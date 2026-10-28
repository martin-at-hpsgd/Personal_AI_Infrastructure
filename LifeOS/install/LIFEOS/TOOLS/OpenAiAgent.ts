#!/usr/bin/env bun
/**
 * @version 1.3.1
 * OpenAiAgent.ts — a small unattended agent loop on the OpenAI Responses API with function
 * tools, for scheduled LifeOS jobs that must not spend Anthropic subscription tokens.
 *
 * The model gets exactly three tools, all deterministic and path-confined:
 *   run_command  argv array, no shell. argv[0] is `bun` + a .ts script the job ALLOWS
 *                (`allow.scripts`: root-relative paths matched by exact realpath, never
 *                by suffix; a job state dir is never an executable root), or `gh issue|api(GET)|search` when
 *                `allow.gh` is set. Output capped; per-call timeout.
 *   read_file    under the LifeOS root or the job state dir (realpath-checked), never a
 *                secret path (DENY_PATHS: .env*, CREDENTIALS/, SECURITY/, keys, session-env).
 *   write_file   under the job state dir ONLY (realpath-checked) — dedupe state, checkpoints.
 * Its final assistant message is the deliverable (same contract as the Claude runner).
 *
 * 1.1.0 (2026-09-07, second-look findings): the loop had none of the guards the `claude -p`
 * path inherited from settings. Now: secret-path deny on every tool; per-job script allowlist
 * (a job may only run the CLIs its brief names); outbound-capable subcommands (gmail send /
 * drafts send / trash / spam / modify, the Relay bridge) refused unless the job allows them,
 * and mail sends only to `allow.mailSendTo`; `store: false` with the full transcript resent
 * each turn so job content is not retained at OpenAI; the Security Protocol travels in the
 * runner's instructions (AgentJob.ts OPENAI_SOUL).
 *
 * Billing: OPENAI_API_KEY_OPTIN from the canonical .env (pay per token, never the ChatGPT
 * login pool). Every response's usage is appended to MEMORY/OBSERVABILITY/openai-usage.jsonl.
 *
 * Gotchas (verified 2026-09-07):
 *   - The low and medium API lane models (openaiLow, openaiMedium) reject function tools on /v1/chat/completions with reasoning; /v1/responses works.
 *   - With store:false every prior output item (reasoning + function_call) is resent in `input`.
 *   - Sol rejects function tools with reasoning_effort (verified on a sibling synth tool); tool jobs ride the low and medium API lanes.
 *
 * 1.2.0 (2026-10-07, HAI-5): the tool definitions (TOOL_DEFS) and executor (execTool) are exported so the
 * Anthropic Messages API runner (AnthropicApi.ts) uses this exact safety logic instead of a fork.
 *
 * 1.2.1 (2026-10-12, review finding): `gh api` holds to GET in every method spelling (`--method=M`, `-XM`)
 * and refuses attached field flags (`-fk=v`); `gh issue` runs only GH_ISSUE_VERBS, read from argv[2], the one
 * list the claude CLI path (AgentJob.claudeToolFlags) also grants.
 *
 * 1.2.3 (2026-10-13, LOSIntegrity security:tools-5 #7 #4 #5 #6): every argument is checked as a path against the
 * protected set, relative spellings included (resolved from the spawn cwd, the LifeOS root), and file-bearing flags
 * (--body-file, --attach, -F, --input) must also sit under an allowed root; gh runs only the one real gh binary
 * (trustedGh), never a caller-supplied path; a send may carry exactly one --to, parsed the way gmail.ts parses it
 * (including its global --account strip); the gmail restrictions key on the realpath, so an alias or case variant of
 * gmail.ts is restricted too, and the command runs the validated realpath, not the supplied name.
 *
 * 1.2.4 (2026-10-14): an allowlist entry names one exact file, resolved from the
 * trusted roots and compared by realpath, never a suffix; the job state dir (and any read root holding it) is not an
 * executable root, so a model-written lookalike cannot run with the job's credentials.
 *
 * 1.3.0 (2026-10-15, ISA 20261015-boundary-primitives C7 C8): gh flags are parsed by gh's own grammar (pflag: bundled
 * shorts, attached values, `--`) against GH_GRAMMAR, an allowlist per subcommand; an unknown flag, a bundle of shorts, an
 * `@` value, or an excluded flag (--delete-last, --yes, --recover, -e, --web, --verbose) is refused, so `-iXDELETE` and
 * `-iFbody=@.env` cannot ride past the per-spelling checks. Every path is judged where the kernel lands it, through
 * Boundary.confinedPath: `..` is never folded before symlinks are followed, so `link/../x` cannot leave the roots.
 *
 * 1.2.2 (2026-10-13, LOSIntegrity security:2#1): bun runtime options before the script are an allowlist
 * (BUN_RUNTIME_FLAGS); attached `--eval=`/`--print=`, separate, bundled and abbreviated spellings are refused.
 *
 *   bun OpenAiAgent.ts --model <id> --allow-script gmail.ts --instructions "..." "<prompt>"   # ad-hoc probe
 */
import { existsSync, mkdirSync, readFileSync, appendFileSync, realpathSync, openSync, fstatSync, writeSync, closeSync, constants as fsConstants } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { invariant } from "./Invariant.ts";
import { confinedPath } from "./lib/Boundary.ts";
import { getClaudeDir, getEnvPath, lifeosPath } from "./Paths";
import { CROSS_VENDOR } from "./models";

const LIFEOS_ROOT = process.env.LIFEOS_ROOT || getClaudeDir();
const API = "https://api.openai.com/v1/responses";
const OUTPUT_CAP = 12_000;

