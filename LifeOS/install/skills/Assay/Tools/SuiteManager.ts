#!/usr/bin/env bun
/**
 * SuiteManager — v2 suite inventory, saturation, and graduation.
 *
 * Lists every runnable v2 suite (USER layer first, then the skill's own),
 * joined with its latest result, judged residue, and saturation status.
 * Saturation (Anthropic lifecycle): a capability suite whose last N runs all
 * hit pass^k 100% has stopped providing signal — graduate it to regression.
 *
 *   bun SuiteManager.ts list [--json]
 *   bun SuiteManager.ts saturation [--runs 3]
 *   bun SuiteManager.ts graduate <suite>     # capability → regression (USER-layer suites only)
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assayUserDir, getClaudeDir } from '../../../LIFEOS/TOOLS/Paths.ts';
import { parse as parseYaml } from 'yaml';
import { isModelAssert, isJudgedAssert, evaluateDeterministic, type Assertion } from './Assertions.ts';

/**
 * ISC-38 (eval re-evaluation ISA): a judged suite proves its judge is
 * load-bearing by keeping at least one ADVERSARIAL fixture — a case with an
 * `adversarial_output` that passes every deterministic assert on that case and
 * is therefore only catchable by the judged residue. No such fixture means the
 * asserts might be doing all the work and the judge is untested debt; a fixture
 * that fails its own deterministic asserts is not adversarial, it is just wrong.
 * Pure over the parsed suite; the runner never needs a model call to validate.
 */
export type SuiteModality = 'text' | 'image';
interface SuiteCase {
  id?: string;
  prompt?: string;
  image?: string;
  expect?: string;
  assert?: Assertion[];
  adversarial_output?: string;
  threshold?: number;
}
interface ValidatableSuite {
  requires_context?: string[];
  name?: string;
  trials?: number;
  pass_threshold?: number;
  subject_timeout_ms?: number;
  cases?: SuiteCase[];
}

export interface SuiteValidation { name: string; modality: SuiteModality; judged: boolean; ok: boolean; errors: string[]; adversarial_cases: string[] }

const TEXT_ASSERTS = new Set([
  'equals', 'contains', 'icontains', 'contains-all', 'contains-any', 'regex', 'starts-with', 'ends-with',
  'is-json', 'contains-json', 'max-length', 'min-length', 'llm-rubric', 'llm-assert',
]);
const IMAGE_ASSERTS = new Set([
  'dimensions', 'min-width', 'min-height', 'aspect', 'format', 'max-bytes', 'luminance-max', 'luminance-min',
  'ocr-contains', 'ocr-word-ratio', 'vision-rubric', 'meaning-ladder',
]);
const SCORE_ASSERTS = new Set(['llm-rubric', 'llm-assert', 'vision-rubric', 'meaning-ladder', 'luminance-max', 'luminance-min', 'ocr-word-ratio']);
const LENGTH_ASSERTS = new Set(['max-length', 'min-length', 'min-width', 'min-height', 'max-bytes']);

function baseType(type: unknown): string | null {
  if (typeof type !== 'string' || !type.trim()) return null;
  return type.startsWith('not-') ? type.slice(4) : type;
}

