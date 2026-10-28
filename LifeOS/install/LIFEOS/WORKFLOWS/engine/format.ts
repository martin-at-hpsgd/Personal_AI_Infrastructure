/**
 * Workflows definition format v2 — a superset of the v1 workflow format.
 *
 * v1 documents (`version: 1`) are handed to the v1 loader untouched, so a
 * v1 definition gets exactly the v1 engine's verdict, then are lifted into the
 * v2 shape. v2 documents add where a workflow runs, the SOP it carries out, the
 * domains it reads, a typed input AND output, several triggers, seven step
 * kinds with their executors, declared side effects, and `after:` links whose
 * types are checked at save time.
 *
 * Graph rules (dependency cycles, dangling `needs`, references to non-ancestor
 * steps, step policy bounds) are not re-implemented here: every v2 definition is
 * compiled to a v1 graph and validated by the v1 engine.
 *
 * Nothing in this module runs a step, spawns a process, or imports an action
 * implementation. Validation is inspection only (ISA WA6).
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { parseDocument } from "yaml";
import { CROSS_VENDOR } from "../../TOOLS/models.ts";
import {
  assertSchema,
  parseV1Yaml,
  parseWorkflow,
  schemaAtPath,
  validateInputMapping,
  validateV1Trigger,
  validateWorkflow,
  type StepPolicy,
  type V1Step,
  type V1Workflow,
} from "./v1.ts";
import { localHasSecret } from "./secrets.ts";
import { DefinitionError, issueOfError, locate, type Issue } from "./format-issues.ts";
import {
  ARTIFACT_REF_FORMAT, ALL_TRIGGER_FIELDS, TRIGGER_FIELDS, artifactRefFields, glanceCallerNames, isCloudOnly, isResource, isTriggerRef, SECRET_NAME_RE,
  TRIGGER_INPUT_KEY, promptFileShape, refsUnder, resolvePromptFile, rewriteTriggerRefs, secretShape, sopResolves, stringLeaves,
} from "./format-rules.ts";
import { NAME_RE, definitionsDir, stemOf } from "./paths.ts";
import { PRINCIPAL_ZONE } from "../../TOOLS/lib/ZonedSchedule.ts";

/** A schedule trigger's `timezone: principal`: wherever the principal is now, from the location service, read at each wake. */
export const PRINCIPAL_TIMEZONE = PRINCIPAL_ZONE;

export { DefinitionError, type Issue };

/* ── Vocabulary ─────────────────────────────────────────────────────────── */

export const STEP_KINDS = ["action", "command", "model", "judgment", "agent", "human", "workflow"] as const;
export type StepKind = (typeof STEP_KINDS)[number];

export const SIDE_EFFECTS = ["none", "read", "write", "outbound", "money", "deploy"] as const;
export type SideEffect = (typeof SIDE_EFFECTS)[number];
/** Side effects that reach outside LifeOS and therefore need a human decision upstream. */
export const GATED_EFFECTS: readonly SideEffect[] = ["outbound", "money", "deploy"];
/**
 * The one recipient that lets an `outbound` step skip the human gate: the principal's own pinned destination.
 * It is the author's declaration. For a command step the validator checks it against the walked argv: a known
 * outbound signature that is not principal-pinned (`principalPinned`, the Relay sender) is refused with it. An
 * action step's own destination is not checked here.
 */
export const PRINCIPAL_RECIPIENT = "principal";

/**
 * Known deploy, send and payment command shapes. This is a LINT, not an authorization: a command step whose
 * walked argv matches a row must declare the matching side effect, so the human gate cannot be skipped by
 * leaving the declaration out by accident. A step that hides its program behind a variable, a downloaded script
 * or a string the walker cannot parse still passes, and `side_effects: [none]` on an unrecognised program is
 * taken at its word.
 *
 * Rows match a walked invocation, not words in prose. `tool` matches the program's basename after wrappers
 * (env, exec, sudo, ...), runners (`bun x.ts`, `npx pkg`, `bun run script`) and shell scripts handed over with the command flag are walked;
 * `sub` must match the leading positional words (flags skipped, `valueFlags` consume their value) so
 * `git commit -m push` is not a push; `leading` allows no flag before the subcommand; `anyArg` must match some argument.
 */
export interface EffectSignature {
  effect: SideEffect;
  label: string;
  tool: RegExp;
  sub?: RegExp;
  anyArg?: RegExp;
  valueFlags?: readonly string[];
  /** The subcommand must be the very first argument, so `--mode deploy` is not a deploy. */
  leading?: boolean;
  /** Applies only to a parsed argv or script, never to words inside `bun -e` code, which the walker cannot parse. */
  argvOnly?: boolean;
  /** Matches only a package.json script run by name (`bun run deploy`, `npm run deploy`). */
  runScript?: boolean;
  /** An outbound sender whose destination is the principal's own line, resolved from its config, so `recipient: principal` may stand with it. */
  principalPinned?: boolean;
}

/** Programs that only print or read; a subcommand-shaped word after them is data. */
const NON_EXECUTING = new Set([
  "echo", "printf", "cat", "bat", "grep", "egrep", "fgrep", "rg", "sed", "awk", "head", "tail", "ls", "eza", "fd", "find",
  "test", "[", "true", "false", "wc", "sort", "cut", "tr", "jq", "diff", "man", "which", "type", "less", "more", "tee", "export",
]);
const HTTP_WRITE = /^(-d|--data(-[a-z]+)?|-F|--form|--upload-file|-T|--json|-X(POST|PUT|PATCH|DELETE)|POST|PUT|PATCH|DELETE)$/;
// Two engine tests forbid the provider CLI's name and a bare short "c" flag literal in engine sources, so both are assembled.
const CF_PROGRAMS = new RegExp("^(wrang" + "ler|cf|CfEnv\\.ts|cfenv)$");
const FLAG_C = "-" + "c";

export const EFFECT_SIGNATURES: readonly EffectSignature[] = [
  // A deploy script or a package script named deploy.
  { effect: "deploy", label: "a deploy script", tool: /^deploy\.[A-Za-z]+$/ },
  { effect: "deploy", label: "a deploy script", tool: /^deploy$/, runScript: true },
  // Any other tool whose first argument is `deploy`: `workflow.ts deploy`, `yarn deploy`.
  { effect: "deploy", label: "a deploy subcommand", tool: /./, sub: /^deploy(\s|$)/, leading: true, argvOnly: true },
  { effect: "deploy", label: "a Cloudflare deploy or secret change", tool: CF_PROGRAMS, valueFlags: ["--config", FLAG_C, "--env", "-e", "--name", "-n"],
    sub: /^(deploy|publish|rollback|delete|versions (deploy|upload)|secrets? (put|bulk|delete)|workers? (publish|deploy|delete|rollback)|pages (deploy|publish)|triggers deploy|d1 (execute|migrations apply)|(kv|r2|queues?) \S+ (put|delete|create))(\s|$)/ },
  { effect: "deploy", label: "git push", tool: /^git$/, sub: /^push(\s|$)/, valueFlags: ["-C", FLAG_C, "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env"] },
  { effect: "deploy", label: "gh release or merge", tool: /^gh$/, sub: /^(release (create|upload|edit|delete)|pr merge)(\s|$)/, valueFlags: ["-R", "--repo"] },
  { effect: "deploy", label: "gh repo visibility or create --public", tool: /^gh$/, sub: /^repo (edit|create)(\s|$)/, anyArg: /^--(visibility(=.*)?|public)$/, valueFlags: ["-R", "--repo"] },
  { effect: "deploy", label: "package publish", tool: /^(npm|pnpm|yarn)$/, sub: /^publish(\s|$)/ },
  { effect: "deploy", label: "Uladmin live write (--yes)", tool: /^Uladmin\.ts$/, sub: /^link-(create|update|delete)(\s|$)/, anyArg: /^--yes$/ },
  { effect: "outbound", label: "gmail.ts send", tool: /^gmail\.ts$/, sub: /^send(\s|$)/, valueFlags: ["--account"] },
  { effect: "outbound", label: "Relay send.ts", tool: /^send\.ts$/i, principalPinned: true },
  { effect: "outbound", label: "Relay send", tool: /^relay(\.ts)?$/i, sub: /^send(\s|$)/, principalPinned: true },
  { effect: "outbound", label: "SMS send", tool: /^(sms|twilio)(\.ts)?$/i },
  { effect: "outbound", label: "Broadcast post", tool: /^Broadcast\.ts$/, sub: /^post(\s|$)/ },
  { effect: "outbound", label: "xurl post, reply, repost or DM", tool: /^xurl$/, sub: /^(post|reply|quote|repost|dm|delete)(\s|$)/ },
  { effect: "outbound", label: "an HTTP write (curl or xurl)", tool: /^(curl|xurl|wget|http)$/, anyArg: HTTP_WRITE },
  { effect: "outbound", label: "YouTubeUpload upload/publish", tool: /^YouTubeUpload\.ts$/, sub: /^(upload|publish)(\s|$)/ },
  { effect: "money", label: "dd-cli order", tool: /^dd-cli$/, sub: /^order(\s|$)/ },
  { effect: "money", label: "SubmitOrder.ts", tool: /^SubmitOrder\.ts$/ },
];

/* ── Walking a command ──────────────────────────────────────────────────── */

interface Invocation { program: string; args: string[]; code: boolean; script: boolean }

const basename = (word: string): string => word.slice(word.lastIndexOf("/") + 1);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
const WRAPPERS = new Set(["exec", "env", "sudo", "nohup", "time", "command", "nice", "xargs", "builtin", "setsid", "timeout", "then", "do", "else", "if", "!", "{"]);
const RUNNERS = new Set(["bun", "bunx", "node", "deno", "tsx", "ts-node", "npx", "pnpx", "npm", "pnpm", "yarn"]);
const RUNNER_VALUE_FLAGS = ["--cwd", "--env-file", "--config", "--preload", "-r", "--require", "--import", "--loader", "--prefix", "-C"];
const PACKAGE_RUNNERS = new Set(["npx", "bunx", "pnpx"]);
const EVAL_FLAGS = /^(-e|--eval|-p|--print|-pe|-ep)$/;
const MAX_DEPTH = 6;

