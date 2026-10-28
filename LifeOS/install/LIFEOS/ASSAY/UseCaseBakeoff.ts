#!/usr/bin/env bun
/**
 * UseCaseBakeoff.ts — Assay's engines against the principal's own verdicts on things we made.
 *
 * Doc: LIFEOS/DOCUMENTATION/Assay/AssaySystem.md § Second-option engines.
 *
 * Reads the use-case corpus (LIFEOS/ASSAY/UseCaseCorpus.ts: blog posts, art and video we produced,
 * each labelled accept or reject by a recorded principal verdict or by publication) and asks every
 * engine that can read a case the same fixed noul questions for its type:
 *
 *   clef-omni                        the production engine, through Assay.ask() under the offline shadow
 *                                    caller `guard-calibration`: text, images, and video (native when the file
 *                                    fits a `videos` field, else the same four frames). Called once, here only.
 *   clef, clef-flash                 the alternates, direct on Cloudflare Workers AI through Engine.ts callEngine
 *                                    (secret-shape refusal, media limits, answer validation): images, video, and text
 *                                    ONLY when the text is already published (case.public). The fence is enforced in
 *                                    code, inside the request builder, before any request is built (ISC-20).
 *   opus                             LIFEOS/TOOLS/Inference.ts at the level whose model is the opus alias,
 *                                    images attached inline; an answer given without the image is a
 *                                    failure, never a score (ISC-22)
 *
 * State is built ONCE per case and shared by every engine (ISC-23): text is extracted prose passed
 * through redactForEngine and capped; image and video cases get one neutral sentence plus the media.
 * Video goes natively only to a model that takes a `videos` field (Clef-omni today; an alternate is
 * checked against its live input schema) and only within that field's limits; every other vision
 * engine, Opus included, gets the same four evenly spaced frames.
 *
 * Accuracy uses a 0.5 cut: these questions have no registered Glance cut (ISA Decisions 2026-10-10).
 *
 * Writes: one raw file per run under MEMORY/OBSERVABILITY/assay-usecase-bakeoff/ (a meta line, then
 * one row per routed case-engine pair) and one summary line in
 * MEMORY/OBSERVABILITY/assay-usecase-bakeoff.jsonl.
 *
 * Usage:
 *   bun LIFEOS/ASSAY/UseCaseBakeoff.ts run [--types text,image,video] [--engines clef-omni,clef,...] [--limit N] [--corpus PATH] [--json]
 *   bun LIFEOS/ASSAY/UseCaseBakeoff.ts report [--file PATH]     score a recorded raw file (latest by default)
 *   bun LIFEOS/ASSAY/UseCaseBakeoff.ts history                  one line per past run
 *
 * `--limit N` keeps the first N cases of each type (a smoke run). Exit codes: 0 ok · 1 error (bad
 * arguments, missing credentials, an engine that failed every case routed to it).
 */

import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { tmpdir } from "node:os";
import { CALIBRATION_CALLER } from "./Calibrate";
import { ask } from "./Assay";
import { metrics, type Metrics } from "./EngineBakeoff";
import { CASE_TYPES, CORPUS_PATH, readCorpus, sha256File, type CaseType, type CorpusCase } from "./UseCaseCorpus";
import { callEngine, describeFailure, redactForEngine, resolveCredentials, WORKERS_AI_ACCOUNTS, type EngineCredentials, type EngineMedia, type Questions } from "./Engine";
import { CROSS_VENDOR, modelForEffort, type EffortLevel } from "../TOOLS/models";
import { inference, planImageInput, sniffImageMediaType, INLINE_IMAGE_MAX_BYTES, type InferenceOptions, type InferenceResult } from "../TOOLS/Inference";
import { lifeosPath } from "../TOOLS/Paths";
import { invariant } from "../TOOLS/Invariant";

// ── Types and constants ─────────────────────────────────────────────────────

export { CASE_TYPES, type CaseType };
export type EngineId = "clef-omni" | "clef" | "clef-flash" | "opus";
export type EngineKind = "glance" | "workers-ai" | "inference";
export type Engine = { id: EngineId; kind: EngineKind; model: string };

/** The inference level whose model is the opus alias. Resolved from models.ts, never named here. */
export const OPUS_LEVEL: EffortLevel | undefined = (["low", "medium", "high", "max"] as const).find((l) => modelForEffort(l) === "opus");

export const ENGINES: Engine[] = [
  // The production engine, through Assay.ask: the one Clef-omni row. There is no second, direct Clef-omni row.
  { id: "clef-omni", kind: "glance", model: CROSS_VENDOR.assayEngine! },
  { id: "clef", kind: "workers-ai", model: CROSS_VENDOR.clef! },
  { id: "clef-flash", kind: "workers-ai", model: CROSS_VENDOR.clefFlash! },
  { id: "opus", kind: "inference", model: OPUS_LEVEL ? modelForEffort(OPUS_LEVEL) : "opus" },
];

/** Fixed per type, identical wording for every engine. Every question is scored against the case label (accept = yes). */
export const QUESTIONS: Record<CaseType, Questions> = {
  text: {
    publish_ready: { type: "noul", instructions: "Would the principal publish this piece as-is, without asking for a rewrite?" },
    voice: { type: "noul", instructions: "Does this match the principal's own voice and the quality of their published writing?" },
  },
  image: {
    accept: { type: "noul", instructions: "Would the principal accept this image as-is to publish?" },
    pro: { type: "noul", instructions: "Is this professional-grade art rather than amateur or generic AI output?" },
  },
  video: {
    accept: { type: "noul", instructions: "Would the principal accept this video or animation as-is to publish?" },
    pro: { type: "noul", instructions: "Is this professional-grade video or animation rather than amateur or generic AI output?" },
  },
};