function positiveInteger(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function score(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 1;
}

function inferModality(cases: SuiteCase[], explicit?: SuiteModality): SuiteModality {
  if (explicit) return explicit;
  return cases.some((c) => typeof c.image === 'string') ? 'image' : 'text';
}

/**
 * Validate the exact schema a runner consumes. `modality` is optional for static
 * inventory callers, but runners must pass their own mode so stray fields cannot
 * be silently ignored by the other lane.
 */
export function validateSuite(suite: ValidatableSuite, modality?: SuiteModality): SuiteValidation {
  if (!suite || typeof suite !== 'object' || Array.isArray(suite)) return { name: '(invalid)', modality: modality ?? 'text', judged: false, ok: false, errors: ['suite must be an object'], adversarial_cases: [] };
  const name = suite.name ?? '(unnamed)';
  const cases = Array.isArray(suite.cases) ? suite.cases : [];
  if (cases.some((c) => !c || typeof c !== 'object' || Array.isArray(c) || (c.assert !== undefined && (!Array.isArray(c.assert) || c.assert.some((a) => !a || typeof a !== 'object' || Array.isArray(a)))))) {
    return { name, modality: modality ?? 'text', judged: false, ok: false, errors: ['cases and assertions must be objects in arrays'], adversarial_cases: [] };
  }
  const errors: string[] = [];
  if (suite.requires_context !== undefined && (!Array.isArray(suite.requires_context) || !suite.requires_context.length || suite.requires_context.some(key => typeof key !== 'string' || !key.trim()))) errors.push('requires_context must name nonempty harness context receipts');
  const resolvedModality = inferModality(cases, modality);
  if (!Array.isArray(suite.cases) || cases.length === 0) errors.push(`suite ${name} must contain at least one case`);
  if (suite.trials !== undefined && !positiveInteger(suite.trials)) errors.push(`suite ${name}: trials must be a positive integer`);
  if (suite.subject_timeout_ms !== undefined && !positiveInteger(suite.subject_timeout_ms)) errors.push(`suite ${name}: subject_timeout_ms must be a positive integer`);
  if (suite.pass_threshold !== undefined && !score(suite.pass_threshold)) errors.push(`suite ${name}: pass_threshold must be a finite number in (0, 1]`);

  const supported = resolvedModality === 'text' ? TEXT_ASSERTS : IMAGE_ASSERTS;
  for (const c of cases) {
    const id = c.id ?? '?';
    if (!Array.isArray(c.assert) || c.assert.length === 0) errors.push(`case ${id}: assert must contain at least one assertion`);
    if (resolvedModality === 'text') {
      if (typeof c.prompt !== 'string' || !c.prompt.trim()) errors.push(`case ${id}: text suite cases need a non-empty prompt`);
      if (c.image !== undefined) errors.push(`case ${id}: text suite cases must not declare image`);
      if (c.expect !== undefined) errors.push(`case ${id}: text suite cases must not declare expect`);
    } else {
      if (typeof c.image !== 'string' || !c.image.trim()) errors.push(`case ${id}: image suite cases need a non-empty image`);
      if (c.prompt !== undefined) errors.push(`case ${id}: image suite cases must not declare prompt`);
      if (c.adversarial_output !== undefined) errors.push(`case ${id}: image suite cases must not declare adversarial_output`);
      if (c.expect !== undefined && c.expect !== 'pass' && c.expect !== 'fail') errors.push(`case ${id}: image expect must be pass or fail`);
    }
    if (c.threshold !== undefined && !score(c.threshold)) errors.push(`case ${id}: threshold must be a finite number in (0, 1]`);
    for (const a of c.assert ?? []) {
      const base = baseType(a?.type);
      if (!base || !supported.has(base)) {
        errors.push(`case ${id}: assertion type ${typeof a?.type === 'string' ? `\`${a.type}\`` : 'is missing'} is unsupported for the ${resolvedModality} runner`);
        continue;
      }
      if (a.weight !== undefined && !(typeof a.weight === 'number' && Number.isFinite(a.weight) && a.weight > 0)) errors.push(`case ${id}: assertion ${a.type} weight must be a positive finite number`);
      if (base === 'llm-assert') {
        const assertions = Array.isArray(a.value) ? a.value : [a.value];
        if (!assertions.length || assertions.some((v) => typeof v !== 'string' || !v.trim())) errors.push(`case ${id}: llm-assert needs non-empty assertion text`);
      }
      if (['llm-rubric', 'vision-rubric'].includes(base) && (typeof a.value !== 'string' || !a.value.trim())) errors.push(`case ${id}: ${base} needs a non-empty rubric`);
      if (a.threshold !== undefined) {
        const validThreshold = SCORE_ASSERTS.has(base) ? score(a.threshold)
          : LENGTH_ASSERTS.has(base) ? typeof a.threshold === 'number' && Number.isFinite(a.threshold) && a.threshold >= 0
          : typeof a.threshold === 'number' && Number.isFinite(a.threshold);
        if (!validThreshold) errors.push(`case ${id}: assertion ${a.type} has an invalid threshold`);
      }
      const assertionTrials = (a as Assertion & { trials?: unknown }).trials;
      if (assertionTrials !== undefined && !positiveInteger(assertionTrials)) errors.push(`case ${id}: assertion ${a.type} trials must be a positive integer`);
    }
  }
  const judged = cases.some((c) => (c.assert ?? []).some((a) => isJudgedAssert(a.type)));
  const adversarial_cases: string[] = [];
  if (!judged) return { name, modality: resolvedModality, judged, ok: errors.length === 0, errors, adversarial_cases };
  for (const c of cases) {
    // Image lane: the fixture is a whole case (`expect: fail`) — an unrelated image that passes the deterministic
    // image asserts and must fail the judged ones; the runner checks both halves when it runs.
    const hasJudged = (c.assert ?? []).some((a) => isJudgedAssert(a.type));
    if (resolvedModality === 'image') {
      if (c.expect !== 'fail') continue;
      if (hasJudged) adversarial_cases.push(c.id ?? '?');
      else errors.push(`case ${c.id ?? '?'}: \`expect: fail\` on a case with no judged assert — nothing can catch it, so it would be missed every run`);
      continue;
    }
    if (typeof c.adversarial_output !== 'string') continue;
    if (!hasJudged) { errors.push(`case ${c.id ?? '?'}: adversarial_output on a case with no judged assert — nothing can catch it, so it would be missed every run`); continue; }
    const det = (c.assert ?? []).filter((a) => !isJudgedAssert(a.type));
    const failing = det.filter((a) => !evaluateDeterministic(c.adversarial_output!, a).passed);
    if (failing.length) errors.push(`case ${c.id ?? '?'}: adversarial_output fails its own deterministic asserts (${failing.map((a) => a.type).join(', ')}) — not adversarial, just wrong`);
    else adversarial_cases.push(c.id ?? '?');
  }
  if (adversarial_cases.length === 0) errors.push(resolvedModality === 'image'
    ? `judged image suite ${name} has no adversarial fixture: add a case with \`expect: fail\` — an unrelated image that passes the deterministic asserts and only the judge can catch`
    : `judged suite ${name} has no adversarial fixture: add \`adversarial_output:\` to at least one case — an output that passes every deterministic assert and only the judge can catch`);
  return { name, modality: resolvedModality, judged, ok: errors.length === 0, errors, adversarial_cases };
}
export function validateSuiteFile(path: string, modality?: SuiteModality): SuiteValidation {
  return validateSuite(parseYaml(readFileSync(path, 'utf-8')) as ValidatableSuite, modality);
}

// The install root comes from Paths (CLAUDE_CONFIG_DIR, plugin root), never a fixed ~/.claude, so an isolated install finds its own suites and results.
const CLAUDE_ROOT = getClaudeDir();
const RESULTS_DIR = join(CLAUDE_ROOT, 'LIFEOS', 'MEMORY', 'STATE', 'Evals-Results');
const USER_SUITES = join(assayUserDir(join(CLAUDE_ROOT, 'LIFEOS')), 'Suites');
const SKILL_SUITES = join(import.meta.dir, '..', 'Suites');

interface SuiteInfo {
  name: string;
  path: string;
  layer: 'user' | 'skill';
  type: string;
  cases: number;
  judged_residue: number;
  last_run?: { ts?: string; score: number; pass_to_k: number; passed: boolean; judge_level?: string };
}

function suiteFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (d: string) => {
    for (const f of readdirSync(d, { withFileTypes: true })) {
      if (f.isDirectory() && !f.name.startsWith('_') && !f.name.startsWith('.')) walk(join(d, f.name));
      else if (/\.ya?ml$/.test(f.name)) out.push(join(d, f.name));
    }
  };
  walk(dir);
  return out;
}

