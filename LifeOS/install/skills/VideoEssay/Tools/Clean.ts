#!/usr/bin/env bun
import { copyFileSync, existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { invariant } from "../../../LIFEOS/TOOLS/Invariant.ts";
import { alignWords } from "./Align.ts";
import { PARAGRAPH_SPANS_FILE, argValue, ensureDir, isNarrator, isSynthesizedNarrator, readJson, resolveRunDir, runPaths, sha256, spansFromWords, VOICE_TARGET_LUFS, VOICE_TRUE_PEAK, writeJson, type ParagraphSpan, type ParagraphSpansRecord, type Post, type RunMeta, type Word } from "./Lib.ts";

/**
 * The tight-cut engine an install provides for a recorded reading; Clean reads only these fields of its plan.
 * Resolved at run time: LIFEOS_TIGHTCUT_ENGINE names the file, else the first sibling skill that ships Tools/TightCut.ts.
 * Absent on an install without a video-editing skill; a synthesized narrator never needs it.
 */
export function resolveTightCutEngine(skillsDir = join(import.meta.dir, "../.."), env: Record<string, string | undefined> = process.env): string | undefined {
  const named = env.LIFEOS_TIGHTCUT_ENGINE;
  if (named) return existsSync(named) ? named : undefined;
  if (!existsSync(skillsDir)) return undefined;
  for (const e of readdirSync(skillsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).sort((x, y) => x.name.localeCompare(y.name))) {
    const candidate = join(skillsDir, e.name, "Tools", "TightCut.ts");
    if (e.name !== "VideoEssay" && existsSync(candidate)) return candidate;
  }
  return undefined;
}
export type PlanSpan = { id: number; cls: string; status: string; start: number; end: number; words: string[]; prev: string; next: string; anchors: number[]; reason: string };
type CutPlan = { inputHash: string; spans: PlanSpan[]; protect: { start: number; end: number; label: string }[]; hash: string };

export function riskyWords(words: string[]): boolean {
  const text = words.join(" ").toLowerCase().replace(/[’‘]/g, "'");
  return /\d|\b(?:not|no|never|none|nothing|nobody|neither|nor|without|cannot|actually|sorry|rather|correction|wait|i\s+mean|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion|trillion|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|half|quarter)\b|n't\b/.test(text);
}

/** The user's by-ear rulings on held spans, keyed by span id. They survive re-runs; a ruled span is never held again. */
export interface Rulings { inputHash: string; approve: number[]; reject: number[] }

export function holdRiskySpans(spans: PlanSpan[], rulings?: Pick<Rulings, "approve" | "reject">): PlanSpan[] {
  const approve = new Set(rulings?.approve ?? []), reject = new Set(rulings?.reject ?? []);
  return spans.map(s => {
    if (reject.has(s.id)) return { ...s, status: "rejected", reason: `${s.reason} · rejected by ear` };
    if (approve.has(s.id)) return { ...s, status: "approved", reason: `${s.reason} · approved by ear` };
    return s.status !== "rejected" && riskyWords(s.words) ? { ...s, status: "needs-review", reason: `${s.reason} · meaning-sensitive deletion` } : { ...s };
  });
}

/** Merge --approve/--reject ids into Narration/rulings.json for this recording; a new recording starts clean. */
export function recordRulings(path: string, inputHash: string, approve: number[], reject: number[]): Rulings {
  const prior = existsSync(path) ? readJson<Rulings>(path) : undefined;
  const base: Rulings = prior && prior.inputHash === inputHash ? prior : { inputHash, approve: [], reject: [] };
  const next: Rulings = { inputHash, approve: [...new Set([...base.approve.filter(i => !reject.includes(i)), ...approve])], reject: [...new Set([...base.reject.filter(i => !approve.includes(i)), ...reject])] };
  invariant(!next.approve.some(i => next.reject.includes(i)), "a span cannot be both approved and rejected");
  if (approve.length || reject.length) writeJson(path, next);
  return next;
}

/** TightCut exits 1 when its gate refuses a render; that is a verdict, not a crash. */
async function exitCode(args: string[]): Promise<number> {
  return await Bun.spawn(args, { stdout: "inherit", stderr: "inherit" }).exited;
}

async function command(args: string[]): Promise<void> {
  const p = Bun.spawn(args, { stdout: "inherit", stderr: "inherit" });
  invariant(await p.exited === 0, `${args[0]} failed`);
}

/**
 * The final audio pass: AudioEditor LoudnessLock's two-pass lock at −14 LUFS integrated with a −1 dBTP true-peak
 * ceiling (Lib VOICE_TARGET_LUFS, VOICE_TRUE_PEAK), re-measured by the tool, which exits 0 only inside its tolerance.
 * This level is the one that ships: Build re-muxes this file over the render's own quieter mix (deliverAudio). A −2 dBTP
 * lock to leave room for a post-render gain does not converge (the limiter raises true peak on every correction pass).
 * No `--level`: the paragraph level match already evened the take, and LoudnessLock's peak-driven leveler
 * (dynaudnorm) puts loudness spread back between matched paragraphs, which the lock alone does not. No gate, no broadband compression and no
 * speech-enhancement pass after the cut.
 */
export async function finalAudioPass(input: string, output: string): Promise<void> {
  invariant(existsSync(input) && input !== output && output.endsWith(".wav"), "the final pass needs an existing input and a distinct .wav output");
  const tool = join(import.meta.dir, "../../AudioEditor/Tools/LoudnessLock.ts");
  await command(["bun", tool, input, "--out", output, "--target", String(VOICE_TARGET_LUFS), "--tp", String(VOICE_TRUE_PEAK)]);
}

// ---------- paragraph level match ----------

/** The largest boost or cut the match applies to one paragraph; a paragraph further from the median keeps the rest of its offset. */
export const MATCH_MAX_GAIN_DB = 12;
/** The shortest span ebur128 can measure (one 400 ms block); a shorter paragraph takes its neighbours' gain. */
export const MATCH_MIN_SECONDS = 0.4;
/** Two paragraphs with no pause between them ramp over this much, centred on the boundary. */
export const MATCH_MIN_RAMP_SECONDS = 0.05;
/** The spread the match exists to reach: the per-paragraph loudness range, in LU, over paragraphs of 1.5 s or more. */
export const PARAGRAPH_RANGE_TARGET_LU = 1.5;
const RANGE_MIN_SECONDS = 1.5;

export interface GainPoint { t: number; db: number }
export interface ParagraphLevel extends ParagraphSpan { lufs?: number; gainDb: number; clamped: boolean; after?: number }
export interface LevelReport { target: number; paragraphs: ParagraphLevel[]; rangeBefore: number; rangeAfter: number }

const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s.length % 2 ? s[(s.length - 1) >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };

/**
 * Per-paragraph gains that bring every measured paragraph to the median of the measured paragraphs, capped at
 * ±MATCH_MAX_GAIN_DB. An unmeasured paragraph (too short, or silent) takes the mean of its nearest measured
 * neighbours' gains, or the one neighbour it has.
 */
export function matchGains(levels: (number | undefined)[]): { target: number; gains: number[]; clamped: boolean[] } {
  const measured = levels.filter((l): l is number => l !== undefined && Number.isFinite(l));
  invariant(measured.length > 0, "no paragraph is long enough to measure; the level match needs at least one");
  const target = median(measured);
  const own = levels.map((l) => (l !== undefined && Number.isFinite(l) ? target - l : undefined));
  const clamped = own.map((g) => g !== undefined && Math.abs(g) > MATCH_MAX_GAIN_DB);
  const capped = own.map((g) => (g === undefined ? undefined : Math.max(-MATCH_MAX_GAIN_DB, Math.min(MATCH_MAX_GAIN_DB, g))));
  const gains = capped.map((g, i) => {
    if (g !== undefined) return g;
    let before: number | undefined, after: number | undefined;
    for (let j = i - 1; j >= 0 && before === undefined; j--) before = capped[j];
    for (let j = i + 1; j < capped.length && after === undefined; j++) after = capped[j];
    return before !== undefined && after !== undefined ? (before + after) / 2 : (before ?? after)!;
  });
  return { target, gains, clamped };
}

/**
 * The gain curve in dB: each paragraph's gain held flat from its first word to its last, a straight ramp across the
 * pause to the next paragraph's gain, so the gain only moves between words. Paragraphs that touch ramp over
 * MATCH_MIN_RAMP_SECONDS around the boundary. Before the first word and after the last, the edge gains hold.
 */
export function gainCurve(spans: ParagraphSpan[], gains: number[]): GainPoint[] {
  invariant(spans.length > 0 && spans.length === gains.length, "one gain per paragraph span");
  invariant(spans.every((s, i) => s.e >= s.s && (i === 0 || s.s >= spans[i - 1].s)), "paragraph spans must be valid and in time order");
  const points: GainPoint[] = [{ t: spans[0].s, db: gains[0] }];
  for (let i = 0; i + 1 < spans.length; i++) {
    let a = spans[i].e, b = spans[i + 1].s;
    if (b - a < MATCH_MIN_RAMP_SECONDS) { const mid = (a + b) / 2; a = mid - MATCH_MIN_RAMP_SECONDS / 2; b = mid + MATCH_MIN_RAMP_SECONDS / 2; }
    points.push({ t: a, db: gains[i] }, { t: b, db: gains[i + 1] });
  }
  points.push({ t: spans.at(-1)!.e, db: gains.at(-1)! });
  // Overlapping alignments can pull a point before its predecessor; time never runs backwards on the curve.
  for (let k = 1; k < points.length; k++) points[k].t = Math.max(points[k].t, points[k - 1].t);
  return points;
}

/** The curve's gain at time t (dB), linear between points, the edge values held outside them. */
export function gainAt(points: GainPoint[], t: number): number {
  if (t <= points[0].t) return points[0].db;
  for (let k = 1; k < points.length; k++) {
    if (t < points[k].t) { const p = points[k - 1], q = points[k]; return p.db + (q.db - p.db) * (t - p.t) / (q.t - p.t); }
  }
  return points.at(-1)!.db;
}

async function capture(args: string[]): Promise<{ out: string; err: string; code: number }> {
  const p = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, code };
}