/** Paths no tool may read, run, or name, wherever they sit under the root. */
export const DENY_PATHS: RegExp[] = [/(^|\/)\.env/, /\/CREDENTIALS\//, /\/USER\/SECURITY\//, /\/session-env\//, /\.(pem|key|p8|p12|age)$/i, /\/settings(\.[a-z]+)?\.json$/, /\/hooks\//, /\/Secrets\.ts$/];
/** Scripts that are never runnable from a job, whatever the allowlist says. */
export const DENY_SCRIPTS: RegExp[] = [/\/RELAY\/bridge\/send\.ts$/, /CfEnv\.ts$/, /Deploy[A-Za-z]*\.ts$/, /\/Secrets\.ts$/, /\/hooks\//, /UpdateKaiRepo/, /ShadowRelease/];
/**
 * The only bun runtime options a job may put before its script, matched as whole tokens. None loads
 * or evaluates code, reads an env or config file, takes a value, or changes the working directory;
 * every other option (`--eval`, `--print`, `-e`, `-p`, abbreviations, `--preload`, `--watch`) is refused.
 */
export const BUN_RUNTIME_FLAGS: ReadonlySet<string> = new Set(["--smol", "--no-env-file", "--no-install"]);
/** gmail.ts subcommands with an outbound or destructive effect. */
const MAIL_MUTATING = /^(send|trash|untrash|spam|unspam|modify|archive|inbox|star|unstar|read|unread|important|unimportant|labels)$/;

/**
 * The `gh issue` verbs `allow.gh` grants, the one list both job runners read: this tool loop checks
 * argv against it, and the claude CLI path (AgentJob.claudeToolFlags) turns it into permission rules.
 * delete, transfer, lock, pin, reopen and the rest are refused.
 */
export const GH_ISSUE_VERBS = ["list", "view", "create", "comment", "close", "edit"] as const;

export interface ToolAllow {
  /** Scripts a job may run with bun, as paths relative to the install root (e.g. "LIFEOS/TOOLS/gmail.ts"), matched by exact realpath. Empty = no bun scripts. */
  scripts: string[];
  /** May run gh issue <GH_ISSUE_VERBS>, gh api (GET, no fields; the API runners only), and gh search. */
  gh?: boolean;
  /** Addresses gmail.ts may send to (`send --to`); empty = no sends. `drafts send` stays refused. */
  mailSendTo?: string[];
}
export interface AgentUsage { input: number; output: number; cached: number; reasoning: number; calls: number }
/** What the three tools need to run one call: shared by the OpenAI and Anthropic runners. */
export interface ToolContext {
  /** Directory write_file may target and read_file may also read. */
  stateDir: string;
  allow: ToolAllow;
  /** Extra roots read_file may read (default: LifeOS root + stateDir). */
  readRoots?: string[];
  env?: NodeJS.ProcessEnv;
  commandTimeoutMs?: number;
  log?: (event: string, extra?: Record<string, unknown>) => void;
}
export interface AgentOptions extends ToolContext {
  model: string;
  instructions: string;
  prompt: string;
  timeoutMs?: number;
  maxSteps?: number;
  apiKey?: string;
  /** OpenAI `service_tier`. `flex` halves the token price for latency-tolerant jobs; if the model rejects it (400 naming service_tier) the run drops the tier once and continues at default price, never onto the Anthropic fallback. */
  serviceTier?: "flex";
  /** OpenAI `reasoning.effort` for the run; unset means the model default. */
  reasoningEffort?: "low" | "medium" | "high";
}
export interface AgentResult { ok: boolean; result: string; usage: AgentUsage; steps: number; error?: string; responseId?: string }

/** OPENAI_API_KEY_OPTIN from the canonical .env; never logged. */
export function loadOpenAiKey(): string | undefined {
  try {
    return readFileSync(getEnvPath(), "utf8").match(/^OPENAI_API_KEY_OPTIN=["']?([^"'\n]+)/m)?.[1];
  } catch { return undefined; }
}

/**
 * `p` made absolute WITHOUT folding `..`: path.resolve folds `link/..` lexically, which is not where the kernel goes
 * when `link` is a symlink. Relative paths join `base` as written.
 */
export function absUnfolded(p: string, base: string = process.cwd()): string {
  if (isAbsolute(p)) return p;
  return (base.endsWith(sep) ? base : base + sep) + p;
}

/** The physical path `p` names (symlinks followed, `..` taken from the real parent), or null when it cannot be resolved. */
function physicalPath(p: string, base?: string): string | null {
  return confinedPath(sep, absUnfolded(p, base));
}

export function isDeniedPath(p: string): boolean {
  const norm = resolve(p);
  const cands = [norm];
  try { cands.push(realpathSync(norm)); } catch { /* may not exist yet */ }
  const physical = physicalPath(p);
  if (physical) cands.push(physical);
  try { cands.push(realpathSync(absUnfolded(p))); } catch { /* may not exist yet */ }
  return DENY_PATHS.some((re) => cands.some((c) => re.test(c)));
}

/**
 * The real path `p` names when it lands under one of `roots`, else null. Judged by Boundary.confinedPath: every existing
 * component is resolved through the filesystem, so `link/../x` goes where the kernel goes, and a
 * dangling or looping symlink is never contained. Relative `p` joins `base` unfolded.
 */
export function confinedIn(p: string, roots: string[], base?: string): string | null {
  if (typeof p !== "string" || p === "" || /\0/.test(p)) return null;
  const abs = absUnfolded(p, base);
  for (const r of roots) { const real = confinedPath(r, abs); if (real !== null) return real; }
  return null;
}

/** Containment: `p` (an existing file, or a path to create) lands under one of `roots`. */
export function isUnder(p: string, roots: string[]): boolean {
  return confinedIn(p, roots) !== null;
}

/** Read a regular file without following a final-component symlink swapped in after the containment check. */
function readFileNoFollow(p: string): string {
  const fd = openSync(p, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    if (!fstatSync(fd).isFile()) throw new Error("not a regular file");
    return readFileSync(fd, "utf8");
  } finally { closeSync(fd); }
}

/**
 * Write `content` to `p` without following a final-component symlink: O_NOFOLLOW makes the open fail on a link
 * substituted after the containment check, so the bytes land only in the regular file the check approved.
 */
export function writeFileNoFollow(p: string, content: string): void {
  const fd = openSync(p, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW, 0o600);
  try {
    if (!fstatSync(fd).isFile()) throw new Error("not a regular file");
    writeSync(fd, content);
  } finally { closeSync(fd); }
}

/** The environment a gh child runs with: the host is pinned to github.com and no inherited repo override survives. */
export function ghSpawnEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const k of ["GH_HOST", "GH_REPO", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"]) delete env[k];
  env.GH_HOST = "github.com";
  return env;
}

/** A `-R/--repo` value may name only github.com: `OWNER/REPO`, or `github.com/OWNER/REPO`. */
function ghRepoHostAllowed(v: string): boolean {
  const parts = v.split("/");
  if (parts.length === 2) return true;
  return parts.length === 3 && parts[0]!.toLowerCase() === "github.com";
}

/** Flags whose value names a file the command reads or uploads: gmail.ts --body-file/--attach, gh --body-file/-F/--input. */
const FILE_FLAGS = new Set(["--body-file", "--attach", "--input", "-F", "--file"]);
/** Values of file-bearing flags in argv, in every spelling: `--flag v`, `--flag=v`, `-Fv`. */
export function fileFlagValues(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]!;
    if (FILE_FLAGS.has(a)) { out.push(argv[i + 1] ?? ""); continue; }
    const eq = a.match(/^(--[a-z-]+)=([\s\S]+)$/);
    if (eq && FILE_FLAGS.has(eq[1]!)) { out.push(eq[2]!); continue; }
    if (/^-F./.test(a)) out.push(a.slice(2));
  }
  return out;
}
/** Absolute-path candidates every argument could name, relative ones resolved from the spawn cwd (LIFEOS_ROOT). */
function pathCandidates(a: string): string[] {
  if (a.length > 1024 || /[\n\r\0]/.test(a)) return [];
  const cands = [a];
  const eq = a.indexOf("=");
  if (eq > 0 && a.startsWith("-")) cands.push(a.slice(eq + 1));
  else if (/^-[A-Za-z]./.test(a)) cands.push(a.slice(2));
  return cands.filter((c) => c && !c.startsWith("-")).map((c) => absUnfolded(c, LIFEOS_ROOT));
}

/**
 * The file a file-bearing flag value names must be a real path under `roots` and never a protected one, judged
 * physically (confinedIn). `-` is stdin. Returns the refusal, or null.
 */
function fileValueRefusal(v: string, roots: string[]): string | null {
  if (v === "-" || v === "") return null;
  if (isDeniedPath(absUnfolded(v, LIFEOS_ROOT))) return "a file argument names a protected path";
  const real = confinedIn(v, roots, LIFEOS_ROOT);
  if (real === null) return `file argument outside allowed roots: ${v}`;
  if (isDeniedPath(real)) return "a file argument names a protected path";
  return null;
}

// ── gh flag grammar ──────────────────────────────────────────────────────────
// gh parses flags with pflag: `--name=v`, `--name v` (the next word, whatever it starts with), bool longs, short
// bundles where a bool letter continues the word and a value letter takes the rest (`-iXDELETE` is `-i -X DELETE`),
// `-X=v`, and `--` ending flags. A regex per spelling cannot keep up with that, so argv is parsed the way gh parses it
// and judged against GH_GRAMMAR, an allowlist per subcommand. Anything the parse does not recognise is refused.

/** One gh flag. `bool` takes no value; `file` names a file gh reads; `at` says where an `@`-leading value is allowed; `refuse` parses the flag only to refuse it with a specific reason. */
interface GhFlagSpec { short?: string; bool?: true; file?: true; at?: "any" | "me"; refuse?: string }
type GhGrammar = Record<string, GhFlagSpec>;

const GH_HELP: GhGrammar = { help: { bool: true } };
const GH_OUTPUT: GhGrammar = { jq: { short: "q", at: "any" }, template: { short: "t", at: "any" }, json: {} };
const GH_REPO: GhGrammar = { repo: { short: "R" } };
const vals = (...names: string[]): GhGrammar => Object.fromEntries(names.map((n) => [n, {}]));
const bools = (...names: string[]): GhGrammar => Object.fromEntries(names.map((n) => [n, { bool: true as const }]));
const people = (...names: string[]): GhGrammar => Object.fromEntries(names.map((n) => [n, { at: "me" as const }]));

const GH_SEARCH_ISSUE_FILTERS: GhGrammar = {
  ...vals("app", "closed", "comments", "created", "interactions", "label", "language", "match", "milestone", "order", "owner", "project", "reactions", "search-type", "sort", "state", "team-mentions", "updated", "visibility"),
  ...people("assignee", "author", "commenter", "involves", "mentions"),
  ...bools("archived", "locked", "no-assignee", "no-label", "no-milestone", "no-project"),
};

/**
 * The flags a job may give each gh subcommand it can run, from gh 2.101 help. Left out on purpose, so refused as unknown:
 * --web (opens a browser), -e/--editor and --recover (interactive or replayed input), --delete-last and --yes (deletes
 * a comment unprompted), api --verbose (prints the request) and --allow-escape-sequences.
 */
export const GH_GRAMMAR: Readonly<Record<string, GhGrammar>> = {
  api: {
    ...GH_HELP,
    method: { short: "X" }, header: { short: "H" }, include: { short: "i", bool: true }, paginate: { bool: true },
    silent: { bool: true }, slurp: { bool: true }, cache: {}, preview: { short: "p" },
    jq: { short: "q", at: "any" }, template: { short: "t", at: "any" },
    field: { short: "F", refuse: "gh api may not send fields" }, "raw-field": { short: "f", refuse: "gh api may not send fields" },
    input: { refuse: "gh api may not send fields" }, hostname: { refuse: "gh may not select a host (--hostname)" },
  },
  "issue list": {
    ...GH_HELP, ...GH_REPO, ...GH_OUTPUT, ...vals("app", "milestone", "type"),
    assignee: { short: "a", at: "me" }, author: { short: "A", at: "me" }, mention: { at: "me" }, label: { short: "l" },
    limit: { short: "L" }, search: { short: "S" }, state: { short: "s" }, milestone: { short: "m" },
  },
  "issue view": { ...GH_HELP, ...GH_REPO, ...GH_OUTPUT, comments: { short: "c", bool: true } },
  "issue create": {
    ...GH_HELP, ...GH_REPO, ...vals("blocked-by", "blocking", "parent", "type"),
    assignee: { short: "a", at: "me" }, attach: { file: true }, body: { short: "b" }, "body-file": { short: "F", file: true },
    label: { short: "l" }, milestone: { short: "m" }, project: { short: "p" }, template: { short: "T" }, title: { short: "t" },
  },
  "issue comment": {
    ...GH_HELP, ...GH_REPO, ...bools("create-if-none", "edit-last"),
    attach: { file: true }, body: { short: "b" }, "body-file": { short: "F", file: true },
  },
  "issue close": { ...GH_HELP, ...GH_REPO, comment: { short: "c" }, "duplicate-of": {}, reason: { short: "r" } },
  "issue edit": {
    ...GH_HELP, ...GH_REPO,
    ...vals("add-blocked-by", "add-blocking", "add-label", "add-project", "add-sub-issue", "parent", "remove-blocked-by", "remove-blocking", "remove-label", "remove-project", "remove-sub-issue", "type"),
    ...people("add-assignee", "remove-assignee"), ...bools("remove-milestone", "remove-parent", "remove-type"),
    attach: { file: true }, body: { short: "b" }, "body-file": { short: "F", file: true }, milestone: { short: "m" }, title: { short: "t" },
  },
  "search issues": { ...GH_HELP, ...GH_OUTPUT, ...GH_SEARCH_ISSUE_FILTERS, limit: { short: "L" }, repo: { short: "R" }, "include-prs": { bool: true } },
  "search prs": {
    ...GH_HELP, ...GH_OUTPUT, ...GH_SEARCH_ISSUE_FILTERS, limit: { short: "L" }, repo: { short: "R" },
    base: { short: "B" }, head: { short: "H" }, ...vals("checks", "merged-at", "review"), ...people("review-requested", "reviewed-by"), ...bools("draft", "merged"),
  },
  "search repos": {
    ...GH_HELP, ...GH_OUTPUT, limit: { short: "L" }, archived: { bool: true },
    ...vals("created", "followers", "forks", "good-first-issues", "help-wanted-issues", "include-forks", "language", "license", "match", "number-topics", "order", "owner", "size", "sort", "stars", "topic", "updated", "visibility"),
  },
  "search code": { ...GH_HELP, ...GH_OUTPUT, limit: { short: "L" }, repo: { short: "R" }, ...vals("extension", "filename", "language", "match", "owner", "size") },
  "search commits": {
    ...GH_HELP, ...GH_OUTPUT, limit: { short: "L" }, repo: { short: "R" }, merge: { bool: true },
    ...vals("author-date", "author-email", "author-name", "committer-date", "committer-email", "committer-name", "hash", "order", "owner", "parent", "sort", "tree", "visibility"),
    ...people("author", "committer"),
  },
};
const GH_SEARCH_VERBS = ["issues", "prs", "repos", "code", "commits"] as const;
/** `@`-leading values a people flag may carry: gh's own selectors, never a file. */
const GH_AT_SELECTORS = new Set(["@me", "@copilot"]);
/** api -H header names a job may set; anything else (a method-override header included) is refused. */
const GH_API_HEADERS = new Set(["accept", "x-github-api-version"]);

export interface GhParsedFlag { name: string; value: string; spelling: string }
export type GhParse = { flags: GhParsedFlag[]; positionals: string[] } | { error: string };

/** Parse gh flags the way pflag does, against one subcommand's grammar. Bundled shorts are refused outright. */
export function parseGhFlags(args: string[], grammar: GhGrammar): GhParse {
  const byShort = new Map<string, string>();
  for (const [name, spec] of Object.entries(grammar)) if (spec.short) byShort.set(spec.short, name);
  const flags: GhParsedFlag[] = [];
  const positionals: string[] = [];
  let ended = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (ended || a === "-" || !a.startsWith("-")) { positionals.push(a); continue; }
    if (a === "--") { ended = true; continue; }
    if (a.startsWith("--")) {
      const body = a.slice(2);
      const eq = body.indexOf("=");
      const name = eq < 0 ? body : body.slice(0, eq);
      const spec = Object.prototype.hasOwnProperty.call(grammar, name) ? grammar[name] : undefined;
      if (!spec) return { error: `gh flag ${JSON.stringify(a.split("=")[0])} is not allowed here` };
      let value: string;
      if (eq >= 0) value = body.slice(eq + 1);
      else if (spec.bool) value = "true";
      else if (i + 1 < args.length) value = args[++i]!;
      else return { error: `gh flag --${name} needs a value` };
      flags.push({ name, value, spelling: a });
      continue;
    }
    let shorts = a.slice(1);
    let count = 0;
    while (shorts.length > 0) {
      const c = shorts[0]!;
      const name = byShort.get(c);
      if (name === undefined) return { error: `gh flag -${c} is not allowed here` };
      const spec = grammar[name]!;
      count++;
      let value: string;
      if (shorts.length > 2 && shorts[1] === "=") { value = shorts.slice(2); shorts = ""; }
      else if (spec.bool) { value = "true"; shorts = shorts.slice(1); }
      else if (shorts.length > 1) { value = shorts.slice(1); shorts = ""; }
      else if (i + 1 < args.length) { value = args[++i]!; shorts = ""; }
      else return { error: `gh flag -${c} needs a value` };
      flags.push({ name, value, spelling: a });
    }
    if (count > 1) return { error: `bundled gh short flags are refused: ${a}` };
  }
  return { flags, positionals };
}

/** A URL-looking argument must be an https URL on github.com; anything else that is not a URL passes. */
function ghUrlHostAllowed(v: string): boolean {
  if (!/^[a-z][a-z0-9+.-]*:/i.test(v) && !v.startsWith("//")) return true;
  try {
    const u = new URL(v.startsWith("//") ? "https:" + v : v);
    return u.protocol === "https:" && (u.hostname === "github.com" || u.hostname === "www.github.com");
  } catch { return false; }
}

/**
 * Judge a gh argv by gh's grammar: the subcommand must have a grammar, every flag must be in it, and each parsed value
 * is checked for what it does (method, fields, host, repo, files, `@`). Returns the refusal, or null.
 */
export function ghGrammarRefusal(argv: string[], fileRoots: string[]): string | null {
  const sub = argv[1];
  let key: string;
  let rest: string[];
  if (sub === "api") { key = "api"; rest = argv.slice(2); }
  else if (sub === "issue") { key = `issue ${argv[2] ?? ""}`; rest = argv.slice(3); }
  else if (sub === "search") {
    if (!(GH_SEARCH_VERBS as readonly string[]).includes(argv[2] ?? "")) return `gh search may only ${GH_SEARCH_VERBS.join("|")}`;
    key = `search ${argv[2]}`; rest = argv.slice(3);
  } else return "gh may only run issue|api|search";
  const grammar = GH_GRAMMAR[key];
  if (!grammar) return `gh ${key} is not allowed`;
  const parsed = parseGhFlags(rest, grammar);
  if ("error" in parsed) return parsed.error;
  for (const f of parsed.flags) {
    const spec = grammar[f.name]!;
    if (spec.refuse) return spec.refuse;
    if (f.value.startsWith("@")) {
      const ok = spec.at === "any" || (spec.at === "me" && GH_AT_SELECTORS.has(f.value));
      if (!ok) return `gh --${f.name} value may not begin with @ (gh reads @file)`;
    }
    if (f.name === "repo" && !ghRepoHostAllowed(f.value)) return `gh -R may name only github.com repositories: ${f.value}`;
    if (f.name === "method" && !/^GET$/i.test(f.value)) return "gh api may only GET";
    if (f.name === "header") {
      const colon = f.value.indexOf(":");
      if (colon <= 0 || !GH_API_HEADERS.has(f.value.slice(0, colon).trim().toLowerCase())) return `gh api header not allowed: ${f.value.slice(0, 80)}`;
    }
    if (spec.file) {
      // --attach takes `<file>#<alt text>`: judge the whole value and the file part.
      const cands = f.name === "attach" && f.value.includes("#") ? [f.value, f.value.slice(0, f.value.indexOf("#"))] : [f.value];
      for (const c of cands) { const r = fileValueRefusal(c, fileRoots); if (r) return r; }
    }
  }
  if (key === "api") {
    if (parsed.positionals.length !== 1) return "gh api takes exactly one endpoint";
    const endpoint = parsed.positionals[0]!;
    if (/^[a-z][a-z0-9+.-]*:/i.test(endpoint) || endpoint.startsWith("//")) return "gh api endpoint must be a relative GitHub path, never a URL";
  }
  if (sub === "issue") {
    const bad = parsed.positionals.find((p) => !ghUrlHostAllowed(p));
    if (bad !== undefined) return `gh issue URLs may name only github.com: ${bad}`;
  }
  return null;
}

/** The one real gh binary: a fixed set of system locations, realpath-resolved. Never PATH, never a caller-supplied path. */
export const TRUSTED_GH_PATHS = ["/opt/homebrew/bin/gh", "/usr/local/bin/gh", "/usr/bin/gh"];
export function trustedGh(): string | null {
  for (const c of TRUSTED_GH_PATHS) { try { return realpathSync(c); } catch { /* next */ } }
  return null;
}

/** Index of the bun script in argv (first non-flag after bun), or -1. */
function bunScriptIndex(argv: string[]): number { return argv.findIndex((a, i) => i > 0 && !a.startsWith("-")); }

/**
 * Exactly what execTool spawns for an allowed argv: bun runs the validated script by its realpath (so a
 * relative path, alias or case variant cannot differ from what the gate checked), gh runs the trusted gh binary.
 */
export function resolvedRun(argv: string[]): { exe: string; args: string[] } | null {
  const exeName = argv[0]!.split("/").pop();
  if (exeName === "bun") {
    const idx = bunScriptIndex(argv);
    const args = argv.slice(1);
    if (idx > 0) { try { args[idx - 1] = realpathSync(argv[idx]!); } catch { return null; } }
    return { exe: process.execPath, args };
  }
  if (exeName === "gh") { const gh = trustedGh(); return gh ? { exe: gh, args: argv.slice(1) } : null; }
  return null;
}

/** gmail.ts takes `--account <name>` anywhere on its line and strips it before any subcommand sees the rest; mirror that loop exactly. */
function gmailArgv(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) { if (args[i] === "--account") { i++; continue; } out.push(args[i]!); }
  return out;
}
/** gmail.ts parseSendArgs: flags that take the next token as a value, and flags that do not. */
const SEND_VALUE_FLAGS = new Set(["--to", "--subject", "--body-file", "--cc", "--bcc", "--from", "--reply-to", "--reply-to-id", "--in-reply-to", "--references", "--thread-id", "--attach"]);
const SEND_BOOL_FLAGS = new Set(["--body-stdin", "--html", "--dry-run", "--no-copy"]);

