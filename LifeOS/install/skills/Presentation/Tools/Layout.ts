#!/usr/bin/env bun
/**
 * Layout.ts — where every image and text block sits on a 1920×1080 lecture slide, and whether the result is balanced.
 *
 * One layout source (LAYOUT_JS, plain JavaScript) runs in two places: inside the Keynote JXA build, which
 * measures real text heights and places items with it, and here, where the self-test exercises it. The build
 * hands back every item's real rectangle and `layoutIssues` judges them, so a slide with a tiny image, an
 * empty band, text over a picture or text in the footer is reported with the slide number, never shipped quietly.
 *
 * Modes, chosen from the slide kind, art type and the image's shape:
 *   bleed   — 16:9 essay or diagram art drawn with the title corner clear fills the slide.
 *   feature — a portrait or square picture (a book cover, a phone screenshot, a portrait) stands tall on the
 *             right; the title and subtitle sit beside it, centred on it.
 *   below   — any other full-slide picture (footage, a wide diagram, a website screenshot) fills the body
 *             under the title.
 *   split   — bullets on the left, the picture filling the right column; the bullet block is centred on it.
 *
 * Generated art is drawn on paper the colour of the slide, so its own empty margins look like slide whitespace.
 * `prepareImage` trims those margins (first frame for a GIF, applied to every frame) before placement, so the
 * drawing itself is what gets sized.
 *
 *   bun Layout.ts --self-test
 */
import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "fs";
import { basename, extname, join } from "path";

export const SLIDE = { w: 1920, h: 1080 };

export const LAYOUT_GEOMETRY = {
  margin: 120, titleY: 36, titleW: 1560,
  bodyTop: 230, bodyBottom: 990, gap: 40,
  splitX: 880, bulletsX: 120, bulletsW: 720,
  featureTop: 110, featureGap: 80, featureMaxW: 1040, featureMinText: 560,
  // Beside a standing picture the title column is wide; type grows to fill it instead of floating small.
  featureTitleScale: 1.7, featureSubScale: 1.2, featureFill: 0.6, glyphW: 0.52,
};
export type Geometry = typeof LAYOUT_GEOMETRY;
export type Mode = "bleed" | "feature" | "below" | "split";
export type Rect = { x: number; y: number; w: number; h: number };
export type Item = Rect & { role: "title" | "sub" | "bullets" | "image" };
export type SlideLayout = { n: number; title: string; mode: Mode; hasImage: boolean; px?: [number, number]; items: Item[] };
export type Issue = { slide: number; title: string; level: "fix" | "warn"; text: string };

/** Plain JavaScript (no TypeScript syntax): it is embedded verbatim in the JXA build script. */
export const LAYOUT_JS = String.raw`
// scene: the drawing itself covers the frame. Art padded out to 16:9 is not a scene and never bleeds.
function lectureMode(kind, artType, iw, ih, scene) {
  var a = iw / ih;
  if (kind === "split") return "split";
  if (artType !== "media" && scene !== false && Math.abs(a - 16 / 9) < 0.08) return "bleed";
  // Anything that cannot fill the body's width stands beside the title; centring it leaves both sides bare.
  if (a < 1.45) return "feature";
  return "below";
}
function lectureFit(iw, ih, box) {
  var k = Math.min(box.w / iw, box.h / ih), w = Math.round(iw * k), h = Math.round(ih * k);
  return { x: Math.round(box.x + (box.w - w) / 2), y: Math.round(box.y + (box.h - h) / 2), w: w, h: h };
}
// headerBottom: bottom edge of the title (or subtitle) as Keynote measured it; bulletsH: measured bullet block height.
function lectureLayout(mode, iw, ih, headerBottom, bulletsH, G) {
  var W = 1920, H = 1080;
  if (mode === "bleed") {
    var k = Math.max(W / iw, H / ih), w = Math.round(iw * k), h = Math.round(ih * k);
    return { image: { x: Math.round((W - w) / 2), y: Math.round((H - h) / 2), w: w, h: h } };
  }
  if (mode === "feature") {
    var colW = Math.min(G.featureMaxW, W - 2 * G.margin - G.featureGap - G.featureMinText);
    var img = lectureFit(iw, ih, { x: W - G.margin - colW, y: G.featureTop, w: colW, h: G.bodyBottom - G.featureTop });
    img.x = W - G.margin - img.w; // stand against the right margin; the freed width goes to the text
    return { image: img, textX: G.margin, textW: img.x - G.featureGap - G.margin, textCenterY: img.y + img.h / 2 };
  }
  var top = Math.max(G.bodyTop, headerBottom + G.gap), bodyH = G.bodyBottom - top;
  if (mode === "split") {
    var im = lectureFit(iw, ih, { x: G.splitX, y: top, w: W - G.margin - G.splitX, h: bodyH });
    var by = Math.round(im.y + im.h / 2 - bulletsH / 2);
    by = Math.max(top, Math.min(by, G.bodyBottom - bulletsH));
    return { image: im, bulletsY: by, bodyTop: top };
  }
  return { image: lectureFit(iw, ih, { x: G.margin, y: top, w: W - 2 * G.margin, h: bodyH }), bodyTop: top };
}
`;

