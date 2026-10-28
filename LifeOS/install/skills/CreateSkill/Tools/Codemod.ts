#!/usr/bin/env bun
/**
 * Codemod — the mechanical half of migrating skills to the intent standard
 * (LIFEOS/DOCUMENTATION/Skills/SkillSystem.md § Intent anatomy). It makes only
 * changes that need no judgment, so no model ever retypes existing content:
 *
 *   voice-section    an H2 whose title matches VOICE_SECTION is removed. When every
 *                    line under it is voice boilerplate the whole section goes; when it
 *                    also holds other content, only the heading and the boilerplate go
 *                    and every other line stays where it was.
 *   voice-fence      a fenced block holding only the legacy notify curl (its continuation
 *                    lines, Running lines and comments included); a fence that also holds
 *                    any other command stays whole, since splitting it needs judgment
 *   running-fence    a fenced block whose only content is "Running the **X** intent…" lines
 *   running-line     a standalone "Running the **X** intent in the **Y** skill" line
 *   voice-label      a boilerplate label ("1. **Send voice notification**:", "**When
 *                    executing an intent, do BOTH:**") inside a voice section, or whose
 *                    next non-blank line was removed above
 *   emptied-heading  a heading (H2 and below) whose section held a removed line and now
 *                    holds nothing but blank lines and rules
 *   done-heading     the first `## Done…` / `## The Deliverable` heading becomes
 *                    `## Ideal State`, only when the file has no `## Ideal State`
 *   data-config      in SKILL.md, `## Customization` becomes `## Data & Config`, only
 *                    when the file has no `## Data & Config`
 *
 * A removal that leaves two blank lines side by side drops one of them.
 *
 * Usage (run from ~/.claude):
 *   bun skills/CreateSkill/Tools/Codemod.ts <path...> [--dry-run] [--json] [--allow-out <tsv>]
 *
 * <path> is a skills root, a skill directory, an Intents/ directory or one file, the
 * same targets IntentLint takes. Files with uncommitted changes (`git status
 * --porcelain` non-empty, untracked included) are skipped and reported as
 * skipped-dirty, so a peer session's work is never touched.
 *
 * --allow-out appends IntentPreserve allow lines (`<repo path>\t<token>\t<reason>`)
 * for every token a removal took out of a file, so a later
 * `IntentPreserve --base <pre-codemod rev> --allow <tsv>` passes. Existing lines are
 * kept and duplicates are not written twice. --dry-run writes nothing, the allow file
 * included, and prints what would change.
 *
 * Idempotent: a second run over its own output changes nothing.
 *
 * Exit codes: 0 done (skips included) · 2 git could not run · 64 usage error.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { invariant } from '../../../LIFEOS/TOOLS/Invariant';
import { UsageError as LintUsageError, collectTargets } from '../../../LIFEOS/TOOLS/IntentLint';
import { type Token, extractTokens, normalize, parseAllow } from '../../../LIFEOS/TOOLS/IntentPreserve';
import {
  DONE_SECTION,
  RUNNING_LINE,
  VOICE_CURL,
  VOICE_SECTION,
  fencedBlocks,
  fencedLines,
} from '../../../LIFEOS/TOOLS/lib/IntentSections';

export type ChangeKind =
  | 'voice-section'
  | 'voice-fence'
  | 'running-fence'
  | 'running-line'
  | 'voice-label'
  | 'emptied-heading'
  | 'done-heading'
  | 'data-config';

export const CHANGE_KINDS: ChangeKind[] = [
  'voice-section', 'voice-fence', 'running-fence', 'running-line', 'voice-label', 'emptied-heading', 'done-heading', 'data-config',
];

export interface Change {
  kind: ChangeKind;
  /** 1-based line in the original file. */
  line: number;
  /** 1-based last line for a removed range; equals `line` for a single line. */
  endLine: number;
  detail?: string;
}

export interface CodemodResult { text: string; changes: Change[] }

export const VOICE_ALLOW_REASON = 'codemod: legacy voice notification retired (intent voice hook)';

export class GitError extends Error {
  constructor(message: string) { super(message); this.name = 'GitError'; }
}
export class UsageError extends Error {
  constructor(message: string) { super(message); this.name = 'UsageError'; }
}

// ── line model ─────────────────────────────────────────────────────────────

/**
 * Splits text into lines on `\n` only, so a `\r` stays attached to its line and an
 * unchanged line is written back byte for byte. `finalNewline` records whether the
 * text ended with a newline (the empty string after it is not a line).
 */
