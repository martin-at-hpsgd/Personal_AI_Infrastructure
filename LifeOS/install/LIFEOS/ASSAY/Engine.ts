#!/usr/bin/env bun
/**
 * Engine.ts — Assay's judgment engine client: Clef-omni on Cloudflare Workers AI.
 *
 * Replaces LIFEOS/TOOLS/Jev.ts (TypeSafe, retired 2026-10-10), principal 2026-10-10: "Remove Jev everywhere, it's all Clef now,
 * Clef-omni so we can do lots of different input types". Assay ISA M6, ISC-51.
 *
 * This file is the VENDOR CLIENT only: the Workers AI endpoint, the question/answer shapes, the credentials,
 * the secret-shape refusal, the media limits and the raw HTTP call. Everything that makes an answer safe to act
 * on — the caller registry, decide(), the shadow ledger, budgets, reports, outage alerts, model-drift reverts —
 * lives one level up in `LIFEOS/ASSAY/Assay.ts`. Callers ask Assay; this is the engine underneath it.
 * Doc: LIFEOS/DOCUMENTATION/Assay/AssaySystem.md.
 *
 * The engine writes no text. It takes a state (text or JSON), optional images, audio or video, and a map of
 * typed questions, and returns per question an answer with probabilities:
 *   choice → one option from a set you define, a probability per option and a confidence
 *   score  → a position on ordered levels you describe, a probability per level and a confidence
 *   noul   → the probability that a yes/no question is yes
 * Clef-omni speaks the same System One question and answer format as Jev (retired 2026-10-10), so no caller changed shape.
 *
 * DATA CLASS: Cloudflare Workers AI on our own account is a trusted vendor for this lane (OPERATIONAL_PREFERENCES
 * § Model selection, 2026-10-10). What never leaves on any lane is a secret VALUE: callEngine() refuses state or
 * question text carrying a credential shape (hooks/lib/egress-shapes SECRET_VALUE_SHAPES) before any fetch, and
 * callers that send prose still run `redactForEngine` for secret shapes, emails and phones. Each attachment goes on
 * the wire as content_type and base64 only; any other field on it is dropped, and a secret shape in any of them
 * refuses the call. The finished request body is scanned once more, every string but the base64 payloads. Media
 * bytes are not scanned; callers attach only media they mean to send.
 *
 * MEDIA (live schema, GET .../ai/models/schema?model=@cf/cloudflare/clef-omni, read 2026-10-10):
 *   images ≤ 4, PNG/JPEG/WebP, ≤ 4 MiB each, ≤ 8 MiB together
 *   audio  ≤ 4, audio/*, ≤ 8 MiB each (server also caps 300 s each)
 *   videos ≤ 2, video/*, ≤ 16 MiB each (server also caps 60 s each)
 *   audio and video together ≤ 16 MiB decoded
 * Byte and count limits are checked here before any fetch; durations only the server can check.
 *
 * Usage:
 *   bun LIFEOS/ASSAY/Engine.ts probe                              one live call through Assay (caller "probe")
 *   bun LIFEOS/ASSAY/Engine.ts schema [--extract]                 prints the live schema of the engine model (--extract: of the extraction model, Extract.ts)
 *   bun LIFEOS/ASSAY/Engine.ts ask|report|alerts|drift|callers   forwards to Assay.ts (same output)
 *
 * Environment (each from the environment, else the canonical .env; never printed):
 *   CLOUDFLARE_ACCOUNT_ID   the account the engine runs on
 *   CLOUDFLARE_API_TOKEN    the one master Cloudflare token (OPERATIONAL_PREFERENCES § Cloudflare: never a second
 *                           Cloudflare credential). resolveCredentials() is the only reader; no other name is read.
 *
 * Exit codes: 0 ok · 1 error (missing credentials, API failure, bad arguments)
 *
 * @version 1.0.0
 */