const L = new Function(`${LAYOUT_JS}; return { lectureMode, lectureFit, lectureLayout };`)() as {
  lectureMode: (kind: string, artType: string, iw: number, ih: number, scene?: boolean) => Mode;
  lectureFit: (iw: number, ih: number, box: Rect) => Rect;
  lectureLayout: (mode: Mode, iw: number, ih: number, headerBottom: number, bulletsH: number, G: Geometry) =>
    { image: Rect; bulletsY?: number; bodyTop?: number; textX?: number; textW?: number; textCenterY?: number };
};
export const { lectureMode, lectureFit, lectureLayout } = L;

// Thresholds. A picture that fills less than this share of the space it was given reads as a thumbnail.
export const MIN_FILL = { split: 0.5, below: 0.45, featureHeight: 0.7 };
/** Largest share of the slide body that may sit empty top to bottom. */
export const MAX_EMPTY_BAND = 0.3;
/** Largest share of the slide body that may sit empty in total, all bands added up. */
export const MAX_EMPTY_TOTAL = 0.25;
/** Shown at more than this many times its pixel size, a picture looks soft on a projector. */
export const MAX_UPSCALE = 1.6;
/** Largest share of the rendered slide (footer strip excluded) that may be one empty block of bare ground. */
export const MAX_EMPTY_BLOCK = 0.265;
/** A drawing covering at least this share of its canvas width and height is a full scene and may bleed. */
export const SCENE_COVER = { w: 0.85, h: 0.7 };

const overlap = (a: Rect, b: Rect, tol = 8) =>
  a.x + tol < b.x + b.w && b.x + tol < a.x + a.w && a.y + tol < b.y + b.h && b.y + tol < a.y + a.h;

/** Judge one built slide from the rectangles Keynote reports. Slides still waiting for art are not judged. */
export function layoutIssues(s: SlideLayout, G: Geometry = LAYOUT_GEOMETRY): Issue[] {
  const out: Issue[] = [];
  const add = (level: Issue["level"], text: string) => out.push({ slide: s.n, title: s.title, level, text });
  const img = s.items.find(i => i.role === "image");
  const text = s.items.filter(i => i.role !== "image");
  for (const t of text) if (t.y + t.h > G.bodyBottom + 10) add("fix", `${t.role} runs into the footer (bottom at y=${t.y + t.h})`);
  if (!s.hasImage || !img) return out;
  if (s.mode !== "bleed") {
    for (const t of text) if (overlap(img, t)) add("fix", `the picture overlaps the ${t.role}`);
    if (img.y + img.h > G.bodyBottom + 4 || img.x < 0 || img.x + img.w > SLIDE.w) add("fix", "the picture leaves the slide body");
  }
  const header = text.filter(t => t.role === "title" || t.role === "sub");
  const headerBottom = header.length ? Math.max(...header.map(t => t.y + t.h)) : G.bodyTop;
  const top = s.mode === "feature" ? G.featureTop : Math.max(G.bodyTop, headerBottom + G.gap);
  const bodyH = G.bodyBottom - top;
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  if (s.mode === "split") {
    const fill = (img.w * img.h) / ((SLIDE.w - G.margin - G.splitX) * bodyH);
    if (fill < MIN_FILL.split) add("fix", `the picture fills ${pct(fill)} of its column (min ${pct(MIN_FILL.split)}); use a taller picture or a full slide`);
  } else if (s.mode === "below") {
    const fill = (img.w * img.h) / ((SLIDE.w - 2 * G.margin) * bodyH);
    if (fill < MIN_FILL.below) add("fix", `the picture fills ${pct(fill)} of the slide body (min ${pct(MIN_FILL.below)})`);
  } else if (s.mode === "feature") {
    const tall = img.h / bodyH;
    if (tall < MIN_FILL.featureHeight) add("fix", `the picture stands ${pct(tall)} of the slide height (min ${pct(MIN_FILL.featureHeight)})`);
  }
  if (s.mode !== "bleed") {
    // Vertical bands of the body that nothing covers.
    const spans = s.items.filter(i => i.role === "image" || i.role === "bullets" || s.mode === "feature")
      .map(i => [Math.max(top, i.y), Math.min(G.bodyBottom, i.y + i.h)] as [number, number]).filter(([a, b]) => b > a).sort((a, b) => a[0] - b[0]);
    let cursor = top, worst = 0, at = top, total = 0;
    for (const [a, b] of spans) { const gap = Math.max(0, a - cursor); total += gap; if (gap > worst) { worst = gap; at = cursor; } cursor = Math.max(cursor, b); }
    const tail = Math.max(0, G.bodyBottom - cursor); total += tail;
    if (tail > worst) { worst = tail; at = cursor; }
    if (worst / bodyH > MAX_EMPTY_BAND) add("fix", `${pct(worst / bodyH)} of the slide body is empty (y ${Math.round(at)}–${Math.round(at + worst)})`);
    else if (total / bodyH > MAX_EMPTY_TOTAL) add("fix", `${pct(total / bodyH)} of the slide body is empty above and below the picture; use a taller picture or a full slide`);
  }
  if (s.px) {
    const k = img.w / s.px[0];
    if (k > MAX_UPSCALE) add("warn", `the picture is shown at ${k.toFixed(1)}× its ${s.px[0]}×${s.px[1]} pixels and will look soft; find a larger source`);
  }
  return out;
}

