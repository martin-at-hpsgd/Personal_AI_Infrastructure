/**
 * VideoJudge — Assay's video judge transport. A caller hands it a video path, a prompt and a response schema; it uploads
 * the video through the Gemini Files API, waits for it to go ACTIVE, runs `generateContent` with the schema, parses the
 * JSON, deletes the upload, and returns the parsed answer with the model id Google reports it executed.
 *
 * Sibling of JudgeCall.ts (text and image judges). What a judge asks and how it reads the answer (a PII verdict, a
 * quality score, a meaning check) stays with the caller; what is shared lives here: the Google egress check, the
 * inference kill switch, the key, the upload, the request body and the cleanup (AssaySystem.md § One eval system).
 * Model ids come from CROSS_VENDOR in models.ts, never pinned here.
 *
 * Chunking is not here. A caller with a video over the 2 GiB Files API limit splits it first and calls `judgeVideo` per
 * part (VideoPiiGate does), since how to split and how to merge the answers is the caller's decision.
 */
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { inferenceDisabledBy } from '../TOOLS/Inference';
import { CROSS_VENDOR } from '../TOOLS/models';
import { getClaudeDir } from '../TOOLS/Paths';
import { assertEvaluatorVendor, type MaterialClass } from '../TOOLS/lib/EvaluatorEgress';
import { vendorOf } from './JudgeCall';

export const VIDEO_JUDGE_API = 'https://generativelanguage.googleapis.com';

// Per-request bounds for the short Files API calls (the upload body and generateContent keep their own long signals).
const START_TIMEOUT_MS = 2 * 60_000;   // upload start: one small POST that returns the upload URL
const UPLOAD_TIMEOUT_MS = 60 * 60_000; // the resumable upload body
const POLL_TIMEOUT_MS = 30_000;        // files.get status poll
const DELETE_TIMEOUT_MS = 30_000;      // files.delete cleanup
const GENERATE_TIMEOUT_MS = 30 * 60_000;
const ACTIVE_CEILING_MS = 30 * 60_000;

export type VideoJudgeDeps = {
  fetch?: typeof fetch;
  /** Override the key (tests). Default: GOOGLE_API_KEY from the install's .env, then the environment. */
  key?: string;
  /** Override the poll sleep (tests). */
  sleep?: (ms: number) => Promise<void>;
};

export type VideoJudgeOpts = {
  /** What the judge is asked to look for. Sent as the text part beside the video. */
  prompt: string;
  /** JSON response schema (Gemini `responseSchema`). The answer is always requested as application/json. */
  schema: Record<string, unknown>;
  /** A Google model id. Default CROSS_VENDOR.gemini. */
  model?: string;
  /** Request MEDIA_RESOLUTION_LOW: cheaper per second of video, may miss small print. */
  lowRes?: boolean;
  /** Default 0. */
  temperature?: number;
  /** The upload's display name in the Files API. Default: the file's base name. */
  displayName?: string;
  /** Default video/mp4. */
  mimeType?: string;
  /** Egress caller label and material class, as `gemini()` in JudgeCall.ts takes them. Default private. */
  caller?: string;
  publicMaterial?: boolean;
  /** Called with the Files API name once the upload exists, so a caller running several parts can clean up on its own failure. */
  onUploaded?: (fileName: string) => void;
};

export type VideoJudgeResult = {
  /** The model's answer, JSON-parsed. The caller validates its shape. */
  parsed: unknown;
  /** The raw answer text. */
  text: string;
  usage: { totalTokenCount?: number } | null;
  /** The model id Google reports it ran (`modelVersion`). Absent when the response did not say; never the requested id. */
  executedModel?: string;
  requestedModel: string;
  /** Whether the uploaded file was deleted from the Files API after the call. */
  deleted: boolean;
};