export function listSuites(): SuiteInfo[] {
  const infos: SuiteInfo[] = [];
  const seen = new Set<string>();
  for (const [dir, layer] of [[USER_SUITES, 'user'], [SKILL_SUITES, 'skill']] as const) {
    for (const path of suiteFiles(dir)) {
      try {
        const s = parseYaml(readFileSync(path, 'utf-8')) as { name?: string; type?: string; cases?: { assert?: Assertion[] }[] };
        if (!Array.isArray(s.cases) || !s.name || seen.has(s.name)) continue; // v1 files and USER-shadowed names skipped
        seen.add(s.name);
        const asserts = s.cases.flatMap((c) => c.assert ?? []);
        const judged = asserts.filter((a) => isModelAssert(a.type)).length;
        const info: SuiteInfo = {
          name: s.name,
          path,
          layer,
          type: s.type ?? 'regression',
          cases: s.cases.length,
          judged_residue: asserts.length ? judged / asserts.length : 0,
        };
        const latest = join(RESULTS_DIR, s.name, 'latest.json');
        if (existsSync(latest)) {
          try {
            const r = JSON.parse(readFileSync(latest, 'utf-8'));
            info.last_run = { ts: r.ts, score: r.score, pass_to_k: r.pass_to_k, passed: r.passed, judge_level: r.judge_level };
          } catch { /* corrupt latest — show suite without it */ }
        }
        infos.push(info);
      } catch { /* unparseable file — not a runnable suite */ }
    }
  }
  return infos;
}

// Last N runs of a suite, newest first (run ids sort chronologically by timestamp prefix).
function recentRuns(name: string, n: number): { pass_to_k: number }[] {
  const dir = join(RESULTS_DIR, name);
  if (!existsSync(dir)) return [];
  const runs = readdirSync(dir)
    .filter((d) => d.startsWith('run_'))
    .sort()
    .reverse()
    .slice(0, n);
  const out: { pass_to_k: number }[] = [];
  for (const r of runs) {
    try { out.push(JSON.parse(readFileSync(join(dir, r, 'run.json'), 'utf-8'))); } catch { /* skip */ }
  }
  return out;
}

