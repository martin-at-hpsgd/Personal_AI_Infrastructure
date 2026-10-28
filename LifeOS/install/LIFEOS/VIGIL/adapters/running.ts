/** Running work that lost its owner or ran past its deadline. Reads SessionTree's verdicts, never its own: the board state every live session saves, the machine-wide dead-session stragglers, and the process count. Exceptions only, as episodes; routine reaps stay silent. @version 0.2.1 — re-check fixes: agent and process keys apart, first sighting as the occurrence. 0.2.0 — audit fixes: per-episode story key, two-read persistence, hard ceiling, kind-free keys, executable-only process labels. */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { collectConfig } from "../../STATVS/lib/collectConfig";
import type { VigilEvent } from "../../STATVS/lib/refuse";
import { readJson, statePath } from "../../STATVS/lib/collectState";
import { STATE_DIR, deadSessionStragglers, fmtAge, readProcs, type Proc, type Straggler } from "../../TOOLS/SessionTree";
import { activeRuns, type ActiveRun } from "../../WORKFLOWS/engine/workflow-ops";
import { clip, clock, event, need, requireSource, withCursor } from "./common";

type Seen = { kind: string; label: string; ageS: number; session: string; pid: number | null; reads: number; firstSeen: string };
export type Snapshot = { at: string; procs: number; baseline: number; over: boolean; exploding: boolean; since: string | null; top: string; stragglers: Record<string, Seen> };

/** A live session's plugin rewrites its tree every few seconds; one older than this belongs to a session that ended. */
const FRESH_MS = 2 * 60_000;
/** Every straggler must be seen on two reads this far apart before it is news: a finished session's last tree, and a stray the plugin reaps within seconds, never qualify. */
const PERSIST_MS = 2 * 60_000;
/** OrphanReaper clears dead sessions every 15 minutes from 10 minutes old, so a younger one is still in its queue. */
const DEAD_SESSION_NEWS_S = 30 * 60;
const LOOK = "Look: bun LIFEOS/TOOLS/SessionTree.ts show --session <id>, or ps -axo pid,ppid,etime,command.";
/** Workflows decides a run is overdue (its own deadline_at); the adapter only carries that verdict. */
const WF = "wf:";
/** A broken run ledger degrades only this leg, never the process-explosion and straggler reads beside it. */
export function overdueRuns(now: Date, read: (now: number) => ActiveRun[] = (at) => activeRuns(undefined, undefined, at)): ActiveRun[] {
  try { return read(now.getTime()).filter((r) => r.overdue); }
  catch (error) { console.error(`running: workflow runs unreadable, overdue check skipped this read: ${error instanceof Error ? error.message : String(error)}`); return []; }
}

const policy = () => ((collectConfig() as any).adapters?.running ?? {}) as { explosionMin?: number; explosionMultiple?: number; explosionCeiling?: number };
const short = (session: string) => session ? session.slice(0, 8) : "unknown";
const exe = (command: string) => (command.split(/\s+/)[0] ?? "").split("/").pop() || "?";
/** One identity per process, keyed by its pid. Agents are not watched here: their status is native. */
const keyOf = (s: Straggler) => `${short(s.session ?? "")}:pid-${s.pid ?? s.label}`;
/** Process labels carry arguments (paths, hosts), so only the executable name leaves the machine. */
const labelOf = (s: Straggler) => exe(s.label);

/** Every straggler the plugin saved for a session written in the last FRESH_MS. A missing directory is a blind read, never an empty one. */
export function sessionVerdicts(dir = STATE_DIR, now = Date.now()): Straggler[] {
  requireSource(dir, `session-tree state dir ${dir}`);
  const out: Straggler[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    const path = join(dir, f);
    try { if (now - statSync(path).mtimeMs > FRESH_MS) continue; } catch { continue; }
    let t: { session?: string; stragglers?: Straggler[] };
    try { t = JSON.parse(readFileSync(path, "utf8")); } catch { continue; } // a tree mid-rename is read next tick
    need(Array.isArray(t.stragglers), `${f} carries stragglers`);
    for (const s of t.stragglers) out.push({ ...s, session: s.session ?? t.session });
  }
  return out;
}