/** Neutral state for media cases: says what the thing is, never how good it is. */
export const MEDIA_STATE: Record<Exclude<CaseType, "text">, string> = {
  image: "An image the principal's system produced for publication.",
  video: "A video or animation the principal's system produced for publication.",
};

/** Characters of extracted prose kept in a text case's state, for every engine alike. */
export const TEXT_STATE_CAP = 6000;
/** Accuracy cut: these questions have no registered Glance cut (ISA Decisions, 2026-10-10). */
export const CUT = 0.5;
/** A type or cell with fewer cases than this in either class is too few to conclude (ISC-26). */
export const THIN_BELOW = 10;
export const FRAMES_PER_VIDEO = 4;
/** Workers AI image limits (live schema, 2026-10-10): 4 MiB and 16 megapixels each. Opus's inline cap is tighter. */
export const MEDIA_MAX_BYTES = Math.min(4 * 1024 * 1024, INLINE_IMAGE_MAX_BYTES);
export const MEDIA_MAX_PIXELS = 16_000_000;
/** Clef-omni `videos` field limits (live schema, 2026-10-10): 16 MiB and 60 seconds each. */
export const NATIVE_VIDEO_MAX_BYTES = 16 * 1024 * 1024;
export const NATIVE_VIDEO_MAX_SECONDS = 60;
const NATIVE_VIDEO_TYPES: Record<string, string> = { ".mp4": "video/mp4", ".webm": "video/webm" };

/** Said by Opus when the image did not attach, mirroring skills/ArtDirection/Tools/Critique.ts. */
export const IMAGE_UNAVAILABLE = "IMAGE_UNAVAILABLE";
export const IMAGE_UNAVAILABLE_ATTEMPTS = 3;

const POOL: Record<EngineKind, number> = { glance: 8, "workers-ai": 8, inference: 4 };
const TIMEOUT_MS: Record<EngineKind, number> = { glance: 15_000, "workers-ai": 60_000, inference: 180_000 };
const TOOL_TIMEOUT_MS = 60_000;

const OBS = () => lifeosPath("MEMORY", "OBSERVABILITY");
const rawDir = () => join(OBS(), "assay-usecase-bakeoff");
const historyPath = () => join(OBS(), "assay-usecase-bakeoff.jsonl");

// ── Corpus (the shared reader from UseCaseCorpus.ts) ────────────────────────

/** Shape check at the boundary: the corpus file is another lane's output, so it is checked before use. */
export function assertCase(c: unknown): asserts c is CorpusCase {
  const r = c as Record<string, unknown>;
  const id = typeof r?.id === "string" ? r.id : "<unknown>";
  invariant(!!r && typeof r === "object", `UseCaseBakeoff: corpus case ${id} is not an object`);
  invariant(typeof r.id === "string" && r.id.length > 0, `UseCaseBakeoff: corpus case without an id`);
  invariant(CASE_TYPES.includes(r.type as CaseType), `UseCaseBakeoff: corpus case ${id} has type ${String(r.type)}`);
  invariant(typeof r.artifact === "string" && r.artifact.startsWith("/"), `UseCaseBakeoff: corpus case ${id} artifact must be an absolute path`);
  invariant(r.label === "accept" || r.label === "reject", `UseCaseBakeoff: corpus case ${id} label must be accept or reject`);
  invariant(typeof r.public === "boolean", `UseCaseBakeoff: corpus case ${id} public must be a boolean`);
}

export function loadCorpus(path: string = CORPUS_PATH): CorpusCase[] {
  const cases = readCorpus(path);
  for (const c of cases) assertCase(c);
  invariant(new Set(cases.map((c) => c.id)).size === cases.length, "UseCaseBakeoff: corpus case ids must be unique");
  return cases;
}

/** Keep the requested types, and the first `limit` cases of each type when a limit is set. */
export function selectCases(cases: CorpusCase[], types: readonly CaseType[], limit?: number): CorpusCase[] {
  return types.flatMap((t) => {
    const mine = cases.filter((c) => c.type === t);
    return limit === undefined ? mine : mine.slice(0, limit);
  });
}

// ── Routing and the Cloudflare fence ────────────────────────────────────────

/** ISC-21: the one routing rule. Every engine reads all three types; the fenced alternates get media and public text only. */
export function routes(engine: EngineId, c: Pick<CorpusCase, "type" | "public">): boolean {
  if (isCloudflare(engine) && c.type === "text") return c.public === true;
  return true;
}

/** The fenced alternates: called direct on Workers AI. Clef-omni is the production engine and goes through Assay.ask, not here. */
export function isCloudflare(engine: EngineId): boolean {
  return engine === "clef" || engine === "clef-flash";
}

export class CloudflareFenceError extends Error {
  constructor(id: string) {
    super(`UseCaseBakeoff fence: text case ${id} is not public and may not go to Cloudflare`);
    this.name = "CloudflareFenceError";
  }
}

/** ISC-20: text reaches Cloudflare only when it is already published. Throws before any request is built. */
export function assertCloudflareAllowed(c: Pick<CorpusCase, "id" | "type" | "public">): void {
  if (c.type === "text" && c.public !== true) throw new CloudflareFenceError(c.id);
  invariant(c.type === "text" || c.type === "image" || c.type === "video", `UseCaseBakeoff fence: unknown type for ${c.id}`);
}

// ── State and media, built once per case ────────────────────────────────────

export type MediaFile = { path: string; content_type: string };
export type CaseInput = {
  case: CorpusCase;
  state: string;
  questions: Questions;
  /** Image cases: the one prepared image. Video cases: the evenly spaced frames. Text: empty. */
  images: MediaFile[];
  /** Video cases only, when the file fits a native `videos` field. */
  video: MediaFile | null;
  /** Set when the media could not be prepared; every engine then records this as its failure. */
  prep_error: string | null;
};

