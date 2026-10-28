/**
 * The seams every non-code executor goes through. Model, agent and Glance calls
 * reach the outside world only through these client interfaces, so the runner
 * can be driven entirely by fakes in tests: no key, no network, no tokens.
 * The live clients live beside their executors (model.ts, agent.ts,
 * judgment.ts) and are used only when the caller supplies none.
 */

/** Token counts one model or agent call reports. */
export interface Usage {
  input_tokens: number;
  output_tokens: number;
}

/** What a model or agent step records about its spend (ISC-128). */
export interface StepCost {
  lane: string;
  model: string;
  service_tier: "flex" | "default";
  /** null when the lane reported no token counts (a codex exec call): unknown, never zero. */
  input_tokens: number | null;
  output_tokens: number | null;
  /** Estimated from the vendor price table; null when the model has no priced row. */
  cost_usd: number | null;
}

export interface ModelRequest {
  lane: string;
  model: string;
  instructions: string;
  input: string;
  /** JSON Schema the reply is bound to (structured output). */
  schema: unknown;
  schemaName: string;
  serviceTier?: "flex";
  signal?: AbortSignal;
}

export interface ModelReply {
  /** The raw text the model returned; the executor parses and validates it. */
  text: string;
  /** Token counts the vendor reported; null when it reported none, so the step records them as unknown rather than zero. */
  usage: Usage | null;
  /** The model id that actually served the call, when the vendor reports it. */
  model?: string;
}

export interface ModelClient {
  complete(request: ModelRequest): Promise<ModelReply>;
}

export interface AgentRequest {
  /** The exact argv the session is started with (tool allowlist and sandbox included). */
  argv: string[];
  prompt: string;
  /** The input schema of the session's submit_result tool: the step's output schema. */
  submitSchema: unknown;
  cwd: string;
  signal?: AbortSignal;
}

export interface AgentReply {
  /** The value the agent passed to submit_result; undefined when it never called it. */
  submitted: unknown;
  usage: Usage;
}

export interface AgentClient {
  run(request: AgentRequest): Promise<AgentReply>;
}

export interface JudgmentRequest {
  caller: string;
  questionId: string;
  question: string;
  state: unknown;
  signal?: AbortSignal;
}

export interface JudgmentReply {
  /** The Glance decision: act only when an enforcing caller's answer cleared its threshold. */
  act: boolean;
  mode: "shadow" | "enforce" | "unregistered";
  verdict?: "yes" | "no";
  probability?: number;
  reason: string;
}

export interface JudgmentClient {
  judge(request: JudgmentRequest): Promise<JudgmentReply>;
}

/** Every injectable client a run may use. Absent entries fall back to the live clients. */
export interface StepClients {
  model?: ModelClient;
  agent?: AgentClient;
  judgment?: JudgmentClient;
}
