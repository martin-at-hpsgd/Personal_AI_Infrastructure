/**
 * The embedded runner (F24): the Workflows engine hosted inside another app's
 * Worker, running many v2 definitions against the host's own functions,
 * clients and storage.
 *
 * The cloud runner (runner.ts) hosts one definition per Worker and reaches its
 * actions over service bindings. Here the host hands over everything instead:
 *   definitions  YAML text, each `runs_on: cloud`, validated when the runner is created
 *   actions      host functions, each with a JSON Schema input and output contract (ISC-243)
 *   store        the only place run state lives: occurrence claims, ledger records,
 *                parked human runs (ISC-246, ISC-247)
 *   clients      the model and Glance clients `model` and `judgment` steps call (ISC-244, ISC-245)
 *   vigil        called once with the record of every finished run (ISC-248, ISC-249)
 *   authority    the names the host registers and the check a step's `authority:` runs (ISC-253, ISC-254)
 *   clock        the time source for claims, records and manual occurrence keys
 *
 * Execution reuses the engine: the definition compiles to a v1 graph and the v1
 * engine runs it (scheduling, `when`, `$ref` mappings, per-step schema checks,
 * retries and timeouts); the model and judgment executors are the local runner's own
 * (steps/model.ts, steps/judgment.ts) with the host's clients; backoff and the run
 * deadline come from steps/policy.ts; schedules match through match.ts.
 *
 * Refused when the runner is created, never at run time: command, agent and
 * workflow steps (a host Worker has no process, no agent session and no
 * definitions directory), `prompt_file` and `evaluate` (no files), `budget_usd_month`
 * (the spend ledger is local), artifact-ref outputs (no files to check), and
 * triggers other than manual, schedule and event (nothing would fire them; the host fires
 * an event through `emit`, ISC-256).
 *
 * This module never touches the file system; embedded-build.ts bundles it with
 * every `fs` import replaced by a module that throws, and ISC-247 checks the bundle.
 */
import { createHash } from "node:crypto";
import { invariant } from "../../TOOLS/Invariant.ts";
import { compileSchema, normalizeActionSchema, runWorkflow, type ActionRegistry, type V1Result } from "../engine/v1.ts";
import { analyzeDefinition, compiledUses, HUMAN_DECISION_SCHEMA, MAX_DEADLINE_MS, message, parseDefinitionText, toV1, type ActionContract, type DefinitionV2, type StepV2, type TriggerV2 } from "../engine/format.ts";
import { artifactRefFields, isTriggerRef, refsUnder, TRIGGER_INPUT_KEY } from "../engine/format-rules.ts";
import { assertRecord, digest, STEP_STATUSES, type LedgerRecord, type LedgerStep } from "../engine/ledger.ts";
import { AwaitingHuman, type CompletedStep, type HumanAnswer } from "../engine/human.ts";
import { executeModelStep, NonConformingReply } from "../engine/steps/model.ts";
import { declaredFallback, executeJudgmentStep } from "../engine/steps/judgment.ts";
import { DeadlineReached, runWithBackoff, StepTimedOut, type AttemptTrace } from "../engine/steps/policy.ts";
import type { JudgmentClient, ModelClient, StepCost } from "../engine/steps/types.ts";
import { contractIssues } from "./contracts.ts";
import { dueOccurrences } from "./match.ts";
import type { CloudLedgerRecord } from "./outbox.ts";

export type { HumanAnswer, CompletedStep } from "../engine/human.ts";
export type { JudgmentClient, JudgmentReply, JudgmentRequest, ModelClient, ModelReply, ModelRequest } from "../engine/steps/types.ts";

/* ── Host-facing types ──────────────────────────────────────────────────── */

/** The triggers an embedded definition may carry. */
export type EmbeddedTrigger = "manual" | "schedule" | "event";

export interface EmbeddedActionContext {
  workflow: string;
  step: string;
  run_id: string;
  occurrence_key: string;
  trigger: EmbeddedTrigger;
  attempt: number;
  /** Aborts on the step's timeout and on the run's deadline. */
  signal: AbortSignal;
}

/** One host function the definitions call as `uses: <name>`. Input and output are checked against the contracts on every call (ISC-243). */
export interface EmbeddedAction {
  input: unknown;
  output: unknown;
  run(input: unknown, ctx: EmbeddedActionContext): unknown | Promise<unknown>;
}

export type EmbeddedActionRegistry = Record<string, EmbeddedAction>;

/**
 * The record the store keeps for a run parked on human steps. Answers collect here until every waiting step has one.
 * Every change after the first park is a compare-and-swap on `version` (ISC-257); `state` says whether a
 * continuation has taken the run (ISC-258).
 */
export interface EmbeddedWaitingRun {
  schema: 1;
  /** 1 at the first park; every later write is the previous version plus one, re-parks included. */
  version: number;
  /** `waiting` collects answers; `resuming` means one continuation holds the run since `resuming_since`. */
  state: "waiting" | "resuming";
  /** ISO time the current continuation took the run; set only while `resuming`. */
  resuming_since?: string;
  run_id: string;
  workflow: string;
  /** The definition text the run started with; resume runs this, not whatever the host carries now. */
  definition: string;
  definition_hash: string;
  occurrence_key: string;
  trigger: EmbeddedTrigger;
  scheduled_for?: string;
  started_at: string;
  input: unknown;
  completed: Record<string, CompletedStep>;
  waiting_on: string[];
  prompts: Record<string, string>;
  answers: Record<string, HumanAnswer>;
  parked_at: string;
}

/** Why a run ended without doing its work. */
export type EmbeddedRefusal = "input" | "disabled" | "authority";

/**
 * The only error text a ledger or Vigil record carries (ISC-260). The raw message stays on the
 * in-memory outcome; the record keeps this category and `error_digest`, a sha256 hex prefix of it.
 */
export type EmbeddedErrorCategory =
  | "action_threw"
  | "input_contract"
  | "output_contract"
  | "timeout"
  | "deadline"
  | "authority_refused"
  | "authority_unavailable"
  | "model_schema"
  | "judgment_failed"
  | "store_failed";

export type EmbeddedLedgerStep = Omit<LedgerStep, "error" | "error_digest"> & { error?: EmbeddedErrorCategory; error_digest?: string };

/** A cloud ledger record, shaped so the engine's assertRecord accepts it; `refused` says why a refused run did not do its work. */
export type EmbeddedLedgerRecord = Omit<CloudLedgerRecord, "error" | "steps"> & {
  steps: Record<string, EmbeddedLedgerStep>;
  error?: EmbeddedErrorCategory;
  error_digest?: string;
  refused?: EmbeddedRefusal;
};

/**
 * Where every piece of run state lives (ISC-247). The runner keeps nothing between calls.
 * Every call is the host's (KV, D1, a Durable Object); the runner awaits it without its own timer,
 * so its wait is bounded by the host platform's subrequest limits.
 */
export interface EmbeddedStore {
  /** Claims a key for one run; false when it was claimed before. The once-only guarantee is as strong as this call is atomic. */
  claimOccurrence(workflow: string, occurrenceKey: string, runId: string): Promise<boolean>;
  /** Keeps one finished run's record. Called once per finished run, after the Vigil hook (ISC-263). */
  appendRecord(record: EmbeddedLedgerRecord): Promise<void>;
  /** Writes a parked run at its first park, or at a later human step it reached (a new park point, its version still counting up). */
  parkRun(state: EmbeddedWaitingRun): Promise<void>;
  /**
   * Compare-and-swap: replaces the parked run only when the stored version equals `expectedVersion`,
   * storing `next` (whose version is `expectedVersion + 1`). True only when it replaced it. Must be atomic.
   */
  updateParked(next: EmbeddedWaitingRun, expectedVersion: number): Promise<boolean>;
  readParked(runId: string): Promise<EmbeddedWaitingRun | null>;
  clearParked(runId: string): Promise<void>;
  /** The global pause (ISC-137 parity): true starts nothing. Absent means never paused. */
  paused?(): Promise<boolean>;
}