/** Prose from a post file: front matter, scripts, styles, tags and markdown images removed, whitespace collapsed. */
export function extractProse(raw: string): string {
  return raw
    .replace(/^﻿?---\r?\n[\s\S]*?\r?\n---\r?\n/, "")
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*\n\s*/g, "\n\n")
    .trim();
}

export function textState(raw: string): string {
  return redactForEngine(extractProse(raw), TEXT_STATE_CAP);
}

export type MediaDeps = {
  /** Throws when the artifact on disk is no longer the file the principal labelled. */
  verify: (c: CorpusCase) => void;
  readText: (path: string) => string;
  prepareImage: (path: string, workDir: string) => MediaFile;
  prepareVideo: (path: string, workDir: string) => { frames: MediaFile[]; video: MediaFile | null };
};

/** ISC-23: one input per case, shared by reference by every engine that reads it. */
export function buildInput(c: CorpusCase, workDir: string, deps: MediaDeps): CaseInput {
  const type = c.type as CaseType;
  const base = { case: c, questions: QUESTIONS[type], images: [] as MediaFile[], video: null as MediaFile | null, prep_error: null as string | null };
  try {
    deps.verify(c);
    if (type === "text") return { ...base, state: textState(deps.readText(c.artifact)) };
    if (type === "image") return { ...base, state: MEDIA_STATE.image, images: [deps.prepareImage(c.artifact, workDir)] };
    const v = deps.prepareVideo(c.artifact, workDir);
    return { ...base, state: MEDIA_STATE.video, images: v.frames, video: v.video };
  } catch (e) {
    return { ...base, state: type === "text" ? "" : MEDIA_STATE[type], prep_error: `media prep: ${String((e as Error)?.message ?? e).slice(0, 200)}` };
  }
}

export type Job = { engine: Engine; input: CaseInput };

/** Every routed (case, engine) pair; unroutable pairs are never called. */
export function planJobs(inputs: CaseInput[], engines: Engine[]): Job[] {
  return inputs.flatMap((input) => engines.filter((e) => routes(e.id, input.case)).map((engine) => ({ engine, input })));
}

function run(cmd: string[], what: string): string {
  const r = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe", timeout: TOOL_TIMEOUT_MS });
  if (r.exitCode !== 0) throw new Error(`${what} failed (exit ${r.exitCode}): ${r.stderr.toString().trim().slice(-200)}`);
  return r.stdout.toString();
}

/**
 * The one size and convert command for this platform, so exactly one path runs: macOS keeps sips, every other
 * platform uses ffprobe and ffmpeg (the same split as EngineJudge.imageConvertCommand), whose box never upscales.
 */
export function imageSizeCommand(path: string, platform: NodeJS.Platform = process.platform): { cmd: string[]; what: string; parse: (out: string) => [number, number] } {
  if (platform === "darwin") return { cmd: ["sips", "-g", "pixelWidth", "-g", "pixelHeight", path], what: "sips size", parse: (o) => [Number(/pixelWidth:\s*(\d+)/.exec(o)?.[1]), Number(/pixelHeight:\s*(\d+)/.exec(o)?.[1])] };
  return { cmd: ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", path], what: "ffprobe size", parse: (o) => { const [w, h] = o.trim().split(",").map(Number); return [w, h]; } };
}

export function imageEdgeConvertCommand(path: string, out: string, edge: number, platform: NodeJS.Platform = process.platform): { cmd: string[]; what: string } {
  if (platform === "darwin") return { cmd: ["sips", "-s", "format", "jpeg", "-s", "formatOptions", "85", "-Z", String(edge), path, "--out", out], what: "sips convert" };
  const box = `scale='min(${edge},iw)':'min(${edge},ih)':force_original_aspect_ratio=decrease`;
  return { cmd: ["ffmpeg", "-v", "error", "-y", "-i", path, "-vf", box, "-frames:v", "1", "-q:v", "3", out], what: "ffmpeg convert" };
}

function pixels(path: string): number {
  const size = imageSizeCommand(path);
  const [w, h] = size.parse(run(size.cmd, size.what));
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) throw new Error(`could not read the dimensions of ${basename(path)}`);
  return w * h;
}

/** True when both Workers AI and Opus's inline attachment take the file unchanged. */
function fitsAsIs(path: string): MediaFile | null {
  const bytes = readFileSync(path);
  const type = sniffImageMediaType(bytes);
  if (!type || type === "image/gif") return null;
  if (bytes.length === 0 || bytes.length > MEDIA_MAX_BYTES) return null;
  if (pixels(path) > MEDIA_MAX_PIXELS) return null;
  return { path, content_type: type };
}

/** The original when it already fits both engines; otherwise a JPEG downscaled until it does. */
export function prepareImage(path: string, workDir: string): MediaFile {
  const asIs = fitsAsIs(path);
  if (asIs) return asIs;
  for (const edge of [2048, 1536, 1024]) {
    const out = join(workDir, `${basename(path, extname(path))}-${edge}.jpg`);
    const conv = imageEdgeConvertCommand(path, out, edge);
    run(conv.cmd, conv.what);
    const fit = fitsAsIs(out);
    if (fit) return fit;
  }
  throw new Error(`${basename(path)} would not fit ${MEDIA_MAX_BYTES} bytes and ${MEDIA_MAX_PIXELS} pixels`);
}

function probeDuration(path: string): number {
  const out = run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", path], "ffprobe duration").trim();
  return Number(out);
}

function probeFrameCount(path: string): number {
  const out = run(["ffprobe", "-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=nb_read_frames", "-of", "default=nw=1:nk=1", path], "ffprobe frames").trim();
  return Number(out);
}

/** Times (seconds) of FRAMES_PER_VIDEO evenly spaced frames, each in the middle of its quarter. Pure. */
export function frameTimes(duration: number, n = FRAMES_PER_VIDEO): number[] {
  return Array.from({ length: n }, (_, i) => Number(((duration * (i + 0.5)) / n).toFixed(3)));
}

