#!/usr/bin/env bun
// ported from public PR #1754, @elhoim
/**
 * @version 1.1.3
 * Apple Health import — turns the Health app's "Export All Health Data" backup
 * into a markdown summary the Pulse HEALTH tab reads.
 *
 * TWO OUTPUTS. (1) APPLE_HEALTH.md, a markdown summary the Health tab lists as a
 * file (headings carry the headline numbers because the page renders headings).
 * (2) With --days-out, one healthsync DayFile per day under USER/HEALTH/DATA/apple
 * for the WHOLE export — years of steps, heart, sleep stages, weight — which the
 * Pulse trend board merges with Oura day by day. That is how history reaches the
 * Week … Lifetime tabs.
 *
 * SCALE. export.xml is routinely multi-gigabyte, so the file is never read
 * whole: it is streamed in chunks and matched per `<Record .../>` element. Peak
 * memory is one chunk plus the daily aggregates, not the export.
 *
 * WRITES ONE FILE, OWNS IT COMPLETELY. Output is APPLE_HEALTH.md, regenerated
 * end to end on every run. Hand-authored files (METRICS.md, FITNESS.md, lab
 * results) are never read or touched — this cannot clobber your own notes.
 *
 * Usage:
 *   bun AppleHealthImport.ts <export.zip|export.xml> [--days N] [--out PATH] [--days-out [DIR]] [--overwrite] [--dry-run]
 *
 *   --days N     Window to summarise, in days back from the newest sample (default 90)
 *   --days-out   Also write one healthsync DayFile per day for the WHOLE export into DIR
 *                (default USER/HEALTH/DATA/apple) — the history feed for the Pulse trend board.
 *                Existing day files are filled where null, never clobbered; --overwrite replaces.
 *   --out PATH   Write somewhere other than USER/HEALTH/APPLE_HEALTH.md
 *   --dry-run    Print the markdown instead of writing it
 */
import { spawn } from "node:child_process";
import { closeSync, constants as FS, existsSync, lstatSync, mkdirSync, openSync, writeFileSync, writeSync, readFileSync, realpathSync } from "node:fs";
import { createReadStream } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { lifeosPath } from "./Paths"; // public issue #1974 @sabo961, PR #1918 @PigLardLord
import { invariant } from "./Invariant.ts";

const HOME = process.env.HOME ?? "~";
// USER/HEALTH, not USER/TELOS/HEALTH: `/api/life/health` resolves its directory as
// USER_DIR + "HEALTH" (Observability/observability.ts:1713) and readDirMdFiles (:2342)
// picks up every .md there except README.md, so a file under TELOS/ would never be read.
// the current and ideal health-state documents are gap-analysis inputs and not this file's home.
//
// This file is NOT in the handler's hardcoded parse list (:2440-2448), so it reaches the
// page only through that generic scan: `sections` is parsed from the full text, but the
// `content` preview is truncated at 2000 chars. That is the concrete reason the headline
// numbers belong in the `##` headings rather than in body prose — see the note above.
//
// Complementary path, not a rival: LIFEOS/TOOLS/healthsync/apple.ts is the CONTINUOUS sync
// (iPhone Shortcut JSON -> DayFiles under USER/HEALTH/DATA). This is the bulk backup import.
const DEFAULT_OUT = lifeosPath("USER", "HEALTH", "APPLE_HEALTH.md");
const DEFAULT_DAYS = 90;
const DEFAULT_DAYS_OUT = lifeosPath("USER", "HEALTH", "DATA", "apple");

/**
 * Fail-closed output guard, same posture as PurgeArchives.ts.
 *
 * A tool that creates its own parent directories will happily materialise a whole tree
 * anywhere the process can write, so `--out` is constrained to $HOME rather than trusted.
 * The check runs on the RESOLVED path, so `..` traversal cannot walk out and back in, and
 * it runs before any mkdir — a refusal leaves the filesystem untouched.
 *
 * Applies even under --dry-run: refusing a path in one mode and accepting it in another is
 * how a guard gets trusted in the mode that does not have it.
 */
