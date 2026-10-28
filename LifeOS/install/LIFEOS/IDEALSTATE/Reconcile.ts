/**
 * Reconcile — the daily, code-only measurement pass.
 *
 * For every bound target row: read its value, record it, and compare it with the
 * straight line from the row's first measurement to its target on its target
 * date. A row behind that line is off-track. Vigil hears about a row only when
 * its pace state flips; the first run is a baseline and emits nothing.
 *
 * A row bound to a Socrates standing question (`measure: socrates/SOC-NNNN`)
 * reads that question's latest answer instead: yes is on-track, no is off-track,
 * unknown or no answer yet is unreadable.
 *
 * It also marks every target and goal pursued, stalled, unpursued or declined
 * (Pursuit.ts) and records when each id was first seen. Vigil hears about a
 * pursuit change only when a known row flips; a burst of flips is one event.
 *
 * Every bound row also gets one gap tier (Tiers.ts): on-track, drift, close-now or
 * needs-input, with the next move in hand. Drift and needs-input never reach the
 * digest (a pace flip is a low event, for Pulse); rows that newly enter close-now are
 * one high event per run, ids and counts only. Needs-input rows are read by Review.
 * Applied Upgrades serving a bound row are checked against its measurement 14 days
 * after they were applied (Verify.ts).
 *
 * Writes: measurements.jsonl, reconcile.json, seen.json, verifications.jsonl and
 * ids.json (goal ids) in the state dir, plus Vigil outbox lines. Nothing else.
 *
 * @version 1.3.0
 *
 * 1.3.0: gap tiers and next moves per bound row; pace flips go to Pulse at low; one high
 * close-now event per run; the 14-day measured check of applied moves.
 * 1.2.0: Socrates-bound rows; their 1/0 readings are kept apart from numeric baselines.
 * 1.1.0: pursuit states and summary; measurements keyed by stable id once a row has one.
 */
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { invariant } from "../TOOLS/Invariant";
import { allRows, goalRows, isNumericMeasure, rowRef, type Row, type SocratesMeasure } from "./Rows";
import { liveGoals } from "./Ids";
import { evaluate, liveSources, summarize, type PursuitRow, type PursuitSources, type PursuitSummary } from "./Pursuit";
import { appendState, readJson, readLines, statePath, updateState, userDir, writeState } from "./Store";
import { emitVigilEvent, vigilEvent } from "../TOOLS/lib/VigilOptional";
import { SOCRATES_DIR, Store as SocratesStore } from "../SOCRATES/Store";
import { assignTier, CLOSE_NOW_WINDOW_DAYS, measurementReason, tally, type NextMove, type Tier, type TierTally } from "./Tiers";
import { liveUpgrades, verifyApplied, type UpgradeLike, type Verification } from "./Verify";
import type { Rec } from "./Recommend";

export type PaceState = "on-track" | "off-track" | "unreadable";
export type RowReport = {
  key: string; file: string; section: string; state: PaceState;
  value: number | null; target: number; by: string; baseline: number | null; baseline_ts: string | null;
  progress: number | null; error?: string;
  /** Socrates-bound rows: the question id and its folded latest answer. value is 1 for yes, 0 for no. */
  question?: string; answer?: SocratesAnswer;
  /** The gap tier (Tiers.ts), why, and the move in hand; set on every bound row. */
  tier?: Tier; tier_why?: string; next_move?: NextMove | null;
};
export type ReconcileReport = {
  generated_at: string;
  bound: number;
  unbound_targets: number;
  rows: RowReport[];
  pursuit?: PursuitRow[];
  pursuit_summary?: PursuitSummary;
  /** Set when the pursuit graph could not be read this run; the measurement half still ran. */
  pursuit_error?: string;
  /** When the pursuit graph in this report was computed (older than generated_at after a failed run). */
  pursuit_as_of?: string;
  /** How many bound rows sit in each tier. */
  tiers?: TierTally;
  /** 14-day checks of applied moves recorded this run, or why the check could not run. */
  verified?: number; verify_error?: string;
};
/** kind "socrates" marks a 1/0 answer reading; numeric baselines never read those. */
type Measurement = { ts: string; key: string; value: number; kind?: "socrates" };

export type SocratesAnswer = "yes" | "no" | "unknown";
/** The latest answer per instance of one standing question (the ledger says pass/fail/unknown). */
export type SocratesReader = (questionId: string) => Array<{ verdict: string }>;

/** Folds a question's instances the way the Socrates board does: any no is no, else any unknown is unknown, none is unknown. */
export function socratesAnswer(answers: Array<{ verdict: string }>): SocratesAnswer {
  if (answers.length === 0) return "unknown";
  const v = answers.map((a) => (a.verdict === "pass" ? "yes" : a.verdict === "fail" ? "no" : a.verdict));
  if (v.includes("no")) return "no";
  if (v.every((x) => x === "yes")) return "yes";
  return "unknown"; // an unknown, or a verdict this code does not recognize, is never read as yes
}

