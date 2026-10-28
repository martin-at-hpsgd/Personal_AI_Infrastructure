/**
 * Extract.ts — Assay's extraction engine client: Clairic on Cloudflare Workers AI (CROSS_VENDOR.assayExtract).
 *
 * Part of Assay's judgment layer (LIFEOS/DOCUMENTATION/Assay/AssaySystem.md § Extraction). Clef-omni (Engine.ts)
 * answers multiple-choice questions; Clairic answers fill-in-the-blank ones: given a state (text, up to 4 images) and
 * a map of typed fields, it returns one value per field in a single pass, copied from the state with its span,
 * computed from it, estimated inside declared bounds, or forecast per step. Assay ISA M8 (ISC-79..89).
 *
 * This file is the VENDOR CLIENT only: field and answer shapes, the request body, the secret-shape refusal, the
 * image limits, the raw fetch (`callExtractor`) and the span check (`verifySpans`). The caller registry, budgets,
 * sample rate, kill switch and ledger live in `LIFEOS/ASSAY/Assay.ts` (`extract()`, `extractMany()`); only that file
 * imports `callExtractor`, and Extract.test.ts holds that allowlist. Other code may import the types and the pure
 * helpers (`fieldSpecProblems`, `verifySpans`, `extractModel`) and nothing that reaches the network.
 *
 * DATA CLASS: Workers AI on our own account is a trusted vendor (OPERATIONAL_PREFERENCES § Model selection). A secret VALUE
 * never leaves: state, field text and image metadata carrying a credential shape are refused before any fetch. The
 * state is NOT redacted here, because a copied value's span must index the exact text sent; a caller that must not
 * send emails or phone numbers redacts before it calls. Image bytes are not scanned.
 *
 * LIVE SCHEMA (GET .../ai/models/schema?model=<assayExtract>, read 2026-10-19):
 *   body       { model: "clairic", state: string, fields: {name: spec}, images?, reference_date?, options? }
 *   field name /^[A-Za-z_][A-Za-z0-9_.\-]{0,63}$/
 *   spec       type text|number|date|time|datetime|duration|list|estimate|forecast; instructions, unit, integer,
 *              decimals 0-6, items (list: text|number|date, required), min/max (estimate, forecast: required),
 *              step, scale linear|log, null_threshold (0,1], horizon 1-64 and interval (forecast)
 *   images     at most 4, PNG/JPEG/WebP, 4 MiB each, 8 MiB together; request body at most 16 MiB
 *   answers    per field: type, value (null when the state does not hold it), p_null, confidence, guess, span
 *              [start, end) for text; spans and confidences per item for lists; mean, median, p10, p90, p_below,
 *              p_above for an estimate; the same as arrays plus steps for a forecast (shape probed live 2026-10-19)
 *
 * Environment: the same CLOUDFLARE_ACCOUNT_ID and master CLOUDFLARE_API_TOKEN as Engine.ts (resolveCredentials()).
 *
 * @version 1.0.0
 */

import { CROSS_VENDOR } from "../TOOLS/models";
import { carriesSecretOutsidePayload, carriesSecretValue, decodedBytes, resolveCredentials, WORKERS_AI_ACCOUNTS, type MediaAttachment } from "./Engine";

/** Measured live 2026-10-19 on synthetic text: 536 ms and 766 ms (2 to 3 parallel passes). Bounded generously; callers may tighten. */
export const DEFAULT_EXTRACT_TIMEOUT_MS = 10_000;
/** Image calls upload and decode megabytes; not yet measured. */
export const DEFAULT_EXTRACT_IMAGE_TIMEOUT_MS = 30_000;

/** The extraction model, from models.ts (never named here). */
export function extractModel(): string {
  const m = (CROSS_VENDOR as Record<string, string>).assayExtract;
  if (typeof m !== "string" || !m.startsWith("@cf/")) throw new Error("models.ts CROSS_VENDOR.assayExtract is not a Workers AI model id");
  return m;
}

// ── Types ─────────────────────────────────────────────────────────────────────

