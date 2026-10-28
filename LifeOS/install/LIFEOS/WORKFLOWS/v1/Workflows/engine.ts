import { assertSchema, compileSchema } from "./schema.ts";
import { schemaAtPath, validateInputMapping } from './contracts';

export interface Workflow {
  version: 1;
  name: string;
  description?: string;
  trigger?:
    | { type: "manual" }
    | { type: "event"; name: string }
    | { type: "schedule"; cron: string; timezone: string };
  defaults?: StepPolicy;
  concurrency?: number;
  input?: unknown;
  output?: unknown;
  steps: Record<string, WorkflowStep>;
}

export interface StepPolicy {
  timeout_ms?: number;
  retries?: number;
  retry_delay_ms?: number;
  on_error?: "stop" | "continue";
}

export interface WorkflowStep extends StepPolicy {
  uses: string;
  needs?: string[];
  with?: unknown;
  when?: { ref: string; equals: unknown };
}

export interface ActionRegistry {
  [name: string]: {
    input?: unknown;
    output?: unknown;
    execute: (
      input: unknown,
      context: { signal: AbortSignal; workflow: string; step: string; attempt: number },
    ) => Promise<unknown>;
  };
}

export interface WorkflowResult {
  success: boolean;
  output?: unknown;
  error?: string;
  steps: Record<
    string,
    {
      status: "succeeded" | "failed" | "skipped";
      output?: unknown;
      error?: string;
      attempts: number;
      timed_out?: boolean;
    }
  >;
}

type Reference = { root: "input"; path: string[] } | { root: "steps"; step: string; path: string[] };
type InternalStatus = "pending" | "running" | "succeeded" | "failed" | "skipped";
type InternalStep = Omit<WorkflowResult["steps"][string], "status"> & { status: InternalStatus };

const ROOT_KEYS = new Set(["version", "name", "description", "trigger", "defaults", "concurrency", "input", "output", "steps"]);
const STEP_KEYS = new Set(["uses", "needs", "with", "when", "timeout_ms", "retries", "retry_delay_ms", "on_error"]);
const POLICY_KEYS = new Set(["timeout_ms", "retries", "retry_delay_ms", "on_error"]);
const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor"]);

/** Parses and validates a workflow definition without consulting a host registry. */
export function parseWorkflow(value: unknown): Workflow {
  assertWorkflowShape(value);
  validateWorkflow(value as Workflow);
  return value as Workflow;
}

/** Validates graph structure and, when supplied, the complete action registry contract. */
export function validateWorkflow(workflow: Workflow, registry?: ActionRegistry): void {
  assertWorkflowShape(workflow);
  const steps = workflow.steps;
  const ids = Object.keys(steps);
  const ancestors = new Map<string, Set<string>>();

  for (const [id, step] of Object.entries(steps)) {
    validateStep(id, step, steps, registry);
  }

  const visit = (id: string, visiting: Set<string>): Set<string> => {
    const cached = ancestors.get(id);
    if (cached) return cached;
    if (visiting.has(id)) throw new Error(`Workflow contains a dependency cycle at step "${id}".`);
    visiting.add(id);
    const result = new Set<string>();
    for (const dependency of steps[id].needs ?? []) {
      result.add(dependency);
      for (const ancestor of visit(dependency, visiting)) result.add(ancestor);
    }
    visiting.delete(id);
    ancestors.set(id, result);
    return result;
  };
  for (const id of ids) visit(id, new Set());

  for (const [id, step] of Object.entries(steps)) {
    const allowed = ancestors.get(id)!;
    for (const ref of referencesIn(step.with)) assertStepReference(ref, id, allowed);
    if (step.when) assertStepReference(parseReference(step.when.ref), id, allowed);
  }
  for (const ref of referencesIn(workflow.output)) {
    if (ref.root === "steps" && !Object.hasOwn(steps, ref.step)) {
      throw new Error(`Workflow output references unknown step "${ref.step}".`);
    }
  }

  if (workflow.input !== undefined) assertSchema(workflow.input);
  if (registry) {
    for (const [id, step] of Object.entries(steps)) {
      const action = registry[step.uses];
      if (!action) throw new Error(`Step "${id}" uses unknown action "${step.uses}".`);
      if (action.input !== undefined) assertSchema(action.input);
      if (action.output !== undefined) assertSchema(action.output);
    }
    const sourceFor = (path: string) => {
      const ref = parseReference(path);
      return schemaAtPath(ref.root === 'input' ? workflow.input : registry[steps[ref.step].uses].output, ref.path, path);
    };
    for (const [id, step] of Object.entries(steps)) {
      for (const ref of referencesIn(step.with)) {
        schemaAtPath(ref.root === 'input' ? workflow.input : registry[steps[ref.step].uses].output, ref.path, id);
      }
      validateInputMapping(step.with === undefined ? { $ref: 'input' } : step.with, registry[step.uses].input, sourceFor, id);
      if (step.when) sourceFor(step.when.ref);
    }
    for (const ref of referencesIn(workflow.output)) {
      schemaAtPath(ref.root === 'input' ? workflow.input : registry[steps[ref.step].uses].output, ref.path, 'workflow output');
    }
  }
}

