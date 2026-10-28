#!/usr/bin/env bun
/**
 * @version 1.0.4
 * ApiLane.ts — Astra and Fable over pay-per-token API, for a capped subscription window only.
 *
 * WHY: Astra rides the ChatGPT plan through `codex exec` and
 * Fable rides the Claude subscription. When a plan window caps, the work stops. This lane is
 * the emergency road around that wall: the same two models, billed per token, on keys from the
 * canonical .env — and it will not run unless the principal has armed it for this session.
 *
 * It is NOT a cheaper road for routine work. Routine work goes down the ladder
 * (OPERATIONAL_PREFERENCES § Model selection); this exists for a capped window.
 *
 *   bun LIFEOS/TOOLS/ApiLane.ts astra --prompt "..." [--system "..."] [--session <id>]
 *   bun LIFEOS/TOOLS/ApiLane.ts fable --prompt "..." [--max-tokens 4096]
 *   bun LIFEOS/TOOLS/ApiLane.ts astra --prompt "reply OK" --probe   # smallest possible live call
 *
 * Every completed call is priced and appended to the overage ledger by `Overage.record`.
 * Keys: OPENAI_API_KEY_OPTIN (Astra) and ANTHROPIC_API_KEY (Fable), read from the canonical
 * .env through the normal env path — never printed, never put in a URL.
 */

import { readFileSync } from "node:fs";
import { CROSS_VENDOR, CURRENT } from "./models";
import { getEnvPath } from "./Paths";
import { check, record, type Vendor } from "./Overage";
import { recordModelUse } from "./lib/ModelUse";

export type Lane = "astra" | "fable";

export interface LaneSpec { lane: Lane; vendor: Vendor; model: string; keyName: string; consoleUrl: string }

/** The two emergency lanes. Model ids resolve from the registry, never pinned here. */
export function laneSpec(lane: Lane): LaneSpec {
  if (lane === "astra") {
    return { lane, vendor: "openai", model: CROSS_VENDOR.astra, keyName: "OPENAI_API_KEY_OPTIN", consoleUrl: "https://platform.openai.com/api-keys" };
  }
  return { lane, vendor: "anthropic", model: CURRENT.fable, keyName: "ANTHROPIC_API_KEY", consoleUrl: "https://platform.claude.com/settings/keys" };
}

/** The only hosts this lane may reach. The PoolProxy carries subscription traffic; metered API keys never go through it (PoolProxy ISC-9). */
const VENDOR_HOSTS: ReadonlySet<string> = new Set(["api.openai.com", "api.anthropic.com"]);

/** Throws for any URL whose host is not the vendor's own: a proxy base URL in the environment cannot redirect this lane. */
export function assertDirectUrl(url: string | URL): void {
  let host = "";
  let https = false;
  try { const u = new URL(String(url)); host = u.hostname; https = u.protocol === "https:"; } catch { /* unparseable is refused below */ }
  if (!https || !VENDOR_HOSTS.has(host)) throw new Error(`the emergency API lane is never proxied: refusing ${host || "an unparseable URL"}`);
}

/**
 * A fetch that checks every URL with assertDirectUrl before it sends anything, and never follows a redirect:
 * the credential header rides on the request, and a redirect target would never pass the host check. A 3xx
 * answer (or an opaque redirect) is refused, so a vendor-host redirect cannot carry the key to another origin.
 */
export function directOnly(inner: typeof fetch): typeof fetch {
  return (async (url: any, init: any) => {
    assertDirectUrl(url);
    const res = await inner(url, { ...(init ?? {}), redirect: "manual" });
    if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
      throw new Error(`the emergency API lane never follows redirects: refusing a ${res.status || "redirect"} answer`);
    }
    return res;
  }) as unknown as typeof fetch;
}

/** Read one key from the canonical .env. Returns undefined when absent; never logs the value. */
export function readKey(name: string, envPath = getEnvPath()): string | undefined {
  const fromEnv = process.env[name];
  if (fromEnv) return fromEnv;
  try {
    const re = new RegExp(`^${name}=["']?([^"'\\n]+)`, "m");
    return readFileSync(envPath, "utf8").match(re)?.[1];
  } catch { return undefined; }
}

export interface LaneResult {
  ok: boolean;
  lane: Lane;
  vendor: Vendor;
  model: string;
  text: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  costUsd: number;
  error?: string;
  /** Why the vendor stopped early, when it says so (a token cap eaten by reasoning, a filter). */
  incompleteReason?: string;
}

export interface RunOptions {
  prompt: string;
  system?: string;
  maxTokens?: number;
  sessionId?: string;
  /** Injected in tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Skip the arm/ceiling gate. ONLY the test suite sets this; the CLI never does. */
  skipGate?: boolean;
  timeoutMs?: number;
}

function refusal(spec: LaneSpec, error: string): LaneResult {
  return { ok: false, lane: spec.lane, vendor: spec.vendor, model: spec.model, text: "", inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costUsd: 0, error };
}

/**
 * One call on one lane. The order matters: the gate first (nothing bills without an arm and
 * headroom), then the key (a missing key is a named blocker, never a silent fall back onto
 * the subscription), then the request, then the ledger.
 */
