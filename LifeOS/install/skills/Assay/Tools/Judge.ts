#!/usr/bin/env bun
/**
 * Judge — the model-graded assertion layer (llm-rubric, llm-assert).
 *
 * Uses Assay's judgment layer (engine: Clef-omni) — see LIFEOS/DOCUMENTATION/Assay/AssaySystem.md.
 * Judged rows ask the judgment layer first under `eval-judge` (rubric, llm-assert) and
 * `eval-judge-pairwise` (pairwise), and skip the model judge only when decide() lets the answer act.
 *
 * Implements Anthropic's cookbook judge discipline: the judge reasons first, then
 * emits a machine-readable verdict; we force a parseable JSON object rather than
 * free text. Best practices baked in (from Anthropic's "develop-tests" docs and
 * "Demystifying evals"): reason-then-score, a DISTINCT judge level from the
 * agent-under-test, and an explicit "Unknown" escape hatch — a judge that can't
 * tell must say so, and Unknown is scored as a miss (conservative for regression).
 *
 * Runs through Inference.ts and the signed-in vendor CLI.
 */

import type { Assertion, AssertResult } from './Assertions.ts';
import { existsSync, readFileSync } from 'node:fs';
import { inference, type InferenceLevel } from '../../../LIFEOS/TOOLS/Inference.ts';
import { judgeText, namedJudge } from '../../../LIFEOS/ASSAY/JudgeCall.ts';
import { RUBRIC_SYSTEM, ASSERT_SYSTEM, PAIRWISE_SYSTEM, anchorBlock, referenceBlock, JUDGE_PROMPT_HASH } from '../../../LIFEOS/TOOLS/lib/JudgePrompts.ts';
import { invariant } from '../../../LIFEOS/TOOLS/Invariant.ts';
import { modelFor, resolveVendors } from '../../../LIFEOS/TOOLS/lib/Calibration.ts';
import { evalJudgeVendor } from '../../../LIFEOS/ROUTER/EvalRoute.ts';
import { ask, decide, judgeMany, type Decision } from '../../../LIFEOS/ASSAY/Assay.ts';
import { EngineError, type ScoreQuestion, type ChoiceQuestion, type NoulQuestion, type Question, type Questions, type Answer, type EngineResponse } from '../../../LIFEOS/ASSAY/Engine.ts';

// The rubric's own pass/fail cut line on its normalized 0..1 score — an eval-authored
// value, applied identically whichever judge (model or engine) produced the score. This is
// NOT a judgment-layer trust/confidence threshold (that one lives in the caller registry,
// assay-callers.json, and is read via decide() below); naming it without "threshold" keeps
// it out of the glance-thresholds scan, which covers every file that imports the judgment
// layer (ISC-38 gate, IntegrityCheck.ts).
const RUBRIC_PASS_BAR = 0.6;
// The model judge's own rubric prompt (RUBRIC_SYSTEM) contracts it to a 1-based integer
// level; a shape bound, not a probability cutoff.
const MIN_SCORE_LEVEL = 1;
// Engine's ScoreQuestion.criteria is a 0-indexed array; scored.score's valid floor is 0,
// not 1. Also a shape bound, not a probability cutoff.
const MIN_SCORE_INDEX = 0;
// Sampling rate for retaining model-judge agreement measurements after rubric enforcement.
const GLANCE_ENFORCE_HOLDOUT = 0.10;

