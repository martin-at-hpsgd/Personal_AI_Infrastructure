/**
 * @version 1.0.0
 * Report.ts — Errata's own state, told once a day (current-ideal-delta F5).
 *
 * Errata reports to Vigil like every other LifeOS system: one roll-up event a day with counts by system and kind
 * and the number of entries stuck in the pipeline, plus one high event the first day a landed fix is seen to have
 * raised its skill's complaint rate. The same counts land in `<ERRATA_STATE_DIR>/state.json`, the file the Current
 * State region reads. Everything that leaves this module is counts and ids: no entry text, no health or money value.
 * Cluster alarms are Review's (ISC-80); single entries are the Vigil adapter's, on the Pulse feed.
 *
 *   bun LIFEOS/ERRATA/Errata.ts report [--json] [--dry-run]
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { invariant } from "../TOOLS/Invariant";
import { emitVigilEvent, vigilEvent, type VigilEvent } from "../TOOLS/lib/VigilOptional";
import { landedImpacts, type LandedReport } from "./Landed";
import { loadSources } from "./OutputJoin";
import { ERRATA_STATE_DIR, ErrataStore, TENANT_SOURCES, stateDirFor } from "./Store";
import type { Erratum, Status } from "./Schema";

/** The shared file contract the Current State region reads: counts and ids only. */
export interface ErrataState {
  generated_at: string;
  window_days: number;
  total: number;
  by_system: Record<string, number>;
  by_kind: Record<string, number>;
  stuck: number;
  praise: number;
  landed_rose: string[];
}

export interface ReportOptions {
  now?: Date;
  /** The landed-fix impact read; defaults to every applied or verified assay-miss upgrade (Landed.ts). */
  landed?: () => LandedReport;
  emit?: (e: VigilEvent) => unknown;
  /** Defaults to state.json in the store's own state dir: the real state dir only for the real ledger (Store.stateDirFor). */
  statePath?: string;
  /** Compute and return everything; write no file and emit nothing. */
  dryRun?: boolean;
}

export interface ReportResult { state: ErrataState; path: string; written: boolean; events: VigilEvent[] }

export const WINDOW_DAYS = 7;
/** The daily run enriches and triages every entry it can; one still waiting after two days is stuck. */
export const STUCK_HOURS = 48;
const ROLLUP_REF = "errata:daily";
/** Statuses the daily pipeline moves an entry out of. */
const WAITING: ReadonlySet<Status> = new Set<Status>(["new", "enriched"]);
/** Sources the daily pipeline never processes: backfill is not triaged daily, detected rows are inferred, tenant rows wait for a tenant key. */
const NOT_PIPELINED: ReadonlySet<string> = new Set(["backfill", "detected", ...TENANT_SOURCES]);

/** The real ledger's state file, the one the Current State region reads. */
export const defaultStatePath = (): string => join(ERRATA_STATE_DIR, "state.json");

/** A store's state file: the real one for the real ledger, one inside the store for any other, so a test run never rewrites it. */
export const statePathFor = (store: ErrataStore): string => join(stateDirFor(store), "state.json");

const tally = (values: string[]): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const v of [...values].sort()) out[v] = (out[v] ?? 0) + 1;
  return out;
};

/** The ledger's state over the window. Rows the evidence projector inferred (`detected`) are never counted. Pure. */
export function errataState(rows: Erratum[], landed: LandedReport, now: Date): ErrataState {
  const from = now.getTime() - WINDOW_DAYS * 86_400_000, stuckBefore = now.getTime() - STUCK_HOURS * 3_600_000;
  const counted = rows.filter((e) => e.source !== "detected");
  const recent = counted.filter((e) => { const t = Date.parse(e.ts); return t >= from && t <= now.getTime(); });
  const byKind = tally(recent.map((e) => e.kind));
  return {
    generated_at: now.toISOString(),
    window_days: WINDOW_DAYS,
    total: recent.length,
    by_system: tally(recent.map((e) => e.system)),
    by_kind: byKind,
    stuck: counted.filter((e) => WAITING.has(e.status) && !NOT_PIPELINED.has(e.source) && Date.parse(e.ts) < stuckBefore).length,
    praise: byKind.praise ?? 0,
    landed_rose: [...new Set(landed.impacts.filter((i) => i.impact.verdict === "higher").map((i) => i.upgrade_id))].sort(),
  };
}

const counts = (m: Record<string, number>): string => Object.entries(m).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k, n]) => `${k} ${n}`).join(", ") || "none";