export function splitLines(text: string): { lines: string[]; finalNewline: boolean } {
  const lines = text.split('\n');
  const finalNewline = lines.length > 1 && lines[lines.length - 1] === '';
  if (finalNewline) lines.pop();
  return { lines, finalNewline };
}

export function joinLines(lines: string[], finalNewline: boolean): string {
  return lines.join('\n') + (finalNewline && lines.length ? '\n' : '');
}

/** Number of lines the YAML frontmatter occupies (fences included), 0 when there is none. Same rule as IntentLint. */
export function frontmatterLineCount(text: string): number {
  const raw = text.replace(/^﻿/, '');
  const fm = raw.match(/^---\s*\r?\n[\s\S]*?\r?\n---\s*(?:\r?\n|$)/);
  if (!fm) return 0;
  return fm[0].endsWith('\n') ? fm[0].split('\n').length - 1 : fm[0].split('\n').length;
}

export interface Heading { level: number; title: string }

/** An ATX heading outside fences: level and title (closing #s and a trailing \r stripped). */
export function headingOf(line: string): Heading | null {
  const m = line.replace(/\r$/, '').match(/^(#{1,6}) +(\S.*?)(?:\s+#+)?\s*$/);
  return m ? { level: m[1].length, title: m[2].trim() } : null;
}

const HR = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;

/** A label that only ever introduced the legacy voice curl or text notification. */
const VOICE_LABELS = [
  /^(?:send (?:the |a )?)?voice notifications?(?: \([^)]*\))?$/i,
  /^(?:output (?:the )?)?text notification$/i,
  /^when executing an intent,? do both$/i,
  /^send this before acting$/i,
  /^before any intent execution$/i,
];

export function isVoiceLabel(line: string): boolean {
  const s = line
    .replace(/\r$/, '')
    .replace(/^\s*>?\s*(?:[-*+]\s+|\d+[.)]\s*)?/, '')
    .replace(/\*\*|__/g, '')
    .trim()
    .replace(/\s*:\s*$/, '')
    .trim();
  return VOICE_LABELS.some(re => re.test(s));
}

/** Quote, list, emphasis and emoji markers that may open a legacy notification line. */
const LEAD_MARKERS = /^[\s>*_`+\-]*(?:\d+[.)]\s*)?[\s*_`]*(?:[\p{Extended_Pictographic}\uFE0F\u200D]+\s*)*/u;
/** The short legacy form `Running **X** in **Y**...`, which RUNNING_LINE (it needs "intent" or "workflow") does not match. */
const SHORT_RUNNING = /^Running \*\*[^*\n]+\*\* (?:in|from) \*\*[^*\n]+\*\*/;

/** A line carrying the legacy text notification anywhere (RUNNING_LINE), or opening with its short form. */
export function isRunningText(line: string): boolean {
  return RUNNING_LINE.test(line) || SHORT_RUNNING.test(line.replace(LEAD_MARKERS, ''));
}

/** A line that IS the legacy text notification: a Running form opens it after any quote, list, emphasis or emoji marker. */
export function isStandaloneRunningLine(line: string): boolean {
  return isRunningText(line) && /^Running\b/.test(line.replace(LEAD_MARKERS, ''));
}

/**
 * True when a fence holds the legacy notify curl and nothing else a reader could need:
 * lines joined across trailing backslashes form one command, and every command is the
 * curl, a Running line or a shell comment.
 */
export function isVoiceOnlyFence(body: { text: string }[]): boolean {
  const commands: string[] = [];
  let current = '';
  for (const { text } of body) {
    const t = text.trim();
    if (t === '' && current === '') continue;
    current += (current ? ' ' : '') + t;
    if (!t.endsWith('\\')) { commands.push(current); current = ''; }
  }
  if (current) commands.push(current);
  return commands.some(c => VOICE_CURL.test(c))
    && commands.every(c => VOICE_CURL.test(c) || c.startsWith('#') || isRunningText(c));
}

// ── the transform ──────────────────────────────────────────────────────────

