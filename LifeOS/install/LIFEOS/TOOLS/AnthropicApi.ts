#!/usr/bin/env bun
/**
 * @version 1.0.0
 * AnthropicApi.ts — LifeOS's pay-per-token lane on the Anthropic Messages API, for unattended
 * work that must not ride the subscription (ISA 20261007-haiku-replaces-luna-terra, HAI-5).
 *
 * Two consumers: Inference.ts vendor `anthropic-api` (one call, no tools) and AgentJob.ts vendor
 * `anthropic-api` (runAnthropicAgent: a tool loop over the SAME three tools and guards as
 * OpenAiAgent.ts, imported from there, never re-implemented). Levels resolve through
 * models.ts anthropicApiLane(): low → CURRENT.haiku, medium → CURRENT.sonnet; high and max throw.
 *
 * Key: ANTHROPIC_API_KEY_LIFEOS, from the process env or the canonical .env, sent only in the
 * `x-api-key` header — never in a URL, never logged. This is never the `claude` CLI and never the
 * subscription; a missing key fails the call loudly and nothing falls back to the subscription.
 *
 * Request rules for Haiku 5.5 / Sonnet 5.5 (Anthropic migration guide): no temperature/top_p/top_k;
 * no assistant prefill (the last message is always the user's); `output_config.effort` sets depth;
 * thinking is adaptive by default, so content is read by block `type` (thinking blocks come first)
 * and `max_tokens` leaves room for it; `stop_reason: "refusal"` is an error; forced tool_choice
 * 400s, so tool turns send `tool_choice: auto` only. In a tool loop the assistant content goes
 * back verbatim (thinking blocks included, unchanged) so preserved thinking stays valid.
 *
 * Usage: every call's tokens and dollars (models.ts pricingFor) append to
 * MEMORY/OBSERVABILITY/anthropic-usage.jsonl, the twin of openai-usage.jsonl. Test seams:
 * LIFEOS_ANTHROPIC_KEY_FILE (the .env path read for the key) and LIFEOS_ANTHROPIC_USAGE_LOG.
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { invariant } from "./Invariant.ts";
import { getEnvPath, lifeosPath } from "./Paths";
import { pricingFor, type HarnessEffort } from "./models";
import { execTool, TOOL_DEFS, type ToolContext } from "./OpenAiAgent.ts";

export const MESSAGES_URL = "https://api.anthropic.com/v1/messages";
export const ANTHROPIC_VERSION = "2023-06-01";
export const KEY_NAME = "ANTHROPIC_API_KEY_LIFEOS";
/** Non-streaming ceiling: room for adaptive thinking plus the answer, under the HTTP timeout. */
export const DEFAULT_MAX_TOKENS = 16_000;

export interface ContentBlock { type: string; text?: string; id?: string; name?: string; input?: unknown; [k: string]: unknown }
export interface MessagesResponse {
  id: string;
  model: string;
  content: ContentBlock[];
  stop_reason: string | null;
  stop_details?: { category?: string | null; explanation?: string | null } | null;
  usage: Record<string, unknown>;
}
export interface ApiUsage { input: number; output: number; cacheRead: number; cacheWrite: number; calls: number }
export type CallResult = { ok: true; body: MessagesResponse } | { ok: false; status: number; error: string };

/** ANTHROPIC_API_KEY_LIFEOS from the given env, else the canonical .env. Never logged. */
export function loadAnthropicApiKey(env: NodeJS.ProcessEnv = process.env, envPath: string = process.env.LIFEOS_ANTHROPIC_KEY_FILE || getEnvPath()): string | undefined {
  const fromEnv = env[KEY_NAME]?.trim();
  if (fromEnv) return fromEnv;
  try { return readFileSync(envPath, "utf8").match(new RegExp(`^${KEY_NAME}=["']?([^"'\\n]+)`, "m"))?.[1]?.trim() || undefined; } catch { return undefined; }
}

export function emptyUsage(): ApiUsage { return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 }; }
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
export function addUsage(acc: ApiUsage, u: Record<string, unknown> | undefined): void {
  acc.input += num(u?.input_tokens); acc.output += num(u?.output_tokens);
  acc.cacheRead += num(u?.cache_read_input_tokens); acc.cacheWrite += num(u?.cache_creation_input_tokens);
  acc.calls += 1;
}