export function checkWritableOut(out: string, homeDir: string = HOME): { ok: true; abs: string } | { ok: false; reason: string } {
  const abs = resolve(out);
  let home: string;
  try { home = realpathSync(resolve(homeDir)); } catch { return { ok: false, reason: `REFUSED: "${abs}" — the home directory does not resolve.` }; }
  // resolve() is lexical — a symlinked parent inside $HOME ($HOME/link -> /outside)
  // passes a startsWith(home) check while the write lands outside the tree. Canonicalize
  // the nearest EXISTING ancestor of the (possibly not-yet-created) output path and check
  // THAT against the real home (Forge cross-vendor audit 2026-08-10; same class as the
  // PurgeArchives symlink bypass).
  // existsSync follows links and reports a DANGLING symlink as absent, which sent the walk to
  // the link's parent inside $HOME while a write follows the link to its target outside it.
  // lstatSync sees the link itself, so a link that does not resolve is refused outright.
  let ancestor = abs;
  for (;;) {
    let isLink = false;
    try { isLink = lstatSync(ancestor).isSymbolicLink(); } catch { /* absent: climb */ }
    if (isLink) {
      try { realpathSync(ancestor); } catch {
        return { ok: false, reason: `REFUSED: "${abs}" passes through a dangling symlink at "${ancestor}". A write would follow it to an unchecked target.` };
      }
      break;
    }
    if (existsSync(ancestor)) break;
    const parent = dirname(ancestor);
    if (parent === ancestor) break; // reached filesystem root
    ancestor = parent;
  }
  let realAncestor: string;
  try {
    realAncestor = realpathSync(ancestor);
  } catch {
    return { ok: false, reason: `REFUSED: "${abs}" — no resolvable ancestor directory.` };
  }
  if (realAncestor !== home && !realAncestor.startsWith(home + sep)) {
    return { ok: false, reason: `REFUSED: "${abs}" resolves outside $HOME (${home}) via "${realAncestor}". I do not write outside the home tree.` };
  }
  return { ok: true, abs };
}

function assertWritableOut(out: string): string {
  const r = checkWritableOut(out);
  if (!r.ok) {
    console.error(r.reason);
    process.exit(1);
  }
  return r.abs;
}

// ── What we pull out of the export ──
//
// Apple ships hundreds of HKQuantityTypeIdentifier types. These are the ones
// with a daily reading that means something on a dashboard. `agg` decides how a
// day's many samples collapse into one number: steps sum, heart rate averages,
// weight takes the last reading of the day.
type Agg = "sum" | "avg" | "last" | "max";

interface MetricSpec {
  /** HKQuantityTypeIdentifier suffix, i.e. the type minus the prefix. */
  key: string;
  label: string;
  agg: Agg;
  unit: string;
  /** Round to this many decimals when reporting. */
  dp: number;
}

const METRICS: MetricSpec[] = [
  { key: "StepCount", label: "Steps", agg: "sum", unit: "steps", dp: 0 },
  { key: "DistanceWalkingRunning", label: "Walk + run distance", agg: "sum", unit: "km", dp: 2 },
  { key: "ActiveEnergyBurned", label: "Active energy", agg: "sum", unit: "kcal", dp: 0 },
  { key: "BasalEnergyBurned", label: "Resting energy", agg: "sum", unit: "kcal", dp: 0 },
  { key: "AppleExerciseTime", label: "Exercise time", agg: "sum", unit: "min", dp: 0 },
  { key: "FlightsClimbed", label: "Flights climbed", agg: "sum", unit: "flights", dp: 0 },
  { key: "RestingHeartRate", label: "Resting heart rate", agg: "avg", unit: "bpm", dp: 0 },
  { key: "HeartRateVariabilitySDNN", label: "HRV (SDNN)", agg: "avg", unit: "ms", dp: 0 },
  { key: "WalkingHeartRateAverage", label: "Walking heart rate", agg: "avg", unit: "bpm", dp: 0 },
  { key: "VO2Max", label: "VO2 max", agg: "last", unit: "mL/kg/min", dp: 1 },
  { key: "BodyMass", label: "Weight", agg: "last", unit: "kg", dp: 1 },
  { key: "BodyFatPercentage", label: "Body fat", agg: "last", unit: "%", dp: 1 },
  { key: "LeanBodyMass", label: "Lean body mass", agg: "last", unit: "kg", dp: 1 },
  { key: "RespiratoryRate", label: "Respiratory rate", agg: "avg", unit: "breaths/min", dp: 1 },
  { key: "OxygenSaturation", label: "Blood oxygen", agg: "avg", unit: "%", dp: 1 },
  { key: "BloodPressureSystolic", label: "Blood pressure (systolic)", agg: "avg", unit: "mmHg", dp: 0 },
  { key: "BloodPressureDiastolic", label: "Blood pressure (diastolic)", agg: "avg", unit: "mmHg", dp: 0 },
  { key: "AppleStandTime", label: "Stand time", agg: "sum", unit: "min", dp: 0 },
];

const SPEC_BY_KEY = new Map(METRICS.map((m) => [m.key, m]));

/**
 * Reconcile the export's own `unit` attribute with the unit we report in.
 *
 * The export is written in the phone's locale: a US export emits `mi` and `lb`
 * where this one emits `km` and `kg`. Trusting the label in METRICS and ignoring
 * the record would silently print miles under a "km" heading. Some units are
 * only spelled differently for the same quantity (`count/min` is bpm); those
 * alias, they do not convert.
 */
