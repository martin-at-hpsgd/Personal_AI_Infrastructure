#!/usr/bin/env bun
/**
 * Report.ts — the measuring half of the Glance system: reports, threshold tuning and sweeps, separation, noul promotion,
 * the agreement joins (ground-truth comparisons, the bunker-glance seed join, the label store, eval-judge and Proof
 * outcomes), status, outage alerts, and the CLI.
 *
 * Assay.ts keeps the runtime a hook needs (ask, judge, judgeMany, decide, budgets, the shadow ledger, registry loading
 * and validation, model-drift reverts). This file imports that runtime; the runtime never imports this file, so a hook
 * that imports Assay.ts does not load any of the code below (ISA 20261010-evals-in-the-isa ISC-32).
 *
 * The CLI entry stays `bun LIFEOS/ASSAY/Assay.ts <verb>`; Assay.ts loads this module only when its CLI runs.
 * `bun LIFEOS/ASSAY/Report.ts <verb>` is the same CLI.
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { lifeosPath } from "../TOOLS/Paths";
import { invariant } from "../TOOLS/Invariant";
import { EngineError, type Questions } from "./Engine";
import { glanceSeedLabels, principalAttested, type GlanceSeedLabel } from "../TOOLS/lib/Calibration.ts";
import { deriveJoinedLabels, earnedStatus, labelsFor, PROOF_GLANCE_CALLER, PROOF_GLANCE_QUESTION, type EarnedStatus, type Label, type LabelInput } from "../TOOLS/lib/LabelStore.ts";
import { currentFingerprint, liveEngineId, promotionRefusal, readFingerprintState, staleStamps, waiverActive, type StaleStamp } from "./Registry.ts";
import { ask, checkModelDrift, DEFAULT_CONCURRENCY, defaultCallersPath, defaultLogPath, effectiveMode, judgeMany, loadCallers, loadRegistry, noulValue, readJsonl, readShadowHistory, safeCallerConfig, validateCallers, type CallerConfig, type CallerMode, type CallerThreshold, type CallersConfig, type ComparisonLine, type ManyItem, type RegistryDefaults, type ShadowLine } from "./Assay.ts";

// ── Report: shadow log × dispatch log ────────────────────────────────────────

export type DispatchEvent = { session_id?: string; subagent_type?: string; event?: string; ts?: string; timestamp?: string };

export type ReportRow = {
  session: string;
  ts: string;
  advised_lane: string;
  advised_p: number;
  advised_confidence: number;
  dispatched: string[];
  actual_lane: string;
  agree: boolean;
};

export type ReportSummary = { rows: ReportRow[]; total: number; agree: number; confident: number; confident_agree: number };

/**
 * Agent type → the lane word the advisor uses (lane-rules Lane: inline|haiku|sol|sonnet|opus|astra|fable).
 * The generated effort variants (HaikuMedium, OpusXHigh …) name their base lane. Luna and Terra, retired
 * 2026-10-07, survive only in old dispatch history; their rungs are Haiku's now, so they read as haiku.
 * Unknown agents keep their name.
 */
export function laneOfAgent(agentType: string): string {
  const t = agentType.toLowerCase().replace(/(?:xhigh|medium|high)$/, "");
  if (t === "luna" || t === "terra") return "haiku";
  return t;
}

/**
 * Join advisor decisions with dispatch events by session. A session with no
 * dispatch is "inline". Agreement is exact lane match; when several agents ran,
 * any match counts. Pure over the parsed lines, so a fixture can test it.
 */
export function buildReport(shadow: ShadowLine[], dispatches: DispatchEvent[], opts: { caller: string; confidenceFloor?: number } = { caller: "dispatch-advisor" }): ReportSummary {
  const floor = opts.confidenceFloor ?? 0.6;
  const bySession = new Map<string, Set<string>>();
  for (const d of dispatches) {
    if (!d.session_id || !d.subagent_type) continue;
    if (d.event && d.event !== "subagent_start" && d.event !== "subagent_spawned_async") continue;
    const set = bySession.get(d.session_id) ?? new Set<string>();
    set.add(laneOfAgent(d.subagent_type));
    bySession.set(d.session_id, set);
  }
  const rows: ReportRow[] = [];
  for (const s of shadow) {
    if (s.caller !== opts.caller || !s.session || !s.answers || s.error) continue;
    const lane = s.answers.lane;
    if (!lane || lane.type !== "choice" || !lane.choice) continue;
    const dispatched = [...(bySession.get(s.session) ?? [])];
    const actual = dispatched.length === 0 ? "inline" : dispatched.join("+");
    const agree = dispatched.length === 0 ? lane.choice === "inline" : dispatched.includes(lane.choice);
    rows.push({
      session: s.session, ts: s.ts, advised_lane: lane.choice,
      advised_p: lane.probabilities?.[lane.choice] ?? 0, advised_confidence: lane.confidence ?? 0,
      dispatched, actual_lane: actual, agree,
    });
  }
  const confident = rows.filter((r) => r.advised_confidence >= floor);
  return { rows, total: rows.length, agree: rows.filter((r) => r.agree).length, confident: confident.length, confident_agree: confident.filter((r) => r.agree).length };
}

function formatReport(r: ReportSummary): string {
  const lines: string[] = [];
  lines.push(`dispatch advisor — judgment layer shadow report`);
  lines.push(`sessions with an advisory: ${r.total} · agree: ${r.agree} (${r.total ? Math.round((100 * r.agree) / r.total) : 0}%) · confident (≥floor): ${r.confident} · confident+agree: ${r.confident_agree} (${r.confident ? Math.round((100 * r.confident_agree) / r.confident) : 0}%)`);
  lines.push("");
  lines.push(`${"when".padEnd(20)} ${"advised".padEnd(8)} ${"p".padEnd(5)} ${"conf".padEnd(5)} ${"actual".padEnd(14)} ok`);
  for (const row of r.rows.slice(-40)) {
    lines.push(`${row.ts.slice(0, 19).replace("T", " ").padEnd(20)} ${row.advised_lane.padEnd(8)} ${row.advised_p.toFixed(2).padEnd(5)} ${row.advised_confidence.toFixed(2).padEnd(5)} ${row.actual_lane.slice(0, 14).padEnd(14)} ${row.agree ? "✓" : "✗"}`);
  }
  return lines.join("\n");
}

/** Match independently labelled comparisons to the exact shadow answer that produced them. */
export function joinGroundTruth(caller: string, questionId: string, window: ShadowLine[], comparisons: ComparisonLine[], since: number): ComparisonLine[] {
  const byTurn = new Map<string, ComparisonLine>();
  for (const row of comparisons) {
    if (row.caller !== caller || row.question !== questionId || !Number.isFinite(Date.parse(row.timestamp)) || Date.parse(row.timestamp) < since || !row.session || !row.turn) continue;
    const decision = window.find(s => s.session === row.session && s.turn === row.turn && s.model === row.model && !s.error && s.answers?.[questionId]?.type === "noul" && s.answers[questionId].noul === row.jev_value);
    if (!decision || typeof row.keyword_verdict !== "boolean") continue;
    byTurn.set(JSON.stringify([row.session, row.turn, row.model]), row);
  }
  return [...byTurn.values()];
}

export function bunkerReportJoin(question: string, shadow: Array<ShadowLine & { isa_key?: string; claim?: string; state_sha256?: Record<string, string> }>, threshold: number, labels: GlanceSeedLabel[] = glanceSeedLabels()) {
  const selected = labels.filter(e => e.question_id === question);
  const joined = selected.flatMap(label => {
    const row = shadow.findLast(row => row.caller === "bunker-glance" && !row.error && row.isa_key === label.isa_key && row.claim === label.claim && row.state_sha256?.[question] === label.state_sha256 && row.answers?.[question]?.type === "noul" && (!label.request_id || row.request_id === label.request_id));
    const value = row?.answers?.[question]?.noul;
    if (!row || typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) return [];
    return [{ caller: "bunker-glance", question, timestamp: row.ts, session: label.isa_key, turn: label.state_sha256!, model: row.model ?? "unknown", jev_value: value, keyword_verdict: label.label === "pass" }];
  });
  const score = scoreThreshold(joined, threshold);
  const balanced = balancedAccuracy(score);
  return { labels: selected.length, joined: joined.length, agreement: joined.length ? score.rate : null, balanced_accuracy: Number.isFinite(balanced) ? balanced : null,
    positives: score.tp + score.fn, negatives: score.tn + score.fp, best_threshold: recommendBalanced(sweepThresholds(joined)),
    principal: selected.filter(principalAttested).length, proxy: selected.filter(e => !principalAttested(e)).length };
}

