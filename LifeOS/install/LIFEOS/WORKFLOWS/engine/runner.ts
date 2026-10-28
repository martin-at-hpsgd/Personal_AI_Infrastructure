/**
 * The local runner. A v2 definition is compiled to a v1 graph and executed by
 * the v1 engine (scheduling, retries, timeouts, `when`, `$ref` resolution and
 * per-step schema validation all come from there); this file supplies what the
 * engine runs for each step:
 *   action   -> the v1 local action registry (the action's own action.json contract)
 *   command  -> Bun.spawn with the argv array exactly as written; JSON on stdin,
 *               one JSON value on stdout, validated against the step's schemas
 *   model    -> steps/model.ts (structured output bound to the output schema)
 *   agent    -> steps/agent.ts (submit_result with one repair; allowlist and sandbox on argv)
 *   judgment -> steps/judgment.ts (Glance; shadow callers fall back)
 *   human    -> human.ts (parks the run on disk; resumeRun continues it)
 *   workflow -> a child run with its own ledger line carrying parent_run_id
 * Around every executor: exponential backoff, the run deadline and the
 * artifact-ref check (steps/policy.ts), the monthly budget (budget.ts) and the
 * sampled evaluator (evaluate.ts).
 *
 * Every real run claims its occurrence key first (a duplicate is refused before
 * any step runs and writes nothing) and appends exactly one ledger line at the
 * end. A dry run validates the definition and the input and prints the plan; it
 * starts nothing and writes nothing.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  compileSchema,
  normalizeActionSchema,
  runWorkflow,
  type ActionRegistry,
  type V1Result,
} from "./v1.ts";
import {
  analyzeDefinition,
  approvalGates,
  approvalRefusal,
  compiledUses,
  EXECUTOR_OF,
  HUMAN_DECISION_SCHEMA,
  loadDefinitionFile,
  MAX_DEADLINE_MS,
  message,
  parseDefinitionText,
  toV1,
  topologicalOrder,
  type ActionContract,
  type Analysis,
  type DefinitionV2,
  type Executor,
  type LoadedDefinition,
  type StepKind,
  type StepV2,
  type TriggerV2,
} from "./format.ts";
import { invariant } from "../../TOOLS/Invariant.ts";
import { appendRecord, claimOccurrence, digest, hasOccurrence, readLedger, stopMarkerPath, type LedgerRecord, type LedgerStep } from "./ledger.ts";
import { artifactsRoot, definitionsDir, ledgerPath, pathForName, personalActionsDir, snapshotsRoot, systemActionsDir } from "./paths.ts";
import { isStorable, pruneStore, readDefinitionSnapshot, saveDefinitionSnapshot, storeStepValues } from "./store.ts";
import { artifactRefFields, isTriggerRef, readPromptFile, refsUnder, TRIGGER_INPUT_KEY } from "./format-rules.ts";
import { checkBudget, recordRefusal } from "./budget.ts";
import { evaluateRun, sampled, type EvalLine } from "./evaluate.ts";
import { AwaitingHuman, claimResume, clearWaiting, listWaiting, parkRun, readAnswer, readWaiting, type CompletedStep } from "./human.ts";
import { executeAgentStep, liveAgentClient } from "./steps/agent.ts";
import { declaredFallback, executeJudgmentStep, liveJudgmentClient } from "./steps/judgment.ts";
import { executeModelStep, liveModelClient } from "./steps/model.ts";
import { danglingArtifactRef, DeadlineReached, retryDelayMs, runWithBackoff, type AttemptTrace } from "./steps/policy.ts";
import type { StepClients, StepCost } from "./steps/types.ts";

/** Step kinds the local runner executes in M1. */
export const RUNNABLE_KINDS: readonly StepKind[] = ["action", "command", "model", "agent", "judgment", "human", "workflow"];
/** How long a human step may wait before its run counts as abandoned, when the step declares no timeout: seven days. */
export const DEFAULT_HUMAN_WAIT_MS = 7 * 86_400_000;
/** A command step with no timeout of its own (or in `defaults`) gets this one: ten minutes. */
export const DEFAULT_COMMAND_TIMEOUT_MS = 600_000;
/** Larger outputs belong in a file the step names, not on stdout. */
export const MAX_STDOUT_BYTES = 16 * 1024 * 1024;
const STDERR_TAIL_BYTES = 4096;
const LEDGER_ERROR_CHARS = 300;

/* ── Action contracts (manifests only; no implementation is imported) ───── */

export interface ActionResolution {
  contracts: Map<string, ActionContract>;
  registry: ActionRegistry;
  missing: Map<string, string>;
}