export const EXTRACT_FIELD_TYPES = ["text", "number", "date", "time", "datetime", "duration", "list", "estimate", "forecast"] as const;
export type ExtractFieldType = (typeof EXTRACT_FIELD_TYPES)[number];
export const LIST_ITEM_TYPES = ["text", "number", "date"] as const;
export const FORECAST_INTERVALS = ["step", "minute", "hour", "day", "week", "month", "quarter", "year"] as const;

/** One field as Clairic takes it. Option names and ranges follow the live schema. */
export type ExtractFieldSpec = {
  type: ExtractFieldType;
  instructions?: string;
  unit?: string;
  integer?: boolean;
  decimals?: number;
  items?: (typeof LIST_ITEM_TYPES)[number];
  /** A number, or an ISO date for a date estimate. Required for estimate and forecast. */
  min?: number | string;
  max?: number | string;
  step?: number | "month" | "year";
  scale?: "linear" | "log";
  null_threshold?: number;
  horizon?: number;
  interval?: (typeof FORECAST_INTERVALS)[number];
};
export type ExtractFields = Record<string, ExtractFieldSpec>;

export type Span = [number, number];

/**
 * One field's answer. `value`, `p_null`, `confidence` and `spans` are always present (null when Clairic gave none);
 * every other key Clairic returned (guess, span, median, p10, p90, steps, confidences …) is kept as it came.
 * `unverified` is set when a copied text value did not match the state at its span: `value` is then null and the
 * original stays in `guess`.
 */
export type ExtractAnswer = {
  type: ExtractFieldType;
  value: unknown;
  p_null: number | null;
  confidence: number | null;
  /** The span of a text value, or one span per text list item; null for computed and estimated values. */
  spans: (Span | null)[] | null;
  unverified?: true;
  [extra: string]: unknown;
};
export type ExtractAnswers = Record<string, ExtractAnswer>;

export type ExtractUsage = { input_tokens?: number; output_tokens?: number; state_tokens?: number; image_tokens?: number; schema_tokens?: number; passes?: number };

export type ExtractResponse = {
  model: string;
  answers: ExtractAnswers;
  usage?: ExtractUsage;
  /** True when Clairic cut the state to fit; values after the cut were never read. */
  truncated: boolean;
  request_id: string | null;
  latency_ms: number;
};

/** Images only: Clairic reads no audio or video. Each goes on the wire as content_type and base64 only. */
export type ExtractMedia = { images?: MediaAttachment[] };

// ── Field specs (pure) ────────────────────────────────────────────────────────

export const FIELD_NAME_RE = /^[A-Za-z_][A-Za-z0-9_.\-]{0,63}$/;
const SPEC_KEYS = new Set(["type", "instructions", "unit", "integer", "decimals", "items", "min", "max", "step", "scale", "null_threshold", "horizon", "interval"]);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isProb = (v: unknown): v is number => finite(v) && v >= 0 && v <= 1;
const bound = (v: unknown): v is number | string => finite(v) || (typeof v === "string" && ISO_DATE.test(v));

