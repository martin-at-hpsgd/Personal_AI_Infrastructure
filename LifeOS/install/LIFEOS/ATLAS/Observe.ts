/**
 * Atlas observes into the record (CENSVS ISA F10, ISC-45..ISC-47).
 *
 * After a collector run commits to atlas.db, observeSync() diffs every mapped asset (the same
 * mapping the things-atlas slice compares, CENSVS/live/atlas.ts) against the RES the record
 * already holds for it (the things-atlas slice, folded from the `observe` stream) and appends:
 *
 *  - one `observe` row (subject `<kind>:<key>`, op `observe`) per asset that APPEARED (the record
 *    has no RES for it), CHANGED (its title, state or carried data differ) or EXPIRED (its state
 *    moved into the gone bucket, or it left atlas.db, which is written as the gone state with
 *    `data.absent: true`);
 *  - one `sync` row per collector run: {collector, scope, run, complete, appeared, changed,
 *    expired, unchanged, refused}, so a quiet run is still on the record.
 *
 * An unchanged asset writes nothing. The first observe after this lands has an empty record, so
 * every mapped asset is written once as appeared (a one-time cost of one row per mapped asset).
 *
 * Rows go only to the `observe` stream, which streams.ts registers `ship: false`: estate-class
 * rows (credential, ingest, capability, control) never leave the machine unsealed (ISC-46). The
 * writer asserts that flag before it writes, and writes nothing while the stream is unregistered.
 * A credential RES carries its name, vendor and tier only, never a value.
 *
 * observeSync never throws for an operational failure (it returns ok:false with the reason); an
 * InvariantViolation is rethrown, so a direct caller and every test still see it loud.
 *
 * Atlas runs each collector through runCollector() (ISC-65): collect, apply to atlas.db, then
 * observeAfterApply(). Once the run has applied, nothing in the observe step can fail it: any
 * failure, an impossible state included, is written as a STATVS event (source `atlas`, kind
 * infra, high for an InvariantViolation, medium otherwise, deduplicated per collector run),
 * printed to stderr, and returned in the result; the collector run stays ok. The next sync
 * diffs atlas.db against the record again, so the rows this run missed are written then.
 *
 * Concept: LIFEOS/DOCUMENTATION/Censvs/CensvsSystem.md * @version 1.0.0
 */
import type { Database } from "bun:sqlite";
import { invariant, InvariantViolation } from "../TOOLS/Invariant";
import { canonicalJson } from "../TOOLS/lib/LedgerCore";
import { append } from "../STATVS/lib/record";
import { writeEvent } from "../STATVS/lib/event";
import { streamDef } from "../STATVS/streams";
import type { AppendResult, StatvsInput } from "../STATVS/lib/types";
import { GENERA, bucketOf, canonicalState, validSubject } from "../CENSVS/genera";
import { atlasSource, mapAssets, type ObservedRes } from "../CENSVS/live/atlas";
import { atlasState } from "../CENSVS/sources/atlas";
import type { CollectResult, Collector } from "./Store";

export const OBSERVE_STREAM = "observe";
export const ATLAS_WRITER = "tool:Atlas";

export type Change = "appeared" | "changed" | "expired";

/** What an observe row's data holds, as the things fold reads it (create/observe payload). */
export interface ObservePayload {
  title?: string;
  state: string;
  data?: Record<string, unknown>;
  unset?: string[];
}

export interface Delta {
  id: string;
  kind: string;
  change: Change;
  payload: ObservePayload;
}

export interface ObserveRun {
  collector: string;
  scope: string;
  runId: number;
  complete: boolean;
  assets?: number;
  edges?: number;
}

export interface ObserveOptions {
  /** The record (default statvsDir()). */
  recordDir?: string;
  /** Where the things-atlas slice's output and checkpoint live (default viewsDir()). */
  outDir?: string;
  /** The append to use (default the record's own); tests may wrap it. */
  append?: (input: StatvsInput) => AppendResult;
}