/** Deterministic allow/deny for run_command. Returns a reason string when refused, null when allowed. */
/**
 * The exact files an allowlist entry names: the entry resolved against each trusted install root (or taken as given
 * when absolute), realpath-canonicalised. A script is allowed only when its own realpath IS one of these files, never
 * when it merely ends with the entry, so a lookalike written elsewhere (a job state dir) cannot pass for an allowed CLI.
 */
export function allowlistIdentities(entry: string, roots: string[]): string[] {
  if (typeof entry !== "string" || !entry || /[\0\n\r]/.test(entry)) return [];
  const cands = entry.startsWith("/") ? [entry] : roots.map((r) => resolve(r, entry));
  const out: string[] = [];
  for (const c of cands) { try { out.push(realpathSync(c)); } catch { /* not present under this root */ } }
  return out;
}

export function commandRefusal(argv: string[], scriptRoots: string[], allow: ToolAllow, extraFileRoots: string[] = [], writableRoots: string[] = []): string | null {
  if (!Array.isArray(argv) || argv.length === 0 || argv.some((a) => typeof a !== "string")) return "argv must be a non-empty string array";
  // Every argument is a possible path, absolute or relative (the command runs with cwd LIFEOS_ROOT): `--body-file .env` is the same file as <root>/.env.
  if (argv.slice(1).some((a) => pathCandidates(a).some((p) => isDeniedPath(p)))) return "an argument names a protected path";
  // A file-bearing flag must point under an allowed root, after realpath, and never at a protected file.
  // (`gh api` is exempt only because its -F/--input are field flags the gh branch below refuses outright.)
  const ghApi = argv[0]!.split("/").pop() === "gh" && argv[1] === "api";
  const fileRoots = [...scriptRoots, ...extraFileRoots];
  for (const v of ghApi ? [] : fileFlagValues(argv)) {
    const r = fileValueRefusal(v, fileRoots);
    if (r) return r;
  }
  const exe = argv[0]!.split("/").pop();
  if (exe === "bun") {
    // Only the bun runtime flags BEFORE the script path are bun's; everything after belongs to the script.
    // Those flags are an allowlist: a denylist missed `--eval=<code>` beside an allowed script, and Bun
    // has attached, separate, bundled (`-pe`) and value-taking spellings a denylist cannot keep up with.
    const scriptIdx = bunScriptIndex(argv);
    const runtimeFlags = scriptIdx < 0 ? argv.slice(1) : argv.slice(1, scriptIdx);
    const badFlag = runtimeFlags.find((a) => !BUN_RUNTIME_FLAGS.has(a));
    if (badFlag !== undefined) return `bun runtime flag ${JSON.stringify(badFlag)} is not allowed; only ${[...BUN_RUNTIME_FLAGS].join(", ")} may precede the script`;
    const script = scriptIdx < 0 ? undefined : argv[scriptIdx];
    if (!script) return "bun needs a script path";
    if (/^(x|run|exec|install|add|remove|create|init|link|pm|repl|build|test|upgrade)$/.test(script)) return "bun run / x / install and other subcommands are not allowed; call a .ts script file";
    if (!/\.ts$/.test(script)) return "bun may only run a .ts script file";
    if (!existsSync(script)) return `script not found: ${script}`;
    if (!isUnder(script, scriptRoots)) return `script outside allowed roots: ${script}`;
    const real = realpathSync(script);
    if (DENY_SCRIPTS.some((re) => re.test(script) || re.test(real))) return `script is never runnable from a job: ${script}`;
    // A directory the model can write to is never an executable root, whatever else contains it.
    if (writableRoots.length && isUnder(real, writableRoots)) return `script sits in a writable job directory and is never runnable: ${script}`;
    const allowed = (allow.scripts ?? []).some((s) => allowlistIdentities(s, scriptRoots).includes(real));
    if (!allowed) return `script not in this job's allowlist: ${script}`;
    // Key on the canonical identity: an alias, symlink or case variant of gmail.ts is gmail.ts.
    if (/gmail\.ts$/i.test(script) || /gmail\.ts$/i.test(real)) {
      const rest = gmailArgv(argv.slice(scriptIdx + 1));
      const sub = rest[0] ?? "";
      if (sub === "drafts" && rest[1] === "send") return "gmail drafts send is refused for jobs";
      if (sub === "drafts" && rest[1] === "delete") return "gmail drafts delete is refused for jobs";
      if (MAIL_MUTATING.test(sub)) {
        if (sub !== "send") return `gmail ${sub} is refused for jobs (read-only mailbox access)`;
        // Parse the way gmail.ts parses (SEND_*_FLAGS): the recipient the gate checks is the recipient gmail.ts sends to.
        const tos: string[] = [];
        let ccBcc = false;
        for (let i = 1; i < rest.length; i++) {
          const a = rest[i]!;
          if (SEND_VALUE_FLAGS.has(a)) { const v = rest[++i]; if (a === "--to") tos.push(v ?? ""); else if (a === "--cc" || a === "--bcc") ccBcc = true; }
          else if (!SEND_BOOL_FLAGS.has(a)) return `gmail send refused: unknown argument ${JSON.stringify(a)}`;
        }
        if (tos.length > 1) return "gmail send refused: repeated --to";
        const to = tos[0] ?? "";
        const ok = (allow.mailSendTo ?? []).map((s) => s.toLowerCase()).includes(to.toLowerCase());
        if (!ok) return `gmail send refused: --to "${to}" is not in this job's mailSendTo`;
        if (ccBcc) return "gmail send refused: cc/bcc not allowed for jobs";
      }
    }
    return null;
  }
  if (exe === "gh") {
    if (!allow.gh) return "gh is not allowed for this job";
    // The name `gh` is not the binary: only the real gh runs, whatever path argv[0] spells.
    const trusted = trustedGh();
    if (!trusted) return "gh is not installed at a trusted location";
    if (argv[0] !== "gh") {
      let real: string | null = null;
      try { real = realpathSync(absUnfolded(argv[0]!, LIFEOS_ROOT)); } catch { /* missing */ }
      if (real !== trusted) return `gh path is not the trusted gh binary: ${argv[0]}`;
    }
    const sub = argv[1];
    if (!["issue", "api", "search"].includes(sub ?? "")) return "gh may only run issue|api|search";
    // The request host is github.com, never the caller's choice: no --hostname in any spelling, no -R naming
    // another host, and (in execTool) no inherited GH_HOST/GH_REPO.
    for (let i = 2; i < argv.length; i++) {
      const a = argv[i]!;
      if (a === "--hostname" || a.startsWith("--hostname=")) return "gh may not select a host (--hostname)";
      const repo = a === "-R" || a === "--repo" ? argv[i + 1] ?? "" : a.startsWith("--repo=") ? a.slice(7) : /^-R./.test(a) ? a.slice(2) : null;
      if (repo !== null && !ghRepoHostAllowed(repo)) return `gh -R may name only github.com repositories: ${repo}`;
    }
    if (sub === "api") {
      // The endpoint is the first positional after `api`; it must be a relative GitHub path or `graphql`, never a URL.
      const VALUE_FLAGS = new Set(["-X", "--method", "-H", "--header", "-q", "--jq", "-t", "--template", "--cache", "-p", "--preview"]);
      let endpoint: string | undefined;
      for (let i = 2; i < argv.length; i++) {
        const a = argv[i]!;
        if (VALUE_FLAGS.has(a)) { i++; continue; }
        if (a.startsWith("-")) continue;
        endpoint = a; break;
      }
      if (endpoint !== undefined && (/^[a-z][a-z0-9+.-]*:/i.test(endpoint) || endpoint.startsWith("//"))) return "gh api endpoint must be a relative GitHub path, never a URL";
      // Every method spelling (`-X M`, `-XM`, `--method M`, `--method=M`) must be GET; any other is a write.
      for (let i = 2; i < argv.length; i++) {
        const a = argv[i]!;
        const method = a === "-X" || a === "--method" ? argv[i + 1] ?? "" : /^--method=/.test(a) ? a.slice(9) : /^-X./.test(a) ? a.slice(2) : null;
        if (method !== null && !/^GET$/i.test(method)) return "gh api may only GET";
      }
      // Field and input flags, separate or attached (`-f k=v`, `-fk=v`, `--field=k=v`, `--input=f`), make a body.
      if (argv.some((a) => /^(-f|-F|--field|--raw-field|--input)$/.test(a) || /^--(field|raw-field|input)=/.test(a) || /^-[fF]./.test(a))) return "gh api may not send fields";
    }
    // The verb comes first (`gh issue view 5 -R o/r`), so a flag ahead of it cannot hide a refused verb.
    if (sub === "issue" && !(GH_ISSUE_VERBS as readonly string[]).includes(argv[2] ?? "")) return `gh issue may only ${GH_ISSUE_VERBS.join("|")}`;
    // The checks above keep their specific messages; this parse is the one that decides (C7).
    return ghGrammarRefusal(argv, fileRoots);
  }
  return `executable not allowed: ${argv[0]}`;
}

