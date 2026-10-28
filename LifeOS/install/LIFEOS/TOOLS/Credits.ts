#!/usr/bin/env bun
/**
 * Credits — the contributor-credit generator.
 *
 * credits-scan: ignore-file
 *
 * Credit for LifeOS lives in fix-site comments written by the `/LI` triage, for example
 * `public issue #2071, @handle` or `ported from public PR #1743, @handle`. This tool turns
 * those comments into one generated file (`credits.json`), then derives everything else from
 * it: the README Credits avatar block, per-release contributor lists, and `Co-authored-by:`
 * trailers so GitHub itself credits the person.
 *
 *   build    scan tracked source, resolve each handle to its GitHub numeric id, write credits.json
 *   readme   render (or rewrite in place) the avatar block between the credits markers
 *   gate     fail when a credited handle is missing from the README block, or the unresolved count rises
 *   release  list the contributors whose credit first shipped in a version (or their trailers)
 *   trailers one Co-authored-by line per contributor whose fix-site comment was added in a git range
 *
 * Credit exists only after acceptance: a comment in source means the maintainer accepted and ported the work.
 * A file whose text contains the literal marker `credits-scan` + `: ignore-file` is never scanned,
 * so fixtures and docs that quote the comment form cannot create credit.
 *
 * Contract: criteria ISC-7..17, 54, 77..81, 86, 87, 96, 97 of the LifeOS Leaderboard ISA.
 *
 * @version 1.2.0
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { getClaudeDir } from "./Paths";
import { invariant } from "./Invariant.ts";
import { upstreamRepo } from "./UpstreamRepo";

// ======================================================================
// Types
// ======================================================================

export type Kind = "issue" | "pr";
export type CreditType = "bug" | "code" | "security" | "idea" | "docs";
export const TYPE_ORDER: CreditType[] = ["bug", "code", "security", "idea", "docs"];

export interface Ref {
  kind: Kind;
  number: number;
}

export interface Occurrence {
  file: string;
  /** 1-based line of the `public issue|PR #N` text that started the clause. */
  line: number;
  kind: Kind;
  number: number;
  /** Inline handle as written, or null when the comment names nobody. */
  handle: string | null;
  /** Literal text used to find the commit that introduced the comment. */
  needle: string;
  types: CreditType[];
}

export interface CreditEntry {
  handle: string;
  github_id: number;
  numbers: Ref[];
  types: CreditType[];
  first_release: string;
  /** Every distinct release a credit shipped in, oldest first; "unreleased" is never listed. Absent in files written before 2026-10-10. */
  releases?: string[];
  note?: string;
}

export interface Flagged {
  handle: string;
  reason: "not_found" | "id_changed";
  previous_id?: number;
  github_id?: number;
}

export interface CreditsFile {
  schema: 1;
  repo: string;
  entries: CreditEntry[];
  flagged: Flagged[];
  unresolved: Ref[];
  unresolved_count: number;
}

export interface OverrideAdd {
  handle: string;
  types: CreditType[];
  note: string;
  first_release?: string;
  numbers?: Ref[];
}
/** An exclusion is a handle, or a handle plus the numeric id it held when it was excluded (survives a rename). */
export type ExcludeRef = string | { handle: string; github_id: number };
export interface Overrides {
  add: OverrideAdd[];
  exclude: ExcludeRef[];
}

/** Bad input from a file or argument: an expected failure with a typed error, exit 1. Never an InvariantViolation. */
export class RejectedInput extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RejectedInput";
  }
}

export type UserLookup =
  | { status: "ok"; id: number; login: string }
  | { status: "not_found" }
  | { status: "error"; message: string };

/** The only door to GitHub. Injected in tests; `ghResolver` is the real one. */
export interface Resolver {
  user(handle: string): Promise<UserLookup>;
  /** Login of the author of issue/PR `number` on the credits repo, or null when unknown. */
  author(number: number): Promise<string | null>;
}

export interface Baseline {
  unresolved: number;
}

/**
 * The documented fallback for the credits repo, used only when nothing configures one. It also stays
 * a fixed constant because skills/Errata/Tools/Send.ts pins its one upstream target to it in code.
 */
export const DEFAULT_REPO = "danielmiessler/LifeOS";

/**
 * The repo credits are built against: the same upstream resolver Banner uses (LIFEOS_REPO, the
 * release-stamped installer, USER/CONFIG/lifeos-repo.json), else DEFAULT_REPO. DEFAULT_REPO applies
 * only when nothing is configured: a configured but unusable value (malformed lifeos-repo.json, a
 * missing or non-string "repo" key, a non owner/name value) throws UpstreamRepoConfigError naming the
 * file and key, which main() reports as a usage error (exit 2).
 */
export function creditsRepo(claudeDir: string = getClaudeDir(), env: Record<string, string | undefined> = process.env): string {
  return upstreamRepo(claudeDir, env) ?? DEFAULT_REPO;
}
export const START_MARKER = "<!-- credits:start -->";
export const END_MARKER = "<!-- credits:end -->";
const IGNORE_MARKER = "credits-scan" + ": ignore-file";
/** GitHub's placeholder login for deleted accounts. It names no one, so it is never credited. */
const GHOST_LOGIN = "ghost";
const isGhost = (login: string) => lc(login) === GHOST_LOGIN;

// ======================================================================
// Small utilities
// ======================================================================

async function pmap<T, R>(items: T[], limit: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

const lc = (s: string) => s.toLowerCase();
const normVersion = (v: string) => v.trim().replace(/^v/i, "");

function sortTypes(types: Iterable<CreditType>): CreditType[] {
  const set = new Set(types);
  return TYPE_ORDER.filter((t) => set.has(t));
}

function sortRefs(refs: Ref[]): Ref[] {
  const seen = new Set<string>();
  const out: Ref[] = [];
  for (const r of refs) {
    const k = `${r.kind}:${r.number}`;
    if (!seen.has(k)) {
      seen.add(k);
      out.push({ kind: r.kind, number: r.number });
    }
  }
  return out.sort((a, b) => a.number - b.number || a.kind.localeCompare(b.kind));
}

function releaseKey(tag: string): [number, number, number, string] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(.*)$/.exec(tag);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3]), m[4]] : null;
}

/** Orders release tags ascending; anything that is not a version (including "unreleased") sorts last. */
export function compareReleases(a: string, b: string): number {
  const ka = releaseKey(a);
  const kb = releaseKey(b);
  if (ka && !kb) return -1;
  if (!ka && kb) return 1;
  if (!ka || !kb) return a.localeCompare(b);
  for (let i = 0; i < 3; i++) if (ka[i] !== kb[i]) return (ka[i] as number) - (kb[i] as number);
  if (ka[3] === kb[3]) return 0;
  if (ka[3] === "") return 1; // 1.0.0 is later than 1.0.0-rc1
  if (kb[3] === "") return -1;
  return ka[3].localeCompare(kb[3]);
}

function minRelease(releases: string[]): string {
  let best = "unreleased";
  for (const r of releases) if (compareReleases(r, best) < 0) best = r;
  return best;
}

// ======================================================================
// Parser: fix-site comments
// ======================================================================

