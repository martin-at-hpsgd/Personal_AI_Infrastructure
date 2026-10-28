#!/usr/bin/env bun
/**
 * IntentLint — checks skill intents and SKILL.md files against the intent anatomy
 * standard (LIFEOS/DOCUMENTATION/Skills/SkillSystem.md § Intent anatomy).
 *
 * Usage:
 *   bun LIFEOS/TOOLS/IntentLint.ts <path...> [--json] [--strict]
 *
 * A path is the skills root, one skill directory, one Intents/ directory, or one
 * file (an intent or a SKILL.md). node_modules and anything under LIFEOS_RELEASES
 * are skipped.
 *
 * Intent rules (ERROR unless marked WARN):
 *   ideal-state-missing      no `## Ideal State`
 *   ideal-state-not-first    `## Ideal State` is not the first H2
 *   ideal-state-bullets      fewer than 2 top-level bullets under Ideal State
 *   anti-criteria-missing    no `## Anti-criteria`
 *   anti-criteria-not-second `## Anti-criteria` is not the second H2
 *   anti-criteria-bullets    no top-level bullet under Anti-criteria
 *   voice-section            a `## Voice Notification` H2 (any H2 naming voice notifications) is present
 *   voice-curl               the legacy localhost:31337/notify curl is present
 *   running-line             a "Running the **X** intent in the **Y** skill" line is present
 *   done-heading             a retired `## Done…` / `## The Deliverable` heading
 *   extra-section     (WARN) an H2 outside Ideal State, Anti-criteria and the allowed set (a voice or
 *                            done heading is raised as its error instead, never twice)
 *   numbered-list     (WARN) a numbered list of ≥5 items outside a fence, Tool contract and Output format
 *   no-h1             (WARN) the file has no H1
 *   evals-empty              a `## Evals` section with no bullet
 *   evals-unknown-entry      an `## Evals` bullet that is not `compiled`, `library: <name>` or `suite: <name>`
 *   evals-missing-suite      an `## Evals` bullet names a library (skills/Assay/Libraries/<name>.yaml) or a
 *                            suite (skills/Assay/Suites/**\/<name>.yaml) that does not exist
 *   ideal-state-uncompilable no Ideal State bullet Assay can compile into a check (a claim of 3+ words):
 *                            an ERROR for an intent born with `## Evals` (every scaffold since 2026-10-24),
 *                            a WARN for older intents, so no existing intent starts failing
 *
 * SKILL.md rules (ERROR):
 *   voice-section, voice-curl, running-line, done-heading
 *   ideal-state-missing / ideal-state-not-first / ideal-state-bullets
 *                            every SKILL.md opens with "## Ideal State" (2+ bullets) as its first H2
 *   anti-criteria-*          a skill with no Intents/*.md also carries "## Anti-criteria" as its second H2
 *   routing-missing          the skill has intents or context files but no "## Intent Routing"
 *   routing-not-early        "## Intent Routing" does not directly follow Ideal State (and Anti-criteria)
 *   unrouted-file            an intent, reference or root .md is not named inside the routing section,
 *                            or another directory holding .md files is not named as "<Dir>/"
 *   dead-route               the routing section names an Intents/ or References/ file that does not exist
 *   nested-intent            an .md sits in a subdirectory of Intents/ (three levels deep); IntentLint cannot
 *                            lint it as an intent, so flatten it to Intents/<CategoryName>.md
 *   summary-missing          frontmatter carries no string `metadata.short-description` (the Codex front
 *                            door's skill catalog reads it; LIFEOS/CODEX/SkillCatalog.ts)
 *   summary-too-long         the short-description exceeds SUMMARY_MAX_CHARS code points, imported from
 *                            SkillCatalog.ts and measured the way it measures
 *   summary-malformed        the short-description is empty, has leading/trailing space, or spans lines
 *   frontmatter-invalid      the frontmatter does not parse as YAML, so no summary can be read
 *   evals-*, ideal-state-uncompilable
 *                            a single-intent SKILL.md carrying `## Evals` is checked as an intent is
 *
 * Context-file rules (ERROR), on SKILL.md, intents, References/*.md and root .md files:
 *   contents-missing / contents-stale
 *                            a file over 100 lines with 2+ H2s opens with "**Contents:**" naming every H2
 *                            in order (fix: bun LIFEOS/TOOLS/SkillContents.ts --write <skill>)
 *
 * Exit codes: 0 clean (warnings allowed), 1 any error (or any warning with --strict),
 * 64 usage error. Read-only: writes nothing.
 *
 * @version 1.4.0
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { basename, join, relative, resolve, sep } from 'path';
import {
  ALLOWED_SECTIONS,
  DONE_SECTION,
  RUNNING_LINE,
  VOICE_CURL,
  VOICE_SECTION,
  compilableBullet,
  fencedLines,
  intentFromPath,
  parseIntent,
  type ParsedIntent,
} from './lib/IntentSections';
import { checkContents, contextFiles, type ContextFile } from './SkillContents';
import { SUMMARY_MAX_CHARS, skillMetadata } from '../CODEX/SkillCatalog';

export interface Issue { rule: string; line: number; msg: string }
export interface FileReport { path: string; kind: 'intent' | 'skill' | 'context'; errors: Issue[]; warnings: Issue[] }
export interface LintTotals { files: number; errors: number; warnings: number }
export interface LintResult { files: FileReport[]; totals: LintTotals }

export class UsageError extends Error {}

/** Sections in which an ordered recipe is the point: numbered lists there are contract, not choreography. */
const ORDERED_OK = new Set(['tool contract', 'output format']);
const KNOWN_SECTIONS = new Set(['ideal state', 'anti-criteria', ...ALLOWED_SECTIONS.map(s => s.toLowerCase())]);
const NUMBERED_ITEM = /^ ?\d{1,3}[.)]\s+\S/;
const NUMBERED_LIST_MIN = 5;

