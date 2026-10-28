#!/usr/bin/env bun
/**
 * RouteTrail.ts — this session's dispatch trail with the observed model beside the configured lane.
 *
 * FUNCTIONHOOKS ISA ISC-52. The statusline draws one 🔀 row from it, newest dispatch first:
 *
 *   🔀 Astra ✓ │ Haiku ⚡ │ general-purpose→ant:Sonnet ✓ │ Sol→oai:Astra ✗
 *
 * The lane carries its provider (`oai:`, `ant:`, `goog:`, `xai:` — hooks/lib/route-label.ts, the one
 * vocabulary shared with the band and the 🔀 ROUTED line in the answer, ISC-56). The mark separates
 * what was ASKED FOR (the CROSS_VENDOR lane the plugin's agent.spawn hook wrote into
 * subagent-events.jsonl) from what RAN:
 *   ✓  the codex run record for this dispatch (codex-runs.jsonl, written by CodexProgress.ts from
 *      codex's own session log, ISC-53) observed the lane id; a Claude dispatch: the engine resolved
 *      the model itself, so its start row is the observation
 *   ⚡  still running
 *   ✗  the matched run observed a different model
 *   ∅  a codex-backed agent completed with NO run record: the Claude wrapper answered on its own
 *      and never ran the helper (caught live on the first probe: a wrapper on a small
 *      model did the task itself in seconds) — or the run predates ISC-53
 *   ·  a run record exists but observed no model (the rollout was missing), or the match is
 *      ambiguous (below)
 *
 * The join (ISC-58): a run record carrying `dispatch_id` (the plugin exports LIFEOS_DISPATCH_ID
 * into the wrapper's helper call) binds to its dispatch exactly. Records without one — runs from
 * before ISC-58, or a helper run outside any dispatch — fall back to agent type + time window,
 * and when that window holds MORE than one candidate the mark is · (unverified), never a guess:
 * two dispatches of one agent must never borrow each other's observation (2026-09-10). Read-only; no model call.
 *
 * Usage: bun LIFEOS/TOOLS/RouteTrail.ts --session <id> [--limit N] [--json] [--width COLS] [--detail N]
 *   Plain: the 🔀 row, then one detail row per recent dispatch (newest first, `--detail` of them,
 *   default 3): every agent doing an intelligence task shows what it was asked, which lane answered,
 *   and what it said (2026-09-10).
 *   --width: clip every printed row to COLS terminal columns (the statusline passes its content width).
 * Env (tests): ROUTE_TRAIL_EVENTS (events file), ROUTE_TRAIL_RUNS (run records), ROUTE_TRAIL_NOW (ms).
 */

import { existsSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { readRuns, type CodexRun } from './CodexObserved.ts';
import { lifeosPath } from './Paths';
import { WORK_LADDER, EFFORT_MODEL } from './models';
import { laneLabel, laneName, laneShort, vendorOf, dispatchKey, displayName, agentRow, fitWidth } from '../../hooks/lib/route-label';

export { laneShort };

/** codex boots after the wrapper agent starts; its record is stamped at child exit. */
const SLOP_MS = 90_000;
const MAX_TAIL_BYTES = 2 * 1024 * 1024;

export type Mark = '✓' | '⚡' | '✗' | '∅' | '·';

export interface Dispatch {
  id: string;
  type: string;
  /** The model the start row named: a codex lane id or the engine-resolved Claude model. */
  model: string;
  level: string;
  startedMs: number;
  stoppedMs: number | null;
  status: string;
  /** The dispatch description: what this model was asked to do (the start row's `description`). */
  description: string | null;
  /** The reasoning effort the wrapper's contract passes the helper (codex dispatches). */
  effort: string | null;
}

export interface TrailEntry extends Dispatch {
  /** `oai:Astra`, `ant:Sonnet` (route-label.ts laneLabel). */
  lane: string;
  vendor: string;
  mark: Mark;
  /** The matched run's observed model (codex dispatches only). */
  observed: string | null;
  /** What the model said: the matched run record's `summary` (codex dispatches with a record). */
  summary: string | null;
  /** Wall time from start to stop; null while running. */
  durationMs: number | null;
}

/** Ambiguous window join: more than one record-less candidate run for one dispatch. */
export const AMBIGUOUS = Symbol('ambiguous');
export type RunMatch = CodexRun | null | typeof AMBIGUOUS;

function tail(path: string, bytes: number): string {
  const size = statSync(path).size;
  const offset = Math.max(0, size - bytes);
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(size - offset);
    const n = readSync(fd, buf, 0, buf.length, offset);
    const text = buf.subarray(0, n).toString('utf8');
    return offset === 0 ? text : text.slice(text.indexOf('\n') + 1);
  } finally { closeSync(fd); }
}

