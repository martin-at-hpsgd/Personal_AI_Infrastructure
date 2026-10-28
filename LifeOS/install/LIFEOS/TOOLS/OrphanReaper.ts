#!/usr/bin/env bun
/**
 * @version 1.0.4
 * OrphanReaper.ts — kill dev servers and work processes that outlived the session that started them.
 *
 *   bun LIFEOS/TOOLS/OrphanReaper.ts            # dry run: print what would die, write nothing
 *   bun LIFEOS/TOOLS/OrphanReaper.ts --apply    # kill (TERM, then KILL after a grace period) and log
 *   bun LIFEOS/TOOLS/OrphanReaper.ts --json     # dry run as JSON
 *
 * WHY (2026-09-03): a `wrangler dev` tree from a session that ended three days
 * earlier sat at 92% CPU, and a `vitepress dev` bound to 0.0.0.0:5173 for
 * thirty hours at 74%. Both were re-parented to launchd (ppid 1) when their
 * session died, so nothing owned them and nothing was watching. The box ran at
 * load 15–20 until a hook timed out and someone looked.
 *
 * WHAT COUNTS AS AN ORPHAN — every one of these must hold (lib: `isOrphanRoot`):
 *   - ppid == 1           re-parented to launchd; a live session's child has a real parent
 *   - no controlling TTY  `??` in ps — a server the principal started in a terminal keeps its tty
 *   - command matches the dev-server pattern set below
 *   - age >= MIN_AGE_S    one hour
 *   - its working directory is not the working directory of any LIVE claude session
 *     (Astra HIGH-2, 2026-09-03: a server started from a Claude Code Bash call with
 *     nohup has ppid 1 and no tty by construction, so the first three clauses cannot
 *     tell it from a leak. The owning session shares its cwd; a leak's session is
 *     gone. A 13-minute-old wrangler dev under active rebuild was on the dry-run
 *     kill list before this clause existed.)
 * Descendants of a selected root (the node → workerd chain) die with it; they are
 * selected by ancestry only, never by their own command line.
 *
 * Runs headless on a launchd clock (com.lifeos.orphanreaper, every 15 min;
 * InstallOrphanReaper.ts). Each kill appends a row to
 * MEMORY/OBSERVABILITY/orphan-reaper.jsonl. No voice, no notification: the log is
 * the record and Pulse/`/ic` can read it.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { lifeosPath } from "./Paths";

export const LOG_PATH = lifeosPath("MEMORY", "OBSERVABILITY", "orphan-reaper.jsonl");
export const MIN_AGE_S = 3600;
export const GRACE_MS = 3000;

/** Command-line shapes of dev servers and the runtimes they spawn. Anchored on word boundaries. */
export const DEV_SERVER_PATTERNS: readonly RegExp[] = [
  /\b(?:vitepress|vite|astro|next|nuxt|remix|wrangler|hono|expo)\s+dev\b/,
  /\b(?:bun|npm|pnpm|yarn)\s+(?:run\s+)?dev\b/,
  /\/\.bin\/(?:vitepress|vite|astro|next|nuxt|remix|wrangler)\b/,
  /\bworkerd\b/,
  /\bminiflare\b/,
];

export interface ProcRow {
  pid: number;
  ppid: number;
  /** `??` when the process has no controlling terminal. */
  tty: string;
  /** Seconds since the process started. */
  ageS: number;
  command: string;
  /** The process declared LIFEOS_DETACH_OK: deliberately persistent, never reaped by a pattern or a dead-session rule. */
  detachOk?: boolean;
}

export function matchesDevServer(command: string): boolean {
  return DEV_SERVER_PATTERNS.some((re) => re.test(command));
}

/** The pure predicate. Every clause is load-bearing; see the header. */
export function isOrphanRoot(row: ProcRow, minAgeS = MIN_AGE_S): boolean {
  return row.detachOk !== true && row.ppid === 1 && row.tty === "??" && row.ageS >= minAgeS && matchesDevServer(row.command);
}

/**
 * Just the ProcRow fields: a SessionTree Proc also carries env tags, which the plan and the kill log never print.
 * The detach exemption is the one tag that must survive, or the pattern reaper kills deliberately persistent servers.
 */
export const procRow = ({ pid, ppid, tty, ageS, command, detachOk }: ProcRow): ProcRow => ({ pid, ppid, tty, ageS, command, ...(detachOk ? { detachOk: true } : {}) });

