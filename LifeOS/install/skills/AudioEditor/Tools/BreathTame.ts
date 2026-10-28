#!/usr/bin/env bun
/**
 * BreathTame.ts — Surgical breath and mouth-sound attenuation.
 *
 * Attenuates individual breath/click EVENTS that sit in the gaps BETWEEN words.
 * It is not a filter: no gate, no denoiser, no expander, no broadband processing.
 * Every sample outside a detected event window is passed through bit-identically,
 * and that claim is verified before the file is written.
 *
 * Usage:
 *   bun BreathTame.ts <audio-or-video> [--out <path>] [--words <transcript.json>]
 *                     [--breath-db -9] [--click-db -12] [--guard-ms 40]
 *                     [--max-affected-pct 12] [--dry-run] [--json]
 */

import { $ } from "bun";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import { basename, dirname, extname, join } from "path";

// ---------- args ----------
const argv = process.argv.slice(2);
const flag = (n: string, d?: string) => {
  const i = argv.indexOf(`--${n}`);
  return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d;
};
const has = (n: string) => argv.includes(`--${n}`);

const input = argv.find((a) => !a.startsWith("--") && !argv[argv.indexOf(a) - 1]?.startsWith("--"))
  ?? argv.find((a) => !a.startsWith("--"));

if (!input || !existsSync(input)) {
  console.error("Usage: bun BreathTame.ts <audio-or-video> [--out <path>] [--words <transcript.json>]");
  console.error("       [--breath-db -9] [--click-db -12] [--guard-ms 40] [--max-affected-pct 12] [--dry-run] [--json]");
  process.exit(2);
}

const BREATH_DB = parseFloat(flag("breath-db", "-9")!);
const CLICK_DB = parseFloat(flag("click-db", "-12")!);
const GUARD_MS = parseFloat(flag("guard-ms", "40")!);
const MAX_AFFECTED_PCT = parseFloat(flag("max-affected-pct", "12")!);

// The help's guarantees ("attenuates, never removes", "nothing inside a word ±guard is touched") hold only for these
// ranges: a dB at or above 0 is unity or gain, and a negative guard shrinks the protected word windows.
const badArg =
  !(Number.isFinite(BREATH_DB) && BREATH_DB < 0) ? `--breath-db must be a negative number (got ${flag("breath-db")})`
  : !(Number.isFinite(CLICK_DB) && CLICK_DB < 0) ? `--click-db must be a negative number (got ${flag("click-db")})`
  : !(Number.isFinite(GUARD_MS) && GUARD_MS >= 0) ? `--guard-ms must be zero or more (got ${flag("guard-ms")})`
  : !(Number.isFinite(MAX_AFFECTED_PCT) && MAX_AFFECTED_PCT > 0 && MAX_AFFECTED_PCT <= 100)
    ? `--max-affected-pct must be above 0 and at most 100 (got ${flag("max-affected-pct")})`
  : null;
if (badArg) {
  console.error(badArg);
  process.exit(2);
}
const DRY = has("dry-run");
const JSON_OUT = has("json");

const ext = extname(input);
const stem = basename(input, ext);
const outPath = flag("out", join(dirname(input), `${stem}-tamed${ext}`))!;

const log = (...a: unknown[]) => { if (!JSON_OUT) console.log(...a); };

// Event shape / safety constants. These bound what may be touched at all.
const RAMP_MS = 12;          // raised-cosine in/out, contained inside the event
const MIN_EVENT_MS = 20;     // shorter than this is not a real event
const MAX_EVENT_MS = 1200;   // longer than this is content, never a breath
const CLICK_MAX_MS = 60;     // <= this and high-ZCR => mouth click
const OVER_FLOOR_DB = 8;     // an event must exceed the room floor by this much
const UNDER_SPEECH_DB = 6;   // and sit at least this far below speech level

// ---------- decode ----------
const tmpWav = join("/tmp", `breathtame-${process.pid}-in.wav`);
const tmpOut = join("/tmp", `breathtame-${process.pid}-out.wav`);

log(`Decoding: ${input}`);
const dec = await $`ffmpeg -y -v error -i ${input} -map a:0 -c:a pcm_s32le -f wav ${tmpWav}`.nothrow().quiet();
if (dec.exitCode !== 0 || !existsSync(tmpWav)) {
  console.error("ffmpeg could not decode an audio stream from the input.");
  process.exit(1);
}