/** Applies every mechanical change to one file's text. Pure: no I/O. */
export function codemodText(text: string, kind: 'intent' | 'skill'): CodemodResult {
  const { lines, finalNewline } = splitLines(text);
  const n = lines.length;
  const fmCount = frontmatterLineCount(text);
  const fenced = fencedLines(text).slice(0, n).map((l, i) => l.fenced && i >= fmCount);
  const isBody = (i: number) => i >= fmCount;
  const headings: (Heading | null)[] = lines.map((l, i) => (isBody(i) && !fenced[i] ? headingOf(l) : null));
  const removed = new Set<number>();
  const changes: Change[] = [];
  const removeRange = (from: number, to: number) => { for (let i = from; i <= to; i++) removed.add(i); };

  /** Index of the next heading after `i` whose level is at most `level`, or n. */
  const sectionEnd = (i: number, level: number): number => {
    for (let j = i + 1; j < n; j++) { const h = headings[j]; if (h && h.level <= level) return j; }
    return n;
  };

  // Fenced blocks: the voice curl fence, and the fence that only carries the Running line.
  for (const b of fencedBlocks(text)) {
    const from = b.start - 1;
    const to = b.end - 1;
    if (from < fmCount) continue;
    if (isVoiceOnlyFence(b.body)) {
      removeRange(from, to);
      changes.push({ kind: 'voice-fence', line: b.start, endLine: b.end });
      continue;
    }
    const content = b.body.filter(l => l.text.trim() !== '');
    if (content.length > 0 && content.every(l => isRunningText(l.text))) {
      removeRange(from, to);
      changes.push({ kind: 'running-fence', line: b.start, endLine: b.end });
    }
  }

  // Standalone Running lines outside fences.
  for (let i = fmCount; i < n; i++) {
    if (fenced[i] || removed.has(i) || !isStandaloneRunningLine(lines[i])) continue;
    removed.add(i);
    changes.push({ kind: 'running-line', line: i + 1, endLine: i + 1 });
  }

  // Voice H2 sections. Every line in one is either boilerplate (removed) or content (kept).
  const inVoiceSection = new Set<number>();
  for (let h = fmCount; h < n; h++) {
    const head = headings[h];
    if (!head || head.level !== 2 || !VOICE_SECTION.test(head.title)) continue;
    const end = sectionEnd(h, 2);
    const boilerplate: number[] = [];
    const content: number[] = [];
    for (let i = h + 1; i < end; i++) {
      inVoiceSection.add(i);
      const l = lines[i];
      if (removed.has(i) || l.trim() === '') continue;
      if (!fenced[i] && (isRunningText(l) || isVoiceLabel(l))) boilerplate.push(i);
      else if (!fenced[i] && HR.test(l)) continue;
      else content.push(i);
    }
    if (content.length === 0) {
      removeRange(h, end - 1);
      changes.push({ kind: 'voice-section', line: h + 1, endLine: end, detail: `"${head.title}" removed whole` });
    } else {
      removed.add(h);
      for (const i of boilerplate) removed.add(i);
      changes.push({
        kind: 'voice-section',
        line: h + 1,
        endLine: h + 1,
        detail: `"${head.title}" heading and ${boilerplate.length} boilerplate line(s) removed; ${content.length} content line(s) kept in place`,
      });
    }
  }

  // Labels that introduced a removed voice element (bottom-up, so a chain of labels resolves).
  for (let i = n - 1; i >= fmCount; i--) {
    if (removed.has(i) || fenced[i] || !isVoiceLabel(lines[i])) continue;
    let next = i + 1;
    while (next < n && lines[next].trim() === '' && !removed.has(next)) next++;
    if (inVoiceSection.has(i) || (next < n && removed.has(next))) {
      removed.add(i);
      changes.push({ kind: 'voice-label', line: i + 1, endLine: i + 1 });
    }
  }

  // Headings left empty by the removals above, deepest first, until nothing changes.
  if (removed.size > 0) {
    let again = true;
    while (again) {
      again = false;
      for (let h = n - 1; h >= fmCount; h--) {
        const head = headings[h];
        if (!head || head.level < 2 || removed.has(h)) continue;
        const end = sectionEnd(h, head.level);
        let touched = false;
        let empty = true;
        const rules: number[] = [];
        for (let i = h + 1; i < end; i++) {
          if (removed.has(i)) { touched = true; continue; }
          const l = lines[i];
          if (l.trim() === '') continue;
          if (!fenced[i] && HR.test(l)) { rules.push(i); continue; }
          empty = false;
          break;
        }
        if (touched && empty) {
          removed.add(h);
          for (const r of rules) removed.add(r);
          changes.push({ kind: 'emptied-heading', line: h + 1, endLine: h + 1, detail: `"${head.title}"` });
          again = true;
        }
      }
    }
  }

  // Renames, on lines that survive.
  const h2Titles = (): string[] => headings.flatMap((h, i) => (h && h.level === 2 && !removed.has(i) ? [h.title.toLowerCase()] : []));
  const renamed = new Map<number, string>();
  const rename = (i: number, title: string) => renamed.set(i, `## ${title}${lines[i].endsWith('\r') ? '\r' : ''}`);
  if (!h2Titles().includes('ideal state')) {
    const at = headings.findIndex((h, i) => h !== null && h.level === 2 && !removed.has(i) && DONE_SECTION.test(h.title));
    if (at !== -1) {
      rename(at, 'Ideal State');
      changes.push({ kind: 'done-heading', line: at + 1, endLine: at + 1, detail: `"${headings[at]!.title}" → "Ideal State"` });
    }
  }
  if (kind === 'skill' && !h2Titles().includes('data & config')) {
    const at = headings.findIndex((h, i) => h !== null && h.level === 2 && !removed.has(i) && /^customizations?$/i.test(h.title));
    if (at !== -1) {
      rename(at, 'Data & Config');
      changes.push({ kind: 'data-config', line: at + 1, endLine: at + 1, detail: `"${headings[at]!.title}" → "Data & Config"` });
    }
  }

  if (removed.size === 0 && renamed.size === 0) return { text, changes: [] };

  // Rebuild. Where a removal sits between blank lines, only the first blank stays.
  const out: string[] = [];
  let pendingJunction = false;
  for (let i = 0; i < n; i++) {
    if (removed.has(i)) { pendingJunction = true; continue; }
    const line = renamed.get(i) ?? lines[i];
    if (pendingJunction && line.trim() === '' && isBody(i)) {
      const prev = out.length > fmCount ? out[out.length - 1] : undefined;
      if (prev === undefined || prev.trim() === '') continue; // keep collapsing until a non-blank line
    }
    pendingJunction = false;
    out.push(line);
  }
  // A removal at the end of the file leaves no trailing blank line behind.
  if (pendingJunction) while (out.length > fmCount && out[out.length - 1].trim() === '') out.pop();

  changes.sort((a, b) => a.line - b.line);
  return { text: joinLines(out, finalNewline), changes };
}

