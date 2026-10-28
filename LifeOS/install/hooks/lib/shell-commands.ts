/**
 * shell-commands.ts — the simple commands a Bash command line actually runs, for guards that
 * judge a PROGRAM and its arguments rather than the command text.
 *
 * A text guard refuses mentions (`rg 'cf deploy'`, a commit message saying "deploy"); the main
 * session cannot live with that. This walker tokenizes with the shell parser in lib/shell-parse.ts
 * (quotes, heredocs, substitutions, pipes) and returns one argv per simple command, with
 * leading env assignments and wrappers (sudo, env, timeout, xargs, nohup, …) peeled off. It
 * descends into code the line runs: `sh -c '…'`, `eval …`, `$(…)` and backticks, `find -exec`,
 * heredoc / here-string / echo / printf text fed to a shell, and text written to a file that the
 * same line then runs, whether a heredoc, an echo or printf, through `>`, `>>` or `tee`
 * (`cat > x.sh <<EOF … EOF; bash x.sh`, `echo … > x.sh; sh x.sh`, `printf … | tee x.sh; . x.sh`).
 * Deeper than MAX_DEPTH nested shells sets `tooDeep`, and the caller fails closed on it.
 *
 * Honest residual: code the line runs from a file it did not write (a script, a package.json
 * script, a Makefile target) is not visible here. Callers say so in their own docblocks.
 */

import { basename } from "node:path";
import { parseShell } from "./shell-parse";

export interface SimpleCommand {
  /** argv with env assignments and wrappers removed; argv[0] is the program word as written. */
  argv: string[];
  /** NAME=value assignments that prefixed the command. */
  env: Record<string, string>;
  /** Wrapper programs peeled off the front, outermost first (`xargs` means stdin supplies more args). */
  wrappers: string[];
}

export interface CommandWalk {
  commands: SimpleCommand[];
  /** The line nests shells deeper than the walker follows. */
  tooDeep: boolean;
  /** Filled by shellSteps() only: every simple command in run order, bare assignments included. */
  steps?: ShellStep[];
  /** Filled by writeView() only: text the line itself writes into files (heredoc, echo/printf, tee), per target set. */
  writes?: Array<{ targets: string[]; texts: string[] }>;
  /** Filled by writeView() only: code an interpreter runs inline (`bun -e …`, a heredoc fed to `bun -`). */
  code?: string[];
}

/** One simple command as shellSteps() reports it: a bare `X=…` statement is an empty argv with its env. */
export interface ShellStep extends SimpleCommand {
  /** Files its `>` / `>>` / `&>` redirects write (empty on a find -exec body, which has none of its own). */
  writeTargets: string[];
  /** 0 for the line itself, 1+ inside `sh -c`, `eval`, `$(…)` and the other bodies walk() descends into. */
  depth: number;
}

const MAX_DEPTH = 4;
const ENV_ASSIGN = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s;
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh", "fish"]);
const WRAPPERS = new Set([
  "sudo", "doas", "env", "time", "nohup", "command", "exec", "builtin", "nice", "timeout", "gtimeout",
  "stdbuf", "rtk", "caffeinate", "xargs", "xcrun", "arch", "script", "unbuffer", "chronic", "then", "do",
  "else", "if", "elif", "while", "until", "{", "!",
]);
/** Wrapper flags whose next word is their value, not the wrapped program. */
const WRAPPER_VALUE_FLAGS: Record<string, Set<string>> = {
  sudo: new Set(["-u", "-g", "-h", "-p", "-C", "-D", "-r", "-t", "-U", "-T"]),
  doas: new Set(["-u", "-C"]),
  env: new Set(["-u", "-C", "-P", "--unset", "--chdir"]),
  timeout: new Set(["-s", "-k", "--signal", "--kill-after"]),
  gtimeout: new Set(["-s", "-k", "--signal", "--kill-after"]),
  nice: new Set(["-n", "--adjustment"]),
  stdbuf: new Set(["-i", "-o", "-e"]),
  caffeinate: new Set(["-t", "-w"]),
  xargs: new Set(["-I", "-J", "-L", "-n", "-P", "-s", "-E", "-d", "-a", "-R", "-S", "--max-args", "--max-procs", "--delimiter", "--arg-file", "--replace"]),
  xcrun: new Set(["--sdk", "-sdk", "--toolchain", "-toolchain"]),
  arch: new Set(["-d", "-e"]),
  script: new Set(["-t", "-T", "-F"]),
};