/**
 * S6 (ISC-8): what the ONE label store says about a question. Principal right/wrong labels only; proxy labels, "unsure"
 * and pass/fail ground truth never count toward earning. The floor and bar are this registry's (min_labels, enforce_bar).
 */
export function labelStoreEvidence(caller: string, question: string, opts: { path?: string; callersPath?: string } = {}): EarnedStatus {
  return earnedStatus({ caller, question }, opts);
}

function formatStoreEvidence(caller: string, question: string): string {
  const e = labelStoreEvidence(caller, question);
  const engine = e.engine ? ` · engine=${e.engine}${e.other_engine ? ` (${e.other_engine} labels judged another engine, not counted)` : ""}` : "";
  return `${question}: label store (principal right/wrong only) n=${e.n}/${e.min_labels} · agreement=${e.agreement === null ? "n/a" : `${(e.agreement * 100).toFixed(1)}%`} (bar ${(e.bar * 100).toFixed(0)}%) · earned=${e.earned}${engine}`;
}

/**
 * ISC-58: one line per threshold row whose model stamp is not the engine now answering. A row cut on another engine and
 * read under Clef-omni applies a cut measured on different weights; a null stamp was never cut. Neither may be promoted (promoteNoul).
 */
function formatStaleStamp(st: StaleStamp): string {
  return st.model === null
    ? `${st.question}: STAMP uncalibrated (model none) · engine now ${st.engine} · ${st.mode} · cut it on ${st.engine} before promoting`
    : `${st.question}: STAMP stale (cut on ${st.model}) · engine now ${st.engine} · ${st.mode} · re-cut on ${st.engine} before trusting or promoting it`;
}

/** The status line for one caller's stamps, or null when every row carries the live engine's stamp (or there are no rows). */
function formatCallerStamps(caller: string, cfg: CallerConfig, engine: string): string | null {
  const total = Object.keys(cfg.thresholds ?? {}).length;
  const stale = staleStamps({ [caller]: cfg }, engine);
  if (!total || !stale.length) return null;
  const byModel = new Map<string, string[]>();
  for (const st of stale) byModel.set(st.model ?? "none", [...(byModel.get(st.model ?? "none") ?? []), st.question]);
  const parts = [...byModel].map(([m, qs]) => `${m}: ${qs.join(", ")}`).join(" · ");
  return `  ${caller} stamps: ${stale.length}/${total} not ${engine} (${parts})`;
}

function formatBunkerJoin(question: string, result: ReturnType<typeof bunkerReportJoin>): string {
  const percent = (value: number | null) => value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
  return `${question}: ${result.labels} labels / ${result.joined} joined · samples=${result.joined} · agreement=${percent(result.agreement)} · balanced accuracy=${percent(result.balanced_accuracy)} · positives=${result.positives} negatives=${result.negatives} · best threshold=${result.best_threshold ?? "n/a"} · principal=${result.principal} proxy=${result.proxy}`;
}

// ── Report adapters: eval-judge and proof (ISA 20261010-evals-in-the-isa F4, ISC-16) ─────────────────────────────────

export const EVAL_JUDGE_CALLER = "eval-judge";

/** Where EvalRunner persists every suite run (skills/Assay/Tools/EvalRunner.ts RESULTS_DIR): <suite>/<run>/run.json, experiments one level deeper. */
export function evalResultsDir(): string {
  return process.env.LIFEOS_EVAL_RESULTS || lifeosPath("MEMORY", "STATE", "Evals-Results");
}

/** One judged assert where the engine answered and the model judge also ruled on the same assertion over the same output. */
export type EvalJudgeSample = { question: "rubric" | "noul"; model: string; judge_passed: boolean; agree: boolean; ts: string };

// `jev` is the stored key each persisted assert carries (skills/Assay/Tools/Assertions.ts), named for the engine retired 2026-10-10; run files on disk use it.
type PersistedAssert = { type?: unknown; passed?: unknown; unavailable?: unknown; jev?: { agree_with_judge?: unknown; model_versioned?: unknown } };
type PersistedCase = { adversarial_asserts?: unknown; trials?: unknown };

/**
 * Every same-run engine-vs-judge pair in the persisted suite runs since `since`. Judge.ts sets agree_with_judge only when
 * both ruled (a holdout, a shadow question, or an escalation), and `passed` on such an assert is the judge's verdict, so
 * a pair is exactly the eval-judge ground-truth join the registry names. A run file older than the window by mtime is not
 * opened. Unreadable files are skipped.
 */
export function readEvalJudgeSamples(dir: string = evalResultsDir(), since = 0): EvalJudgeSample[] {
  const out: EvalJudgeSample[] = [];
  const visit = (path: string, depth: number): void => {
    let entries: string[];
    try { entries = readdirSync(path); } catch { return; }
    for (const name of entries) {
      const child = join(path, name);
      if (name === "run.json") { readRun(child); continue; }
      if (depth < 3 && !name.includes(".")) visit(child, depth + 1);
    }
  };
  const readRun = (file: string): void => {
    let run: { ts?: unknown; detail?: unknown };
    try {
      if (statSync(file).mtimeMs < since) return;
      run = JSON.parse(readFileSync(file, "utf8"));
    } catch { return; }
    const ts = typeof run.ts === "string" ? run.ts : new Date(statSync(file).mtimeMs).toISOString();
    if (Date.parse(ts) < since || !Array.isArray(run.detail)) return;
    for (const c of run.detail as PersistedCase[]) {
      const trials = Array.isArray(c?.trials) ? c.trials as Array<{ asserts?: unknown }> : [];
      const asserts = [...(Array.isArray(c?.adversarial_asserts) ? c.adversarial_asserts : []), ...trials.flatMap(t => Array.isArray(t?.asserts) ? t.asserts : [])] as PersistedAssert[];
      for (const a of asserts) {
        const base = typeof a?.type === "string" ? a.type.replace(/^not-/, "") : "";
        if ((base !== "llm-rubric" && base !== "llm-assert") || a.unavailable === true || typeof a.passed !== "boolean" || typeof a.jev?.agree_with_judge !== "boolean") continue;
        out.push({ question: base === "llm-assert" ? "noul" : "rubric", model: typeof a.jev.model_versioned === "string" ? a.jev.model_versioned : "unknown",
          judge_passed: a.passed, agree: a.jev.agree_with_judge, ts });
      }
    }
  };
  visit(dir, 0);
  return out;
}

export type JudgeAgreement = { model: string; samples: number; agree: number; rate: number; judge_pass: number; pass_agree: number; judge_fail: number; fail_agree: number; balanced: number | null };

/** Agreement per engine model for one question, with each judge class broken out: balanced accuracy needs both classes, null otherwise. */
export function evalJudgeAgreement(samples: EvalJudgeSample[], question: string): JudgeAgreement[] {
  const byModel = new Map<string, EvalJudgeSample[]>();
  for (const x of samples) if (x.question === question) byModel.set(x.model, [...(byModel.get(x.model) ?? []), x]);
  return [...byModel].sort(([a], [b]) => a.localeCompare(b)).map(([model, rows]) => {
    const pass = rows.filter(r => r.judge_passed), fail = rows.filter(r => !r.judge_passed);
    const agree = rows.filter(r => r.agree).length, passAgree = pass.filter(r => r.agree).length, failAgree = fail.filter(r => r.agree).length;
    return { model, samples: rows.length, agree, rate: agree / rows.length, judge_pass: pass.length, pass_agree: passAgree, judge_fail: fail.length, fail_agree: failAgree,
      balanced: pass.length && fail.length ? (passAgree / pass.length + failAgree / fail.length) / 2 : null };
  });
}

/** The principal-derived right/wrong labels on a caller's question: those already in the store, and the ones the join would add that are not written yet. */
export type OutcomeLabels = { stored: Array<Pick<Label, "id" | "verdict" | "truth">>; pending: Array<Pick<LabelInput, "verdict" | "truth"> & { id: string }> };

/** Read only. Stored: principal right/wrong labels for caller.question. Pending: what deriveJoinedLabels yields for it that is not in the store yet. */
export function outcomeLabels(caller: string, question: string, opts: { path?: string; receiptsDir?: string } = {}): OutcomeLabels {
  const stored = labelsFor({ caller, question }, { path: opts.path, source: "principal" }).filter(l => l.verdict === "right" || l.verdict === "wrong");
  let pending: OutcomeLabels["pending"] = [];
  try { pending = deriveJoinedLabels(opts).labels.filter(l => l.caller === caller && l.question === question); } catch { /* no receipts or store yet: nothing pending */ }
  return { stored, pending };
}

export type OutcomeAgreement = { n: number; stored: number; pending: number; right: number; agreement: number | null; truth_pass: { n: number; right: number }; truth_fail: { n: number; right: number } };