import { existsSync, readFileSync } from "node:fs";
import { getEnvPath } from "../TOOLS/Paths";
import { parseEnv } from "../TOOLS/Env";
import { CROSS_VENDOR } from "../TOOLS/models";
import { SECRET_VALUE_SHAPES } from "../../hooks/lib/egress-shapes";

export const WORKERS_AI_ACCOUNTS = "https://api.cloudflare.com/client/v4/accounts";
/** Measured live on Clef-omni (text state, 2026-10-10): median ~750 ms, p95 ~2 s. Hooks call on every prompt. */
export const DEFAULT_TIMEOUT_MS = 3000;
/** Media calls upload and decode megabytes; not yet measured, so the bound is generous and the caller may tighten it. */
export const DEFAULT_MEDIA_TIMEOUT_MS = 30_000;

/** The engine model, from models.ts (never named here). */
export function engineModel(): string {
  const m = CROSS_VENDOR.assayEngine;
  if (typeof m !== "string" || !m.startsWith("@cf/")) throw new EngineError("models.ts CROSS_VENDOR.assayEngine is not a Workers AI model id", "shape");
  return m;
}

// ── Types ─────────────────────────────────────────────────────────────────────

export type NoulQuestion = { type: "noul"; instructions: unknown; criteria?: { true?: string; false?: string } };
export type ChoiceQuestion = { type: "choice"; instructions: unknown; criteria: Record<string, string | null> };
// criteria is an ORDERED ARRAY, lowest level first, 2 to 10 levels (live schema). The returned ScoreAnswer.score is a
// continuous 0-indexed expected value over the positions (probability-weighted), not a 1-based integer level pick.
export type ScoreQuestion = { type: "score"; instructions: unknown; criteria: string[] };
export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion;
export type Questions = Record<string, Question>;

export type NoulAnswer = { type: "noul"; noul: number };
export type ChoiceAnswer = { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> };
export type ScoreAnswer = { type: "score"; score: number; confidence: number; probabilities: Record<string, number>; legend?: Record<string, string> };
export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export type EngineResponse = {
  model: string;
  answers: Record<string, Answer>;
  usage?: { input_tokens?: number; output_tokens?: number };
  request_id?: string | null;
  latency_ms: number;
};

export type EngineErrorKind = "no-key" | "http" | "timeout" | "network" | "shape" | "not-public" | "disabled" | "budget" | "media" | "unregistered";

export class EngineError extends Error {
  constructor(message: string, public readonly kind: EngineErrorKind, public readonly status?: number) {
    super(message);
    this.name = "EngineError";
  }
}

/** One attached image, audio clip or video, base64-encoded. Only these two fields are ever sent (buildRequest). */
export type MediaAttachment = { content_type: string; base64: string };
export type EngineMedia = { images?: MediaAttachment[]; audio?: MediaAttachment[]; videos?: MediaAttachment[] };

// ── Credentials ───────────────────────────────────────────────────────────────

export type EngineCredentials = { accountId: string; apiToken: string };

/** The canonical .env, parsed. An unreadable or missing file is the same as no credentials: the caller fails as no-key. */
function readEnvFile(): Record<string, string> {
  try {
    const envPath = getEnvPath();
    return existsSync(envPath) ? parseEnv(readFileSync(envPath, "utf8")) : {};
  } catch {
    return {};
  }
}

function envValue(name: string, env: NodeJS.ProcessEnv, file: () => Record<string, string>): string | null {
  const fromEnv = env[name]?.trim();
  if (fromEnv) return fromEnv;
  const v = file()[name]?.trim();
  return v || null;
}

/**
 * The one engine credential reader: CLOUDFLARE_ACCOUNT_ID and the master CLOUDFLARE_API_TOKEN, each from the
 * environment, else the canonical .env. No other token name is read (Assay ISA ISC-69). Null unless both are present.
 * Never printed. `envFile` is a test seam for the .env contents.
 */