/** Pair this session's start/stop rows from the events file (tail-read; the file is append-only and large). */
export function readDispatches(eventsFile: string, sessionId: string): Dispatch[] {
  if (!existsSync(eventsFile)) return [];
  const map = new Map<string, Dispatch>();
  for (const line of tail(eventsFile, MAX_TAIL_BYTES).split('\n')) {
    if (!line.includes(sessionId)) continue;
    let r: Record<string, unknown>;
    try { r = JSON.parse(line); } catch { continue; }
    if (r.session_id !== sessionId || typeof r.subagent_id !== 'string') continue;
    const ts = Date.parse(String(r.timestamp ?? ''));
    if (Number.isNaN(ts)) continue;
    if (r.event === 'subagent_start') {
      map.set(r.subagent_id, {
        id: r.subagent_id, type: String(r.subagent_type ?? '?'), model: String(r.subagent_model ?? ''),
        level: String(r.subagent_level ?? ''), startedMs: ts, stoppedMs: null, status: 'running',
        description: typeof r.description === 'string' && r.description ? r.description : null,
        effort: typeof r.effort === 'string' && r.effort ? r.effort : null,
      });
    } else if (r.event === 'subagent_stop') {
      const d = map.get(r.subagent_id);
      if (d) { d.stoppedMs = ts; d.status = String(r.status ?? 'completed'); }
    }
  }
  return [...map.values()].sort((a, b) => b.startedMs - a.startedMs);
}

/**
 * The run record for this dispatch. Exact first (ISC-58): a record whose `dispatch_id` is this
 * dispatch's key, the latest such when the wrapper ran the helper more than once. Otherwise the
 * window join over records that carry NO dispatch_id (a stamped record belongs to its own
 * dispatch): same agent, started inside the dispatch window — one candidate matches, several are
 * AMBIGUOUS and stay unverified.
 */
export function matchRun(d: Dispatch, runs: CodexRun[], now: number): RunMatch {
  const key = dispatchKey(d.id);
  let exact: CodexRun | null = null;
  for (const r of runs) if (r.dispatch_id === key && (!exact || Date.parse(r.ts) > Date.parse(exact.ts))) exact = r;
  if (exact) return exact;
  const lo = d.startedMs - SLOP_MS;
  const hi = (d.stoppedMs ?? now) + SLOP_MS;
  const want = d.type.toLowerCase();
  const candidates: CodexRun[] = [];
  for (const r of runs) {
    if (r.dispatch_id) continue;
    // The helper's --agent is the wrapper's name, sometimes suffixed by the caller (`Astra-D6`).
    const got = String(r.agent ?? '').toLowerCase();
    if (got !== want && !got.startsWith(`${want}-`)) continue;
    const t = Date.parse(r.ts);
    if (Number.isNaN(t) || t < lo || t > hi) continue;
    candidates.push(r);
  }
  if (candidates.length === 0) return null;
  if (candidates.length > 1) return AMBIGUOUS;
  return candidates[0];
}

/**
 * When CodexProgress.ts began writing run records (ISC-53 landed on disk). A codex-backed
 * dispatch that finished before this with no record is unobserved (·), not a bypass (∅):
 * the two look the same on disk and mean opposite things.
 */
export const OBSERVER_SINCE_MS = Date.parse('2026-09-10T04:00:00Z');

export function markFor(d: Dispatch, run: RunMatch, observerSince = OBSERVER_SINCE_MS): Mark {
  if (d.stoppedMs === null) return '⚡';
  if (d.level !== 'cross-vendor') return d.model ? '✓' : '·';
  if (run === AMBIGUOUS) return '·';
  if (!run) return d.startedMs < observerSince ? '·' : '∅';
  if (!run.observed) return '·';
  return run.observed.toLowerCase() === d.model.toLowerCase() ? '✓' : '✗';
}

export interface TrailOptions {
  eventsFile?: string;
  runsFile?: string;
  now?: number;
  limit?: number;
}