export function outcomeAgreement(labels: OutcomeLabels): OutcomeAgreement {
  const ids = new Set<string>();
  const all = [...labels.stored, ...labels.pending].filter(l => (l.verdict === "right" || l.verdict === "wrong") && !ids.has(l.id) && ids.add(l.id));
  const right = all.filter(l => l.verdict === "right").length;
  const cls = (t: "pass" | "fail") => { const rows = all.filter(l => l.truth === t); return { n: rows.length, right: rows.filter(l => l.verdict === "right").length }; };
  return { n: all.length, stored: labels.stored.length, pending: all.length - labels.stored.length, right, agreement: all.length ? right / all.length : null, truth_pass: cls("pass"), truth_fail: cls("fail") };
}

const pct = (v: number | null): string => v === null ? "n/a" : `${(v * 100).toFixed(1)}%`;

function formatJudgeAgreement(id: string, rows: JudgeAgreement[]): string[] {
  if (rows.length === 0) return [`${id}: engine vs model judge — no same-run pairs in the window, agreement not computable`];
  return rows.map(r => `${id} model=${r.model}: engine vs model judge (same assertion, same output) samples=${r.samples} agreement=${r.agree}/${r.samples} (${pct(r.rate)}) · judge PASS ${r.judge_pass} (engine agrees ${r.pass_agree}) · judge FAIL ${r.judge_fail} (engine agrees ${r.fail_agree}) · balanced=${pct(r.balanced)}`);
}

function formatOutcomeAgreement(id: string, a: OutcomeAgreement): string[] {
  const out = [`${id}: engine vs principal outcome (joined right/wrong labels, all time) n=${a.n} (stored ${a.stored}, pending join ${a.pending}) · agreement=${a.agreement === null ? "n/a" : `${a.right}/${a.n} (${pct(a.agreement)})`} · truth pass ${a.truth_pass.right}/${a.truth_pass.n} · truth fail ${a.truth_fail.right}/${a.truth_fail.n}`];
  if (a.pending > 0) out.push(`${id}: ${a.pending} joined labels not written yet — the label backfill writes them; earning counts only stored labels`);
  return out;
}

/** Test seam for buildCallerReport: the adapters' inputs, read from their default stores when absent. */
/** `engine` replaces the live engine id the stamp lines compare with (test seam). */
export type ReportSources = { evalJudge?: EvalJudgeSample[]; outcome?: (caller: string, question: string) => OutcomeLabels; engine?: string; reviewDefect?: string[] };
/** The judgment caller whose ground truth is {{PRINCIPAL_NAME}}'s case labels (ReviewCases.ts label); its lines come from ReviewEntry.ts. */
const REVIEW_DEFECT_CALLER = "review-case-defect";

function comparisonRowsInWindow(caller: string, questionId: string, comparisons: ComparisonLine[], since: number): ComparisonLine[] {
  return comparisons.filter((row) => row.caller === caller && row.question === questionId && Number.isFinite(Date.parse(row.timestamp)) && Date.parse(row.timestamp) >= since);
}

function hasMatchingShadow(row: ComparisonLine, questionId: string, window: ShadowLine[]): boolean {
  return !!window.find((s) => s.session === row.session && s.turn === row.turn && s.model === row.model && !s.error && s.answers?.[questionId]?.type === "noul" && s.answers[questionId].noul === row.jev_value);
}

/** Below this many positive examples a threshold is fitted to noise, whatever it scores. */
export const MIN_POSITIVES = 30;

export type SweepPoint = { threshold: number; rows: number; agree: number; rate: number; tp: number; fp: number; fn: number; tn: number };

function scoreThreshold(matched: ComparisonLine[], threshold: number): SweepPoint {
  let agree = 0, tp = 0, fp = 0, fn = 0, tn = 0;
  for (const row of matched) {
    const fires = row.jev_value >= threshold;
    if (fires && row.keyword_verdict) tp++;
    else if (fires) fp++;
    else if (row.keyword_verdict) fn++;
    else tn++;
    if (fires === row.keyword_verdict) agree++;
  }
  return { threshold, rows: matched.length, agree, rate: matched.length ? agree / matched.length : 0, tp, fp, fn, tn };
}

export function sweepThresholds(matched: ComparisonLine[], step: number = 0.01): SweepPoint[] {
  if (!Number.isFinite(step) || step <= 0) throw new RangeError("sweep step must be a positive finite number");
  const thresholds: number[] = [];
  for (let i = 0; ; i++) {
    const threshold = Number(Math.min(i * step, 1).toFixed(2));
    if (thresholds.at(-1) !== threshold) thresholds.push(threshold);
    if (threshold === 1) break;
  }
  return thresholds.map((threshold) => scoreThreshold(matched, threshold));
}

/**
 * The midpoint of the WIDEST plateau of maximum score. A value that wins by one row on a
 * knife edge is not a threshold, it is an artifact of the sample.
 */
function plateauMidpoint(points: SweepPoint[], scoreOf: (p: SweepPoint) => number): number | null {
  if (points.length === 0 || points.every((point) => point.rows === 0)) return null;
  const scores = points.map(scoreOf);
  if (scores.every((v) => !Number.isFinite(v))) return null;
  const maximum = Math.max(...scores.filter(Number.isFinite));
  let best: [number, number] | null = null;
  for (let start = 0; start < points.length;) {
    if (scores[start] !== maximum) { start++; continue; }
    let end = start;
    while (end + 1 < points.length && scores[end + 1] === maximum) end++;
    if (!best || end - start > best[1] - best[0]) best = [start, end];
    start = end + 1;
  }
  if (!best) return null;
  const midpoint = (points[best[0]].threshold + points[best[1]].threshold) / 2;
  let chosen = best[0];
  for (let i = best[0] + 1; i <= best[1]; i++) {
    if (Math.abs(points[i].threshold - midpoint) < Math.abs(points[chosen].threshold - midpoint)) chosen = i;
  }
  return points[chosen].threshold;
}

export function recommendThreshold(points: SweepPoint[]): number | null {
  return plateauMidpoint(points, (point) => point.rate);
}

/**
 * Recall and specificity averaged, so the rare class counts as much as the common one.
 * NaN when either class is empty — with no positives there is nothing to be right about.
 */
export function balancedAccuracy(point: SweepPoint): number {
  const positives = point.tp + point.fn;
  const negatives = point.tn + point.fp;
  if (positives === 0 || negatives === 0) return NaN;
  return (point.tp / positives + point.tn / negatives) / 2;
}

export type NoulSeed = { labels: Array<{ expected: "yes" | "no"; noul: number }> };

/** Promotion uses kept seed labels, including correctly resolved labels of both classes. */
export function noulPromotionCheck(seed: NoulSeed, threshold: CallerThreshold, enforceBar: number | undefined, defaultMinPositives = 1): { allowed: boolean; balanced: number | null; false_pass_rate: number | null; false_fail_rate: number | null; reasons: string[] } {
  let tp = 0, tn = 0, fp = 0, fn = 0;
  const reasons: string[] = [];
  for (const label of seed.labels) {
    if (label.expected !== "yes" && label.expected !== "no") throw new Error("Invalid seed label");
    const answer = noulValue(label.noul);
    const correct = answer.confidence >= threshold.value && answer.verdict === label.expected;
    if (label.expected === "yes") { if (correct) tp++; else fn++; }
    else { if (correct) tn++; else fp++; }
  }
  const balanced = balancedAccuracy({ threshold: threshold.value, rows: seed.labels.length, agree: tp + tn, rate: 0, tp, tn, fp, fn });
  if (!tp) reasons.push("seed needs a correctly answered positive label");
  const minPositives = threshold.min_positives ?? defaultMinPositives;
  if (!Number.isInteger(minPositives) || minPositives < 1) reasons.push("invalid positive label floor");
  if (tp + fn < minPositives) reasons.push(`seed needs at least ${minPositives} positive labels`);
  if (!tn) reasons.push("seed needs a correctly answered negative label");
  if (enforceBar === undefined || !Number.isFinite(enforceBar)) reasons.push("no enforce_bar registered");
  if (!Number.isFinite(balanced) || (enforceBar !== undefined && balanced < enforceBar)) reasons.push("balanced accuracy below enforce bar");
  return { allowed: reasons.length === 0, balanced: Number.isFinite(balanced) ? balanced : null, false_pass_rate: tn + fp ? fp / (tn + fp) : null, false_fail_rate: tp + fn ? fn / (tp + fn) : null, reasons };
}