// A_ actions, plus F_ flow and P_ pipeline Workers wrapped whole as actions (migration M-52 wrap-first).
// The shape also keeps a name from escaping its ACTIONS/<name>/ directory.
const ACTION_NAME_RE = /^(?:[AFP]_[A-Z0-9_]+|[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+)$/;

export interface ActionSource {
  path: string;
  origin: "personal" | "system";
}

/**
 * Finds the directory an action name resolves to (ISC-87). A personal action of
 * the same name wins. When the personal directory exists at all, it IS the
 * action: if its action.json is missing, unreadable or invalid the lookup fails
 * and the system action is never used in its place, so a broken override is a
 * loud failure instead of a silent switch to different code.
 */
export function resolveActionSource(name: string, dirs: { personal?: string; system?: string } = {}): ActionSource {
  if (!ACTION_NAME_RE.test(name)) throw new Error(`Action not found: ${name}`);
  const personal = join(dirs.personal ?? personalActionsDir(), name);
  if (existsSync(personal)) {
    try {
      JSON.parse(readFileSync(join(personal, "action.json"), "utf8"));
    } catch (error) {
      throw new Error(`Personal action ${name} is present but broken (${message(error)}); fix or remove it. The system action of the same name is not used as a fallback.`);
    }
    return { path: personal, origin: "personal" };
  }
  const system = join(dirs.system ?? systemActionsDir(), name);
  if (existsSync(join(system, "action.json"))) return { path: system, origin: "system" };
  throw new Error(`Action not found: ${name}`);
}

/** Runs an action implementation from a resolved directory, with the same output check the v1 runner applies. */
async function executeActionAt(source: ActionSource, name: string, input: unknown, context: { signal?: AbortSignal; workflow: string; step: string }): Promise<unknown> {
  const manifest = JSON.parse(readFileSync(join(source.path, "action.json"), "utf8"));
  const validateInput = compileSchema(normalizeActionSchema(manifest.input));
  const validateOutput = compileSchema(normalizeActionSchema(manifest.output));
  const checked = validateInput(input);
  if (!checked.valid) throw new Error(`Input validation failed: ${checked.errors?.join(", ")}`);
  context.signal?.throwIfAborted();
  const implementation = (await import(join(source.path, "action.ts"))).default;
  const output = await implementation.execute(input, {
    capabilities: {},
    env: { mode: "local" },
    signal: context.signal,
    pipeline: { name: context.workflow, stepId: context.step },
  });
  const out = validateOutput(output);
  if (!out.valid) throw new Error(`Output validation failed: ${out.errors?.join(", ")}`);
  return output;
}

/**
 * Reads the action.json of every action a definition uses, one action at a time
 * so a cloud-only action does not hide the contracts of the local ones. Lookup
 * is personal first with no fallback from a broken override (ISC-87). Only
 * manifests are read here; no implementation is imported until the step runs.
 * The production directories run through the v1 action runner (capabilities and
 * all); directories moved by the test overrides run through executeActionAt.
 */
export async function resolveActions(def: DefinitionV2, dirs: { personal?: string; system?: string } = {}): Promise<ActionResolution> {
  const contracts = new Map<string, ActionContract>();
  const registry: ActionRegistry = Object.create(null);
  const missing = new Map<string, string>();
  const names = new Set(Object.values(def.steps).filter(s => s.kind === "action").map(s => s.uses as string));
  for (const name of names) {
    try {
      const source = resolveActionSource(name, dirs);
      const manifest = JSON.parse(readFileSync(join(source.path, "action.json"), "utf8"));
      const input = normalizeActionSchema(manifest.input);
      const output = normalizeActionSchema(manifest.output);
      registry[name] = {
        input,
        output,
        async execute(stepInput, context) {
          const v1 = await findV1Action(name);
          if (v1 === source.path) {
            const { runAction } = await import("../v1/Actions/lib/runner.v2.ts");
            const result = await runAction(name, stepInput, { signal: context.signal, pipeline: { name: context.workflow, stepId: context.step } });
            if (!result.success) throw new Error(result.error ?? `Action failed: ${name}`);
            return result.output;
          }
          return executeActionAt(source, name, stepInput, context);
        },
      };
      contracts.set(name, { input, output });
    } catch (error) {
      missing.set(name, message(error));
    }
  }
  return { contracts, registry, missing };
}

async function findV1Action(name: string): Promise<string | null> {
  const { findAction } = await import("../v1/Actions/lib/runner.v2.ts");
  return findAction(name);
}

/** Looks definitions up by name in one directory, memoized; null when the file does not exist. */
export function definitionResolver(dir: string = definitionsDir()): (name: string) => DefinitionV2 | null {
  const cache = new Map<string, DefinitionV2 | null>();
  return (name: string) => {
    if (cache.has(name)) return cache.get(name) ?? null;
    let found: DefinitionV2 | null = null;
    try {
      found = loadDefinitionFile(pathForName(name, dir)).def;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    cache.set(name, found);
    return found;
  };
}

/* ── Command steps ──────────────────────────────────────────────────────── */

/** Reads a stream up to `cap` bytes; past it, `onOverflow` runs at once (the caller kills the writer) and the bytes are dropped. */
async function readCapped(stream: ReadableStream<Uint8Array>, cap: number, onOverflow: () => void): Promise<{ bytes: Uint8Array; overflow: boolean }> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = stream.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > cap) {
      onOverflow();
      await reader.cancel();
      return { bytes: new Uint8Array(), overflow: true };
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return { bytes: out, overflow: false };
}

async function readTail(stream: ReadableStream<Uint8Array>, keep: number): Promise<string> {
  let tail = new Uint8Array();
  const reader = stream.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    const joined = new Uint8Array(tail.byteLength + value.byteLength);
    joined.set(tail);
    joined.set(value, tail.byteLength);
    tail = joined.byteLength > keep ? joined.slice(joined.byteLength - keep) : joined;
  }
  return new TextDecoder().decode(tail);
}

export interface CommandOutcome {
  value: unknown;
  stderr: string;
}

export class CommandError extends Error {
  constructor(message: string, readonly stderr: string) {
    super(message);
    this.name = "CommandError";
  }
}

/* ── Environment (ISC-82) ───────────────────────────────────────────────── */

/**
 * The keys every command gets without declaring them: where to find programs, the home directory, and who the user
 * is. None is a credential. USER and LOGNAME are here because the claude CLI finds its subscription login in the macOS
 * Keychain by user name; without them every claude-CLI job answered "Not logged in" from the 2026-10-22 cutover until
 * 2026-10-25 (mail-monitor, morning-brief, work-closeout), the class Inference.ts had patched for itself on 10-19.
 */
export const ALWAYS_ENV: readonly string[] = ["PATH", "HOME", "USER", "LOGNAME"];
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The whole environment a command step receives: ALWAYS_ENV from the parent,
 * plus exactly the keys the step declares under `env:`. A declared list
 * (`[GH_TOKEN]`) copies those names from the parent; a declared map
 * (`{LANG: C}`) sets literal values. Nothing else from the parent reaches the
 * child, so a step cannot read a credential it did not name.
 */
export function commandEnv(declared: unknown, parent: Record<string, string | undefined> = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ALWAYS_ENV) if (parent[key] !== undefined) env[key] = parent[key] as string;
  if (declared === undefined || declared === null) return env;
  if (Array.isArray(declared)) {
    for (const key of declared) {
      invariant(typeof key === "string" && ENV_KEY_RE.test(key), `env: entry "${String(key)}" is not an environment variable name`);
      if (parent[key] !== undefined) env[key] = parent[key] as string;
    }
    return env;
  }
  invariant(typeof declared === "object", "env: must be a list of names or a map of values");
  for (const [key, value] of Object.entries(declared as Record<string, unknown>)) {
    invariant(ENV_KEY_RE.test(key), `env: key "${key}" is not an environment variable name`);
    invariant(typeof value === "string", `env: value for "${key}" must be a string`);
    env[key] = value;
  }
  return env;
}

/* ── Process groups (ISC-81) ────────────────────────────────────────────── */

/** Process groups of commands still running; the exit handler kills what a crashed run would leave behind. */
const liveGroups = new Set<number>();
let exitHookInstalled = false;

/**
 * SIGKILLs every process in the group. ESRCH means the group is already gone. On
 * macOS a group holding only exited-but-unreaped processes answers EPERM; that
 * is the same "nothing left to kill" for a group this run started itself.
 */
function killGroup(pgid: number): void {
  try {
    process.kill(-pgid, "SIGKILL");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ESRCH" && code !== "EPERM") throw error;
  }
}