/** Returns a side-effect-free description of the workflow graph. */
export function describeWorkflow(workflow: Workflow): { name: string; trigger?: Workflow["trigger"]; concurrency: number; steps: Record<string, { uses: string; needs: string[] }> } {
  validateWorkflow(workflow);
  const steps: Record<string, { uses: string; needs: string[] }> = {};
  for (const [id, step] of Object.entries(workflow.steps)) {
    steps[id] = { uses: step.uses, needs: [...(step.needs ?? [])] };
  }
  return { name: workflow.name, trigger: workflow.trigger, concurrency: workflow.concurrency ?? 1, steps };
}

export async function runWorkflow(workflow: Workflow, input: unknown, registry: ActionRegistry): Promise<WorkflowResult> {
  validateWorkflow(workflow, registry);
  if (workflow.input !== undefined) {
    assertValid(compileSchema(workflow.input)(input), "Workflow input");
  }

  const actionValidators = new Map<string, { input?: ReturnType<typeof compileSchema>; output?: ReturnType<typeof compileSchema> }>();
  for (const step of Object.values(workflow.steps)) {
    if (!actionValidators.has(step.uses)) {
      const action = registry[step.uses];
      actionValidators.set(step.uses, {
        input: action.input === undefined ? undefined : compileSchema(action.input),
        output: action.output === undefined ? undefined : compileSchema(action.output),
      });
    }
  }

  const state: Record<string, InternalStep> = {};
  for (const id of Object.keys(workflow.steps)) state[id] = { status: "pending", attempts: 0 };
  const concurrency = workflow.concurrency ?? 1;
  const active = new Set<Promise<void>>();
  let stopped = false;
  let stopError: string | undefined;

  const finish = (id: string, outcome: Omit<InternalStep, "status"> & { status: Exclude<InternalStatus, "pending" | "running"> }) => {
    state[id] = outcome;
    const policy = effectivePolicy(workflow, workflow.steps[id]);
    if (outcome.status === "failed" && (policy.on_error === "stop" || outcome.timed_out) && !stopped) {
      stopped = true;
      stopError = `Step "${id}" failed: ${outcome.error ?? "unknown error"}`;
    }
  };

  const start = (id: string) => {
    state[id].status = "running";
    let task: Promise<void>;
    task = executeStep(workflow, id, input, state, registry, actionValidators.get(workflow.steps[id].uses)!)
      .then(outcome => finish(id, outcome))
      .catch(error => finish(id, { status: "failed", attempts: state[id].attempts, error: message(error) }))
      .finally(() => active.delete(task));
    active.add(task);
  };

  while (true) {
    if (stopped) {
      for (const [id, step] of Object.entries(state)) {
        if (step.status === "pending") {
          state[id] = { status: "skipped", attempts: 0, error: "Workflow stopped after an earlier failure." };
        }
      }
    } else {
      let changed = true;
      while (changed) {
        changed = false;
        for (const [id, step] of Object.entries(workflow.steps)) {
          if (state[id].status !== "pending") continue;
          const blockedBy = (step.needs ?? []).find(dependency => {
            const status = state[dependency].status;
            return status === "failed" || status === "skipped";
          });
          if (blockedBy) {
            state[id] = { status: "skipped", attempts: 0, error: `Dependency "${blockedBy}" did not succeed.` };
            changed = true;
          }
        }
      }
      for (const id of Object.keys(workflow.steps)) {
        if (active.size >= concurrency) break;
        const step = workflow.steps[id];
        if (state[id].status === "pending" && (step.needs ?? []).every(dependency => state[dependency].status === "succeeded")) start(id);
      }
    }

    if (active.size > 0) {
      await Promise.race(active);
      continue;
    }
    if (Object.values(state).every(step => step.status !== "pending" && step.status !== "running")) break;
    throw new Error("Workflow scheduler could not make progress.");
  }

  const steps: WorkflowResult["steps"] = {};
  for (const [id, step] of Object.entries(state)) {
    steps[id] = { status: step.status as WorkflowResult["steps"][string]["status"], attempts: step.attempts };
    if (step.output !== undefined) steps[id].output = clone(step.output);
    if (step.error !== undefined) steps[id].error = step.error;
    if (step.timed_out) steps[id].timed_out = true;
  }
  const failed = Object.entries(state).filter(([, step]) => step.status === "failed");
  if (failed.length > 0) return { success: false, error: stopError ?? `Step "${failed[0][0]}" failed: ${failed[0][1].error ?? "unknown error"}`, steps };
  try {
    const output = workflow.output === undefined ? terminalOutput(workflow, state) : resolveMapping(workflow.output, input, state);
    return { success: true, output: clone(output), steps };
  } catch (error) { return { success: false, error: message(error), steps }; }
}

