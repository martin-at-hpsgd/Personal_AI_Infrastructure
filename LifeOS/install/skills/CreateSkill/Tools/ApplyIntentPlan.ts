#!/usr/bin/env bun
/**
 * ApplyIntentPlan — rebuilds one intent (or one SKILL.md) to the intent standard
 * (LIFEOS/DOCUMENTATION/Skills/SkillSystem.md § Intent anatomy) from a plan a model
 * wrote, moving the original's lines verbatim. The model decides where each line
 * goes; it never retypes one. The only new prose is the title, the one-line summary,
 * the Ideal State and Anti-criteria bullets, and at most three short connective
 * sentences per section.
 *
 * Usage (run from ~/.claude):
 *   bun skills/CreateSkill/Tools/ApplyIntentPlan.ts --plan <plan.json> [--allow-out <tsv>] [--check] [--json] [--skill-md]
 *
 * The plan (type IntentPlan below; unknown keys are refused at every level):
 *   file, sha256       the target, repo-relative or absolute, and the sha256 of its
 *                      current bytes, so a plan never applies to a file that changed
 *   title, summary     the new H1 and the one line under it (summary optional in --skill-md)
 *   frontmatter        { keep, contractRequires?, dropReason? }: keep the original
 *                      frontmatter verbatim (contract.requires merged in when given), or
 *                      drop it, which needs dropReason when the original had one
 *   idealState         ≥2 bullets; antiCriteria ≥1 bullet. In --skill-md, idealState is
 *                      always required (the skill-level Ideal State), antiCriteria required
 *                      when the skill has no Intents/*.md and optional otherwise
 *   preamble           --skill-md only: blocks placed between the H1 and the first H2
 *   sections           [{ title, blocks: [{from,to} | {text}] }] in output order
 *   cuts               [{ from, to, reason ≥12 chars }]
 *
 * Refused (exit 1, nothing written) unless: every non-blank original line after the
 * frontmatter sits in exactly one block range or cut, and no line sits in two; section
 * titles come from ALLOWED_SECTIONS, once each (--skill-md: free-form, never a voice,
 * done-family, Ideal State or Anti-criteria title); a text block is one line of at most
 * 280 characters, at most 3 per section; every moved line keeps its fence state; and
 * the result has zero IntentLint errors. The lint runs on the would-be file before
 * anything is written, so a failing plan leaves the file untouched.
 *
 * Moved ranges keep their exact bytes; leading and trailing blank lines of a range are
 * dropped, and a non-fenced `#` or `##` heading inside a moved range becomes `###`.
 * Two ranges in a row are joined with no blank line when the original had them
 * separated only by cut, non-blank lines (a cut table row or paragraph line), and with
 * one blank line otherwise.
 *
 * --allow-out appends one IntentPreserve allow line per token (fence line, code span,
 * URL, flag, guard line) the cuts took out of the file, carrying the reason of the cut
 * that held it: the cut log is the allow file. --check validates and prints the
 * would-be file and allow lines without writing either.
 *
 * Exit codes: 0 written (or valid under --check) · 1 plan refused · 2 git or file I/O
 * error · 64 usage error.
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { invariant } from '../../../LIFEOS/TOOLS/Invariant';
import { type Issue, lintIntentText, lintSkillText } from '../../../LIFEOS/TOOLS/IntentLint';
import {
  ALLOWED_SECTIONS,
  DONE_SECTION,
  VOICE_SECTION,
  fencedLines,
  intentFromPath,
} from '../../../LIFEOS/TOOLS/lib/IntentSections';
import {
  GitError,
  allowLine,
  appendAllowFile,
  frontmatterLineCount,
  joinLines,
  lostTokens,
  repoPath,
  repoRootOf,
  splitLines,
} from './Codemod';

// ── plan types ─────────────────────────────────────────────────────────────

export interface ContractRequirement { id: string; path: string; fields: string[]; produce?: string }
export interface PlanFrontmatter { keep: boolean; contractRequires?: ContractRequirement[]; dropReason?: string }
export interface RangeBlock { from: number; to: number }
export interface TextBlock { text: string }
export type Block = RangeBlock | TextBlock;
export interface PlanSection { title: string; blocks: Block[] }
export interface PlanCut { from: number; to: number; reason: string }
export interface IntentPlan {
  file: string;
  sha256: string;
  title: string;
  summary?: string;
  frontmatter: PlanFrontmatter;
  idealState?: string[];
  antiCriteria?: string[];
  preamble?: Block[];
  sections: PlanSection[];
  cuts: PlanCut[];
}
export type PlanMode = 'intent' | 'skill-md';

export const TEXT_BLOCK_MAX = 280;
export const TEXT_BLOCKS_PER_SECTION = 3;
export const CUT_REASON_MIN = 12;

/** The plan is wrong: reported with exit 1, every problem listed, nothing written. */
export class PlanRefusal extends Error {
  constructor(readonly problems: string[]) {
    super(problems.join('\n'));
    this.name = 'PlanRefusal';
  }
}
export class UsageError extends Error {
  constructor(message: string) { super(message); this.name = 'UsageError'; }
}