function trackGroup(pgid: number): void {
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.on("exit", () => {
      for (const group of liveGroups) {
        try {
          killGroup(group);
        } catch {
          /* best effort while the process is going away */
        }
      }
    });
  }
  liveGroups.add(pgid);
}

/**
 * Runs one argv array. The array goes to the OS exactly as written: no shell,
 * no interpolation, no word splitting. The step's input is JSON on stdin; the
 * step's output is the one JSON value it prints on stdout. Errors carry the
 * exit code only; stderr travels separately so it never lands in the ledger.
 *
 * The child leads its own process group. A timeout, a cancel or an output
 * overflow kills the whole group, and the group is killed again the moment the
 * leader exits, so nothing the command started (a backgrounded worker, a
 * grandchild holding the output pipe) outlives the step.
 */
export async function runCommand(
  argv: readonly string[],
  input: unknown,
  opts: { cwd: string; signal?: AbortSignal; env?: Record<string, string> },
): Promise<CommandOutcome> {
  if (!Array.isArray(argv) || argv.length === 0 || argv.some(part => typeof part !== "string")) {
    throw new CommandError("A command step needs an argv array of strings.", "");
  }
  if (opts.signal?.aborted) throw new CommandError("Cancelled before it started.", "");
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([...argv], {
      cwd: opts.cwd,
      stdin: new TextEncoder().encode(JSON.stringify(input ?? null)),
      stdout: "pipe",
      stderr: "pipe",
      env: opts.env ?? commandEnv(undefined),
      detached: true,
    });
  } catch (error) {
    throw new CommandError(`Could not start ${argv[0]}: ${(error as NodeJS.ErrnoException).code ?? message(error)}`, "");
  }
  const pgid = proc.pid;
  invariant(Number.isInteger(pgid) && pgid > 1, "A spawned command needs a real process id");
  trackGroup(pgid);
  const kill = () => killGroup(pgid);
  opts.signal?.addEventListener("abort", kill, { once: true });
  try {
    const exited = proc.exited.then(code => {
      kill();
      return code;
    });
    const [out, stderr, code] = await Promise.all([
      readCapped(proc.stdout as ReadableStream<Uint8Array>, MAX_STDOUT_BYTES, kill),
      readTail(proc.stderr as ReadableStream<Uint8Array>, STDERR_TAIL_BYTES),
      exited,
    ]);
    if (opts.signal?.aborted) throw new CommandError("Cancelled: the step timed out and the process was killed.", stderr);
    if (out.overflow) {
      throw new CommandError(`Printed more than ${MAX_STDOUT_BYTES} bytes on stdout; write large payloads to a file and return its path.`, stderr);
    }
    if (code !== 0) throw new CommandError(`Exited with code ${code}.`, stderr);
    const raw = new TextDecoder().decode(out.bytes).trim();
    if (!raw) throw new CommandError("Printed no JSON on stdout.", stderr);
    try {
      return { value: JSON.parse(raw), stderr };
    } catch {
      throw new CommandError(`Stdout is not one JSON value (${out.bytes.byteLength} bytes).`, stderr);
    }
  } finally {
    kill();
    liveGroups.delete(pgid);
    opts.signal?.removeEventListener("abort", kill);
  }
}

/* ── Plan ───────────────────────────────────────────────────────────────── */

export interface PlannedStep {
  id: string;
  kind: StepKind;
  executor: Executor;
  needs: string[];
  runnable: boolean;
  reason?: string;
}

function notInM1(step: StepV2): string {
  return step.kind === "workflow"
    ? `Step "${step.id}" runs another workflow; sub-workflow execution is not in M1.`
    : `Step "${step.id}" is a ${step.kind} step; ${step.kind} execution is not in M1 (F9 builds it).`;
}

export function planOf(def: DefinitionV2): PlannedStep[] {
  return topologicalOrder(def).map(id => {
    const step = def.steps[id];
    const runnable = RUNNABLE_KINDS.includes(step.kind);
    return { id, kind: step.kind, executor: EXECUTOR_OF[step.kind], needs: [...step.needs], runnable, ...(runnable ? {} : { reason: notInM1(step) }) };
  });
}

/* ── Run ────────────────────────────────────────────────────────────────── */

export interface RunOptions {
  input?: unknown;
  occurrenceKey?: string;
  dryRun?: boolean;
  /** Ledger file; defaults to ledgerPath(). */
  ledger?: string;
  /** Where `after:` upstreams and sub-workflows are looked up; defaults to definitionsDir(). */
  definitions?: string;
  /** Clock override, for tests of the payload store and the deadline. */
  now?: () => Date;
  /** Where action names are looked up (personal first, then system); defaults to the paths.ts locations. */
  actionDirs?: { personal?: string; system?: string };
  /** Model, agent and Glance clients; tests pass fakes, production leaves them out. */
  clients?: StepClients;
  /** What started the run; defaults to manual. Anything but manual runs model and agent steps on the flex tier. */
  trigger?: TriggerContext;
  /** Set on a child run started by a workflow step. */
  parentRunId?: string;
  /** The workflows above this run, outermost first; a child already in it is refused (ISC-169). */
  workflowChain?: string[];
  /** Sampling source for evaluate.sample_rate; defaults to Math.random. */
  random?: () => number;
  /** Roots an artifact-ref may point under; defaults to the definition directory and the payload store. */
  artifactRoots?: string[];
  /** Sleep used between backoff retries; tests pass a recorder. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /**
   * Runs the park notification (ISC-130): receives the argv and env of `human-notify.ts notify`. Production leaves it out
   * and gets a real, non-detached, argv-only spawn; under NODE_ENV=test the default does nothing, so a test never texts.
   */
  spawnNotify?: (argv: string[], env: Record<string, string>) => void;
}

/** `human-notify.ts notify`: argv only, no shell, no run id (it texts every parked human step that has no binding yet). */
export const PARK_NOTIFY_ARGV: readonly string[] = [process.execPath, join(import.meta.dir, "human-notify.ts"), "notify"];
const PARK_NOTIFY_TIMEOUT_MS = 90_000;

function defaultSpawnNotify(argv: string[], env: Record<string, string>): void {
  if (process.env.NODE_ENV === "test") return;
  Bun.spawnSync(argv, { env, stdout: "ignore", stderr: "ignore", timeout: PARK_NOTIFY_TIMEOUT_MS });
}

/** Texts the principal that a run is waiting. A failed or missing notifier never fails the park; `notify` is idempotent and a later resume retries it. */
function notifyParked(ctx: RunContext): void {
  if (ctx.opts.dryRun) return;
  const env = { ...(process.env as Record<string, string>), LIFEOS_NOTIFICATION_CHANNEL: "headless", LIFEOS_WORKFLOWS_LEDGER: ctx.ledger };
  try {
    (ctx.opts.spawnNotify ?? defaultSpawnNotify)([...PARK_NOTIFY_ARGV], env);
  } catch { /* the run is parked on disk either way */ }
}

