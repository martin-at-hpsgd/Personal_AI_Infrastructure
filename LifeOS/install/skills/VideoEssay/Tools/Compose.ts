#!/usr/bin/env bun
/**
 * Compose.ts — turns a staged run into a HyperFrames project and renders it through the shared seam
 * (LIFEOS/TOOLS/HyperFrames). The only render path for essay, voice and thumbnail.
 *
 *   bun Compose.ts snapshot --run <slug|dir> --at 0.9,12,28 --out-dir <dir>   stills from the staged composition
 *
 * A project is the run's stage directory (public/runs/<slug>/, where Build.ts copies the captures, the
 * narration, the bed and the avatar) plus what this file writes into it:
 *
 *   index.html   the root (1920x1080, 30 fps, data-duration), <audio> for narration and bed, the embedded fonts
 *   essay.js     one script: the narration's per-frame spectrum from the seam's audioBands() (drives the presence
 *                layer), the staged props as base64 JSON (text in a script is data, never code the preflight
 *                reads), and Page.ts bundled for the browser. The registration gate stays inline in index.html, where
 *                HyperFrames' lint looks for `window.__timelines`
 *   vendor/      pinned GSAP from stageGsap()
 *
 * A clone run's credit is the text-only Theme VOICE_CREDIT; it needs no logo files.
 *
 * Code beats are tokenised here with shiki, so the page never highlights at render time.
 */
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { codeToTokens } from "shiki";
import { audioBands, audioBandsScript, embedFonts, injectFonts, registerAfterFonts, render as hfRender, snapshot as hfSnapshot, stageGsap, type RenderResult } from "../../../LIFEOS/TOOLS/HyperFrames/HyperFrames.ts";
import { invariant } from "../../../LIFEOS/TOOLS/Invariant.ts";
import { recordRenderOf, type RecordRenderResult } from "../../../LIFEOS/TOOLS/lib/RenderProvenance.ts";
import type { EssayProps } from "./CompositionTypes.ts";
import { ENCODE_CRF, FPS, HEIGHT, OUTPUT_SCALE, WIDTH, argValue, configuredFaces, publicDir, resolveRunDir } from "./Lib.ts";
import { durationInFrames, type PageProps } from "./Page.ts";
import type { CodeToken } from "./PageVisuals.ts";
import { DEFAULT_PALETTE, FACES } from "./Theme.ts";

export const COMPOSITION_ID = "essay";
/**
 * Every Theme FACES face, embedded from its Config.json file as a data URI under the family, weight and style the
 * page sets. Throws naming every missing face or file: the composition never falls back to a system or web font.
 */
export function essayFonts() {
  return embedFonts(configuredFaces().map((f) => ({ family: f.family, path: f.path, weight: f.weight, style: f.style })));
}

/** Bundle Page.ts for the browser into `<dir>/essay.js`. */
export async function bundlePage(): Promise<string> {
  const out = await Bun.build({ entrypoints: [join(import.meta.dir, "Page.ts")], target: "browser", format: "iife", minify: false });
  if (!out.success) throw new Error(`Page.ts bundle failed:\n${out.logs.map(String).join("\n")}`);
  invariant(out.outputs.length === 1, `Page.ts bundle produced ${out.outputs.length} files, expected 1`);
  return out.outputs[0].text();
}

async function highlight(props: EssayProps): Promise<Record<string, CodeToken[][]>> {
  const out: Record<string, CodeToken[][]> = {};
  for (const b of props.script.beats) {
    if (b.visual.type !== "code") continue;
    const v = b.visual;
    try {
      const r = await codeToTokens(v.code, { lang: v.lang as never, theme: "github-dark-default" });
      out[b.id] = r.tokens.map((line) => line.map((t) => ({ content: t.content, ...(t.color ? { color: t.color } : {}) })));
    } catch (e) {
      // An unknown language renders as plain text; say so rather than hide it.
      console.warn(`· ${b.id}: shiki could not highlight "${v.lang}" (${(e as Error).message}); plain text`);
    }
  }
  return out;
}

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

