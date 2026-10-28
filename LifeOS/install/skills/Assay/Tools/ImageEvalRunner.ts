#!/usr/bin/env bun
/**
 * ImageEvalRunner — suite runner for the visual eval lane.
 *
 * An image case is `{id, image, assert:[...]}` — the runner GRADES files, it
 * never generates them (generation stays in the owning skill). Deterministic
 * image asserts (ImageAsserts.ts) run ONCE — a fixed file yields identical
 * results every time, so trials on them are pure cost. `vision-rubric` asserts
 * run `trials` times (judge variance is real) and score per-trial.
 *
 * Persists SuiteResult-shaped results to MEMORY/STATE/Evals-Results/<suite>/ so
 * latest.json, trend derivation, and EvalState.md all work unchanged.
 *
 *   bun ImageEvalRunner.ts -s <suite> [--json]
 *
 * Suite YAML (Suites/ roots, same resolution as text):
 *   name: thumbnail-quality
 *   type: capability
 *   cases:
 *     - id: current_thumb
 *       image: "~/path/to.png"          # ~ expanded; relative to suite file otherwise
 *       assert:
 *         - { type: dimensions, value: "1280x720", weight: 2 }
 *         - { type: vision-rubric, value: "...", anchors: {...}, weight: 2, trials: 2 }
 */

import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assayUserDir } from '../../../LIFEOS/TOOLS/Paths.ts';
import { homedir } from 'node:os';
import { parse as parseYaml } from 'yaml';
import { parseArgs } from 'node:util';
import { evaluateImageAssert, type ImageAssertion } from './ImageAsserts.ts';
import { judgeImageRubric, judgeMeaningLadder, meaningLadderAssert } from './VisionJudge.ts';
import { textPairwiseModel } from './Judge.ts';
import { familyOf } from './Tournament.ts';
import { summarize } from './Stats.ts';
import { isJudgedAssert, type AssertResult } from './Assertions.ts';
import { defaultJudgeLevel, provisionalReport, calibrationProvenance, scoreAssertions, type SuiteResult } from './EvalRunner.ts';
import { judgeLevelForModel } from './JudgeLevel.ts';
import { defaultSuiteDirs } from '../../../LIFEOS/TOOLS/lib/Calibration.ts';
import { CROSS_VENDOR } from '../../../LIFEOS/TOOLS/models.ts';
import { validateSuite } from './SuiteManager.ts';
import { captureEvidence } from './EvalState.ts';

const CLAUDE_ROOT = join(homedir(), '.claude');
const RESULTS_DIR = join(CLAUDE_ROOT, 'LIFEOS', 'MEMORY', 'STATE', 'Evals-Results');
const USER_SUITES = join(assayUserDir(join(CLAUDE_ROOT, 'LIFEOS')), 'Suites');
const SKILL_SUITES = join(import.meta.dir, '..', 'Suites');

export interface ImageCase {
  id: string;
  image: string;
  /** the argument summary a meaning-ladder assert grades against (an assert-level `reference` wins) */
  reference?: string;
  /** the model that produced the image, for the generator/judge bookkeeping */
  generated_by?: string;
  /** ISC-38: `fail` marks the adversarial fixture — an unrelated image that must pass the deterministic asserts and be caught by the judged ones */
  expect?: 'pass' | 'fail';
  assert: (ImageAssertion & { anchors?: Record<string, string>; trials?: number; threshold?: number; reference?: string; derived_from?: string })[];
}

/** ISC-37: the ladder's reference is the argument summary, from the assert or the case; never absent. Pure. */
export function resolveLadderReference(c: Pick<ImageCase, 'id' | 'reference'>, a: { reference?: string }): string {
  const ref = (a.reference ?? c.reference ?? '').trim();
  if (!ref) throw new Error(`case ${c.id}: a meaning-ladder assert needs a \`reference:\` (the article's argument summary) on the assert or the case`);
  return ref;
}

/** ISC-31: who generated, who described, who judged. The judge is a different call on a different model from the generator, and the result says so. Pure. */
export function ladderModels(generatedBy: string | undefined, publicMaterial = false): { generator: string | null; describer: string; judge: string; same_family: boolean } {
  // Private material is described by OpenAI vision (VisionJudge.describeImageBlind); Gemini only on the public-material opt-in.
  const describer = publicMaterial ? CROSS_VENDOR.gemini : CROSS_VENDOR.openaiJudge;
  const judge = textPairwiseModel();
  const g = generatedBy ?? null;
  return { generator: g, describer, judge, same_family: g !== null && (familyOf(g) === familyOf(describer) || familyOf(g) === familyOf(judge)) };
}
export interface ImageSuite { name: string; type?: string; pass_threshold?: number; allow_identity?: boolean; /** Explicit consent that every image in this suite is public material, the only case Google (Gemini) may receive pixels (ISC-35). */ public_material?: boolean; judge_level?: NonNullable<Parameters<typeof judgeMeaningLadder>[2]>['level']; judge_model?: string; cases: ImageCase[] }

