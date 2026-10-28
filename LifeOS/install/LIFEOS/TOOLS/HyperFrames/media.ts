/**
 * Output checks for every render: provenance strip, ffprobe contract, audio presence, and the
 * decoded-frame motion and blank-frame checks that make a silent still or a black video impossible to ship.
 */
import type { Finding } from "./preflight";
import { runProcess, runProcessBytes } from "./run";

export type OutputFormat = "mp4" | "webm" | "mov";
export const CODEC_FOR: Record<OutputFormat, readonly string[]> = { mp4: ["h264", "hevc"], webm: ["vp9", "vp8", "av1"], mov: ["prores"] };

function tool(name: "ffmpeg" | "ffprobe"): string {
  const path = Bun.which(name);
  if (!path) throw new Error(`${name} not found on PATH; install it (brew install ffmpeg)`);
  return path;
}

export interface ProbeStream { codec_type: string; codec_name: string; width?: number; height?: number; r_frame_rate?: string; avg_frame_rate?: string; nb_read_packets?: string; duration?: string; tags?: Record<string, string> }
export interface ProbeInfo { streams: ProbeStream[]; format: { duration?: string; tags?: Record<string, string>; format_name?: string } }

export async function ffprobe(file: string): Promise<ProbeInfo> {
  const res = await runProcess([tool("ffprobe"), "-v", "error", "-count_packets", "-show_streams", "-show_format", "-of", "json", file], { timeoutMs: 120_000 });
  if (res.code !== 0) throw new Error(`ffprobe failed on ${file}: ${res.stderr.slice(-400)}`);
  const parsed = JSON.parse(res.stdout) as Partial<ProbeInfo>;
  if (!Array.isArray(parsed.streams) || typeof parsed.format !== "object" || parsed.format === null) throw new Error(`ffprobe returned an unexpected shape for ${file}`);
  return parsed as ProbeInfo;
}

export function parseRate(rate: string | undefined): number {
  if (!rate) return Number.NaN;
  const [n, d] = rate.split("/").map(Number);
  return d ? n! / d : Number(n);
}

/** Every metadata key, format and stream level, that names HyperFrames. */
export function provenanceKeys(info: ProbeInfo): string[] {
  const keys: string[] = [];
  for (const [k, v] of Object.entries(info.format.tags ?? {})) if (/hyperframes/i.test(k) || /hyperframes/i.test(v)) keys.push(`format:${k}`);
  info.streams.forEach((s, i) => { for (const [k, v] of Object.entries(s.tags ?? {})) if (/hyperframes/i.test(k) || /hyperframes/i.test(v)) keys.push(`stream${i}:${k}`); });
  return keys;
}

/** Remux without any container metadata (HyperFrames stamps hyperframes_renderer/_version). Stream copy, no re-encode. */
export async function stripProvenance(input: string, output: string, format: OutputFormat): Promise<void> {
  const args = [tool("ffmpeg"), "-v", "error", "-y", "-i", input, "-map", "0", "-c", "copy", "-map_metadata", "-1", "-map_chapters", "-1", "-fflags", "+bitexact"];
  for (const s of ["v", "a"]) args.push(`-map_metadata:s:${s}`, "-1");
  if (format !== "webm") args.push("-movflags", "+faststart");
  args.push(output);
  const res = await runProcess(args, { timeoutMs: 600_000 });
  if (res.code !== 0) throw new Error(`provenance strip failed: ${res.stderr.slice(-400)}`);
}

export interface Expectation { format: OutputFormat; width: number; height: number; fps: number; durationSec: number; audio: boolean }
export interface Validation { ok: boolean; findings: Finding[]; info: { codec: string; width: number; height: number; fps: number; frames: number; durationSec: number; hasAudio: boolean; audioMaxDb: number | null; provenance: string[] } }