export function resolveCredentials(env: NodeJS.ProcessEnv = process.env, envFile: () => Record<string, string> = readEnvFile): EngineCredentials | null {
  let parsed: Record<string, string> | null = null;
  const file = () => (parsed ??= envFile());
  const accountId = envValue("CLOUDFLARE_ACCOUNT_ID", env, file);
  const apiToken = envValue("CLOUDFLARE_API_TOKEN", env, file);
  return accountId && apiToken ? { accountId, apiToken } : null;
}

/**
 * The engine's bearer token, or null when the account id or the token is missing. Kept under the name every
 * caller already uses as its "is the engine reachable" check; the account id travels with resolveCredentials().
 */
export function resolveApiKey(env: NodeJS.ProcessEnv = process.env): string | null {
  return resolveCredentials(env)?.apiToken ?? null;
}

// ── Redaction (send-side control for principal text) ─────────────────────────

const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const PHONE_RE = /(?<![\w.])(?:\+\d{8,15}|\+?1?[\s.-]?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4})(?![\w.])/g;
const INTL_PHONE_RE = /\+\d[\d\s().-]{7,}\d/g; // international format e.g. +44 20 7946 0958
const SECRET_RES: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(?:sk|rk|pk)_[A-Za-z0-9_-]{16,}/g,
  /\bsk-(?:ant-|proj-|live-)?[A-Za-z0-9_-]{20,}/g, // OpenAI/Anthropic-style (sk-ant-api03-…, sk-proj-…, sk-live-…, sk-…)
  /\bapikey_[A-Za-z0-9_]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{16,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}/g,
  /\bglpat-[A-Za-z0-9_-]{16,}/g, // GitLab PAT
  /\bcsk-[A-Za-z0-9]{16,}/g, // Cerebras
  /\b[A-Za-z0-9_-]{40,}\b/g, // opaque tokens (40+ chars; a Cloudflare API token is 40 chars; git hash redaction is an accepted tradeoff)
  /\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g, // JWT
  /\b[0-9a-fA-F]{32,}\b/g, // hex API keys and secrets (32+; the 40-char opaque rule missed 32-39)
  /\b\d{3}-\d{2}-\d{4}\b/g, // SSN-shaped numbers
  // Every value shape the send-side refusal knows, so a shape added there is redacted here too instead of only refusing the call.
  ...SECRET_VALUE_SHAPES.map((re) => new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g")),
];

/** Strip secret shapes, emails and phone numbers; cap length. Pure. Same behaviour as redactForJev, retired 2026-10-10. */
export function redactForEngine(text: string, maxChars = 2000): string {
  let out = text;
  for (const re of SECRET_RES) out = out.replace(re, "[REDACTED]");
  out = out.replace(EMAIL_RE, "[email]").replace(PHONE_RE, "[phone]").replace(INTL_PHONE_RE, "[phone]");
  return out.length > maxChars ? out.slice(0, maxChars) + " …" : out;
}

/**
 * redactForEngine over a whole state: a string state, or every string inside an object or array state, keys kept.
 * Each string is capped at `maxChars`. Pure. For tools that send a structured state straight to callEngine.
 */
export function redactState<T extends string | object>(state: T, maxChars = 20_000): T {
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return redactForEngine(v, maxChars);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(state) as T;
}

/** True when the text carries a credential VALUE shape. Pure. */
export function carriesSecretValue(text: string): boolean {
  return SECRET_VALUE_SHAPES.some((re) => { re.lastIndex = 0; return re.test(text); });
}

// ── Media ─────────────────────────────────────────────────────────────────────

const MIB = 1024 * 1024;
export const MEDIA_LIMITS = {
  images: { max: 4, eachBytes: 4 * MIB, totalBytes: 8 * MIB, type: /^image\/(png|jpeg|webp)$/ },
  audio: { max: 4, eachBytes: 8 * MIB, type: /^audio\/[a-z0-9.+-]+$/ },
  videos: { max: 2, eachBytes: 16 * MIB, type: /^video\/[a-z0-9.+-]+$/ },
  audioVideoTotalBytes: 16 * MIB,
} as const;

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/** Decoded byte length of a base64 string, or null when it is not base64. Pure. */
export function decodedBytes(b64: string): number | null {
  if (b64.length % 4 !== 0 || !BASE64_RE.test(b64)) return null;
  const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return (b64.length / 4) * 3 - pad;
}