/**
 * Lower-cased program name of a word: its last path segment, minus any `@version` suffix and a
 * script-shim extension (`node …/bin/wrangler.js`, `wrangler.cmd`), so a guard sees the CLI the
 * file is. `.ts` is kept: `bun CfEnv.ts` names the wrapper, never the provider CLI.
 */
export function programName(word: string | undefined): string {
  return basename(word ?? "").toLowerCase().replace(/@.*$/, "").replace(/\.(?:c?js|mjs|cmd)$/, "");
}

/** Peel env assignments and wrappers off the front of `ws`; `-S` scripts of `env` go to `scripts`. */
function unwrap(ws: string[], env: Record<string, string>, scripts: string[], wrappers: string[] = []): string[] {
  let k = 0;
  while (k < ws.length) {
    const w = ws[k]!;
    const assign = ENV_ASSIGN.exec(w);
    if (assign) { env[assign[1]!] = assign[2]!; k++; continue; }
    const name = programName(w);
    if (!WRAPPERS.has(name)) break;
    if (name === "command" && /^-[vV]$/.test(ws[k + 1] ?? "")) break; // `command -v x` looks x up
    wrappers.push(name);
    k++;
    const valueFlags = WRAPPER_VALUE_FLAGS[name];
    while (k < ws.length && ws[k]!.startsWith("-")) {
      const f = ws[k]!;
      k++;
      if (f === "--") break;
      if (name === "env" && (f === "-S" || f === "--split-string")) { if (ws[k] !== undefined) scripts.push(ws[k]!); k++; continue; }
      if (name === "env" && f.startsWith("--split-string=")) { scripts.push(f.slice("--split-string=".length)); continue; }
      if (valueFlags?.has(f)) k++;
    }
    if ((name === "timeout" || name === "gtimeout") && /^[0-9.]+[smhd]?$/.test(ws[k] ?? "")) k++;
    if (name === "script" && ws[k] !== undefined) k++;
  }
  return ws.slice(k);
}

type Seg = ReturnType<typeof parseShell>[number];

/** Words of a parsed simple command, and the files its `>`/`>>` redirects write. */
function wordsOf(seg: Seg): { words: string[]; writeTargets: string[] } {
  const words: string[] = [];
  const writeTargets: string[] = [];
  for (let i = 0; i < seg.toks.length; i++) {
    const t = seg.toks[i]!;
    if (t.op) {
      const target = seg.toks[i + 1];
      if (target && !target.op) {
        if (t.op === ">" || t.op === ">>") writeTargets.push(target.text);
        i++;
      }
      continue;
    }
    words.push(t.text);
  }
  return { words, writeTargets };
}

/** `find -exec … ;` bodies inside an argv, each as its own argv. */
function findExecs(argv: string[]): string[][] {
  if (programName(argv[0]) !== "find") return [];
  const out: string[][] = [];
  for (let i = 1; i < argv.length; i++) {
    if (!["-exec", "-execdir", "-ok", "-okdir"].includes(argv[i]!)) continue;
    const inner: string[] = [];
    let j = i + 1;
    for (; j < argv.length && argv[j] !== ";" && argv[j] !== "+"; j++) inner.push(argv[j]!);
    out.push(inner);
    i = j;
  }
  return out;
}

const nonFlags = (ws: string[], from: number): string[] => ws.slice(from).filter((w) => !w.startsWith("-"));

/** A shell with nothing to run but stdin: `bash`, `sh -`, `bash -s`. */
function readsStdin(argv: string[]): boolean {
  return SHELLS.has(programName(argv[0])) && nonFlags(argv, 1).every((w) => w === "-") &&
    !argv.some((w, i) => i > 0 && /^-[A-Za-z]*c[A-Za-z]*$/.test(w));
}

/** Text a simple command emits on stdout from its own words: its heredocs and here-strings, and echo/printf arguments. */
function emittedText(seg: Seg, argv: string[]): string[] {
  const out = [...seg.heredocBodies, ...seg.hereStrings];
  const p = programName(argv[0]);
  if (p === "echo" || p === "printf") {
    // printf's format and echo -e both turn `\n` into a newline; the raw form is kept too.
    const text = nonFlags(argv, 1).join(" ");
    out.push(text, text.replace(/\\n/g, "\n"));
  }
  return out;
}

