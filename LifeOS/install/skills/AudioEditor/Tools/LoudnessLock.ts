#!/usr/bin/env bun
/**
 * LoudnessLock — deterministic delivery-loudness finalizer (YouTube standard).
 *
 * Target: −14 LUFS integrated, ≤ −1 dBTP true peak (YouTube normalizes to ~−14;
 * louder is turned down, quieter just sounds quiet next to other videos).
 *
 * Measure mode (default): report integrated LUFS / true peak / LRA + PASS/FAIL,
 * plus a within-file spread report (worst sustained speech span vs integrated) —
 * a file can pass integrated while carrying a hot embedded clip next to quiet
 * speech, and the spread line is what makes that visible. Report-only by
 * design: measured 2026-08-28, no bucket-scale threshold separates that defect
 * (−6.0 LU worst span) from natural soft asides in a correctly leveled file
 * (−5.4 LU) — the structural control is --level being the pipeline default.
 *   bun LoudnessLock.ts <media>                       # exit 0 = within tolerance
 *
 * Normalize mode: two-pass ffmpeg loudnorm (linear when possible), video stream
 * copied, AAC audio at source sample rate, then SELF RE-MEASURE — exits 0 only
 * when the OUTPUT lands within tolerance.
 *   bun LoudnessLock.ts <media> --out <out.mp4> [--target -14] [--tp -1] [--abr 256k] [--level]
 *
 * --level: adaptive speech leveling (dynaudnorm, ~7.5s gaussian window, gain-only,
 * +12dB cap, silence-thresholded) BEFORE the linear lock. Fixes within-file
 * imbalance — raw mic speech sitting LU below a mastered embedded clip — which
 * uniform program normalization preserves by design. The maintainer-side
 * talking-head video pipeline (not in the public release) passes this by default.
 *
 * Exit codes: 0 = pass, 1 = fail/out-of-tolerance, 2 = error.
 */
import { spawnSync } from "child_process";
import { recordRenderOf, videoInheritanceProblem } from "../../../LIFEOS/TOOLS/lib/RenderProvenance.ts";

const BOOL_FLAGS = new Set(["--level"]);
const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith("--") && (BOOL_FLAGS.has(args[args.indexOf(a) - 1] ?? "") || !args[args.indexOf(a) - 1]?.startsWith("--")));
const opt = (name: string, def: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};
const OUT = opt("--out", "");
const TARGET = parseFloat(opt("--target", "-14"));
const TP = parseFloat(opt("--tp", "-1"));
const ABR = opt("--abr", "256k");
const LEVEL = args.includes("--level");
const TOL = 0.5;
// Gain-only leveler: 500ms frames × 15-frame gaussian ≈ 7.5s window (levels
// phrases and sections, not syllables — g=31 left phrase-scale dips audible,
// measured 2026-08-28); m=4 caps boost at +12dB; t≈−34dBFS peak threshold
// keeps pauses/noise floor unamplified; overlap smooths gain steps. No
// compress factor: s>0 measurably WORSENED speech LRA on real footage.
const LEVEL_AF = "dynaudnorm=f=500:g=15:p=0.95:m=4:t=0.02:o=0.3";
if (!file) { console.error("usage: LoudnessLock.ts <media> [--out out.mp4] [--target -14] [--tp -1] [--abr 256k] [--level]"); process.exit(2); }

function measure(f: string, prefilter = "") {
  const af = (prefilter ? prefilter + "," : "") + `loudnorm=I=${TARGET}:TP=${TP}:LRA=11:print_format=json`;
  const r = spawnSync("ffmpeg", ["-hide_banner", "-i", f, "-af", af, "-f", "null", "-"], { maxBuffer: 1 << 26 });
  const err = r.stderr?.toString() || "";
  const m = err.match(/\{[\s\S]*\}/);
  if (!m) { console.error("loudnorm measurement failed:", err.slice(-400)); process.exit(2); }
  const j = JSON.parse(m[0]);
  return {
    input_i: parseFloat(j.input_i), input_tp: parseFloat(j.input_tp),
    input_lra: parseFloat(j.input_lra), input_thresh: parseFloat(j.input_thresh),
    target_offset: parseFloat(j.target_offset),
  };
}
const verdict = (i: number, tp: number) => Math.abs(i - TARGET) <= TOL && tp <= TP + 0.1;

