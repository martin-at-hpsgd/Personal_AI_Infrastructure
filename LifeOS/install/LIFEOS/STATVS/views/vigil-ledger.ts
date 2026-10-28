/**
 * The `vigil-ledger` view: Vigil's history, folded from its own streams (migration design §1.3, §3 Lane D).
 *
 * It replaces the tick's per-run re-parse of the 65 MB outbox. From stream `vigil` (decision rows,
 * writer `wf:vigil-tick`) and `vigil-log` (tick, cutover rows) it keeps, for the last 8 days of what
 * it has seen: texts sent, stories told (key, ts, severity, source), editor texts, job ids decided,
 * shadow decisions, work-repo filings, the answered set (row ids and event ids) and the brief queue.
 *
 * The decision-row contract it reads (§2.4; Decision.ts writes it):
 *   ref = the answered row id; data { answers, event_id?, outcome, reason, brief?, delivery?: { state },
 *   key?, severity?, source?, editor?, job?, shadow?, workrepo? }.
 * A `vigil-log` `tick` row with data.brief_sent true marks a morning brief; brief rows decided before it
 * have been delivered. A `vigil-log` `cutover` row's data.event_ids are rows the last legacy tick
 * answered with no notification row (pulse, digest): they join the answered set (S3).
 *
 * Until p3, `vigilLedger()` also folds two legacy files, read from Vigil's state dir and never from
 * stream `event` (writeEvent refuses `source: vigil`, so no one can forge one there, P1):
 *   - `source: vigil` notification rows in outbox.jsonl: the 72-hour story hold, sent texts, decided
 *     jobs and the answered set carry over to the first new tick;
 *   - digest.jsonl entries newer than the last brief, so items queued before the switch reach the next one.
 *
 * STATVS code outside tests never imports LIFEOS/VIGIL (S9): the legacy paths come from legacyOutbox.ts
 * and the story shape is declared here. The fold keeps keyed maps and a max, so any row order folds to
 * the same state, and its window is relative to the newest row seen, never the clock.
 * 1.1.0: a legacy notification row with no meta.source (the floor-send row) takes source, severity and key
 * from the event it answers, as Tick.sentStories does.
 * @version 1.1.0
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readViewDef, type FoldOptions, type ViewDef } from "../lib/views";
import { statvsStateDir } from "../lib/record";
import { digestPath, outboxPath } from "../lib/legacyOutbox";
import type { StatvsRow } from "../lib/types";

const DAY_MS = 86_400_000;
/** How long the fold keeps a decision: a day more than the longest window a reader asks for. */
export const LEDGER_KEEP_DAYS = 8;
export const ANSWERED_DAYS = 7;
export const STORY_HOLD_MS = 72 * 3_600_000;

type Sev = "info" | "low" | "medium" | "high" | "critical";
const SEVERITIES: readonly string[] = ["info", "low", "medium", "high", "critical"];
const OUTCOMES: readonly string[] = ["let_be", "pulse", "research", "prepare", "background", "tell_now"];

/** One decision, as much as the ledger needs. */
export interface LedgerDecision {
  ts: string;
  answers: string;
  event_id?: string;
  outcome: string;
  delivery?: "sent" | "failed" | "held";
  brief?: true;
  key?: string;
  severity?: Sev;
  source?: string;
  editor?: true;
  job?: true;
  shadow?: true;
  workrepo?: string;
}

export interface LedgerState {
  /** The newest ts folded; the keep window is relative to it. */
  newest: string;
  /** decision row id → decision. */
  decisions: Record<string, LedgerDecision>;
  /** Event ids named by cutover rows (sorted, unique). */
  cutover: string[];
  /** ts of the latest morning brief recorded in vigil-log. */
  last_brief: string;
}

/** A story Vigil texted; the shape Route.ts's SentStory has. */
export type LedgerStory = { key: string; ts: string; severity?: Sev; source?: string };