// ── Image preparation ───────────────────────────────────────────────────────

function magick(args: string[]): string {
  const p = Bun.spawnSync(["magick", ...args], { stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`magick ${args[0]} failed: ${new TextDecoder().decode(p.stderr).trim().slice(-300)}`);
  return new TextDecoder().decode(p.stdout).trim();
}

/** Pixel size of an image (first frame for a GIF). */
export function imageSize(file: string): [number, number] {
  const [w, h] = magick(["identify", "-format", "%w %h", `${file}[0]`]).split(" ").map(Number);
  if (!w || !h) throw new Error(`cannot read the size of ${file}`);
  return [w, h];
}

/** Parse ImageMagick's `%@` trim box ("WxH+X+Y"). */
export function parseTrimBox(s: string): Rect | null {
  const m = s.match(/^(\d+)x(\d+)\+(-?\d+)\+(-?\d+)$/);
  return m ? { w: +m[1], h: +m[2], x: +m[3], y: +m[4] } : null;
}

/** The trim box grown by a margin and kept inside the image. Null when trimming would remove almost nothing. */
export function paddedCrop(box: Rect, iw: number, ih: number, pad = 0.03): Rect | null {
  if (box.w * box.h >= 0.95 * iw * ih) return null;
  const p = Math.round(pad * Math.max(box.w, box.h));
  const x = Math.max(0, box.x - p), y = Math.max(0, box.y - p);
  return { x, y, w: Math.min(iw, box.x + box.w + p) - x, h: Math.min(ih, box.y + box.h + p) - y };
}

/** Share of the canvas the drawing covers, from the trim box of its first frame. */
export function inkCover(file: string): { w: number; h: number } {
  const [iw, ih] = imageSize(file);
  const box = parseTrimBox(magick([`${file}[0]`, "-fuzz", "8%", "-format", "%@", "info:"]));
  return box ? { w: box.w / iw, h: box.h / ih } : { w: 1, h: 1 };
}
export const isScene = (c: { w: number; h: number }) => c.w >= SCENE_COVER.w && c.h >= SCENE_COVER.h;

// ── Pixel gate: what the audience actually sees ─────────────────────────────

const GRID = { w: 96, h: 50, cell: 20 }; // 1920×1000 (the footer strip is left out) in 20 px cells

/** Largest axis-aligned rectangle of true cells (histogram method). */
export function largestEmpty(grid: boolean[][]): { cells: number; x: number; y: number; w: number; h: number } {
  const H = grid.length, W = grid[0]?.length ?? 0, hist = new Array(W).fill(0);
  let best = { cells: 0, x: 0, y: 0, w: 0, h: 0 };
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) hist[x] = grid[y][x] ? hist[x] + 1 : 0;
    const st: number[] = [];
    for (let x = 0; x <= W; x++) {
      const cur = x === W ? 0 : hist[x];
      while (st.length && hist[st[st.length - 1]] >= cur) {
        const top = st.pop()!, h = hist[top], left = st.length ? st[st.length - 1] + 1 : 0, w = x - left;
        if (h * w > best.cells) best = { cells: h * w, x: left, y: y - h + 1, w, h };
      }
      st.push(x);
    }
  }
  return best;
}

