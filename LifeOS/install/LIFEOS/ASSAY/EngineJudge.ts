#!/usr/bin/env bun
/**
 * EngineJudge.ts — one frozen Assay question system, any engine.
 *
 * `makeJudge(engine)` returns a JudgeFn (the same signature as Assay's judgeMany), so
 * `runSystem(system, cases, { judge: makeJudge(e) })` runs an unchanged question system on:
 *
 *   clef-omni                    The production engine. States go through Assay judgeMany, unchanged (ledger,
 *                                registry, budgets, retries), with the item's media or the batch media riding
 *                                along. judgeMany does not know `image_path`, so an image_path state goes to
 *                                Clef-omni directly on Workers AI (below), the same model, with its image and
 *                                any item or batch media together. One engine, one row: no item runs on both.
 *   clef, clef-flash             The alternates, Cloudflare Workers AI direct: {state, questions[, images]},
 *                                answers come back typed, verdicts through decide(). Image states attach the
 *                                image (JPEG, longest edge <= 1600 px, base64). Text-only states are refused
 *                                unless the caller names the system id on a text allowlist (synthesized cases
 *                                only; the alternates stay fenced off real text).
 *   opus                         LIFEOS/TOOLS/Inference.ts at the level whose model is the opus alias, anthropic
 *                                only. The prompt carries the state and the typed questions; the reply must be
 *                                strict JSON in the engine answer shape per type, converted to an Answer here.
 *                                Images attach inline; a blind answer (the IMAGE_UNAVAILABLE sentinel) is
 *                                retried, then counted as a failure.
 *
 * Images: a state object with a string `image_path` field has that field stripped from the state the
 * engine reads as text, and the image itself attached.
 *
 * Item and batch media: an item's `media` (else the batch's `opts.media`, as judgeMany picks it) is forwarded to
 * every engine that reads that kind (ENGINE_MEDIA): Clef-omni all three, the alternates images, Opus images written
 * to files and attached. A kind an engine cannot read is refused as that item's error through `onRefuse`, so an
 * answer given without the attachment it was asked about never counts as a success.
 *
 * Every Workers AI call here (the alternates, and Clef-omni's image items) goes through Engine.ts callEngine, so it
 * refuses secret-shaped state and validates every answer against its question before checkEngineAnswer narrows it
 * further. An image item's remaining state is passed through redactState first, on every Workers AI engine alike,
 * so the alternates and the production engine read the same state (ISA ISC-61).
 *
 * Every item is timed (wall clock, retries included) and reported through `onTiming`, so a bakeoff can
 * compare engines on the same footing. One item's failure never fails the batch: it comes back as `error`.
 *
 * Doc: LIFEOS/DOCUMENTATION/Assay/AssaySystem.md § Second-option engines.
 */

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { tmpdir } from "node:os";
import { DEFAULT_CONCURRENCY, decide, judgeMany, noulValue, type JudgeResult, type ManyItem, type ManyOptions, type ManyResult } from "./Assay";
import type { JudgeFn } from "./QuestionSystem";
import { IMAGE_UNAVAILABLE, IMAGE_UNAVAILABLE_ATTEMPTS, OPUS_LEVEL } from "./UseCaseBakeoff";
import { callEngine, decodedBytes, describeFailure, mediaProblems, redactState, resolveCredentials, type Answer, type EngineCredentials, type EngineMedia, type Question, type Questions } from "./Engine";
import { CROSS_VENDOR, modelForEffort } from "../TOOLS/models";
import { inference, planImageInput, sniffImageMediaType, type InferenceOptions, type InferenceResult } from "../TOOLS/Inference";
import { invariant, InvariantViolation } from "../TOOLS/Invariant";

// ── Engines ─────────────────────────────────────────────────────────────────

export const ENGINE_NAMES = ["clef-omni", "clef", "clef-flash", "opus"] as const;
export type EngineName = (typeof ENGINE_NAMES)[number];

/** Workers AI model per alternate Clef engine, called direct, from models.ts (never named here). */
export const CLEF_MODELS: Record<"clef" | "clef-flash", string> = {
  clef: CROSS_VENDOR.clef!,
  "clef-flash": CROSS_VENDOR.clefFlash!,
};

