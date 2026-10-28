/**
 * Audio features precomputed in TypeScript, so compositions never decode audio in the browser.
 *
 * This is the port of HyperFrames' Python `extract-audio-data.py` (per-frame RMS plus N
 * log-spaced frequency bands, each band normalised 0–1 over the file), plus a `spectrum` lane
 * that reproduces Remotion's `visualizeAudio({ numberOfSamples, smoothing: true })` as used with
 * `useWindowedAudioData({ windowInSeconds: 10 })`. The spectrum lane is what lets the
 * Optional VideoEssay presence badges (NOT in the public release payload) keep their current look: same bins, same smoothing, same
 * normalisation, so `spectrum[frame][bin] * gain` means what it meant under Remotion.
 *
 * Frame i covers audio time [i/fps, (i+1)/fps). The consumer adds any composition offset.
 */
import { realpathSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { runProcess, runProcessBytes, sandboxed } from "./run";

/**
 * The only thing ffprobe and ffmpeg are ever pointed at: a local regular file, by its resolved path.
 * A URL, a device or a FIFO is refused here. Both tools also run inside the seam's network sandbox
 * with only the file protocol whitelisted, so a crafted playlist or container cannot pull anything
 * from the network either.
 */
export function assertLocalAudioFile(wav: string): string {
  if (typeof wav !== "string" || wav.length === 0 || wav.includes("\0")) throw new Error("audio input must be a non-empty local file path");
  let real: string;
  try { real = realpathSync(resolve(wav)); } catch { throw new Error(`audio input is not a local file: ${wav.slice(0, 80)}`); }
  if (!statSync(real).isFile()) throw new Error(`audio input must be a regular file: ${wav.slice(0, 80)}`);
  return real;
}

export interface AudioBandsOptions {
  wav: string;
  fps: number;
  /** Log-spaced bands (default 8). */
  bands?: number;
  minHz?: number;
  maxHz?: number;
  /** Remotion-compatible spectrum bins (power of two ≥ 2; default 32, what Presence.tsx uses). 0 skips the lane. */
  spectrumSamples?: number;
  /** Remotion's windowed decode: peak normalisation spans the previous, current and next window. */
  windowSeconds?: number;
  out?: string;
}

export interface AudioBands {
  version: 1;
  fps: number;
  frameCount: number;
  durationSec: number;
  sampleRate: number;
  channel: 0;
  /** Linear RMS per frame, full scale = 1. */
  rms: number[];
  rmsPeak: number;
  bands: { count: number; edgesHz: number[]; fftSize: number; peaks: number[]; values: number[][] };
  spectrum: { samples: number; windowSeconds: number; smoothing: true; compat: string; values: number[][] } | null;
}

const round6 = (v: number) => (Number.isFinite(v) ? Math.round(v * 1e6) / 1e6 : 0);

async function probeAudio(input: string): Promise<{ sampleRate: number; channels: number }> {
  const wav = assertLocalAudioFile(input);
  const ffprobe = Bun.which("ffprobe");
  if (!ffprobe) throw new Error("ffprobe not found on PATH");
  const res = await runProcess(sandboxed([ffprobe, "-v", "error", "-protocol_whitelist", "file", "-select_streams", "a:0", "-show_entries", "stream=sample_rate,channels", "-of", "json", wav]), { timeoutMs: 60_000 });
  if (res.code !== 0) throw new Error(`ffprobe failed on ${wav}: ${res.stderr.slice(-300)}`);
  const s = (JSON.parse(res.stdout) as { streams?: Array<{ sample_rate?: string; channels?: number }> }).streams?.[0];
  const sampleRate = Number(s?.sample_rate);
  if (!s || !(sampleRate > 0)) throw new Error(`${wav} has no audio stream`);
  return { sampleRate, channels: Number(s.channels ?? 1) };
}

/** Channel 0 at the native rate as float32, the same samples Remotion's decoder reads. */
export async function decodeChannel0(input: string): Promise<{ samples: Float32Array; sampleRate: number }> {
  const wav = assertLocalAudioFile(input);
  const { sampleRate } = await probeAudio(wav);
  const ffmpeg = Bun.which("ffmpeg");
  if (!ffmpeg) throw new Error("ffmpeg not found on PATH");
  const res = await runProcessBytes(sandboxed([ffmpeg, "-v", "error", "-protocol_whitelist", "file", "-i", wav, "-map", "0:a:0", "-af", "pan=mono|c0=c0", "-ar", String(sampleRate), "-f", "f32le", "-acodec", "pcm_f32le", "-"]), { timeoutMs: 600_000 });
  if (res.code !== 0) throw new Error(`PCM decode failed for ${wav}: ${res.stderr.slice(-300)}`);
  const copy = new Uint8Array(res.stdout.byteLength);
  copy.set(res.stdout);
  return { samples: new Float32Array(copy.buffer, 0, Math.floor(copy.byteLength / 4)), sampleRate };
}

/** In-place iterative radix-2 FFT. */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  if (n === 0 || (n & (n - 1)) !== 0 || im.length !== n) throw new Error(`fft: length must be a power of two, got ${n}`);
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j]!, re[i]!]; [im[i], im[j]] = [im[j]!, im[i]!]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const wr = Math.cos(ang * k), wi = Math.sin(ang * k);
        const a = i + k, b = a + len / 2;
        const tr = re[b]! * wr - im[b]! * wi, ti = re[b]! * wi + im[b]! * wr;
        re[b] = re[a]! - tr; im[b] = im[a]! - ti;
        re[a] = re[a]! + tr; im[a] = im[a]! + ti;
      }
    }
  }
}