// ── tokens and allow lines (shared with ApplyIntentPlan) ───────────────────

/** Tokens IntentPreserve extracts from `before` that are absent from `after`, with IntentPreserve's own matching rules. */
export function lostTokens(before: string, after: string): Token[] {
  const hay = normalize(after);
  const plain = hay.replace(/\*\*|__/g, '');
  return extractTokens(before).filter(t => !(t.kind === 'guard-line' ? plain : hay).includes(t.text));
}

/** One IntentPreserve allow line. The token is already whitespace-normalized; the reason must be TSV-safe and at least 8 characters. */
export function allowLine(repoPath: string, token: string, reason: string): string {
  invariant(!/[\t\r\n]/.test(repoPath) && repoPath.length > 0, `allow path must be one TSV field: ${JSON.stringify(repoPath)}`);
  invariant(!/[\t\r\n]/.test(token) && token.length > 0, `allow token must be one TSV field: ${JSON.stringify(token)}`);
  invariant(!/[\t\r\n]/.test(reason) && reason.trim().length >= 8, `allow reason must be one TSV field of 8+ characters: ${JSON.stringify(reason)}`);
  return `${repoPath}\t${token}\t${reason}`;
}

/** Appends allow lines to a TSV file, skipping lines it already holds. Returns how many were added. */
export function appendAllowFile(outPath: string, newLines: string[]): number {
  const existing = existsSync(outPath) ? readFileSync(outPath, 'utf8') : '';
  const have = new Set(existing.split(/\r?\n/));
  const add = [...new Set(newLines)].filter(l => !have.has(l));
  if (add.length === 0) return 0;
  const next = existing + (existing && !existing.endsWith('\n') ? '\n' : '') + add.join('\n') + '\n';
  invariant(parseAllow(next, outPath).length >= add.length, 'allow file must parse after the append');
  invariant(next.startsWith(existing), 'appending to the allow file never rewrites what it already held');
  writeFileSync(outPath, next);
  return add.length;
}

// ── git ────────────────────────────────────────────────────────────────────

export function git(cwd: string, args: string[]): string {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    const err = e as { stderr?: Buffer | string; message: string };
    throw new GitError(`git ${args.slice(0, 3).join(' ')}: ${String(err.stderr ?? err.message).trim()}`);
  }
}

/** realpath of the repository holding `dir`. */
export function repoRootOf(dir: string): string {
  return realpathSync(git(dir, ['rev-parse', '--show-toplevel']).trim());
}

