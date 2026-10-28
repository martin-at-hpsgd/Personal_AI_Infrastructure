#!/usr/bin/env bun
/**
 * @version 2.6.4
 * 2.6.2 (2026-10-15, security P1 batch 2 closing pass, S041/S042): parity with the live hook on the reviewed
 * inputs. A pointer must also equal the version line of the deploy that finished last in the session,
 * whichever project it belongs to, as the live hook required, so a newer deploy (a bare one, or another
 * project's) holds an older pointer stale; the per-project rule can only add blocks on top of that. A deploy
 * call's version lines are read from its answered result even when the call as a whole failed
 * (a later step of the call exited non-zero): the step printed its version, so it shipped and owes the reconcile. A transcript
 * that records no timestamps credits a parsed shell write as the live hook did (ISAFoldGate changedDuring).
 * 2.6.1 (2026-10-15, security P1 batch 2 final round 2, S041/S042/S043): nothing here is looser than the
 * live hook. When the strict transcript read fails (a malformed line), the check runs once more over the
 * readable lines and a block it finds is returned; anything else is still deferred. A pointer whose
 * deploy is undecided is held to the last version line its newest deploy call printed, as the live hook
 * held it to the session's last line, so a printed or extra version line can defer a matching pointer but
 * never clear an older one. The value of a provider CLI's value-taking global flag (`--env <word>`) is
 * not a deploy subcommand. deployedIsaPaths also reads the live hook's raw transcript form. The
 * shell-write reader moved to ISAFoldGate (one rule for both gates) and is re-exported here.
 * 2.6.0 (2026-10-15, security P1 batch 2 final round, S041/S042): every deploy step carries the
 * versions it may have produced and whether that is decided. A call's lines are paired with its steps
 * only when the counts match and the command does not itself spell a version line; a step after a
 * `cd` whose scope the resolver cannot follow (an unresolved target, a subshell) has an undecided
 * owner. Nothing undecided throws any more: definite obligations (check 2, a pointer that matches no
 * possible version) still block, a pointer that matches an undecided version defers, and a version
 * line from a program the parser cannot classify (`npm run release`, `rg --pre`) is a possible
 * version of the directories its call ran in, so it can block a pointer but never clear one. A shell
 * write is credited only when the ISA's mtime falls between the call's timestamp and its result's.
 * 2.5.0 (2026-10-15, security P1 batch 2 fix round 2, S041/S042): a deploy is judged on the words
 * the shell would run, as the shared resolver substitutes them (`D=deploy; cf $D`, `cf de""ploy`,
 * `cf de{ploy,}`), and a provider CLI's deploy subcommand is found among all its positional words, so
 * a global flag's value (`--config x --env production deploy`) cannot hide it. The only text check left
 * in front of the parser is a sound cost guard (a call with no version line and no way to spell
 * "deploy" is skipped). Versions follow the order deploy results arrived, not the order calls were made.
 * A deploy step belongs to the directory its latest `cd` entered (the resolver's cwd list is every
 * directory the step may run in, which after `cd /a && … && cd /b` still holds /a), and a call that
 * deploys several projects gives each step its own version line in order. When the lines cannot be
 * attributed (the counts differ, a `cd` went somewhere unknown, or shells nest past the parser) the
 * check is deferred, never guessed, and a step that could deploy but cannot be read counts as one. A
 * version line printed by a program the parser cannot classify (`npm run release`, inline code) can
 * never clear a pointer, and turns a pass into a deferral instead of vanishing. A shell command that
 * targets an ISA counts as rewriting it only when the file really changed: its mtime is at or after
 * that call (a no-clobber copy, a zero-byte dd, or inline code that merely names the ISA beside some
 * other write leaves the file as it was).
 * 2.4.0 (2026-10-15, security P1 batch 2 S041/S042/S043): deploy evidence is the result of a
 * successful Bash call whose command really runs a deploy, as the shared shell parser reads it
 * (shell-commands effectiveProgram, shell-paths resolveSteps), never assistant prose, a tool call's
 * input, or another command's output that quotes a version line. Each version belongs to the
 * project ISAs in the directories its deploy ran from, and an ISA's pointer is held to its own
 * project's last deploy (the session's last deploy only when no deploy names its directory). An ISA
 * counts as rewritten only through a successful Edit/Write/MultiEdit or a shell command whose write
 * targets, read by the shared parser, name it (shellWrittenIsas), so staging, committing or
 * redirecting some other file never does. A transcript that cannot be read, a malformed
 * line anywhere in it, or any error in the check goes through runGate("advise") and returns an
 * explicit `deferred` status naming the unchecked deploy obligation instead of passing.
 * 2.3.0 (2026-10-14): an ISA counts as written only through a successful,
 * result-paired Edit/Write/MultiEdit or shell write call, and written and deployed ISAs compare
 * by real path. A Read's file_path, a failed edit, or a call with no result no longer counts.
 * IsaDeployMarkerGate.hook.ts — ISA deploy-freshness teeth (two checks).
 *
 * CHECK 1 — stale pointer (v1.0.0, 2026-08-17, rl-redesign session 5):
 * ISAFoldGate keys on "ISA untouched", so a session that edits
 * the ISA early and keeps deploying afterward passes both gates while the
 * ISA's own `Latest deploy:` pointer goes stale. IF the session deployed
 * ("Current Version ID: <uuid>" in a successful deploy's result) AND an ISA written this session
 * carries a `Latest deploy: <hex>` marker, the marker must equal the version-id prefix of the last
 * deploy from that ISA's directory. Mismatch blocks ONCE per session+ISA.
 *
 * CHECK 2 — deploy with no ISA write at all (v2.0.0, 2026-08-18, production app
 * incident): every prior tooth conditioned on something that only
 * exists once the session already engaged the ISA — it needed a
 * bound run in work.json, check 1 needs an ISA written this session, the
 * nudge layer is advisory. A session that deploys a repo WITH an ISA while
 * never touching that ISA was invisible to all of them, which is exactly how
 * four deploys shipped with zero record. Now: IF the session
 * deployed successfully AND a deploy command's directory contains ISA.md
 * AND that ISA was never written this session AND the final message
 * does not honestly address ISA state (ISA_ADDRESSED_RE), block ONCE per
 * session+ISA with the reconcile instruction. The record leg is part of the
 * deploy, not an optional epilogue. Every directory a deploy step may have run in counts here.
 *
 * SHELL WRITES COUNT (v2.1.0, after a false fire on a Bash-written ISA): an ISA reconciled
 * through Bash — a heredoc, `sed -i`, `cat > ISA.md` — counts as written for both
 * checks. Since 2.4.0 the write targets come from the shared parser: a redirect,
 * tee, in-place sed/perl, a cp/mv destination, or a write call in inline code.
 * Read-only commands, `git add` and `git commit` write no ISA (S042). Since 2.5.0 the
 * parser only names candidates: the file's mtime has to show the write landed.
 *
 * Honest residuals: a deploy call's other programs can still print a version line the text does not
 * spell (`cat deploy.log`, a phrase assembled through expansions), which is then read as the deploy's;
 * in a call with a readable deploy step its other programs are taken not to deploy; a `cd` inside
 * a pipeline element (which bash runs in a subshell) is read as persisting, since the shared resolver
 * (shell-paths) does not model shell scope; and another process rewriting the ISA while a no-op shell
 * command that names it runs makes that command look like the write.
 *
 * Kill switch: ISADEPLOYMARKERGATE_OFF=1.
 * Deterministic, advise (an error is a Vigil hook-error plus a `deferred` status), standalone-runnable:
 *   bun IsaDeployMarkerGate.hook.ts < hook-input.json
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { basename, isAbsolute, join, resolve } from "path";
import { readHookInput, parseTranscriptFromInput } from "./lib/hook-io";
import { ISA_ADDRESSED_RE } from "./lib/isa-turn";
import { lifeosPath } from "./lib/paths"; // public issue #1974 @sabo961, PR #1918 @PigLardLord
import { runGate } from "./lib/gate-run";
import { effectiveProgram, inlineCodeBodies, programName, writeView } from "./lib/shell-commands";
import {
  braceExpansion, pathForms, realPathOf, resolveCommandPaths, resolveSteps,
  type ResolvedStep, type ResolvedSteps,
} from "./lib/shell-paths";
import { invariant } from "../LIFEOS/TOOLS/Invariant";
import { changedDuring, shellWrittenIsas, transcriptToolCalls, type ToolCall } from "./ISAFoldGate.hook";

export { shellWrittenIsas };

const STATE_DIR = lifeosPath("MEMORY", "STATE");
const STATE_PATH = join(STATE_DIR, "isa-deploy-marker-gate.json");

// Deploy success line. The cf CLI (Wrangler replaced 2026-09-29) prints the identical
// `Current Version ID: <uuid>` line — its deployWorker path carries Wrangler's logger
// (verified in the cf 1.0.0-beta.5 dist). Read only from a deploy call's successful result (S041).
const VERSION_RE = /Current Version ID: ([0-9a-f]{8})-[0-9a-f]{4}/gi;
// Tools whose successful call rewrites the file named by its file_path.
const FILE_WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit"]);
const MARKER_RE = /Latest deploy: ([0-9a-f]{6,12})\b/i;
const ISA_FILE_RE = /(?:^|\/)ISA\.md$/;
/** A command that spells a version line itself (`printf 'Current Version ID: …'`) can print it beside a deploy's. */
const SPELLED_VERSION_RE = /current\s*version\s*id/gi;
/** Programs that print input lines matching a pattern, never the pattern itself. */
const SEARCHERS: ReadonlySet<string> = new Set(["grep", "egrep", "fgrep", "rg"]);
/** The directory-changing builtins, the same three the shared resolver follows (shell-paths CD_PROGRAMS, not exported). */
const CD_PROGRAMS: ReadonlySet<string> = new Set(["cd", "pushd", "chdir"]);
/**
 * Programs that only print, filter or move between directories and cannot start another program, so a
 * version line in their output is quoted text (`printf 'Current Version ID: …'`). Deliberately small:
 * every program not listed (sed and awk included, which can execute) is one that might have deployed.
 */