// Empirically verified against the live API (2026-09-17, probe below): a Score
// question's `criteria` must be an ORDERED ARRAY, not a keyed object — a Record
// throws a real HTTP 422 ("Input should be a valid list"). `Assertion.anchors`
// is keyed 1-based ("1".."top", matching the model judge's own 1-based levels),
// so it is re-indexed into a 0-based array here: array[i] = anchors[String(i+1)].
//   bun -e 'import("./LIFEOS/ASSAY/Assay.ts").then(({ask}) => ask("t", {rubric:
//     {type:"score", instructions:"i", criteria: {"1":"a"}}}, {caller:"probe"})
//     .catch(e => console.log(e.message)))'
export function rubricToScoreQuestion(a: Assertion): ScoreQuestion {
  const rubric = typeof a.value === 'string' ? a.value : JSON.stringify(a.value);
  const top = a.scale && a.scale > 1 ? a.scale : 5;
  const criteria = Array.from({ length: top }, (_, i) => a.anchors?.[String(i + 1)]);
  if (criteria.some(r => typeof r !== "string" || !r.trim())) throw new Error("unanchored");
  return { type: 'score', instructions: `${rubric}${referenceBlock(a.reference)}`, criteria: criteria as string[] };
}

/** The claims an llm-assert puts to the judge: every array item is one claim, a scalar value is one claim. Pure. */
export function assertClaims(a: Assertion): string[] {
  return Array.isArray(a.value) ? a.value.map(String) : [String(a.value)];
}

/** The noul question for one claim (ISC-30): one claim per question, never a packed "satisfy ALL" list. Pure. */
export function claimQuestion(claim: string, reference?: string): NoulQuestion {
  return { type: "noul", instructions: `Does the output satisfy this assertion?\n${claim}${referenceBlock(reference)}` };
}

/** The question id of claim k of n under an assert's own id: the id itself when the assert has one claim. Pure. */
export function claimQuestionId(id: string, k: number, n: number): string {
  return n === 1 ? id : `${id}_c${k + 1}`;
}

/**
 * Every question one judged assert asks, keyed under `id`: a rubric is one score question; an llm-assert is one noul per
 * claim (ISC-30), so a three-claim assert is three questions in ONE map, which the engine answers in one call per output.
 */
export function assertionQuestions(a: Assertion, id: string): Questions {
  if (a.type.replace(/^not-/, "") === "llm-rubric") return { [id]: rubricToScoreQuestion(a) };
  const claims = assertClaims(a);
  return Object.fromEntries(claims.map((c, k) => [claimQuestionId(id, k, claims.length), claimQuestion(c, a.reference)]));
}

/** Thrown by assertionQuestion for an llm-assert with several claims: its questions are a map (assertionQuestions). */
export class MultiClaimError extends Error {
  constructor(n: number) { super(`multi-claim: ${n} claims are ${n} questions; use assertionQuestions`); }
}

/**
 * The single question a judged assert asks when it asks one. An llm-assert with several claims asks one per claim, so it
 * has no single question: this throws MultiClaimError, and a pooling caller (EvalRunner.applyAsserts) leaves that assert
 * to judgeAssertion, which asks all its claims in one question map through judgeMany.
 */
export function assertionQuestion(a: Assertion): Question {
  const questions = Object.values(assertionQuestions(a, "q"));
  if (questions.length !== 1) throw new MultiClaimError(questions.length);
  return questions[0]!;
}

function glanceFailure(e: unknown): NonNullable<AssertResult['jev']> {
  return { resolved: false, escalated: true, escalate_reason: `error:${e instanceof EngineError ? e.kind : 'unknown'}`, agree_with_judge: null };
}

/** One claim's verdict and where it came from: the glance tier when the engine was confident, the model judge otherwise. */
export type ClaimVerdict = { verdict: 'TRUE' | 'FALSE' | 'UNKNOWN'; quotes?: string[]; reason?: string; by?: 'glance' | 'judge' };

/**
 * The assert result over its per-claim verdicts. The score is the share of claims TRUE and the assert passes only when
 * every claim is TRUE; any UNKNOWN is a miss with score 0, negated or not; a not-llm-assert inverts both. Pure.
 */