export interface TriggerContext {
  type: TriggerV2["type"];
  scheduled_for?: string;
  upstream_run_id?: string;
}

export type RunOutcome = "succeeded" | "failed" | "timed_out" | "waiting";

export type Refusal = "invalid" | "not-runnable" | "input" | "duplicate-occurrence" | "budget";

export interface StepReport {
  status: "succeeded" | "failed" | "skipped" | "waiting" | "pending";
  attempts: number;
  /** Lane, tokens and estimated cost of a model or agent step (ISC-128). */
  cost?: StepCost;
  /** The Glance reply behind a judgment step, recorded even when a shadow caller cannot gate (ISC-132). */
  glance?: unknown;
  /** The waits before each retry of an exponential-backoff step (ISC-54). */
  retry_delays_ms?: number[];
  /** The child run a workflow step started (ISC-125). */
  child_run_id?: string;
  output?: unknown;
  error?: string;
  timed_out?: boolean;
  /** Tail of a failed command's stderr, shown to the caller and never written to the ledger. */
  stderr?: string;
}

export interface RunReport {
  success: boolean;
  /** How the run ended: timed_out at its deadline, or waiting on a human step. Absent on refusals and dry runs. */
  status?: RunOutcome;
  /** Human steps a waiting run is parked on. */
  waiting_on?: string[];
  parent_run_id?: string;
  evaluation?: EvalLine;
  workflow: string;
  path: string;
  dry_run: boolean;
  run_id?: string;
  occurrence_key?: string;
  output?: unknown;
  error?: string;
  refused?: Refusal;
  plan?: PlannedStep[];
  steps: Record<string, StepReport>;
  ledger?: string;
  warnings?: string[];
}

const refuse = (base: Pick<RunReport, "workflow" | "path" | "dry_run">, refused: Refusal, error: string, extra: Partial<RunReport> = {}): RunReport =>
  ({ ...base, success: false, refused, error, steps: {}, ...extra });

/** Slack added to the summed step budgets before a claim's run counts as dead (ISC-80). */
export const DEADLINE_SLACK_MS = 60_000;

/**
 * When a run that has not written its ledger line is presumed dead: the
 * workflow's own `deadline_ms` when it has one, otherwise the most every step
 * could take one after another (each timeout times its attempts, plus retry
 * delays), plus a minute of slack.
 */
export function runDeadlineMs(def: DefinitionV2): number {
  if (def.deadline_ms !== undefined) return def.deadline_ms + DEADLINE_SLACK_MS;
  let total = 0;
  for (const step of Object.values(def.steps)) {
    const timeout = step.timeout_ms ?? (step.kind === "human" ? DEFAULT_HUMAN_WAIT_MS : def.defaults?.timeout_ms ?? DEFAULT_COMMAND_TIMEOUT_MS);
    const retries = step.retries ?? def.defaults?.retries ?? 0;
    const delay = step.retry_delay_ms ?? def.defaults?.retry_delay_ms ?? 0;
    total += timeout * (retries + 1);
    for (let attempt = 2; attempt <= retries + 1; attempt++) total += retryDelayMs(attempt, delay, step.retry_backoff, step.retry_delay_max_ms);
  }
  return total + DEADLINE_SLACK_MS;
}

/** The env: a command step declares (list of names or map of values), read off the parsed step. */
export const declaredEnv = (step: StepV2): unknown => (step as StepV2 & { env?: unknown }).env;

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim().slice(0, LEDGER_ERROR_CHARS);

/** A fresh key per manual invocation, so two hand runs are two occurrences. */
export function manualOccurrenceKey(now: Date = new Date()): string {
  return `manual:${now.toISOString()}:${randomUUID()}`;
}

/**
 * Validates and (unless dry) runs one definition file locally. Never throws for
 * an ordinary failure: invalid definitions, bad input, duplicate occurrences
 * and failed steps all come back as a report with `success: false`.
 */
export async function runDefinition(path: string, opts: RunOptions = {}): Promise<RunReport> {
  const dryRun = opts.dryRun === true;
  let loaded: LoadedDefinition;
  try {
    loaded = loadDefinitionFile(path);
  } catch (error) {
    return refuse({ workflow: "", path, dry_run: dryRun }, "invalid", message(error));
  }
  const { def } = loaded;
  const base = { workflow: def.name, path, dry_run: dryRun };
  if (opts.workflowChain?.includes(def.name)) {
    return refuse(base, "invalid", `Workflow "${def.name}" is already running above itself (${[...opts.workflowChain, def.name].join(" → ")}); a workflow step cannot call back into its own chain.`);
  }

  const actions = await resolveActions(def, opts.actionDirs);
  let analysis: Analysis;
  try {
    analysis = analyzeDefinition(def, { contracts: actions.contracts, resolveWorkflow: definitionResolver(opts.definitions), home: opts.definitions ?? definitionsDir() });
  } catch (error) {
    return refuse(base, "invalid", message(error));
  }
  if (!analysis.valid) return refuse(base, "invalid", analysis.errors.join("; "), { warnings: analysis.warnings });
  if (def.runs_on !== "local") return refuse(base, "not-runnable", `Workflow "${def.name}" runs on ${def.runs_on}; the cloud runner is not in M1.`);
  if (actions.missing.size) {
    return refuse(base, "not-runnable", [...actions.missing].map(([name, why]) => `Action ${name} cannot run locally: ${why}`).join("; "));
  }
  const plan = planOf(def);
  const blocked = plan.filter(p => !p.runnable);
  if (blocked.length) return refuse(base, "not-runnable", blocked.map(p => p.reason).join(" "), { plan });

  const input = opts.input === undefined ? {} : opts.input;
  if (def.input !== undefined) {
    const check = compileSchema(def.input)(input);
    if (!check.valid) return refuse(base, "input", `Workflow input failed schema validation: ${check.errors?.join("; ") ?? "invalid"}`, { plan });
  }
  if (dryRun) return { ...base, success: true, plan, steps: {}, ...(analysis.warnings.length ? { warnings: analysis.warnings } : {}) };

  const ledger = opts.ledger ?? ledgerPath();
  const clock = opts.now ?? (() => new Date());
  const occurrenceKey = opts.occurrenceKey ?? manualOccurrenceKey();
  const trigger = opts.trigger ?? { type: "manual" as const };

  // ISC-145: a run that would start after the month's recorded spend reached the ceiling is refused and recorded.
  const budget = checkBudget(ledger, def.name, def.budget_usd_month, clock());
  if (!budget.allowed) {
    const reason = `Workflow "${def.name}" has spent $${budget.spent.toFixed(4)} of its $${budget.budget} monthly budget; the run was not started.`;
    recordRefusal(ledger, { workflow: def.name, occurrence_key: occurrenceKey, reason, spent: budget.spent, budget: budget.budget as number, at: clock().toISOString() });
    return refuse(base, "budget", reason, { occurrence_key: occurrenceKey });
  }

  const runId = randomUUID();
  const claimedAt = clock();
  if (!claimOccurrence(ledger, def.name, occurrenceKey, runId, {
    deadline_at: new Date(claimedAt.getTime() + runDeadlineMs(def)).toISOString(),
    definition_path: path,
    definition_hash: loaded.hash,
    data_class: def.data_class,
    started_at: claimedAt.toISOString(),
    steps: Object.keys(def.steps),
    pid: process.pid,
    trigger: trigger.type,
  })) {
    return refuse(base, "duplicate-occurrence", `Occurrence "${occurrenceKey}" of ${def.name} already ran; nothing was started.`, { occurrence_key: occurrenceKey });
  }
  return executeRun({
    def, hash: loaded.hash, text: loaded.text, path, base, warnings: analysis.warnings, input, runId, occurrenceKey,
    startedAt: claimedAt.toISOString(), trigger, parentRunId: opts.parentRunId, ledger, clock, opts, replay: {},
  });
}