/** Vendor-neutral tool definitions: name, description, JSON Schema. Each runner wraps them in its API's shape. */
export const TOOL_DEFS: ReadonlyArray<{ name: string; description: string; parameters: Record<string, unknown> }> = [
  { name: "run_command", description: "Run a LifeOS command without a shell. argv[0] is 'bun' followed by one of this job's allowed .ts scripts, or 'gh' when allowed. Returns exit code, stdout, stderr (each capped).",
    parameters: { type: "object", properties: { argv: { type: "array", items: { type: "string" } }, stdin: { type: "string", description: "Text piped to the command's stdin; empty string for none." } }, required: ["argv", "stdin"], additionalProperties: false } },
  { name: "read_file", description: "Read a UTF-8 file under the LifeOS root or the job state dir. Secret paths are refused.",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false } },
  { name: "write_file", description: "Write a UTF-8 file under the job state dir (dedupe state, checkpoints). Creates parent dirs.",
    parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"], additionalProperties: false } },
];
const TOOLS = TOOL_DEFS.map((t) => ({ type: "function", name: t.name, strict: true, description: t.description, parameters: t.parameters }));

function cap(s: string, n = OUTPUT_CAP): string { return s.length > n ? s.slice(0, n) + `\n…[truncated ${s.length - n} chars]` : s; }