export function aggregateClaims(a: Assertion, verdicts: readonly ClaimVerdict[]): AssertResult {
  invariant(verdicts.length === assertClaims(a).length, 'one verdict per claim');
  const n = verdicts.length;
  const trueCount = verdicts.filter((v) => v.verdict === 'TRUE').length;
  const unknown = verdicts.some((v) => v.verdict === 'UNKNOWN');
  let passed = trueCount === n;
  let score = trueCount / n;
  if (a.type.startsWith('not-') && !unknown) { passed = !passed; score = 1 - score; }
  if (unknown) { passed = false; score = 0; }
  const evidence = verdicts.map((v, k) => `${k + 1}. ${v.verdict}${v.by === 'glance' ? ' (glance)' : ''}: ${JSON.stringify(v.quotes ?? [])}${v.reason ? ` — ${v.reason}` : ''}`).join('; ');
  return { type: a.type, passed, score, reason: `${unknown ? 'UNKNOWN: ' : ''}${trueCount}/${n} assertions TRUE; ${evidence}`, weight: a.weight ?? 1, ...(unknown ? { unknown: true } : {}) };
}

/** The model judge's verdict on every claim of `a`, in order, or the reason it gave none (an unavailable judge). */
async function modelClaimVerdicts(output: string, a: Assertion, opts: JudgeOptions): Promise<ClaimVerdict[] | { error: string }> {
  const level: InferenceLevel = opts.level ?? 'high';
  const timeout = opts.timeout ?? 45_000;
  const invoke = opts.invoke ?? judgeText;
  const claims = assertClaims(a);
  const prompt = buildAssertPrompt(output, a);
  try {
    let res = await invoke({ systemPrompt: ASSERT_SYSTEM, userPrompt: prompt, level, vendor: evalJudgeVendor(), timeout });
    if (!res.success) return { error: `judge error: ${res.error}` };
    let j = extractJson(res.output) as { results?: { verdict?: string; quotes?: string[]; reason?: string }[] } | null;
    // A cheap judge with no verdicts gets ONE retry at 'high' before the assert is unavailable.
    if ((j?.results ?? []).length === 0 && level !== 'high') {
      res = await invoke({ systemPrompt: ASSERT_SYSTEM, userPrompt: prompt, level: 'high', vendor: evalJudgeVendor(), timeout });
      if (res.success) j = extractJson(res.output) as typeof j;
    }
    const results = j?.results ?? [];
    if (!Array.isArray(results) || results.length !== claims.length || results.some((r) => !r || !['TRUE', 'FALSE', 'UNKNOWN'].includes(String(r.verdict).toUpperCase()))) {
      return { error: 'judge returned no assertion verdicts' };
    }
    return results.map((r) => ({ verdict: String(r.verdict).toUpperCase() as ClaimVerdict['verdict'], quotes: r.quotes, reason: r.reason, by: 'judge' as const }));
  } catch (e) {
    return { error: `judge exception: ${(e as Error).message}` };
  }
}

/** Why the judgment layer left one claim to the model judge, in the escalate_reason vocabulary the rubric lane already writes. */
function claimEscalateReason(d: Decision): string {
  return d.reason === 'below threshold' ? 'UNKNOWN' : d.reason;
}

/**
 * An llm-assert, one claim at a time (ISC-30). Every claim is its own engine noul; all claims about this output ride ONE
 * question map, so it is one judgment-layer call (judgeMany with one item; a single claim keeps the plain ask). A claim the
 * engine answers confidently is settled there; the model judge sees only the claims the engine left uncertain (or all of
 * them on the agreement holdout). The assert's score is the share of claims TRUE and it passes only when all pass
 * (aggregateClaims).
 */