/** The simple commands of a shell script, each as unquoted words. Separators: ; & | newline ( ) ` and $( . */
function shellCommands(script: string): string[][] {
  const commands: string[][] = [];
  let current: string[] = [];
  let word = "";
  let has = false;
  const endWord = () => { if (has) { current.push(word); word = ""; has = false; } };
  const endCommand = () => { endWord(); if (current.length) commands.push(current); current = []; };
  for (let i = 0; i < script.length; i++) {
    const c = script[i]!;
    if (c === "'") {
      const close = script.indexOf("'", i + 1);
      const end = close < 0 ? script.length : close;
      word += script.slice(i + 1, end); has = true; i = end;
    } else if (c === '"') {
      has = true; i++;
      while (i < script.length && script[i] !== '"') { if (script[i] === "\\" && i + 1 < script.length) i++; word += script[i]; i++; }
    } else if (c === "\\") {
      if (script[i + 1] === "\n") i++;
      else if (i + 1 < script.length) { word += script[i + 1]; has = true; i++; }
    } else if (c === "$" && script[i + 1] === "{") {
      const close = script.indexOf("}", i);
      const end = close < 0 ? script.length - 1 : close;
      word += script.slice(i, end + 1); has = true; i = end;
    } else if (c === "#" && !has) {
      while (i < script.length && script[i] !== "\n") i++;
      endCommand();
    } else if (c === ";" || c === "\n" || c === "|" || c === "&" || c === "(" || c === ")" || c === "`") endCommand();
    else if (c === " " || c === "\t" || c === "\r") endWord();
    else { word += c; has = true; }
  }
  endCommand();
  return commands;
}

/** Leading positional words of an argument list: flags skipped, a flag in valueFlags (and not written --flag=value) consumes the next word. */
function positionals(args: readonly string[], valueFlags: readonly string[] = [], leading = false, limit = 3): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length && out.length < limit; i++) {
    const arg = args[i]!;
    if (arg.startsWith("-") && arg.length > 1) {
      if (leading) break;
      if (!arg.includes("=") && valueFlags.includes(arg)) i++;
      continue;
    }
    out.push(arg);
  }
  return out;
}

/** The words of inline code (`bun -e`, `node -e`), each reduced to its basename; the code is not parsed, so every word may start a command. */
function codeInvocations(code: string): Invocation[] {
  const words = code.split(/[\s"'`,;()[\]{}|&<>=]+/).filter(Boolean).map(basename);
  return words.map((program, i) => ({ program, args: words.slice(i + 1, i + 13), code: true, script: false }));
}

function invocationsOf(words: readonly string[], depth = 0): Invocation[] {
  if (depth > MAX_DEPTH) return [];
  let i = 0;
  for (;;) {
    while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]!)) i++;
    if (i >= words.length) return [];
    const wrapper = basename(words[i]!);
    if (!WRAPPERS.has(wrapper)) break;
    i++;
    while (i < words.length && words[i]!.startsWith("-") && words[i] !== "-") { if (wrapper === "nice" && words[i] === "-n") i++; i++; }
    if (wrapper === "timeout") i++;
  }
  const program = basename(words[i]!);
  const rest = words.slice(i + 1);
  const plain: Invocation = { program, args: rest, code: false, script: false };
  if (program === "eval") return invocationsFromScript(rest.join(" "), depth);
  if (SHELLS.has(program)) {
    const c = rest.findIndex(w => /^-[a-z]*c[a-z]*$/.test(w));
    if (c >= 0 && rest[c + 1] !== undefined) return [plain, ...invocationsFromScript(rest[c + 1]!, depth)];
    const file = rest.findIndex(w => !w.startsWith("-"));
    return file >= 0 ? invocationsOf(rest.slice(file), depth + 1) : [plain];
  }
  if (!RUNNERS.has(program)) return [plain];
  const evalAt = rest.findIndex(w => EVAL_FLAGS.test(w));
  if (evalAt >= 0 && rest[evalAt + 1] !== undefined) return [plain, ...codeInvocations(rest[evalAt + 1]!)];
  const at = (n: number): string | undefined => {
    let seen = 0;
    for (let j = 0; j < rest.length; j++) {
      const arg = rest[j]!;
      if (arg.startsWith("-") && arg.length > 1) { if (!arg.includes("=") && RUNNER_VALUE_FLAGS.includes(arg)) j++; continue; }
      if (seen++ === n) return arg;
    }
    return undefined;
  };
  const indexOfWord = (word: string): number => rest.findIndex(w => w === word);
  const first = at(0);
  if (first === undefined) return [plain];
  const after = (word: string): Invocation[] => {
    const target = at(1);
    if (target === undefined) return [plain];
    const from = rest.indexOf(target, Math.max(0, indexOfWord(word)));
    return invocationsOf(rest.slice(from), depth + 1).map(inv => ({ ...inv, script: inv.script || !/[./]/.test(target) }));
  };
  if (["bun", "npm", "pnpm", "yarn", "deno"].includes(program) && ["run", "run-script", "x", "exec", "dlx"].includes(first)) return after(first);
  if (PACKAGE_RUNNERS.has(program)) return invocationsOf(rest.slice(rest.indexOf(first)), depth + 1);
  if (program === "npm" || program === "pnpm" || program === "yarn") return [plain];
  // bun / node / deno / tsx: the first positional is a script file, or for bun a package.json script by name.
  const file = rest.indexOf(first);
  return [{ program: basename(first), args: rest.slice(file + 1), code: false, script: program === "bun" && !/[./]/.test(first) }, plain];
}

function invocationsFromScript(script: string, depth: number): Invocation[] {
  return shellCommands(script).flatMap(command => invocationsOf(command, depth + 1));
}

function matches(sig: EffectSignature, inv: Invocation): boolean {
  if (!sig.tool.test(inv.program)) return false;
  if (sig.argvOnly && inv.code) return false;
  if (sig.runScript && !inv.script) return false;
  if (sig.anyArg && !inv.args.some(arg => sig.anyArg!.test(arg))) return false;
  if (sig.sub && !sig.sub.test(positionals(inv.args, sig.valueFlags, sig.leading).join(" "))) return false;
  if (sig.leading && NON_EXECUTING.has(inv.program)) return false;
  return true;
}

/** The known deploy/send/pay signatures an argv carries. Pure. */
export function argvSignatures(argv: readonly string[]): EffectSignature[] {
  const invocations = invocationsOf(argv);
  return EFFECT_SIGNATURES.filter(sig => invocations.some(inv => matches(sig, inv)));
}

export const DATA_CLASSES = ["public", "internal", "confidential", "restricted"] as const;
export type DataClass = (typeof DATA_CLASSES)[number];

export const RUNS_ON = ["local", "cloud"] as const;
export type RunsOn = (typeof RUNS_ON)[number];

export const MISSED_RUN = ["skip", "once"] as const;
export type MissedRun = (typeof MISSED_RUN)[number];

export const AFTER_STATUS = ["succeeded", "failed", "completed"] as const;
export type AfterStatus = (typeof AFTER_STATUS)[number];

export const RETRY_BACKOFF = ["fixed", "exponential"] as const;
export type RetryBackoff = (typeof RETRY_BACKOFF)[number];

export const SANDBOXES = ["read-only", "workspace-write"] as const;
export type Sandbox = (typeof SANDBOXES)[number];
/** What an agent step without a declared sandbox gets. */
export const DEFAULT_SANDBOX: Sandbox = "read-only";

export const ALERTS = ["critical", "high", "normal"] as const;
export type Alert = (typeof ALERTS)[number];

/** Longest workflow deadline and step timer: 24 hours. */
export const MAX_DEADLINE_MS = 86_400_000;
export const MAX_CONCURRENT_RUNS = 10;
export const MAX_QUEUE_SIZE = 10_000;

/**
 * The lanes a model or agent step may name: the OpenAI API lanes whose model
 * ids live in models.ts CROSS_VENDOR (openaiLow and openaiMedium are the low and medium
 * API lanes that replaced the retired luna and terra keys on 2026-10-07; Sol and Astra are the high and max lanes). A lane appears here only while models.ts
 * carries it, and no model id is ever written in this file.
 */
export const LANES: readonly string[] = ["openaiLow", "openaiMedium", "sol", "astra"].filter(lane => typeof CROSS_VENDOR[lane] === "string" && CROSS_VENDOR[lane].length > 0);

/** What a `human` step returns when its definition does not say otherwise. */
export const HUMAN_DECISION_SCHEMA = {
  type: "object",
  required: ["approved"],
  properties: { approved: { type: "boolean" }, note: { type: "string" } },
  additionalProperties: false,
} as const;

export type Executor = "code" | "judgment" | "model" | "human" | "unknown";
export const EXECUTOR_OF: Record<StepKind, Executor> = {
  action: "code",
  command: "code",
  model: "model",
  agent: "model",
  judgment: "judgment",
  human: "human",
  // A sub-workflow's executors are its own steps'; one label would misstate them.
  workflow: "unknown",
};

/* ── Shapes ─────────────────────────────────────────────────────────────── */

export type TriggerV2 = (
  /** body: "url" lets a cloud runner's POST /run also take a bare http(s) URL as the body, run as input {url} (a plain webhook caller, e.g. another app's Summarize button). */
  | { type: "manual"; body?: "url" }
  | { type: "schedule"; cron: string; timezone: string; missed_run: MissedRun }
  | { type: "once"; at: string; missed_run: MissedRun }
  | { type: "interval"; minutes: number; missed_run: MissedRun }
  | { type: "event"; name: string }
  | { type: "after"; workflow: string; status: AfterStatus }
  /** Cloud only: a Cloudflare queue delivers batches of messages. */
  | { type: "queue"; queue: string; batch_size: number }
) & {
  /** false pauses this trigger without deleting it; absent means enabled. */
  enabled?: boolean;
  /** schedule | once | interval: a missed occurrence older than this many minutes is skipped and recorded, never run (ISC-117). */
  grace_minutes?: number;
};