export interface EmbeddedStepClients {
  model?: ModelClient;
  judgment?: JudgmentClient;
}

export type VigilHook = (record: EmbeddedLedgerRecord) => void | Promise<void>;

export interface AuthorityContext {
  workflow: string;
  step: string;
  run_id: string;
  occurrence_key: string;
  trigger: EmbeddedTrigger;
  side_effects: readonly string[];
  /** The input the step would run with. */
  input: unknown;
}

export type AuthorityCheck = (name: string, ctx: AuthorityContext) => boolean | Promise<boolean>;

export interface EmbeddedAuthority {
  /** Every authority name the host registers; a definition naming any other is refused (ISC-253). */
  names: Iterable<string>;
  /** Asked once per name before a step carrying `authority:` runs; only `true` lets the step run (ISC-254). */
  check: AuthorityCheck;
}

export interface EmbeddedRunnerOptions {
  /** v2 definitions as YAML text, each `runs_on: cloud`, names unique. */
  definitions: readonly string[];
  actions: EmbeddedActionRegistry;
  store: EmbeddedStore;
  clients?: EmbeddedStepClients;
  /** Required (ISC-261): every finished run is reported here before its record is kept. */
  vigil: VigilHook;
  authority?: EmbeddedAuthority;
  /** Glance caller names the judgment client answers for; a judgment step naming any other is refused. */
  callers?: Iterable<string>;
  /** Whether a definition's `sop` resolves; an unresolved SOP is a warning only. Defaults to unresolved. */
  resolveSop?: (sop: string) => boolean;
  clock?: () => Date;
}

export interface EmbeddedStepReport {
  status: "succeeded" | "failed" | "skipped" | "waiting" | "pending";
  attempts: number;
  output?: unknown;
  error?: string;
  timed_out?: boolean;
  cost?: StepCost;
  /** The Glance reply behind a judgment step, kept even when a shadow caller cannot gate (ISC-132). */
  glance?: unknown;
  /** The host authority that refused this step. */
  refused_by?: string;
}

export type VigilDelivery = { delivered: true } | { delivered: false; reason: "threw" | "timed_out"; error?: string };

export interface EmbeddedFinishedRun {
  status: "succeeded" | "failed" | "timed_out" | "refused";
  workflow: string;
  run_id: string;
  occurrence_key: string;
  record: EmbeddedLedgerRecord;
  output?: unknown;
  error?: string;
  refused?: EmbeddedRefusal;
  steps: Record<string, EmbeddedStepReport>;
  vigil: VigilDelivery;
}

export interface EmbeddedWaitingOutcome {
  status: "waiting";
  workflow: string;
  run_id: string;
  occurrence_key: string;
  waiting_on: string[];
  prompts: Record<string, string>;
  steps: Record<string, EmbeddedStepReport>;
}

export type EmbeddedRunOutcome =
  | { status: "paused"; workflow: string }
  | { status: "duplicate"; workflow: string; occurrence_key: string }
  | EmbeddedWaitingOutcome
  | EmbeddedFinishedRun;

export interface EmbeddedScheduledResult {
  workflow: string;
  occurrence_key: string;
  outcome?: EmbeddedRunOutcome;
  /** Set when the run threw (a store failure); one workflow's failure never stops another's run. */
  error?: string;
}

export interface EmbeddedRunner {
  /** The workflow names this runner hosts, in the order given. */
  readonly workflows: readonly string[];
  /** Warnings the validator raised per workflow (an unresolved SOP, for one). */
  readonly warnings: Readonly<Record<string, readonly string[]>>;
  definition(name: string): DefinitionV2;
  /** Runs one workflow now through its manual trigger. A fresh occurrence key per call unless one is given. */
  run(name: string, input?: unknown, opts?: { occurrenceKey?: string }): Promise<EmbeddedRunOutcome>;
  /** Fires a named event: runs every hosted workflow with an enabled `event` trigger of that name, each once per occurrence key (ISC-256). */
  emit(event: string, input: unknown, opts: { occurrenceKey: string }): Promise<EmbeddedScheduledResult[]>;
  /** Records the answer for one waiting human step; once every waiting step has one, the run continues. */
  resume(runId: string, stepId: string, answer: HumanAnswer): Promise<EmbeddedRunOutcome>;
  /** The host's cron entry: fires every definition whose schedule is due at this minute, each occurrence once (ISC-250). */
  scheduled(scheduledTime: number): Promise<EmbeddedScheduledResult[]>;
}

/** Every reason the host's definitions cannot be hosted, one line each, prefixed by workflow. */
export class EmbeddedDefinitionError extends Error {
  constructor(readonly problems: string[]) {
    super(`The embedded runner cannot host these definitions:\n- ${problems.join("\n- ")}`);
    this.name = "EmbeddedDefinitionError";
  }
}

/* ── Constants ──────────────────────────────────────────────────────────── */

/** A Vigil hook gets this long; past it the run's result returns without waiting further. */
export const VIGIL_TIMEOUT_MS = 10_000;
const LEDGER_ERROR_CHARS = 300;
const RUN_ID_RE = /^[A-Za-z0-9-]{8,}$/;
const EMBEDDABLE_KINDS: ReadonlySet<StepV2["kind"]> = new Set(["action", "model", "judgment", "human"]);
const EMBEDDABLE_TRIGGERS: ReadonlySet<TriggerV2["type"]> = new Set(["manual", "schedule", "event"]);
/** The validator's definitions home; nothing is read from it because prompt_file and evaluate are refused first. */
const NO_HOME = "/embedded-runner/no-definitions-home";
const REFUSED_BEFORE_START = "The run was refused before any step started.";
/** Hex characters of sha256 kept as a record's error digest: enough to match two failures, too few to carry the text. */
const ERROR_DIGEST_HEX = 16;
/** How many times resume re-reads and retries after losing a compare-and-swap to another writer. */
const RESUME_CAS_ATTEMPTS = 8;

/** One line for the in-memory outcome only; records never carry it (ISC-260). */
const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim().slice(0, LEDGER_ERROR_CHARS);
const sha256Hex = (text: string): string => createHash("sha256").update(text).digest("hex");
const errorDigest = (raw: string): string => sha256Hex(raw).slice(0, ERROR_DIGEST_HEX);

/* ── Preparation ────────────────────────────────────────────────────────── */

interface Prepared {
  def: DefinitionV2;
  text: string;
  hash: string;
  warnings: string[];
}

interface RunnerConfig {
  actions: EmbeddedActionRegistry;
  clients: EmbeddedStepClients;
  authority?: EmbeddedAuthority;
  authorityNames: string[];
  callers: string[];
  resolveSop: (sop: string) => boolean;
}