/** Integrated loudness (ebur128, LUFS) of [s, e] in a file, or undefined when the span is too short or all gated out. */
export async function spanLoudness(file: string, s: number, e: number): Promise<number | undefined> {
  if (e - s < MATCH_MIN_SECONDS) return undefined;
  const r = await capture(["ffmpeg", "-hide_banner", "-nostats", "-ss", s.toFixed(3), "-t", (e - s).toFixed(3), "-i", file, "-vn", "-af", "ebur128=framelog=quiet", "-f", "null", "-"]);
  invariant(r.code === 0, `ebur128 failed on ${file}: ${r.err.slice(-300)}`);
  const lufs = Number(r.err.match(/I:\s+(-?[\d.]+) LUFS/)?.[1]);
  return Number.isFinite(lufs) && lufs > -70 ? lufs : undefined;
}

/**
 * Apply the curve sample by sample, the same gain on every channel, streamed through ffmpeg as 32-bit float so a
 * boost never clips here (the final pass owns the true-peak ceiling). Gain only: no compressor, no gate, no limiter.
 */
export async function applyGainCurve(input: string, output: string, points: GainPoint[]): Promise<void> {
  invariant(existsSync(input) && input !== output && output.endsWith(".wav"), "the gain pass needs an existing input and a distinct .wav output");
  const probe = await capture(["ffprobe", "-v", "error", "-select_streams", "a:0", "-show_entries", "stream=sample_rate,channels", "-of", "csv=p=0", input]);
  const [rate, channels] = probe.out.trim().split(",").map(Number);
  invariant(probe.code === 0 && rate > 0 && channels > 0, `cannot read the audio format of ${input}`);
  const decode = Bun.spawn(["ffmpeg", "-v", "error", "-i", input, "-vn", "-f", "f32le", "-ac", String(channels), "-ar", String(rate), "-"], { stdout: "pipe", stderr: "pipe" });
  const encode = Bun.spawn(["ffmpeg", "-y", "-v", "error", "-f", "f32le", "-ac", String(channels), "-ar", String(rate), "-i", "-", "-c:a", "pcm_f32le", output], { stdin: "pipe", stdout: "ignore", stderr: "pipe" });
  const frameBytes = 4 * channels;
  let carry = new Uint8Array(0), frame = 0, k = 1;
  for await (const chunk of decode.stdout as unknown as AsyncIterable<Uint8Array>) {
    const bytes = new Uint8Array(carry.length + chunk.length); bytes.set(carry); bytes.set(chunk, carry.length);
    const whole = bytes.length - (bytes.length % frameBytes);
    const samples = new Float32Array(bytes.buffer.slice(0, whole));
    for (let i = 0; i < samples.length; i += channels, frame++) {
      const t = frame / rate;
      // Points only move forward in time, so the segment pointer does too.
      while (k < points.length && t >= points[k].t) k++;
      const db = k >= points.length ? points.at(-1)!.db : t <= points[0].t ? points[0].db : points[k - 1].db + (points[k].db - points[k - 1].db) * (t - points[k - 1].t) / (points[k].t - points[k - 1].t);
      const g = 10 ** (db / 20);
      for (let c = 0; c < channels; c++) samples[i + c] *= g;
    }
    encode.stdin.write(new Uint8Array(samples.buffer));
    // Wait for the encoder to take the block, so a long recording never piles up in memory.
    await encode.stdin.flush();
    carry = bytes.slice(whole);
  }
  encode.stdin.end();
  const [decodeCode, decodeErr, encodeCode, encodeErr] = await Promise.all([decode.exited, new Response(decode.stderr).text(), encode.exited, new Response(encode.stderr).text()]);
  invariant(decodeCode === 0 && encodeCode === 0 && carry.length === 0, `gain pass failed: ${decodeErr.slice(-200)} ${encodeErr.slice(-200)}`);
}

