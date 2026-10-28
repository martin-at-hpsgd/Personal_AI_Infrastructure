#!/usr/bin/env bun
/**
 * AnimatedEssay.ts — an Essay still that draws itself on in charcoal, then washes into colour, as a looping GIF.
 *
 *   bun AnimatedEssay.ts build --image <still.png> --dir <project> [--hold 3.5] [--draw 3.2] [--ground #rrggbb] [--force]
 *   bun AnimatedEssay.ts gif   --dir <project> [--name <slug>] [--width 1280] [--fps 15]
 *
 * Nothing is generated: the animation is the finished still, revealed. `build` reads the still's own
 * pixels on a coarse grid and turns every inked cell into a hatch stroke in an SVG mask. The strokes
 * are ordered outward from the picture's subject (the ink-weighted centre), so the drawing starts
 * where the eye goes and spreads to the surroundings. The grayscale still sits under that mask, so
 * what appears first is the charcoal. Then the colour still blooms in through a soft circle grown
 * from the colour's own centre, holds complete, and fades to the paper so the GIF loops cleanly.
 *
 * `gif` renders through the HyperFrames seam and encodes Out/<slug>.gif and Out/<slug>-poster.png
 * with a full-frame palette (textured art bands under a motion-weighted one).
 *
 * Exit codes: 0 done, 1 refused or failed, 2 usage error.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { invariant } from "../../../LIFEOS/TOOLS/Invariant.ts";
import { stageGsap } from "../../../LIFEOS/TOOLS/HyperFrames/HyperFrames.ts";
import { DiagramError as EssayError, encodeGif, PACE } from "./AnimatedDiagram.ts";

export { EssayError };

/** Grid the still is read on. 48x27 keeps strokes larger than a pen mark and the page small. */
export const GRID = { cols: 48, rows: 27 } as const;
/** A cell counts as inked when its darkness clears the paper by this much (0..1). */
export const INK_THRESHOLD = 0.06;

export interface Cell { c: number; r: number; ink: number; sat: number }
export interface Analysis { cells: Cell[]; ground: string; inkCentre: [number, number]; colourCentre: [number, number] }

/** Per-cell darkness and saturation from an RGB byte grid of GRID.cols x GRID.rows. Pure. */
export function analyse(rgb: Uint8Array, cols: number = GRID.cols, rows: number = GRID.rows): Analysis {
  invariant(rgb.length === cols * rows * 3, `expected ${cols * rows * 3} bytes of RGB, got ${rgb.length}`);
  const luma: number[] = [], cells: Cell[] = [];
  for (let i = 0; i < cols * rows; i++) luma.push((0.2126 * rgb[i * 3]! + 0.7152 * rgb[i * 3 + 1]! + 0.0722 * rgb[i * 3 + 2]!) / 255);
  // The paper is the brightest common tone: the 90th percentile of luma, so a few white specks do not set it.
  const paper = [...luma].sort((a, b) => a - b)[Math.floor(luma.length * 0.9)]!;
  const paperIdx = luma.findIndex((l) => l >= paper);
  const ground = `#${[0, 1, 2].map((k) => rgb[paperIdx * 3 + k]!.toString(16).padStart(2, "0")).join("")}`;
  let ix = 0, iy = 0, iw = 0, cx = 0, cy = 0, cw = 0;
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const i = r * cols + c, R = rgb[i * 3]!, G = rgb[i * 3 + 1]!, B = rgb[i * 3 + 2]!;
    const max = Math.max(R, G, B), min = Math.min(R, G, B), sat = max === 0 ? 0 : (max - min) / max;
    const ink = Math.max(0, paper - luma[i]!);
    cells.push({ c, r, ink, sat });
    ix += c * ink; iy += r * ink; iw += ink;
    const cs = sat * ink; cx += c * cs; cy += r * cs; cw += cs;
  }
  const centre = (x: number, y: number, w: number): [number, number] => (w > 0 ? [(x / w + 0.5) / cols, (y / w + 0.5) / rows] : [0.5, 0.5]);
  return { cells, ground, inkCentre: centre(ix, iy, iw), colourCentre: cw > 0 ? centre(cx, cy, cw) : centre(ix, iy, iw) };
}