/**
 * The explicit shadow-to-enforce transition for a caller with one noul question. Two things must hold (ISC-8): the seed file
 * (kept history: it checks both classes and balanced accuracy) AND the one label store (LabelStore.earnedStatus: principal
 * right/wrong labels only, at the registered floor and bar). The seed alone no longer suffices, and a proxy label never earns.
 * `opts.labelPath` is the test seam for the label store. Evidence must describe the engine answering now (promotionRefusal):
 * the row cut on the live engine AND under the canary's current fingerprint, and only labels that judged the live engine count.
 * Promotion never rewrites the row's fingerprint, so it cannot erase staleness after a same-model weight change.
 */
export function promoteNoul(caller: string, question: string, seedPath: string, callersPath = defaultCallersPath(), opts: { labelPath?: string; engine?: string; fingerprint?: string | null } = {}): void {
  const engine = opts.engine ?? liveEngineId();
  const { callers, defaults } = loadRegistry(callersPath);
  const cfg = callers[caller];
  invariant(!!cfg && cfg.mode === "shadow", "noul promotion requires a registered shadow caller");
  invariant(Object.keys(cfg.thresholds).length === 1 && !!cfg.thresholds[question], "noul promotion requires an isolated question caller");
  invariant(cfg.thresholds[question].min_labels ?? defaults.min_labels, `noul promotion refused: ${caller}.${question}: no label floor registered`);
  const seed = JSON.parse(readFileSync(seedPath, "utf8")) as NoulSeed;
  const check = noulPromotionCheck(seed, cfg.thresholds[question], cfg.enforce_bar, callers["eval-judge"]?.enforce_evidence?.positives ?? 1);
  invariant(check.allowed, `noul promotion refused: ${check.reasons.join("; ")}`);
  const earned = earnedStatus({ caller, question }, { path: opts.labelPath, callersPath, engine });
  invariant(earned.earned, `noul promotion refused: the label store has ${earned.n} principal right/wrong labels for ${caller}.${question} (agreement ${earned.agreement === null ? "none" : earned.agreement.toFixed(2)}); it needs at least ${earned.min_labels} at agreement ${earned.bar}. Seed labels alone do not earn.`);
  const model = cfg.thresholds[question].model;
  invariant(typeof model === "string" && model.length > 0, "noul promotion requires a calibrated model");
  // ISC-59/ISC-60: a cut measured on another engine, or on other weights of this one, is not evidence about the engine now answering.
  const fingerprint = opts.fingerprint !== undefined ? opts.fingerprint : currentFingerprint({ engine });
  const refusal = promotionRefusal(cfg.thresholds[question], engine, fingerprint);
  invariant(refusal === null, `noul promotion refused: ${caller}.${question} ${refusal}`);
  invariant(cfg.thresholds[question].fingerprint === fingerprint && typeof fingerprint === "string", "noul promotion: the row's fingerprint must already be the current one; promotion never stamps it");
  cfg.mode = "enforce";
  if (cfg.thresholds[question].mode) cfg.thresholds[question].mode = "enforce";
  cfg.enforce_evidence = { agreement: check.balanced!, date: new Date().toISOString(), model, fingerprint };
  validateCallers(callers, { defaults, labelPath: opts.labelPath });
  writeFileSync(callersPath, JSON.stringify({ ...(Object.keys(defaults).length ? { defaults } : {}), ...callers }, null, 2) + "\n");
}

/**
 * The honest recommendation on an imbalanced ledger. Raw agreement recommends the never-fire
 * point whenever positives are rare: with a handful of positives in hundreds of rows, a
 * threshold nothing clears scores near 100%. Balanced accuracy refuses that trade.
 */
export function recommendBalanced(points: SweepPoint[]): number | null {
  return plateauMidpoint(points, balancedAccuracy);
}

export function recommendRecallFloor(points: SweepPoint[], minRecall: number = 1): number | null {
  let chosen: number | null = null;
  for (const point of points) {
    const positives = point.tp + point.fn;
    if (positives > 0 && point.tp / positives >= minRecall && (chosen === null || point.threshold > chosen)) chosen = point.threshold;
  }
  return chosen;
}

export function tuneBlockedBy(enforceBar: number | null, recommendedBalanced: number | null, sep: Separation, rows: number, model: string, registeredModel: string | null | undefined): string[] {
  const blockedBy: string[] = [];
  if (enforceBar === null) blockedBy.push("no enforce_bar registered");
  if (enforceBar !== null && (recommendedBalanced === null || !Number.isFinite(recommendedBalanced) || recommendedBalanced < enforceBar)) blockedBy.push(`balanced accuracy ${Number.isFinite(recommendedBalanced as number) ? `${(recommendedBalanced! * 100).toFixed(1)}%` : "n/a"} under the ${(enforceBar * 100).toFixed(0)}% bar`);
  if (sep.verdict === "no-positives" || sep.verdict === "no-negatives" || sep.verdict === "no-signal") blockedBy.push(`probabilities do not rank positives above negatives (AUC ${sep.auc === null ? "n/a" : sep.auc.toFixed(3)}); no monotone threshold separates them here`);
  if (sep.positives < MIN_POSITIVES) blockedBy.push(`only ${sep.positives} positives`);
  if (rows < 200) blockedBy.push(`only ${rows} matched rows`);
  if (model !== registeredModel) blockedBy.push(`model ${model} does not match registered model ${registeredModel ?? "none"}`);
  return blockedBy;
}

export type SeparationVerdict = "no-positives" | "no-negatives" | "no-signal" | "weak" | "usable" | "strong";
export type Separation = { positives: number; negatives: number; base_rate: number | null; auc: number | null; verdict: SeparationVerdict };

/**
 * Whether the probabilities separate the two classes at all, independent of any threshold.
 * AUC is the chance a random positive scores above a random negative (ties count half), so
 * 0.5 is a coin flip. Computed on tie-averaged ranks.
 */
export function separation(matched: ComparisonLine[]): Separation {
  const positives = matched.filter((row) => row.keyword_verdict).map((row) => row.jev_value);
  const negatives = matched.filter((row) => !row.keyword_verdict).map((row) => row.jev_value);
  const base = matched.length ? positives.length / matched.length : null;
  if (positives.length === 0 || negatives.length === 0)
    return { positives: positives.length, negatives: negatives.length, base_rate: base, auc: null, verdict: positives.length === 0 ? "no-positives" : "no-negatives" };
  const all = [...positives.map((v) => ({ v, pos: true })), ...negatives.map((v) => ({ v, pos: false }))].sort((a, b) => a.v - b.v);
  const ranks = new Array<number>(all.length);
  for (let i = 0; i < all.length;) {
    let j = i;
    while (j + 1 < all.length && all[j + 1].v === all[i].v) j++;
    const shared = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[k] = shared;
    i = j + 1;
  }
  let rankSum = 0;
  all.forEach((row, i) => { if (row.pos) rankSum += ranks[i]; });
  const auc = (rankSum - (positives.length * (positives.length + 1)) / 2) / (positives.length * negatives.length);
  // 0.60/0.75/0.90 are descriptive reporting bands, not significance tests, and carry no safety guarantee.
  const verdict: SeparationVerdict = auc >= 0.9 ? "strong" : auc >= 0.75 ? "usable" : auc >= 0.6 ? "weak" : "no-signal";
  return { positives: positives.length, negatives: negatives.length, base_rate: base, auc, verdict };
}

/** One call per event today; sum when several rows share an explicit event key. */
export function latencyDistribution(rows: ShadowLine[]): { count: number; p50: number | null; p95: number | null; max: number | null } {
  const sums = new Map<string, number>();
  rows.forEach((r, i) => {
    if (!Number.isFinite(r.latency_ms) || r.latency_ms < 0) return;
    const key = r.turn ? JSON.stringify([r.session, r.turn]) : String(i);
    sums.set(key, (sums.get(key) ?? 0) + r.latency_ms);
  });
  const values = [...sums.values()].sort((a, b) => a - b);
  const percentile = (p: number) => values.length ? values[Math.ceil(values.length * p / 100) - 1] : null;
  return { count: values.length, p50: percentile(50), p95: percentile(95), max: values.at(-1) ?? null };
}