function saturation(minRuns: number): void {
  console.log(`\n🌡️  SATURATION (capability suites with pass^k 100% across last ${minRuns} runs have stopped providing signal):\n`);
  for (const s of listSuites()) {
    const runs = recentRuns(s.name, minRuns);
    const saturated = runs.length >= minRuns && runs.every((r) => r.pass_to_k === 1);
    const tag = s.type === 'capability' && saturated ? '🎓 GRADUATE → regression' : saturated ? 'saturated (already regression)' : runs.length ? `pass^k trail: ${runs.map((r) => Math.round(r.pass_to_k * 100)).join(',')}%` : 'no runs yet';
    console.log(`   ${s.name} [${s.type}] — ${tag}`);
  }
}

function graduate(name: string): number {
  const s = listSuites().find((x) => x.name === name);
  if (!s) { console.error(`Unknown suite: ${name}`); return 1; }
  if (s.type === 'regression') { console.log(`${name} is already a regression suite.`); return 0; }
  if (s.layer !== 'user') {
    console.error(`${name} lives in the skill tree (${s.path}) — graduate by editing its type: field there; only USER-layer suites are auto-edited.`);
    return 1;
  }
  const raw = readFileSync(s.path, 'utf-8');
  if (!/^type:\s*capability\s*$/m.test(raw)) { console.error(`Could not find 'type: capability' line in ${s.path}`); return 1; }
  writeFileSync(s.path, raw.replace(/^type:\s*capability\s*$/m, 'type: regression'));
  console.log(`🎓 ${name} graduated: capability → regression (${s.path}). It now gates on pass^k at its threshold.`);
  return 0;
}

if (import.meta.main) {
  const [cmd, ...rest] = Bun.argv.slice(2);
  const arg = rest.find((value) => !value.startsWith('--'));
  const json = Bun.argv.includes('--json');
  if (cmd === 'list' || !cmd) {
    const suites = listSuites();
    if (json) console.log(JSON.stringify(suites, null, 2));
    else {
      console.log(`\n📋 SUITES (${suites.length}):\n`);
      for (const s of suites) {
        const lr = s.last_run ? `last: ${s.last_run.passed ? '✅' : '❌'} pass^k ${(s.last_run.pass_to_k * 100).toFixed(0)}% @ ${s.last_run.ts?.slice(0, 10) ?? '?'}` : 'never run';
        console.log(`   ${s.name} [${s.type}/${s.layer}] ${s.cases} cases, residue ${(s.judged_residue * 100).toFixed(0)}% — ${lr}`);
      }
    }
    process.exit(0);
  }
  if (cmd === 'saturation') {
    const runsFlagIdx = Bun.argv.indexOf('--runs');
    saturation(runsFlagIdx > -1 ? parseInt(Bun.argv[runsFlagIdx + 1]) : 3);
    process.exit(0);
  }
  if (cmd === 'graduate' && arg) process.exit(graduate(arg));
  if (cmd === 'validate') {
    const targets = arg ? listSuites().filter((s) => s.name === arg) : listSuites();
    if (arg && targets.length === 0) { console.error(`Unknown suite: ${arg}`); process.exit(1); }
    const reports = targets.map((s) => validateSuiteFile(s.path));
    if (json) console.log(JSON.stringify(reports, null, 2));
    else for (const r of reports) console.log(`  ${r.ok ? '✅' : r.judged ? '❌' : '·'} ${r.name}${r.judged ? ` (judged; adversarial: ${r.adversarial_cases.join(', ') || 'none'})` : ' (deterministic only)'}${r.errors.map((e) => `\n       ${e}`).join('')}`);
    process.exit(reports.every((r) => r.ok) ? 0 : 1);
  }
  if (cmd === 'show' && arg) {
    // The parsed suite as JSON (or the raw YAML): the shape a Test Strategy row can jq against.
    const s = listSuites().find((x) => x.name === arg);
    if (!s) { console.error(`Unknown suite: ${arg}`); process.exit(1); }
    const raw = readFileSync(s.path, 'utf-8');
    console.log(json ? JSON.stringify({ path: s.path, layer: s.layer, ...(parseYaml(raw) as object) }, null, 2) : raw);
    process.exit(0);
  }
  console.log(`SuiteManager — v2 suite inventory\n\n  bun SuiteManager.ts list [--json]\n  bun SuiteManager.ts show <suite> [--json]\n  bun SuiteManager.ts validate [suite] [--json]   # judged suites need an adversarial fixture\n  bun SuiteManager.ts saturation [--runs N]\n  bun SuiteManager.ts graduate <suite>`);
  process.exit(1);
}