/** Inked cells in drawing order: nearest the subject first, darker cells pulled earlier. Pure. */
export function strokeOrder(a: Analysis, cols: number = GRID.cols, rows: number = GRID.rows): Cell[] {
  const [fx, fy] = a.inkCentre, maxInk = Math.max(...a.cells.map((c) => c.ink), 1e-6);
  const key = (k: Cell) => Math.hypot((k.c + 0.5) / cols - fx, ((k.r + 0.5) / rows - fy) * (rows / cols)) - 0.12 * (k.ink / maxInk);
  return a.cells.filter((k) => k.ink >= INK_THRESHOLD).sort((p, q) => key(p) - key(q) || p.r - q.r || p.c - q.c);
}

function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const f = (n: number) => Math.round(n * 10) / 10;

export interface EssayTiming { draw: number; hold: number; /** Opacity of the charcoal underdrawing under the reveal, so no frame is blank. Default 0.15. */ ghost?: number }
export interface BuiltEssay { html: string; duration: number; holdStart: number; strokes: number }

/** The composition HTML for a W x H still. Pure: same analysis and timing, same bytes. */
export function buildHtml(a: Analysis, W: number, H: number, timing: EssayTiming = { draw: 3.2, hold: 3.5 }, fps = 30): BuiltEssay {
  if (!(timing.draw >= 1.5 && timing.draw <= 8)) throw new EssayError(`--draw must be 1.5..8 s, got ${timing.draw}`, true);
  if (!(timing.hold >= 1.5 && timing.hold <= 15)) throw new EssayError(`--hold must be 1.5..15 s, got ${timing.hold}`, true);
  const ghost = timing.ghost ?? 0.15;
  if (!(ghost >= 0 && ghost <= 0.4)) throw new EssayError(`ghost must be 0..0.4, got ${ghost}`, true);
  const order = strokeOrder(a);
  if (order.length === 0) throw new EssayError("the still has no inked cells; nothing to draw");
  const cw = W / GRID.cols, ch = H / GRID.rows, rnd = seeded(order.length * 7919 + W);
  const strokeDraw = 0.45, start = 0.3, span = timing.draw - strokeDraw;
  const paths: string[] = [], tw: string[] = [];
  order.forEach((k, i) => {
    // A hatch stroke across its cell, wide enough with its neighbours to leave no paper gaps.
    const x0 = k.c * cw, y0 = k.r * ch, j = () => (rnd() - 0.5) * cw * 0.3;
    const d = `M ${f(x0 - cw * 0.3 + j())} ${f(y0 + ch * 1.25 + j())} L ${f(x0 + cw * 1.3 + j())} ${f(y0 - ch * 0.25 + j())}`;
    paths.push(`<path id="h${i}" class="hatch" d="${d}" pathLength="1" stroke="#fff" stroke-width="${f(Math.max(cw, ch) * 1.9)}" stroke-linecap="round" fill="none"/>`);
    tw.push(`tl.to("#h${i}", { strokeDashoffset: 0, duration: ${strokeDraw}, ease: "power1.out" }, ${f(start + (span * i) / Math.max(1, order.length - 1))});`);
  });
  const bloomAt = f(start + timing.draw - 0.2), bloomDur = 1.6, holdStart = f(bloomAt + bloomDur);
  const fadeAt = f(holdStart + timing.hold), duration = f(fadeAt + PACE.fadeOut);
  const [bx, by] = a.colourCentre, reach = f(Math.hypot(Math.max(bx, 1 - bx) * W, Math.max(by, 1 - by) * H) * 1.15);
  tw.push(`tl.to("#bloom", { attr: { r: ${reach} }, duration: ${bloomDur}, ease: "power2.inOut" }, ${bloomAt});`);
  tw.push(`tl.to("#art", { opacity: 0, duration: ${PACE.fadeOut}, ease: "power2.in" }, ${fadeAt});`);
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=${W}, height=${H}" />
<script src="./vendor/gsap.min.js"></script>
<style>
body { margin: 0; background: ${a.ground}; }
#root { position: relative; width: ${W}px; height: ${H}px; overflow: hidden; background: ${a.ground}; }
#art { position: absolute; inset: 0; }
svg { position: absolute; inset: 0; }
.hatch { stroke-dasharray: 1 1; stroke-dashoffset: 1; }
</style>
</head>
<body>
<div id="root" data-composition-id="main" data-start="0" data-duration="${duration}" data-width="${W}" data-height="${H}" data-fps="${fps}">
<svg id="under" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">${ghost > 0 ? `<image href="gray.png" x="0" y="0" width="${W}" height="${H}" opacity="${ghost}"/>` : ""}</svg>
<div id="art" class="clip" data-start="0" data-duration="${duration}" data-track-index="1">
<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
<defs>
<mask id="drawn" maskUnits="userSpaceOnUse" x="0" y="0" width="${W}" height="${H}">
${paths.join("\n")}
</mask>
<filter id="soft" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${f(Math.min(W, H) * 0.06)}"/></filter>
<mask id="washed" maskUnits="userSpaceOnUse" x="0" y="0" width="${W}" height="${H}">
<circle id="bloom" cx="${f(bx * W)}" cy="${f(by * H)}" r="0" fill="#fff" filter="url(#soft)"/>
</mask>
</defs>
<image id="ink" href="gray.png" x="0" y="0" width="${W}" height="${H}" mask="url(#drawn)"/>
<image href="still.png" x="0" y="0" width="${W}" height="${H}" mask="url(#washed)"/>
</svg>
</div>
</div>
<script>
window.__timelines = window.__timelines || {};
const tl = gsap.timeline({ paused: true });
${tw.join("\n")}
window.__timelines["main"] = tl;
</script>
</body>
</html>
`;
  return { html, duration, holdStart, strokes: order.length };
}

async function run(cmd: string[]): Promise<Uint8Array> {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(p.stdout).arrayBuffer(), new Response(p.stderr).text()]);
  if ((await p.exited) !== 0) throw new EssayError(`${cmd[0]} failed: ${err.trim().slice(-400)}`);
  return new Uint8Array(out);
}

export async function build(image: string, dir: string, opts: { hold?: number; draw?: number; ground?: string; force?: boolean } = {}): Promise<{ index: string; duration: number; holdStart: number; strokes: number }> {
  const src = resolve(image), project = resolve(dir), index = join(project, "index.html");
  if (!existsSync(src)) throw new EssayError(`no such image: ${src}`);
  if (existsSync(index) && !opts.force) throw new EssayError(`${index} exists; pass --force to rebuild it`);
  const dims = new TextDecoder().decode(await run(["magick", "identify", "-format", "%w %h", src])).trim().split(" ").map(Number);
  const [iw, ih] = dims as [number, number];
  if (!(iw > 0 && ih > 0)) throw new EssayError(`could not read the size of ${src}`);
  // Compose at 1920 wide (even height) so the seam renders a frame the GIF can scale from.
  const W = 1920, H = Math.round((1920 * ih) / iw / 2) * 2;
  const rgb = await run(["magick", src, "-resize", `${GRID.cols}x${GRID.rows}!`, "-depth", "8", "rgb:-"]);
  const a = analyse(rgb);
  if (opts.ground) {
    if (!/^#[0-9a-f]{6}$/i.test(opts.ground)) throw new EssayError(`--ground must be #rrggbb, got "${opts.ground}"`, true);
    a.ground = opts.ground.toLowerCase();
  }
  const built = buildHtml(a, W, H, { draw: opts.draw ?? 3.2, hold: opts.hold ?? 3.5 });
  mkdirSync(project, { recursive: true });
  await run(["magick", src, "-resize", `${W}x${H}!`, "-alpha", "off", join(project, "still.png")]);
  // The charcoal layer: luminance only, with its paper lifted to white and then multiplied by the ground,
  // so the paper of the drawing is the exact paper of the page and no pale patch shows around the strokes.
  const g = [1, 3, 5].map((k) => parseInt(a.ground.slice(k, k + 2), 16) / 255), paperPct = Math.round((0.2126 * g[0]! + 0.7152 * g[1]! + 0.0722 * g[2]!) * 1000) / 10;
  await run(["magick", join(project, "still.png"), "-colorspace", "gray", "-level", `0%,${paperPct}%`, "-colorspace", "sRGB", "(", "+clone", "-fill", a.ground, "-colorize", "100", ")", "-compose", "multiply", "-composite", join(project, "gray.png")]);
  invariant(built.html.includes('data-composition-id="main"') && built.html.includes('window.__timelines["main"] = tl;'), "essay HTML lost its root or timeline registration");
  writeFileSync(index, built.html);
  writeFileSync(join(project, "essay.json"), JSON.stringify({ source: src, width: W, height: H, ground: a.ground, inkCentre: a.inkCentre, colourCentre: a.colourCentre, strokes: built.strokes, _built: { duration: built.duration, holdStart: built.holdStart } }, null, 2) + "\n");
  copyFileSync(src, join(project, `source${src.slice(src.lastIndexOf("."))}`));
  await stageGsap(project);
  return { index, duration: built.duration, holdStart: built.holdStart, strokes: built.strokes };
}