/** Spend uses the last seven logged days; agreement uses the requested time window. */
export function buildCallerReport(caller: string, shadow: ShadowLine[], cfg: CallerConfig | null, dispatches: DispatchEvent[], since: number = Date.now() - 7 * 86_400_000, comparisons: ComparisonLine[] = [], sources: ReportSources = {}): string {
  if (!cfg) return `Caller "${caller}" is not registered in assay-callers.json — no agreement, no spend, no enforce.`;
  const lines = [`Judgment layer report — caller: ${caller} (${cfg.mode})`];
  for (const st of staleStamps({ [caller]: cfg }, sources.engine ?? liveEngineId())) lines.push(formatStaleStamp(st));
  const rows = shadow.filter((s) => s.caller === caller);
  const days = new Map<string, { calls: number; tokens: number }>();
  for (const row of rows) {
    const day = row.ts.slice(0, 10);
    const bucket = days.get(day) ?? { calls: 0, tokens: 0 };
    bucket.calls++;
    bucket.tokens += (row.input_tokens ?? 0) + (row.output_tokens ?? 0);
    days.set(day, bucket);
  }
  for (const day of [...days.keys()].sort().slice(-7)) {
    const bucket = days.get(day)!;
    lines.push(`${day}: ${bucket.calls} calls, ${bucket.tokens} tokens`);
  }
  if (rows.length === 0) lines.push("no shadow-log rows for this caller yet");
  const window = rows.filter((s) => Date.parse(s.ts) >= since);
  const minCorrelationSamples = cfg.correlation_min_samples ?? 20;
  for (const correlation of answerCorrelations(window, minCorrelationSamples)) {
    lines.push(`answer correlation ${correlation.left}+${correlation.right}: r=${correlation.pearson.toFixed(3)} n=${correlation.samples}`);
  }
  const latency = latencyDistribution(window);
  lines.push(`per-turn summed engine latency_ms: n=${latency.count} p50=${latency.p50 ?? "n/a"} p95=${latency.p95 ?? "n/a"} max=${latency.max ?? "n/a"}`);
  for (const [id, truth] of Object.entries(cfg.ground_truth)) {
    if (cfg.corrective[id]) {
      lines.push(`${id}: Corrective caller: agreement against the carrier's own action is refused (ISC-41).`);
      lines.push(`Ground truth needed: ${cfg.ground_truth_note ?? "none configured"}`);
    } else if (truth === null) {
      lines.push(`${id}: no ground-truth join registered, agreement not computable`);
    } else if (caller === EVAL_JUDGE_CALLER) {
      // Ground truth is the model judge, a proxy: this measures agreement, it never earns enforce (that is the label store line).
      const samples = sources.evalJudge ??= readEvalJudgeSamples(evalResultsDir(), since);
      lines.push(...formatJudgeAgreement(id, evalJudgeAgreement(samples, id)));
      lines.push(formatStoreEvidence(caller, id));
    } else if (caller === PROOF_GLANCE_CALLER && id === PROOF_GLANCE_QUESTION) {
      lines.push(...formatOutcomeAgreement(id, outcomeAgreement((sources.outcome ?? outcomeLabels)(caller, id))));
      lines.push(formatStoreEvidence(caller, id));
    } else if (caller === "bunker-glance") {
      lines.push(formatBunkerJoin(id, bunkerReportJoin(id, window, cfg.thresholds[id]?.value ?? Infinity)));
      lines.push(formatStoreEvidence(caller, id));
    } else if (caller === REVIEW_DEFECT_CALLER && sources.reviewDefect) {
      lines.push(...sources.reviewDefect);
    } else if (truth.ledger) {
      const threshold = cfg.thresholds[id];
      const joined = joinGroundTruth(caller, id, window, comparisons, since);
      const models = new Set(joined.map(r => r.model));
      if (!threshold || models.size === 0) {
        lines.push(`${id}: no matched ground-truth rows, agreement not computable`);
        continue;
      }
      for (const model of models) {
        const matched = joined.filter(r => r.model === model);
        const agree = matched.filter(r => (r.jev_value >= threshold.value) === r.keyword_verdict).length;
        const rate = agree / matched.length;
        // Agreement alone says almost nothing on these ledgers — positives are rare, so a
        // threshold nothing clears scores near 100%. Enforce eligibility is balanced accuracy over a
        // question whose probabilities actually separate the classes (ISC-29).
        const sep = separation(matched);
        const point = scoreThreshold(matched, threshold.value);
        const balanced = balancedAccuracy(point);
        lines.push(`${id} model=${model}: rows=${matched.length} agreement=${agree}/${matched.length} (${(rate * 100).toFixed(1)}%) · positives=${sep.positives} (${sep.base_rate === null ? "n/a" : `${(sep.base_rate * 100).toFixed(1)}%`}) · balanced=${Number.isFinite(balanced) ? `${(balanced * 100).toFixed(1)}%` : "n/a"} · separation=${sep.auc === null ? "n/a" : sep.auc.toFixed(3)} (${sep.verdict})`);
        if (model !== threshold.model) continue;
        const reasons: string[] = [];
        if (matched.length < 200) reasons.push(`only ${matched.length} matched rows`);
        if (sep.positives < MIN_POSITIVES) reasons.push(`only ${sep.positives} positives`);
        if (sep.verdict === "no-positives" || sep.verdict === "no-negatives" || sep.verdict === "no-signal") reasons.push(`probabilities do not rank positives above negatives (AUC ${sep.auc === null ? "n/a" : sep.auc.toFixed(3)}); no monotone threshold separates them here`);
        if (cfg.enforce_bar !== undefined && (!Number.isFinite(balanced) || balanced < cfg.enforce_bar))
          reasons.push(`balanced accuracy ${Number.isFinite(balanced) ? `${(balanced * 100).toFixed(1)}%` : "n/a"} under the ${(cfg.enforce_bar * 100).toFixed(0)}% bar`);
        if (cfg.enforce_bar === undefined) reasons.push("no enforce_bar registered");
        lines.push(reasons.length === 0 ? `${id}: enforceable` : `${id}: not enforceable — ${reasons.join("; ")}`);
      }
    } else if (id === "lane" && /subagent-events\.jsonl/.test(truth.source)) {
      const events = dispatches.filter(d => { const t = Date.parse(d.ts ?? d.timestamp ?? ""); return Number.isNaN(t) || t >= since; });
      const report = buildReport(window, events, { caller, confidenceFloor: cfg.thresholds[id]?.value ?? Infinity });
      lines.push(formatReport(report));
      // The lane branch joins against dispatch events, not a two-class ledger, so there is no
      // balanced accuracy to compute here. It stays on agreement and says so (ISC-29).
      if (report.total >= 200 && cfg.enforce_bar !== undefined && report.agree / report.total >= cfg.enforce_bar)
        lines.push("enforceable on agreement only — this join has no negative class to balance against");
    } else {
      lines.push(`${id}: ground-truth join is owned by ${truth.source}; no shared report adapter`);
    }
  }
  return lines.join("\n");
}

export type AlertLine = { caller: string; errorRate: number; errors: number; calls: number; floor: number };

/** Rolling 24h outage rate; gates count as calls, never as outage errors. */
export function outageAlerts(shadow: ShadowLine[], callers: CallersConfig, now: number = Date.now()): AlertLine[] {
  const since = now - 24 * 60 * 60 * 1000;
  const byCaller = new Map<string, { errors: number; calls: number }>();
  for (const line of shadow) {
    const t = Date.parse(line.ts);
    if (Number.isNaN(t) || t < since) continue;
    const bucket = byCaller.get(line.caller) ?? { errors: 0, calls: 0 };
    bucket.calls++;
    const kind = line.error_kind ?? line.error;
    if (kind && (kind === "timeout" || kind === "network" || kind === "shape" || (typeof kind === "string" && kind.startsWith("http-")))) bucket.errors++;
    byCaller.set(line.caller, bucket);
  }
  const out: AlertLine[] = [];
  for (const [caller, { errors, calls }] of byCaller) {
    if (calls === 0) continue;
    const floor = callers[caller]?.error_floor ?? 0.2;
    const rate = errors / calls;
    if (rate > floor) out.push({ caller, errorRate: rate, errors, calls, floor });
  }
  return out.sort((a, b) => b.errorRate - a.errorRate);
}

export function formatAlert(a: AlertLine): string {
  return `ALERT: ${a.caller} error rate ${(a.errorRate * 100).toFixed(1)}% over floor ${(a.floor * 100).toFixed(0)}% (${a.errors}/${a.calls} calls, 24h)`;
}

export type AnswerCorrelation = { left: string; right: string; samples: number; pearson: number };

function probability(answer: NonNullable<ShadowLine["answers"]>[string] | undefined): number | null {
  if (!answer) return null;
  if (answer.type === "noul") return answer.noul ?? null;
  if (answer.choice) return answer.probabilities?.[answer.choice] ?? answer.confidence ?? null;
  if (answer.score !== undefined) return answer.probabilities?.[String(answer.score)] ?? answer.confidence ?? null;
  return answer.confidence ?? null;
}

