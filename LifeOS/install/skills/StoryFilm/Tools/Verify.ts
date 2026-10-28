#!/usr/bin/env bun
/**
 * Verify.ts — read the rendered film back. Never trusts the render command.
 *
 *   bun Verify.ts --run <slug|dir> [--check format|duration|frames|motion|speech|loudness|cards|caption|sheet] [--whisper-model base.en]
 *
 *   format    h264 1920x1080 at 30 fps with an aac audio stream
 *   duration  container duration within 0.5 s of the timeline total
 *   frames    a mid-beat frame for every beat is non-degenerate (real pixel variance) — Out/frames/<beat>.png
 *   motion    for every beat, the frame at 15% and at 85% of the beat differ (mean abs pixel diff over a 64x36 gray) above a floor
 *   speech    whisper transcript of three sampled beats vs the story text, WER ≤ 0.08
 *   loudness  integrated loudness within 2 LU of −16 LUFS
 *   cards     the frame at 2.5 s and at total−1.5 s are typed cards: dark, with bright letters (sampled at 320x180)
 *   caption   at three word midpoints the lit (white) word in the caption band, read by OCR, is the word the
 *             timeline says is spoken, and whisper places that same word over the word's span in the film audio
 *   sheet     Out/review/contact-sheet.png (a frame every 10 s) and motion-strip.png (6 frames per beat, one row per beat)
 * Writes Out/verify.json, bound to the film's sha256: a partial --check keeps earlier verdicts only for the same film bytes, and the file is ok
 * only when every check above is present and green. An unknown --check is an error. A film built with --no-captions skips the caption check (reported as skipped).
 * Exit 0 only when every requested check is ok.
 */