export interface StepV2 extends StepPolicy {
  id: string;
  kind: StepKind;
  description?: string;
  needs: string[];
  with?: unknown;
  when?: { ref: string; equals: unknown };
  side_effects: SideEffect[];
  recipient?: string;
  /**
   * Host authorities that approve this step in place of a human ancestor (ISC-253). Written as one name or a
   * non-empty list and always held as a list. They satisfy the side-effect rule only when the definition is
   * parsed for a host that registers every name; the embedded runner asks the host about each name before
   * the step runs and refuses the step on any no (ISC-254).
   */
  authority?: string[];
  /** action */
  uses?: string;
  /** command: the exact argv, never a shell string */
  argv?: string[];
  /** command: names of the environment variables the process receives (never values) */
  env?: string[];
  /** model | agent */
  lane?: string;
  /** model | agent | human */
  prompt?: string;
  /** judgment */
  question?: string;
  /** workflow */
  workflow?: string;
  /** Declared contracts (action steps take theirs from action.json instead). */
  input?: unknown;
  output?: unknown;
  /** Retry spacing: "fixed" (default) waits retry_delay_ms; "exponential" waits base x 2^(n-1), capped at retry_delay_max_ms. */
  retry_backoff?: RetryBackoff;
  retry_delay_max_ms?: number;
  /** Safe to repeat; required for a retried step with an outbound, money or deploy effect. */
  idempotent?: boolean;
  /** Knowledge domains this step reads. */
  domains?: string[];
  /** Resources the step needs: d1:<name>, queue:<name>, do:<class>, r2:<bucket>, or a secret name. */
  resources?: string[];
  /** judgment: the Glance caller that owns the question. */
  caller?: string;
  /** judgment: the `act` a `when:` reads while the caller is in shadow mode; the verdict gates only once the caller enforces (ISC-132). */
  fallback?: boolean;
  /** agent: allowlisted tools. */
  tools?: string[];
  /** agent: resolves to read-only when not declared. */
  sandbox?: Sandbox;
  /** model | agent | human: a markdown prompt file relative to the definitions home. */
  prompt_file?: string;
  /** Output fields declared format: artifact-ref, as dotted paths under the output schema. */
  artifact_refs?: string[];
}

export interface EvaluateConfig {
  /** Criteria file, relative to the definitions home. */
  criteria: string;
  lane: string;
  /** Share of runs sampled for evaluation, 0 to 1. */
  sample_rate: number;
  /** Minimum scored runs before a reader of the scores may act on them; nothing reads it today. */
  min_runs?: number;
}

export interface DefinitionV2 {
  /** The format the document was written in; v1 documents are lifted into this shape. */
  version: 1 | 2;
  name: string;
  description?: string;
  runs_on: RunsOn;
  sop?: string;
  /** Ideal-state row or goal ids (IS-NNNN) this workflow moves; read by the ideal-state pursuit graph. */
  serves?: string[];
  domains: string[];
  destination?: string;
  data_class: DataClass;
  triggers: TriggerV2[];
  defaults?: StepPolicy;
  concurrency?: number;
  input?: unknown;
  output?: unknown;
  /** Mapping that builds the run's output from step outputs (v1 called this `output`). */
  result?: unknown;
  /** A run still going after this many ms ends timed_out (at most 24 hours). */
  deadline_ms?: number;
  /** Runs of this workflow allowed at once, 1 to 10. */
  max_concurrent_runs: number;
  /** Runs allowed to wait for a slot, 0 to 10000. */
  queue_size: number;
  /** false pauses the whole workflow; absent means enabled. */
  enabled?: boolean;
  /** Severity a failed run's Vigil event carries. */
  alert: Alert;
  /** Monthly spend ceiling in US dollars. */
  budget_usd_month?: number;
  /** Secret NAMES the workflow needs (never values). A local workflow is invalid while one is absent from the local env (ISC-33). */
  secrets?: string[];
  evaluate?: EvaluateConfig;
  /** Hand-offs: the workflows this one hands work to and where the work waits (ISC-270). Description only; nothing runs on it (ISC-271). */
  feeds?: FeedV2[];
  steps: Record<string, StepV2>;
}

/** One hand-off: `workflow` picks up work this workflow leaves in `via` (a table, queue or store). */
export interface FeedV2 {
  workflow: string;
  via: string;
}

/* ── Keys ───────────────────────────────────────────────────────────────── */

const ROOT_KEYS = new Set([
  "version", "name", "description", "runs_on", "sop", "serves", "domains", "destination", "data_class",
  "triggers", "defaults", "concurrency", "input", "output", "result", "steps",
  "deadline_ms", "max_concurrent_runs", "queue_size", "enabled", "alert", "budget_usd_month", "evaluate", "secrets", "feeds",
]);
const COMMON_STEP_KEYS = [
  "kind", "description", "needs", "with", "when", "side_effects", "recipient", "timeout_ms", "retries", "retry_delay_ms", "on_error",
  "retry_backoff", "retry_delay_max_ms", "idempotent", "domains", "resources", "authority",
];
const KIND_KEYS: Record<StepKind, string[]> = {
  action: ["uses"],
  command: ["argv", "env", "input", "output"],
  model: ["lane", "prompt", "prompt_file", "input", "output"],
  agent: ["lane", "prompt", "prompt_file", "tools", "sandbox", "input", "output"],
  judgment: ["question", "caller", "fallback", "input", "output"],
  human: ["prompt", "prompt_file", "input", "output"],
  workflow: ["workflow"],
};
const EVALUATE_REQUIRED = ["criteria", "lane", "sample_rate"];
const EVALUATE_KEYS = [...EVALUATE_REQUIRED, "min_runs"];
const TRIGGER_KEYS: Record<TriggerV2["type"], string[]> = {
  manual: ["type", "body", "enabled"],
  schedule: ["type", "cron", "timezone", "missed_run", "grace_minutes", "enabled"],
  once: ["type", "at", "missed_run", "grace_minutes", "enabled"],
  interval: ["type", "minutes", "missed_run", "grace_minutes", "enabled"],
  event: ["type", "name", "enabled"],
  after: ["type", "workflow", "status", "enabled"],
  queue: ["type", "queue", "batch_size", "enabled"],
};
const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor"]);
/** One year; anything longer is a schedule, not an interval. */
const MAX_INTERVAL_MINUTES = 525_600;
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;

/* ── Small guards ───────────────────────────────────────────────────────── */

/** Rejects the document. Give `path` and `code` for a located error; without them the sentence is located from its wording. */
const fail = (message: string, path?: string, code?: string): never => {
  throw new DefinitionError(message, path, code);
};
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) fail(`${label} must be an object.`);
  return value as Record<string, unknown>;
}
function keysWithin(value: Record<string, unknown>, allowed: Iterable<string>, label: string): void {
  const set = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (UNSAFE_KEYS.has(key)) fail(`${label} contains unsafe key "${key}".`);
    if (!set.has(key)) fail(`${label} has unknown key "${key}".`);
  }
}
function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) fail(`${label} must be a non-empty string.`);
  return value as string;
}
function optionalText(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : text(value, label);
}
function oneOf<T extends string>(value: unknown, allowed: readonly T[], label: string, path?: string): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) fail(`${label} must be one of ${allowed.join(", ")}.`, path, "invalid-value");
  return value as T;
}
/** A whole number in [min, max], rejected with the located path. */
function wholeNumber(value: unknown, min: number, max: number, label: string, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) fail(`${label} must be a whole number from ${min} to ${max}.`, path, "out-of-range");
  return value as number;
}
function flag(value: unknown, label: string, path: string): boolean {
  if (typeof value !== "boolean") fail(`${label} must be true or false.`, path, "invalid-type");
  return value as boolean;
}
/** A list of unique non-empty strings. */
function stringList(value: unknown, label: string, path: string): string[] {
  if (!Array.isArray(value)) fail(`${label} must be a list.`, path, "invalid-type");
  const items = (value as unknown[]).map((item, i) => {
    if (typeof item !== "string" || !item.trim()) fail(`${label} entry ${i + 1} must be a non-empty string.`, `${path}.${i}`, "invalid-type");
    return item as string;
  });
  if (new Set(items).size !== items.length) fail(`${label} lists an entry more than once.`, path, "duplicate");
  return items;
}
/** The located path of a trigger from its "Trigger N" label. */
const triggerPath = (label: string): string => {
  const n = label.match(/^Trigger (\d+)/)?.[1];
  return n ? `triggers.${Number(n) - 1}` : "triggers";
};
function schema(value: unknown, label: string): unknown {
  try {
    assertSchema(value);
  } catch (error) {
    fail(`${label}: ${message(error)}`);
  }
  return value;
}
export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/* ── Triggers ───────────────────────────────────────────────────────────── */

/** A one-step v1 document used only to put a cron through the v1 trigger validator. */
export function v1ScheduleProbe(cron: string, timezone: string): V1Workflow {
  return { version: 1, name: "schedule-probe", trigger: { type: "schedule", cron, timezone }, steps: { probe: { uses: "probe" } } };
}

export function parseTrigger(value: unknown, label: string): TriggerV2 {
  const t = record(value, label);
  const type = oneOf(t.type, Object.keys(TRIGGER_KEYS) as TriggerV2["type"][], `${label} type`);
  keysWithin(t, TRIGGER_KEYS[type], label);
  const at = triggerPath(label);
  const enabled = t.enabled === undefined ? {} : { enabled: flag(t.enabled, `${label} enabled`, `${at}.enabled`) };
  const grace = t.grace_minutes === undefined ? {} : { grace_minutes: wholeNumber(t.grace_minutes, 0, MAX_INTERVAL_MINUTES, `${label} grace_minutes`, `${at}.grace_minutes`) };
  return { ...parseTriggerBody(t, type, label, at), ...grace, ...enabled } as TriggerV2;
}

function parseTriggerBody(t: Record<string, unknown>, type: TriggerV2["type"], label: string, at: string): TriggerV2 {
  const missed = (): MissedRun => (t.missed_run === undefined ? "skip" : oneOf(t.missed_run, MISSED_RUN, `${label} missed_run`));
  switch (type) {
    case "manual":
      return t.body === undefined ? { type } : { type, body: oneOf(t.body, ["url"] as const, `${label} body`) };
    case "queue": {
      const queue = text(t.queue, `${label} queue`);
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(queue)) fail(`${label} queue "${queue}" is not a queue name.`, `${at}.queue`, "invalid-value");
      // Cloudflare delivers at most 100 messages per batch; 10 is its default.
      const batch_size = t.batch_size === undefined ? 10 : wholeNumber(t.batch_size, 1, 100, `${label} batch_size`, `${at}.batch_size`);
      return { type, queue, batch_size };
    }
    case "schedule": {
      const cron = text(t.cron, `${label} cron`);
      const timezone = text(t.timezone, `${label} timezone`);
      try {
        // `principal` is the principal's current zone, read at each wake (schedule.ts zoneOf); any zone validates the cron.
        const probe = v1ScheduleProbe(cron, timezone === PRINCIPAL_TIMEZONE ? "UTC" : timezone);
        parseWorkflow(probe);
        validateV1Trigger(probe);
      } catch (error) {
        fail(`${label}: ${message(error)}`);
      }
      return { type, cron, timezone, missed_run: missed() };
    }
    case "once": {
      const at = text(t.at, `${label} at`);
      if (!ISO_WITH_OFFSET.test(at) || !Number.isFinite(Date.parse(at))) fail(`${label} at must be an ISO time with a timezone offset, like 2026-10-01T09:00:00-07:00.`);
      return { type, at, missed_run: missed() };
    }
    case "interval": {
      const minutes = t.minutes;
      if (!Number.isSafeInteger(minutes) || (minutes as number) < 1 || (minutes as number) > MAX_INTERVAL_MINUTES) fail(`${label} minutes must be a whole number from 1 to ${MAX_INTERVAL_MINUTES}.`);
      return { type, minutes: minutes as number, missed_run: missed() };
    }
    case "event":
      return { type, name: text(t.name, `${label} name`) };
    case "after": {
      const workflow = text(t.workflow, `${label} workflow`);
      if (!NAME_RE.test(workflow)) fail(`${label} workflow "${workflow}" is not a workflow name.`);
      return { type, workflow, status: t.status === undefined ? "succeeded" : oneOf(t.status, AFTER_STATUS, `${label} status`) };
    }
  }
}

