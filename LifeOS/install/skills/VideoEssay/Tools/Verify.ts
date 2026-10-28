#!/usr/bin/env bun
/**
 * Verify.ts — reads the rendered file back. A clean plan proves nothing; the render does.
 *
 *   bun Verify.ts --run <slug|dir> [--check duration|format|encode|readscale|frames|detail|sheet|type|presence|clearance|speech|loudness|pii] [--whisper-model base.en]
 *
 * Assay's video eval set (skills/Assay/Tools/VideoEval.ts) runs detail and speech from here one at a time through
 * verify(…, { only, persist: false, video }), so its partial runs never touch Out/verify.json, and reuses encodeVerdict
 * and loudnessCheck. Out/verify.json records the sha256 of the video it measured and of Script.json, so the eval stage
 * that follows takes this run's format, encode, detail, speech and pii results for those exact bytes instead of running
 * whisper and the PII upload a second time.
 *
 * Checks (all run by default; results in Out/verify.json, exit 1 on any failure):
 *   format    1920x1080, 30 fps, h264 video + aac audio
 *   duration  container duration = timeline total ± 0.5 s
 *   frames    one frame at every beat midpoint and 0.6 s into every chapter → Out/frames/ (for reading)
 *   sheet     the studio review pass, one look each: Out/review/contact-sheet.png (a frame every 5 s, 8 across),
 *             motion-strip.png (8 frames across every beat, one row per beat), waveform.png, spectrogram.png
 *   presence  the presence signal carries materially more accent between a frame inside a beat gap and a frame
 *             mid-word: the bars over the avatar (essay) or the signal of the presenter's badge design (voice)
 *   clearance voice only: at every word midpoint the highlighted sentence lies wholly outside the badge box
 *   speech    whisper transcript of the rendered audio vs the script narration, WER ≤ 0.08
 *   loudness  integrated loudness −16 ± 2 LUFS (ebur128); voice mode −14 ± 1 LUFS and true peak ≤ −0.5 dBTP
 *   pii       VideoPiiGate report → Out/pii.json (findings are for the user; never auto-fail)
 *   encode    the encoder's own record in the stream: x264 rate control CRF at or below ENCODE_CRF_MAX (text needs a low QP)
 *   readscale voice only: the reading camera never enlarges page pixels (read scale ≤ READ.maxScale)
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { isImageUrl } from "./Capture.ts";
import { cardSeconds } from "./Motion.ts";

/** The moment that shows a beat's own visual: its midpoint, or for a chapter-opening beat the midpoint of what follows the chapter card. */
export const beatFrameTime = (b: { start: number; end: number }, opensChapter: boolean): number => ((opensChapter ? Math.min(b.end - 0.25, b.start + cardSeconds) : b.start) + b.end) / 2;
import { join } from "node:path";
import { getLifeosDir } from "../../../LIFEOS/TOOLS/Paths.ts";
import { runMode, type RunMode } from "./Build.ts";
import { ENCODE_CRF_MAX, FPS, HEIGHT, OUTPUT_SCALE, TARGET_LUFS, VOICE_TARGET_LUFS, VOICE_TRUE_PEAK, WIDTH, argValue, ensureDir, hasFlag, loadScript, loadTimeline, normalizeText, resolveRunDir, runPaths, writeJson, type Timeline, loadPalette, configuredFaces, houseTypeProblems, houseTypeRolesPath } from "./Lib.ts";
import { invariant } from "../../../LIFEOS/TOOLS/Invariant.ts";
import { sha256File } from "../../../LIFEOS/TOOLS/lib/ProofReceipt.ts";
import { badgeSignalRect, DEFAULT_BADGE, isBadgeVariant, READ, VOICE_LAYOUT, type BadgeVariant, type Rect } from "./Theme.ts";
import type { EssayProps as StagedProps } from "./CompositionTypes.ts";
import { markRectsOnFrame, readCamera, readFrameAt, readLayout } from "./ReadCamera.ts";
import { presenterConfig } from "./Setup.ts";

/**
 * The nine signal bars only: the bottom band of the 200 px presence circle (bars x 1733–1827, baseline y 1016,
 * tops to y 970), over the dark scrim, and clear of the accent ring (inner edge x 1722/1837 at the crop's last row).
 * Geometry lives in PagePresence.ts PRESENCE.
 */