// ---------- WAV parse (canonical + extensible headers) ----------
function parseWav(buf: Buffer) {
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("not a RIFF/WAVE file");
  }
  let off = 12, fmt: { channels: number; rate: number; bits: number } | null = null;
  let dataOff = -1, dataLen = 0;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === "fmt ") {
      fmt = { channels: buf.readUInt16LE(body + 2), rate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) };
    } else if (id === "data") {
      dataOff = body; dataLen = Math.min(size, buf.length - body);
    }
    off = body + size + (size % 2);
  }
  if (!fmt || dataOff < 0) throw new Error("missing fmt or data chunk");
  if (fmt.bits !== 32) throw new Error(`expected 32-bit PCM, got ${fmt.bits}`);
  return { ...fmt, dataOff, dataLen };
}

const inBuf = readFileSync(tmpWav);
const wav = parseWav(inBuf);
const { channels, rate, dataOff, dataLen } = wav;
const frameCount = Math.floor(dataLen / (4 * channels));
// Copy into an aligned buffer — a WAV data chunk is not guaranteed to start on a 4-byte boundary.
const samples = new Int32Array(frameCount * channels);
for (let i = 0; i < samples.length; i++) samples[i] = inBuf.readInt32LE(dataOff + i * 4);
const original = Int32Array.from(samples); // reference copy for the falsifier
const durationSec = frameCount / rate;

log(`Audio: ${rate} Hz, ${channels} ch, ${durationSec.toFixed(2)}s`);

// ---------- word windows (whisper) ----------
type Span = { start: number; end: number };

async function getWordSpans(): Promise<Span[]> {
  let jsonPath = flag("words");
  if (!jsonPath) {
    const guess = join(dirname(input), `${stem}.transcript.json`);
    if (existsSync(guess)) jsonPath = guess;
  }
  if (!jsonPath) {
    log("No word transcript supplied — running Transcribe.ts...");
    const t = join("/tmp", `breathtame-${process.pid}.transcript.json`);
    const r = await $`bun ${join(import.meta.dir, "Transcribe.ts")} ${tmpWav} --output ${t}`.nothrow().quiet();
    if (r.exitCode === 0 && existsSync(t)) jsonPath = t;
  }
  if (!jsonPath || !existsSync(jsonPath)) {
    console.error("No word-level transcript available. BreathTame refuses to run without one:");
    console.error("without word boundaries it cannot prove it is only touching gaps between words.");
    process.exit(1);
  }
  const j = JSON.parse(readFileSync(jsonPath, "utf8"));
  const spans: Span[] = [];
  const push = (s: unknown, e: unknown) => {
    const a = Number(s), b = Number(e);
    if (Number.isFinite(a) && Number.isFinite(b) && b > a) spans.push({ start: a, end: b });
  };
  if (Array.isArray(j.chunks)) for (const c of j.chunks) if (Array.isArray(c.timestamp)) push(c.timestamp[0], c.timestamp[1]);
  if (!spans.length && Array.isArray(j.segments)) {
    for (const s of j.segments) {
      if (Array.isArray(s.words)) for (const w of s.words) push(w.start, w.end);
      else push(s.start, s.end);
    }
  }
  if (!spans.length) { console.error(`No word timestamps found in ${jsonPath}`); process.exit(1); }
  return spans.sort((a, b) => a.start - b.start);
}

const words = await getWordSpans();
log(`Word spans: ${words.length}`);

// Protected = every word window widened by the guard margin. Never touched.
const guard = GUARD_MS / 1000;
const protectedSpans: Span[] = [];
for (const w of words) {
  const s = Math.max(0, w.start - guard), e = Math.min(durationSec, w.end + guard);
  const last = protectedSpans[protectedSpans.length - 1];
  if (last && s <= last.end) last.end = Math.max(last.end, e);
  else protectedSpans.push({ start: s, end: e });
}

// Gaps = complement of protected, inside [0, duration].
const gaps: Span[] = [];
let cursor = 0;
for (const p of protectedSpans) {
  if (p.start > cursor) gaps.push({ start: cursor, end: p.start });
  cursor = Math.max(cursor, p.end);
}
if (cursor < durationSec) gaps.push({ start: cursor, end: durationSec });

// ---------- framing ----------
const HOP = Math.max(1, Math.round(rate * 0.005)); // 5 ms
const WIN = Math.max(2, Math.round(rate * 0.020)); // 20 ms
const nFrames = Math.max(0, Math.floor((frameCount - WIN) / HOP) + 1);
const rms = new Float64Array(nFrames);
const zcr = new Float64Array(nFrames);
const SCALE = 2147483648;