import { createReadStream, existsSync, readFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { invariant } from "../../../LIFEOS/TOOLS/Invariant.ts";
import { beatSentences, sentenceAt, WORD_LIT_TAIL } from "./FilmTimeline.ts";
import { FPS, HEIGHT, TARGET_LUFS, WIDTH, argValue, ensureDir, hasFlag, loadBeats, loadTimeline, normalizeText, probeDuration, resolveRunDir, runPaths, sh, writeJson, type Timeline } from "./Lib.ts";

export interface Check { name: string; ok: boolean; detail: string; data?: unknown }

/** Every check a complete verification covers. An unknown --check name is an error, never an empty (vacuously green) selection. */
export const CHECK_NAMES = ["format", "duration", "frames", "motion", "loudness", "cards", "caption", "speech", "sheet"] as const;

/** sha256 of the rendered film, streamed. verify.json is bound to these bytes. */
export function fileSha256(path: string): Promise<string> {
  return new Promise((res, rej) => {
    const h = createHash("sha256");
    createReadStream(path).on("data", (c) => h.update(c)).on("error", rej).on("end", () => res(h.digest("hex")));
  });
}

/**
 * Fold this run's checks into the previous verify.json. Previous verdicts survive only when they were taken on the same
 * film bytes; a different film drops them. The merged file is ok only when every check in CHECK_NAMES is present and green.
 */
export function mergeVerdicts(previous: { videoSha256?: string; checks?: Check[] }, now: Check[], videoSha256: string, only?: string): { ok: boolean; complete: boolean; checks: Check[] } {
  const carried = only && previous.videoSha256 === videoSha256 ? (previous.checks ?? []).filter((c) => c.name !== only) : [];
  const checks = only ? [...carried, ...now] : now;
  const complete = CHECK_NAMES.every((n) => checks.some((c) => c.name === n));
  return { ok: complete && checks.every((c) => c.ok), complete, checks };
}

export function wordErrorRate(reference: string, hypothesis: string): number {
  const r = normalizeText(reference).split(" ").filter(Boolean), h = normalizeText(hypothesis).split(" ").filter(Boolean);
  if (!r.length) return h.length ? 1 : 0;
  const d: number[][] = Array.from({ length: r.length + 1 }, (_, i) => [i, ...Array(h.length).fill(0)]);
  for (let j = 1; j <= h.length; j++) d[0][j] = j;
  for (let i = 1; i <= r.length; i++) for (let j = 1; j <= h.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (r[i - 1] === h[j - 1] ? 0 : 1));
  return d[r.length][h.length] / r.length;
}

/** Times inside a beat at which to sample: 15% and 85% of its span. */
export function motionSampleTimes(b: { start: number; end: number }): [number, number] { const d = b.end - b.start; return [b.start + 0.15 * d, b.start + 0.85 * d]; }
/** Which beats speech is checked on: the longest, the first, and the last (deterministic, no randomness). */
export function speechSampleIds(tl: Timeline): string[] {
  const longest = [...tl.beats].sort((a, b) => (b.end - b.start) - (a.end - a.start))[0];
  return [...new Set([tl.beats[0].id, longest.id, tl.beats[tl.beats.length - 1].id])];
}
export function stripTimes(start: number, end: number, n = 6): number[] { const d = end - start; return Array.from({ length: n }, (_, i) => start + (d * (i + 0.5)) / n); }

export interface CaptionSample { id: string; word: string; s: number; e: number; frame: number }
/**
 * The caption check's words: in each speech-sample beat, the on-screen word nearest the beat's middle that lasts at
 * least 0.25 s and has four or more letters (short or fast words are OCR- and whisper-fragile). The sample frame is the
 * word's midpoint, and it must fall inside the word's lit span and while its sentence is the one on screen.
 */
export function captionSamples(tl: Timeline, texts: Record<string, string>, fps = FPS): CaptionSample[] {
  const out: CaptionSample[] = [];
  for (const id of speechSampleIds(tl)) {
    const beat = tl.beats.find((b) => b.id === id)!;
    const sentences = beatSentences(beat, texts[id] ?? "");
    const mid = (beat.start + beat.end) / 2;
    const candidates = sentences.flatMap((s, k) => s.words.map((w) => ({ ...w, k }))).filter((w) => w.e - w.s >= 0.25 && normalizeText(w.w).replace(/ /g, "").length >= 4);
    candidates.sort((a, b) => Math.abs((a.s + a.e) / 2 - mid) - Math.abs((b.s + b.e) / 2 - mid));
    const pick = candidates.find((w) => { const f = Math.round(((w.s + w.e) / 2) * fps), t = f / fps; return t >= w.s && t < w.e + WORD_LIT_TAIL && sentenceAt(sentences, t) === w.k; });
    if (pick) out.push({ id, word: pick.w, s: pick.s, e: pick.e, frame: Math.round(((pick.s + pick.e) / 2) * fps) });
  }
  return out;
}
/**
 * The caption check needs one sample word from every speech-sample beat: three for a story of three or more beats,
 * and as many as there are distinct beats for a one- or two-beat story (speechSampleIds deduplicates first, longest
 * and last, so a fixed floor of three could never pass on a short story).
 */
export function captionSampleCountOk(tl: Timeline, samples: CaptionSample[]): boolean {
  const needed = speechSampleIds(tl).length;
  return needed > 0 && samples.length >= needed;
}

/**
 * Bounding box of the lit word: pure-white pixels (every channel ≥ 245) in the caption band, narrowed to the
 * densest 60-px text row and then to the largest run of columns (gaps under 24 px). The lit word is the only
 * pure white text, but a bright spot in the painting can reach 255 too, so a plain bounding box is not enough.
 */
export function litBox(rgb: Buffer, w: number, h: number, bandTop: number): { x0: number; y0: number; x1: number; y1: number; count: number } | null {
  const pts: [number, number][] = [];
  for (let y = bandTop; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 3;
    if (rgb[i]! >= 245 && rgb[i + 1]! >= 245 && rgb[i + 2]! >= 245) pts.push([x, y]);
  }
  if (!pts.length) return null;
  const rows = new Array<number>(h).fill(0);
  for (const [, y] of pts) rows[y]!++;
  const ROW = 60;
  let bestY = bandTop, best = -1;
  for (let y = bandTop; y < h; y++) { let n = 0; for (let k = y; k < Math.min(h, y + ROW); k++) n += rows[k]!; if (n > best) { best = n; bestY = y; } }
  const inRow = pts.filter(([, y]) => y >= bestY && y < bestY + ROW).sort((a, b) => a[0] - b[0]);
  const runs: [number, number][][] = [];
  for (const p of inRow) { const r = runs[runs.length - 1]; if (r && p[0] - r[r.length - 1]![0] < 24) r.push(p); else runs.push([p]); }
  const run = runs.reduce((a, b) => (b.length > a.length ? b : a));
  const xs = run.map((p) => p[0]), ys = run.map((p) => p[1]);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys), count: run.length };
}