async function judgeClaims(output: string, a: Assertion, opts: JudgeOptions): Promise<AssertResult> {
  const claims = assertClaims(a);
  const n = claims.length;
  const ids = claims.map((_c, k) => claimQuestionId(opts.questionId ?? 'noul', k, n));
  const settled: (ClaimVerdict | null)[] = claims.map(() => null);
  const glanceYes: ('TRUE' | 'FALSE' | null)[] = claims.map(() => null);
  const reasons: string[] = claims.map(() => 'UNKNOWN');
  let glance: NonNullable<AssertResult['jev']>;
  try {
    if (opts.prepared instanceof Error) throw opts.prepared;
    let answers: Record<string, Answer>;
    let model: string | null;
    if (opts.prepared) ({ answers, model } = opts.prepared);
    else if (n === 1) {
      ({ answers, model } = await (opts.glanceAsk ?? ask)(output, { [ids[0]!]: claimQuestion(claims[0]!, a.reference) }, {
        caller: 'eval-judge', session: opts.session, turn: opts.turn, callersPath: opts.glanceCallersPath, logPath: opts.glanceLogPath,
      }));
    } else {
      const key = opts.turn ?? 'assert';
      const [row] = await (opts.glanceMany ?? judgeMany)([{ key, state: output }], assertionQuestions(a, opts.questionId ?? 'noul'), {
        caller: 'eval-judge', session: opts.session, callersPath: opts.glanceCallersPath, logPath: opts.glanceLogPath, retries: 0,
        questionJoins: Object.fromEntries(ids.map((id) => [id, { question: 'noul', turn: `${key}:${id}` }])),
      });
      if (!row?.result) throw new Error(row?.error ?? 'judgment layer returned no result');
      answers = Object.fromEntries(Object.entries(row.result).map(([id, r]) => [id, r.answer]));
      model = Object.values(row.result)[0]?.model ?? null;
    }
    const confidences: number[] = [];
    ids.forEach((id, k) => {
      const scored = answers[id];
      if (scored?.type !== 'noul') { reasons[k] = 'error:shape'; return; }
      const decision = decide('eval-judge', 'noul', scored, opts.glanceCallersPath);
      if (!decision.verdict) { reasons[k] = 'error:shape'; return; }
      glanceYes[k] = decision.verdict === 'yes' ? 'TRUE' : 'FALSE';
      if (decision.confidence !== undefined) confidences.push(decision.confidence);
      if (decision.act) settled[k] = { verdict: glanceYes[k]!, reason: `glance noul: ${decision.verdict}`, by: 'glance' };
      else reasons[k] = claimEscalateReason(decision);
    });
    glance = { resolved: true, escalated: false, escalate_reason: 'confident', agree_with_judge: null,
      ...(confidences.length ? { jev_confidence: Math.min(...confidences) } : {}), model_versioned: model };
    if (settled.every(Boolean) && (opts.random ?? Math.random)() < (opts.holdoutRate ?? GLANCE_ENFORCE_HOLDOUT)) {
      settled.fill(null);
      reasons.fill('holdout');
    }
  } catch (e) {
    glance = glanceFailure(e);
    reasons.fill(glance.escalate_reason);
  }
  const open = claims.map((_c, k) => k).filter((k) => !settled[k]);
  if (open.length === 0) return { ...aggregateClaims(a, settled as ClaimVerdict[]), jev: glance };
  glance = { ...glance, resolved: false, escalated: true, escalate_reason: reasons[open[0]!]! };
  const judged = await modelClaimVerdicts(output, { ...a, type: 'llm-assert', value: open.map((k) => claims[k]!) }, opts);
  if ('error' in judged) return { type: a.type, passed: false, score: 0, reason: judged.error, weight: a.weight ?? 1, unavailable: true, jev: glance };
  open.forEach((k, j) => { settled[k] = judged[j]!; });
  const compared = open.filter((k) => glanceYes[k] !== null && settled[k]!.verdict !== 'UNKNOWN');
  if (compared.length) glance.agree_with_judge = compared.every((k) => glanceYes[k] === settled[k]!.verdict);
  return { ...aggregateClaims(a, settled as ClaimVerdict[]), jev: glance };
}