/** Start of a credit clause: the literal `public issue #N`, `public PR #N`, or plural forms. */
const HEAD_RE = /\bpublic\s+(?:issues?|PRs?|pull\s+requests?)\s*#(\d+)/gi;
const SEP_RE = /(?:[\s,;&/+]|\band\b)+/iy;
const KW_RE = /(?:public|issues?|PRs?|pull\s+requests?)\b/iy;
const REF_RE = /#(\d+)/y;
const HANDLE_RE = /@([A-Za-z0-9][A-Za-z0-9-]{0,38})(?![\w/@-])/y;
/** Comment leaders stripped from a continuation line before looking for a wrapped handle. */
const COMMENT_PREFIX = /^\s*(?:(?:\/\/+|\/\*+|\*+|#+|<!--|--|>)\s*)*/;
/** Max characters of filler allowed between the last ref and its handle ("item 2, "). */
const FILLER_BUDGET = 24;
/** JSDoc tags and decorators that look like a handle on a wrapped line but never are. */
const NOT_HANDLES = new Set([
  "param", "params", "returns", "return", "type", "typedef", "see", "deprecated", "example", "throws", "since",
  "todo", "link", "private", "public", "protected", "internal", "default", "template", "callback", "ts-ignore",
  "ts-expect-error", "ts-check", "ts-nocheck", "types", "import", "media", "keyframes", "property", "override",
]);

interface Group {
  refs: Ref[];
  handles: string[];
}

interface ClauseResult {
  groups: Group[];
  endLine: number;
  endCol: number;
}

/**
 * Parse one credit clause starting at `lines[li][col]`. The clause is a run of refs and handles:
 * refs gather until a handle appears (a few filler characters allowed), further handles may follow
 * joined by commas, and a new ref after a handle starts a new group. Anything else ends it.
 * When the clause stops at the end of a line still wanting a handle, the next line is read if it
 * starts with one (the wrapped-line drift).
 */
function parseClause(lines: string[], li: number, col: number): ClauseResult {
  let text = lines[li].slice(col);
  const segs = [{ line: li, textStart: 0, colStart: col }];
  const groups: Group[] = [];
  let cur: Group = { refs: [], handles: [] };
  let kind: Kind = "issue";
  let prev: "none" | "kw" | "ref" | "handle" | "filler" = "none";
  let depth = 0;
  let anchor = 0;
  let p = 0;

  const close = () => {
    if (cur.refs.length) groups.push(cur);
    cur = { refs: [], handles: [] };
  };
  const inB = () => cur.handles.length > 0;
  const tryExtend = (): boolean => {
    const nl = segs[segs.length - 1].line + 1;
    if (nl >= lines.length) return false;
    const raw = lines[nl];
    const prefixLen = (COMMENT_PREFIX.exec(raw) as RegExpExecArray)[0].length;
    const rest = raw.slice(prefixLen);
    // the wrapped line must open with the handle, optionally after a short qualifier: "(commit 1), @handle"
    if (!/^[\s,;(]*(?:(?:commit|item|part|finding)s?\s+\w+\)?[\s,;]*)?@[A-Za-z0-9]/i.test(rest)) return false;
    text += " ";
    segs.push({ line: nl, textStart: text.length, colStart: prefixLen });
    text += rest;
    return true;
  };

  for (;;) {
    if (p >= text.length) {
      const wantsMore = (!inB() && cur.refs.length > 0) || (inB() && /[,;(]\s*$/.test(text));
      if (wantsMore && tryExtend()) continue;
      break;
    }
    if (text.startsWith("-->", p) || text.startsWith("*/", p)) break;

    SEP_RE.lastIndex = p;
    const sep = SEP_RE.exec(text);
    if (sep) {
      p += sep[0].length;
      continue;
    }

    KW_RE.lastIndex = p;
    const kw = KW_RE.exec(text);
    if (kw) {
      if (inB()) close();
      const w = lc(kw[0]);
      if (w.startsWith("issue")) kind = "issue";
      else if (w.startsWith("pr") || w.startsWith("pull")) kind = "pr";
      prev = "kw";
      p += kw[0].length;
      anchor = p;
      continue;
    }

    REF_RE.lastIndex = p;
    const ref = REF_RE.exec(text);
    if (ref) {
      const allowed = prev === "kw" || prev === "ref" || (inB() && prev === "handle");
      if (allowed) {
        if (inB()) close();
        cur.refs.push({ kind, number: Number(ref[1]) });
        prev = "ref";
        p += ref[0].length;
        anchor = p;
        continue;
      }
      if (cur.refs.length === 0 || inB()) break;
      p += ref[0].length; // "finding #10": a number that is not a credit
      prev = "filler";
      continue;
    }

    HANDLE_RE.lastIndex = p;
    const hm = HANDLE_RE.exec(text);
    if (hm && (p === 0 || !/[\w.@]/.test(text[p - 1]))) {
      const handle = hm[1].replace(/-+$/, "");
      if (NOT_HANDLES.has(lc(handle))) break;
      const allowed = inB() ? prev === "handle" : cur.refs.length > 0 && p - anchor <= FILLER_BUDGET + 8;
      if (!allowed) break;
      cur.handles.push(handle);
      prev = "handle";
      p += hm[0].length;
      continue;
    }

    const c = text[p];
    if (c === "(") {
      depth++;
      p++;
      continue;
    }
    if (c === ")") {
      if (depth > 0) {
        depth--;
        p++;
        continue;
      }
      break;
    }
    // any other character: filler before a handle, the end of the clause after one
    if (inB() || cur.refs.length === 0 || p - anchor > FILLER_BUDGET) break;
    p++;
    prev = "filler";
  }
  close();

  let seg = segs[0];
  for (const s of segs) if (s.textStart <= p) seg = s;
  return { groups, endLine: seg.line, endCol: seg.colStart + Math.max(0, p - seg.textStart) };
}

const SECURITY_RE = /\b(security|vulnerab\w*|CVE-\d+|XSS|SSRF|injection|path traversal|exploit\w*|privilege escalation)\b/i;
const IDEA_RE = /\b(feature request|enhancement|proposal|suggest\w*|idea)\b/i;
const DOC_FILE_RE = /\.(md|mdx|txt|rst)$|(^|\/)DOCUMENTATION\//i;

function typesFor(kind: Kind, file: string, line: string): CreditType[] {
  const t = new Set<CreditType>();
  t.add(kind === "pr" ? "code" : IDEA_RE.test(line) ? "idea" : "bug");
  if (SECURITY_RE.test(line)) t.add("security");
  if (DOC_FILE_RE.test(file)) t.add("docs");
  return sortTypes(t);
}

/** Every credit occurrence in `lines`. Pure; `file` only labels the result and picks the types. */
export function parseLines(lines: string[], file: string): Occurrence[] {
  const out: Occurrence[] = [];
  let consumed = { line: -1, col: 0 };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.includes("#")) continue;
    for (const m of line.matchAll(HEAD_RE)) {
      const start = m.index as number;
      if (i < consumed.line || (i === consumed.line && start < consumed.col)) continue;
      const { groups, endLine, endCol } = parseClause(lines, i, start);
      consumed = { line: endLine, col: endCol };
      const needle = m[0];
      for (const g of groups) {
        for (const r of g.refs) {
          const types = typesFor(r.kind, file, line);
          if (g.handles.length === 0) {
            out.push({ file, line: i + 1, kind: r.kind, number: r.number, handle: null, needle, types });
          } else {
            for (const h of g.handles) {
              out.push({ file, line: i + 1, kind: r.kind, number: r.number, handle: h, needle, types });
            }
          }
        }
      }
    }
  }
  return out;
}

// ======================================================================
// Scanning tracked source
// ======================================================================

const BINARY_EXT = /\.(png|jpe?g|gif|ico|icns|webp|bmp|tiff?|woff2?|ttf|otf|eot|pdf|zip|gz|tgz|bz2|xz|7z|mp3|mp4|m4a|wav|mov|webm|ogg|flac|sqlite3?|db|wasm|node|dylib|so|class|jar|bin)$/i;
const MAX_FILE_BYTES = 5 * 1024 * 1024;

export interface GitResult {
  code: number;
  out: string;
  err: string;
}

async function git(root: string, args: string[]): Promise<GitResult> {
  const proc = Bun.spawn(["git", "-C", root, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
  });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, out, err };
}

export async function trackedFiles(root: string): Promise<string[]> {
  const r = await git(root, ["ls-files", "-z"]);
  if (r.code !== 0) throw new Error(`git ls-files failed in ${root}: ${r.err.trim()}`);
  return r.out.split("\0").filter((f) => f && !f.startsWith("LIFEOS/MEMORY/") && !BINARY_EXT.test(f));
}

