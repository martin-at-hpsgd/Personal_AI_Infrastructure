#!/usr/bin/env bun
/**
 * Score.ts — music as code. A run's `Score.json` describes tempo, tracks, and clips; this
 * synthesizes it to `Narration/score.wav` in-process (no sample library, no ffmpeg graph),
 * then ducks it under the narration into `Narration/bed.wav` with a sidechain compressor.
 *
 *   bun Score.ts --run <slug|dir> [--preset ambient|pulse] [--force] [--verify]
 *
 * With no `Score.json` and no `--preset`, the stage is a no-op (music is opt-in).
 * `--preset` writes a generated `Score.json` sized to the timeline (a pad bed that swells
 * into each chapter) and then renders it. Every note is a pure function of the score, so
 * the same score always yields the same bytes.
 *
 * Score shape (bars are 0-based, beats within a bar are 0-based, durations in beats):
 *   { "bpm": 84, "beatsPerBar": 4, "seconds": 412.3, "gainDb": -18,
 *     "tracks": [ { "name": "pad", "instrument": "pad", "gain": 1,
 *                   "clips": [ { "bar": 0, "beat": 0, "duration": 16, "notes": ["C3","G3","E4"] } ] } ] }
 *
 * Instruments are synthesized waveforms with an envelope (attack/decay/sustain/release in
 * seconds) and a low-pass: pad, pluck, bass, bell, hat, kick.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { invariant } from "../../../LIFEOS/TOOLS/Invariant.ts";
import { argValue, hasFlag, loadScript, loadTimeline, readJson, resolveRunDir, runPaths, sha256, writeJson, type Timeline } from "./Lib.ts";

export const SAMPLE_RATE = 44100;
export const BED_GAIN_DB = -18;

export type Instrument = "pad" | "pluck" | "bass" | "bell" | "hat" | "kick";
export interface Clip { bar: number; beat?: number; duration: number; notes: string[]; velocity?: number }
export interface Track { name: string; instrument: Instrument; gain?: number; clips: Clip[] }
export interface Score { bpm: number; beatsPerBar: number; seconds: number; gainDb?: number; tracks: Track[] }

interface Voice { wave: "sine" | "saw" | "tri" | "noise"; a: number; d: number; s: number; r: number; cutoff: number; detune?: number; harmonics?: number[] }
const VOICES: Record<Instrument, Voice> = {
  pad: { wave: "saw", a: 1.2, d: 0.5, s: 0.8, r: 2.0, cutoff: 900, detune: 0.004 },
  pluck: { wave: "tri", a: 0.005, d: 0.25, s: 0.15, r: 0.3, cutoff: 3000 },
  bass: { wave: "saw", a: 0.01, d: 0.2, s: 0.7, r: 0.15, cutoff: 400 },
  bell: { wave: "sine", a: 0.002, d: 1.2, s: 0.0, r: 1.0, cutoff: 8000, harmonics: [1, 2.76, 5.4] },
  hat: { wave: "noise", a: 0.001, d: 0.05, s: 0, r: 0.03, cutoff: 12000 },
  kick: { wave: "sine", a: 0.001, d: 0.18, s: 0, r: 0.1, cutoff: 200 },
};

// ---------- pure ----------

const NOTE_INDEX: Record<string, number> = { C: 0, "C#": 1, Db: 1, D: 2, "D#": 3, Eb: 3, E: 4, F: 5, "F#": 6, Gb: 6, G: 7, "G#": 8, Ab: 8, A: 9, "A#": 10, Bb: 10, B: 11 };

/** "A4" → 440, "C3" → 130.81. Kick/hat ignore pitch but still need a parseable note. */
export function noteToHz(note: string): number {
  const m = note.match(/^([A-G][#b]?)(-?\d)$/);
  invariant(m, `bad note: ${note}`);
  const semis = NOTE_INDEX[m[1]] + (Number(m[2]) + 1) * 12;
  return 440 * Math.pow(2, (semis - 69) / 12);
}

export function beatSeconds(score: Score): number { return 60 / score.bpm; }

export function clipStartSeconds(score: Score, clip: Clip): number {
  return (clip.bar * score.beatsPerBar + (clip.beat ?? 0)) * beatSeconds(score);
}

/** Deterministic noise: a 32-bit LCG seeded per note so the same score always renders the same bytes. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296 * 2 - 1; };
}

function envelope(t: number, dur: number, v: Voice): number {
  if (t < 0) return 0;
  if (t < v.a) return t / v.a;
  if (t < v.a + v.d) return 1 - (1 - v.s) * ((t - v.a) / v.d);
  if (t < dur) return v.s;
  const rel = 1 - (t - dur) / v.r;
  return rel > 0 ? v.s * rel : 0;
}

/** Render one note into the buffer at sample offset `at`. One-pole low-pass keeps the saws from fizzing. */
function renderNote(buf: Float32Array, at: number, hz: number, dur: number, v: Voice, velocity: number, seed: number): void {
  const total = Math.min(buf.length - at, Math.ceil((dur + v.r) * SAMPLE_RATE));
  if (total <= 0) return;
  const noise = lcg(seed);
  const rc = 1 / (2 * Math.PI * v.cutoff);
  const alpha = (1 / SAMPLE_RATE) / (rc + 1 / SAMPLE_RATE);
  let lp = 0;
  const partials = v.harmonics ?? [1];
  const det = v.detune ?? 0;
  for (let i = 0; i < total; i++) {
    const t = i / SAMPLE_RATE;
    let x = 0;
    if (v.wave === "noise") x = noise();
    else {
      for (let p = 0; p < partials.length; p++) {
        const f = hz * partials[p] * (v.wave === "sine" && v.a < 0.01 && v.cutoff < 300 ? Math.max(0.35, 1 - t * 6) : 1); // kick pitch drop
        const ph = 2 * Math.PI * f * t;
        const w = v.wave === "sine" ? Math.sin(ph) : v.wave === "tri" ? (2 / Math.PI) * Math.asin(Math.sin(ph)) : 2 * ((f * t) % 1) - 1;
        x += w / (p + 1);
        if (det) x += (v.wave === "saw" ? 2 * ((f * (1 + det) * t) % 1) - 1 : Math.sin(2 * Math.PI * f * (1 + det) * t)) * 0.5;
      }
    }
    lp += alpha * (x - lp);
    buf[at + i] += lp * envelope(t, dur, v) * velocity;
  }
}

/** Synthesize the whole score to mono float samples in [-1, 1], length = score.seconds. */
export function synthesize(score: Score): Float32Array {
  invariant(score.bpm > 0 && score.beatsPerBar > 0 && score.seconds > 0, "score needs bpm, beatsPerBar, seconds > 0");
  const n = Math.ceil(score.seconds * SAMPLE_RATE);
  const buf = new Float32Array(n);
  const bs = beatSeconds(score);
  for (const track of score.tracks) {
    const v = VOICES[track.instrument];
    invariant(v, `unknown instrument: ${track.instrument}`);
    const gain = track.gain ?? 1;
    for (const clip of track.clips) {
      const start = clipStartSeconds(score, clip);
      const at = Math.round(start * SAMPLE_RATE);
      if (at >= n) continue;
      const dur = clip.duration * bs;
      const vel = (clip.velocity ?? 0.8) * gain / Math.max(1, Math.sqrt(clip.notes.length));
      for (const note of clip.notes) renderNote(buf, at, noteToHz(note), dur, v, vel, sha256Seed(`${track.name}:${note}:${start}`));
    }
  }
  // Fade the tail so the bed never ends on a click, then normalize to -3 dBFS peak so the mix stage owns the level.
  const fade = Math.min(n, SAMPLE_RATE * 2);
  for (let i = 0; i < fade; i++) buf[n - 1 - i] *= i / fade;
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(buf[i]));
  if (peak > 0) { const k = 0.708 / peak; for (let i = 0; i < n; i++) buf[i] *= k; }
  return buf;
}

function sha256Seed(s: string): number { return parseInt(sha256(s).slice(0, 8), 16); }

/** 16-bit PCM stereo WAV bytes from mono samples. */
export function toWav(samples: Float32Array): Uint8Array {
  const channels = 2, bytesPerSample = 2;
  const dataLen = samples.length * channels * bytesPerSample;
  const out = new Uint8Array(44 + dataLen);
  const dv = new DataView(out.buffer);
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) out[o + i] = s.charCodeAt(i); };
  str(0, "RIFF"); dv.setUint32(4, 36 + dataLen, true); str(8, "WAVE"); str(12, "fmt ");
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, channels, true);
  dv.setUint32(24, SAMPLE_RATE, true); dv.setUint32(28, SAMPLE_RATE * channels * bytesPerSample, true);
  dv.setUint16(32, channels * bytesPerSample, true); dv.setUint16(34, 16, true);
  str(36, "data"); dv.setUint32(40, dataLen, true);
  let o = 44;
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    const s = v < 0 ? v * 32768 : v * 32767;
    dv.setInt16(o, s, true); dv.setInt16(o + 2, s, true); o += 4;
  }
  return out;
}