export function isEngineName(s: string): s is EngineName {
  return (ENGINE_NAMES as readonly string[]).includes(s);
}
/** The fenced alternates. Clef-omni is the production engine and is not one of them. */
export function isClef(e: EngineName): e is keyof typeof CLEF_MODELS {
  return e === "clef" || e === "clef-flash";
}

/** The model an engine is expected to run, for the bakeoff table before any answer comes back. */
export function engineModel(e: EngineName): string {
  if (e === "clef-omni") return CROSS_VENDOR.assayEngine!;
  if (e === "opus") return OPUS_LEVEL ? modelForEffort(OPUS_LEVEL) : "opus";
  return CLEF_MODELS[e];
}

export const IMAGE_FIELD = "image_path";
/** Longest edge of an attached image, in pixels. */
export const IMAGE_MAX_EDGE = 1600;

const POOL = { clef: 8, opus: 4 } as const;
const TIMEOUT_MS = { clef: 60_000, opus: 180_000 } as const;
const CONVERT_TIMEOUT_MS = 60_000;
/** A probability set may sum this far from 1 before it is refused; inside it, it is renormalized. */
export const SUM_TOLERANCE = 0.05;

// ── Options and seams ───────────────────────────────────────────────────────

export type Refusal = { engine: EngineName; key: string; reason: string };

export type EngineJudgeOptions = {
  /** The question system's id: the key the Clef text allowlist is checked against. */
  systemId?: string;
  /** System ids whose text-only states may go to Clef (their cases are synthesized). Empty by default. */
  clefTextAllowlist?: readonly string[];
  /** Called once per refused item. Default: one line on stderr. */
  onRefuse?: (r: Refusal) => void;
  /** Called once per item with its wall-clock time, retries included. */
  onTiming?: (key: string, ms: number) => void;
  /** Where downscaled images are written. Default: a fresh temp directory, made on first use. */
  workDir?: string;
  // Test seams: nothing below is needed in production.
  /** Replaces Assay judgeMany for the production engine's text items. */
  assayMany?: JudgeFn;
  fetchImpl?: typeof fetch;
  infer?: (o: InferenceOptions) => Promise<InferenceResult>;
  /** Replaces Engine.ts resolveCredentials (the one credential reader). */
  credentials?: () => EngineCredentials | null;
  /** Returns the path of a JPEG no larger than IMAGE_MAX_EDGE on its longest side. */
  prepareImage?: (path: string, workDir: string) => string;
  readBytes?: (path: string) => Uint8Array;
};

// ── State and images ────────────────────────────────────────────────────────

/** Strips a string `image_path` from an object state. Pure. A string state, or one without the field, has no image. */
export function splitImage(state: string | object): { state: string | object; imagePath: string | null } {
  if (typeof state !== "object" || state === null || Array.isArray(state)) return { state, imagePath: null };
  const rec = state as Record<string, unknown>;
  const v = rec[IMAGE_FIELD];
  if (typeof v !== "string" || v.length === 0) return { state, imagePath: null };
  const { [IMAGE_FIELD]: _drop, ...rest } = rec;
  return { state: rest, imagePath: v };
}

function runTool(cmd: string[], what: string): void {
  const r = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe", timeout: CONVERT_TIMEOUT_MS });
  if (r.exitCode !== 0) throw new Error(`${what} failed (exit ${r.exitCode}): ${r.stderr.toString().trim().slice(-200)}`);
}

/**
 * The one converter command for this platform, so exactly one path runs. macOS keeps sips (`-Z` never upscales);
 * every other platform uses ffmpeg, whose `min(EDGE,iw)` box with force_original_aspect_ratio=decrease never upscales either.
 */
export function imageConvertCommand(path: string, out: string, platform: NodeJS.Platform = process.platform): { cmd: string[]; what: string } {
  if (platform === "darwin") {
    return { cmd: ["sips", "-s", "format", "jpeg", "-s", "formatOptions", "85", "-Z", String(IMAGE_MAX_EDGE), path, "--out", out], what: "sips convert" };
  }
  const box = `scale='min(${IMAGE_MAX_EDGE},iw)':'min(${IMAGE_MAX_EDGE},ih)':force_original_aspect_ratio=decrease`;
  return { cmd: ["ffmpeg", "-v", "error", "-y", "-i", path, "-vf", box, "-frames:v", "1", "-q:v", "3", out], what: "ffmpeg convert" };
}