export async function scanTree(root: string): Promise<Occurrence[]> {
  const files = await trackedFiles(root);
  const out: Occurrence[] = [];
  for (const rel of files) {
    const abs = join(root, rel);
    let buf: Buffer;
    try {
      const st = lstatSync(abs);
      if (!st.isFile() || st.size > MAX_FILE_BYTES) continue;
      buf = readFileSync(abs);
    } catch {
      continue;
    }
    if (buf.subarray(0, 8000).includes(0)) continue; // binary
    const text = buf.toString("utf8");
    if (!/public\s+(?:issues?|PRs?|pull\s+requests?)\s*#\d/i.test(text)) continue;
    if (text.includes(IGNORE_MARKER)) continue;
    out.push(...parseLines(text.split("\n"), rel));
  }
  return out;
}

// ======================================================================
// Overrides
// ======================================================================

const HANDLE_SHAPE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isPosInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;

function checkKeys(obj: Record<string, unknown>, allowed: string[], where: string): void {
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) throw new RejectedInput(`${where}: unknown key "${k}"`);
}

function checkTypes(v: unknown, where: string): CreditType[] {
  if (!Array.isArray(v)) throw new RejectedInput(`${where}: types must be an array`);
  for (const t of v) if (!TYPE_ORDER.includes(t as CreditType)) throw new RejectedInput(`${where}: unknown credit type ${JSON.stringify(t)}`);
  return v as CreditType[];
}

function checkRefs(v: unknown, where: string): Ref[] {
  if (!Array.isArray(v)) throw new RejectedInput(`${where}: numbers must be an array`);
  return v.map((r) => {
    if (!isPlainObject(r) || (r.kind !== "issue" && r.kind !== "pr") || !isPosInt(r.number)) {
      throw new RejectedInput(`${where}: each number must look like { "kind": "issue"|"pr", "number": <positive integer> }`);
    }
    return { kind: r.kind as Kind, number: r.number as number };
  });
}

function checkHandle(v: unknown, where: string): string {
  if (typeof v !== "string" || !HANDLE_SHAPE.test(v)) throw new RejectedInput(`${where}: invalid handle ${JSON.stringify(v)}`);
  return v;
}