/** Every reason one field spec (its options, not its name) breaks the live schema, as plain sentences. Empty means sendable. Pure. */
export function specProblems(spec: unknown): string[] {
  if (!isObj(spec)) return ["the field must be an object"];
  const type = spec.type;
  if (!(EXTRACT_FIELD_TYPES as readonly unknown[]).includes(type)) return [`type "${String(type)}" is unknown; it must be one of ${EXTRACT_FIELD_TYPES.join(", ")}`];
  const out: string[] = [];
  for (const k of Object.keys(spec)) if (!SPEC_KEYS.has(k)) out.push(`unknown option "${k}"`);
  if (spec.instructions !== undefined && typeof spec.instructions !== "string") out.push("instructions must be a string");
  if (spec.unit !== undefined && typeof spec.unit !== "string") out.push("unit must be a string");
  if (spec.integer !== undefined && typeof spec.integer !== "boolean") out.push("integer must be true or false");
  if (spec.decimals !== undefined && (!Number.isInteger(spec.decimals) || (spec.decimals as number) < 0 || (spec.decimals as number) > 6)) out.push("decimals must be an integer from 0 to 6");
  if (spec.scale !== undefined && spec.scale !== "linear" && spec.scale !== "log") out.push("scale must be linear or log");
  if (spec.null_threshold !== undefined && !(finite(spec.null_threshold) && spec.null_threshold > 0 && spec.null_threshold <= 1)) out.push("null_threshold must be a number in (0, 1]");
  if (spec.step !== undefined && !((finite(spec.step) && spec.step > 0) || spec.step === "month" || spec.step === "year")) out.push('step must be a positive number, "month" or "year"');
  if (type === "list") {
    if (!(LIST_ITEM_TYPES as readonly unknown[]).includes(spec.items)) out.push(`a list needs items (${LIST_ITEM_TYPES.join(", ")})`);
  } else if (spec.items !== undefined) out.push("items is only for a list");
  if (type === "estimate" || type === "forecast") {
    if (!bound(spec.min) || !bound(spec.max)) out.push(`an ${type} needs min and max (numbers, or ISO dates for a date estimate)`);
    else if (typeof spec.min !== typeof spec.max) out.push("min and max must both be numbers or both be dates");
    else if (spec.min >= spec.max) out.push("min must be below max");
  } else if (spec.min !== undefined || spec.max !== undefined) out.push("min and max are only for an estimate or forecast");
  if (type === "forecast") {
    if (spec.horizon !== undefined && (!Number.isInteger(spec.horizon) || (spec.horizon as number) < 1 || (spec.horizon as number) > 64)) out.push("horizon must be an integer from 1 to 64");
    if (spec.interval !== undefined && !(FORECAST_INTERVALS as readonly unknown[]).includes(spec.interval)) out.push(`interval must be one of ${FORECAST_INTERVALS.join(", ")}`);
  } else if (spec.horizon !== undefined || spec.interval !== undefined) out.push("horizon and interval are only for a forecast");
  return out;
}

/** Every reason one named field breaks the live schema: its name, then its options. Empty means sendable. Pure. */
export function fieldSpecProblems(name: string, spec: unknown): string[] {
  const out = FIELD_NAME_RE.test(name) ? [] : [`field name "${name}" must match ${FIELD_NAME_RE.source}`];
  return [...out, ...specProblems(spec).map((m) => `field "${name}": ${m}`)];
}

/** Every problem in a field map: none, or the reasons it cannot be sent. Pure. */
export function fieldsProblems(fields: unknown): string[] {
  if (!isObj(fields) || Object.keys(fields).length === 0) return ["fields must be a map with at least one field"];
  return Object.entries(fields).flatMap(([name, spec]) => fieldSpecProblems(name, spec));
}

// ── Images (pure) ─────────────────────────────────────────────────────────────

const MIB = 1024 * 1024;
export const EXTRACT_LIMITS = {
  images: { max: 4, eachBytes: 4 * MIB, totalBytes: 8 * MIB, type: /^image\/(png|jpeg|webp)$/ },
  bodyBytes: 16 * MIB,
} as const;

/** Every reason the images would be refused, checked before any fetch. Empty means they fit the live schema. Pure. */
export function extractMediaProblems(media: ExtractMedia | undefined): string[] {
  if (!media) return [];
  const problems: string[] = [];
  for (const k of Object.keys(media)) if (k !== "images") problems.push(`${k}: Clairic reads images only`);
  const list = media.images;
  if (list === undefined) return problems;
  if (!Array.isArray(list)) return [...problems, "images is not an array"];
  const lim = EXTRACT_LIMITS.images;
  if (list.length > lim.max) problems.push(`images: ${list.length} attached, at most ${lim.max}`);
  let total = 0;
  list.forEach((m, i) => {
    if (!m || typeof m.content_type !== "string" || typeof m.base64 !== "string") { problems.push(`images[${i}] needs content_type and base64 strings`); return; }
    if (!lim.type.test(m.content_type)) problems.push(`images[${i}]: content type ${m.content_type} is not accepted`);
    const n = decodedBytes(m.base64);
    if (n === null) { problems.push(`images[${i}]: base64 is malformed`); return; }
    if (n === 0) problems.push(`images[${i}] is empty`);
    if (n > lim.eachBytes) problems.push(`images[${i}]: ${n} bytes, at most ${lim.eachBytes}`);
    total += n;
  });
  if (total > lim.totalBytes) problems.push(`images: ${total} bytes together, at most ${lim.totalBytes}`);
  return problems;
}