export async function gif(dir: string, opts: { name?: string; width?: number; fps?: number } = {}) {
  const project = resolve(dir);
  const meta = JSON.parse(readFileSync(join(project, "essay.json"), "utf8"))._built as { duration: number; holdStart: number } | undefined;
  if (!meta) throw new EssayError(`${project}/essay.json has no build record; run build first`);
  return encodeGif(project, { name: opts.name ?? basename(project), width: opts.width ?? 1280, fps: opts.fps ?? 15, posterAt: Math.max(0, meta.duration - PACE.fadeOut - 0.4), startAt: meta.holdStart, palette: "full", colors: 256, ground: JSON.parse(readFileSync(join(project, "essay.json"), "utf8")).ground });
}

const USAGE = `usage:
  bun AnimatedEssay.ts build --image <still.png> --dir <project> [--hold 3.5] [--draw 3.2] [--ground #rrggbb] [--force]
  bun AnimatedEssay.ts gif   --dir <project> [--name <slug>] [--width 1280] [--fps 15]`;

function flags(argv: string[], allowed: string[], bools: string[] = []): Map<string, string> {
  const m = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (bools.includes(a)) { m.set(a.slice(2), "true"); continue; }
    if (!allowed.includes(a)) throw new EssayError(`unknown argument "${a}"`, true);
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw new EssayError(`${a} needs a value`, true);
    m.set(a.slice(2), v);
    i++;
  }
  return m;
}