/** Validate and normalise an overrides file. Every shape error is a RejectedInput; unknown keys are errors too, so a typo cannot silently drop an exclusion. */
export function loadOverrides(path: string | undefined): Overrides {
  if (!path) return { add: [], exclude: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new RejectedInput(`cannot read overrides ${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const where = `overrides ${path}`;
  if (!isPlainObject(parsed)) throw new RejectedInput(`${where}: must be a JSON object { add, exclude }`);
  checkKeys(parsed, ["add", "exclude"], where);
  const rawAdd = parsed.add ?? [];
  const rawExclude = parsed.exclude ?? [];
  if (!Array.isArray(rawAdd)) throw new RejectedInput(`${where}: add must be an array`);
  if (!Array.isArray(rawExclude)) throw new RejectedInput(`${where}: exclude must be an array`);

  const seen = new Set<string>();
  const add: OverrideAdd[] = rawAdd.map((a, i) => {
    const w = `${where}: add[${i}]`;
    if (!isPlainObject(a)) throw new RejectedInput(`${w} must be an object`);
    checkKeys(a, ["handle", "types", "note", "first_release", "numbers"], w);
    const handle = checkHandle(a.handle, w);
    if (isGhost(handle)) throw new RejectedInput(`${w}: the GitHub placeholder "ghost" is never credited`);
    if (seen.has(lc(handle))) throw new RejectedInput(`${w}: duplicate handle ${handle}`);
    seen.add(lc(handle));
    const types = sortTypes(checkTypes(a.types ?? [], w));
    if (a.note !== undefined && typeof a.note !== "string") throw new RejectedInput(`${w}: note must be a string`);
    if (a.first_release !== undefined && (typeof a.first_release !== "string" || !a.first_release.trim())) throw new RejectedInput(`${w}: first_release must be a non-empty string`);
    const numbers = a.numbers === undefined ? undefined : checkRefs(a.numbers, w);
    return { handle, types, note: (a.note as string | undefined) ?? "", first_release: a.first_release as string | undefined, numbers };
  });

  const exclude: ExcludeRef[] = rawExclude.map((x, i) => {
    const w = `${where}: exclude[${i}]`;
    if (typeof x === "string") return checkHandle(x, w);
    if (isPlainObject(x)) {
      checkKeys(x, ["handle", "github_id"], w);
      const handle = checkHandle(x.handle, w);
      if (!isPosInt(x.github_id)) throw new RejectedInput(`${w}: github_id must be a positive integer`);
      return { handle, github_id: x.github_id as number };
    }
    throw new RejectedInput(`${w} must be a handle or { handle, github_id }`);
  });
  return { add, exclude };
}

/** Who is excluded: handles (lowercase) and numeric ids. The ghost placeholder is always on the list. */
export interface Exclusions {
  handles: Set<string>;
  ids: Set<number>;
}

export function exclusionsOf(o?: Overrides): Exclusions {
  const handles = new Set<string>([GHOST_LOGIN]);
  const ids = new Set<number>();
  for (const x of o?.exclude ?? []) {
    if (typeof x === "string") handles.add(lc(x));
    else {
      handles.add(lc(x.handle));
      ids.add(x.github_id);
    }
  }
  return { handles, ids };
}

/** True when this login, or this numeric id when known, must appear nowhere in the output. */
export const isExcluded = (ex: Exclusions, handle: string, id?: number): boolean =>
  ex.handles.has(lc(handle)) || (id !== undefined && ex.ids.has(id));

/**
 * Write the numeric id next to every excluded handle that has none, so an exclusion survives a rename.
 * Looks each such handle up once. A handle GitHub no longer knows stays a bare string. Any failed lookup
 * throws and leaves the file untouched.
 */
export async function recordExclusionIds(
  path: string,
  resolver: Resolver,
): Promise<{ recorded: Array<{ handle: string; github_id: number }>; unresolved: string[] }> {
  const overrides = loadOverrides(path); // validates the whole file first
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const recorded: Array<{ handle: string; github_id: number }> = [];
  const unresolved: string[] = [];
  const next: ExcludeRef[] = [];
  for (const x of overrides.exclude) {
    if (typeof x !== "string") {
      next.push(x);
      continue;
    }
    const res = await resolver.user(x);
    if (res.status === "error") throw new Error(`GitHub lookup failed for @${x}: ${res.message}. Refusing to rewrite ${path} with a silent gap.`);
    if (res.status === "not_found") {
      unresolved.push(x);
      next.push(x);
      continue;
    }
    invariant(isPosInt(res.id), `GitHub returned a bad id for @${x}: ${res.id}`);
    const ref = { handle: x, github_id: res.id };
    recorded.push(ref);
    next.push(ref);
  }
  if (!recorded.length) return { recorded, unresolved };
  invariant(next.length === overrides.exclude.length, "exclusion rewrite changed the number of exclusions");
  atomicWrite(path, JSON.stringify({ ...raw, exclude: next }, null, 2) + "\n");
  return { recorded, unresolved };
}

// ======================================================================
// Release lookup (which tag first contained the comment)
// ======================================================================

/**
 * ERE that matches `needle` only as a whole credit head: not inside a longer word on the left and
 * not followed by another digit on the right, so `public issue #207` never matches `public issue #2071`.
 */
export function needlePattern(needle: string): string {
  const lit = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return `(^|[^A-Za-z0-9_])${lit}([^0-9]|$)`;
}

async function introducingCommit(root: string, file: string, needle: string): Promise<string | null> {
  const r = await git(root, ["log", "--pickaxe-regex", `-S${needlePattern(needle)}`, "--format=%H", "--reverse", "--", file]);
  if (r.code !== 0) return null;
  const first = r.out.split("\n").find((l) => l.trim());
  return first ? first.trim() : null;
}

async function earliestTag(root: string, commit: string): Promise<string | null> {
  const r = await git(root, ["tag", "--list", "v*", "--contains", commit]);
  if (r.code !== 0) return null;
  const tags = r.out.split("\n").map((t) => t.trim()).filter((t) => releaseKey(t));
  if (!tags.length) return null;
  return tags.sort(compareReleases)[0];
}

async function releasesFor(root: string, occs: Occurrence[]): Promise<Map<string, string>> {
  const keyOf = (o: Occurrence) => `${o.file}\0${o.needle}`;
  const unique = new Map<string, Occurrence>();
  for (const o of occs) if (!unique.has(keyOf(o))) unique.set(keyOf(o), o);
  const commitCache = new Map<string, Promise<string | null>>();
  const result = new Map<string, string>();
  await pmap([...unique.values()], 8, async (o) => {
    const commit = await introducingCommit(root, o.file, o.needle);
    let tag: string | null = null;
    if (commit) {
      if (!commitCache.has(commit)) commitCache.set(commit, earliestTag(root, commit));
      tag = await (commitCache.get(commit) as Promise<string | null>);
    }
    result.set(keyOf(o), tag ?? "unreleased");
  });
  return result;
}

// ======================================================================
// build
// ======================================================================

export interface BuildOpts {
  root: string;
  repo?: string;
  overrides?: Overrides;
  previous?: CreditsFile | null;
  baseline?: Baseline;
}

export interface BuildResult {
  credits: CreditsFile;
  unresolved_detail: Array<{ kind: Kind; number: number; file: string; line: number }>;
  skipped_authors: number;
  baseline_exceeded: boolean;
}

function isBotOrOwner(login: string, repo: string): boolean {
  return /\[bot\]$/i.test(login) || lc(login) === lc(repo.split("/")[0]);
}

interface Acc {
  handle: string;
  github_id: number;
  refs: Ref[];
  types: Set<CreditType>;
  releases: string[];
  notes: string[];
}

/**
 * The trusted id for each handle (lowercase key): every credited entry's id, plus the id a handle held
 * before it was flagged (`id_changed` or `not_found`, both carry `previous_id`). A flag therefore lasts
 * until a human deletes it from credits.json; rebuilding never promotes a new id on its own, so a freed
 * handle re-registered by someone else stays uncredited.
 */
export function pinnedIds(previous: CreditsFile | null | undefined): Map<string, number> {
  const pins = new Map<string, number>();
  for (const f of previous?.flagged ?? []) {
    if (Number.isInteger(f.previous_id)) pins.set(lc(f.handle), f.previous_id as number);
  }
  for (const e of previous?.entries ?? []) pins.set(lc(e.handle), e.github_id);
  return pins;
}

export async function build(opts: BuildOpts, deps: { resolver: Resolver }): Promise<BuildResult> {
  const repo = opts.repo ?? creditsRepo();
  const overrides = opts.overrides ?? { add: [], exclude: [] };
  const ex = exclusionsOf(overrides);
  const { resolver } = deps;

  const scanned = await scanTree(opts.root);

  // 1. no-handle occurrences fall back to the author of that issue/PR (ISC-87)
  const needAuthor = [...new Set(scanned.filter((o) => !o.handle).map((o) => o.number))].sort((a, b) => a - b);
  const authorOf = new Map<number, string | null>();
  await pmap(needAuthor, 8, async (n) => {
    authorOf.set(n, await resolver.author(n));
  });

  let skipped_authors = 0;
  const credited: Occurrence[] = [];
  const unresolvedOccs: Occurrence[] = [];
  for (const o of scanned) {
    if (o.handle) {
      if (!isExcluded(ex, o.handle)) credited.push(o);
      continue;
    }
    const login = authorOf.get(o.number) ?? null;
    if (!login) {
      unresolvedOccs.push(o);
    } else if (isGhost(login)) {
      skipped_authors++; // a deleted account: nobody to credit
    } else if (isExcluded(ex, login)) {
      // excluded people appear nowhere, not even as an unresolved miss
    } else if (isBotOrOwner(login, repo)) {
      skipped_authors++;
    } else {
      credited.push({ ...o, handle: login });
    }
  }

  // 2. resolve each distinct handle to a numeric id (ISC-80), flag id changes and 404s (ISC-81)
  const handleKeys = new Map<string, string>(); // lower -> first-seen spelling
  for (const o of credited) if (!handleKeys.has(lc(o.handle as string))) handleKeys.set(lc(o.handle as string), o.handle as string);
  for (const a of overrides.add) if (!isExcluded(ex, a.handle) && !handleKeys.has(lc(a.handle))) handleKeys.set(lc(a.handle), a.handle);

  const previousById = pinnedIds(opts.previous);

  const lookups = new Map<string, UserLookup>();
  await pmap([...handleKeys.entries()], 8, async ([key, spelled]) => {
    lookups.set(key, await resolver.user(spelled));
  });

  const flagged: Flagged[] = [];
  const okByKey = new Map<string, { id: number; login: string }>();
  for (const [key, spelled] of handleKeys) {
    const res = lookups.get(key) as UserLookup;
    if (res.status === "error") {
      throw new Error(`GitHub lookup failed for @${spelled}: ${res.message}. Refusing to write a credits file with a silent gap.`);
    }
    if (res.status === "not_found") {
      const held = previousById.get(key);
      flagged.push(held !== undefined ? { handle: spelled, reason: "not_found", previous_id: held } : { handle: spelled, reason: "not_found" });
      continue;
    }
    // an excluded numeric id is dropped silently, whatever name it now goes by
    if (isExcluded(ex, res.login, res.id)) continue;
    const prevId = previousById.get(key);
    if (prevId !== undefined && prevId !== res.id) {
      flagged.push({ handle: spelled, reason: "id_changed", previous_id: prevId, github_id: res.id });
      continue;
    }
    okByKey.set(key, { id: res.id, login: res.login });
  }

  // 3. which release first contained each credited comment
  const forRelease = credited.filter((o) => okByKey.has(lc(o.handle as string)));
  const releaseMap = await releasesFor(opts.root, forRelease);

  // 4. accumulate by numeric id so a renamed account never shows up twice
  const byId = new Map<number, Acc>();
  const accFor = (id: number, login: string): Acc => {
    let a = byId.get(id);
    if (!a) {
      a = { handle: login, github_id: id, refs: [], types: new Set(), releases: [], notes: [] };
      byId.set(id, a);
    }
    return a;
  };
  for (const o of forRelease) {
    const u = okByKey.get(lc(o.handle as string)) as { id: number; login: string };
    const a = accFor(u.id, u.login);
    a.refs.push({ kind: o.kind, number: o.number });
    for (const t of o.types) a.types.add(t);
    a.releases.push(releaseMap.get(`${o.file}\0${o.needle}`) ?? "unreleased");
  }
  for (const add of overrides.add) {
    const u = okByKey.get(lc(add.handle));
    if (!u || isExcluded(ex, add.handle)) continue;
    const a = accFor(u.id, u.login);
    for (const t of add.types) a.types.add(t);
    for (const r of add.numbers ?? []) a.refs.push(r);
    if (add.note) a.notes.push(add.note);
    a.releases.push(add.first_release ?? "unreleased");
  }

  const entries: CreditEntry[] = [];
  for (const a of byId.values()) {
    if (isExcluded(ex, a.handle, a.github_id)) continue; // the API login may differ from the written handle
    const types = sortTypes(a.types);
    const entry: CreditEntry = {
      handle: a.handle,
      github_id: a.github_id,
      numbers: sortRefs(a.refs),
      types: types.length ? types : ["code"],
      first_release: minRelease(a.releases),
      releases: [...new Set(a.releases.filter((r) => releaseKey(r) !== null))].sort(compareReleases),
    };
    if (a.notes.length) entry.note = [...new Set(a.notes)].join("; ");
    entries.push(entry);
  }
  entries.sort((x, y) => lc(x.handle).localeCompare(lc(y.handle)) || x.handle.localeCompare(y.handle));

  const unresolvedRefs = sortRefs(unresolvedOccs.map((o) => ({ kind: o.kind, number: o.number })));
  const credits: CreditsFile = {
    schema: 1,
    repo,
    entries,
    flagged: flagged.sort((a, b) => lc(a.handle).localeCompare(lc(b.handle))),
    unresolved: unresolvedRefs,
    unresolved_count: unresolvedRefs.length,
  };
  const unresolved_detail = unresolvedOccs
    .map((o) => ({ kind: o.kind, number: o.number, file: o.file, line: o.line }))
    .sort((a, b) => a.number - b.number || a.file.localeCompare(b.file) || a.line - b.line);
  const baseline_exceeded = opts.baseline ? credits.unresolved_count > opts.baseline.unresolved : false;
  return { credits, unresolved_detail, skipped_authors, baseline_exceeded };
}

// ======================================================================
// credits.json I/O
// ======================================================================

function assertCreditsInvariants(c: CreditsFile): void {
  invariant(c.schema === 1, "credits schema must be 1");
  const seen = new Set<string>();
  let prev = "";
  for (const e of c.entries) {
    invariant(HANDLE_SHAPE.test(e.handle), `credited handle has an invalid shape: ${e.handle}`);
    invariant(Number.isInteger(e.github_id) && e.github_id > 0, `credited handle ${e.handle} has no positive numeric id`);
    invariant(!seen.has(lc(e.handle)), `duplicate credited handle: ${e.handle}`);
    seen.add(lc(e.handle));
    invariant(lc(e.handle) >= prev, "credits entries must be sorted case-insensitively");
    prev = lc(e.handle);
    invariant(e.types.every((t) => TYPE_ORDER.includes(t)), `unknown credit type on ${e.handle}`);
    invariant(typeof e.first_release === "string" && e.first_release.length > 0, `missing first_release on ${e.handle}`);
  }
  for (const f of c.flagged) invariant(!seen.has(lc(f.handle)), `flagged handle ${f.handle} is also credited`);
  invariant(c.unresolved_count === c.unresolved.length, "unresolved_count must equal unresolved.length");
}

function atomicWrite(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, body);
  renameSync(tmp, path);
}

export function writeCredits(path: string, credits: CreditsFile): void {
  assertCreditsInvariants(credits);
  const body = JSON.stringify(credits, null, 2) + "\n";
  invariant(JSON.parse(body).entries.length === credits.entries.length, "credits JSON did not round-trip");
  atomicWrite(path, body);
}

/** Shape check for one credits entry; the one place that says what a renderable, trailer-able entry is (ISC-96). */
function checkEntry(e: unknown, where: string): CreditEntry {
  if (!isPlainObject(e)) throw new RejectedInput(`${where}: entry must be an object`);
  const handle = checkHandle(e.handle, where);
  const w = `${where} (@${handle})`;
  if (!isPosInt(e.github_id)) throw new RejectedInput(`${w}: github_id must be a positive integer, got ${JSON.stringify(e.github_id)}`);
  const numbers = checkRefs(e.numbers ?? [], w);
  const types = checkTypes(e.types ?? [], w);
  if (typeof e.first_release !== "string" || !e.first_release.trim()) throw new RejectedInput(`${w}: first_release must be a non-empty string`);
  if (e.note !== undefined && typeof e.note !== "string") throw new RejectedInput(`${w}: note must be a string`);
  if (e.releases !== undefined && (!Array.isArray(e.releases) || !e.releases.every((r) => typeof r === "string" && releaseKey(r) !== null))) throw new RejectedInput(`${w}: releases must be a list of release tags`);
  const out: CreditEntry = { handle, github_id: e.github_id as number, numbers, types, first_release: e.first_release };
  if (Array.isArray(e.releases)) out.releases = e.releases as string[];
  if (typeof e.note === "string") out.note = e.note;
  return out;
}

/** Every entry valid, no handle or id appearing twice. */
function checkEntries(entries: unknown[], where: string): CreditEntry[] {
  const handles = new Set<string>();
  const ids = new Set<number>();
  return entries.map((raw, i) => {
    const e = checkEntry(raw, `${where} entries[${i}]`);
    if (handles.has(lc(e.handle))) throw new RejectedInput(`${where}: duplicate handle ${e.handle}`);
    if (ids.has(e.github_id)) throw new RejectedInput(`${where}: github_id ${e.github_id} appears on two entries`);
    handles.add(lc(e.handle));
    ids.add(e.github_id);
    return e;
  });
}

function checkedUnresolvedCount(stored: unknown, actual: number, path: string): number {
  if (stored === undefined) return actual;
  if (!Number.isInteger(stored) || (stored as number) < 0) throw new RejectedInput(`${path}: unresolved_count must be a nonnegative integer, got ${JSON.stringify(stored)}`);
  if (stored !== actual) throw new RejectedInput(`${path}: unresolved_count ${stored as number} disagrees with the ${actual} unresolved reference(s) listed`);
  return actual;
}

export function loadCredits(path: string): CreditsFile {
  let j: unknown;
  try {
    j = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new RejectedInput(`cannot read ${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!isPlainObject(j) || j.schema !== 1 || !Array.isArray(j.entries)) throw new RejectedInput(`${path} is not a credits.json (schema 1)`);
  const entries = checkEntries(j.entries, path);
  const flaggedRaw = j.flagged ?? [];
  if (!Array.isArray(flaggedRaw)) throw new RejectedInput(`${path}: flagged must be an array`);
  const flagged = flaggedRaw.map((f, i) => {
    const w = `${path} flagged[${i}]`;
    if (!isPlainObject(f)) throw new RejectedInput(`${w} must be an object`);
    const handle = checkHandle(f.handle, w);
    if (f.reason !== "not_found" && f.reason !== "id_changed") throw new RejectedInput(`${w}: bad reason ${JSON.stringify(f.reason)}`);
    for (const k of ["previous_id", "github_id"] as const) {
      if (f[k] !== undefined && !isPosInt(f[k])) throw new RejectedInput(`${w}: ${k} must be a positive integer`);
    }
    return f as unknown as Flagged & { handle: string };
  });
  const unresolved = (j.unresolved ?? []) as Ref[];
  checkRefs(unresolved, `${path} unresolved`);
  return {
    schema: 1,
    repo: typeof j.repo === "string" ? j.repo : creditsRepo(),
    entries,
    flagged,
    unresolved,
    // The count is derived from the validated references; a stored count is only cross-checked. A negative or
    // disagreeing count is rejected, never trusted, since the gate compares it to the baseline.
    unresolved_count: checkedUnresolvedCount(j.unresolved_count, unresolved.length, path),
  };
}

/** Entries minus anything excluded by handle or numeric id, and the ghost placeholder: applied again at output time so a stale file cannot leak a name. */
function visibleEntries(entries: CreditEntry[], overrides?: Overrides): CreditEntry[] {
  const ex = exclusionsOf(overrides);
  return entries.filter((e) => !isExcluded(ex, e.handle, e.github_id));
}

// ======================================================================
// readme
// ======================================================================

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function renderBlock(entries: CreditEntry[], overrides?: Overrides): string {
  checkEntries(entries, "renderBlock");
  const rows = visibleEntries(entries, overrides)
    .slice()
    .sort((a, b) => lc(a.handle).localeCompare(lc(b.handle)) || a.handle.localeCompare(b.handle))
    .map(
      (e) =>
        `<a href="https://github.com/${esc(e.handle)}"><img src="https://avatars.githubusercontent.com/u/${e.github_id}?v=4&s=64" width="48" height="48" alt="${esc(e.handle)}" title="${esc(e.handle)}"></a>`,
    );
  return [START_MARKER, '<p align="center">', ...rows, "</p>", END_MARKER].join("\n");
}

export function blockHandles(readmeText: string): { found: boolean; handles: string[] } {
  const s = readmeText.indexOf(START_MARKER);
  const e = readmeText.indexOf(END_MARKER);
  if (s < 0 || e < 0 || e < s) return { found: false, handles: [] };
  const inner = readmeText.slice(s, e);
  const handles = [...inner.matchAll(/<a href="https:\/\/github\.com\/([A-Za-z0-9-]+)"/g)].map((m) => m[1]);
  return { found: true, handles };
}

export function writeReadme(
  readmePath: string,
  credits: CreditsFile,
  overrides?: Overrides,
): { ok: true; handles: number; changed: boolean } | { ok: false; error: string } {
  const before = readFileSync(readmePath, "utf8");
  const starts = before.split(START_MARKER).length - 1;
  const ends = before.split(END_MARKER).length - 1;
  if (starts !== 1 || ends !== 1 || before.indexOf(START_MARKER) > before.indexOf(END_MARKER)) {
    return { ok: false, error: `${readmePath} must contain exactly one ${START_MARKER} followed by one ${END_MARKER}` };
  }
  const entries = visibleEntries(credits.entries, overrides);
  const block = renderBlock(credits.entries, overrides);
  const s = before.indexOf(START_MARKER);
  const e = before.indexOf(END_MARKER) + END_MARKER.length;
  const after = before.slice(0, s) + block + before.slice(e);

  // invariants: everything outside the markers is untouched, and every credited handle is in the block
  invariant(after.slice(0, s) === before.slice(0, s), "README text before the credits block changed");
  invariant(after.endsWith(before.slice(e)), "README text after the credits block changed");
  const got = new Set(blockHandles(after).handles.map(lc));
  for (const en of entries) invariant(got.has(lc(en.handle)), `credited handle ${en.handle} missing from the generated block`);
  invariant(got.size === entries.length, "generated block carries a handle that is not credited");

  if (after !== before) atomicWrite(readmePath, after);
  return { ok: true, handles: entries.length, changed: after !== before };
}

// ======================================================================
// gate
// ======================================================================

export interface GateResult {
  ok: boolean;
  exitCode: 0 | 1;
  missing: string[];
  /** Excluded (by handle, numeric id or the ghost placeholder) yet still in the README block, as the README spells them. */
  excluded_present: string[];
  unresolved_count: number;
  baseline: number | null;
  exceeded: boolean;
  errors: string[];
}

/** Handle and avatar id of every row in the README block (id is null when the row has no avatar URL). */
export function blockRows(readmeText: string): Array<{ handle: string; id: number | null }> {
  const s = readmeText.indexOf(START_MARKER);
  const e = readmeText.indexOf(END_MARKER);
  if (s < 0 || e < 0 || e < s) return [];
  const parts = readmeText.slice(s, e).split('<a href="https://github.com/').slice(1);
  const rows: Array<{ handle: string; id: number | null }> = [];
  for (const p of parts) {
    const h = /^([A-Za-z0-9-]+)"/.exec(p);
    if (!h) continue;
    const id = /avatars\.githubusercontent\.com\/u\/(\d+)/.exec(p);
    rows.push({ handle: h[1], id: id ? Number(id[1]) : null });
  }
  return rows;
}

export function gate(input: { credits: CreditsFile; readmeText: string; baseline?: Baseline; overrides?: Overrides }): GateResult {
  const errors: string[] = [];
  const block = blockHandles(input.readmeText);
  if (!block.found) errors.push(`README has no ${START_MARKER} ... ${END_MARKER} block`);
  const have = new Set(block.handles.map(lc));
  const missing = visibleEntries(input.credits.entries, input.overrides)
    .filter((e) => !have.has(lc(e.handle)))
    .map((e) => e.handle);
  const ex = exclusionsOf(input.overrides);
  const excluded_present = [
    ...new Set(
      blockRows(input.readmeText)
        .filter((r) => isExcluded(ex, r.handle, r.id ?? undefined))
        .map((r) => r.handle),
    ),
  ];
  // The gate counts the references themselves; an in-memory count that disagrees with them is refused.
  const unresolved_count = input.credits.unresolved.length;
  if (input.credits.unresolved_count !== unresolved_count) {
    const errors = [`unresolved_count ${input.credits.unresolved_count} disagrees with the ${unresolved_count} unresolved reference(s) listed`];
    return { ok: false, exitCode: 1, missing: [], excluded_present: [], unresolved_count, baseline: input.baseline ? input.baseline.unresolved : null, exceeded: false, errors };
  }
  const baseline = input.baseline ? input.baseline.unresolved : null;
  const exceeded = baseline !== null && unresolved_count > baseline;
  if (missing.length) errors.push(`${missing.length} credited handle(s) missing from the README block: ${missing.join(", ")}`);
  if (excluded_present.length) errors.push(`${excluded_present.length} excluded handle(s) still in the README block: ${excluded_present.join(", ")}`);
  if (exceeded) errors.push(`unresolved credit comments rose to ${unresolved_count}, above the baseline of ${baseline}`);
  const ok = errors.length === 0;
  return { ok, exitCode: ok ? 0 : 1, missing, excluded_present, unresolved_count, baseline, exceeded, errors };
}

// ======================================================================
// release + trailers
// ======================================================================

export function noreplyTrailer(login: string, id: number): string {
  invariant(HANDLE_SHAPE.test(login) && Number.isInteger(id) && id > 0, `cannot build a co-author line for ${login}/${id}`);
  return `Co-authored-by: ${login} <${id}+${login}@users.noreply.github.com>`;
}

export function releaseList(credits: CreditsFile, version: string, overrides?: Overrides): CreditEntry[] {
  const want = normVersion(version);
  return visibleEntries(credits.entries, overrides).filter((e) => normVersion(e.first_release) === want);
}

export function releaseTrailers(credits: CreditsFile, version: string, overrides?: Overrides): string[] {
  return releaseList(credits, version, overrides).map((e) => noreplyTrailer(e.handle, e.github_id));
}

interface DiffLine {
  text: string;
  added: boolean;
}
interface Hunk {
  file: string;
  lines: DiffLine[];
}

/** New-side lines of every hunk in a unified diff, with an `added` flag per line. */
export function parseDiff(diff: string): Hunk[] {
  const hunks: Hunk[] = [];
  let file = "";
  let cur: Hunk | null = null;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      cur = null;
      continue;
    }
    if (raw.startsWith("+++ ")) {
      file = raw.slice(4).replace(/^b\//, "");
      continue;
    }
    if (raw.startsWith("--- ")) continue;
    if (raw.startsWith("@@")) {
      cur = { file, lines: [] };
      hunks.push(cur);
      continue;
    }
    if (!cur) continue;
    if (raw.startsWith("+")) cur.lines.push({ text: raw.slice(1), added: true });
    else if (raw.startsWith(" ")) cur.lines.push({ text: raw.slice(1), added: false });
  }
  return hunks;
}

/** A range is a revision expression, never an option: refuse anything git could read as a flag (ISC-97). */
export function validateRange(range: unknown): string {
  if (typeof range !== "string" || range.length === 0 || range !== range.trim()) {
    throw new RejectedInput("git range must be a non-empty string without surrounding whitespace");
  }
  if (range.startsWith("-")) throw new RejectedInput(`git range must not start with "-": ${JSON.stringify(range)}`);
  if (/[\x00-\x1f\x7f]/.test(range)) throw new RejectedInput("git range must not contain control characters");
  return range;
}

/** The git arguments for a range diff. The range follows --end-of-options, so it can never be parsed as an option. */
export function rangeDiffArgs(range: string): string[] {
  const r = validateRange(range);
  return ["diff", "--no-color", "--no-ext-diff", "-U1", "--end-of-options", r, "--", ".", ":(exclude)LIFEOS/MEMORY"];
}

export async function trailersForRange(
  opts: { root: string; range: string; repo?: string; overrides?: Overrides; previous?: CreditsFile | null },
  deps: { resolver: Resolver },
): Promise<{ trailers: string[]; warnings: string[]; skipped_authors: number }> {
  const repo = opts.repo ?? creditsRepo();
  const ex = exclusionsOf(opts.overrides);
  const pins = pinnedIds(opts.previous);
  const diffArgs = rangeDiffArgs(opts.range); // validates before git runs
  const d = await git(opts.root, diffArgs);
  if (d.code !== 0) throw new Error(`git diff ${opts.range} failed: ${d.err.trim()}`);

  const warnings: string[] = [];
  const ignoreCache = new Map<string, boolean>();
  /** Fails closed: a file that cannot be read cannot be shown free of the ignore marker, so it earns no credit. */
  const isIgnored = (file: string): boolean => {
    if (!ignoreCache.has(file)) {
      let ignored: boolean;
      try {
        ignored = readFileSync(join(opts.root, file), "utf8").includes(IGNORE_MARKER);
      } catch {
        ignored = true;
        warnings.push(`skipped ${file}: could not read it to check for the ignore marker, so its credit comments were not used`);
      }
      ignoreCache.set(file, ignored);
    }
    return ignoreCache.get(file) as boolean;
  };

  const found: Array<{ handle: string | null; number: number }> = [];
  for (const h of parseDiff(d.out)) {
    if (!h.file || BINARY_EXT.test(h.file)) continue;
    const occs = parseLines(h.lines.map((l) => l.text), h.file).filter((o) => h.lines[o.line - 1]?.added);
    if (!occs.length || isIgnored(h.file)) continue;
    for (const o of occs) found.push({ handle: o.handle, number: o.number });
  }

  let skipped_authors = 0;
  const logins = new Map<string, string>(); // lower -> spelled
  const needAuthor = [...new Set(found.filter((f) => !f.handle).map((f) => f.number))];
  const authorOf = new Map<number, string | null>();
  await pmap(needAuthor, 8, async (n) => {
    authorOf.set(n, await deps.resolver.author(n));
  });
  for (const f of found) {
    let login = f.handle;
    if (!login) {
      login = authorOf.get(f.number) ?? null;
      if (!login) {
        warnings.push(`no handle and no author found for #${f.number}; no co-author line emitted`);
        continue;
      }
      if (isGhost(login) || isBotOrOwner(login, repo)) {
        skipped_authors++;
        continue;
      }
    }
    if (isExcluded(ex, login)) continue;
    if (!logins.has(lc(login))) logins.set(lc(login), login);
  }

  const lines: Array<{ sort: string; line: string }> = [];
  const seenIds = new Set<number>();
  const resolved = await pmap([...logins.values()], 8, async (login) => ({ login, res: await deps.resolver.user(login) }));
  for (const { login, res } of resolved) {
    if (res.status === "ok") {
      if (isExcluded(ex, res.login, res.id) || seenIds.has(res.id)) continue;
      const pin = pins.get(lc(login)) ?? pins.get(lc(res.login));
      if (pin !== undefined && pin !== res.id) {
        warnings.push(`skipped @${login}: GitHub id changed from ${pin} to ${res.id}; no co-author line until a human clears the flag in credits.json`);
        continue;
      }
      seenIds.add(res.id);
      lines.push({ sort: lc(res.login), line: noreplyTrailer(res.login, res.id) });
    } else if (res.status === "not_found") {
      warnings.push(`skipped @${login}: no such GitHub user, so no co-author address was guessed`);
    } else {
      warnings.push(`skipped @${login}: GitHub lookup failed (${res.message}), so no co-author address was guessed`);
    }
  }
  lines.sort((a, b) => a.sort.localeCompare(b.sort));
  return { trailers: lines.map((l) => l.line), warnings, skipped_authors };
}

// ======================================================================
// The real GitHub resolver
// ======================================================================

export type GhRun = (args: string[]) => Promise<GitResult>;

export function ghResolver(repo: string = creditsRepo(), run?: GhRun): Resolver {
  const gh: GhRun = run ?? (async (args) => {
    const proc = Bun.spawn(["gh", "api", ...args], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1" },
    });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { code, out, err };
  });
  // 404 and 410 both mean the account or issue is gone: unresolved, not a crash
  const notFound = (r: GitResult) => /HTTP 40[4]|HTTP 410|Not Found|\bGone\b/i.test(r.err + r.out);
  return {
    async user(handle) {
      invariant(HANDLE_SHAPE.test(handle), `refusing to look up a malformed handle: ${handle}`);
      const r = await gh([`users/${handle}`]);
      if (r.code !== 0) return notFound(r) ? { status: "not_found" } : { status: "error", message: r.err.trim().slice(0, 200) || `gh exited ${r.code}` };
      try {
        const j = JSON.parse(r.out) as { id?: number; login?: string };
        if (!Number.isInteger(j.id) || !j.login) return { status: "error", message: "unexpected response shape" };
        return { status: "ok", id: j.id as number, login: j.login };
      } catch {
        return { status: "error", message: "unparseable response" };
      }
    },
    async author(number) {
      invariant(Number.isInteger(number) && number > 0, `bad issue number ${number}`);
      const r = await gh([`repos/${repo}/issues/${number}`, "--jq", ".user.login"]);
      if (r.code !== 0) {
        if (notFound(r)) return null;
        throw new Error(`GitHub lookup failed for ${repo}#${number}: ${r.err.trim().slice(0, 200)}`);
      }
      const login = r.out.trim();
      return login || null;
    },
  };
}

