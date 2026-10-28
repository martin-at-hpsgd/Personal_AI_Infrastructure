/**
 * shell-paths.ts — the one shell-path resolver the Bash guards share.
 *
 * Spec: the boundary-primitives ISA, L1 Resolver (criterion C1).
 *
 * A guard that judges the paths a command names must judge the paths the shell actually opens. Per-guard
 * path logic leaves holes (found in the pre-release hooks audit): relative words judged against the starting
 * directory after the line ran `cd`, symlink aliases judged by the name the command used, and brace
 * alternatives silently dropped past a cap. This module is the one place that work happens:
 *
 *   - `cd`, `pushd` and `chdir` are tracked through the line. A line may leave a subshell, so the set of
 *     working directories only grows: every later word is judged against every directory the line may be
 *     in (the starting one included), which never judges a word in fewer places than before.
 *   - `~`, `$HOME` and variables assigned earlier in the same line are substituted.
 *   - Brace alternatives (`{a,b}`, `{1..9}`, `{a..e}`, nested) are expanded in full up to BRACE_CAP. Past
 *     the cap nothing is dropped silently: the expansion is marked incomplete and callers fail closed.
 *   - Every existing path component is resolved through realpath, so a symlink alias resolves to the file
 *     it names and `link/..` follows the physical parent, as the kernel does. A dangling symlink is followed
 *     to the target it names, because a write through it creates that target.
 *
 * Fail closed: an unresolved `cd` target, a working-directory set past CWD_CAP, a brace or glob set past its
 * cap, more than PATH_CAP resolved paths, or a line nested deeper than the walker follows marks the result
 * `unresolved` with the reason, and callers treat it as protected. Every cap bounds the work a hostile line
 * can force on a guard that runs before every tool call. The walker (shell-commands.ts) throws only on a
 * parser bug, and that throw is left to the caller.
 *
 * I/O: read-only (realpath, readdir). Nothing here writes.
 *
 * Honest residual: paths a program computes at run time (a script reading a file it chose, `$(…)` output
 * used as a path) are not visible in the text; the walker's own residual applies.
 */

import { lstatSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { continuationForms, crlfContinuations, programName, shellSteps, type ShellStep } from "./shell-commands";

/** Most words a single brace expression may expand to before the result is marked incomplete. */
export const BRACE_CAP = 1024;
/** Most directory entries a single glob may match before the result is marked incomplete. */
export const GLOB_CAP = 1024;
/** Most working directories (lexical and real forms) a line may be in before the set is marked unknown. */
export const CWD_CAP = 256;
/** Most resolved paths one command may yield before the result is marked incomplete. */
export const PATH_CAP = 4096;

export type UnresolvedReason = "brace-cap" | "glob-cap" | "cd" | "too-deep" | "path-cap";

export interface BraceExpansion {
  /** The expanded words, in bash order. */
  words: string[];
  /** False when the expansion passed the cap: `words` is then a prefix, and callers must fail closed. */
  complete: boolean;
}

/** A sequence expression body (`1..9`, `01..10..2`, `a..e`) as its terms; null when the body is not one. */
function sequenceTerms(body: string, cap: number): { terms: string[]; overflow: boolean } | null {
  const num = /^(-?\d+)\.\.(-?\d+)(?:\.\.(-?\d+))?$/.exec(body);
  if (num) {
    const [a, b] = [Number(num[1]), Number(num[2])];
    const step = Math.abs(Number(num[3] ?? 1)) || 1;
    // Bounds past exact integers cannot be enumerated here; the expansion is reported incomplete, never empty.
    if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || !Number.isSafeInteger(step)) return { terms: [], overflow: true };
    const width = /^-?0\d/.test(num[1]!) || /^-?0\d/.test(num[2]!) ? Math.max(num[1]!.length, num[2]!.length) : 0;
    const count = Math.floor(Math.abs(b - a) / step) + 1;
    const dir = a <= b ? 1 : -1;
    const terms: string[] = [];
    for (let k = 0; k < Math.min(count, cap + 1); k++) {
      const v = a + dir * k * step;
      const s = String(Math.abs(v)).padStart(width ? width - (v < 0 ? 1 : 0) : 0, "0");
      terms.push(v < 0 ? "-" + s : s);
    }
    return { terms, overflow: count > cap };
  }
  const chr = /^([A-Za-z])\.\.([A-Za-z])(?:\.\.(-?\d+))?$/.exec(body);
  if (chr) {
    const [a, b] = [chr[1]!.charCodeAt(0), chr[2]!.charCodeAt(0)];
    const step = Math.abs(Number(chr[3] ?? 1)) || 1;
    const dir = a <= b ? 1 : -1;
    const terms: string[] = [];
    for (let c = a; dir > 0 ? c <= b : c >= b; c += dir * step) terms.push(String.fromCharCode(c));
    return { terms, overflow: false };
  }
  return null;
}