// The system prompts and the three mechanics (quote first, choose lower, reference) live in
// LIFEOS/TOOLS/lib/JudgePrompts.ts so the vision judge shares them and the calibration
// record can hash them. Re-exported for readers of this file.
export { RUBRIC_SYSTEM, ASSERT_SYSTEM, JUDGE_PROMPT_HASH };

/** The user prompt a rubric assert sends: rubric, anchors, reference (when the assert carries one), then the output. Pure. */
export function buildRubricPrompt(output: string, a: Assertion): string {
  const rubric = typeof a.value === 'string' ? a.value : JSON.stringify(a.value);
  const scale = a.scale && a.scale !== 5 ? `\n\n## SCALE\nInteger 1–${a.scale}. The anchors are the whole scale; ${a.scale} is the top.` : '';
  return `## RUBRIC\n${rubric}${anchorBlock(a.anchors)}${scale}${referenceBlock(a.reference)}\n\n## OUTPUT\n${output}`;
}

/** The user prompt an llm-assert sends: output, reference (when present), the numbered assertions. Pure. */
export function buildAssertPrompt(output: string, a: Assertion): string {
  const assertions = Array.isArray(a.value) ? a.value.map(String) : [String(a.value)];
  return `## OUTPUT\n${output}${referenceBlock(a.reference)}\n\n## ASSERTIONS\n${assertions.map((s, i) => `${i + 1}. ${s}`).join('\n')}`;
}

export interface JudgeOptions {
  prepared?: EngineResponse | Error;
  questionId?: string;
  /** Same suite/case/trial/assert join used by the rubric lane. */
  turn?: string;
  session?: string;
  glanceAsk?: typeof ask;
  /** Test seam for a multi-claim llm-assert: its one question map goes through judgeMany as one item. */
  glanceMany?: typeof judgeMany;
  glanceCallersPath?: string;
  /** Test seam: keeps test runs out of the live shadow log. */
  glanceLogPath?: string;
  level?: InferenceLevel; // judge level; default 'high' (distinct from a 'medium' agent-under-test)
  timeout?: number;
  holdoutRate?: number;
  random?: () => number;
  /** Injectable only for deterministic tests. */
  invoke?: typeof inference;
}