// Within-file spread: MOMENTARY (400ms) loudness sampled ~10Hz via ebur128,
// speech-gated at integrated−15, bucketed to 10s; buckets with <40% gated
// samples are skipped as silence/music-bed. Momentary, not short-term: 3s
// windows smear pauses into speech and false-flag sparse-speech spans
// (measured 2026-08-28 — an S-based gate flagged a span whose gated
// integrated was fine). Returns the worst sustained speech bucket relative
// to integrated — the number integrated hides.
function spreadReport(f: string, integrated: number) {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-nostats", "-i", f, "-af", "ebur128", "-f", "null", "-"], { maxBuffer: 1 << 27 });
  const out = r.stderr?.toString() || "";
  const gate = integrated - 15;
  const buckets = new Map<number, { sum: number; n: number; total: number }>();
  for (const line of out.split("\n")) {
    const tm = line.match(/t:\s*([0-9.]+)/); const mm = line.match(/M:\s*(-?[0-9.]+)/);
    if (!tm || !mm) continue;
    const t = Math.floor(parseFloat(tm[1]) / 10) * 10; const m = parseFloat(mm[1]);
    const b = buckets.get(t) ?? { sum: 0, n: 0, total: 0 };
    b.total++;
    if (m > gate) { b.sum += m; b.n++; }
    buckets.set(t, b);
  }
  let worst = { t: -1, mean: Infinity };
  for (const [t, b] of buckets) {
    if (b.total === 0 || b.n / b.total < 0.4) continue;
    const mean = b.sum / b.n;
    if (mean < worst.mean) worst = { t, mean };
  }
  if (worst.t < 0) return null;
  return { t: worst.t, mean: worst.mean, delta: worst.mean - integrated };
}
const fmtT = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

const m1 = measure(file, OUT && LEVEL ? LEVEL_AF : "");
console.log(`${file}: integrated ${m1.input_i} LUFS | true peak ${m1.input_tp} dBTP | LRA ${m1.input_lra} | target ${TARGET} LUFS / ${TP} dBTP${OUT && LEVEL ? " (measured post-level)" : ""}`);

if (!OUT) {
  const pass = verdict(m1.input_i, m1.input_tp);
  const sp = spreadReport(file, m1.input_i);
  if (sp) console.log(`spread: worst sustained speech span ${fmtT(sp.t)}–${fmtT(sp.t + 10)} at ${sp.mean.toFixed(1)} LUFS (${sp.delta.toFixed(1)} LU vs integrated) | LRA ${m1.input_lra}`);
  console.log(pass ? "PASS — within delivery tolerance" : `FAIL — off by ${(m1.input_i - TARGET).toFixed(1)} LU${m1.input_tp > TP ? `, true peak over by ${(m1.input_tp - TP).toFixed(1)}dB` : ""}`);
  process.exit(pass ? 0 : 1);
}