export interface ObserveResult {
  ok: boolean;
  appeared: number;
  changed: number;
  expired: number;
  unchanged: number;
  /** Assets left out by a named ATLAS_KIND_MAP skip. */
  skipped: number;
  /** Assets with no mapping, no valid id or no state for their status. */
  unmapped: number;
  /** Rows the record refused (each counted by the record too). */
  refused: number;
  /** Rows appended or spooled, the sync row included. */
  rows: number;
  ms: number;
  error?: string;
}

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);

/** The gone state an asset reads as once it has left atlas.db. */
function goneState(kind: string, current: string): string | null {
  if (bucketOf(kind, current) === "gone") return current;
  return atlasState(kind, "expired");
}

/**
 * The rows a sync owes the record: `prev` is what the record holds (data may carry `absent`),
 * `seen` is atlas.db now. Pure; deltas are sorted by id.
 */
export function diffAtlas(prev: ReadonlyMap<string, ObservedRes>, seen: ReadonlyMap<string, ObservedRes>): { deltas: Delta[]; unchanged: number } {
  const deltas: Delta[] = [];
  let unchanged = 0;
  for (const s of seen.values()) {
    const p = prev.get(s.id);
    if (!p) {
      deltas.push({ id: s.id, kind: s.kind, change: "appeared", payload: { title: s.title, state: s.state, data: { ...s.data } } });
      continue;
    }
    if (p.title === s.title && p.state === s.state && canonicalJson(p.data) === canonicalJson(s.data)) {
      unchanged++;
      continue;
    }
    const expired = bucketOf(s.kind, s.state) === "gone" && bucketOf(p.kind, p.state) !== "gone";
    const payload: ObservePayload = { title: s.title, state: s.state, data: { ...s.data } };
    const unset = Object.keys(p.data).filter((k) => !Object.hasOwn(s.data, k)).sort();
    if (unset.length) payload.unset = unset;
    deltas.push({ id: s.id, kind: s.kind, change: expired ? "expired" : "changed", payload });
  }
  for (const p of prev.values()) {
    if (seen.has(p.id) || p.data.absent === true) continue;
    const gone = goneState(p.kind, p.state);
    if (gone === null) continue;
    deltas.push({ id: p.id, kind: p.kind, change: "expired", payload: { state: gone, data: { absent: true } } });
  }
  deltas.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { deltas, unchanged };
}

/** The RES the record already holds for Atlas: the things-atlas slice's fold, read incrementally. */
async function recorded(opts: ObserveOptions): Promise<Map<string, ObservedRes>> {
  // Loaded here, not at module load: the things view imports every live source, and Atlas's
  // other commands (status, owns, blast...) never need it.
  const { sliceView, renderThings } = await import("../STATVS/views/things");
  const { readViewDef } = await import("../STATVS/lib/views");
  const read = readViewDef(sliceView(atlasSource()), { recordDir: opts.recordDir, outDir: opts.outDir });
  const view = renderThings(read.state);
  const out = new Map<string, ObservedRes>();
  for (const r of Object.values(view.res)) {
    const d = r.data ?? {};
    if (typeof d.atlas_kind !== "string") continue;
    out.set(r.id, { id: r.id, kind: r.kind, title: r.title, state: r.state ?? "", data: { ...d } });
  }
  return out;
}

function refusedForPersonal(r: AppendResult): boolean {
  return !r.ok && "refused" in r && /^Personal data refused/.test(r.refused);
}

/**
 * Diff atlas.db against the record and append what changed, plus one sync row. Call once per
 * collector run, after applyRun has committed.
 */