/**
 * Resumes a run parked on a human step once every step it waits on has an
 * answer (ISC-131). The definition is the snapshot the run started with, the
 * steps that finished are replayed from their saved outputs (never run
 * again), and the run then ends with its one ledger line under its original
 * run id. Returns null when the run is not parked, an answer is missing, or
 * another resume of the same run is in flight: one resume holds the run, so
 * concurrent callers never replay it and run a gated step twice.
 */
export async function resumeRun(runId: string, opts: RunOptions = {}): Promise<RunReport | null> {
  const ledger = opts.ledger ?? ledgerPath();
  if (!readWaiting(ledger, runId)) return null;
  const release = claimResume(ledger, runId);
  if (!release) return null;
  try {
    return await resumeHeld(runId, ledger, opts);
  } finally {
    release();
  }
}

/** The resume itself, run only while this process holds the run (resumeRun). */
async function resumeHeld(runId: string, ledger: string, opts: RunOptions): Promise<RunReport | null> {
  // Read under the hold: a resume that finished just before it took the run cleared or re-parked this state.
  const waiting = readWaiting(ledger, runId);
  if (!waiting) return null;
  // A run whose one ledger line is already written has ended; its leftover state is cleared, never replayed.
  if (hasOccurrence(ledger, waiting.workflow, waiting.occurrence_key)) {
    clearWaiting(ledger, runId);
    return null;
  }
  if (waiting.waiting_on.some(step => readAnswer(ledger, runId, step) === null)) return null;
  const text = readDefinitionSnapshot(snapshotsRoot(ledger), waiting.definition_hash);
  invariant(text !== null, `Run ${runId} is parked but its definition snapshot ${waiting.definition_hash} is missing`);
  const def = parseDefinitionText(text, waiting.definition_path);
  const actions = await resolveActions(def, opts.actionDirs);
  if (actions.missing.size) throw new Error([...actions.missing].map(([name, why]) => `Action ${name} cannot run locally: ${why}`).join("; "));
  return executeRun({
    def, hash: waiting.definition_hash, text, path: waiting.definition_path, base: { workflow: def.name, path: waiting.definition_path, dry_run: false },
    warnings: [], input: waiting.input, runId, occurrenceKey: waiting.occurrence_key, startedAt: waiting.started_at,
    trigger: { type: waiting.trigger as TriggerContext["type"] }, parentRunId: waiting.parent_run_id, ledger,
    clock: opts.now ?? (() => new Date()), opts, replay: waiting.completed, actions,
  });
}

/** Resumes every parked run whose human steps are all answered; the sweep a restart or a Pulse/Relay answer runs. */
export async function resumeAnswered(opts: RunOptions = {}): Promise<RunReport[]> {
  const out: RunReport[] = [];
  for (const waiting of listWaiting(opts.ledger ?? ledgerPath())) {
    const report = await resumeRun(waiting.run_id, opts);
    if (report) out.push(report);
  }
  return out;
}

interface RunContext {
  def: DefinitionV2;
  hash: string;
  text: string;
  path: string;
  base: Pick<RunReport, "workflow" | "path" | "dry_run">;
  warnings: string[];
  input: unknown;
  runId: string;
  occurrenceKey: string;
  startedAt: string;
  trigger: TriggerContext;
  parentRunId?: string;
  ledger: string;
  clock: () => Date;
  opts: RunOptions;
  /** Steps finished before a park, replayed from their saved outputs on resume. */
  replay: Record<string, CompletedStep>;
  actions?: ActionResolution;
}

/** The input the compiled graph runs with: the reserved trigger key is added only when a step reads it. */
function graphInput(def: DefinitionV2, input: unknown, trigger: Record<string, unknown>): unknown {
  const readsTrigger = Object.values(def.steps).some(s => [...refsUnder(s.with, "")].some(r => isTriggerRef(r.ref)) || (s.when !== undefined && isTriggerRef(s.when.ref)))
    || [...refsUnder(def.result, "")].some(r => isTriggerRef(r.ref));
  if (!readsTrigger || input === null || typeof input !== "object" || Array.isArray(input)) return input;
  return { ...(input as Record<string, unknown>), [TRIGGER_INPUT_KEY]: trigger };
}

/** A step's prompt: its inline `prompt`, or its `prompt_file` read from the definitions home. */
function promptOf(step: StepV2, home: string): string {
  if (step.prompt !== undefined) return step.prompt;
  if (step.prompt_file !== undefined) return readPromptFile(home, step.prompt_file);
  return "";
}