/** A MediaAttachment from raw bytes. */
export function mediaFromBytes(bytes: Uint8Array, contentType: string): MediaAttachment {
  return { content_type: contentType, base64: Buffer.from(bytes).toString("base64") };
}

/** Every reason the media would be refused, checked before any fetch. Empty means it fits the schema limits. Pure. */
export function mediaProblems(media: EngineMedia | undefined): string[] {
  if (!media) return [];
  const problems: string[] = [];
  const sizes: Record<"images" | "audio" | "videos", number[]> = { images: [], audio: [], videos: [] };
  for (const kind of ["images", "audio", "videos"] as const) {
    const list = media[kind];
    if (list === undefined) continue;
    if (!Array.isArray(list)) { problems.push(`${kind} is not an array`); continue; }
    const lim = MEDIA_LIMITS[kind];
    if (list.length > lim.max) problems.push(`${kind}: ${list.length} attached, at most ${lim.max}`);
    list.forEach((m, i) => {
      if (!m || typeof m.content_type !== "string" || typeof m.base64 !== "string") { problems.push(`${kind}[${i}] needs content_type and base64 strings`); return; }
      if (!lim.type.test(m.content_type)) problems.push(`${kind}[${i}]: content type ${m.content_type} is not accepted`);
      const n = decodedBytes(m.base64);
      if (n === null) { problems.push(`${kind}[${i}]: base64 is malformed`); return; }
      if (n === 0) problems.push(`${kind}[${i}] is empty`);
      if (n > lim.eachBytes) problems.push(`${kind}[${i}]: ${n} bytes, at most ${lim.eachBytes}`);
      sizes[kind].push(n);
    });
  }
  const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
  if (sum(sizes.images) > MEDIA_LIMITS.images.totalBytes) problems.push(`images: ${sum(sizes.images)} bytes together, at most ${MEDIA_LIMITS.images.totalBytes}`);
  const av = sum(sizes.audio) + sum(sizes.videos);
  if (av > MEDIA_LIMITS.audioVideoTotalBytes) problems.push(`audio and video: ${av} bytes together, at most ${MEDIA_LIMITS.audioVideoTotalBytes}`);
  return problems;
}

function hasMedia(media: EngineMedia | undefined): boolean {
  return !!media && ((media.images?.length ?? 0) + (media.audio?.length ?? 0) + (media.videos?.length ?? 0)) > 0;
}

// ── Request and response (pure) ───────────────────────────────────────────────

const MEDIA_KINDS = ["images", "audio", "videos"] as const;

/** One attachment as it goes on the wire: content_type and base64, and no other field (a caption, path or note never leaves). Pure. */
function wireAttachment(m: MediaAttachment): MediaAttachment {
  return { content_type: m.content_type, base64: m.base64 };
}

/**
 * The Workers AI request body. The model selector is the last path segment of the model id ("clef-omni"). Each
 * attachment is rebuilt from content_type and base64 only, so metadata a caller hung on it is never serialized. Pure.
 */
export function buildRequest(state: string | object, questions: Questions, model: string, media?: EngineMedia): Record<string, unknown> {
  const body: Record<string, unknown> = { model: model.split("/").pop(), state, questions };
  for (const kind of MEDIA_KINDS) {
    const list = media?.[kind];
    if (Array.isArray(list) && list.length) body[kind] = list.map(wireAttachment);
  }
  return body;
}

/**
 * Every string a value carries, object keys included, except the `base64` payload of an attachment (media bytes
 * cannot be scanned and a payload can spell a key shape by chance). Only the top-level `images`, `audio` and `videos`
 * lists of `v` (an EngineMedia or a request body) are media lists; a `base64` key anywhere else, the state included,
 * is scanned like any other string. Pure.
 */