async function rgbFrame(video: string, frame: number): Promise<Buffer> {
  // Seek just before the frame's timestamp: ffmpeg returns the first frame at or after the seek point.
  const p = Bun.spawn(["ffmpeg", "-v", "error", "-ss", Math.max(0, frame / FPS - 0.001).toFixed(4), "-i", video, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { stdout: "pipe", stderr: "pipe" });
  const buf = Buffer.from(await new Response(p.stdout).arrayBuffer());
  await p.exited;
  invariant(buf.length === WIDTH * HEIGHT * 3, `rgb frame ${frame} returned ${buf.length} bytes`);
  return buf;
}

/** OCR the lit word: its box (padded) from the frame, as dark text on white, 3x up, one word. */
async function ocrLitWord(rgb: Buffer, box: { x0: number; y0: number; x1: number; y1: number }, dir: string, name: string): Promise<string> {
  const pad = 10, x0 = Math.max(0, box.x0 - pad), y0 = Math.max(0, box.y0 - pad), x1 = Math.min(WIDTH - 1, box.x1 + pad), y1 = Math.min(HEIGHT - 1, box.y1 + pad);
  const cw = x1 - x0 + 1, ch = y1 - y0 + 1;
  const gray = Buffer.alloc(cw * ch);
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
    const i = ((y + y0) * WIDTH + (x + x0)) * 3;
    const m = Math.min(rgb[i]!, rgb[i + 1]!, rgb[i + 2]!);
    gray[y * cw + x] = m >= 235 ? 0 : 255;
  }
  const pgm = join(dir, `${name}.pgm`), png = join(dir, `${name}.png`);
  await Bun.write(pgm, Buffer.concat([Buffer.from(`P5\n${cw} ${ch}\n255\n`), gray]));
  await sh(["ffmpeg", "-y", "-v", "error", "-i", pgm, "-vf", "scale=iw*3:ih*3:flags=bicubic,pad=iw+60:ih+60:30:30:white", png]);
  const { out } = await sh(["tesseract", png, "stdout", "--psm", "8"]);
  return out.trim();
}

/** The words whisper heard over the sample word's span, from a 4 s window of the film's audio around it. */
async function heardWords(video: string, s: CaptionSample, dir: string, model: string): Promise<string[]> {
  const t0 = Math.max(0, (s.s + s.e) / 2 - 2);
  const wav = join(dir, `${s.id}-word.wav`);
  await sh(["ffmpeg", "-y", "-v", "error", "-ss", t0.toFixed(3), "-t", "4", "-i", video, "-vn", "-ar", "16000", "-ac", "1", wav]);
  await sh(["whisper", wav, "--model", model, "--language", "en", "--word_timestamps", "True", "--output_format", "json", "--output_dir", dir, "--fp16", "False", "--verbose", "False"]);
  const json = JSON.parse(readFileSync(join(dir, `${s.id}-word.json`), "utf8")) as { segments?: { words?: { word: string; start: number; end: number }[] }[] };
  const words = (json.segments ?? []).flatMap((seg) => seg.words ?? []);
  const a = s.s - t0, b = s.e - t0;
  // Whisper's word stamps drift by about 0.1 s, so every word it places over the span counts; the result lists them all.
  return words.filter((w) => Math.min(b, w.end) - Math.max(a, w.start) > 0).map((w) => w.word.trim());
}