const PURE_OUTPUT: ReadonlySet<string> = new Set([
  "echo", "printf", "cat", "head", "tail", "rg", "grep", "egrep", "fgrep", "jq", "sort", "uniq", "wc", "cut",
  "tr", "tee", "true", "ls", "pwd", "cd", "pushd", "popd", "chdir",
]);
/** PURE_OUTPUT programs that an option can make run another program: `rg --pre <cmd>`, `rg --hostname-bin`,
 *  `rg` through a config file, GNU `sort --compress-program` (any unambiguous prefix). */
const EXEC_CAPABLE: ReadonlySet<string> = new Set(["rg", "sort"]);
const EXEC_OPTION = /^--(?:pre|hostname|comp|pager)/i;

// What a deploy is, judged per simple command on the parsed argv. A provider CLI (wrangler, cf, or
// CfEnv.ts forwarding to cf) with a deploy subcommand anywhere among its positional words (`deploy`,
// `pages deploy`, `versions deploy`, `workers triggers deploy`, `--env production deploy`) or
// `deployments create`, or a program or script named for a deploy (`bun run deploy`,
// `npm run deploy:prod`, `bash deploy.sh`, `make -C app deploy`).
const PROVIDER_CLIS = new Set(["wrangler", "cf", "cfenv.ts"]);
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);
const TASK_RUNNERS = new Set(["make", "just", "task"]);
const DEPLOY_WORD = /(?:^|[-_.:/])deploy(?:[-_.:]|$)/i;
/**
 * Global flags of the provider CLIs that always take the next word as their value (wrangler's --config,
 * --env, --cwd, --env-file and their short forms). That word is the flag's value, never a subcommand:
 * `cf --env deploy workers list` lists workers. Deliberately only these: after a flag not listed the next
 * word stays positional, the reading that finds more deploys.
 */
