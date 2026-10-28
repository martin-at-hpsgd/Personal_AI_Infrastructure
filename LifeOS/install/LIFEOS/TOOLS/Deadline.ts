#!/usr/bin/env bun
/**
 * @version 1.1.0 (2026-10-20: the tree is walked with pgrep, which still runs where ps is refused;
 *   whatever the command leaves running when it exits is stopped then instead of escaping the deadline)
 * Deadline.ts — run a command, and kill everything it started when its time is up.
 *
 *   bun ~/.claude/LIFEOS/TOOLS/Deadline.ts <N>m|<N>s -- <command> [args...]
 *   bun ~/.claude/LIFEOS/TOOLS/Deadline.ts 20m -- zsh -c 'bun run check 2>&1 | tail -40'
 *
 * Exit: the command's own code; 124 when the deadline killed it; 2 on bad usage.
 *
 * WHY (2026-09-27): an agent waiting on its own background job makes no tool calls, so a time
 * budget checked at tool calls can't reach it; an eval run held one agent idle for an hour.
 * A subagent's background Bash runs under this wrapper with N inside the agent's remaining
 * budget. The wrapper is a convention that no hook enforces; Workflows own agent deadlines.
 *
 * The command stays in this process's group, so a harness stop that signals the group still
 * reaches it. At the deadline the whole descendant tree (walked by parent pid, which also finds
 * children that moved to their own group) gets SIGTERM, then SIGKILL after a grace period.
 *
 * A process whose parent exits is re-parented to pid 1 and drops out of that walk, so
 * `sh -c 'sleep 3600 &'` would otherwise exit at once and leave the sleep with no deadline.
 * Orphans that appear in this process's group while the command runs are counted as the
 * command's own: they are stopped at the deadline, and when the command exits first they are
 * stopped as it exits, keeping the command's exit code. An orphan that also left the group
 * (setsid) after its parent exited is out of reach.
 */

import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { constants } from "node:os";

const KILL_GRACE_MS = 5_000;
export const EXIT_DEADLINE = 124;

export function parseDuration(s: string): number | null {
  const m = /^(\d+)([ms])$/.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  if (n <= 0) return null;
  return m[2] === "m" ? n * 60_000 : n * 1_000;
}

/** Pids pgrep matches, [] on no match. pgrep, not ps: a sandbox that refuses the setuid ps still runs it. */
function pgrep(args: string[]): number[] {
  try {
    return execFileSync("pgrep", args, { encoding: "utf-8" }).split("\n").map(Number).filter((n) => n > 0);
  } catch { return []; }
}

/** Every descendant of `roots` by parent pid, deepest first. */
export function descendants(...roots: number[]): number[] {
  const seen = new Set(roots);
  const levels: number[][] = [];
  let frontier = roots;
  while (frontier.length > 0) {
    frontier = pgrep(["-P", frontier.join(",")]).filter((p) => !seen.has(p));
    for (const p of frontier) seen.add(p);
    levels.push(frontier);
  }
  return levels.reverse().flat();
}

/** Orphans (parent pid 1) in this process's group; pgrep runs in the group, so -g 0 names it. */
function groupOrphans(): number[] {
  return pgrep(["-P", "1", "-g", "0"]);
}

async function stop(tree: number[]): Promise<void> {
  signalAll(tree, "SIGTERM");
  const until = Date.now() + KILL_GRACE_MS;
  while (Date.now() < until && tree.some(alive)) await Bun.sleep(100);
  signalAll(tree.filter(alive), "SIGKILL");
}

function signalAll(pids: number[], sig: NodeJS.Signals): void {
  for (const pid of pids) {
    try { process.kill(pid, sig); } catch { /* already gone */ }
  }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function main(argv: string[]): Promise<number> {
  const sep = argv.indexOf("--");
  const ms = parseDuration(argv[0] ?? "");
  const command = sep >= 0 ? argv.slice(sep + 1) : [];
  if (sep !== 1 || ms === null || command.length === 0) {
    console.error("usage: Deadline.ts <N>m|<N>s -- <command> [args...]");
    return 2;
  }
  const preexisting = new Set(groupOrphans());
  const orphaned = () => groupOrphans().filter((p) => !preexisting.has(p));
  const child = spawn(command[0]!, command.slice(1), { stdio: "inherit" });
  let sweep: Promise<void> | null = null;
  const timer = setTimeout(() => {
    sweep = (async () => {
      const roots = [child.pid!, ...orphaned()];
      const tree = [...descendants(...roots), ...roots];
      console.error(`deadline: ${argv[0]} passed; stopping ${tree.length} process(es) started by: ${command.join(" ").slice(0, 160)}`);
      await stop(tree);
    })();
  }, ms);
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    process.on(sig, () => {
      signalAll([...descendants(child.pid!), child.pid!], sig);
      process.exit(128 + (constants.signals[sig] ?? 1));
    });
  }
  const code: number = await new Promise((resolve) => {
    child.on("exit", (c, s) => resolve(c ?? 128 + ((s && constants.signals[s]) || 1)));
    child.on("error", (e) => { console.error(`deadline: could not start ${command[0]}: ${e.message}`); resolve(127); });
  });
  clearTimeout(timer);
  if (sweep !== null) {
    // The child may exit on TERM before a grandchild does; the sweep finishes before we exit.
    await sweep;
    return EXIT_DEADLINE;
  }
  const left = orphaned();
  if (left.length > 0) {
    const tree = [...descendants(...left), ...left];
    console.error(`deadline: the command exited and left ${tree.length} process(es) running; stopping them: ${command.join(" ").slice(0, 160)}`);
    await stop(tree);
  }
  return code;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