// ======================================================================
// CLI
// ======================================================================

const EXIT_CODES = {
  "0": "ok",
  "1": "gate failed (a credited handle is missing from the README block, an excluded one is still in it, or unresolved comments rose above the baseline), or an input file or git range was rejected",
  "2": "usage or runtime error",
};

const CATALOG = {
  tool: "Credits",
  version: "1.2.0",
  summary: "Contributor credit generated from fix-site comments in tracked source.",
  commands: [
    {
      name: "build",
      usage: "build [--root <repo>] [--out <credits.json>] [--overrides <file>] [--record-exclusions] [--baseline <file>] [--previous <credits.json>] [--repo owner/name]",
      summary: "Scan tracked source for `public issue|PR #N, @handle` comments, resolve handles to GitHub ids, write credits.json.",
      notes: "overrides: { add:[{handle,types,note}], exclude:[handle | {handle,github_id}] }; an excluded numeric id is dropped whatever name it now has, and --record-exclusions writes the id next to each bare excluded handle (one lookup each; the file is rewritten only when every lookup succeeds). The GitHub placeholder \"ghost\" is never credited. baseline: { unresolved: N }; exits 1 when the unresolved count is above it. --previous defaults to the existing --out file; a handle whose id changed or that 404s is flagged, not credited. An id_changed or not_found flag stays (with the original previous_id) on every rebuild until a human deletes that record from credits.json.",
    },
    {
      name: "readme",
      usage: "readme --credits <file> [--write <readme>] [--overrides <file>]",
      summary: `Render the avatar block between ${START_MARKER} and ${END_MARKER}; with --write, replace it in place (byte-identical on a second run).`,
    },
    {
      name: "gate",
      usage: "gate --credits <file> --readme <file> [--baseline <file>] [--overrides <file>]",
      summary: "Exit 1 when a credited handle is missing from the README block, an excluded handle or id is still in it, or the unresolved count exceeds the baseline.",
    },
    {
      name: "release",
      usage: "release <version> --credits <file> [--trailers] [--overrides <file>]",
      summary: "List the contributors whose first_release is <version>; with --trailers, print their Co-authored-by lines.",
    },
    {
      name: "trailers",
      usage: "trailers <git-range> [--root <repo>] [--credits <file>] [--overrides <file>] [--repo owner/name]",
      summary: "One Co-authored-by line per contributor whose fix-site comment was added in the range. An unresolvable handle, or one whose GitHub id differs from the id in --credits, is skipped with a warning on stderr.",
    },
    { name: "help", usage: "help [--json]", summary: "This catalog." },
  ],
  global_flags: [{ name: "--json", summary: "Machine-readable stdout." }],
  exit_codes: EXIT_CODES,
};