/** Pull the last balanced {...} JSON object out of a text blob. Robust to fences + prose. */
export function extractJson(text: string): Record<string, unknown> | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/gi);
  const candidates: string[] = [];
  if (fenced) for (const f of fenced) candidates.push(f.replace(/```(?:json)?/gi, '').trim());
  // Scan complete top-level objects, respecting braces inside JSON strings.
  let start = -1, depth = 0, quoted = false, escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (start < 0) { if (c === '{') { start = i; depth = 1; } continue; }
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') quoted = false;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) { candidates.push(text.slice(start, i + 1)); start = -1; }
  }
  for (const c of candidates.reverse()) {
    try { return JSON.parse(c); } catch { /* try next */ }
  }
  return null;
}

/** Grade one model-based assertion (llm-rubric or llm-assert) against the output. The assert's `derived_from` lineage rides on the result so run.json keeps it (ISC-17.2). */
export async function judgeAssertion(
  output: string,
  a: Assertion,
  opts: JudgeOptions = {},
): Promise<AssertResult> {
  let glance: AssertResult['jev'];
  let glancePassed: boolean | undefined;
  const lineage = (r: AssertResult): AssertResult => a.derived_from ? { ...r, derived_from: a.derived_from } : r;
  const base = a.type.replace(/^not-/, "");
  if (base === "llm-assert") return lineage(await judgeClaims(output, a, opts));
  if (base === "llm-rubric") {
    try {
      const question = assertionQuestion(a);
      const id = "rubric";
      if (opts.prepared instanceof Error) throw opts.prepared;
      const answer = opts.prepared ?? await (opts.glanceAsk ?? ask)(output, { [id]: question }, {
        caller: 'eval-judge', session: opts.session, turn: opts.turn, callersPath: opts.glanceCallersPath, logPath: opts.glanceLogPath,
      });
      const scored = answer.answers[opts.questionId ?? id];
      {
      const top = a.scale && a.scale > 1 ? a.scale : 5;
      // scored.score is a CONTINUOUS 0-indexed expected value over the `top`-length
      // criteria array (probability-weighted position, e.g. 0.02 favoring index 0) —
      // not a 1-based integer level pick. Verified empirically against the live API.
      if (scored?.type !== 'score' || !Number.isFinite(scored.score) || scored.score < MIN_SCORE_INDEX || scored.score > top - 1 || !Number.isFinite(scored.confidence)) {
        throw new EngineError('Invalid rubric score', 'shape');
      }
      const norm = scored.score / (top - 1);
      const negated = a.type.startsWith('not-');
      glancePassed = norm >= (a.threshold ?? RUBRIC_PASS_BAR);
      if (negated) glancePassed = !glancePassed;
      const decision = decide('eval-judge', id, scored, opts.glanceCallersPath);
      glance = { resolved: decision.act, escalated: !decision.act, escalate_reason: decision.act ? 'confident' : decision.reason,
        agree_with_judge: null, jev_score: scored.score, jev_confidence: scored.confidence, model_versioned: answer.model };
      if (decision.act) {
        const random = opts.random ?? Math.random;
        const holdoutRate = opts.holdoutRate ?? GLANCE_ENFORCE_HOLDOUT;
        if (random() >= holdoutRate) return lineage({ type: a.type, passed: glancePassed, score: negated ? 1 - norm : norm,
          reason: `glance expected level ${scored.score.toFixed(2)} of ${top - 1} (0-indexed)`, weight: a.weight ?? 1, jev: glance });
        glance.resolved = false;
        glance.escalated = true;
        glance.escalate_reason = 'holdout';
      }
      }
    } catch (e) { glance = e instanceof Error && e.message === "unanchored"
      ? { resolved: false, escalated: true, escalate_reason: "unanchored", agree_with_judge: null }
      : glanceFailure(e); glancePassed = undefined; }
  }
  const r = await judgeAssertionInner(output, a, opts);
  if (glance) {
    if (glancePassed !== undefined && !r.unavailable) glance.agree_with_judge = glancePassed === r.passed;
    r.jev = glance;
  }
  return lineage(r);
}

/** The user prompt a pairwise comparison sends. Pure. */
export function buildPairwisePrompt(a: string, b: string, question: string): string {
  return `## QUESTION\n${question}\n\n## CANDIDATE A\n${a}\n\n## CANDIDATE B\n${b}`;
}

/** The model a text pairwise call runs on: the judge level 'high' on the configured vendor (never the top rung). */
export function textPairwiseModel(): string {
  return modelFor(resolveVendors().default, 'high');
}

/**
 * Text pairwise: which of two candidates answers the question better. Each
 * candidate is a file path (read) or a literal. Order matters to a model, so
 * Tournament.ts calls this twice per pair with the order flipped; this
 * function judges ONE ordering and never flips on its own.
 */
export interface TextPairwiseResult {
  winner: 'A' | 'B' | 'tie';
  reason: string;
  executed_model?: string;
  jev?: AssertResult['jev'];
}

export async function judgeTextPairwise(a: string, b: string, question: string, opts: JudgeOptions = {}): Promise<TextPairwiseResult> {
  const text = (c: string) => (existsSync(c) ? readFileSync(c, 'utf-8') : c);
  const prompt = buildPairwisePrompt(text(a), text(b), question);
  let glance: AssertResult['jev'];
  let glanceWinner: TextPairwiseResult['winner'] | undefined;
  try {
    const choice: ChoiceQuestion = { type: 'choice', instructions: question,
      criteria: { A: `Candidate A better satisfies: ${question}`, B: `Candidate B better satisfies: ${question}`, tie: 'too close to call' } };
    const answer = await (opts.glanceAsk ?? ask)(prompt, { pairwise: choice }, { caller: 'eval-judge-pairwise', session: opts.session, callersPath: opts.glanceCallersPath, logPath: opts.glanceLogPath });
    const picked = answer.answers.pairwise;
    if (picked?.type !== 'choice' || !['A', 'B', 'tie'].includes(picked.choice) || !Number.isFinite(picked.confidence)) throw new EngineError('Invalid pairwise choice', 'shape');
    glanceWinner = picked.choice as TextPairwiseResult['winner'];
    const decision = decide('eval-judge-pairwise', 'pairwise', picked, opts.glanceCallersPath);
    glance = { resolved: decision.act, escalated: !decision.act, escalate_reason: decision.act ? 'confident' : decision.reason,
      agree_with_judge: null, jev_confidence: picked.confidence, model_versioned: answer.model };
    if (decision.act) return { winner: glanceWinner, reason: `glance choice: ${glanceWinner}`, jev: glance };
  } catch (e) { glance = glanceFailure(e); glanceWinner = undefined; }
  const res = await (opts.invoke ?? judgeText)({ systemPrompt: PAIRWISE_SYSTEM, userPrompt: prompt, level: opts.level ?? 'high', vendor: evalJudgeVendor(), timeout: opts.timeout ?? 60_000 });
  if (!res.success) throw new Error(`pairwise judge error: ${res.error}`);
  const j = extractJson(res.output) as { winner?: string; reason?: string } | null;
  const w = typeof j?.winner === 'string' ? j.winner.toUpperCase() : '';
  if ((w !== 'A' && w !== 'B' && w !== 'TIE') || typeof j?.reason !== 'string' || !j.reason.trim()) throw new Error('pairwise judge returned unparseable verdict');
  const winner = w === 'A' ? 'A' : w === 'B' ? 'B' : 'tie';
  if (glanceWinner !== undefined) glance.agree_with_judge = glanceWinner === winner;
  return { winner, reason: String(j.reason), ...(res.executedModel ? { executed_model: res.executedModel } : {}), jev: glance };
}

/**
 * Text pairwise on one named judge from the registry (`JudgeCall.namedJudge`), with no judgment-layer first pass:
 * the caller chose the model on purpose, so calibrating or comparing judges measures that model and nothing else.
 */
export function namedPairwiseJudge(name: string): (a: string, b: string, question: string) => Promise<TextPairwiseResult> {
  const judge = namedJudge(name, PAIRWISE_SYSTEM);
  const text = (c: string) => (existsSync(c) ? readFileSync(c, 'utf-8') : c);
  // Three attempts per verdict, as Panel.judgeOne does: one timeout or malformed reply must not void a whole calibration run.
  return async (a, b, question) => {
    let last = '';
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await judge.ask(buildPairwisePrompt(text(a), text(b), question));
      if (!res.ok) { last = `error: ${res.error ?? 'no reply'}`; continue; }
      const j = extractJson(res.text) as { winner?: string; reason?: string } | null;
      const w = typeof j?.winner === 'string' ? j.winner.toUpperCase() : '';
      if ((w !== 'A' && w !== 'B' && w !== 'TIE') || typeof j?.reason !== 'string' || !j.reason.trim()) { last = 'returned unparseable verdict'; continue; }
      return { winner: w === 'A' ? 'A' : w === 'B' ? 'B' : 'tie', reason: String(j.reason), ...(res.model ? { executed_model: res.model } : {}) };
    }
    throw new Error(`pairwise judge ${name} ${last} (3 attempts)`);
  };
}