async function executeRun(ctx: RunContext): Promise<RunReport> {
  const { def, runId, ledger, clock, opts } = ctx;
  const actions = ctx.actions ?? await resolveActions(def, opts.actionDirs);
  const stderrOf = new Map<string, string>();
  const costs = new Map<string, StepCost>(Object.entries(ctx.replay).flatMap(([id, c]) => (c.cost ? [[id, c.cost] as [string, StepCost]] : [])));
  const glanceOf = new Map<string, unknown>();
  const parked = new Map<string, string>();
  const childRuns = new Map<string, string>();
  const backoffTrace = new Map<string, AttemptTrace>();
  const afterDeadline = new Set<string>();
  const timing = new Map<string, { startedAt: string; startMs: number; endMs: number }>();
  const inputs = new Map<string, unknown>();
  // A gated step runs only once every approval it waits on answered approved: true; a decline never reaches it.
  const gates = approvalGates(def);
  const answers = new Map<string, unknown>();
  const cwd = dirname(ctx.path);
  // Prompt and criteria files resolve from the definitions home, the same home validation checked them against.
  const home = opts.definitions ?? definitionsDir();
  const clients = opts.clients ?? {};
  const artifactRoots = opts.artifactRoots ?? [cwd, artifactsRoot(ledger)];

  // ISC-55: one run-wide deadline. Every executor sees it; a step that starts after it never runs.
  const deadline = new AbortController();
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  if (def.deadline_ms !== undefined) {
    const elapsed = clock().getTime() - Date.parse(ctx.startedAt);
    deadlineTimer = setTimeout(() => deadline.abort(new DeadlineReached(def.deadline_ms as number)), Math.max(0, def.deadline_ms - elapsed));
  }

  // ISC-73: `workflow stop` drops claims/<run_id>.stop beside the ledger; poll it, then abort every running step (command steps kill their process group).
  const stop = new AbortController();
  const stopRequested = () => existsSync(stopMarkerPath(ledger, runId));
  const stopTimer = setInterval(() => {
    if (!stop.signal.aborted && stopRequested()) stop.abort(new Error("Stopped by request."));
  }, STOP_POLL_MS);
  stopTimer.unref();

  const trigger = { type: ctx.trigger.type, occurrence_key: ctx.occurrenceKey, run_id: runId, ...(ctx.trigger.scheduled_for ? { scheduled_for: ctx.trigger.scheduled_for } : {}), ...(ctx.trigger.upstream_run_id ? { upstream_run_id: ctx.trigger.upstream_run_id } : {}) };

  const wrap = (step: StepV2, contract: { input?: unknown; output?: unknown }, execute: (input: unknown, signal: AbortSignal) => Promise<unknown>): ActionRegistry[string] => ({
    ...contract,
    async execute(stepInput, context) {
      const replay = ctx.replay[step.id];
      if (replay) {
        timing.set(step.id, { startedAt: replay.started_at ?? ctx.startedAt, startMs: 0, endMs: replay.duration_ms });
        if (step.kind === "human") answers.set(step.id, replay.output);
        return replay.output;
      }
      if (!stop.signal.aborted && stopRequested()) stop.abort(new Error("Stopped by request."));
      if (stop.signal.aborted) throw stop.signal.reason;
      if (deadline.signal.aborted) {
        afterDeadline.add(step.id);
        throw deadline.signal.reason;
      }
      const approvals = gates.get(step.id);
      if (approvals) {
        const refusal = approvalRefusal(step.id, approvals, id => answers.get(id));
        if (refusal) throw new Error(refusal);
      }
      const t0 = Date.now();
      const record = timing.get(step.id) ?? { startedAt: new Date(t0).toISOString(), startMs: t0, endMs: t0 };
      timing.set(step.id, record);
      inputs.set(step.id, stepInput);
      const signal = AbortSignal.any([context.signal, deadline.signal, stop.signal]);
      try {
        const once = (s: AbortSignal) => raceAbort(execute(stepInput, s), s);
        const value = step.retry_backoff === "exponential"
          ? await runWithBackoff(step, def.defaults, s => once(s), { signal, sleep: opts.sleep, trace: backoffTrace.get(step.id) ?? setTrace(backoffTrace, step.id) })
          : await once(signal);
        // ISC-59: an artifact-ref in the output must exist before any downstream step starts.
        const refs = step.artifact_refs ?? artifactRefFields(contract.output).fields;
        if (refs.length) {
          const dangling = danglingArtifactRef(value, refs, artifactRoots, cwd);
          if (dangling) throw new Error(`Step "${step.id}" output failed its artifact check: ${dangling}`);
        }
        return value;
      } finally {
        record.endMs = Date.now();
      }
    },
  });

  const registry: ActionRegistry = Object.create(null);
  for (const step of Object.values(def.steps)) {
    const uses = compiledUses(step.id);
    switch (step.kind) {
      case "action": {
        const action = actions.registry[step.uses as string];
        registry[uses] = wrap(step, { input: action.input, output: action.output }, (i, signal) => action.execute(i, { signal, workflow: def.name, step: step.id, attempt: 1 }));
        break;
      }
      case "command": {
        const argv = step.argv as string[];
        const env = commandEnv(declaredEnv(step));
        registry[uses] = wrap(step, { input: step.input, output: step.output }, async (i, signal) => {
          try {
            return (await runCommand(argv, i, { cwd, signal, env })).value;
          } catch (error) {
            if (error instanceof CommandError && error.stderr) stderrOf.set(step.id, error.stderr);
            throw error;
          }
        });
        break;
      }
      case "model": {
        registry[uses] = wrap(step, { input: step.input, output: step.output }, async (i, signal) => {
          try {
            const result = await executeModelStep({ lane: step.lane as string, prompt: promptOf(step, home), input: i, output: step.output, stepId: step.id, trigger: ctx.trigger.type, signal }, clients.model ?? liveModelClient);
            costs.set(step.id, result.cost);
            return result.value;
          } catch (error) {
            const cost = (error as { cost?: StepCost }).cost;
            if (cost) costs.set(step.id, cost);
            throw error;
          }
        });
        break;
      }
      case "agent": {
        registry[uses] = wrap(step, { input: step.input, output: step.output }, async (i, signal) => {
          try {
            const result = await executeAgentStep({ stepId: step.id, lane: step.lane as string, prompt: promptOf(step, home), input: i, output: step.output, tools: step.tools, sandbox: step.sandbox, trigger: ctx.trigger.type, cwd, signal }, clients.agent ?? liveAgentClient);
            costs.set(step.id, result.cost);
            return result.value;
          } catch (error) {
            const cost = (error as { cost?: StepCost }).cost;
            if (cost) costs.set(step.id, cost);
            throw error;
          }
        });
        break;
      }
      case "judgment": {
        registry[uses] = wrap(step, { input: step.input, output: step.output }, async (i, signal) => {
          const out = await executeJudgmentStep({ workflow: def.name, stepId: step.id, caller: step.caller as string, question: step.question as string, state: i, fallback: declaredFallback(step as unknown as Record<string, unknown>), signal }, clients.judgment ?? liveJudgmentClient);
          glanceOf.set(step.id, out.glance);
          return out;
        });
        break;
      }
      case "human": {
        registry[uses] = wrap(step, { input: step.input, output: step.output ?? HUMAN_DECISION_SCHEMA }, async () => {
          const answer = readAnswer(ledger, runId, step.id);
          if (answer) {
            answers.set(step.id, answer);
            return answer;
          }
          // Parking writes the run's input and every finished output to disk, which the store never does for these
          // classes ("confidential and restricted runs leave nothing behind"), so such a run cannot wait on a person.
          if (!isStorable(def.data_class)) throw new Error(`Step "${step.id}" is a human step in a ${def.data_class} run: a parked run keeps its input and outputs on disk, so a ${def.data_class} run cannot wait for a person. Make the workflow internal, or take the decision upstream.`);
          const waiting = new AwaitingHuman(step.id, promptOf(step, home));
          parked.set(step.id, waiting.prompt);
          throw waiting;
        });
        break;
      }
      case "workflow": {
        registry[uses] = wrap(step, {}, async i => {
          const childPath = pathForName(step.workflow as string, opts.definitions ?? definitionsDir());
          const child = await runDefinition(childPath, { ...opts, input: i, occurrenceKey: `${ctx.occurrenceKey}/${step.id}`, parentRunId: runId, trigger: ctx.trigger, dryRun: false, workflowChain: [...(opts.workflowChain ?? []), def.name] });
          if (child.run_id) childRuns.set(step.id, child.run_id);
          if (!child.success) throw new Error(`Sub-workflow ${step.workflow} ${child.refused ? `was refused (${child.refused})` : "failed"}: ${child.error ?? "unknown error"}`);
          return child.output;
        });
        break;
      }
    }
  }
  const graph = toV1(def);
  for (const step of Object.values(def.steps)) {
    const compiled = graph.steps[step.id] as unknown as Record<string, unknown>;
    if (step.retry_backoff === "exponential") {
      // The retry loop and its per-attempt timeout live in runWithBackoff for these steps; the v1 engine gets one
      // attempt and the 24-hour ceiling, which also overrides any workflow-level default timeout or retry count.
      compiled.retries = 0;
      delete compiled.retry_delay_ms;
      compiled.timeout_ms = MAX_DEADLINE_MS;
    } else if (step.kind === "command" && step.timeout_ms === undefined && def.defaults?.timeout_ms === undefined) {
      compiled.timeout_ms = DEFAULT_COMMAND_TIMEOUT_MS;
    }
  }
  const withTrigger = graphInput(def, ctx.input, trigger);
  if (withTrigger !== ctx.input) delete graph.input;

  let result: V1Result;
  try {
    result = await runWorkflow(graph, withTrigger, registry);
  } catch (error) {
    result = { success: false, error: message(error), steps: {} };
  } finally {
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
    clearInterval(stopTimer);
  }
  // A stop that landed after the last step began still ends the run as stopped, never as a success it did not finish.
  const stopped = stop.signal.aborted || (!result.success && stopRequested());
  const timedOut = !stopped && deadline.signal.aborted;
  const otherFailure = Object.entries(result.steps).some(([id, s]) => s.status === "failed" && !parked.has(id));
  if (parked.size && !otherFailure && !timedOut) return parkReport(ctx, result, parked, timing, costs);

  if (result.success && def.output !== undefined) {
    const check = compileSchema(def.output)(result.output);
    if (!check.valid) result = { ...result, success: false, error: `Workflow output failed schema validation: ${check.errors?.join("; ") ?? "invalid"}` };
  }
  if (timedOut) result = { ...result, success: false, error: `timed_out: the run reached its deadline of ${def.deadline_ms}ms.` };

  const steps: Record<string, StepReport> = {};
  const ledgerSteps: Record<string, LedgerStep> = {};
  for (const id of Object.keys(def.steps)) {
    let s = result.steps[id] ?? { status: "skipped" as const, attempts: 0, error: "The run ended before this step was scheduled." };
    if (stopped && s.status !== "succeeded") s = { status: "skipped", attempts: s.attempts, error: STOPPED_STEP_MESSAGE };
    else if (afterDeadline.has(id)) s = { status: "skipped", attempts: 0, error: "The run reached its deadline before this step started." };
    else if (timedOut && s.status === "failed" && deadline.signal.reason instanceof DeadlineReached && s.error === deadline.signal.reason.message) s = { ...s, timed_out: true };
    else if (s.status === "skipped" && timedOut && s.attempts === 0) s = { ...s, error: "The run reached its deadline before this step started." };
    const trace = backoffTrace.get(id);
    if (trace && s.status !== "skipped") s = { ...s, attempts: Math.max(trace.attempts, 1), ...(trace.timedOut ? { timed_out: true } : {}) };
    const replayed = ctx.replay[id];
    if (replayed && s.status === "succeeded") s = { ...s, attempts: replayed.attempts };
    const t = timing.get(id);
    steps[id] = { status: s.status, attempts: s.attempts };
    ledgerSteps[id] = {
      status: s.status,
      attempts: s.attempts,
      started_at: t ? t.startedAt : null,
      duration_ms: t ? Math.max(0, t.endMs - t.startMs) : 0,
    };
    if (s.output !== undefined) {
      steps[id].output = s.output;
      ledgerSteps[id].output_digest = digest(s.output);
    }
    if (s.error !== undefined) {
      steps[id].error = s.error;
      ledgerSteps[id].error = oneLine(s.error);
    }
    if (s.timed_out) steps[id].timed_out = ledgerSteps[id].timed_out = true;
    const spent = costs.get(id);
    if (spent) Object.assign(ledgerSteps[id], ledgerCost(spent));
    const stderr = stderrOf.get(id);
    if (stderr && s.status === "failed") steps[id].stderr = stderr;
    const cost = costs.get(id);
    if (cost) steps[id].cost = cost;
    if (glanceOf.has(id)) steps[id].glance = glanceOf.get(id);
    if (trace?.delays.length) steps[id].retry_delays_ms = [...trace.delays];
    if (childRuns.has(id)) steps[id].child_run_id = childRuns.get(id);
  }

  const record: LedgerRecord & { parent_run_id?: string; run_status?: RunOutcome } = {
    schema: 1,
    run_id: runId,
    workflow: def.name,
    definition_path: ctx.path,
    definition_hash: ctx.hash,
    trigger: ctx.trigger.type,
    occurrence_key: ctx.occurrenceKey,
    data_class: def.data_class,
    runs_on: "local",
    started_at: ctx.startedAt,
    finished_at: clock().toISOString(),
    status: (stopped ? "stopped" : result.success ? "succeeded" : timedOut ? "timed_out" : "failed") as LedgerRecord["status"],
    steps: ledgerSteps,
    output_digest: result.success && !stopped && result.output !== undefined ? digest(result.output) : null,
    ...(stopped ? { error: STOPPED_MESSAGE } : result.error ? { error: oneLine(result.error) } : {}),
    ...(ctx.parentRunId ? { parent_run_id: ctx.parentRunId } : {}),
    ...(timedOut ? { run_status: "timed_out" as const } : {}),
  };
  // Payload values and the definition bytes are kept first; the ledger line is written last,
  // so a line in the ledger always has its snapshot and (for stored classes) its values.
  const warnings = [...ctx.warnings];
  saveDefinitionSnapshot(snapshotsRoot(ledger), ctx.hash, ctx.text);
  const store = artifactsRoot(ledger);
  for (const id of Object.keys(def.steps)) {
    const s = result.steps[id];
    if (!s || !timing.has(id) || ctx.replay[id]) continue;
    // ISC-282: an unattended run has no caller to read a failed command's stderr, so its tail is kept with the step's values.
    const unattendedStderr = s.status === "failed" && ctx.trigger.type !== "manual" ? stderrOf.get(id) : undefined;
    storeStepValues(store, runId, id, def.data_class, { input: inputs.get(id), output: s.output, ...(unattendedStderr ? { stderr: unattendedStderr } : {}) });
  }
  try {
    pruneStore(store, clock().getTime());
  } catch (error) {
    warnings.push(`Could not prune the payload store: ${message(error)}`);
  }
  // `workflow stop` may have closed the run already; one run gets one ledger line.
  if (!(stopped && readLedger(ledger).records.some(r => r.run_id === runId))) appendRecord(ledger, record);
  if (Object.keys(ctx.replay).length) clearWaiting(ledger, runId);

  const report: RunReport = {
    ...ctx.base,
    success: result.success && !stopped,
    status: stopped ? "stopped" : timedOut ? "timed_out" : result.success ? "succeeded" : "failed",
    run_id: runId,
    occurrence_key: ctx.occurrenceKey,
    ...(ctx.parentRunId ? { parent_run_id: ctx.parentRunId } : {}),
    ...(result.success ? { output: result.output } : {}),
    ...(result.error ? { error: result.error } : {}),
    steps,
    ledger,
    ...(warnings.length ? { warnings } : {}),
  };

  // ISC-147: a sampled run is scored after its line is written; an evaluator failure is a warning, never a run failure.
  if (def.evaluate && sampled(def.evaluate.sample_rate, opts.random ?? Math.random)) {
    try {
      report.evaluation = await evaluateRun(def.evaluate, { run_id: runId, workflow: def.name, status: report.status as string, ...(result.success ? { output: result.output } : { error: result.error }) }, { home, ledger, client: clients.model ?? liveModelClient, now: clock });
    } catch (error) {
      report.warnings = [...(report.warnings ?? []), `Evaluator failed: ${message(error)}`];
    }
  }
  return report;
}

