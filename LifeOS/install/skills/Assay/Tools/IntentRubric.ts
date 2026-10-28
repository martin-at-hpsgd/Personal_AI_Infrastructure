#!/usr/bin/env bun
/**
 * IntentRubric — a skill intent's Ideal State becomes the Assay rubric its output is graded on.
 *
 * SkillSystem.md § Intent anatomy: every intent opens with `## Ideal State` (testable outcome bullets) and
 * `## Anti-criteria` (what must never happen). This tool reads them through the one intent parser
 * (LIFEOS/TOOLS/lib/IntentSections.ts) and emits, in the suite format EvalRunner already reads:
 *   tiered through Proof's one compiler (compileIntent, ISC-29): a countable bullet becomes required regex asserts;
 *   a readable bullet one single-claim `llm-assert`; a readable Anti-criteria bullet one single-claim `not-llm-assert`.
 *   Every assert also carries a targeted `fixture`: an output that breaks exactly its bullet.
 * Every assert quotes its bullet and carries `derived_from: <intent path>#IS-n | #AC-n`, so EvalRunner's receipt names
 * the intent as the ideal state and `Calibrate.ts --residue` sees the lineage.
 *
 * Proof.ts imports `loadIntent` and `intentIdealState` from here, so "what an intent says done is" reaches the
 * per-run proof and the per-skill suite through the same code.
 *
 * Usage: see IntentRubric.help.md. Deterministic except `--compile-fixtures`, which makes one model call per case through
 * Inference.ts at the top level (compileFixtures, injectable).
 *
 * @version 2.0.0
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { parseIntent, intentFromPath } from '../../../LIFEOS/TOOLS/lib/IntentSections.ts';
import type { IdealStateRef } from '../../../LIFEOS/TOOLS/lib/ProofReceipt.ts';
import { invariant } from '../../../LIFEOS/TOOLS/Invariant.ts';
import { getClaudeDir } from '../../../LIFEOS/TOOLS/Paths.ts';
import { evaluateDeterministic, type Assertion } from './Assertions.ts';
import { validateSuite } from './SuiteManager.ts';
import { boundConflict, compileIntent, countablesIn, COUNT_PATTERNS, type Check, type CountBound, type InferenceFn } from './Proof.ts';
import { inference, type InferenceLevel } from '../../../LIFEOS/TOOLS/Inference.ts';

/** Bad input: a missing file, a non-intent path, a malformed flag (exit 64). */
export class IntentUsageError extends Error {}
/** The input is well formed but cannot yield a rubric: no Ideal State bullets, or the suite does not validate (exit 1). */
export class IntentGapError extends Error {}

export type LoadedIntent = {
  /** Absolute path of the intent file (an `Intents/<Name>.md`, or the SKILL.md of a skill with no Intents/). */
  path: string;
  skill: string;
  intent: string;
  /** sha256 of the intent file's bytes: the revision every check and receipt is bound to. */
  sha256: string;
  idealState: string[];
  antiCriteria: string[];
};

/** The bullet id a check or assert is keyed by: IS-1.. for Ideal State, AC-1.. for Anti-criteria. */
export const isId = (i: number): string => `IS-${i + 1}`;
export const acId = (i: number): string => `AC-${i + 1}`;

/** `skills/<Skill>/Intents/<Intent>.md`, or `skills/<Skill>/SKILL.md` (a skill that is its own single intent). */
export function intentNames(path: string): { skill: string; intent: string } | null {
  const named = intentFromPath(path);
  if (named) return named;
  const m = path.replace(/\\/g, '/').match(/(?:^|\/)skills\/([^/]+)\/SKILL\.md$/);
  return m ? { skill: m[1]!, intent: m[1]! } : null;
}

/** Reads and parses one intent. Throws IntentUsageError for a missing file or a path that is not an intent. */
export function loadIntent(path: string): LoadedIntent {
  const abs = resolve(path);
  if (!existsSync(abs)) throw new IntentUsageError(`intent not found: ${path}`);
  const names = intentNames(abs);
  if (!names) throw new IntentUsageError(`not an intent path: ${path} (expected skills/<Skill>/Intents/<Intent>.md or skills/<Skill>/SKILL.md)`);
  const bytes = readFileSync(abs);
  const parsed = parseIntent(bytes.toString('utf8'));
  return { path: abs, ...names, sha256: createHash('sha256').update(bytes).digest('hex'), idealState: parsed.idealState, antiCriteria: parsed.antiCriteria };
}