export const PRESENCE_REGION = { x: 1725, y: 968, w: 110, h: 50 };

/** A crop of the frame, in frame pixels. */
export type PresenceRegion = Rect;

/**
 * The region the presence check measures, by run mode. Essay: PRESENCE_REGION, the bars over the DA avatar,
 * unchanged. Voice: the signal rect of the badge design the run wears (Theme VOICE_LAYOUT.badge.signals), which
 * by construction holds the audio marks on an opaque backing and never the portrait or the name line.
 */
export function presenceRegion(mode: RunMode, badge: BadgeVariant = DEFAULT_BADGE): PresenceRegion {
  if (mode === "essay") return PRESENCE_REGION;
  return badgeSignalRect(badge);
}

/** The props a run was last rendered with (Out/render.json names them), or undefined before the first render. */
export function renderedProps(runDir: string): StagedProps | undefined {
  const rec = join(runPaths(runDir).out, "render.json");
  if (!existsSync(rec)) return undefined;
  const propsPath = (JSON.parse(readFileSync(rec, "utf8")) as { props?: unknown }).props;
  if (typeof propsPath !== "string" || !existsSync(propsPath)) return undefined;
  return JSON.parse(readFileSync(propsPath, "utf8")) as StagedProps;
}

/** The accent a run was rendered in: the rendered props' accent, else the configured one. */
export function runAccent(props: StagedProps | undefined): string {
  return typeof props?.accent === "string" && /^#[\da-f]{6}$/i.test(props.accent) ? props.accent : loadPalette().accent;
}

/** The badge a voice run wears: the rendered props' choice, else the configured one. */
export function runBadge(props: StagedProps | undefined): BadgeVariant {
  if (isBadgeVariant(props?.badge)) return props.badge;
  return presenterConfig()?.badge ?? DEFAULT_BADGE;
}

const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * Word midpoints at which the highlighted sentence touches the badge box, from the same camera the render uses.
 * Empty means the badge never covers the line being read.
 */
export function badgeCollisions(props: Pick<StagedProps, "post" | "timeline" | "script">): { t: number; sentence: string }[] {
  if (!props.post) return [];
  const words = props.timeline.beats.flatMap((b) => b.words);
  const cam = readCamera(props.post, words);
  const box = VOICE_LAYOUT.badge.box;
  const reading = props.timeline.beats.filter((b, i) => props.script.beats[i]?.visual.type === "read");
  const hits: { t: number; sentence: string }[] = [];
  for (const b of reading) for (const w of b.words) {
    const t = (w.s + w.e) / 2;
    const rects = markRectsOnFrame(cam, t);
    if (rects.some((r) => overlaps(r, box))) hits.push({ t, sentence: readFrameAt(cam, t).current?.id ?? "?" });
  }
  return hits;
}
export const WER_MAX = 0.08;

/**
 * The encoder's settings as x264 records them in the stream (its "options:" SEI), or null when the stream carries
 * none (another encoder, or a stripped stream): the rate-control mode, and the rate factor when it is CRF.
 */
export function x264Settings(bytes: string): { rc: string; crf: number | null } | null {
  const m = /x264 - core \d+[^\0]*?options: ([^\0]*)/.exec(bytes);
  if (!m) return null;
  const rc = /(?:^| )rc=(\w+)/.exec(m[1])?.[1];
  if (!rc) return null;
  const crf = /(?:^| )crf=([\d.]+)/.exec(m[1]);
  return { rc, crf: crf ? Number(crf[1]) : null };
}

/** The encode floor: CRF rate control at or below `max`. A bitrate-targeted or unreadable encode fails. */
export function encodeVerdict(s: ReturnType<typeof x264Settings>, max = ENCODE_CRF_MAX): { ok: boolean; detail: string } {
  if (!s) return { ok: false, detail: "no x264 settings record in the stream: the encoder and its rate control cannot be checked" };
  if (s.rc !== "crf" || s.crf === null) return { ok: false, detail: `rate control is ${s.rc}, not CRF: a bitrate target starves text on flat paper` };
  return { ok: s.crf <= max, detail: `x264 CRF ${s.crf} (floor: CRF ≤ ${max})` };
}