/** Dollars for the usage, or null when the model has no priced row. input_tokens excludes cache reads and writes, so nothing is double-counted. */
export function costUsd(model: string, u: ApiUsage): number | null {
  const m = pricingFor(model);
  if (!m) return null;
  const p = m.pricing;
  return Math.round(((u.input * p.input + u.cacheRead * p.cacheRead + u.cacheWrite * p.cacheWrite5m + u.output * p.output) / 1_000_000) * 1e6) / 1e6;
}

export function usageLogPath(): string { return process.env.LIFEOS_ANTHROPIC_USAGE_LOG || join(lifeosPath("MEMORY", "OBSERVABILITY"), "anthropic-usage.jsonl"); }

/** Append one usage row. Same shape as openai-usage.jsonl plus cache fields and dollars. */
export function recordAnthropicUsage(model: string, job: string, level: string, u: ApiUsage): void {
  invariant(!!model && !!job && !!level, "recordAnthropicUsage: model, job and level are required");
  invariant([u.input, u.output, u.cacheRead, u.cacheWrite, u.calls].every((n) => Number.isFinite(n) && n >= 0), "recordAnthropicUsage: token counts must be non-negative numbers");
  const usd = costUsd(model, u);
  try {
    const path = usageLogPath();
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify({ ts: new Date().toISOString(), vendor: "anthropic-api", model, job, level, ...u, usd }) + "\n");
  } catch { /* observability never breaks the call */ }
}

/** Text of the response, read by block type: thinking blocks (which come first) are skipped. */
export function textOf(content: ContentBlock[]): string {
  return content.filter((b) => b.type === "text" && typeof b.text === "string").map((b) => b.text as string).join("\n").trim();
}

/** The error string for a refusal, or null. Refusals arrive as HTTP 200 with stop_reason "refusal". */
export function refusalError(body: MessagesResponse): string | null {
  if (body.stop_reason !== "refusal") return null;
  const d = body.stop_details ?? {};
  return `refusal: stop_reason=refusal category=${d.category ?? "unknown"}${d.explanation ? ` (${String(d.explanation).slice(0, 200)})` : ""}`;
}

function isMessagesResponse(j: unknown): j is MessagesResponse {
  const r = j as MessagesResponse;
  return !!r && typeof r === "object" && Array.isArray(r.content) && r.content.every((b) => !!b && typeof b.type === "string")
    && (typeof r.stop_reason === "string" || r.stop_reason === null) && !!r.usage && typeof r.usage === "object";
}

/**
 * One POST /v1/messages with bounded retries (429, 5xx, 529, network). 400/401/403/404 are not
 * retried. The response shape is validated before anything reads it.
 */
export async function postMessages(key: string, body: Record<string, unknown>, opts: { timeoutMs: number; maxAttempts?: number }): Promise<CallResult> {
  invariant(!!key, "postMessages: key required");
  const attempts = Math.max(1, Math.min(3, Math.floor(opts.maxAttempts ?? 3)));
  const deadline = Date.now() + opts.timeoutMs;
  let last: { status: number; error: string } = { status: 0, error: "no attempt made" };
  for (let attempt = 0; attempt < attempts; attempt++) {
    const left = deadline - Date.now();
    if (left <= 0) return { ok: false, status: 0, error: `timeout after ${opts.timeoutMs}ms (${last.error})` };
    let res: Response;
    try {
      res = await fetch(MESSAGES_URL, {
        method: "POST",
        headers: { "x-api-key": key, "anthropic-version": ANTHROPIC_VERSION, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(left),
      });
    } catch (e) {
      last = { status: 0, error: String(e).slice(0, 300) };
      if (attempt + 1 < attempts) await Bun.sleep(1500 * (attempt + 1));
      continue;
    }
    const j = await res.json().catch(() => null) as { error?: { message?: string; type?: string } } | null;
    if (res.ok && isMessagesResponse(j)) return { ok: true, body: j };
    const msg = res.ok ? "response did not match the Messages API shape" : (j?.error?.message ?? `HTTP ${res.status}`);
    last = { status: res.status, error: `HTTP ${res.status}: ${String(msg).slice(0, 300)}` };
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable) break;
    if (attempt + 1 < attempts) {
      const ra = Number(res.headers.get("retry-after"));
      await Bun.sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra, 20) * 1000 : 1500 * (attempt + 1));
    }
  }
  return { ok: false, status: last.status, error: last.error };
}

/** The three tools in Messages API shape. Definitions and execution both come from OpenAiAgent.ts. */
export const ANTHROPIC_TOOLS = TOOL_DEFS.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters, strict: true }));

