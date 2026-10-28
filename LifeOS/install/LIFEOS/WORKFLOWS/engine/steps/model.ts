/**
 * The `model` step (ISC-28, ISC-127, ISC-128): one call at the step's named lane
 * rung, with the reply bound to the step's output schema. The reply is parsed and
 * validated here; a reply that does not conform fails the step. The live client
 * runs on the subscriptions through Inference.ts (2026-10-12), so a lane
 * name is a rung, not a vendor: every call records the lane it declared, the model
 * that actually answered, and the tokens the vendor reported (null when it reported
 * none). Runs started by any trigger other than `manual` ask for the flex tier,
 * which only a pay-per-token client honours.
 */
import { CROSS_VENDOR } from "../../../TOOLS/models.ts";
import { priceFor } from "../../../TOOLS/Overage.ts";
import { inference, inferenceDisabledBy } from "../../../TOOLS/Inference.ts";
import type { EffortLevel } from "../../../TOOLS/models.ts";
import { invariant } from "../../../TOOLS/Invariant.ts";
import { compileSchema } from "../v1.ts";
import type { ModelClient, ModelReply, ModelRequest, StepCost, Usage } from "./types.ts";

/** Default timeout for a live model call that names none of its own. */
const LIVE_TIMEOUT_MS = 300_000;

/** The model id a lane resolves to, from models.ts CROSS_VENDOR; never a literal. */
export function laneModel(lane: string): string {
  const model = CROSS_VENDOR[lane];
  invariant(typeof model === "string" && model.length > 0, `Lane "${lane}" has no model in models.ts CROSS_VENDOR`);
  return model;
}

/** Flex for every run nobody is waiting on: any trigger other than `manual` (ISC-127). */
export function serviceTierFor(trigger: string): "flex" | undefined {
  return trigger === "manual" ? undefined : "flex";
}

/** Estimated dollars for one call. Flex is billed at half the standard rate. */
export function estimateCost(model: string, usage: Usage | null, tier: "flex" | undefined): number | null {
  const price = priceFor("openai", model);
  if (!price || !usage) return null;
  const standard = (usage.input_tokens * price.input + usage.output_tokens * price.output) / 1_000_000;
  return Number((tier === "flex" ? standard / 2 : standard).toFixed(6));
}

export function costOf(lane: string, model: string, usage: Usage | null, tier: "flex" | undefined): StepCost {
  return {
    lane,
    model,
    service_tier: tier ?? "default",
    input_tokens: usage ? usage.input_tokens : null,
    output_tokens: usage ? usage.output_tokens : null,
    cost_usd: estimateCost(model, usage, tier),
  };
}

export class NonConformingReply extends Error {
  constructor(detail: string) {
    super(`The model reply does not conform to the step's output schema: ${detail}`);
    this.name = "NonConformingReply";
  }
}

/** Parses a reply and holds it to the schema; throws NonConformingReply otherwise. */
export function conformingValue(text: string, schema: unknown): unknown {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new NonConformingReply("the reply is not one JSON value");
  }
  const check = compileSchema(schema)(value);
  if (!check.valid) throw new NonConformingReply(check.errors?.join("; ") ?? "invalid");
  return value;
}

export interface ModelStepCall {
  lane: string;
  prompt: string;
  input: unknown;
  output: unknown;
  stepId: string;
  trigger: string;
  signal?: AbortSignal;
}

export interface ModelStepResult {
  value: unknown;
  cost: StepCost;
}

export async function executeModelStep(call: ModelStepCall, client: ModelClient): Promise<ModelStepResult> {
  invariant(call.output !== undefined, `Model step "${call.stepId}" has no output schema to bind the reply to`);
  const model = laneModel(call.lane);
  const tier = serviceTierFor(call.trigger);
  const request: ModelRequest = {
    lane: call.lane,
    model,
    instructions: call.prompt,
    input: JSON.stringify(call.input ?? null),
    schema: call.output,
    schemaName: `step_${call.stepId.replace(/[^A-Za-z0-9_-]/g, "_")}`,
    ...(tier ? { serviceTier: tier } : {}),
    signal: call.signal,
  };
  const reply: ModelReply = await client.complete(request);
  const cost = costOf(call.lane, reply.model ?? model, reply.usage, tier);
  try {
    return { value: conformingValue(reply.text, call.output), cost };
  } catch (error) {
    (error as Error & { cost?: StepCost }).cost = cost;
    throw error;
  }
}

/* ── Live client: Inference.ts on the subscriptions ─────────────────────── */

/** The Inference level a lane runs at: the openai lanes by rung; any other lane runs at medium. */
export function laneLevel(lane: string): EffortLevel {
  return ({ openaiLow: "low", openaiMedium: "medium", openaiHigh: "high", openaiMax: "max" } as Record<string, EffortLevel>)[lane] ?? "medium";
}

/**
 * The production client. Runs the step through Inference.ts, so it lands on the subscriptions: Haiku or Sonnet
 * on the Claude plan for low and medium, Sol or Astra through codex on the ChatGPT plan for high and max, never
 * an API key (2026-10-12). The schema rides in the instructions and the executor validates the reply.
 * The step's signal reaches the child process, so a stop or a step timeout kills the call. The reply names the
 * model Inference saw answer, or says it was not reported; it never names the lane's OpenAI model unless that
 * model ran. Tokens are the vendor's own count, or null when the lane reports none.
 */
// An object literal, not a call, so the embedded (Worker) bundle that imports this module can tree-shake Inference away (ISC-247).
export const liveModelClient: ModelClient = { complete: (request) => completeWithInference(inference, request) };

/** The live client over a given Inference call; tests hand it a fake so no model runs. */
export function inferenceModelClient(run: typeof inference): ModelClient {
  return { complete: (request) => completeWithInference(run, request) };
}

async function completeWithInference(run: typeof inference, request: ModelRequest): Promise<ModelReply> {
  const disabled = inferenceDisabledBy();
  if (disabled) throw new Error(`inference disabled: ${disabled}`);
  const r = await run({
    level: laneLevel(request.lane),
    systemPrompt: `${request.instructions}\n\nReply with one JSON value that conforms to this JSON Schema:\n${JSON.stringify(request.schema)}`,
    userPrompt: request.input,
    expectJson: true,
    timeout: LIVE_TIMEOUT_MS,
    ...(request.signal ? { signal: request.signal } : {}),
  });
  if (!r.success) throw new Error(`${request.lane} call failed: ${(r.error ?? "no answer").slice(0, 300)}`);
  const model = r.executedModel ?? `unreported (${r.vendor ?? "inference"} ${laneLevel(request.lane)})`;
  return { text: r.parsed !== undefined ? JSON.stringify(r.parsed) : r.output, usage: r.usage ?? null, model };
}