const VALUE_FLAGS: ReadonlySet<string> = new Set(["--config", "-c", "--env", "-e", "--cwd", "--env-file"]);

/**
 * Does this simple command (an argv) run a deploy? A provider CLI's global flags may take a value
 * (`--config wrangler.jsonc`, `--env production`) that sits between the CLI and its subcommand, and
 * which flags take one is the CLI's business, so every positional word is read: that can only find
 * more deploys, never fewer (S041).
 */
export function isDeployArgv(argv: string[]): boolean {
  const { program, args } = effectiveProgram(argv);
  const pos = args.filter((a) => !a.startsWith("-")).map((a) => a.toLowerCase());
  if (PROVIDER_CLIS.has(program)) {
    // Positional words, less the value of a value-taking global flag (`--env <word>`).
    const sub = args
      .filter((a, i) => !a.startsWith("-") && !(i > 0 && VALUE_FLAGS.has(args[i - 1]!.toLowerCase())))
      .map((a) => a.toLowerCase());
    return sub.includes("deploy") || sub.some((w, i) => w === "deployments" && sub[i + 1] === "create");
  }
  if (TASK_RUNNERS.has(program) || SHELLS.has(program)) return pos.some((p) => DEPLOY_WORD.test(basename(p)));
  return DEPLOY_WORD.test(program);
}

/**
 * No simple command in `command` can spell a deploy: it holds no expansion (`$`, a backtick, a brace
 * or a glob character) and no "deploy" once quotes, backslashes and line continuations are removed.
 * Sound for isDeployArgv, so a call that printed no version line skips the parser. A cost guard only:
 * a call that printed a version line is always parsed.
 */