/* ── Steps ──────────────────────────────────────────────────────────────── */

function parseStep(id: string, value: unknown): StepV2 {
  const label = `Step "${id}"`;
  const s = record(value, label);
  const kind: StepKind = s.kind === undefined
    ? (s.uses !== undefined ? "action" : fail(`${label} needs a kind (${STEP_KINDS.join(", ")}).`))
    : oneOf(s.kind, STEP_KINDS, `${label} kind`);
  keysWithin(s, [...COMMON_STEP_KEYS, ...KIND_KEYS[kind]], `${label} (${kind})`);

  let side_effects: SideEffect[] = [];
  if (s.side_effects !== undefined) {
    if (!Array.isArray(s.side_effects)) fail(`${label} side_effects must be a list.`);
    side_effects = (s.side_effects as unknown[]).map(e => oneOf(e, SIDE_EFFECTS, `${label} side effect`));
    if (new Set(side_effects).size !== side_effects.length) fail(`${label} lists a side effect more than once.`);
    if (side_effects.includes("none") && side_effects.length > 1) fail(`${label} side_effects cannot combine none with another effect.`);
  }
  const recipient = optionalText(s.recipient, `${label} recipient`);
  if (recipient !== undefined && !side_effects.includes("outbound")) fail(`${label} recipient applies only to a step with the outbound side effect.`);

  let authority: string[] | undefined;
  if (s.authority !== undefined) {
    authority = typeof s.authority === "string"
      ? [text(s.authority, `${label} authority`)]
      : stringList(s.authority, `${label} authority`, `steps.${id}.authority`);
    if (authority.length === 0) fail(`${label} authority must be a name or a non-empty list of names.`, `steps.${id}.authority`, "invalid-value");
  }

  const step: StepV2 = {
    id, kind, needs: [], side_effects,
    ...(recipient !== undefined ? { recipient } : {}),
    ...(authority !== undefined ? { authority } : {}),
    ...(s.description !== undefined ? { description: text(s.description, `${label} description`) } : {}),
  };
  // needs / with / when / policy keys are checked by the v1 engine on the compiled graph.
  if (s.needs !== undefined) {
    if (!Array.isArray(s.needs)) fail(`${label} needs must be a list.`);
    step.needs = (s.needs as unknown[]).map(n => text(n, `Dependency of ${label}`));
  }
  for (const key of ["with", "when", "timeout_ms", "retries", "retry_delay_ms", "on_error"] as const) {
    if (s[key] !== undefined) (step as unknown as Record<string, unknown>)[key] = s[key];
  }
  const where = `steps.${id}`;
  if (s.retry_backoff !== undefined) step.retry_backoff = oneOf(s.retry_backoff, RETRY_BACKOFF, `${label} retry_backoff`, `${where}.retry_backoff`);
  if (s.retry_delay_max_ms !== undefined) {
    if (step.retry_backoff !== "exponential") fail(`${label} retry_delay_max_ms applies only with retry_backoff: exponential.`, `${where}.retry_delay_max_ms`, "invalid-value");
    step.retry_delay_max_ms = wholeNumber(s.retry_delay_max_ms, 1, MAX_DEADLINE_MS, `${label} retry_delay_max_ms`, `${where}.retry_delay_max_ms`);
    const base = s.retry_delay_ms;
    if (typeof base === "number" && base > step.retry_delay_max_ms) fail(`${label} retry_delay_max_ms must not be below retry_delay_ms.`, `${where}.retry_delay_max_ms`, "out-of-range");
  }
  if (s.idempotent !== undefined) step.idempotent = flag(s.idempotent, `${label} idempotent`, `${where}.idempotent`);
  if (s.domains !== undefined) step.domains = stringList(s.domains, `${label} domains`, `${where}.domains`);
  if (s.resources !== undefined) {
    step.resources = stringList(s.resources, `${label} resources`, `${where}.resources`);
    for (const [i, resource] of step.resources.entries()) {
      if (!isResource(resource)) fail(`${label} resource "${resource}" must be d1:<name>, queue:<name>, do:<class>, r2:<bucket> or a SECRET_NAME.`, `${where}.resources.${i}`, "invalid-resource");
    }
  }

  switch (kind) {
    case "action":
      step.uses = text(s.uses, `${label} uses`);
      break;
    case "command": {
      if (!Array.isArray(s.argv) || s.argv.length === 0) fail(`${label} argv must be a non-empty list of strings; commands never run through a shell.`);
      const argv = s.argv as unknown[];
      for (const [i, part] of argv.entries()) {
        if (typeof part !== "string") fail(`${label} argv[${i}] must be a string.`);
        if ((part as string).includes("\0")) fail(`${label} argv[${i}] contains a NUL byte.`);
      }
      if (!(argv[0] as string).trim()) fail(`${label} argv[0] must name a program.`);
      step.argv = argv as string[];
      // An undeclared effect would skip the human gate below, so a command step always says what it touches.
      if (s.side_effects === undefined) {
        fail(`${label} is a command step and must declare side_effects: what it touches (read, write, outbound, money, deploy), or [none].`, `${where}.side_effects`, "missing-side-effects");
      }
      for (const sig of argvSignatures(step.argv)) {
        if (!side_effects.includes(sig.effect)) {
          fail(`${label} argv runs ${sig.label}, which is a ${sig.effect} action; declare side_effects including ${sig.effect}.`, `${where}.side_effects`, "undeclared-side-effect");
        }
        // recipient: principal skips the human gate, so it cannot stand beside a sender that names its own destination.
        if (recipient === PRINCIPAL_RECIPIENT && sig.effect === "outbound" && !sig.principalPinned) {
          fail(`${label} argv runs ${sig.label}, which can reach anyone; recipient: ${PRINCIPAL_RECIPIENT} is allowed only with the principal-pinned Relay sender. Put a human approval step among its ancestors instead.`, `${where}.recipient`, "unpinned-principal-recipient");
        }
      }
      if (s.env !== undefined) {
        const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
        if (Array.isArray(s.env)) {
          for (const [i, name] of (s.env as unknown[]).entries()) {
            if (typeof name !== "string" || !ENV_NAME.test(name)) fail(`${label} env[${i}] must be an environment variable name.`);
          }
        } else if (isRecord(s.env)) {
          for (const [name, value] of Object.entries(s.env)) {
            if (!ENV_NAME.test(name)) fail(`${label} env key "${name}" must be an environment variable name.`);
            if (typeof value !== "string") fail(`${label} env value for "${name}" must be a string.`);
          }
        } else fail(`${label} env must be a list of variable names (or a map of literal values).`);
        step.env = s.env as string[];
      }
      break;
    }
    case "model":
    case "agent":
      if (s.lane === undefined) fail(`${label} is a ${kind} step and must name a lane (${LANES.join(", ")}).`);
      step.lane = oneOf(s.lane, LANES, `${label} lane`);
      parsePrompt(step, s, label);
      if (kind === "agent") {
        if (s.tools !== undefined) step.tools = stringList(s.tools, `${label} tools`, `${where}.tools`);
        step.sandbox = s.sandbox === undefined ? DEFAULT_SANDBOX : oneOf(s.sandbox, SANDBOXES, `${label} sandbox`, `${where}.sandbox`);
      }
      if (s.output === undefined) fail(`${label} is a ${kind} step and must declare an output schema.`);
      break;
    case "judgment":
      step.question = text(s.question, `${label} question`);
      if (s.caller !== undefined) step.caller = text(s.caller, `${label} caller`);
      if (s.fallback !== undefined) step.fallback = flag(s.fallback, `${label} fallback`, `${where}.fallback`);
      if (s.output === undefined) fail(`${label} is a judgment step and must declare an output schema.`);
      break;
    case "human":
      parsePrompt(step, s, label);
      break;
    case "workflow": {
      const name = text(s.workflow, `${label} workflow`);
      if (!NAME_RE.test(name)) fail(`${label} workflow "${name}" is not a workflow name.`);
      step.workflow = name;
      break;
    }
  }
  if (s.input !== undefined) step.input = schema(s.input, `${label} input schema`);
  if (s.output !== undefined) step.output = schema(s.output, `${label} output schema`);
  if (kind === "human" && step.output === undefined) step.output = structuredClone(HUMAN_DECISION_SCHEMA);
  if (step.output !== undefined) {
    const refs = artifactRefFields(step.output);
    for (const field of refs.badType) fail(`${label} output field "${field}" is format artifact-ref, which needs type string.`, `${where}.output.${field}`, "invalid-artifact-ref");
    if (refs.fields.length) step.artifact_refs = refs.fields;
  }
  refuseSecretLiterals(step, label);
  return step;
}

/** A step's prompt is inline text or a markdown file under the definitions home, never both and never neither. */
function parsePrompt(step: StepV2, s: Record<string, unknown>, label: string): void {
  const where = `steps.${step.id}`;
  if (s.prompt !== undefined && s.prompt_file !== undefined) fail(`${label} declares both prompt and prompt_file; use one.`, `${where}.prompt_file`, "conflicting-fields");
  if (s.prompt_file !== undefined) {
    const file = text(s.prompt_file, `${label} prompt_file`);
    const bad = promptFileShape(file);
    if (bad) fail(`${label} prompt_file "${file}" ${bad}.`, `${where}.prompt_file`, "invalid-prompt-file");
    step.prompt_file = file;
    return;
  }
  step.prompt = text(s.prompt, `${label} prompt`);
}