export async function observeSync(store: { db: Database }, run: ObserveRun, opts: ObserveOptions = {}): Promise<ObserveResult> {
  const t0 = Date.now();
  const res: ObserveResult = { ok: true, appeared: 0, changed: 0, expired: 0, unchanged: 0, skipped: 0, unmapped: 0, refused: 0, rows: 0, ms: 0 };
  const done = (error?: string): ObserveResult => {
    res.ms = Date.now() - t0;
    if (error !== undefined) { res.ok = false; res.error = error; }
    return res;
  };
  try {
    const def = streamDef(OBSERVE_STREAM);
    if (!def) return done(`the ${OBSERVE_STREAM} stream is not registered (CENSVS F3 not applied); nothing written`);
    // Estate rows may be written only to a stream that never ships (ISC-46).
    invariant((def as { ship?: unknown }).ship === false, `the ${OBSERVE_STREAM} stream must be ship:false before Atlas writes estate rows to it`);

    const seen = mapAssets(store.db);
    res.skipped = seen.skipped;
    res.unmapped = seen.unmapped;
    const prev = await recorded(opts);
    const { deltas, unchanged } = diffAtlas(prev, seen.res);
    res.unchanged = unchanged;

    const write = opts.append ?? append;
    for (const d of deltas) {
      invariant(validSubject(d.id) === null && d.id.startsWith(`${d.kind}:`), `atlas observe: bad subject ${d.id}`);
      invariant(canonicalState(d.kind, d.payload.state) === d.payload.state, `atlas observe: ${d.payload.state} is not a declared ${d.kind} state`);
      invariant(!isObj(d.payload.data) || d.kind !== "credential" || Object.keys(d.payload.data).every((k) => ["atlas_kind", "species", "vendor", "tier", "absent"].includes(k)),
        `atlas observe: a credential RES carries only name, vendor and tier`);
      const input = { writer: ATLAS_WRITER, stream: OBSERVE_STREAM, class: GENERA[d.kind]!.class, kind: d.change, subject: d.id, op: "observe", data: d.payload } as StatvsInput;
      let r = write(input);
      // The class only rises: a title the record reads as personal makes the row (and so the RES) personal.
      if (refusedForPersonal(r) && input.class !== "personal") r = write({ ...input, class: "personal" });
      if (!r.ok && "refused" in r) { res.refused++; continue; }
      if (r.ok && (r.row as { subject?: unknown }).subject !== d.id) {
        res.rows++;
        return done(`the record dropped the row's subject (CENSVS F3 not applied); stopped after ${d.id}`);
      }
      res.rows++;
      res[d.change]++;
    }

    const sync = write({
      writer: ATLAS_WRITER, stream: OBSERVE_STREAM, class: "system", kind: "sync",
      data: {
        collector: run.collector, scope: run.scope, run: run.runId, complete: run.complete,
        ...(run.assets !== undefined ? { assets: run.assets } : {}), ...(run.edges !== undefined ? { edges: run.edges } : {}),
        appeared: res.appeared, changed: res.changed, expired: res.expired, unchanged: res.unchanged, refused: res.refused,
      },
    });
    if (!sync.ok && "refused" in sync) { res.refused++; return done(`sync row refused: ${sync.refused}`); }
    res.rows++;
    return done(res.refused > 0 ? `${res.refused} observe row(s) refused by the record` : undefined);
  } catch (e) {
    if (e instanceof InvariantViolation) throw e;
    return done(`observe failed: ${(e as Error)?.message ?? String(e)}`);
  }
}

// ── A collector run, and an observe step that can never fail it (ISC-65) ──

/** The event source every observe-failure event carries. */
export const OBSERVE_EVENT_SOURCE = "atlas";

/** Write one observe failure as a STATVS event. Best effort: a refused or failed write is printed, never thrown. */
function recordObserveFailure(run: ObserveRun, r: ObserveResult, impossible: boolean): void {
  const what = impossible ? "an impossible state in the observe step" : "the observe step did not fully land";
  const base = {
    source: OBSERVE_EVENT_SOURCE,
    ts: new Date().toISOString(),
    kind: "infra" as const,
    severity: impossible ? ("high" as const) : ("medium" as const),
    title: `Atlas observe failed for ${run.collector}`.slice(0, 140),
    privacy_class: "personal" as const,
    dedup_key: `atlas-observe-failed:${run.collector}:${run.scope}:${run.runId}`,
    meta: { collector: run.collector, scope: run.scope, run: run.runId, impossible, rows: r.rows, refused: r.refused },
  };
  const tail = `Sync run ${run.runId} applied to atlas.db and stays ok; the next sync re-diffs and writes what this run missed.`;
  try {
    let sent = writeEvent({ ...base, summary: `${what}: ${r.error ?? "unknown"}. ${tail}`.slice(0, 1000) });
    // The error text may read as credential-shaped to the event checks; the failure is still recorded, without it.
    if (!sent.ok) sent = writeEvent({ ...base, summary: `${what} (detail withheld: ${sent.refused}). ${tail}`.slice(0, 1000) });
    if (!sent.ok) console.error(`  ↳ observe ${run.collector}: the failure event was refused (${sent.refused})`);
  } catch (e) {
    console.error(`  ↳ observe ${run.collector}: the failure event could not be written (${(e as Error)?.message ?? String(e)})`);
  }
}