// SessionTree owns the process table and imports this module, so it is required lazily, at call time.
const sessionTree = () => require("./SessionTree") as typeof import("./SessionTree");

/** Parse `ps -Axo pid=,ppid=,tty=,etime=,command=` output, through SessionTree's one parser. */
export function parsePs(text: string): ProcRow[] {
  return sessionTree().parseTables(text, "").map(procRow);
}

/** `[[dd-]hh:]mm:ss` → seconds. Unparseable → 0 (treated as brand new, so never selected). */
export function parseEtime(s: string): number {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(s);
  if (!m) return 0;
  const [, d, h, mi, se] = m;
  return (Number(d ?? 0) * 86400) + (Number(h ?? 0) * 3600) + (Number(mi) * 60) + Number(se);
}

export interface SelectOptions {
  /** Working directory of a pid, or null when unknown. Impure in production (lsof); injected in tests. */
  cwdOf?: (pid: number) => string | null;
  /** Working directories of live claude sessions. A root whose cwd is one of these is owned, not orphaned. */
  ownedCwds?: ReadonlySet<string>;
  /**
   * False when the live-session lookup failed (as opposed to confirming there are none). Ownership is then
   * unknown and nothing is selected. Omitted means the caller asserts the lookup succeeded.
   */
  ownershipKnown?: boolean;
}

export interface Selection {
  roots: ProcRow[];
  /** Descendants of the roots, by ancestry through the table. */
  descendants: ProcRow[];
}

/** Select orphan roots and everything under them. Pure over the table. */
export function selectOrphans(rows: ProcRow[], minAgeS = MIN_AGE_S, selfPid = process.pid, opts: SelectOptions = {}): Selection {
  const owned = opts.ownedCwds ?? new Set<string>();
  const byParent = new Map<number, ProcRow[]>();
  for (const r of rows) {
    if (!byParent.has(r.ppid)) byParent.set(r.ppid, []);
    byParent.get(r.ppid)!.push(r);
  }
  /** Any descendant of `pid` that declared LIFEOS_DETACH_OK: the whole tree is exempt, as SessionTree treats a chain. */
  const hasDetachedBelow = (pid: number): boolean => {
    const seenBelow = new Set<number>([pid]);
    const todo = [pid];
    while (todo.length) {
      for (const c of byParent.get(todo.pop()!) ?? []) {
        if (seenBelow.has(c.pid)) continue;
        seenBelow.add(c.pid);
        if (c.detachOk) return true;
        todo.push(c.pid);
      }
    }
    return false;
  };
  const roots = rows.filter((r) => {
    if (r.pid === selfPid || !isOrphanRoot(r, minAgeS)) return false;
    if (hasDetachedBelow(r.pid)) return false;
    // Ownership must be CONFIRMED absent. A failed lookup, an unreadable cwd, or live sessions with no
    // way to tell whose server this is all mean "unknown", and unknown is never killed.
    if (opts.ownershipKnown === false) return false;
    if (owned.size === 0) return true;
    if (!opts.cwdOf) return false;
    const cwd = opts.cwdOf(r.pid);
    if (!cwd) return false;
    return !owned.has(cwd);
  });
  const descendants: ProcRow[] = [];
  const seen = new Set<number>(roots.map((r) => r.pid));
  const stack = [...roots];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const child of byParent.get(cur.pid) ?? []) {
      if (seen.has(child.pid) || child.pid === selfPid) continue;
      seen.add(child.pid);
      descendants.push(child);
      stack.push(child);
    }
  }
  return { roots, descendants };
}

