#!/usr/bin/env bun
/**
 * name-sweep — retires "Arbol" as a system name in prose across both LifeOS
 * trees, and proves no live identifier moved (Workflows ISA ISC-45, ISC-46).
 *
 *   bun LIFEOS/WORKFLOWS/engine/name-sweep.ts --check [--json] [--kept]
 *       exit 1 with a file:line list while any prose names Arbol as the system
 *   bun LIFEOS/WORKFLOWS/engine/name-sweep.ts --apply [--json] [--allow-dirty]
 *       rewrite every prose mention to Workflows wording; files with
 *       uncommitted changes are skipped (another session owns them) unless
 *       --allow-dirty is passed for a re-run over this sweep's own edits
 *   bun LIFEOS/WORKFLOWS/engine/name-sweep.ts --residue [--scope <path|fleet|user>]... [--match <text>]
 *       exit 1 while any case-insensitive arbol in the tracked files of the system,
 *       USER and fleet repos is not covered by USER/CONFIG/arbol-allowlist.json;
 *       repeated --scope flags are a union, and a scope with no tracked file fails
 *   --system <dir> / --user <dir> / --fleet <dir> move the roots (tests use temp repos)
 *
 * Only TRACKED files are read (git grep over each repo), never ignored or
 * untracked ones, and symlinks are skipped so the MEMORY link is not walked.
 *
 * Every case-insensitive "arbol" that starts a word is classified:
 *   prose       the system name in running text: markdown prose, code
 *               comments, user-facing strings (multi-word, or a UI label)
 *   identifier  anything a machine reads and must keep: Worker names
 *               (`arbol-*`), paths (`CUSTOMIZATIONS/ARBOL`,
 *               `~/.config/arbol`), `ARBOL_*` env vars, `@arbol/*` imports,
 *               URLs, the lowercase `arbol` CLI / config / enum token, code
 *               identifiers, code spans, verbatim quotes and dated history
 * Only prose is rewritten. Before any write the file's identifier fingerprint
 * (every kept token, in order) must be byte-identical after the rewrite, so a
 * live identifier can never be renamed by this tool.
 *
 * Exit codes: 0 clean / applied, 1 findings or a failed file, 2 usage.
 */
import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { invariant } from "../../TOOLS/Invariant.ts";

/* ── Types ──────────────────────────────────────────────────────────────── */

export type RootName = "system" | "user";
export type Context =
  | "prose"      // running text: markdown, comments, JSX text, frontmatter values
  | "string"     // a string literal in code or JSON (prose only when user-facing)
  | "code"       // code outside comments and strings, code spans, tags
  | "url"
  | "quote"      // a double-quoted span in prose
  | "history";   // a dated record: ISA Decisions/Log sections, applied-proposal lines

export interface Span { start: number; end: number; ctx: Context; quoteInner?: [number, number]; uiKey?: boolean }

export interface Mention {
  line: number;        // 1-based
  column: number;      // 0-based offset of the match
  token: string;       // the full identifier run around the match (what a machine would read)
  kind: "prose" | "identifier";
  cls: string;         // why it was kept or rewritten
}

export interface FileScan { rel: string; mentions: Mention[] }

/* ── File profiles ──────────────────────────────────────────────────────── */

export type Profile = "markdown" | "markup" | "code-c" | "code-hash" | "json" | "skip";

const C_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".jsonc", ".mts", ".cts"]);
const HASH_EXT = new Set([".sh", ".bash", ".zsh", ".yaml", ".yml", ".toml", ".env", ".txt", ".conf", ".ini", ".gitignore", ".template"]);
const MARKDOWN_EXT = new Set([".md", ".markdown", ".mdx"]);
const MARKUP_EXT = new Set([".html", ".htm", ".xml", ".plist", ".svg"]);

export function profileFor(path: string): Profile {
  const name = basename(path).toLowerCase();
  if (name === ".gitignore") return "code-hash";
  const plain = name.endsWith(".template") ? name.slice(0, -".template".length) : name;
  const dot = plain.lastIndexOf(".");
  const ext = dot >= 0 ? plain.slice(dot) : "";
  if (MARKDOWN_EXT.has(ext)) return "markdown";
  if (MARKUP_EXT.has(ext)) return "markup";
  if (C_EXT.has(ext)) return "code-c";
  if (ext === ".json") return "json";
  if (HASH_EXT.has(ext) || name.endsWith(".template")) return "code-hash";
  return "skip";
}

/* ── The allowlist: the one place a path or a mention may keep the name ── */

/**
 * `USER/CONFIG/arbol-allowlist.json` (Workflows ISA ISC-180, ISC-219). An entry
 * with only `path` excludes a whole file from both the prose check and the
 * residue check; an entry with `token`, `line` or `context` allows single
 * mentions in the residue check, and a prose mention it covers is neither a
 * prose finding nor rewritten. Every entry's reason names one of five classes.
 */
export type RepoName = "system" | "user" | "fleet";
export const ALLOW_CLASSES = ["Cloudflare-bound name", "dated history", "frozen v1 tree", "the sweep's own rule table", "retained alias"] as const;

export interface AllowEntry {
  id: string;
  repo: RepoName | "any";
  reason: string;
  path?: string;        // glob over the repo-relative path (`**` any depth, `*` one segment)
  token?: string;       // regex tested against the mention's token run (or a path name)
  line?: string;        // regex the whole line must match (case-insensitive)
  context?: "history";  // the mention sits in a dated-history section
  covers?: string[];    // tokens the `token` regex must allow (checked at load)
  rejects?: string[];   // tokens it must not allow, such as a longer or retired spelling (checked at load)
}
interface CompiledEntry extends AllowEntry { pathRe?: RegExp; tokenRe?: RegExp; lineRe?: RegExp; wholeFile: boolean }
export interface Allowlist { entries: CompiledEntry[] }

export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let k = 0; k < glob.length; k += 1) {
    const ch = glob[k]!;
    if (ch === "*" && glob[k + 1] === "*") {
      k += 1;
      if (glob[k + 1] === "/") { k += 1; re += "(?:.*/)?"; } else re += ".*";
    } else if (ch === "*") re += "[^/]*";
    else if (ch === "?") re += "[^/]";
    else re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp("^" + re + "$");
}