interface Line { text: string; fenced: boolean; no: number; section: string | null; frontmatter: boolean }

/** Annotates every file line with its 1-based number, fence state, owning H2 and frontmatter membership. */
function annotate(text: string): Line[] {
  const raw = text.replace(/^﻿/, '');
  const fm = raw.match(/^---\s*\r?\n[\s\S]*?\r?\n---\s*(?:\r?\n|$)/);
  const fmLines = fm ? fm[0].split(/\r?\n/).length - 1 : 0;
  const out: Line[] = [];
  let section: string | null = null;
  fencedLines(raw).forEach((l, i) => {
    const frontmatter = i < fmLines;
    // A fence opened inside frontmatter is impossible in valid YAML; frontmatter lines are never body.
    if (!frontmatter && !l.fenced && /^## \S/.test(l.text)) section = l.text.slice(3).trim();
    out.push({ text: l.text, fenced: l.fenced && !frontmatter, no: i + 1, section, frontmatter });
  });
  return out;
}

/** Errors common to intents and SKILL.md: the voice curl, the Running line, the retired done headings. */
function legacyIssues(lines: Line[], sections: { title: string; line: number }[]): Issue[] {
  const issues: Issue[] = [];
  const curl = lines.find(l => VOICE_CURL.test(l.text));
  if (curl) issues.push({ rule: 'voice-curl', line: curl.no, msg: 'legacy voice curl (localhost:31337/notify); the IntentVoice hook announces intents now' });
  const running = lines.find(l => RUNNING_LINE.test(l.text));
  if (running) issues.push({ rule: 'running-line', line: running.no, msg: '"Running the X intent in the Y skill" line; the IntentVoice hook announces intents now' });
  for (const s of sections) {
    if (DONE_SECTION.test(s.title)) {
      issues.push({ rule: 'done-heading', line: s.line, msg: `"## ${s.title}" is retired; done is "## Ideal State" + "## Anti-criteria"` });
    }
  }
  return issues;
}

/** The retired `## Voice Notification` block, in an intent or a SKILL.md: the IntentVoice hook announces intents now. */
function voiceSectionIssues(sections: { title: string; line: number }[]): Issue[] {
  return sections
    .filter(s => VOICE_SECTION.test(s.title))
    .map(s => ({ rule: 'voice-section', line: s.line, msg: `"## ${s.title}" is retired; the IntentVoice hook announces intents now` }));
}

/** Numbered lists of ≥5 items outside fences and outside Tool contract / Output format. */
function numberedListWarnings(lines: Line[]): Issue[] {
  const out: Issue[] = [];
  let run: { start: number; count: number; section: string | null } | null = null;
  const flush = () => {
    if (run && run.count >= NUMBERED_LIST_MIN && !ORDERED_OK.has((run.section ?? '').toLowerCase())) {
      out.push({
        rule: 'numbered-list',
        line: run.start,
        msg: `${run.count}-item numbered list outside Tool contract / Output format: cut the choreography, or move a tool-required order into ## Tool contract`,
      });
    }
    run = null;
  };
  for (const l of lines) {
    if (l.frontmatter) continue;
    if (l.fenced) continue; // fenced content neither counts nor ends a list (fences sit inside list items)
    if (/^#{1,6} \S/.test(l.text)) { flush(); continue; }
    if (NUMBERED_ITEM.test(l.text)) {
      if (!run) run = { start: l.no, count: 0, section: l.section };
      run.count++;
      continue;
    }
    if (l.text.trim() === '') continue;
    if (run && /^\s{2,}\S/.test(l.text)) continue; // continuation line or nested content of an item
    flush();
  }
  flush();
  return out;
}

/** The Assay eval sets an `## Evals` bullet may name: shared libraries and suites, by file name (suites also by Dir/name). */
export interface EvalCatalog { library: Set<string>; suite: Set<string> }
export const ASSAY_SKILL_DIR = resolve(import.meta.dir, '..', '..', 'skills', 'Assay');
let cachedCatalog: EvalCatalog | null = null;
/** Read once per process, and only when some file carries `## Evals`, so a lint of intents without one pays nothing. */
export function assayEvalCatalog(dir: string = ASSAY_SKILL_DIR): EvalCatalog {
  if (dir === ASSAY_SKILL_DIR && cachedCatalog) return cachedCatalog;
  const yamlNames = (d: string) => { try { return readdirSync(d).filter(f => /\.ya?ml$/.test(f)); } catch { return []; } };
  const library = new Set(yamlNames(join(dir, 'Libraries')).map(f => f.replace(/\.ya?ml$/, '')));
  const suite = new Set<string>();
  const walk = (d: string, rel: string) => {
    let names: string[] = [];
    try { names = readdirSync(d); } catch { return; }
    for (const n of names) {
      const full = join(d, n);
      if (isDir(full)) { if (n !== 'Fixtures') walk(full, rel ? `${rel}/${n}` : n); continue; }
      if (!/\.ya?ml$/.test(n)) continue;
      const name = n.replace(/\.ya?ml$/, '');
      suite.add(name);
      if (rel) suite.add(`${rel}/${name}`);
    }
  };
  walk(join(dir, 'Suites'), '');
  const out = { library, suite };
  if (dir === ASSAY_SKILL_DIR) cachedCatalog = out;
  return out;
}

/**
 * The eval-set rules, shared by intents and single-intent SKILL.md files: an `## Evals` section names only eval sets that
 * exist, and an intent born with one (the scaffold writes it) must carry an Ideal State Assay can compile; an older intent
 * without `## Evals` gets that as a warning, never an error.
 */
function evalIssues(parsed: ParsedIntent, catalog: () => EvalCatalog): { errors: Issue[]; warnings: Issue[] } {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  const h2 = parsed.sections;
  const evalsAt = h2.find(s => s.title.toLowerCase() === 'evals');
  const isAt = h2.find(s => s.title.toLowerCase() === 'ideal state');
  if (isAt && parsed.idealState.length > 0 && !parsed.idealState.some(compilableBullet)) {
    const issue = { rule: 'ideal-state-uncompilable', line: isAt.line, msg: 'no Ideal State bullet Assay can compile into a check: state each outcome as a claim of 3+ words a reader could show failed' };
    (parsed.evals ? errors : warnings).push(issue);
  }
  if (!evalsAt || !parsed.evals) return { errors, warnings };
  if (parsed.evals.length === 0) {
    errors.push({ rule: 'evals-empty', line: evalsAt.line, msg: '"## Evals" has no bullet; write "- compiled: …" when the checks Assay compiles from Ideal State and Anti-criteria are the whole set' });
  }
  for (const e of parsed.evals) {
    if (e.kind === 'unknown') {
      errors.push({ rule: 'evals-unknown-entry', line: evalsAt.line, msg: `"## Evals" bullet "${e.text.slice(0, 80)}" is not "compiled", "library: <name>" or "suite: <name>"` });
    } else if (e.kind !== 'compiled' && !catalog()[e.kind].has(e.name)) {
      const where = e.kind === 'library' ? 'skills/Assay/Libraries/' : 'skills/Assay/Suites/';
      errors.push({ rule: 'evals-missing-suite', line: evalsAt.line, msg: `"## Evals" names ${e.kind} "${e.name}", which does not exist under ${where}` });
    }
  }
  return { errors, warnings };
}

export function lintIntentText(text: string, catalog: () => EvalCatalog = () => assayEvalCatalog()): { errors: Issue[]; warnings: Issue[] } {
  const parsed = parseIntent(text);
  const lines = annotate(text);
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  const h2 = parsed.sections;
  const idx = (name: string) => h2.findIndex(s => s.title.toLowerCase() === name.toLowerCase());

  const isAt = idx('Ideal State');
  if (isAt === -1) {
    errors.push({ rule: 'ideal-state-missing', line: 1, msg: 'no "## Ideal State" section' });
  } else {
    if (isAt !== 0) errors.push({ rule: 'ideal-state-not-first', line: h2[isAt].line, msg: `"## Ideal State" is H2 #${isAt + 1}; it must be the first H2` });
    if (parsed.idealState.length < 2) {
      errors.push({ rule: 'ideal-state-bullets', line: h2[isAt].line, msg: `Ideal State has ${parsed.idealState.length} top-level bullet(s); at least 2 required` });
    }
  }

  const acAt = idx('Anti-criteria');
  if (acAt === -1) {
    errors.push({ rule: 'anti-criteria-missing', line: 1, msg: 'no "## Anti-criteria" section' });
  } else {
    if (acAt !== 1) errors.push({ rule: 'anti-criteria-not-second', line: h2[acAt].line, msg: `"## Anti-criteria" is H2 #${acAt + 1}; it must be the second H2` });
    if (parsed.antiCriteria.length < 1) {
      errors.push({ rule: 'anti-criteria-bullets', line: h2[acAt].line, msg: 'Anti-criteria has no top-level bullet' });
    }
  }

  errors.push(...voiceSectionIssues(h2));
  errors.push(...legacyIssues(lines, h2));

  for (const s of h2) {
    const t = s.title.toLowerCase();
    // Voice and done headings are already raised as errors; a second report as extra-section is noise.
    if (KNOWN_SECTIONS.has(t) || DONE_SECTION.test(s.title) || VOICE_SECTION.test(s.title)) continue;
    warnings.push({ rule: 'extra-section', line: s.line, msg: `"## ${s.title}" is outside the allowed sections (${ALLOWED_SECTIONS.join(', ')})` });
  }
  warnings.push(...numberedListWarnings(lines));
  if (parsed.title === null) warnings.push({ rule: 'no-h1', line: 1, msg: 'no H1 title' });
  const ev = evalIssues(parsed, catalog);
  errors.push(...ev.errors);
  warnings.push(...ev.warnings);
  const contents = checkContents(text);
  if (contents) errors.push(contents);

  errors.sort((a, b) => a.line - b.line);
  warnings.sort((a, b) => a.line - b.line);
  return { errors, warnings };
}

/** What the skill holds besides SKILL.md, for the routing rules. Omitted (a lone SKILL.md text) skips them. */
export interface SkillContext { files: ContextFile[]; exists: (rel: string) => boolean }

// A path inside another skill (`skills/Assay/Intents/Proof.md`) is not this skill's route.
const ROUTED_PATH = /(?<![\w/.-])((?:Intents|References)\/[\w.+-]+\.md)\b/g;

/**
 * The compact catalog summary the Codex front door projects in place of the full description.
 * Parsing and the cap come from SkillCatalog.ts so the lint and the renderer cannot disagree.
 */
export function summaryIssues(text: string): Issue[] {
  const raw = text.replace(/^\uFEFF/, '');
  const fm = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(raw)?.[0] ?? '';
  const keyLine = fm.split(/\r?\n/).findIndex(l => /^\s+short-description:/.test(l));
  const line = keyLine === -1 ? 1 : keyLine + 1;
  let summary: string | undefined;
  try {
    summary = skillMetadata(raw).summary;
  } catch (e) {
    return [{ rule: 'frontmatter-invalid', line: 1, msg: `frontmatter does not parse as YAML (${e instanceof Error ? e.message : String(e)}); metadata.short-description cannot be read` }];
  }
  if (summary === undefined) {
    return [{ rule: 'summary-missing', line, msg: `no metadata.short-description; add one plain sentence of at most ${SUMMARY_MAX_CHARS} characters saying what the skill does (the Codex skill catalog shows it)` }];
  }
  const issues: Issue[] = [];
  if (summary.length === 0 || summary.trim() !== summary || /[\r\n]/.test(summary)) {
    issues.push({ rule: 'summary-malformed', line, msg: 'metadata.short-description must be nonempty, single-line and trimmed' });
  }
  const length = [...summary].length;
  if (length > SUMMARY_MAX_CHARS) {
    issues.push({ rule: 'summary-too-long', line, msg: `metadata.short-description is ${length} characters; the catalog cap is ${SUMMARY_MAX_CHARS}` });
  }
  return issues;
}

export function lintSkillText(text: string, hasIntents: boolean, ctx?: SkillContext): { errors: Issue[]; warnings: Issue[] } {
  const parsed = parseIntent(text);
  const lines = annotate(text);
  const errors: Issue[] = [...summaryIssues(text)];
  const h2 = parsed.sections;
  errors.push(...voiceSectionIssues(h2));
  errors.push(...legacyIssues(lines, h2));
  const idx = (name: string) => h2.findIndex(s => s.title.toLowerCase() === name.toLowerCase());

  const isAt = idx('Ideal State');
  if (isAt === -1) errors.push({ rule: 'ideal-state-missing', line: 1, msg: 'SKILL.md must open with "## Ideal State" after the purpose paragraph' });
  else {
    if (isAt !== 0) errors.push({ rule: 'ideal-state-not-first', line: h2[isAt].line, msg: `"## Ideal State" is H2 #${isAt + 1}; it must be the first H2` });
    if (parsed.idealState.length < 2) errors.push({ rule: 'ideal-state-bullets', line: h2[isAt].line, msg: `Ideal State has ${parsed.idealState.length} top-level bullet(s); at least 2 required` });
  }
  const acAt = idx('Anti-criteria');
  if (!hasIntents) {
    if (acAt === -1) errors.push({ rule: 'anti-criteria-missing', line: 1, msg: 'skill has no Intents/; SKILL.md must carry "## Anti-criteria"' });
    else {
      if (acAt !== 1) errors.push({ rule: 'anti-criteria-not-second', line: h2[acAt].line, msg: `"## Anti-criteria" is H2 #${acAt + 1}; it must be the second H2` });
      if (parsed.antiCriteria.length < 1) errors.push({ rule: 'anti-criteria-bullets', line: h2[acAt].line, msg: 'Anti-criteria has no top-level bullet' });
    }
  }

  const rtAt = idx('Intent Routing');
  const needsRouting = hasIntents || (ctx?.files.length ?? 0) > 0;
  if (rtAt === -1) {
    if (needsRouting) errors.push({ rule: 'routing-missing', line: 1, msg: 'the skill has intents or context files but SKILL.md has no "## Intent Routing"' });
  } else {
    const expected = isAt === -1 ? -1 : (acAt === isAt + 1 ? acAt + 1 : isAt + 1);
    if (expected !== -1 && rtAt !== expected) {
      errors.push({ rule: 'routing-not-early', line: h2[rtAt].line, msg: `"## Intent Routing" is H2 #${rtAt + 1}; it must come directly after ${acAt === isAt + 1 ? 'Anti-criteria' : 'Ideal State'} (H2 #${expected + 1})` });
    }
    if (ctx) {
      const routing = h2[rtAt].body;
      for (const f of ctx.files) {
        const name = f.route === 'file' ? f.rel : `${f.dir}/`;
        if (!routing.includes(name)) errors.push({ rule: 'unrouted-file', line: h2[rtAt].line, msg: `${name} is not named in "## Intent Routing"; every intent and context file is reachable from SKILL.md in one hop` });
      }
      const seen = new Set<string>();
      for (const m of routing.matchAll(ROUTED_PATH)) {
        if (seen.has(m[1])) continue;
        seen.add(m[1]);
        if (!ctx.exists(m[1])) errors.push({ rule: 'dead-route', line: h2[rtAt].line, msg: `"## Intent Routing" names ${m[1]}, which does not exist` });
      }
    }
  }
  if (ctx) {
    for (const f of ctx.files) {
      if (/^Intents\/[^/]+\//.test(f.rel)) errors.push({ rule: 'nested-intent', line: 1, msg: `${f.rel} is three levels deep, where IntentLint cannot check it as an intent; flatten to Intents/<CategoryName>.md (Conventions § Folder structure)` });
    }
  }
  const contents = checkContents(text);
  if (contents) errors.push(contents);
  // A single-intent SKILL.md is its own intent: an `## Evals` section there is checked as an intent's is.
  const warnings: Issue[] = [];
  if (!hasIntents && parsed.evals) {
    const ev = evalIssues(parsed, () => assayEvalCatalog());
    errors.push(...ev.errors);
    warnings.push(...ev.warnings);
  }
  // A routed directory is reported once, not once per file in it.
  const unique = errors.filter((e, i) => errors.findIndex(o => o.rule === e.rule && o.msg === e.msg) === i);
  unique.sort((a, b) => a.line - b.line);
  return { errors: unique, warnings };
}

export function lintContextText(text: string): { errors: Issue[]; warnings: Issue[] } {
  const contents = checkContents(text);
  return { errors: contents ? [contents] : [], warnings: [] };
}

// ── target collection ──────────────────────────────────────────────────────

interface Target { path: string; kind: 'intent' | 'skill' | 'context'; hasIntents: boolean; skillDir?: string }

function skipped(p: string): boolean {
  const segs = p.split(sep);
  return segs.includes('node_modules') || segs.includes('LIFEOS_RELEASES');
}

function isDir(p: string): boolean {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

function intentFiles(intentsDir: string): string[] {
  if (!isDir(intentsDir)) return [];
  return readdirSync(intentsDir)
    .filter(f => f.endsWith('.md'))
    .map(f => join(intentsDir, f))
    .filter(f => !isDir(f))
    .sort();
}

function skillTargets(skillDir: string): Target[] {
  const intents = intentFiles(join(skillDir, 'Intents'));
  const out: Target[] = [];
  const skillMd = join(skillDir, 'SKILL.md');
  if (existsSync(skillMd)) out.push({ path: skillMd, kind: 'skill', hasIntents: intents.length > 0, skillDir });
  for (const f of intents) out.push({ path: f, kind: 'intent', hasIntents: false });
  if (existsSync(skillMd)) {
    for (const c of contextFiles(skillDir)) {
      if (c.route === 'file' && !c.rel.startsWith('Intents/')) out.push({ path: c.path, kind: 'context', hasIntents: false });
    }
  }
  return out;
}

/** Resolves CLI paths to the files to lint. Throws UsageError on a missing path or one that holds no skill content. */
export function collectTargets(paths: string[]): Target[] {
  const seen = new Set<string>();
  const out: Target[] = [];
  const add = (t: Target) => {
    if (skipped(t.path) || seen.has(t.path)) return;
    seen.add(t.path);
    out.push(t);
  };
  for (const input of paths) {
    const p = resolve(input);
    if (skipped(p)) continue;
    if (!existsSync(p)) throw new UsageError(`no such path: ${input}`);
    if (!isDir(p)) {
      if (basename(p) === 'SKILL.md') {
        add({ path: p, kind: 'skill', hasIntents: intentFiles(join(p, '..', 'Intents')).length > 0, skillDir: resolve(p, '..') });
      } else if (intentFromPath(p)) {
        add({ path: p, kind: 'intent', hasIntents: false });
      } else {
        throw new UsageError(`not an intent (skills/<Skill>/Intents/<Intent>.md) or SKILL.md: ${input}`);
      }
      continue;
    }
    if (existsSync(join(p, 'SKILL.md'))) { skillTargets(p).forEach(add); continue; }
    if (basename(p) === 'Intents') {
      intentFiles(p).forEach(f => add({ path: f, kind: 'intent', hasIntents: false }));
      continue;
    }
    const skills = readdirSync(p)
      .map(name => join(p, name))
      .filter(d => !skipped(d) && isDir(d) && existsSync(join(d, 'SKILL.md')))
      .sort();
    if (skills.length === 0) throw new UsageError(`no skill (a directory with SKILL.md) under: ${input}`);
    for (const d of skills) skillTargets(d).forEach(add);
  }
  return out;
}

function displayPath(p: string): string {
  const rel = relative(process.cwd(), p);
  return rel && !rel.startsWith('..') ? rel : p;
}

export function lintPaths(paths: string[]): LintResult {
  const files: FileReport[] = [];
  for (const t of collectTargets(paths)) {
    const text = readFileSync(t.path, 'utf8');
    const r = t.kind === 'intent' ? lintIntentText(text)
      : t.kind === 'context' ? lintContextText(text)
      : lintSkillText(text, t.hasIntents, t.skillDir ? { files: contextFiles(t.skillDir), exists: rel => existsSync(join(t.skillDir!, rel)) } : undefined);
    files.push({ path: displayPath(t.path), kind: t.kind, errors: r.errors, warnings: r.warnings });
  }
  return {
    files,
    totals: {
      files: files.length,
      errors: files.reduce((n, f) => n + f.errors.length, 0),
      warnings: files.reduce((n, f) => n + f.warnings.length, 0),
    },
  };
}

/** Issue counts per rule, most frequent first. */
export function ruleCounts(result: LintResult): { rule: string; severity: 'error' | 'warning'; count: number }[] {
  const m = new Map<string, { rule: string; severity: 'error' | 'warning'; count: number }>();
  for (const f of result.files) {
    for (const [sev, list] of [['error', f.errors], ['warning', f.warnings]] as const) {
      for (const i of list) {
        const k = sev + ':' + i.rule;
        const e = m.get(k) ?? { rule: i.rule, severity: sev, count: 0 };
        e.count++;
        m.set(k, e);
      }
    }
  }
  return [...m.values()].sort((a, b) => b.count - a.count || a.rule.localeCompare(b.rule));
}

export function exitCodeFor(result: LintResult, strict: boolean): 0 | 1 {
  if (result.totals.errors > 0) return 1;
  if (strict && result.totals.warnings > 0) return 1;
  return 0;
}

function formatHuman(result: LintResult): string {
  const out: string[] = [];
  for (const f of result.files) {
    if (f.errors.length === 0 && f.warnings.length === 0) continue;
    out.push(f.path);
    const all = [
      ...f.errors.map(i => ({ ...i, sev: 'ERROR' })),
      ...f.warnings.map(i => ({ ...i, sev: 'WARN ' })),
    ].sort((a, b) => a.line - b.line);
    for (const i of all) out.push(`  ${String(i.line).padStart(4)}  ${i.sev}  ${i.rule.padEnd(25)} ${i.msg}`);
  }
  const t = result.totals;
  out.push(`${t.files} files, ${t.errors} errors, ${t.warnings} warnings`);
  return out.join('\n');
}

const USAGE = `Usage: bun LIFEOS/TOOLS/IntentLint.ts <path...> [--json] [--strict]
  <path>    skills root, a skill directory, an Intents/ directory, an intent file, or a SKILL.md
  --json    print {files:[{path,errors,warnings}],totals}
  --strict  exit 1 on warnings as well as errors
Exit: 0 clean, 1 errors (or warnings with --strict), 64 usage error`;

function main(argv: string[]): number {
  const flags = argv.filter(a => a.startsWith('--'));
  const paths = argv.filter(a => !a.startsWith('--'));
  const unknown = flags.filter(f => !['--json', '--strict', '--help'].includes(f));
  if (flags.includes('--help')) { console.log(USAGE); return 0; }
  if (unknown.length > 0 || paths.length === 0) {
    console.error(unknown.length ? `unknown flag: ${unknown.join(' ')}\n${USAGE}` : USAGE);
    return 64;
  }
  let result: LintResult;
  try {
    result = lintPaths(paths);
  } catch (e) {
    if (e instanceof UsageError) { console.error(`IntentLint: ${e.message}`); return 64; }
    throw e;
  }
  if (flags.includes('--json')) {
    console.log(JSON.stringify({
      files: result.files.map(f => ({ path: f.path, errors: f.errors, warnings: f.warnings })),
      totals: result.totals,
    }, null, 2));
  } else {
    console.log(formatHuman(result));
  }
  return exitCodeFor(result, flags.includes('--strict'));
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