/** Path of `abs` relative to `root`, `/`-separated, after resolving symlinks; throws when it falls outside. */
export function repoPath(root: string, abs: string): string {
  const rel = relative(root, realpathSync(abs));
  invariant(rel !== '' && !rel.startsWith('..') && !isAbsolute(rel), `${abs} must sit inside repository ${root}`);
  return rel.split(sep).join('/');
}

/** Repo-relative paths among `rels` that `git status --porcelain` reports (modified, staged, untracked, renamed). */
export function dirtyPaths(root: string, rels: string[]): Set<string> {
  const dirty = new Set<string>();
  if (rels.length === 0) return dirty;
  const out = git(root, ['--literal-pathspecs', 'status', '--porcelain', '-z', '--untracked-files=all', '--', ...rels]);
  const parts = out.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (entry.length < 4) continue;
    dirty.add(entry.slice(3));
    if (entry[0] === 'R' || entry[0] === 'C') { const orig = parts[++i]; if (orig) dirty.add(orig); }
  }
  return dirty;
}

// ── run over paths ─────────────────────────────────────────────────────────

export type FileStatus = 'changed' | 'unchanged' | 'skipped-dirty';
export interface FileOutcome { path: string; status: FileStatus; changes: Change[]; allow: number }
export interface RunTotals {
  files: number;
  changed: number;
  unchanged: number;
  skippedDirty: number;
  byKind: Record<ChangeKind, number>;
  filesByKind: Record<ChangeKind, number>;
  allowLines: number;
  allowWritten: number;
}
export interface RunResult { dryRun: boolean; files: FileOutcome[]; totals: RunTotals; allowOut: string | null; allowLines: string[] }

export function runCodemod(opts: { paths: string[]; dryRun: boolean; allowOut: string | null; cwd?: string }): RunResult {
  const cwd = opts.cwd ?? process.cwd();
  let targets: ReturnType<typeof collectTargets>;
  try {
    targets = collectTargets(opts.paths.map(p => resolve(cwd, p)));
  } catch (e) {
    if (e instanceof LintUsageError) throw new UsageError(e.message);
    throw e;
  }

  // One `git status` per repository, every target as a literal pathspec.
  const byRoot = new Map<string, { abs: string; rel: string; kind: 'intent' | 'skill' }[]>();
  const rootCache = new Map<string, string>();
  for (const t of targets) {
    const dir = dirname(t.path);
    let root = rootCache.get(dir);
    if (root === undefined) { root = repoRootOf(dir); rootCache.set(dir, root); }
    const list = byRoot.get(root) ?? [];
    list.push({ abs: t.path, rel: repoPath(root, t.path), kind: t.kind });
    byRoot.set(root, list);
  }

  const zero = () => Object.fromEntries(CHANGE_KINDS.map(k => [k, 0])) as Record<ChangeKind, number>;
  const totals: RunTotals = { files: 0, changed: 0, unchanged: 0, skippedDirty: 0, byKind: zero(), filesByKind: zero(), allowLines: 0, allowWritten: 0 };
  const files: FileOutcome[] = [];
  const allLines: string[] = [];

  for (const [root, list] of byRoot) {
    const dirty = dirtyPaths(root, list.map(f => f.rel));
    for (const f of list) {
      totals.files++;
      if (dirty.has(f.rel)) {
        totals.skippedDirty++;
        files.push({ path: f.rel, status: 'skipped-dirty', changes: [], allow: 0 });
        continue;
      }
      const before = readFileSync(f.abs, 'utf8');
      const { text: after, changes } = codemodText(before, f.kind);
      if (changes.length === 0) { totals.unchanged++; files.push({ path: f.rel, status: 'unchanged', changes, allow: 0 }); continue; }
      const lines = lostTokens(before, after).map(t => allowLine(f.rel, t.text, VOICE_ALLOW_REASON));
      allLines.push(...lines);
      totals.changed++;
      for (const c of changes) totals.byKind[c.kind]++;
      for (const k of new Set(changes.map(c => c.kind))) totals.filesByKind[k]++;
      files.push({ path: f.rel, status: 'changed', changes, allow: lines.length });
      if (opts.dryRun) continue;
      invariant(after !== before, `codemod reported changes to ${f.rel} but the text is identical`);
      invariant(readFileSync(f.abs, 'utf8') === before, `${f.rel} changed on disk while the codemod read it`);
      invariant(codemodText(after, f.kind).changes.length === 0, `codemod output for ${f.rel} is not a fixed point`);
      invariant(repoPath(root, f.abs) === f.rel, `${f.rel} must resolve inside ${root}`);
      writeFileSync(f.abs, after);
    }
  }
  totals.allowLines = allLines.length;
  const allowOut = opts.allowOut ? resolve(cwd, opts.allowOut) : null;
  if (allowOut && !opts.dryRun && allLines.length > 0) totals.allowWritten = appendAllowFile(allowOut, allLines);
  return { dryRun: opts.dryRun, files, totals, allowOut, allowLines: allLines };
}