function cannotSpellDeploy(command: string): boolean {
  if (/[$`{*?[]/.test(command)) return false;
  return !/deploy/i.test(command.replace(/\\\r?\n/g, "").replace(/["'\\]/g, ""));
}

/** The step's words as the shell would run them: substituted where the resolver knows the value, as written where it does not. */
function runWords(s: ResolvedStep): string[] {
  return s.words.map((w, k) => w ?? s.step.argv[k] ?? "");
}

/** runWords with each word's brace alternatives as separate words, as bash expands them (`de{ploy,}` → `deploy de`). */
function shellWords(s: ResolvedStep): string[] {
  return runWords(s).flatMap((w) => {
    const e = braceExpansion(w);
    return e.words.length ? e.words : [w];
  });
}

/** A step whose program, or the argv of a CLI that can deploy, holds an expansion the resolver could not read. */
function unreadableDeployer(s: ResolvedStep): boolean {
  if (!s.words.some((w) => w === null)) return false;
  if (s.words[0] === null) return true;
  const { program } = effectiveProgram(runWords(s));
  return PROVIDER_CLIS.has(program) || TASK_RUNNERS.has(program) || SHELLS.has(program);
}

/** The step only prints or filters text (or only assigns a variable): its output is never a deploy's. */
function pureOutput(s: ResolvedStep): boolean {
  if (!s.step.argv.length) return true;
  const ws = runWords(s);
  const { program, args } = effectiveProgram(ws);
  if (!PURE_OUTPUT.has(program) || inlineCodeBodies(ws).length) return false;
  // An option that runs a program, a word the resolver cannot read (it may be one), or an env prefix
  // (RIPGREP_CONFIG_PATH) makes an otherwise pure program one that might have deployed.
  if (EXEC_CAPABLE.has(program) && (args.some((a) => EXEC_OPTION.test(a)) || s.words.includes(null) || Object.keys(s.step.env).length)) return false;
  return true;
}

const isCdStep = (s: ResolvedStep): boolean => {
  const head = s.words[0];
  return head !== null && head !== undefined && CD_PROGRAMS.has(programName(head));
};

/**
 * The line opens a plain subshell: an unquoted `(` that is not `$(`, `$((`, `<(` or `>(`. A `cd` inside
 * one ends with it, which the resolver's growing cwd list does not model (substitutions are seen as
 * steps nested deeper, so deployOf checks those by depth).
 */
function opensSubshell(command: string): boolean {
  let q: string | null = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (q === "'") { if (c === "'") q = null; continue; }
    if (c === "\\") { i++; continue; }
    if (q === "\"") { if (c === "\"") q = null; continue; }
    if (c === "'" || c === "\"") { q = c; continue; }
    if (c === "(" && !"$<>(".includes(command[i - 1] ?? "")) return true;
  }
  return false;
}

/**
 * The directories the latest `cd` before step `i` entered: what that cd added to the resolver's cwd
 * list. [] when no cd precedes the step (it runs where the line started). null when a cd precedes it
 * but added nothing (its target was unresolved, or already in the list), so which directory the step
 * ran in is not known from the text.
 */
function latestCdDirs(rs: ResolvedSteps, i: number): string[] | null {
  for (let j = i - 1; j >= 0; j--) {
    const head = rs.steps[j]!.words[0];
    if (head === null || head === undefined || !CD_PROGRAMS.has(programName(head))) continue;
    const before = new Set(rs.steps[j]!.cwds);
    const added = rs.steps[j + 1]!.cwds.filter((d) => !before.has(d));
    return added.length ? added : null;
  }
  return [];
}

const realOf = (p: string): string => realPathOf(isAbsolute(p) ? p : resolve(p)).real;

/** The ISA.md files in `dirs`, keyed by real path, valued by the spelling the command used. */
function isasIn(dirs: Iterable<string>): Map<string, string> {
  const out = new Map<string, string>();
  for (const d of dirs) {
    const isa = join(d, "ISA.md");
    if (!existsSync(isa)) continue;
    const r = realOf(isa);
    if (!out.has(r)) out.set(r, isa);
  }
  return out;
}

/** One deploy step of a command. */
export interface DeployStep {
  /** ISAs of every directory the step may have run in (the resolver's may-set): who owes a reconcile. */
  isas: Map<string, string>;
  /** ISAs of the directory its latest cd entered: whose deploy it is, for version attribution. */
  owner: Map<string, string>;
  /** A cd before the step went somewhere the text does not say, or the line has a cd whose scope ends
   *  early (a subshell, a substitution); `owner` is then the whole may-set and its version is never decided. */
  ambiguous: boolean;
}

export interface DeployRead {
  /** "deploy": a step certainly deploys. "maybe": none certainly does, but a step with an unreadable
   *  program or CLI argument could. "unknown": shells nest past the walker. "none": no deploy. */
  kind: "deploy" | "maybe" | "none" | "unknown";
  /** Every ISA.md in a directory a certain deploy step may have run in (real path → the spelling the command used). */
  isas: Map<string, string>;
  /** The certain deploy steps, in run order. */
  steps: DeployStep[];
  /** Every certain or possible deploy step, in run order; what sessionDeploys uses when the call printed a version. */
  withMaybe: DeployStep[];
  /** Shells nested deeper than the walker follows: a deploy step may be missing from both lists. */
  tooDeep: boolean;
  /** Every step only prints or filters text and no interpreter reads code from a heredoc. */
  pureOutput: boolean;
  /** The line itself spells a version line somewhere other than a grep/rg pattern, so it can print one beside a deploy's. */
  spelled: boolean;
}

/** Version phrases in `text` once quotes, backslashes and line continuations are removed. */
const spelledCount = (text: string): number =>
  text.replace(/\\\r?\n/g, "").replace(/["'\\]/g, "").match(SPELLED_VERSION_RE)?.length ?? 0;

/** `command` spells a version line outside the patterns its grep/rg steps search for (a deploy piped through `rg "Current Version ID"` does not). */
function spellsVersion(command: string, plain: ResolvedSteps): boolean {
  const total = spelledCount(command);
  if (!total) return false;
  let patterns = 0;
  for (const s of plain.steps) {
    if (!SEARCHERS.has(effectiveProgram(runWords(s)).program)) continue;
    for (const w of s.step.argv) patterns += spelledCount(w);
  }
  return total > patterns;
}

/**
 * Whether `command` runs a deploy, and the ISA.md files in the directories its deploy steps ran
 * from. Directories come from the shared resolver: an absolute or `~` cd as written, and a relative
 * cd against `startCwd` (the starting directory itself is not a deploy directory: the shell's cwd at
 * that call is unknown).
 */
export function deployOf(command: string, startCwd: string | null): DeployRead {
  const isas = new Map<string, string>();
  const steps: DeployStep[] = [];
  const withMaybe: DeployStep[] = [];
  const plain = resolveSteps(command, null);
  const marks: Array<{ i: number; sure: boolean }> = [];
  plain.steps.forEach((s, i) => {
    if (isDeployArgv(s.step.argv) || isDeployArgv(shellWords(s))) marks.push({ i, sure: true });
    else if (unreadableDeployer(s)) marks.push({ i, sure: false });
  });
  const fromStart = marks.length && startCwd ? resolveSteps(command, startCwd) : null;
  const startForms = new Set<string>();
  if (startCwd) { const f = pathForms(startCwd, "/"); startForms.add(f.lexical); startForms.add(f.real); }
  const notStart = (ds: readonly string[]) => ds.filter((d) => !startForms.has(d));
  // A cd whose scope ends before the line does (inside a subshell or a substitution) leaves every later
  // step's directory undecided among those the line reached.
  const subshell = opensSubshell(command);
  const scoped = plain.steps.some((s) => isCdStep(s) && (s.step.depth > 0 || subshell));
  for (const { i, sure } of marks) {
    const may = new Set([...plain.steps[i]!.cwds, ...notStart(fromStart?.steps[i]?.cwds ?? [])]);
    const fromPlain = latestCdDirs(plain, i);
    const fromStarted = fromStart ? latestCdDirs(fromStart, i) : null;
    const ambiguous = scoped || (fromPlain === null && fromStarted === null);
    const ownerDirs = ambiguous ? may : new Set([...(fromPlain ?? []), ...notStart(fromStarted ?? [])]);
    const step: DeployStep = { isas: isasIn(may), owner: isasIn(ownerDirs), ambiguous };
    withMaybe.push(step);
    if (!sure) continue;
    steps.push(step);
    for (const [r, spelled] of step.isas) if (!isas.has(r)) isas.set(r, spelled);
  }
  const kind = steps.length ? "deploy" : withMaybe.length ? "maybe" : plain.tooDeep ? "unknown" : "none";
  const pure = !plain.tooDeep && plain.steps.every(pureOutput) && writeView(command).code.length === 0;
  return { kind, isas, steps, withMaybe, tooDeep: plain.tooDeep, pureOutput: pure, spelled: spellsVersion(command, plain) };
}

/** A JSON `"command": "…"` field in raw transcript text, the form the live hook's deployedIsaPaths read. */
const COMMAND_FIELD_RE = /"command"\s*:\s*("(?:[^"\\]|\\.)*")/g;

/**
 * ISA.md files in the directories `command`'s deploy steps may have run in (the spelling the command
 * used). Given raw transcript text holding JSON `"command"` fields instead (the live hook's input), each
 * command is read the same way and the sets are joined.
 */
export function deployedIsaPaths(command: string, startCwd: string | null = null): Set<string> {
  const fields = [...command.matchAll(COMMAND_FIELD_RE)].flatMap((m) => {
    try { const v = JSON.parse(m[1]!); return typeof v === "string" ? [v] : []; } catch { return []; }
  });
  const out = new Set<string>();
  for (const c of fields.length ? fields : [command]) for (const p of deployOf(c, startCwd).isas.values()) out.add(p);
  return out;
}

/** What one deploy step's version is, as far as its call's output shows. */
export interface Attribution {
  /** The versions the step may have produced: its own line when paired, every distinct line of its call when not; [] when the call printed none. */
  versions: string[];
  /** Exactly one version and a known directory: the step's version is decided. */
  certain: boolean;
  /** The step's own line when paired, else the last version line its call printed; null when it printed none.
   *  What an undecided pointer is held to, as the live hook held every pointer to the last line it saw. */
  last: string | null;
}

/**
 * The versions each deploy step of one call may have produced. Step k is paired with version line k
 * only when the counts match and the command does not itself spell a version line (a printf or echo
 * of one beside a real deploy). Otherwise every step may have produced any of the call's lines; that
 * is decided only for one project whose lines all agree and number at least its steps. A step whose
 * directory is undecided (an unresolved or scoped cd) is never decided (S041).
 */
export function attributeVersions(steps: DeployStep[], versions: string[], spelled = false): Attribution[] {
  if (!versions.length) return steps.map(() => ({ versions: [], certain: false, last: null }));
  if (!spelled && versions.length === steps.length) {
    return steps.map((s, k) => ({ versions: [versions[k]!], certain: !s.ambiguous, last: versions[k]! }));
  }
  const distinct = [...new Set(versions)];
  const last = versions[versions.length - 1]!;
  const oneProject = new Set(steps.map((s) => [...s.owner.keys()].sort().join("\n"))).size <= 1;
  const decided = !spelled && oneProject && distinct.length === 1 && versions.length >= steps.length;
  return steps.map((s) => ({ versions: distinct, certain: decided && !s.ambiguous, last }));
}

export interface Deploy extends DeployStep, Attribution {
  order: [number, number];
  /** A call whose version lines no readable deploy explains (`npm run release`, `rg --pre`): its lines
   *  are possible versions of the directories it ran in. It owes no reconcile. */
  unattributed: boolean;
}

export interface SessionDeploys {
  /** Every deploy step, and every unattributed versioned call, ordered by when its call's result arrived. */
  deploys: Deploy[];
  /** Calls whose version lines could not be tied to a readable deploy step: the check can then only block or defer, never pass. */
  unattributed: number;
}

/** Every directory a line may run in (its own cds), the call's unknown starting directory left out. */
function lineDirs(command: string, startCwd: string | null): string[] {
  const dirs = new Set(resolveSteps(command, null).cwds);
  if (startCwd) {
    const f = pathForms(startCwd, "/");
    for (const d of resolveSteps(command, startCwd).cwds) if (d !== f.lexical && d !== f.real) dirs.add(d);
  }
  return [...dirs];
}

/**
 * Every deploy step this session ran, ordered by when its call's result arrived (parallel calls can
 * finish out of order; the deploy that finished last is the live one). Its ISAs come from the command
 * whatever the result (check 2 counted every deploy command before 2.4.0 and still does); its versions
 * from its answered result, attributed per step. A failed result counts too: a deploy that printed its
 * version before a later step of the call failed still shipped (closing-pass parity). When a call printed a version, a step
 * that could deploy but cannot be read (`cf $(…)`, an unset `$TOOL deploy`) counts as a deploy step, the
 * stricter reading. A version line from pure output is quoted text and ignored. A line no readable step
 * explains (or one from shells nested past the walker) is an undecided version, which can block a pointer
 * or defer the gate, never clear it. Nothing here throws on undecided attribution, so one undecided call
 * never cancels another call's obligation.
 */
export function sessionDeploys(calls: ToolCall[], startCwd: string | null): SessionDeploys {
  const deploys: Deploy[] = [];
  let unattributed = 0;
  for (const c of calls) {
    if (c.sidechain || c.name !== "Bash" || typeof c.input.command !== "string") continue;
    const command = c.input.command;
    const versions = c.answered ? [...c.resultText.matchAll(VERSION_RE)].map((m) => m[1]!.toLowerCase()) : [];
    if (!versions.length && cannotSpellDeploy(command)) continue;
    const d = deployOf(command, startCwd);
    const steps = versions.length ? d.withMaybe : d.steps;
    const order0 = c.answered ? c.resultOrder : -1;
    if (versions.length && (d.tooDeep || !steps.length)) {
      if (!steps.length && d.pureOutput) continue; // quoted text
      unattributed++;
      const distinct = [...new Set(versions)];
      const last = versions[versions.length - 1]!;
      if (!steps.length) {
        const own = isasIn(lineDirs(command, startCwd));
        deploys.push({ isas: own, owner: own, ambiguous: true, versions: distinct, certain: false, last, unattributed: true, order: [order0, 0] });
      } else {
        // Nested past the walker: a deploy step may be missing, so none of the found ones is decided.
        steps.forEach((s, k) => deploys.push({ ...s, versions: distinct, certain: false, last, unattributed: false, order: [order0, k] }));
      }
      continue;
    }
    if (!steps.length) continue;
    const assigned = attributeVersions(steps, versions, d.spelled);
    steps.forEach((s, k) => deploys.push({ ...s, ...assigned[k]!, unattributed: false, order: [order0, k] }));
  }
  deploys.sort((a, b) => a.order[0] - b.order[0] || a.order[1] - b.order[1]);
  return { deploys, unattributed };
}

/**
 * What an ISA's pointer must say: one decided version, or a set of possible ones plus the last version
 * line the newest entry's call printed (the live hook's rule: a pointer equals the last line it saw).
 */
export type Expectation = { exact: string } | { possible: Set<string>; newest: string | null };

/**
 * A pointer names a deploy when it and the deploy's version are the same hash at whichever length each was written:
 * the pointer is 6–12 hex characters (MARKER_RE), the extracted version exactly 8, so one must prefix the other.
 */
export function samePointer(pointer: string, version: string): boolean {
  const a = pointer.toLowerCase();
  const b = version.toLowerCase();
  return a.startsWith(b) || b.startsWith(a);
}

/**
 * The version an ISA's pointer is held to (S041): walk this session's versioned entries newest first,
 * first those the ISA's directory owns (their latest cd entered it), then those that may have run
 * there, then every entry (an ISA no deploy names is held to the session's last deploy). The newest
 * entry decides when it is certain; otherwise every version up to the first certain entry is possible,
 * and the pointer must still equal the newest entry's last printed line, so an extra or printed version
 * line can only defer a pointer that matches it, never clear one that does not.
 */
export function expectationFor(isa: string, deploys: Deploy[]): Expectation | null {
  const newestFirst = [...deploys].reverse();
  const tiers: Array<(d: Deploy) => boolean> = [(d) => d.owner.has(isa), (d) => d.isas.has(isa), () => true];
  let first: Deploy | null = null;
  const possible = new Set<string>();
  const undecided = (): Expectation => ({ possible, newest: first?.last ?? null });
  for (const inTier of tiers) {
    for (const d of newestFirst) {
      if (!d.versions.length || !inTier(d)) continue;
      if (!first) {
        first = d;
        if (d.certain) return { exact: d.versions[0]! };
      }
      for (const v of d.versions) possible.add(v);
      if (d.certain) return undecided();
    }
  }
  return first ? undecided() : null;
}

/**
 * How this session's successful, non-sidechain calls touched ISAs, by real path.
 *   written: a successful Edit/Write/MultiEdit on an ISA.md, or a Bash command whose parsed write
 *     targets name it (shellWrittenIsas) when the file changed while that call ran. Only this
 *     clears check 2.
 *   named: every ISA.md a successful Bash command names, resolved through the shared resolver (reads
 *     included). It never clears anything; it only widens check 1 for deployed ISAs (see evaluate).
 *   unparsed: a command naming an ISA that the shared parser could not read. It counts as no write
 *     (check 2 asks) and as naming every deployed ISA (check 1 widens): the stricter reading of both.
 * Failed or unanswered calls never count.
 */
export function isaTouches(calls: ToolCall[]): { written: Set<string>; named: Set<string>; unparsed: boolean } {
  const written = new Set<string>();
  const named = new Set<string>();
  let unparsed = false;
  for (const c of calls) {
    if (!c.ok || c.sidechain) continue;
    if (FILE_WRITE_TOOLS.has(c.name)) {
      const fp = c.input.file_path;
      if (typeof fp === "string" && ISA_FILE_RE.test(fp)) written.add(realOf(fp));
      continue;
    }
    if (c.name !== "Bash" || typeof c.input.command !== "string" || !/ISA\.md/.test(c.input.command)) continue;
    const command = c.input.command;
    let wrote: Set<string>;
    let paths: Array<{ lexical: string; real: string }>;
    try {
      wrote = shellWrittenIsas(command);
      paths = resolveCommandPaths(command, null).paths;
    } catch {
      unparsed = true;
      continue;
    }
    for (const r of wrote) if (changedDuring(r, c.ts, c.resultTs)) written.add(r);
    for (const p of paths) if (ISA_FILE_RE.test(p.real) || ISA_FILE_RE.test(p.lexical)) named.add(p.real);
  }
  return { written, named, unparsed };
}

/** Real paths of the ISAs this session rewrote (isaTouches().written). */
export function writtenIsas(calls: ToolCall[]): Set<string> {
  return isaTouches(calls).written;
}

function firedSet(): Set<string> {
  try {
    return new Set(JSON.parse(readFileSync(STATE_PATH, "utf-8")) as string[]);
  } catch {
    return new Set();
  }
}
function recordFired(fp: string): void {
  invariant(typeof fp === "string" && fp.length > 0 && fp.includes(":"), "a fired key names a session and an ISA");
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    const s = firedSet();
    s.add(fp);
    writeFileSync(STATE_PATH, JSON.stringify([...s]));
  } catch {}
}

type GateInput = NonNullable<Awaited<ReturnType<typeof readHookInput>>>;

/**
 * The gate. It is advise: when the check cannot run (an unreadable or malformed transcript, versions
 * that cannot be attributed, any throw), runGate records one Vigil hook-error and one stderr line, and
 * the gate returns an explicit `deferred` status naming the unchecked deploy obligation, never a
 * silent clearance (S043).
 */
export async function run(input: GateInput): Promise<object | null> {
  if (process.env.ISADEPLOYMARKERGATE_OFF === "1") return null;
  const r = await runGate("advise", "IsaDeployMarkerGate", () => evaluate(input, false));
  if (r.status === "ok") return r.value;
  // The strict check could not run (a malformed line, say). A violation the readable lines still show
  // is blocked as the live hook blocked it; anything short of a block stays deferred, never a pass.
  try {
    const v = await evaluate(input, true);
    if (v && (v as { decision?: unknown }).decision === "block") return v;
  } catch { /* the deferral below stands */ }
  return {
    decision: "deferred",
    message:
      `IsaDeployMarkerGate could not check this session's deploys (${r.reason}). If this session deployed, ` +
      `the deployed repo's ISA reconcile and its Latest deploy pointer are unchecked: confirm both before calling the deploy done.`,
  };
}

/**
 * One evaluation. Strict: the whole session, every line a valid entry, so a torn or unreadable
 * transcript is unknown (S043). Lenient (run's second look after a strict failure): malformed lines are
 * skipped, and only a block it returns is used.
 */
async function evaluate(input: GateInput, lenient: boolean): Promise<object | null> {
  const t = await parseTranscriptFromInput(input);
  const read = transcriptToolCalls((input as { transcript_path?: unknown }).transcript_path, "session", { lenient });
  if (!read.ok) throw new Error(read.reason);
  const cwd = (input as { cwd?: unknown }).cwd;
  const startCwd = typeof cwd === "string" && cwd ? cwd : process.cwd();

  const { deploys, unattributed } = sessionDeploys(read.calls, startCwd);
  // ISAs whose pointer matched only an undecided version: a pass is then a deferral.
  const undecided: string[] = [];
  const pass = (): null => {
    if (unattributed || undecided.length) {
      throw new Error([
        unattributed ? `${unattributed} call(s) printed a deploy version line that no readable deploy explains` : "",
        undecided.length ? `which deploy set the pointer of ${undecided.join(", ")} cannot be decided` : "",
      ].filter(Boolean).join("; "));
    }
    return null;
  };
  if (!deploys.some((d) => d.versions.length)) return pass();

  const { written, named, unparsed } = isaTouches(read.calls);
  const sid = (input as { session_id?: string }).session_id ?? "s";
  const deployed = new Map<string, string>();
  for (const d of deploys) {
    if (d.unattributed) continue;
    for (const [r, spelled] of d.isas) if (!deployed.has(r)) deployed.set(r, spelled);
  }

  // CHECK 2: deployed a repo that HAS an ISA, never wrote it, never addressed it.
  if (!ISA_ADDRESSED_RE.test(t.lastMessage || "")) {
    for (const [r, isa] of deployed) {
      if (written.has(r)) continue; // written this session — check 1's territory
      const fp = `${sid}:nowrite:${r}`;
      if (firedSet().has(fp)) continue;
      recordFired(fp);
      return {
        decision: "block",
        reason:
          `LifeOS: DEPLOY WITHOUT ISA RECONCILE. This session deployed from a repo whose ` +
          `system-of-record ${isa} was never updated. The record leg is part of the deploy, not an epilogue: ` +
          `fold what shipped into the ISA (Features criteria with evidence, Decisions/Learning if any, ` +
          `frontmatter progress + updated), update the project changelog if one exists, commit, then restate — ` +
          `or state honestly in the response why no ISA delta is needed. Fires once per ISA per session.`,
      };
    }
  }

  // CHECK 1: an ISA written this session is held to its own project's deploy (expectationFor). A
  // deployed ISA that a successful command named (or that an unparsed command may have named) is
  // checked too: check 1 can only block, so a write the parser missed never skips the pointer check.
  // A pointer that matches no possible version, or differs from the newest entry's only version, is
  // stale; one that matches only an undecided version defers. Every pointer is also held to the version
  // line of the deploy that finished last in the session, as the live hook held it (closing-pass parity).
  const sessionLast = [...deploys].reverse().find((d) => d.versions.length)?.last ?? null;
  const pointerChecked = new Set(written);
  for (const r of deployed.keys()) if (unparsed || named.has(r)) pointerChecked.add(r);
  for (const p of pointerChecked) {
    if (!existsSync(p)) continue;
    const marker = readFileSync(p, "utf-8").match(MARKER_RE);
    if (!marker) continue; // ISA doesn't use the convention — not our business.
    const want = expectationFor(p, deploys);
    if (!want) continue;
    const has = marker[1]!.toLowerCase();
    const projectStale = "exact" in want
      ? !samePointer(has, want.exact)
      : ![...want.possible].some((v) => samePointer(has, v)) || (want.newest !== null && !samePointer(has, want.newest));
    const sessionStale = sessionLast !== null && !samePointer(has, sessionLast);
    const stale = projectStale || sessionStale;
    if (!stale) {
      if (!("exact" in want)) undecided.push(p);
      continue;
    }
    const fp = `${sid}:${p}`;
    if (firedSet().has(fp)) continue;
    recordFired(fp);
    const said = !projectStale ? sessionLast! : "exact" in want ? want.exact : want.newest ?? [...want.possible].join(" or ");
    const whose = projectStale ? "this session's last deploy of that project" : "this session's last deploy";
    return {
      decision: "block",
      reason:
        `LifeOS: STALE ISA DEPLOY POINTER. ${p} says "Latest deploy: ${marker[1]}" ` +
        `but ${whose} was ${said}. Work after the last ISA reconcile is the ` +
        `exact staleness class the principal flagged: update the ISA's Resume header (deploy pointer + ` +
        `what shipped since), commit, then restate. Fires once per ISA per session.`,
    };
  }
  return pass();
}

// Standalone shim
if (import.meta.main) {
  (async () => {
    const input = await readHookInput();
    if (!input) process.exit(0);
    const d = await run(input);
    if (d) console.log(JSON.stringify(d));
    process.exit(0);
  })();
}
