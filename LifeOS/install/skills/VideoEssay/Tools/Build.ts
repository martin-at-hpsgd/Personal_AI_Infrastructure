#!/usr/bin/env bun
/**
 * Build.ts — stage a run into the composition's public dir and render the essay.
 *
 *   bun Build.ts --run <slug|dir> [--captions] [--stage-only] [--workers N]
 *
 * Staging copies Assets/*.png + regions, Narration/narration.wav (+ bed.wav when a score exists), and the avatar
 * into the user-zone store public/runs/<slug>/ and writes props.json there. Compose.ts then makes that directory a
 * HyperFrames project and renders it through the shared seam to Out/essay.mp4 (1920x1080, 30 fps, H.264 + AAC).
 *
 * Voice runs (run.json mode "voice") also stage the post page for `read` beats: Assets/post.png with its
 * meta and the validated sentence map (post.sentences.json, scaled to image pixels), and the corner shows
 * the presenter from Config.json (the author's portrait and label) instead of the DA. A clone-narrated voice
 * run (run.json narrator "clone") carries the vendor-neutral "AI VOICE CLONE" credit on the badge
 * (Theme VOICE_CREDIT); it names no vendor and needs no logo files. A DA-read voice run
 * (narrator "da") wears Config.json narrators.da instead: the DA's portrait, the author's label (the words are
 * the author's), and a read-by line naming the DA; it never carries the clone credit. A run.json `label` replaces the author
 * label for that run alone; when it names the DA itself (the DA reads a post it wrote), the badge says so.
 */