export function answerCorrelations(rows: ShadowLine[], minSamples: number): AnswerCorrelation[] {
  const pairs = new Map<string, { left: string; right: string; values: Array<[number, number]> }>();
  for (const row of rows) {
    if (row.error || !row.answers || row.questions.length < 2) continue;
    const ids = [...new Set(row.questions)].sort();
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
      const left = ids[i]!, right = ids[j]!;
      const x = probability(row.answers[left]), y = probability(row.answers[right]);
      if (x === null || y === null || !Number.isFinite(x) || !Number.isFinite(y)) continue;
      const key = `${left}\0${right}`;
      const pair = pairs.get(key) ?? { left, right, values: [] };
      pair.values.push([x, y]); pairs.set(key, pair);
    }
  }
  const out: AnswerCorrelation[] = [];
  for (const pair of pairs.values()) {
    if (pair.values.length <= minSamples) continue;
    const mx = pair.values.reduce((sum, [x]) => sum + x, 0) / pair.values.length;
    const my = pair.values.reduce((sum, [, y]) => sum + y, 0) / pair.values.length;
    let covariance = 0, varianceX = 0, varianceY = 0;
    for (const [x, y] of pair.values) { covariance += (x - mx) * (y - my); varianceX += (x - mx) ** 2; varianceY += (y - my) ** 2; }
    const denominator = Math.sqrt(varianceX * varianceY);
    if (denominator > 0) out.push({ left: pair.left, right: pair.right, samples: pair.values.length, pearson: covariance / denominator });
  }
  return out.sort((a, b) => a.left.localeCompare(b.left) || a.right.localeCompare(b.right));
}

// ── Status: one line per registered caller ───────────────────────────────────

export type CallerStatusLine = {
  caller: string;
  mode: CallerMode;
  rows: number;
  /** Error rate over judged rows only: budget-skipped rows are in neither the numerator nor the denominator. null when nothing was judged. */
  errorRate: number | null;
  /** Rows in the window skipped because the caller's daily budget was spent. */
  budgetSkips: number;
  agreementComputable: boolean;
};

/** A row the budget gate skipped (error_kind "budget"; rows written before error_kind carry error "budget"). */
export const isBudgetSkip = (s: ShadowLine): boolean => (s.error_kind ?? s.error) === "budget";

/** One row per registered caller: mode, calls in the last 24h, error rate, and whether agreement is computable from a registered, non-corrective ground truth. */
export function buildStatusReport(callers: CallersConfig, shadow: ShadowLine[], now: number = Date.now()): CallerStatusLine[] {
  const since = now - 24 * 60 * 60 * 1000;
  const out: CallerStatusLine[] = [];
  for (const name of Object.keys(callers).sort()) {
    const cfg = callers[name];
    const rows = shadow.filter((s) => s.caller === name && Number.isFinite(Date.parse(s.ts)) && Date.parse(s.ts) >= since);
    const budgetSkips = rows.filter(isBudgetSkip).length;
    const judged = rows.length - budgetSkips;
    const errors = rows.filter((s) => !!s.error && !isBudgetSkip(s)).length;
    const errorRate = judged > 0 ? errors / judged : null;
    const agreementComputable = Object.entries(cfg.ground_truth).some(([id, truth]) => !cfg.corrective[id] && truth !== null);
    out.push({ caller: name, mode: cfg.mode, rows: rows.length, errorRate, budgetSkips, agreementComputable });
  }
  return out;
}

export function formatStatusLine(s: CallerStatusLine): string {
  const rate = s.errorRate === null ? "n/a" : `${(s.errorRate * 100).toFixed(1)}%`;
  return `${s.caller}: mode=${s.mode} · rows(24h)=${s.rows} · error_rate=${rate} · agreement=${s.agreementComputable ? "computable" : "not computable"} · budget_skips=${s.budgetSkips}`;
}

/**
 * One line per caller naming every question's effective mode, so a caller in enforce whose questions are all shadow
 * reads as what it is (eval-judge until 2026-09-30: "enforce" on the caller row while none of its asserts resolved).
 */
export function formatEffectiveModes(caller: string, cfg: CallerConfig): string {
  const ids = Object.keys(cfg.thresholds).sort();
  if (ids.length === 0) return `  ${caller} effective: no questions registered`;
  const enforced = ids.filter((id) => effectiveMode(cfg, id) === "enforce");
  const shadow = ids.filter((id) => effectiveMode(cfg, id) === "shadow");
  const part = (label: string, list: string[]) => `${label} ${list.length}/${ids.length}${list.length ? ` (${list.join(", ")})` : ""}`;
  return `  ${caller} effective: ${part("enforce", enforced)} · ${part("shadow", shadow)}`;
}

/**
 * `blocking` findings fail `status`. A "waived" finding is a label-floor shortfall on a row the principal's waiver covers
 * right now (Registry.waiverActive, the same rule decide() acts on): it is printed with its expiry and does not fail status.
 */
export type StatusPolicyFinding = { caller: string; question: string; kind: "proxy-truth" | "label-floor" | "waived"; blocking: boolean; message: string };