async function executeStep(
  workflow: Workflow,
  id: string,
  input: unknown,
  state: Record<string, InternalStep>,
  registry: ActionRegistry,
  validators: { input?: ReturnType<typeof compileSchema>; output?: ReturnType<typeof compileSchema> },
): Promise<Omit<InternalStep, "status"> & { status: "succeeded" | "failed" | "skipped" }> {
  const step = workflow.steps[id];
  const policy = effectivePolicy(workflow, step);
  try {
    if (step.when) {
      const actual = resolveReference(parseReference(step.when.ref), input, state);
      if (!equal(actual, step.when.equals)) return { status: "skipped", attempts: 0, error: "Condition was not met." };
    }
    const actionInput = clone(step.with === undefined ? input : resolveMapping(step.with, input, state));
    if (validators.input) assertValid(validators.input(actionInput), `Input for step "${id}"`);
    for (let attempt = 1; attempt <= policy.retries + 1; attempt++) {
      state[id].attempts = attempt;
      const outcome = await invoke(registry[step.uses].execute, actionInput, workflow.name, id, attempt, policy.timeout_ms);
      if (outcome.ok) {
        if (validators.output) assertValid(validators.output(outcome.value), `Output for step "${id}"`);
        return { status: "succeeded", attempts: attempt, output: clone(outcome.value) };
      }
      if (outcome.timedOut) return { status: "failed", attempts: attempt, timed_out: true, error: `Step "${id}" timed out after ${policy.timeout_ms}ms; cancellation requested, completion unknown.` };
      if (attempt <= policy.retries && policy.retry_delay_ms > 0) await delay(policy.retry_delay_ms);
      if (attempt === policy.retries + 1) return { status: "failed", attempts: attempt, error: message(outcome.error) };
    }
    throw new Error("Unreachable retry state.");
  } catch (error) {
    return { status: "failed", attempts: state[id].attempts, error: message(error) };
  }
}