import { copyFileSync, existsSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { loadLifeosConfig } from "../../../LIFEOS/TOOLS/LifeosConfig.ts";
import { invariant } from "../../../LIFEOS/TOOLS/Invariant.ts";
import { composeEssay, renderEssay } from "./Compose.ts";
import { FPS, HEIGHT, NARRATORS, TARGET_LUFS, VOICE_TARGET_LUFS, VOICE_TRUE_PEAK, WIDTH, argValue, configuredFaces, ensureDir, hasFlag, isNarrator, loadBadgeCopy, loadPalette, loadScript, loadTimeline, normalizeLabel, publicDir, readJson, resolveRunDir, runPaths, writeJson, type Narrator, type Script, type Timeline } from "./Lib.ts";
import type { Region } from "./Capture.ts";
import type { CaptureMeta, ReadPost } from "./CompositionTypes.ts";
import { parsePostSentences, scaleRect, scaleSentences } from "./ReadSync.ts";
import { avatarPath, cornerLogoPath, daNarratorConfig, presenterConfig, type DaNarrator, type Presenter } from "./Setup.ts";
import type { BadgeCopy, BadgeVariant, Palette, StagedFace } from "./Theme.ts";

export type RunMode = "essay" | "voice";
export type { Narrator };

export interface EssayProps {
  slug: string;
  mode: RunMode;
  /** The corner label: the DA in essay mode, the presenter in voice mode. */
  daLabel: string;
  /** The brand accent (Config.json colors.accent): the badge signal, essay ring, progress line and Verify's presence measure. */
  accent: string;
  /** Every render colour (Config.json colors over Theme DEFAULT_PALETTE). */
  palette: Palette;
  captions: boolean;
  bed: boolean;
  assetBase: string;
  script: Script;
  timeline: Timeline;
  regions: Record<string, Region>;
  captures: Record<string, CaptureMeta>;
  /** The faces the page embeds and its font gate checks (no file paths: Compose embeds from Config.json). */
  fonts: StagedFace[];
  post?: ReadPost;
  /** Voice mode: the presenter's badge design (Config.json presenter.badge; Theme BADGE_VARIANTS, e.g. "d-dark"). */
  badge?: BadgeVariant;
  /** Voice mode: who voiced the narration (run.json narrator); "clone" puts the voice-clone credit on the badge, "da" the read-by line. */
  narrator?: Narrator;
  /** Voice mode, DA-read runs: the DA's name for the badge's read-by line (Config.json narrators.da.reader or the DA identity). */
  reader?: string;
  /** Voice mode, DA-read runs: the author's possessive for the read-by line (Config.json possessive, default "their"). */
  possessive?: string;
  /** Voice mode: the words the badge prints (Config.json badge over Theme DEFAULT_BADGE_COPY). */
  badgeCopy?: BadgeCopy;
}

/** The capture id Capture.ts writes the post page under (Assets/post.png, post.meta.json, post.sentences.json). */
export const POST_CAPTURE_ID = "post";

/** run.json mode; absent (every essay run before voice mode) means essay. */
export function runMode(runDir: string): RunMode {
  const meta = runPaths(runDir).meta;
  if (!existsSync(meta)) return "essay";
  const mode = readJson<{ mode?: unknown }>(meta).mode;
  if (mode === undefined || mode === "essay") return "essay";
  if (mode === "voice") return "voice";
  throw new Error(`run.json mode must be "essay" or "voice", got ${JSON.stringify(mode)}`);
}

/** run.json label: this run's badge author, overriding the configured presenter/DA-narrator label; undefined when unset. */
export function runLabel(runDir: string): string | undefined {
  const meta = runPaths(runDir).meta;
  if (!existsSync(meta)) return undefined;
  const label = readJson<{ label?: unknown }>(meta).label;
  if (label === undefined) return undefined;
  if (typeof label !== "string") throw new Error(`run.json label must be a string, got ${JSON.stringify(label)}`);
  return normalizeLabel(label);
}

/** run.json narrator for a voice run: "recorded", "clone" or "da"; absent means the run predates the field (no credit). */
export function runNarrator(runDir: string): Narrator | undefined {
  const meta = runPaths(runDir).meta;
  if (!existsSync(meta)) return undefined;
  const narrator = readJson<{ narrator?: unknown }>(meta).narrator;
  if (narrator === undefined) return undefined;
  if (isNarrator(narrator)) return narrator;
  throw new Error(`run.json narrator must be one of ${NARRATORS.map((n) => `"${n}"`).join(", ")}, got ${JSON.stringify(narrator)}`);
}

/**
 * Who sits in a voice run's corner. A DA-read run wears Config.json narrators.da (always resolvable: the DA avatar
 * is the default portrait); every other voice run wears the author's presenter, undefined when none is configured.
 */
export function voiceCorner(narrator: Narrator | undefined, resolve: { presenter?: () => Presenter | undefined; da?: () => DaNarrator } = {}): Presenter | DaNarrator | undefined {
  return narrator === "da" ? (resolve.da ?? daNarratorConfig)() : (resolve.presenter ?? presenterConfig)();
}

const isDaNarrator = (c: Presenter | DaNarrator): c is DaNarrator => typeof (c as Partial<DaNarrator>).reader === "string";

/** Title and URL of the post (capture source lines, the description): Source/post.json when Ingest wrote it, else the script's source. */
function postIdentity(runDir: string, script: Script): { title: string; url: string } {
  const p = join(runDir, "Source", "post.json");
  if (existsSync(p)) {
    const post = readJson<{ title?: unknown; url?: unknown }>(p);
    if (typeof post.title === "string" && typeof post.url === "string" && post.url) return { title: post.title, url: post.url };
    throw new Error(`${p}: title and url must be strings (url non-empty)`);
  }
  return { title: script.source.title || script.title, url: script.source.url };
}

/** The page background as #rrggbb, sampled just inside the capture's top-left corner. */
export function samplePaper(png: string): string {
  const p = Bun.spawnSync(["magick", png, "-crop", "1x1+8+8", "+repage", "-format", "%[hex:p{0,0}]", "info:"], { stdout: "pipe", stderr: "pipe" });
  const hex = p.stdout.toString().trim().slice(0, 6);
  invariant(p.exitCode === 0 && /^[\dA-F]{6}$/i.test(hex), `paper sample failed on ${png}: ${p.stderr.toString().slice(-200)}`);
  return `#${hex.toUpperCase()}`;
}

/** The post page for read beats, validated against its capture. Undefined when the run has no post capture. */
/**
 * How to show a capture readably, read off its pixels: ink is any pixel more than 60 grey levels off the paper; within
 * the top 4000 rows a column is inked when 2% of its rows are (so a nav line across the top does not join the columns);
 * the text column is the run of inked columns (split at blank gaps of 1.5% of the width) holding the most ink; its text
 * lines, down the whole page, are the runs of rows with ink in that column (runs under 6 rows are rules or specks, and
 * runs over 4 median lines are pictures, so neither is a line); the x-height is half the median line height in the top
 * 4000 rows. Undefined when the top holds no text.
 */
export function captureLayout(png: string, width: number, height: number): CaptureMeta["layout"] {
  const rows = Math.min(height, 4000);
  const p = Bun.spawnSync(["magick", png, "-colorspace", "Gray", "-depth", "8", "gray:-"], { stdout: "pipe", stderr: "pipe" });
  const px = new Uint8Array(p.stdout.buffer, p.stdout.byteOffset, p.stdout.byteLength);
  invariant(p.exitCode === 0 && px.length === width * height, `capture analysis failed on ${png}: ${p.stderr.toString().slice(-200)}`);
  const paperV = px[8 * width + 8];
  const ink = (i: number) => Math.abs(px[i] - paperV) > 60;
  const colInk = new Uint32Array(width);
  for (let y = 0; y < rows; y++) for (let x = 0; x < width; x++) if (ink(y * width + x)) colInk[x]++;
  const gap = Math.max(8, Math.round(width * 0.015));
  const spans: { x0: number; x1: number; mass: number }[] = [];
  let run: { x0: number; x1: number; mass: number } | undefined, blank = 0;
  for (let x = 0; x < width; x++) {
    if (colInk[x] > rows * 0.02) {
      if (!run || blank >= gap) { run = { x0: x, x1: x, mass: 0 }; spans.push(run); }
      run.x1 = x; run.mass += colInk[x]; blank = 0;
    } else blank++;
  }
  const col = spans.sort((a, b) => b.mass - a.mass)[0];
  if (!col) return undefined;
  const runs: [number, number][] = [];
  let top = -1, start = -1;
  for (let y = 0; y <= height; y++) {
    let n = 0;
    if (y < height) for (let x = col.x0; x <= col.x1 && n < 2; x++) if (ink(y * width + x)) n++;
    if (n >= 2) { if (top < 0 && y < rows) top = y; if (start < 0) start = y; }
    else if (start >= 0) { if (y - start >= 6) runs.push([start, y]); start = -1; }
  }
  const heights = runs.filter(([a]) => a < rows).map(([a, b]) => b - a).sort((a, b) => a - b);
  if (top < 0 || heights.length === 0) return undefined;
  const median = heights[Math.floor(heights.length / 2)];
  return { paper: samplePaper(png), column: [col.x0, col.x1 + 1], top, xHeight: median / 2, lines: runs.filter(([a, b]) => b - a <= 4 * median), figures: runs.filter(([a, b]) => b - a > 4 * median) };
}

export function stagePost(runDir: string, script: Script, captures: Record<string, CaptureMeta>): ReadPost | undefined {
  const map = join(runPaths(runDir).assets, `${POST_CAPTURE_ID}.sentences.json`);
  const cap = captures[POST_CAPTURE_ID];
  if (!existsSync(map) || !cap) return undefined;
  const parsed = parsePostSentences(readJson<unknown>(map));
  return { ...postIdentity(runDir, script), image: `${POST_CAPTURE_ID}.png`, width: cap.width, height: cap.height, cssWidth: cap.cssWidth, sentences: scaleSentences(parsed, cap.width), ...(parsed.title ? { titleRect: scaleRect(parsed.title, parsed, cap.width) } : {}), paper: samplePaper(join(runPaths(runDir).assets, `${POST_CAPTURE_ID}.png`)) };
}

/** Every configured face, validated against Config.json and the disk, as the page sees it (family, weight, style). */
export function fontProps(): StagedFace[] {
  return configuredFaces().map(({ id, family, weight, style }) => ({ id, family, weight, style }));
}

export function stageRun(runDir: string, opts: { captions?: boolean } = {}): { props: EssayProps; propsPath: string } {
  const paths = runPaths(runDir);
  const script = loadScript(runDir);
  const timeline = loadTimeline(runDir);
  invariant(existsSync(paths.narrationWav), "narration.wav missing — run narrate first");
  const stage = join(publicDir(), "runs", script.slug);
  rmSync(stage, { recursive: true, force: true });
  ensureDir(stage);
  copyFileSync(paths.narrationWav, join(stage, "narration.wav"));
  const bed = existsSync(paths.bedWav);
  if (bed) copyFileSync(paths.bedWav, join(stage, "bed.wav"));
  const mode = runMode(runDir);
  const narrator = mode === "voice" ? runNarrator(runDir) : undefined;
  invariant(mode !== "voice" || narrator, "voice run needs a run.json narrator (recorded, clone or da): a run with no narrator would render with no voice credit");
  const corner = mode === "voice" ? voiceCorner(narrator) : undefined;
  const label = mode === "voice" ? runLabel(runDir) : undefined;
  const presenter = corner && label ? { ...corner, label } : corner;
  invariant(mode === "essay" || presenter, "voice run needs Config.json presenter.avatar (the author's portrait)");
  const avatar = presenter?.avatar ?? avatarPath();
  invariant(existsSync(avatar), `avatar missing at ${avatar}`);
  copyFileSync(avatar, join(stage, "avatar.png"));
  const logo = cornerLogoPath();
  invariant(!logo || existsSync(logo), `Config.json cornerLogo missing at ${logo}`);
  if (logo) copyFileSync(logo, join(stage, "corner-logo.png"));
  else rmSync(join(stage, "corner-logo.png"), { force: true });
  const regions: Record<string, Region> = {};
  const captures: Record<string, CaptureMeta> = {};
  if (existsSync(paths.assets)) {
    for (const f of readdirSync(paths.assets)) {
      if (f.endsWith(".png")) copyFileSync(join(paths.assets, f), join(stage, f));
      else if (f.endsWith(".region.json")) regions[f.replace(".region.json", "")] = readJson<Region>(join(paths.assets, f));
      else if (f.endsWith(".meta.json")) {
        const id = f.replace(".meta.json", "");
        const m = readJson<{ width: number; height: number; cssWidth?: number }>(join(paths.assets, f));
        const png = join(paths.assets, `${id}.png`);
        const layout = id !== POST_CAPTURE_ID && existsSync(png) ? captureLayout(png, m.width, m.height) : undefined;
        captures[id] = { width: m.width, height: m.height, cssWidth: m.cssWidth ?? m.width / 2, ...(layout ? { layout } : {}) };
      }
    }
  }
  // Regions are measured off the capture pixels (Capture.ts marker pass), so pageWidth equals the capture width
  // and the scale below is 1. Older runs stored DOM css-pixel regions; those still scale by the ratio.
  for (const [id, r] of Object.entries(regions)) {
    const cap = captures[id];
    if (!cap) continue;
    const k = cap.width / r.pageWidth;
    regions[id] = { x: r.x * k, y: r.y * k, w: r.w * k, h: r.h * k, pageWidth: cap.width, pageHeight: r.pageHeight * k };
  }
  for (const b of script.beats) {
    const t = b.visual.type;
    if (t === "screenshot" || t === "scroll" || t === "zoom") invariant(captures[b.id], `${b.id}: capture missing — run capture first`);
    if (t === "zoom") invariant(regions[b.id], `${b.id}: zoom region missing`);
  }
  const post = stagePost(runDir, script, captures);
  if (script.beats.some((b) => b.visual.type === "read")) {
    invariant(post, `read beats need Assets/${POST_CAPTURE_ID}.png, .meta.json and .sentences.json — run capture first`);
    const known = new Set(post.sentences.map((s) => s.p));
    for (const b of script.beats) if (b.visual.type === "read") for (const p of b.visual.paragraphs) invariant(known.has(p), `${b.id}: paragraph ${p} has no sentences on the captured page`);
  }
  const da = loadLifeosConfig().da;
  const palette = loadPalette();
  const props: EssayProps = {
    slug: script.slug,
    mode,
    daLabel: presenter?.label ?? (da.displayName ?? da.name).toUpperCase(),
    accent: palette.accent,
    palette,
    captions: !!opts.captions,
    bed,
    assetBase: `runs/${script.slug}`,
    script,
    timeline: { ...timeline, beats: timeline.beats.map((b) => ({ ...b, chunk: "" })) },
    regions,
    captures,
    fonts: fontProps(),
    ...(post ? { post } : {}),
    ...(presenter ? { badge: presenter.badge, badgeCopy: loadBadgeCopy() } : {}),
    ...(narrator ? { narrator } : {}),
    ...(presenter && isDaNarrator(presenter) ? { reader: presenter.reader, possessive: presenter.possessive } : {}),
  };
  const propsPath = join(stage, "props.json");
  writeJson(propsPath, props);
  return { props, propsPath };
}

/**
 * The render's audio of record. HyperFrames' render drops the locked narration a little in loudness while its true peak
 * barely moves (the mp4 comes out quieter than the staged narration.wav), so no gain after the render can
 * reach −14 LUFS under the −1 dBTP ceiling, and locking the narration lower to leave room did not converge. The fix takes
 * the renderer out of the audio path: after the render, the mp4's audio is replaced by exactly what the composition
 * plays (narration.wav from 0, plus bed.wav summed at unity when a score exists), encoded once, with the video stream
 * copied. The result must pass the mode's delivery check (voice −14 ± 1 LUFS, true peak ≤ −0.5 dBTP; essay −16 ± 2),
 * or the build fails.
 */
export interface DeliveredLoudness { lufs: number; truePeak: number; ok: boolean; detail: string }

export function deliveredLoudness(mode: RunMode, ebur128Log: string): DeliveredLoudness {
  const lufs = Number(ebur128Log.match(/I:\s+(-?[\d.]+) LUFS/)?.[1] ?? NaN);
  const truePeak = Number(ebur128Log.match(/True peak:\s+Peak:\s+(-?[\d.]+)/)?.[1] ?? NaN);
  invariant(Number.isFinite(lufs) && Number.isFinite(truePeak), "the delivered audio's loudness could not be measured");
  const ok = mode === "voice" ? Math.abs(lufs - VOICE_TARGET_LUFS) <= 1 && truePeak <= VOICE_TRUE_PEAK + 0.5 : Math.abs(lufs - TARGET_LUFS) <= 2;
  const detail = mode === "voice" ? `${lufs} LUFS, true peak ${truePeak} dBTP (target ${VOICE_TARGET_LUFS} ± 1, ≤ ${VOICE_TRUE_PEAK + 0.5} dBTP)` : `${lufs} LUFS (target ${TARGET_LUFS} ± 2)`;
  return { lufs, truePeak, ok, detail };
}

async function ffmpegErr(args: string[]): Promise<string> {
  const p = Bun.spawn(["ffmpeg", ...args], { stdout: "ignore", stderr: "pipe" });
  const [err, code] = await Promise.all([new Response(p.stderr).text(), p.exited]);
  invariant(code === 0, `ffmpeg ${args.slice(0, 6).join(" ")} failed: ${err.slice(-300)}`);
  return err;
}

async function duration(file: string): Promise<number> {
  const p = Bun.spawn(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], { stdout: "pipe", stderr: "ignore" });
  return Number((await new Response(p.stdout).text()).trim());
}