const proxyTruth = (source: string): boolean => /\bmodel(?:[- ]judge| caller)?\b|\bjudge(?:\.ts| assertion| text| model)\b|\bdeterministic\b|\bkeyword tables?\b|\bguard(?:'s)? own check\b/i.test(source);

/**
 * Enforce rows must be backed by principal labels, not another model/code verdict, and must meet their registered label floor.
 * An active principal waiver covers the label-floor shortfall only, and only while it is in force; proxy truth and a missing
 * floor still block under a waiver.
 */
export function statusPolicyFindings(callers: CallersConfig, defaults: RegistryDefaults = {}, allowProxy = false, now = Date.now()): StatusPolicyFinding[] {
  const out: StatusPolicyFinding[] = [];
  for (const [caller, cfg] of Object.entries(callers).sort(([a], [b]) => a.localeCompare(b))) {
    for (const [question, threshold] of Object.entries(cfg.thresholds).sort(([a], [b]) => a.localeCompare(b))) {
      const enforced = threshold.mode === "enforce" || (cfg.mode === "enforce" && threshold.mode !== "shadow");
      if (!enforced) continue;
      const truth = cfg.ground_truth[question];
      if (!allowProxy && truth && proxyTruth(truth.source)) {
        out.push({ caller, question, kind: "proxy-truth", blocking: true, message: `${caller}.${question}: proxy-truth source=${JSON.stringify(truth.source)} · registry edit: set thresholds.${question}.mode to "shadow" until ground_truth.${question}.source names a principal-attested label source` });
      }
      const floor = threshold.min_labels ?? defaults.min_labels;
      if (floor === undefined) {
        out.push({ caller, question, kind: "label-floor", blocking: true, message: `${caller}.${question}: no label floor registered · registry edit: set thresholds.${question}.min_labels or defaults.min_labels before enforcement` });
        continue;
      }
      const waiver = cfg.waiver;
      if (threshold.samples < floor && waiver && waiverActive(waiver, now)) {
        out.push({ caller, question, kind: "waived", blocking: false, message: `${caller}.${question}: enforce under the principal's waiver until ${waiver.expires} · label-floor samples=${threshold.samples} min_labels=${floor} · its labels must earn it by then, or decide() stops acting on it` });
      } else if (threshold.samples < floor) {
        out.push({ caller, question, kind: "label-floor", blocking: true, message: `${caller}.${question}: label-floor samples=${threshold.samples} min_labels=${floor} · registry edit: set thresholds.${question}.mode to "shadow" until at least ${floor} labels are recorded` });
      }
    }
  }
  return out;
}

// ── CLI ───────────────────────────────────────────────────────────────────────

function arg(flag: string, argv: string[]): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

export async function main(argv: string[]): Promise<number> {
  const cmd = argv[0];
  if (!cmd || cmd === "-h" || cmd === "--help") {
    console.log("Usage: bun LIFEOS/ASSAY/Assay.ts status | ask --state <text> --questions <json> [--caller name] | ask-many --states <jsonl> --questions <json> [--caller name] [--concurrency N] | report [--days N] [--caller name] | tune --caller <name> [--days N] [--step S] [--json] | promote-noul --caller <name> --question <id> --seed <json> | alerts | drift | callers [--check-docs] | replay --review <case id> [--k N] [--max-calls N] [--json] | suite --review [--k N] [--max-calls N] [--dry-run] [--vigil] [--json]\nSecret values are refused before any call — see LIFEOS/ASSAY/Engine.ts header.");
    return 0;
  }
  if (cmd === "replay" && argv.includes("--review")) return (await import("./ReviewEntry.ts")).replayMain(argv.slice(1));
  if (cmd === "replay") { console.error("Assay: `replay <rewind fixture>` replayed recorded calls through the PreToolUse guard dispatcher, which was retired 2026-10-24 (ISA 20261024-native-security). `replay --review <case id>` still runs."); return 2; }
  if (cmd === "suite") return (await import("./ReviewEntry.ts")).suiteMain(argv.slice(1));
  if (cmd === "status") {
    const { callers, defaults } = loadRegistry();
    const shadow = readShadowHistory();
    const engine = liveEngineId();
    for (const line of buildStatusReport(callers, shadow)) {
      console.log(formatStatusLine(line));
      console.log(formatEffectiveModes(line.caller, callers[line.caller]!));
      const stamps = formatCallerStamps(line.caller, callers[line.caller]!, engine);
      if (stamps) console.log(stamps);
    }
    for (const [question, threshold] of Object.entries(callers["bunker-glance"]?.thresholds ?? {})) {
      console.log(`bunker-glance.${formatBunkerJoin(question, bunkerReportJoin(question, shadow, threshold.value))}`);
      console.log(`bunker-glance.${formatStoreEvidence("bunker-glance", question)}`);
    }
    const stale = staleStamps(callers, engine);
    const rows = Object.values(callers).reduce((n, c) => n + Object.keys(c.thresholds ?? {}).length, 0);
    console.log(`engine ${engine}: ${stale.length}/${rows} threshold rows carry another engine's stamp or none (${stale.filter((s) => s.model === null).length} never cut)${stale.length ? "; re-cut them on the live engine before promoting" : ""}`);
    const fp = readFingerprintState();
    console.log(fp && fp.engine === engine ? `engine fingerprint: ${fp.fingerprint} (canary ${fp.at}, ${fp.cases} questions${fp.previous ? `, was ${fp.previous.fingerprint}` : ""})` : `engine fingerprint: none for ${engine} (the assay-engine-fingerprint canary has not run on it)`);
    const findings = statusPolicyFindings(callers, defaults, argv.includes("--allow-proxy"));
    for (const finding of findings) (finding.blocking ? console.error : console.log)(finding.message);
    return findings.some((f) => f.blocking) ? 1 : 0;
  }
  if (cmd === "promote-noul") {
    const caller = arg("--caller", argv), question = arg("--question", argv), seed = arg("--seed", argv);
    if (!caller || !question || !seed) { console.error("promote-noul needs --caller, --question and --seed"); return 1; }
    promoteNoul(caller, question, seed);
    console.log(`${caller}.${question}: promoted using seed negatives and balanced accuracy`);
    return 0;
  }
  if (cmd === "ask") {
    const state = arg("--state", argv);
    const q = arg("--questions", argv);
    if (!state || !q) { console.error("ask needs --state and --questions"); return 1; }
    const r = await ask(state, JSON.parse(q) as Questions, { caller: arg("--caller", argv) ?? "cli" });
    console.log(JSON.stringify(r, null, 1));
    return 0;
  }
  if (cmd === "ask-many") {
    const file = arg("--states", argv);
    const q = arg("--questions", argv);
    if (!file || !q) { console.error("ask-many needs --states <jsonl of {key,state}> and --questions"); return 1; }
    const items = readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as ManyItem);
    const concurrency = Number(arg("--concurrency", argv) ?? DEFAULT_CONCURRENCY);
    const t0 = performance.now();
    const results = await judgeMany(items, JSON.parse(q) as Questions, { caller: arg("--caller", argv) ?? "cli", concurrency });
    for (const r of results) console.log(JSON.stringify(r));
    console.error(`${results.length} items · ${results.filter((r) => r.error).length} failed · ${Math.round(performance.now() - t0)}ms wall · concurrency ${concurrency}`);
    return 0;
  }
  if (cmd === "report") {
    const caller = arg("--caller", argv) ?? "dispatch-advisor";
    const reverts = checkModelDrift();
    for (const r of reverts) console.log(`Reverted "${r.caller}" to shadow: model changed from ${r.from} to ${r.to} (${r.date})`);
    const cfg = safeCallerConfig(caller);
    // The code reviewer block reads only files and makes no model call; it shows on the default report and for its own caller.
    const reviewer = !arg("--caller", argv) || caller === REVIEW_DEFECT_CALLER ? await import("./ReviewEntry.ts") : null;
    const reviewerBlock = reviewer ? "\n" + reviewer.reviewerBlock({ withAgreement: caller !== REVIEW_DEFECT_CALLER }) : "";
    if (!cfg) { console.log(buildCallerReport(caller, [], null, []) + reviewerBlock); return 0; }
    const days = Number(arg("--days", argv) ?? 7);
    const since = Date.now() - days * 86_400_000;
    const shadow = readShadowHistory();
    const dispatches = Object.entries(cfg.ground_truth).some(([id, truth]) => !cfg.corrective[id] && truth?.source.includes("subagent-events.jsonl"))
      ? readJsonl<DispatchEvent>(lifeosPath("MEMORY", "OBSERVABILITY", "subagent-events.jsonl")) : [];
    const comparisons = [...new Set(Object.values(cfg.ground_truth).flatMap(t => t?.ledger ? [t.ledger] : []))]
      .flatMap(file => readJsonl<ComparisonLine>(lifeosPath("MEMORY", "OBSERVABILITY", file)));
    const sources: ReportSources = caller === REVIEW_DEFECT_CALLER && reviewer ? { reviewDefect: reviewer.defectAgreementLines() } : {};
    console.log(buildCallerReport(caller, shadow, cfg, dispatches, since, comparisons, sources) + reviewerBlock);
    return 0;
  }
  if (cmd === "tune") {
    const caller = arg("--caller", argv) ?? "guard";
    const days = Number(arg("--days", argv) ?? 7);
    const step = Number(arg("--step", argv) ?? 0.01);
    const json = argv.includes("--json");
    const cfg = safeCallerConfig(caller);
    if (!cfg) {
      const output = { caller, days, questions: [] as unknown[] };
      if (json) console.log(JSON.stringify(output));
      else console.log(`Caller "${caller}" is not registered in assay-callers.json — no tuning data.`);
      return 0;
    }
    const since = Date.now() - days * 86_400_000;
    const shadow = readShadowHistory();
    const window = shadow.filter((row) => row.caller === caller && Date.parse(row.ts) >= since);
    const comparisons = [...new Set(Object.values(cfg.ground_truth).flatMap((truth) => truth?.ledger ? [truth.ledger] : []))]
      .flatMap((file) => readJsonl<ComparisonLine>(lifeosPath("MEMORY", "OBSERVABILITY", file)));
    const questions: Array<{ question: string; model: string; rows: number; unmatched: number; separation: Separation; registered: number | null; registered_rate: number | null; registered_balanced: number | null; registered_recall: number | null; registered_fn: number | null; registered_fp: number | null; recommended: number | null; recommended_rate: number | null; recommended_balanced: number | null; recommended_recall: number | null; recommended_fn: number | null; recommended_fp: number | null; recall: number | null; fn: number | null; fp: number | null; recall_floor: number | null; recall_floor_recall: number | null; recall_floor_fn: number | null; recall_floor_fp: number | null; enforce_bar: number | null; clears: boolean; blocked_by: string[]; points: SweepPoint[] }> = [];
    for (const [question, truth] of Object.entries(cfg.ground_truth)) {
      if (cfg.corrective[question] || !truth?.ledger) continue;
      const matched = joinGroundTruth(caller, question, window, comparisons, since);
      const comparisonRows = comparisonRowsInWindow(caller, question, comparisons, since);
      const unmatched = comparisonRows.filter((row) => !hasMatchingShadow(row, question, window)).length;
      for (const model of new Set(matched.map((row) => row.model))) {
        const modelRows = matched.filter((row) => row.model === model);
        const points = sweepThresholds(modelRows, step);
        const registered = cfg.thresholds[question]?.value ?? null;
        const registeredPoint = registered === null ? null : scoreThreshold(modelRows, registered);
        // Balanced accuracy, never raw agreement: on a 1%-positive ledger the never-fire
        // point scores 99% and would be "recommended" by agreement alone (ISC-28).
        const recommended = recommendBalanced(points);
        const recommendedPoint = recommended === null ? null : points.find((point) => point.threshold === recommended) ?? null;
        const recallFloor = recommendRecallFloor(points);
        const recallFloorPoint = recallFloor === null ? null : points.find((point) => point.threshold === recallFloor) ?? null;
        const enforceBar = cfg.enforce_bar ?? null;
        const sep = separation(modelRows);
        const recommendedBalanced = recommendedPoint === null ? null : balancedAccuracy(recommendedPoint);
        const recall = (point: SweepPoint | null) => point === null || point.tp + point.fn === 0 ? null : point.tp / (point.tp + point.fn);
        const blockedBy = tuneBlockedBy(enforceBar, Number.isFinite(recommendedBalanced as number) ? recommendedBalanced : null, sep, modelRows.length, model, cfg.thresholds[question]?.model);
        questions.push({
          question, model, rows: modelRows.length, unmatched, separation: sep,
          registered, registered_rate: registeredPoint?.rate ?? null,
          registered_balanced: registeredPoint === null ? null : balancedAccuracy(registeredPoint),
          registered_recall: recall(registeredPoint), registered_fn: registeredPoint?.fn ?? null, registered_fp: registeredPoint?.fp ?? null,
          recommended, recommended_rate: recommendedPoint?.rate ?? null,
          recommended_balanced: Number.isFinite(recommendedBalanced as number) ? recommendedBalanced : null,
          recommended_recall: recall(recommendedPoint), recommended_fn: recommendedPoint?.fn ?? null, recommended_fp: recommendedPoint?.fp ?? null,
          recall: recall(recommendedPoint), fn: recommendedPoint?.fn ?? null, fp: recommendedPoint?.fp ?? null,
          recall_floor: recallFloor, recall_floor_recall: recall(recallFloorPoint), recall_floor_fn: recallFloorPoint?.fn ?? null, recall_floor_fp: recallFloorPoint?.fp ?? null,
          enforce_bar: enforceBar,
          clears: blockedBy.length === 0,
          blocked_by: blockedBy,
          points,
        });
      }
    }
    if (json) {
      console.log(JSON.stringify({ caller, days, questions }));
      return 0;
    }
    for (const result of questions) {
      const sep = result.separation;
      console.log(`caller=${caller} question=${result.question} model=${result.model} matched rows=${result.rows}`);
      console.log(`  unmatched=${result.unmatched} of ${comparisonRowsInWindow(caller, result.question, comparisons, since).length} comparison rows in window`);
      console.log(`  positives=${sep.positives} negatives=${sep.negatives} base rate=${sep.base_rate === null ? "n/a" : `${(sep.base_rate * 100).toFixed(1)}%`}`);
      console.log(`  separation AUC=${sep.auc === null ? "n/a" : sep.auc.toFixed(3)} → ${sep.verdict.toUpperCase()}`);
      if (sep.verdict === "no-positives" || sep.verdict === "no-negatives") console.log(`  ${sep.verdict === "no-positives" ? "no positive" : "no negative"} examples in this window — nothing here can be calibrated`);
      else if (sep.verdict === "no-signal") console.log(`  probabilities do not rank positives above negatives (AUC ${sep.auc!.toFixed(3)}); no monotone threshold separates them here`);
      else if (sep.positives < 30) console.log(`  only ${sep.positives} positives — every number below is noise until that grows`);
      for (const point of sweepThresholds(
        joinGroundTruth(caller, result.question, window, comparisons, since).filter((row) => row.model === result.model),
        0.05,
      ))
        console.log(`  ${point.threshold.toFixed(2)}  rows=${point.rows}  agree=${point.agree}  ${(point.rate * 100).toFixed(1)}%`);
      const pct = (v: number | null) => v === null || !Number.isFinite(v) ? "n/a" : `${(v * 100).toFixed(1)}%`;
      console.log(`  registered threshold=${result.registered === null ? "n/a" : result.registered.toFixed(2)} agreement=${pct(result.registered_rate)} balanced=${pct(result.registered_balanced)} recall=${pct(result.registered_recall)} fn=${result.registered_fn ?? "n/a"} fp=${result.registered_fp ?? "n/a"}`);
      console.log(`  recommended threshold=${result.recommended === null ? "n/a" : result.recommended.toFixed(2)} agreement=${pct(result.recommended_rate)} balanced=${pct(result.recommended_balanced)} recall=${pct(result.recommended_recall)} fn=${result.recommended_fn ?? "n/a"} fp=${result.recommended_fp ?? "n/a"}`);
      if (result.recall_floor === null) console.log("  recall-floor threshold=n/a — no sampled threshold catches every positive");
      else console.log(`  recall-floor threshold=${result.recall_floor.toFixed(2)} recall=${pct(result.recall_floor_recall)} fp=${result.recall_floor_fp} (${sep.negatives ? ((result.recall_floor_fp! / sep.negatives) * 100).toFixed(1) : "n/a"}% of negatives)`);
      if (result.enforce_bar !== null) console.log(`  enforce bar ${(result.enforce_bar * 100).toFixed(1)}% on balanced accuracy: ${result.clears ? "clears" : "does not clear"}; blocked_by=${result.blocked_by.length ? result.blocked_by.join("; ") : "none"}`);
    }
    return 0;
  }
  if (cmd === "alerts") {
    let callers: CallersConfig = {};
    try {
      callers = loadCallers();
      if (Object.keys(callers).length === 0) console.error("[Assay] caller registry empty or unreadable; alerts use default floors");
    } catch (e) { console.error(`[Assay] caller registry invalid; alerts use default floors: ${(e as Error)?.message ?? e}`); }
    const alerts = outageAlerts(readShadowHistory(), callers);
    for (const alert of alerts) console.log(formatAlert(alert));
    return alerts.length > 0 ? 1 : 0;
  }
  if (cmd === "drift") {
    const callersPath = defaultCallersPath();
    const logPath = defaultLogPath();
    // The check itself reverts and persists (ISC-37); the CLI only reports what it did.
    const reverts = checkModelDrift(callersPath);
    const reverted = new Map(reverts.map((r) => [r.caller, r]));
    const callers = loadCallers(callersPath);
    const shadow = readShadowHistory();
    const latestModelByCaller = new Map<string, string>();
    for (const line of shadow) {
      if (line && typeof line.model_versioned === "string" && line.model_versioned) latestModelByCaller.set(line.caller, line.model_versioned);
    }
    for (const [name, cfg] of Object.entries(callers)) {
      const latest = latestModelByCaller.get(name) ?? "none";
      const r = reverted.get(name);
      const evidence = r ? r.from : cfg.mode === "enforce" && cfg.enforce_evidence ? cfg.enforce_evidence.model : "none";
      const status = r ? `reverted to shadow (${r.from} → ${r.to})` : "unchanged";
      console.log(`${name}: ${cfg.mode} · evidence model ${evidence} · latest seen ${latest} · ${status}`);
    }
    return 0;
  }
  if (cmd === "callers") {
    const checkDocs = argv.includes("--check-docs");
    const callersPath = defaultCallersPath();
    const logPath = defaultLogPath();
    const callers = loadCallers(callersPath);
    if (!checkDocs) {
      const shadow = readShadowHistory();
      const callerSet = new Set<string>();
      for (const line of shadow) {
        if (line?.caller) callerSet.add(line.caller);
      }
      for (const name of Object.keys(callers).sort()) {
        const cfg = callers[name];
        const corrective = Object.values(cfg.corrective).some(Boolean) ? "corrective questions" : "standard";
        const groundTruth = Object.values(cfg.ground_truth).some(Boolean) ? "yes" : "no";
        const budget = `${cfg.budget.calls_per_day}c/${cfg.budget.tokens_per_day}t`;
        console.log(`${name}: ${cfg.mode} · ${corrective} · ${budget} · ground-truth: ${groundTruth}`);
      }
      for (const name of [...callerSet].sort()) {
        if (!callers[name]) console.log(`${name}: (log only, not in registry)`);
      }
      return 0;
    }
    const docsPath = lifeosPath("DOCUMENTATION", "Router", "RouterSystem.md");
    let docsText = "";
    try {
      docsText = readFileSync(docsPath, "utf8");
    } catch {
      console.error(`cannot read ${docsPath}`);
      return 1;
    }
    const tableStart = docsText.indexOf("### Data class per caller");
    if (tableStart === -1) {
      console.error("cannot find '### Data class per caller' table in RouterSystem.md");
      return 1;
    }
    const tableSection = docsText.slice(tableStart);
    const tableEnd = tableSection.indexOf("\n## ");
    const tableText = tableEnd > 0 ? tableSection.slice(0, tableEnd) : tableSection;
    const docCallerSet = new Set<string>();
    const backtickRe = /`([^`]+)`/g;
    for (const match of tableText.matchAll(backtickRe)) {
      const token = match[1];
      if (token && /^[\w-]+$/.test(token)) docCallerSet.add(token);
    }
    const inRegistry = new Set(Object.keys(callers));
    const inLog = new Set<string>();
    for (const line of readShadowHistory()) {
      if (line?.caller) inLog.add(line.caller);
    }
    const inRegistryOrLog = new Set([...inRegistry, ...inLog]);
    const missing: string[] = [];
    for (const caller of [...inRegistryOrLog].sort()) {
      if (!docCallerSet.has(caller)) missing.push(caller);
    }
    if (missing.length > 0) {
      for (const caller of missing) console.log(`MISSING DOC ROW: ${caller}`);
      return 1;
    }
    console.log(`docs: ${docCallerSet.size} callers, all present`);
    return 0;
  }
  console.error(`unknown command: ${cmd}`);
  return 1;
}

if (import.meta.main) {
  main(process.argv.slice(2)).then((code) => process.exit(code)).catch((e) => {
    console.error(e instanceof EngineError ? `${e.name} (${e.kind}): ${e.message}` : String(e));
    process.exit(1);
  });
}