/** The biggest block of bare ground on a rendered 1920×1080 slide, as a share of the slide and a pixel rect. */
export function emptiestBlock(png: string, ground: string): { share: number; rect: Rect } {
  const g = [1, 3, 5].map(i => parseInt(ground.slice(i, i + 2), 16));
  const p = Bun.spawnSync(["magick", png, "-resize", "1920x1080!", "-crop", "1920x1000+0+0", "+repage", "-filter", "box", "-resize", `${GRID.w}x${GRID.h}!`, "-depth", "8", "rgb:-"], { stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`cannot read ${png}`);
  const b = p.stdout, grid: boolean[][] = [];
  for (let y = 0; y < GRID.h; y++) { const row: boolean[] = []; for (let x = 0; x < GRID.w; x++) { const i = (y * GRID.w + x) * 3; row.push(Math.abs(b[i] - g[0]) + Math.abs(b[i + 1] - g[1]) + Math.abs(b[i + 2] - g[2]) < 14); } grid.push(row); }
  const r = largestEmpty(grid);
  return { share: r.cells / (GRID.w * GRID.h), rect: { x: r.x * GRID.cell, y: r.y * GRID.cell, w: r.w * GRID.cell, h: r.h * GRID.cell } };
}

/** Mean grey difference (0-255) under which two slide bodies read as the same slide. Measured 2026-10-04 on a
 *  real deck: slides the speaker called duplicates (a still of a page beside a GIF of the same page, one page
 *  shown twice) scored well under it; the closest distinct slides (different pages of one dark dashboard) well
 *  above it. The deck and its scores are install history (USER Presentation History.md). */
export const MAX_LOOKALIKE = 1.5;

/** A slide's body with the title band and footer cut off, as a 32x18 grey thumbnail. */
export function bodyThumb(png: string): Uint8Array {
  const p = Bun.spawnSync(["magick", png, "-resize", "1920x1080!", "-crop", "1920x900+0+140", "+repage", "-filter", "box", "-resize", "32x18!", "-colorspace", "gray", "-depth", "8", "gray:-"], { stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error("cannot read " + png);
  return new Uint8Array(p.stdout);
}
export const thumbDistance = (a: Uint8Array, b: Uint8Array) => { let d = 0; for (let i = 0; i < a.length; i++) d += Math.abs(a[i] - b[i]); return d / a.length; };

/** Slides whose pictures look the same though their files differ (a still and a GIF of one page). Slides in
 *  skip (no picture, or a deliberate reprise) are never judged. */
export function lookalikeIssues(exportDir: string, titles: string[], skip: Set<number>): Issue[] {
  const files = readdirSync(exportDir).filter(f => /\.(\d+)\.png$/i.test(f)).sort();
  const seen: { n: number; t: Uint8Array }[] = [], out: Issue[] = [];
  for (const f of files) {
    const n = Number(f.match(/\.(\d+)\.png$/i)![1]);
    if (skip.has(n)) continue;
    const t = bodyThumb(join(exportDir, f));
    const twin = seen.find(s => thumbDistance(s.t, t) < MAX_LOOKALIKE);
    if (twin) out.push({ slide: n, title: titles[n - 1] ?? "", level: "fix", text: "looks the same as slide " + twin.n + " under a different title, so it reads as a duplicate slide; show something else, or merge the two" });
    else seen.push({ n, t });
  }
  return out;
}

/**
 * The appearance checks only see slides that have an exported image. One fix issue when the export is absent or leaves
 * any of the deck's slides without a recognised <prefix>.NNN.png, so an empty or partial export cannot pass as clean.
 */
export function exportCoverageIssues(exportDir: string, titles: string[]): Issue[] {
  const present = new Set<number>();
  if (existsSync(exportDir)) for (const f of readdirSync(exportDir)) { const m = f.match(/\.(\d+)\.png$/i); if (m) present.add(Number(m[1])); }
  const missing = titles.map((_, i) => i + 1).filter(n => !present.has(n));
  if (!missing.length) return [];
  const list = missing.length > 8 ? missing.slice(0, 8).join(", ") + ", …" : missing.join(", ");
  return [{ slide: missing[0], title: titles[missing[0] - 1] ?? "", level: "fix", text: `the slide export has no image for ${missing.length} of ${titles.length} slide(s) (${list}), so how those slides look was not checked` }];
}

/** Judge every exported slide image (Keynote names them <prefix>.001.png …) for large empty blocks. */
export function pixelIssues(exportDir: string, ground: string, titles: string[]): Issue[] {
  const out: Issue[] = [];
  const files = readdirSync(exportDir).filter(f => /\.(\d+)\.png$/i.test(f)).sort();
  for (const f of files) {
    const n = Number(f.match(/\.(\d+)\.png$/i)![1]);
    const e = emptiestBlock(join(exportDir, f), ground);
    if (e.share > MAX_EMPTY_BLOCK) {
      const side = e.rect.x === 0 && e.rect.w < 1900 ? "left side" : e.rect.x + e.rect.w >= 1900 && e.rect.x > 0 ? "right side" : e.rect.y === 0 ? "top" : "middle";
      out.push({ slide: n, title: titles[n - 1] ?? "", level: "fix", text: `${Math.round(e.share * 100)}% of the slide is one empty block (${side}, x ${e.rect.x}–${e.rect.x + e.rect.w}, y ${e.rect.y}–${e.rect.y + e.rect.h}); max ${Math.round(MAX_EMPTY_BLOCK * 100)}%` });
    }
  }
  return out;
}

/**
 * Generated art carries empty paper around the drawing. Return a copy cropped to the drawing (cached by
 * file identity), or the original when there is nothing to trim. GIFs are cropped by their first frame,
 * which the Art tools draw as the finished picture.
 */
export function prepareImage(file: string, cacheDir: string): string {
  const [iw, ih] = imageSize(file);
  const box = parseTrimBox(magick([`${file}[0]`, "-fuzz", "8%", "-format", "%@", "info:"]));
  const crop = box && paddedCrop(box, iw, ih);
  if (!crop) return file;
  const st = statSync(file);
  const ext = extname(file).toLowerCase();
  const key = createHash("sha1").update(`${file}|${st.size}|${st.mtimeMs}|${crop.w}x${crop.h}+${crop.x}+${crop.y}`).digest("hex").slice(0, 12);
  mkdirSync(cacheDir, { recursive: true });
  const out = join(cacheDir, `${basename(file, ext)}-${key}${ext}`);
  if (existsSync(out)) return out;
  const geom = `${crop.w}x${crop.h}+${crop.x}+${crop.y}`;
  if (ext === ".gif") {
    // ffmpeg crops a long GIF in about a second; ImageMagick's -coalesce path took ~35 s each.
    const p = Bun.spawnSync(["ffmpeg", "-v", "error", "-y", "-i", file, "-filter_complex",
      `[0:v]crop=${crop.w}:${crop.h}:${crop.x}:${crop.y},split[a][b];[a]palettegen=stats_mode=full[p];[b][p]paletteuse=dither=none`,
      "-loop", "0", out], { stdout: "pipe", stderr: "pipe" });
    if (p.exitCode !== 0) throw new Error(`ffmpeg crop failed: ${new TextDecoder().decode(p.stderr).trim().slice(-300)}`);
  } else magick([file, "-crop", geom, "+repage", out]);
  return out;
}

/** Corner radius, in slide points, of every real-thing picture (screenshot, cover, photo, footage). Sharp corners read as pasted in. */
export const MEDIA_RADIUS = 12;

/**
 * A copy of a real-thing picture with rounded corners (cached by file identity). `radius` is in the image's own
 * pixels, so the caller scales MEDIA_RADIUS by how large the picture is shown. Stills come back as PNG with
 * transparent corners. A GIF has only on/off transparency, so its corners are painted in the slide's ground
 * colour with a smooth edge instead; Keynote's scripting cannot round an image itself.
 */
export function roundCorners(file: string, radius: number, ground: string, cacheDir: string): string {
  const [iw, ih] = imageSize(file);
  const r = Math.max(1, Math.round(Math.min(radius, iw / 2, ih / 2)));
  const ext = extname(file).toLowerCase(), gif = ext === ".gif";
  const st = statSync(file);
  const key = createHash("sha1").update(`${file}|${st.size}|${st.mtimeMs}|r${r}|${gif ? ground : ""}`).digest("hex").slice(0, 12);
  mkdirSync(cacheDir, { recursive: true });
  const out = join(cacheDir, `${basename(file, ext)}-round-${key}${gif ? ".gif" : ".png"}`);
  if (existsSync(out)) return out;
  const shape = `roundrectangle 0,0 ${iw - 1},${ih - 1} ${r},${r}`;
  if (!gif) {
    magick([`${file}[0]`, "(", "-size", `${iw}x${ih}`, "xc:black", "-fill", "white", "-draw", shape, ")",
      "-alpha", "off", "-compose", "CopyOpacity", "-composite", out]);
    return out;
  }
  // The matte is ground colour outside the rounded shape and clear inside, laid over every frame.
  const matte = join(cacheDir, `${basename(file, ext)}-matte-${key}.png`);
  magick(["-size", `${iw}x${ih}`, `xc:${ground}`, "(", "-size", `${iw}x${ih}`, "xc:white", "-fill", "black", "-draw", shape, ")",
    "-alpha", "off", "-compose", "CopyOpacity", "-composite", matte]);
  const p = Bun.spawnSync(["ffmpeg", "-v", "error", "-y", "-i", file, "-loop", "1", "-i", matte, "-filter_complex",
    "[0:v][1:v]overlay=0:0:shortest=1,split[a][b];[a]palettegen=stats_mode=full[p];[b][p]paletteuse=dither=none",
    "-loop", "0", out], { stdout: "pipe", stderr: "pipe" });
  rmSync(matte, { force: true });
  if (p.exitCode !== 0) throw new Error(`ffmpeg corner rounding failed: ${new TextDecoder().decode(p.stderr).trim().slice(-300)}`);
  return out;
}

/** Longest a GIF may sit still after its slide appears before something on it moves, in seconds. */
export const MAX_GIF_LEAD = 0.5;

/** A GIF read as tiny greyscale frames: per-frame delays (s), mean ink (0–255) and change from frame 0. */
function gifFrames(file: string): { delays: number[]; ink: number[]; diff: (i: number, j: number) => number } {
  const delays = magick(["identify", "-format", "%T\n", file]).split("\n").map(n => (Number(n) || 10) / 100);
  const n = 32 * 18;
  const p = Bun.spawnSync(["magick", file, "-coalesce", "-resize", "32x18!", "-colorspace", "Gray", "-depth", "8", "gray:-"], { stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`magick could not read the frames of ${file}`);
  const px = new Uint8Array(p.stdout.buffer, p.stdout.byteOffset, p.stdout.byteLength);
  const ink: number[] = [];
  for (let i = 0; i * n < px.length; i++) {
    let s = 0;
    for (let k = 0; k < n; k++) s += 255 - px[i * n + k];
    ink.push(s / n);
  }
  const diff = (i: number, j: number) => { let d = 0; for (let k = 0; k < n; k++) d += Math.abs(px[i * n + k] - px[j * n + k]); return d / n; };
  return { delays: delays.slice(0, ink.length), ink, diff };
}

/**
 * Seconds a GIF shows a still picture before it first moves, and the frame its loop should open on instead.
 * A diagram GIF from AnimatedDiagram opens on the finished drawing, holds it, fades it out, then draws itself:
 * on a 15-second slide that hold ate the whole slide. The loop opens after the opening still and,
 * when what follows is a fade to an emptier frame, at the end of that fade, so the drawing starts with the slide.
 */
export function gifMotion(file: string): { lead: number; start: number } {
  const { delays, ink, diff } = gifFrames(file);
  const F = ink.length;
  // Last frame of the still run that opens at frame i (the picture has not yet changed from frame i).
  const stillEnd = (i: number) => { let k = i; while (k + 1 < F && diff(k + 1, i) < 1) k++; return k; };
  const k = stillEnd(0);
  if (k + 1 >= F) return { lead: 0, start: 0 };
  const lead = delays.slice(0, k + 1).reduce((a, b) => a + b, 0);
  let start = k, low = k, t = 0;
  for (let i = k + 1; i < F && t < 1.5; t += delays[i++]) if (ink[i] < ink[low]) low = i;
  if (ink[low] < ink[k] * 0.75) start = stillEnd(low);
  return { lead, start };
}

/** The GIF itself when it moves within MAX_GIF_LEAD of appearing, else a copy whose loop opens on its motion. */
export function startOnMotion(file: string, cacheDir: string): string {
  const st = statSync(file);
  mkdirSync(cacheDir, { recursive: true });
  // Reading every frame of a long clip takes minutes, so each file is read once per version of it.
  const stamp = join(cacheDir, `${basename(file, ".gif")}-motion-${createHash("sha1").update(`${file}|${st.size}|${st.mtimeMs}`).digest("hex").slice(0, 12)}.json`);
  const { lead, start } = existsSync(stamp) ? JSON.parse(readFileSync(stamp, "utf8")) as { lead: number; start: number } : gifMotion(file);
  if (!existsSync(stamp)) writeFileSync(stamp, JSON.stringify({ lead, start }));
  if (lead <= MAX_GIF_LEAD || start === 0) return file;
  const key = createHash("sha1").update(`${file}|${st.size}|${st.mtimeMs}|start${start}`).digest("hex").slice(0, 12);
  const out = join(cacheDir, `${basename(file, ".gif")}-now-${key}.gif`);
  if (existsSync(out)) return out;
  const p = Bun.spawnSync(["ffmpeg", "-v", "error", "-y", "-i", file, "-filter_complex",
    `[0:v]split[x][y];[x]trim=start_frame=${start},setpts=PTS-STARTPTS[a];[y]trim=end_frame=${start},setpts=PTS-STARTPTS[b];` +
    `[a][b]concat=n=2:v=1,split[c][d];[c]palettegen=stats_mode=full[p];[d][p]paletteuse=dither=none`,
    "-loop", "0", out], { stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`ffmpeg loop rotation failed: ${new TextDecoder().decode(p.stderr).trim().slice(-300)}`);
  const after = gifMotion(out).lead;
  if (after > MAX_GIF_LEAD) throw new Error(`${basename(file)} still sits ${after.toFixed(1)} s before moving after its loop was rotated`);
  return out;
}

/** How wide a real-thing picture will be shown, before text is measured (the widest the body allows). */
export function mediaShownWidth(kind: string, iw: number, ih: number, G: Geometry = LAYOUT_GEOMETRY): number {
  return L.lectureLayout(L.lectureMode(kind, "media", iw, ih), iw, ih, G.bodyTop - G.gap, 0, G).image.w;
}

// ── Self-test ───────────────────────────────────────────────────────────────

export function selfTest(): number {
  let fail = 0;
  const t = (name: string, ok: boolean) => { if (!ok) fail++; console.log(`${ok ? "✓" : "✗"} ${name}`); };
  const G = LAYOUT_GEOMETRY;
  t("16:9 essay art bleeds", lectureMode("full", "essay", 1920, 1080) === "bleed");
  t("16:9 footage never bleeds", lectureMode("full", "media", 1920, 1080) === "below");
  t("16:9 art padded around a narrow drawing does not bleed", lectureMode("full", "essay", 1920, 1080, false) !== "bleed");
  t("a drawing covering a third of its canvas is not a scene", !isScene({ w: 0.45, h: 0.75 }) && isScene({ w: 0.95, h: 0.9 }));
  {
    const g = Array.from({ length: 10 }, (_, y) => Array.from({ length: 10 }, (_, x) => x < 6 && y > 1));
    const r = largestEmpty(g);
    t("largest empty block is found", r.cells === 48 && r.x === 0 && r.y === 2 && r.w === 6 && r.h === 8);
  }
  t("a book cover is a feature", lectureMode("full", "media", 350, 525) === "feature");
  t("a wide diagram sits below the title", lectureMode("full", "diagram", 2100, 900) === "below");
  // A past failure: a trimmed drawing about 1.4:1, centred under the title with bare strips both sides.
  t("a medium-wide drawing stands beside the title", lectureMode("full", "essay", 1734, 1210, false) === "feature");
  t("a 1.5:1 picture fills the body under the title instead", lectureMode("full", "essay", 2281, 1536, false) === "below");
  {
    const m = lectureLayout("feature", 1734, 1210, 0, 0, LAYOUT_GEOMETRY);
    t("it is drawn at least 1000 px wide and leaves a readable text column", m.image.w >= 1000 && (m.textW ?? 0) >= 500);
  }
  t("split stays split", lectureMode("split", "media", 350, 525) === "split");

  const cover = lectureLayout("feature", 350, 525, 0, 0, G);
  t("a cover stands at least 75% of the slide tall", cover.image.h >= 0.75 * (G.bodyBottom - G.featureTop));
  t("a cover sits against the right margin", cover.image.x + cover.image.w === SLIDE.w - G.margin);
  t("the title beside a cover is wide enough to read", (cover.textW ?? 0) >= 700);

  const sp = lectureLayout("split", 1500, 1000, 190, 220, G);
  t("split art fills its column", (sp.image.w * sp.image.h) / ((SLIDE.w - G.margin - G.splitX) * (G.bodyBottom - 230)) >= 0.5);
  t("split bullets are centred on the picture", Math.abs((sp.bulletsY! + 110) - (sp.image.y + sp.image.h / 2)) <= 1);
  t("split picture stays right of the bullets", sp.image.x >= G.bulletsX + G.bulletsW);

  const base = (mode: Mode, img: Rect, extra: Item[] = []): SlideLayout => ({
    n: 1, title: "t", mode, hasImage: true,
    items: [{ role: "title", x: 120, y: 36, w: 1560, h: 100 }, { role: "sub", x: 124, y: 138, w: 1560, h: 52 }, { role: "image", ...img }, ...extra],
  });
  const good = base("split", { x: 880, y: 260, w: 920, h: 700 }, [{ role: "bullets", x: 120, y: 500, w: 720, h: 220 }]);
  t("a balanced split slide passes", layoutIssues(good).length === 0);
  // A past split-slide failure: bullets at the top, a small picture, the bottom of the slide empty.
  const thin = base("split", { x: 1000, y: 330, w: 420, h: 280 }, [{ role: "bullets", x: 120, y: 340, w: 820, h: 200 }]);
  const thinIssues = layoutIssues(thin).map(i => i.text).join(" | ");
  t("a thumbnail-sized split picture is flagged", /fills \d+% of its column/.test(thinIssues));
  t("an empty lower half is flagged", /of the slide body is empty/.test(thinIssues));
  // The first rebuild: 3:2 art in an 820-wide column left two empty bands of 15% each.
  t("two empty bands that add up past the limit are flagged", layoutIssues(base("split", { x: 980, y: 344, w: 820, h: 547 }, [{ role: "bullets", x: 120, y: 488, w: 800, h: 260 }])).some(i => /above and below/.test(i.text)));
  t("a picture over the bullets is flagged", layoutIssues(base("split", { x: 700, y: 260, w: 1100, h: 700 }, [{ role: "bullets", x: 120, y: 500, w: 800, h: 220 }])).some(i => /overlaps the bullets/.test(i.text)));
  t("text in the footer is flagged", layoutIssues(base("below", { x: 300, y: 230, w: 1320, h: 600 }, [{ role: "bullets", x: 120, y: 900, w: 800, h: 160 }])).some(i => /footer/.test(i.text)));
  const feature = (px: [number, number]): SlideLayout => ({ n: 1, title: "t", mode: "feature", hasImage: true, px, items: [
    { role: "title", x: 120, y: 400, w: 1040, h: 100 }, { role: "sub", x: 124, y: 502, w: 1040, h: 52 }, { role: "image", x: 1240, y: 110, w: 560, h: 840 }] });
  t("an upscaled cover warns", layoutIssues(feature([300, 450])).some(i => i.level === "warn"));
  t("a full-size cover passes clean", layoutIssues(feature([800, 1200])).length === 0);
  t("slides waiting for art are not judged", layoutIssues({ ...thin, hasImage: false }).length === 0);

  t("trim box parses", JSON.stringify(parseTrimBox("400x300+20+10")) === JSON.stringify({ w: 400, h: 300, x: 20, y: 10 }));
  t("a near-full trim is skipped", paddedCrop({ x: 2, y: 2, w: 996, h: 996 }, 1000, 1000) === null);
  const pc = paddedCrop({ x: 300, y: 200, w: 400, h: 300 }, 1500, 1000)!;
  t("padding keeps the crop inside the image and around the drawing", pc.x < 300 && pc.y < 200 && pc.x + pc.w <= 1500 && pc.y + pc.h <= 1000 && pc.x + pc.w > 700);

  // A real trim: a small dark square on light paper comes back cropped close to the square.
  const dir = join(process.env.TMPDIR ?? "/tmp", `layout-selftest-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  const src = join(dir, "art.png");
  magick(["-size", "1500x1000", "xc:#F2F2EE", "-fill", "#222222", "-draw", "rectangle 600,400 900,600", src]);
  const trimmed = prepareImage(src, join(dir, "cache"));
  const [tw, th] = imageSize(trimmed);
  t("prepareImage crops paper margins off generated art", trimmed !== src && tw < 400 && th < 300 && tw > 300 && th > 200);
  const f2 = join(dir, "f2.png"), gif = join(dir, "anim.gif");
  magick(["-size", "1500x1000", "xc:#F2F2EE", "-fill", "#2F4A8A", "-draw", "rectangle 620,420 880,580", f2]);
  magick(["-delay", "20", src, f2, "-loop", "0", gif]);
  const g = prepareImage(gif, join(dir, "cache"));
  const frames = Bun.spawnSync(["ffprobe", "-v", "error", "-count_frames", "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", g], { stdout: "pipe" });
  t("a GIF is cropped by its first frame and keeps every frame", imageSize(g)[0] < 400 && new TextDecoder().decode(frames.stdout).trim() === "2");
  // A past failure: a drawing on the right of a 16:9 canvas, the left half bare.
  const half = join(dir, "half.png"), full = join(dir, "full.png");
  magick(["-size", "1920x1080", "xc:#F2F2EE", "-fill", "#222222", "-draw", "rectangle 1100,250 1750,1000", "-draw", "rectangle 120,40 1000,120", half]);
  magick(["-size", "1920x1080", "xc:#F2F2EE", "-fill", "#222222", "-draw", "rectangle 0,180 1920,1000", "-draw", "rectangle 120,40 1000,120", full]);
  t("a bare left half is caught by the pixel gate", emptiestBlock(half, "#F2F2EE").share > MAX_EMPTY_BLOCK);
  t("a filled slide passes the pixel gate", emptiestBlock(full, "#F2F2EE").share <= MAX_EMPTY_BLOCK);
  // A past duplicate case: one screen under two titles. Same body, different title → flagged; a different body → not.
  const look = join(dir, "look"); mkdirSync(look, { recursive: true });
  const screen = "rectangle 200,200 1720,1000", rows = ["rectangle 260,300 1660,340", "rectangle 260,420 1300,460"];
  magick(["-size", "1920x1080", "xc:#F2F2EE", "-fill", "#101826", "-draw", screen, "-fill", "#5A6A80", "-draw", rows[0], "-fill", "#222222", "-draw", "rectangle 60,30 900,110", join(look, "d.001.png")]);
  magick(["-size", "1920x1080", "xc:#F2F2EE", "-fill", "#101826", "-draw", screen, "-fill", "#5A6A80", "-draw", rows[0], "-fill", "#222222", "-draw", "rectangle 60,30 500,110", join(look, "d.002.png")]);
  magick(["-size", "1920x1080", "xc:#F2F2EE", "-fill", "#101826", "-draw", screen, "-fill", "#5A6A80", "-draw", rows[1], "-draw", "rectangle 260,600 1660,900", join(look, "d.003.png")]);
  t("the same screen under a new title is a look-alike; a different screen is not", JSON.stringify(lookalikeIssues(look, [], new Set()).map(x => x.slide)) === "[2]");
  t("a slide marked reprise or without a picture is never judged", lookalikeIssues(look, [], new Set([2])).length === 0);
  t("a full export is covered; a partial or absent export is a fix issue", exportCoverageIssues(look, ["a", "b", "c"]).length === 0 && exportCoverageIssues(look, ["a", "b", "c", "d"])[0]?.slide === 4 && exportCoverageIssues(join(dir, "nope"), ["a"]).length === 1);
  // Real-thing pictures come back with 12 pt corners: transparent on a still, ground-coloured on a GIF.
  const shot = join(dir, "shot.jpg");
  magick(["-size", "1600x900", "xc:#204060", shot]);
  const rr = roundCorners(shot, 20, "#F2F2EE", join(dir, "cache"));
  const alpha = (f: string, x: number, y: number) => Number(magick([f, "-format", `%[fx:p{${x},${y}}.a]`, "info:"]));
  t("a still gets transparent rounded corners and a solid middle", alpha(rr, 0, 0) === 0 && alpha(rr, 800, 450) === 1 && imageSize(rr)[0] === 1600);
  const rg = roundCorners(gif, 20, "#F2F2EE", join(dir, "cache"));
  const rgFrames = Bun.spawnSync(["ffprobe", "-v", "error", "-count_frames", "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", rg], { stdout: "pipe" });
  // GIF palettes shift colours a few levels, so the corner is compared to the ground with a tolerance.
  const corners = magick([rg, "-coalesce", "-format", "%[fx:int(255*p{0,0}.r)],%[fx:int(255*p{0,0}.g)],%[fx:int(255*p{0,0}.b)];", "info:"]).split(";").filter(Boolean);
  t("a GIF keeps every frame and its corner takes the ground colour", new TextDecoder().decode(rgFrames.stdout).trim() === "2" && corners.length === 2 && corners.every(c => c.split(",").map(Number).every((v, i) => Math.abs(v - [242, 242, 238][i]) <= 8)));
  t("a 16:9 screenshot is sized for the body under the title", Math.abs(mediaShownWidth("full", 1920, 1080) - 1351) <= 1);
  // A held finished drawing, a fade to a faint ghost, a pause, then the drawing builds: the loop must open on the build.
  const held = join(dir, "held.gif");
  magick(["-delay", "10", "-size", "160x90", ...Array(20).fill("xc:#333333"), ...["#777777", "#bbbbbb", "#eeeeee"].map(c => `xc:${c}`),
    ...Array(5).fill("xc:#eeeeee"), ...["#dddddd", "#bbbbbb", "#999999", "#666666", "#444444"].map(c => `xc:${c}`), "-loop", "0", held]);
  const heldMotion = gifMotion(held);
  t("a GIF that holds a still for 2 s reports its lead", Math.abs(heldMotion.lead - 2) < 0.05 && heldMotion.start === 27);
  t("its loop is rotated to open on the build", gifMotion(startOnMotion(held, join(dir, "cache"))).lead <= MAX_GIF_LEAD);
  Bun.spawnSync(["rm", "-rf", dir]);
  console.log(fail ? `${fail} failed` : "all passed");
  return fail ? 1 : 0;
}

if (import.meta.main) {
  if (process.argv.includes("--self-test")) process.exit(selfTest());
  console.log("usage: bun Layout.ts --self-test   (the layout is used by Keynote.ts)");
}