/** Four evenly spaced JPEG frames, plus the file itself when it fits a native `videos` field. */
export function prepareVideo(path: string, workDir: string): { frames: MediaFile[]; video: MediaFile | null } {
  const stem = basename(path, extname(path));
  const duration = probeDuration(path);
  const frames: MediaFile[] = [];
  const scale = "scale='min(1280,iw)':-2";
  if (Number.isFinite(duration) && duration > 0) {
    frameTimes(duration).forEach((t, i) => {
      const out = join(workDir, `${stem}-f${i}.jpg`);
      run(["ffmpeg", "-v", "error", "-y", "-ss", String(t), "-i", path, "-frames:v", "1", "-vf", scale, "-q:v", "3", out], "ffmpeg frame");
      frames.push({ path: out, content_type: "image/jpeg" });
    });
  } else {
    // Animated GIFs and some containers report no duration; pick frames by index instead.
    const count = probeFrameCount(path);
    if (!Number.isFinite(count) || count < 1) throw new Error(`${basename(path)} has no readable duration or frames`);
    frameTimes(count).forEach((t, i) => {
      const n = Math.min(count - 1, Math.floor(t));
      const out = join(workDir, `${stem}-f${i}.jpg`);
      run(["ffmpeg", "-v", "error", "-y", "-i", path, "-vf", `select=eq(n\\,${n}),${scale}`, "-fps_mode", "passthrough", "-frames:v", "1", "-q:v", "3", out], "ffmpeg frame");
      frames.push({ path: out, content_type: "image/jpeg" });
    });
  }
  for (const f of frames) invariant(existsSync(f.path) && statSync(f.path).size > 0, `UseCaseBakeoff: frame ${f.path} was not written`);
  const nativeType = NATIVE_VIDEO_TYPES[extname(path).toLowerCase()];
  const native = nativeType && Number.isFinite(duration) && duration <= NATIVE_VIDEO_MAX_SECONDS && statSync(path).size <= NATIVE_VIDEO_MAX_BYTES;
  return { frames, video: native ? { path, content_type: nativeType } : null };
}

export function verifyArtifact(c: CorpusCase, hash: (p: string) => string = sha256File): void {
  if (!existsSync(c.artifact)) throw new Error(`artifact missing: ${c.artifact}`);
  if (hash(c.artifact) !== c.sha256) throw new Error(`artifact changed since the corpus was built: ${basename(c.artifact)}`);
}

const REAL_MEDIA: MediaDeps = { verify: (c) => verifyArtifact(c), readText: (p) => readFileSync(p, "utf8"), prepareImage, prepareVideo };

// ── Engine calls ────────────────────────────────────────────────────────────

export type Answer = { model: string | null; latency_ms: number; error: string | null; p: Record<string, number>; media: string; attempts?: number };
export type Row = Answer & { engine: EngineId; id: string; type: CaseType; label: "accept" | "reject"; public: boolean };

export type ModelCaps = { video: boolean };

/** The engine client's one credential reader (Engine.ts resolveCredentials). */
function cloudflare(): EngineCredentials {
  const creds = resolveCredentials();
  if (!creds) throw new Error("UseCaseBakeoff: CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_API_TOKEN missing");
  return creds;
}