async function invoke(
  execute: ActionRegistry[string]["execute"],
  input: unknown,
  workflow: string,
  step: string,
  attempt: number,
  timeoutMs: number | undefined,
): Promise<{ ok: true; value: unknown } | { ok: false; error: unknown; timedOut: boolean }> {
  const controller = new AbortController();
  const execution = Promise.resolve().then(() => execute(clone(input), { signal: controller.signal, workflow, step, attempt }));
  if (timeoutMs === undefined) {
    try {
      return { ok: true, value: await execution };
    } catch (error) {
      return { ok: false, error, timedOut: false };
    }
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">(resolve => {
    timer = setTimeout(() => {
      controller.abort();
      resolve("timeout");
    }, timeoutMs);
  });
  const raced = await Promise.race([execution.then(value => ({ kind: "value" as const, value }), error => ({ kind: "error" as const, error })), timeout]);
  if (timer !== undefined) clearTimeout(timer);
  if (raced !== "timeout") return raced.kind === "value" ? { ok: true, value: raced.value } : { ok: false, error: raced.error, timedOut: false };
  // Execution may ignore abort forever. Its rejection is already observed by the race.
  // Return a bounded failure and stop new work; never retry an uncertain side effect.
  return { ok: false, error: new Error("Timed out."), timedOut: true };
}

function assertWorkflowShape(value: unknown): asserts value is Workflow {
  assertRecord(value, "Workflow");
  assertKeys(value, ROOT_KEYS, "Workflow");
  if (value.version !== 1) throw new Error("Workflow version must be 1.");
  assertNonEmptyString(value.name, "Workflow name");
  if (value.description !== undefined) assertString(value.description, "Workflow description");
  if (value.trigger !== undefined) validateTrigger(value.trigger as NonNullable<Workflow["trigger"]>);
  if (value.defaults !== undefined) validatePolicy(value.defaults as StepPolicy, "Workflow defaults", POLICY_KEYS);
  if (value.concurrency !== undefined) assertPositiveInteger(value.concurrency, "Workflow concurrency");
  if (typeof value.concurrency === 'number' && value.concurrency > 64) throw new Error('Workflow concurrency must not exceed 64');
  if (value.input !== undefined) assertSafeValue(value.input, "Workflow input schema");
  if (value.output !== undefined) assertSafeValue(value.output, "Workflow output");
  assertRecord(value.steps, "Workflow steps");
  if (Object.keys(value.steps).length === 0) throw new Error("Workflow must contain at least one step.");
  for (const [id, step] of Object.entries(value.steps)) {
    assertSafeKey(id, "Step id");
    assertNonEmptyString(id, "Step id");
    assertReferenceSegment(id, "Step id");
    assertRecord(step, `Step "${id}"`);
  }
}

function validateStep(id: string, step: WorkflowStep, allSteps: Record<string, WorkflowStep>, registry?: ActionRegistry): void {
  assertKeys(step, STEP_KEYS, `Step "${id}"`);
  assertNonEmptyString(step.uses, `Step "${id}" uses`);
  assertSafeKey(step.uses, 'Action id');
  if (registry && (!Object.hasOwn(registry, step.uses) || typeof registry[step.uses]?.execute !== 'function')) throw new Error(`Step "${id}" uses unknown action "${step.uses}".`);
  if (step.needs !== undefined) {
    if (!Array.isArray(step.needs)) throw new Error(`Step "${id}" needs must be an array.`);
    const seen = new Set<string>();
    for (const dependency of step.needs) {
      assertNonEmptyString(dependency, `Dependency of step "${id}"`);
      if (dependency === id) throw new Error(`Step "${id}" cannot depend on itself.`);
      if (!Object.hasOwn(allSteps, dependency)) throw new Error(`Step "${id}" depends on unknown step "${dependency}".`);
      if (seen.has(dependency)) throw new Error(`Step "${id}" lists dependency "${dependency}" more than once.`);
      seen.add(dependency);
    }
  }
  if (step.with !== undefined) assertSafeValue(step.with, `Input mapping for step "${id}"`);
  if (step.when !== undefined) {
    assertRecord(step.when, `Condition for step "${id}"`);
    assertKeys(step.when, new Set(["ref", "equals"]), `Condition for step "${id}"`);
    assertNonEmptyString(step.when.ref, `Condition ref for step "${id}"`);
    if (!Object.hasOwn(step.when, 'equals')) throw new Error('Condition requires equals');
    parseReference(step.when.ref);
    assertSafeValue(step.when.equals, `Condition value for step "${id}"`);
  }
  validatePolicy(step, `Step "${id}"`, STEP_KEYS);
  for (const ref of referencesIn(step.with)) parseReferenceToEnsureValid(ref);
}