/** Checks each host action's own shape once: a run function and two compilable, specific contracts (ISC-35 parity). */
function actionProblems(actions: EmbeddedActionRegistry, used: ReadonlySet<string>): string[] {
  const problems: string[] = [];
  for (const name of used) {
    const action = Object.hasOwn(actions, name) ? actions[name] : undefined;
    if (!action) continue;
    if (typeof action.run !== "function") problems.push(`action ${name}: run is not a function`);
    try {
      compileSchema(normalizeActionSchema(action.input));
      compileSchema(normalizeActionSchema(action.output));
    } catch (error) {
      problems.push(`action ${name}: ${message(error)}`);
      continue;
    }
    for (const issue of contractIssues(name, action.input, action.output)) problems.push(`action ${issue}`);
  }
  return problems;
}

/** Parses and validates one definition for this host; returns the problems instead of throwing. */
function prepare(text: string, config: RunnerConfig, label: string): { prepared?: Prepared; problems: string[] } {
  let def: DefinitionV2;
  try {
    def = parseDefinitionText(text, undefined, config.authority ? { authorities: config.authorityNames } : {});
  } catch (error) {
    return { problems: [`${label}: ${message(error)}`] };
  }
  const problems: string[] = [];
  const at = (text: string) => problems.push(`${def.name}: ${text}`);
  if (def.runs_on !== "cloud") at(`runs_on is ${def.runs_on}; an embedded definition runs in the host's Worker, so it must be runs_on: cloud`);
  if (def.evaluate) at("evaluate needs a criteria file and the local evaluator; the embedded runner has neither");
  if (def.budget_usd_month !== undefined) at("budget_usd_month is enforced against the local spend ledger, which the embedded runner does not have");
  for (const [i, t] of def.triggers.entries()) {
    if (!EMBEDDABLE_TRIGGERS.has(t.type)) at(`trigger ${i + 1} is a ${t.type} trigger; the embedded runner fires manual, schedule and event triggers only`);
  }
  const contracts = new Map<string, ActionContract>();
  for (const step of Object.values(def.steps)) {
    const where = `step "${step.id}"`;
    if (!EMBEDDABLE_KINDS.has(step.kind)) {
      at(`${where} is a ${step.kind} step; the embedded runner runs action, model, judgment and human steps`);
      continue;
    }
    if (step.prompt_file !== undefined) at(`${where} uses prompt_file; an embedded step carries its prompt inline`);
    if (step.authority !== undefined && !config.authority) at(`${where} names authority ${step.authority.join(", ")} but the host registers no authority check`);
    if (step.kind === "action") {
      const uses = step.uses as string;
      const action = Object.hasOwn(config.actions, uses) ? config.actions[uses] : undefined;
      if (!action) at(`${where} uses ${uses}, which the host does not provide`);
      else contracts.set(uses, { input: normalizeActionSchema(action.input), output: normalizeActionSchema(action.output) });
    }
    if (step.kind === "model" && !config.clients.model) at(`${where} is a model step but the host injects no model client`);
    if (step.kind === "judgment" && !config.clients.judgment) at(`${where} is a judgment step but the host injects no judgment client`);
    const output = step.kind === "action" ? contracts.get(step.uses as string)?.output : step.output;
    if ((step.artifact_refs ?? []).length || artifactRefFields(output).fields.length) at(`${where} declares artifact-ref output; the embedded runner has no files to check them against`);
  }
  if (problems.length) return { problems };
  const analysis = analyzeDefinition(def, { contracts, callers: config.callers, resolveSop: config.resolveSop, home: NO_HOME });
  if (!analysis.valid) return { problems: analysis.errors.map(e => `${def.name}: ${e}`) };
  return { prepared: { def, text, hash: sha256Hex(text), warnings: analysis.warnings }, problems: [] };
}

/* ── Run helpers ────────────────────────────────────────────────────────── */

/** Same rule as the local and cloud runners: the reserved trigger key is added only when a step or the result reads it. */
function graphInput(def: DefinitionV2, input: unknown, trigger: Record<string, unknown>): unknown {
  const reads = Object.values(def.steps).some(s => [...refsUnder(s.with, "")].some(r => isTriggerRef(r.ref)) || (s.when !== undefined && isTriggerRef(s.when.ref)))
    || [...refsUnder(def.result, "")].some(r => isTriggerRef(r.ref));
  if (!reads || input === null || typeof input !== "object" || Array.isArray(input)) return input;
  return { ...(input as Record<string, unknown>), [TRIGGER_INPUT_KEY]: trigger };
}

/** Settles as soon as `signal` aborts, so a host function that ignores its signal cannot outlive the step. */
function raceAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((res, rej) => {
    const onAbort = () => rej(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      v => { signal.removeEventListener("abort", onAbort); res(v); },
      e => { signal.removeEventListener("abort", onAbort); rej(e); },
    );
  });
}

const countable = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;

/**
 * The ledger step's cost fields (ISC-128), same mapping as the local runner's ledgerCost. A token count the
 * client reported as negative or non-finite is left out, and so is the cost built on it: an unusable figure is
 * no cost, never a record the ledger check would reject (ISC-262).
 */
function costFields(cost: StepCost): Pick<LedgerStep, "lane" | "model" | "tier" | "tokens_in" | "tokens_out" | "cost_usd"> {
  const tokensOk = countable(cost.input_tokens) && countable(cost.output_tokens);
  return {
    lane: cost.lane, model: cost.model, tier: cost.service_tier,
    ...(countable(cost.input_tokens) ? { tokens_in: cost.input_tokens } : {}),
    ...(countable(cost.output_tokens) ? { tokens_out: cost.output_tokens } : {}),
    ...(tokensOk && countable(cost.cost_usd) ? { cost_usd: cost.cost_usd } : {}),
  };
}

/** Thrown inside a step the host's authority refused or could not answer for; the step is skipped and the run is refused and stops (ISC-264). */
class StepRefused extends Error {
  constructor(readonly stepId: string, readonly authority: string, readonly category: "authority_refused" | "authority_unavailable", readonly why: string) {
    super(`Step "${stepId}" was refused by host authority "${authority}": ${why}`);
    this.name = "StepRefused";
  }
}