function page(body: string, head = ""): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=${WIDTH}, height=${HEIGHT}" />
<script src="./vendor/gsap.min.js"></script>
<style>
html, body { margin: 0; padding: 0; background: #000; }
#root { position: relative; width: ${WIDTH}px; height: ${HEIGHT}px; overflow: hidden; }
#stage { position: absolute; left: 0; top: 0; width: ${WIDTH}px; height: ${HEIGHT}px; }
</style>
${head}</head>
<body>
${body}
</body>
</html>
`;
}

/**
 * The channel mark, bottom-left, mirroring the badge's 32 px inset on the right; faint like a YouTube watermark. It
 * replaces the channel's own YouTube watermark, which YouTube can only draw bottom-right, on top of the badge
 * (the principal, 2026-10-24).
 */
const CORNER_LOGO = `<img id="corner-logo" src="corner-logo.png" alt="" style="position: absolute; left: 32px; bottom: 32px; height: 72px; width: auto; opacity: 0.6; z-index: 5; pointer-events: none" />`;

/** Write the HyperFrames project for a staged essay or voice run into its stage directory. */
export async function composeEssay(dir: string, props: EssayProps): Promise<{ durationSec: number }> {
  invariant(existsSync(join(dir, "narration.wav")), `${dir}: narration.wav not staged`);
  invariant(existsSync(join(dir, "avatar.png")), `${dir}: avatar.png not staged`);
  const fps = props.timeline.fps;
  invariant(fps === FPS, `timeline fps ${fps} ≠ ${FPS}`);
  const frames = durationInFrames(props.timeline.total, fps);
  const durationSec = frames / fps;
  await stageGsap(dir);
  const bands = await audioBands({ wav: join(dir, "narration.wav"), fps, bands: 1 });
  invariant(bands.spectrum, "audioBands returned no spectrum lane");
  const pageProps: PageProps = { ...props, codeTokens: await highlight(props) };
  // The data and the page travel as one script, so the page can never boot without its data.
  const script = [
    audioBandsScript(bands, "__ESSAY_BANDS"),
    `window.__ESSAY_PROPS = "${b64(JSON.stringify(pageProps))}";`,
    await bundlePage(),
  ].join("\n");
  writeFileSync(join(dir, "essay.js"), script);
  const audio = [`<audio id="narration" src="narration.wav" data-start="0" data-duration="${durationSec}" data-volume="1"></audio>`];
  if (props.bed) {
    invariant(existsSync(join(dir, "bed.wav")), `${dir}: props.bed is set but bed.wav is not staged`);
    audio.push(`<audio id="bed" src="bed.wav" data-start="0" data-duration="${durationSec}" data-volume="1"></audio>`);
  }
  const body = `<div id="root" data-composition-id="${COMPOSITION_ID}" data-start="0" data-duration="${durationSec}" data-width="${WIDTH}" data-height="${HEIGHT}" data-fps="${fps}">
${audio.join("\n")}
<div id="stage"></div>
${existsSync(join(dir, "corner-logo.png")) ? CORNER_LOGO : ""}
</div>
<script src="essay.js"></script>
<script>
window.__essayReady.then(function () { var tl = window.__essayTimeline; ${registerAfterFonts(COMPOSITION_ID, "tl")} }, function (e) { console.error("[essay] " + e.message); });
</script>`;
  writeFileSync(join(dir, "index.html"), injectFonts(page(body), essayFonts()));
  return { durationSec };
}

/** Render a composed project to a validated mp4 with its audio. */
export async function renderEssay(dir: string, out: string, opts: { workers?: number; logPath?: string } = {}): Promise<RenderResult> {
  return hfRender({ projectDir: dir, out, fps: FPS, workers: opts.workers ?? 1, quality: "high", crf: ENCODE_CRF, scale: OUTPUT_SCALE, expectAudio: true, logPath: opts.logPath, timeoutMs: 4 * 60 * 60 * 1000 });
}

/**
 * The render row for a finished essay or voice run (pipeline VideoEssay, the run's own intent), written once the run's
 * Out/essay.mp4 is final: after Build.ts re-muxed the audio of record. The HyperFrames seam's own row for the pre-mux
 * encode names other bytes. VideoEval and the release gates admit a VideoEssay intent only for bytes carrying this row,
 * and its artifact is how a gate finds the run dir. Never throws (RenderProvenance.recordRenderOf).
 */
export function recordEssayRender(video: string, intent: string | null): RecordRenderResult {
  return recordRenderOf(video, { pipeline: "VideoEssay", intent });
}

/** Stills of a composed project at the given times (seconds), copied to `outDir/t<time>.png`. */
export async function snapshotEssay(dir: string, times: number[], outDir: string): Promise<string[]> {
  mkdirSync(outDir, { recursive: true });
  const tmp = join(dir, "snapshots");
  rmSync(tmp, { recursive: true, force: true });
  const r = await hfSnapshot({ projectDir: dir, times, outDir: tmp });
  invariant(r.files.length === times.length, `snapshot returned ${r.files.length} files for ${times.length} times`);
  return r.files.map((f, i) => { const dest = join(outDir, `t${times[i]}.png`); copyFileSync(f, dest); return dest; });
}

// ---------- thumbnail ----------

/**
 * `ground` and `ink` are the dark palette's (Config.json colors.darkInk); absent means Theme DEFAULT_PALETTE. `background` is an
 * image file staged in the project dir (an explainer's post header, say): it fills the frame under a ground-coloured gradient,
 * darkest behind the title, so the type still reads at 320 px.
 */
export interface ThumbnailProps { white: string[]; accent: string[]; accentColor: string; daLabel: string; ground?: string; ink?: string; background?: string }
export const THUMB_BORDER = 28;

/** `#rrggbb` at `alpha` as an rgba() value, for the accent glows. */
const rgba = (hex: string, alpha: number): string => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
};

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * The DA house thumbnail as static HTML: accent border, stacked one-word-per-line title filling the left half (light
 * lines, then accent lines) in the bold condensed caps face, the avatar cut-out bleeding off the right over accent
 * glows, dark authored ground, the DA label in the small-caps face. Its timeline is a one-second no-op, registered after the fonts load, so the
 * seam's snapshot captures it with every face in place.
 */
