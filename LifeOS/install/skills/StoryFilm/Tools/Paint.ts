/**
 * Paint.ts — one image call, shared by Characters.ts and Shots.ts.
 *
 * Talks to the configured image lane (models.ts CROSS_VENDOR.geminiImage) with reference images
 * attached for character and style consistency. Every output is keyed by a content hash of the
 * prompt, the reference image bytes, the aspect and the model, so a repaint happens only when one
 * of those changed. `checkImage` is the non-degenerate gate: right aspect, real pixel variance.
 */
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GoogleGenAI } from "@google/genai";
import { CROSS_VENDOR } from "../../../LIFEOS/TOOLS/models.ts";
import { getEnvPath } from "../../../LIFEOS/TOOLS/Paths.ts";
import { invariant } from "../../../LIFEOS/TOOLS/Invariant.ts";
import { sh, sha256 } from "./Lib.ts";

export const IMAGE_ASPECT = "16:9";
export const IMAGE_SIZE = "2K";
/** Standing instruction appended to every prompt: paintings carry no text, ever. */
export const NO_TEXT = "No text, no lettering, no captions, no titles, no logos, no signatures, no watermarks anywhere in the image.";

export type Painter = (req: { prompt: string; refs: string[] }) => Promise<Buffer>;

export function envValue(key: string): string {
  const text = readFileSync(getEnvPath(), "utf8");
  const m = text.match(new RegExp(`^${key}=(.*)$`, "m"));
  const v = m?.[1]?.trim().replace(/^["']|["']$/g, "") ?? "";
  invariant(v, `missing ${key} in the env file`);
  return v;
}

export function paintHash(prompt: string, refs: string[], model = CROSS_VENDOR.geminiImage): string {
  const refHashes = refs.map((r) => sha256(readFileSync(r)).slice(0, 16));
  return sha256(JSON.stringify({ prompt, refHashes, aspect: IMAGE_ASPECT, size: IMAGE_SIZE, model })).slice(0, 12);
}

/** `<dir>/<id>.<hash>.png` if it exists, else null; stale hashes for the same id are removed by the caller on write. */
export function cachedPath(dir: string, id: string, hash: string): string | null {
  const p = join(dir, `${id}.${hash}.png`);
  return existsSync(p) ? p : null;
}
export function currentPath(dir: string, id: string): string | null {
  if (!existsSync(dir)) return null;
  const f = readdirSync(dir).find((n) => n.startsWith(`${id}.`) && n.endsWith(".png"));
  return f ? join(dir, f) : null;
}
export function dropStale(dir: string, id: string, keepHash: string): void {
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir)) if (f.startsWith(`${id}.`) && !f.startsWith(`${id}.${keepHash}.`)) rmSync(join(dir, f));
}

export const geminiPainter: Painter = async ({ prompt, refs }) => {
  const ai = new GoogleGenAI({ apiKey: envValue("GOOGLE_API_KEY") });
  const parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> = [];
  for (const r of refs) parts.push({ inlineData: { mimeType: "image/png", data: readFileSync(r).toString("base64") } });
  parts.push({ text: prompt });
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await ai.models.generateContent({
        model: CROSS_VENDOR.geminiImage,
        contents: [{ parts }],
        config: { responseModalities: ["TEXT", "IMAGE"], imageConfig: { aspectRatio: IMAGE_ASPECT, imageSize: IMAGE_SIZE } },
      });
      const out = res.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data)?.inlineData?.data;
      if (!out) throw new Error(`no image in response (finish: ${res.candidates?.[0]?.finishReason ?? "?"}; text: ${res.candidates?.[0]?.content?.parts?.map((p) => p.text).filter(Boolean).join(" ").slice(0, 200)})`);
      return Buffer.from(out, "base64");
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
  throw new Error(`image generation failed after 3 attempts: ${String(lastErr).slice(0, 400)}`);
};

/** Paint one id into dir; returns the path. Cached by hash; stale siblings removed on a fresh paint. */
export async function paintInto(dir: string, id: string, prompt: string, refs: string[], opts: { painter?: Painter; force?: boolean; log?: (s: string) => void } = {}): Promise<{ path: string; cached: boolean }> {
  const hash = paintHash(prompt, refs);
  const hit = opts.force ? null : cachedPath(dir, id, hash);
  if (hit) return { path: hit, cached: true };
  const painter = opts.painter ?? geminiPainter;
  opts.log?.(`🎨 ${id}${refs.length ? ` (+${refs.length} refs)` : ""}`);
  const png = await painter({ prompt: `${prompt}\n\n${NO_TEXT}`, refs });
  dropStale(dir, id, hash);
  const path = join(dir, `${id}.${hash}.png`);
  writeFileSync(path, png);
  const check = await checkImage(path);
  invariant(check.ok, `${id}: degenerate image (${check.problems.join("; ")})`);
  return { path, cached: false };
}

export interface ImageCheck { ok: boolean; width: number; height: number; stddev: number; bytes: number; problems: string[] }

