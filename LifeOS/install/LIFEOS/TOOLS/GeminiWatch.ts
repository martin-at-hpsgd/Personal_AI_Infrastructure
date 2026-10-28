#!/usr/bin/env bun
/**
 * GeminiWatch — watch and listen to a PUBLIC YouTube video with Gemini and return
 * a near-verbatim transcript plus what is on screen and what the framing leaves out.
 *
 * This is the watch path the Video-bearing content rule names (OPERATIONAL_PREFERENCES
 * § Video-bearing content), for inputs that are already a public YouTube URL: Gemini
 * reads the URL directly, nothing is downloaded or uploaded. A local video file (an
 * X post's video, a downloaded clip) goes through watchFile, which uploads it with the same
 * Files API pattern as VideoPiiGate and deletes the upload afterwards.
 *
 * Harvest uses it as the fallback when `fabric -y` cannot get captions for a video.
 *
 * Data class: any but secret values (Google is a trusted vendor since 2026-10-10). For a URL, only the URL leaves.
 *
 * Usage:  bun LIFEOS/TOOLS/GeminiWatch.ts <youtube-url> [--out <file>]
 * Env:    GOOGLE_API_KEY from ~/.claude/.env; the key rides the x-goog-api-key header only.
 */
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CROSS_VENDOR } from "./models";
import { getClaudeDir } from "./Paths";

const API = "https://generativelanguage.googleapis.com";
// A 94-minute talk measured 516k video tokens at low resolution; default resolution
// would not fit a long video in the context window.
const TIMEOUT_MS = 30 * 60_000;
// Per-request bounds for the short Files API calls (the upload body and the watch pass keep TIMEOUT_MS).
const START_TIMEOUT_MS = 2 * 60_000;   // upload start: one small POST that returns the upload URL
const POLL_TIMEOUT_MS = 30_000;        // files.get status poll
const DELETE_TIMEOUT_MS = 30_000;      // files.delete cleanup
// Measured on that talk: 516,071 video tokens for 5,671 seconds at low resolution.
const LOW_RES_VIDEO_TOKENS_PER_SEC = 91;
// Speech runs about 900 characters a minute; a pass under a third of that for the video's
// length summarized instead of transcribing. Same URL, same prompt, temperature 0: 116k
// characters on one call and 10k on the next (2026-09-29), so one retry is worth its cost.
const MIN_CHARS_PER_MINUTE = 300;

const PROMPT = `Watch and listen to this entire video. Produce:

1. A near-verbatim transcript of the whole video, with speaker labels and [mm:ss] timestamps every paragraph. Do not summarize or skip sections; cover start to finish.
2. A VISUALS section: anything shown on screen (demos, slides, code, UIs) that the speech does not capture, with timestamps.
3. A CONTENT BEYOND THE FRAMING section: concrete claims, product details, techniques, numbers, and opinions stated in the video that a title or description would not reveal.

Plain text output.`;