const UNIT_ALIASES: Record<string, string> = {
  "count/min": "bpm", "Cal": "kcal", "min": "min", "ms": "ms", "%": "%",
};

/**
 * Units that are a bare tally of things. Health writes `unit="count"` for all
 * of them, so what a count *is* depends on the metric: steps for StepCount,
 * flights for FlightsClimbed. Aliasing `count` globally to any one of them
 * makes the others look like a unit mismatch and drops them.
 */
const TALLY_UNITS = new Set(["steps", "flights"]);

const CONVERSIONS: Record<string, Record<string, number>> = {
  mi: { km: 1.609344 },
  ft: { m: 0.3048 },
  lb: { kg: 0.45359237 },
  kJ: { kcal: 0.239005736 },
};

/** Unit strings seen that we could neither alias nor convert, for reporting. */
export const unitWarnings = new Map<string, string>();

/**
 * Convert a raw sample into the spec's unit.
 * Returns null when the unit is unrecognised, so the sample is dropped rather
 * than counted under the wrong label.
 */
function scale(spec: MetricSpec, value: number, rawUnit: string): number | null {
  // Percent metrics arrive as 0..1 fractions.
  if (spec.unit === "%") return value * 100;
  if (!rawUnit) return value;
  if ((rawUnit === "count" || rawUnit === "count/day") && TALLY_UNITS.has(spec.unit)) return value;
  const unit = UNIT_ALIASES[rawUnit] ?? rawUnit;
  if (unit === spec.unit) return value;
  const factor = CONVERSIONS[rawUnit]?.[spec.unit];
  if (factor !== undefined) return value * factor;
  unitWarnings.set(spec.key, rawUnit);
  return null;
}

// ── Aggregation ──

interface DayBucket {
  sum: number;
  count: number;
  max: number;
  last: number;
  lastAt: string;
}

/**
 * metric key → date (YYYY-MM-DD) → sourceName → bucket
 *
 * Bucketing by SOURCE is not an optimisation, it is a correctness requirement.
 * Health stores every device's view of the same day side by side: this export
 * carries StepCount from six sources (two phones, a ring, and three app-level
 * writers) and BasalEnergyBurned from four. Summing the lot double- or
 * triple-counts. Apple's own Health app resolves this with a per-source
 * priority list; `collapse()` below picks a winner per day instead, which needs
 * no configuration.
 */
export type Daily = Map<string, Map<string, Map<string, DayBucket>>>;

function addSample(
  daily: Daily, key: string, date: string, source: string, value: number, startedAt: string,
): void {
  let byDate = daily.get(key);
  if (!byDate) {
    byDate = new Map();
    daily.set(key, byDate);
  }
  let bySource = byDate.get(date);
  if (!bySource) {
    bySource = new Map();
    byDate.set(date, bySource);
  }
  const bucket = bySource.get(source);
  if (!bucket) {
    bySource.set(source, { sum: value, count: 1, max: value, last: value, lastAt: startedAt });
    return;
  }
  bucket.sum += value;
  bucket.count += 1;
  if (value > bucket.max) bucket.max = value;
  // "last" means latest by sample start time, not by file order — exports are
  // not reliably sorted and a re-imported device can interleave.
  if (startedAt >= bucket.lastAt) {
    bucket.last = value;
    bucket.lastAt = startedAt;
  }
}

/**
 * Collapse one day's per-source buckets into a single number, plus the source
 * that produced it.
 *
 *   sum  — the source with the largest total. A day's steps are whichever
 *          device was actually on you, never phone + ring + watch added up.
 *   avg  — the source with the most samples that day; averaging across devices
 *          would weight a ring that samples hourly against a phone that wrote
 *          twice.
 *   last — the globally latest sample, whichever device wrote it.
 *   max  — the largest single reading seen anywhere.
 */
function collapse(bySource: Map<string, DayBucket>, agg: Agg): { value: number; source: string } {
  let best: { value: number; source: string; rank: number } | null = null;
  for (const [source, b] of bySource) {
    const value = agg === "sum" ? b.sum
      : agg === "avg" ? b.sum / b.count
      : agg === "max" ? b.max
      : b.last;
    const rank = agg === "sum" ? b.sum
      : agg === "avg" ? b.count
      : agg === "max" ? b.max
      : Number(new Date(b.lastAt.slice(0, 19).replace(" ", "T")).getTime()) || 0;
    if (!best || rank > best.rank) best = { value, source, rank };
  }
  return best ? { value: best.value, source: best.source } : { value: 0, source: "" };
}