/** The first expandable brace expression at or after `from`: its span and alternatives. `${…}` is never one. */
function findBrace(w: string, from: number, cap: number): { open: number; close: number; parts: string[]; overflow: boolean } | null {
  for (let open = w.indexOf("{", from); open >= 0; open = w.indexOf("{", open + 1)) {
    if (open > 0 && w[open - 1] === "$") continue;
    let depth = 0;
    let close = -1;
    const commas: number[] = [];
    for (let i = open; i < w.length; i++) {
      const ch = w[i];
      if (ch === "\\") { i++; continue; }
      if (ch === "{") depth++;
      else if (ch === "}") { depth--; if (depth === 0) { close = i; break; } }
      else if (ch === "," && depth === 1) commas.push(i);
    }
    if (close < 0) continue; // unmatched: literal here, but a later `{` may still pair
    if (commas.length) {
      const cuts = [open, ...commas, close];
      const parts: string[] = [];
      for (let k = 0; k + 1 < cuts.length; k++) parts.push(w.slice(cuts[k]! + 1, cuts[k + 1]));
      return { open, close, parts, overflow: false };
    }
    const seq = sequenceTerms(w.slice(open + 1, close), cap);
    if (seq) return { open, close, parts: seq.terms, overflow: seq.overflow };
    // `{x}` with no comma and no sequence is literal; keep looking after it.
  }
  return null;
}

/**
 * Every brace alternative of `word`, in bash order, up to `cap` words. Nothing is dropped silently: past the
 * cap `complete` is false. Quotes are already removed by the walker, so a quoted brace is expanded too, which
 * only ever judges more words than bash would.
 */
export function braceExpansion(word: string, cap: number = BRACE_CAP): BraceExpansion {
  const words: string[] = [];
  let complete = true;
  const go = (w: string, from: number): void => {
    if (!complete) return;
    const b = findBrace(w, from, cap);
    if (!b) {
      if (words.length >= cap) { complete = false; return; }
      words.push(w);
      return;
    }
    if (b.overflow) complete = false;
    const head = w.slice(0, b.open);
    const tail = w.slice(b.close + 1);
    for (const p of b.parts) {
      if (!complete) return;
      go(head + p + tail, b.open);
    }
  };
  go(word, 0);
  return { words, complete };
}