/** The key, read the way JudgeCall reads it: the install's .env first, then the environment. */
export function videoJudgeGoogleKey(): string {
  try {
    for (const line of readFileSync(join(getClaudeDir(), '.env'), 'utf-8').split('\n')) {
      const m = line.match(/^GOOGLE_API_KEY=(.*)$/);
      if (m) return m[1].trim().replace(/^["']|["']$/g, '');
    }
  } catch { /* fall through */ }
  return process.env.GOOGLE_API_KEY ?? '';
}

/**
 * Everything that must hold before a video leaves the machine: Google egress approved for the material class, inference
 * not disabled, a key present, a Google model. Returns the key. Callers that do work before the first upload (probing,
 * splitting) call this first so a missing key fails before that work.
 */
export function assertVideoJudgeReady(o: { model?: string; caller?: string; publicMaterial?: boolean; key?: string } = {}): string {
  const material: MaterialClass = o.publicMaterial ? 'public' : 'private';
  assertEvaluatorVendor('google', o.caller ?? 'VideoJudge', material);
  const disabled = inferenceDisabledBy();
  if (disabled) throw new Error(`inference disabled in this context (LIFEOS_INFERENCE_DISABLED=${disabled}); this probe must be deterministic`);
  const model = o.model ?? CROSS_VENDOR.gemini;
  if (vendorOf(model) !== 'google') throw new Error(`VideoJudge runs Google models only; "${model}" is not one`);
  const key = o.key ?? videoJudgeGoogleKey();
  if (!key) throw new Error('GOOGLE_API_KEY missing from ~/.claude/.env');
  return key;
}

/** The generateContent request body for one uploaded video. Pure. */
export function buildVideoJudgeRequest(fileUri: string, o: Pick<VideoJudgeOpts, 'prompt' | 'schema' | 'lowRes' | 'temperature' | 'mimeType'>): { contents: unknown[]; generationConfig: Record<string, unknown> } {
  const generationConfig: Record<string, unknown> = { temperature: o.temperature ?? 0, responseMimeType: 'application/json', responseSchema: o.schema };
  if (o.lowRes) generationConfig.mediaResolution = 'MEDIA_RESOLUTION_LOW';
  return {
    contents: [{ role: 'user', parts: [{ fileData: { mimeType: o.mimeType ?? 'video/mp4', fileUri } }, { text: o.prompt }] }],
    generationConfig,
  };
}

type GenerateResponse = { modelVersion?: unknown; usageMetadata?: { totalTokenCount?: number }; error?: { message?: string }; candidates?: { content?: { parts?: { text?: string }[] } }[] };

/** The model's answer from a generateContent response: text, JSON-parsed, usage, and the executed model when reported. Throws on non-JSON. Pure. */
export function parseVideoJudgeResponse(data: GenerateResponse): { text: string; parsed: unknown; usage: VideoJudgeResult['usage']; executedModel?: string } {
  const text = (data.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('').trim();
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new Error(`model returned non-JSON: ${text.slice(0, 200)}`); }
  const executedModel = typeof data.modelVersion === 'string' && data.modelVersion.trim() ? data.modelVersion : undefined;
  return { text, parsed, usage: data.usageMetadata ?? null, ...(executedModel ? { executedModel } : {}) };
}

export async function uploadVideo(path: string, displayName: string, key: string, o: { mimeType?: string; fetch?: typeof fetch } = {}): Promise<{ name: string; uri: string }> {
  const f = o.fetch ?? fetch;
  const H = { 'x-goog-api-key': key };
  const size = statSync(path).size;
  const start = await f(`${VIDEO_JUDGE_API}/upload/v1beta/files`, {
    method: 'POST',
    headers: {
      ...H,
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(size),
      'X-Goog-Upload-Header-Content-Type': o.mimeType ?? 'video/mp4',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ file: { display_name: displayName } }),
    signal: AbortSignal.timeout(START_TIMEOUT_MS),
  });
  if (!start.ok) throw new Error(`upload start HTTP ${start.status}: ${await start.text()}`);
  const uploadUrl = start.headers.get('x-goog-upload-url');
  if (!uploadUrl) throw new Error('upload start returned no x-goog-upload-url');

  const up = await f(uploadUrl, {
    method: 'POST',
    headers: { ...H, 'Content-Length': String(size), 'X-Goog-Upload-Offset': '0', 'X-Goog-Upload-Command': 'upload, finalize' },
    body: Bun.file(path),
    signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    timeout: false, // Bun aborts any fetch at 300s by default; the signal is the real bound
  } as RequestInit);
  if (!up.ok) throw new Error(`upload HTTP ${up.status}: ${await up.text()}`);
  const info = await up.json() as { file?: { name?: string; uri?: string } };
  const name = info?.file?.name, uri = info?.file?.uri;
  if (!name || !uri) throw new Error(`upload returned no file name/uri: ${JSON.stringify(info).slice(0, 300)}`);
  return { name, uri };
}

export async function waitVideoActive(name: string, key: string, o: { ceilingMs?: number; fetch?: typeof fetch; sleep?: (ms: number) => Promise<void> } = {}): Promise<void> {
  const f = o.fetch ?? fetch, sleep = o.sleep ?? ((ms: number) => Bun.sleep(ms));
  const ceilingMs = o.ceilingMs ?? ACTIVE_CEILING_MS;
  const t0 = Date.now();
  while (Date.now() - t0 < ceilingMs) {
    const r = await f(`${VIDEO_JUDGE_API}/v1beta/${name}`, { headers: { 'x-goog-api-key': key }, signal: AbortSignal.timeout(POLL_TIMEOUT_MS) });
    if (!r.ok) throw new Error(`files.get HTTP ${r.status}: ${await r.text()}`);
    const file = await r.json() as { state?: string; error?: unknown };
    if (file.state === 'ACTIVE') return;
    if (file.state === 'FAILED') throw new Error(`file processing FAILED: ${JSON.stringify(file.error ?? file).slice(0, 300)}`);
    await sleep(5000);
  }
  throw new Error(`file ${name} not ACTIVE after ${ceilingMs / 1000}s`);
}

/** Delete an upload from Google's store. Never throws; false means it could not be confirmed deleted. */
export async function deleteVideoFile(name: string, key: string, o: { fetch?: typeof fetch } = {}): Promise<boolean> {
  try {
    const r = await (o.fetch ?? fetch)(`${VIDEO_JUDGE_API}/v1beta/${name}`, { method: 'DELETE', headers: { 'x-goog-api-key': key }, signal: AbortSignal.timeout(DELETE_TIMEOUT_MS) });
    return r.ok;
  } catch { return false; }
}

/**
 * One video judge call: upload, wait until ACTIVE, generateContent with the caller's prompt and schema, parse, delete.
 * The upload is deleted whether the call succeeds or fails. Throws on egress refusal, a disabled context, a missing key,
 * an API error or a non-JSON answer; the caller decides what the parsed answer means.
 */
export async function judgeVideo(file: string, opts: VideoJudgeOpts, deps: VideoJudgeDeps = {}): Promise<VideoJudgeResult> {
  const model = opts.model ?? CROSS_VENDOR.gemini;
  const key = assertVideoJudgeReady({ model, caller: opts.caller, publicMaterial: opts.publicMaterial, key: deps.key });
  const f = deps.fetch ?? fetch;
  const mimeType = opts.mimeType ?? 'video/mp4';
  let uploaded: string | undefined;
  try {
    const up = await uploadVideo(file, opts.displayName ?? file.split('/').pop() ?? 'video', key, { mimeType, fetch: f });
    uploaded = up.name;
    opts.onUploaded?.(up.name);
    await waitVideoActive(up.name, key, { fetch: f, sleep: deps.sleep });

    const r = await f(`${VIDEO_JUDGE_API}/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify(buildVideoJudgeRequest(up.uri, { ...opts, mimeType })),
      signal: AbortSignal.timeout(GENERATE_TIMEOUT_MS),
      timeout: false, // Bun aborts any fetch at 300s by default; the signal is the real bound
    } as RequestInit);
    const data = await r.json() as GenerateResponse;
    if (!r.ok || data.error) throw new Error(data.error?.message || `generateContent HTTP ${r.status}`);
    const answer = parseVideoJudgeResponse(data);
    const deleted = await deleteVideoFile(up.name, key, { fetch: f });
    uploaded = undefined;
    return { ...answer, requestedModel: model, deleted };
  } catch (e) {
    // Never leave the principal's video in Google's store on a failed run.
    if (uploaded) await deleteVideoFile(uploaded, key, { fetch: f });
    throw e;
  }
}