/** Delivers a record to the Vigil hook. Never throws and never waits past VIGIL_TIMEOUT_MS (ISC-249). */
async function deliverVigil(hook: VigilHook, record: EmbeddedLedgerRecord): Promise<VigilDelivery> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<"timeout">(res => { timer = setTimeout(() => res("timeout"), VIGIL_TIMEOUT_MS); });
    const sent = Promise.resolve().then(() => hook(structuredClone(record))).then(() => "sent" as const);
    const settled = await Promise.race([sent, timeout]);
    if (settled === "timeout") {
      sent.catch(() => { /* a late rejection after the timeout has nowhere to go */ });
      return { delivered: false, reason: "timed_out" };
    }
    return { delivered: true };
  } catch (error) {
    return { delivered: false, reason: "threw", error: oneLine(message(error)) };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function assertWaiting(state: EmbeddedWaitingRun): void {
  invariant(state.schema === 1, "A parked run needs schema 1");
  invariant(Number.isSafeInteger(state.version) && state.version >= 1, `A parked run's version must be a positive integer, got ${String(state.version)}`);
  invariant(state.state === "waiting" || state.state === "resuming", `A parked run's state must be waiting or resuming, got ${String(state.state)}`);
  invariant(RUN_ID_RE.test(state.run_id), `Not a run id: ${state.run_id}`);
  invariant(state.waiting_on.length > 0, "A parked run must be waiting on at least one human step");
  for (const id of state.waiting_on) invariant(!Object.hasOwn(state.completed, id), `Step "${id}" cannot be both waiting and completed`);
  for (const id of Object.keys(state.answers)) invariant(state.waiting_on.includes(id), `Answer for step "${id}" belongs to no waiting step`);
  invariant(sha256Hex(state.definition) === state.definition_hash, "A parked run's definition text must match its hash");
  if (state.state === "resuming") {
    invariant(typeof state.resuming_since === "string" && Number.isFinite(Date.parse(state.resuming_since)), "A resuming run needs a resuming_since timestamp");
    invariant(state.waiting_on.every(id => Object.hasOwn(state.answers, id)), "A run resumes only once every waiting step is answered");
  } else {
    invariant(state.resuming_since === undefined, "A waiting run carries no resuming_since");
  }
}

const sameAnswer = (a: HumanAnswer, b: HumanAnswer): boolean => a.approved === b.approved && a.note === b.note;

function checkedAnswer(answer: unknown): HumanAnswer {
  if (answer === null || typeof answer !== "object" || typeof (answer as HumanAnswer).approved !== "boolean") throw new Error("A human answer needs a boolean approved");
  const note = (answer as HumanAnswer).note;
  if (note !== undefined && typeof note !== "string") throw new Error("A human answer note must be a string");
  return note === undefined ? { approved: (answer as HumanAnswer).approved } : { approved: (answer as HumanAnswer).approved, note };
}

/* ── The runner ─────────────────────────────────────────────────────────── */

interface RunState {
  prepared: Prepared;
  runId: string;
  occurrenceKey: string;
  trigger: EmbeddedTrigger;
  scheduledFor?: string;
  startedAt: string;
  input: unknown;
  replay: Record<string, CompletedStep>;
  answers: Record<string, HumanAnswer>;
  /** The parked version a resumed continuation holds; a re-park writes the next one. Absent on a first run. */
  parkedVersion?: number;
}

/** A finished run's record and Vigil result, plus the reason when the full record was rejected and a minimal one went out instead. */
interface Finished {
  record: EmbeddedLedgerRecord;
  vigil: VigilDelivery;
  rejected?: string;
}

export function createEmbeddedRunner(opts: EmbeddedRunnerOptions): EmbeddedRunner {
  if (!opts || !Array.isArray(opts.definitions) || opts.definitions.length === 0) throw new EmbeddedDefinitionError(["definitions must be a non-empty list of YAML texts"]);
  if (!opts.actions || typeof opts.actions !== "object") throw new EmbeddedDefinitionError(["actions must be an object of host functions"]);
  const store = opts.store;
  for (const method of ["claimOccurrence", "appendRecord", "parkRun", "updateParked", "readParked", "clearParked"] as const) {
    if (!store || typeof store[method] !== "function") throw new EmbeddedDefinitionError([`store.${method} must be a function`]);
  }
  // ISC-261: a runner that could finish a run without telling Vigil is never created.
  if (typeof opts.vigil !== "function") throw new EmbeddedDefinitionError(["vigil must be a function: every finished run is reported to Vigil"]);
  const vigilHook = opts.vigil;
  if (opts.authority && typeof opts.authority.check !== "function") throw new EmbeddedDefinitionError(["authority.check must be a function"]);
  const clock = opts.clock ?? (() => new Date());
  const config: RunnerConfig = {
    actions: opts.actions,
    clients: opts.clients ?? {},
    ...(opts.authority ? { authority: opts.authority } : {}),
    authorityNames: opts.authority ? [...opts.authority.names] : [],
    callers: opts.callers ? [...opts.callers] : [],
    resolveSop: opts.resolveSop ?? (() => false),
  };

  const byName = new Map<string, Prepared>();
  const byHash = new Map<string, Prepared>();
  const problems: string[] = [];
  const used = new Set<string>();
  for (const [i, text] of opts.definitions.entries()) {
    if (typeof text !== "string") {
      problems.push(`definition ${i + 1} is not YAML text`);
      continue;
    }
    const { prepared, problems: found } = prepare(text, config, `definition ${i + 1}`);
    problems.push(...found);
    if (!prepared) continue;
    if (byName.has(prepared.def.name)) {
      problems.push(`${prepared.def.name}: defined more than once`);
      continue;
    }
    for (const step of Object.values(prepared.def.steps)) if (step.kind === "action") used.add(step.uses as string);
    byName.set(prepared.def.name, prepared);
    byHash.set(prepared.hash, prepared);
  }
  problems.push(...actionProblems(opts.actions, used));
  if (problems.length) throw new EmbeddedDefinitionError(problems);

  /** A parked run's definition: the hosted one when unchanged, else the parked text validated for this host now. */
  function preparedFor(state: EmbeddedWaitingRun): Prepared {
    const same = byHash.get(state.definition_hash);
    if (same) return same;
    const { prepared, problems: found } = prepare(state.definition, config, `parked run ${state.run_id}`);
    if (!prepared) throw new EmbeddedDefinitionError(found);
    return prepared;
  }

  /**
   * The record that goes out when the full one fails the ledger check (ISC-262): the run marked failed, each step
   * reduced to its status and attempt count, and the rejection kept only as a digest.
   */
  function minimalRecord(full: EmbeddedLedgerRecord, rejection: string): EmbeddedLedgerRecord {
    const steps: Record<string, EmbeddedLedgerStep> = {};
    for (const [id, s] of Object.entries(full.steps)) {
      steps[id] = {
        status: (STEP_STATUSES as readonly string[]).includes(s?.status) ? s.status : "failed",
        attempts: Number.isSafeInteger(s?.attempts) && s.attempts >= 0 ? s.attempts : 0,
      };
    }
    return {
      schema: full.schema, run_id: full.run_id, workflow: full.workflow, definition_path: full.definition_path, definition_hash: full.definition_hash,
      trigger: full.trigger, occurrence_key: full.occurrence_key, data_class: full.data_class, runs_on: "cloud",
      started_at: full.started_at, finished_at: full.finished_at, status: "failed", steps, output_digest: null,
      error: "store_failed", error_digest: errorDigest(rejection),
    };
  }

  /**
   * Closes a finished run. Vigil hears first (ISC-263), so a crash after it leaves a Vigil line and never a silent
   * record; then the parked state is cleared, so a dead process can never leave a finished run retakeable; then the
   * record is kept. A record the ledger check rejects is replaced by a minimal failed one (ISC-262). The hook is
   * called exactly once whatever the store does (ISC-248); a store failure is thrown after it.
   */
  async function finishRecord(state: RunState, full: EmbeddedLedgerRecord, clearParked: boolean): Promise<Finished> {
    let record = full;
    let rejected: string | undefined;
    let keepable = true;
    try {
      assertRecord(full as unknown as LedgerRecord);
    } catch (error) {
      rejected = message(error);
      record = minimalRecord(full, rejected);
      try {
        assertRecord(record as unknown as LedgerRecord);
      } catch {
        keepable = false;
      }
    }
    const vigil = await deliverVigil(vigilHook, record);
    let failure: unknown;
    if (clearParked) {
      try {
        await store.clearParked(state.runId);
      } catch (error) {
        failure = error;
      }
    }
    if (keepable) {
      try {
        await store.appendRecord(structuredClone(record));
      } catch (error) {
        failure ??= error;
      }
    } else {
      failure ??= new Error(`Run ${state.runId}'s record failed the ledger check even reduced to a minimal one (${rejected}); Vigil has it, the store does not.`);
    }
    if (failure !== undefined) throw failure;
    return { record, vigil, ...(rejected !== undefined ? { rejected } : {}) };
  }

  async function refuseRun(state: RunState, refused: EmbeddedRefusal, error: string): Promise<EmbeddedFinishedRun> {
    const { def, hash } = state.prepared;
    const steps: Record<string, EmbeddedLedgerStep> = {};
    const reports: Record<string, EmbeddedStepReport> = {};
    for (const id of Object.keys(def.steps)) {
      steps[id] = { status: "skipped", attempts: 0, started_at: null, duration_ms: 0 };
      reports[id] = { status: "skipped", attempts: 0, error: REFUSED_BEFORE_START };
    }
    const record: EmbeddedLedgerRecord = {
      schema: 1, run_id: state.runId, workflow: def.name, definition_path: `embedded:${def.name}`, definition_hash: hash,
      trigger: state.trigger, occurrence_key: state.occurrenceKey, data_class: def.data_class, runs_on: "cloud",
      started_at: state.startedAt, finished_at: clock().toISOString(), status: "failed", steps, output_digest: null,
      // A disabled workflow is not an error; `refused` says why. A bad input is an input contract failure.
      ...(refused === "input" ? { error: "input_contract" as const, error_digest: errorDigest(error) } : {}),
      refused,
    };
    const finished = await finishRecord(state, record, false);
    return { status: finished.rejected ? "failed" : "refused", workflow: def.name, run_id: state.runId, occurrence_key: state.occurrenceKey, record: finished.record, error: finished.rejected ?? error, ...(finished.rejected ? {} : { refused }), steps: reports, vigil: finished.vigil };
  }

  async function execute(state: RunState): Promise<EmbeddedRunOutcome> {
    const { def } = state.prepared;
    const clients = config.clients;
    const costs = new Map<string, StepCost>(Object.entries(state.replay).flatMap(([id, c]) => (c.cost ? [[id, c.cost] as [string, StepCost]] : [])));
    const glanceOf = new Map<string, unknown>();
    const parked = new Map<string, string>();
    const refused = new Map<string, StepRefused>();
    const authorityVerdicts = new Map<string, Promise<StepRefused | null>>();
    const backoffTrace = new Map<string, AttemptTrace>();
    const afterDeadline = new Set<string>();
    const timing = new Map<string, { startedAt: string; startMs: number; endMs: number }>();

    // ISC-55 parity: one run-wide deadline; a step that would start after it never runs.
    const deadline = new AbortController();
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    if (def.deadline_ms !== undefined) {
      const elapsed = clock().getTime() - Date.parse(state.startedAt);
      deadlineTimer = setTimeout(() => deadline.abort(new DeadlineReached(def.deadline_ms as number)), Math.max(0, def.deadline_ms - elapsed));
    }

    /** The first refusal; once set, no step that has not started yet starts, whatever its on_error (ISC-264). */
    let halt: StepRefused | undefined;
    const halted = new Set<string>();
    /** Why each step failed, decided where the error was thrown (ISC-260); the record carries only this. */
    const categoryOf = new Map<string, EmbeddedErrorCategory>();

    /**
     * Asks the host about every authority a step names, once per run; the first no refuses it (ISC-254).
     * The whole check is bounded by the step's timeout and by `signal` (the run deadline): a check that throws,
     * or that has not settled in time, refuses the step as authority_unavailable (ISC-265).
     */
    const authorize = (step: StepV2, input: unknown, signal: AbortSignal): Promise<StepRefused | null> => {
      const known = authorityVerdicts.get(step.id);
      if (known) return known;
      const check = config.authority?.check;
      invariant(check !== undefined, `Step "${step.id}" carries authority but the runner holds no check`);
      const names = step.authority ?? [];
      invariant(names.length > 0, `Step "${step.id}" carries an empty authority list`);
      const limitMs = step.timeout_ms ?? def.defaults?.timeout_ms ?? MAX_DEADLINE_MS;
      let asking = names[0];
      const asked = (async (): Promise<StepRefused | null> => {
        for (const name of names) {
          asking = name;
          let allowed: unknown;
          try {
            allowed = await check(name, {
              workflow: def.name, step: step.id, run_id: state.runId, occurrence_key: state.occurrenceKey,
              trigger: state.trigger, side_effects: [...step.side_effects], input: structuredClone(input),
            });
          } catch (error) {
            return new StepRefused(step.id, name, "authority_unavailable", `the check threw: ${message(error)}`);
          }
          if (allowed !== true) return new StepRefused(step.id, name, "authority_refused", "the check said no");
        }
        return null;
      })();
      const verdict = new Promise<StepRefused | null>(res => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const settle = (value: StepRefused | null) => {
          if (timer !== undefined) clearTimeout(timer);
          signal.removeEventListener("abort", onAbort);
          res(value);
        };
        const onAbort = () => settle(new StepRefused(step.id, asking, "authority_unavailable", "the run was stopped (its deadline) before the check settled"));
        if (signal.aborted) return onAbort();
        signal.addEventListener("abort", onAbort, { once: true });
        timer = setTimeout(() => settle(new StepRefused(step.id, asking, "authority_unavailable", `the check did not settle within the step timeout of ${limitMs}ms`)), limitMs);
        asked.then(settle, error => settle(new StepRefused(step.id, asking, "authority_unavailable", `the check failed: ${message(error)}`)));
      });
      authorityVerdicts.set(step.id, verdict);
      return verdict;
    };

    /** The category of an error a step's own work threw; contract failures are found by the engine instead (see stepCategory). */
    const thrownCategory = (step: StepV2, error: unknown, stepSignal: AbortSignal): EmbeddedErrorCategory => {
      if (error instanceof DeadlineReached || (deadline.signal.aborted && error === deadline.signal.reason)) return "deadline";
      if (error instanceof StepTimedOut || stepSignal.aborted) return "timeout";
      if (step.kind === "model") return error instanceof NonConformingReply ? "model_schema" : "action_threw";
      if (step.kind === "judgment") return "judgment_failed";
      return "action_threw";
    };

    /** Steps that run their own retries: exponential backoff (as locally) and authority steps, so a refusal is never retried. */
    const ownsRetries = (step: StepV2): boolean => step.retry_backoff === "exponential" || step.authority !== undefined;

    const wrap = (step: StepV2, contract: { input?: unknown; output?: unknown }, run: (input: unknown, signal: AbortSignal, attempt: number) => Promise<unknown>): ActionRegistry[string] => ({
      ...contract,
      async execute(stepInput, context) {
        const replayed = state.replay[step.id];
        if (replayed) {
          timing.set(step.id, { startedAt: replayed.started_at ?? state.startedAt, startMs: 0, endMs: replayed.duration_ms });
          return replayed.output;
        }
        const stopIfHalted = () => {
          if (!halt) return;
          halted.add(step.id);
          throw halt;
        };
        const stopIfPastDeadline = () => {
          if (!deadline.signal.aborted) return;
          afterDeadline.add(step.id);
          throw deadline.signal.reason;
        };
        stopIfHalted();
        stopIfPastDeadline();
        if (step.authority !== undefined) {
          const no = await authorize(step, stepInput, AbortSignal.any([context.signal, deadline.signal]));
          if (no) {
            refused.set(step.id, no);
            halt ??= no;
            throw no;
          }
          // Another step may have been refused, or the deadline passed, while this one was being checked.
          stopIfHalted();
          stopIfPastDeadline();
        }
        const t0 = Date.now();
        const record = timing.get(step.id) ?? { startedAt: new Date(t0).toISOString(), startMs: t0, endMs: t0 };
        timing.set(step.id, record);
        const signal = AbortSignal.any([context.signal, deadline.signal]);
        try {
          if (!ownsRetries(step)) return await raceAbort(run(stepInput, signal, context.attempt), signal);
          const trace = backoffTrace.get(step.id) ?? { attempts: 0, timedOut: false, delays: [] };
          backoffTrace.set(step.id, trace);
          return await runWithBackoff(step, def.defaults, (s, attempt) => raceAbort(run(stepInput, s, attempt), s), { signal, trace });
        } catch (error) {
          if (!(error instanceof AwaitingHuman)) categoryOf.set(step.id, thrownCategory(step, error, context.signal));
          throw error;
        } finally {
          record.endMs = Date.now();
        }
      },
    });

    const actionContext = (step: StepV2, signal: AbortSignal, attempt: number): EmbeddedActionContext => ({
      workflow: def.name, step: step.id, run_id: state.runId, occurrence_key: state.occurrenceKey, trigger: state.trigger, attempt, signal,
    });

    const registry: ActionRegistry = Object.create(null);
    for (const step of Object.values(def.steps)) {
      const uses = compiledUses(step.id);
      switch (step.kind) {
        case "action": {
          const action = config.actions[step.uses as string];
          registry[uses] = wrap(step, { input: normalizeActionSchema(action.input), output: normalizeActionSchema(action.output) },
            async (i, signal, attempt) => action.run(i, actionContext(step, signal, attempt)));
          break;
        }
        case "model": {
          const client = clients.model as ModelClient;
          registry[uses] = wrap(step, { input: step.input, output: step.output }, async (i, signal) => {
            try {
              const result = await executeModelStep({ lane: step.lane as string, prompt: step.prompt ?? "", input: i, output: step.output, stepId: step.id, trigger: state.trigger, signal }, client);
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
          const client = clients.judgment as JudgmentClient;
          registry[uses] = wrap(step, { input: step.input, output: step.output }, async (i, signal) => {
            const out = await executeJudgmentStep({ workflow: def.name, stepId: step.id, caller: step.caller as string, question: step.question as string, state: i, fallback: declaredFallback(step as unknown as Record<string, unknown>), signal }, client);
            glanceOf.set(step.id, out.glance);
            return out;
          });
          break;
        }
        case "human": {
          registry[uses] = wrap(step, { input: step.input, output: step.output ?? HUMAN_DECISION_SCHEMA }, async () => {
            if (Object.hasOwn(state.answers, step.id)) return state.answers[step.id];
            const waiting = new AwaitingHuman(step.id, step.prompt ?? "");
            parked.set(step.id, waiting.prompt);
            throw waiting;
          });
          break;
        }
        default:
          // prepare() refuses every other kind before a runner exists.
          invariant(false, `Step "${step.id}" is a ${step.kind} step, which the embedded runner never accepts`);
      }
    }

    const graph = toV1(def);
    for (const step of Object.values(def.steps)) {
      if (!ownsRetries(step)) continue;
      // runWithBackoff holds the retry loop and per-attempt timeout; the v1 engine gets one attempt and the 24-hour ceiling.
      const compiled = graph.steps[step.id] as unknown as Record<string, unknown>;
      compiled.retries = 0;
      delete compiled.retry_delay_ms;
      compiled.timeout_ms = MAX_DEADLINE_MS;
    }
    const triggerCtx = { type: state.trigger, occurrence_key: state.occurrenceKey, run_id: state.runId, ...(state.scheduledFor ? { scheduled_for: state.scheduledFor } : {}) };
    const withTrigger = graphInput(def, state.input, triggerCtx);
    // The workflow input was checked against its schema before the claim; the trigger key is not part of it.
    if (withTrigger !== state.input) delete graph.input;

    let result: V1Result;
    try {
      result = await runWorkflow(graph, withTrigger, registry);
    } catch (error) {
      result = { success: false, error: message(error), steps: {} };
    } finally {
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
    }

    const timedOut = deadline.signal.aborted;
    const otherFailure = Object.entries(result.steps).some(([id, s]) => s.status === "failed" && !parked.has(id));
    if (parked.size && !otherFailure && !timedOut && !halt) return park(state, result, parked, timing, costs);

    let outputBroken = false;
    if (result.success && def.output !== undefined) {
      const check = compileSchema(def.output)(result.output);
      if (!check.valid) {
        outputBroken = true;
        result = { ...result, success: false, error: `Workflow output failed schema validation: ${check.errors?.join("; ") ?? "invalid"}` };
      }
    }
    if (timedOut) result = { ...result, success: false, error: `timed_out: the run reached its deadline of ${def.deadline_ms}ms.` };
    else if (halt) result = { ...result, success: false, error: halt.message };

    /** The record's error for one step (ISC-260): a category decided where it failed, never its text. */
    const stepCategory = (id: string, s: V1Result["steps"][string]): EmbeddedErrorCategory | undefined => {
      const no = refused.get(id);
      if (no) return no.category;
      if (halted.has(id)) return halt?.category;
      if (afterDeadline.has(id)) return "deadline";
      // A human step still waiting when another step failed was never answered; it did not fail on its own.
      if (s.status !== "failed" || parked.has(id)) return undefined;
      const thrown = categoryOf.get(id);
      if (thrown) return thrown;
      if (s.timed_out) return "timeout";
      // The engine's own contract checks, which run outside the step's code; their prefixes are engine text.
      if (s.error?.startsWith(`Input for step "${id}"`)) return "input_contract";
      if (s.error?.startsWith(`Output for step "${id}"`)) return "output_contract";
      return "action_threw";
    };

    const reports: Record<string, EmbeddedStepReport> = {};
    const steps: Record<string, EmbeddedLedgerStep> = {};
    let firstFailed: EmbeddedErrorCategory | undefined;
    for (const id of Object.keys(def.steps)) {
      let s: V1Result["steps"][string] = result.steps[id] ?? { status: "skipped", attempts: 0, error: "The run ended before this step was scheduled." };
      const no = refused.get(id);
      const category = stepCategory(id, s);
      if (no) s = { status: "skipped", attempts: 0, error: no.message };
      else if (halted.has(id)) s = { status: "skipped", attempts: 0, error: `Not started: the run stopped when ${halt?.message ?? "a step was refused"}` };
      else if (afterDeadline.has(id)) s = { status: "skipped", attempts: 0, error: "The run reached its deadline before this step started." };
      else if (timedOut && s.status === "failed" && deadline.signal.reason instanceof DeadlineReached && s.error === deadline.signal.reason.message) s = { ...s, timed_out: true };
      if (s.status === "failed" && category !== undefined) firstFailed ??= category;
      const trace = backoffTrace.get(id);
      if (trace && !no && s.status !== "skipped") s = { ...s, attempts: Math.max(trace.attempts, 1), ...(trace.timedOut ? { timed_out: true } : {}) };
      const replayed = state.replay[id];
      if (replayed && s.status === "succeeded") s = { ...s, attempts: replayed.attempts };
      const t = timing.get(id);
      const ran = t !== undefined && !no && !halted.has(id);
      steps[id] = { status: s.status, attempts: s.attempts, started_at: ran ? t.startedAt : null, duration_ms: ran ? Math.max(0, t.endMs - t.startMs) : 0 };
      reports[id] = { status: s.status, attempts: s.attempts };
      if (s.output !== undefined) {
        steps[id].output_digest = digest(s.output);
        reports[id].output = s.output;
      }
      if (s.error !== undefined) reports[id].error = s.error;
      if (category !== undefined) {
        steps[id].error = category;
        steps[id].error_digest = errorDigest(s.error ?? category);
      }
      if (s.timed_out) steps[id].timed_out = reports[id].timed_out = true;
      const cost = costs.get(id);
      if (cost) {
        Object.assign(steps[id], costFields(cost));
        reports[id].cost = cost;
      }
      if (glanceOf.has(id)) reports[id].glance = glanceOf.get(id);
      if (no) reports[id].refused_by = no.authority;
    }

    const runCategory: EmbeddedErrorCategory | undefined = result.success ? undefined
      : timedOut ? "deadline"
      : halt ? halt.category
      : outputBroken ? "output_contract"
      : firstFailed ?? "action_threw";
    const status: EmbeddedFinishedRun["status"] = timedOut ? "timed_out" : halt ? "refused" : result.success ? "succeeded" : "failed";
    const record: EmbeddedLedgerRecord = {
      schema: 1, run_id: state.runId, workflow: def.name, definition_path: `embedded:${def.name}`, definition_hash: state.prepared.hash,
      trigger: state.trigger, occurrence_key: state.occurrenceKey, data_class: def.data_class, runs_on: "cloud",
      started_at: state.startedAt, finished_at: clock().toISOString(),
      status: status === "refused" ? "failed" : status,
      steps,
      output_digest: result.success && result.output !== undefined ? digest(result.output) : null,
      ...(runCategory !== undefined ? { error: runCategory, error_digest: errorDigest(result.error ?? runCategory) } : {}),
      ...(halt && !timedOut ? { refused: "authority" as const } : {}),
    };
    const finished = await finishRecord(state, record, state.parkedVersion !== undefined);
    if (finished.rejected !== undefined) {
      return {
        status: "failed", workflow: def.name, run_id: state.runId, occurrence_key: state.occurrenceKey, record: finished.record,
        error: `The run's record failed the ledger check, so a minimal failed record was kept instead: ${finished.rejected}`, steps: reports, vigil: finished.vigil,
      };
    }
    return {
      status, workflow: def.name, run_id: state.runId, occurrence_key: state.occurrenceKey, record: finished.record,
      ...(result.success ? { output: result.output } : {}),
      ...(result.error ? { error: result.error } : {}),
      ...(record.refused ? { refused: record.refused } : {}),
      steps: reports, vigil: finished.vigil,
    };
  }

  /**
   * Writes the parked state through the store and reports the run as waiting; no record until it resumes and ends.
   * A first park writes version 1; a re-park at a later human step writes the continuation's version plus one.
   * A store that cannot keep the parked state ends the run as failed (`store_failed`), so it still reaches Vigil.
   */
  async function park(
    state: RunState,
    result: V1Result,
    parked: Map<string, string>,
    timing: Map<string, { startedAt: string; startMs: number; endMs: number }>,
    costs: Map<string, StepCost>,
  ): Promise<EmbeddedWaitingOutcome | EmbeddedFinishedRun> {
    const completed: Record<string, CompletedStep> = { ...state.replay };
    for (const [id, s] of Object.entries(result.steps)) {
      if (s.status !== "succeeded" || completed[id]) continue;
      const t = timing.get(id);
      const cost = costs.get(id);
      completed[id] = { output: s.output, attempts: s.attempts, started_at: t ? t.startedAt : null, duration_ms: t ? Math.max(0, t.endMs - t.startMs) : 0, ...(cost ? { cost } : {}) };
    }
    const waiting: EmbeddedWaitingRun = {
      schema: 1, version: state.parkedVersion === undefined ? 1 : state.parkedVersion + 1, state: "waiting",
      run_id: state.runId, workflow: state.prepared.def.name, definition: state.prepared.text, definition_hash: state.prepared.hash,
      occurrence_key: state.occurrenceKey, trigger: state.trigger, ...(state.scheduledFor ? { scheduled_for: state.scheduledFor } : {}),
      started_at: state.startedAt, input: state.input, completed, waiting_on: [...parked.keys()], prompts: Object.fromEntries(parked),
      answers: {}, parked_at: clock().toISOString(),
    };
    assertWaiting(waiting);
    try {
      await store.parkRun(structuredClone(waiting));
    } catch (error) {
      return closeUnparkable(state, waiting, message(error));
    }
    const steps: Record<string, EmbeddedStepReport> = {};
    for (const id of Object.keys(state.prepared.def.steps)) {
      if (parked.has(id)) steps[id] = { status: "waiting", attempts: 1 };
      else if (completed[id]) steps[id] = { status: "succeeded", attempts: completed[id].attempts, output: completed[id].output };
      else steps[id] = { status: "pending", attempts: 0 };
    }
    return { status: "waiting", workflow: waiting.workflow, run_id: waiting.run_id, occurrence_key: waiting.occurrence_key, waiting_on: waiting.waiting_on, prompts: waiting.prompts, steps };
  }

  /** Ends a run the store could not park: finished steps as they ran, the waiting human steps failed with `store_failed`. */
  async function closeUnparkable(state: RunState, waiting: EmbeddedWaitingRun, raw: string): Promise<EmbeddedFinishedRun> {
    const { def } = state.prepared;
    const steps: Record<string, EmbeddedLedgerStep> = {};
    const reports: Record<string, EmbeddedStepReport> = {};
    for (const id of Object.keys(def.steps)) {
      const done = waiting.completed[id];
      if (done) {
        steps[id] = {
          status: "succeeded", attempts: done.attempts, started_at: done.started_at, duration_ms: done.duration_ms, output_digest: digest(done.output),
          ...(done.cost ? costFields(done.cost) : {}),
        };
        reports[id] = { status: "succeeded", attempts: done.attempts, output: done.output, ...(done.cost ? { cost: done.cost } : {}) };
      } else if (waiting.waiting_on.includes(id)) {
        steps[id] = { status: "failed", attempts: 1, started_at: null, duration_ms: 0, error: "store_failed", error_digest: errorDigest(raw) };
        reports[id] = { status: "failed", attempts: 1, error: `The run could not be parked: ${raw}` };
      } else {
        steps[id] = { status: "skipped", attempts: 0, started_at: null, duration_ms: 0 };
        reports[id] = { status: "skipped", attempts: 0, error: "The run ended before this step was scheduled." };
      }
    }
    const record: EmbeddedLedgerRecord = {
      schema: 1, run_id: state.runId, workflow: def.name, definition_path: `embedded:${def.name}`, definition_hash: state.prepared.hash,
      trigger: state.trigger, occurrence_key: state.occurrenceKey, data_class: def.data_class, runs_on: "cloud",
      started_at: state.startedAt, finished_at: clock().toISOString(), status: "failed", steps, output_digest: null,
      error: "store_failed", error_digest: errorDigest(raw),
    };
    const finished = await finishRecord(state, record, state.parkedVersion !== undefined);
    return { status: "failed", workflow: def.name, run_id: state.runId, occurrence_key: state.occurrenceKey, record: finished.record, error: `The run could not be parked: ${raw}`, steps: reports, vigil: finished.vigil };
  }

  async function start(prepared: Prepared, trigger: EmbeddedTrigger, occurrenceKey: string, input: unknown, scheduledFor?: string): Promise<EmbeddedRunOutcome> {
    const { def } = prepared;
    if (store.paused && (await store.paused())) return { status: "paused", workflow: def.name };
    invariant(occurrenceKey.length > 0, "An occurrence key must be non-empty");
    const runId = crypto.randomUUID();
    if (!(await store.claimOccurrence(def.name, occurrenceKey, runId))) return { status: "duplicate", workflow: def.name, occurrence_key: occurrenceKey };
    const state: RunState = { prepared, runId, occurrenceKey, trigger, ...(scheduledFor ? { scheduledFor } : {}), startedAt: clock().toISOString(), input, replay: {}, answers: {} };
    if (def.enabled === false) return refuseRun(state, "disabled", `Workflow "${def.name}" is disabled (enabled: false); nothing was started.`);
    if (def.input !== undefined) {
      const check = compileSchema(def.input)(input);
      if (!check.valid) return refuseRun(state, "input", `Workflow input failed schema validation: ${check.errors?.join("; ") ?? "invalid"}`);
    }
    return execute(state);
  }

  function hosted(name: string): Prepared {
    const prepared = byName.get(name);
    if (!prepared) throw new Error(`The embedded runner hosts no workflow named "${name}"`);
    return prepared;
  }

  const warnings = Object.fromEntries([...byName].map(([name, p]) => [name, [...p.warnings]]));

  return {
    workflows: [...byName.keys()],
    warnings,
    definition: name => structuredClone(hosted(name).def),

    async run(name, input = {}, runOpts = {}) {
      const prepared = hosted(name);
      if (!prepared.def.triggers.some(t => t.type === "manual" && t.enabled !== false)) throw new Error(`Workflow "${name}" has no enabled manual trigger`);
      const key = runOpts.occurrenceKey ?? `manual:${clock().toISOString()}:${crypto.randomUUID()}`;
      if (typeof key !== "string" || !key.trim()) throw new Error("An occurrence key must be a non-empty string");
      return start(prepared, "manual", key, input);
    },

    async emit(event, input, emitOpts) {
      if (typeof event !== "string" || !event.trim()) throw new Error("An event name must be a non-empty string");
      const key = emitOpts?.occurrenceKey;
      if (typeof key !== "string" || !key.trim()) throw new Error("An event occurrence key must be a non-empty string");
      const targets = [...byName.values()].filter(p => p.def.enabled !== false && p.def.triggers.some(t => t.type === "event" && t.enabled !== false && t.name === event));
      return Promise.all(targets.map(async (prepared): Promise<EmbeddedScheduledResult> => ({
        workflow: prepared.def.name, occurrence_key: `event:${event}:${key}`,
        outcome: await start(prepared, "event", `event:${event}:${key}`, input),
      })));
    },

    async resume(runId, stepId, rawAnswer) {
      const answer = checkedAnswer(rawAnswer);
      if (typeof runId !== "string" || !RUN_ID_RE.test(runId)) throw new Error(`Not a run id: ${String(runId)}`);
      // Every write is a compare-and-swap on the parked version (ISC-257); a lost race re-reads and tries again.
      for (let attempt = 1; attempt <= RESUME_CAS_ATTEMPTS; attempt++) {
        let parked = await store.readParked(runId);
        if (!parked) throw new Error(`Run ${runId} is not waiting on a human step`);
        assertWaiting(parked);
        if (!parked.waiting_on.includes(stepId)) throw new Error(`Run ${runId} is not waiting on step "${stepId}"`);
        if (Object.hasOwn(parked.answers, stepId)) {
          // Once every waiting step is answered, the same answer again retries a continuation that may not have run
          // (ISC-258, ISC-259). Before that, or with a different answer, it is a second decision on a decided step.
          const allAnswered = parked.waiting_on.every(id => Object.hasOwn((parked as EmbeddedWaitingRun).answers, id));
          if (!allAnswered || !sameAnswer(parked.answers[stepId], answer)) throw new Error(`Step "${stepId}" of run ${runId} is already answered`);
        } else {
          invariant(parked.state === "waiting", `Run ${runId} is resuming but step "${stepId}" has no answer`);
          const answered: EmbeddedWaitingRun = { ...parked, version: parked.version + 1, answers: { ...parked.answers, [stepId]: answer } };
          assertWaiting(answered);
          if (!(await store.updateParked(structuredClone(answered), parked.version))) continue;
          parked = answered;
        }
        if (!parked.waiting_on.every(id => Object.hasOwn(parked.answers, id))) {
          const answers = parked.answers;
          const steps: Record<string, EmbeddedStepReport> = {};
          for (const id of parked.waiting_on) steps[id] = Object.hasOwn(answers, id) ? { status: "succeeded", attempts: 1, output: answers[id] } : { status: "waiting", attempts: 1 };
          return { status: "waiting", workflow: parked.workflow, run_id: runId, occurrence_key: parked.occurrence_key, waiting_on: parked.waiting_on.filter(id => !Object.hasOwn(answers, id)), prompts: parked.prompts, steps };
        }
        // ISC-259: the run must still prepare on this host before anyone takes it; if not, it stays parked with its answers.
        let prepared: Prepared;
        try {
          prepared = preparedFor(parked);
        } catch (error) {
          const problems = error instanceof EmbeddedDefinitionError ? error.problems : [message(error)];
          throw new EmbeddedDefinitionError([...problems, `run ${runId} stays parked with its answers; resume it again with the same answer once this host can prepare its definition`]);
        }
        const now = clock();
        if (parked.state === "resuming") {
          // ISC-258: a continuation holds the run until the run deadline has passed since it took it; after that it is presumed dead.
          const leaseMs = prepared.def.deadline_ms ?? MAX_DEADLINE_MS;
          if (now.getTime() - Date.parse(parked.resuming_since as string) <= leaseMs) return { status: "duplicate", workflow: parked.workflow, occurrence_key: parked.occurrence_key };
        }
        const taken: EmbeddedWaitingRun = { ...parked, version: parked.version + 1, state: "resuming", resuming_since: now.toISOString() };
        assertWaiting(taken);
        if (!(await store.updateParked(structuredClone(taken), parked.version))) continue;
        return execute({
          prepared, runId, occurrenceKey: parked.occurrence_key, trigger: parked.trigger,
          ...(parked.scheduled_for ? { scheduledFor: parked.scheduled_for } : {}),
          startedAt: parked.started_at, input: parked.input, replay: parked.completed, answers: parked.answers, parkedVersion: taken.version,
        });
      }
      throw new Error(`Run ${runId}: the parked state kept changing under ${RESUME_CAS_ATTEMPTS} attempts to record the answer for step "${stepId}"; nothing was lost, try again`);
    },

    async scheduled(scheduledTime) {
      const due: Array<{ prepared: Prepared; key: string; at: string }> = [];
      for (const prepared of byName.values()) {
        if (prepared.def.enabled === false) continue;
        for (const o of dueOccurrences(prepared.def.triggers, scheduledTime)) due.push({ prepared, key: o.key, at: o.at.toISOString() });
      }
      const results = await Promise.all(due.map(async ({ prepared, key, at }): Promise<EmbeddedScheduledResult> => {
        try {
          return { workflow: prepared.def.name, occurrence_key: key, outcome: await start(prepared, "schedule", key, { scheduled_at: at }, at) };
        } catch (error) {
          return { workflow: prepared.def.name, occurrence_key: key, error: message(error) };
        }
      }));
      return results.sort((a, b) => a.workflow.localeCompare(b.workflow) || a.occurrence_key.localeCompare(b.occurrence_key));
    },
  };
}