function stringsOutsidePayload(v: unknown, out: string[], depth: "top" | "attachment" | "inner" = "inner"): string[] {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => stringsOutsidePayload(x, out));
  else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      out.push(k);
      if (depth === "attachment" && k === "base64") continue;
      if (depth === "top" && (MEDIA_KINDS as readonly string[]).includes(k) && Array.isArray(x)) {
        (x as unknown[]).forEach((a) => stringsOutsidePayload(a, out, "attachment"));
      } else stringsOutsidePayload(x, out);
    }
  }
  return out;
}

/**
 * True when any string in `v` (an EngineMedia or a request body) carries a credential VALUE shape, every string
 * scanned except each attachment's base64 payload. Pure.
 */
export function carriesSecretOutsidePayload(v: unknown): boolean {
  return stringsOutsidePayload(v, [], "top").some(carriesSecretValue);
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isProb = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;

function probMap(v: unknown): v is Record<string, number> {
  return isObj(v) && Object.values(v).every(isProb);
}

/**
 * Why an answer does not match its question's type and the answer schema, or null when it does. Pure.
 * `confidence` is checked when present and not required: nothing in Assay acts on it, and existing consumer fixtures omit it.
 */
export function answerProblem(q: Question, a: unknown): string | null {
  if (!isObj(a)) return "answer is not an object";
  if (a.type !== q.type) return `answer type ${String(a.type)} for a ${q.type} question`;
  if (a.type === "noul") return isProb(a.noul) ? null : "noul is not a probability";
  if (a.type === "choice") {
    if (typeof a.choice !== "string") return "choice is not a string";
    if (a.confidence !== undefined && !isProb(a.confidence)) return "confidence is not a probability";
    return probMap(a.probabilities) ? null : "probabilities is not a map of probabilities";
  }
  if (typeof a.score !== "number" || !Number.isFinite(a.score)) return "score is not a number";
  if (a.confidence !== undefined && !isProb(a.confidence)) return "confidence is not a probability";
  return probMap(a.probabilities) ? null : "probabilities is not a map of probabilities";
}

/**
 * The answers from a Workers AI response body: the REST envelope `{ success, errors, result: {...} }`, or a bare
 * result `{ model, answers, usage }` as a Workers AI binding returns it. Every question must have a well-formed answer.
 */
export function parseResponse(body: unknown, questions: Questions, requestedModel: string):
  { ok: true; model: string; answers: Record<string, Answer>; usage?: EngineResponse["usage"] } | { ok: false; message: string } {
  if (!isObj(body)) return { ok: false, message: "response is not a JSON object" };
  if (body.success === false) return { ok: false, message: `engine reported failure: ${JSON.stringify(body.errors ?? null).slice(0, 200)}` };
  const result = isObj(body.result) ? body.result : body;
  if (!isObj(result.answers)) return { ok: false, message: "response missing answers" };
  const answers = result.answers as Record<string, unknown>;
  for (const [id, q] of Object.entries(questions)) {
    if (!(id in answers)) return { ok: false, message: `response missing answer for "${id}"` };
    const problem = answerProblem(q, answers[id]);
    if (problem) return { ok: false, message: `answer "${id}": ${problem}` };
  }
  const model = typeof result.model === "string" && result.model ? result.model : requestedModel;
  const usage = isObj(result.usage) ? (result.usage as EngineResponse["usage"]) : undefined;
  return { ok: true, model, answers: answers as Record<string, Answer>, usage };
}

// ── The raw call ──────────────────────────────────────────────────────────────

/** A failed callEngine() call: enough for Assay to build its shadow-log line and throw the right EngineError. */
export type EngineCallFailure = {
  ok: false;
  kind: "not-public" | "timeout" | "network" | "http" | "shape" | "media" | "no-key";
  status?: number;
  message: string;
  requestId: string | null;
  latencyMs: number;
  /** What Assay's shadow line records for `model`: null when nothing was sent, else the model asked for (or the one the body named). */
  model: string | null;
};
export type EngineCallOutcome = { ok: true; response: EngineResponse } | EngineCallFailure;

/**
 * A failure as one short line for a bake-off row: "timeout", "network: …", "HTTP 503 …", else "<kind>: …".
 * The leading word is what a retry loop matches on (timeout, network, HTTP 5xx, HTTP 429). Pure.
 */
export function describeFailure(f: EngineCallFailure): string {
  if (f.kind === "timeout") return "timeout";
  if (f.kind === "http") return `HTTP ${f.status ?? "?"} ${f.message.split(": ").slice(1).join(": ")}`.trim().slice(0, 200);
  const msg = f.message.startsWith(`engine ${f.kind}: `) ? f.message.slice(`engine ${f.kind}: `.length) : f.message;
  return `${f.kind}: ${msg}`.slice(0, 200);
}

export type EngineCallOptions = {
  model: string;
  /** Bearer token (resolveCredentials().apiToken, the master Cloudflare token). */
  apiKey: string;
  /** Account the engine runs on. Default: resolveCredentials()'s account id. */
  accountId?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  media?: EngineMedia;
};

/**
 * The raw engine call: secret-shape refusal, media limits, then the fetch, then response-shape validation. No caller
 * registry, no budget, no ledger — those are Assay's job (`LIFEOS/ASSAY/Assay.ts`). Expected failures return a
 * discriminated outcome; an unexpected non-abort error while reading the response is rethrown. It skips the kill
 * switch, the budget and the ledger, so only Assay and the offline bake-off tools (EngineBakeoff, UseCaseBakeoff,
 * EngineJudge) may import it; a Glance.test allowlist holds that. Every Workers AI POST in LifeOS goes through here,
 * so every one refuses secret-shaped state and validates its answers (ISA ISC-61). `t0` is the caller's clock start
 * (performance.now()) so latency covers the whole ask(), registry checks included.
 */
export async function callEngine(state: string | object, questions: Questions, opts: EngineCallOptions, t0: number): Promise<EngineCallOutcome> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const model = opts.model;

  // Secret values never leave, on any lane: refuse a payload carrying a credential shape before any fetch.
  const stateStr = typeof state === "string" ? state : JSON.stringify(state);
  const refuseSecret: EngineCallFailure = { ok: false, kind: "not-public", message: "engine refused: payload carries a secret value shape", requestId: null, latencyMs: 0, model: null };
  if (carriesSecretValue(stateStr) || carriesSecretValue(JSON.stringify(questions))) return refuseSecret;
  // Attachment metadata (a note, a caption, a path) is never sent, but a secret riding in it means the caller handed
  // over something it did not mean to: refuse rather than quietly drop it.
  if (opts.media !== undefined && carriesSecretOutsidePayload(opts.media)) return refuseSecret;
  const problems = mediaProblems(opts.media);
  if (problems.length) {
    return { ok: false, kind: "media", message: `engine refused media: ${problems.join("; ")}`, requestId: null, latencyMs: 0, model: null };
  }
  // The exact body that goes out, checked once more: every string it carries except the base64 payloads.
  const requestBody = buildRequest(state, questions, model, opts.media);
  if (carriesSecretOutsidePayload(requestBody)) return refuseSecret;
  const accountId = opts.accountId ?? resolveCredentials()?.accountId ?? null;
  if (!accountId) {
    return { ok: false, kind: "no-key", message: "CLOUDFLARE_ACCOUNT_ID is not set (env or .env)", requestId: null, latencyMs: 0, model: null };
  }

  const url = `${WORKERS_AI_ACCOUNTS}/${encodeURIComponent(accountId)}/ai/run/${model}`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? (hasMedia(opts.media) ? DEFAULT_MEDIA_TIMEOUT_MS : DEFAULT_TIMEOUT_MS));
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${opts.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
      signal: ctl.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    const latency = Math.round(performance.now() - t0);
    const kind = (e as Error)?.name === "AbortError" ? "timeout" : "network";
    return { ok: false, kind, message: `engine ${kind}: ${(e as Error)?.message ?? e}`, requestId: null, latencyMs: latency, model };
  }
  const requestId = res.headers.get("cf-ray");
  try {
    const latency = Math.round(performance.now() - t0);
    if (res.status !== 200) {
      let detail = "";
      try { detail = (await res.text()).slice(0, 200); } catch { /* the status alone is the error */ }
      return { ok: false, kind: "http", status: res.status, message: `engine HTTP ${res.status}${detail ? `: ${detail}` : ""}`, requestId, latencyMs: latency, model };
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch (e) {
      if ((e as Error)?.name === "AbortError") throw e; // a timeout during the body read, handled below
      return { ok: false, kind: "shape", message: "engine response was not JSON", requestId, latencyMs: latency, model };
    }
    const parsed = parseResponse(body, questions, model);
    if (!parsed.ok) return { ok: false, kind: "shape", message: `engine ${parsed.message}`, requestId, latencyMs: latency, model };
    return { ok: true, response: { model: parsed.model, answers: parsed.answers, usage: parsed.usage, request_id: requestId, latency_ms: latency } };
  } catch (e) {
    if ((e as Error)?.name !== "AbortError") throw e;
    const latency = Math.round(performance.now() - t0);
    return { ok: false, kind: "timeout", message: `engine timeout: ${(e as Error)?.message ?? e}`, requestId, latencyMs: latency, model };
  } finally {
    clearTimeout(timer);
  }
}