if (import.meta.main) {
  const [cmd, ...rest] = process.argv.slice(2);
  try {
    if (cmd === "build") {
      const v = flags(rest, ["--image", "--dir", "--hold", "--draw", "--ground"], ["--force"]);
      if (!v.get("image") || !v.get("dir")) throw new EssayError("build needs --image and --dir", true);
      const num = (k: string) => (v.has(k) ? Number(v.get(k)) : undefined);
      const r = await build(v.get("image")!, v.get("dir")!, { hold: num("hold"), draw: num("draw"), ground: v.get("ground"), force: v.has("force") });
      console.log(`✓ ${r.index}  (${r.duration}s, ${r.strokes} strokes; complete image holds from ${r.holdStart}s)`);
    } else if (cmd === "gif") {
      const v = flags(rest, ["--dir", "--name", "--width", "--fps"]);
      if (!v.get("dir")) throw new EssayError("gif needs --dir", true);
      const num = (k: string) => (v.has(k) ? Number(v.get(k)) : undefined);
      const r = await gif(v.get("dir")!, { name: v.get("name"), width: num("width"), fps: num("fps") });
      console.log(`✓ ${r.gif}  (${(r.bytes / 1024 / 1024).toFixed(2)} MB)\n✓ ${r.poster}\n✓ ${r.mp4}`);
    } else {
      throw new EssayError(cmd ? `unknown command "${cmd}"` : "no command", true);
    }
  } catch (e) {
    const usage = e instanceof EssayError && e.usage;
    console.error(`✗ ${(e as Error).message}${usage ? `\n${USAGE}` : ""}`);
    process.exit(usage ? 2 : 1);
  }
}