/** True when a path segment carries shell glob syntax. */
export const hasGlob = (s: string): boolean => /[*?[]/.test(s);

/** A `[…]` body as a JS class, or any-one-character when JS can't compile it (`[s-l]`, a reversed range): a superset, so callers check more names, never fewer. */
function bracketClass(body: string): string {
  const cls = `[${body.replace(/\\/g, "\\\\")}]`;
  try { new RegExp(cls); return cls; } catch { return "[^/]"; }
}

/** A shell glob (`*`, `?`, `[…]`) on one path segment as an anchored RegExp; a leading `*`/`?` never matches a leading dot. Never throws. */
export function globSegmentRegExp(seg: string): RegExp {
  let re = "";
  for (let i = 0; i < seg.length; i++) {
    const ch = seg[i]!;
    if (ch === "*") re += i === 0 ? "(?!\\.)[^/]*" : "[^/]*";
    else if (ch === "?") re += i === 0 ? "(?!\\.)[^/]" : "[^/]";
    else if (ch === "[") {
      const end = seg.indexOf("]", i + 2);
      if (end < 0) { re += "\\["; continue; }
      let body = seg.slice(i + 1, end);
      if (body.startsWith("!")) body = "^" + body.slice(1);
      re += bracketClass(body);
      i = end;
    } else re += ch.replace(/[.+^${}()|\\]/g, "\\$&");
  }
  try { return new RegExp(`^${re}$`); } catch { return /^[^/]*$/; }
}

/** `~`, `$HOME`, `${HOME}` and `$VAR`/`${VAR}` from `vars`; null when an expansion stays unresolved. */
export function substituteWord(word: string, vars: Record<string, string>): string | null {
  const home = process.env.HOME ?? "";
  let w = word;
  if (w === "~" || w.startsWith("~/")) w = home + w.slice(1);
  w = w.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (m, a: string | undefined, b: string | undefined) => {
    const name = (a ?? b)!;
    if (name === "HOME") return home;
    return Object.prototype.hasOwnProperty.call(vars, name) ? vars[name]! : m;
  });
  return /[$`]/.test(w) ? null : w;
}

/** Input-redirect targets (`< file`, `0< file`) in the text, unquoted; heredocs, here-strings and `<(…)` excluded. */
export function inputRedirectTargets(text: string): string[] {
  const out: string[] = [];
  const re = /(?<![<\d])\d?<(?![<(&])\s*((?:"[^"]*"|'[^']*'|\\.|[^\s;|&<>()])+)/g;
  for (const form of continuationForms(text)) {
    for (const m of form.matchAll(re)) out.push(m[1]!.replace(/\\(.)/g, "$1").replace(/["']/g, ""));
  }
  return out;
}

/** The absolute form of `p` against `cwd`, lexically (no symlink resolution). */
export const absolutePath = (p: string, cwd: string): string => (isAbsolute(p) ? resolve(p) : resolve(cwd, p));

/** Most dangling symlinks followed in a row before resolution stops (the kernel's own loop limit). */
const SYMLINK_HOPS = 40;

/**
 * `p` (absolute) with every existing component resolved through realpath, left to right, so a symlinked
 * directory followed by `..` lands on the physical parent the kernel would open. A component that is a
 * dangling symlink is replaced by the target it names and resolution goes on from there: `echo x > link`
 * creates that target, so the target is the path a guard must judge. The first missing component that is
 * not a symlink ends resolution; the rest is joined lexically. `exists` is true when the whole path resolved.
 */
export function realPathOf(p: string, hops: number = SYMLINK_HOPS): { real: string; exists: boolean } {
  const segs = p.split("/").filter(Boolean);
  let cur = "/";
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]!;
    if (s === ".") continue;
    if (s === "..") { cur = dirname(cur); continue; }
    const next = join(cur, s);
    let real: string;
    try {
      real = realpathSync(next);
    } catch {
      let link: string | null = null;
      try { if (lstatSync(next).isSymbolicLink()) link = readlinkSync(next); } catch { link = null; }
      if (link !== null && hops > 0) {
        const target = isAbsolute(link) ? link : `${cur}/${link}`;
        return { real: realPathOf([target, ...segs.slice(i + 1)].join("/"), hops - 1).real, exists: false };
      }
      return { real: resolve(next, ...segs.slice(i + 1)), exists: false };
    }
    cur = real;
  }
  return { real: cur, exists: true };
}

/**
 * The lexical and physical forms of `p` run from `cwd`. The physical form resolves the RAW join, so `link/..`
 * follows the symlink before the parent step, as the kernel does; `resolve` alone folds `..` first and would
 * judge the wrong file. `lexical` is the folded form (what `cd -L` and a reader of the text see).
 */
export function pathForms(p: string, cwd: string): { lexical: string; real: string; exists: boolean } {
  const raw = isAbsolute(p) ? p : `${cwd}/${p}`;
  const { real, exists } = realPathOf(raw);
  return { lexical: resolve(raw), real, exists };
}

/** One simple command with its words substituted and the working directories it may run in. */
export interface ResolvedStep {
  step: ShellStep;
  /** step.argv with `~`, `$HOME` and line-assigned variables substituted; null where an expansion stays unresolved. */
  words: Array<string | null>;
  /** Every working directory this step may run in (lexical and real forms), the starting one first. */
  cwds: string[];
  /** An earlier `cd` in the line went somewhere the text does not say, or the set passed CWD_CAP. */
  cwdUnknown: boolean;
}

export interface ResolvedSteps {
  steps: ResolvedStep[];
  /** Every working directory the line may use by its end. */
  cwds: string[];
  /** Variables known at the end of the line. */
  vars: Record<string, string>;
  tooDeep: boolean;
  /** Why the result is not complete; empty when it is. */
  reasons: UnresolvedReason[];
}

const CD_PROGRAMS: ReadonlySet<string> = new Set(["cd", "pushd", "chdir"]);

/**
 * The simple commands `command` runs, in order, each with its words substituted and the set of working
 * directories it may run in, starting from `cwd`. `cwd` null means no starting directory is known: only an
 * absolute `cd` then supplies one. Throws only on a walker bug.
 */
export function resolveSteps(command: string, cwd: string | null): ResolvedSteps {
  const walked = shellSteps(crlfContinuations(command));
  const reasons = new Set<UnresolvedReason>();
  if (walked.tooDeep) reasons.add("too-deep");
  const cwds: string[] = [];
  let cwdUnknown = false;
  // `cd` is logical by default and physical with -P, so both forms of the target join the set.
  const addCwd = (p: string, base: string = "/") => {
    const f = pathForms(p, base);
    for (const d of [f.lexical, f.real]) {
      if (cwds.includes(d)) continue;
      if (cwds.length >= CWD_CAP) { cwdUnknown = true; reasons.add("cd"); return; }
      cwds.push(d);
    }
  };
  if (cwd !== null) addCwd(resolve(cwd));
  const vars: Record<string, string> = {};
  const steps: ResolvedStep[] = [];
  for (const step of walked.steps) {
    // Bare `X=…` statements and prefix assignments become known values for later words.
    for (const [k, v] of Object.entries(step.env)) {
      const sub = substituteWord(v, vars);
      if (sub !== null) vars[k] = sub; else delete vars[k];
    }
    const words = step.argv.map((w) => substituteWord(w, vars));
    steps.push({ step, words, cwds: [...cwds], cwdUnknown });
    const head = words[0];
    if (head === undefined || head === null || !CD_PROGRAMS.has(programName(head))) continue;
    // `cd [-L|-P|-e|-@] [--] [dir]`: no dir is HOME; `-` is OLDPWD, already in the set.
    let i = 1;
    for (; i < step.argv.length; i++) {
      const raw = step.argv[i]!;
      if (raw === "--") { i++; break; }
      if (raw === "-" || !raw.startsWith("-")) break;
    }
    if (i >= step.argv.length) { addCwd(process.env.HOME ?? "/"); continue; }
    if (step.argv[i] === "-") continue;
    const target = words[i];
    if (target === null || target === undefined || hasGlob(target)) { cwdUnknown = true; reasons.add("cd"); continue; }
    const exp = braceExpansion(target);
    if (!exp.complete) { cwdUnknown = true; reasons.add("brace-cap"); }
    for (const t of exp.words) {
      if (isAbsolute(t)) { addCwd(t); continue; }
      if (!cwds.length) { cwdUnknown = true; reasons.add("cd"); continue; }
      for (const c of [...cwds]) addCwd(t, c);
    }
  }
  return { steps, cwds, vars, tooDeep: walked.tooDeep, reasons: [...reasons] };
}

/** One path the command names, resolved against one working directory. */
export interface ResolvedPath {
  /** The word as substituted and brace-expanded (never file content). */
  word: string;
  /** Its absolute lexical form. */
  lexical: string;
  /** Its form with every existing component resolved through realpath. */
  real: string;
  /** The whole path exists on disk. */
  exists: boolean;
}

export interface CommandPaths extends ResolvedSteps {
  paths: ResolvedPath[];
  /** True when any part could not be resolved; callers treat the command as touching a protected path. */
  unresolved: boolean;
}

/**
 * The words a glob path matches on disk, one segment at a time, so a glob in a parent directory (a star between two
 * slashes, as in /tmp/STAR/.env) is expanded exactly like a glob in the last segment. Each hit keeps the shape of `word` (relative stays relative), so
 * pathForms resolves it against the same working directory. The frontier is bounded by GLOB_CAP; past it the walk
 * stops and says so, and the caller marks the result unresolved.
 */
function globWords(word: string, dir: string): { hits: string[]; capped: boolean } {
  const segs = word.split("/");
  let frontier: string[] = [""];
  let capped = false;
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i]!;
    const next: string[] = [];
    for (const prefix of frontier) {
      if (!hasGlob(seg)) { next.push(i === 0 ? seg : `${prefix}/${seg}`); continue; }
      const re = globSegmentRegExp(seg);
      // The raw join, so `link/../*` lists the directory the kernel would.
      const listed = prefix === "" && i > 0 ? "/" : prefix === "" ? "." : prefix;
      let entries: string[] = [];
      try { entries = readdirSync(isAbsolute(listed) ? listed : `${dir || "/"}/${listed}`); } catch { entries = []; }
      for (const e of entries) if (re.test(e)) next.push(i === 0 ? e : `${prefix}/${e}`);
    }
    if (next.length > GLOB_CAP) capped = true;
    frontier = next.slice(0, GLOB_CAP);
    if (frontier.length === 0) break;
  }
  return { hits: frontier, capped };
}

/** The value part of `--file=x` / `if=x`, and the word itself. */
const operandForms = (arg: string): string[] => {
  const eq = /^-{0,2}[A-Za-z][A-Za-z0-9-]*=(.+)$/s.exec(arg);
  return eq ? [arg, eq[1]!] : [arg];
};

/**
 * The real paths a Bash command reads or names, as run from `cwd` (null: relative words are not resolved).
 * Every word of every simple command, the value of `--opt=value` operands, and every redirect target is
 * substituted, brace-expanded in full, glob-matched against the directory on disk, and resolved against every
 * working directory the line may be in. Bare option words are skipped. Past a cap, or after a `cd` to an
 * unresolved place, `unresolved` is true and callers fail closed. Throws only on a walker bug.
 */
export function resolveCommandPaths(command: string, cwd: string | null): CommandPaths {
  const resolved = resolveSteps(command, cwd);
  const reasons = new Set<UnresolvedReason>(resolved.reasons);
  const paths: ResolvedPath[] = [];
  const seen = new Set<string>();
  const add = (word: string, dirs: readonly string[]) => {
    const exp = braceExpansion(word);
    if (!exp.complete) reasons.add("brace-cap");
    for (const x of exp.words) {
      if (!x) continue;
      const targets: string[] = [x];
      if (hasGlob(x)) {
        for (const d of isAbsolute(x) ? [""] : dirs) {
          const { hits, capped } = globWords(x, d);
          if (capped) reasons.add("glob-cap");
          targets.push(...hits);
        }
      }
      for (const t of targets) {
        for (const d of isAbsolute(t) ? [""] : dirs) {
          const { lexical, real, exists } = pathForms(t, d || "/");
          const key = `${lexical}\0${real}`;
          if (seen.has(key)) continue;
          if (paths.length >= PATH_CAP) { reasons.add("path-cap"); return; }
          seen.add(key);
          paths.push({ word: t, lexical, real, exists });
        }
      }
    }
  };
  for (const { step, words, cwds } of resolved.steps) {
    // Every word is taken, the program word included (`./x.sh`, `bun x.ts` both name a file).
    for (const w of words) {
      if (!w) continue;
      for (const form of operandForms(w)) {
        if (form.startsWith("-") && form.length > 1) continue;
        add(form, cwds);
      }
    }
    for (const t of step.writeTargets) {
      const w = substituteWord(t, resolved.vars);
      if (w) add(w, cwds);
    }
  }
  for (const raw of inputRedirectTargets(command)) {
    const w = substituteWord(raw, resolved.vars);
    if (w) add(w, resolved.cwds);
  }
  const all = [...reasons];
  return { ...resolved, reasons: all, paths, unresolved: all.length > 0 };
}