/** Non-degenerate: 16:9 within 2%, real pixel variance (a flat card or a solid fill fails), a real file. */
export async function checkImage(path: string, opts: { minStddev?: number } = {}): Promise<ImageCheck> {
  const problems: string[] = [];
  const bytes = statSync(path).size;
  const { out } = await sh(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", path]);
  const [w, h] = out.trim().split(",").map(Number);
  if (!(w > 0 && h > 0)) problems.push("unreadable dimensions");
  const aspect = w / h;
  if (Math.abs(aspect - 16 / 9) / (16 / 9) > 0.02) problems.push(`aspect ${aspect.toFixed(3)} not 16:9`);
  if (w < 1600) problems.push(`width ${w} < 1600`);
  const sig = await sh(["ffmpeg", "-v", "info", "-i", path, "-vf", "signalstats", "-f", "null", "-"], { allowFail: true });
  // signalstats prints per-frame YAVG/YDIF etc; use the grey-level spread via a histogram-free proxy: YHIGH-YLOW and stddev via `-vf format=gray,signalstats`.
  const m = (sig.err + sig.out).match(/YLOW:(\d+).*?YHIGH:(\d+)/s);
  const spread = m ? Number(m[2]) - Number(m[1]) : 0;
  // Standard deviation from a downscaled gray dump.
  const dump = Bun.spawn(["ffmpeg", "-v", "error", "-i", path, "-vf", "scale=64:36,format=gray", "-f", "rawvideo", "-"], { stdout: "pipe", stderr: "pipe" });
  const buf = Buffer.from(await new Response(dump.stdout).arrayBuffer());
  await dump.exited;
  let sum = 0; for (const b of buf) sum += b;
  const mean = sum / (buf.length || 1);
  let sq = 0; for (const b of buf) sq += (b - mean) ** 2;
  const stddev = Math.sqrt(sq / (buf.length || 1));
  const minStddev = opts.minStddev ?? 12;
  if (stddev < minStddev) problems.push(`stddev ${stddev.toFixed(1)} < ${minStddev} (flat image)`);
  if (spread < 40 && m) problems.push(`luma spread ${spread} < 40`);
  return { ok: problems.length === 0, width: w, height: h, stddev, bytes, problems };
}

// ---------- paper margin crop ----------

/** Per-row / per-column luminance stats of a small gray dump. */
export function lineStats(gray: Buffer, w: number, h: number): { rows: { mean: number; sd: number }[]; cols: { mean: number; sd: number }[] } {
  const stat = (vals: number[]) => { const m = vals.reduce((a, b) => a + b, 0) / vals.length; const v = vals.reduce((a, b) => a + (b - m) ** 2, 0) / vals.length; return { mean: m, sd: Math.sqrt(v) }; };
  const rows = Array.from({ length: h }, (_, y) => stat(Array.from({ length: w }, (_, x) => gray[y * w + x])));
  const cols = Array.from({ length: w }, (_, x) => stat(Array.from({ length: h }, (_, y) => gray[y * w + x])));
  return { rows, cols };
}

/** Bare toned paper is bright and flat; a painting is neither. */
export function isPaper(s: { mean: number; sd: number }, opts = { minMean: 185, maxSd: 22 }): boolean { return s.mean >= opts.minMean && s.sd <= opts.maxSd; }

/**
 * The inner box (in dump coordinates) after trimming paper-like rows and columns from each edge, never trimming
 * more than 18% per side (a genuinely bright painting is not a margin). Pure; the tests feed synthetic stats.
 */
export function innerBox(stats: ReturnType<typeof lineStats>, w: number, h: number, maxFrac = 0.18): { x: number; y: number; w: number; h: number } {
  const lim = (n: number) => Math.floor(n * maxFrac);
  let top = 0; while (top < lim(h) && isPaper(stats.rows[top])) top++;
  let bottom = h; while (h - bottom < lim(h) && isPaper(stats.rows[bottom - 1])) bottom--;
  let left = 0; while (left < lim(w) && isPaper(stats.cols[left])) left++;
  let right = w; while (w - right < lim(w) && isPaper(stats.cols[right - 1])) right--;
  return { x: left, y: top, w: right - left, h: bottom - top };
}

/** The largest 16:9 box centered inside a box. */
export function fit169(box: { x: number; y: number; w: number; h: number }): { x: number; y: number; w: number; h: number } {
  let w = box.w, h = Math.round(w * 9 / 16);
  if (h > box.h) { h = box.h; w = Math.round(h * 16 / 9); }
  return { x: box.x + Math.round((box.w - w) / 2), y: box.y + Math.round((box.h - h) / 2), w, h };
}

/** Crop src to its painting (paper margins trimmed, 16:9 kept) into dst. Returns the crop in source pixels. */
export async function cropPaper(src: string, dst: string): Promise<{ x: number; y: number; w: number; h: number; trimmed: boolean }> {
  const { out } = await sh(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", src]);
  const [W, H] = out.trim().split(",").map(Number);
  const dw = 344, dh = 192;
  const dump = Bun.spawn(["ffmpeg", "-v", "error", "-i", src, "-vf", `scale=${dw}:${dh},format=gray`, "-f", "rawvideo", "-"], { stdout: "pipe", stderr: "pipe" });
  const gray = Buffer.from(await new Response(dump.stdout).arrayBuffer());
  await dump.exited;
  invariant(gray.length === dw * dh, `gray dump for ${src} is ${gray.length} bytes`);
  const box = fit169(innerBox(lineStats(gray, dw, dh), dw, dh));
  const sx = W / dw, sy = H / dh;
  // Pad two dump-pixels inward so no paper fringe survives the scale-up, then keep the crop even-sized for the encoder.
  const crop = { x: Math.round((box.x + 2) * sx), y: Math.round((box.y + 2) * sy), w: Math.round((box.w - 4) * sx) & ~1, h: Math.round((box.h - 4) * sy) & ~1 };
  const trimmed = box.w < dw - 2 || box.h < dh - 2;
  await sh(["ffmpeg", "-y", "-v", "error", "-i", src, "-vf", `crop=${crop.w}:${crop.h}:${crop.x}:${crop.y}`, dst]);
  return { ...crop, trimmed };
}
