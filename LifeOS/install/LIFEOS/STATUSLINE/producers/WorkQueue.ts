import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Cache } from "../Cache";
import { TTL, type State } from "../State";
import { invariant } from "../../TOOLS/Invariant";
import { loadWorkConfig } from "../../../hooks/lib/work-config";
import { acquireLock, type RefreshJob } from "./Background";

/** What the WORK and INPUTS rows draw, written by the refresher to `work-queue.json`. Work and ideas are disjoint: no issue is in both. */
export interface WorkQueue {
  updated: string;
  /** Real open work, ideas excluded. */
  open: number;
  active: number;
  /** P0/P1 work, ideas excluded. */
  urgent: number;
  /** Open Type:project or Idea:* issues, and how many of them are core to our work. */
  ideas: number;
  ideasCore: number;
  /** The newest core idea, else the newest idea. */
  newestIdea: { number: number; title: string } | null;
  /** Synapse captures in the last 24 hours, and how many of them it filed as issues. */
  captured: number;
  filed: number;
  /** The top real P0/P1 item: P0 before P1, then the oldest. */
  next: { number: number; title: string } | null;
  /** Minutes the oldest ungraded Synapse capture has waited, or null when none waits. */
  stuckMin: number | null;
}

export interface Issue { number?: number; title: string; createdAt: string; labels: Array<{ name: string }> }
export interface Capture { captured_at: string; status: string; routed_refs?: string | null }

/** Counts from the open issues and the recent ledger rows. Pure, so the test feeds it fixtures. */
export function summarize(all: Issue[], captures: Capture[], nowMs: number): WorkQueue {
  const has = (i: Issue, name: string): boolean => i.labels.some((l) => l.name === name);
  // Real forward work, by WorkSweep's rule: session-tracking issues (auto-sweep, auto-native) are records, not work.
  const real = all.filter((i) => !has(i, "auto-sweep") && !has(i, "auto-native"));
  // An idea is a Synapse project idea, whatever its older Priority label says, so it never counts as work.
  const isIdea = (i: Issue): boolean => has(i, "Type:project") || i.labels.some((l) => l.name.startsWith("Idea:"));
  const work = real.filter((i) => !isIdea(i));
  const rank = (i: Issue): number => has(i, "Priority:P0") ? 0 : has(i, "Priority:P1") ? 1 : 2;
  const urgent = work.filter((i) => rank(i) < 2).sort((a, b) => rank(a) - rank(b) || Date.parse(a.createdAt) - Date.parse(b.createdAt));
  const top = urgent.find((i) => typeof i.number === "number");
  // Before the Idea: labels, a core idea was a Type:project issue labelled Priority:P1.
  const isCore = (i: Issue): boolean => has(i, "Idea:core") || (has(i, "Type:project") && has(i, "Priority:P1"));
  const ideas = real.filter(isIdea).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const fresh = ideas.find((i) => isCore(i) && typeof i.number === "number") ?? ideas.find((i) => typeof i.number === "number");
  const today = captures.filter((c) => nowMs - Date.parse(c.captured_at) <= 86400_000);
  const issued = (c: Capture): boolean => { try { return JSON.parse(c.routed_refs || "[]").some((r: { type?: string }) => r.type === "work_issue"); } catch { return false; } };
  const strip = (i: Issue): { number: number; title: string } => ({ number: i.number!, title: i.title.replace(/^\[[^\]]+\]\s*/, "").trim() });
  const waiting = captures.filter((c) => c.status === "captured").map((c) => Date.parse(c.captured_at)).filter(Number.isFinite);
  return {
    updated: new Date(nowMs).toISOString(),
    open: work.length,
    active: work.filter((i) => has(i, "Status:in-progress")).length,
    urgent: urgent.length,
    ideas: ideas.length,
    ideasCore: ideas.filter(isCore).length,
    newestIdea: fresh ? strip(fresh) : null,
    captured: today.length,
    filed: today.filter(issued).length,
    next: top ? strip(top) : null,
    stuckMin: waiting.length ? Math.max(0, Math.floor((nowMs - Math.min(...waiting)) / 60_000)) : null,
  };
}

export interface WorkQueueDeps {
  issues: () => Promise<Issue[]>;
  captures: () => Promise<Capture[]>;
}

async function run(argv: string[]): Promise<string> {
  const p = Bun.spawn(argv, { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
  const timer = setTimeout(() => p.kill(), 30_000);
  const out = await new Response(p.stdout).text();
  clearTimeout(timer);
  invariant((await p.exited) === 0, `${argv[1] ?? argv[0]} exited non-zero`);
  return out;
}

/** The amber CLI is the one worker under the Workers dir that carries cli/amber.ts; the dir name is per-instance, so it is found, not spelled. */
function findAmberCli(root: string): string {
  const workers = join(root, "USER", "CUSTOMIZATIONS", "WORKFLOWS", "Workers");
  try {
    for (const d of readdirSync(workers)) {
      const cli = join(workers, d, "cli", "amber.ts");
      if (existsSync(cli)) return cli;
    }
  } catch { /* no workers dir on this install */ }
  return join(workers, "amber-ledger", "cli", "amber.ts");
}

/** Thrown by the live issue source when no (private) work repo is configured; the refresh skips quietly and the row stays undrawn. */
export class NoWorkRepo extends Error {
  constructor() { super("no work repo configured"); this.name = "NoWorkRepo"; }
}

/** The live sources: gh for the work repo's open issues, the amber CLI for the newest ledger rows. */
export function liveDeps(root: string): WorkQueueDeps {
  const gh = Bun.which("gh") ?? "/opt/homebrew/bin/gh";
  const amber = findAmberCli(root);
  return {
    issues: async () => {
      // The privacy-verifying loader: repo is null unless the work repo is confirmed private.
      const repo = loadWorkConfig().repo ?? "";
      // The Work system is optional: an install without a work repo is expected, not a broken state.
      if (repo === "") throw new NoWorkRepo();
      return JSON.parse(await run([gh, "issue", "list", "--repo", repo, "--state", "open", "--limit", "1000", "--json", "number,title,createdAt,labels"])) as Issue[];
    },
    captures: async () => {
      if (!existsSync(amber)) return [];
      const j = JSON.parse(await run([process.execPath, amber, "list", "--limit", "300", "--json"])) as { captures?: Capture[] } | Capture[];
      return Array.isArray(j) ? j : j.captures ?? [];
    },
  };
}

/** Refresh past five minutes behind a 60-second lock; a failed source leaves the last good file in place. */
export function workQueueRefresh(cache: Cache, root: string, nowMs: number, deps?: WorkQueueDeps): RefreshJob | null {
  if (cache.age("work-queue.json") <= TTL.workQueue) return null;
  return {
    name: "work-queue",
    async run() {
      const lock = acquireLock(cache, "work-queue-refresh.lock", 60);
      if (!lock) return;
      try {
        const d = deps ?? liveDeps(root);
        let issues: Issue[], captures: Capture[];
        try { [issues, captures] = await Promise.all([d.issues(), d.captures()]); }
        catch (e) { if (e instanceof NoWorkRepo) return; throw e; }
        const q = summarize(issues, captures, nowMs);
        invariant(q.active <= q.open && q.urgent <= q.open && q.ideasCore <= q.ideas && q.filed <= q.captured, "work-queue counts are inconsistent");
        cache.put("work-queue.json", JSON.stringify(q));
      } finally { lock.release(); }
    },
  };
}

export const workQueueRefreshFor = (state: State, deps?: WorkQueueDeps): RefreshJob | null => workQueueRefresh(state.cache, state.root, state.nowMs, deps);