// ── Remotion visualizeAudio port (@remotion/media-utils 4.0.525, optimizeFor "accuracy") ──

const toInt16 = (x: number) => (x > 0 ? x * 0x7fff : x * 0x8000);

/** Verbatim port of Remotion's `smoothen`, including its in-place pass reuse (so results match exactly). */
export function remotionSmoothen(array: number[]): number[] {
  let last = array;
  const next: number[] = [];
  for (let pass = 0; pass < 3; pass++) {
    const side = 1;
    const cn = 1 / 3;
    next[0] = last[0]!;
    next[last.length - 1] = last[last.length - 1]!;
    for (let i = side; i < last.length - side; i++) {
      let sum = 0;
      for (let n = -side; n <= side; n++) sum += cn * last[i + n]! + n;
      next[i] = sum;
    }
    last = next;
  }
  return next;
}

/** One frame of Remotion's getVisualization over `data` (the loaded windows), starting at `offsetSec`. */
export function remotionVisualization(data: Float32Array, sampleRate: number, frame: number, fps: number, samples: number, maxInt: number, offsetSec: number): number[] {
  const size = samples * 2;
  const start = Math.floor((frame / fps - offsetSec) * sampleRate);
  const actualStart = Math.max(0, start - size / 2);
  const re = new Float64Array(size), im = new Float64Array(size);
  const end = Math.min(data.length, actualStart + size);
  for (let i = actualStart; i < end; i++) re[i - actualStart] = Math.trunc(Math.fround(toInt16(data[i]!))); // Int16Array.set truncates
  fft(re, im);
  const mags: number[] = [];
  for (let k = 0; k < size / 2; k++) mags.push(Math.hypot(re[k]!, im[k]!));
  return remotionSmoothen(mags).map((m) => (maxInt > 0 ? m / (size / 2) / maxInt : 0));
}

function spectrumLane(x: Float32Array, sr: number, fps: number, frameCount: number, samples: number, windowSeconds: number): number[][] {
  const winLen = windowSeconds * sr;
  const durationSec = x.length / sr;
  const maxWindow = Math.floor(durationSec / windowSeconds - 1e-12);
  const windowMax: number[] = [];
  for (let w = 0; w <= maxWindow; w++) {
    let m = 0;
    const a = Math.floor(w * winLen), b = Math.min(x.length, Math.floor((w + 1) * winLen));
    for (let i = a; i < b; i++) if (x[i]! > m) m = x[i]!;
    windowMax.push(m);
  }
  const out: number[][] = [];
  for (let f = 0; f < frameCount; f++) {
    const w = Math.floor(f / fps / windowSeconds);
    const w0 = w === 0 ? 0 : w - 1;
    const w1 = Math.min(w + 1, maxWindow);
    const data = x.subarray(Math.floor(w0 * winLen), Math.min(x.length, Math.floor((w1 + 1) * winLen)));
    let peak = 0;
    for (let k = w0; k <= w1; k++) peak = Math.max(peak, windowMax[k] ?? 0);
    const maxInt = toInt16(peak);
    const offset = w0 * windowSeconds;
    const three = [f - 1, f, f + 1].map((g) => remotionVisualization(data, sr, g, fps, samples, maxInt, offset));
    out.push(Array.from({ length: samples }, (_, i) => round6((three[0]![i]! + three[1]![i]! + three[2]![i]!) / 3)));
  }
  return out;
}

/** Log-spaced band edges from minHz to maxHz. */
export function bandEdges(count: number, minHz: number, maxHz: number): number[] {
  if (!(count >= 1) || !(minHz > 0) || !(maxHz > minHz)) throw new Error(`bandEdges: need count ≥ 1 and 0 < minHz < maxHz (got ${count}, ${minHz}, ${maxHz})`);
  return Array.from({ length: count + 1 }, (_, i) => minHz * Math.pow(maxHz / minHz, i / count));
}