/** Why an intent cannot serve as an ideal state, or null when it can (at least one Ideal State bullet). */
export function intentGap(li: LoadedIntent): string | null {
  return li.idealState.length === 0 ? `intent ${li.skill}/${li.intent} has no "## Ideal State" bullets` : null;
}

/** An ideal-state reference that names an intent. The receipt schema has no `intent` kind yet, so it rides the `isa` shape (an intent is a small ISA) and says so in `source`. */
export type IntentIdealStateRef = Extract<IdealStateRef, { kind: 'isa' }> & { source: 'intent'; skill: string; intent: string };

export function intentIdealState(li: LoadedIntent): IntentIdealStateRef {
  const criteria = [...li.idealState.map((_b, i) => isId(i)), ...li.antiCriteria.map((_b, i) => acId(i))];
  return { kind: 'isa', path: li.path, revision: li.sha256, ...(criteria.length ? { criteria } : {}), source: 'intent', skill: li.skill, intent: li.intent };
}

/** Every intent file of a skill directory (Intents/*.md sorted), or its SKILL.md when it has no Intents/. */
export function skillIntentPaths(skillDir: string): string[] {
  const dir = resolve(skillDir);
  const intents = join(dir, 'Intents');
  if (existsSync(intents)) return readdirSync(intents).filter((f) => f.endsWith('.md')).sort().map((f) => join(intents, f));
  const skillMd = join(dir, 'SKILL.md');
  if (existsSync(skillMd)) return [skillMd];
  throw new IntentUsageError(`no Intents/ and no SKILL.md under ${skillDir}`);
}

const CLAUDE_ROOT = getClaudeDir();
/** The lineage path written into a suite: repo-relative under ~/.claude (EvalRunner resolves it there), absolute otherwise. */
export function lineagePath(abs: string): string {
  const rel = relative(CLAUDE_ROOT, abs);
  return !rel.startsWith('..') && !isAbsolute(rel) ? rel : abs;
}

/** The statement a must-not assert puts to the judge: TRUE would mean the output commits what the anti-criterion forbids. */
export function mustNotStatement(bullet: string): string {
  return `The output does what this anti-criterion forbids: "${bullet}"`;
}

/** A rubric assert: an Assertion plus the targeted fixture that breaks exactly its bullet. */
export type RubricAssert = Assertion & { fixture?: string };

/** Rewrites a pattern written for the m flag (^ and $ at line ends) so it means the same with no flags, as Assertions runs regexes. Pure. */
export function multilinePattern(pattern: string): string {
  let out = '', inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === '\\') { out += c + (pattern[i + 1] ?? ''); i++; continue; }
    if (inClass) { if (c === ']') inClass = false; out += c; continue; }
    if (c === '[') { inClass = true; out += c; if (pattern[i + 1] === '^') { out += '^'; i++; } continue; }
    out += c === '^' ? String.raw`(?<![^\n])` : c === '$' ? String.raw`(?![^\n])` : c;
  }
  return out;
}

/** A word as Proof counts one: a whitespace-separated token carrying a letter or digit. */
const WORD_TOKEN = String.raw`(?<!\S)[^\sA-Za-z0-9\u00C0-\uFFFF]*[A-Za-z0-9\u00C0-\uFFFF]\S*`;
/**
 * A regex that matches when `token` occurs at least n times, leftmost and non-overlapping as matchAll counts. Each step is
 * atomic (lookahead plus backreference), so a miss costs one pass over the text, never exponential backtracking. Pure.
 */
export function atLeastPattern(token: string, n: number): string {
  invariant(Number.isInteger(n) && n >= 1, 'atLeastPattern: n is a positive integer');
  return String.raw`^(?:(?=([\s\S]*?(?:${token})))\1){${n}}`;
}
/** Trimmed length of at least n characters (Proof's countChars, counted in UTF-16 units). */
function charsAtLeast(n: number): string {
  return n === 1 ? String.raw`\S` : String.raw`^\s*\S[\s\S]{${n - 2},}\S`;
}