/** A generated score sized to the timeline: a slow pad bed in a minor key, a bell hit and a bass swell at each chapter start. */
export function presetScore(preset: "ambient" | "pulse", tl: Timeline, chapterStarts: number[], seed: string): Score {
  const bpm = preset === "pulse" ? 96 : 72;
  const score: Score = { bpm, beatsPerBar: 4, seconds: tl.total, gainDb: BED_GAIN_DB, tracks: [] };
  const bs = 60 / bpm;
  const barSec = bs * 4;
  const bars = Math.ceil(tl.total / barSec);
  const progressions = [["A2", "E3", "C4"], ["F2", "C3", "A3"], ["C3", "G3", "E4"], ["G2", "D3", "B3"]];
  const rot = parseInt(sha256(seed).slice(0, 2), 16) % progressions.length;
  const pad: Track = { name: "pad", instrument: "pad", gain: 1, clips: [] };
  for (let b = 0; b < bars; b += 4) pad.clips.push({ bar: b, duration: 16, notes: progressions[(b / 4 + rot) % progressions.length], velocity: 0.7 });
  score.tracks.push(pad);
  const bells: Track = { name: "chapter", instrument: "bell", gain: 0.6, clips: [] };
  const bass: Track = { name: "swell", instrument: "bass", gain: 0.5, clips: [] };
  for (const t of chapterStarts) {
    const bar = Math.floor(t / barSec);
    const beat = Math.round((t - bar * barSec) / bs);
    const chord = progressions[(Math.floor(bar / 4) + rot) % progressions.length];
    bells.clips.push({ bar, beat, duration: 2, notes: [chord[2].replace(/\d/, (d) => String(Number(d) + 1))], velocity: 0.9 });
    bass.clips.push({ bar, beat, duration: 8, notes: [chord[0]], velocity: 0.8 });
  }
  score.tracks.push(bells, bass);
  if (preset === "pulse") {
    const hats: Track = { name: "hats", instrument: "hat", gain: 0.25, clips: [] };
    for (let b = 0; b < bars; b++) for (let k = 0; k < 4; k++) hats.clips.push({ bar: b, beat: k, duration: 0.25, notes: ["A5"], velocity: k % 2 ? 0.5 : 0.8 });
    score.tracks.push(hats);
  }
  return score;
}