function validateTrigger(trigger: NonNullable<Workflow["trigger"]>): void {
  assertRecord(trigger, "Workflow trigger");
  const allowed = trigger.type === "manual" ? new Set(["type"]) : trigger.type === "event" ? new Set(["type", "name"]) : trigger.type === "schedule" ? new Set(["type", "cron", "timezone"]) : undefined;
  if (!allowed) throw new Error("Workflow trigger type must be manual, event, or schedule.");
  assertKeys(trigger, allowed, "Workflow trigger");
  if (trigger.type === "event") assertNonEmptyString(trigger.name, "Event trigger name");
  if (trigger.type === "schedule") {
    assertNonEmptyString(trigger.cron, "Schedule cron");
    assertNonEmptyString(trigger.timezone, "Schedule timezone");
    if (trigger.cron.trim().split(/\s+/).length !== 5) throw new Error("Schedule cron must contain five fields.");
    try { new Intl.DateTimeFormat("en-US", { timeZone: trigger.timezone }); } catch { throw new Error(`Schedule timezone "${trigger.timezone}" is invalid.`); }
  }
}

function validatePolicy(value: object, label: string, allowed: Set<string>): void {
  for (const key of POLICY_KEYS) {
    const policy = value as StepPolicy;
    if (policy[key as keyof StepPolicy] === undefined) continue;
    if (key === "on_error") {
      if (policy.on_error !== "stop" && policy.on_error !== "continue") throw new Error(`${label} on_error must be stop or continue.`);
    } else if (key === "retries" || key === 'retry_delay_ms') assertNonNegativeInteger(policy[key], `${label} ${key}`);
    else assertPositiveInteger(policy[key as "timeout_ms" | "retry_delay_ms"], `${label} ${key}`);
  }
  const p = value as StepPolicy;
  if ((p.retries ?? 0) > 10) throw new Error(`${label} retries must not exceed 10`);
  if ((p.timeout_ms ?? 0) > 86_400_000 || (p.retry_delay_ms ?? 0) > 86_400_000) throw new Error(`${label} timer must not exceed 24 hours`);
  assertKeys(value, allowed, label);
}

function effectivePolicy(workflow: Workflow, step: WorkflowStep): Required<StepPolicy> {
  return {
    timeout_ms: step.timeout_ms ?? workflow.defaults?.timeout_ms,
    retries: step.retries ?? workflow.defaults?.retries ?? 0,
    retry_delay_ms: step.retry_delay_ms ?? workflow.defaults?.retry_delay_ms ?? 0,
    on_error: step.on_error ?? workflow.defaults?.on_error ?? "stop",
  } as Required<StepPolicy>;
}

function referencesIn(value: unknown): Reference[] {
  const refs: Reference[] = [];
  const walk = (item: unknown) => {
    if (Array.isArray(item)) return item.forEach(walk);
    if (!isRecord(item)) return;
    if (Object.hasOwn(item, "$ref")) {
      if (Object.keys(item).length !== 1 || typeof item.$ref !== "string") throw new Error("A reference mapping must be exactly { $ref: \"...\" }.");
      refs.push(parseReference(item.$ref));
      return;
    }
    for (const child of Object.values(item)) walk(child);
  };
  walk(value);
  return refs;
}

function parseReferenceToEnsureValid(reference: Reference): void { void reference; }

function parseReference(value: string): Reference {
  const parts = value.split(".");
  if (parts.length === 0 || parts.some(part => !part || UNSAFE_KEYS.has(part) || !isReferenceSegment(part))) throw new Error(`Invalid reference "${value}".`);
  if (parts[0] === "input") return { root: "input", path: parts.slice(1) };
  if (parts[0] === "steps" && parts.length >= 3 && parts[2] === "output") {
    return { root: "steps", step: parts[1], path: parts.slice(3) };
  }
  throw new Error(`Reference "${value}" must begin with input or steps.<id>.output.`);
}