/** The unit a code fixture repeats to break a count check. */
function fixtureUnit(c: Check): { unit: string; join: string } {
  if (c.type === 'word-count') return { unit: 'word', join: ' ' };
  if (c.type === 'length-chars') return { unit: 'x', join: '' };
  const byPattern: Record<string, string> = { [COUNT_PATTERNS.bullets]: '- item\n', [COUNT_PATTERNS.headings]: '# Heading\n', [COUNT_PATTERNS.links]: 'https://example.com/p ', [COUNT_PATTERNS.sentences]: 'A sentence. ', [COUNT_PATTERNS.paragraphs]: 'A paragraph.\n\n' };
  return { unit: byPattern[c.pattern ?? ''] ?? '', join: '' };
}

/**
 * One compiled code check → the deterministic asserts that measure it in an eval suite, each required and each with a
 * fixture that breaks it. A fixture that does not actually fail its assert is left off, never shipped. Null for a check
 * type the text runner cannot measure (the caller falls back to a judged assert).
 */
export function checkAsserts(c: Check, derivedFrom: string): RubricAssert[] | null {
  const token = c.type === 'word-count' ? WORD_TOKEN : c.type === 'count' && c.pattern ? (c.regex ? multilinePattern(c.pattern) : c.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) : null;
  const atLeast = (n: number): string => (c.type === 'length-chars' ? charsAtLeast(n) : atLeastPattern(token!, n));
  if (c.type === 'text-present' && c.pattern) return [{ type: 'icontains', value: c.pattern, required: true, weight: 1, derived_from: derivedFrom, fixture: '' }];
  if (c.type === 'text-absent' && c.pattern) return [{ type: 'not-icontains', value: c.pattern, required: true, weight: 1, derived_from: derivedFrom, fixture: c.pattern }];
  if (c.type === 'non-empty') return [{ type: 'regex', value: String.raw`\S`, required: true, weight: 1, derived_from: derivedFrom, fixture: '' }];
  if (!(c.type === 'length-chars' || token)) return null;
  const { unit, join } = fixtureUnit(c);
  const out: RubricAssert[] = [];
  const add = (a: RubricAssert, units: number): void => {
    const fixture = unit && units >= 0 ? Array.from({ length: units }, () => unit).join(join) : undefined;
    out.push(fixture !== undefined && !evaluateDeterministic(fixture, a).passed ? { ...a, fixture } : a);
  };
  const meta = { required: true, weight: 1, derived_from: derivedFrom, metric: c.type };
  if (c.min !== undefined && c.min > 0) add({ type: 'regex', value: atLeast(c.min), ...meta }, c.min - 1);
  if (c.max !== undefined) add({ type: 'not-regex', value: atLeast(c.max + 1), ...meta }, c.max + 1);
  return out.length ? out : null;
}

/**
 * The bound a measured assert holds the output to, read back from the pattern checkAsserts wrote, or null for any assert
 * that is not one (no count metric, not required, or a hand-written pattern in another shape). `source` is its bullet id.
 */
export function assertBound(a: Assertion): CountBound | null {
  if (a.required === false || (a.type !== 'regex' && a.type !== 'not-regex') || typeof a.value !== 'string') return null;
  const metric = a.metric;
  if (metric !== 'length-chars' && metric !== 'word-count' && metric !== 'count') return null;
  let n: number | null = null;
  let measure: string = metric;
  if (metric === 'length-chars') {
    const m = /^\^\\s\*\\S\[\\s\\S\]\{(\d+),\}\\S$/.exec(a.value);
    n = a.value === String.raw`\S` ? 1 : m ? Number(m[1]) + 2 : null;
  } else {
    const m = /^(.*)\{(\d+)\}$/s.exec(a.value);
    if (m && a.value.startsWith(String.raw`^(?:(?=([\s\S]*?(?:`)) { n = Number(m[2]); measure = `${metric}|${m[1]}`; }
  }
  if (n === null) return null;
  const source = a.derived_from ? a.derived_from.slice(a.derived_from.lastIndexOf('#') + 1) : '(hand-written)';
  return a.type === 'regex' ? { key: measure, what: metric, min: n, source } : { key: measure, what: metric, max: n - 1, source };
}

const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'are', 'has', 'have', 'its', 'keeps', 'kept', 'stays', 'stay', 'total', 'output', 'response', 'answer', 'than', 'each', 'every', 'any', 'one', 'all', 'not', 'from', 'into', 'long', 'length']);
/** True when a countable bullet also asks something the count cannot see ("3-5 bullets, each naming a source"). Pure. */
export function readableRemainder(bullet: string): boolean {
  let rest = bullet;
  for (const f of countablesIn(bullet).sort((x, y) => y.span[0] - x.span[0])) rest = rest.slice(0, f.span[0]) + ' ' + rest.slice(f.span[1]);
  return rest.toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= 3 && !STOP.has(w)).length >= 3;
}