export function trail(sessionId: string, opts: TrailOptions = {}): TrailEntry[] {
  const eventsFile = opts.eventsFile ?? process.env.ROUTE_TRAIL_EVENTS ?? lifeosPath('MEMORY', 'OBSERVABILITY', 'subagent-events.jsonl');
  const runsFile = opts.runsFile ?? process.env.ROUTE_TRAIL_RUNS ?? lifeosPath('MEMORY', 'OBSERVABILITY', 'codex-runs.jsonl');
  const now = opts.now ?? (process.env.ROUTE_TRAIL_NOW ? Number(process.env.ROUTE_TRAIL_NOW) : Date.now());
  const limit = opts.limit ?? 6;
  const dispatches = readDispatches(eventsFile, sessionId).slice(0, limit);
  const runs = dispatches.some((d) => d.level === 'cross-vendor') ? readRuns(runsFile) : [];
  return dispatches.map((d) => {
    const run = d.level === 'cross-vendor' ? matchRun(d, runs, now) : null;
    const observed = run && run !== AMBIGUOUS ? run.observed : null;
    // What the model said. A run that did not succeed says so first: the mark is a ROUTING mark
    // (which model ran) and stays ✓ on a model match, so the failure has to be visible here
    // (2026-09-10).
    const rec = run && run !== AMBIGUOUS ? run : null;
    const said = rec && typeof rec.summary === 'string' && rec.summary ? rec.summary : null;
    const summary = rec && rec.verdict && rec.verdict !== 'success' ? `${rec.verdict}${said ? `: ${said}` : ''}` : said;
    // Wall time: the run record's own clock when there is one (a background dispatch logs its stop
    // the moment it is launched, so start→stop can read 0s); otherwise start→stop.
    const durationMs = rec && typeof rec.duration_ms === 'number' ? rec.duration_ms : d.stoppedMs === null ? null : d.stoppedMs - d.startedMs;
    // Router R68: the effort this run really started with (its record), else the contract effort the dispatch named.
    const effort = rec && typeof rec.effort === 'string' && rec.effort ? rec.effort : d.effort;
    return { ...d, effort, lane: laneLabel(d.model), vendor: vendorOf(d.model), mark: markFor(d, run), observed, summary, durationMs };
  });
}

/** The work-ladder level a dispatch ran at: the agent's rung in WORK_LADDER, else its Claude tier's level; null when neither names it. */
export function levelOf(type: string, model: string): string | null {
  for (const [level, agents] of Object.entries(WORK_LADDER)) if (agents.includes(type)) return level;
  const tier = laneShort(model);
  for (const [level, t] of Object.entries(EFFORT_MODEL)) if (t === tier) return level;
  return null;
}

/**
 * The level a detail row draws. Router R68/R69: a codex run draws the effort it ran at, or nothing when
 * no effort is known; never its model's ladder rank, which made every Astra row read MAX at low effort.
 */
export function rowLevel(e: TrailEntry): string | null {
  return e.level === 'cross-vendor' ? e.effort : levelOf(e.type, e.model);
}

/** Detail rows for the newest `n` dispatches (route-label.ts agentRow; Router ISA R22 grammar). */
export function renderAgents(entries: TrailEntry[], n = 3): string[] {
  return entries.slice(0, n)
    .map((e) => agentRow({ type: e.type, lane: e.model, level: rowLevel(e), mark: e.mark, durationMs: e.durationMs, asked: e.description, said: e.summary }));
}

/**
 * One 🔀 segment. Agents are named for their lane, so `Sol→oai:Sol` would say nothing:
 * the arrow draws only when it carries information — a generic agent's lane, or on ✗ the model
 * that actually ran.
 */
export function segment(e: TrailEntry): string {
  const name = displayName(e.type);
  if (e.mark === '✗' && e.observed) return `${name}→${laneLabel(e.observed)} ✗`;
  if (name.toLowerCase() === laneName(e.model).toLowerCase()) return `${name} ${e.mark}`;
  return `${name}→${e.lane} ${e.mark}`;
}

/** The one-line form the statusline prints; empty when the session has dispatched nothing. */
export function render(entries: TrailEntry[]): string {
  if (entries.length === 0) return '';
  // Separator is a bar, never a dot: `·` is the unobserved MARK and must stay readable beside it.
  return '🔀 ' + entries.map(segment).join(' │ ');
}

/** What `RouteTrail.ts --session <id> --width <w>` prints by default (one summary line, then detail rows). */
export function routeTrailText(session: string, width: number, detail = 3, limit?: number): string {
  const entries = trail(session, { limit });
  const fit = (s: string) => (width > 0 ? fitWidth(s, width) : s);
  const lines: string[] = [];
  const line = render(entries); if (line) lines.push(fit(line));
  for (const r of renderAgents(entries, detail)) lines.push(fit(r));
  return lines.map((l) => l + '\n').join('');
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const arg = (flag: string) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
  const session = arg('--session');
  if (!session) { console.error('usage: RouteTrail.ts --session <id> [--limit N] [--json]'); process.exit(2); }
  const entries = trail(session, { limit: arg('--limit') ? Number(arg('--limit')) : undefined });
  const width = Number(arg('--width') ?? 0) || 0;
  const detail = arg('--detail') !== undefined ? Number(arg('--detail')) : 3;
  const fit = (s: string) => (width > 0 ? fitWidth(s, width) : s);
  if (args.includes('--json')) console.log(JSON.stringify(entries, null, 2));
  else {
    const line = render(entries); if (line) console.log(fit(line));
    for (const r of renderAgents(entries, detail)) console.log(fit(r));
  }
}