/** How often a running run looks for its stop marker, in milliseconds. */
export const STOP_POLL_MS = 100;
export const STOPPED_MESSAGE = "Stopped by workflow stop.";
export const STOPPED_STEP_MESSAGE = "The run was stopped before this step finished.";

/** The ledger step's cost fields (ISC-128): lane, model, tier, tokens and dollars, never a payload. */
export function ledgerCost(cost: StepCost): Pick<LedgerStep, "lane" | "model" | "tier" | "tokens_in" | "tokens_out" | "cost_usd"> {
  return {
    lane: cost.lane,
    model: cost.model,
    tier: cost.service_tier,
    ...(cost.input_tokens !== null ? { tokens_in: cost.input_tokens } : {}),
    ...(cost.output_tokens !== null ? { tokens_out: cost.output_tokens } : {}),
    ...(typeof cost.cost_usd === "number" ? { cost_usd: cost.cost_usd } : {}),
  };
}

function setTrace(map: Map<string, AttemptTrace>, id: string): AttemptTrace {
  const trace: AttemptTrace = { attempts: 0, timedOut: false, delays: [] };
  map.set(id, trace);
  return trace;
}

/** Settles as soon as `signal` aborts, so an executor that ignores its signal cannot outlive the deadline. */
function raceAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((res, rej) => {
    const onAbort = () => rej(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      v => {
        signal.removeEventListener("abort", onAbort);
        res(v);
      },
      e => {
        signal.removeEventListener("abort", onAbort);
        rej(e);
      },
    );
  });
}