/** Replace the rendered mp4's audio with the staged tracks, video copied, and prove the delivery loudness. */
export async function deliverAudio(video: string, mode: RunMode, narration: string, bed?: string): Promise<DeliveredLoudness> {
  invariant(existsSync(video) && existsSync(narration) && (!bed || existsSync(bed)), "deliverAudio needs the render and its staged audio");
  const length = await duration(video);
  invariant(Math.abs((await duration(narration)) - length) <= 0.25, `narration.wav and the render differ in length by more than 0.25 s`);
  const tmp = video.replace(/\.mp4$/, ".audio.mp4");
  const mix = bed ? ["-filter_complex", "[1:a][2:a]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[a]", "-map", "[a]"] : ["-map", "1:a:0"];
  await ffmpegErr(["-y", "-v", "error", "-i", video, "-i", narration, ...(bed ? ["-i", bed] : []), "-map", "0:v:0", ...mix, "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-t", length.toFixed(3), "-movflags", "+faststart", tmp]);
  const log = await ffmpegErr(["-nostats", "-i", tmp, "-map", "0:a:0", "-af", "ebur128=peak=true", "-f", "null", "-"]);
  const result = deliveredLoudness(mode, log.slice(log.lastIndexOf("Summary:")));
  if (!result.ok) { rmSync(tmp, { force: true }); throw new Error(`delivered audio out of tolerance: ${result.detail}; fix the narration lock in Clean, never limit here`); }
  renameSync(tmp, video);
  return result;
}