// ── plan validation ────────────────────────────────────────────────────────

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Validates the raw JSON against the plan shape for `mode`. Throws PlanRefusal listing every problem. */
export function validatePlan(raw: unknown, mode: PlanMode): IntentPlan {
  const problems: string[] = [];
  const bad = (msg: string) => { problems.push(msg); };
  const keys = (o: Obj, where: string, allowed: string[], required: string[]) => {
    for (const k of Object.keys(o)) if (!allowed.includes(k)) bad(`${where}: unknown key "${k}"`);
    for (const k of required) if (!(k in o)) bad(`${where}: missing "${k}"`);
  };
  const oneLine = (v: unknown, where: string): v is string => {
    if (typeof v !== 'string' || v.trim() === '') { bad(`${where}: must be a non-empty string`); return false; }
    if (/[\r\n]/.test(v)) { bad(`${where}: must be a single line`); return false; }
    return true;
  };
  const lineNo = (v: unknown, where: string): v is number => {
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) { bad(`${where}: must be a positive integer line number`); return false; }
    return true;
  };
  const range = (o: Obj, where: string) => {
    if (lineNo(o.from, `${where}.from`) && lineNo(o.to, `${where}.to`) && (o.from as number) > (o.to as number)) {
      bad(`${where}: from ${o.from} is after to ${o.to}`);
    }
  };
  const block = (b: unknown, where: string) => {
    if (!isObj(b)) { bad(`${where}: must be {from,to} or {text}`); return; }
    if ('text' in b) {
      keys(b, where, ['text'], ['text']);
      if (oneLine(b.text, `${where}.text`)) {
        const t = b.text as string;
        if (t.length > TEXT_BLOCK_MAX) bad(`${where}.text: ${t.length} characters; a connective sentence is at most ${TEXT_BLOCK_MAX}`);
        if (/^\s*(#|```|~~~)/.test(t)) bad(`${where}.text: may not open with a heading or fence marker`);
      }
    } else {
      keys(b, where, ['from', 'to'], ['from', 'to']);
      range(b, where);
    }
  };
  const blockList = (v: unknown, where: string) => {
    if (!Array.isArray(v) || v.length === 0) { bad(`${where}: must be a non-empty array of blocks`); return; }
    v.forEach((b, i) => block(b, `${where}[${i}]`));
    const texts = v.filter(b => isObj(b) && 'text' in b).length;
    if (texts > TEXT_BLOCKS_PER_SECTION) bad(`${where}: ${texts} text blocks; at most ${TEXT_BLOCKS_PER_SECTION} (new prose belongs in the Ideal State)`);
  };
  const bullets = (v: unknown, where: string, min: number) => {
    if (!Array.isArray(v)) { bad(`${where}: must be an array of strings`); return; }
    v.forEach((s, i) => {
      if (oneLine(s, `${where}[${i}]`) && /^\s*([-*+]|\d+[.)])\s/.test(s as string)) bad(`${where}[${i}]: carries its own list marker`);
    });
    if (v.filter(s => typeof s === 'string' && s.trim()).length < min) bad(`${where}: at least ${min} non-empty bullet(s) required`);
  };

  if (!isObj(raw)) throw new PlanRefusal(['plan: must be a JSON object']);
  const top = mode === 'intent'
    ? ['file', 'sha256', 'title', 'summary', 'frontmatter', 'idealState', 'antiCriteria', 'sections', 'cuts']
    : ['file', 'sha256', 'title', 'summary', 'frontmatter', 'idealState', 'antiCriteria', 'preamble', 'sections', 'cuts'];
  const required = mode === 'intent'
    ? ['file', 'sha256', 'title', 'summary', 'frontmatter', 'idealState', 'antiCriteria', 'sections', 'cuts']
    : ['file', 'sha256', 'title', 'frontmatter', 'sections', 'cuts'];
  keys(raw, 'plan', top, required);
  if ('file' in raw) oneLine(raw.file, 'file');
  if ('sha256' in raw && (typeof raw.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(raw.sha256))) bad('sha256: must be 64 lowercase hex characters');
  if ('title' in raw && oneLine(raw.title, 'title') && /^#/.test((raw.title as string).trim())) bad('title: give the text only, without "#"');
  if ('summary' in raw && oneLine(raw.summary, 'summary') && /^\s*(#|```|~~~)/.test(raw.summary as string)) bad('summary: may not open with a heading or fence marker');
  if ('idealState' in raw) bullets(raw.idealState, 'idealState', 2);
  if ('antiCriteria' in raw) bullets(raw.antiCriteria, 'antiCriteria', 1);
  if ('preamble' in raw) blockList(raw.preamble, 'preamble');

  const fm = raw.frontmatter;
  if ('frontmatter' in raw) {
    if (!isObj(fm)) bad('frontmatter: must be an object');
    else {
      keys(fm, 'frontmatter', mode === 'intent' ? ['keep', 'contractRequires', 'dropReason'] : ['keep', 'dropReason'], ['keep']);
      if (typeof fm.keep !== 'boolean') bad('frontmatter.keep: must be true or false');
      if ('dropReason' in fm && oneLine(fm.dropReason, 'frontmatter.dropReason') && (fm.dropReason as string).trim().length < CUT_REASON_MIN) {
        bad(`frontmatter.dropReason: at least ${CUT_REASON_MIN} characters`);
      }
      if (fm.keep === true && 'dropReason' in fm) bad('frontmatter.dropReason: only meaningful when keep is false');
      if ('contractRequires' in fm) {
        if (!Array.isArray(fm.contractRequires) || fm.contractRequires.length === 0) bad('frontmatter.contractRequires: must be a non-empty array');
        else {
          const ids = new Set<string>();
          fm.contractRequires.forEach((r, i) => {
            const where = `frontmatter.contractRequires[${i}]`;
            if (!isObj(r)) { bad(`${where}: must be an object`); return; }
            keys(r, where, ['id', 'path', 'fields', 'produce'], ['id', 'path', 'fields']);
            if (oneLine(r.id, `${where}.id`)) { if (ids.has(r.id as string)) bad(`${where}.id: duplicate "${r.id}"`); ids.add(r.id as string); }
            oneLine(r.path, `${where}.path`);
            if (!Array.isArray(r.fields) || r.fields.length === 0) bad(`${where}.fields: must be a non-empty array of strings`);
            else r.fields.forEach((f, j) => oneLine(f, `${where}.fields[${j}]`));
            if ('produce' in r) oneLine(r.produce, `${where}.produce`);
          });
        }
      }
    }
  }

  if ('sections' in raw) {
    if (!Array.isArray(raw.sections)) bad('sections: must be an array');
    else {
      const seen = new Set<string>();
      raw.sections.forEach((s, i) => {
        const where = `sections[${i}]`;
        if (!isObj(s)) { bad(`${where}: must be an object`); return; }
        keys(s, where, ['title', 'blocks'], ['title', 'blocks']);
        if (oneLine(s.title, `${where}.title`)) {
          const t = (s.title as string).trim();
          if (mode === 'intent') {
            if (!(ALLOWED_SECTIONS as readonly string[]).includes(t)) bad(`${where}.title: "${t}" is not one of ${ALLOWED_SECTIONS.join(', ')}`);
          } else {
            if (/^#/.test(t)) bad(`${where}.title: give the text only, without "#"`);
            if (VOICE_SECTION.test(t) || DONE_SECTION.test(t)) bad(`${where}.title: "${t}" is a retired voice or done-family heading`);
            if (/^(ideal state|anti-criteria)$/i.test(t)) bad(`${where}.title: "${t}" comes from the idealState / antiCriteria fields`);
          }
          if (seen.has(t.toLowerCase())) bad(`${where}.title: "${t}" appears twice`);
          seen.add(t.toLowerCase());
        }
        blockList(s.blocks, `${where}.blocks`);
      });
    }
  }

  if ('cuts' in raw) {
    if (!Array.isArray(raw.cuts)) bad('cuts: must be an array');
    else raw.cuts.forEach((c, i) => {
      const where = `cuts[${i}]`;
      if (!isObj(c)) { bad(`${where}: must be {from,to,reason}`); return; }
      keys(c, where, ['from', 'to', 'reason'], ['from', 'to', 'reason']);
      range(c, where);
      if (oneLine(c.reason, `${where}.reason`)) {
        if ((c.reason as string).trim().length < CUT_REASON_MIN) bad(`${where}.reason: at least ${CUT_REASON_MIN} characters`);
        if (/\t/.test(c.reason as string)) bad(`${where}.reason: may not contain a tab (it becomes a TSV field)`);
      }
    });
  }
  if (isObj(fm) && typeof fm.dropReason === 'string' && /\t/.test(fm.dropReason)) bad('frontmatter.dropReason: may not contain a tab');

  if (problems.length) throw new PlanRefusal(problems);
  return raw as unknown as IntentPlan;
}

// ── frontmatter merge ──────────────────────────────────────────────────────

const yamlString = (s: string) => JSON.stringify(s); // a JSON string is a valid YAML double-quoted scalar

function requirementLines(reqs: ContractRequirement[], indent: string): string[] {
  const out: string[] = [];
  for (const r of reqs) {
    out.push(`${indent}- id: ${yamlString(r.id)}`);
    out.push(`${indent}  path: ${yamlString(r.path)}`);
    out.push(`${indent}  fields: [${r.fields.map(yamlString).join(', ')}]`);
    if (r.produce !== undefined) out.push(`${indent}  produce: ${yamlString(r.produce)}`);
  }
  return out;
}

const indentOf = (l: string) => l.length - l.trimStart().length;

/**
 * Merges `contract.requires` entries into frontmatter body lines (between the fences)
 * by textual insertion, so every original line survives byte for byte. The result is
 * parsed back and checked: original keys unchanged, requires = old entries + new ones.
 */
export function mergeContract(bodyLines: string[], reqs: ContractRequirement[], eol: string): string[] {
  const problems: string[] = [];
  const parsedBefore: unknown = bodyLines.length ? parseYaml(bodyLines.map(l => l.replace(/\r$/, '')).join('\n')) : {};
  const before: Obj = isObj(parsedBefore) ? parsedBefore : {};
  const out = [...bodyLines];
  const contractAt = out.findIndex(l => /^contract:\s*\r?$/.test(l));
  if (contractAt === -1) {
    if ('contract' in before) throw new PlanRefusal(['frontmatter: "contract" is not a block mapping; merge contractRequires by hand']);
    out.push('contract:', '  requires:', ...requirementLines(reqs, '    '));
  } else {
    let end = contractAt + 1;
    while (end < out.length && (out[end].trim() === '' || indentOf(out[end]) > 0)) end++;
    const childIndent = out.slice(contractAt + 1, end).find(l => l.trim() !== '');
    const ci = childIndent ? ' '.repeat(indentOf(childIndent)) : '  ';
    const reqAt = out.findIndex((l, i) => i > contractAt && i < end && new RegExp(`^${ci}requires:`).test(l));
    if (reqAt === -1) {
      out.splice(contractAt + 1, 0, `${ci}requires:`, ...requirementLines(reqs, ci + '  '));
    } else {
      if (!/^\s*requires:\s*\r?$/.test(out[reqAt])) throw new PlanRefusal(['frontmatter: contract.requires is written inline; merge contractRequires by hand']);
      let last = reqAt;
      for (let i = reqAt + 1; i < end; i++) {
        if (out[i].trim() === '') continue;
        if (indentOf(out[i]) > ci.length || (indentOf(out[i]) === ci.length && /^\s*- /.test(out[i]))) last = i;
        else break;
      }
      const firstItem = out.slice(reqAt + 1, last + 1).find(l => /^\s*- /.test(l));
      const itemIndent = firstItem ? ' '.repeat(indentOf(firstItem)) : ci + '  ';
      out.splice(last + 1, 0, ...requirementLines(reqs, itemIndent));
    }
  }
  // Generated lines carry the file's line ending.
  const merged = out.map((l, i) => (i < bodyLines.length || eol === '\n' || l.endsWith('\r') ? l : l + '\r'));
  let after: unknown;
  try { after = parseYaml(merged.map(l => l.replace(/\r$/, '')).join('\n')); } catch (e) {
    throw new PlanRefusal([`frontmatter: merged contract does not parse as YAML: ${(e as Error).message}`]);
  }
  if (!isObj(after) || !isObj(after.contract) || !Array.isArray(after.contract.requires)) {
    throw new PlanRefusal(['frontmatter: merged contract.requires is not a list']);
  }
  const oldReqs = isObj(before.contract) && Array.isArray(before.contract.requires) ? before.contract.requires : [];
  const want = [...oldReqs, ...reqs.map(r => ({ id: r.id, path: r.path, fields: r.fields, ...(r.produce !== undefined ? { produce: r.produce } : {}) }))];
  if (JSON.stringify(after.contract.requires) !== JSON.stringify(want)) problems.push('frontmatter: merged contract.requires differs from the original entries plus the plan\'s');
  const ids = want.map(r => (isObj(r) ? r.id : undefined));
  if (new Set(ids).size !== ids.length) problems.push('frontmatter: contract.requires would hold a duplicate id');
  for (const k of Object.keys(before)) {
    if (k === 'contract') continue;
    if (JSON.stringify(after[k]) !== JSON.stringify(before[k])) problems.push(`frontmatter: merge changed key "${k}"`);
  }
  if (problems.length) throw new PlanRefusal(problems);
  return merged;
}

// ── build ──────────────────────────────────────────────────────────────────

export interface BuildOptions { mode: PlanMode; hasIntents: boolean }
export interface CutToken { token: string; kind: string; line: number; reason: string }
export interface BuildResult { text: string; warnings: Issue[]; demoted: number[]; lost: CutToken[] }

interface OutLine { text: string; origin: number | null }

export function sha256(text: string | Buffer): string {
  return createHash('sha256').update(text).digest('hex');
}

const isRange = (b: Block): b is RangeBlock => 'from' in b;

/** Rebuilds the file from a validated plan. Pure: no I/O. Throws PlanRefusal on any violation. */
export function buildFromPlan(plan: IntentPlan, original: string, opts: BuildOptions): BuildResult {
  const problems: string[] = [];
  if (sha256(Buffer.from(original, 'utf8')) !== plan.sha256) {
    throw new PlanRefusal([`sha256: the plan was written for different content than ${plan.file} holds now; re-read the file and re-plan`]);
  }
  if (opts.mode === 'skill-md') {
    const has = (k: 'idealState' | 'antiCriteria') => plan[k] !== undefined;
    if (!has('idealState')) problems.push('idealState: every SKILL.md opens with a skill-level Ideal State');
    if (!opts.hasIntents && !has('antiCriteria')) problems.push('antiCriteria: this skill has no Intents/*.md, so SKILL.md must carry both Ideal State and Anti-criteria');
  }

  const { lines } = splitLines(original);
  const n = lines.length;
  const eol = lines.some(l => l.endsWith('\r')) ? '\r\n' : '\n';
  const fmCount = frontmatterLineCount(original);
  const origFenced = fencedLines(original).slice(0, n).map(l => l.fenced);
  const blank = (no: number) => lines[no - 1].trim() === '';

  // Coverage: every line after the frontmatter in at most one range; every non-blank one in exactly one.
  const ranges: { from: number; to: number; where: string }[] = [];
  (plan.preamble ?? []).forEach((b, i) => { if (isRange(b)) ranges.push({ ...b, where: `preamble[${i}]` }); });
  plan.sections.forEach((s, i) => s.blocks.forEach((b, j) => { if (isRange(b)) ranges.push({ ...b, where: `sections[${i}].blocks[${j}]` }); }));
  plan.cuts.forEach((c, i) => ranges.push({ from: c.from, to: c.to, where: `cuts[${i}]` }));
  const owner: (string | undefined)[] = new Array(n + 1);
  for (const r of ranges) {
    if (r.from <= fmCount || r.to > n) {
      problems.push(`${r.where}: lines ${r.from}-${r.to} fall outside the body (lines ${fmCount + 1}-${n})`);
      continue;
    }
    const overlap = new Map<string, number[]>();
    for (let no = r.from; no <= r.to; no++) {
      const prior = owner[no];
      if (prior === undefined) { owner[no] = r.where; continue; }
      overlap.set(prior, [...(overlap.get(prior) ?? []), no]);
    }
    for (const [prior, nos] of overlap) problems.push(`overlap: ${r.where} and ${prior} both cover line(s) ${compactRanges(nos)}`);
  }
  const gaps: number[] = [];
  for (let no = fmCount + 1; no <= n; no++) if (owner[no] === undefined && !blank(no)) gaps.push(no);
  if (gaps.length) problems.push(`coverage: non-blank line(s) in no block and no cut: ${compactRanges(gaps)}`);
  if (problems.length) throw new PlanRefusal(problems);

  const cutAt: (PlanCut | undefined)[] = new Array(n + 1);
  for (const c of plan.cuts) for (let no = c.from; no <= c.to; no++) cutAt[no] = c;

  // Assembly.
  const out: OutLine[] = [];
  const push = (text: string, origin: number | null = null) => out.push({ text, origin });
  const pushBlank = () => { if (out.length && out[out.length - 1].text.trim() !== '') push(''); };
  const demoted: number[] = [];

  const fmLines = lines.slice(0, fmCount);
  if (plan.frontmatter.keep) {
    if (fmCount === 0 && plan.frontmatter.contractRequires) {
      push('---');
      for (const l of mergeContract([], plan.frontmatter.contractRequires, eol)) push(l);
      push('---');
    } else if (fmCount > 0) {
      const body = fmLines.slice(1, -1);
      const merged = plan.frontmatter.contractRequires ? mergeContract(body, plan.frontmatter.contractRequires, eol) : body;
      push(fmLines[0]);
      for (const l of merged) push(l);
      push(fmLines[fmCount - 1]);
    }
  } else {
    if (fmCount > 0 && !plan.frontmatter.dropReason) {
      throw new PlanRefusal(['frontmatter.keep: false drops the original frontmatter; give frontmatter.dropReason (12+ chars) or keep it']);
    }
    if (plan.frontmatter.contractRequires) {
      push('---');
      for (const l of mergeContract([], plan.frontmatter.contractRequires, eol)) push(l);
      push('---');
    }
  }

  const outFm = out.length; // frontmatter lines keep their own bytes and are never fence-checked
  pushBlank();
  push(`# ${plan.title.trim()}`);
  if (plan.summary !== undefined) { push(''); push(plan.summary.trim()); }

  const emitBlocks = (blocks: Block[]) => {
    let prev: RangeBlock | null = null;
    for (const b of blocks) {
      if (!isRange(b)) {
        pushBlank();
        push(b.text.trim());
        prev = null;
        continue;
      }
      let from = b.from;
      let to = b.to;
      while (from <= to && blank(from)) from++;
      while (to >= from && blank(to)) to--;
      if (from > to) { problems.push(`block ${b.from}-${b.to}: holds only blank lines`); continue; }
      let tight = prev !== null && from > prev.to;
      if (tight && prev) for (let no = prev.to + 1; no < from; no++) if (blank(no) || cutAt[no] === undefined) { tight = false; break; }
      if (!tight) pushBlank();
      for (let no = from; no <= to; no++) {
        let text = lines[no - 1];
        if (!origFenced[no - 1] && /^#{1,2} \S/.test(text)) { text = text.replace(/^#{1,2} /, '### '); demoted.push(no); }
        push(text, no);
      }
      prev = { from, to };
    }
  };

  if (plan.preamble) emitBlocks(plan.preamble);
  if (plan.idealState) {
    pushBlank(); push('## Ideal State'); push('');
    for (const b of plan.idealState) push(`- ${b.trim()}`);
  }
  if (plan.antiCriteria) {
    pushBlank(); push('## Anti-criteria'); push('');
    for (const b of plan.antiCriteria) push(`- ${b.trim()}`);
  }
  for (const s of plan.sections) {
    pushBlank(); push(`## ${s.title.trim()}`); push('');
    emitBlocks(s.blocks);
  }
  if (problems.length) throw new PlanRefusal(problems);
  while (out.length && out[out.length - 1].text.trim() === '') out.pop();

  // Generated lines take the file's line ending; moved and frontmatter lines keep their own bytes.
  const finalLines = out.map((l, i) => (l.origin === null && i >= outFm && eol === '\r\n' && !l.text.endsWith('\r') ? l.text + '\r' : l.text));
  const text = joinLines(finalLines, true);

  // Fence integrity: a moved line keeps its fence state; a generated line is never fenced.
  const outFenced = fencedLines(text).slice(0, finalLines.length);
  const broken: number[] = [];
  out.forEach((l, i) => {
    if (i < outFm) return;
    const want = l.origin === null ? false : origFenced[l.origin - 1];
    if (outFenced[i].fenced !== want) broken.push(l.origin ?? -(i + 1));
  });
  if (broken.length) {
    const orig = broken.filter(x => x > 0);
    problems.push(`fences: the moved ranges split a fenced block, so ${orig.length ? `original line(s) ${compactRanges(orig)}` : 'generated lines'} change fence state; move whole fenced blocks, or cut them whole`);
  }

  // The result must pass IntentLint before anything is written.
  const lint = opts.mode === 'intent' ? lintIntentText(text) : lintSkillText(text, opts.hasIntents);
  for (const e of lint.errors) problems.push(`IntentLint ${e.rule} at output line ${e.line}: ${e.msg}`);
  if (problems.length) throw new PlanRefusal(problems);

  // Every token IntentPreserve would miss came off a cut line (or the dropped frontmatter), and carries that reason.
  const lost: CutToken[] = lostTokens(original, text).map(t => {
    const cut = cutAt[t.line];
    const reason = cut ? cut.reason.trim() : t.line <= fmCount && !plan.frontmatter.keep ? plan.frontmatter.dropReason!.trim() : '';
    invariant(reason !== '', `token "${t.text}" from original line ${t.line} was lost, but the line was moved verbatim`);
    return { token: t.text, kind: t.kind, line: t.line, reason };
  });
  return { text, warnings: lint.warnings, demoted, lost };
}

/** `[3,4,5,9]` → `3-5, 9`. */
export function compactRanges(nums: number[]): string {
  const sorted = [...new Set(nums)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    parts.push(i === j ? String(sorted[i]) : `${sorted[i]}-${sorted[j]}`);
    i = j;
  }
  return parts.join(', ');
}

// ── apply (I/O) ────────────────────────────────────────────────────────────

export interface ApplyOptions { planPath: string; mode: PlanMode; check: boolean; allowOut: string | null; cwd?: string }
export interface ApplyResult {
  file: string;
  written: boolean;
  text: string;
  allowLines: string[];
  allowWritten: number;
  warnings: Issue[];
  demoted: number[];
}

function intentsPresent(skillDir: string): boolean {
  const dir = join(skillDir, 'Intents');
  try {
    return readdirSync(dir).some(f => f.endsWith('.md') && !statSync(join(dir, f)).isDirectory());
  } catch { return false; }
}

export function applyPlan(opts: ApplyOptions): ApplyResult {
  const cwd = opts.cwd ?? process.cwd();
  const planPath = resolve(cwd, opts.planPath);
  if (!existsSync(planPath)) throw new UsageError(`no such plan file: ${opts.planPath}`);
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(planPath, 'utf8')); } catch (e) {
    throw new PlanRefusal([`plan: not valid JSON: ${(e as Error).message}`]);
  }
  const plan = validatePlan(raw, opts.mode);
  const abs = resolve(cwd, plan.file);
  if (!existsSync(abs)) throw new PlanRefusal([`file: ${plan.file} does not exist`]);
  if (opts.mode === 'intent' && !intentFromPath(abs)) throw new PlanRefusal([`file: ${plan.file} is not skills/<Skill>/Intents/<Intent>.md (use --skill-md for a SKILL.md)`]);
  if (opts.mode === 'skill-md' && basename(abs) !== 'SKILL.md') throw new PlanRefusal([`file: --skill-md needs a SKILL.md, got ${plan.file}`]);

  const root = repoRootOf(dirname(abs));
  const rel = repoPath(root, abs);
  const bytes = readFileSync(abs);
  const original = bytes.toString('utf8');
  if (sha256(bytes) !== plan.sha256) {
    throw new PlanRefusal([`sha256: ${rel} is ${sha256(bytes)}, the plan expects ${plan.sha256}; re-read the file and re-plan`]);
  }
  const hasIntents = opts.mode === 'skill-md' && intentsPresent(dirname(abs));
  const built = buildFromPlan(plan, original, { mode: opts.mode, hasIntents });
  const allow = built.lost.map(t => allowLine(rel, t.token, t.reason));

  let written = false;
  let allowWritten = 0;
  if (!opts.check) {
    invariant(sha256(readFileSync(abs)) === plan.sha256, `${rel} changed on disk while the plan was being applied`);
    invariant(repoPath(root, abs) === rel, `${rel} must resolve inside ${root}`);
    const lint = opts.mode === 'intent' ? lintIntentText(built.text) : lintSkillText(built.text, hasIntents);
    invariant(lint.errors.length === 0, `${rel}: the rebuilt file must carry no IntentLint error before it is written`);
    writeFileSync(abs, built.text);
    written = true;
    if (opts.allowOut && allow.length) allowWritten = appendAllowFile(resolve(cwd, opts.allowOut), allow);
  }
  return { file: rel, written, text: built.text, allowLines: allow, allowWritten, warnings: built.warnings, demoted: built.demoted };
}

// ── CLI ────────────────────────────────────────────────────────────────────

const HELP = `ApplyIntentPlan — rebuild one intent or SKILL.md from a plan, moving lines verbatim

  bun skills/CreateSkill/Tools/ApplyIntentPlan.ts --plan <plan.json> [--allow-out <tsv>] [--check] [--json] [--skill-md]

  --plan       the plan JSON (shape: IntentPlan in this file)
  --allow-out  append IntentPreserve allow lines for tokens the cuts removed
  --check      validate and print the would-be file and allow lines; write nothing
  --json       print {ok, file, written, allow, warnings, demoted[, text]} as JSON
  --skill-md   the target is a SKILL.md: free-form section titles, optional summary and preamble

Exit: 0 written or valid, 1 plan refused, 2 git or I/O error, 64 usage error.`;

function parseArgs(argv: string[]): { plan: string | null; allowOut: string | null; check: boolean; json: boolean; skillMd: boolean; help: boolean } {
  const r = { plan: null as string | null, allowOut: null as string | null, check: false, json: false, skillMd: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--plan' || a === '--allow-out') {
      const v = argv[++i];
      if (!v || v.startsWith('--')) throw new UsageError(`${a} needs a file path`);
      if (a === '--plan') r.plan = v; else r.allowOut = v;
    } else if (a === '--check') r.check = true;
    else if (a === '--json') r.json = true;
    else if (a === '--skill-md') r.skillMd = true;
    else if (a === '--help') r.help = true;
    else throw new UsageError(`unexpected argument ${a}`);
  }
  if (!r.help && !r.plan) throw new UsageError('--plan is required');
  return r;
}

export function main(argv: string[]): number {
  let args: ReturnType<typeof parseArgs>;
  try { args = parseArgs(argv); } catch (e) {
    if (e instanceof UsageError) { console.error(`apply-intent-plan: ${e.message}\n${HELP}`); return 64; }
    throw e;
  }
  if (args.help) { console.log(HELP); return 0; }
  try {
    const r = applyPlan({ planPath: args.plan!, mode: args.skillMd ? 'skill-md' : 'intent', check: args.check, allowOut: args.allowOut });
    if (args.json) {
      console.log(JSON.stringify({
        ok: true, file: r.file, written: r.written, allow: r.allowLines, allowWritten: r.allowWritten,
        warnings: r.warnings, demoted: r.demoted, ...(args.check ? { text: r.text } : {}),
      }, null, 2));
    } else {
      if (args.check) {
        process.stdout.write(r.text);
        console.log(`--- allow lines (${r.allowLines.length}) ---`);
        for (const l of r.allowLines) console.log(l);
      } else console.log(`wrote ${r.file}${args.allowOut ? `; ${r.allowWritten} allow line(s) added to ${args.allowOut}` : ''}`);
      for (const w of r.warnings) console.log(`WARN ${w.rule} at line ${w.line}: ${w.msg}`);
      if (r.demoted.length) console.log(`demoted to ###: original line(s) ${compactRanges(r.demoted)}`);
    }
    return 0;
  } catch (e) {
    if (e instanceof PlanRefusal) {
      if (args.json) console.log(JSON.stringify({ ok: false, errors: e.problems }, null, 2));
      else { console.error('apply-intent-plan: plan refused, nothing written'); for (const p of e.problems) console.error(`  ${p}`); }
      return 1;
    }
    if (e instanceof UsageError) { console.error(`apply-intent-plan: ${e.message}`); return 64; }
    if (e instanceof GitError) { console.error(`apply-intent-plan: ${e.message}`); return 2; }
    const code = (e as NodeJS.ErrnoException).code;
    if (typeof code === 'string' && /^E[A-Z]+$/.test(code)) { console.error(`apply-intent-plan: ${(e as Error).message}`); return 2; }
    throw e;
  }
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