export function scorePaths(runDir: string) {
  const p = runPaths(runDir);
  return { score: join(runDir, "Score.json"), scoreWav: join(p.narration, "score.wav"), bedWav: join(p.narration, "bed.wav"), hash: join(p.narration, "score.hash") };
}

// ---------- live ----------

async function sh(cmd: string[]): Promise<{ out: string; err: string }> {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  invariant(code === 0, `${cmd.slice(0, 2).join(" ")} failed (${code}): ${err.slice(-400)}`);
  return { out, err };
}

async function durationOf(file: string): Promise<number> {
  const r = await sh(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]);
  return Number(r.out.trim());
}

/** RMS in dBFS of a window of a wav file. */
async function rmsDb(file: string, start: number, len: number): Promise<number> {
  const r = await sh(["ffmpeg", "-v", "info", "-ss", String(start), "-t", String(len), "-i", file, "-af", "astats=measure_overall=RMS_level:measure_perchannel=none", "-f", "null", "-"]);
  const m = r.err.match(/RMS level dB:\s*(-?[\d.]+|-inf)/);
  return m ? (m[1] === "-inf" ? -120 : Number(m[1])) : -120;
}

/** Duck the score under the narration: sidechain compression keyed on speech, then the bed gain. */
export async function mixBed(narrationWav: string, scoreWav: string, bedWav: string, gainDb: number): Promise<void> {
  const total = await durationOf(narrationWav);
  // apad + atrim: the compressor stops at the shorter input, so pad the score past the narration and cut to it exactly.
  const graph = `[1:a]volume=${gainDb}dB,apad=whole_dur=${total + 1}[bed];[bed][0:a]sidechaincompress=threshold=0.02:ratio=8:attack=40:release=600:makeup=1[ducked];[ducked]apad=whole_dur=${total + 1},atrim=0:${total}[out]`;
  await sh(["ffmpeg", "-y", "-v", "error", "-i", narrationWav, "-i", scoreWav, "-filter_complex", graph, "-map", "[out]", "-ar", String(SAMPLE_RATE), "-ac", "2", "-c:a", "pcm_s16le", bedWav]);
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const runArg = argValue(argv, "--run");
  if (!runArg) { console.error("usage: Score.ts --run <slug|dir> [--preset ambient|pulse] [--force] [--verify]"); process.exit(2); }
  const dir = resolveRunDir(runArg);
  const paths = runPaths(dir);
  const sp = scorePaths(dir);
  const preset = argValue(argv, "--preset") as "ambient" | "pulse" | undefined;

  if (hasFlag(argv, "--verify")) {
    if (!existsSync(sp.score)) { console.log("· no Score.json — nothing to verify"); process.exit(0); }
    invariant(existsSync(sp.bedWav), "bed.wav missing — run Score.ts first");
    const tl = loadTimeline(dir);
    const dur = await durationOf(sp.bedWav);
    const okDur = Math.abs(dur - tl.total) <= 0.1;
    // Ducking: the bed must be quieter mid-speech than in a beat gap.
    const gapAt = tl.beats[0].end + tl.gap / 2;
    const words = tl.beats[Math.min(1, tl.beats.length - 1)].words.filter((w) => w.e - w.s > 0.15);
    const speechAt = words.length ? (words[0].s + words[0].e) / 2 : tl.beats[0].start + 1;
    const [gap, speech] = await Promise.all([rmsDb(sp.bedWav, Math.max(0, gapAt - 0.1), 0.2), rmsDb(sp.bedWav, speechAt - 0.1, 0.2)]);
    const ducked = gap - speech >= 3;
    console.log(`${okDur ? "✓" : "✗"} bed duration ${dur.toFixed(2)}s vs timeline ${tl.total.toFixed(2)}s`);
    console.log(`${ducked ? "✓" : "✗"} ducking: bed ${gap.toFixed(1)} dB in gap, ${speech.toFixed(1)} dB under speech (need ≥ 3 dB drop)`);
    process.exit(okDur && ducked ? 0 : 1);
  }

  if (!existsSync(sp.score) && !preset) { console.log("· no Score.json and no --preset — music off, skipping"); process.exit(0); }
  invariant(existsSync(paths.timeline), "timeline.json missing — run narrate first");
  const tl = loadTimeline(dir);
  if (preset && (!existsSync(sp.score) || hasFlag(argv, "--force"))) {
    const script = loadScript(dir);
    const chapterStarts = script.beats.map((b, i) => (b.chapter ? tl.beats[i]?.start : undefined)).filter((t): t is number => typeof t === "number" && t > 0.5);
    writeJson(sp.score, presetScore(preset, tl, chapterStarts, script.slug));
    console.log(`✓ wrote ${sp.score} (${preset}, ${chapterStarts.length} chapter hits)`);
  }
  const score = readJson<Score>(sp.score);
  invariant(Math.abs(score.seconds - tl.total) <= 0.5, `score.seconds ${score.seconds} does not match timeline ${tl.total.toFixed(2)} — regenerate with --force`);
  const narr = Bun.file(paths.narrationWav);
  const hash = sha256(JSON.stringify(score) + narr.size + narr.lastModified);
  const prev = existsSync(sp.hash) ? await Bun.file(sp.hash).text() : "";
  if (prev === hash && existsSync(sp.bedWav) && !hasFlag(argv, "--force")) { console.log(`· bed.wav current (${hash.slice(0, 8)})`); process.exit(0); }
  const t0 = Date.now();
  await Bun.write(sp.scoreWav, toWav(synthesize(score)));
  await mixBed(paths.narrationWav, sp.scoreWav, sp.bedWav, score.gainDb ?? BED_GAIN_DB);
  await Bun.write(sp.hash, hash);
  console.log(`✓ ${sp.bedWav} (${score.tracks.length} tracks, ${score.bpm} bpm, ${Math.round((Date.now() - t0) / 1000)}s)`);
}