function assertStepReference(ref: Reference, id: string, allowed: Set<string>): void {
  if (ref.root === "steps" && !allowed.has(ref.step)) throw new Error(`Step "${id}" references non-ancestor step "${ref.step}".`);
}

function resolveMapping(value: unknown, input: unknown, state: Record<string, InternalStep>): unknown {
  if (Array.isArray(value)) return value.map(item => resolveMapping(item, input, state));
  if (!isRecord(value)) return clone(value);
  if (Object.hasOwn(value, "$ref")) return clone(resolveReference(parseReference(value.$ref as string), input, state));
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) result[key] = resolveMapping(child, input, state);
  return result;
}

function resolveReference(reference: Reference, input: unknown, state: Record<string, InternalStep>): unknown {
  let value: unknown;
  let path: string[];
  if (reference.root === "input") {
    value = input;
    path = reference.path;
  } else {
    const step = state[reference.step];
    if (!step || step.status !== "succeeded") throw new Error(`Reference to unavailable output from step "${reference.step}".`);
    value = step.output;
    path = reference.path;
  }
  for (const key of path) {
    if (!isRecord(value) && !Array.isArray(value)) throw new Error("Reference path does not exist.");
    if (!Object.hasOwn(value, key)) throw new Error("Reference path does not exist.");
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

function terminalOutput(workflow: Workflow, state: Record<string, InternalStep>): Record<string, unknown> {
  const dependencies = new Set(Object.values(workflow.steps).flatMap(step => step.needs ?? []));
  const output: Record<string, unknown> = {};
  for (const id of Object.keys(workflow.steps)) if (!dependencies.has(id)) output[id] = clone(state[id].output);
  return output;
}

function assertValid(result: { valid: boolean; errors?: string[] }, label: string): void {
  if (!result.valid) throw new Error(`${label} failed schema validation${result.errors?.length ? `: ${result.errors.join("; ")}` : "."}`);
}

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object.`);
  assertSafeValue(value, label);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertSafeValue(value: unknown, label: string, seen = new Set<unknown>()): void {
  if (typeof value === "number" && !Number.isFinite(value)) throw new Error(`${label} must not contain non-finite numbers.`);
  if (value === null || typeof value !== "object") {
    if (typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") throw new Error(`${label} must contain JSON-compatible values.`);
    return;
  }
  if (seen.has(value)) throw new Error(`${label} must not contain cycles.`);
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) assertSafeValue(item, label, seen);
  } else {
    if (!isRecord(value)) throw new Error(`${label} must contain only plain objects.`);
    for (const [key, item] of Object.entries(value)) {
      assertSafeKey(key, label);
      assertSafeValue(item, label, seen);
    }
  }
  seen.delete(value);
}

function assertKeys(value: object, allowed: Set<string>, label: string): void {
  for (const key of Object.keys(value)) {
    assertSafeKey(key, label);
    if (!allowed.has(key)) throw new Error(`${label} has unknown key "${key}".`);
  }
}

function assertSafeKey(key: string, label: string): void {
  if (UNSAFE_KEYS.has(key)) throw new Error(`${label} contains unsafe key "${key}".`);
}

function assertReferenceSegment(value: string, label: string): void {
  if (!isReferenceSegment(value)) throw new Error(`${label} contains unsupported path character(s).`);
}

function isReferenceSegment(value: string): boolean {
  return /^(?:[A-Za-z_$][A-Za-z0-9_$-]*|0)$/.test(value) || /^(?:[1-9][0-9]*)$/.test(value);
}

function assertString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string") throw new Error(`${label} must be a string.`);
}

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
  assertString(value, label);
  if (!value.trim()) throw new Error(`${label} must not be empty.`);
}

function assertPositiveInteger(value: unknown, label: string): void {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new Error(`${label} must be a positive finite integer.`);
}

function assertNonNegativeInteger(value: unknown, label: string): void {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${label} must be a non-negative finite integer.`);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function equal(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length && left.every((item, index) => equal(item, right[index]));
  if (isRecord(left) && isRecord(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return leftKeys.length === rightKeys.length && leftKeys.every(key => Object.hasOwn(right, key) && equal(left[key], right[key]));
  }
  return false;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
