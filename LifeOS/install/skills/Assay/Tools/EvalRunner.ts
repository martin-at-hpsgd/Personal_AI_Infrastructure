#!/usr/bin/env bun
/**
 * EvalRunner — assertion-first suite runner (v2). Canonical replacement for the
 * old grader-stack AlgorithmBridge path.
 *
 * Uses Assay's judgment layer (engine: Clef-omni) — see LIFEOS/DOCUMENTATION/Assay/AssaySystem.md.
 * Judged assertions ask the judgment layer first and skip the model judge only when its answer may act.
 *
 * A CASE is `{id, prompt, assert:[...]}`. The agent-under-test runs the prompt
 * with the LIVE system prompt + DA identity as its system (so a config edit that
 * shifts dispositions shows up), producing real output. Each assertion is graded
 * deterministically (Assertions.ts) or by the model judge (Judge.ts). Cases run
 * `trials` times; we report pass^k (all trials pass — the honest metric for a
 * reliability-critical agent) alongside pass@k. Subscription-billed via Inference.ts.
 *
 * Suite resolution order: USER customizations first (identity-bound suites live
 * outside the public skill), then the skill's own generic Suites/.
 *
 * Anthropic doctrine encoded: grade the OUTPUT not the path; capability vs
 * regression; partial credit via weighted asserts; balanced should-do/should-not
 * via `not-*` and negative cases. Read transcripts — every run persists them.
 */

import { readFileSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';
import { assayUserDir } from '../../../LIFEOS/TOOLS/Paths.ts';
import { homedir } from 'node:os';
import { parse as parseYaml } from 'yaml';
import { parseArgs } from 'node:util';
import { evaluateDeterministic, isModelAssert, type Assertion, type AssertResult } from './Assertions.ts';
import { judgeAssertion, assertionQuestion, type JudgeOptions } from './Judge.ts';
import { validateSuite } from './SuiteManager.ts';
import { summarize, type Summary } from './Stats.ts';
import { judgeLevelForModel } from './JudgeLevel.ts';
import { inference, type InferenceLevel } from '../../../LIFEOS/TOOLS/Inference.ts';
import { evalSubject, evalJudgeVendor, servedMatches } from '../../../LIFEOS/ROUTER/EvalRoute.ts';
import { attachJudgeAgreement, calibrationStatus, provisionalOf, type Provisional } from '../../../LIFEOS/TOOLS/lib/Calibration.ts';
import { safeCallerConfig, judgeMany, type ManyItem } from '../../../LIFEOS/ASSAY/Assay.ts';
import { captureEvidence, type EvidenceBinding } from './EvalState.ts';
import { invariant } from '../../../LIFEOS/TOOLS/Invariant.ts';
import { tasteFor, withTasteValue } from '../../../LIFEOS/TOOLS/lib/CalibrateTaste.ts';
import { isJudgedAssert } from './Assertions.ts';
import { ASSAY_RECEIPT_SCHEMA, deriveVerdict, sha256File, writeReceipt, type AssayReceipt, type IdealStateRef, type ProofFinding } from '../../../LIFEOS/TOOLS/lib/ProofReceipt.ts';
import { assertEvaluatorVendor } from '../../../LIFEOS/TOOLS/lib/EvaluatorEgress.ts';
import { intentIdealState, intentNames, loadIntent } from './IntentRubric.ts';

const CLAUDE_ROOT = join(homedir(), '.claude');
const RESULTS_DIR = join(CLAUDE_ROOT, 'LIFEOS', 'MEMORY', 'STATE', 'Evals-Results');
export const USER_SUITES = join(assayUserDir(join(CLAUDE_ROOT, 'LIFEOS')), 'Suites');
export const SKILL_SUITES = join(import.meta.dir, '..', 'Suites');

export interface EvalCase {
  id: string;
  prompt: string;
  assert: Assertion[];
  threshold?: number;
  negative?: boolean; // documents a should-NOT case (balance); no behavior change
  /** ISC-38: a canned output that passes every deterministic assert on this case and only the judge can catch. The runner grades it every run; a judge that passes it is not load-bearing and the suite fails. */
  adversarial_output?: string;
}

export interface EvalSuiteV2 {
  /** These receipts must come from an actual harness adapter, never single-shot inference. */
  requires_context?: string[];
  name: string;
  type?: 'capability' | 'regression';
  pass_threshold?: number;
  agent_level?: InferenceLevel;
  judge_level?: InferenceLevel;
  judge_model?: string; // tier alias or model id; resolved via JudgeLevel.ts (capped at 'high'). Wins over judge_level.
  trials?: number;
  subject_timeout_ms?: number; // per-answer timeout for the model under test (default 90000); a large system prompt (a long intent) needs more
  system_prompt?: string; // override; default = live system prompt + DA identity
  system_prompt_file?: string; // REPLACES the system prompt with this file's content (~ ok; relative to the suite file). For skill suites: point at the SKILL.md.
  append_to_base?: boolean; // with system_prompt_file: append to the live base prompt instead of replacing — for suites judging identity-bound properties (voice) where the skill alone would fail for the wrong reason.
  /** Calibrate target whose Taste.json the judged asserts read. Defaults to the suite name; `none` opts out. */
  calibration?: string;
  cases: EvalCase[];
}

/** Appends the principal's calibrated taste (Calibrate skill) to every string-valued judged assert. No profile, no change. */
export function applyCalibrationTaste<T extends { name: string; calibration?: string; cases?: EvalCase[] }>(suite: T): T {
  const taste = suite.calibration === 'none' ? null : tasteFor(suite.calibration ?? suite.name);
  if (!taste || !Array.isArray(suite.cases)) return suite;
  return { ...suite, cases: suite.cases.map(c => ({ ...c, assert: (c.assert ?? []).map(a => isJudgedAssert(a.type) && typeof a.value === 'string' ? { ...a, value: withTasteValue(a.value, taste) } : a) })) };
}

/**
 * Calibrated-cheap-judge default (Anthropic ships haiku as its plugin-eval
 * judge default; docs require model graders be calibrated against human
 * grading). A suite whose judge has an EARNED calibration record — agreement,
 * kappa, per-rung counts, and nothing stale (judge chain, rubric, labels), the
 * one rule in LIFEOS/TOOLS/lib/Calibration.ts — gets the cheap judge; without
 * one the judge stays 'high'. Explicit judge_model / judge_level always wins.
 * The calibration dir is resolved per call (LIFEOS_CALIBRATION_DIR in tests).
 */
export function defaultJudgeLevel(suiteName: string, dir?: string, suiteDirs?: string[]): { level: InferenceLevel; calibrated: boolean; reason: string } {
  const s = calibrationStatus(suiteName, { dir, suiteDirs });
  return { level: s.level, calibrated: s.calibrated, reason: s.reason };
}

/**
 * The provisional marker (ISC-19.1/44.1): a suite with judged asserts whose
 * judge has no earned calibration is provisional, and says so with the age in
 * days since its oldest persisted run. Pure over its dirs; the runner calls it
 * after the trials, tests call it on fixtures.
 */
export function provisionalReport(suiteName: string, judgedAsserts: number, opts: { calibrationDir?: string; resultsDir?: string; now?: number; suiteDirs?: string[] } = {}): Provisional {
  const status = calibrationStatus(suiteName, { dir: opts.calibrationDir, suiteDirs: opts.suiteDirs });
  return provisionalOf(suiteName, judgedAsserts, { status, dir: opts.calibrationDir, resultsDir: opts.resultsDir, now: opts.now });
}

/** Provenance accompanies calibrated results; assistant agreement is not human validation. */
export function calibrationProvenance(suiteName: string, eligible: boolean, suiteDirs?: string[]): { label_basis: 'principal' | 'assistant' | 'mixed' | 'unspecified'; human_validated: boolean } {
  const status = calibrationStatus(suiteName, { suiteDirs });
  return { label_basis: status.record?.label_basis ?? 'unspecified', human_validated: eligible && status.calibrated && status.record?.human_validated === true };
}

/** Recorded in every EvalRunner receipt's evaluators. */
export const EVAL_RUNNER_VERSION = '2.0.0';

const HEX64_RE = /^[0-9a-f]{64}$/;

/**
 * What the suite was measured against: the ISA its judged asserts derive from (`derived_from: <isa-path>#<criterion>`),
 * with the criterion ids it ran. No derivation to an existing ISA reads as { kind: "none" }, with the reason.
 */
export function suiteIdealState(suite: Pick<EvalSuiteV2, 'cases'>): IdealStateRef {
  const byPath = new Map<string, Set<string>>();
  const byIntent = new Map<string, Set<string>>();
  for (const c of suite.cases ?? []) {
    for (const a of c.assert ?? []) {
      const d = (a as Assertion & { derived_from?: string }).derived_from;
      if (!d) continue;
      const [rawPath, ...frag] = d.split('#');
      const p = rawPath.replace(/^~\//, `${homedir()}/`);
      const abs = isAbsolute(p) ? p : resolve(CLAUDE_ROOT, p);
      // An ISA, or a skill intent (IntentRubric lineage: <intent path>#IS-n | #AC-n). An ISA wins when both appear.
      const target = /ISA\.md$/.test(abs) ? byPath : intentNames(abs) ? byIntent : null;
      if (!target || !existsSync(abs)) continue;
      const set = target.get(abs) ?? new Set<string>();
      const id = frag.join('#').trim();
      if (id) set.add(id);
      target.set(abs, set);
    }
  }
  const most = (m: Map<string, Set<string>>) => [...m.entries()].sort((a, b) => b[1].size - a[1].size)[0];
  const best = most(byPath);
  if (best) {
    const [path, ids] = best;
    return { kind: 'isa', path, revision: createHash('sha256').update(readFileSync(path)).digest('hex'), ...(ids.size ? { criteria: [...ids].sort() } : {}) };
  }
  const intent = most(byIntent);
  if (!intent) return { kind: 'none', reason: 'the suite declares no derived_from to an existing ISA or skill intent' };
  const ref = intentIdealState(loadIntent(intent[0]));
  return { ...ref, ...(intent[1].size ? { criteria: [...intent[1]].sort() } : {}) };
}

/**
 * The run as an assay-receipt/1 (ISC-1), bound to the sha256 of the run's result file (run.json). A deterministic assert
 * that failed or a pass^k/mean below the suite threshold is a code-tier fail. A judged assert that failed is a judge-tier
 * fail only when the suite's judge is calibrated and the run is not provisional; otherwise it is a flag. No verdict
 * (the evaluator was unavailable) is an unavailable finding, never a pass. The suite's own pass/fail is unchanged by this.
 */
export function buildEvalReceipt(result: SuiteResult, detail: CaseResult[], runFile: string, ideal: IdealStateRef): AssayReceipt {
  const earned = result.judge_calibrated === true && result.provisional !== true;
  const findings: ProofFinding[] = [];
  let passedCases = 0;
  if (result.verifier_unavailable) {
    findings.push({ check: 'eval:verifier', tier: 'judge', severity: 'unavailable', message: result.summary.slice(0, 300) });
  } else {
    for (const c of detail) {
      if (c.pass_to_k === 1 || (c.trials.length > 0 && c.trials.every((t) => t.passed))) passedCases++;
      const seen = new Set<string>();
      for (const t of c.trials) {
        if (t.error !== undefined) continue;
        for (const a of t.asserts) {
          if (a.passed || a.skipped) continue;
          const judged = isModelAssert(a.type);
          const key = `${judged ? 'judge' : 'code'}:${a.type}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const message = `case ${c.id}: ${a.type} failed — ${String(a.reason ?? '').replace(/\s+/g, ' ').slice(0, 200)}`;
          if (!judged) findings.push({ check: `eval:${c.id}:${a.type}`, tier: 'code', severity: 'fail', message });
          else findings.push({ check: `eval:${c.id}:${a.type}`, tier: 'judge', severity: earned ? 'fail' : 'flag', earned, message, ...(a.derived_from ? { derived_from: a.derived_from } : {}) });
        }
      }
    }
    const missed = result.adversarial?.missed ?? [];
    for (const id of missed) findings.push({ check: `eval:adversarial:${id}`, tier: 'judge', severity: 'flag', earned: false, message: `the judge passed the adversarial fixture for case ${id}; it is not load-bearing there` });
    // A shortfall no finding explains (weights, partial credit) is a deterministic threshold miss. A failure the unearned judge explains stays a flag.
    if (!result.passed && findings.length === 0) findings.push({ check: 'eval:threshold', tier: 'code', severity: 'fail', message: result.summary.slice(0, 300) });
  }
  const { verdict, counts } = deriveVerdict(findings, passedCases, ASSAY_RECEIPT_SCHEMA);
  const st = statSync(runFile);
  const ran_at = result.ts ?? new Date().toISOString();
  const evaluators: Record<string, string> = { eval_runner: EVAL_RUNNER_VERSION };
  if (result.agent_model) evaluators.subject = result.agent_model;
  if (result.judge_level) evaluators.judge = `${result.judge_level}${result.judge_calibrated ? ' (calibrated)' : ''}`;
  if (result.jev_model_versioned) evaluators.glance = result.jev_model_versioned;
  for (const m of new Set(detail.flatMap((c) => c.trials.map((t) => t.model).filter((m): m is string => !!m)))) evaluators[`served:${m}`] = 'trial';
  const checkSet = createHash('sha256').update(JSON.stringify({ suite: result.suite, cases: result.cases.map((c) => c.id), type: result.type })).digest('hex');
  return {
    schema: ASSAY_RECEIPT_SCHEMA, artifact: resolve(runFile), sha256: '', size: st.size, mtimeMs: st.mtimeMs, kind: 'text',
    ran_at, run_id: randomUUID(), duration_ms: result.duration_ms ?? 0, checks_file: null, profile: [`eval:${result.suite}`],
    verdict, counts, findings, opt_outs: [],
    ideal_state: ideal, check_set: { version: checkSet, source: null }, evaluators, destination: 'none',
    verdict_at_boundary: { verdict, counts, findings: findings.length, at: ran_at },
  };
}

/** Write the run's receipt. Under `bun test` the default store is never touched unless a store is named (LIFEOS_PROOF_RECEIPTS). Never throws: a receipt is a record, not the verdict. */
export async function writeEvalReceipt(result: SuiteResult, detail: CaseResult[], runFile: string, suite: Pick<EvalSuiteV2, 'cases'> | undefined): Promise<{ receipt?: string; receiptError?: string }> {
  if (process.env.NODE_ENV === 'test' && !process.env.LIFEOS_PROOF_RECEIPTS) return {};
  try {
    const r = buildEvalReceipt(result, detail, runFile, suite ? suiteIdealState(suite) : { kind: 'none', reason: 'no suite definition available' });
    r.sha256 = await sha256File(runFile);
    invariant(HEX64_RE.test(r.sha256), 'eval receipt sha256 must be a hex digest');
    return { receipt: writeReceipt(r) };
  } catch (e) {
    const receiptError = e instanceof Error ? e.message : String(e);
    console.error(`(eval receipt not written: ${receiptError})`);
    return { receiptError };
  }
}

export interface CaseResult {
  adversarial_asserts?: AssertResult[];
  id: string;
  mean_score: number;
  pass_at_k: number;
  pass_to_k: number;
  /** Trials whose inference call failed (timeout, refusal, envelope error). Not model failures. */
  infra_errors: number;
  trials: { score: number; passed: boolean; asserts: AssertResult[]; output: string; error?: string; model?: string; harness?: unknown }[];
}

export interface SuiteResult {
  /** Judgment-layer split. These stored keys keep the name of the engine retired 2026-10-10: run.json and latest.json persist them. */
  resolved_by_jev: number;
  escalated_to_judge: number;
  judge_calls_avoided: number;
  jev_samples: number;
  jev_agreement: number | null;
  jev_model_versioned: string | null;
  evidence?: EvidenceBinding;
  /** The assay-receipt/1 written for this run (ISC-1), when one was written. */
  receipt?: string;
  suite: string;
  type: string;
  passed: boolean;
  score: number; // suite mean
  pass_to_k: number; // headline: mean per-case pass^k
  pass_at_k: number;
  summary: string;
  run_id: string;
  /** Trials or adversarial checks with no evaluator verdict. Excluded from every denominator. */
  infra_errors: number;
  /** Any unavailable evaluator makes this run no-verdict.
   * Exit code 2; latest.json retains its valid verdict; EvalState reports the unavailable attempt. */
  verifier_unavailable: boolean;
  cases: { id: string; mean_score: number; pass_to_k: number; pass_at_k: number; infra_errors: number }[];
  /** Never a bare mean (Anthropic statistical doctrine): SEM + 95% CI over per-case means. */
  stats?: Summary;
  /** Judge-shrinkage metric: fraction of the suite's assertions that are model-graded.
   * The doctrine goal is for this number to FALL over time as judged claims are
   * mined into deterministic asserts. */
  judged_residue?: number;
  agent_level?: InferenceLevel;
  /** The model under test as the router resolved it: the carrier id, or `<helper vendor>:<level>` for a suite that pins agent_level. */
  agent_model?: string;
  judge_level?: InferenceLevel | 'vision'; // 'vision' = image lane (VisionJudge)
  judge_calibrated?: boolean;
  label_basis?: 'principal' | 'assistant' | 'mixed' | 'unspecified';
  human_validated?: boolean;
  /** ISC-19.1: judged asserts with no earned calibration record. The suite still runs and scores; every surface says so. */
  provisional?: boolean;
  /** ISC-44.1: days since the suite's oldest persisted run — how long the provisional verdicts have accumulated. */
  provisional_age_days?: number | null;
  provisional_reason?: string;
  /** ISC-38: adversarial fixtures graded this run and how many the judge caught. cases > caught fails the suite. */
  adversarial?: { cases: number; caught: number; missed: string[] };
  duration_ms?: number;
  ts?: string;
}

export const EMPTY_GLANCE_STATS = { resolved_by_jev: 0, escalated_to_judge: 0, judge_calls_avoided: 0,
  jev_samples: 0, jev_agreement: null as number | null, jev_model_versioned: null as string | null };

/** Text report uses the same registry bar as the caller's enforcement evidence. */
/** Report on the judgment layer's (engine: Clef-omni) results from a suite run. */
export function glanceReportLines(result: SuiteResult, callersPath?: string): string[] {
  const total = result.resolved_by_jev + result.escalated_to_judge;
  if (!total && !result.jev_samples) return [];
  const bar = safeCallerConfig('eval-judge', callersPath)?.enforce_bar;
  const warning = result.jev_agreement !== null && bar !== undefined && result.jev_agreement < bar
    ? ` — WARNING: below ${bar * 100}% bar` : '';
  return [
    `   Judgment layer: resolved-by-glance ${result.resolved_by_jev}/${total} · escalated ${result.escalated_to_judge} · judge calls avoided ${result.judge_calls_avoided}`,
    `   Judgment layer calibration: agreement ${result.jev_agreement === null ? 'n/a' : `${(result.jev_agreement * 100).toFixed(1)}%`} over ${result.jev_samples} samples${warning}`,
  ];
}

/** Injectable dependencies keep unavailable-verifier semantics testable without paid inference. */
export interface EvalRunDeps {
  invoke?: typeof inference;
  /** Void trials whose served model is not the requested tier. Default: on for the real inference path, off for an injected invoker. */
  assertServedModel?: boolean;
  judge?: typeof judgeAssertion;
  resultsDir?: string;
  judgeMany?: typeof judgeMany;
  judgeOptions?: JudgeOptions;
}

/** Run work in input order without allowing a suite to fan out unbounded inference calls. */
export async function boundedPool<T, R>(items: T[], concurrency: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

export function buildLiveSystemPrompt(): string {
  const sources = [
    join(CLAUDE_ROOT, 'LIFEOS', 'LIFEOS_SYSTEM_PROMPT.md'),
    join(CLAUDE_ROOT, 'LIFEOS', 'USER', 'DIGITAL_ASSISTANT', 'DA_IDENTITY.md'),
  ];
  const parts = sources.filter(existsSync).map((f) => readFileSync(f, 'utf-8'));
  return parts.length ? parts.join('\n\n---\n\n') : 'You are a precise assistant. Verify before claiming done; be concise.';
}

export function resolveSuite(name: string): string | null {
  for (const dir of [USER_SUITES, SKILL_SUITES]) {
    // ported from a community contribution — `.yml` is as valid a YAML suffix as
    // `.yaml`, tried second so an existing `.yaml` keeps winning if both exist.
    for (const ext of ['yaml', 'yml']) {
      for (const p of [join(dir, `${name}.${ext}`), join(dir, 'Regression', `${name}.${ext}`), join(dir, 'Capability', `${name}.${ext}`)]) {
        if (existsSync(p)) return p;
      }
    }
  }
  return null;
}

/** Coalesce ready outputs into one bounded Glance pool. Each output owns its question map. */
export function pooledJudgeOptions(options: JudgeOptions = {}, many: typeof judgeMany = judgeMany, manual = false) {
  let pending: Array<{ output: string; questions: NonNullable<ManyItem["questions"]>; key?: string; resolve: (r: JudgeOptions) => void }> = [];
  const flush = async () => {
    const batch = pending; pending = [];
    if (!batch.length) return;
    try {
      const rows = await many(batch.map((b, i) => ({ key: b.key ?? String(i), state: b.output, questions: b.questions,
        questionJoins: Object.fromEntries(Object.entries(b.questions).map(([id, q]) => [id, {
          question: q.type === "noul" ? "noul" : "rubric", turn: `${b.key ?? i}:${id}`,
        }])),
      })), {}, {
        caller: "eval-judge", session: options.session, callersPath: options.glanceCallersPath, logPath: options.glanceLogPath, retries: 0,
      });
      batch.forEach((b, i) => {
        const row = rows[i];
        b.resolve({ ...options, prepared: row?.result ? {
          answers: Object.fromEntries(Object.entries(row.result).map(([id, r]) => [id, r.answer])),
          model: Object.values(row.result)[0]?.model ?? "unknown", latency_ms: 0,
        } : new Error(row?.error ?? "Glance pool returned no result") });
      });
    } catch (error) { for (const b of batch) b.resolve({ ...options, prepared: error instanceof Error ? error : new Error(String(error)) }); }
  };
  const enqueue = (output: string, questions: NonNullable<ManyItem["questions"]>, key?: string): Promise<JudgeOptions> => new Promise(resolve => {
    pending.push({ output, questions, key, resolve });
    if (!manual && pending.length === 1) queueMicrotask(flush);
  });
  return Object.assign(enqueue, { flush });
}

/** Every assert on one output. Judged asserts ride `judge` (Judge.ts by default; injectable for tests); the result keeps the assert's `derived_from` lineage, and run.json persists it (ISC-17.2). */
export async function applyAsserts(output: string, asserts: Assertion[], judgeLevel: InferenceLevel, judge: typeof judgeAssertion = judgeAssertion, session?: string, pool: (output: string, questions: NonNullable<ManyItem["questions"]>, key?: string) => Promise<JudgeOptions> = pooledJudgeOptions({ session }), caseKey?: string): Promise<AssertResult[]> {
  // Evaluate prerequisites on the same immutable output before any model call,
  // while retaining declaration order in persisted results.
  const out: AssertResult[] = new Array(asserts.length);
  const record = (a: Assertion, r: AssertResult): AssertResult => ({
    ...r,
    required: a.required ?? !isModelAssert(a.type),
    ...(a.derived_from ? { derived_from: a.derived_from } : {}),
  });
  for (const [i, a] of asserts.entries()) {
    if (!isModelAssert(a.type)) out[i] = record(a, evaluateDeterministic(output, a));
  }
  const blocked = out.some((r) => r?.required && !r.passed);
  const questions: NonNullable<ManyItem["questions"]> = {};
  if (!blocked && judge === judgeAssertion) {
    for (const [i, a] of asserts.entries()) {
      if (!isModelAssert(a.type)) continue;
      try { questions[`assert_${i}`] = assertionQuestion(a); } catch { /* Unanchored rubrics go directly to the model judge. */ }
    }
  }
  const shared: NonNullable<ManyItem["questions"]> = {};
  const preparedByQuestion = new Map<string, Promise<JudgeOptions>>();
  for (const [id, question] of Object.entries(questions)) {
    const index = Number(id.slice("assert_".length));
    if ((asserts[index] as Assertion & { independent?: boolean } | undefined)?.independent) {
      preparedByQuestion.set(id, pool(output, { [id]: question }, caseKey === undefined ? undefined : `${caseKey}:${id}`));
    } else shared[id] = question;
  }
  if (Object.keys(shared).length) {
    const prepared = pool(output, shared, caseKey);
    for (const id of Object.keys(shared)) preparedByQuestion.set(id, prepared);
  }
  const preparedEntries = await Promise.all([...preparedByQuestion].map(async ([id, value]) => [id, await value] as const));
  const preparedById = new Map(preparedEntries);
  await Promise.all(asserts.map(async (a, i) => {
    if (!isModelAssert(a.type)) return;
    const questionId = `assert_${i}`;
    const prepared = preparedById.get(questionId) ?? {};
    const r = blocked
      ? { type: a.type, passed: false, score: 0, weight: a.weight ?? 1, skipped: true, reason: 'Skipped: required deterministic prerequisite failed' }
      : await judge(output, a, { ...prepared, ...(Object.hasOwn(questions, questionId) ? { questionId } : {}), level: judgeLevel, session });
    out[i] = record(a, r);
  }));
  return out;
}

function weighted(results: AssertResult[]): number {
  const tw = results.reduce((s, r) => s + r.weight, 0);
  return tw > 0 ? results.reduce((s, r) => s + r.score * r.weight, 0) / tw : 0;
}

/** Required failures cannot be bought off by weights or a permissive threshold. */
export function scoreAssertions(results: AssertResult[], threshold: number): { score: number; passed: boolean } {
  const blocked = results.some((r) => r.skipped || (r.required && !r.passed));
  const score = blocked ? 0 : weighted(results);
  return { score, passed: !blocked && score >= threshold };
}

export async function runSuite(name: string, override: Partial<EvalSuiteV2> = {}, deps: EvalRunDeps = {}): Promise<SuiteResult> {
  const evidence = Object.keys(override).length === 0 && !deps.invoke && !deps.judge && !deps.resultsDir ? captureEvidence(name) : undefined;
  const experiment = Object.keys(override).length > 0 || !!deps.invoke || !!deps.judge;
  const resultsDir = deps.resultsDir ?? (experiment ? join(RESULTS_DIR, 'experiments') : RESULTS_DIR);
  async function persist(result: SuiteResult, detail: CaseResult[] = []): Promise<SuiteResult> {
    invariant(/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name), 'suite result name must be a safe path component');
    invariant(!result.verifier_unavailable || !result.passed, 'unavailable evidence cannot pass');
    const dir = join(resultsDir, name);
    mkdirSync(join(dir, result.run_id), { recursive: true });
    const runFile = join(dir, result.run_id, 'run.json');
    writeFileSync(runFile, JSON.stringify({ ...result, detail }, null, 2));
    const rcpt = await writeEvalReceipt(result, detail, runFile, suite);
    if (rcpt.receipt) result.receipt = rcpt.receipt;
    if (!result.verifier_unavailable) writeFileSync(join(dir, 'latest.json'), JSON.stringify(result, null, 2));
    if (!deps.resultsDir && !experiment) {
      try { const { updateSkillStates } = await import('./EvalState.ts'); updateSkillStates(name); }
      catch (e) { console.error(`(EvalState update skipped: ${(e as Error).message})`); }
    }
    return result;
  }
  const path = resolveSuite(name);
  let suite: EvalSuiteV2;
  if (path) {
    suite = { ...(parseYaml(readFileSync(path, 'utf-8')) as EvalSuiteV2), ...override };
    // A qualified lookup (fixtures/name) persists under the declared safe suite name.
    if (name.includes('/')) name = suite.name;
  } else if (override.cases?.length) {
    // Inline/ephemeral suite (e.g. a drafted case dry-run) — no file needed.
    suite = { name, cases: [], ...override } as EvalSuiteV2;
  } else {
    return { ...EMPTY_GLANCE_STATS, suite: name, type: 'unknown', passed: false, score: 0, pass_to_k: 0, pass_at_k: 0, summary: `Suite not found: ${name}`, run_id: 'error', infra_errors: 0, verifier_unavailable: false, cases: [] };
  }
  suite = applyCalibrationTaste(suite);
  // ported from a community contribution
  // Diagnose a v1 suite instead of dying on `for (const c of undefined)`. The
  // a legacy v1 suite uses the `tasks:` list,
  // so running it threw a bare TypeError — and callers that catch broadly
  // (ConfigEvalOnChange) turned that into a regression eval which silently never
  // ran. The two formats are not mechanically convertible: UseCases/*.yaml
  // define weighted graders and carry no `prompt`, so there is nothing for this
  // single-shot runner to send. Say so rather than guess.
  //
  // Returned, not thrown (a community-reported bug): an unrunnable suite
  // is the same operational fact as a failing one, so it takes the same shape as
  // the "Suite not found" path above — passed:false, run_id:'error', a named
  // summary. Callers keep working unchanged; ConfigEvalOnChange still notifies,
  // and the CLI still exits 1.
  if (!Array.isArray(suite.cases) || suite.cases.length === 0) {
    const legacy = (suite as unknown as { tasks?: unknown[] }).tasks;
    const summary = Array.isArray(legacy)
      ? `Suite '${name}' is in the legacy v1 format: it lists ${legacy.length} \`tasks:\` referencing Evals/UseCases/*.yaml, which define graders and no \`prompt\`. This runner needs v2 \`cases:\` with prompt/assert. Run a v2 suite (e.g. core-dispositions), or run this one through a UseCase-aware runner.`
      : `Suite '${name}' has no \`cases:\` to run.`;
    return { ...EMPTY_GLANCE_STATS, suite: name, type: 'unknown', passed: false, score: 0, pass_to_k: 0, pass_at_k: 0, summary, run_id: 'error', infra_errors: 0, verifier_unavailable: false, cases: [] };
  }
  const validation = validateSuite(suite, 'text');
  if (!validation.ok) return { ...EMPTY_GLANCE_STATS, suite: name, type: suite.type ?? 'unknown', passed: false, score: 0, pass_to_k: 0, pass_at_k: 0, summary: `Invalid suite: ${validation.errors.join('; ')}`, run_id: 'error', infra_errors: 1, verifier_unavailable: true, cases: [] };
  if (suite.requires_context?.length && !deps.invoke) return persist({ ...EMPTY_GLANCE_STATS, suite: name, type: suite.type ?? 'unknown', passed: false, score: 0, pass_to_k: 0, pass_at_k: 0, summary: 'verifier unavailable — requires an actual harness adapter with context receipts', run_id: `run_${Date.now()}_preflight`, ts: new Date().toISOString(), infra_errors: 1, verifier_unavailable: true, cases: [] });
  const threshold = suite.pass_threshold ?? 0.75;
  const trials = suite.trials ?? 3;
  // The model under test comes from the router (LIFEOS/ROUTER/EvalRoute.ts): the carrier, the
  // model the DA runs on, on the anthropic vendor with no fallback (from 2026-09-15 the helper
  // default put every DA-dispositions trial on an OpenAI lane). A suite or Compare arm that
  // pins agent_level is testing a helper-lane job, so it rides the router's helper vendor.
  const carrier = suite.agent_level ? null : evalSubject();
  const agentLevel: InferenceLevel = suite.agent_level ?? 'high';
  const subjectRoute = carrier
    ? { vendor: carrier.vendor, allowVendorFallback: false, model: carrier.model }
    : { vendor: evalJudgeVendor() };
  // Judge resolution order: explicit judge_model (alias/id → level, capped at
  // 'high') > explicit judge_level > calibrated-cheap default.
  const calibDefault = defaultJudgeLevel(name);
  const judgeLevel: InferenceLevel = suite.judge_model
    ? judgeLevelForModel(suite.judge_model)
    : suite.judge_level ?? calibDefault.level;
  assertEvaluatorVendor(subjectRoute.vendor, 'eval-subject');
  assertEvaluatorVendor(evalJudgeVendor(), 'eval-judge');
  const judgeCalibrated = Object.keys(override).length === 0 && !suite.judge_model && calibDefault.calibrated && judgeLevel === calibDefault.level;
  if (suite.agent_level && judgeLevel === agentLevel) {
    console.log(`  ⚠️ judge_level equals agent_level ('${judgeLevel}') — Anthropic best practice is a distinct judge.`);
  }
  const startedAt = Date.now();
  // Eval-context suffix: the agent-under-test runs single-shot with NO tools.
  // Without this, the full agentic system prompt makes it narrate/simulate tool
  // calls and defer the answer, so the eval measures "reaches for tools" instead
  // of the target disposition. This keeps the task unambiguous (Anthropic Step 2)
  // while preserving verify discipline — it can still caveat what it would check.
  const EVAL_CONTEXT =
    '\n\n---\n[EVALUATION CONTEXT] You are being evaluated in a single-shot setting with NO tools available. ' +
    'Do not narrate or simulate tool calls. Give your best final answer directly, applying your normal judgment, ' +
    'voice, and verification discipline within the answer itself (e.g. state plainly when something would need checking).';
  let basePrompt = suite.system_prompt ?? buildLiveSystemPrompt();
  if (suite.system_prompt_file) {
    const raw = suite.system_prompt_file.replace(/^~\//, `${homedir()}/`);
    const resolved = raw.startsWith('/') ? raw : path ? join(path, '..', raw) : raw;
    if (!existsSync(resolved)) throw new Error(`suite ${suite.name}${path ? ` (${path})` : ''}: system_prompt_file ${suite.system_prompt_file} resolves to ${resolved}, which does not exist`);
    const fileContent = readFileSync(resolved, 'utf-8');
    // Replace by default (parallel to system_prompt); append_to_base opts into
    // base+file for suites judging identity-bound properties like voice.
    basePrompt = suite.append_to_base ? `${buildLiveSystemPrompt()}\n\n---\n\n${fileContent}` : fileContent;
  }
  const systemPrompt = basePrompt + EVAL_CONTEXT;
  const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const invoke = deps.invoke ?? inference;
  const judge = deps.judge ?? judgeAssertion;

  const caseResults: CaseResult[] = [];
  const adversarial = { cases: 0, caught: 0, missed: [] as string[] };
  let adversarialInfraErrors = 0;
  const pool = pooledJudgeOptions({ ...deps.judgeOptions, session: runId }, deps.judgeMany);
  const trialRuns: Array<Promise<Array<{ res: Awaited<ReturnType<typeof inference>>; asserts: AssertResult[] }>>> = [];
  // Barrier: finish every model run, enqueue every eligible output, then flush once per trial.
  const trialRun = (trial: number) => trialRuns[trial] ??= (async () => {
    const responses = await boundedPool(suite.cases, 8, c => invoke({ systemPrompt, userPrompt: c.prompt, level: agentLevel, ...subjectRoute, timeout: suite.subject_timeout_ms ?? 90_000 }));
    const trialPool = pooledJudgeOptions({ ...deps.judgeOptions, session: runId }, deps.judgeMany, true);
    const checks = responses.map((res, index) => {
      // Served-model assertion: a trial answered by a model other than the one requested
      // measures nothing about the subject, so it is voided, never scored. An injected invoker
      // (a harness adapter, a test) reports its own identity and is not checked here.
      if (carrier && res.success && (deps.assertServedModel ?? !deps.invoke) && !servedMatches(carrier.tier, res.executedModel)) {
        res.success = false; res.error = `served_model_mismatch: asked ${carrier.model}, served ${res.executedModel ?? 'unreported'}`;
      }
      if (res.success && suite.requires_context?.length) {
        const context = (res as unknown as { harness?: { context?: Record<string, string> } }).harness?.context;
        if (suite.requires_context.some(key => !/^[a-f0-9]{64}$/.test(context?.[key] ?? ''))) {
          res.success = false; res.error = 'required harness context receipts missing';
        }
      }
      const c = suite.cases[index];
      return res.success ? applyAsserts(res.output.trim(), c.assert, judgeLevel, judge, runId, trialPool, JSON.stringify([name, c.id, trial])) : Promise.resolve([]);
    });
    await trialPool.flush();
    const asserts = await Promise.all(checks);
    return responses.map((res, index) => ({ res, asserts: asserts[index] }));
  })();
  await Promise.all(suite.cases.map(async (c, caseIndex) => {
    const caseThreshold = c.threshold ?? threshold;
    let adversarialAsserts: AssertResult[] | undefined;
    if (typeof c.adversarial_output === 'string') {
      // Recheck prerequisites at execution time too: an inline or edited suite
      // may not have passed SuiteManager validation.
      adversarial.cases++;
      const checked = await applyAsserts(c.adversarial_output, c.assert, judgeLevel, judge, runId, pool, JSON.stringify([name, c.id, "adversarial"]));
      adversarialAsserts = checked;
      const judged = checked.filter((r) => isModelAssert(r.type));
      const unavailable = judged.some((r) => r.unavailable);
      if (unavailable) adversarialInfraErrors++;
      const caught = !unavailable && checked.filter((r) => !isModelAssert(r.type)).every((r) => r.passed)
        && judged.some((r) => !r.skipped && !r.passed && !/^unknown:/i.test(r.reason.trim()));
      if (caught) adversarial.caught++; else adversarial.missed.push(c.id);
      console.log(`  ${c.id} adversarial: ${unavailable ? '⚠️ verifier unavailable — no verdict' : caught ? '🪤 caught' : '❌ MISSED — the judge passed the fixture the asserts cannot catch'}`);
    }
    const trialResults: CaseResult['trials'] = [];
    for (let t = 0; t < trials; t++) {
      const { res, asserts } = (await trialRun(t))[caseIndex];
      if (!res.success) {
        // An inference failure is the verifier being unavailable, not the model
        // failing the case. It is recorded, excluded from every score, and never
        // read as a regression (Verification.md: unavailable-verifier-means-DEFER).
        const error = res.error || 'inference failed';
        trialResults.push({ score: 0, passed: false, asserts: [], output: '', error });
        console.log(`  ${c.id} t${t + 1}: ⚠️ verifier unavailable — ${error.split('\n')[0].slice(0, 120)}`);
        continue;
      }
      const output = res.output.trim();
      const unavailable = asserts.find((r) => r.unavailable);
      if (unavailable) {
        const error = unavailable.reason;
        trialResults.push({ score: 0, passed: false, asserts, output, error });
        console.log(`  ${c.id} t${t + 1}: ⚠️ evaluator unavailable — ${error.split('\n')[0].slice(0, 120)}`);
        continue;
      }
      const { score, passed } = scoreAssertions(asserts, caseThreshold);
      trialResults.push({ score, passed, asserts, output, ...(res.executedModel ? { model: res.executedModel } : {}),
        ...('harness' in res ? { harness: res.harness } : {}) });
      console.log(`  ${c.id} t${t + 1}: ${passed ? '✅' : '❌'} ${(score * 100).toFixed(0)}%`);
    }
    const valid = trialResults.filter((t) => t.error === undefined);
    const passed = valid.filter((t) => t.passed).length;
    caseResults[caseIndex] = {
      id: c.id,
      ...(adversarialAsserts ? { adversarial_asserts: adversarialAsserts } : {}),
      infra_errors: trialResults.length - valid.length,
      mean_score: valid.length ? valid.reduce((s, t) => s + t.score, 0) / valid.length : 0,
      pass_at_k: passed > 0 ? 1 : 0,
      // ported from a community contribution
      // pass^k is "every one of the k trials passed" — a reliability measure.
      // passed/trials is the MEAN, which reported 2-of-3 as 67% where the true
      // pass^k is 0, making a flaky case look like a mostly-passing one. Recorded
      // scores drop wherever trials partially pass; that is the corrected
      // semantics, not a regression — historical numbers are not comparable.
      // A partial trial set cannot establish pass^k, even if all completed trials passed.
      pass_to_k: valid.length === trials && passed === trials ? 1 : 0,
      trials: trialResults,
    };
  }));

  const glanceStats = { ...EMPTY_GLANCE_STATS };
  let agreeing = 0;
  for (const c of caseResults) {
    for (const a of [...(c.adversarial_asserts ?? []), ...c.trials.flatMap((t) => t.asserts)]) {
      if (!a.jev) continue;
      if (a.jev.resolved) glanceStats.resolved_by_jev++;
      if (a.jev.escalated) glanceStats.escalated_to_judge++;
      if (a.jev.agree_with_judge !== null) {
        glanceStats.jev_samples++;
        if (a.jev.agree_with_judge) agreeing++;
      }
      if (a.jev.model_versioned) glanceStats.jev_model_versioned = a.jev.model_versioned;
    }
  }
  glanceStats.judge_calls_avoided = glanceStats.resolved_by_jev;
  glanceStats.jev_agreement = glanceStats.jev_samples ? agreeing / glanceStats.jev_samples : null;
  if (glanceStats.jev_samples > 0) {
    try {
      const attached = attachJudgeAgreement(name, { agreement: glanceStats.jev_agreement!, samples: glanceStats.jev_samples,
        model_versioned: glanceStats.jev_model_versioned ?? 'unknown', date: new Date().toISOString() });
      if (!attached) console.error(`(judgment-layer calibration not attached: no existing record for ${name})`);
    } catch (e) { console.error(`(judgment-layer calibration not attached: ${(e as Error).message})`); }
  }

  const meanScore = caseResults.reduce((s, c) => s + c.mean_score, 0) / caseResults.length;
  const passToK = caseResults.reduce((s, c) => s + c.pass_to_k, 0) / caseResults.length;
  const passAtK = caseResults.reduce((s, c) => s + c.pass_at_k, 0) / caseResults.length;
  const suiteType = suite.type ?? 'regression';
  // Regression gates on pass^k — "regression evals target ~100%" and pass^k is
  // the reliability metric; a mean gate let 2-of-3 flaky passes look healthy.
  // Capability keeps the mean gate (a hill being climbed reports progress).
  const infraErrors = caseResults.reduce((s, c) => s + c.infra_errors, 0) + adversarialInfraErrors;
  // An unavailable evaluator leaves this run with no quality verdict. Keep the
  // transcript for diagnosis, but never replace last known-valid state.
  const verifierUnavailable = infraErrors > 0;
  const passedByScore = !verifierUnavailable && (suiteType === 'regression' ? passToK >= threshold : meanScore >= threshold);
  const passed = passedByScore && adversarial.caught === adversarial.cases;
  const stats = summarize(caseResults.map((c) => c.mean_score));
  const allAsserts = suite.cases.flatMap((c) => c.assert ?? []);
  const judgedCount = allAsserts.filter((a) => isModelAssert(a.type)).length;
  const judgedResidue = allAsserts.length === 0 ? 0 : judgedCount / allAsserts.length;

  const provisional = provisionalReport(name, judgedCount, { resultsDir });
  if (judgedCount > 0 && !judgeCalibrated && !provisional.provisional) {
    provisional.provisional = true;
    provisional.reason = 'runtime suite or judge configuration is not covered by calibration';
  }
  const result: SuiteResult = {
    ...glanceStats,
    ...(evidence ? { evidence } : {}),
    suite: name,
    type: suiteType,
    passed,
    score: meanScore,
    pass_to_k: passToK,
    pass_at_k: passAtK,
    summary: verifierUnavailable
      ? `verifier unavailable — ${infraErrors} trial${infraErrors === 1 ? '' : 's'} had no evaluator verdict; no verdict`
      : `pass^k ${(passToK * 100).toFixed(0)}%, mean ${(meanScore * 100).toFixed(1)}% ±${(stats.sem * 100).toFixed(1)} over ${trials} trials${infraErrors ? ` (${infraErrors} trial${infraErrors === 1 ? '' : 's'} excluded: verifier unavailable)` : ''}`,
    run_id: runId,
    infra_errors: infraErrors,
    verifier_unavailable: verifierUnavailable,
    cases: caseResults.map((c) => ({ id: c.id, mean_score: c.mean_score, pass_to_k: c.pass_to_k, pass_at_k: c.pass_at_k, infra_errors: c.infra_errors })),
    stats,
    judged_residue: judgedResidue,
    agent_level: agentLevel,
    agent_model: carrier?.model ?? `${subjectRoute.vendor}:${agentLevel}`,
    judge_level: judgeLevel,
    judge_calibrated: judgeCalibrated,
    ...calibrationProvenance(name, judgedCount > 0 && judgeCalibrated),
    adversarial,
    provisional: provisional.provisional,
    provisional_age_days: provisional.age_days,
    provisional_reason: provisional.reason,
    duration_ms: Date.now() - startedAt,
    ts: new Date().toISOString(),
  };

  return persist(result, caseResults);
}

if (import.meta.main) {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      suite: { type: 'string', short: 's' },
      trials: { type: 'string', short: 't' },
      json: { type: 'boolean' },
      report: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
  });
  if (values.help || !values.suite) {
    console.log(`EvalRunner — assertion-first suite runner\n\n  bun run EvalRunner.ts -s <suite> [-t trials] [--json]\n\nExit 0 = passed, 1 = regressed, 2 = evaluator unavailable (no verdict).`);
    process.exit(values.help ? 0 : 1);
  }
  const override: Partial<EvalSuiteV2> = {};
  if (values.trials) override.trials = parseInt(values.trials);
  console.log(`\nRunning suite: ${values.suite}\n`);
  const result = await runSuite(values.suite, override);
  if (values.json && !values.report) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`\n📊 ${result.verifier_unavailable ? '⚠️ NO VERDICT' : result.passed ? '✅ PASSED' : '❌ REGRESSED'}: ${result.suite} (${result.type})`);
    console.log(`   ${result.summary}`);
    if (result.stats) console.log(`   95% CI [${(result.stats.ci95_lo * 100).toFixed(1)}%, ${(result.stats.ci95_hi * 100).toFixed(1)}%] over ${result.stats.n} cases`);
    console.log(`   judge: ${result.judge_level}${result.judge_calibrated ? ' (calibrated-cheap)' : ''}${result.provisional ? ` · ${result.provisional_reason?.startsWith('proxy:') ? 'PROXY' : 'PROVISIONAL'} (${result.provisional_age_days ?? '?'}d: ${result.provisional_reason})` : ''} · judged residue ${((result.judged_residue ?? 0) * 100).toFixed(0)}% · ${((result.duration_ms ?? 0) / 1000).toFixed(0)}s`);
    for (const line of glanceReportLines(result)) console.log(line);
    for (const c of result.cases) console.log(`   - ${c.id}: pass^k ${(c.pass_to_k * 100).toFixed(0)}%  mean ${(c.mean_score * 100).toFixed(0)}%`);
  }
  process.exit(result.verifier_unavailable ? 2 : result.passed ? 0 : 1);
}