export function thumbnailHtml(p: ThumbnailProps): string {
  const lines = [...p.white.map((t) => ({ t, accent: false })), ...p.accent.map((t) => ({ t, accent: true }))];
  const longest = Math.max(1, ...lines.map((l) => l.t.length));
  // Size the longest line to ~52% of the width, taking a condensed caps face at ~0.5 em a character.
  const fontSize = Math.min(320, Math.max(140, (1920 * 0.52) / (longest * 0.5)));
  const lineHeight = fontSize * 0.92;
  // Single quotes: this lands inside a double-quoted style attribute, where a double quote would end it.
  const face = (id: keyof typeof FACES) => `font-family: '${FACES[id].family}'; font-weight: ${FACES[id].weight}; font-style: ${FACES[id].style}; font-synthesis: none`;
  const B = THUMB_BORDER;
  const ground = p.ground ?? DEFAULT_PALETTE.darkInk.ground, ink = p.ink ?? DEFAULT_PALETTE.darkInk.ink;
  const title = lines.map((l) => `<div style="${face("kickerBold")}; font-size: ${fontSize}px; line-height: ${lineHeight}px; letter-spacing: ${fontSize * 0.01}px; color: ${l.accent ? p.accentColor : ink}; text-shadow: 0 8px 30px rgba(0,0,0,0.6); text-transform: uppercase">${esc(l.t)}</div>`).join("\n");
  const body = `<div id="root" data-composition-id="thumbnail" data-start="0" data-duration="1" data-width="${WIDTH}" data-height="${HEIGHT}" data-fps="${FPS}">
<div id="stage" style="background: ${p.accentColor}">
<div style="position: absolute; left: ${B}px; top: ${B}px; right: ${B}px; bottom: ${B}px; background: ${ground}; overflow: hidden">
${p.background ? `<img id="plate" src="${esc(p.background)}" style="position: absolute; left: 0; top: 0; width: 100%; height: 100%; object-fit: cover" />
<div style="position: absolute; left: 0; top: 0; right: 0; bottom: 0; background: linear-gradient(90deg, ${rgba(ground, 0.93)} 0%, ${rgba(ground, 0.86)} 38%, ${rgba(ground, 0.66)} 62%, ${rgba(ground, 0.62)} 100%)"></div>\n` : ""}<div style="position: absolute; left: 0; top: 0; right: 0; bottom: 0; background: radial-gradient(1100px 700px at 15% 20%, ${rgba(p.accentColor, 0.22)}, transparent 60%), radial-gradient(900px 900px at 82% 70%, ${rgba(p.accentColor, 0.28)}, transparent 62%)"></div>
<div style="position: absolute; right: -60px; bottom: -80px; width: 920px; height: 920px; border-radius: 50%; background: radial-gradient(circle, ${rgba(p.accentColor, 0.45)}, transparent 62%)"></div>
<img src="avatar-cut.png" style="position: absolute; right: 20px; bottom: -40px; height: 1040px; width: 1040px; object-fit: contain; filter: drop-shadow(0 30px 60px rgba(0,0,0,0.6))" />
<div style="position: absolute; left: 96px; top: 0; bottom: 0; display: flex; flex-direction: column; justify-content: center">
${title}
</div>
<div style="position: absolute; top: 34px; right: 44px; ${face("caps")}; font-size: 36px; letter-spacing: 0.08em; text-transform: uppercase; color: ${ink}; background: rgba(8,7,12,0.7); padding: 14px 28px; border-radius: 999px; border: 2px solid ${p.accentColor}">${esc(p.daLabel)}</div>
</div>
</div>
</div>
<script>
var tl = gsap.timeline({ paused: true });
var hold = { v: 0 };
tl.to(hold, { v: 1, duration: 1, ease: "none" }, 0);
Promise.all(Array.prototype.map.call(document.querySelectorAll("img"), function (im) { return im.decode(); })).then(function () { ${registerAfterFonts("thumbnail", "tl")} }, function () { console.error("[thumbnail] an image failed to load"); });
</script>`;
  return page(body);
}