/** Run one tool call under the path, allowlist and secret-path guards. Returns the JSON string the model sees. */
export function execTool(name: string, args: Record<string, unknown>, o: ToolContext): string {
  const readRoots = [LIFEOS_ROOT, ...(o.readRoots ?? []), o.stateDir];
  if (name === "run_command") {
    const argv = args.argv as string[];
    // The job state dir (and any read root holding it, such as the shared state tree) is writable by models, so it is
    // excluded from the executable roots and refused as a script location.
    const writable = [o.stateDir, ...(o.readRoots ?? []).filter((r) => r !== LIFEOS_ROOT && isUnder(o.stateDir, [r]))];
    const scriptRoots = [LIFEOS_ROOT, ...(o.readRoots ?? []).filter((r) => !writable.includes(r))];
    const refusal = commandRefusal(argv, scriptRoots, o.allow, [o.stateDir], writable);
    if (refusal) { o.log?.("tool_refused", { argv: (argv ?? []).slice(0, 6), refusal }); return JSON.stringify({ refused: refusal }); }
    const run = resolvedRun(argv);
    if (!run) { o.log?.("tool_refused", { argv: argv.slice(0, 6), refusal: "unresolvable executable" }); return JSON.stringify({ refused: "executable could not be resolved to a trusted binary" }); }
    const baseEnv = o.env ?? process.env;
    const childEnv = argv[0]!.split("/").pop() === "gh" ? ghSpawnEnv(baseEnv) : baseEnv;
    const r = spawnSync(run.exe, run.args, { encoding: "utf8", cwd: LIFEOS_ROOT, env: childEnv, timeout: o.commandTimeoutMs ?? 120_000, input: (args.stdin as string) || undefined, maxBuffer: 16 * 1024 * 1024 });
    o.log?.("tool_run", { argv: argv.slice(0, 6), status: r.status, stdoutChars: (r.stdout ?? "").length });
    return JSON.stringify({ exit: r.status, stdout: cap(r.stdout ?? ""), stderr: cap(r.stderr ?? "", 2000), timedOut: !!r.error });
  }
  if (name === "read_file") {
    const p = String(args.path);
    if (isDeniedPath(p)) { o.log?.("tool_refused", { read: p, refusal: "protected path" }); return JSON.stringify({ refused: "protected path" }); }
    if (!existsSync(p)) return JSON.stringify({ error: "not found" });
    // Read the physical path the containment check approved, never `p` re-walked.
    const real = confinedIn(p, readRoots);
    if (real === null) return JSON.stringify({ refused: "outside allowed roots" });
    if (isDeniedPath(real)) { o.log?.("tool_refused", { read: p, refusal: "protected path" }); return JSON.stringify({ refused: "protected path" }); }
    try { return JSON.stringify({ content: cap(readFileNoFollow(real)) }); }
    catch (e) { return JSON.stringify({ refused: `read_file refused: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}` }); }
  }
  if (name === "write_file") {
    const p = String(args.path);
    const refusedWrite = JSON.stringify({ refused: "write_file is confined to the job state dir" });
    const first = isDeniedPath(p) ? null : confinedIn(p, [o.stateDir]);
    if (first === null || isDeniedPath(first)) return refusedWrite;
    mkdirSync(dirname(first), { recursive: true, mode: 0o700 });
    // Re-check after mkdir: a component created or swapped in between must still resolve under the state dir.
    const target = confinedIn(p, [o.stateDir]);
    if (target === null || isDeniedPath(target)) return refusedWrite;
    const realState = realpathSync(o.stateDir);
    invariant(target === realState || target.startsWith(realState + sep), `write_file: confined target ${target} is not under the state dir ${realState}`);
    try { writeFileNoFollow(target, String(args.content)); }
    catch (e) { return JSON.stringify({ refused: `write_file refused: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}` }); }
    o.log?.("tool_write", { path: p, chars: String(args.content).length });
    return JSON.stringify({ ok: true });
  }
  return JSON.stringify({ refused: `unknown tool ${name}` });
}