/**
 * Observe a run that has already applied to atlas.db. Never throws: an InvariantViolation from
 * observeSync becomes an ok:false result, and every ok:false result is written as a STATVS event
 * and printed to stderr. The applied run is never undone or failed by this step.
 */
export async function observeAfterApply(store: { db: Database }, run: ObserveRun, opts: ObserveOptions = {}): Promise<ObserveResult> {
  let r: ObserveResult;
  let impossible = false;
  try {
    r = await observeSync(store, run, opts);
  } catch (e) {
    impossible = e instanceof InvariantViolation;
    const err = e as Error;
    r = { ok: false, appeared: 0, changed: 0, expired: 0, unchanged: 0, skipped: 0, unmapped: 0, refused: 0, rows: 0, ms: 0,
      error: `${err?.name ?? "Error"}: ${err?.message ?? String(e)}` };
  }
  if (!r.ok) {
    if (impossible) console.error(`  ↳ observe ${run.collector}: ${r.error} (recorded as a STATVS event; the sync stays applied)`);
    recordObserveFailure(run, r, impossible);
  }
  return r;
}

export type CollectorRun =
  | { ok: true; runId: number; swept: boolean; result: CollectResult; observe: ObserveResult }
  | { ok: false; error: string };

/**
 * One collector run, as Atlas's sync runs it: collect, apply to atlas.db, then observe. A collector
 * that throws, or a run that will not apply, writes nothing and is a failed run. Once applyRun has
 * committed, the run is ok whatever the observe step does (ISC-65). `onApplied` runs between the
 * two, so the sync log prints the run before its observe line.
 */
export async function runCollector(
  store: { db: Database; applyRun(collector: string, scope: string, result: CollectResult): { runId: number; swept: boolean } },
  collector: Collector,
  scope: string,
  opts: ObserveOptions & { onApplied?: (applied: { runId: number; swept: boolean; result: CollectResult }) => void } = {},
): Promise<CollectorRun> {
  let result: CollectResult;
  let applied: { runId: number; swept: boolean };
  try {
    result = await collector.collect(scope === "full" ? undefined : scope);
    applied = store.applyRun(collector.name, scope, result);
  } catch (err) {
    // A failed collector writes NOTHING: prior graph state stays intact.
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  try { opts.onApplied?.({ ...applied, result }); } catch { /* the log line is not the sync */ }
  const { onApplied: _o, ...observeOpts } = opts;
  const observe = await observeAfterApply(store, {
    collector: collector.name, scope, runId: applied.runId, complete: result.complete, assets: result.assets.length, edges: result.edges.length,
  }, observeOpts);
  return { ok: true, runId: applied.runId, swept: applied.swept, result, observe };
}

/** One line for the sync log: what the record got from this run. */
export function observeLine(collector: string, r: ObserveResult): string {
  const counts = `+${r.appeared} ~${r.changed} -${r.expired} (${r.unchanged} unchanged), ${r.rows} rows, ${r.ms} ms`;
  return r.ok ? `  ↳ observe ${collector}: ${counts}` : `  ↳ observe ${collector}: ${counts}; ${r.error}`;
}

/** Print observeLine, to stderr when the observe did not fully land. */
export function logObserve(collector: string, r: ObserveResult): void {
  (r.ok ? console.log : console.error)(observeLine(collector, r));
}