// ── Request and response (pure) ───────────────────────────────────────────────

/** The state as Clairic reads it: a string state as is, any other state as its JSON. Spans index this text. Pure. */
export function stateText(state: string | object): string {
  return typeof state === "string" ? state : JSON.stringify(state);
}

/** The Workers AI request body. Each image is rebuilt from content_type and base64 only. Pure. */
export function buildExtractRequest(state: string, fields: ExtractFields, model: string, media?: ExtractMedia): Record<string, unknown> {
  const body: Record<string, unknown> = { model: model.split("/").pop(), state, fields };
  if (Array.isArray(media?.images) && media.images.length) body.images = media.images.map((m) => ({ content_type: m.content_type, base64: m.base64 }));
  return body;
}

const isSpan = (v: unknown): v is Span => Array.isArray(v) && v.length === 2 && Number.isInteger(v[0]) && Number.isInteger(v[1]) && (v[0] as number) >= 0 && (v[0] as number) <= (v[1] as number);

/** Why one answer does not fit its field and the output schema, or null when it does. Pure. */
export function extractAnswerProblem(spec: ExtractFieldSpec, a: unknown): string | null {
  if (!isObj(a)) return "answer is not an object";
  if (a.type !== spec.type) return `answer type ${String(a.type)} for a ${spec.type} field`;
  if (!("value" in a)) return "answer has no value";
  for (const k of ["p_null", "confidence"] as const) if (a[k] !== undefined && a[k] !== null && !isProb(a[k])) return `${k} is not a probability`;
  if (a.span !== undefined && a.span !== null && !isSpan(a.span)) return "span is not a [start, end] pair";
  if (a.spans !== undefined && a.spans !== null && !(Array.isArray(a.spans) && a.spans.every((s) => s === null || isSpan(s)))) return "spans is not a list of [start, end] pairs";
  const v = a.value;
  if (v === null) return null;
  switch (spec.type) {
    case "text": return typeof v === "string" ? null : "text value is not a string";
    case "number": return finite(v) ? null : "number value is not a number";
    case "date": case "time": case "datetime": return typeof v === "string" ? null : `${spec.type} value is not a string`;
    case "duration": return finite(v) || typeof v === "string" ? null : "duration value is not a number or string";
    case "list": return Array.isArray(v) ? null : "list value is not an array";
    case "estimate": return finite(v) || typeof v === "string" ? null : "estimate value is not a number or date";
    case "forecast": return Array.isArray(v) ? null : "forecast value is not an array";
  }
}

/** The answer in Assay's shape: Clairic's keys kept, with value, p_null, confidence and spans always present. Pure. */
function normalize(spec: ExtractFieldSpec, a: Record<string, unknown>): ExtractAnswer {
  const spans: ExtractAnswer["spans"] = spec.type === "text"
    ? (isSpan(a.span) ? [a.span] : null)
    : spec.type === "list" && Array.isArray(a.spans) ? (a.spans as unknown[]).map((s) => (isSpan(s) ? s : null)) : null;
  return { ...a, type: spec.type, value: a.value, p_null: isProb(a.p_null) ? a.p_null : null, confidence: isProb(a.confidence) ? a.confidence : null, spans };
}

/**
 * The answers from a Workers AI response body: the REST envelope `{ success, errors, result }` or a bare result.
 * Every requested field must have a well-formed answer. Pure.
 */
