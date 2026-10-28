#!/usr/bin/env bun
/**
 * SkillContents — the contents line on long skill files, and which files a skill
 * must route from SKILL.md (LIFEOS/DOCUMENTATION/Skills/SkillSystem.md § SKILL.md anatomy).
 *
 * Usage:
 *   bun LIFEOS/TOOLS/SkillContents.ts <path...> [--write] [--json]
 *
 * A path is the skills root, one skill directory, or one .md file in a skill.
 * Without --write it checks and exits 1 when any file over 100 lines lacks a
 * current contents line. With --write it inserts or refreshes the line in place.
 *
 * The contents line is `**Contents:** A · B · C`, naming every H2 in order, placed
 * after the H1 and before the first H2. A file needs one when it runs past
 * CONTENTS_MIN_LINES lines and has at least two H2s, so a head-only read still
 * shows everything the file covers (Anthropic skill authoring guidance: long
 * reference files get a table of contents).
 *
 * Exit codes: 0 clean (or written), 1 a stale or missing line (check mode), 64 usage error.
 *
 * @version 1.0.0
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { join, relative, resolve, sep } from 'path';
import { fencedLines } from './lib/IntentSections';

export const CONTENTS_MIN_LINES = 100;
export const CONTENTS_PREFIX = '**Contents:**';
const SEP = ' · ';

/** Directories whose files are not context a model reads to run the skill: tool code and help, vendored deps. */
const IGNORED_DIRS = new Set(['Tools', 'node_modules']);
/** Directories whose every .md file is routed one by one from SKILL.md. Anything else is routed by directory. */
const PER_FILE_DIRS = new Set(['Intents', 'References']);

export interface ContextFile {
  /** Absolute path. */
  path: string;
  /** Path relative to the skill directory, e.g. `References/Api.md`. */
  rel: string;
  /** `file`: SKILL.md must name `rel`. `dir`: SKILL.md must name `<dir>/`. */
  route: 'file' | 'dir';
  /** For `dir` routes, the top-level directory name. */
  dir?: string;
}

function isDir(p: string): boolean {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

function walkMd(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (name.startsWith('.')) continue;
    const p = join(dir, name);
    if (isDir(p)) { if (!IGNORED_DIRS.has(name)) out.push(...walkMd(p)); continue; }
    if (name.endsWith('.md')) out.push(p);
  }
  return out;
}

/** Every .md a skill holds besides SKILL.md, with how SKILL.md must route it. */
export function contextFiles(skillDir: string): ContextFile[] {
  const out: ContextFile[] = [];
  for (const p of walkMd(skillDir)) {
    const rel = relative(skillDir, p).split(sep).join('/');
    if (rel === 'SKILL.md') continue;
    const top = rel.includes('/') ? rel.split('/')[0] : null;
    if (top === null || PER_FILE_DIRS.has(top)) out.push({ path: p, rel, route: 'file' });
    else out.push({ path: p, rel, route: 'dir', dir: top });
  }
  return out;
}