/** Secrets appear in a definition only as names. A literal shaped like a credential in with, argv or prompt is refused (the message never echoes the value). */
function refuseSecretLiterals(step: StepV2, label: string): void {
  const where = `steps.${step.id}`;
  const scan: Array<{ at: string; text: string }> = [
    ...stringLeaves(step.with, `${where}.with`),
    ...(step.argv ?? []).map((text, i) => ({ at: `${where}.argv.${i}`, text })),
    ...(step.prompt !== undefined ? [{ at: `${where}.prompt`, text: step.prompt }] : []),
  ];
  for (const leaf of scan) {
    const shape = secretShape(leaf.text);
    if (shape) fail(`${label} has a secret-shaped literal (${shape}) at ${leaf.at}; reference a secret by name instead.`, leaf.at, "secret-literal");
  }
}

/* ── Compile to v1 (graph validation and execution both use the v1 engine) ─ */

/** The v1 action name a compiled step is registered under; step ids are unique, so these are too. */
export const compiledUses = (id: string): string => `step:${id}`;

export function toV1(def: DefinitionV2): V1Workflow {
  const steps: Record<string, V1Step> = {};
  for (const step of Object.values(def.steps)) {
    const v1: V1Step = { uses: compiledUses(step.id) };
    if (step.needs.length) v1.needs = [...step.needs];
    // `trigger.<f>` is v2 vocabulary; the compiled graph reads it from the reserved input key the runner fills.
    if (step.with !== undefined) v1.with = rewriteTriggerRefs(step.with);
    if (step.when !== undefined) v1.when = isTriggerRef(step.when.ref) ? { ...step.when, ref: `input.${TRIGGER_INPUT_KEY}${step.when.ref.slice("trigger".length)}` } : step.when;
    for (const key of ["timeout_ms", "retries", "retry_delay_ms", "on_error"] as const) {
      if (step[key] !== undefined) (v1 as unknown as Record<string, unknown>)[key] = step[key];
    }
    steps[step.id] = v1;
  }
  const workflow: V1Workflow = { version: 1, name: def.name, steps };
  if (def.description !== undefined) workflow.description = def.description;
  if (def.defaults !== undefined) workflow.defaults = def.defaults;
  if (def.concurrency !== undefined) workflow.concurrency = def.concurrency;
  if (def.input !== undefined) workflow.input = def.input;
  if (def.result !== undefined) workflow.output = rewriteTriggerRefs(def.result);
  return workflow;
}

/** Every step id upstream of each step, following `needs` transitively. Assumes an acyclic graph. */
export function ancestorsOf(def: DefinitionV2): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const visit = (id: string): Set<string> => {
    const cached = out.get(id);
    if (cached) return cached;
    const set = new Set<string>();
    out.set(id, set);
    for (const dep of def.steps[id]?.needs ?? []) {
      set.add(dep);
      for (const a of visit(dep)) set.add(a);
    }
    return set;
  };
  for (const id of Object.keys(def.steps)) visit(id);
  return out;
}

/* ── Parse ──────────────────────────────────────────────────────────────── */

function parseEvaluate(value: unknown): EvaluateConfig {
  const e = record(value, "Workflow evaluate");
  keysWithin(e, EVALUATE_KEYS, "Workflow evaluate");
  for (const key of EVALUATE_REQUIRED) if (e[key] === undefined) fail(`Workflow evaluate must declare ${key}.`, `evaluate.${key}`, "missing-field");
  const criteria = text(e.criteria, "Workflow evaluate criteria");
  const bad = promptFileShape(criteria);
  if (bad) fail(`Workflow evaluate criteria "${criteria}" ${bad}.`, "evaluate.criteria", "invalid-prompt-file");
  const lane = oneOf(e.lane, LANES, "Workflow evaluate lane", "evaluate.lane");
  const rate = e.sample_rate;
  if (typeof rate !== "number" || !Number.isFinite(rate) || rate < 0 || rate > 1) fail("Workflow evaluate sample_rate must be a number from 0 to 1.", "evaluate.sample_rate", "out-of-range");
  const min = e.min_runs === undefined ? {} : { min_runs: wholeNumber(e.min_runs, 1, 1_000_000, "Workflow evaluate min_runs", "evaluate.min_runs") };
  return { criteria, lane, sample_rate: rate as number, ...min };
}

/** The trigger kinds whose runs a reference must be valid for: the enabled ones, or all of them when every trigger is paused. */
const liveTriggers = (def: DefinitionV2): TriggerV2[] => {
  const live = def.triggers.filter(t => t.enabled !== false);
  return live.length ? live : def.triggers;
};

/** Rules that read across the whole document (ISC-42, 53, 56, 58, 63). Pure. */
function crossChecks(def: DefinitionV2): void {
  // ISC-63: a queue trigger exists only where Cloudflare queues do.
  for (const [i, t] of def.triggers.entries()) {
    if (t.type === "queue" && def.runs_on === "local") fail(`Trigger ${i + 1} is a queue trigger, which needs runs_on: cloud.`, `triggers.${i}.type`, "cloud-only-trigger");
    if (t.type === "schedule" && t.timezone === PRINCIPAL_TIMEZONE && def.runs_on === "cloud") fail(`Trigger ${i + 1} uses timezone: ${PRINCIPAL_TIMEZONE}, which only a local run can read (the location service lives on this Mac); set runs_on: local or name an IANA zone.`, `triggers.${i}.timezone`, "local-only-timezone");
  }

  for (const step of Object.values(def.steps)) {
    const where = `steps.${step.id}`;
    // ISC-42: a cloud-only resource cannot be reached from a local run.
    if (def.runs_on === "local") {
      for (const [i, resource] of (step.resources ?? []).entries()) {
        if (isCloudOnly(resource)) fail(`Step "${step.id}" needs ${resource}, which exists only in the cloud; set runs_on: cloud.`, `${where}.resources.${i}`, "cloud-only-resource");
      }
    }
    // ISC-53: a repeated outbound, money or deploy step must be safe to repeat.
    const retries = step.retries ?? def.defaults?.retries ?? 0;
    const gated = step.side_effects.filter(e => GATED_EFFECTS.includes(e));
    if (retries > 0 && gated.length && step.idempotent !== true) {
      fail(`Step "${step.id}" retries and declares side effects ${gated.join(", ")}; declare idempotent: true or remove the retries.`, `${where}.idempotent`, "idempotent-required");
    }
  }

  // ISC-58: the workflow's domains are exactly the union of its steps' domains, once any step declares one.
  const declared = Object.values(def.steps).flatMap(step => step.domains ?? []);
  if (declared.length) {
    const union = [...new Set(declared)].sort();
    const own = [...def.domains].sort();
    if (union.length !== own.length || union.some((d, i) => d !== own[i])) {
      fail(`Workflow domains (${own.join(", ") || "none"}) must equal the union of its steps' domains (${union.join(", ")}).`, "domains", "domains-mismatch");
    }
  }

  // ISC-56: a trigger reference must name a field every live trigger kind provides.
  const live = liveTriggers(def);
  const check = (ref: string, at: string) => {
    const field = ref.split(".")[1];
    if (ref === "trigger" || !field) fail(`Reference "${ref}" at ${at} must name a trigger field (${ALL_TRIGGER_FIELDS.join(", ")}).`, at, "invalid-reference");
    if (ref.split(".").length > 2 || !(ALL_TRIGGER_FIELDS as readonly string[]).includes(field)) {
      fail(`Reference "${ref}" at ${at} names no trigger field; the fields are ${ALL_TRIGGER_FIELDS.join(", ")}.`, at, "unknown-trigger-field");
    }
    for (const t of live) {
      if (!TRIGGER_FIELDS[t.type].includes(field)) fail(`Reference "${ref}" at ${at} reads trigger.${field}, which a ${t.type} trigger does not provide.`, at, "trigger-field-unavailable");
    }
  };
  for (const step of Object.values(def.steps)) {
    for (const { at, ref } of refsUnder(step.with, `steps.${step.id}.with`)) if (isTriggerRef(ref)) check(ref, at);
    if (step.when && isTriggerRef(step.when.ref)) check(step.when.ref, `steps.${step.id}.when.ref`);
  }
  for (const { at, ref } of refsUnder(def.result, "result")) if (isTriggerRef(ref)) check(ref, at);
}