/** The three executables with the most processes. */
export function topCommands(procs: Pick<Proc, "command">[]): string {
  const counts = new Map<string, number>();
  for (const p of procs) counts.set(exe(p.command), (counts.get(exe(p.command)) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([n, c]) => `${n} ×${c.toLocaleString("en-US")}`).join(", ");
}

/**
 * The explosion line is max(min, multiple × baseline), capped at the ceiling so a baseline taken under load can never hide one.
 * Onset needs two reads over the line, or one read over the ceiling; it clears under 80% of the line, so a count at the line does not flap.
 */
export async function live(prev: Snapshot | null = null, procs: Proc[] = readProcs(), verdicts: Straggler[] = [...sessionVerdicts(), ...deadSessionStragglers(procs)], now = new Date(), overdue: ActiveRun[] = overdueRuns(now)): Promise<Snapshot> {
  need(procs.length > 0, "process table read");
  const { explosionMin = 4000, explosionMultiple = 3, explosionCeiling = 6000 } = policy();
  const base = prev?.baseline ?? procs.length, line = Math.min(explosionCeiling, Math.max(explosionMin, explosionMultiple * base));
  const over = procs.length >= line;
  const exploding = (over && (!!prev?.over || procs.length >= explosionCeiling)) || (!!prev?.exploding && procs.length >= 0.8 * line);
  const at = now.toISOString();
  const stragglers: Record<string, Seen> = {};
  for (const s of verdicts) {
    const key = keyOf(s), before = prev?.stragglers[key];
    if (stragglers[key]) continue;
    stragglers[key] = { kind: s.kind, label: labelOf(s), ageS: s.ageS, session: s.session ?? "", pid: s.pid ?? null, reads: (before?.reads ?? 0) + 1, firstSeen: before?.firstSeen ?? at };
  }
  for (const r of overdue) {
    const key = `${WF}${r.run_id}`, before = prev?.stragglers[key];
    stragglers[key] = { kind: "workflow-overdue", label: clip(r.workflow, 80), ageS: Math.max(0, Math.round((now.getTime() - Date.parse(r.started_at)) / 1000)), session: "", pid: null, reads: (before?.reads ?? 0) + 1, firstSeen: before?.firstSeen ?? at };
  }
  return {
    at, procs: procs.length, over, exploding, stragglers,
    baseline: over || exploding ? base : Math.round(base * 0.9 + procs.length * 0.1),
    since: exploding ? (prev?.exploding && prev.since ? prev.since : at) : null,
    top: topCommands(procs),
  };
}

/** True once a straggler is news: seen on two reads PERSIST_MS apart, and for a dead session, old enough that OrphanReaper had its turn. */
export const qualifies = (s: Seen | undefined, at: string): boolean => !!s && s.reads >= 2 && Date.parse(at) - Date.parse(s.firstSeen) >= PERSIST_MS && (s.kind !== "dead-session" || s.ageS >= DEAD_SESSION_NEWS_S);

function describe(key: string, s: Seen): VigilEvent {
  const where = `session ${short(s.session)}`, age = fmtAge(s.ageS), pid = s.pid ? `, pid ${s.pid}` : "";
  switch (s.kind) {
    case "hung-hook": return event("running", key, "flagged", "medium", `Hook running too long: ${s.label}`, `A ${s.label} hook${pid} in ${where} has run ${age}, past the 10-minute line. Hooks are flagged, never killed automatically. ${LOOK}`, "infra", null, s.firstSeen);
    case "over-deadline": return event("running", key, "flagged", "medium", `Work past its 30-minute deadline: ${s.label}`, `A ${s.label} process${pid} that ${where} started has run ${age} under a live shell with no agent owning it. Its session is alive, so nothing stops it automatically; if it is not meant to keep running, stop it. ${LOOK}`, "infra", null, s.firstSeen);
    case "workflow-overdue": { const run = key.slice(WF.length); /* occurrence is the run, never firstSeen: a run that drops out of one read and returns is the same run */ return event("running", key, "flagged", "medium", `Workflow run past its deadline: ${s.label}`, `Run ${run} of ${s.label} started ${age} ago and is past the deadline Workflows set for it, with no result in the run ledger. If it is hung, stop it: bun LIFEOS/WORKFLOWS/workflow.ts stop ${run}. Look: bun LIFEOS/WORKFLOWS/workflow.ts runs --active.`, "infra", null, run); }
    default: return event("running", key, "flagged", "medium", `Stray work survived its reaper: ${s.label}`, `A ${s.label} process (${s.kind}${pid}) in ${where} is ${age} old and was still there on a second read, so the reap that should have removed it did not. ${LOOK}`, "infra", null, s.firstSeen);
  }
}

/** The 72-hour repeat hold reads the story key; without one per episode, a stripped dedup key would make every explosion the same story. */
const episode = (e: VigilEvent, since: string): VigilEvent => ({ ...e, meta: { ...(e.meta ?? {}), key: `running:processes:${since}` } });

export function diff(prev: Snapshot | undefined, next: Snapshot): VigilEvent[] {
  if (!prev) return [];
  const out: VigilEvent[] = [];
  if (next.exploding && !prev.exploding) { const since = next.since ?? next.at; out.push(episode(event("running", "processes", "exploding", "critical", `Process explosion: ${next.procs.toLocaleString("en-US")} processes`, `${next.procs.toLocaleString("en-US")} processes are running against a baseline of ${next.baseline.toLocaleString("en-US")}. Top: ${next.top}. Started ${clock(since)}. Find the parent chain of the top command and stop it. ${LOOK}`, "infra", null, since), since)); }
  if (!next.exploding && prev.exploding) { const since = prev.since ?? prev.at; out.push(episode(event("running", "processes", "cleared", "info", `Process explosion cleared at ${next.procs.toLocaleString("en-US")} processes`, `Back to ${next.procs.toLocaleString("en-US")} processes from an explosion that started ${clock(since)}. Top now: ${next.top}.`, "infra", null, since), since)); }
  for (const [key, s] of Object.entries(next.stragglers)) if (qualifies(s, next.at) && !qualifies(prev.stragglers[key], prev.at)) out.push(describe(key, s));
  return out;
}

export const read = () => withCursor("running", () => live(readJson<Snapshot | null>(statePath("cursors", "running.json"), null)), diff);