/** A case has one reliability observation per trial only when every judged
 * assertion was asked the same number of times. Combining a 2-trial rubric
 * with a 3-trial ladder would invent a case verdict, so reject that shape. */
function caseTrialShapeError(c: ImageCase): string | null {
  const counts = c.assert
    .filter((a) => isJudgedAssert(a.type))
    .map((a) => a.trials ?? 2);
  return new Set(counts).size > 1
    ? `case ${c.id}: judged image assertions must use one shared trials count for case pass^k/pass@k (got ${counts.join(', ')})`
    : null;
}

function resolveSuite(name: string): string | null {
  for (const dir of [USER_SUITES, SKILL_SUITES]) {
    for (const ext of ['yaml', 'yml']) {
      for (const p of [join(dir, `${name}.${ext}`), join(dir, 'Regression', `${name}.${ext}`), join(dir, 'Capability', `${name}.${ext}`)]) {
        if (existsSync(p)) return p;
      }
    }
  }
  return null;
}

function resolveImage(img: string, suitePath: string): string {
  const raw = img.replace(/^~\//, `${homedir()}/`);
  return raw.startsWith('/') ? raw : join(suitePath, '..', raw);
}

type ImageCheck = ImageCase['assert'][number];
interface ImageCheckOptions {
  suite?: string;
  allowIdentity?: boolean;
  publicMaterial?: boolean;
  level: NonNullable<Parameters<typeof judgeMeaningLadder>[2]>['level'];
  deterministic?: typeof evaluateImageAssert;
  rubric?: typeof judgeImageRubric;
  ladder?: typeof judgeMeaningLadder;
}

/** Same-image prerequisite stage, with injectable verifiers for offline tests. */
export async function applyImageAsserts(img: string, c: ImageCase, opts: ImageCheckOptions): Promise<AssertResult[]> {
  const results: AssertResult[] = new Array(c.assert.length);
  const record = (a: ImageCheck, r: AssertResult): AssertResult => ({
    ...r, required: a.required ?? !isJudgedAssert(a.type),
    ...(a.derived_from ? { derived_from: a.derived_from } : {}),
  });
  for (const [i, a] of c.assert.entries()) {
    if (!isJudgedAssert(a.type)) results[i] = record(a, await (opts.deterministic ?? evaluateImageAssert)(img, a));
  }
  const blocked = results.some((r) => r?.required && !r.passed);
  for (const [i, a] of c.assert.entries()) {
    if (!isJudgedAssert(a.type)) continue;
    if (blocked) {
      results[i] = record(a, { type: a.type, passed: false, score: 0, weight: a.weight ?? 1,
        skipped: true, reason: 'Skipped: required deterministic prerequisite failed' });
      continue;
    }
    const trials = a.trials ?? 2;
    if (!Number.isInteger(trials) || trials < 1) throw new Error('image assertion trials must be a positive integer');
    const scores: number[] = [];
    const trialResults: NonNullable<AssertResult['trials']> = [];
    let unknown = false;
    let unavailableReason: string | null = null;
    for (let t = 0; t < trials; t++) {
      const r = a.type === 'meaning-ladder' || a.type === 'not-meaning-ladder'
        ? await (opts.ladder ?? judgeMeaningLadder)(img,
          meaningLadderAssert(resolveLadderReference(c, a), { anchors: a.anchors, threshold: a.threshold,
            weight: a.weight, derived_from: a.derived_from, value: a.value }),
          { allowIdentity: opts.allowIdentity ?? false, publicMaterial: opts.publicMaterial ?? false, level: opts.level })
        : await (opts.rubric ?? judgeImageRubric)(img, String(a.value ?? ''), a.anchors,
          { weight: a.weight, threshold: a.threshold, allowIdentity: opts.allowIdentity ?? false, publicMaterial: opts.publicMaterial ?? false, reference: a.reference ?? c.reference, suite: opts.suite });
      if (r.unavailable) {
        trialResults.push({ score: 0, passed: false, reason: r.reason, unavailable: true });
        unavailableReason = r.reason;
        break;
      }
      scores.push(r.score);
      const trialUnknown = /^unknown:/i.test(r.reason.trim());
      unknown ||= trialUnknown;
      const trialPassed = !trialUnknown && (a.type.startsWith('not-') ? !r.passed : r.passed);
      trialResults.push({ score: a.type.startsWith('not-') ? 1 - r.score : r.score, passed: trialPassed, reason: r.reason, ...(trialUnknown ? { unknown: true } : {}), ...(r.judge ? { judge: r.judge } : {}) });
    }
    if (unavailableReason !== null) {
      results[i] = record(a, { type: a.type, passed: false, score: 0, unavailable: true,
        reason: `evaluator unavailable: ${unavailableReason}`, weight: a.weight ?? 1, trials: trialResults, requested_trials: trials });
      continue;
    }
    const mean = scores.reduce((s, x) => s + x, 0) / scores.length;
    const negated = a.type.startsWith('not-');
    const passed = !unknown && trialResults.every((r) => r.passed) && (negated ? mean < (a.threshold ?? 0.6) : mean >= (a.threshold ?? 0.6));
    results[i] = record(a, { type: a.type, passed, score: unknown ? 0 : negated ? 1 - mean : mean,
      reason: trialResults.map((r, index) => `Trial ${index + 1}: ${r.passed ? 'pass' : 'fail'} — ${r.reason}`).join('; '), weight: a.weight ?? 1, unknown, trials: trialResults, requested_trials: trials });
  }
  return results;
}

/**
 * The suite verdict, pure. Adversarial cases (`expect: fail`, ISC-38) are graded
 * as caught/missed and never enter the capability mean: a correctly caught rung-1
 * fixture scores near zero and would otherwise drag a passing suite under its
 * threshold. A missed fixture fails the suite outright.
 */
export function imageSuiteVerdict(
  cases: { mean_score: number; pass_to_k: number; pass_at_k?: number; adversarial?: boolean; unavailable?: boolean; id: string }[],
  threshold: number,
  suiteType: string,
): { meanScore: number; passToK: number; passAtK: number; stats: ReturnType<typeof summarize>; adversarial: NonNullable<SuiteResult['adversarial']>; passed: boolean } {
  const graded = cases.filter((c) => !c.adversarial && !c.unavailable);
  const traps = cases.filter((c) => c.adversarial);
  const adversarial = { cases: traps.length, caught: traps.filter((c) => !c.unavailable && c.pass_to_k === 1).length, missed: traps.filter((c) => c.unavailable || c.pass_to_k !== 1).map((c) => c.id) };
  const meanScore = graded.length ? graded.reduce((s, c) => s + c.mean_score, 0) / graded.length : 0;
  const passToK = graded.length ? graded.reduce((s, c) => s + c.pass_to_k, 0) / graded.length : 0;
  const passAtK = graded.length ? graded.reduce((s, c) => s + (c.pass_at_k ?? 0), 0) / graded.length : 0;
  const stats = summarize(graded.map((c) => c.mean_score));
  const passedByScore = graded.length > 0 && (suiteType === 'regression' ? passToK >= threshold : meanScore >= threshold);
  return { meanScore, passToK, passAtK, stats, adversarial, passed: passedByScore && adversarial.caught === adversarial.cases };
}

export interface ImageRunDeps {
  suite?: ImageSuite;
  suitePath?: string;
  resultsDir?: string;
  deterministic?: typeof evaluateImageAssert;
  rubric?: typeof judgeImageRubric;
  ladder?: typeof judgeMeaningLadder;
}

export async function runImageSuite(name: string, deps: ImageRunDeps = {}): Promise<SuiteResult> {
  const evidence = Object.keys(deps).length === 0 ? captureEvidence(name) : undefined;
  const resolvedPath = resolveSuite(name);
  const path = deps.suitePath ?? resolvedPath;
  if (!deps.suite && !path) return { suite: name, type: 'unknown', passed: false, score: 0, pass_to_k: 0, pass_at_k: 0, summary: `Suite not found: ${name}`, run_id: 'error', infra_errors: 0, verifier_unavailable: false, cases: [] };
  const suite = deps.suite ?? parseYaml(readFileSync(path!, 'utf-8')) as ImageSuite;
  if (!Array.isArray(suite.cases) || suite.cases.length === 0) {
    return { suite: name, type: 'unknown', passed: false, score: 0, pass_to_k: 0, pass_at_k: 0, summary: `Suite '${name}' has no cases`, run_id: 'error', infra_errors: 0, verifier_unavailable: false, cases: [] };
  }
  const validation = validateSuite(suite, 'image');
  if (!validation.ok) return { suite: name, type: suite.type ?? 'unknown', passed: false, score: 0, pass_to_k: 0, pass_at_k: 0, summary: `Invalid suite: ${validation.errors.join('; ')}`, run_id: 'error', infra_errors: 1, verifier_unavailable: true, cases: [] };
  const trialShapeErrors = suite.cases.map(caseTrialShapeError).filter((error): error is string => error !== null);
  if (trialShapeErrors.length) return { suite: name, type: suite.type ?? 'unknown', passed: false, score: 0, pass_to_k: 0, pass_at_k: 0, summary: `Invalid suite: ${trialShapeErrors.join('; ')}`, run_id: 'error', infra_errors: 1, verifier_unavailable: true, cases: [] };
  const threshold = suite.pass_threshold ?? 0.75;
  const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const started = Date.now();
  const caseResults: { id: string; mean_score: number; pass_to_k: number; pass_at_k: number; infra_errors: number; asserts: AssertResult[]; trials: { passed: boolean; unavailable?: boolean }[]; adversarial?: boolean; unavailable?: boolean; models?: ReturnType<typeof ladderModels> }[] = [];
  // Image calibration uses the same resolved status as text. An explicit suite
  // override remains provisional because it is a different execution path.
  const calibrationSuiteDirs = defaultSuiteDirs();
  const calibration = defaultJudgeLevel(name, undefined, calibrationSuiteDirs);
  const ladderLevel = suite.judge_model ? judgeLevelForModel(suite.judge_model) : suite.judge_level ?? calibration.level;
  const overridden = !!(deps.suite || deps.suitePath || deps.deterministic || deps.rubric || deps.ladder);
  const judgeCalibrated = !overridden && !suite.judge_model && calibration.calibrated && ladderLevel === calibration.level;

  for (const c of suite.cases) {
    const img = resolveImage(c.image, path ?? join(process.cwd(), `${name}.yaml`));
    const results = await applyImageAsserts(img, c, { suite: name, allowIdentity: suite.allow_identity, publicMaterial: suite.public_material, level: ladderLevel,
      deterministic: deps.deterministic, rubric: deps.rubric, ladder: deps.ladder });
    const models = results.some((r) => !r.skipped && (r.type === 'meaning-ladder' || r.type === 'not-meaning-ladder'))
      ? ladderModels(c.generated_by, suite.public_material ?? false) : undefined;
    const verdict = scoreAssertions(results, threshold);
    const score = verdict.score;
    const unavailable = results.some((r) => r.unavailable);
    const det = results.filter((r) => !isJudgedAssert(r.type));
    const judgedR = results.filter((r) => isJudgedAssert(r.type));
    const trialCount = judgedR[0]?.requested_trials ?? 1;
    const trialVerdicts = Array.from({ length: trialCount }, (_, t) => {
      const trialRows = results.map((r) => r.trials
        ? { ...r, ...r.trials[t], unavailable: r.trials[t]?.unavailable ?? r.unavailable, unknown: r.trials[t]?.unknown ?? r.unknown }
        : r);
      const trialUnavailable = trialRows.some((r) => r.unavailable || (r.trials && !r.trials[t]));
      // An adversarial case passes a trial only when its deterministic checks
      // pass and every judged assertion rejects it with an actual verdict.
      const trialPassed = c.expect === 'fail'
        ? !trialUnavailable && det.every((r) => r.passed) && judgedR.length > 0 && judgedR.every((r) => {
          const jt = r.trials?.[t];
          return jt !== undefined && !jt.unavailable && !jt.unknown && !jt.passed;
        })
        : !trialUnavailable && scoreAssertions(trialRows, threshold).passed;
      return { passed: trialPassed, ...(trialUnavailable ? { unavailable: true } : {}) };
    });
    const passToK = !unavailable && trialVerdicts.length === trialCount && trialVerdicts.every((t) => t.passed) ? 1 : 0;
    const passAtK = !unavailable && trialVerdicts.some((t) => t.passed) ? 1 : 0;
    caseResults.push({ id: c.id, mean_score: score, pass_to_k: passToK, pass_at_k: passAtK, infra_errors: unavailable ? 1 : 0, asserts: results, trials: trialVerdicts, ...(c.expect === 'fail' ? { adversarial: true } : {}), ...(unavailable ? { unavailable: true } : {}), ...(models ? { models } : {}) });
    if (models?.same_family) console.log(`     ⚠️ same family: generator ${models.generator} and a judge share a family`);
    console.log(`  ${c.id}: ${passToK ? '✅' : '❌'} ${(score * 100).toFixed(0)}%${c.expect === 'fail' ? (unavailable ? ' (adversarial: ⚠️ verifier unavailable — no verdict)' : passToK ? ' (adversarial: 🪤 caught)' : ' (adversarial: ❌ MISSED — the judge passed an unrelated image, or an assert failed)') : ''}`);
    for (const r of results) console.log(`     ${r.passed ? '·' : '✗'} ${r.type}: ${r.reason}`);
  }

  const suiteType = suite.type ?? 'capability';
  const { meanScore, passToK, passAtK, stats, adversarial, passed: passedByScore } = imageSuiteVerdict(caseResults, threshold, suiteType);
  const infraErrors = caseResults.reduce((sum, c) => sum + c.infra_errors, 0);
  const verifierUnavailable = infraErrors > 0;
  const passed = !verifierUnavailable && passedByScore;
  const judgedCount = suite.cases.flatMap((c) => c.assert).filter((a) => isJudgedAssert(a.type)).length;
  const provisional = provisionalReport(name, judgedCount, { resultsDir: deps.resultsDir ?? RESULTS_DIR, suiteDirs: calibrationSuiteDirs });
  if (judgedCount && !judgeCalibrated && !provisional.provisional) {
    provisional.provisional = true;
    provisional.reason = 'runtime suite or judge override is not covered by calibration';
  }
  const result: SuiteResult = {
    ...(evidence ? { evidence } : {}),
    suite: name, type: suiteType, passed, score: meanScore, pass_to_k: passToK, pass_at_k: passAtK,
    summary: verifierUnavailable
      ? `verifier unavailable — ${infraErrors} image case${infraErrors === 1 ? '' : 's'} had no evaluator verdict; no verdict`
      : `image suite: pass ${(passToK * 100).toFixed(0)}%, mean ${(meanScore * 100).toFixed(1)}% ±${(stats.sem * 100).toFixed(1)}${adversarial.cases ? `, adversarial ${adversarial.caught}/${adversarial.cases} caught` : ''}`,
    run_id: runId,
    infra_errors: infraErrors,
    verifier_unavailable: verifierUnavailable,
    cases: caseResults.map((c) => ({ id: c.id, mean_score: c.mean_score, pass_to_k: c.pass_to_k, pass_at_k: c.pass_at_k, infra_errors: c.infra_errors })),
    stats, adversarial, judged_residue: undefined, agent_level: undefined,
    judge_level: caseResults.some((c) => c.models) ? ladderLevel : 'vision', judge_calibrated: judgeCalibrated,
    provisional: provisional.provisional, provisional_age_days: provisional.age_days,
    provisional_reason: provisional.reason,
    ...calibrationProvenance(name, judgedCount > 0 && judgeCalibrated, calibrationSuiteDirs),
    duration_ms: Date.now() - started, ts: new Date().toISOString(),
  };
  const experiment = Object.keys(deps).length > 0;
  const dir = join(deps.resultsDir ?? (experiment ? join(RESULTS_DIR, 'experiments') : RESULTS_DIR), name);
  mkdirSync(join(dir, runId), { recursive: true });
  writeFileSync(join(dir, runId, 'run.json'), JSON.stringify({ ...result, detail: caseResults }, null, 2));
  if (!verifierUnavailable) writeFileSync(join(dir, 'latest.json'), JSON.stringify(result, null, 2));
  try {
    const { updateSkillStates } = await import('./EvalState.ts');
    if (!experiment) updateSkillStates(name);
  } catch (e) {
    console.error(`  (EvalState update skipped: ${(e as Error).message})`);
  }
  return result;
}

if (import.meta.main) {
  const { values } = parseArgs({ args: Bun.argv.slice(2), options: { suite: { type: 'string', short: 's' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } } });
  if (values.help || !values.suite) {
    console.log(`ImageEvalRunner — visual suite runner\n\n  bun ImageEvalRunner.ts -s <suite> [--json]`);
    process.exit(values.help ? 0 : 1);
  }
  console.log(`\nRunning image suite: ${values.suite}\n`);
  const r = await runImageSuite(values.suite);
  if (values.json) console.log(JSON.stringify(r, null, 2));
  else console.log(`\n📊 ${r.verifier_unavailable ? '⚠️ NO VERDICT' : r.passed ? '✅ PASSED' : '❌ BELOW THRESHOLD'}: ${r.suite} — ${r.summary}`);
  process.exit(r.verifier_unavailable ? 2 : r.passed ? 0 : 1);
}