/** Converts to a JPEG whose longest edge is at most IMAGE_MAX_EDGE (sips on macOS, ffmpeg elsewhere). */
export function prepareImageJpeg(path: string, workDir: string): string {
  if (!existsSync(path)) throw new Error(`image not found: ${basename(path)}`);
  const out = join(workDir, `${basename(path, extname(path))}-${IMAGE_MAX_EDGE}.jpg`);
  const { cmd, what } = imageConvertCommand(path, out);
  runTool(cmd, what);
  return out;
}

// ── Media (item and batch) ──────────────────────────────────────────────────

/**
 * What each engine can read beside the state. Clef-omni reads images, audio and video. The alternates take images
 * and are not known to take audio or video (UseCaseBakeoff reads their live schema before sending video; this judge
 * does not), so those are refused. Opus takes images as attached files only.
 */
export const ENGINE_MEDIA: Record<EngineName, Record<"images" | "audio" | "videos", boolean>> = {
  "clef-omni": { images: true, audio: true, videos: true },
  clef: { images: true, audio: false, videos: false },
  "clef-flash": { images: true, audio: false, videos: false },
  opus: { images: true, audio: false, videos: false },
};

/** The media an item carries: its own, else the batch-wide option, exactly as Assay judgeMany picks it. Pure. */
export function itemMedia(item: ManyItem, opts: Pick<ManyOptions, "media">): EngineMedia | undefined {
  return item.media ?? opts.media;
}

const mediaCount = (m: EngineMedia | undefined): number => (m ? (m.images?.length ?? 0) + (m.audio?.length ?? 0) + (m.videos?.length ?? 0) : 0);

/** The media kinds present that `engine` cannot read. Empty means every attachment can go. Pure. */
export function unreadableMedia(engine: EngineName, media: EngineMedia | undefined): string[] {
  if (!media) return [];
  return (["images", "audio", "videos"] as const).filter((k) => (media[k]?.length ?? 0) > 0 && !ENGINE_MEDIA[engine][k]);
}

const IMAGE_EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };

// ── Answer conversion (pure) ────────────────────────────────────────────────

const isProb = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;

/** Probabilities over exactly `keys`, each in [0,1], summing to 1 within SUM_TOLERANCE; renormalized. */
function distribution(raw: unknown, keys: string[]): Record<string, number> | string {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "probabilities is not an object";
  const rec = raw as Record<string, unknown>;
  const extra = Object.keys(rec).filter((k) => !keys.includes(k));
  if (extra.length) return `unknown option(s): ${extra.join(", ")}`;
  const out: Record<string, number> = {};
  for (const k of keys) {
    const v = rec[k];
    if (!isProb(v)) return `probability for "${k}" missing or outside [0,1]`;
    out[k] = v;
  }
  const sum = Object.values(out).reduce((a, b) => a + b, 0);
  if (Math.abs(sum - 1) > SUM_TOLERANCE) return `probabilities sum to ${sum.toFixed(3)}, not 1`;
  for (const k of keys) out[k] = out[k]! / sum;
  return out;
}

function argmax(p: Record<string, number>, order: string[]): string {
  let best = order[0]!;
  for (const k of order) if (p[k]! > p[best]!) best = k;
  return best;
}

/**
 * One engine reply, converted to the engine's Answer for the question's type, or an error string.
 *   noul   → a probability in [0,1], bare or as {"noul": p}
 *   choice → {"probabilities": {option: p, ...}, "choice"?: option}; the chosen option is the most probable one
 *   score  → {"probabilities": {"0": p, "1": p, ...}} over the level indexes; score is the expected level
 */