/** Validates and compiles the allowlist; a malformed entry fails loudly so a bad allowance never passes the check. */
export function parseAllowlist(raw: unknown, where = "allowlist"): Allowlist {
  const entries = (raw as { entries?: unknown })?.entries;
  if (!Array.isArray(entries)) throw new Error(`${where}: entries[] missing`);
  const ids = new Set<string>();
  return {
    entries: entries.map((e: Partial<AllowEntry>, i): CompiledEntry => {
      const at = `${where} entries[${i}]`;
      if (typeof e?.id !== "string" || !e.id) throw new Error(`${at}: id missing`);
      if (ids.has(e.id)) throw new Error(`${at}: duplicate id ${e.id}`);
      ids.add(e.id);
      if (!["system", "user", "fleet", "any"].includes(e.repo as string)) throw new Error(`${at}: repo must be system|user|fleet|any`);
      if (typeof e.reason !== "string" || !ALLOW_CLASSES.some((c) => e.reason!.startsWith(`${c}: `))) throw new Error(`${at}: reason must start with one of: ${ALLOW_CLASSES.join(" | ")}, then ": "`);
      if (e.context !== undefined && e.context !== "history") throw new Error(`${at}: context must be "history"`);
      if (e.path === undefined && e.token === undefined && e.line === undefined && e.context === undefined) throw new Error(`${at}: needs path, token, line or context`);
      for (const k of ["path", "token", "line"] as const) if (e[k] !== undefined && (typeof e[k] !== "string" || !e[k])) throw new Error(`${at}: ${k} must be a non-empty string`);
      const tokenRe = e.token ? new RegExp(e.token) : undefined;
      for (const k of ["covers", "rejects"] as const) {
        const list = e[k];
        if (list === undefined) continue;
        if (!tokenRe) throw new Error(`${at}: ${k} needs a token regex to test`);
        if (!Array.isArray(list) || list.length === 0 || list.some((t) => typeof t !== "string" || !t)) throw new Error(`${at}: ${k} must be a non-empty list of tokens`);
        for (const t of list) if (tokenRe.test(t) !== (k === "covers")) throw new Error(`${at}: token regex ${k === "covers" ? "does not allow" : "allows"} ${JSON.stringify(t)}, which it ${k === "covers" ? "covers" : "rejects"}`);
      }
      return {
        ...(e as AllowEntry),
        pathRe: e.path ? globToRegExp(e.path) : undefined,
        tokenRe,
        lineRe: e.line ? new RegExp(e.line, "i") : undefined,
        wholeFile: e.path !== undefined && e.token === undefined && e.line === undefined && e.context === undefined,
      };
    }),
  };
}

export function loadAllowlist(path: string): Allowlist {
  if (!existsSync(path)) throw new Error(`allowlist missing: ${path}`);
  return parseAllowlist(JSON.parse(readFileSync(path, "utf8")), path);
}

const repoMatches = (e: AllowEntry, repo: RepoName) => e.repo === "any" || e.repo === repo;

/** The whole-file entry that excludes a path, or null. Both sweeps read exclusions only from here. */
export function exclusionFor(allow: Allowlist, repo: RepoName, rel: string): AllowEntry | null {
  return allow.entries.find((e) => e.wholeFile && repoMatches(e, repo) && e.pathRe!.test(rel)) ?? null;
}

/** The mention-level entry that allows one token on one line, or null. */
export function allowanceFor(allow: Allowlist, repo: RepoName, rel: string, token: string, line: string, ctx: Context | null): AllowEntry | null {
  return allow.entries.find((e) => {
    if (e.wholeFile || !repoMatches(e, repo)) return false;
    if (e.pathRe && !e.pathRe.test(rel)) return false;
    if (e.context && ctx !== e.context) return false;
    if (e.tokenRe && !e.tokenRe.test(token)) return false;
    if (e.lineRe && !e.lineRe.test(line)) return false;
    return true;
  }) ?? null;
}

/* ── Span builders, one per profile ─────────────────────────────────────── */