export function socratesState(answer: SocratesAnswer): PaceState {
  return answer === "yes" ? "on-track" : answer === "no" ? "off-track" : "unreadable";
}

/** Reads the Socrates fold (latest answer per question and instance) once, read-only. */
export function liveSocratesReader(dir = process.env.SOCRATES_DIR ?? SOCRATES_DIR): SocratesReader {
  const byQ = new Map<string, Array<{ verdict: string }>>();
  for (const a of new SocratesStore(dir, { readonly: true }).latestAnswers()) {
    if (!byQ.has(a.question_id)) byQ.set(a.question_id, []);
    byQ.get(a.question_id)!.push({ verdict: a.verdict });
  }
  return (id) => byQ.get(id) ?? [];
}

const DAY = 86_400_000;

export function readPath(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), obj);
}

export function readValue(row: Row, root = userDir()): number {
  invariant(row.measure && isNumericMeasure(row.measure), "readValue needs a row bound to a JSON path");
  const file = join(root, row.measure.file);
  if (!existsSync(file)) throw new Error(`source missing: ${row.measure.file}`);
  const v = readPath(JSON.parse(readFileSync(file, "utf8")), row.measure.path);
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n)) throw new Error(`no number at ${row.measure.file}#${row.measure.path}`);
  return n;
}

/** Where the straight line from baseline to target says the value should be now. */
export function expectedAt(baseline: number, baselineTs: number, target: number, byTs: number, now: number): number {
  if (byTs <= baselineTs) return target;
  const f = Math.max(0, Math.min(1, (now - baselineTs) / (byTs - baselineTs)));
  return baseline + (target - baseline) * f;
}

export function pace(value: number, baseline: number, baselineTs: number, target: number, byTs: number, now: number): { state: PaceState; progress: number } {
  const dir = Math.sign(target - baseline);
  // Started at the target: holding it is on-track, drifting off it is not.
  if (dir === 0) return value === target ? { state: "on-track", progress: 1 } : { state: "off-track", progress: 0 };
  const progress = Math.max(0, Math.min(1, (value - baseline) / (target - baseline)));
  const expected = expectedAt(baseline, baselineTs, target, byTs, now);
  return { state: (value - expected) * dir >= -1e-9 ? "on-track" : "off-track", progress };
}

/** One Socrates-bound row: its folded answer, and a 1/0 reading in `fresh` when the answer is yes or no. */
function socratesReport(row: Row, m: SocratesMeasure, socrates: SocratesReader | Error, now: Date, fresh: Measurement[]): RowReport {
  const ref = rowRef(row);
  const base = { key: ref, file: row.file, section: row.section, target: 1, by: m.by ?? "", baseline: null, baseline_ts: null, question: m.socrates };
  if (socrates instanceof Error) return { ...base, state: "unreadable", value: null, progress: null, answer: "unknown", error: `Socrates store unreadable: ${socrates.message}` };
  const answer = socratesAnswer(socrates(m.socrates));
  const state = socratesState(answer);
  if (answer === "unknown") return { ...base, state, value: null, progress: null, answer, error: `${m.socrates} has no yes or no answer` };
  const value = answer === "yes" ? 1 : 0;
  fresh.push({ ts: now.toISOString(), key: ref, value, kind: "socrates" });
  return { ...base, state, value, progress: value, answer };
}

export const MAX_FLIP_EVENTS = 3;