function walk(cmd: string, depth: number, out: CommandWalk): void {
  if (depth > MAX_DEPTH) { out.tooDeep = true; return; }
  const segs = parseShell(cmd);
  // Files this line writes text into: a later `bash file`, `. file`, `source file` or `./file` runs that text.
  const written = new Map<string, string[]>();
  const record = (targets: string[], texts: string[]) => {
    if (!texts.length) return;
    if (targets.length) out.writes?.push({ targets, texts });
    for (const t of targets) written.set(programName(t), [...(written.get(programName(t)) ?? []), ...texts]);
  };
  const parsed: Array<{ seg: Seg; argv: string[]; env: Record<string, string>; scripts: string[]; writeTargets: string[]; wrappers: string[] }> = [];
  for (const seg of segs) {
    const { words, writeTargets } = wordsOf(seg);
    const env: Record<string, string> = {};
    const scripts: string[] = [...seg.subs];
    const wrappers: string[] = [];
    const argv = unwrap(words, env, scripts, wrappers);
    const isTee = programName(argv[0]) === "tee";
    const own = emittedText(seg, argv);
    record([...writeTargets, ...(isTee ? nonFlags(argv, 1) : [])], own);
    const prev = parsed[parsed.length - 1];
    if (isTee && prev?.seg.pipedOut) record(nonFlags(argv, 1), emittedText(prev.seg, prev.argv)); // `echo … | tee x.sh`
    parsed.push({ seg, argv, env, scripts, writeTargets, wrappers });
  }
  const fedToShell = parsed.some((p) => p.argv.length && readsStdin(p.argv));

  for (const { seg, argv, env, scripts, writeTargets, wrappers } of parsed) {
    const argvs = argv.length ? [argv, ...findExecs(argv).map((a) => unwrap(a, {}, scripts))] : [];
    if (!argv.length && out.steps) out.steps.push({ argv: [], env, writeTargets, depth, wrappers });
    for (const a of argvs) {
      if (!a.length) continue;
      const via = a === argv ? wrappers : ["find"]; // a find -exec body: find supplies its {} arguments
      out.commands.push({ argv: a, env, wrappers: via });
      out.steps?.push({ argv: a, env, writeTargets: a === argv ? writeTargets : [], depth, wrappers: via });
      const p = programName(a[0]);
      if (out.code) {
        out.code.push(...inlineCodeBodies(a));
        if (INLINE_INTERPRETERS.has(p) && a === argv) out.code.push(...seg.heredocBodies, ...seg.hereStrings);
      }
      if (SHELLS.has(p)) {
        const ci = a.findIndex((x, i) => i > 0 && /^-[A-Za-z]*c[A-Za-z]*$/.test(x));
        if (ci >= 0 && a[ci + 1] !== undefined) scripts.push(a[ci + 1]!);
        scripts.push(...seg.heredocBodies, ...seg.hereStrings);
        const file = nonFlags(a, 1)[0];
        if (ci < 0 && file) scripts.push(...(written.get(programName(file)) ?? []));
      } else if (p === "eval") {
        scripts.push(a.slice(1).join(" "));
      } else if ((p === "source" || p === ".") && a[1] !== undefined) {
        scripts.push(...(written.get(programName(a[1])) ?? [])); // `. x.sh` written earlier in this same line
      } else if (written.has(p) && a[0]!.includes("/")) {
        scripts.push(...written.get(p)!); // ./deploy-now.sh written earlier in this same line
      }
      if (fedToShell && (p === "echo" || p === "printf")) {
        const args = nonFlags(a, 1);
        scripts.push(p === "printf" ? args.slice(1).join(" ") : args.join(" "), ...args);
      }
    }
    if (fedToShell) scripts.push(...seg.heredocBodies, ...seg.hereStrings);
    for (const s of scripts) walk(s, depth + 1, out);
  }
}

/** Every simple command `cmd` runs that is visible in its text. Throws only on a parser bug. */
export function simpleCommands(cmd: string): CommandWalk {
  const out: CommandWalk = { commands: [], tooDeep: false };
  walk(cmd, 0, out);
  return out;
}

/**
 * simpleCommands plus the detail a write detector needs: bare assignments (`D=~/Downloads;`) as
 * empty-argv steps, each command's redirect targets, and its nesting depth, all in run order
 * (a nested body follows the command that runs it).
 */
export function shellSteps(cmd: string): CommandWalk & { steps: ShellStep[] } {
  const out = { commands: [] as SimpleCommand[], tooDeep: false, steps: [] as ShellStep[] };
  walk(cmd, 0, out);
  return out;
}

/**
 * shellSteps plus what a write-content guard needs: the text this line writes into each set of
 * files it can see (heredoc, here-string, echo/printf through `>`, `>>` or `tee`), and the code an
 * interpreter runs inline. Text a program computes and prints is not visible here.
 */
export function writeView(cmd: string): CommandWalk & { steps: ShellStep[]; writes: Array<{ targets: string[]; texts: string[] }>; code: string[] } {
  const out = { commands: [] as SimpleCommand[], tooDeep: false, steps: [] as ShellStep[], writes: [] as Array<{ targets: string[]; texts: string[] }>, code: [] as string[] };
  walk(cmd, 0, out);
  return out;
}