function parseV2(value: Record<string, unknown>, stem: string | null, opts: ParseOptions): DefinitionV2 {
  keysWithin(value, ROOT_KEYS, "Workflow");
  const name = text(value.name, "Workflow name");
  if (!NAME_RE.test(name)) fail(`Workflow name "${name}" must be lowercase letters, digits and hyphens.`);
  if (stem !== null && stem !== name) fail(`Workflow name "${name}" does not match its file name "${stem}.workflow.yaml".`);
  if (value.runs_on === undefined) fail(`Workflow must declare runs_on (${RUNS_ON.join(" or ")}).`);
  const def: DefinitionV2 = {
    version: 2,
    name,
    runs_on: oneOf(value.runs_on, RUNS_ON, "Workflow runs_on"),
    domains: [],
    data_class: value.data_class === undefined ? "internal" : oneOf(value.data_class, DATA_CLASSES, "Workflow data_class"),
    triggers: [{ type: "manual" }],
    max_concurrent_runs: 1,
    queue_size: 0,
    alert: "normal",
    steps: {},
  };
  if (value.description !== undefined) def.description = text(value.description, "Workflow description");
  if (value.deadline_ms !== undefined) def.deadline_ms = wholeNumber(value.deadline_ms, 1, MAX_DEADLINE_MS, "Workflow deadline_ms", "deadline_ms");
  if (value.max_concurrent_runs !== undefined) def.max_concurrent_runs = wholeNumber(value.max_concurrent_runs, 1, MAX_CONCURRENT_RUNS, "Workflow max_concurrent_runs", "max_concurrent_runs");
  if (value.queue_size !== undefined) def.queue_size = wholeNumber(value.queue_size, 0, MAX_QUEUE_SIZE, "Workflow queue_size", "queue_size");
  if (value.enabled !== undefined) def.enabled = flag(value.enabled, "Workflow enabled", "enabled");
  if (value.alert !== undefined) def.alert = oneOf(value.alert, ALERTS, "Workflow alert", "alert");
  if (value.budget_usd_month !== undefined) {
    const budget = value.budget_usd_month;
    if (typeof budget !== "number" || !Number.isFinite(budget) || budget <= 0) fail("Workflow budget_usd_month must be a positive number of US dollars.", "budget_usd_month", "out-of-range");
    def.budget_usd_month = budget as number;
  }
  if (value.evaluate !== undefined) def.evaluate = parseEvaluate(value.evaluate);
  if (value.secrets !== undefined) {
    def.secrets = stringList(value.secrets, "Workflow secrets", "secrets");
    for (const [i, secret] of def.secrets.entries()) {
      if (!SECRET_NAME_RE.test(secret)) fail(`Workflow secrets entry "${secret}" must be a secret NAME such as MY_API_KEY, never a value.`, `secrets.${i}`, "invalid-secret-name");
    }
  }
  if (value.sop !== undefined) def.sop = text(value.sop, "Workflow sop");
  if (value.serves !== undefined) {
    const serves = typeof value.serves === "string" ? [value.serves] : value.serves;
    if (!Array.isArray(serves) || !serves.every((id) => typeof id === "string" && /^IS-\d{4,}$/.test(id))) fail("Workflow serves must be an ideal-state id such as IS-0007, or a list of them.", "serves", "invalid-serves");
    def.serves = serves as string[];
  }
  if (value.destination !== undefined) def.destination = text(value.destination, "Workflow destination");
  if (value.domains !== undefined) {
    if (!Array.isArray(value.domains)) fail("Workflow domains must be a list.");
    def.domains = (value.domains as unknown[]).map(d => text(d, "Workflow domain"));
    if (new Set(def.domains).size !== def.domains.length) fail("Workflow domains lists a domain more than once.");
  }
  if (value.triggers !== undefined) {
    if (!Array.isArray(value.triggers) || value.triggers.length === 0) fail("Workflow triggers must be a non-empty list.");
    def.triggers = (value.triggers as unknown[]).map((t, i) => parseTrigger(t, `Trigger ${i + 1}`));
    for (const t of def.triggers) if (t.type === "after" && t.workflow === name) fail(`Workflow "${name}" cannot run after itself.`);
  }
  if (value.feeds !== undefined) {
    if (!Array.isArray(value.feeds)) fail("Workflow feeds must be a list of {workflow, via}.", "feeds", "invalid-value");
    const seen = new Set<string>();
    def.feeds = (value.feeds as unknown[]).map((f, i) => {
      const label = `Workflow feeds entry ${i + 1}`;
      const r = record(f, label);
      keysWithin(r, ["workflow", "via"], label);
      const workflow = text(r.workflow, `${label} workflow`);
      if (!NAME_RE.test(workflow)) fail(`${label} workflow "${workflow}" is not a workflow name.`, `feeds.${i}.workflow`, "invalid-value");
      if (workflow === name) fail(`Workflow "${name}" cannot feed itself.`, `feeds.${i}.workflow`, "invalid-value");
      const via = text(r.via, `${label} via`);
      const key = `${workflow}\u0000${via}`;
      if (seen.has(key)) fail(`${label} repeats the hand-off to "${workflow}" via "${via}".`, `feeds.${i}`, "invalid-value");
      seen.add(key);
      return { workflow, via };
    });
  }
  if (value.defaults !== undefined) def.defaults = value.defaults as StepPolicy;
  if (value.concurrency !== undefined) def.concurrency = value.concurrency as number;
  if (value.input !== undefined) def.input = schema(value.input, "Workflow input schema");
  if (value.output !== undefined) def.output = schema(value.output, "Workflow output schema");
  if (value.result !== undefined) def.result = value.result;
  const steps = record(value.steps, "Workflow steps");
  if (Object.keys(steps).length === 0) fail("Workflow must contain at least one step.");
  for (const [id, step] of Object.entries(steps)) {
    if (UNSAFE_KEYS.has(id)) fail(`Step id "${id}" is unsafe.`);
    def.steps[id] = parseStep(id, step);
    if (def.steps[id].kind === "workflow" && def.steps[id].workflow === name) fail(`Step "${id}" runs its own workflow "${name}".`);
  }

  crossChecks(def);

  // Graph structure, reference scope and step policy: the v1 engine is the one judge.
  try {
    validateWorkflow(toV1(def));
  } catch (error) {
    fail(message(error));
  }

  // ISC-253: parsed for a host, every authority a step names must be one that host registers.
  const authorities = opts.authorities === undefined ? null : new Set(opts.authorities);
  if (authorities !== null) {
    for (const step of Object.values(def.steps)) {
      for (const name of step.authority ?? []) {
        if (!authorities.has(name)) fail(`Step "${step.id}" names authority "${name}", which this host does not register.`, `steps.${step.id}.authority`, "unknown-authority");
      }
    }
  }

  // Anything that reaches outside needs a human approval upstream, enforced here rather than in prose; the
  // runner then refuses the step unless every one of those approvals answered approved: true (approvalGates).
  // A host-registered authority stands in for that human only when the definition is parsed for that host (ISC-253).
  for (const [id, humans] of approvalGates(def)) {
    const step = def.steps[id];
    if (authorities !== null && step.authority !== undefined && step.authority.every(name => authorities.has(name))) continue;
    if (!humans.length) {
      const gated = step.side_effects.filter(e => GATED_EFFECTS.includes(e));
      const why = gated.includes("outbound") && gated.length === 1
        ? ` (outbound is exempt only with recipient: ${PRINCIPAL_RECIPIENT})`
        : "";
      fail(`Step "${step.id}" declares side effects ${gated.join(", ")} but no human step is among its ancestors${why}. A human step counts only when its answer requires a boolean "approved", as the default human output does.`);
    }
  }
  return def;
}

/** True when a step is a human step whose answer carries a required boolean `approved` (the default human output does). */
export function carriesApproval(step: StepV2): boolean {
  if (step.kind !== "human") return false;
  const out = step.output as { required?: unknown; properties?: Record<string, { type?: unknown }> } | undefined;
  return Array.isArray(out?.required) && out.required.includes("approved") && out.properties?.approved?.type === "boolean";
}

/**
 * The approval each gated step waits on: for every step with an outbound, money or deploy side effect that is
 * not the principal-recipient outbound exemption, the human ancestors whose answer carries `approved`. The
 * validator needs at least one; the runner refuses the step unless every one of them answered approved: true,
 * so a decline can never reach the side effect even when the author wrote no `when`. Pure.
 */
export function approvalGates(def: DefinitionV2): Map<string, string[]> {
  const ancestors = ancestorsOf(def);
  const out = new Map<string, string[]>();
  for (const step of Object.values(def.steps)) {
    const gated = step.side_effects.filter(e => GATED_EFFECTS.includes(e));
    if (!gated.length) continue;
    if (gated.every(e => e === "outbound") && step.recipient === PRINCIPAL_RECIPIENT) continue;
    out.set(step.id, [...(ancestors.get(step.id) ?? [])].filter(a => carriesApproval(def.steps[a])).sort());
  }
  return out;
}

/**
 * Why a gated step must not run, given the approvals it waits on (from approvalGates) and the answers so far;
 * null only when there is at least one approval and every one answered approved: true. Fails closed: a missing
 * answer or an empty approval list is a refusal. Every runner that executes human steps calls this. Pure.
 */
export function approvalRefusal(stepId: string, approvals: readonly string[], answerOf: (id: string) => unknown): string | null {
  if (!approvals.length) return `Step "${stepId}" was not run: it has an outbound, money or deploy side effect and no human approval among its ancestors.`;
  for (const id of approvals) {
    const answer = answerOf(id) as { approved?: unknown; note?: unknown } | undefined;
    if (answer?.approved === true) continue;
    const note = typeof answer?.note === "string" && answer.note.trim() ? ` (note: ${answer.note.trim()})` : "";
    return answer?.approved === false
      ? `Step "${stepId}" was not run: human step "${id}" declined${note}. Add when: {ref: steps.${id}.output.approved, equals: true} to skip it cleanly instead.`
      : `Step "${stepId}" was not run: human step "${id}" has no approved: true answer.`;
  }
  return null;
}

/** Lifts a v1 document (already accepted by the v1 loader) into the v2 shape. */
function liftV1(v1: V1Workflow): DefinitionV2 {
  const triggers: TriggerV2[] = [];
  const t = v1.trigger ?? { type: "manual" as const };
  if (t.type === "schedule") triggers.push({ type: "schedule", cron: t.cron, timezone: t.timezone, missed_run: "skip" });
  else if (t.type === "event") triggers.push({ type: "event", name: t.name });
  else triggers.push({ type: "manual" });
  const steps: Record<string, StepV2> = {};
  for (const [id, s] of Object.entries(v1.steps)) {
    const step: StepV2 = { id, kind: "action", uses: s.uses, needs: [...(s.needs ?? [])], side_effects: [] };
    if (s.with !== undefined) step.with = s.with;
    if (s.when !== undefined) step.when = s.when;
    for (const key of ["timeout_ms", "retries", "retry_delay_ms", "on_error"] as const) {
      if (s[key] !== undefined) (step as unknown as Record<string, unknown>)[key] = s[key];
    }
    steps[id] = step;
  }
  const def: DefinitionV2 = {
    version: 1,
    name: v1.name,
    // v1 carries no runs_on; the v1 CLI runs a v1 document locally.
    runs_on: "local",
    domains: [],
    data_class: "internal",
    triggers,
    max_concurrent_runs: 1,
    queue_size: 0,
    alert: "normal",
    steps,
  };
  if (v1.description !== undefined) def.description = v1.description;
  if (v1.defaults !== undefined) def.defaults = v1.defaults;
  if (v1.concurrency !== undefined) def.concurrency = v1.concurrency;
  if (v1.input !== undefined) def.input = v1.input;
  if (v1.output !== undefined) def.result = v1.output;
  return def;
}

export interface ParseOptions {
  /**
   * Authority names the host this definition is parsed for registers (ISC-253). Absent means no host:
   * an `authority:` field then satisfies nothing and the side-effect rule needs a human ancestor as always.
   */
  authorities?: Iterable<string>;
}

/**
 * Parses one YAML document into a definition, or throws DefinitionError.
 * `source` is the file path when there is one: a `<name>.workflow.yaml` file
 * must carry that name.
 */