export function reconcile(opts: { now?: Date; rows?: Row[]; goals?: Row[]; pursuit?: PursuitSources; socrates?: SocratesReader; upgrades?: () => UpgradeLike[] } = {}): { report: ReconcileReport; events: number } {
  const now = opts.now ?? new Date();
  const rows = opts.rows ?? allRows();
  const bound = rows.filter((r) => r.type === "target" && r.measure);
  const unbound = rows.filter((r) => r.type === "target" && !r.measure).length;
  const history = readLines<Measurement>("measurements.jsonl");
  const prev = readJson<ReconcileReport | null>(statePath("reconcile.json"), null);
  const prevState = new Map((prev?.rows ?? []).map((r) => [r.key, r.state]));
  const reports: RowReport[] = [];
  const fresh: Measurement[] = [];

  // The Socrates fold is read once, and only when some row is bound to a question.
  let socrates: SocratesReader | Error | undefined = opts.socrates;
  for (const row of bound) {
    const m = row.measure!;
    if (!isNumericMeasure(m)) {
      if (!socrates) { try { socrates = liveSocratesReader(); } catch (e) { socrates = e instanceof Error ? e : new Error(String(e)); } }
      reports.push(socratesReport(row, m, socrates, now, fresh));
      continue;
    }
    const byTs = Date.parse(`${m.by}T00:00:00Z`);
    let value: number;
    try { value = readValue(row); }
    catch (e) {
      reports.push({ key: rowRef(row), file: row.file, section: row.section, state: "unreadable", value: null, target: m.target, by: m.by, baseline: null, baseline_ts: null, progress: null, error: e instanceof Error ? e.message : String(e) });
      continue;
    }
    const ref = rowRef(row);
    const first = history.find((h) => (h.key === ref || h.key === row.key) && h.kind !== "socrates") ?? { ts: now.toISOString(), key: ref, value };
    const { state, progress } = pace(value, first.value, Date.parse(first.ts), m.target, byTs, now.getTime());
    fresh.push({ ts: now.toISOString(), key: ref, value });
    reports.push({ key: ref, file: row.file, section: row.section, state, value, target: m.target, by: m.by, baseline: first.value, baseline_ts: first.ts, progress });
  }

  const report: ReconcileReport = { generated_at: now.toISOString(), bound: bound.length, unbound_targets: unbound, rows: reports };
  try {
    const goals = opts.goals ?? (() => { const g = liveGoals({ persist: true }); return goalRows(g.goals, g.ids); })();
    const src = opts.pursuit ?? liveSources;
    const sensed = new Set(reports.filter((r) => r.state !== "unreadable").map((r) => r.key));
    report.pursuit = evaluate([...rows, ...goals], { workflows: src.workflows(), isas: src.isas() }, sensed, now.getTime());
    report.pursuit_summary = summarize(report.pursuit);
    invariant(new Set(report.pursuit.map((p) => p.id)).size === report.pursuit.length, "pursuit ids are unique");
  } catch (e) {
    report.pursuit_error = e instanceof Error ? e.message : String(e);
    // Keep the last good graph, so the next run still has something to compare against and the chip stays.
    if (prev?.pursuit) { report.pursuit = prev.pursuit; report.pursuit_summary = prev.pursuit_summary; report.pursuit_as_of = prev.pursuit_as_of ?? prev.generated_at; }
  }
  if (report.pursuit && !report.pursuit_error) report.pursuit_as_of = report.generated_at;

  // One tier per bound row, from this run's reading, its history, its approved reason, what pursues it and what is proposed for it.
  const recs = readJson<{ recs: Rec[] }>(statePath("recommendations.json"), { recs: [] }).recs;
  const pursuitById = new Map((report.pursuit ?? []).map((p) => [p.id, p]));
  const lastSeen = (ref: string, key: string) => history.filter((h) => h.key === ref || h.key === key).reduce<string | null>((a, h) => (!a || h.ts > a ? h.ts : a), null);
  for (const r of reports) {
    const row = bound.find((b) => rowRef(b) === r.key)!;
    const build = recs.find((x) => x.status === "open" && x.kind === "build" && x.serves === r.key);
    const binding = recs.find((x) => x.status === "open" && x.kind === "binding" && (x.row_key === r.key || x.row_key === row.key));
    const t = assignTier(r, { now, lastGood: r.state === "unreadable" ? lastSeen(r.key, row.key) : now.toISOString(), reason: measurementReason(recs, row), pursuit: pursuitById.get(r.key),
      ...(build ? { openBuild: { id: build.id, title: build.title ?? build.id } } : {}), ...(binding ? { openBinding: { id: binding.id } } : {}) });
    r.tier = t.tier; r.tier_why = t.why; r.next_move = t.next_move;
  }
  report.tiers = tally(reports);
  for (const r of reports) invariant(r.tier !== undefined && (r.state !== "off-track" || r.next_move), `${r.key} has one tier, and a next move when off pace`);

  // The 14-day measured check of applied moves. It never blocks the measurement pass.
  let checks: Verification[] = [];
  try {
    checks = verifyApplied({ now, upgrades: (opts.upgrades ?? liveUpgrades)(), report, history: [...history, ...fresh], done: readLines<Verification>("verifications.jsonl") });
    report.verified = checks.length;
  } catch (e) { report.verify_error = e instanceof Error ? e.message : String(e); }
  for (const r of reports) invariant(r.progress === null || (r.progress >= 0 && r.progress <= 1), `progress in 0..1 for ${r.key}`);
  for (const f of fresh) invariant(f.kind !== "socrates" || f.value === 0 || f.value === 1, `a Socrates reading is 0 or 1 for ${f.key}`);
  for (const f of fresh) appendState("measurements.jsonl", f);
  for (const c of checks) { invariant(c.upgrade_id.length > 0 && /^IS-\d{4,}$/.test(c.row) && ["closer", "not-closer", "unreadable"].includes(c.verdict), "a verification names its record, its row and a known verdict"); appendState("verifications.jsonl", c); }
  writeState("reconcile.json", report);
  if (report.pursuit) {
    const pursuit = report.pursuit;
    // Merged under the file's lock, so a first-seen date another run recorded meanwhile is kept.
    updateState<Record<string, string>>("seen.json", {}, (seen) => {
      let grew = false;
      for (const p of pursuit) if (!seen[p.id]) { seen[p.id] = now.toISOString(); grew = true; }
      return grew ? seen : null;
    });
  }

  // A flip from a known prior state is news for Pulse (low, never the digest); a first sighting is the baseline.
  // A row entering close-now is told once below, at high, so its flip is not told twice.
  let events = 0;
  for (const r of reports) {
    const before = prevState.get(r.key);
    if (!before || before === r.state || r.tier === "close-now") continue;
    const dim = r.file.replace(/\.md$/, "");
    const title = r.state === "off-track" ? `An ideal-state ${dim} target fell off pace` : r.state === "on-track" ? `An ideal-state ${dim} target is back on pace` : `An ideal-state ${dim} target can't be measured`;
    emitVigilEvent(vigilEvent("ideal-state", r.key, r.state, "low", title, `One bound target row in ${r.file} changed from ${before} to ${r.state}. Run: bun LIFEOS/IDEALSTATE/IdealState.ts gap`, "life", null, now.toISOString().slice(0, 10)));
    events++;
  }

  // Rows newly in close-now, after a baseline run: one high event per run, ids and counts only (Vigil policy texts it, at most once a day).
  const prevTier = new Map((prev?.rows ?? []).map((r) => [r.key, r.tier]));
  const closing = prev ? reports.filter((r) => r.tier === "close-now" && prevTier.get(r.key) !== "close-now").map((r) => r.key).sort() : [];
  if (closing.length) {
    const tag = createHash("sha256").update(closing.join(",")).digest("hex").slice(0, 8);
    emitVigilEvent(vigilEvent("ideal-state", "close-now", `close-now-${tag}`, "high", `${closing.length} ideal-state target${closing.length === 1 ? "" : "s"} need closing now`,
      `${closing.join(", ")} entered close-now: off pace with the deadline within ${CLOSE_NOW_WINDOW_DAYS} days, or the measurement went dead. Run: bun LIFEOS/IDEALSTATE/IdealState.ts gap`, "life", null, now.toISOString().slice(0, 10)));
    events++;
  }

  // Pursuit flips from a known prior state. A first sighting (new id) is a baseline.
  const prevPursuit = new Map((prev?.pursuit ?? []).map((p) => [p.id, p.state]));
  const flips = (report.pursuit ?? []).filter((p) => p.type !== "north_star" && p.status !== "dropped" && p.status !== "achieved" && prevPursuit.has(p.id) && prevPursuit.get(p.id) !== p.state);
  const day = now.toISOString().slice(0, 10);
  if (flips.length > MAX_FLIP_EVENTS) {
    const lost = flips.filter((f) => f.state === "stalled" || f.state === "unpursued").length;
    emitVigilEvent(vigilEvent("ideal-state", "pursuit", `flips-${flips.length}`, lost ? "medium" : "low", `${flips.length} ideal-state rows changed pursuit state`, `${lost} lost their pursuit and ${flips.length - lost} gained or changed one: ${flips.map((f) => `${f.id} ${prevPursuit.get(f.id)}→${f.state}`).join(", ")}. Run: bun LIFEOS/IDEALSTATE/IdealState.ts pursuit`, "life", null, day));
    events++;
  } else for (const f of flips) {
    const kind = f.type === "goal" ? "goal" : `${f.file.replace(/\.md$/, "")} target`;
    const lost = f.state === "stalled" || f.state === "unpursued";
    const title = f.state === "pursued" ? `An ideal-state ${kind} is being pursued again` : f.state === "stalled" ? `What pursues an ideal-state ${kind} has stopped` : f.state === "declined" ? `An ideal-state ${kind} was marked not pursued` : `An ideal-state ${kind} lost its pursuit`;
    emitVigilEvent(vigilEvent("ideal-state", f.id, `pursuit-${f.state}`, lost ? "medium" : "low", title, `${f.id} changed from ${prevPursuit.get(f.id)} to ${f.state}. Run: bun LIFEOS/IDEALSTATE/IdealState.ts pursuit ${f.id}`, "life", null, day));
    events++;
  }
  return { report, events };
}

export function daysLeft(by: string, now = new Date()): number {
  return Math.round((Date.parse(`${by}T00:00:00Z`) - now.getTime()) / DAY);
}