interface Args {
  cmd: string;
  positional: string[];
  flags: Map<string, string | true>;
}

const VALUE_FLAGS = new Set(["root", "out", "overrides", "baseline", "previous", "repo", "credits", "readme", "write"]);

function parseArgs(argv: string[]): Args {
  const flags = new Map<string, string | true>();
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const name = a.slice(2);
      if (VALUE_FLAGS.has(name)) {
        const v = argv[++i];
        if (v === undefined || v.startsWith("--")) throw new UsageError(`--${name} needs a value`);
        flags.set(name, v);
      } else flags.set(name, true);
    } else positional.push(a);
  }
  return { cmd: positional.shift() ?? "help", positional, flags };
}

class UsageError extends Error {}

function defaultRoot(): string {
  return getClaudeDir();
}

function readBaseline(path: string | undefined): Baseline | undefined {
  if (!path) return undefined;
  const j = JSON.parse(readFileSync(path, "utf8")) as Partial<Baseline>;
  if (!Number.isInteger(j.unresolved) || (j.unresolved as number) < 0) throw new UsageError(`${path} must look like { "unresolved": <count> }`);
  return { unresolved: j.unresolved as number };
}

function need(args: Args, name: string): string {
  const v = args.flags.get(name);
  if (typeof v !== "string") throw new UsageError(`--${name} is required`);
  return v;
}
const opt = (args: Args, name: string): string | undefined => {
  const v = args.flags.get(name);
  return typeof v === "string" ? v : undefined;
};