export function parseDefinitionText(yamlText: string, source?: string, opts: ParseOptions = {}): DefinitionV2 {
  const doc = parseDocument(yamlText, { uniqueKeys: true, version: "1.2" });
  if (doc.errors.length || doc.warnings.length) fail([...doc.errors, ...doc.warnings].map(e => e.message).join("; "));
  let value: unknown;
  try {
    value = doc.toJS({ maxAliasCount: 0 });
  } catch (error) {
    fail(message(error));
  }
  const root = record(value, "Workflow");
  if (root.version === 1) {
    // The exact v1 verdict: the v1 loader parses the same text itself.
    try {
      return liftV1(parseV1Yaml(yamlText));
    } catch (error) {
      fail(message(error));
    }
  }
  if (root.version !== 2) fail("Workflow version must be 1 or 2.");
  return parseV2(root, source ? stemOf(source) : null, opts);
}

export interface LoadedDefinition {
  path: string;
  text: string;
  /** sha256 of the file bytes as read. */
  hash: string;
  def: DefinitionV2;
}

export function loadDefinitionFile(path: string): LoadedDefinition {
  const content = readFileSync(path, "utf8");
  return { path, text: content, hash: createHash("sha256").update(content).digest("hex"), def: parseDefinitionText(content, path) };
}

/* ── Analysis: connection classes and after-link typing ─────────────────── */

export type ConnectionClass = "checked" | "runtime" | "mismatch";

export interface Connection {
  /** "input" (the workflow's input) or "steps.<id>" */
  from: string;
  /** a step id, or "output" for the workflow's result */
  to: string;
  /** the reference as written, e.g. steps.greet.output.text */
  ref: string;
  /** where in the target's input the value lands, e.g. shout.text */
  at: string;
  class: ConnectionClass;
  reason?: string;
}

/** A declared hand-off, typed by analysis: "declared" when the downstream exists, "mismatch" when it does not (ISC-272). */
export interface Handoff {
  upstream: string;
  downstream: string;
  via: string;
  class: "declared" | "mismatch" | "runtime";
  reason?: string;
}

export interface AfterLink {
  upstream: string;
  downstream: string;
  status: AfterStatus;
  class: ConnectionClass;
  reason?: string;
}

export interface ActionContract {
  input?: unknown;
  output?: unknown;
}

export interface AnalysisContext {
  /** Normalized action contracts by action name, when they could be read (local manifests). */
  contracts?: Map<string, ActionContract>;
  /** Finds another definition by name, for `after:` links and `workflow` steps. */
  resolveWorkflow?: (name: string) => DefinitionV2 | null;
  /** Resources each action declares in its manifest, by action name (ISC-42). */
  resources?: Map<string, string[]>;
  /** Registered Glance caller names; read from the Glance registry when a judgment step names one and this is absent (ISC-61). */
  callers?: Iterable<string>;
  /** Whether a `sop` value resolves (an SOP file, an SOP id, or a Vector SOP id); defaults to a local lookup (ISC-139). */
  resolveSop?: (sop: string) => boolean;
  /** The definitions home that prompt and criteria files are read from; defaults to the configured home (ISC-66). */
  home?: string;
  /** Whether a secret NAME is present in the local env; defaults to the Secrets.ts `has` lookup, names only (ISC-33). */
  hasSecret?: (name: string) => boolean;
  /** Authority names the validating host registers; passed to the parser (ISC-253). Absent means no host. */
  authorities?: Iterable<string>;
}

/** Every secret NAME a definition declares, with where it was declared: the root `secrets` list and any bare SECRET_NAME step resource. */
export function declaredSecrets(def: DefinitionV2): Array<{ name: string; path: string }> {
  const found: Array<{ name: string; path: string }> = (def.secrets ?? []).map((name, i) => ({ name, path: `secrets.${i}` }));
  for (const step of Object.values(def.steps)) {
    for (const [i, resource] of (step.resources ?? []).entries()) {
      if (!resource.includes(":") && SECRET_NAME_RE.test(resource)) found.push({ name: resource, path: `steps.${step.id}.resources.${i}` });
    }
  }
  return found;
}

export interface Analysis {
  valid: boolean;
  errors: string[];
  /** The same errors as `{path, code, message}` (ISC-57). */
  issues: Issue[];
  warnings: string[];
  warningIssues: Issue[];
  connections: Connection[];
  links: AfterLink[];
  handoffs: Handoff[];
}

type Shape = Record<string, unknown>;
const isShape = (s: unknown): s is Shape => isRecord(s);
const typesOf = (s: unknown): string[] => (isShape(s) ? (typeof s.type === "string" ? [s.type] : Array.isArray(s.type) ? (s.type as string[]) : []) : []);
/** A side is typed when it names a JSON type (or accepts nothing); only then can two sides be compared. */
const typed = (s: unknown): boolean => s === false || typesOf(s).length > 0;

/** The declared input and output schemas of each step, as far as they are knowable without running anything. */
export function stepContracts(
  def: DefinitionV2,
  ctx: AnalysisContext = {},
  lookup: (name: string) => DefinitionV2 | null = name => ctx.resolveWorkflow?.(name) ?? null,
): Map<string, ActionContract> {
  const out = new Map<string, ActionContract>();
  for (const step of Object.values(def.steps)) {
    if (step.kind === "action") out.set(step.id, ctx.contracts?.get(step.uses as string) ?? {});
    else if (step.kind === "workflow") {
      const sub = lookup(step.workflow as string);
      out.set(step.id, sub ? { input: sub.input, output: sub.output } : {});
    } else out.set(step.id, { input: step.input, output: step.output });
  }
  return out;
}

/** Each `$ref` in a mapping, paired with the part of the target schema it lands in. */
function refsIn(mapping: unknown, target: unknown, at: string, out: Array<{ ref: string; target: unknown; at: string }>): void {
  if (isRecord(mapping) && typeof mapping.$ref === "string" && Object.keys(mapping).length === 1) {
    out.push({ ref: mapping.$ref, target, at });
    return;
  }
  if (Array.isArray(mapping)) {
    mapping.forEach((item, i) => {
      const items = isShape(target) ? target.items : undefined;
      refsIn(item, Array.isArray(items) ? items[i] : items, `${at}.${i}`, out);
    });
    return;
  }
  if (isRecord(mapping)) {
    for (const [key, child] of Object.entries(mapping)) {
      const props = isShape(target) && isShape(target.properties) ? target.properties : undefined;
      refsIn(child, props && Object.hasOwn(props, key) ? props[key] : undefined, `${at}.${key}`, out);
    }
  }
}

/** Required target fields a typed source does not promise to supply. */
function unpromised(source: unknown, target: unknown): string[] {
  if (!isShape(source) || !isShape(target) || !typesOf(target).includes("object") || !Array.isArray(target.required)) return [];
  const promised = new Set(Array.isArray(source.required) ? (source.required as string[]) : []);
  return (target.required as string[]).filter(key => !promised.has(key));
}

/**
 * One connection's class. `checked`: both sides typed, the v1 contract check
 * finds no provable incompatibility, and every required target field is
 * promised by the source. `runtime`: a side is open (or a field is not
 * promised), so the value is validated against the schema when the step runs.
 * `mismatch`: the types provably disagree.
 */
export function classify(source: unknown, target: unknown, label: string): { class: ConnectionClass; reason?: string } {
  if (!typed(source)) return { class: "runtime", reason: "source is untyped; validated when the step runs" };
  if (!typed(target)) return { class: "runtime", reason: "target is untyped; validated when the step runs" };
  try {
    validateInputMapping({ $ref: "source" }, target, () => source, label);
  } catch (error) {
    return { class: "mismatch", reason: message(error) };
  }
  const missing = unpromised(source, target);
  if (missing.length) return { class: "runtime", reason: `source does not promise required field ${missing.join(", ")}` };
  return { class: "checked" };
}

function sourceSchema(def: DefinitionV2, contracts: Map<string, ActionContract>, ref: string, label: string): unknown {
  const parts = ref.split(".");
  // Every trigger field is a string (a timestamp, a key or an id).
  if (isTriggerRef(ref)) return { type: "string" };
  if (parts[0] === "input") return schemaAtPath(def.input, parts.slice(1), label);
  return schemaAtPath(contracts.get(parts[1])?.output, parts.slice(3), label);
}

/** Lookups that read outside the document: Glance callers, SOPs, prompt and criteria files, action resources, artifact-ref outputs. */
function checkRegistries(
  def: DefinitionV2,
  ctx: AnalysisContext,
  contracts: Map<string, ActionContract>,
  err: (path: string, code: string, text: string) => void,
  warn: (path: string, code: string, text: string) => void,
): void {
  // ISC-139 / ISC-38: an SOP that resolves to nothing is a warning on the card, not a rejection.
  if (def.sop !== undefined) {
    let resolved: boolean;
    try {
      resolved = (ctx.resolveSop ?? sopResolves)(def.sop);
    } catch {
      resolved = false;
    }
    if (!resolved) warn("sop", "unresolved-sop", `Workflow sop "${def.sop}" resolves to no SOP file or Vector SOP id.`);
  }

  // ISC-61: a judgment caller must be registered with Glance. The registry is read only when a caller is named.
  const named = Object.values(def.steps).filter(step => step.kind === "judgment" && step.caller !== undefined);
  if (named.length) {
    let callers: Set<string>;
    try {
      callers = ctx.callers ? new Set(ctx.callers) : glanceCallerNames();
    } catch (error) {
      err("$", "glance-registry-unreadable", `The Glance caller registry cannot be read: ${message(error)}`);
      callers = new Set(named.map(step => step.caller as string));
    }
    for (const step of named) {
      if (!callers.has(step.caller as string)) err(`steps.${step.id}.caller`, "unknown-caller", `Step "${step.id}" names Glance caller "${step.caller}", which is not in the Glance caller registry.`);
    }
  }

  // ISC-66 / ISC-147: prompt and criteria files must exist under the definitions home.
  const home = ctx.home ?? definitionsDir();
  for (const step of Object.values(def.steps)) {
    if (step.prompt_file === undefined) continue;
    const found = resolvePromptFile(home, step.prompt_file);
    if (!found.ok) err(`steps.${step.id}.prompt_file`, "missing-prompt-file", `Step "${step.id}": ${found.reason}`);
  }
  if (def.evaluate) {
    const found = resolvePromptFile(home, def.evaluate.criteria);
    if (!found.ok) err("evaluate.criteria", "missing-criteria-file", `Workflow evaluate: ${found.reason.replace("prompt_file", "criteria")}`);
  }

  // ISC-33 (local half): a local workflow needs every declared secret in the local env. Names only, never values.
  if (def.runs_on === "local") {
    const declared = declaredSecrets(def);
    if (declared.length) {
      const present = ctx.hasSecret ?? localHasSecret;
      const seen = new Set<string>();
      for (const { name, path } of declared) {
        if (seen.has(name) || present(name)) continue;
        seen.add(name);
        err(path, "secret-absent", `Secret ${name} is not in the local env, so this workflow cannot run locally; add it or set runs_on: cloud once the Worker holds it.`);
      }
    }
  }

  // ISC-42 (action half) and ISC-59 (action outputs): what an action's manifest declares.
  for (const step of Object.values(def.steps)) {
    if (step.kind !== "action") continue;
    if (def.runs_on === "local") {
      for (const resource of ctx.resources?.get(step.uses as string) ?? []) {
        if (isCloudOnly(resource)) err(`steps.${step.id}.uses`, "cloud-only-resource", `Step "${step.id}" uses action ${step.uses}, which needs ${resource}, which exists only in the cloud; set runs_on: cloud.`);
      }
    }
    for (const field of artifactRefFields(contracts.get(step.id)?.output).badType) {
      err(`steps.${step.id}.output.${field}`, "invalid-artifact-ref", `Step "${step.id}" output field "${field}" is format artifact-ref, which needs type string.`);
    }
  }
}