/** The bullet a compiled intent check id names: `intent-is-2` or `intent-ac-1-2` → `{ section, index }` (0-based). */
function bulletOf(id: string): { section: 'is' | 'ac'; index: number } | null {
  const m = /^intent-(is|ac)-(\d+)(?:-\d+)?$/.exec(id);
  return m ? { section: m[1] as 'is' | 'ac', index: Number(m[2]) - 1 } : null;
}

/**
 * One intent → its rubric, tiered by Proof's compiler (ISC-29): each countable bullet becomes required regex asserts, each
 * readable bullet one single-claim llm-assert (a readable Anti-criteria bullet one not-llm-assert). A countable bullet that
 * also asks something readable keeps a judged assert for it, and a bullet the compiler drops (a count with no code counter)
 * falls back to a judged assert, so no bullet is ever ungraded. Order: Ideal State bullets, then Anti-criteria, each in turn.
 */
export function intentRubric(li: LoadedIntent): RubricAssert[] {
  const gap = intentGap(li);
  if (gap) throw new IntentGapError(`${gap}; a rubric needs at least one`);
  const lineage = lineagePath(li.path);
  const compiled = compileIntent(li, 'text');
  // A bullet set whose measured bounds cannot all hold is a broken parse or a broken intent; it is refused, never shipped as an unpassable rubric.
  if (compiled.conflict) throw new IntentGapError(`intent ${li.skill}/${li.intent} has ${compiled.conflict}`);
  const code = new Map<string, Check[]>();
  for (const c of compiled.checks) {
    const at = bulletOf(c.id);
    invariant(at !== null, `compileIntent check id names its bullet: ${c.id}`);
    if (c.type === 'glance') continue;
    const key = `${at.section}-${at.index}`;
    code.set(key, [...(code.get(key) ?? []), c]);
  }
  const judged = (section: 'is' | 'ac', b: string, ref: string): RubricAssert => section === 'is'
    ? { type: 'llm-assert', value: [b], weight: 1, derived_from: ref }
    : { type: 'not-llm-assert', value: [mustNotStatement(b)], weight: 1, derived_from: ref };
  const tier = (section: 'is' | 'ac', bullets: string[], id: (i: number) => string): RubricAssert[] => bullets.flatMap((b, i) => {
    const ref = `${lineage}#${id(i)}`;
    const checks = code.get(`${section}-${i}`) ?? [];
    const asserts = checks.flatMap((c) => checkAsserts(c, ref) ?? []);
    if (!asserts.length) return [judged(section, b, ref)];
    return readableRemainder(b) ? [...asserts, judged(section, b, ref)] : asserts;
  });
  const out = [...tier('is', li.idealState, isId), ...tier('ac', li.antiCriteria, acId)];
  const covered = new Set(out.map((a) => a.derived_from));
  invariant(covered.size === li.idealState.length + li.antiCriteria.length, 'every bullet has at least one assert');
  return out;
}

/** A case a suite runs: the prompt from real use, which intent it exercises (required when the source has several), targeted fixtures keyed by bullet id (IS-n, AC-n), and any hand-written asserts for what the bullets do not cover. */
export type CaseSpec = { id?: string; prompt: string; intent?: string; negative?: boolean; adversarial_output?: string; fixtures?: Record<string, string>; reference?: string; assert?: Assertion[] };

const FIXTURE_SYSTEM = `You write adversarial fixtures for an eval. For each criterion id you are given, write one realistic output for the
user prompt that meets EVERY other criterion and breaks exactly that one, subtly, the way a capable but careless writer would.
Never mention the criteria, never write a bare claim of completion, never leave the task undone. Reply with one JSON object
mapping each criterion id to its fixture text, and nothing else.`;

/**
 * One model call that writes, for every bullet of an intent, an output that breaks exactly that bullet and meets the rest.
 * Runs at the top level ("max", maximum intelligence for building the eval; the evals themselves run fast). Returns only
 * well-formed string entries for known ids; the caller still checks each against the case's deterministic asserts.
 */