/** Unfenced H2 titles outside frontmatter, with 0-based line indexes. */
function h2s(lines: { text: string; fenced: boolean }[], fmLines: number): { title: string; at: number }[] {
  return lines
    .map((l, i) => ({ l, i }))
    .filter(({ l, i }) => i >= fmLines && !l.fenced && /^## \S/.test(l.text))
    .map(({ l, i }) => ({ title: l.text.slice(3).trim(), at: i }));
}

function frontmatterLines(text: string): number {
  const fm = text.match(/^---\s*\r?\n[\s\S]*?\r?\n---\s*(?:\r?\n|$)/);
  return fm ? fm[0].split(/\r?\n/).length - 1 : 0;
}

/** True when the file is long enough, and has enough sections, to need a contents line. */
export function needsContents(text: string): boolean {
  const lines = fencedLines(text);
  return lines.length > CONTENTS_MIN_LINES && h2s(lines, frontmatterLines(text)).length >= 2;
}

/** The contents line this file should carry. */
export function expectedContents(text: string): string {
  return CONTENTS_PREFIX + ' ' + h2s(fencedLines(text), frontmatterLines(text)).map(h => h.title).join(SEP);
}

/** Null when the file is fine; otherwise the rule broken and the 1-based line to point at. */
export function checkContents(text: string): { rule: 'contents-missing' | 'contents-stale'; line: number; msg: string } | null {
  const lines = fencedLines(text);
  const fm = frontmatterLines(text);
  const heads = h2s(lines, fm);
  const first = heads.length ? heads[0].at : lines.length;
  const want = expectedContents(text);
  const at = lines.findIndex((l, i) => i >= fm && i < first && !l.fenced && l.text.startsWith(CONTENTS_PREFIX));
  if (!needsContents(text)) {
    // A file that shrank below the threshold keeps no contents line: a stale one misleads.
    return at !== -1 && lines[at].text.trim() !== want ? { rule: 'contents-stale', line: at + 1, msg: 'contents line no longer matches the H2s; run bun LIFEOS/TOOLS/SkillContents.ts --write' } : null;
  }
  if (at === -1) return { rule: 'contents-missing', line: 1, msg: `file runs ${lines.length} lines with no "${CONTENTS_PREFIX}" line before its first H2: run bun LIFEOS/TOOLS/SkillContents.ts --write` };
  if (lines[at].text.trim() !== want) return { rule: 'contents-stale', line: at + 1, msg: `contents line does not name every H2 in order; expected: ${want}` };
  return null;
}

/** Inserts or refreshes the contents line; returns the text unchanged when none is needed. */
export function applyContents(text: string): string {
  const lines = fencedLines(text);
  const fm = frontmatterLines(text);
  const raw = lines.map(l => l.text);
  const heads = h2s(lines, fm);
  const existing = lines.findIndex((l, i) => i >= fm && (heads.length === 0 || i < heads[0].at) && !l.fenced && l.text.startsWith(CONTENTS_PREFIX));
  if (!needsContents(text)) {
    if (existing === -1 || raw[existing].trim() === expectedContents(text)) return text;
    const drop = existing + 1 < raw.length && raw[existing + 1].trim() === '' ? 2 : 1;
    raw.splice(existing, drop);
    return raw.join('\n');
  }
  const want = expectedContents(text);
  if (existing !== -1) {
    raw[existing] = want;
    return raw.join('\n');
  }
  const h1 = lines.findIndex((l, i) => i >= fm && i < heads[0].at && !l.fenced && /^# \S/.test(l.text));
  const insertAt = h1 === -1 ? fm : h1 + 1;
  const block = h1 === -1 ? [want, ''] : ['', want];
  raw.splice(insertAt, 0, ...block);
  return raw.join('\n');
}

// ── CLI ────────────────────────────────────────────────────────────────────

function skillDirs(input: string): string[] {
  const p = resolve(input);
  if (!existsSync(p)) throw new Error(`no such path: ${input}`);
  if (!isDir(p)) return [];
  if (existsSync(join(p, 'SKILL.md'))) return [p];
  return readdirSync(p).map(n => join(p, n)).filter(d => isDir(d) && existsSync(join(d, 'SKILL.md'))).sort();
}

function targetsFor(input: string): string[] {
  const p = resolve(input);
  if (existsSync(p) && !isDir(p)) return p.endsWith('.md') ? [p] : [];
  return skillDirs(input).flatMap(d => [join(d, 'SKILL.md'), ...contextFiles(d).filter(f => f.route === 'file').map(f => f.path)]);
}

const USAGE = `Usage: bun LIFEOS/TOOLS/SkillContents.ts <path...> [--write] [--json]
  <path>   skills root, a skill directory, or one .md file
  --write  insert or refresh the contents line in every file that needs one
  --json   print {files:[{path,status}]}
Exit: 0 clean or written, 1 missing/stale lines (check mode), 64 usage error`;

function main(argv: string[]): number {
  const flags = argv.filter(a => a.startsWith('--'));
  const paths = argv.filter(a => !a.startsWith('--'));
  if (flags.includes('--help')) { console.log(USAGE); return 0; }
  const unknown = flags.filter(f => !['--write', '--json'].includes(f));
  if (unknown.length || paths.length === 0) { console.error(USAGE); return 64; }
  const write = flags.includes('--write');
  const report: { path: string; status: string }[] = [];
  let targets: string[];
  try { targets = paths.flatMap(targetsFor); } catch (e) { console.error(`SkillContents: ${(e as Error).message}`); return 64; }
  for (const t of targets) {
    const text = readFileSync(t, 'utf8');
    const issue = checkContents(text);
    if (!issue) continue;
    if (write) { writeFileSync(t, applyContents(text)); report.push({ path: relative(process.cwd(), t), status: 'written' }); }
    else report.push({ path: relative(process.cwd(), t), status: issue.rule });
  }
  if (flags.includes('--json')) console.log(JSON.stringify({ files: report }, null, 2));
  else { for (const r of report) console.log(`${r.status.padEnd(17)} ${r.path}`); console.log(`${targets.length} files checked, ${report.length} ${write ? 'written' : 'need a contents line'}`); }
  return !write && report.length > 0 ? 1 : 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));