/** Compute every lane from decoded samples. Separated from decoding so tests can feed synthetic PCM. */
export function computeAudioBands(x: Float32Array, sampleRate: number, opts: Omit<AudioBandsOptions, "wav" | "out">): AudioBands {
  const { fps } = opts;
  if (!(fps > 0)) throw new Error(`audioBands: fps must be > 0, got ${fps}`);
  const count = opts.bands ?? 8;
  const minHz = opts.minHz ?? 40;
  const maxHz = Math.min(opts.maxHz ?? 16_000, sampleRate / 2);
  const samples = opts.spectrumSamples ?? 32;
  const windowSeconds = opts.windowSeconds ?? 10;
  if (samples !== 0 && (samples < 2 || (samples & (samples - 1)) !== 0)) throw new Error(`audioBands: spectrumSamples must be 0 or a power of two ≥ 2, got ${samples}`);
  const durationSec = x.length / sampleRate;
  const frameCount = Math.ceil(durationSec * fps);
  const hop = sampleRate / fps;
  let fftSize = 256;
  while (fftSize < hop * 2) fftSize <<= 1;
  const hann = Float64Array.from({ length: fftSize }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (fftSize - 1)));
  const edges = bandEdges(count, minHz, maxHz);
  const binHz = sampleRate / fftSize;
  const bandBins = edges.slice(0, -1).map((lo, b) => {
    const hi = edges[b + 1]!;
    const first = Math.max(1, Math.ceil(lo / binHz));
    const last = Math.max(first, Math.min(fftSize / 2 - 1, Math.floor(hi / binHz)));
    return [first, last] as const;
  });
  const rms: number[] = [];
  const raw: number[][] = [];
  const re = new Float64Array(fftSize), im = new Float64Array(fftSize);
  for (let f = 0; f < frameCount; f++) {
    const a = Math.floor(f * hop), b = Math.min(x.length, Math.floor((f + 1) * hop));
    let sq = 0;
    for (let i = a; i < b; i++) sq += x[i]! * x[i]!;
    rms.push(b > a ? Math.sqrt(sq / (b - a)) : 0);
    const centre = Math.floor((f + 0.5) * hop);
    const start = centre - fftSize / 2;
    for (let i = 0; i < fftSize; i++) { const s = start + i; re[i] = s >= 0 && s < x.length ? x[s]! * hann[i]! : 0; im[i] = 0; }
    fft(re, im);
    raw.push(bandBins.map(([lo, hi]) => { let e = 0; for (let k = lo; k <= hi; k++) e += re[k]! * re[k]! + im[k]! * im[k]!; return Math.sqrt(e / (hi - lo + 1)) / (fftSize / 4); }));
  }
  const peaks = Array.from({ length: count }, (_, b) => raw.reduce((m, row) => Math.max(m, row[b]!), 0));
  const rmsPeak = rms.reduce((m, v) => Math.max(m, v), 0);
  return {
    version: 1, fps, frameCount, durationSec: round6(durationSec), sampleRate, channel: 0,
    rms: rms.map(round6), rmsPeak: round6(rmsPeak),
    bands: { count, edgesHz: edges.map((e) => Math.round(e * 10) / 10), fftSize, peaks: peaks.map(round6), values: raw.map((row) => row.map((v, b) => round6(peaks[b]! > 0 ? v / peaks[b]! : 0))) },
    spectrum: samples === 0 ? null : { samples, windowSeconds, smoothing: true, compat: "@remotion/media-utils 4.0.525 visualizeAudio (accuracy) over useWindowedAudioData", values: spectrumLane(x, sampleRate, fps, frameCount, samples, windowSeconds) },
  };
}

/** Decode a wav (or any audio ffmpeg reads) and write per-frame features. */
export async function audioBands(opts: AudioBandsOptions): Promise<AudioBands> {
  const { samples, sampleRate } = await decodeChannel0(opts.wav);
  if (samples.length === 0) throw new Error(`${opts.wav} decoded to zero samples`);
  const data = computeAudioBands(samples, sampleRate, opts);
  if (opts.out) writeFileSync(opts.out, JSON.stringify(data));
  return data;
}

/** A classic script that exposes the data synchronously, so timelines can read it before registering. */
export function audioBandsScript(data: AudioBands, globalName = "__HF_AUDIO"): string {
  if (!/^[A-Za-z_$][\w$]*$/.test(globalName)) throw new Error(`audioBandsScript: invalid global name "${globalName}"`);
  return `window.${globalName} = ${JSON.stringify(data)};\n`;
}