function loadKey(): string {
  try {
    for (const line of readFileSync(join(getClaudeDir(), ".env"), "utf-8").split("\n")) {
      const m = line.match(/^GOOGLE_API_KEY=(.*)$/);
      if (m) return m[1].trim().replace(/^["']|["']$/g, "");
    }
  } catch { /* fall through to process.env */ }
  return process.env.GOOGLE_API_KEY ?? "";
}

export function isYoutubeUrl(url: string): boolean {
  try {
    const h = new URL(url).hostname.replace(/^www\.|^m\./, "");
    return h === "youtube.com" || h === "youtu.be";
  } catch {
    return false;
  }
}

export type WatchResult = { text: string; model: string; videoTokens: number | null; finishReason: string | null };

/** True when a pass is too short to be a transcript of a video this long (unknown length never counts as short). */
export function looksSummarized(res: Pick<WatchResult, "text" | "videoTokens">): boolean {
  if (!res.videoTokens) return false;
  const minutes = res.videoTokens / LOW_RES_VIDEO_TOKENS_PER_SEC / 60;
  return res.text.length < minutes * MIN_CHARS_PER_MINUTE;
}

/**
 * Watch one public YouTube video, retrying once when the first pass summarized, and
 * return the longer pass. Throws on a missing key, an API error, or an empty answer.
 */
export async function watchYoutube(url: string): Promise<WatchResult> {
  if (!isYoutubeUrl(url)) throw new Error(`not a YouTube URL: ${url}`);
  const key = loadKey();
  if (!key) throw new Error("GOOGLE_API_KEY missing from ~/.claude/.env");
  return watchWithRetry({ fileUri: url }, key);
}

/**
 * Watch one local video file (an X post's video, a downloaded clip, a private recording)
 * through the Files API: upload, wait for ACTIVE, watch, and always delete the upload.
 * Same upload pattern as VideoPiiGate. Same data class as the header: a private recording
 * may go (Google is a trusted vendor), but never a file that shows secret values.
 */
export async function watchFile(file: string, mimeType = "video/mp4"): Promise<WatchResult> {
  const key = loadKey();
  if (!key) throw new Error("GOOGLE_API_KEY missing from ~/.claude/.env");
  const H = { "x-goog-api-key": key };
  const size = statSync(file).size;
  const start = await fetch(`${API}/upload/v1beta/files`, {
    method: "POST",
    headers: {
      ...H,
      "X-Goog-Upload-Protocol": "resumable",
      "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": String(size),
      "X-Goog-Upload-Header-Content-Type": mimeType,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ file: { display_name: "gemini-watch" } }),
    signal: AbortSignal.timeout(START_TIMEOUT_MS),
  });
  const uploadUrl = start.headers.get("x-goog-upload-url");
  if (!start.ok || !uploadUrl) throw new Error(`Gemini upload start failed: HTTP ${start.status}`);
  const up = await fetch(uploadUrl, {
    method: "POST",
    headers: { ...H, "Content-Length": String(size), "X-Goog-Upload-Offset": "0", "X-Goog-Upload-Command": "upload, finalize" },
    body: Bun.file(file),
    signal: AbortSignal.timeout(TIMEOUT_MS),
    timeout: false,
  } as RequestInit);
  const info = (await up.json()) as any;
  const name: string | undefined = info?.file?.name;
  const uri: string | undefined = info?.file?.uri;
  if (!up.ok || !name || !uri) throw new Error(`Gemini upload failed: HTTP ${up.status}`);
  try {
    const t0 = Date.now();
    for (;;) {
      const f = (await (await fetch(`${API}/v1beta/${name}`, { headers: H, signal: AbortSignal.timeout(POLL_TIMEOUT_MS) })).json()) as any;
      if (f.state === "ACTIVE") break;
      if (f.state === "FAILED") throw new Error("Gemini file processing FAILED");
      if (Date.now() - t0 > TIMEOUT_MS) throw new Error(`Gemini file not ACTIVE after ${TIMEOUT_MS / 1000}s`);
      await Bun.sleep(3000);
    }
    return await watchWithRetry({ mimeType, fileUri: uri }, key);
  } finally {
    await fetch(`${API}/v1beta/${name}`, { method: "DELETE", headers: H, signal: AbortSignal.timeout(DELETE_TIMEOUT_MS) }).catch(() => {});
  }
}

async function watchWithRetry(fileData: { fileUri: string; mimeType?: string }, key: string): Promise<WatchResult> {
  const first = await watchOnce(fileData, key);
  if (!looksSummarized(first)) return first;
  console.error(`GeminiWatch: ${first.text.length} chars looks summarized for ${first.videoTokens} video tokens, retrying once`);
  const second = await watchOnce(fileData, key);
  return second.text.length > first.text.length ? second : first;
}

async function watchOnce(fileData: { fileUri: string; mimeType?: string }, key: string): Promise<WatchResult> {
  const model = CROSS_VENDOR.gemini;
  const r = await fetch(`${API}/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ fileData }, { text: PROMPT }] }],
      generationConfig: { temperature: 0, mediaResolution: "MEDIA_RESOLUTION_LOW", maxOutputTokens: 65536 },
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
    // Bun's fetch aborts on its own at about five minutes unless told not to, and a
    // long video's watch pass takes longer than that; the signal above is the real bound.
    timeout: false,
  } as RequestInit);
  const data = (await r.json()) as any;
  if (!r.ok || data.error) throw new Error(`Gemini watch failed: ${data.error?.message ?? `HTTP ${r.status}`}`);
  const cand = data.candidates?.[0];
  const text = (cand?.content?.parts ?? []).map((p: any) => p.text ?? "").join("").trim();
  if (!text) throw new Error(`Gemini watch returned no text (finish: ${cand?.finishReason ?? "none"})`);
  const video = (data.usageMetadata?.promptTokensDetails ?? []).find((d: any) => d.modality === "VIDEO");
  return { text, model, videoTokens: video?.tokenCount ?? null, finishReason: cand?.finishReason ?? null };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const url = args.find((a) => !a.startsWith("--"));
  const outIdx = args.indexOf("--out");
  const out = outIdx >= 0 ? args[outIdx + 1] : null;
  if (!url) {
    console.error("usage: bun LIFEOS/TOOLS/GeminiWatch.ts <youtube-url> [--out <file>]");
    process.exit(2);
  }
  try {
    const res = await watchYoutube(url);
    if (out) writeFileSync(out, res.text);
    else process.stdout.write(res.text + "\n");
    console.error(JSON.stringify({ model: res.model, chars: res.text.length, videoTokens: res.videoTokens, finish: res.finishReason }));
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}