/** Compose the thumbnail project in `dir` (avatar-cut.png already staged there) and snapshot it to `out`. */
export async function renderThumbnail(dir: string, p: ThumbnailProps, out: string): Promise<void> {
  invariant(existsSync(join(dir, "avatar-cut.png")), `${dir}: avatar-cut.png not staged`);
  invariant(!p.background || existsSync(join(dir, p.background)), `${dir}: background ${p.background} not staged`);
  invariant([p.accentColor, p.ground ?? "#000000", p.ink ?? "#000000"].every((c) => /^#[\da-f]{6}$/i.test(c)), `thumbnail colours must be #rrggbb: ${p.accentColor}, ${p.ground}, ${p.ink}`);
  await stageGsap(dir);
  writeFileSync(join(dir, "index.html"), injectFonts(thumbnailHtml(p), essayFonts()));
  const tmp = join(dir, "snapshots");
  rmSync(tmp, { recursive: true, force: true });
  const r = await hfSnapshot({ projectDir: dir, times: [0], outDir: tmp });
  invariant(r.files.length === 1, `thumbnail snapshot returned ${r.files.length} files`);
  copyFileSync(r.files[0], out);
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const runArg = argValue(argv, "--run");
  const at = argValue(argv, "--at");
  const outDir = argValue(argv, "--out-dir");
  if (argv[0] !== "snapshot" || !runArg || !at || !outDir) { console.error("usage: Compose.ts snapshot --run <slug|dir> --at 0.9,12 --out-dir <dir>"); process.exit(2); }
  const { stageRun } = await import("./Build.ts");
  const { props } = stageRun(resolveRunDir(runArg));
  const dir = join(publicDir(), "runs", props.script.slug);
  await composeEssay(dir, props);
  const files = await snapshotEssay(dir, at.split(",").map(Number), resolve(outDir));
  for (const f of files) console.log(`✓ ${f}`);
}