function recordUsage(model: string, job: string | undefined, u: AgentUsage): void {
  try {
    const dir = lifeosPath("MEMORY", "OBSERVABILITY");
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "openai-usage.jsonl"), JSON.stringify({ ts: new Date().toISOString(), vendor: "openai", model, job, ...u }) + "\n");
  } catch { /* observability never breaks the run */ }
}

/** One unattended run: prompt → tool loop → final text. The transcript stays local (store:false). */
export async function runOpenAiAgent(o: AgentOptions): Promise<AgentResult> {
  invariant(!!o.model && !!o.instructions && !!o.prompt, "OpenAiAgent: model, instructions, prompt required");
  invariant(!!o.stateDir, "OpenAiAgent: stateDir required");
  invariant(!!o.allow && Array.isArray(o.allow.scripts), "OpenAiAgent: allow.scripts required (empty array = no scripts)");
  const key = o.apiKey ?? loadOpenAiKey();
  const usage: AgentUsage = { input: 0, output: 0, cached: 0, reasoning: 0, calls: 0 };
  if (!key) return { ok: false, result: "", usage, steps: 0, error: "OPENAI_API_KEY_OPTIN missing from .env" };
  const deadline = Date.now() + (o.timeoutMs ?? 600_000);
  const maxSteps = o.maxSteps ?? 40;
  const headers = { authorization: `Bearer ${key}`, "content-type": "application/json" };
  const transcript: unknown[] = [{ role: "user", content: o.prompt }];
  let last: string | undefined;
  let steps = 0;
  let tier = o.serviceTier;
  for (;;) {
    if (Date.now() > deadline) return { ok: false, result: "", usage, steps, error: "timeout", responseId: last };
    if (steps >= maxSteps) return { ok: false, result: "", usage, steps, error: `step cap ${maxSteps} reached`, responseId: last };
    let j: any;
    for (let attempt = 0; ; attempt++) {
      const body = { model: o.model, instructions: o.instructions, input: transcript, tools: TOOLS, store: false, ...(tier ? { service_tier: tier } : {}), ...(o.reasoningEffort ? { reasoning: { effort: o.reasoningEffort } } : {}) };
      const res = await fetch(API, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(Math.max(10_000, Math.min(180_000, deadline - Date.now()))) }).catch((e) => ({ ok: false, status: 0, json: async () => ({ error: { message: String(e) } }) }) as any);
      j = await res.json().catch(() => ({ error: { message: `HTTP ${res.status} unparseable` } }));
      if (res.ok && !j.error) break;
      const msg = j.error?.message ?? `HTTP ${res.status}`;
      if (tier && res.status === 400 && /service_tier/i.test(String(msg))) {
        o.log?.("service_tier_rejected", { model: o.model, tier, message: String(msg).slice(0, 200) });
        tier = undefined;
        continue;
      }
      const retryable = res.status === 429 || res.status >= 500 || res.status === 0;
      if (!retryable || attempt >= 2) return { ok: false, result: "", usage, steps, error: `openai: ${String(msg).slice(0, 300)}`, responseId: last };
      await Bun.sleep(2000 * (attempt + 1));
    }
    steps++; usage.calls++;
    const u = j.usage ?? {};
    usage.input += u.input_tokens ?? 0; usage.output += u.output_tokens ?? 0;
    usage.cached += u.input_tokens_details?.cached_tokens ?? 0; usage.reasoning += u.output_tokens_details?.reasoning_tokens ?? 0;
    last = j.id;
    const output: any[] = j.output ?? [];
    const calls = output.filter((x) => x.type === "function_call");
    if (calls.length === 0) {
      const text: string = typeof j.output_text === "string" ? j.output_text : output.filter((x) => x.type === "message").flatMap((m: any) => (m.content ?? []).map((c: any) => c.text ?? "")).join("\n");
      recordUsage(o.model, o.env?.AGENTJOB_ID, usage);
      if (j.status && j.status !== "completed") return { ok: false, result: text.trim(), usage, steps, error: `response status ${j.status}`, responseId: last };
      return { ok: true, result: text.trim(), usage, steps, responseId: last };
    }
    // store:false — the model's own output items (reasoning + calls) go back verbatim, then our outputs.
    transcript.push(...output);
    for (const c of calls) {
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(c.arguments || "{}"); } catch { /* bad args → tool sees {} */ }
      let out: string;
      try { out = execTool(c.name, args, o); } catch (e) { out = JSON.stringify({ error: String(e).slice(0, 500) }); }
      transcript.push({ type: "function_call_output", call_id: c.call_id, output: out });
    }
  }
}