/** Check a finished file against what the composition declared. */
export async function validateOutput(file: string, expect: Expectation): Promise<Validation> {
  const info = await ffprobe(file);
  const findings: Finding[] = [];
  const add = (code: string, message: string) => findings.push({ source: "validate", severity: "error", code, message });
  const video = info.streams.find((s) => s.codec_type === "video");
  const audio = info.streams.find((s) => s.codec_type === "audio");
  const fps = parseRate(video?.r_frame_rate);
  const frames = Number(video?.nb_read_packets ?? Number.NaN);
  const durationSec = Number(info.format.duration ?? video?.duration ?? Number.NaN);
  if (!video) add("no-video", "output has no video stream");
  else {
    if (!CODEC_FOR[expect.format].includes(video.codec_name)) add("codec", `codec ${video.codec_name}, expected ${CODEC_FOR[expect.format].join("|")} for ${expect.format}`);
    if (video.width !== expect.width || video.height !== expect.height) add("size", `size ${video.width}x${video.height}, expected ${expect.width}x${expect.height}`);
    if (!(Math.abs(fps - expect.fps) < 0.01)) add("fps", `fps ${video.r_frame_rate}, expected ${expect.fps}`);
    const wantFrames = Math.round(expect.durationSec * expect.fps);
    if (!(Math.abs(frames - wantFrames) <= 1)) add("frame-count", `${frames} frames, expected ${wantFrames} (±1)`);
    if (!(Math.abs(durationSec - expect.durationSec) <= 1 / expect.fps + 0.05)) add("duration", `duration ${durationSec.toFixed(3)} s, expected ${expect.durationSec} s`);
  }
  let audioMaxDb: number | null = null;
  if (expect.audio) {
    if (!audio) add("no-audio", "audio was expected but the output has no audio stream");
    else {
      const measured = await maxVolumeDb(file);
      audioMaxDb = measured.db;
      if (measured.error !== null) add("audio-measure-failed", measured.error);
      else if (audioMaxDb === null || audioMaxDb < -60) add("silent-audio", `audio stream is silent (max ${audioMaxDb ?? "n/a"} dB)`);
    }
  }
  const provenance = provenanceKeys(info);
  if (provenance.length) add("provenance", `provenance tags survived the strip: ${provenance.join(", ")}`);
  return { ok: findings.length === 0, findings, info: { codec: video?.codec_name ?? "", width: video?.width ?? 0, height: video?.height ?? 0, fps, frames, durationSec, hasAudio: !!audio, audioMaxDb, provenance } };
}

export interface VolumeMeasurement { db: number | null; error: string | null }

/**
 * Read volumedetect's max_volume from a finished ffmpeg run. A run that timed out
 * or exited nonzero proves nothing, even when its partial stderr already printed a
 * max_volume line, so it is an error and its number is never used.
 */
export function parseMaxVolume(res: { code: number; stderr: string; timedOut: boolean }): VolumeMeasurement {
  if (res.timedOut) return { db: null, error: "volume measurement timed out" };
  if (res.code !== 0) return { db: null, error: `volume measurement exited ${res.code}: ${res.stderr.slice(-200)}` };
  const m = /max_volume:\s*(-?\d+(?:\.\d+)?|-inf) dB/.exec(res.stderr);
  if (!m) return { db: null, error: "volume measurement printed no max_volume" };
  const db = m[1] === "-inf" ? Number.NEGATIVE_INFINITY : Number(m[1]);
  if (Number.isNaN(db)) return { db: null, error: `volume measurement is not a number: ${m[1]}` };
  return { db, error: null };
}

async function maxVolumeDb(file: string): Promise<VolumeMeasurement> {
  const res = await runProcess([tool("ffmpeg"), "-v", "info", "-nostats", "-i", file, "-map", "0:a:0", "-af", "volumedetect", "-f", "null", "-"], { timeoutMs: 600_000 });
  return parseMaxVolume(res);
}

export const MOTION_W = 160;
export const MOTION_H = 90;
/** A pixel counts as changed when its gray level moves more than this (0–255), above codec noise. */
export const MOTION_PIXEL_DELTA = 6;
/** Motion exists when some pair of sampled frames differs in at least this fraction of pixels. */
export const MOTION_MIN_CHANGED = 0.001;

export interface MotionResult { ok: boolean; times: number[]; changed: number[]; maxChanged: number }

/** Sample times from the first frame to the last, evenly spaced. */
export function motionTimes(durationSec: number, fps: number, samples: number): number[] {
  // Half a frame before the last frame: an input seek to the exact last pts can land past the end and decode nothing.
  const last = Math.max(0, durationSec - 1.5 / fps);
  if (samples < 2) throw new Error("motion check needs at least 2 samples");
  return Array.from({ length: samples }, (_, i) => Number(((last * i) / (samples - 1)).toFixed(4)));
}

async function grayFrame(file: string, t: number): Promise<Uint8Array> {
  const res = await runProcessBytes([tool("ffmpeg"), "-v", "error", "-ss", String(t), "-i", file, "-frames:v", "1", "-vf", `scale=${MOTION_W}:${MOTION_H}:flags=area,format=gray`, "-f", "rawvideo", "-"], { timeoutMs: 120_000 });
  if (res.code !== 0 || res.stdout.length !== MOTION_W * MOTION_H) throw new Error(`frame decode at ${t}s failed (${res.stdout.length} bytes): ${res.stderr.slice(-300)}`);
  return res.stdout;
}