/** Compose the staged run as a HyperFrames project and render it through the seam (Compose.ts). */
export async function render(props: EssayProps, out: string, opts: { workers?: number; logPath?: string } = {}): Promise<{ ms: number }> {
  const dir = join(publicDir(), "runs", props.script.slug);
  await composeEssay(dir, props);
  const r = await renderEssay(dir, out, opts);
  return { ms: r.ms };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const runArg = argValue(argv, "--run");
  if (!runArg) { console.error("usage: Build.ts --run <slug|dir> [--captions] [--stage-only] [--workers N]"); process.exit(2); }
  const dir = resolveRunDir(runArg);
  const paths = runPaths(dir);
  const { props, propsPath } = stageRun(dir, { captions: hasFlag(argv, "--captions") });
  console.log(`✓ staged ${props.script.beats.length} beats · ${props.timeline.total.toFixed(1)}s · ${WIDTH}x${HEIGHT}@${FPS}${props.bed ? " · music bed" : ""}${props.mode === "voice" ? ` · voice (${props.daLabel}, ${props.post?.sentences.length ?? 0} sentences)` : ""}`);
  if (hasFlag(argv, "--stage-only")) process.exit(0);
  ensureDir(paths.out);
  const t0 = Date.now();
  await render(props, paths.video, { workers: Number(argValue(argv, "--workers")) || undefined, logPath: join(paths.out, "render.log") });
  const loudness = await deliverAudio(paths.video, props.mode, paths.narrationWav, props.bed ? paths.bedWav : undefined);
  writeJson(join(paths.out, "render.json"), { renderedAt: new Date().toISOString(), seconds: Math.round((Date.now() - t0) / 1000), props: propsPath, loudness });
  console.log(`✓ audio of record re-muxed: ${loudness.detail}`);
  console.log(`✓ ${paths.video} (${Math.round((Date.now() - t0) / 1000)}s)`);
}
