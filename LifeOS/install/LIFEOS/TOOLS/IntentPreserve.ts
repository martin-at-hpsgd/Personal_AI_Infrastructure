#!/usr/bin/env bun
/**
 * IntentPreserve — proves an intent migration lost no tool contract.
 *
 * Usage (run from the repo root, e.g. ~/.claude):
 *   bun LIFEOS/TOOLS/IntentPreserve.ts [--base <git-rev>] [--allow <file>] [--json] <path...>
 *
 * For every `.md` file under <path...> that differs from --base (default HEAD),
 * deleted files included, the BASE version is mined for tokens:
 *   - every non-empty line inside a fenced block (whitespace-normalized)
 *   - every inline code span outside fences
 *   - every URL outside fences
 *   - every `--flag` outside fences
 *   - every prose line under a safety/gotcha/constraint-style heading, and every
 *     prose line carrying MUST, NEVER, DO NOT, ⚠️ or 🚨 (list markers and bold
 *     stripped), so a gate written as prose cannot vanish in a rewrite
 * Each token must appear, as a whitespace-normalized substring, somewhere in the
 * union of the CURRENT working-tree text of every `.md` file in the same skill
 * directory (`skills/<Skill>`): content may move between SKILL.md and intents or
 * between intents.
 *
 * Exempt automatically: whole fenced blocks containing the legacy voice curl,
 * any token or line naming `localhost:31337/notify`, and "Running the **X** intent
 * in the **Y** skill" lines (both retired by the IntentVoice hook).
 *
 * --allow <file> takes TSV lines `<repo-relative path>\t<token>\t<reason>`; the
 * reason must be at least 8 characters. Blank lines and `#` comments are ignored.
 *
 * Exit codes: 0 every token preserved, 1 a token is missing, 2 git could not run
 * (not a repository, unknown base) or a skill root resolves outside the repository,
 * 64 usage error. Read-only: writes nothing.
 *
 * @version 1.0.2
 */

import { execFileSync, spawnSync } from 'child_process';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'fs';
import { basename, dirname, join, relative, resolve, sep } from 'path';
import { RUNNING_LINE, VOICE_CURL, fencedBlocks, fencedLines } from './lib/IntentSections';
import { confinedPath } from './lib/Boundary';

export type TokenKind = 'fence-line' | 'code-span' | 'url' | 'flag' | 'guard-line';

/** A heading whose prose is a safety gate or a verified gotcha: every line under it must survive. */
const GUARD_HEADING = /^[^A-Za-z]*(gotchas?|safety|warnings?|cautions?|critical|never|constraints?|guards?|security|authori[sz]ation|permissions?|anti-?criteria|do not)\b/i;
/** A prose line that is a gate wherever it sits. */
const GUARD_MARKER = /\b(MUST|NEVER|DO NOT|DON'T|FORBIDDEN|NOT ALLOWED|REQUIRED)\b|⚠️|🚨|⛔/;

/** A prose line reduced to its words: list marker, quote marker and emphasis stripped, so a gate may move from a numbered step to a bullet. */
export function guardLine(line: string): string {
  const s = line.replace(/\*\*|__/g, '').replace(/^\s*>?\s*(?:[-*+]|\d+[.)])?\s*/, '');
  const n = normalize(s);
  return n.length >= 12 ? n : '';
}
export interface Token { kind: TokenKind; text: string; line: number }
export interface Missing { path: string; line: number; kind: TokenKind; token: string }
export interface AllowEntry { path: string; token: string; reason: string }
export interface PreserveResult {
  base: string;
  checked: { files: number; skills: number; tokens: number };
  exempted: { allow: number };
  missing: Missing[];
}

export class UsageError extends Error {}
export class GitError extends Error {}
/** A path the check would read resolves outside the repository: the run cannot judge it, so it fails (exit 2). */
export class BoundaryError extends Error {}