export function toAnswer(q: Question, raw: unknown): Answer | string {
  if (q.type === "noul") {
    const p = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>).noul : raw;
    return isProb(p) ? { type: "noul", noul: p } : "noul answer is not a probability in [0,1]";
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return `${q.type} answer is not an object`;
  const rec = raw as Record<string, unknown>;
  if (q.type === "choice") {
    const options = Object.keys(q.criteria);
    const d = distribution(rec.probabilities, options);
    if (typeof d === "string") return `choice: ${d}`;
    if (rec.choice !== undefined && !options.includes(rec.choice as string)) return `choice: "${String(rec.choice)}" is not an option`;
    const choice = argmax(d, options);
    return { type: "choice", choice, confidence: d[choice]!, probabilities: d };
  }
  const levels = q.criteria.map((_, i) => String(i));
  const d = distribution(rec.probabilities, levels);
  if (typeof d === "string") return `score: ${d}`;
  const score = levels.reduce((s, k) => s + Number(k) * d[k]!, 0);
  const legend = Object.fromEntries(q.criteria.map((c, i) => [String(i), typeof c === "string" ? c : JSON.stringify(c)]));
  return { type: "score", score, confidence: d[argmax(d, levels)]!, probabilities: d, legend };
}

/** A typed answer from the Clef API, checked against the question's type before it is trusted. */
export function checkEngineAnswer(q: Question, a: unknown): Answer | string {
  if (!a || typeof a !== "object") return "answer missing";
  const r = a as Record<string, unknown>;
  if (r.type !== q.type) return `expected a ${q.type} answer, got ${String(r.type)}`;
  if (q.type === "noul") return isProb(r.noul) ? { type: "noul", noul: r.noul } : "noul outside [0,1]";
  if (!r.probabilities || typeof r.probabilities !== "object") return `${q.type} answer has no probabilities`;
  const probabilities = r.probabilities as Record<string, number>;
  if (q.type === "choice") {
    if (typeof r.choice !== "string" || !Object.hasOwn(q.criteria, r.choice)) return "choice is not an option";
    const confidence = isProb(r.confidence) ? r.confidence : probabilities[r.choice];
    if (!isProb(confidence)) return "choice has no confidence";
    return { type: "choice", choice: r.choice, confidence, probabilities };
  }
  if (typeof r.score !== "number" || !Number.isFinite(r.score) || r.score < 0 || r.score > q.criteria.length - 1) return "score outside the level range";
  if (!isProb(r.confidence)) return "score has no confidence";
  return { type: "score", score: r.score, confidence: r.confidence, probabilities, ...(r.legend && typeof r.legend === "object" ? { legend: r.legend as Record<string, string> } : {}) };
}

/** Answers → JudgeResult, verdicts through decide() exactly as Glance judge() computes them. */
export function toJudgeResult(answers: Record<string, Answer>, model: string, opts: Pick<ManyOptions, "caller" | "callersPath" | "questionJoins">): JudgeResult {
  const out: JudgeResult = {};
  for (const [id, answer] of Object.entries(answers)) {
    if (answer.type === "noul") Object.assign(answer, noulValue(answer.noul));
    out[id] = { answer, verdict: decide(opts.caller, opts.questionJoins?.[id]?.question ?? id, answer, opts.callersPath), model };
  }
  return out;
}

// ── Opus prompt ─────────────────────────────────────────────────────────────

const text = (v: unknown): string => (typeof v === "string" ? v : JSON.stringify(v));

export function opusSystemPrompt(hasImage: boolean): string {
  return [
    "You are a judgment engine. You read a state and answer typed questions about it with calibrated probabilities. You write no prose.",
    hasImage ? `The image the state refers to is attached to the user message. Look at it before answering. If no image is visible to you, reply with exactly ${IMAGE_UNAVAILABLE} and nothing else.` : "",
    "Reply with strict JSON only, no code fences: one object with a key per question id.",
    'For a noul question the value is the probability, from 0 to 1, that the answer is yes, e.g. 0.82.',
    'For a choice question the value is {"probabilities": {"<option>": p, ...}, "choice": "<most probable option>"} with every option present and the probabilities summing to 1.',
    'For a score question the value is {"probabilities": {"0": p, "1": p, ...}} with one entry per level index, the probabilities summing to 1.',
  ].filter(Boolean).join("\n");
}