export function parseExtractResponse(body: unknown, fields: ExtractFields, requestedModel: string):
  { ok: true; model: string; answers: ExtractAnswers; usage?: ExtractUsage; truncated: boolean } | { ok: false; message: string } {
  if (!isObj(body)) return { ok: false, message: "response is not a JSON object" };
  if (body.success === false) return { ok: false, message: `extractor reported failure: ${JSON.stringify(body.errors ?? null).slice(0, 200)}` };
  const result = isObj(body.result) ? body.result : body;
  if (!isObj(result.answers)) return { ok: false, message: "response missing answers" };
  const raw = result.answers as Record<string, unknown>;
  const answers: ExtractAnswers = {};
  for (const [name, spec] of Object.entries(fields)) {
    if (!(name in raw)) return { ok: false, message: `response missing answer for "${name}"` };
    const problem = extractAnswerProblem(spec, raw[name]);
    if (problem) return { ok: false, message: `answer "${name}": ${problem}` };
    answers[name] = normalize(spec, raw[name] as Record<string, unknown>);
  }
  const model = typeof result.model === "string" && result.model ? result.model : requestedModel;
  const usage = isObj(result.usage) ? (result.usage as ExtractUsage) : undefined;
  return { ok: true, model, answers, usage, truncated: result.truncated === true };
}

/** Whitespace runs collapsed and the ends trimmed: a copy that differs only in spacing still matches. Pure. */
const squash = (s: string): string => s.replace(/\s+/g, " ").trim();

/** True when the state text at `span` is the copied value. A span outside the text never matches. Pure. */
export function spanMatches(text: string, span: Span | null | undefined, value: unknown): boolean {
  if (!isSpan(span) || typeof value !== "string" || span[1] > text.length) return false;
  return squash(text.slice(span[0], span[1])) === squash(value);
}

/**
 * The copy check, in code. A non-null `text` value must equal the state at its span; so must every text item of a
 * `list`. A value that does not (or has no span to check) comes back null with `unverified: true`, the original kept
 * in `guess`; for a list, one bad item nulls the whole list. A null value is never checked, even when Clairic still
 * returned a guess and span for it. Computed and estimated values carry no span and pass through. Pure.
 */
export function verifySpans(state: string, answers: ExtractAnswers, fields: ExtractFields): ExtractAnswers {
  const out: ExtractAnswers = {};
  for (const [name, a] of Object.entries(answers)) {
    const spec = fields[name];
    let ok = true;
    if (spec?.type === "text" && a.value !== null) ok = spanMatches(state, a.spans?.[0], a.value);
    else if (spec?.type === "list" && spec.items === "text" && Array.isArray(a.value)) {
      ok = (a.value as unknown[]).every((item, i) => item === null || spanMatches(state, a.spans?.[i], item));
    }
    out[name] = ok ? a : { ...a, guess: a.value, value: null, unverified: true };
  }
  return out;
}

// ── The raw call ──────────────────────────────────────────────────────────────

/** A failed callExtractor() call: enough for Assay to write its ledger line and throw the right EngineError. */
export type ExtractCallFailure = {
  ok: false;
  kind: "not-public" | "timeout" | "network" | "http" | "shape" | "media" | "no-key";
  status?: number;
  message: string;
  requestId: string | null;
  latencyMs: number;
  /** null when nothing was sent, else the model asked for. */
  model: string | null;
};
export type ExtractCallOutcome = { ok: true; response: ExtractResponse } | ExtractCallFailure;

export type ExtractCallOptions = {
  model: string;
  /** Bearer token: resolveCredentials().apiToken, the master Cloudflare token. */
  apiKey: string;
  /** Default: resolveCredentials()'s account id. */
  accountId?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  media?: ExtractMedia;
};

/**
 * The raw Clairic call: field-spec check, secret-shape refusal, image limits, the fetch, response validation and the
 * span check. No registry, budget or ledger: those are Assay's (`extract()` in Assay.ts), the only importer. Expected
 * failures return a discriminated outcome; an unexpected error while reading the body is rethrown. `t0` is the
 * caller's clock start (performance.now()), so latency covers the whole extract().
 */