for (let f = 0; f < nFrames; f++) {
  const s0 = f * HOP;
  let acc = 0, cross = 0, prev = 0;
  for (let i = 0; i < WIN; i++) {
    let mix = 0;
    const base = (s0 + i) * channels;
    for (let c = 0; c < channels; c++) mix += samples[base + c] / SCALE;
    mix /= channels;
    acc += mix * mix;
    if (i > 0 && ((mix >= 0) !== (prev >= 0))) cross++;
    prev = mix;
  }
  rms[f] = Math.sqrt(acc / WIN);
  zcr[f] = cross / WIN;
}

const frameTime = (f: number) => (f * HOP + WIN / 2) / rate;
const inSpans = (t: number, spans: Span[]) => spans.some((s) => t >= s.start && t < s.end);

const pct = (arr: number[], p: number) => {
  if (!arr.length) return 0;
  const a = [...arr].sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.max(0, Math.floor(p * (a.length - 1))))];
};

const gapRms: number[] = [], speechRms: number[] = [];
for (let f = 0; f < nFrames; f++) {
  const t = frameTime(f);
  if (inSpans(t, gaps)) gapRms.push(rms[f]);
  else if (inSpans(t, protectedSpans)) speechRms.push(rms[f]);
}

const floor = Math.max(pct(gapRms, 0.10), 1e-9);
const speech = Math.max(pct(speechRms, 0.90), floor * 4);
const openThresh = floor * Math.pow(10, OVER_FLOOR_DB / 20);
const ceilThresh = speech * Math.pow(10, -UNDER_SPEECH_DB / 20);

const db = (x: number) => 20 * Math.log10(Math.max(x, 1e-12));
log(`Room floor ${db(floor).toFixed(1)} dBFS · speech ${db(speech).toFixed(1)} dBFS · event window ${db(openThresh).toFixed(1)}..${db(ceilThresh).toFixed(1)} dBFS`);

// ---------- event detection (gaps only) ----------
type Ev = { start: number; end: number; kind: "breath" | "click"; peak: number; zcr: number };
const events: Ev[] = [];
let run: number[] | null = null;

const closeRun = () => {
  if (!run) return;
  const f0 = run[0], f1 = run[run.length - 1];
  const start = (f0 * HOP) / rate;
  const end = (f1 * HOP + WIN) / rate;
  run = null;
  const ms = (end - start) * 1000;
  if (ms < MIN_EVENT_MS || ms > MAX_EVENT_MS) return;
  // The whole event must sit inside one gap — never straddle a word boundary.
  if (!gaps.some((g) => start >= g.start && end <= g.end)) return;
  let peak = 0, zsum = 0, n = 0;
  for (let f = f0; f <= f1; f++) { peak = Math.max(peak, rms[f]); zsum += zcr[f]; n++; }
  if (peak > ceilThresh) return;                       // too loud to be a breath
  const z = n ? zsum / n : 0;
  const kind: Ev["kind"] = ms <= CLICK_MAX_MS && z > 0.10 ? "click" : "breath";
  events.push({ start, end, kind, peak, zcr: z });
};

for (let f = 0; f < nFrames; f++) {
  const t = frameTime(f);
  const live = inSpans(t, gaps) && rms[f] > openThresh;
  if (live) (run ??= []).push(f);
  else closeRun();
}
closeRun();

const breaths = events.filter((e) => e.kind === "breath").length;
const clicks = events.filter((e) => e.kind === "click").length;
const affectedSec = events.reduce((a, e) => a + (e.end - e.start), 0);
const affectedPct = durationSec > 0 ? (affectedSec / durationSec) * 100 : 0;

log(`Events: ${breaths} breaths, ${clicks} clicks · ${affectedSec.toFixed(2)}s (${affectedPct.toFixed(2)}% of file)`);

// The anti-heavy-handed gate: broad detection means the settings went wrong.
if (affectedPct > MAX_AFFECTED_PCT) {
  console.error(`REFUSED: ${affectedPct.toFixed(2)}% of the file would be attenuated (ceiling ${MAX_AFFECTED_PCT}%).`);
  console.error("That is broadband processing wearing an event-detector costume. Raise --max-affected-pct only");
  console.error("if you have listened and confirmed the detections are real breaths, not speech.");
  if (!DRY) { try { unlinkSync(tmpWav); } catch {} process.exit(1); }
}