// ── CLI ───────────────────────────────────────────────────────────────────────

async function main(argv: string[]): Promise<number> {
  const cmd = argv[0];
  if (!cmd || cmd === "-h" || cmd === "--help") {
    console.log("Usage: bun LIFEOS/ASSAY/Engine.ts probe | schema [--extract] | ask|report|alerts|drift|callers ... (forwards to LIFEOS/ASSAY/Assay.ts)\nSecret values are refused before any call — see file header.");
    return 0;
  }
  if (cmd === "schema") {
    const creds = resolveCredentials();
    if (!creds) { console.error("CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are not both set"); return 1; }
    // --extract reads the extraction model's schema (CROSS_VENDOR.assayExtract, the Clairic lane Extract.ts calls).
    const model = argv.includes("--extract") ? (CROSS_VENDOR as Record<string, string>).assayExtract : engineModel();
    if (typeof model !== "string" || !model.startsWith("@cf/")) { console.error("models.ts CROSS_VENDOR.assayExtract is not a Workers AI model id"); return 1; }
    const res = await fetch(`${WORKERS_AI_ACCOUNTS}/${encodeURIComponent(creds.accountId)}/ai/models/schema?model=${encodeURIComponent(model)}`, {
      headers: { Authorization: `Bearer ${creds.apiToken}` },
      signal: AbortSignal.timeout(15_000),
    });
    console.log(await res.text());
    return res.ok ? 0 : 1;
  }
  if (cmd === "probe") {
    const { ask } = await import("./Assay");
    const r = await ask("The deploy finished and every test passed.", { urgent: { type: "noul", instructions: "Does this message express urgency?" } }, { caller: "probe" });
    console.log(JSON.stringify({ model: r.model, request_id: r.request_id, latency_ms: r.latency_ms, answers: r.answers, usage: r.usage }, null, 1));
    return 0;
  }
  // ask, report, alerts, drift, callers live in Assay.ts. Dynamically imported so this file forms no static import cycle.
  if (["ask", "report", "alerts", "drift", "callers"].includes(cmd)) {
    const { main: assayMain } = await import("./Assay");
    return assayMain(argv);
  }
  console.error(`unknown command: ${cmd}`);
  return 1;
}

if (import.meta.main) {
  main(process.argv.slice(2)).then((code) => process.exit(code)).catch((e) => {
    console.error(e instanceof EngineError ? `${e.name} (${e.kind}): ${e.message}` : String(e));
    process.exit(1);
  });
}