/**
 * Classifies every step-to-step connection, checks each step's whole input
 * mapping, and types each `after:` link. Never runs anything. A definition that
 * parsed is structurally valid; this adds the type verdict.
 */
export function analyzeDefinition(def: DefinitionV2, ctx: AnalysisContext = {}): Analysis {
  const errors: string[] = [];
  const issues: Issue[] = [];
  const warnings: string[] = [];
  const warningIssues: Issue[] = [];
  const err = (path: string, code: string, text: string) => {
    errors.push(text);
    issues.push({ path, code, message: text });
  };
  const warn = (path: string, code: string, text: string) => {
    warnings.push(text);
    warningIssues.push({ path, code, message: text });
  };
  /** An error whose location is read from its sentence. */
  const errLocated = (text: string) => {
    const at = locate(text);
    err(at.path, at.code, text);
  };
  const connections: Connection[] = [];
  const links: AfterLink[] = [];
  // A definition that cannot be read is reported once as an error, never thrown.
  const found = new Map<string, DefinitionV2 | null>();
  const unreadable = new Set<string>();
  const lookup = (name: string): DefinitionV2 | null => {
    if (!ctx.resolveWorkflow) return null;
    if (found.has(name)) return found.get(name) ?? null;
    let other: DefinitionV2 | null = null;
    try {
      other = ctx.resolveWorkflow(name);
    } catch (error) {
      unreadable.add(name);
      err("$", "unreadable-workflow", `Workflow "${name}" cannot be read: ${message(error)}`);
    }
    found.set(name, other);
    return other;
  };
  const contracts = stepContracts(def, ctx, lookup);

  const connect = (mapping: unknown, target: unknown, to: string) => {
    const refs: Array<{ ref: string; target: unknown; at: string }> = [];
    refsIn(mapping, target, to, refs);
    for (const { ref, target: part, at } of refs) {
      const from = ref.split(".")[0] === "input" ? "input" : ref.split(".")[0] === "trigger" ? "trigger" : `steps.${ref.split(".")[1]}`;
      let verdict: { class: ConnectionClass; reason?: string };
      try {
        verdict = classify(sourceSchema(def, contracts, ref, at), part, at);
      } catch (error) {
        verdict = { class: "mismatch", reason: message(error) };
      }
      connections.push({ from, to, ref, at, ...verdict });
      if (verdict.class === "mismatch") err(at, "type-mismatch", `Connection ${ref} -> ${at} is a type mismatch: ${verdict.reason}`);
    }
  };

  for (const step of Object.values(def.steps)) {
    const mapping = step.with === undefined ? { $ref: "input" } : step.with;
    const target = contracts.get(step.id)?.input;
    const before = errors.length;
    connect(mapping, target, step.id);
    if (errors.length > before) continue;
    // Whole-mapping rules a single reference cannot show: required inputs present, literals valid.
    try {
      validateInputMapping(mapping, target, ref => sourceSchema(def, contracts, ref, step.id), `Step "${step.id}" input`);
    } catch (error) {
      errLocated(message(error));
    }
    if (step.kind === "action" && ctx.contracts && !ctx.contracts.has(step.uses as string)) {
      warn(`steps.${step.id}.uses`, "contract-unreadable", `Step "${step.id}" uses action ${step.uses}, whose contract is not readable locally; its connections are checked at runtime.`);
    }
    if (step.kind === "workflow") {
      if (!ctx.resolveWorkflow) warn(`steps.${step.id}.workflow`, "workflow-not-looked-up", `Step "${step.id}" runs workflow ${step.workflow}, which was not looked up.`);
      else if (!lookup(step.workflow as string) && !unreadable.has(step.workflow as string)) err(`steps.${step.id}.workflow`, "unknown-workflow", `Step "${step.id}" runs workflow "${step.workflow}", which does not exist.`);
    }
  }

  if (def.result !== undefined) connect(def.result, def.output, "output");
  else if (def.output !== undefined) {
    connections.push({ from: "steps", to: "output", ref: "(terminal steps)", at: "output", class: "runtime", reason: "no result mapping; the run's output is validated when it ends" });
  }

  for (const trigger of def.triggers) {
    if (trigger.type !== "after") continue;
    const upstream = lookup(trigger.workflow);
    if (!ctx.resolveWorkflow) {
      warn("triggers", "workflow-not-looked-up", `after: ${trigger.workflow} was not looked up.`);
      links.push({ upstream: trigger.workflow, downstream: def.name, status: trigger.status, class: "runtime", reason: "upstream not looked up" });
      continue;
    }
    if (!upstream) {
      if (!unreadable.has(trigger.workflow)) err("triggers", "unknown-workflow", `after: upstream workflow "${trigger.workflow}" does not exist (downstream "${def.name}").`);
      links.push({ upstream: trigger.workflow, downstream: def.name, status: trigger.status, class: "mismatch", reason: unreadable.has(trigger.workflow) ? "upstream cannot be read" : "upstream does not exist" });
      continue;
    }
    if (trigger.status !== "succeeded") {
      // Only a succeeded run has an output to hand over; the F8 dispatcher defines the failed/completed payload.
      links.push({ upstream: upstream.name, downstream: def.name, status: trigger.status, class: "runtime", reason: `a ${trigger.status} upstream run hands over no typed output` });
      continue;
    }
    const verdict = classify(upstream.output, def.input, `after: ${upstream.name} -> ${def.name}`);
    links.push({ upstream: upstream.name, downstream: def.name, status: trigger.status, ...verdict });
    if (verdict.class === "mismatch") {
      err("triggers", "type-mismatch", `after: upstream "${upstream.name}" output does not fit downstream "${def.name}" input: ${verdict.reason}`);
    }
  }

  const handoffs: Handoff[] = [];
  for (const [i, f] of (def.feeds ?? []).entries()) {
    if (!ctx.resolveWorkflow) {
      handoffs.push({ upstream: def.name, downstream: f.workflow, via: f.via, class: "runtime", reason: "downstream not looked up" });
      continue;
    }
    if (!lookup(f.workflow)) {
      if (!unreadable.has(f.workflow)) err(`feeds.${i}.workflow`, "unknown-workflow", `feeds: downstream workflow "${f.workflow}" does not exist (upstream "${def.name}").`);
      handoffs.push({ upstream: def.name, downstream: f.workflow, via: f.via, class: "mismatch", reason: unreadable.has(f.workflow) ? "downstream cannot be read" : "downstream does not exist" });
      continue;
    }
    handoffs.push({ upstream: def.name, downstream: f.workflow, via: f.via, class: "declared" });
  }

  checkRegistries(def, ctx, contracts, err, warn);

  return { valid: errors.length === 0, errors, issues, warnings, warningIssues, connections, links, handoffs };
}

/* ── Description ────────────────────────────────────────────────────────── */

export interface GraphStep {
  kind: StepKind;
  executor: Executor;
  needs: string[];
  side_effects: SideEffect[];
  uses?: string;
  lane?: string;
  workflow?: string;
  description?: string;
}

/** A side-effect-free description of the graph, the shape `graph --json` prints. */
export function describeDefinition(def: DefinitionV2, analysis: Analysis) {
  const steps: Record<string, GraphStep> = {};
  for (const s of Object.values(def.steps)) {
    steps[s.id] = {
      kind: s.kind, executor: EXECUTOR_OF[s.kind], needs: [...s.needs], side_effects: [...s.side_effects],
      ...(s.uses ? { uses: s.uses } : {}), ...(s.lane ? { lane: s.lane } : {}),
      ...(s.workflow ? { workflow: s.workflow } : {}), ...(s.description ? { description: s.description } : {}),
    };
  }
  return {
    name: def.name, version: def.version, runs_on: def.runs_on, data_class: def.data_class,
    ...(def.sop ? { sop: def.sop } : {}), domains: [...def.domains],
    triggers: def.triggers, steps, connections: analysis.connections, links: analysis.links, handoffs: analysis.handoffs,
    valid: analysis.valid, errors: analysis.errors, issues: analysis.issues, warnings: analysis.warnings, warningIssues: analysis.warningIssues,
  };
}

/** What `validate --json` reports: a verdict and every rejection as `{path, code, message}` (ISC-57). Never throws. */
export interface Verdict {
  valid: boolean;
  errors: Issue[];
  warnings: Issue[];
  definition?: DefinitionV2;
  analysis?: Analysis;
}

export function checkDefinitionText(yamlText: string, source?: string, ctx: AnalysisContext = {}): Verdict {
  let def: DefinitionV2;
  try {
    def = parseDefinitionText(yamlText, source, ctx.authorities === undefined ? {} : { authorities: ctx.authorities });
  } catch (error) {
    return { valid: false, errors: [issueOfError(error)], warnings: [] };
  }
  const analysis = analyzeDefinition(def, ctx);
  return { valid: analysis.valid, errors: analysis.issues, warnings: analysis.warningIssues, definition: def, analysis };
}

/** Step ids in an order that respects `needs` (stable: definition order breaks ties). */
export function topologicalOrder(def: DefinitionV2): string[] {
  const done = new Set<string>();
  const order: string[] = [];
  const ids = Object.keys(def.steps);
  while (order.length < ids.length) {
    const next = ids.find(id => !done.has(id) && def.steps[id].needs.every(n => done.has(n)));
    if (next === undefined) throw new DefinitionError("Workflow contains a dependency cycle.");
    done.add(next);
    order.push(next);
  }
  return order;
}