export async function main(argv: string[], deps?: { resolver?: Resolver }): Promise<number> {
  let json = argv.includes("--json");
  const print = (obj: unknown, human: string) => process.stdout.write(json ? JSON.stringify(obj) + "\n" : human.endsWith("\n") ? human : human + "\n");
  try {
    const args = parseArgs(argv);
    json = args.flags.has("json");
    // Resolved on first use, so help and the commands that never touch GitHub still run with a broken repo config.
    const repoOf = () => opt(args, "repo") ?? creditsRepo();
    const resolver = () => deps?.resolver ?? ghResolver(repoOf());

    switch (args.cmd) {
      case "help": {
        print(CATALOG, [`Credits ${CATALOG.version}: ${CATALOG.summary}`, "", ...CATALOG.commands.map((c) => `  ${c.usage}\n      ${c.summary}`), "", "Exit codes: 0 ok, 1 gate failed, 2 usage or runtime error"].join("\n"));
        return 0;
      }
      case "build": {
        const root = resolve(opt(args, "root") ?? defaultRoot());
        const out = opt(args, "out");
        const overridesPath = opt(args, "overrides");
        if (args.flags.has("record-exclusions")) {
          if (!overridesPath) throw new UsageError("--record-exclusions needs --overrides <file>");
          const rec = await recordExclusionIds(overridesPath, resolver());
          for (const h of rec.unresolved) process.stderr.write(`warning: excluded @${h} no longer resolves on GitHub; kept as a bare handle\n`);
        }
        const overrides = loadOverrides(overridesPath);
        const baseline = readBaseline(opt(args, "baseline"));
        const prevPath = opt(args, "previous") ?? (out && existsSync(out) ? out : undefined);
        const previous = prevPath && existsSync(prevPath) ? loadCredits(prevPath) : null;
        const r = await build({ root, repo: repoOf(), overrides, previous, baseline }, { resolver: resolver() });
        if (out) writeCredits(out, r.credits);
        const summary = {
          ok: !r.baseline_exceeded,
          out: out ?? null,
          entries: r.credits.entries.length,
          unresolved_count: r.credits.unresolved_count,
          unresolved: r.unresolved_detail,
          flagged: r.credits.flagged,
          skipped_authors: r.skipped_authors,
          baseline: baseline ? { allowed: baseline.unresolved, exceeded: r.baseline_exceeded } : null,
        };
        print(
          summary,
          [
            `${r.credits.entries.length} contributors credited${out ? ` -> ${out}` : ""}`,
            `${r.credits.unresolved_count} unresolved comment(s)${r.unresolved_detail.map((u) => `\n  ${u.kind} #${u.number}  ${u.file}:${u.line}`).join("")}`,
            `${r.credits.flagged.length} flagged handle(s)${r.credits.flagged.map((f) => `\n  @${f.handle}: ${f.reason}`).join("")}`,
            baseline ? (r.baseline_exceeded ? `BASELINE EXCEEDED (allowed ${baseline.unresolved})` : `within baseline (${baseline.unresolved})`) : "",
          ].filter(Boolean).join("\n"),
        );
        return r.baseline_exceeded ? 1 : 0;
      }
      case "readme": {
        const credits = loadCredits(need(args, "credits"));
        const overrides = loadOverrides(opt(args, "overrides"));
        const target = opt(args, "write");
        if (!target) {
          const block = renderBlock(credits.entries, overrides);
          print({ ok: true, handles: visibleEntries(credits.entries, overrides).length, block }, block);
          return 0;
        }
        const r = writeReadme(target, credits, overrides);
        if (!r.ok) {
          print({ ok: false, error: r.error }, `error: ${r.error}`);
          return 2;
        }
        print({ ok: true, wrote: target, handles: r.handles, changed: r.changed }, `${r.changed ? "rewrote" : "unchanged"} ${target} (${r.handles} handles)`);
        return 0;
      }
      case "gate": {
        const credits = loadCredits(need(args, "credits"));
        const readmeText = readFileSync(need(args, "readme"), "utf8");
        const r = gate({ credits, readmeText, baseline: readBaseline(opt(args, "baseline")), overrides: loadOverrides(opt(args, "overrides")) });
        print(r, r.ok ? "credits gate: ok" : ["credits gate: FAILED", ...r.errors.map((e) => `  ${e}`)].join("\n"));
        return r.exitCode;
      }
      case "release": {
        const version = args.positional[0];
        if (!version) throw new UsageError("release needs a <version>");
        const credits = loadCredits(need(args, "credits"));
        const overrides = loadOverrides(opt(args, "overrides"));
        const list = releaseList(credits, version, overrides);
        if (args.flags.has("trailers")) {
          const lines = releaseTrailers(credits, version, overrides);
          print({ ok: true, version, trailers: lines }, lines.join("\n"));
        } else {
          print({ ok: true, version, contributors: list }, list.length ? list.map((e) => `${e.handle}  ${e.numbers.map((n) => `${n.kind === "pr" ? "PR " : ""}#${n.number}`).join(", ")}`).join("\n") : `no contributors first credited in ${version}`);
        }
        return 0;
      }
      case "trailers": {
        const range = args.positional[0];
        if (!range) throw new UsageError("trailers needs a <git-range>");
        validateRange(range);
        const root = resolve(opt(args, "root") ?? defaultRoot());
        const credPath = opt(args, "credits");
        const previous = credPath ? loadCredits(credPath) : null;
        const r = await trailersForRange({ root, range, repo: repoOf(), overrides: loadOverrides(opt(args, "overrides")), previous }, { resolver: resolver() });
        for (const w of r.warnings) process.stderr.write(`warning: ${w}\n`);
        print({ ok: true, range, trailers: r.trailers, warnings: r.warnings }, r.trailers.join("\n"));
        return 0;
      }
      default:
        throw new UsageError(`unknown command: ${args.cmd}`);
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (json) process.stdout.write(JSON.stringify({ ok: false, error: message }) + "\n");
    else process.stderr.write(`error: ${message}\n`);
    return e instanceof RejectedInput ? 1 : 2;
  }
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