export async function callExtractor(state: string | object, fields: ExtractFields, opts: ExtractCallOptions, t0: number): Promise<ExtractCallOutcome> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const model = opts.model;
  const fail = (kind: ExtractCallFailure["kind"], message: string): ExtractCallFailure => ({ ok: false, kind, message, requestId: null, latencyMs: 0, model: null });
  const text = stateText(state);

  const specProblems = fieldsProblems(fields);
  if (specProblems.length) return fail("shape", `extractor refused fields: ${specProblems.join("; ")}`);
  if (text.length === 0 && !(opts.media?.images?.length)) return fail("shape", "extractor refused: the state is empty and no image is attached");
  // Secret values never leave, on any lane.
  const refuseSecret = fail("not-public", "extractor refused: payload carries a secret value shape");
  if (carriesSecretValue(text) || carriesSecretValue(JSON.stringify(fields))) return refuseSecret;
  if (opts.media !== undefined && carriesSecretOutsidePayload(opts.media)) return refuseSecret;
  const problems = extractMediaProblems(opts.media);
  if (problems.length) return fail("media", `extractor refused media: ${problems.join("; ")}`);
  const requestBody = buildExtractRequest(text, fields, model, opts.media);
  if (carriesSecretOutsidePayload(requestBody)) return refuseSecret;
  const wire = JSON.stringify(requestBody);
  if (Buffer.byteLength(wire) > EXTRACT_LIMITS.bodyBytes) return fail("media", `extractor refused media: request body is ${Buffer.byteLength(wire)} bytes, at most ${EXTRACT_LIMITS.bodyBytes}`);
  const accountId = opts.accountId ?? resolveCredentials()?.accountId ?? null;
  if (!accountId) return fail("no-key", "CLOUDFLARE_ACCOUNT_ID is not set (env or .env)");

  const url = `${WORKERS_AI_ACCOUNTS}/${encodeURIComponent(accountId)}/ai/run/${model}`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? (opts.media?.images?.length ? DEFAULT_EXTRACT_IMAGE_TIMEOUT_MS : DEFAULT_EXTRACT_TIMEOUT_MS));
  let res: Response;
  try {
    res = await fetchImpl(url, { method: "POST", headers: { Authorization: `Bearer ${opts.apiKey}`, "Content-Type": "application/json" }, body: wire, signal: ctl.signal });
  } catch (e) {
    clearTimeout(timer);
    const kind = (e as Error)?.name === "AbortError" ? "timeout" : "network";
    return { ok: false, kind, message: `extractor ${kind}: ${(e as Error)?.message ?? e}`, requestId: null, latencyMs: Math.round(performance.now() - t0), model };
  }
  const requestId = res.headers.get("cf-ray");
  try {
    const latency = Math.round(performance.now() - t0);
    if (res.status !== 200) {
      let detail = "";
      try { detail = (await res.text()).slice(0, 200); } catch { /* the status alone is the error */ }
      return { ok: false, kind: "http", status: res.status, message: `extractor HTTP ${res.status}${detail ? `: ${detail}` : ""}`, requestId, latencyMs: latency, model };
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch (e) {
      if ((e as Error)?.name === "AbortError") throw e;
      return { ok: false, kind: "shape", message: "extractor response was not JSON", requestId, latencyMs: latency, model };
    }
    const parsed = parseExtractResponse(body, fields, model);
    if (!parsed.ok) return { ok: false, kind: "shape", message: `extractor ${parsed.message}`, requestId, latencyMs: latency, model };
    const answers = verifySpans(text, parsed.answers, fields);
    return { ok: true, response: { model: parsed.model, answers, usage: parsed.usage, truncated: parsed.truncated, request_id: requestId, latency_ms: latency } };
  } catch (e) {
    if ((e as Error)?.name !== "AbortError") throw e;
    return { ok: false, kind: "timeout", message: `extractor timeout: ${(e as Error)?.message ?? e}`, requestId, latencyMs: Math.round(performance.now() - t0), model };
  } finally {
    clearTimeout(timer);
  }
}