/** cwd of one pid via lsof; null when unreadable. */
export function cwdOf(pid: number): string | null {
  try {
    const out = execFileSync("lsof", ["-a", "-d", "cwd", "-p", String(pid), "-Fn"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const m = /^n(.+)$/m.exec(out);
    return m ? m[1]!.trim() : null;
  } catch { return null; }
}

export interface Ownership {
  /** Working directories of every live claude process — the sessions that could own a dev server. */
  cwds: Set<string>;
  /** False when the lookup itself failed, which is not the same as confirming there are no sessions. */
  known: boolean;
}

/**
 * Live claude sessions' working directories. pgrep exit 1 means "no such process", a confirmed absence;
 * any other failure, or a live claude whose cwd cannot be read, makes ownership unknown.
 */
export function liveClaudeOwnership(): Ownership {
  const cwds = new Set<string>();
  let pids: string[] = [];
  try {
    pids = execFileSync("pgrep", ["-x", "claude"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().split("\n").filter(Boolean);
  } catch (e) {
    const status = (e as { status?: number | null }).status;
    return { cwds, known: status === 1 };
  }
  let known = true;
  for (const p of pids) { const c = cwdOf(Number(p)); if (c) cwds.add(c); else known = false; }
  return { cwds, known };
}

/** The process table, read once by SessionTree (the kernel on macOS, `ps` elsewhere). */
export function snapshot(): ProcRow[] {
  return sessionTree().readProcs().map(procRow);
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export interface ReapResult { killed: number[]; survived: number[] }

/** TERM every selected pid, wait, KILL survivors. Logs one row per pid that died. */
export async function reap(sel: Selection, log: (row: Record<string, unknown>) => void, graceMs = GRACE_MS): Promise<ReapResult> {
  const targets = [...sel.roots, ...sel.descendants];
  for (const t of targets) { try { process.kill(t.pid, "SIGTERM"); } catch { /* already gone */ } }
  await new Promise((r) => setTimeout(r, graceMs));
  const survivedTerm = targets.filter((t) => alive(t.pid));
  for (const t of survivedTerm) { try { process.kill(t.pid, "SIGKILL"); } catch { /* gone */ } }
  await new Promise((r) => setTimeout(r, 500));
  const killed: number[] = [];
  const survived: number[] = [];
  for (const t of targets) {
    if (alive(t.pid)) { survived.push(t.pid); continue; }
    killed.push(t.pid);
    log({
      ts: new Date().toISOString(),
      pid: t.pid,
      ppid: t.ppid,
      age_s: t.ageS,
      role: sel.roots.includes(t) ? "root" : "descendant",
      signal: survivedTerm.includes(t) ? "SIGKILL" : "SIGTERM",
      command: t.command.slice(0, 300),
    });
  }
  return { killed, survived };
}

export function appendLog(row: Record<string, unknown>, path = LOG_PATH): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(row) + "\n");
  } catch { /* a missing log line is not worth failing the reap */ }
}

// The CLI is a function, not top-level await: a module with top-level await cannot be require()d by in-process callers.
async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const json = process.argv.includes("--json");
  // One process-table read serves both classes.
  const { readProcs, deadSessionStragglers } = sessionTree();
  const procs = readProcs();
  const own = liveClaudeOwnership();
  const sel = selectOrphans(procs.map(procRow), MIN_AGE_S, process.pid, { cwdOf, ownedCwds: own.cwds, ownershipKnown: own.known });
  if (!own.known) console.error("OrphanReaper: live-session ownership is unknown this run; pattern-matched servers are left alone.");
  // Second class (2026-09-29, Session work tree ISA ISC-8): work processes carrying the env tag of a
  // Claude session whose claude pid is gone, adopted by launchd. Catches what the pattern list misses
  // (a `bun serve.ts` dev server ran eight days). Selection lives in SessionTree.ts, the one owner of
  // session membership.
  const picked = new Set([...sel.roots, ...sel.descendants].map((r) => r.pid));
  for (const d of deadSessionStragglers(procs)) {
    for (const pid of d.pids ?? []) {
      if (picked.has(pid)) continue;
      picked.add(pid);
      const row: ProcRow = { pid, ppid: pid === d.pid ? 1 : (d.pid ?? 1), tty: "??", ageS: d.ageS, command: `dead-session ${d.session?.slice(0, 8) ?? "?"}: ${d.label}` };
      (pid === d.pid ? sel.roots : sel.descendants).push(row);
    }
  }
  const plan = [...sel.roots.map((r) => ({ ...r, role: "root" })), ...sel.descendants.map((r) => ({ ...r, role: "descendant" }))];
  if (json) {
    console.log(JSON.stringify({ apply, plan }, null, 2));
  } else if (plan.length === 0) {
    console.log("OrphanReaper: nothing to reap.");
  } else {
    for (const p of plan) console.log(`${apply ? "KILL " : "would kill "}${p.pid} (${p.role}, ppid ${p.ppid}, ${Math.round(p.ageS / 60)} min) ${p.command.slice(0, 120)}`);
  }
  if (apply && plan.length > 0) {
    const r = await reap(sel, (row) => appendLog(row));
    console.log(`OrphanReaper: killed ${r.killed.length}${r.survived.length ? `, ${r.survived.length} survived (${r.survived.join(",")})` : ""}.`);
    if (r.survived.length) process.exit(1);
  }
}

if (import.meta.main) void main();