async function grayDump(video: string, t: number, w = 64, h = 36): Promise<Buffer> {
  const p = Bun.spawn(["ffmpeg", "-v", "error", "-ss", t.toFixed(3), "-i", video, "-frames:v", "1", "-vf", `scale=${w}:${h},format=gray`, "-f", "rawvideo", "-"], { stdout: "pipe", stderr: "pipe" });
  const buf = Buffer.from(await new Response(p.stdout).arrayBuffer());
  await p.exited;
  invariant(buf.length === w * h, `frame dump at ${t}s returned ${buf.length} bytes`);
  return buf;
}
export function stddev(buf: Buffer): number { let s = 0; for (const b of buf) s += b; const m = s / buf.length; let q = 0; for (const b of buf) q += (b - m) ** 2; return Math.sqrt(q / buf.length); }
export function meanAbsDiff(a: Buffer, b: Buffer): number { let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / a.length; }
export function mean(buf: Buffer): number { let s = 0; for (const b of buf) s += b; return s / buf.length; }

async function extractFrame(video: string, t: number, out: string): Promise<void> {
  await sh(["ffmpeg", "-y", "-v", "error", "-ss", t.toFixed(3), "-i", video, "-frames:v", "1", out]);
}

export async function reviewSheets(video: string, tl: Timeline, dir: string): Promise<string[]> {
  ensureDir(dir);
  const every = 10, across = 8;
  const rows = Math.max(1, Math.ceil(tl.total / every / across));
  const contact = join(dir, "contact-sheet.png");
  await sh(["ffmpeg", "-y", "-v", "error", "-i", video, "-vf", `fps=1/${every},scale=240:-1,drawtext=text='%{pts\\:hms}':x=6:y=6:fontsize=16:fontcolor=white:box=1:boxcolor=black@0.6,tile=${across}x${rows}:padding=2:margin=2`, "-frames:v", "1", contact]);
  const strip = join(dir, "motion-strip.png");
  const n = 6;
  // One seek per strip frame, then tile the stills. A single select expression with a term per frame
  // (240 for 40 beats) ran ffmpeg out of memory building the filter graph (Checkup 2026-10-12).
  const framesDir = join(dir, "strip-frames");
  rmSync(framesDir, { recursive: true, force: true });
  ensureDir(framesDir);
  const times = tl.beats.flatMap((b) => stripTimes(b.start, b.end, n));
  const frame = (i: number) => join(framesDir, `f${String(i).padStart(4, "0")}.png`);
  const workers = 8;
  for (let i = 0; i < times.length; i += workers) {
    await Promise.all(times.slice(i, i + workers).map((t, k) => sh(["ffmpeg", "-y", "-v", "error", "-ss", t.toFixed(3), "-i", video, "-frames:v", "1", "-vf", "scale=200:-1", frame(i + k)])));
  }
  times.forEach((t, i) => invariant(existsSync(frame(i)), `motion strip: no frame at ${t.toFixed(3)}s`));
  await sh(["ffmpeg", "-y", "-v", "error", "-framerate", "1", "-i", join(framesDir, "f%04d.png"), "-vf", `tile=${n}x${tl.beats.length}:padding=2:margin=2`, "-frames:v", "1", strip]);
  rmSync(framesDir, { recursive: true, force: true });
  return [contact, strip];
}