export async function run(lane: Lane, opts: RunOptions): Promise<LaneResult> {
  const spec = laneSpec(lane);
  if (!opts.skipGate) {
    const gate = check(opts.sessionId);
    if (!gate.ok) return refusal(spec, gate.reason);
  }
  const key = readKey(spec.keyName);
  if (!key) {
    return refusal(spec, `${spec.keyName} is not in the canonical .env — create one at ${spec.consoleUrl}, add it, and run 'bun LIFEOS/TOOLS/Secrets.ts seal'. This lane never falls back to the subscription.`);
  }
  const doFetch = directOnly(opts.fetchImpl ?? fetch);
  const timeout = opts.timeoutMs ?? 180_000;
  try {
    const call = spec.vendor === "openai" ? callOpenAi : callAnthropic;
    const out = await call(spec, key, opts, doFetch, timeout);
    if (!out.ok) return out;
    // A 200 that carries usage HAS billed, so the ledger row is written before anything else
    // can go wrong with it. An empty answer is still a spend (2026-09-20: a 60-token cap was
    // eaten entirely by reasoning, returned "" and billed $0.0032 — ok:true would have been
    // a silent failure that cost money).
    const row = record({
      vendor: spec.vendor,
      lane: spec.lane,
      model: spec.model,
      inputTokens: out.inputTokens,
      outputTokens: out.outputTokens,
      cachedInputTokens: out.cachedInputTokens,
      sessionId: opts.sessionId,
      reason: opts.skipGate ? undefined : check(opts.sessionId).armed.reason,
    });
    recordModelUse(spec.model, out.outputTokens);
    const priced = { ...out, costUsd: row.costUsd };
    if (!priced.text) {
      return { ...priced, ok: false, error: `${spec.model} billed ${row.outputTokens} output tokens ($${row.costUsd.toFixed(5)}) and returned no text${out.incompleteReason ? ` — ${out.incompleteReason}` : ""}. On a reasoning model the token cap is spent on reasoning first; raise --max-tokens.` };
    }
    return priced;
  } catch (e) {
    return refusal(spec, `request failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

type Caller = (spec: LaneSpec, key: string, opts: RunOptions, doFetch: typeof fetch, timeoutMs: number) => Promise<LaneResult>;

/** Astra on the OpenAI Responses API. `store: false` — our content is not retained at OpenAI. */
const callOpenAi: Caller = async (spec, key, opts, doFetch, timeoutMs) => {
  const body: Record<string, unknown> = {
    model: spec.model,
    input: opts.prompt,
    store: false,
    ...(opts.system ? { instructions: opts.system } : {}),
    ...(opts.maxTokens ? { max_output_tokens: opts.maxTokens } : {}),
  };
  const res = await doFetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const payload = (await res.json().catch(() => ({}))) as any;
  if (res.status !== 200) return refusal(spec, `OpenAI ${res.status}: ${String(payload?.error?.message ?? "").slice(0, 200)}`);
  const text: string = payload.output_text ?? (payload.output ?? [])
    .flatMap((o: any) => (o?.content ?? []).map((c: any) => c?.text ?? ""))
    .join("")
    .trim();
  const u = payload.usage ?? {};
  return {
    ok: true, lane: spec.lane, vendor: spec.vendor, model: spec.model, text,
    inputTokens: Number(u.input_tokens ?? 0),
    outputTokens: Number(u.output_tokens ?? 0),
    cachedInputTokens: Number(u.input_tokens_details?.cached_tokens ?? 0),
    costUsd: 0,
    ...(payload.status === "incomplete" ? { incompleteReason: `status incomplete (${String(payload.incomplete_details?.reason ?? "no reason given")})` } : {}),
  };
};

/** Fable on the Anthropic Messages API. */
const callAnthropic: Caller = async (spec, key, opts, doFetch, timeoutMs) => {
  const body: Record<string, unknown> = {
    model: spec.model,
    max_tokens: opts.maxTokens ?? 4096,
    messages: [{ role: "user", content: opts.prompt }],
    ...(opts.system ? { system: opts.system } : {}),
  };
  const res = await doFetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const payload = (await res.json().catch(() => ({}))) as any;
  if (res.status !== 200) return refusal(spec, `Anthropic ${res.status}: ${String(payload?.error?.message ?? "").slice(0, 200)}`);
  const text: string = (payload.content ?? []).map((c: any) => c?.text ?? "").join("").trim();
  const u = payload.usage ?? {};
  return {
    ok: true, lane: spec.lane, vendor: spec.vendor, model: spec.model, text,
    inputTokens: Number(u.input_tokens ?? 0) + Number(u.cache_read_input_tokens ?? 0),
    outputTokens: Number(u.output_tokens ?? 0),
    cachedInputTokens: Number(u.cache_read_input_tokens ?? 0),
    costUsd: 0,
    ...(payload.stop_reason === "max_tokens" ? { incompleteReason: "stop_reason max_tokens" } : {}),
  };
};

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const lane = argv[0] as Lane;
  if (lane !== "astra" && lane !== "fable") {
    console.error("[ApiLane] usage: ApiLane.ts <astra|fable> --prompt \"...\" [--system \"...\"] [--max-tokens N] [--session <id>]");
    process.exit(2);
  }
  const probe = argv.includes("--probe");
  const prompt = flag(argv, "prompt") ?? (probe ? "reply with the single word OK" : "");
  if (!prompt) { console.error("[ApiLane] --prompt is required"); process.exit(2); }
  const result = await run(lane, {
    prompt,
    system: flag(argv, "system"),
    maxTokens: probe ? 16 : Number(flag(argv, "max-tokens") ?? 4096),
    sessionId: flag(argv, "session") ?? process.env.CLAUDE_SESSION_ID,
  });
  if (argv.includes("--json")) { console.log(JSON.stringify(result, null, 2)); process.exit(result.ok ? 0 : 1); }
  if (!result.ok) { console.error(`[ApiLane] ${lane} refused: ${result.error}`); process.exit(1); }
  console.log(result.text);
  console.error(`[ApiLane] ${result.model} · in ${result.inputTokens} out ${result.outputTokens} · $${result.costUsd.toFixed(4)} billed to the overage ledger`);
}