const rangeOf = (levels: ParagraphLevel[], key: "lufs" | "after") => {
  const v = levels.filter((l) => l.e - l.s >= RANGE_MIN_SECONDS && l[key] !== undefined).map((l) => l[key]!);
  return v.length ? Math.max(...v) - Math.min(...v) : 0;
};

/** Measure each paragraph, ramp every one to the median, write the leveled file, and re-measure it. */
export async function matchParagraphLevels(input: string, output: string, spans: ParagraphSpan[]): Promise<LevelReport> {
  const levels: (number | undefined)[] = [];
  for (const s of spans) levels.push(await spanLoudness(input, s.s, s.e));
  const { target, gains, clamped } = matchGains(levels);
  await applyGainCurve(input, output, gainCurve(spans, gains));
  const paragraphs: ParagraphLevel[] = [];
  for (const [i, s] of spans.entries()) paragraphs.push({ ...s, lufs: levels[i], gainDb: gains[i], clamped: clamped[i], after: await spanLoudness(output, s.s, s.e) });
  return { target, paragraphs, rangeBefore: rangeOf(paragraphs, "lufs"), rangeAfter: rangeOf(paragraphs, "after") };
}

/** whisper word timings for a file, cached beside it by the file's hash. */
async function transcribeWords(wav: string, dir: string): Promise<{ words: Word[]; duration: number }> {
  const out = ensureDir(join(dir, `.level-whisper-${sha256(readFileSync(wav)).slice(0, 12)}`));
  const json = join(out, `${basename(wav, extname(wav))}.json`);
  if (!existsSync(json)) {
    const r = await capture(["whisper", wav, "--model", "small.en", "--language", "en", "--word_timestamps", "True", "--output_format", "json", "--output_dir", out, "--fp16", "False", "--verbose", "False"]);
    invariant(r.code === 0 && existsSync(json), `whisper failed on ${wav}: ${r.err.slice(-300)}`);
  }
  const transcript = readJson<{ segments: { words?: { word: string; start: number; end: number }[] }[] }>(json);
  const probe = await capture(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", wav]);
  const duration = Number(probe.out.trim());
  invariant(probe.code === 0 && duration > 0, `cannot read the duration of ${wav}`);
  return { words: transcript.segments.flatMap((s) => s.words ?? []).map((w) => ({ w: w.word.trim(), s: w.start, e: w.end })), duration };
}

/**
 * The paragraph spans on cleaned.wav. A synthesized take's (clone or DA) come from its Fish alignment (Ingest's
 * paragraph-spans.json, bound by hash to the source.wav cleaned.wav was copied from). A recording's come from a
 * transcript of the cut, aligned to the post the same way Align does it.
 */
export async function paragraphSpans(runDir: string, cleaned: string): Promise<ParagraphSpan[]> {
  const paths = runPaths(runDir), meta = readJson<RunMeta>(paths.meta);
  if (isSynthesizedNarrator(meta.narrator)) {
    const file = join(paths.narration, PARAGRAPH_SPANS_FILE);
    invariant(existsSync(file), `${PARAGRAPH_SPANS_FILE} missing; re-ingest the ${meta.narrator} take`);
    const record = readJson<ParagraphSpansRecord>(file);
    invariant(record.sha256 === sha256(readFileSync(join(paths.narration, "source.wav"))), `${PARAGRAPH_SPANS_FILE} belongs to another take; re-ingest`);
    return record.spans;
  }
  const post = readJson<Post>(join(paths.source, "post.json"));
  const { words, duration } = await transcribeWords(cleaned, paths.narration);
  const spans = spansFromWords(alignWords(post, words, duration).words);
  invariant(spans.length > 0, "the recording's transcript matched no paragraph of the post");
  return spans;
}

/** Spans, then the match, then the report beside the audio. A range left over the target is said out loud. */
export async function levelParagraphs(runDir: string, input: string, output: string): Promise<LevelReport> {
  const report = await matchParagraphLevels(input, output, await paragraphSpans(runDir, input));
  writeJson(join(runPaths(runDir).narration, "paragraph-levels.json"), report);
  const clamped = report.paragraphs.filter((p) => p.clamped).map((p) => p.p);
  console.log(`paragraph levels: range ${report.rangeBefore.toFixed(2)} → ${report.rangeAfter.toFixed(2)} LU (target ${report.target.toFixed(2)} LUFS)`);
  if (report.rangeAfter > PARAGRAPH_RANGE_TARGET_LU) console.log(`⚠ paragraph range ${report.rangeAfter.toFixed(2)} LU is over ${PARAGRAPH_RANGE_TARGET_LU} LU${clamped.length ? `; capped at ±${MATCH_MAX_GAIN_DB} dB: ${clamped.join(", ")}` : ""}`);
  return report;
}

export async function clean(runDir: string, deps: { execute?: typeof command; render?: typeof exitCode; level?: typeof levelParagraphs; normalize?: typeof finalAudioPass; approve?: number[]; reject?: number[] } = {}): Promise<number> {
  const paths = runPaths(runDir), meta = readJson<RunMeta>(paths.meta);
  invariant(meta.mode === "voice" && isNarrator(meta.narrator), "Clean requires a voice run with a narrator (recorded, clone or da)");
  ensureDir(paths.narration);
  const output = join(paths.narration, "cleaned.wav"), planPath = join(paths.narration, "cutplan.json");
  // Invalidate downstream narration before any gate; a failed rerun cannot leave playable stale audio.
  rmSync(paths.narrationWav, { force: true });
  if (isSynthesizedNarrator(meta.narrator)) {
    // A synthesized take is the post's exact words: nothing to cut, so it goes straight to the level match.
    const source = join(paths.narration, "source.wav");
    invariant(existsSync(source), `${meta.narrator} source missing`);
    copyFileSync(source, output);
    writeJson(planPath, { spans: [], narrator: meta.narrator });
  } else {
    const provenance = readJson<{ file: string; sha256: string }>(join(paths.narration, "provenance.json"));
    invariant(/^source\.[a-z0-9]+$/.test(provenance.file), "invalid provenance source filename");
    const source = join(paths.narration, provenance.file);
    invariant(sha256(readFileSync(source)) === provenance.sha256, "source recording hash changed");
    const tool = resolveTightCutEngine();
    invariant(tool !== undefined, "cleaning a recorded reading needs a tight-cut engine: a sibling skill shipping Tools/TightCut.ts, or LIFEOS_TIGHTCUT_ENGINE naming one; a synthesized narrator needs none");
    const { planHash } = (await import(tool)) as { planHash: (spans: PlanSpan[], protect: CutPlan["protect"]) => string };
    const execute = deps.execute ?? command;
    const work = join(paths.narration, `.tightcut-${basename(source, extname(source))}-${provenance.sha256.slice(0, 8)}`);
    const enginePlan = join(work, "cutplan.json");
    if (!existsSync(enginePlan)) await execute(["bun", tool, source, "--out", output, "--plan-only"]);
    const plan = readJson<CutPlan>(enginePlan);
    invariant(plan.inputHash === provenance.sha256, "cut plan belongs to another recording");
    const rulings = recordRulings(join(paths.narration, "rulings.json"), provenance.sha256, deps.approve ?? [], deps.reject ?? []);
    plan.spans = holdRiskySpans(plan.spans, rulings);
    plan.hash = planHash(plan.spans, plan.protect);
    writeJson(planPath, plan);
    const held = plan.spans.filter(s => s.status === "needs-review");
    if (held.length) {
      for (const s of held) console.log(`needs-review #${s.id} ${s.start.toFixed(3)}–${s.end.toFixed(3)}s: ${s.prev} [${s.words.join(" ")}] ${s.next}`);
      console.log("listen, then: Clean.ts --run <slug> --approve <ids> | --reject <ids>");
      return 3;
    }
    const code = await (deps.render ?? exitCode)(["bun", tool, source, "--out", output, "--render-plan", planPath]);
    const gatePath = join(work, "gate.json");
    const gate = existsSync(gatePath) ? readJson<{ ok: boolean }>(gatePath) : { ok: false };
    if (code !== 0 || !gate.ok || !existsSync(output)) {
      console.log(`✗ TightCut gate refused the cut (exit ${code}); nothing downstream was written. Gate: ${gatePath} · plan: ${planPath}`);
      return 4;
    }
  }
  // Every paragraph to the take's median level, then the linear lock, which keeps that evenness.
  const leveled = join(paths.narration, "leveled.wav");
  await (deps.level ?? levelParagraphs)(runDir, output, leveled);
  await (deps.normalize ?? finalAudioPass)(leveled, paths.narrationWav);
  console.log(`✓ cleaned ${meta.narrator} narration`);
  return 0;
}

if (import.meta.main) {
  const run = argValue(process.argv.slice(2), "--run");
  invariant(run, "usage: Clean.ts --run <slug>");
  const ids = (flag: string) => (argValue(process.argv.slice(2), flag) ?? "").split(",").filter(Boolean).map(Number);
  process.exit(await clean(resolveRunDir(run), { approve: ids("--approve"), reject: ids("--reject") }));
}