async function judgeAssertionInner(output: string, a: Assertion, opts: JudgeOptions): Promise<AssertResult> {
  const weight = a.weight ?? 1;
  const level: InferenceLevel = opts.level ?? 'high';
  const timeout = opts.timeout ?? 45_000;
  const base = a.type.startsWith('not-') ? a.type.slice(4) : a.type;
  const negated = a.type.startsWith('not-');
  const invoke = opts.invoke ?? judgeText;

  try {
    if (base === 'llm-rubric') {
      const prompt = buildRubricPrompt(output, a);
      let res = await invoke({ systemPrompt: RUBRIC_SYSTEM, userPrompt: prompt, level, vendor: evalJudgeVendor(), timeout });
      if (!res.success) return { type: a.type, passed: false, score: 0, reason: `judge error: ${res.error}`, weight, unavailable: true };
      let j = extractJson(res.output);
      // Escalation: a cheap judge that can't produce a parseable verdict gets ONE
      // retry at 'high' before the assert fails — the calibrated-cheap-judge
      // default stays cheap on the happy path and never silently degrades.
      if ((!j || typeof j.score !== 'number') && level !== 'high') {
        res = await invoke({ systemPrompt: RUBRIC_SYSTEM, userPrompt: prompt, level: 'high', vendor: evalJudgeVendor(), timeout });
        if (res.success) j = extractJson(res.output);
      }
      const top = a.scale && a.scale > 1 ? a.scale : 5;
      if (!j || typeof j.score !== 'number' || !Number.isInteger(j.score) || j.score < MIN_SCORE_LEVEL || j.score > top || typeof j.pass !== 'boolean' || typeof j.reason !== 'string') {
        return { type: a.type, passed: false, score: 0, reason: 'judge returned unparseable verdict', weight, unavailable: true };
      }
      const norm = Math.max(0, Math.min(1, (Number(j.score) - 1) / (top - 1)));
      const reason = String(j.reason ?? '');
      const unknown = /^unknown:/i.test(reason.trim());
      const threshold = a.threshold ?? RUBRIC_PASS_BAR;
      let passed = !unknown && (j.pass === true) && norm >= threshold;
      let score = unknown ? 0 : norm;
      if (negated && !unknown) { passed = !passed; score = 1 - score; }
      return { type: a.type, passed, score, reason: reason || `score ${j.score}/5`, weight };
    }

    if (base === 'llm-assert') {
      const verdicts = await modelClaimVerdicts(output, a, opts);
      return 'error' in verdicts ? { type: a.type, passed: false, score: 0, reason: verdicts.error, weight, unavailable: true } : aggregateClaims(a, verdicts);
    }

    return { type: a.type, passed: false, score: 0, reason: `unsupported model assert: ${base}`, weight, unavailable: true };
  } catch (e) {
    return { type: a.type, passed: false, score: 0, reason: `judge exception: ${(e as Error).message}`, weight, unavailable: true };
  }
}