/**
 * Whether the film carries captions. Build binds Out/caption-mode.json to the sha256 of the film it rendered; the
 * "no captions" record excuses the caption check only for those exact bytes. A missing record, an unbound one
 * (staged but not rendered, or --stage-only) or one for a different film is treated as captioned, so the check runs.
 */
export function readCaptionMode(dir: string, filmSha256: string): boolean {
  const p = join(runPaths(dir).out, "caption-mode.json");
  if (!existsSync(p)) return true;
  const rec = JSON.parse(readFileSync(p, "utf8")) as { captions?: boolean; videoSha256?: string };
  return !(rec.captions === false && rec.videoSha256 === filmSha256);
}

export async function verify(dir: string, opts: { only?: string; whisperModel?: string; log?: (s: string) => void } = {}): Promise<{ ok: boolean; checks: Check[] }> {
  const log = opts.log ?? ((s) => console.log(s));
  const paths = runPaths(dir);
  const checks: Check[] = [];
  invariant(!opts.only || (CHECK_NAMES as readonly string[]).includes(opts.only), `unknown check "${opts.only}" — one of ${CHECK_NAMES.join(", ")}`);
  const want = (n: string) => !opts.only || opts.only === n;
  invariant(existsSync(paths.video), `film missing at ${paths.video} — run Build.ts first`);
  // Hash BEFORE the first check: the verdicts below describe these bytes, and recordVerdicts
  // re-hashes at the end and refuses to record if the film changed while the checks ran.
  const shaBefore = await fileSha256(paths.video);
  const captionsOn = readCaptionMode(dir, shaBefore);
  const tl = loadTimeline(dir);
  const beats = loadBeats(dir);

  if (want("format")) {
    const { out } = await sh(["ffprobe", "-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height,r_frame_rate", "-of", "json", paths.video]);
    const streams = (JSON.parse(out) as { streams: { codec_type: string; codec_name: string; width?: number; height?: number; r_frame_rate?: string }[] }).streams;
    const v = streams.find((s) => s.codec_type === "video"), a = streams.find((s) => s.codec_type === "audio");
    const ok = !!v && v.codec_name === "h264" && v.width === WIDTH && v.height === HEIGHT && v.r_frame_rate === `${FPS}/1` && !!a && a.codec_name === "aac";
    checks.push({ name: "format", ok, detail: `${v?.codec_name} ${v?.width}x${v?.height} ${v?.r_frame_rate} + ${a?.codec_name ?? "no audio"}` });
  }
  if (want("duration")) {
    const d = await probeDuration(paths.video);
    checks.push({ name: "duration", ok: Math.abs(d - tl.total) <= 0.5, detail: `${d.toFixed(2)}s vs timeline ${tl.total.toFixed(2)}s` });
  }
  if (want("frames")) {
    ensureDir(paths.frames);
    const bad: string[] = [];
    for (const b of tl.beats) {
      const mid = (b.start + b.end) / 2;
      await extractFrame(paths.video, mid, join(paths.frames, `${b.id}.png`));
      const sd = stddev(await grayDump(paths.video, mid));
      if (sd < 10) bad.push(`${b.id}(${sd.toFixed(1)})`);
    }
    checks.push({ name: "frames", ok: !bad.length, detail: bad.length ? `flat: ${bad.join(" ")}` : `${tl.beats.length} mid-beat frames non-degenerate` });
  }
  if (want("motion")) {
    const still: string[] = [];
    const diffs: Record<string, number> = {};
    for (const b of tl.beats) {
      const [t1, t2] = motionSampleTimes(b);
      const d = meanAbsDiff(await grayDump(paths.video, t1), await grayDump(paths.video, t2));
      diffs[b.id] = d;
      if (d < 1.0) still.push(`${b.id}(${d.toFixed(2)})`);
    }
    checks.push({ name: "motion", ok: !still.length, detail: still.length ? `still: ${still.join(" ")}` : `every beat moved (min diff ${Math.min(...Object.values(diffs)).toFixed(2)})`, data: diffs });
  }
  if (want("loudness")) {
    const p = Bun.spawn(["ffmpeg", "-v", "info", "-i", paths.video, "-af", "loudnorm=print_format=json", "-f", "null", "-"], { stderr: "pipe", stdout: "pipe" });
    await p.exited;
    const m = (await new Response(p.stderr).text()).match(/\{[\s\S]*"input_i"[\s\S]*?\}/);
    const i = m ? Number((JSON.parse(m[0]) as { input_i: string }).input_i) : NaN;
    checks.push({ name: "loudness", ok: Number.isFinite(i) && Math.abs(i - TARGET_LUFS) <= 2, detail: `${i.toFixed(1)} LUFS (target ${TARGET_LUFS} ± 2)` });
  }
  if (want("cards")) {
    // Inside each card's full-opacity hold: the title is on from 1 s; the end card fades out over the last 0.9 s.
    const t0 = 2.5, t1 = tl.total - 1.5;
    // Sampled at 320x180: on the 64x36 dump thin type averages into the black (peak 84 on a real card).
    const a = await grayDump(paths.video, t0, 320, 180), b = await grayDump(paths.video, t1, 320, 180);
    // A typed card on near-black: a dark frame with bright letters somewhere.
    const peak = (buf: Buffer) => { let m = 0; for (const v of buf) if (v > m) m = v; return m; };
    const cardLike = (buf: Buffer) => mean(buf) < 40 && peak(buf) >= 150;
    await extractFrame(paths.video, t0, join(ensureDir(paths.frames), "card-title.png"));
    await extractFrame(paths.video, t1, join(paths.frames, "card-end.png"));
    checks.push({ name: "cards", ok: cardLike(a) && cardLike(b), detail: `title mean ${mean(a).toFixed(0)} peak ${peak(a)} · end mean ${mean(b).toFixed(0)} peak ${peak(b)}` });
  }
  if (want("caption") && !captionsOn) {
    checks.push({ name: "caption", ok: true, detail: "skipped: the film was built with --no-captions, so there is no lit word to read", data: { skipped: true } });
  } else if (want("caption")) {
    const texts = Object.fromEntries(beats.beats.map((b) => [b.id, b.text]));
    const outDir = ensureDir(join(paths.out, "caption-check"));
    const samples = captionSamples(tl, texts);
    const results: { id: string; frame: number; expected: string; lit: string; heard: string; ok: boolean }[] = [];
    const tesseract = await sh(["which", "tesseract"], { allowFail: true });
    if (tesseract.code !== 0) checks.push({ name: "caption", ok: false, detail: "tesseract is not installed; the lit word cannot be read" });
    else {
      for (const s of samples) {
        const rgb = await rgbFrame(paths.video, s.frame);
        const box = litBox(rgb, WIDTH, HEIGHT, HEIGHT - 300);
        const lit = box ? await ocrLitWord(rgb, box, outDir, `${s.id}-f${s.frame}`) : "";
        const heard = await heardWords(paths.video, s, outDir, opts.whisperModel ?? "base.en");
        const want = normalizeText(s.word);
        results.push({ id: s.id, frame: s.frame, expected: s.word, lit, heard: heard.join(" "), ok: normalizeText(lit) === want && heard.some((h) => normalizeText(h) === want) });
      }
      checks.push({ name: "caption", ok: captionSampleCountOk(tl, samples) && results.every((r) => r.ok), detail: results.length ? results.map((r) => `${r.id}@${(r.frame / FPS).toFixed(2)}s "${r.expected}" lit "${r.lit}" heard "${r.heard}"`).join(" · ") : "no sample words", data: results });
    }
  }
  if (want("speech")) {
    const model = opts.whisperModel ?? "base.en";
    const outDir = ensureDir(join(paths.out, "whisper"));
    const results: { id: string; wer: number }[] = [];
    for (const id of speechSampleIds(tl)) {
      const b = tl.beats.find((x) => x.id === id)!;
      const wav = join(outDir, `${id}.wav`);
      await sh(["ffmpeg", "-y", "-v", "error", "-ss", b.start.toFixed(3), "-to", b.end.toFixed(3), "-i", paths.video, "-vn", "-ar", "16000", "-ac", "1", wav]);
      await sh(["whisper", wav, "--model", model, "--language", "en", "--output_format", "txt", "--output_dir", outDir, "--fp16", "False", "--verbose", "False"]);
      const hyp = readFileSync(join(outDir, `${id}.txt`), "utf8");
      const ref = beats.beats.find((x) => x.id === id)!.text;
      results.push({ id, wer: wordErrorRate(ref, hyp) });
    }
    const worst = Math.max(...results.map((r) => r.wer));
    checks.push({ name: "speech", ok: worst <= 0.08, detail: results.map((r) => `${r.id} WER ${(r.wer * 100).toFixed(1)}%`).join(" · "), data: results });
  }
  if (want("sheet")) {
    const files = await reviewSheets(paths.video, tl, paths.review);
    checks.push({ name: "sheet", ok: files.every((f) => existsSync(f)), detail: files.join(", ") });
  }
  for (const c of checks) log(`${c.ok ? "✓" : "✗"} ${c.name}: ${c.detail}`);
  const recorded = await recordVerdicts(paths, shaBefore, checks, opts.only);
  if (!recorded.recorded) {
    log(`✗ film-stable: ${recorded.reason}`);
    return { ok: false, checks: [...checks, { name: "film-stable", ok: false, detail: recorded.reason ?? "film changed during verification" }] };
  }
  return { ok: checks.every((c) => c.ok), checks };
}