/** One roll-up a day: the date is the event's occurrence, so a second run the same day dedups. Medium (the digest) only while entries are stuck. */
export function rollupEvent(s: ErrataState, now: Date): VigilEvent {
  const day = now.toLocaleDateString("en-CA");
  const title = `Errata, last ${s.window_days} days: ${s.total} entries, ${s.stuck} stuck`;
  const summary = [
    `By system: ${counts(s.by_system)}.`, `By kind: ${counts(s.by_kind)}.`,
    `Stuck in new or enriched past ${STUCK_HOURS} hours: ${s.stuck}.`,
    s.landed_rose.length ? `Landed fixes followed by more complaints: ${s.landed_rose.join(", ")}.` : "",
    "Look: bun LIFEOS/ERRATA/Errata.ts report",
  ].filter(Boolean).join(" ");
  return vigilEvent("errata", ROLLUP_REF, "rollup", s.stuck > 0 ? "medium" : "low", title, summary, "customer", null, day);
}

/** One high event per landed fix, the first day its skill's complaint rate is seen to have risen. */
export function landedRoseEvent(report: LandedReport, id: string): VigilEvent {
  const i = report.impacts.find((x) => x.upgrade_id === id);
  invariant(i !== undefined && i.impact.verdict === "higher", `landed impact for ${id} rose`);
  const points = i.impact.delta === null ? "" : ` by ${(i.impact.delta * 100).toFixed(1)} points`;
  return vigilEvent("errata", `errata:landed:${id}`, "rose", "high",
    `Errata: landed fix ${id} raised complaints on ${i.impact.skill}`,
    `Upgrade ${id} landed ${i.landed.slice(0, 10)}. In the ${i.impact.days} days after, the complaint rate for ${i.impact.skill} rose${points}. Look: bun LIFEOS/ERRATA/Errata.ts impact --landed`,
    "customer");
}

function previousRose(path: string): Set<string> {
  try {
    const prior = JSON.parse(readFileSync(path, "utf8")) as Partial<ErrataState>;
    return new Set(Array.isArray(prior.landed_rose) ? prior.landed_rose.filter((x): x is string => typeof x === "string") : []);
  } catch { return new Set(); }
}

const isCount = (n: unknown): boolean => Number.isInteger(n) && (n as number) >= 0;

/** Writes the state file whole (temp file, then rename), after asserting it is the contract shape and its counts agree. */
export function writeErrataState(path: string, s: ErrataState): void {
  invariant(!Number.isNaN(Date.parse(s.generated_at)), "generated_at is a timestamp");
  invariant(s.window_days === WINDOW_DAYS && isCount(s.total) && isCount(s.stuck) && isCount(s.praise), "state counts are whole numbers");
  for (const m of [s.by_system, s.by_kind]) {
    invariant(Object.values(m).every(isCount), "tallies are whole numbers");
    invariant(Object.values(m).reduce((a, b) => a + b, 0) === s.total, "each tally sums to the total");
  }
  invariant(s.praise === (s.by_kind.praise ?? 0), "praise matches its kind tally");
  invariant(Array.isArray(s.landed_rose) && s.landed_rose.every((x) => typeof x === "string" && x.length > 0 && !/\s/.test(x)), "landed_rose holds ids only");
  const body = JSON.stringify(s, null, 2) + "\n";
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, body);
  renameSync(tmp, path);
}

/** What a scheduled run keeps of a report: where the state went, its headline counts, and how many events left. */
export function summarize(r: ReportResult): { path: string; written: boolean; total: number; stuck: number; landed_rose: string[]; events: number } {
  return { path: r.path, written: r.written, total: r.state.total, stuck: r.state.stuck, landed_rose: r.state.landed_rose, events: r.events.length };
}

export function errataReport(store: ErrataStore, o: ReportOptions = {}): ReportResult {
  const now = o.now ?? new Date();
  const path = o.statePath ?? statePathFor(store);
  const landed = (o.landed ?? (() => landedImpacts(store, loadSources(), { now })))();
  const state = errataState(store.list({}), landed, now);
  const told = previousRose(path);
  const events = [rollupEvent(state, now), ...state.landed_rose.filter((id) => !told.has(id)).map((id) => landedRoseEvent(landed, id))];
  if (o.dryRun) return { state, path, written: false, events };
  // Emit before the state file records what was told: a failed write re-tells tomorrow, and Vigil dedups the repeat by its key.
  for (const e of events) (o.emit ?? emitVigilEvent)(e);
  writeErrataState(path, state);
  return { state, path, written: true, events };
}