export async function compileFixtures(li: LoadedIntent, prompt: string, opts: { inferenceFn?: InferenceFn; level?: InferenceLevel; timeout?: number } = {}): Promise<Record<string, string>> {
  const ids = [...li.idealState.map((b, i) => [isId(i), `Ideal State: ${b}`]), ...li.antiCriteria.map((b, i) => [acId(i), `Must never happen: ${b}`])];
  const userPrompt = `## USER PROMPT\n${prompt}\n\n## CRITERIA (${li.skill} ${li.intent})\n${ids.map(([id, t]) => `${id}: ${t}`).join('\n')}`;
  const res = await (opts.inferenceFn ?? inference)({ systemPrompt: FIXTURE_SYSTEM, userPrompt, level: opts.level ?? 'max', timeout: opts.timeout ?? 60_000 });
  if (!res.success) throw new IntentGapError(`fixture compile failed for ${li.skill}/${li.intent}: ${res.error}`);
  const m = /\{[\s\S]*\}/.exec(res.output);
  let parsed: unknown;
  try { parsed = m ? JSON.parse(m[0]) : null; } catch { parsed = null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new IntentGapError(`fixture compile for ${li.skill}/${li.intent} returned no JSON object`);
  const known = new Set(ids.map(([id]) => id));
  return Object.fromEntries(Object.entries(parsed as Record<string, unknown>).filter(([k, v]) => known.has(k) && typeof v === 'string' && v.trim()) as [string, string][]);
}

export type SuiteSpec = {
  name: string;
  intents: LoadedIntent[];
  cases: CaseSpec[];
  type?: 'capability' | 'regression';
  trials?: number;
  pass_threshold?: number;
  system_prompt_file?: string;
  /** Pins the judge level (low|medium|high). Omit for the calibrated-cheap default (EvalRunner). */
  judge_level?: 'low' | 'medium' | 'high';
};

const SUITE_NAME = /^[a-z0-9][a-z0-9-]{1,63}$/;

/** Builds the suite object: each case gets its intent's rubric, then its own hand-written asserts. Validated by SuiteManager before it is returned. */
export function buildSuite(spec: SuiteSpec): Record<string, unknown> {
  if (!SUITE_NAME.test(spec.name)) throw new IntentUsageError(`suite name must be kebab-case (got ${JSON.stringify(spec.name)})`);
  const usable = spec.intents.filter((li) => !intentGap(li));
  if (usable.length === 0) throw new IntentGapError(`no intent has Ideal State bullets: ${spec.intents.map((li) => `${li.skill}/${li.intent}`).join(', ') || '(none)'}`);
  if (spec.cases.length === 0) throw new IntentUsageError('at least one case (--prompt or --cases) is required; cases come from real use');
  const byName = new Map(usable.map((li) => [li.intent, li]));
  const seen = new Set<string>();
  const cases = spec.cases.map((c, n) => {
    if (typeof c.prompt !== 'string' || !c.prompt.trim()) throw new IntentUsageError(`case ${n + 1}: prompt is required`);
    const li = c.intent ? byName.get(c.intent) : usable.length === 1 ? usable[0] : undefined;
    if (!li) throw new IntentUsageError(c.intent ? `case ${n + 1}: intent ${c.intent} is not one of ${[...byName.keys()].join(', ')} (or has no Ideal State)` : `case ${n + 1}: name its intent (one of ${[...byName.keys()].join(', ')})`);
    let id = c.id && /^[A-Za-z0-9_-]{1,80}$/.test(c.id) ? c.id : `${li.intent.toLowerCase()}_${n + 1}`;
    while (seen.has(id)) id = `${id}_x`;
    seen.add(id);
    const rubric = intentRubric(li).map((a) => (c.reference ? { ...a, reference: c.reference } : a));
    const asserts: RubricAssert[] = [...rubric, ...(c.assert ?? [])];
    // The general catch, on the whole case (rubric plus hand-written asserts): measured bounds with an empty window are refused by name.
    const conflict = boundConflict(asserts.flatMap((a) => assertBound(a) ?? []));
    if (conflict) throw new IntentGapError(`case ${id}: ${conflict}`);
    const deterministic = asserts.filter((a) => !/llm-/.test(a.type));
    // A judged bullet's fixture is kept only when it passes every deterministic assert of the case: one that fails a
    // code assert is not adversarial, just wrong (SuiteManager), and only the judge may be the thing that catches it.
    const passesCode = (text: string): boolean => deterministic.every((a) => evaluateDeterministic(text, a).passed);
    for (const a of asserts) {
      if (!/llm-/.test(a.type) || !a.derived_from) continue;
      const fixture = c.fixtures?.[a.derived_from.slice(a.derived_from.lastIndexOf('#') + 1)];
      if (typeof fixture === 'string' && fixture.trim() && passesCode(fixture)) a.fixture = fixture;
    }
    const adversarial = typeof c.adversarial_output === 'string' ? c.adversarial_output : asserts.find((a) => /llm-/.test(a.type) && a.fixture)?.fixture;
    return {
      id,
      prompt: c.prompt,
      ...(c.negative ? { negative: true } : {}),
      ...(typeof adversarial === 'string' ? { adversarial_output: adversarial } : {}),
      assert: asserts,
    };
  });
  if (!cases.some((c) => 'adversarial_output' in c) && cases.some((c) => c.assert.some((a) => /llm-/.test(a.type)))) {
    throw new IntentGapError('no adversarial fixture: give a case fixtures (keyed IS-n / AC-n) or adversarial_output, or pass --compile-fixtures; there is no canned default');
  }
  const suite: Record<string, unknown> = {
    name: spec.name,
    type: spec.type ?? 'capability',
    pass_threshold: spec.pass_threshold ?? 0.75,
    trials: spec.trials ?? 3,
    ...(spec.system_prompt_file ? { system_prompt_file: spec.system_prompt_file } : {}),
    ...(spec.judge_level ? { judge_level: spec.judge_level } : {}),
    cases,
  };
  const v = validateSuite(suite as never);
  if (!v.ok) throw new IntentGapError(`generated suite does not validate: ${v.errors.join('; ')}`);
  return suite;
}

/** The YAML text for a suite, headed with where its rubric came from. */
export function suiteYaml(suite: Record<string, unknown>, intents: LoadedIntent[]): string {
  const head = [
    `# Generated by skills/Assay/Tools/IntentRubric.ts from the Ideal State and Anti-criteria of:`,
    ...intents.map((li) => `#   ${lineagePath(li.path)} (sha256 ${li.sha256.slice(0, 12)})`),
    `# Regenerate after the intent changes; hand-written asserts belong in the cases file, not here.`,
  ];
  return `${head.join('\n')}\n${stringifyYaml(suite, { lineWidth: 0 })}`;
}

/** Writes the suite atomically. Refuses to overwrite unless `force`. */
export function writeSuite(out: string, text: string, force: boolean): string {
  const abs = resolve(out);
  if (existsSync(abs) && !force) throw new IntentUsageError(`${out} exists; pass --force to replace it`);
  const parsed = parseYaml(text) as { name?: unknown; cases?: unknown };
  invariant(typeof parsed?.name === 'string' && Array.isArray(parsed.cases) && parsed.cases.length > 0, 'a suite file round-trips to a named suite with cases');
  mkdirSync(dirname(abs), { recursive: true });
  const tmp = `${abs}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, abs);
  return abs;
}

/** An intent file, or every intent of a skill directory. */
export function loadSource(source: string): LoadedIntent[] {
  const abs = resolve(source);
  if (!existsSync(abs)) throw new IntentUsageError(`not found: ${source}`);
  return /\.md$/.test(abs) ? [loadIntent(abs)] : skillIntentPaths(abs).map(loadIntent);
}

function readCases(path: string): CaseSpec[] {
  const abs = resolve(path);
  if (!existsSync(abs)) throw new IntentUsageError(`cases file not found: ${path}`);
  const raw = parseYaml(readFileSync(abs, 'utf8')) as unknown;
  const list = Array.isArray(raw) ? raw : (raw as { cases?: unknown })?.cases;
  if (!Array.isArray(list)) throw new IntentUsageError(`${path}: expected a list of cases (or {cases: [...]})`);
  return list as CaseSpec[];
}

const USAGE = `usage:
  IntentRubric.ts rubric <intent.md | skills/<Skill>> [--json]
  IntentRubric.ts suite <intent.md | skills/<Skill>> --name <suite-name> (--prompt "<p>" [--prompt ...] | --cases <cases.yaml>)
                  [--system-prompt-file <path>] [--judge-level low|medium|high] [--type capability|regression] [--trials N] [--threshold 0.75] [--compile-fixtures] [--out <file.yaml> [--force]] [--json]
exit: 0 ok · 1 a source has no Ideal State bullets or the suite does not validate · 64 usage   (see IntentRubric.help.md)`;

function flags(argv: string[]): { pos: string[]; get: (n: string) => string | undefined; all: (n: string) => string[]; has: (n: string) => boolean } {
  const pos: string[] = [];
  const map = new Map<string, string[]>();
  const bool = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) { pos.push(a); continue; }
    const name = a.slice(2);
    if (name === 'json' || name === 'force' || name === 'compile-fixtures') { bool.add(name); continue; }
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new IntentUsageError(`--${name} needs a value`);
    map.set(name, [...(map.get(name) ?? []), v]);
    i++;
  }
  return { pos, get: (n) => map.get(n)?.at(-1), all: (n) => map.get(n) ?? [], has: (n) => bool.has(n) };
}

export async function main(argv: string[], deps: { inferenceFn?: InferenceFn } = {}): Promise<number> {
  const [cmd, ...rest] = argv;
  try {
    const f = flags(rest);
    const source = f.pos[0];
    if (cmd === 'help' || cmd === '--help' || cmd === '-h') { console.log(USAGE); return 0; }
    if (!source) throw new IntentUsageError('a source (intent file or skill directory) is required');
    const intents = loadSource(source);
    if (cmd === 'rubric') {
      const out = intents.map((li) => ({ skill: li.skill, intent: li.intent, path: lineagePath(li.path), sha256: li.sha256, gap: intentGap(li), assert: intentGap(li) ? [] : intentRubric(li) }));
      if (f.has('json')) console.log(JSON.stringify(out, null, 2));
      else for (const r of out) {
        console.log(`# ${r.skill}/${r.intent}  ${r.path}`);
        console.log(r.gap ? `# SKIPPED: ${r.gap}` : stringifyYaml({ assert: r.assert }, { lineWidth: 0 }));
      }
      return out.every((r) => r.gap) ? 1 : 0;
    }
    if (cmd === 'suite') {
      const name = f.get('name');
      if (!name) throw new IntentUsageError('--name is required');
      const prompts = f.all('prompt');
      const casesFile = f.get('cases');
      if (prompts.length && casesFile) throw new IntentUsageError('--prompt and --cases are two ways to give the cases; use one');
      const cases: CaseSpec[] = casesFile ? readCases(casesFile) : prompts.map((prompt) => ({ prompt }));
      const type = f.get('type');
      if (type !== undefined && type !== 'capability' && type !== 'regression') throw new IntentUsageError('--type must be capability or regression');
      const trials = f.get('trials') !== undefined ? Number(f.get('trials')) : undefined;
      if (trials !== undefined && !(Number.isInteger(trials) && trials > 0)) throw new IntentUsageError('--trials must be a positive integer');
      const threshold = f.get('threshold') !== undefined ? Number(f.get('threshold')) : undefined;
      if (threshold !== undefined && !(threshold > 0 && threshold <= 1)) throw new IntentUsageError('--threshold must be in (0, 1]');
      for (const li of intents) { const g = intentGap(li); if (g) console.error(`skipped: ${g}`); }
      const judge = f.get('judge-level');
      if (judge !== undefined && !['low', 'medium', 'high'].includes(judge)) throw new IntentUsageError('--judge-level must be low, medium or high');
      if (f.has('compile-fixtures')) {
        const usableIntents = intents.filter((li) => !intentGap(li));
        for (const c of cases) {
          const li = c.intent ? usableIntents.find((x) => x.intent === c.intent) : usableIntents.length === 1 ? usableIntents[0] : undefined;
          if (li) c.fixtures = { ...(await compileFixtures(li, c.prompt, { inferenceFn: deps.inferenceFn })), ...(c.fixtures ?? {}) };
        }
      }
      const suite = buildSuite({ name, intents, cases, type: type as SuiteSpec['type'], trials, pass_threshold: threshold, system_prompt_file: f.get('system-prompt-file'), judge_level: judge as SuiteSpec['judge_level'] });
      const text = suiteYaml(suite, intents.filter((li) => !intentGap(li)));
      const out = f.get('out');
      if (out) {
        const written = writeSuite(out, text, f.has('force'));
        console.error(`suite ${name} → ${written}`);
      }
      if (f.has('json')) console.log(JSON.stringify(suite, null, 2));
      else if (!out) console.log(text);
      return 0;
    }
    throw new IntentUsageError(cmd ? `unknown command ${cmd}` : 'no command');
  } catch (e) {
    if (e instanceof IntentUsageError) { console.error(`${e.message}\n${USAGE}`); return 64; }
    if (e instanceof IntentGapError) { console.error(e.message); return 1; }
    throw e;
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