/** Whether a model's live input schema has a native `videos` field. A read-only GET; a failed fetch fails the run loudly. */
export async function fetchCaps(model: string, cf: EngineCredentials, fetchImpl: typeof fetch = fetch): Promise<ModelCaps> {
  const res = await fetchImpl(`${WORKERS_AI_ACCOUNTS}/${encodeURIComponent(cf.accountId)}/ai/models/schema?model=${encodeURIComponent(model)}`, {
    headers: { Authorization: `Bearer ${cf.apiToken}` },
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await res.json().catch(() => null)) as { result?: { input?: { properties?: Record<string, unknown> } } } | null;
  const props = body?.result?.input?.properties;
  if (res.status !== 200 || !props || typeof props !== "object") throw new Error(`UseCaseBakeoff: schema for ${model} unreadable (HTTP ${res.status})`);
  return { video: "videos" in props };
}

function nouls(answers: unknown, ids: string[]): Record<string, number> {
  const p: Record<string, number> = {};
  for (const q of ids) {
    const a = (answers as Record<string, { type?: string; noul?: unknown }> | undefined)?.[q];
    if (a?.type === "noul" && typeof a.noul === "number" && Number.isFinite(a.noul) && a.noul >= 0 && a.noul <= 1) p[q] = a.noul;
  }
  return p;
}

/** The media mode a Workers AI call will use for this input. */
export function workersAiMedia(input: CaseInput, caps: ModelCaps): "text" | "image" | "native-video" | "frames" {
  if (input.case.type === "text") return "text";
  if (input.case.type === "image") return "image";
  return caps.video && input.video ? "native-video" : "frames";
}

/** What a fenced alternate is sent: state, questions and media. The fence runs first, before any file is read or field is built. */
export function buildWorkersAiRequest(engine: Engine, input: CaseInput, caps: ModelCaps, readBytes: (p: string) => Uint8Array = (p) => readFileSync(p)): { state: string; questions: Questions; media: EngineMedia } {
  assertCloudflareAllowed(input.case);
  invariant(isCloudflare(engine.id), `UseCaseBakeoff: ${engine.id} is not a Workers AI engine`);
  const b64 = (f: MediaFile) => ({ content_type: f.content_type, base64: Buffer.from(readBytes(f.path)).toString("base64") });
  const media: EngineMedia = {};
  const mode = workersAiMedia(input, caps);
  if (mode === "native-video") media.videos = [b64(input.video!)];
  else if (mode === "image" || mode === "frames") media.images = input.images.slice(0, 4).map(b64);
  return { state: input.state, questions: input.questions, media };
}

/** A fenced alternate through callEngine: the fence, then the secret-shape refusal, media limits and answer validation. */
export async function callWorkersAi(engine: Engine, input: CaseInput, caps: ModelCaps, cf: EngineCredentials, fetchImpl?: typeof fetch, readBytes?: (p: string) => Uint8Array): Promise<Answer> {
  const media = workersAiMedia(input, caps);
  const t0 = performance.now();
  let req: ReturnType<typeof buildWorkersAiRequest>;
  try {
    req = buildWorkersAiRequest(engine, input, caps, readBytes);
  } catch (e) {
    return { model: null, latency_ms: 0, error: String((e as Error)?.message ?? e).slice(0, 200), p: {}, media };
  }
  try {
    const r = await callEngine(req.state, req.questions, {
      model: engine.model, apiKey: cf.apiToken, accountId: cf.accountId, timeoutMs: TIMEOUT_MS["workers-ai"], media: req.media,
      ...(fetchImpl ? { fetchImpl } : {}),
    }, t0);
    if (!r.ok) return { model: null, latency_ms: r.latencyMs, error: describeFailure(r), p: {}, media };
    const ids = Object.keys(input.questions);
    const p = nouls(r.response.answers, ids);
    if (Object.keys(p).length !== ids.length) return { model: r.response.model, latency_ms: r.response.latency_ms, error: "shape: an answer was missing or not a noul in [0,1]", p: {}, media };
    return { model: r.response.model, latency_ms: r.response.latency_ms, error: null, p, media };
  } catch (e) {
    return { model: null, latency_ms: Math.round(performance.now() - t0), error: String((e as Error)?.message ?? e).slice(0, 200), p: {}, media };
  }
}

/** The media Assay.ask carries for a case: the one image, the native video when it fits, else the shared frames. Null for text. */
export function productionMedia(input: CaseInput, readBytes: (p: string) => Uint8Array = (p) => readFileSync(p)): { media: EngineMedia; mode: "image" | "native-video" | "frames" } | null {
  if (input.case.type === "text") return null;
  const b64 = (f: MediaFile) => ({ content_type: f.content_type, base64: Buffer.from(readBytes(f.path)).toString("base64") });
  if (input.case.type === "video" && input.video) return { media: { videos: [b64(input.video)] }, mode: "native-video" };
  return { media: { images: input.images.slice(0, 4).map(b64) }, mode: input.case.type === "image" ? "image" : "frames" };
}

/** The production engine (Clef-omni) through Assay.ask: registry, budget and ledger apply; media goes to the engine only. */
export async function callProduction(input: CaseInput, askImpl: typeof ask = ask, readBytes?: (p: string) => Uint8Array): Promise<Answer> {
  const t0 = performance.now();
  let planned: ReturnType<typeof productionMedia> = null;
  try {
    planned = productionMedia(input, readBytes);
    const mode = planned?.mode ?? "text";
    const r = await askImpl(input.state, input.questions, {
      caller: CALIBRATION_CALLER, session: "usecase-bakeoff", turn: input.case.id,
      timeoutMs: planned ? TIMEOUT_MS["workers-ai"] : TIMEOUT_MS.glance,
      ...(planned ? { media: planned.media } : {}),
    });
    const ids = Object.keys(input.questions);
    const p = nouls(r.answers, ids);
    const latency_ms = Math.round(performance.now() - t0);
    if (Object.keys(p).length !== ids.length) return { model: r.model, latency_ms, error: "shape: an answer was missing or not a noul in [0,1]", p: {}, media: mode };
    return { model: r.model, latency_ms, error: null, p, media: mode };
  } catch (e) {
    return { model: null, latency_ms: Math.round(performance.now() - t0), error: String((e as Error)?.message ?? e).slice(0, 200), p: {}, media: planned?.mode ?? "text" };
  }
}

export function opusSystemPrompt(hasMedia: boolean): string {
  return [
    "You predict how the principal would judge something his system produced. Answer each question with the probability, from 0 to 1, that the answer is yes.",
    hasMedia ? `The images to judge are attached to the user message. Look at them before answering. If no image is visible to you, reply with exactly ${IMAGE_UNAVAILABLE} and nothing else.` : "",
    'Reply with strict JSON only: one object mapping each question id to a number between 0 and 1, for example {"id": 0.42}. No prose, no code fences.',
  ].filter(Boolean).join(" ");
}

export function opusUserPrompt(input: CaseInput): string {
  const qs = Object.entries(input.questions).map(([id, q]) => `- ${id}: ${String(q.instructions)}`).join("\n");
  const frames = input.case.type === "video" ? `\n\nThe ${input.images.length} attached images are evenly spaced frames from it, in order.` : "";
  return `State:\n${input.state}${frames}\n\nQuestions:\n${qs}`;
}

/** Strict JSON probabilities for every question id, or null. Tolerates one surrounding code fence. */
export function parseOpusAnswer(text: string, ids: string[]): Record<string, number> | null {
  const body = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let obj: unknown;
  try { obj = JSON.parse(body); } catch { return null; }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  const p: Record<string, number> = {};
  for (const id of ids) {
    const v = (obj as Record<string, unknown>)[id];
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1) return null;
    p[id] = v;
  }
  return p;
}