if (import.meta.main) {
  const a = process.argv.slice(2);
  const flag = (n: string) => { const i = a.indexOf(n); return i >= 0 ? a[i + 1] : undefined; };
  const scripts = a.flatMap((x, i) => (x === "--allow-script" ? [a[i + 1]!] : []));
  const prompt = a.filter((x, i) => !x.startsWith("--") && !(i > 0 && a[i - 1]!.startsWith("--"))).join(" ");
  if (!prompt) { console.error('usage: OpenAiAgent.ts --model <id> [--allow-script <suffix>]... [--allow-gh] [--instructions "..."] [--state-dir <dir>] "<prompt>"'); process.exit(2); }
  const r = await runOpenAiAgent({ model: flag("--model") ?? CROSS_VENDOR.openaiLow, instructions: flag("--instructions") ?? "You are an unattended LifeOS job. Use the tools when needed. Your final message is the deliverable, plain text.", prompt, stateDir: flag("--state-dir") ?? join(LIFEOS_ROOT, "LIFEOS/USER/MEMORY/STATE/agent-jobs/_probe"), allow: { scripts, gh: a.includes("--allow-gh") }, log: (e, x) => console.error(`[${e}] ${JSON.stringify(x ?? {})}`) });
  console.error(`[usage] ${JSON.stringify(r.usage)} steps=${r.steps}${r.error ? " error=" + r.error : ""}`);
  console.log(r.result);
  process.exit(r.ok ? 0 : 1);
}