// ── CLI ────────────────────────────────────────────────────────────────────

const HELP = `Codemod — mechanical intent-standard changes, no judgment, no retyping

  bun skills/CreateSkill/Tools/Codemod.ts <path...> [--dry-run] [--json] [--allow-out <tsv>]

  <path>        skills root, skill directory, Intents/ directory, intent file or SKILL.md
  --dry-run     write nothing (allow file included); print what would change
  --json        print {dryRun, files, totals, allowOut} as JSON
  --allow-out   append IntentPreserve allow lines for every token a removal took out

Changes: voice-section, voice-fence, running-fence, running-line, voice-label,
emptied-heading, done-heading, data-config. Files with uncommitted changes are skipped.
Exit: 0 done, 2 git error, 64 usage error.`;

function parseArgs(argv: string[]): { paths: string[]; dryRun: boolean; json: boolean; allowOut: string | null; help: boolean } {
  const paths: string[] = [];
  let dryRun = false;
  let json = false;
  let help = false;
  let allowOut: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') dryRun = true;
    else if (a === '--json') json = true;
    else if (a === '--help') help = true;
    else if (a === '--allow-out') {
      const v = argv[++i];
      if (!v || v.startsWith('--')) throw new UsageError('--allow-out needs a file path');
      allowOut = v;
    } else if (a.startsWith('--')) throw new UsageError(`unknown flag ${a}`);
    else paths.push(a);
  }
  if (!help && paths.length === 0) throw new UsageError('at least one path is required');
  return { paths, dryRun, json, allowOut, help };
}

function formatHuman(r: RunResult): string {
  const out: string[] = [];
  const verb = r.dryRun ? 'would change' : 'changed';
  for (const f of r.files) {
    if (f.status === 'skipped-dirty') { out.push(`${f.path}  skipped-dirty (uncommitted changes)`); continue; }
    if (f.status !== 'changed') continue;
    out.push(`${f.path}  ${verb}`);
    for (const c of f.changes) {
      const span = c.endLine > c.line ? `${c.line}-${c.endLine}` : String(c.line);
      out.push(`  ${span.padStart(9)}  ${c.kind.padEnd(16)}${c.detail ? ' ' + c.detail : ''}`);
    }
  }
  const t = r.totals;
  const kinds = CHANGE_KINDS.filter(k => t.byKind[k] > 0).map(k => `${k} ${t.byKind[k]}`).join(', ');
  out.push(`${t.files} files: ${t.changed} ${verb}, ${t.unchanged} unchanged, ${t.skippedDirty} skipped-dirty${kinds ? ` (${kinds})` : ''}`);
  if (r.allowOut) out.push(r.dryRun ? `allow lines: ${t.allowLines} (not written: --dry-run)` : `allow lines: ${t.allowWritten} new in ${r.allowOut}`);
  else if (t.allowLines) out.push(`allow lines: ${t.allowLines} (pass --allow-out to keep them)`);
  return out.join('\n');
}

export function main(argv: string[]): number {
  let args: ReturnType<typeof parseArgs>;
  try { args = parseArgs(argv); } catch (e) {
    if (e instanceof UsageError) { console.error(`codemod: ${e.message}\n${HELP}`); return 64; }
    throw e;
  }
  if (args.help) { console.log(HELP); return 0; }
  let result: RunResult;
  try {
    result = runCodemod({ paths: args.paths, dryRun: args.dryRun, allowOut: args.allowOut });
  } catch (e) {
    if (e instanceof UsageError) { console.error(`codemod: ${e.message}`); return 64; }
    if (e instanceof GitError) { console.error(`codemod: ${e.message}`); return 2; }
    throw e;
  }
  if (args.json) {
    console.log(JSON.stringify({
      dryRun: result.dryRun,
      files: result.files.filter(f => f.status !== 'unchanged'),
      totals: result.totals,
      allowOut: result.allowOut,
    }, null, 2));
  } else console.log(formatHuman(result));
  return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