if (JSON_OUT) {
  console.log(JSON.stringify({
    input, output: DRY ? null : outPath, durationSec, sampleRate: rate, channels,
    roomFloorDb: +db(floor).toFixed(2), speechDb: +db(speech).toFixed(2),
    breaths, clicks, affectedSec: +affectedSec.toFixed(3), affectedPct: +affectedPct.toFixed(3),
    breathDb: BREATH_DB, clickDb: CLICK_DB, dryRun: DRY,
    events: events.map((e) => ({ start: +e.start.toFixed(3), end: +e.end.toFixed(3), kind: e.kind, peakDb: +db(e.peak).toFixed(1) })),
  }, null, 2));
}

if (DRY) {
  log("Dry run — nothing written.");
  try { unlinkSync(tmpWav); } catch {}
  process.exit(0);
}

// ---------- apply per-event gain with raised-cosine ramps ----------
const touched: Array<[number, number]> = [];
for (const e of events) {
  const targetDb = e.kind === "click" ? CLICK_DB : BREATH_DB;
  const gain = Math.pow(10, targetDb / 20);
  const s0 = Math.max(0, Math.floor(e.start * rate));
  const s1 = Math.min(frameCount, Math.ceil(e.end * rate));
  const len = s1 - s0;
  if (len <= 0) continue;
  const ramp = Math.min(Math.floor(rate * (RAMP_MS / 1000)), Math.floor(len / 2));
  for (let i = 0; i < len; i++) {
    let g = gain;
    if (ramp > 0) {
      if (i < ramp) g = 1 + (gain - 1) * (0.5 - 0.5 * Math.cos((Math.PI * i) / ramp));
      else if (i >= len - ramp) {
        const k = len - 1 - i;
        g = 1 + (gain - 1) * (0.5 - 0.5 * Math.cos((Math.PI * k) / ramp));
      }
    }
    const base = (s0 + i) * channels;
    for (let c = 0; c < channels; c++) {
      const v = Math.round(samples[base + c] * g);
      samples[base + c] = Math.max(-2147483648, Math.min(2147483647, v));
    }
  }
  touched.push([s0, s1]);
}

// ---------- FALSIFIER: everything outside a touched window is bit-identical ----------
const isTouched = new Uint8Array(frameCount);
for (const [a, b] of touched) for (let i = a; i < b; i++) isTouched[i] = 1;

let drift = 0, firstDrift = -1;
for (let i = 0; i < frameCount; i++) {
  if (isTouched[i]) continue;
  const base = i * channels;
  for (let c = 0; c < channels; c++) {
    if (samples[base + c] !== original[base + c]) { drift++; if (firstDrift < 0) firstDrift = i; break; }
  }
}

if (drift > 0) {
  console.error(`UNTOUCHED-IDENTICAL: FAIL — ${drift} samples changed outside event windows (first at ${(firstDrift / rate).toFixed(3)}s).`);
  console.error("Refusing to write. This tool is only allowed to modify detected events.");
  try { unlinkSync(tmpWav); } catch {}
  process.exit(1);
}
log(`UNTOUCHED-IDENTICAL: PASS (${frameCount - touched.reduce((a, [s, e]) => a + (e - s), 0)} frames bit-identical)`);

// ---------- write + mux ----------
for (let i = 0; i < samples.length; i++) inBuf.writeInt32LE(samples[i], dataOff + i * 4);
writeFileSync(tmpOut, inBuf);
log(`Writing: ${outPath}`);

const isVideo = [".mp4", ".mov", ".mkv", ".webm", ".m4v"].includes(ext.toLowerCase());
let mux;
if (isVideo) {
  mux = await $`ffmpeg -y -v error -i ${input} -i ${tmpOut} -map 0:v -map 1:a -c:v copy -c:a aac -b:a 320k -movflags +faststart ${outPath}`.nothrow().quiet();
} else if (ext.toLowerCase() === ".wav") {
  // Copy the 32-bit working file verbatim — re-encoding to 24-bit would truncate the
  // untouched samples and break the bit-identity this tool just proved.
  writeFileSync(outPath, readFileSync(tmpOut));
  mux = { exitCode: 0 } as { exitCode: number };
} else {
  mux = await $`ffmpeg -y -v error -i ${tmpOut} -b:a 320k ${outPath}`.nothrow().quiet();
}
try { unlinkSync(tmpWav); unlinkSync(tmpOut); } catch {}

if (mux.exitCode !== 0) { console.error("ffmpeg mux failed."); process.exit(1); }

log(`Done. ${breaths} breaths at ${BREATH_DB} dB, ${clicks} clicks at ${CLICK_DB} dB, ${affectedPct.toFixed(2)}% of file touched.`);