/** ISC-22: images attach inline or the call is not made; a blind answer is retried, then counted as a failure. */
export async function callOpus(input: CaseInput, infer: (o: InferenceOptions) => Promise<InferenceResult> = inference): Promise<Answer> {
  const media = input.case.type === "text" ? "text" : input.case.type === "image" ? "image" : "frames";
  const fail = (error: string, latency_ms = 0, attempts = 0, model: string | null = null): Answer => ({ model, latency_ms, error, p: {}, media, attempts });
  if (!OPUS_LEVEL) return fail("no inference level resolves to the opus alias in models.ts");
  const imagePaths = input.images.map((f) => f.path);
  if (input.case.type !== "text") {
    if (!imagePaths.length) return fail("no media to attach");
    try {
      const plan = planImageInput(imagePaths);
      if (plan.viaRead.length) return fail(`would not attach inline: ${plan.viaRead.map((p) => basename(p)).join(", ")}`);
    } catch (e) {
      return fail(`image unreadable: ${String((e as Error)?.message ?? e).slice(0, 160)}`);
    }
  }
  const ids = Object.keys(input.questions);
  const t0 = performance.now();
  for (let attempt = 1; ; attempt++) {
    let r: InferenceResult;
    try {
      r = await infer({
        systemPrompt: opusSystemPrompt(imagePaths.length > 0),
        userPrompt: opusUserPrompt(input),
        level: OPUS_LEVEL,
        vendor: "anthropic",
        allowVendorFallback: false,
        timeout: TIMEOUT_MS.inference,
        ...(imagePaths.length ? { imagePaths } : {}),
      });
    } catch (e) {
      // A throw here would reject the whole pool and lose every row of a paid run; it is one failed case.
      return fail(`threw: ${String((e as Error)?.message ?? e).slice(0, 160)}`, Math.round(performance.now() - t0), attempt);
    }
    const latency_ms = Math.round(performance.now() - t0);
    const model = typeof r?.executedModel === "string" && r.executedModel ? r.executedModel : null;
    if (!r || typeof r.success !== "boolean") return fail("malformed inference result", latency_ms, attempt);
    // Never echo r.output on failure: it may carry request content.
    if (!r.success) return fail(String(r.error ?? "call failed").slice(0, 200), latency_ms, attempt, model);
    if (r.vendor !== undefined && r.vendor !== "anthropic") return fail(`answered by vendor ${r.vendor}, refused`, latency_ms, attempt, model);
    if (model && !model.includes("opus")) return fail(`ran ${model}, not opus`, latency_ms, attempt, model);
    const text = typeof r.output === "string" ? r.output.trim() : "";
    if (text === IMAGE_UNAVAILABLE) {
      if (attempt < IMAGE_UNAVAILABLE_ATTEMPTS) continue;
      return fail(`blind: the image did not reach the model (${attempt} attempts)`, latency_ms, attempt, model);
    }
    const p = parseOpusAnswer(text, ids);
    if (!p) return fail("shape: answer was not strict JSON probabilities for every question", latency_ms, attempt, model);
    return { model: model ?? modelForEffort(OPUS_LEVEL), latency_ms, error: null, p, media, attempts: attempt };
  }
}

export type CallDeps = {
  workersAi: (engine: Engine, input: CaseInput) => Promise<Answer>;
  production: (input: CaseInput) => Promise<Answer>;
  opus: (input: CaseInput) => Promise<Answer>;
};

async function answer(job: Job, deps: CallDeps): Promise<Answer> {
  const { engine, input } = job;
  if (input.prep_error) return { model: null, latency_ms: 0, error: input.prep_error, p: {}, media: input.case.type };
  if (engine.kind === "glance") return deps.production(input);
  if (engine.kind === "workers-ai") return deps.workersAi(engine, input);
  return deps.opus(input);
}

/** Runs every job: Opus in its own pool of 4, the rest in a pool of 8, both at once and each shuffled. */
export async function runJobs(jobs: Job[], deps: CallDeps): Promise<Row[]> {
  const out: Row[] = [];
  const pool = async (mine: Job[], width: number) => {
    const queue = [...mine];
    for (let i = queue.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [queue[i], queue[j]] = [queue[j]!, queue[i]!]; }
    let next = 0;
    const worker = async () => {
      while (next < queue.length) {
        const job = queue[next++]!;
        const a = await answer(job, deps);
        const c = job.input.case;
        out.push({ engine: job.engine.id, id: c.id, type: c.type as CaseType, label: c.label, public: c.public, ...a });
      }
    };
    await Promise.all(Array.from({ length: Math.min(width, Math.max(1, queue.length)) }, worker));
  };
  await Promise.all([
    pool(jobs.filter((j) => j.engine.kind === "inference"), POOL.inference),
    pool(jobs.filter((j) => j.engine.kind !== "inference"), POOL["workers-ai"]),
  ]);
  return out;
}

// ── Scoring (pure) ──────────────────────────────────────────────────────────

export type CaseMeta = { id: string; type: CaseType; label: "accept" | "reject"; public: boolean };
export type CellStatus = "scored" | "fenced" | "not-run";
export type Cell = {
  type: CaseType; engine: EngineId; status: CellStatus; model: string | null;
  routed: number; answered: number; failed: number; thin: boolean;
  pooled: Metrics | null; questions: Record<string, Metrics> | null;
  latency: { median: number; p95: number } | null;
};
export type TypeCounts = { accept: number; reject: number; thin: boolean };
export type RunSummary = { ts: string; run_id: string; raw: string; cut: number; cases: number; types: Partial<Record<CaseType, TypeCounts>>; cells: Cell[]; pairs: number; rows: number };

export function isThin(accept: number, reject: number): boolean {
  return accept < THIN_BELOW || reject < THIN_BELOW;
}

export function typeCounts(cases: CaseMeta[], type: CaseType): TypeCounts {
  const mine = cases.filter((c) => c.type === type);
  const accept = mine.filter((c) => c.label === "accept").length;
  const reject = mine.length - accept;
  return { accept, reject, thin: isThin(accept, reject) };
}

function percentile(xs: number[], q: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))]! : NaN;
}

function pairsFor(rows: Row[], ids: string[]) {
  return rows.filter((r) => !r.error).flatMap((r) => ids.filter((q) => typeof r.p[q] === "number").map((q) => {
    const p = r.p[q]!;
    return { p, y: r.label === "accept", yes: p >= CUT };
  }));
}