// ---- self-test (real inference; subscription) --------------------------------
if (import.meta.main) {
  const good = 'No, not by default. Force-pushing a shared main rewrites history for everyone who has pulled it.';
  const bad = 'Sure, go ahead and force-push whenever you like, it is totally fine on any branch.';
  (async () => {
    const rubric: Assertion = {
      type: 'llm-rubric',
      value: 'Does the answer correctly warn that force-pushing a shared main branch is dangerous and advise against it?',
    };
    const assert: Assertion = {
      type: 'llm-assert',
      value: ['The response advises against force-pushing to a shared branch'],
    };
    const rGood = await judgeAssertion(good, rubric);
    const rBad = await judgeAssertion(bad, rubric);
    const aGood = await judgeAssertion(good, assert);
    const aBad = await judgeAssertion(bad, assert);
    console.log('rubric good:', JSON.stringify(rGood));
    console.log('rubric bad :', JSON.stringify(rBad));
    console.log('assert good:', JSON.stringify(aGood));
    console.log('assert bad :', JSON.stringify(aBad));
    const ok = rGood.passed && !rBad.passed && aGood.passed && !aBad.passed;
    console.log(`\n${ok ? '✅ judge discriminates good vs bad' : '❌ judge failed to discriminate'}`);
    process.exit(ok ? 0 : 1);
  })();
}
