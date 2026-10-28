/**
 * The `run` slice's live side (CENSVS ISA F9, ISC-44): what `Statvs.ts compare things-run`
 * diffs the things fold against.
 *
 * The record side is every `run` RES the things fold holds: written by the workflow engine's
 * ledger (engine/ledger.ts recordRunStart and recordRunEnd) through res.ts. The live side is
 * the engine's runs ledger, read-only. Both are keyed by run id and picked to RUN_FIELDS:
 * workflow (from the RES parent `workflow:<name>`), state (the ledger's status), trigger,
 * definition_hash and steps (step id → status).
 *
 * The window: runs that finished in the last 7 days, and only those that finished at or after
 * the first run row in the record. Runs before the dual-write began are in the ledger alone, so
 * comparing them would only measure history the record never had; a run that finished after
 * that point and is missing from the record is a real difference. The upper bound is the
 * moment the record side was projected, less a minute, so a run that ends while the compare
 * runs is left out of both sides. compare calls project() before live(), and project() hands
 * its bounds to live(); live() called alone computes the same bounds from the record.
 *
 * Imports from views/things.ts are types only (see live/isa.ts).
 *
 * @version 1.0.0
 */
import { readLedger, type LedgerRecord } from "../../WORKFLOWS/engine/ledger";
import { ledgerPath } from "../../WORKFLOWS/engine/paths";
import { recordFold } from "../ids";
import type { LiveSource, ThingRes, ThingsState, ThingsView } from "../../STATVS/views/things";

export const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Runs that finished in the last minute before the projection are left out of both sides. */
export const SETTLE_MS = 60 * 1000;
/** The fields a run RES is compared on, in the order a slice row lists them. */
export const RUN_FIELDS = ["workflow", "state", "trigger", "definition_hash", "steps"] as const;

export interface RunSlice {
  /** ISO bounds of the compared window; null when the record holds no run yet. */
  from: string | null;
  until: string;
  runs: Record<string, Record<string, unknown>>;
}

interface Bounds { from: string | null; until: string }

function bounds(firstRunRow: string | null, now: number): Bounds {
  const windowStart = new Date(now - WINDOW_MS).toISOString();
  const from = firstRunRow === null ? null : firstRunRow > windowStart ? firstRunRow : windowStart;
  return { from, until: new Date(now - SETTLE_MS).toISOString() };
}

const inWindow = (finished: unknown, b: Bounds): boolean =>
  typeof finished === "string" && b.from !== null && finished >= b.from && finished <= b.until;

/** One ledger record as the slice compares it. */
export function pickLedger(r: LedgerRecord): Record<string, unknown> {
  return {
    workflow: r.workflow,
    state: r.status,
    trigger: r.trigger,
    definition_hash: r.definition_hash,
    steps: Object.fromEntries(Object.entries(r.steps).map(([id, s]) => [id, s.status])),
  };
}

/** One run RES as the slice compares it. */
export function pickRes(r: ThingRes): Record<string, unknown> {
  const d = (r.data ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (typeof r.parent === "string" && r.parent.startsWith("workflow:")) out.workflow = r.parent.slice("workflow:".length);
  if (r.state !== undefined) out.state = r.state;
  for (const f of ["trigger", "definition_hash", "steps"] as const) if (d[f] !== undefined) out[f] = JSON.parse(JSON.stringify(d[f]));
  return out;
}

/** The ledger side of the slice for given bounds. */
export function ledgerSlice(records: LedgerRecord[], b: Bounds): RunSlice {
  const runs: Record<string, Record<string, unknown>> = {};
  for (const r of records) if (inWindow(r.finished_at, b)) runs[r.run_id] = pickLedger(r);
  return { from: b.from, until: b.until, runs };
}

/** The record side of the slice for given bounds. */
export function recordSlice(view: ThingsView, b: Bounds): RunSlice {
  const runs: Record<string, Record<string, unknown>> = {};
  for (const r of Object.values(view.res)) {
    if (r.kind !== "run") continue;
    const d = (r.data ?? {}) as Record<string, unknown>;
    if (!inWindow(d.finished_at, b) || typeof d.run_id !== "string") continue;
    runs[d.run_id] = pickRes(r);
  }
  return { from: b.from, until: b.until, runs };
}

/** The earliest row time of any run RES in a things view, or null. */
function firstRunInView(view: ThingsView): string | null {
  let first: string | null = null;
  for (const r of Object.values(view.res)) if (r.kind === "run" && r.since && (first === null || r.since < first)) first = r.since;
  return first;
}

/** The earliest row time of any run RES in the record (res stream), or null. */
function firstRunInRecord(): string | null {
  let first: string | null = null;
  for (const r of Object.values(recordFold().res)) if (r.kind === "run" && (first === null || r.created < first)) first = r.created;
  return first;
}

/**
 * The run live source over any ledger reader; the default reads the engine's live ledger.
 * Both sides are keyed by run id: a RES carries its run id in data.run_id, so a run whose RES
 * id is ledger.ts runResId's hashed form still lines up.
 */
export function runSource(read: () => LedgerRecord[] = () => readLedger(ledgerPath()).records, clock: () => number = Date.now): LiveSource {
  let handed: Bounds | null = null;
  return {
    kind: "run",
    project: (view: ThingsView, _state: ThingsState) => {
      handed = bounds(firstRunInView(view), clock());
      return recordSlice(view, handed);
    },
    live: () => {
      const b = handed ?? bounds(firstRunInRecord(), clock());
      handed = null;
      return ledgerSlice(read(), b);
    },
  };
}

export default runSource();