// probe source audio params
const pr = spawnSync("ffprobe", ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=sample_rate", "-of", "csv=p=0", file]);
const SR = parseInt(pr.stdout?.toString().trim() || "") || 48000;
const hasVideo = spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_type", "-of", "csv=p=0", file]).stdout?.toString().includes("video");
// the encoder follows the output type, so an audio-only chain (podcast .mp3, archival .wav) is encoded once, here
const OUT_EXT = OUT.slice(OUT.lastIndexOf(".")).toLowerCase();
const ACODEC = OUT_EXT === ".mp3" ? ["-c:a", "libmp3lame", "-b:a", ABR] : OUT_EXT === ".wav" ? ["-c:a", "pcm_s24le"] : OUT_EXT === ".flac" ? ["-c:a", "flac"] : ["-c:a", "aac", "-b:a", ABR, "-movflags", "+faststart"];

const af = (LEVEL ? LEVEL_AF + "," : "") + `loudnorm=I=${TARGET}:TP=${TP}:LRA=11:measured_I=${m1.input_i}:measured_TP=${m1.input_tp}:measured_LRA=${m1.input_lra}:measured_thresh=${m1.input_thresh}:offset=${m1.target_offset}:linear=true`;
const encArgs = ["-v", "error", "-i", file, ...(hasVideo ? ["-map", "0:v:0", "-c:v", "copy"] : []), "-map", "0:a:0", "-af", af, ...ACODEC, "-ar", String(SR), OUT, "-y"];
const enc = spawnSync("ffmpeg", encArgs, { maxBuffer: 1 << 26 });
if (enc.status !== 0) { console.error("normalize encode failed:", enc.stderr?.toString().slice(-400)); process.exit(2); }

let m2 = measure(OUT);
console.log(`${OUT}: integrated ${m2.input_i} LUFS | true peak ${m2.input_tp} dBTP`);

// correction pass: pure gain for the residual + true-peak limiter (loudnorm's dynamic
// mode can land outside tolerance on large gain requirements)
for (let pass = 1; pass <= 2 && !verdict(m2.input_i, m2.input_tp); pass++) {
  const residual = TARGET - m2.input_i;
  // alimiter caps sample peaks, not inter-sample true peaks — leave 0.8dB margin
  const limitLin = Math.pow(10, (TP - 0.8) / 20).toFixed(4);
  const tmp = OUT + ".corr" + OUT_EXT;
  console.log(`correction pass ${pass}: ${residual >= 0 ? "+" : ""}${residual.toFixed(2)}dB gain, sample-peak limit ${(TP - 0.8).toFixed(1)}dB (true-peak margin)`);
  const corr = spawnSync("ffmpeg", ["-v", "error", "-i", OUT, ...(hasVideo ? ["-map", "0:v:0", "-c:v", "copy"] : []), "-map", "0:a:0", "-af", `volume=${residual.toFixed(2)}dB,alimiter=limit=${limitLin}:level=false:attack=5:release=50`, ...ACODEC, "-ar", String(SR), tmp, "-y"], { maxBuffer: 1 << 26 });
  if (corr.status !== 0) { console.error("correction encode failed:", corr.stderr?.toString().slice(-300)); process.exit(2); }
  spawnSync("mv", [tmp, OUT]);
  m2 = measure(OUT);
  console.log(`${OUT} (corrected ${pass}): integrated ${m2.input_i} LUFS | true peak ${m2.input_tp} dBTP`);
}

const pass = verdict(m2.input_i, m2.input_tp);
console.log(pass ? `LOCKED — output within ${TOL} LU of ${TARGET} LUFS, TP ≤ ${TP} dBTP` : "FAIL — output out of tolerance after correction pass");
// A locked video is a camera-footage export's final write (the video pipeline skill's ExportReliably), so it carries the
// camera-footage render row the release gates read, unless its source was rendered by another pipeline (an essay or
// film), whose derivative it is.
// release-allow: private-skill-names (_VIDEO below is the camera-footage pipeline value in a STATVS render row, not a path; nothing is resolved from it)
if (pass && hasVideo) {
  const inherited = videoInheritanceProblem([{ file, role: "primary" }]);
  const r = inherited ? { ok: false as const, why: inherited } : recordRenderOf(OUT, { pipeline: "_VIDEO" });
  console.log(r.ok ? `render row: _VIDEO ${r.sha256.slice(0, 12)}…` : `no render row (the gates will refuse this output): ${r.why}`);
}
process.exit(pass ? 0 : 1);