// ── Streaming parse ──
//
// Records look like:
//   <Record type="HKQuantityTypeIdentifierStepCount" ... startDate="2026-01-02 08:14:00 +0100"
//           endDate="..." value="431"/>
// Attribute order is stable in practice but not guaranteed, so each is matched
// by name rather than by position.
const RECORD_RE = /<Record\s([^>]*?)\/?>/g;
const ATTR_RE = /(\w+)="([^"]*)"/g;
const TYPE_PREFIX = "HKQuantityTypeIdentifier";

// Sleep is a category type, not a quantity: each record is a stage with a
// start and end, and the value names the stage. Hours land on the WAKE day
// (endDate), which is how Oura keys its nights too, so the two sources line up
// day for day. Keys are namespaced so `summarise()` (METRICS only) never sees them.
const SLEEP_TYPE = "HKCategoryTypeIdentifierSleepAnalysis";
const SLEEP_STAGE: Record<string, string> = {
  HKCategoryValueSleepAnalysisAsleepCore: "core",
  HKCategoryValueSleepAnalysisAsleepDeep: "deep",
  HKCategoryValueSleepAnalysisAsleepREM: "rem",
  HKCategoryValueSleepAnalysisAsleepUnspecified: "unspecified",
  HKCategoryValueSleepAnalysisAsleep: "unspecified", // pre-iOS 16 exports
  HKCategoryValueSleepAnalysisInBed: "inbed",
  HKCategoryValueSleepAnalysisAwake: "awake",
  "0": "inbed", "1": "unspecified", "2": "awake", // very old integer exports
};
const SLEEP_KEY = (stage: string) => `Sleep.${stage}`;
const ASLEEP_STAGES = ["core", "deep", "rem", "unspecified"];

function exportDateMs(s: string): number {
  // "2026-01-02 08:14:00 +0100" → epoch ms; NaN when unparseable.
  return Date.parse(s.trim().replace(" ", "T").replace(/ ([+-]\d{2})(\d{2})$/, "$1:$2"));
}

export interface ParseStats {
  recordsSeen: number;
  recordsKept: number;
  firstDate: string | null;
  lastDate: string | null;
}

/** Pull the attributes of one `<Record>` into a plain object. */
function attrsOf(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  ATTR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTR_RE.exec(raw)) !== null) out[m[1]] = m[2];
  return out;
}

/**
 * Fold one chunk of export.xml into the daily aggregates.
 * Returns the trailing fragment that may hold a half-written record, which the
 * caller prepends to the next chunk. Without this, every chunk boundary that
 * lands mid-record silently drops a sample.
 */