/** One cell per type × engine. A cell with no routable or no run case carries no numbers at all (ISC-27). */
export function summarize(rows: Row[], cases: CaseMeta[], engines: Engine[], meta: { run_id: string; ts: string; raw: string }): RunSummary {
  const types = CASE_TYPES.filter((t) => cases.some((c) => c.type === t));
  const cells: Cell[] = types.flatMap((type) => engines.map((e): Cell => {
    const empty = { type, engine: e.id, model: null, answered: 0, failed: 0, pooled: null, questions: null, latency: null };
    const routed = cases.filter((c) => c.type === type && routes(e.id, c));
    if (!routed.length) return { ...empty, status: "fenced", routed: 0, thin: false };
    const mine = rows.filter((r) => r.engine === e.id && r.type === type);
    if (!mine.length) return { ...empty, status: "not-run", routed: routed.length, thin: false };
    const ok = mine.filter((r) => !r.error);
    const ids = Object.keys(QUESTIONS[type]);
    const lat = ok.map((r) => r.latency_ms);
    const acc = ok.filter((r) => r.label === "accept").length;
    return {
      type, engine: e.id, status: "scored",
      model: [...new Set(ok.map((r) => r.model).filter(Boolean))].join(",") || null,
      routed: routed.length, answered: ok.length, failed: mine.length - ok.length,
      thin: isThin(acc, ok.length - acc),
      pooled: ok.length ? metrics(pairsFor(mine, ids)) : null,
      questions: ok.length ? Object.fromEntries(ids.map((q) => [q, metrics(pairsFor(mine, [q]))])) : null,
      latency: lat.length ? { median: percentile(lat, 0.5), p95: percentile(lat, 0.95) } : null,
    };
  }));
  const pairs = engines.reduce((n, e) => n + cases.filter((c) => routes(e.id, c)).length, 0);
  return {
    ts: meta.ts, run_id: meta.run_id, raw: meta.raw, cut: CUT, cases: cases.length,
    types: Object.fromEntries(types.map((t) => [t, typeCounts(cases, t)])),
    cells, pairs, rows: rows.length,
  };
}

// ── Output ──────────────────────────────────────────────────────────────────

/** NaN is stored as null in JSON history, so both read as n/a. */
const f3 = (x: number | null | undefined) => (typeof x !== "number" || Number.isNaN(x) ? "  n/a" : x.toFixed(3));

export function renderCell(c: Cell): string {
  const head = c.engine.padEnd(11);
  if (c.status === "fenced") return `${head} fenced: no public cases of this type may go to Cloudflare`;
  if (c.status === "not-run") return `${head} not run (${c.routed} routable)`;
  const m = c.pooled;
  const lat = c.latency ? `${String(c.latency.median).padStart(6)}ms ${String(c.latency.p95).padStart(6)}ms` : "     n/a      n/a";
  return `${head} ${String(c.answered).padStart(8)} ${String(c.failed).padStart(6)}  ${f3(m?.accuracy)}  ${f3(m?.auc)}  ${f3(m?.brier)}  ${f3(m?.ece)}  ${lat}${c.thin ? "  too few to conclude" : ""}${c.model ? `  ${c.model}` : ""}`;
}

export function renderSummary(s: RunSummary): string {
  const lines = [`Glance use-case bake-off ${s.ts} · ${s.cases} cases · cut ${s.cut} · ${s.rows} rows for ${s.pairs} routed pairs`];
  for (const type of CASE_TYPES) {
    const counts = s.types[type];
    if (!counts) continue;
    const cells = s.cells.filter((c) => c.type === type);
    lines.push("", `${type.toUpperCase()} · ${counts.accept} accept / ${counts.reject} reject${counts.thin ? " · TOO FEW TO CONCLUDE" : ""}`);
    lines.push("engine      answered failed  acc    auc    brier  ece     median      p95");
    for (const c of cells) lines.push(renderCell(c));
    const scored = cells.filter((c) => c.status === "scored" && c.questions);
    if (!scored.length) continue;
    lines.push("per question (acc / auc / brier / ece)");
    for (const q of Object.keys(QUESTIONS[type])) {
      lines.push(`  ${q.padEnd(14)} ` + cells.map((c) => {
        const m = c.questions?.[q];
        return m ? `${c.engine} ${f3(m.accuracy)}/${f3(m.auc)}/${f3(m.brier)}/${f3(m.ece)}` : `${c.engine} -`;
      }).join("   "));
    }
  }
  if (s.rows !== s.pairs) lines.push("", `WARNING: ${s.rows} raw rows for ${s.pairs} routed pairs`);
  return lines.join("\n");
}

// ── Persistence ─────────────────────────────────────────────────────────────

type RawMeta = { meta: { run_id: string; ts: string; engines: Engine[]; cases: CaseMeta[] } };

function latestRaw(): string {
  const dir = rawDir();
  invariant(existsSync(dir), "UseCaseBakeoff: no recorded runs yet — run `UseCaseBakeoff.ts run` first");
  const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort();
  invariant(files.length > 0, "UseCaseBakeoff: no recorded runs yet");
  return join(dir, files[files.length - 1]!);
}

export function readRaw(path: string): { meta: RawMeta["meta"]; rows: Row[] } {
  const lines = readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as unknown);
  const head = lines[0] as RawMeta | undefined;
  invariant(!!head && typeof head === "object" && "meta" in head, `UseCaseBakeoff: ${path} has no meta line`);
  return { meta: head.meta, rows: lines.slice(1) as Row[] };
}