const MIN_REASON = 8;
const URL_RE = /https?:\/\/[^\s<>()\[\]"'`]+/g;
const FLAG_RE = /(?<![\w-])--[A-Za-z][\w-]*/g;

/** Collapses every whitespace run to one space and trims: the comparison form for tokens and haystacks. */
export function normalize(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function exemptText(s: string): boolean {
  return VOICE_CURL.test(s) || RUNNING_LINE.test(s);
}

/** An inline code span with a single- or multi-backtick delimiter; group 2 is the content. */
const CODE_SPAN = /(?<!`)(`+)(?!`)([\s\S]*?[^`])\1(?!`)/g;

/** Inline code spans of one line, contents only. */
function codeSpans(line: string): string[] {
  const out: string[] = [];
  for (const m of line.matchAll(CODE_SPAN)) {
    const inner = m[2].trim();
    if (inner) out.push(inner);
  }
  return out;
}

/** Extracts the tokens a migration must preserve from one markdown text. */
export function extractTokens(text: string): Token[] {
  const tokens: Token[] = [];
  for (const block of fencedBlocks(text)) {
    if (block.body.some(l => VOICE_CURL.test(l.text))) continue; // the legacy voice block is exempt whole
    for (const l of block.body) {
      const n = normalize(l.text);
      if (n && !exemptText(n)) tokens.push({ kind: 'fence-line', text: n, line: l.line });
    }
  }
  fencedLines(text).forEach((l, i) => {
    if (l.fenced || exemptText(l.text)) return;
    const no = i + 1;
    for (const s of codeSpans(l.text)) {
      const n = normalize(s);
      if (!exemptText(n)) tokens.push({ kind: 'code-span', text: n, line: no });
    }
    const prose = l.text.replace(CODE_SPAN, ' ');
    for (const m of prose.matchAll(URL_RE)) {
      const u = m[0].replace(/[.,;:!?*_]+$/, '');
      if (!exemptText(u)) tokens.push({ kind: 'url', text: u, line: no });
    }
    for (const m of prose.matchAll(FLAG_RE)) tokens.push({ kind: 'flag', text: m[0], line: no });
  });
  let guarded = false;
  fencedLines(text).forEach((l, i) => {
    if (l.fenced) return;
    const h = l.text.match(/^#{1,6}\s+(.*)$/);
    if (h) { guarded = GUARD_HEADING.test(h[1]); return; }
    const g = guardLine(l.text);
    if (g && (guarded || GUARD_MARKER.test(l.text)) && !exemptText(g)) tokens.push({ kind: 'guard-line', text: g, line: i + 1 });
  });
  tokens.sort((a, b) => a.line - b.line);
  // One token per distinct text: the first occurrence carries the line number.
  const seen = new Set<string>();
  return tokens.filter(t => (seen.has(t.text) ? false : (seen.add(t.text), true)));
}

export function parseAllow(text: string, source = 'allow file'): AllowEntry[] {
  const out: AllowEntry[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    if (!raw.trim() || raw.trimStart().startsWith('#')) return;
    const parts = raw.split('\t');
    if (parts.length < 3) throw new UsageError(`${source}:${i + 1}: expected <path>\\t<token>\\t<reason>`);
    const [path, token, ...rest] = parts;
    const reason = rest.join('\t').trim();
    if (!path.trim() || !token.trim()) throw new UsageError(`${source}:${i + 1}: empty path or token`);
    if (reason.length < MIN_REASON) throw new UsageError(`${source}:${i + 1}: reason must be at least ${MIN_REASON} characters`);
    out.push({ path: path.trim(), token: normalize(token), reason });
  });
  return out;
}

// ── git ────────────────────────────────────────────────────────────────────

function git(cwd: string, args: string[]): string {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    const err = e as { stderr?: Buffer | string; message: string };
    throw new GitError(`git ${args.join(' ')}: ${String(err.stderr ?? err.message).trim()}`);
  }
}

/** Reads `<base>:<path>` for many paths in one `git cat-file --batch`; a path absent at base maps to null. */
function showAtBase(root: string, base: string, paths: string[]): Map<string, string | null> {
  const out = new Map<string, string | null>();
  if (paths.length === 0) return out;
  const r = spawnSync('git', ['cat-file', '--batch'], {
    cwd: root,
    input: paths.map(p => `${base}:${p}`).join('\n') + '\n',
    maxBuffer: 1024 * 1024 * 1024,
  });
  if (r.status !== 0 || !r.stdout) throw new GitError(`git cat-file --batch: ${String(r.stderr ?? '').trim()}`);
  const buf: Buffer = r.stdout;
  let pos = 0;
  for (const p of paths) {
    const nl = buf.indexOf(0x0a, pos);
    if (nl === -1) throw new GitError(`git cat-file --batch: truncated output at ${p}`);
    const header = buf.subarray(pos, nl).toString('utf8');
    pos = nl + 1;
    if (header.endsWith(' missing') || header.endsWith(' ambiguous')) { out.set(p, null); continue; }
    const m = header.match(/^[0-9a-f]+ (\w+) (\d+)$/);
    if (!m) throw new GitError(`git cat-file --batch: unexpected header "${header}"`);
    const size = Number(m[2]);
    out.set(p, m[1] === 'blob' ? buf.subarray(pos, pos + size).toString('utf8') : null);
    pos += size + 1; // content plus its trailing newline
  }
  return out;
}

function skipped(rel: string): boolean {
  const segs = rel.split('/');
  return segs.includes('node_modules') || segs.includes('LIFEOS_RELEASES');
}

/** `skills/<Skill>` for a path under a skills tree; otherwise the file's own directory. */
export function skillDirOf(rel: string): string {
  const segs = rel.split('/');
  const i = segs.indexOf('skills');
  if (i !== -1 && segs.length > i + 2) return segs.slice(0, i + 2).join('/');
  return segs.slice(0, -1).join('/') || '.';
}

/**
 * Markdown files under a skill directory, confined to that directory by canonical path. Every entry
 * is resolved with realpath before it is read or entered: a symlink whose target lies outside the
 * skill root is skipped (it would let outside text stand in for a missing guard token), and each real
 * directory is entered once, so a symlink cycle cannot recurse without bound.
 */
export function mdFilesUnder(dir: string): string[] {
  const out: string[] = [];
  let rootReal: string;
  try { rootReal = realpathSync(dir); } catch { return out; }
  const inRoot = (p: string) => p === rootReal || p.startsWith(rootReal + sep);
  const seenDirs = new Set<string>([rootReal]);
  const seenFiles = new Set<string>();
  const walk = (d: string) => {
    let entries: string[];
    try { entries = readdirSync(d); } catch { return; }
    for (const name of entries) {
      if (name === 'node_modules' || name === '.git') continue;
      const p = join(d, name);
      let real: string;
      let st;
      try { real = realpathSync(p); st = statSync(real); } catch { continue; }
      if (!inRoot(real)) continue;
      if (st.isDirectory()) {
        if (seenDirs.has(real)) continue;
        seenDirs.add(real);
        walk(p);
      } else if (name.endsWith('.md') && st.isFile() && !seenFiles.has(real)) {
        seenFiles.add(real);
        out.push(p);
      }
    }
  };
  walk(dir);
  return out.sort();
}

/** realpath of the deepest existing ancestor, with the missing tail re-appended (deleted paths stay addressable). */
function realish(abs: string): string {
  const tail: string[] = [];
  let cur = abs;
  while (!existsSync(cur)) {
    const parent = dirname(cur);
    if (parent === cur) return abs;
    tail.unshift(basename(cur));
    cur = parent;
  }
  return join(realpathSync(cur), ...tail);
}

export interface PreserveOptions { cwd: string; base: string; paths: string[]; allow: AllowEntry[] }

export function checkPreserve(opts: PreserveOptions): PreserveResult {
  const root = git(opts.cwd, ['rev-parse', '--show-toplevel']).trim();
  git(root, ['rev-parse', '--verify', '--quiet', `${opts.base}^{commit}`]);
  // A path need not exist on disk: a deleted file or directory is still a valid pathspec against base.
  const realRoot = realpathSync(root);
  const specs = opts.paths.map(p => {
    const abs = resolve(opts.cwd, p);
    const rel = relative(realRoot, realish(abs));
    if (rel.startsWith('..')) throw new UsageError(`path outside the repository: ${p}`);
    return rel.split(sep).join('/') || '.';
  });
  const changed = git(root, ['diff', '--name-only', '--no-renames', '-z', opts.base, '--', ...specs])
    .split('\0')
    .filter(f => f.endsWith('.md') && !skipped(f));
  const baseText = showAtBase(root, opts.base, changed);

  const allowKey = (path: string, token: string) => path + '\0' + token;
  const allow = new Set(opts.allow.map(a => allowKey(a.path, a.token)));
  const unionCache = new Map<string, string>();
  const union = (skillDir: string): string => {
    let u = unionCache.get(skillDir);
    if (u === undefined) {
      // The skill root itself must resolve inside the repository: a symlink that relocates it would
      // let outside text stand in for the preserved tokens (S073). A missing root (deleted skill) is
      // confined lexically and yields an empty union, so its tokens report missing.
      const skillRoot = confinedPath(realRoot, skillDir.split('/').join(sep));
      if (skillRoot === null) throw new BoundaryError(`skill root ${skillDir} resolves outside the repository; its text cannot be evidence of preserved tokens`);
      u = normalize(mdFilesUnder(skillRoot).map(f => readFileSync(f, 'utf8')).join('\n'));
      unionCache.set(skillDir, u);
    }
    return u;
  };

  const missing: Missing[] = [];
  let tokens = 0;
  let allowed = 0;
  let files = 0;
  for (const rel of changed) {
    const text = baseText.get(rel);
    if (text == null) continue; // new at the working tree: nothing existed to lose
    files++;
    const hay = union(skillDirOf(rel));
    const plain = hay.replace(/\*\*|__/g, '');
    for (const t of extractTokens(text)) {
      tokens++;
      if ((t.kind === 'guard-line' ? plain : hay).includes(t.text)) continue;
      if (allow.has(allowKey(rel, t.text))) { allowed++; continue; }
      missing.push({ path: rel, line: t.line, kind: t.kind, token: t.text });
    }
  }
  return {
    base: opts.base,
    checked: { files, skills: unionCache.size, tokens },
    exempted: { allow: allowed },
    missing,
  };
}

const USAGE = `Usage: bun LIFEOS/TOOLS/IntentPreserve.ts [--base <git-rev>] [--allow <file>] [--json] <path...>
  --base <rev>    compare against this revision (default HEAD)
  --allow <file>  TSV lines: <repo-relative path>\\t<token>\\t<reason (>= ${MIN_REASON} chars)>
  --json          print the result as JSON
Exit: 0 all preserved, 1 tokens missing, 2 git error or a skill root outside the repo, 64 usage error`;

function parseArgs(argv: string[]): { base: string; allowFile: string | null; json: boolean; paths: string[] } {
  let base = 'HEAD';
  let allowFile: string | null = null;
  let json = false;
  const paths: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--base' || a === '--allow') {
      const v = argv[++i];
      if (!v || v.startsWith('--')) throw new UsageError(`${a} needs a value`);
      if (a === '--base') base = v; else allowFile = v;
    } else if (a === '--json') json = true;
    else if (a.startsWith('--')) throw new UsageError(`unknown flag: ${a}`);
    else paths.push(a);
  }
  if (paths.length === 0) throw new UsageError('at least one path is required');
  return { base, allowFile, json, paths };
}

function main(argv: string[]): number {
  if (argv.includes('--help')) { console.log(USAGE); return 0; }
  let args: ReturnType<typeof parseArgs>;
  let allow: AllowEntry[] = [];
  try {
    args = parseArgs(argv);
    if (args.allowFile) {
      if (!existsSync(args.allowFile)) throw new UsageError(`no such allow file: ${args.allowFile}`);
      allow = parseAllow(readFileSync(args.allowFile, 'utf8'), args.allowFile);
    }
  } catch (e) {
    if (e instanceof UsageError) { console.error(`IntentPreserve: ${e.message}\n${USAGE}`); return 64; }
    throw e;
  }
  let result: PreserveResult;
  try {
    result = checkPreserve({ cwd: process.cwd(), base: args.base, paths: args.paths, allow });
  } catch (e) {
    if (e instanceof UsageError) { console.error(`IntentPreserve: ${e.message}`); return 64; }
    if (e instanceof GitError || e instanceof BoundaryError) { console.error(`IntentPreserve: ${e.message}`); return 2; }
    throw e;
  }
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    for (const m of result.missing) console.log(`${m.path}:${m.line}  ${m.kind.padEnd(10)} ${m.token}`);
    const c = result.checked;
    console.log(`${c.files} changed files in ${c.skills} skill dirs vs ${result.base}: ${c.tokens} tokens checked, ${result.missing.length} missing, ${result.exempted.allow} allowed`);
  }
  return result.missing.length > 0 ? 1 : 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