export function consumeChunk(chunk: string, daily: Daily, stats: ParseStats): string {
  RECORD_RE.lastIndex = 0;
  let lastEnd = 0;
  let m: RegExpExecArray | null;
  while ((m = RECORD_RE.exec(chunk)) !== null) {
    lastEnd = m.index + m[0].length;
    stats.recordsSeen += 1;
    const a = attrsOf(m[1]);
    const type = a.type;
    if (type === SLEEP_TYPE) {
      const stage = SLEEP_STAGE[a.value ?? ""];
      const start = exportDateMs(a.startDate ?? "");
      const end = exportDateMs(a.endDate ?? "");
      if (!stage || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
      const date = (a.endDate ?? "").slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      const hours = (end - start) / 3_600_000;
      if (hours > 24) continue; // a runaway record, never a night
      addSample(daily, SLEEP_KEY(stage), date, a.sourceName || "unknown", hours, a.startDate ?? "");
      stats.recordsKept += 1;
      if (!stats.firstDate || date < stats.firstDate) stats.firstDate = date;
      if (!stats.lastDate || date > stats.lastDate) stats.lastDate = date;
      continue;
    }
    if (!type || !type.startsWith(TYPE_PREFIX)) continue;
    const spec = SPEC_BY_KEY.get(type.slice(TYPE_PREFIX.length));
    if (!spec) continue;
    const value = Number(a.value);
    if (!Number.isFinite(value)) continue;
    const startDate = a.startDate ?? "";
    const date = startDate.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const scaled = scale(spec, value, a.unit ?? "");
    if (scaled === null) continue;
    addSample(daily, spec.key, date, a.sourceName || "unknown", scaled, startDate);
    stats.recordsKept += 1;
    if (!stats.firstDate || date < stats.firstDate) stats.firstDate = date;
    if (!stats.lastDate || date > stats.lastDate) stats.lastDate = date;
  }
  // Keep back anything after the last complete record. Cap the carry so a file
  // with no records at all cannot grow it without bound.
  const tail = chunk.slice(lastEnd);
  return tail.length > 1_000_000 ? tail.slice(-1_000_000) : tail;
}

/** Stream export.xml (or a zip containing it) through consumeChunk. */
async function parseExport(path: string): Promise<{ daily: Daily; stats: ParseStats }> {
  const daily: Daily = new Map();
  const stats: ParseStats = { recordsSeen: 0, recordsKept: 0, firstDate: null, lastDate: null };
  let carry = "";

  const onChunk = (buf: Buffer | string) => {
    carry = consumeChunk(carry + buf.toString(), daily, stats);
  };

  if (path.endsWith(".zip")) {
    // `unzip -p` streams the member to stdout, so a 4GB export never lands on
    // disk twice. The member path is what the Health app has always produced.
    await new Promise<void>((resolve, reject) => {
      const proc = spawn("unzip", ["-p", path, "apple_health_export/export.xml"], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stderr = "";
      proc.stdout.on("data", onChunk);
      proc.stderr.on("data", (d) => { stderr += d.toString(); });
      proc.on("error", () => reject(new Error(
        "`unzip` is not installed. Unzip the export yourself and pass the export.xml path instead.",
      )));
      proc.on("close", (code) => {
        if (code === 0) return resolve();
        reject(new Error(
          `unzip exited ${code}: ${stderr.trim() || "no apple_health_export/export.xml inside the zip"}`,
        ));
      });
    });
  } else {
    await new Promise<void>((resolve, reject) => {
      const rs = createReadStream(path, { encoding: "utf-8" });
      rs.on("data", onChunk);
      rs.on("error", reject);
      rs.on("end", () => resolve());
    });
  }

  if (carry) consumeChunk(carry, daily, stats);
  return { daily, stats };
}

// ── Summarising ──

interface Summary {
  spec: MetricSpec;
  /** Mean of the per-day values across the window (days with no sample excluded). */
  average: number;
  latest: number;
  latestDate: string;
  days: number;
  /** Device that won the most days for this metric, and how many it won. */
  source: string;
  sourceDays: number;
  /** How many distinct devices wrote this metric in the window. */
  sourceCount: number;
}

function round(value: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(value * f) / f;
}

function fmt(value: number, dp: number): string {
  return round(value, dp).toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

function summarise(daily: Daily, since: string): Summary[] {
  const out: Summary[] = [];
  for (const spec of METRICS) {
    const byDate = daily.get(spec.key);
    if (!byDate) continue;
    const dates = [...byDate.keys()].filter((d) => d >= since).sort();
    if (dates.length === 0) continue;
    const wins = new Map<string, number>();
    const seenSources = new Set<string>();
    const values = dates.map((d) => {
      const bySource = byDate.get(d)!;
      for (const src of bySource.keys()) seenSources.add(src);
      const { value, source } = collapse(bySource, spec.agg);
      wins.set(source, (wins.get(source) ?? 0) + 1);
      return value;
    });
    const average = values.reduce((a, b) => a + b, 0) / values.length;
    const [source, sourceDays] = [...wins.entries()].sort((a, b) => b[1] - a[1])[0] ?? ["", 0];
    out.push({
      spec,
      average,
      latest: values[values.length - 1],
      latestDate: dates[dates.length - 1],
      days: dates.length,
      source,
      sourceDays,
      sourceCount: seenSources.size,
    });
  }
  return out;
}

// ── Day files (the healthsync DayFile shape) ──
//
// One JSON per day under USER/HEALTH/DATA/apple, the same files the hourly
// Health Auto Export drain writes, with the same key names (healthsync/apple.ts
// + hae.ts) so the trend board reads history and live data through one path.

/** HKQuantityTypeIdentifier suffix → DayFile metric key. */
const DAYFILE_KEY: Record<string, string> = {
  StepCount: "steps",
  ActiveEnergyBurned: "active_energy_kcal",
  BasalEnergyBurned: "basal_energy_kcal",
  AppleExerciseTime: "exercise_minutes",
  RestingHeartRate: "resting_hr",
  HeartRateVariabilitySDNN: "hrv_ms",
  BodyMass: "weight_kg",
  BodyFatPercentage: "body_fat_pct",
  LeanBodyMass: "lean_mass_kg",
  OxygenSaturation: "spo2_pct",
  VO2Max: "vo2max",
  RespiratoryRate: "respiratory_rate",
  DistanceWalkingRunning: "distance_km",
  FlightsClimbed: "flights",
  WalkingHeartRateAverage: "walking_hr",
  BloodPressureSystolic: "bp_systolic",
  BloodPressureDiastolic: "bp_diastolic",
  AppleStandTime: "stand_minutes",
};

export type DayMetrics = Record<string, number | string | null>;

/**
 * Collapse the aggregates into per-day metric objects. Quantity metrics use
 * `collapse()` per key; sleep picks ONE source per night (the one that logged
 * the most asleep time) and takes every stage from it, so deep from a ring and
 * core from a mattress never get stitched into a night nobody slept.
 */
export function buildDayFiles(daily: Daily): Map<string, DayMetrics> {
  const days = new Map<string, DayMetrics>();
  const row = (date: string) => {
    let r = days.get(date);
    if (!r) {
      r = {};
      days.set(date, r);
    }
    return r;
  };
  for (const spec of METRICS) {
    const key = DAYFILE_KEY[spec.key];
    const byDate = daily.get(spec.key);
    if (!key || !byDate) continue;
    for (const [date, bySource] of byDate) {
      const { value } = collapse(bySource, spec.agg);
      row(date)[key] = round(value, spec.dp);
    }
  }
  // Sleep: winner by asleep total, then that source's stages.
  const nights = new Set<string>();
  for (const stage of [...ASLEEP_STAGES, "inbed", "awake"]) {
    for (const date of daily.get(SLEEP_KEY(stage))?.keys() ?? []) nights.add(date);
  }
  for (const date of nights) {
    const asleepBySource = new Map<string, number>();
    for (const stage of ASLEEP_STAGES) {
      for (const [src, b] of daily.get(SLEEP_KEY(stage))?.get(date) ?? []) {
        asleepBySource.set(src, (asleepBySource.get(src) ?? 0) + b.sum);
      }
    }
    let winner: string | null = null;
    let best = -1;
    for (const [src, h] of asleepBySource) if (h > best) { best = h; winner = src; }
    if (winner === null) {
      // In-bed only (no staging) — still a night, keyed on the biggest in-bed source.
      for (const [src, b] of daily.get(SLEEP_KEY("inbed"))?.get(date) ?? []) {
        if (b.sum > best) { best = b.sum; winner = src; }
      }
      if (winner === null) continue;
    }
    const hoursFrom = (stage: string) => {
      const b = daily.get(SLEEP_KEY(stage))?.get(date)?.get(winner as string);
      return b ? round(b.sum, 2) : null;
    };
    const r = row(date);
    const asleep = ASLEEP_STAGES.reduce((a, s) => a + (hoursFrom(s) ?? 0), 0);
    r.sleep_hours = asleepBySource.size ? round(asleep, 2) : null;
    r.sleep_core_h = hoursFrom("core");
    r.sleep_deep_h = hoursFrom("deep");
    r.sleep_rem_h = hoursFrom("rem");
    r.sleep_inbed_h = hoursFrom("inbed");
    r.sleep_awake_h = hoursFrom("awake");
    r.sleep_source = winner;
  }
  return days;
}

/**
 * Write day files. An existing day (the hourly drain may already own it) is
 * never overwritten: the export only fills keys that are missing or null there,
 * unless --overwrite. Returns counts for the report line.
 */
/**
 * The one day-file destination check. The directory guard (checkWritableOut)
 * vouches for the directory, not its children: an existing child that is a symlink or a hard link would carry a read
 * or a write out of the directory the guard accepted. So every destination is checked on its own, after realpath:
 * the date is a plain YYYY-MM-DD name, the file's canonical parent IS the canonical day directory, and an existing
 * leaf is a regular file with one link. A refusal throws before that file is read or written.
 */
export function dayFileDestination(realDir: string, date: string): { path: string; exists: boolean } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`REFUSED: day key "${date.slice(0, 40)}" is not a YYYY-MM-DD date; nothing written for it.`);
  const path = join(realDir, `${date}.json`);
  if (realpathSync(dirname(path)) !== realDir) throw new Error(`REFUSED: "${path}" does not sit directly in the day directory.`);
  let st: ReturnType<typeof lstatSync> | null = null;
  try { st = lstatSync(path); } catch (e) { if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") throw e; }
  if (st === null) return { path, exists: false };
  if (st.isSymbolicLink()) throw new Error(`REFUSED: "${path}" is a symlink; a day file is never read or written through a link.`);
  if (!st.isFile()) throw new Error(`REFUSED: "${path}" is not a regular file.`);
  if (st.nlink > 1) throw new Error(`REFUSED: "${path}" has ${st.nlink} hard links; writing it would change a file outside the day directory.`);
  return { path, exists: true };
}

/** Write one day file without following a link: O_NOFOLLOW always, O_EXCL when it is new. */
function writeDayFileSafely(path: string, existed: boolean, content: string): void {
  const flags = FS.O_WRONLY | FS.O_NOFOLLOW | (existed ? FS.O_TRUNC : FS.O_CREAT | FS.O_EXCL);
  const fd = openSync(path, flags, 0o644);
  try { writeSync(fd, content); } finally { closeSync(fd); }
}

export function writeDayFiles(
  days: Map<string, DayMetrics>,
  dir: string,
  opts: { overwrite: boolean; exportDate: string | null; dryRun: boolean },
): { created: number; filled: number; untouched: number } {
  let created = 0, filled = 0, untouched = 0;
  if (!opts.dryRun) mkdirSync(dir, { recursive: true });
  const fetchedAt = new Date().toISOString();
  // Canonicalise the directory once; every destination is checked against this, never against the lexical path.
  const realDir = existsSync(dir) ? realpathSync(dir) : null;
  // Every destination is vetted before ANY file is touched, so a planted link refuses the whole run cleanly.
  const plan = [...days.entries()].sort().map(([date, metrics]) => ({ date, metrics, dest: realDir === null ? { path: join(dir, `${date}.json`), exists: false } : dayFileDestination(realDir, date) }));
  for (const { metrics, dest } of plan) {
    const path = dest.path;
    let existing: Record<string, unknown> | null = null;
    if (dest.exists) {
      try { existing = JSON.parse(readFileSync(path, "utf-8")).metrics ?? null; } catch { existing = null; }
    }
    let out: Record<string, unknown>;
    if (existing && !opts.overwrite) {
      out = { ...existing };
      let changed = false;
      for (const [k, v] of Object.entries(metrics)) {
        if (out[k] === undefined || out[k] === null) { out[k] = v; changed = true; }
      }
      if (!changed) { untouched += 1; continue; }
      filled += 1;
    } else {
      out = { ...metrics, origin: "export", export_date: opts.exportDate };
      created += 1;
    }
    if (!opts.dryRun) {
      invariant(realDir !== null, "the day directory exists before a day file is written");
      writeDayFileSafely(path, dest.exists, JSON.stringify({ schema: 1, source: "apple", fetched_at: fetchedAt, metrics: out }, null, 2));
    }
  }
  return { created, filled, untouched };
}

/** `since` = windowDays back from the newest sample, not from today — an export
 *  is often days old, and anchoring on today silently empties the window. */
function windowStart(lastDate: string, windowDays: number): string {
  const d = new Date(`${lastDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - windowDays + 1);
  return d.toISOString().slice(0, 10);
}

// ── Rendering ──
//
// Headings carry the numbers on purpose. The Pulse health page renders each
// file's `##` headings and nothing else, so a heading of "Steps" would show up
// as the word "Steps" with the value invisible. The tables below each heading
// are for reading the file directly, and for the DA.

export function renderMarkdown(
  summaries: Summary[],
  stats: ParseStats,
  windowDays: number,
  generatedAt: string,
): string {
  const lines: string[] = [];
  lines.push("---");
  lines.push("provenance: generated");
  lines.push("generator: LIFEOS/TOOLS/AppleHealthImport.ts");
  lines.push(`generated: ${generatedAt}`);
  lines.push("---");
  lines.push("");
  lines.push("# APPLE HEALTH");
  lines.push("");
  lines.push(
    `Generated from an Apple Health export. Regenerated end to end on every run — ` +
    `edit \`METRICS.md\` or \`FITNESS.md\` instead, this file is overwritten.`,
  );
  lines.push("");

  if (summaries.length === 0) {
    lines.push("---");
    lines.push("");
    lines.push("## No recognised metrics in this export");
    lines.push("");
    lines.push(
      `Read ${stats.recordsSeen.toLocaleString("en-US")} records but matched none of the ` +
      `tracked types. If the export is not empty, the metric list in the generator may need ` +
      `extending.`,
    );
    lines.push("");
    return lines.join("\n");
  }

  for (const s of summaries) {
    const avg = `${fmt(s.average, s.spec.dp)} ${s.spec.unit}`;
    const latest = `${fmt(s.latest, s.spec.dp)} ${s.spec.unit}`;
    // A daily total averages "per day"; a daily average is just an average; a
    // metric read a handful of times is best described by its latest value.
    const headline =
      s.spec.agg === "sum" ? `${avg}/day avg (${s.days}d)`
      : s.spec.agg === "last" ? `${latest} latest (${s.days} readings)`
      : `${avg} avg (${s.days}d)`;
    lines.push("---");
    lines.push("");
    lines.push(`## ${s.spec.label} — ${headline}`);
    lines.push("");
    lines.push("| | |");
    lines.push("|---|---|");
    lines.push(`| Average | ${avg}${s.spec.agg === "sum" ? " per day" : ""} |`);
    lines.push(`| Latest | ${latest} (${s.latestDate}) |`);
    lines.push(`| Days with data | ${s.days} of ${windowDays} |`);
    lines.push(`| Aggregation | ${s.spec.agg} per day |`);
    lines.push(
      `| Source | ${s.source}${s.sourceCount > 1 ? ` (won ${s.sourceDays}/${s.days} days of ${s.sourceCount} devices)` : ""} |`,
    );
    lines.push("");
  }

  lines.push("---");
  lines.push("");
  lines.push(`## Source — ${stats.recordsKept.toLocaleString("en-US")} samples, ${stats.firstDate} to ${stats.lastDate}`);
  lines.push("");
  lines.push("| | |");
  lines.push("|---|---|");
  lines.push(`| Records read | ${stats.recordsSeen.toLocaleString("en-US")} |`);
  lines.push(`| Records used | ${stats.recordsKept.toLocaleString("en-US")} |`);
  lines.push(`| Export covers | ${stats.firstDate} to ${stats.lastDate} |`);
  lines.push(`| Summary window | last ${windowDays} days |`);
  lines.push(`| Generated | ${generatedAt} |`);
  lines.push("");
  if (unitWarnings.size > 0) {
    lines.push("---");
    lines.push("");
    lines.push(`## Skipped — ${unitWarnings.size} metric(s) in an unrecognised unit`);
    lines.push("");
    lines.push("| Metric | Unit in export |");
    lines.push("|---|---|");
    for (const [key, unit] of unitWarnings) lines.push(`| ${key} | \`${unit}\` |`);
    lines.push("");
    lines.push("Samples in these units were dropped rather than reported under the wrong label.");
    lines.push("");
  }
  return lines.join("\n");
}

// ── CLI ──

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function main(): Promise<void> {
  const input = process.argv[2];
  if (!input || input.startsWith("--")) {
    console.error("Usage: bun AppleHealthImport.ts <export.zip|export.xml> [--days N] [--out PATH] [--days-out [DIR]] [--overwrite] [--dry-run]");
    process.exit(2);
  }
  if (!existsSync(input)) {
    console.error(`No such file: ${input}`);
    process.exit(2);
  }

  const windowDays = Number(arg("--days", String(DEFAULT_DAYS)));
  if (!Number.isFinite(windowDays) || windowDays < 1) {
    console.error("--days must be a positive number");
    process.exit(2);
  }
  // Guard before the parse, not just before the write: a multi-gigabyte export can take
  // minutes, and refusing only at the end wastes all of it to say no.
  const out = assertWritableOut(arg("--out", DEFAULT_OUT)!);
  const dryRun = process.argv.includes("--dry-run");
  // --days-out [DIR]: also write one DayFile per day for the whole export (this
  // is how years of history reach the trend board). DIR defaults to the live
  // apple data directory; existing days are filled, never clobbered (--overwrite).
  const daysOutIdx = process.argv.indexOf("--days-out");
  const daysOutArg = daysOutIdx !== -1 ? process.argv[daysOutIdx + 1] : undefined;
  const daysOut = daysOutIdx === -1
    ? null
    : assertWritableOut(daysOutArg && !daysOutArg.startsWith("--") ? daysOutArg : DEFAULT_DAYS_OUT);
  const overwrite = process.argv.includes("--overwrite");

  const t0 = Date.now();
  const { daily, stats } = await parseExport(input);
  if (!stats.lastDate) {
    console.error(
      `Parsed ${stats.recordsSeen.toLocaleString("en-US")} records but found no dated samples. ` +
      `Is this an Apple Health export?`,
    );
    process.exit(1);
  }

  const since = windowStart(stats.lastDate, windowDays);
  const summaries = summarise(daily, since);
  const markdown = renderMarkdown(summaries, stats, windowDays, new Date().toISOString());

  if (dryRun) {
    console.log(markdown);
  } else {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, markdown, "utf-8");
  }

  let dayLine = "";
  if (daysOut) {
    const days = buildDayFiles(daily);
    const r = writeDayFiles(days, daysOut, { overwrite, exportDate: stats.lastDate, dryRun });
    dayLine = ` · day files: ${days.size} days (${r.created} created, ${r.filled} filled, ${r.untouched} untouched)${dryRun ? "" : ` → ${daysOut}`}`;
  }

  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.error(
    `[apple-health] ${stats.recordsKept.toLocaleString("en-US")}/${stats.recordsSeen.toLocaleString("en-US")} ` +
    `records, ${summaries.length} metrics, ${stats.firstDate}..${stats.lastDate}, ` +
    `window ${since}..${stats.lastDate} (${secs}s)${dryRun ? " [dry run]" : ` → ${out}`}${dayLine}`,
  );
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`[apple-health] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