/** Writes the parked state and reports the run as waiting; no ledger line until it resumes and ends. */
function parkReport(
  ctx: RunContext,
  result: V1Result,
  parked: Map<string, string>,
  timing: Map<string, { startedAt: string; startMs: number; endMs: number }>,
  costs: Map<string, StepCost>,
): RunReport {
  const completed: Record<string, CompletedStep> = { ...ctx.replay };
  for (const [id, s] of Object.entries(result.steps)) {
    if (s.status !== "succeeded" || completed[id]) continue;
    const t = timing.get(id);
    const cost = costs.get(id);
    completed[id] = { output: s.output, attempts: s.attempts, started_at: t ? t.startedAt : null, duration_ms: t ? Math.max(0, t.endMs - t.startMs) : 0, ...(cost ? { cost } : {}) };
  }
  saveDefinitionSnapshot(snapshotsRoot(ctx.ledger), ctx.hash, ctx.text);
  parkRun(ctx.ledger, {
    schema: 1, run_id: ctx.runId, workflow: ctx.def.name, definition_path: ctx.path, definition_hash: ctx.hash,
    occurrence_key: ctx.occurrenceKey, trigger: ctx.trigger.type, started_at: ctx.startedAt, input: ctx.input,
    ...(ctx.parentRunId ? { parent_run_id: ctx.parentRunId } : {}),
    completed, waiting_on: [...parked.keys()], prompts: Object.fromEntries(parked), parked_at: ctx.clock().toISOString(),
  });
  notifyParked(ctx);
  const steps: Record<string, StepReport> = {};
  for (const id of Object.keys(ctx.def.steps)) {
    const s = result.steps[id];
    if (parked.has(id)) steps[id] = { status: "waiting", attempts: 1 };
    else if (completed[id]) steps[id] = { status: "succeeded", attempts: completed[id].attempts, output: completed[id].output };
    else steps[id] = { status: "pending", attempts: 0 };
    const cost = costs.get(id);
    if (cost) steps[id].cost = cost;
    void s;
  }
  return { ...ctx.base, success: false, status: "waiting", waiting_on: [...parked.keys()], run_id: ctx.runId, occurrence_key: ctx.occurrenceKey, steps, ledger: ctx.ledger };
}