export interface VigilLedger {
  /** Every sent, non-shadow text's send time (the 24-hour ceiling's count). */
  texts: string[];
  /** Stories texted, for the 72-hour hold and the per-source caps. */
  stories: LedgerStory[];
  /** Editor texts sent. */
  editor_texts: string[];
  /** Job event ids decided for real (sent, failed or held). */
  jobs_decided: string[];
  /** Work-repo filing times. */
  workrepo: string[];
  /** Shadow decision row ids. */
  shadow: string[];
  /** Row ids and event ids answered in the last 7 days. */
  answered: Set<string>;
  /** Brief rows decided after the last brief: { answers, event_id, ts }. */
  brief: Array<{ answers: string; event_id?: string; ts: string }>;
  /** Legacy digest.jsonl lines newer than the last brief (until p3). */
  legacy_digest: Array<Record<string, unknown>>;
  /** When the last brief went out (the ledger's, else the last digest hour). */
  last_brief: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
const ms = (ts: string): number => { const t = Date.parse(ts); return Number.isFinite(t) ? t : NaN; };

/** The oldest ts the keep window holds, relative to the newest row seen; NaN before any row. */
const keepFloor = (newest: string): number => ms(newest) - LEDGER_KEEP_DAYS * DAY_MS;
const dayOf = (ts: string): number => Math.floor(ms(ts) / DAY_MS);

/** Drop decisions older than the keep window, in place. One pass over the map, run once per UTC day of `newest`. */
function prune(decisions: Record<string, LedgerDecision>, newest: string): void {
  const floor = keepFloor(newest);
  if (!Number.isFinite(floor)) return;
  for (const id of Object.keys(decisions)) if (ms(decisions[id]!.ts) < floor) delete decisions[id];
}

function decisionOf(row: StatvsRow): LedgerDecision | null {
  const d = isObj(row.data) ? row.data : null;
  const answers = str(d?.answers) ?? str(row.ref);
  const outcome = str(d?.outcome);
  if (!d || !answers || !outcome || !OUTCOMES.includes(outcome) || !Number.isFinite(ms(row.ts))) return null;
  const out: LedgerDecision = { ts: row.ts, answers, outcome };
  const eid = str(d.event_id); if (eid) out.event_id = eid;
  const delivery = isObj(d.delivery) ? str(d.delivery.state) : undefined;
  if (delivery === "sent" || delivery === "failed" || delivery === "held") out.delivery = delivery;
  if (d.brief === true) out.brief = true;
  const key = str(d.key); if (key) out.key = key;
  const sev = str(d.severity); if (sev && SEVERITIES.includes(sev)) out.severity = sev as Sev;
  const source = str(d.source); if (source) out.source = source;
  if (d.editor !== undefined && d.editor !== null && d.editor !== false) out.editor = true;
  if (d.job !== undefined && d.job !== null && d.job !== false) out.job = true;
  if (d.shadow === true) out.shadow = true;
  const wr = str(d.workrepo); if (wr) out.workrepo = wr;
  return out;
}

/**
 * Fold one row. The decisions map is updated in place (the state stays plain JSON): copying it per row made a
 * full refold quadratic, about 52 s for 20,000 decisions, against the ~88,000 an 8-day window holds. A decision
 * already older than the keep window is never added, and the map is pruned only when `newest` crosses into a new
 * UTC day, so between prunes it may hold up to a day past the window; `ledgerOf` applies the same floor, so the
 * ledger it builds does not depend on row order.
 */
export function foldVigilLedger(state: LedgerState, row: StatvsRow): LedgerState {
  if (row.stream !== "vigil" && row.stream !== "vigil-log") return state;
  const newest = row.ts > state.newest ? row.ts : state.newest;
  let next: LedgerState = newest === state.newest ? state : { ...state, newest };
  if (row.stream === "vigil" && row.kind === "decision") {
    const d = decisionOf(row);
    if (d && !(ms(d.ts) < keepFloor(newest))) next.decisions[row.id] = d;
  } else if (row.stream === "vigil-log" && row.kind === "cutover" && isObj(row.data) && Array.isArray(row.data.event_ids)) {
    const ids = row.data.event_ids.filter((x): x is string => typeof x === "string" && x.length > 0);
    next = { ...next, cutover: [...new Set([...next.cutover, ...ids])].sort() };
  } else if (row.stream === "vigil-log" && row.kind === "tick" && isObj(row.data) && row.data.brief_sent === true && row.ts > next.last_brief) {
    next = { ...next, last_brief: row.ts };
  }
  if (state.newest && dayOf(newest) !== dayOf(state.newest)) prune(next.decisions, newest);
  return next;
}

/** The most recent `hour`:00 local time at or before `now` (the legacy brief's schedule). */
export function lastDigestHour(now: number, hour = 8): string {
  const d = new Date(now);
  d.setHours(hour, 0, 0, 0);
  if (d.getTime() > now) d.setDate(d.getDate() - 1);
  return d.toISOString();
}

type LegacyRow = { id?: unknown; source?: unknown; kind?: unknown; ts?: unknown; ref?: unknown; summary?: unknown; meta?: unknown };

function jsonl(path: string): unknown[] {
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch { return []; }
  const out: unknown[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try { out.push(JSON.parse(line)); } catch { /* a torn line: skip */ }
  }
  return out;
}

/** The ledger from the view state, the legacy files (until p3), and the clock. Pure apart from the two file reads. */
export function ledgerOf(state: LedgerState, opts: { now?: number; legacy?: boolean; digestHour?: number } = {}): VigilLedger {
  const now = opts.now ?? Date.now();
  const answeredFloor = now - ANSWERED_DAYS * DAY_MS;
  const out: VigilLedger = { texts: [], stories: [], editor_texts: [], jobs_decided: [], workrepo: [], shadow: [], answered: new Set(state.cutover), brief: [], legacy_digest: [], last_brief: "" };
  const dayHour = lastDigestHour(now, opts.digestHour ?? 8);
  out.last_brief = state.last_brief > dayHour ? state.last_brief : dayHour;

  const floor = keepFloor(state.newest);
  const decisions = Object.entries(state.decisions).filter(([, d]) => !(ms(d.ts) < floor)).sort(([a, x], [b, y]) => (x.ts < y.ts ? -1 : x.ts > y.ts ? 1 : a < b ? -1 : 1));
  for (const [id, d] of decisions) {
    if (d.shadow) { out.shadow.push(id); continue; }
    if (ms(d.ts) >= answeredFloor) { out.answered.add(d.answers); if (d.event_id) out.answered.add(d.event_id); }
    if (d.outcome === "tell_now" && d.delivery === "sent") {
      out.texts.push(d.ts);
      if (d.key) out.stories.push({ key: d.key, ts: d.ts, ...(d.severity ? { severity: d.severity } : {}), ...(d.source ? { source: d.source } : {}) });
      if (d.editor) out.editor_texts.push(d.ts);
    }
    if (d.job && d.delivery) out.jobs_decided.push(d.event_id ?? d.answers);
    if (d.workrepo === "workrepo") out.workrepo.push(d.ts);
    if (d.brief && d.ts > out.last_brief) out.brief.push({ answers: d.answers, ...(d.event_id ? { event_id: d.event_id } : {}), ts: d.ts });
  }

  if (opts.legacy !== false) {
    const outbox = jsonl(outboxPath());
    // A legacy notification row may carry no source, severity or key in its meta (the floor-send row writes no
    // source). Fill them from the event it answers, by id, exactly as Tick.sentStories does, so a sent story always
    // counts toward its source's cap and the 24-hour text count. Only the referenced ids are kept in the map.
    const wanted = new Set<string>();
    for (const raw of outbox) {
      const e = raw as LegacyRow;
      if (!isObj(e) || e.source !== "vigil" || e.kind !== "notification") continue;
      const meta = isObj(e.meta) ? e.meta : {};
      const ref = str(e.ref);
      if (ref && meta.decision === "sent" && (!str(meta.source) || !str(meta.severity) || !str(meta.key))) wanted.add(ref);
    }
    const answeredEvent = new Map<string, { source?: string; severity?: string; key?: string }>();
    if (wanted.size) for (const raw of outbox) {
      const e = raw as LegacyRow & { severity?: unknown; dedup_key?: unknown };
      const id = isObj(e) ? str(e.id) : undefined;
      if (!id || !wanted.has(id) || e.source === "vigil") continue;
      const meta = isObj(e.meta) ? e.meta : {};
      answeredEvent.set(id, { source: str(e.source), severity: str(e.severity), key: str(meta.key) });
    }
    for (const raw of outbox) {
      const e = raw as LegacyRow;
      if (!isObj(e) || e.source !== "vigil" || e.kind !== "notification" || typeof e.ts !== "string") continue;
      const t = ms(e.ts);
      if (!Number.isFinite(t) || t < answeredFloor) continue;
      const meta = isObj(e.meta) ? e.meta : {};
      if (meta.shadow === true) continue;
      const ref = str(e.ref);
      if (ref) out.answered.add(ref);
      if (meta.job === true && ref) out.jobs_decided.push(ref);
      if (typeof e.summary === "string" && /text sent/.test(e.summary)) out.texts.push(e.ts);
      if (meta.decision === "sent") {
        const of = ref ? answeredEvent.get(ref) : undefined;
        // Tick.sentStories falls back to storyKeyOf(the answered event); STATVS may not import Vigil's Route (S9),
        // so the fallback here is the event's own meta.key, which storyKeyOf returns first (with its watch- prefix rule).
        const key = str(meta.key) ?? (of?.key && of.source?.startsWith("watch-") && !of.key.startsWith("watch-") ? `${of.source}:${of.key}` : of?.key);
        const sev = str(meta.severity) ?? of?.severity;
        const source = str(meta.source) ?? of?.source;
        if (key) out.stories.push({ key, ts: e.ts, ...(sev && SEVERITIES.includes(sev) ? { severity: sev as Sev } : {}), ...(source ? { source } : {}) });
        if (meta.editor === true) out.editor_texts.push(e.ts);
      }
    }
    for (const raw of jsonl(digestPath())) {
      if (!isObj(raw) || typeof raw.ts !== "string" || !(raw.ts > out.last_brief)) continue;
      out.legacy_digest.push(raw);
    }
  }
  out.texts.sort();
  out.jobs_decided = [...new Set(out.jobs_decided)];
  return out;
}

const vigilLedgerView: ViewDef<LedgerState> = {
  name: "vigil-ledger",
  group: "vigil",
  streams: ["vigil", "vigil-log"],
  classes: ["personal"],
  path: "statvs-views/vigil-ledger.json",
  init: () => ({ newest: "", decisions: {}, cutover: [], last_brief: "" }),
  fold: foldVigilLedger,
  render: (state) => ({ keep_days: LEDGER_KEEP_DAYS, newest: state.newest, last_brief: state.last_brief, cutover: state.cutover.length, decisions: Object.keys(state.decisions).length }),
};

/** Where the view's checkpoint lives: the live views dir, or under `bun test` the temp state dir (as event.ts does). */
function outDir(): string | undefined {
  if (process.env.STATVS_VIEWS_DIR) return undefined;
  return process.env.NODE_ENV === "test" ? join(statvsStateDir(), "views") : undefined;
}

/** Read the view (incrementally, through its checkpoint) and build the ledger. */
export function vigilLedger(opts: { now?: number; legacy?: boolean; digestHour?: number } & FoldOptions = {}): VigilLedger {
  const dir = opts.outDir ?? outDir();
  const r = readViewDef(vigilLedgerView, { ...(opts.recordDir ? { recordDir: opts.recordDir } : {}), ...(dir ? { outDir: dir } : {}) });
  return ledgerOf(r.state, opts);
}

export default vigilLedgerView;