const HISTORY_HEADING = /^(decisions|log|articulation log|changelog|change log|history|version history|verification log|evidence log)\b/i;
const CODE_FENCE_LANGS = new Set(["ts", "tsx", "typescript", "js", "javascript", "jsx", "json", "jsonc", "sh", "bash", "zsh", "shell", "console", "yaml", "yml", "toml", "env", "ini", "diff"]);
const HASH_LANGS = new Set(["sh", "bash", "zsh", "shell", "console", "yaml", "yml", "toml", "env", "ini"]);
/** Property or attribute names whose string value is shown to a person. */
const UI_KEY = /(?:^|[^A-Za-z0-9_])(label|title|section|hint|description|purpose|powers|what|summary|message|reason|note|prompt|placeholder|daPromptExample|help)\s*["']?\s*[:=]\s*\{?\s*$/;

interface CodeState { block: boolean; templates: number[] }
const freshCodeState = (): CodeState => ({ block: false, templates: [] });

/** Splits one line of C-family or hash-comment code into code, comment (prose) and string spans. */
export function lexCodeLine(line: string, flavor: "c" | "hash", state: CodeState): Span[] {
  const spans: Span[] = [];
  let i = 0;
  let codeStart = 0;
  const pushCode = (end: number) => { if (end > codeStart) spans.push({ start: codeStart, end, ctx: "code" }); };
  const regexAllowedAfter = (pos: number) => {
    let j = pos - 1;
    while (j >= 0 && /\s/.test(line[j]!)) j--;
    if (j < 0) return true;
    return /[(,=:[!&|?{};+\-*%<>~^]/.test(line[j]!) || /\breturn$/.test(line.slice(0, j + 1));
  };
  // Resume inside a block comment or a template literal carried over from the previous line.
  if (flavor === "c" && state.block) {
    const close = line.indexOf("*/");
    const end = close < 0 ? line.length : close + 2;
    spans.push({ start: 0, end, ctx: "prose" });
    if (close < 0) return spans;
    state.block = false;
    i = codeStart = end;
  }
  const inTemplate = () => state.templates.length > 0 && state.templates[state.templates.length - 1] === 0;
  while (i < line.length) {
    if (inTemplate()) {
      const start = i;
      while (i < line.length && line[i] !== "`" && !(line[i] === "$" && line[i + 1] === "{")) i += line[i] === "\\" ? 2 : 1;
      spans.push({ start, end: Math.min(i, line.length), ctx: "string", quoteInner: [start, Math.min(i, line.length)] });
      if (i >= line.length) return spans;
      if (line[i] === "`") { state.templates.pop(); i += 1; codeStart = i; continue; }
      state.templates[state.templates.length - 1] = 1; // entering ${ … }
      i += 2; codeStart = i; continue;
    }
    const ch = line[i]!;
    const top = state.templates.length - 1;
    if (flavor === "c" && top >= 0 && state.templates[top]! > 0) {
      if (ch === "{") state.templates[top]! += 1;
      else if (ch === "}") {
        state.templates[top]! -= 1;
        if (state.templates[top] === 0) { pushCode(i); i += 1; codeStart = i; continue; }
      }
    }
    if (flavor === "c" && ch === "/" && line[i + 1] === "/") { pushCode(i); spans.push({ start: i, end: line.length, ctx: "prose" }); return spans; }
    if (flavor === "c" && ch === "/" && line[i + 1] === "*") {
      pushCode(i);
      const close = line.indexOf("*/", i + 2);
      if (close < 0) { spans.push({ start: i, end: line.length, ctx: "prose" }); state.block = true; return spans; }
      spans.push({ start: i, end: close + 2, ctx: "prose" });
      i = codeStart = close + 2; continue;
    }
    if (flavor === "hash" && ch === "#" && (i === 0 || /\s/.test(line[i - 1]!))) { pushCode(i); spans.push({ start: i, end: line.length, ctx: "prose" }); return spans; }
    if (ch === '"' || ch === "'" || (flavor === "c" && ch === "`")) {
      pushCode(i);
      if (ch === "`") { state.templates.push(0); i += 1; codeStart = i; continue; }
      let j = i + 1;
      while (j < line.length && line[j] !== ch) j += line[j] === "\\" ? 2 : 1;
      const end = Math.min(j + 1, line.length);
      spans.push({ start: i, end, ctx: "string", quoteInner: [i + 1, Math.min(j, line.length)], uiKey: UI_KEY.test(line.slice(0, i)) });
      i = codeStart = end; continue;
    }
    if (flavor === "c" && ch === "/" && regexAllowedAfter(i)) {
      let j = i + 1, inClass = false;
      while (j < line.length && (inClass || line[j] !== "/")) {
        if (line[j] === "\\") j += 1;
        else if (line[j] === "[") inClass = true;
        else if (line[j] === "]") inClass = false;
        j += 1;
      }
      if (j < line.length) { i = j + 1; continue; } // a regex literal stays code
    }
    i += 1;
  }
  pushCode(line.length);
  return spans;
}

/** Prose segments of a markdown line: code spans, URLs and double-quoted spans are carved out. */
function markdownProseSpans(line: string, from: number, to: number): Span[] {
  const spans: Span[] = [];
  let i = from;
  while (i < to) {
    const tick = line.indexOf("`", i);
    const stop = tick < 0 || tick >= to ? to : tick;
    spans.push(...textSpans(line, i, stop));
    if (stop >= to) break;
    let run = 0;
    while (line[stop + run] === "`") run += 1;
    const fence = "`".repeat(run);
    const close = line.indexOf(fence, stop + run);
    if (close < 0 || close >= to) { spans.push(...textSpans(line, stop, to)); break; }
    spans.push(...codeSpanParts(line, stop, close + run));
    i = close + run;
  }
  return spans;
}

/** Inside a code span: a quoted multi-word string is a phrase a probe asserts, so it follows the doc it probes. */
function codeSpanParts(line: string, start: number, end: number): Span[] {
  const spans: Span[] = [];
  let cursor = start;
  const quoted = /(["'])((?:(?!\1).)*?\s(?:(?!\1).)*?)\1/g;
  for (const m of line.matchAll(quoted)) {
    if (m.index < start) continue;
    if (m.index >= end) break;
    const mEnd = m.index + m[0].length;
    if (mEnd > end) break;
    if (m.index > cursor) spans.push({ start: cursor, end: m.index, ctx: "code" });
    spans.push({ start: m.index, end: mEnd, ctx: "string", quoteInner: [m.index + 1, mEnd - 1] });
    cursor = mEnd;
  }
  if (cursor < end) spans.push({ start: cursor, end, ctx: "code" });
  return spans;
}

/** Plain text: URLs and double-quoted spans (raw or HTML-entity quotes) are carved out of prose. */
function textSpans(line: string, start: number, end: number): Span[] {
  const spans: Span[] = [];
  const carve = /https?:\/\/[^\s)>\]`"']+|"[^"\n]*"|“[^”\n]*”|&quot;.*?&quot;|&ldquo;.*?&rdquo;/g;
  let cursor = start;
  for (const m of line.matchAll(carve)) {
    if (m.index < start) continue;
    if (m.index >= end) break;
    const mEnd = Math.min(m.index + m[0].length, end);
    if (m.index > cursor) spans.push({ start: cursor, end: m.index, ctx: "prose" });
    if (m[0].startsWith("http")) spans.push({ start: m.index, end: mEnd, ctx: "url" });
    else {
      const open = m[0].startsWith("&quot;") ? 6 : m[0].startsWith("&ldquo;") ? 7 : 1;
      const close = m[0].endsWith("&quot;") ? 6 : m[0].endsWith("&rdquo;") ? 7 : 1;
      spans.push({ start: m.index, end: mEnd, ctx: "quote", quoteInner: [m.index + open, mEnd - close] });
    }
    cursor = mEnd;
  }
  if (cursor < end) spans.push({ start: cursor, end, ctx: "prose" });
  return spans;
}

/** Span lists for every line of a file, carrying fence, comment, template and section state across lines. */
export function spansForText(text: string, profile: Profile): Span[][] {
  const lines = text.split("\n");
  if (profile === "code-c" || profile === "code-hash") {
    const state = freshCodeState();
    return lines.map((l) => lexCodeLine(l, profile === "code-c" ? "c" : "hash", state));
  }
  if (profile === "json") return lines.map(jsonSpans);
  if (profile === "markup") return markupSpans(lines);
  if (profile === "markdown") return markdownSpans(lines);
  return lines.map(() => []);
}

function jsonSpans(line: string): Span[] {
  const spans: Span[] = [];
  let cursor = 0;
  const str = /"((?:[^"\\]|\\.)*)"/g;
  for (const m of line.matchAll(str)) {
    const end = m.index + m[0].length;
    if (m.index > cursor) spans.push({ start: cursor, end: m.index, ctx: "code" });
    const isKey = /^\s*:/.test(line.slice(end));
    spans.push(isKey ? { start: m.index, end, ctx: "code" } : { start: m.index, end, ctx: "string", quoteInner: [m.index + 1, end - 1], uiKey: UI_KEY.test(line.slice(0, m.index)) });
    cursor = end;
  }
  if (cursor < line.length) spans.push({ start: cursor, end: line.length, ctx: "code" });
  return spans;
}

function markdownSpans(lines: string[]): Span[][] {
  const out: Span[][] = [];
  let frontmatter = lines[0]?.trim() === "---";
  let fence: { marker: string; lang: string; state: CodeState } | null = null;
  let historyLevel: number | null = null;
  lines.forEach((line, n) => {
    if (frontmatter) {
      if (n > 0 && line.trim() === "---") { frontmatter = false; out.push([{ start: 0, end: line.length, ctx: "code" }]); return; }
      const key = line.match(/^(\s*[\w.-]+\s*:\s?)/);
      const valueStart = key ? key[1]!.length : 0;
      out.push([{ start: 0, end: valueStart, ctx: "code" }, ...markdownProseSpans(line, valueStart, line.length)]);
      return;
    }
    const fenceLine = line.match(/^\s*(```+|~~~+)\s*([\w+-]*)/);
    if (fence) {
      if (fenceLine && fenceLine[1]!.startsWith(fence.marker[0]!) && fenceLine[1]!.length >= fence.marker.length && !fenceLine[2]) { fence = null; out.push([{ start: 0, end: line.length, ctx: "code" }]); return; }
      if (historyLevel !== null) { out.push([{ start: 0, end: line.length, ctx: "history" }]); return; }
      const lang = fence.lang.toLowerCase();
      if (!CODE_FENCE_LANGS.has(lang)) out.push([{ start: 0, end: line.length, ctx: "prose" }]);
      else if (lang === "json" || lang === "diff") out.push([{ start: 0, end: line.length, ctx: "code" }]);
      else out.push(lexCodeLine(line, HASH_LANGS.has(lang) ? "hash" : "c", fence.state));
      return;
    }
    if (fenceLine) { fence = { marker: fenceLine[1]!, lang: fenceLine[2] ?? "", state: freshCodeState() }; out.push([{ start: 0, end: line.length, ctx: "code" }]); return; }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = heading[1]!.length;
      if (historyLevel !== null && level <= historyLevel) historyLevel = null;
      if (historyLevel === null && HISTORY_HEADING.test(heading[2]!.replace(/[*_`]/g, "").trim())) historyLevel = level;
    }
    if (historyLevel !== null || line.includes("<!-- applied:")) { out.push([{ start: 0, end: line.length, ctx: "history" }]); return; }
    out.push(markdownProseSpans(line, 0, line.length));
  });
  return out;
}

function markupSpans(lines: string[]): Span[][] {
  const out: Span[][] = [];
  let inTag = false, inCode = false, inComment = false;
  let historyLevel: number | null = null;
  for (const line of lines) {
    const heading = line.match(/<h([1-6])[^>]*>(.*?)<\/h\1>/i);
    if (heading) {
      const level = Number(heading[1]);
      const title = heading[2]!.replace(/<[^>]+>/g, "").trim();
      if (historyLevel !== null && level <= historyLevel) historyLevel = null;
      if (historyLevel === null && HISTORY_HEADING.test(title)) historyLevel = level;
    }
    if (historyLevel !== null) { out.push([{ start: 0, end: line.length, ctx: "history" }]); continue; }
    const spans: Span[] = [];
    let i = 0, cursor = 0;
    const push = (end: number, ctx: Context) => { if (end > cursor) spans.push({ start: cursor, end, ctx }); cursor = end; };
    while (i < line.length) {
      if (inComment) {
        const close = line.indexOf("-->", i);
        const end = close < 0 ? line.length : close + 3;
        push(end, "prose"); i = end;
        if (close >= 0) inComment = false;
        continue;
      }
      if (inTag) {
        const close = line.indexOf(">", i);
        const end = close < 0 ? line.length : close + 1;
        push(end, "code"); i = end;
        if (close >= 0) inTag = false;
        continue;
      }
      if (line.startsWith("<!--", i)) { push(i, inCode ? "code" : "prose"); inComment = true; continue; }
      if (line[i] === "<" && /^<\/?[a-zA-Z!?]/.test(line.slice(i, i + 3))) {
        const name = line.slice(i).match(/^<\/?\s*([a-zA-Z0-9]+)/)?.[1]?.toLowerCase();
        push(i, inCode ? "code" : "prose");
        if (name === "code" || name === "pre") inCode = line[i + 1] !== "/";
        inTag = true;
        continue;
      }
      i += 1;
    }
    push(line.length, inCode ? "code" : "prose");
    carveText(line, spans);
    out.push(spans);
  }
  return out;
}

/** Re-splits prose spans of a markup line so URLs and quotes are carved out (idempotent). */
function carveText(line: string, spans: Span[]): void {
  for (let k = 0; k < spans.length; k += 1) {
    const s = spans[k]!;
    if (s.ctx !== "prose") continue;
    const parts = textSpans(line, s.start, s.end);
    if (parts.length === 1 && parts[0]!.ctx === "prose") continue;
    spans.splice(k, 1, ...parts);
    k += parts.length - 1;
  }
}

/* ── Classification ─────────────────────────────────────────────────────── */

const MATCH = /(?<![A-Za-z])arbol/gi;
const RUN_CHAR = /[A-Za-z0-9_$]/;
const PATH_CHAR = /[A-Za-z0-9_$.\/~@\-]/;

function spanAt(spans: Span[], index: number): Span | null {
  return spans.find((s) => index >= s.start && index < s.end) ?? null;
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/** The token a machine would read around a match: identifier characters joined by path punctuation. */
function tokenAt(line: string, index: number): { core: string; run: string; runStart: number; runEnd: number; coreEnd: number } {
  let l = index, r = index;
  while (l > 0 && RUN_CHAR.test(line[l - 1]!)) l -= 1;
  while (r < line.length && RUN_CHAR.test(line[r]!)) r += 1;
  let rl = l, rr = r;
  while (rl > 0 && PATH_CHAR.test(line[rl - 1]!)) rl -= 1;
  while (rr < line.length && PATH_CHAR.test(line[rr]!)) rr += 1;
  // A sentence-ending period or a trailing hyphen is punctuation, not part of the run.
  while (rr > r && /[.\-]/.test(line[rr - 1]!)) rr -= 1;
  return { core: line.slice(l, r), run: line.slice(rl, rr), runStart: rl, runEnd: rr, coreEnd: r };
}

/**
 * A capitalized standalone `Arbol` joined to neighbours by path punctuation:
 * null when the join is still prose ("Arbol-managed", "non-Arbol",
 * "Bunker/Arbol"), otherwise the identifier class it belongs to.
 */
function joinedClass(line: string, tok: ReturnType<typeof tokenAt>): string | null {
  const { run } = tok;
  if (run === "Arbol") return null;
  if (/^Arbol-(?:[a-z]+|to-Workflows)$/.test(run)) return null;
  if (/^non-Arbol$/.test(run)) return null;
  if (run.includes("/")) {
    const titleWords = run.split("/").every((s) => /^[A-Z][a-z]+$/.test(s));
    return titleWords ? null : "path";
  }
  if (line[tok.coreEnd] === "." && /[A-Za-z]/.test(line[tok.coreEnd + 1] ?? "")) return "path";
  return "code-identifier";
}

/** Classifies every "arbol" in one line given its spans. */
export function classifyLine(line: string, spans: Span[], lineNo: number, profile: Profile): Mention[] {
  const out: Mention[] = [];
  for (const m of line.matchAll(MATCH)) {
    const index = m.index!;
    const tok = tokenAt(line, index);
    const span = spanAt(spans, index);
    const mention = (kind: Mention["kind"], cls: string): Mention => ({ line: lineNo, column: index, token: tok.run || tok.core, kind, cls });
    const ctx = span?.ctx ?? "code";
    if (ctx === "history") { out.push(mention("identifier", "history")); continue; }
    if (ctx === "url") { out.push(mention("identifier", "url")); continue; }
    // Identifier shapes are kept in every context. Deployed names are lowercase kebab-case.
    if (/^arbol-[a-z0-9*{<$]/.test(line.slice(index))) { out.push(mention("identifier", "kebab-id (Worker, adapter, job or team name)")); continue; }
    if (line[index - 1] === "@") { out.push(mention("identifier", "package")); continue; }
    if (/\.config\/arbol/.test(tok.run)) { out.push(mention("identifier", "config path")); continue; }
    if (tok.core !== "ARBOL" && /ARBOL/.test(tok.core)) { out.push(mention("identifier", "env var, constant or Worker dir")); continue; }
    if (tok.core === "ARBOL") { out.push(mention("identifier", tok.run.includes("/") ? "path" : "directory name")); continue; }
    if (tok.core === "arbol") { out.push(mention("identifier", tok.run.includes("/") ? "path" : "lowercase token (CLI, config, enum, app id)")); continue; }
    if (tok.core !== "Arbol") { out.push(mention("identifier", "code-identifier")); continue; }
    const joined = joinedClass(line, tok);
    if (joined !== null) { out.push(mention("identifier", joined)); continue; }
    // A capitalized standalone Arbol: its context decides.
    if (ctx === "prose") { out.push(mention("prose", "prose")); continue; }
    if (ctx === "quote") {
      const inner = span!.quoteInner ? line.slice(span!.quoteInner[0], span!.quoteInner[1]) : "";
      if (inner.trim() === "Arbol") out.push(mention("identifier", "name mention (quoted word)"));
      else if (wordCount(inner) >= 3) out.push(mention("identifier", "verbatim quote"));
      else out.push(mention("prose", "prose"));
      continue;
    }
    if (ctx === "string") {
      const inner = span!.quoteInner ? line.slice(span!.quoteInner[0], span!.quoteInner[1]) : "";
      if (/\s/.test(inner.trim()) || span!.uiKey) out.push(mention("prose", "user-facing string"));
      else out.push(mention("identifier", "data string"));
      continue;
    }
    // Code context: JSX text in a .tsx line is shown to a person; an object key is not.
    if (profile === "code-c" && /^\s*[A-Za-z ,.;()·—-]*<\//.test(line.slice(tok.coreEnd)) && !/^\s*:/.test(line.slice(tok.coreEnd))) { out.push(mention("prose", "JSX text")); continue; }
    out.push(mention("identifier", profile === "markdown" || profile === "markup" ? "code span or tag" : "code"));
  }
  return out;
}

/** Every mention in a text, classified; the entry point for tests. */
export function classifyText(text: string, path: string): Mention[] {
  const profile = profileFor(path);
  if (profile === "skip") return [];
  const spans = spansForText(text, profile);
  return text.split("\n").flatMap((line, n) => classifyLine(line, spans[n] ?? [], n + 1, profile));
}

/* ── Rewriting prose ────────────────────────────────────────────────────── */

/** `consume` is the matched text the rule replaces; `to` receives its capture groups. */
interface Rule { match: RegExp; to: (groups: string[]) => string }

/**
 * Ordered: the first rule whose pattern matches at the mention wins. Each
 * pattern is anchored at the mention and consumes exactly the text it
 * replaces (no lookahead), so the replacement is computed from the match.
 */
const RULES: Rule[] = [
  { match: /^Arbol\s*(?:→|->|to)\s*Workflows\b/, to: () => "Workflows" },
  { match: /^Arbol-to-Workflows\b/, to: () => "Workflows" },
  { match: /^Arbol (Workflows?|workflows?)\b/, to: ([, word]) => word! },
  { match: /^Arbol(?:'s|’s) (?:own )?(?:v1 )?(engine|loader|CLI|trigger validator|contract check|local action registry|workflow format|format)\b/, to: ([, what]) => `the v1 ${what}` },
  { match: /^Arbol ISC-/, to: () => "cloud-fleet ISC-" },
  { match: /^Arbol CLI\b/, to: () => "Workflows action CLI" },
  { match: /^Arbol [Rr]unner\b/, to: () => "Workflows action runner" },
  { match: /^Arbol(?:'s|’s)/, to: () => "Workflows'" },
  { match: /^Arbol(?:&#39;s|&apos;s|&rsquo;s)/, to: () => "Workflows&#39;" },
  { match: /^Arbol\b/, to: () => "Workflows" },
];

/** Characters that mark a line as part of a drawn table or box, where column alignment matters. */
const BOX_CHARS = /[│|┃├┤┼┬┴└┘┌┐─]/;

/**
 * The replacement for one prose mention: its text, how many characters it
 * consumes at the mention, and how an "an" just before it changes. A string
 * that is exactly "Arbol" is a UI label; it becomes "Cloud Workflows" so it
 * never collides with the Workflows page's own label.
 */
export function rewriteAt(line: string, column: number, wholeString: boolean): { text: string; consumed: number; eatBefore: number; insertBefore: string } {
  const rest = line.slice(column);
  if (wholeString) return { text: "Cloud Workflows", consumed: 5, eatBefore: 0, insertBefore: "" };
  for (const rule of RULES) {
    const m = rest.match(rule.match);
    if (!m) continue;
    const text = rule.to([...m]);
    const consumed = m[0].length;
    const grow = text.length - consumed;
    const tail = line.slice(column + consumed);
    const padAt = grow > 0 && BOX_CHARS.test(line) ? paddingFor(tail, grow) : -1;
    if (padAt >= 0) {
      const trimmedTail = tail.slice(0, padAt) + tail.slice(padAt + grow);
      return withArticle(line, column, text + trimmedTail, consumed + tail.length);
    }
    return withArticle(line, column, text, consumed);
  }
  return { text: "Workflows", consumed: 5, eatBefore: 0, insertBefore: "" };
}

/**
 * Keeps drawn tables and boxes aligned: the offset of the first run of
 * padding after a longer name that can give up `grow` spaces, or -1. A run
 * strictly wider than the growth always qualifies (a space remains); a run
 * exactly as wide qualifies only when a box character follows it, so the
 * trim can leave the text touching the border but never joins two words.
 */
export function paddingFor(tail: string, grow: number): number {
  for (const run of tail.matchAll(/ +/g)) {
    const len = run[0].length;
    if (len > grow) return run.index!;
    if (len === grow && BOX_CHARS.test(tail[run.index! + len] ?? "")) return run.index!;
  }
  return -1;
}

/** "an Arbol …" becomes "a Workflows …"; when a rule dropped the name, the next word decides. */
function withArticle(line: string, column: number, text: string, consumed: number): { text: string; consumed: number; eatBefore: number; insertBefore: string } {
  const article = line.slice(0, column).match(/(^|[^A-Za-z])([Aa])n $/);
  const nextSound = text.length > 0 ? text : line.slice(column + consumed);
  if (article && !/^[aeiouAEIOU]/.test(nextSound)) return { text, consumed, eatBefore: 3, insertBefore: `${article[2]} ` };
  return { text, consumed, eatBefore: 0, insertBefore: "" };
}

/** Kept tokens in order; a rewrite must leave this list byte-identical. */
export function identifierFingerprint(mentions: Mention[]): string {
  return mentions.filter((m) => m.kind === "identifier").map((m) => `${m.cls}\u0000${m.token}`).join("\n");
}

export interface RewriteResult { text: string; rewritten: number; lines: number[] }

/** True for a prose mention the allowlist lets stand; it is neither a finding nor rewritten. */
export type KeepMention = (line: string, mention: Mention) => boolean;

/** Rewrites every prose mention in a text that `keep` does not hold back; identifiers are never touched. */
export function rewriteText(text: string, path: string, keep: KeepMention = () => false): RewriteResult {
  const profile = profileFor(path);
  if (profile === "skip") return { text, rewritten: 0, lines: [] };
  const lines = text.split("\n");
  const spans = spansForText(text, profile);
  let rewritten = 0;
  const touched: number[] = [];
  const next = lines.map((line, n) => {
    const prose = classifyLine(line, spans[n] ?? [], n + 1, profile).filter((m) => m.kind === "prose" && !keep(line, m));
    if (prose.length === 0) return line;
    let out = line;
    for (const m of [...prose].sort((a, b) => b.column - a.column)) {
      const span = spanAt(spans[n] ?? [], m.column);
      const wholeString = span?.ctx === "string" && span.quoteInner !== undefined && line.slice(span.quoteInner[0], span.quoteInner[1]) === "Arbol";
      const r = rewriteAt(out, m.column, wholeString);
      out = out.slice(0, m.column - r.eatBefore) + r.insertBefore + r.text + out.slice(m.column + r.consumed);
      rewritten += 1;
    }
    touched.push(n + 1);
    return out;
  });
  return { text: next.join("\n"), rewritten, lines: touched };
}

/* ── Repositories ───────────────────────────────────────────────────────── */

export interface Roots { system: string; user: string }

export function defaultRoots(): Roots {
  const system = resolve(import.meta.dir, "..", "..", "..");
  const link = join(system, "LIFEOS", "USER");
  return { system, user: existsSync(link) ? realpathSync(link) : link };
}

function git(root: string, args: string[]): string {
  const r = Bun.spawnSync(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe", timeout: 120_000 });
  // git grep exits 1 when nothing matches; anything above that (or a kill) is a real failure.
  if (r.exitCode === null || r.exitCode > 1) throw new Error(`git ${args.join(" ")} in ${root} exited ${r.exitCode}: ${r.stderr.toString().trim()}`);
  return r.stdout.toString();
}

/** Tracked, non-binary files whose content mentions the name. */
export function trackedCandidates(root: string): string[] {
  return git(root, ["grep", "-z", "-I", "-l", "-i", "-e", "arbol"]).split("\0").filter(Boolean).sort();
}

/** Paths with uncommitted changes (staged or not); a peer session owns them until they are committed. */
export function dirtyPaths(root: string): Set<string> {
  const out = git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=no"]);
  const set = new Set<string>();
  const parts = out.split("\0");
  for (let k = 0; k < parts.length; k += 1) {
    const entry = parts[k]!;
    if (entry.length < 4) continue;
    set.add(entry.slice(3));
    if (entry[0] === "R" || entry[0] === "C") k += 1; // the rename source follows
  }
  return set;
}

export interface SweepReport {
  roots: Roots;
  findings: Array<{ root: RootName; rel: string; line: number; excerpt: string }>;
  kept: Record<string, number>;
  excluded: Array<{ root: RootName; rel: string; reason: string }>;
  skippedDirty: Array<{ root: RootName; rel: string; prose: number }>;
  changed: Array<{ root: RootName; rel: string; rewritten: number }>;
  failed: Array<{ root: RootName; rel: string; error: string }>;
}

/** `rewrite` defaults to rewriteText; tests pass a faulty one to prove the write guards refuse it. */
export interface SweepOptions { apply: boolean; allowDirty: boolean; allowlist: Allowlist; rewrite?: (text: string, path: string, keep: KeepMention) => RewriteResult }

export function sweep(roots: Roots, opts: SweepOptions): SweepReport {
  const report: SweepReport = { roots, findings: [], kept: {}, excluded: [], skippedDirty: [], changed: [], failed: [] };
  const rewrite = opts.rewrite ?? rewriteText;
  for (const root of ["system", "user"] as const) {
    const dir = roots[root];
    if (!existsSync(join(dir, ".git"))) throw new Error(`${root} root is not a git repository: ${dir}`);
    const dirty = opts.apply && !opts.allowDirty ? dirtyPaths(dir) : new Set<string>();
    for (const rel of trackedCandidates(dir)) {
      const excl = exclusionFor(opts.allowlist, root, rel);
      if (excl) { report.excluded.push({ root, rel, reason: `${excl.id}: ${excl.reason}` }); continue; }
      const abs = join(dir, rel);
      if (profileFor(rel) === "skip") continue;
      let stat;
      try { stat = lstatSync(abs); } catch { continue; } // tracked but deleted in the working tree
      if (stat.isSymbolicLink() || !stat.isFile()) continue;
      const text = readFileSync(abs, "utf8");
      const mentions = classifyText(text, rel);
      // A prose mention a mention-level allowlist entry covers (a sentence recording the rename) stands.
      const allowedBy = (line: string, m: Mention) => allowanceFor(opts.allowlist, root, rel, m.token, line, "prose");
      const keepMention: KeepMention = (line, m) => allowedBy(line, m) !== null;
      const lines = text.split("\n");
      const prose = mentions.filter((m) => m.kind === "prose" && !keepMention(lines[m.line - 1]!, m));
      if (opts.apply && prose.length > 0 && dirty.has(rel)) {
        report.skippedDirty.push({ root, rel, prose: prose.length });
      } else if (opts.apply && prose.length > 0) {
        try {
          const result = rewrite(text, rel, keepMention);
          const after = classifyText(result.text, rel);
          const afterLines = result.text.split("\n");
          invariant(afterLines.length === lines.length, `${rel}: rewrite changed the line count`);
          invariant(identifierFingerprint(after) === identifierFingerprint(mentions), `${rel}: rewrite changed a kept identifier`);
          invariant(after.every((m) => m.kind === "identifier" || keepMention(afterLines[m.line - 1]!, m)), `${rel}: prose mention survived the rewrite`);
          writeFileSync(abs, result.text);
          report.changed.push({ root, rel, rewritten: result.rewritten });
          for (const m of after) {
            const cls = m.kind === "identifier" ? m.cls : `allowed: ${allowedBy(afterLines[m.line - 1]!, m)!.id}`;
            report.kept[cls] = (report.kept[cls] ?? 0) + 1;
          }
          continue;
        } catch (e) {
          if ((e as Error).name === "InvariantViolation") throw e;
          report.failed.push({ root, rel, error: (e as Error).message });
        }
      }
      for (const m of mentions) {
        const entry = m.kind === "prose" ? allowedBy(lines[m.line - 1]!, m) : null;
        if (m.kind === "identifier") report.kept[m.cls] = (report.kept[m.cls] ?? 0) + 1;
        else if (entry) report.kept[`allowed: ${entry.id}`] = (report.kept[`allowed: ${entry.id}`] ?? 0) + 1;
        else report.findings.push({ root, rel, line: m.line, excerpt: lines[m.line - 1]!.trim().slice(0, 160) });
      }
    }
  }
  return report;
}

/* ── Residue: every arbol the allowlist does not cover, in three repos ──── */

export interface ResidueRoots { system: string; user: string; fleet: string }
export interface ResidueHit { repo: RepoName; rel: string; line: number; column: number; token: string; text: string }
export interface ResidueOptions { allowlist: Allowlist; scopes?: string[]; match?: string }
export interface ResidueReport {
  roots: ResidueRoots;
  scopes: string[] | null;
  match: string | null;
  scanned: number;                    // tracked files read (after scope and whole-file exclusions)
  excluded: number;                   // tracked files a whole-file entry excluded
  hits: ResidueHit[];
  allowed: Record<string, number>;    // mentions allowed, by entry id
}

const ANY_ARBOL = /arbol/gi;
/** Characters of a line a hit carries for display; matching always reads the whole line. */
export const EXCERPT = 200;

/** Where a scope points: which repos, and the repo-relative prefix inside each ("" = whole repo). */
export interface ScopePlan { parts: Array<{ repo: RepoName; prefix: string }>; skip: (repo: RepoName, rel: string) => boolean }

const underPrefix = (rel: string, prefix: string) => prefix === "" || rel === prefix || rel.startsWith(`${prefix}/`);

/** The real path of a path that exists, else the path itself (resolved). */
const real = (p: string) => { const abs = resolve(p); return existsSync(abs) ? realpathSync(abs) : abs; };

/**
 * `fleet` is the fleet repo; `user` is the USER repo minus `SOCRATES/` (the fleet is
 * its own repo, so it is never in the USER listing); anything else is a path, relative
 * to the system root or absolute. A path that exists is resolved through symlinks first
 * (`LIFEOS/USER/…` lands in the USER repo, the fleet directory under it, by either name,
 * in the fleet repo); one that does not exist is mapped by its spelling (`USER/…` and
 * `LIFEOS/USER/…` to the USER repo). The residue check refuses a scope that selects no
 * tracked file, so a misspelt path never reads as clean.
 */
export function planScope(scope: string | undefined, roots: ResidueRoots): ScopePlan {
  const none = () => false;
  if (scope === undefined) return { parts: [{ repo: "system", prefix: "" }, { repo: "user", prefix: "" }, { repo: "fleet", prefix: "" }], skip: none };
  if (scope === "fleet") return { parts: [{ repo: "fleet", prefix: "" }], skip: none };
  if (scope === "user") return { parts: [{ repo: "user", prefix: "" }], skip: (repo, rel) => repo === "user" && underPrefix(rel, "SOCRATES") };
  const clean = (p: string) => p.replace(/^\.\//, "").replace(/\/+$/, "");
  const fleet = real(roots.fleet), user = real(roots.user), system = real(roots.system);
  const route = (abs: string): { repo: RepoName; rel: string } | null => {
    const inside = (root: string) => abs === root || abs.startsWith(`${root}/`);
    // Most specific first: the fleet repo sits inside the USER tree.
    if (inside(fleet)) return { repo: "fleet", rel: abs.slice(fleet.length + 1) };
    if (inside(user)) return { repo: "user", rel: abs.slice(user.length + 1) };
    if (inside(system)) return { repo: "system", rel: abs.slice(system.length + 1) };
    return null;
  };
  let target: { repo: RepoName; rel: string } | null;
  if (scope.startsWith("/")) {
    target = route(real(scope));
    if (!target) throw new Error(`scope ${scope} is outside the three repos`);
  } else {
    const onDisk = join(system, clean(scope));
    target = existsSync(onDisk) ? route(real(onDisk)) : null;
    if (!target) {
      let rel = clean(scope);
      let repo: RepoName = "system";
      const userPrefix = rel.match(/^(?:LIFEOS\/USER|USER)(?:\/|$)/);
      if (userPrefix) { repo = "user"; rel = rel.slice(userPrefix[0].length); }
      else if (/^LIFEOS\/MEMORY(?:\/|$)/.test(rel)) { repo = "user"; rel = rel.slice("LIFEOS/".length); }
      if (repo === "user") {
        const fleetPrefix = rel.match(/^CUSTOMIZATIONS\/(?:WORKFLOWS|ARBOL)(?:\/|$)/);
        if (fleetPrefix) { repo = "fleet"; rel = rel.slice(fleetPrefix[0].length); }
      }
      target = { repo, rel };
    }
  }
  return { parts: [{ repo: target.repo, prefix: clean(target.rel) }], skip: none };
}

function trackedFiles(root: string): string[] {
  return git(root, ["ls-files", "-z"]).split("\0").filter(Boolean);
}

/**
 * Tracked files in scope, per repo. Several scopes are a union (overlaps read once); each
 * scope must select at least one tracked file, or the whole check fails.
 */
function filesInScopes(roots: ResidueRoots, scopes: string[] | undefined): Map<RepoName, string[]> {
  const listing = new Map<RepoName, string[]>();
  const tracked = (repo: RepoName) => {
    if (!listing.has(repo)) {
      const dir = roots[repo];
      if (!existsSync(join(dir, ".git"))) throw new Error(`${repo} root is not a git repository: ${dir}`);
      listing.set(repo, trackedFiles(dir));
    }
    return listing.get(repo)!;
  };
  const chosen = new Map<RepoName, Set<string>>();
  for (const scope of scopes === undefined || scopes.length === 0 ? [undefined] : scopes) {
    const plan = planScope(scope, roots);
    let selected = 0;
    for (const { repo, prefix } of plan.parts) {
      const set = chosen.get(repo) ?? new Set<string>();
      for (const rel of tracked(repo)) if (underPrefix(rel, prefix) && !plan.skip(repo, rel)) { set.add(rel); selected += 1; }
      chosen.set(repo, set);
    }
    if (selected === 0) {
      const where = plan.parts.map((p) => `${p.repo}:${p.prefix || "."}`).join(", ");
      throw new Error(`scope ${scope ?? "(all)"} selects no tracked file (looked in ${where}); a scope that reads nothing cannot prove anything clean`);
    }
  }
  return new Map([...chosen].map(([repo, set]) => [repo, [...set].sort()]));
}

export function residue(roots: ResidueRoots, opts: ResidueOptions): ResidueReport {
  const scopes = opts.scopes && opts.scopes.length ? opts.scopes : undefined;
  const report: ResidueReport = { roots, scopes: scopes ?? null, match: opts.match ?? null, scanned: 0, excluded: 0, hits: [], allowed: {} };
  const allow = (id: string) => { report.allowed[id] = (report.allowed[id] ?? 0) + 1; };
  // --match tests the whole line (or the whole path), never the shortened excerpt a hit carries for display.
  const keep = (hit: ResidueHit, whole: string) => { if (opts.match === undefined || whole.includes(opts.match)) report.hits.push(hit); };
  for (const [repo, files] of filesInScopes(roots, scopes)) {
    const dir = roots[repo];
    const excluded = new Set<string>();
    for (const rel of files) if (exclusionFor(opts.allowlist, repo, rel)) excluded.add(rel);
    report.excluded += excluded.size;
    // Names: a tracked path that carries the word is residue too (a directory or file to rename).
    for (const rel of files) {
      if (excluded.has(rel)) continue;
      for (const m of rel.matchAll(ANY_ARBOL)) {
        const start = rel.lastIndexOf("/", m.index!) + 1;
        const end = rel.indexOf("/", m.index!);
        const segment = rel.slice(start, end < 0 ? rel.length : end);
        const entry = allowanceFor(opts.allowlist, repo, rel, segment, rel, null);
        if (entry) allow(entry.id);
        else keep({ repo, rel, line: 0, column: m.index!, token: segment, text: rel }, rel);
      }
    }
    // Contents: every case-insensitive arbol, inside identifiers too.
    const wanted = new Set(files.filter((rel) => !excluded.has(rel)));
    for (const rel of trackedCandidates(dir)) {
      if (!wanted.has(rel)) continue;
      const abs = join(dir, rel);
      let stat;
      try { stat = lstatSync(abs); } catch { continue; } // tracked but deleted in the working tree
      if (stat.isSymbolicLink() || !stat.isFile()) continue;
      report.scanned += 1;
      const text = readFileSync(abs, "utf8");
      const profile = profileFor(rel);
      const spans = profile === "skip" ? [] : spansForText(text, profile);
      text.split("\n").forEach((line, n) => {
        for (const m of line.matchAll(ANY_ARBOL)) {
          const tok = tokenAt(line, m.index!);
          const token = tok.run || tok.core || m[0];
          const ctx = spanAt(spans[n] ?? [], m.index!)?.ctx ?? null;
          const entry = allowanceFor(opts.allowlist, repo, rel, token, line, ctx);
          if (entry) allow(entry.id);
          else keep({ repo, rel, line: n + 1, column: m.index!, token, text: line.trim().slice(0, EXCERPT) }, line);
        }
      });
    }
  }
  return report;
}

/* ── CLI ────────────────────────────────────────────────────────────────── */

const USAGE = "usage: name-sweep.ts --check | --apply [--allow-dirty] | --residue [--scope <path|fleet|user>]... [--match <text>]  [--json] [--kept] [--system <dir>] [--user <dir>] [--fleet <dir>] [--allowlist <file>]";

const SWITCHES = new Set(["--check", "--apply", "--residue", "--allow-dirty", "--json", "--kept"]);
const VALUED = new Set(["--system", "--user", "--fleet", "--allowlist", "--scope", "--match"]);
const MODES = ["--check", "--apply", "--residue"] as const;

/**
 * Parsed flags, or null when the command line is not a valid invocation. `--scope` may
 * repeat (the scopes are a union); any other valued flag given twice is refused, never
 * silently overridden.
 */
function parseArgs(argv: string[]): { mode: (typeof MODES)[number]; switches: Set<string>; values: Map<string, string>; scopes: string[] } | null {
  const switches = new Set<string>(), values = new Map<string, string>(), scopes: string[] = [];
  for (let k = 0; k < argv.length; k += 1) {
    const a = argv[k]!;
    if (SWITCHES.has(a)) switches.add(a);
    else if (VALUED.has(a) && argv[k + 1] !== undefined && !argv[k + 1]!.startsWith("--")) {
      const v = argv[++k]!;
      if (a === "--scope") scopes.push(v);
      else if (values.has(a)) return null;
      else values.set(a, v);
    } else return null;
  }
  const modes = MODES.filter((m) => switches.has(m));
  if (modes.length !== 1) return null;
  const mode = modes[0]!;
  if (mode !== "--residue" && (scopes.length > 0 || values.has("--match"))) return null;
  if (mode !== "--apply" && switches.has("--allow-dirty")) return null;
  return { mode, switches, values, scopes };
}

function residueMain(roots: ResidueRoots, allowlist: Allowlist, scopes: string[], values: Map<string, string>, json: boolean, kept: boolean): number {
  const report = residue(roots, { allowlist, scopes, match: values.get("--match") });
  const ok = report.hits.length === 0;
  if (json) { console.log(JSON.stringify({ ok, mode: "residue", ...report }, null, 2)); return ok ? 0 : 1; }
  for (const h of report.hits) console.log(`${h.repo}:${h.rel}:${h.line}: ${h.line === 0 ? `(path) ${h.token}` : h.text}`);
  if (kept) {
    console.log("allowed mentions by allowlist entry:");
    for (const [id, n] of Object.entries(report.allowed).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(6)}  ${id}`);
    console.log(`excluded files: ${report.excluded}`);
  }
  const where = report.scopes ? ` in scope ${report.scopes.join(", ")}` : " across system, user and fleet";
  const filter = report.match ? ` on lines containing "${report.match}"` : "";
  console.log(ok
    ? `name-sweep: no arbol residue${where}${filter} (${report.scanned} file(s) read)`
    : `name-sweep: ${report.hits.length} arbol mention(s) outside the allowlist${where}${filter}, in ${new Set(report.hits.map((h) => `${h.repo}:${h.rel}`)).size} file(s)`);
  return ok ? 0 : 1;
}

export function main(argv: string[]): number {
  const args = parseArgs(argv);
  if (!args) { console.error(USAGE); return 2; }
  const defaults = defaultRoots();
  const system = resolve(args.values.get("--system") ?? defaults.system);
  const user = resolve(args.values.get("--user") ?? defaults.user);
  const fleet = resolve(args.values.get("--fleet") ?? join(user, "CUSTOMIZATIONS", "WORKFLOWS"));
  const json = args.switches.has("--json"), keptFlag = args.switches.has("--kept");
  let allowlist: Allowlist;
  try {
    allowlist = loadAllowlist(resolve(args.values.get("--allowlist") ?? join(user, "CONFIG", "arbol-allowlist.json")));
  } catch (e) {
    console.error(`name-sweep: ${(e as Error).message}`);
    return 1;
  }
  if (args.mode === "--residue") {
    try { return residueMain({ system, user, fleet: existsSync(fleet) ? realpathSync(fleet) : fleet }, allowlist, args.scopes, args.values, json, keptFlag); }
    catch (e) {
      if ((e as Error).name === "InvariantViolation") throw e;
      console.error(`name-sweep: ${(e as Error).message}`);
      return 1;
    }
  }
  const apply = args.mode === "--apply";
  const roots: Roots = { system, user };
  let report: SweepReport;
  try {
    report = sweep(roots, { apply, allowDirty: args.switches.has("--allow-dirty"), allowlist });
  } catch (e) {
    if ((e as Error).name === "InvariantViolation") throw e;
    console.error(`name-sweep: ${(e as Error).message}`);
    return 1;
  }
  const failedOrFound = report.findings.length > 0 || report.failed.length > 0;
  if (json) {
    console.log(JSON.stringify({ ok: !failedOrFound, mode: apply ? "apply" : "check", ...report }, null, 2));
    return failedOrFound ? 1 : 0;
  }
  if (apply) {
    const byRoot = (r: RootName) => report.changed.filter((c) => c.root === r);
    console.log(`rewrote ${report.changed.reduce((s, c) => s + c.rewritten, 0)} mention(s) in ${report.changed.length} file(s): system ${byRoot("system").length}, user ${byRoot("user").length}`);
    for (const c of report.changed) console.log(`  ✎ ${c.root}:${c.rel} (${c.rewritten})`);
    for (const s of report.skippedDirty) console.log(`  ⏸ ${s.root}:${s.rel} — uncommitted changes from another session, ${s.prose} prose mention(s) left`);
    for (const f of report.failed) console.log(`  ✗ ${f.root}:${f.rel} — ${f.error}`);
  }
  for (const f of report.findings) console.log(`${f.root}:${f.rel}:${f.line}: ${f.excerpt}`);
  if (keptFlag) {
    console.log("kept identifiers by class:");
    for (const [cls, n] of Object.entries(report.kept).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(5)}  ${cls}`);
    console.log(`excluded files: ${report.excluded.length}`);
  }
  console.log(failedOrFound
    ? `name-sweep: ${report.findings.length} prose mention(s) name Arbol as the system${report.failed.length ? `, ${report.failed.length} file(s) failed` : ""}`
    : "name-sweep: clean — no prose names Arbol as the system");
  return failedOrFound ? 1 : 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