/** The reading camera may shrink page pixels, never enlarge them: a capture too coarse for the layout fails here. */
export function readScaleVerdict(scale: number, max: number = READ.maxScale): { ok: boolean; detail: string } {
  return { ok: scale <= max + 1e-9, detail: `read scale ${scale.toFixed(3)} page px per frame px (must be ≤ ${max})` };
}

// ---------- pure ----------

/** Word error rate via Levenshtein over normalized tokens. */
export function wordErrorRate(reference: string, hypothesis: string): number {
  const r = normalizeText(reference).split(" ").filter(Boolean);
  const h = normalizeText(hypothesis).split(" ").filter(Boolean);
  if (r.length === 0) return h.length === 0 ? 0 : 1;
  let prev = Array.from({ length: h.length + 1 }, (_, j) => j);
  for (let i = 1; i <= r.length; i++) {
    const cur = [i];
    for (let j = 1; j <= h.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (r[i - 1] === h[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[h.length] / r.length;
}

/** A time inside a beat gap (silence) and candidate mid-word times: the longest word of several beats. */
export const PRESENCE_RATIO_MIN = 1.5;
/**
 * Fraction of the crop painted in the accent colour (the signal marks), via a fuzzy colour mask. Everything
 * outside the accent's fuzz goes black first and only then is the accent turned white, so a light backing
 * (the voice badges sit on paper and card stock) can never be mistaken for signal.
 */
export async function accentArea(png: string, accent: string): Promise<number> {
  const r = await sh(["magick", png, "-fuzz", "30%", "-fill", "black", "+opaque", accent, "-fill", "white", "-opaque", accent, "-format", "%[fx:mean]", "info:"]);
  return Number(r.out.trim());
}

/**
 * `pauseCandidates` are the midpoints of the longest gaps between aligned words, longest first. A gap in the word
 * list is not always silence: alignment can drop words it could not match, and the audio keeps speaking through the
 * hole (dropped words can make a multi-second "pause" the check samples mid-speech, failing a render whose badge
 * moved correctly). Verify takes the quietest of them, the mirror of taking the strongest speech sample.
 */
export function presenceSampleTimes(tl: Timeline, candidates = 5): { pause: number; pauseCandidates: number[]; speech: number; speechCandidates: number[] } {
  const n = tl.beats.length;
  const gapAfter = tl.beats[Math.min(1, n - 1)];
  const words = tl.beats.flatMap(b => b.words);
  const pauses = words.map((w, i) => ({ start: w.e, end: words[i + 1]?.s ?? tl.total })).concat([{ start: 0, end: words[0]?.s ?? 0 }]);
  const longest = pauses.sort((a, b) => (b.end - b.start) - (a.end - a.start)).slice(0, candidates);
  const pauseCandidates = tl.gap > 0 ? [gapAfter.end + tl.gap / 2] : longest.map((p) => (p.start + p.end) / 2);
  const pause = pauseCandidates[0];
  const picks = Array.from({ length: Math.min(candidates, n) }, (_, i) => tl.beats[Math.floor(((i + 1) * n) / (Math.min(candidates, n) + 1))]);
  const speechCandidates = picks.map((b) => {
    // The last word's alignment end absorbs the chunk's trailing silence, so it is never a candidate;
    // among the rest, the longest word with a sane duration is the loudest bet.
    const inner = b.words.slice(0, -1).filter((w) => w.e - w.s <= 1.5);
    const longest = [...inner].sort((a, c) => (c.e - c.s) - (a.e - a.s))[0];
    return longest ? (longest.s + longest.e) / 2 : (b.start + b.end) / 2;
  });
  return { pause, pauseCandidates, speech: speechCandidates[0], speechCandidates };
}

/** Sample times for the motion strip: n evenly spaced frames inside [start, end). */
export function stripTimes(start: number, end: number, n = 8): number[] {
  const span = end - start;
  return Array.from({ length: n }, (_, i) => start + (span * (i + 0.5)) / n);
}

// ---------- live ----------

/**
 * Cut the presence region out of a frame. accentArea's %[fx:mean] averages every channel, so an alpha channel
 * (a PNG frame with one, or any drawing step) would add 0.25 to both crops and squash the speech/pause ratio
 * toward 1; the crop is always written without alpha.
 */
export async function cropPresence(frame: string, region: PresenceRegion, out: string): Promise<void> {
  await sh(["magick", frame, "-crop", `${region.w}x${region.h}+${region.x}+${region.y}`, "+repage", "-alpha", "off", out]);
}

async function sh(cmd: string[], opts: { allowFail?: boolean; cwd?: string } = {}): Promise<{ code: number; out: string; err: string }> {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", cwd: opts.cwd });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0 && !opts.allowFail) throw new Error(`${cmd.slice(0, 2).join(" ")} failed (${code}): ${err.slice(-400)}`);
  return { code, out, err };
}

/** The studio review pass: contact sheet, per-beat motion strip, waveform, spectrogram. All from the rendered file. */
export async function reviewSheets(video: string, tl: Timeline, dir: string, opts: { every?: number; across?: number; accent?: string } = {}): Promise<string[]> {
  const every = opts.every ?? 5, across = opts.across ?? 8, accent = opts.accent ?? loadPalette().accent;
  const contact = join(dir, "contact-sheet.png");
  const stampFont = configuredFaces().find((face) => face.id === "mono")?.path;
  invariant(stampFont, "Config.json fonts has no mono face to draw the review-sheet labels");
  const rows = Math.max(1, Math.ceil(tl.total / every / across));
  // Timestamps are drawn by ImageMagick, not ffmpeg's drawtext: some ffmpeg builds (Homebrew's, for one) ship without
  // drawtext, and the sheet would fail the whole verify stage on one.
  const cells = join(dir, ".contact-cells");
  rmSync(cells, { recursive: true, force: true });
  ensureDir(cells);
  await sh(["ffmpeg", "-y", "-v", "error", "-i", video, "-vf", `fps=1/${every}:start_time=0,scale=240:-1`, join(cells, "c%04d.png")]);
  const frames = readdirSync(cells).filter((f) => f.endsWith(".png")).sort();
  // A named face, never ImageMagick's default: a build with no fonts registered fails every unnamed -annotate and montage with
  // "unable to read font `'" (ImageMagick 7.1.2-32, 2026-10-24). The run's own mono face draws the stamps.
  for (const [i, f] of frames.entries()) {
    const s = i * every;
    const stamp = `${String(Math.floor(s / 3600)).padStart(2, "0")}:${String(Math.floor(s / 60) % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}.000`;
    await sh(["magick", join(cells, f), "-font", stampFont, "-gravity", "NorthWest", "-fill", "white", "-undercolor", "#00000099", "-pointsize", "16", "-annotate", "+6+6", stamp, join(cells, f)]);
  }
  await sh(["magick", "montage", "-font", stampFont, ...frames.map((f) => join(cells, f)), "-tile", `${across}x${rows}`, "-geometry", "+2+2", "-background", "black", contact]);
  rmSync(cells, { recursive: true, force: true });
  const strip = join(dir, "motion-strip.png");
  // One input-seeked grab per cell, tiled by ImageMagick. A single select='eq(n,…)+…' expression over every cell ran
  // ffmpeg out of memory on a long render with many beats ("Cannot allocate memory" at filter init), and it
  // decoded the whole video to find them; a seek per cell holds one frame at a time.
  const stripCells = join(dir, ".strip-cells");
  rmSync(stripCells, { recursive: true, force: true });
  ensureDir(stripCells);
  const grabs: string[] = [];
  for (const [bi, b] of tl.beats.entries()) {
    for (const [ci, t] of stripTimes(b.start, b.end + tl.gap, across).entries()) {
      const cell = join(stripCells, `b${String(bi).padStart(3, "0")}c${ci}.png`);
      await sh(["ffmpeg", "-y", "-v", "error", "-ss", Math.min(t, tl.total - 1 / tl.fps).toFixed(3), "-i", video, "-frames:v", "1", "-vf", "scale=200:-1", cell]);
      grabs.push(cell);
    }
  }
  await sh(["magick", "montage", "-font", stampFont, ...grabs, "-tile", `${across}x${tl.beats.length}`, "-geometry", "+2+2", "-background", "black", strip]);
  rmSync(stripCells, { recursive: true, force: true });
  const wave = join(dir, "waveform.png");
  await sh(["ffmpeg", "-y", "-v", "error", "-i", video, "-filter_complex", `[0:a]showwavespic=s=1920x240:colors=${accent}|${accent}`, "-frames:v", "1", wave]);
  const spec = join(dir, "spectrogram.png");
  await sh(["ffmpeg", "-y", "-v", "error", "-i", video, "-lavfi", "showspectrumpic=s=1920x480:legend=0", spec]);
  return [contact, strip, wave, spec];
}

/** The least share of its source's edge detail a shown image may keep; the blurry 2026-10-24 render kept 67%. */
export const DETAIL_MIN = 0.85;

async function extractFrame(video: string, t: number, out: string, scaleWidth?: number): Promise<void> {
  // Frames come back in composition pixels (WIDTH wide) whatever the output scale, so every geometric check holds.
  const vf = ["-vf", `scale=${scaleWidth ?? WIDTH}:-1:flags=lanczos`];
  await sh(["ffmpeg", "-y", "-v", "error", "-ss", t.toFixed(3), "-i", video, "-frames:v", "1", ...vf, out]);
}

type Check = { name: string; ok: boolean; detail: string };

/**
 * `video` reads another rendered file of the run in place of Out/essay.mp4; `persist: false` leaves Out/verify.json
 * alone, so a caller running one check (Assay's video eval set, `skills/Assay/Tools/VideoEval.ts`) never overwrites the
 * full record with a partial one.
 */
export async function verify(runDir: string, opts: { only?: string; whisperModel?: string; log?: (s: string) => void; video?: string; persist?: boolean } = {}): Promise<{ ok: boolean; checks: Check[] }> {
  const log = opts.log ?? ((s) => console.log(s));
  const paths = { ...runPaths(runDir), ...(opts.video ? { video: opts.video } : {}) };
  const script = loadScript(runDir);
  const tl = loadTimeline(runDir);
  const checks: Check[] = [];
  const want = (n: string) => !opts.only || opts.only === n;
  if (!existsSync(paths.video)) return { ok: false, checks: [{ name: "exists", ok: false, detail: `${paths.video} missing` }] };
  ensureDir(paths.frames);

  if (want("format")) {
    const { out } = await sh(["ffprobe", "-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height,r_frame_rate", "-of", "json", paths.video]);
    const streams = (JSON.parse(out).streams as any[]);
    const v = streams.find((s) => s.codec_type === "video");
    const a = streams.find((s) => s.codec_type === "audio");
    const fps = v ? (() => { const [n, d] = String(v.r_frame_rate).split("/").map(Number); return n / d; })() : 0;
    const ok = !!v && v.codec_name === "h264" && v.width === WIDTH * OUTPUT_SCALE && v.height === HEIGHT * OUTPUT_SCALE && Math.round(fps) === FPS && !!a && a.codec_name === "aac";
    checks.push({ name: "format", ok, detail: `${v?.codec_name} ${v?.width}x${v?.height}@${fps.toFixed(2)} + ${a?.codec_name}` });
  }
  if (want("encode")) {
    // x264's SEI rides in the first frame, which faststart puts right after the small moov: the first 16 MB hold it.
    const head = Buffer.from(await Bun.file(paths.video).slice(0, 16 * 1024 * 1024).arrayBuffer()).toString("latin1");
    const { out } = await sh(["ffprobe", "-v", "error", "-select_streams", "v", "-show_entries", "stream=bit_rate", "-of", "csv=p=0", paths.video]);
    const v = encodeVerdict(x264Settings(head));
    checks.push({ name: "encode", ok: v.ok, detail: `${v.detail}; video ${(Number(out.trim()) / 1e6).toFixed(2)} Mbps` });
  }
  if (want("readscale") && runMode(runDir) === "voice") {
    const props = renderedProps(runDir);
    if (!props?.post) checks.push({ name: "readscale", ok: false, detail: "no Out/render.json post to measure the reading layout from" });
    else checks.push({ name: "readscale", ...readScaleVerdict(readLayout(props.post).scale) });
  }
  if (want("duration")) {
    const { out } = await sh(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", paths.video]);
    const d = Number(out.trim());
    checks.push({ name: "duration", ok: Math.abs(d - tl.total) <= 0.5, detail: `rendered ${d.toFixed(2)}s vs timeline ${tl.total.toFixed(2)}s` });
  }
  if (want("frames")) {
    let n = 0;
    // A chapter-opening beat's frame is taken from the part after its chapter card, so it shows the beat's own visual.
    const opensChapter = new Set(script.beats.filter((b) => b.chapter).map((b) => b.id));
    for (const b of tl.beats) { await extractFrame(paths.video, beatFrameTime(b, opensChapter.has(b.id)), join(paths.frames, `${b.id}.png`), 960); n++; }
    let c = 0;
    for (const b of script.beats) if (b.chapter) { const t = tl.beats.find((x) => x.id === b.id)!; await extractFrame(paths.video, t.start + 0.6, join(paths.frames, `chapter-${++c}-${b.id}.png`), 960); }
    checks.push({ name: "frames", ok: n === tl.beats.length, detail: `${n} beat frames + ${c} chapter frames in Out/frames/` });
  }
  if (want("detail")) {
    // A shown image keeps the detail of its source (principal directive, 2026-10-24: the first explainer went out "massively blurry"
    // and no check measured it). Each screenshot of an image file is read back at full output size, cropped to the image
    // on screen, and its edge energy (Laplacian standard deviation) compared with the original resized to the same width.
    const rows: string[] = [];
    let worst = Infinity;
    for (const b of script.beats) {
      const v = b.visual as { type?: string; url?: string };
      const metaPath = join(paths.assets, `${b.id}.meta.json`);
      if (v.type !== "screenshot" || !v.url || !isImageUrl(v.url) || !existsSync(metaPath)) continue;
      const beat = tl.beats.find((x) => x.id === b.id);
      if (!beat) continue;
      const frame = join(paths.out, `.detail-${b.id}.png`);
      await sh(["ffmpeg", "-y", "-v", "error", "-ss", ((beat.start + beat.end) / 2).toFixed(3), "-i", paths.video, "-frames:v", "1", frame]);
      const box = (await sh(["magick", frame, "-colorspace", "gray", "-threshold", "75%", "-format", "%@", "info:"])).out.trim().match(/^(\d+)x(\d+)\+(\d+)\+(\d+)$/);
      if (!box) { rows.push(`${b.id}: image not found on screen`); worst = 0; continue; }
      const [w, hgt, x, y] = box.slice(1).map(Number), inset = 12 * OUTPUT_SCALE;
      const lap = async (args: string[]) => Number((await sh(["magick", ...args, "-colorspace", "gray", "-morphology", "Convolve", "Laplacian:0", "-format", "%[fx:standard_deviation]", "info:"])).out.trim());
      const shown = await lap([frame, "-crop", `${w - 2 * inset}x${hgt - 2 * inset}+${x + inset}+${y + inset}`, "+repage"]);
      // The source is the original file at its URL, not the captured asset, so a lossy capture step fails here too.
      const original = join(paths.out, `.detail-${b.id}.src`);
      const res = await fetch(v.url, { signal: AbortSignal.timeout(60_000) });
      if (!res.ok) { rows.push(`${b.id}: source ${res.status}`); worst = 0; rmSync(frame, { force: true }); continue; }
      await Bun.write(original, new Uint8Array(await res.arrayBuffer()));
      const source = await lap([original, "-resize", `${w}x`]);
      rmSync(original, { force: true });
      rmSync(frame, { force: true });
      const ratio = source > 0 ? shown / source : 0;
      worst = Math.min(worst, ratio);
      rows.push(`${b.id} ${(ratio * 100).toFixed(0)}%`);
    }
    checks.push({ name: "detail", ok: worst === Infinity || worst >= DETAIL_MIN, detail: rows.length ? `shown edge detail vs source (need ≥ ${DETAIL_MIN * 100}%): ${rows.join(", ")}` : "no screenshots of image files" });
  }
  if (want("sheet")) {
    const review = ensureDir(join(paths.out, "review"));
    const files = await reviewSheets(paths.video, tl, review, { accent: runAccent(renderedProps(runDir)) });
    const sizes = await Promise.all(files.map(async (f) => (await sh(["magick", "identify", "-format", "%w %h", f])).out.trim()));
    const ok = files.every((f) => existsSync(f)) && sizes.every((s) => Number(s.split(" ")[0]) > 0);
    checks.push({ name: "sheet", ok, detail: files.map((f, i) => `${f.split("/").pop()} ${sizes[i]}`).join(", ") });
  }
  if (want("type")) {
    // The house type system (principal directive, 2026-10-24). An install with no
    // TypeRoles.json has no house system to hold, and the check says so instead of passing.
    const path = houseTypeRolesPath();
    if (!existsSync(path)) checks.push({ name: "type", ok: true, detail: `skipped: no house type system at ${path}` });
    else {
      const problems = houseTypeProblems(configuredFaces(), JSON.parse(readFileSync(path, "utf8")));
      checks.push({ name: "type", ok: problems.length === 0, detail: problems.length ? problems.join("; ") : "every type role is in its house face and case" });
    }
  }
  if (want("presence")) {
    const { pauseCandidates, speechCandidates } = presenceSampleTimes(tl);
    const mode = runMode(runDir);
    const staged = renderedProps(runDir);
    const badge = mode === "voice" ? runBadge(staged) : undefined;
    const accent = runAccent(staged);
    const region = presenceRegion(mode, badge);
    // A gap in the aligned words can hide speech the aligner dropped; the quietest of the longest gaps is the pause.
    const ca = join(paths.frames, "presence-pause-crop.png");
    let pause = pauseCandidates[0], pauseArea = Infinity;
    for (const [i, t] of pauseCandidates.entries()) {
      const a = join(paths.frames, `presence-pause-${i}.png`), c = join(paths.frames, `presence-pause-${i}-crop.png`);
      await extractFrame(paths.video, t, a);
      await cropPresence(a, region, c);
      const area = await accentArea(c, accent);
      if (area < pauseArea) { pauseArea = area; pause = t; copyFileSync(c, ca); }
    }
    // The voice is quiet at some instants even mid-word; take the strongest of several mid-word samples.
    // The measure is the accent-coloured area of the signal: at rest it is a row (essay) or ring (voice) of dots, mid-word the marks rise,
    // so the speech crop carries materially more accent pixels than the pause crop. RMSE over the crop is
    // reported too, but it flattens once the bars are a small part of the region (0.043 on a good render).
    let best = { ratio: 0, rmse: 0, t: speechCandidates[0] };
    for (const [i, t] of speechCandidates.entries()) {
      const b = join(paths.frames, `presence-speech-${i}.png`);
      const cb = join(paths.frames, `presence-speech-${i}-crop.png`);
      await extractFrame(paths.video, t, b);
      await cropPresence(b, region, cb);
      const r = await sh(["magick", "compare", "-metric", "RMSE", ca, cb, "null:"], { allowFail: true });
      const rmse = Number((r.err.match(/\(([\d.]+)\)/) ?? [])[1] ?? NaN);
      const ratio = (await accentArea(cb, accent)) / Math.max(pauseArea, 1e-6);
      if (ratio > best.ratio) best = { ratio, rmse, t };
    }
    checks.push({ name: "presence", ok: best.ratio >= PRESENCE_RATIO_MIN, detail: `${mode === "voice" ? `badge ${badge} signal` : "bars"} area ×${best.ratio.toFixed(2)} (RMSE ${best.rmse.toFixed(4)}) between pause@${pause.toFixed(2)}s and speech@${best.t.toFixed(2)}s (best of ${speechCandidates.length}; need ≥ ×${PRESENCE_RATIO_MIN})` });
  }
  if (want("clearance") && runMode(runDir) === "voice") {
    const props = renderedProps(runDir);
    if (!props) checks.push({ name: "clearance", ok: false, detail: "no Out/render.json props to replay the reading camera from" });
    else {
      const hits = badgeCollisions(props);
      const words = props.timeline.beats.reduce((n, b, i) => n + (props.script.beats[i]?.visual.type === "read" ? b.words.length : 0), 0);
      checks.push({ name: "clearance", ok: hits.length === 0, detail: hits.length === 0 ? `highlighted sentence clear of the badge at all ${words} read-word midpoints` : `${hits.length} word midpoint(s) with the highlight under the badge, first at ${hits[0].t.toFixed(2)}s (${hits[0].sentence})` });
    }
  }
  if (want("speech")) {
    const wav = join(paths.out, "rendered-audio.wav");
    await sh(["ffmpeg", "-y", "-v", "error", "-i", paths.video, "-vn", "-ar", "16000", "-ac", "1", wav]);
    const model = opts.whisperModel ?? "base.en";
    const outDir = ensureDir(join(paths.out, "whisper"));
    await sh(["whisper", wav, "--model", model, "--language", "en", "--output_format", "txt", "--output_dir", outDir, "--fp16", "False", "--verbose", "False"]);
    const hyp = readFileSync(join(outDir, "rendered-audio.txt"), "utf8");
    const ref = script.beats.map((b) => b.narration).join(" ");
    const wer = wordErrorRate(ref, hyp);
    checks.push({ name: "speech", ok: wer <= WER_MAX, detail: `WER ${(wer * 100).toFixed(1)}% (${model}), max ${WER_MAX * 100}%` });
  }
  if (want("loudness")) {
    const mode = runMode(runDir);
    const r = await sh(["ffmpeg", "-v", "info", "-i", paths.video, "-vn", "-af", `ebur128=framelog=quiet${mode === "voice" ? ":peak=true" : ""}`, "-f", "null", "-"], { allowFail: true });
    checks.push(loudnessCheck(mode, r.err));
  }
  if (want("pii")) {
    const gate = join(getLifeosDir(), "TOOLS", "VideoPiiGate.ts");
    const report = join(paths.out, "pii.json");
    // A report left by an earlier run must never stand in for this one (a gate that exits non-zero without writing
    // a report would otherwise leave a stale CLEAN one to be read as its result).
    rmSync(report, { force: true });
    const r = await sh(["bun", gate, paths.video, "--low", "--json", "--out", report], { allowFail: true });
    const ran = existsSync(report);
    let findings = -1;
    if (ran) { try { findings = (JSON.parse(readFileSync(report, "utf8")).findings ?? []).length; } catch { /* keep -1 */ } }
    checks.push({ name: "pii", ok: ran && r.code !== 2, detail: ran && r.code === 2 ? `gate exited 2 (${r.err.slice(-200).trim()})` : ran ? `${findings} finding(s) for review in Out/pii.json` : `gate did not run (${r.err.slice(-200)})` });
  }
  const ok = checks.every((c) => c.ok);
  if (opts.persist !== false) {
    // The bytes measured, so a later reader (the eval stage) can tell these results are for the file it holds.
    const [sha256, scriptSha256] = [await sha256File(paths.video), createHash("sha256").update(readFileSync(runPaths(runDir).script)).digest("hex")];
    invariant(/^[0-9a-f]{64}$/.test(sha256) && /^[0-9a-f]{64}$/.test(scriptSha256), "verify.json binds the video and script sha256");
    writeJson(paths.verify, { verifiedAt: new Date().toISOString(), ok, sha256, scriptSha256, video: paths.video, checks });
  }
  for (const c of checks) log(`${c.ok ? "✓" : "✗"} ${c.name}: ${c.detail}`);
  return { ok, checks };
}

/**
 * Essay mode: integrated −16 ± 2 LUFS. Voice mode: the house delivery lock Clean applies (−14 LUFS, −1 dBTP), with
 * ±1 LU and 0.5 dB of true-peak room for the render's AAC re-encode of the locked track, which moves integrated
 * loudness by tenths and can raise inter-sample peaks a few tenths above the lock.
 */
export function loudnessCheck(mode: RunMode, ebur128Log: string): Check {
  const I = Number(ebur128Log.match(/I:\s+(-?[\d.]+) LUFS/)?.[1] ?? NaN);
  if (mode !== "voice") return { name: "loudness", ok: Math.abs(I - TARGET_LUFS) <= 2, detail: `integrated ${I} LUFS (target ${TARGET_LUFS} ± 2)` };
  const tp = Number(ebur128Log.match(/True peak:\s+Peak:\s+(-?[\d.]+)/)?.[1] ?? NaN);
  const ok = Math.abs(I - VOICE_TARGET_LUFS) <= 1 && tp <= VOICE_TRUE_PEAK + 0.5;
  return { name: "loudness", ok, detail: `integrated ${I} LUFS, true peak ${tp} dBTP (target ${VOICE_TARGET_LUFS} ± 1 LUFS, ≤ ${VOICE_TRUE_PEAK + 0.5} dBTP)` };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const runArg = argValue(argv, "--run");
  if (!runArg) { console.error("usage: Verify.ts --run <slug|dir> [--check name] [--whisper-model m]"); process.exit(2); }
  const r = await verify(resolveRunDir(runArg), { only: argValue(argv, "--check"), whisperModel: argValue(argv, "--whisper-model") });
  process.exit(r.ok ? 0 : 1);
}