/**
 * Write verify.json for checks taken on the film whose sha256 was `shaBefore` when they started. The film is
 * re-hashed now; if its bytes changed while the checks ran (a rebuild mid-whisper), nothing is recorded, so old
 * verdicts are never bound to new bytes. (review-final 2026-10-09 row 8.)
 */
export async function recordVerdicts(paths: { video: string; verify: string }, shaBefore: string, checks: Check[], only?: string): Promise<{ recorded: boolean; reason?: string }> {
  invariant(checks.length > 0, "recordVerdicts: no checks ran; an empty set would record a vacuous verdict");
  const shaAfter = await fileSha256(paths.video);
  if (shaAfter !== shaBefore) {
    return { recorded: false, reason: `the film changed while it was being verified (sha256 ${shaBefore.slice(0, 12)} before the checks, ${shaAfter.slice(0, 12)} after); nothing recorded, re-run Verify` };
  }
  const previous = existsSync(paths.verify) ? JSON.parse(readFileSync(paths.verify, "utf8")) as { videoSha256?: string; checks?: Check[] } : {};
  const merged = mergeVerdicts(previous, checks, shaBefore, only);
  writeJson(paths.verify, { verifiedAt: new Date().toISOString(), videoSha256: shaBefore, ok: merged.ok, complete: merged.complete, checks: merged.checks });
  return { recorded: true };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const runArg = argValue(argv, "--run");
  if (!runArg) { console.error("usage: Verify.ts --run <slug|dir> [--check name] [--whisper-model m]"); process.exit(2); }
  const only = argValue(argv, "--check");
  if (only && !(CHECK_NAMES as readonly string[]).includes(only)) { console.error(`unknown --check "${only}" — one of ${CHECK_NAMES.join(", ")}`); process.exit(2); }
  const r = await verify(resolveRunDir(runArg), { only, whisperModel: argValue(argv, "--whisper-model") });
  console.log(r.ok ? "✓ film verified" : "✗ film failed");
  invariant(!hasFlag(argv, "--strict") || r.ok, "strict verify failed");
  process.exit(r.ok ? 0 : 1);
}