export interface AnthropicAgentOptions extends ToolContext {
  model: string;
  effort: HarnessEffort;
  instructions: string;
  prompt: string;
  /** Usage-log job name (AgentJob passes the job id). */
  job: string;
  /** Lane name for the usage log. */
  level: string;
  timeoutMs?: number;
  maxSteps?: number;
  maxTokens?: number;
  apiKey?: string;
}
export interface AnthropicAgentResult { ok: boolean; result: string; usage: ApiUsage; steps: number; error?: string; responseId?: string; model: string }

/** One unattended run: prompt → tool loop → final text, on the Messages API. */
export async function runAnthropicAgent(o: AnthropicAgentOptions): Promise<AnthropicAgentResult> {
  invariant(!!o.model && !!o.instructions && !!o.prompt, "AnthropicAgent: model, instructions, prompt required");
  invariant(!!o.stateDir, "AnthropicAgent: stateDir required");
  invariant(!!o.allow && Array.isArray(o.allow.scripts), "AnthropicAgent: allow.scripts required (empty array = no scripts)");
  const usage = emptyUsage();
  const key = o.apiKey ?? loadAnthropicApiKey(o.env ?? process.env);
  if (!key) return { ok: false, result: "", usage, steps: 0, model: o.model, error: `${KEY_NAME} missing (env or .env); the anthropic-api lane never falls back to the subscription` };
  const deadline = Date.now() + (o.timeoutMs ?? 600_000);
  const maxSteps = o.maxSteps ?? 40;
  const messages: Array<{ role: "user" | "assistant"; content: unknown }> = [{ role: "user", content: o.prompt }];
  let steps = 0;
  let last: string | undefined;
  const finish = (r: Omit<AnthropicAgentResult, "usage" | "steps" | "model" | "responseId">): AnthropicAgentResult => {
    if (usage.calls > 0) recordAnthropicUsage(o.model, o.job, o.level, usage);
    return { ...r, usage, steps, model: o.model, responseId: last };
  };
  for (;;) {
    const left = deadline - Date.now();
    if (left <= 0) return finish({ ok: false, result: "", error: "timeout" });
    if (steps >= maxSteps) return finish({ ok: false, result: "", error: `step cap ${maxSteps} reached` });
    const body = {
      model: o.model,
      max_tokens: o.maxTokens ?? DEFAULT_MAX_TOKENS,
      system: o.instructions,
      messages,
      tools: ANTHROPIC_TOOLS,
      tool_choice: { type: "auto" },
      output_config: { effort: o.effort },
      // Auto-caches the growing prefix (tools → system → history) so each turn reads the last one.
      cache_control: { type: "ephemeral" },
    };
    const r = await postMessages(key, body, { timeoutMs: Math.max(10_000, Math.min(180_000, left)) });
    if (!r.ok) return finish({ ok: false, result: "", error: `anthropic-api: ${r.error}` });
    const j = r.body;
    steps++;
    addUsage(usage, j.usage);
    last = j.id;
    const refusal = refusalError(j);
    if (refusal) { o.log?.("refusal", { stop_details: j.stop_details ?? null }); return finish({ ok: false, result: textOf(j.content), error: refusal }); }
    if (j.stop_reason === "max_tokens") return finish({ ok: false, result: textOf(j.content), error: `max_tokens ${o.maxTokens ?? DEFAULT_MAX_TOKENS} reached mid-turn` });
    if (j.stop_reason === "end_turn" || j.stop_reason === "stop_sequence") return finish({ ok: true, result: textOf(j.content) });
    if (j.stop_reason === "pause_turn") { messages.push({ role: "assistant", content: j.content }); continue; }
    if (j.stop_reason !== "tool_use") return finish({ ok: false, result: textOf(j.content), error: `unexpected stop_reason ${String(j.stop_reason)}` });
    const calls = j.content.filter((b) => b.type === "tool_use");
    if (calls.length === 0) return finish({ ok: false, result: textOf(j.content), error: "stop_reason tool_use with no tool_use block" });
    // The assistant turn goes back verbatim, thinking blocks included, then every result in ONE user message.
    messages.push({ role: "assistant", content: j.content });
    const results = calls.map((c) => {
      const args = c.input && typeof c.input === "object" && !Array.isArray(c.input) ? (c.input as Record<string, unknown>) : {};
      try { return { type: "tool_result", tool_use_id: c.id, content: execTool(String(c.name), args, o) }; }
      catch (e) { return { type: "tool_result", tool_use_id: c.id, content: JSON.stringify({ error: String(e).slice(0, 500) }), is_error: true }; }
    });
    messages.push({ role: "user", content: results });
  }
}