export function changedFraction(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length) throw new Error("changedFraction: frame sizes differ");
  let n = 0;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i]! - b[i]!) > MOTION_PIXEL_DELTA) n++;
  return n / a.length;
}

/** Gray frames decoded at spread times; motionOf and blankOf both read one sample. */
export interface FrameSample { times: number[]; frames: Uint8Array[] }

export async function sampleFrames(file: string, durationSec: number, fps: number, samples = 12): Promise<FrameSample> {
  const times = motionTimes(durationSec, fps, samples);
  return { times, frames: await Promise.all(times.map((t) => grayFrame(file, t))) };
}

/** Decode frames at spread times and measure how much consecutive samples differ. */
export async function motionCheck(file: string, durationSec: number, fps: number, samples = 12): Promise<MotionResult> {
  return motionOf(await sampleFrames(file, durationSec, fps, samples));
}

export function motionOf({ times, frames }: FrameSample): MotionResult {
  const changed: number[] = [];
  for (let i = 1; i < frames.length; i++) changed.push(Number(changedFraction(frames[i - 1]!, frames[i]!).toFixed(5)));
  // Against the first frame too, so motion that returns to a sampled pose between neighbours still counts.
  let fromFirst = 0;
  for (let i = 2; i < frames.length; i++) fromFirst = Math.max(fromFirst, changedFraction(frames[0]!, frames[i]!));
  const maxChanged = Math.max(...changed, Number(fromFirst.toFixed(5)));
  return { ok: maxChanged >= MOTION_MIN_CHANGED, times, changed, maxChanged };
}

/**
 * Blank-frame detection. A compositor that draws nothing (hardware GPU compositing on an affected Mac,
 * 2026-09-24: every frame fully transparent, encoded as black) gives frames of one flat colour.
 * A frame is flat when fewer than FLAT_MAX_VARIED of its pixels sit more than MOTION_PIXEL_DELTA
 * levels from the frame's mean. One flat frame can be a fade; every sampled frame flat is a failure.
 */
export const FLAT_MAX_VARIED = 0.001;

/** Fraction of pixels whose gray level departs from the frame's mean by more than MOTION_PIXEL_DELTA. */
export function variedFraction(gray: Uint8Array): number {
  if (gray.length === 0) throw new Error("variedFraction: empty frame");
  let sum = 0;
  for (let i = 0; i < gray.length; i++) sum += gray[i]!;
  const mean = sum / gray.length;
  let n = 0;
  for (let i = 0; i < gray.length; i++) if (Math.abs(gray[i]! - mean) > MOTION_PIXEL_DELTA) n++;
  return n / gray.length;
}

export function meanLevel(gray: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < gray.length; i++) sum += gray[i]!;
  return Math.round(sum / gray.length);
}

export interface BlankResult { ok: boolean; flat: number; total: number; meanLevels: number[] }

/** ok is false only when every sampled frame is flat. */
export function blankOf({ frames }: FrameSample): BlankResult {
  if (frames.length === 0) throw new Error("blankOf: no frames");
  const flat = frames.filter((f) => variedFraction(f) < FLAT_MAX_VARIED).length;
  return { ok: flat < frames.length, flat, total: frames.length, meanLevels: frames.map(meanLevel) };
}

export interface StillStats { gray: Uint8Array; alphaMax: number }

/** Decode a PNG at MOTION_W×MOTION_H: gray levels plus the highest alpha, so a fully transparent still is visible. */
export async function stillStats(file: string): Promise<StillStats> {
  const res = await runProcessBytes([tool("ffmpeg"), "-v", "error", "-i", file, "-frames:v", "1", "-vf", `scale=${MOTION_W}:${MOTION_H}:flags=area,format=rgba`, "-f", "rawvideo", "-"], { timeoutMs: 60_000 });
  const n = MOTION_W * MOTION_H;
  if (res.code !== 0 || res.stdout.length !== n * 4) throw new Error(`still decode of ${file} failed (${res.stdout.length} bytes): ${res.stderr.slice(-300)}`);
  const gray = new Uint8Array(n);
  let alphaMax = 0;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    gray[i] = Math.round((res.stdout[o]! * 299 + res.stdout[o + 1]! * 587 + res.stdout[o + 2]! * 114) / 1000);
    alphaMax = Math.max(alphaMax, res.stdout[o + 3]!);
  }
  return { gray, alphaMax };
}