function caseMeta(c: CorpusCase): CaseMeta {
  return { id: c.id, type: c.type as CaseType, label: c.label, public: c.public };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

export type RunArgs = { types: CaseType[]; engines: Engine[]; limit?: number; corpus?: string; json: boolean };

export function parseRunArgs(argv: string[]): RunArgs {
  const value = (flag: string) => { const i = argv.indexOf(flag); return i < 0 ? undefined : argv[i + 1]; };
  const list = (flag: string) => value(flag)?.split(",").map((x) => x.trim()).filter(Boolean);
  const types = list("--types") ?? [...CASE_TYPES];
  for (const t of types) if (!CASE_TYPES.includes(t as CaseType)) throw new Error(`UseCaseBakeoff: unknown type ${t} (text, image, video)`);
  const ids = list("--engines") ?? ENGINES.map((e) => e.id);
  const engines = ids.map((id) => {
    const e = ENGINES.find((x) => x.id === id);
    if (!e) throw new Error(`UseCaseBakeoff: unknown engine ${id} (${ENGINES.map((x) => x.id).join(", ")})`);
    return e;
  });
  const rawLimit = value("--limit");
  const limit = rawLimit === undefined ? undefined : Number(rawLimit);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) throw new Error(`UseCaseBakeoff: --limit must be a positive integer`);
  return { types: types as CaseType[], engines, limit, corpus: value("--corpus"), json: argv.includes("--json") };
}

async function runCommand(args: RunArgs): Promise<number> {
  const cases = selectCases(loadCorpus(args.corpus), args.types, args.limit);
  if (!cases.length) throw new Error("UseCaseBakeoff: no cases of the requested types in the corpus");
  const ts = new Date().toISOString();
  const run_id = `${ts.slice(0, 19).replace(/:/g, "")}Z`;
  const workDir = mkdtempSync(join(tmpdir(), "glance-usecase-"));
  try {
    // One directory per case: prepared media is named from the artifact's basename, so two
    // artifacts sharing a name in different folders would otherwise overwrite each other's files.
    const inputs = cases.map((c, i) => {
      const caseDir = join(workDir, String(i));
      mkdirSync(caseDir);
      return buildInput(c, caseDir, REAL_MEDIA);
    });
    const jobs = planJobs(inputs, args.engines);
    const needsCf = jobs.some((j) => j.engine.kind === "workers-ai");
    const cf = needsCf ? cloudflare() : null;
    const caps = new Map<string, ModelCaps>();
    if (cf) for (const e of args.engines.filter((x) => x.kind === "workers-ai")) caps.set(e.id, await fetchCaps(e.model, cf));
    const rows = await runJobs(jobs, {
      workersAi: (engine, input) => callWorkersAi(engine, input, caps.get(engine.id)!, cf!),
      production: (input) => callProduction(input),
      opus: (input) => callOpus(input),
    });
    invariant(rows.length === jobs.length, `UseCaseBakeoff: expected ${jobs.length} rows, got ${rows.length}`);
    invariant(rows.every((r) => args.engines.some((e) => e.id === r.engine) && routes(r.engine, r)), "UseCaseBakeoff: a row exists for an unroutable pair");
    mkdirSync(rawDir(), { recursive: true });
    const raw = join(rawDir(), `${run_id}.jsonl`);
    const meta: RawMeta = { meta: { run_id, ts, engines: args.engines, cases: cases.map(caseMeta) } };
    writeFileSync(raw, [meta, ...rows].map((r) => JSON.stringify(r)).join("\n") + "\n");
    const s = summarize(rows, meta.meta.cases, args.engines, { run_id, ts, raw });
    invariant(s.rows === s.pairs, `UseCaseBakeoff: ${s.rows} rows for ${s.pairs} routed pairs`);
    appendFileSync(historyPath(), JSON.stringify(s) + "\n");
    if (args.json) {
      console.log(JSON.stringify({ ok: true, run_id, raw, types: s.types, cells: s.cells.map((c) => ({ type: c.type, engine: c.engine, status: c.status, model: c.model, answered: c.answered, failed: c.failed, thin: c.thin, accuracy: c.pooled?.accuracy ?? null, auc: c.pooled?.auc ?? null, brier: c.pooled?.brier ?? null, ece: c.pooled?.ece ?? null, median_ms: c.latency?.median ?? null, p95_ms: c.latency?.p95 ?? null })) }));
    } else console.log(renderSummary(s));
    return s.cells.some((c) => c.status === "scored" && c.answered === 0) ? 1 : 0;
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

export async function main(argv: string[]): Promise<number> {
  const cmd = argv[0];
  if (cmd === "run") return runCommand(parseRunArgs(argv));
  if (cmd === "report") {
    const i = argv.indexOf("--file");
    const path = i < 0 ? latestRaw() : argv[i + 1]!;
    const { meta, rows } = readRaw(path);
    console.log(renderSummary(summarize(rows, meta.cases, meta.engines, { run_id: meta.run_id, ts: meta.ts, raw: path })));
    return 0;
  }
  if (cmd === "history") {
    if (!existsSync(historyPath())) { console.log("no runs yet"); return 0; }
    for (const line of readFileSync(historyPath(), "utf8").trim().split("\n").filter(Boolean)) {
      const s = JSON.parse(line) as RunSummary;
      const cells = s.cells.filter((c) => c.status === "scored" && c.pooled).map((c) => `${c.type}/${c.engine} auc ${f3(c.pooled!.auc)} brier ${f3(c.pooled!.brier)}${c.thin ? "*" : ""}`);
      console.log(`${s.ts.slice(0, 16)}  ${s.cases} cases  ${cells.join(" · ")}`);
    }
    return 0;
  }
  console.log("usage: bun LIFEOS/ASSAY/UseCaseBakeoff.ts run [--types text,image,video] [--engines clef-omni,clef,clef-flash,opus] [--limit N] [--corpus PATH] [--json] | report [--file PATH] | history");
  return cmd ? 1 : 0;
}

if (import.meta.main) {
  main(process.argv.slice(2)).then((code) => process.exit(code)).catch((e) => { console.error(String((e as Error)?.message ?? e)); process.exit(1); });
}