export function opusUserPrompt(state: string | object, questions: Questions): string {
  const qs = Object.entries(questions).map(([id, q]) => {
    const head = `- ${id} (${q.type}): ${text(q.instructions)}`;
    if (q.type === "noul") {
      const c = q.criteria ? [q.criteria.true ? `  yes means: ${text(q.criteria.true)}` : "", q.criteria.false ? `  no means: ${text(q.criteria.false)}` : ""].filter(Boolean) : [];
      return [head, ...c].join("\n");
    }
    if (q.type === "choice") return [head, ...Object.entries(q.criteria).map(([k, v]) => `  option "${k}"${v === null ? "" : `: ${text(v)}`}`)].join("\n");
    return [head, ...q.criteria.map((c, i) => `  level ${i}: ${text(c)}`)].join("\n");
  }).join("\n");
  return `State:\n${typeof state === "string" ? state : JSON.stringify(state, null, 1)}\n\nQuestions:\n${qs}`;
}

/** Strict JSON, one surrounding code fence tolerated; every question converted or an error string. */
export function parseOpusReply(reply: string, questions: Questions): Record<string, Answer> | string {
  const body = reply.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let obj: unknown;
  try { obj = JSON.parse(body); } catch { return "reply was not JSON"; }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return "reply was not a JSON object";
  const out: Record<string, Answer> = {};
  for (const [id, q] of Object.entries(questions)) {
    const a = toAnswer(q, (obj as Record<string, unknown>)[id]);
    if (typeof a === "string") return `${id}: ${a}`;
    out[id] = a;
  }
  return out;
}

// ── Pool ────────────────────────────────────────────────────────────────────

type ItemCall = (item: ManyItem, questions: Questions) => Promise<{ result: JudgeResult } | { error: string }>;

async function pool(items: ManyItem[], questions: Questions, width: number, call: ItemCall, onTiming?: (k: string, ms: number) => void): Promise<ManyResult[]> {
  invariant(Number.isInteger(width) && width >= 1, "EngineJudge: concurrency must be a positive integer");
  invariant(new Set(items.map((i) => i.key)).size === items.length, "EngineJudge: item keys must be unique");
  const out: ManyResult[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      const item = items[i]!;
      const t0 = performance.now();
      let r: { result: JudgeResult } | { error: string };
      try { r = await call(item, item.questions ?? questions); } catch (e) { r = { error: `threw: ${String((e as Error)?.message ?? e).slice(0, 200)}` }; }
      onTiming?.(item.key, Math.round(performance.now() - t0));
      out[i] = "result" in r ? { key: item.key, result: r.result, error: null } : { key: item.key, result: null, error: r.error };
    }
  };
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, worker));
  return out;
}

// ── Engine calls ────────────────────────────────────────────────────────────


const transient = (e: string) => /^(timeout|network|HTTP 5\d\d|HTTP 429)/.test(e);

/**
 * The JudgeFn for one engine. `systemId` and `clefTextAllowlist` gate what a Clef engine may send;
 * every refusal is reported through `onRefuse` and returned as that item's error.
 */