/**
 * The forms a trigger regex must test: the text as written, the text with every backslash-newline
 * line continuation removed (what the shell runs: `pu\<nl>sh` is `push`), and the same with each
 * continuation turned into a space (`git\<nl>push` reads as two words). A regex that spans one
 * line (`[^\n]*`) otherwise misses a command split over several.
 */
export function continuationForms(text: string): string[] {
  if (!/\\\r?\n/.test(text)) return [text];
  return [text, text.replace(/\\\r?\n/g, ""), text.replace(/\\\r?\n/g, " ")];
}

/**
 * `text` with each backslash-CR-LF read as a backslash-newline continuation, for a walker that a
 * guard fails closed with: bash itself reads `\<CR>` as an escaped CR, but a gate treats the
 * Windows line ending as the continuation it was most likely meant to be.
 */
export function crlfContinuations(text: string): string {
  return text.replace(/\\\r\n/g, "\\\n");
}

const INLINE_INTERPRETERS = new Set(["bun", "node", "deno", "tsx", "python", "python3", "perl", "ruby", "osascript"]);
const INLINE_CODE_FLAGS = new Set(["-e", "--eval", "-p", "--print", "-c", "-E"]);

/** Code bodies an interpreter argv runs inline: `bun -e …`, `node --eval=…`, `deno eval …`, `python -c …`. */
export function inlineCodeBodies(argv: string[]): string[] {
  if (!argv.slice(0, 3).some((w) => INLINE_INTERPRETERS.has(programName(w)))) return [];
  const bodies: string[] = [];
  for (let i = 1; i < argv.length; i++) {
    const w = argv[i]!;
    if (INLINE_CODE_FLAGS.has(w) && argv[i + 1] !== undefined) { bodies.push(argv[i + 1]!); i++; continue; }
    const eq = /^--(?:eval|print)=(.*)$/s.exec(w);
    if (eq) bodies.push(eq[1]!);
    if (w === "eval" && programName(argv[i - 1]) === "deno" && argv[i + 1] !== undefined) bodies.push(argv[i + 1]!);
  }
  return bodies;
}

const PKG_RUNNERS = new Set(["bunx", "npx", "pnpx", "bun", "pnpm", "npm", "yarn", "node", "deno", "tsx"]);
const RUNNER_VERBS = new Set(["x", "exec", "dlx", "run"]);
/** Package-runner flags whose next word is a value (`npx -p wrangler wrangler deploy`). */
const RUNNER_VALUE_FLAGS = new Set(["-p", "--package", "-c", "--call", "--cwd", "--filter", "-F", "-C", "--prefix", "-w", "--workspace"]);
/** Runner flags whose next word is inline source code, never a program (`bun -e`, `node --eval`). */
const RUNNER_INLINE_CODE_FLAGS = new Set(["-e", "--eval", "--print"]);

/**
 * The program an argv really runs, through package runners: `bunx wrangler deploy`,
 * `npx -y wrangler@3 deploy`, `bun x cf deploy`, `pnpm dlx wrangler deploy`, `npm exec -- cf deploy`,
 * `node node_modules/.bin/wrangler deploy` all resolve to the provider CLI with its own arguments.
 * `bun CfEnv.ts deploy` resolves to `cfenv.ts`, which is not a provider CLI.
 */
export function effectiveProgram(argv: string[]): { program: string; args: string[]; word: string } {
  let cur = argv;
  for (let hop = 0; hop < 4; hop++) {
    const p = programName(cur[0]);
    if (!PKG_RUNNERS.has(p)) return { program: p, args: cur.slice(1), word: cur[0] ?? "" };
    let i = 1;
    for (; i < cur.length; i++) {
      const w = cur[i]!;
      if (w === "--") { i++; break; }
      // Inline code (`bun -e '<script>'`) is not a program word; the runner itself is what runs.
      if (RUNNER_INLINE_CODE_FLAGS.has(w)) return { program: p, args: cur.slice(1), word: cur[0] ?? "" };
      if (RUNNER_VALUE_FLAGS.has(w)) { i++; continue; }
      if (w.startsWith("-")) continue;
      if (RUNNER_VERBS.has(w.toLowerCase())) continue;
      break;
    }
    if (i >= cur.length) return { program: p, args: cur.slice(1), word: cur[0] ?? "" };
    cur = cur.slice(i);
  }
  return { program: programName(cur[0]), args: cur.slice(1), word: cur[0] ?? "" };
}