export function makeJudge(engine: EngineName, o: EngineJudgeOptions = {}): JudgeFn {
  invariant(isEngineName(engine), `EngineJudge: unknown engine "${String(engine)}"`);
  const refuse = (key: string, reason: string) => {
    (o.onRefuse ?? ((r: Refusal) => console.error(`[EngineJudge] ${r.engine} refused ${r.key}: ${r.reason}`)))({ engine, key, reason });
    return { error: reason };
  };
  let workDir = o.workDir;
  const prepared = new Map<string, string>();
  const prepare = (p: string): string => {
    const hit = prepared.get(p);
    if (hit) return hit;
    workDir ??= mkdtempSync(join(tmpdir(), "engine-judge-"));
    const out = (o.prepareImage ?? prepareImageJpeg)(p, workDir);
    prepared.set(p, out);
    return out;
  };
  const readBytes = o.readBytes ?? ((p: string) => readFileSync(p));
  // Opus attaches images by path, so an item's base64 images are written into the work directory first.
  let mediaSeq = 0;
  const writeMediaImage = (m: { content_type: string; base64: string }): string => {
    const ext = IMAGE_EXT[m.content_type];
    invariant(ext !== undefined, `EngineJudge: no file extension for ${m.content_type} (mediaProblems admits png, jpeg and webp only)`);
    const bytes = Buffer.from(m.base64, "base64");
    invariant(bytes.length > 0 && bytes.length === decodedBytes(m.base64), "EngineJudge: a media image must decode to the bytes its base64 states");
    workDir ??= mkdtempSync(join(tmpdir(), "engine-judge-"));
    const out = join(workDir, `media-${++mediaSeq}.${ext}`);
    writeFileSync(out, bytes);
    return out;
  };

  // Media the engine cannot read is refused out loud: an answer given without the attachment it was asked about is
  // never counted as a success (M7 audit blocker 2).
  const refuseUnreadable = (item: ManyItem, opts: ManyOptions): { error: string } | null => {
    const kinds = unreadableMedia(engine, itemMedia(item, opts));
    return kinds.length ? refuse(item.key, `${engine} cannot read ${kinds.join(", ")}; refused rather than answered without it`) : null;
  };

  // Workers AI direct, through callEngine: the alternates, and the production engine's image_path items (judgeMany
  // does not know image_path; it carries an item's media and the batch media itself).
  let cf: EngineCredentials | null = null;
  const direct = (model: string) => async (item: ManyItem, qs: Questions, opts: ManyOptions): Promise<{ result: JudgeResult } | { error: string }> => {
    const unreadable = refuseUnreadable(item, opts);
    if (unreadable) return unreadable;
    const allow = new Set(o.clefTextAllowlist ?? []);
    const split = splitImage(item.state);
    const imagePath = split.imagePath;
    const given = itemMedia(item, opts);
    const textOnly = imagePath === null && mediaCount(given) === 0;
    if (textOnly && !(o.systemId !== undefined && allow.has(o.systemId))) {
      return refuse(item.key, `text-only state for system "${o.systemId ?? "(unnamed)"}" is not on the Clef text allowlist`);
    }
    // Text-only states reach here only from an allowlisted synthesized system and are sent as given; a media item's
    // state is redacted on every Workers AI engine alike.
    const state = textOnly ? split.state : redactState(split.state);
    let media: EngineMedia | undefined = given && mediaCount(given) > 0 ? { ...given } : undefined;
    if (imagePath !== null) {
      try {
        const jpeg = prepare(imagePath);
        const bytes = readBytes(jpeg);
        const fromPath = { content_type: sniffImageMediaType(Buffer.from(bytes)) ?? "image/jpeg", base64: Buffer.from(bytes).toString("base64") };
        // The item's own images first, then the image_path image; Engine.ts mediaProblems holds the count limit.
        media = { ...(media ?? {}), images: [...(media?.images ?? []), fromPath] };
      } catch (e) {
        return { error: `image unreadable: ${String((e as Error)?.message ?? e).slice(0, 160)}` };
      }
    }
    cf ??= (o.credentials ?? resolveCredentials)();
    if (!cf) return { error: "no-key: CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_API_TOKEN missing" };
    const retries = opts.retries ?? 1;
    let error = "not attempted";
    for (let attempt = 0; attempt <= retries; attempt++) {
      const r = await callEngine(state, qs, {
        model, apiKey: cf.apiToken, accountId: cf.accountId, timeoutMs: TIMEOUT_MS.clef,
        ...(media ? { media } : {}), ...(o.fetchImpl ? { fetchImpl: o.fetchImpl } : {}),
      }, performance.now());
      if (r.ok) {
        const answers: Record<string, Answer> = {};
        for (const [id, q] of Object.entries(qs)) {
          const a = checkEngineAnswer(q, r.response.answers[id]);
          if (typeof a === "string") return { error: `shape: ${id}: ${a}` };
          answers[id] = a;
        }
        return { result: toJudgeResult(answers, r.response.model, opts) };
      }
      error = describeFailure(r);
      if (!transient(error)) break;
    }
    return { error };
  };

  if (engine === "clef-omni") {
    const many = o.assayMany ?? judgeMany;
    const media = direct(CROSS_VENDOR.assayEngine!);
    return (items, questions, opts) => pool(items, questions, opts.concurrency ?? DEFAULT_CONCURRENCY, async (item, qs) => {
      if (splitImage(item.state).imagePath !== null) return media(item, qs, opts);
      // judgeMany unchanged, one item at a time so each item is timed; its retries, ledger and verdicts are Assay's own.
      // The item (with its media) and opts (with the batch media) pass through whole: judgeMany sends item.media ?? opts.media.
      const [r] = await many([item], qs, { ...opts, concurrency: 1 });
      return r && r.result ? { result: r.result } : { error: r?.error ?? "no result returned" };
    }, o.onTiming);
  }

  if (isClef(engine)) {
    const call = direct(CLEF_MODELS[engine]);
    return (items, questions, opts) => pool(items, questions, Math.min(opts.concurrency ?? POOL.clef, POOL.clef), (item, qs) => call(item, qs, opts), o.onTiming);
  }

  // opus
  const infer = o.infer ?? inference;
  return (items, questions, opts) => pool(items, questions, Math.min(opts.concurrency ?? POOL.opus, POOL.opus), async (item, qs) => {
    if (!OPUS_LEVEL) return { error: "no inference level resolves to the opus alias in models.ts" };
    const unreadable = refuseUnreadable(item, opts);
    if (unreadable) return unreadable;
    const { state, imagePath } = splitImage(item.state);
    let imagePaths: string[] = [];
    const given = itemMedia(item, opts);
    if (given?.images?.length) {
      const problems = mediaProblems({ images: given.images });
      if (problems.length) return { error: `media: ${problems.join("; ").slice(0, 200)}` };
      try {
        imagePaths = given.images.map((m) => writeMediaImage(m));
      } catch (e) {
        if (e instanceof InvariantViolation) throw e; // an impossible state fails loud, never as an item error
        return { error: `image unwritable: ${String((e as Error)?.message ?? e).slice(0, 160)}` };
      }
    }
    if (imagePath !== null) {
      try {
        imagePaths.push(prepare(imagePath));
      } catch (e) {
        return { error: `image unreadable: ${String((e as Error)?.message ?? e).slice(0, 160)}` };
      }
    }
    if (imagePaths.length) {
      try {
        const plan = planImageInput(imagePaths, readBytes);
        if (plan.viaRead.length) return { error: `image would not attach inline: ${plan.viaRead.map((p) => basename(p)).join(", ")}` };
      } catch (e) {
        return { error: `image unreadable: ${String((e as Error)?.message ?? e).slice(0, 160)}` };
      }
    }
    for (let attempt = 1; ; attempt++) {
      const r = await infer({
        systemPrompt: opusSystemPrompt(imagePaths.length > 0),
        userPrompt: opusUserPrompt(state, qs),
        level: OPUS_LEVEL,
        vendor: "anthropic",
        allowVendorFallback: false,
        timeout: TIMEOUT_MS.opus,
        ...(imagePaths.length ? { imagePaths } : {}),
      });
      const executed = typeof r?.executedModel === "string" && r.executedModel ? r.executedModel : null;
      if (!r || typeof r.success !== "boolean") return { error: "malformed inference result" };
      // Never echo r.output on failure: it may carry request content.
      if (!r.success) return { error: String(r.error ?? "call failed").slice(0, 200) };
      if (r.vendor !== undefined && r.vendor !== "anthropic") return { error: `answered by vendor ${r.vendor}, refused` };
      if (executed && !executed.includes("opus")) return { error: `ran ${executed}, not opus` };
      const reply = typeof r.output === "string" ? r.output.trim() : "";
      if (imagePaths.length && reply === IMAGE_UNAVAILABLE) {
        if (attempt < IMAGE_UNAVAILABLE_ATTEMPTS) continue;
        return { error: `blind: the image did not reach the model (${attempt} attempts)` };
      }
      const answers = parseOpusReply(reply, qs);
      if (typeof answers === "string") return { error: `shape: ${answers}` };
      return { result: toJudgeResult(answers, executed ?? modelForEffort(OPUS_LEVEL), opts) };
    }
  }, o.onTiming);
}
