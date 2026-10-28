#!/usr/bin/env bun
/**
 * DesignAudit.ts — measures a composed video essay against its design system, inside the page, frame by frame.
 *
 *   bun DesignAudit.ts [--run <slug|dir> [--if-present]] --check <name[,name...]> [--scope badge] [--camera-step <frames>] [--json]
 *
 * --if-present: when the named run does not exist (or no Config.json names a runs root), print "skipped: …" and exit 0
 * instead of failing, so a machine without that run passes a declared eval cleanly.
 *
 * Checks (`layout` is center,fill,safe,collide,empty):
 *   config      Config.json fonts: every Theme FACES id maps to a file on disk that is a font with a readable name
 *               table; for each id Config.json fontFamilies names, the file's own family name starts with that name
 *   fonts       every visible text node at every beat's settle frame and every chapter card is set in an embedded
 *               (data:) @font-face family, passes document.fonts.check, is not a declared face that falls back
 *               (glyph widths equal the monospace, serif and sans-serif fallbacks), and paints no glyph in a system face
 *               (CDP CSS.getPlatformFontsForNode). `--scope badge` limits it to [data-ve-badge]
 *   center      the ink-bbox centre of each insert's [data-ve-block] (and each chapter card) lies within x 960 ± 38, y 508 ± 32
 *   fill        each insert meets its type's fill target (Theme FILL) and the 55% width-or-height floor
 *   safe        no ink leaves the graphics-safe box x 96–1824, y 54–1026, touches the badge keep-out (badge rect + 24 px),
 *               or is clipped by an ancestor
 *   collide     no two text blocks' ink boxes intersect, and no stroke crosses a label (unless a paper halo masks it)
 *   legibility  no insert text under 28 px and no stroke under 2 px at 1080p (the badge and furniture are exempt)
 *   camera      on read beats, sampled every frame: the page shown never extends past data-ve-post-clip (geometry, then
 *               screenshot pixels against the paper where geometry alone cannot tell), and every visible
 *               data-ve-highlight stays inside the frame
 *   sync        each data-ve-reveal first becomes visible no earlier than 4 frames (133 ms) before the first timed word
 *               matching its label's content tokens
 *   seam        ΔE00 < 2 between the paper of a read frame and the paper of the insert frame beside it, from screenshots
 *   types       every Visual type the composition accepts renders a non-empty data-ve-block; with no --run it audits a
 *               synthesized run that carries one beat of every type
 *   empty       no frame after 1 s is empty: sampled every 0.25 s and at each beat’s first and last frame, a frame
 *               needs text, a stroke, an SVG fill or an image at least ΔE 2 from the ground outside [data-ve-furniture]
 *               and [data-ve-badge]; an empty run of at most 5 frames is an ink-swap gap and passes
 *   style-doc   every number and colour exported from Theme.ts appears in References/Style.md
 *   git-fonts   no .otf/.ttf/.woff/.woff2 is tracked in the system repo or the user-data repo
 *
 * The DOM contract (the composition emits these; this tool reads nothing else besides computed styles and pixels):
 *   data-ve-beat + data-ve-type + data-ve-settle   each beat root, its Visual type, beat-local settle seconds
 *   data-ve-block      the insert's composition; ink boxes of its descendants are measured, never its CSS box
 *   data-ve-reveal     a piece that builds on a cue, labelled with its text
 *   data-ve-paper      the insert ground (its computed background is the paper colour)
 *   data-ve-badge      the badge root (font scope; its box + 24 px is the keep-out)
 *   data-ve-chapter    a chapter card root
 *   data-ve-post-clip  "x,y,w,h" in post-image pixels on the element that clips the post page (read beats)
 *   data-ve-highlight  the read highlight
 *   data-ve-furniture  progress hairline, badge internals: out of fill, center, collide, safe and legibility
 * Page globals: window.__essayReady (a promise), window.__essayTimeline.seek(seconds) paints that frame synchronously.
 *
 * Page checks stage a copy of the run under a private slug (<slug>--audit) through Build.ts stageRun and Compose.ts
 * composeEssay (never a render), open it in the HyperFrames seam's pinned headless Chrome inside the seam's network
 * sandbox, and remove the copy and the stage afterwards. Frame times are the run's timeline.json beat starts plus
 * the beat-local settle time, on the 30 fps grid.
 *
 * Exit: 0 every requested check passed; 1 a violation, or a check that could not measure; 2 usage.
 */
import { constants as fsc, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { brotliDecompressSync, deflateSync, inflateSync } from "node:zlib";
import { sniffFontFormat } from "../../../LIFEOS/TOOLS/HyperFrames/fonts.ts";
import { ensureInstalled, sandboxed } from "../../../LIFEOS/TOOLS/HyperFrames/run.ts";
import { invariant } from "../../../LIFEOS/TOOLS/Invariant.ts";
import { FACE_IDS, FACES, isFaceId, type FaceId } from "./Theme.ts";
import { VISUAL_TYPES, argValue, compositionDir, forbiddenRunRoots, hasFlag, loadSkillConfig, publicDir, readJson, resolveConfigPath, resolveRunDir, runPaths, skillConfigPath, skillDir, writeJson, type Script, type Timeline } from "./Lib.ts";

// ─────────────────────────────────────────────────────────────── design constants (frame, type floors, timing)

export const FRAME = { w: 1920, h: 1080 } as const;
export const SAFE: Rect = { x0: 96, y0: 54, x1: 1824, y1: 1026 };
export const GRID_W = 1688;
export const SAFE_H = 972;
export const OPTICAL = { x: 960, y: 508, tolX: 38, tolY: 32 } as const;
export const KEEP_OUT_PAD = 24;
export const TEXT_FLOOR_PX = 28;
export const STROKE_FLOOR_PX = 2;
/** Four frames at 30 fps: a build may start no earlier than its word's onset minus this. */
export const SYNC_LEAD_S = 4 / 30;
export const SEAM_MAX_DE = 2;
/** The page keeps the closing seconds clear for the end screen; an insert it suppressed there (data-ve-suppressed="end-screen") is a legitimate empty, accepted only on a beat starting in this last window. */
export const END_SCREEN_WINDOW_S = 20;
/** Ink is paint that differs from the ground: anything within this ΔE00 of the paper is not ink. */
export const INK_MIN_DE = 2;
/** A camera leak pixel differs from the paper by more than this (antialiasing at a clip edge stays under it). */
export const LEAK_PIXEL_DE = 3;
export const LEAK_MIN_PIXELS = 16;

export const PAGE_CHECKS = ["fonts", "center", "fill", "safe", "collide", "legibility", "camera", "sync", "seam", "types", "empty"] as const;
export const STATIC_CHECKS = ["config", "style-doc", "git-fonts"] as const;
export type PageCheck = (typeof PAGE_CHECKS)[number];
export type StaticCheck = (typeof STATIC_CHECKS)[number];
export type CheckName = PageCheck | StaticCheck;
export const ALIASES: Record<string, CheckName[]> = { layout: ["center", "fill", "safe", "collide", "empty"] };
/** An ink swap: page ink exits, then 4 frames of bare paper, then the next ink; an empty run this long or shorter is that swap. */
export const INK_SWAP_MAX_FRAMES = 5; // 4 paper frames plus the exit's own faded last frame
export const EMPTY_STEP_S = 0.25;
export const EMPTY_FROM_S = 1;

/**
 * Config.json `fontFamilies` as matchers: for each face id it names, the family name (or names) that face's file must
 * report in its own name table, matched as a case-insensitive prefix ending on a word boundary, whitespace collapsed.
 * Ids it does not name are checked for existence and readability only.
 */
export function familyMatchers(raw: unknown): Partial<Record<FaceId, string[]>> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error(`Config.json fontFamilies must be an object of face id → family name, got ${JSON.stringify(raw)}`);
  const out: Partial<Record<FaceId, string[]>> = {};
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!isFaceId(id)) throw new Error(`Config.json fontFamilies.${id} is not a face the composition sets (faces: ${FACE_IDS.join(", ")})`);
    const names = (Array.isArray(v) ? v : [v]).map((n) => (typeof n === "string" ? n.trim().replace(/\s+/g, " ") : ""));
    if (!names.length || names.some((n) => !n)) throw new Error(`Config.json fontFamilies.${id} must be a family name or a list of them`);
    out[id] = names;
  }
  return out;
}

const familyMatches = (name: string, prefix: string): boolean => {
  const n = name.replace(/\s+/g, " ").trim().toLowerCase(), p = prefix.toLowerCase();
  return n.startsWith(p) && (n.length === p.length || !/[a-z0-9]/.test(n[p.length]) || !/[a-z0-9]/.test(p[p.length - 1]));
};

// ─────────────────────────────────────────────────────────────── report types

export interface Rect { x0: number; y0: number; x1: number; y1: number }
export interface Finding { check: CheckName; where: string; code: string; message: string }
export interface CheckReport { check: CheckName; ok: boolean; measured: number; lines: string[]; findings: Finding[]; notes: string[] }

function report(check: CheckName): CheckReport {
  return { check, ok: true, measured: 0, lines: [], findings: [], notes: [] };
}
function fail(r: CheckReport, where: string, code: string, message: string): void {
  r.findings.push({ check: r.check, where, code, message });
  r.lines.push(`✗ ${where}: ${message}`);
}
function pass(r: CheckReport, where: string, message: string): void {
  r.lines.push(`✓ ${where}: ${message}`);
}
function close(r: CheckReport, what: string): CheckReport {
  if (r.measured === 0 && !r.findings.some((f) => f.code === "nothing-measured")) fail(r, "run", "nothing-measured", `no ${what} measured; a check that measured nothing has not passed`);
  r.ok = r.findings.length === 0;
  return r;
}

// ─────────────────────────────────────────────────────────────── geometry

export const area = (r: Rect): number => Math.max(0, r.x1 - r.x0) * Math.max(0, r.y1 - r.y0);
export const intersect = (a: Rect, b: Rect): Rect => ({ x0: Math.max(a.x0, b.x0), y0: Math.max(a.y0, b.y0), x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1) });
export function union(rs: Rect[]): Rect | null {
  if (rs.length === 0) return null;
  return rs.reduce((u, r) => ({ x0: Math.min(u.x0, r.x0), y0: Math.min(u.y0, r.y0), x1: Math.max(u.x1, r.x1), y1: Math.max(u.y1, r.y1) }));
}
const inflate = (r: Rect, d: number): Rect => ({ x0: r.x0 - d, y0: r.y0 - d, x1: r.x1 + d, y1: r.y1 + d });
const inside = (r: Rect, outer: Rect, tol = 0.5): boolean => r.x0 >= outer.x0 - tol && r.y0 >= outer.y0 - tol && r.x1 <= outer.x1 + tol && r.y1 <= outer.y1 + tol;
const fmtRect = (r: Rect): string => `x ${Math.round(r.x0)}–${Math.round(r.x1)}, y ${Math.round(r.y0)}–${Math.round(r.y1)}`;
const px = (n: number): string => `${Math.round(n * 10) / 10} px`;

/** The badge keep-out: the badge rect plus 24 px, clamped to the frame. */
export function keepOut(badge: Rect): Rect {
  return intersect(inflate(badge, KEEP_OUT_PAD), { x0: 0, y0: 0, x1: FRAME.w, y1: FRAME.h });
}

/** `a` minus `b` as up to four bands, each at least 1 px thick. */
export function subtract(a: Rect, b: Rect): Rect[] {
  const i = intersect(a, b);
  if (area(i) <= 0) return area(a) > 0 ? [a] : [];
  const bands: Rect[] = [
    { x0: a.x0, y0: a.y0, x1: a.x1, y1: i.y0 },
    { x0: a.x0, y0: i.y1, x1: a.x1, y1: a.y1 },
    { x0: a.x0, y0: i.y0, x1: i.x0, y1: i.y1 },
    { x0: i.x1, y0: i.y0, x1: a.x1, y1: i.y1 },
  ];
  return bands.filter((r) => r.x1 - r.x0 >= 1 && r.y1 - r.y0 >= 1);
}

// ─────────────────────────────────────────────────────────────── colour

export type Rgba = [number, number, number, number];
export type Lab = [number, number, number];

/** A CSS colour as computed styles print it (rgb(), rgba(), color(srgb ...)) or a hex literal; null when unparseable. */
export function parseColor(s: string): Rgba | null {
  const t = s.trim().toLowerCase();
  if (t === "transparent") return [0, 0, 0, 0];
  let m = /^#([0-9a-f]{3,8})$/.exec(t);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join("");
    if (h.length !== 6 && h.length !== 8) return null;
    const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
    return [n(0), n(2), n(4), h.length === 8 ? n(6) / 255 : 1];
  }
  m = /^rgba?\(([^)]*)\)$/.exec(t);
  if (m) {
    const parts = m[1].split(/[\s,/]+/).filter(Boolean);
    if (parts.length < 3) return null;
    const ch = (p: string) => (p.endsWith("%") ? parseFloat(p) * 2.55 : parseFloat(p));
    const a = parts[3] === undefined ? 1 : parts[3].endsWith("%") ? parseFloat(parts[3]) / 100 : parseFloat(parts[3]);
    const v: Rgba = [ch(parts[0]), ch(parts[1]), ch(parts[2]), a];
    return v.every(Number.isFinite) ? v : null;
  }
  m = /^color\(srgb\s+([^)]*)\)$/.exec(t);
  if (m) {
    const [rgb, alpha] = m[1].split("/");
    const c = rgb.trim().split(/\s+/).map(Number);
    const a = alpha === undefined ? 1 : Number(alpha.trim());
    const v: Rgba = [c[0] * 255, c[1] * 255, c[2] * 255, a];
    return c.length === 3 && v.every(Number.isFinite) ? v : null;
  }
  return null;
}

/** `fg` composited over an opaque `bg`. */
export function over(fg: Rgba, bg: Rgba): Rgba {
  const a = fg[3];
  return [fg[0] * a + bg[0] * (1 - a), fg[1] * a + bg[1] * (1 - a), fg[2] * a + bg[2] * (1 - a), 1];
}

export function toLab(c: readonly number[]): Lab {
  const lin = (v: number) => { const x = v / 255; return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
  const [r, g, b] = [lin(c[0]), lin(c[1]), lin(c[2])];
  const X = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
  const Y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  const Z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))];
}

/** CIEDE2000 (Sharma, Wu and Dalal 2005). */
export function deltaE00(p: Lab, q: Lab): number {
  const [L1, a1, b1] = p, [L2, a2, b2] = q;
  const rad = Math.PI / 180;
  const C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2), Cb = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cb ** 7 / (Cb ** 7 + 25 ** 7)));
  const a1p = (1 + G) * a1, a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1), C2p = Math.hypot(a2p, b2);
  const hue = (b: number, a: number) => (a === 0 && b === 0 ? 0 : (Math.atan2(b, a) / rad + 360) % 360);
  const h1p = hue(b1, a1p), h2p = hue(b2, a2p);
  const dLp = L2 - L1, dCp = C2p - C1p;
  let dhp = 0;
  if (C1p * C2p !== 0) { dhp = h2p - h1p; if (dhp > 180) dhp -= 360; else if (dhp < -180) dhp += 360; }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp / 2) * rad);
  const Lbp = (L1 + L2) / 2, Cbp = (C1p + C2p) / 2;
  let hbp = h1p + h2p;
  if (C1p * C2p !== 0) { if (Math.abs(h1p - h2p) > 180) hbp += hbp < 360 ? 360 : -360; hbp /= 2; }
  const T = 1 - 0.17 * Math.cos((hbp - 30) * rad) + 0.24 * Math.cos(2 * hbp * rad) + 0.32 * Math.cos((3 * hbp + 6) * rad) - 0.2 * Math.cos((4 * hbp - 63) * rad);
  const dTheta = 30 * Math.exp(-(((hbp - 275) / 25) ** 2));
  const Rc = 2 * Math.sqrt(Cbp ** 7 / (Cbp ** 7 + 25 ** 7));
  const Sl = 1 + (0.015 * (Lbp - 50) ** 2) / Math.sqrt(20 + (Lbp - 50) ** 2);
  const Sc = 1 + 0.045 * Cbp, Sh = 1 + 0.015 * Cbp * T;
  const Rt = -Math.sin(2 * dTheta * rad) * Rc;
  return Math.sqrt((dLp / Sl) ** 2 + (dCp / Sc) ** 2 + (dHp / Sh) ** 2 + Rt * (dCp / Sc) * (dHp / Sh));
}

const hex = (c: readonly number[]): string => `#${c.slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, "0")).join("").toUpperCase()}`;

/**
 * Whether a paint shows against the paper: alpha above 5% and, composited over the paper, at least INK_MIN_DE away
 * from it. With no known paper every non-transparent paint counts. Gradients and images always count.
 */
export function showsOn(color: string, paper: Rgba | null): boolean {
  if (/url\(|gradient/.test(color)) return true;
  const c = parseColor(color);
  if (!c) return true;
  if (c[3] <= 0.05) return false;
  if (!paper) return true;
  return deltaE00(toLab(over(c, paper)), toLab(paper)) >= INK_MIN_DE;
}

// ─────────────────────────────────────────────────────────────── PNG (screenshots in, synthesized captures out)

export interface Bitmap { width: number; height: number; data: Uint8Array }

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
const PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10];

/** 8-bit RGB or RGBA, non-interlaced PNGs (what Chrome's screenshots are) to RGBA. */
export function decodePng(buf: Uint8Array): Bitmap {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (!PNG_SIG.every((b, i) => buf[i] === b)) throw new Error("not a PNG");
  let off = 8, width = 0, height = 0, colorType = -1;
  const idat: Uint8Array[] = [];
  while (off + 8 <= buf.length) {
    const len = dv.getUint32(off), type = String.fromCharCode(...buf.subarray(off + 4, off + 8));
    const body = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      width = dv.getUint32(off + 8); height = dv.getUint32(off + 12);
      const depth = body[8]; colorType = body[9];
      if (depth !== 8 || (colorType !== 2 && colorType !== 6) || body[12] !== 0) throw new Error(`unsupported PNG (depth ${depth}, colour type ${colorType}, interlace ${body[12]})`);
    } else if (type === "IDAT") idat.push(body);
    else if (type === "IEND") break;
    off += 12 + len;
  }
  if (!width || !height || idat.length === 0) throw new Error("PNG has no image data");
  const raw = inflateSync(Buffer.concat(idat));
  const bpp = colorType === 6 ? 4 : 3, stride = width * bpp;
  if (raw.length < height * (stride + 1)) throw new Error("PNG image data is truncated");
  const out = new Uint8Array(width * height * 4);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = new Uint8Array(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0, b = prev[x], c = x >= bpp ? prev[x - bpp] : 0;
      let p = 0;
      if (f === 1) p = a; else if (f === 2) p = b; else if (f === 3) p = (a + b) >> 1;
      else if (f === 4) { const q = a + b - c, pa = Math.abs(q - a), pb = Math.abs(q - b), pc = Math.abs(q - c); p = pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      else if (f !== 0) throw new Error(`bad PNG filter ${f}`);
      cur[x] = (line[x] + p) & 0xff;
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4, i = x * bpp;
      out[o] = cur[i]; out[o + 1] = cur[i + 1]; out[o + 2] = cur[i + 2]; out[o + 3] = bpp === 4 ? cur[i + 3] : 255;
    }
    prev = cur;
  }
  return { width, height, data: out };
}

export function encodePng(img: Bitmap): Uint8Array {
  invariant(img.width > 0 && img.height > 0 && img.data.length === img.width * img.height * 4, "encodePng needs RGBA data of width × height × 4 bytes");
  const raw = new Uint8Array(img.height * (img.width * 4 + 1));
  for (let y = 0; y < img.height; y++) raw.set(img.data.subarray(y * img.width * 4, (y + 1) * img.width * 4), y * (img.width * 4 + 1) + 1);
  const chunk = (type: string, body: Uint8Array) => {
    const out = new Uint8Array(12 + body.length), dv = new DataView(out.buffer);
    dv.setUint32(0, body.length);
    out.set([...type].map((c) => c.charCodeAt(0)), 4);
    out.set(body, 8);
    dv.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
    return out;
  };
  const ihdr = new Uint8Array(13), hv = new DataView(ihdr.buffer);
  hv.setUint32(0, img.width); hv.setUint32(4, img.height); ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Uint8Array.from(PNG_SIG), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array(0))]);
}

/** A flat bitmap with filled rectangles painted over it, for synthesized captures and fixtures. */
export function paintBitmap(width: number, height: number, ground: Rgba, rects: { r: Rect; c: Rgba }[] = []): Bitmap {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set([ground[0], ground[1], ground[2], 255], i * 4);
  for (const { r, c } of rects) {
    for (let y = Math.max(0, Math.floor(r.y0)); y < Math.min(height, Math.ceil(r.y1)); y++) {
      for (let x = Math.max(0, Math.floor(r.x0)); x < Math.min(width, Math.ceil(r.x1)); x++) data.set([c[0], c[1], c[2], 255], (y * width + x) * 4);
    }
  }
  return { width, height, data };
}

/** The most frequent colour of a bitmap outside `exclude` rects (sampled every `step` px), and its share. */
export function dominantColor(img: Bitmap, exclude: Rect[] = [], step = 2): { color: Rgba; share: number } | null {
  const counts = new Map<number, number>();
  let total = 0;
  for (let y = 0; y < img.height; y += step) {
    for (let x = 0; x < img.width; x += step) {
      if (exclude.some((r) => x >= r.x0 && x < r.x1 && y >= r.y0 && y < r.y1)) continue;
      const o = (y * img.width + x) * 4, key = (img.data[o] << 16) | (img.data[o + 1] << 8) | img.data[o + 2];
      counts.set(key, (counts.get(key) ?? 0) + 1);
      total++;
    }
  }
  if (total === 0) return null;
  let best = 0, n = 0;
  for (const [k, v] of counts) if (v > n) { best = k; n = v; }
  return { color: [(best >> 16) & 255, (best >> 8) & 255, best & 255, 1], share: n / total };
}

// ─────────────────────────────────────────────────────────────── words and cues

const STOPWORDS = new Set("a an the of to and or in on at for with is are was were be been it its that this these those as by from what which how i my me we our you your he his she her they their them not no do does did has have had will would should can could than then so if but into out up about all each every more most just also only very".split(" "));

/** A label's or word's content tokens: lowercased, edge punctuation off, thousands commas out, stopwords out. */
export function contentTokens(s: string): string[] {
  return s.toLowerCase().replace(/[’‘]/g, "'").split(/\s+/)
    .map((t) => t.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "").replace(/(\d),(?=\d{3}\b)/g, "$1"))
    .filter((t) => t.length > 0 && !STOPWORDS.has(t) && (t.length > 1 || /\d/.test(t)));
}

/** The first timed word (absolute seconds) whose token is one of the label's content tokens. */
export function cueWord(label: string, words: readonly { w: string; s: number }[]): { w: string; s: number } | null {
  const want = new Set(contentTokens(label));
  if (want.size === 0) return null;
  for (const w of words) if (contentTokens(w.w).some((t) => want.has(t))) return w;
  return null;
}

const NUMERIC = /^\s*[-+−]?[$€£]?\s*(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?\s*(%|[a-z×]{1,12})?\s*$/i;
/** A compare is drawn as bars when both sides are numbers in the same unit ("61.4%" vs "83.7%", "47 times" vs "23 times"). */
export function isNumericCompare(left: string, right: string): boolean {
  const l = NUMERIC.exec(left), r = NUMERIC.exec(right);
  return !!l && !!r && (l[3] ?? "").toLowerCase() === (r[3] ?? "").toLowerCase();
}

// ─────────────────────────────────────────────────────────────── what the page reports

export interface TextLine {
  owner: number; block: number; desc: string; text: string; rect: Rect; raw: Rect; fontPx: number; capPx: number; color: string;
  inBlock: boolean; furniture: boolean; badge: boolean; order: number;
  halo: { color: string; px: number; strokeFirst: boolean } | null; chip: { color: string; order: number; rect: Rect } | null;
}
export interface Shape {
  kind: "stroke" | "fill" | "box" | "image"; desc: string; rect: Rect; raw: Rect; color: string; strokePx: number; points: number[];
  inBlock: boolean; furniture: boolean; badge: boolean; paper: boolean; order: number;
}
export interface Measure {
  found: boolean; rootVisible: boolean; chapterVisible: boolean; paper: string | null; badge: Rect | null;
  blocks: number; texts: TextLine[]; shapes: Shape[]; notes: string[]; generated: string[];
}
interface DomBeat { id: string; type: string | null; settle: string | null; blocks: number; suppressed: string | null }
interface ChapterScan { index: number; beat: string | null; visible: boolean; ink: number }
interface RevealState { label: string; text: string; visible: boolean }
interface CameraState {
  clip: string | null; clipAttr: string | null; image: { rect: Rect; natW: number; natH: number } | null; visible: Rect | null;
  highlights: Rect[]; highlightCount: number; paper: string | null; badge: Rect | null; furniture: Rect[]; notes: string[];
}
interface FontOwner { id: string; desc: string; family: string; first: string; spec: string; text: string; check: boolean; fallsBack: boolean; badge: boolean }
interface FontState { embedded: string[]; nonEmbedded: { family: string; src: string }[]; owners: FontOwner[]; generated: string[]; badgeFound: boolean }
interface FrameInkState { ground: string | null; texts: { color: string; text: string }[]; shapes: { kind: string; color: string; desc: string }[] }
interface FrameInfo { badge: Rect | null; furniture: Rect[]; paper: string | null }

/**
 * Installed into the page as window.__veAudit. Self-contained: it is serialized with Function.prototype.toString,
 * so it may reference nothing outside its own body.
 */
function pageAgent(): void {
  const FW = 1920, FH = 1080;
  type B = { x0: number; y0: number; x1: number; y1: number };
  const ALL: B = { x0: -1e7, y0: -1e7, x1: 1e7, y1: 1e7 };
  const FRAMEB: B = { x0: 0, y0: 0, x1: FW, y1: FH };
  const isect = (a: B, b: B): B => ({ x0: Math.max(a.x0, b.x0), y0: Math.max(a.y0, b.y0), x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1) });
  const areaOf = (r: B) => Math.max(0, r.x1 - r.x0) * Math.max(0, r.y1 - r.y0);
  const boxOf = (d: DOMRect): B => ({ x0: d.left, y0: d.top, x1: d.right, y1: d.bottom });
  const r1 = (n: number) => Math.round(n * 100) / 100;
  const rb = (b: B): B => ({ x0: r1(b.x0), y0: r1(b.y0), x1: r1(b.x1), y1: r1(b.y1) });
  let opacityCache = new Map<Element, number>();
  let contentClipCache = new Map<Element, B>();
  let ids = new Map<Element, number>();
  let orders = new Map<Element, number>();
  let notes: string[] = [];
  const fresh = () => { opacityCache = new Map(); contentClipCache = new Map(); ids = new Map(); orders = new Map(); notes = []; };
  const st = (el: Element) => getComputedStyle(el);
  const idOf = (el: Element) => { let n = ids.get(el); if (n === undefined) { n = ids.size + 1; ids.set(el, n); } return n; };
  const alphaOf = (c: string): number => {
    if (!c || c === "transparent") return 0;
    const m = /rgba?\(([^)]*)\)/.exec(c);
    if (m) { const p = m[1].split(/[\s,/]+/).filter(Boolean); return p[3] === undefined ? 1 : p[3].endsWith("%") ? parseFloat(p[3]) / 100 : parseFloat(p[3]); }
    const s = /color\([^/]*\/\s*([\d.]+)/.exec(c);
    return s ? parseFloat(s[1]) : 1;
  };
  const desc = (el: Element): string => {
    const tag = el.tagName.toLowerCase();
    const ve = Array.from(el.attributes).filter((a) => a.name.startsWith("data-ve-") && !a.name.startsWith("data-ve-audit")).map((a) => (a.value ? `${a.name}="${a.value.slice(0, 24)}"` : a.name)).join(" ");
    const cls = typeof el.className === "string" && el.className.trim() ? "." + el.className.trim().split(/\s+/)[0] : "";
    const txt = (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 32);
    return `<${tag}${el.id ? "#" + el.id : ""}${cls}${ve ? " " + ve : ""}>${txt ? ` "${txt}"` : ""}`;
  };
  function opacityOf(el: Element): number {
    const c = opacityCache.get(el);
    if (c !== undefined) return c;
    const s = st(el);
    let o = s.display === "none" ? 0 : Number(s.opacity);
    if (!Number.isFinite(o)) o = 1;
    const p = el.parentElement;
    if (o > 0 && p) o *= opacityOf(p);
    opacityCache.set(el, o);
    return o;
  }
  const len = (v: string, total: number): number => {
    const t = v.trim();
    if (t === "0") return 0;
    if (t.endsWith("%")) return (parseFloat(t) / 100) * total;
    if (t.endsWith("px")) return parseFloat(t);
    return NaN;
  };
  /** An element's clip-path as a screen box; null when it has none or the shape is not one this agent measures. */
  function shapeClip(el: Element, s: CSSStyleDeclaration): B | null {
    const cp = s.clipPath;
    if (!cp || cp === "none") return null;
    const m = /^(inset|polygon)\((.*)\)\s*([a-z-]*)$/.exec(cp.trim());
    let W = 0, H = 0, map: (x: number, y: number) => [number, number];
    if (el instanceof SVGGraphicsElement) {
      const bb = el.getBBox(), ctm = el.getScreenCTM();
      if (!ctm) return null;
      W = bb.width; H = bb.height;
      map = (x, y) => { const p = new DOMPoint(bb.x + x, bb.y + y).matrixTransform(ctm); return [p.x, p.y]; };
    } else {
      const he = el as HTMLElement, r = el.getBoundingClientRect();
      W = he.offsetWidth; H = he.offsetHeight;
      const sx = W > 0 ? r.width / W : 1, sy = H > 0 ? r.height / H : 1;
      map = (x, y) => [r.left + x * sx, r.top + y * sy];
    }
    if (!m) { notes.push(`clip-path ${cp} on ${desc(el)} is not a shape this audit measures (inset, polygon); treated as unclipped`); return null; }
    if (m[1] === "inset") {
      const v = m[2].split(/\s+round\s+/)[0].trim().split(/\s+/);
      const [t, r, b, l] = v.length === 1 ? [v[0], v[0], v[0], v[0]] : v.length === 2 ? [v[0], v[1], v[0], v[1]] : v.length === 3 ? [v[0], v[1], v[2], v[1]] : v;
      const T = len(t, H), R = len(r, W), Bo = len(b, H), L = len(l, W);
      if (![T, R, Bo, L].every(Number.isFinite)) { notes.push(`clip-path ${cp} on ${desc(el)} has a length this audit cannot read; treated as unclipped`); return null; }
      const [x0, y0] = map(L, T), [x1, y1] = map(W - R, H - Bo);
      return { x0: Math.min(x0, x1), y0: Math.min(y0, y1), x1: Math.max(x0, x1), y1: Math.max(y0, y1) };
    }
    const pts = m[2].split(",").map((p) => p.trim()).filter((p) => !/^(nonzero|evenodd)$/.test(p)).map((p) => p.split(/\s+/));
    const mapped = pts.map(([x, y]) => map(len(x, W), len(y ?? "0", H)));
    if (mapped.some(([x, y]) => !Number.isFinite(x) || !Number.isFinite(y))) { notes.push(`clip-path ${cp} on ${desc(el)} has a length this audit cannot read; treated as unclipped`); return null; }
    return { x0: Math.min(...mapped.map((p) => p[0])), y0: Math.min(...mapped.map((p) => p[1])), x1: Math.max(...mapped.map((p) => p[0])), y1: Math.max(...mapped.map((p) => p[1])) };
  }
  const maskNote = (el: Element, s: CSSStyleDeclaration) => {
    const mask = s.maskImage || (s as unknown as Record<string, string>).webkitMaskImage;
    if (mask && mask !== "none") notes.push(`mask-image on ${desc(el)} is not measured; its content counts as unclipped`);
  };
  /** The box an element's in-flow descendants are painted within: its own clip, its overflow clip, and its ancestors'. */
  function contentClip(el: Element): B {
    const c = contentClipCache.get(el);
    if (c) return c;
    const s = st(el);
    let out = clipFor(el);
    if (s.overflowX !== "visible" || s.overflowY !== "visible") {
      const r = boxOf(el.getBoundingClientRect());
      out = isect(out, { x0: s.overflowX !== "visible" ? r.x0 : -1e7, x1: s.overflowX !== "visible" ? r.x1 : 1e7, y0: s.overflowY !== "visible" ? r.y0 : -1e7, y1: s.overflowY !== "visible" ? r.y1 : 1e7 });
    }
    contentClipCache.set(el, out);
    return out;
  }
  const makesContainingBlock = (s: CSSStyleDeclaration, fixed: boolean) =>
    (!fixed && s.position !== "static") || s.transform !== "none" || s.filter !== "none" || s.perspective !== "none" || /paint|layout|strict|content/.test(s.contain);
  /** The box an element itself is painted within. Absolutely and fixed positioned boxes escape overflow clips below their containing block; clip-paths clip every descendant. */
  function clipFor(el: Element): B {
    const s = st(el);
    let c = ALL;
    const own = shapeClip(el, s);
    if (own) c = isect(c, own);
    maskNote(el, s);
    const pos = s.position;
    let p = el.parentElement;
    if (pos === "absolute" || pos === "fixed") {
      const fixed = pos === "fixed";
      while (p && !makesContainingBlock(st(p), fixed)) {
        const ps = st(p);
        const sc = shapeClip(p, ps);
        if (sc) c = isect(c, sc);
        p = p.parentElement;
      }
    }
    if (p) c = isect(c, contentClip(p));
    return c;
  }
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
  const fontOf = (s: CSSStyleDeclaration) => `${s.fontStyle} ${s.fontVariantCaps === "small-caps" ? "small-caps " : ""}${s.fontWeight} ${s.fontSize} ${s.fontFamily}`;
  const cased = (t: string, s: CSSStyleDeclaration) => (s.textTransform === "uppercase" ? t.toUpperCase() : s.textTransform === "lowercase" ? t.toLowerCase() : s.textTransform === "capitalize" ? t.replace(/\b\p{L}/gu, (c) => c.toUpperCase()) : t);
  function layoutBlock(el: Element): Element {
    if (el instanceof SVGElement) return el.closest("text") ?? el;
    let e: Element = el;
    while (e.parentElement && /^(inline|contents)$/.test(st(e).display)) e = e.parentElement;
    return e;
  }
  const orderOf = (el: Element): number => orders.get(el) ?? -1;
  function indexOrder(scope: Element): void {
    let n = 0;
    orders.set(scope, n++);
    const w = document.createTreeWalker(scope, NodeFilter.SHOW_ELEMENT);
    for (let e = w.nextNode(); e; e = w.nextNode()) orders.set(e as Element, n++);
  }
  const flags = (el: Element, blockScope: Element | null) => {
    const blk = el.closest("[data-ve-block]");
    return { inBlock: !!blk && (!blockScope || blockScope.contains(blk)), furniture: !!el.closest("[data-ve-furniture]"), badge: !!el.closest("[data-ve-badge]") };
  };
  const pxOf = (v: string) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };

  interface Line { top: number; h: number; x0: number; x1: number; y0: number; y1: number; text: string }
  function textLines(scope: Element, skip: (el: Element) => boolean, blockScope: Element | null) {
    const out: unknown[] = [];
    const range = document.createRange();
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const t = node as Text, el = t.parentElement;
      if (!el || !t.data.trim() || el.closest("script,style,title,noscript") || skip(el)) continue;
      const s = st(el);
      if (s.visibility !== "visible" || opacityOf(el) <= 0.05) continue;
      const lines: Line[] = [];
      let cur: Line | null = null;
      for (const w of t.data.matchAll(/\S+/g)) {
        range.setStart(t, w.index ?? 0);
        range.setEnd(t, (w.index ?? 0) + w[0].length);
        for (const rc of Array.from(range.getClientRects())) {
          if (rc.width <= 0 || rc.height <= 0) continue;
          if (cur && Math.abs(rc.top - cur.top) < rc.height * 0.5) { cur.x0 = Math.min(cur.x0, rc.left); cur.x1 = Math.max(cur.x1, rc.right); cur.text += " " + w[0]; }
          else { cur = { top: rc.top, h: rc.height, x0: rc.left, x1: rc.right, y0: rc.top, y1: rc.bottom, text: w[0] }; lines.push(cur); }
        }
      }
      if (!lines.length) continue;
      ctx.font = fontOf(s);
      try { (ctx as unknown as { letterSpacing: string }).letterSpacing = s.letterSpacing === "normal" ? "0px" : s.letterSpacing; } catch { /* older canvas without letterSpacing: widths only scale the horizontal ink */ }
      const H = ctx.measureText("H");
      const clip = clipFor(el);
      const blk = layoutBlock(el);
      const f = flags(el, blockScope);
      const halo = (() => {
        const svg = el instanceof SVGElement;
        const color = svg ? s.stroke : (s as unknown as Record<string, string>).webkitTextStrokeColor;
        const width = svg ? pxOf(s.strokeWidth) : pxOf((s as unknown as Record<string, string>).webkitTextStrokeWidth);
        if (!color || color === "none" || width <= 0) return null;
        return { color, width, strokeFirst: /^stroke/.test(s.paintOrder || "") };
      })();
      let chip: { color: string; order: number; rect: B } | null = null;
      for (let a: Element | null = el; a && scope.contains(a); a = a.parentElement) {
        const bg = st(a).backgroundColor;
        if (alphaOf(bg) >= 0.95) { chip = { color: bg, order: orderOf(a), rect: rb(boxOf(a.getBoundingClientRect())) }; break; }
        if (a === scope) break;
      }
      for (const ln of lines) {
        const m = ctx.measureText(cased(ln.text, s));
        const asc = m.fontBoundingBoxAscent, dsc = m.fontBoundingBoxDescent;
        const k = asc + dsc > 0 ? ln.h / (asc + dsc) : 1;
        const kx = m.width > 0 ? (ln.x1 - ln.x0) / m.width : k;
        const base = ln.y0 + asc * k;
        const raw: B = { x0: ln.x0 - m.actualBoundingBoxLeft * kx, x1: ln.x0 + m.actualBoundingBoxRight * kx, y0: base - m.actualBoundingBoxAscent * k, y1: base + m.actualBoundingBoxDescent * k };
        const vis = isect(isect(raw, clip), FRAMEB);
        if (areaOf(vis) <= 0) continue;
        out.push({
          owner: idOf(el), block: idOf(blk), desc: desc(el), text: ln.text.slice(0, 80), rect: rb(vis), raw: rb(raw),
          fontPx: r1(pxOf(s.fontSize) * k), capPx: r1(H.actualBoundingBoxAscent * k), color: s.color, ...f, order: orderOf(el),
          halo: halo ? { color: halo.color, px: r1(halo.width * k), strokeFirst: halo.strokeFirst } : null, chip,
        });
      }
    }
    return out;
  }
  function dashPainted(el: SVGGeometryElement, s: CSSStyleDeclaration, total: number): (d: number) => boolean {
    const arr = s.strokeDasharray;
    if (!arr || arr === "none") return () => true;
    const pl = Number(el.getAttribute("pathLength"));
    const unit = pl > 0 ? total / pl : 1;
    let list = arr.split(/[\s,]+/).filter(Boolean).map((v) => pxOf(v) * unit);
    if (list.length % 2) list = list.concat(list);
    const period = list.reduce((a, b) => a + b, 0);
    if (!(period > 0)) return () => true;
    const offset = pxOf(s.strokeDashoffset) * unit;
    return (d) => {
      let pos = (((d + offset) % period) + period) % period;
      for (let i = 0; i < list.length; i++) { if (pos < list[i]) return i % 2 === 0; pos -= list[i]; }
      return true;
    };
  }
  function shapes(scope: Element, skip: (el: Element) => boolean, blockScope: Element | null, withPoints: boolean) {
    const out: unknown[] = [];
    const generated: string[] = [];
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_ELEMENT, {
      acceptNode: (n) => {
        const el = n as Element;
        if (skip(el)) return NodeFilter.FILTER_REJECT;
        if (st(el).display === "none" || opacityOf(el) <= 0.05) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const visit = (el: Element) => {
      const s = st(el);
      if (s.visibility !== "visible") return;
      const f = flags(el, blockScope);
      const base = { desc: desc(el), ...f, paper: el.hasAttribute("data-ve-paper"), order: orderOf(el) };
      const clip = clipFor(el);
      const push = (kind: string, raw: B, color: string, strokePx: number, points: number[]) => {
        const vis = isect(isect(raw, clip), FRAMEB);
        if (areaOf(vis) <= 0 && kind !== "stroke") return;
        if (kind === "stroke" && (vis.x1 < vis.x0 || vis.y1 < vis.y0)) return;
        out.push({ kind, rect: rb(vis), raw: rb(raw), color, strokePx: r1(strokePx), points, ...base });
      };
      if (el instanceof SVGGeometryElement) {
        const ctm = el.getScreenCTM();
        if (!ctm) return;
        const bb = el.getBBox();
        const corners = [[bb.x, bb.y], [bb.x + bb.width, bb.y], [bb.x, bb.y + bb.height], [bb.x + bb.width, bb.y + bb.height]].map(([x, y]) => new DOMPoint(x, y).matrixTransform(ctm));
        const raw: B = { x0: Math.min(...corners.map((p) => p.x)), y0: Math.min(...corners.map((p) => p.y)), x1: Math.max(...corners.map((p) => p.x)), y1: Math.max(...corners.map((p) => p.y)) };
        const scale = Math.sqrt(Math.abs(ctm.a * ctm.d - ctm.b * ctm.c));
        if (s.fill !== "none" && pxOf(s.fillOpacity) > 0.05 && bb.width > 0 && bb.height > 0 && !(el instanceof SVGLineElement) && !(el instanceof SVGPolylineElement)) push("fill", raw, s.fill, 0, []);
        const sw = pxOf(s.strokeWidth);
        if (s.stroke !== "none" && pxOf(s.strokeOpacity) > 0.05 && sw > 0) {
          const strokePx = sw * scale, half = strokePx / 2;
          const pts: number[] = [];
          if (withPoints) {
            let total = 0;
            try { total = el.getTotalLength(); } catch { total = 0; }
            const painted = dashPainted(el, s, total);
            const n = Math.min(1200, Math.max(2, Math.ceil((total * scale) / 3)));
            for (let i = 0; i <= n; i++) {
              const d = (total * i) / n;
              if (!painted(d)) continue;
              const p = el.getPointAtLength(d).matrixTransform(ctm);
              pts.push(r1(p.x), r1(p.y));
            }
          }
          push("stroke", { x0: raw.x0 - half, y0: raw.y0 - half, x1: raw.x1 + half, y1: raw.y1 + half }, s.stroke, strokePx, pts);
        }
        return;
      }
      if (el instanceof SVGElement) {
        if (el instanceof SVGImageElement || el instanceof SVGUseElement) push("image", boxOf(el.getBoundingClientRect()), "url(image)", 0, []);
        return;
      }
      const r = el.getBoundingClientRect();
      const tag = el.tagName;
      if (tag === "IMG" || tag === "CANVAS" || tag === "VIDEO") { if (r.width > 0 && r.height > 0) push("image", boxOf(r), "url(image)", 0, []); }
      else if (r.width > 0 && r.height > 0) {
        const he = el as HTMLElement;
        const scale = he.offsetWidth > 0 ? r.width / he.offsetWidth : 1;
        if (s.backgroundImage && s.backgroundImage !== "none") push("image", boxOf(r), s.backgroundImage.slice(0, 60), 0, []);
        else if (alphaOf(s.backgroundColor) > 0) {
          const thin = Math.min(r.width, r.height);
          if (thin < 6) {
            const pts: number[] = [];
            if (withPoints) {
              const horiz = r.width >= r.height, L = horiz ? r.width : r.height, n = Math.max(2, Math.ceil(L / 3));
              for (let i = 0; i <= n; i++) pts.push(r1(horiz ? r.left + (L * i) / n : r.left + r.width / 2), r1(horiz ? r.top + r.height / 2 : r.top + (L * i) / n));
            }
            push("stroke", boxOf(r), s.backgroundColor, thin, pts);
          } else push("box", boxOf(r), s.backgroundColor, 0, []);
        }
        const sides = [["Top", r.left, r.top, r.right, r.top], ["Right", r.right, r.top, r.right, r.bottom], ["Bottom", r.left, r.bottom, r.right, r.bottom], ["Left", r.left, r.top, r.left, r.bottom]] as const;
        for (const [side, x0, y0, x1, y1] of sides) {
          const bw = pxOf((s as unknown as Record<string, string>)[`border${side}Width`]);
          const bs = (s as unknown as Record<string, string>)[`border${side}Style`];
          const bc = (s as unknown as Record<string, string>)[`border${side}Color`];
          if (bw <= 0 || bs === "none" || bs === "hidden" || alphaOf(bc) <= 0) continue;
          const pts: number[] = [];
          const Ls = Math.hypot(x1 - x0, y1 - y0), n = Math.max(2, Math.ceil(Ls / 3));
          if (withPoints) for (let i = 0; i <= n; i++) pts.push(r1(x0 + ((x1 - x0) * i) / n), r1(y0 + ((y1 - y0) * i) / n));
          const w = bw * scale;
          push("stroke", { x0: Math.min(x0, x1) - (side === "Right" ? w : 0), y0: Math.min(y0, y1) - (side === "Bottom" ? w : 0), x1: Math.max(x0, x1) + (side === "Left" ? w : 0), y1: Math.max(y0, y1) + (side === "Top" ? w : 0) }, bc, w, pts);
        }
        for (const pseudo of ["::before", "::after"]) {
          const ps = getComputedStyle(el, pseudo);
          const content = ps.content;
          if (!content || content === "none" || content === "normal" || ps.display === "none") continue;
          const text = content.replace(/^["']|["']$/g, "");
          if (text.trim() || alphaOf(ps.backgroundColor) > 0 || (ps.backgroundImage && ps.backgroundImage !== "none") || pxOf(ps.borderTopWidth) + pxOf(ps.borderLeftWidth) > 0) {
            generated.push(`${desc(el)}${pseudo} paints ${text.trim() ? `generated text "${text.slice(0, 24)}"` : "a generated box"}, which the audit cannot measure; put it in the DOM`);
          }
        }
      }
    };
    visit(scope);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) visit(n as Element);
    return { shapes: out, generated };
  }
  const visibleEl = (el: Element | null): boolean => {
    if (!el) return false;
    if (opacityOf(el) <= 0.05 || st(el).visibility !== "visible") return false;
    return areaOf(isect(isect(boxOf(el.getBoundingClientRect()), clipFor(el)), FRAMEB)) > 0;
  };
  const beatRoot = (id: string) => document.querySelector(`[data-ve-beat="${CSS.escape(id)}"]`);
  const chaptersAll = () => Array.from(document.querySelectorAll("[data-ve-chapter]"));
  const paperColor = (root: Element | null): string | null => {
    const inRoot = root ? [...(root.matches("[data-ve-paper]") ? [root] : []), ...Array.from(root.querySelectorAll("[data-ve-paper]"))] : [];
    const pick = (list: Element[]) => list.filter((e) => visibleEl(e)).sort((a, b) => areaOf(boxOf(b.getBoundingClientRect())) - areaOf(boxOf(a.getBoundingClientRect())))[0];
    const el = pick(inRoot) ?? pick(Array.from(document.querySelectorAll("[data-ve-paper]")));
    return el ? st(el).backgroundColor : null;
  };
  const badgeRect = (): B | null => {
    const el = Array.from(document.querySelectorAll("[data-ve-badge]")).find((e) => visibleEl(e));
    return el ? rb(boxOf(el.getBoundingClientRect())) : null;
  };
  const furnitureRects = (): B[] => Array.from(document.querySelectorAll("[data-ve-furniture]")).filter((e) => visibleEl(e)).map((e) => rb(boxOf(e.getBoundingClientRect())));
  const inkOf = (scope: Element, skip: (el: Element) => boolean): number => {
    const t = textLines(scope, skip, null) as { rect: B }[];
    const sh = shapes(scope, skip, null, false).shapes as { rect: B; paper: boolean }[];
    return t.filter((x) => areaOf(x.rect) > 1).length + sh.filter((x) => !x.paper && areaOf(x.rect) > 1).length;
  };

  const api = {
    seek(t: number): number {
      const tl = (window as unknown as { __essayTimeline?: { seek(t: number, s?: boolean): unknown } }).__essayTimeline;
      if (!tl || typeof tl.seek !== "function") throw new Error("window.__essayTimeline.seek is missing");
      tl.seek(t, false);
      return t;
    },
    beats(): DomBeatShape[] {
      return Array.from(document.querySelectorAll("[data-ve-beat]")).map((el) => ({ id: el.getAttribute("data-ve-beat") ?? "", type: el.getAttribute("data-ve-type"), settle: el.getAttribute("data-ve-settle"), blocks: el.querySelectorAll("[data-ve-block]").length, suppressed: el.getAttribute("data-ve-suppressed") }));
    },
    propsTimeline(): { id: string; start: number }[] | null {
      const b64 = (window as unknown as { __ESSAY_PROPS?: string }).__ESSAY_PROPS;
      if (typeof b64 !== "string") return null;
      const bin = atob(b64), bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const props = JSON.parse(new TextDecoder().decode(bytes)) as { timeline?: { beats?: { id: string; start: number }[] } };
      return props.timeline?.beats?.map((b) => ({ id: b.id, start: b.start })) ?? null;
    },
    measure(beatId: string | null, chapterIndex: number | null, withPoints: boolean) {
      fresh();
      const root = beatId !== null ? beatRoot(beatId) : chaptersAll()[chapterIndex ?? -1] ?? null;
      if (!root) return { found: false };
      indexOrder(root);
      const skip = (el: Element) => el !== root && ((beatId !== null && el.hasAttribute("data-ve-chapter")) || el.hasAttribute("data-ve-badge"));
      const texts = textLines(root, skip, root);
      const sh = shapes(root, skip, root, withPoints);
      const blockEls = Array.from(root.querySelectorAll("[data-ve-block]")).filter((b) => !b.closest("[data-ve-chapter]") || beatId === null);
      return {
        found: true, rootVisible: visibleEl(root), chapterVisible: beatId !== null && chaptersAll().some((c) => visibleEl(c)),
        paper: paperColor(root), badge: badgeRect(), blocks: blockEls.length,
        texts, shapes: sh.shapes, notes: [...new Set(notes)], generated: sh.generated,
      };
    },
    chapterScan(): { index: number; beat: string | null; visible: boolean; ink: number }[] {
      fresh();
      return chaptersAll().map((c, index) => {
        const visible = visibleEl(c);
        return { index, beat: c.closest("[data-ve-beat]")?.getAttribute("data-ve-beat") ?? null, visible, ink: visible ? inkOf(c, () => false) : 0 };
      });
    },
    reveals(beatId: string): { label: string; text: string; visible: boolean }[] {
      fresh();
      const root = beatRoot(beatId);
      if (!root) return [];
      return Array.from(root.querySelectorAll("[data-ve-reveal]")).filter((el) => !el.closest("[data-ve-chapter]")).map((el) => ({
        label: el.getAttribute("data-ve-reveal") ?? "",
        text: (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 120),
        visible: inkOf(el, () => false) > 0,
      }));
    },
    camera(beatId: string) {
      fresh();
      const root = beatRoot(beatId);
      const clipEls = root ? Array.from(root.querySelectorAll("[data-ve-post-clip]")) : [];
      const clipEl = clipEls.find((e) => visibleEl(e)) ?? null;
      const hl = root ? Array.from(root.querySelectorAll("[data-ve-highlight]")) : [];
      const highlights = hl.filter((e) => opacityOf(e) > 0.05 && st(e).visibility === "visible").map((e) => boxOf(e.getBoundingClientRect())).filter((r) => areaOf(r) > 0).map(rb);
      const base = { highlights, highlightCount: hl.length, paper: paperColor(root), badge: badgeRect(), furniture: furnitureRects() };
      if (!clipEl) return { clip: clipEls.length ? "hidden" : null, clipAttr: null, image: null, visible: null, ...base, notes: [...new Set(notes)] };
      const imgs = Array.from(clipEl.querySelectorAll("img")).filter((i) => i.naturalWidth > 0 && visibleEl(i)).sort((a, b) => b.naturalWidth * b.naturalHeight - a.naturalWidth * a.naturalHeight);
      const img = imgs[0];
      if (!img) return { clip: "found", clipAttr: clipEl.getAttribute("data-ve-post-clip"), image: null, visible: null, ...base, notes: [...new Set(notes)] };
      const rect = boxOf(img.getBoundingClientRect());
      const vis = isect(isect(rect, clipFor(img)), FRAMEB);
      return { clip: "found", clipAttr: clipEl.getAttribute("data-ve-post-clip"), image: { rect: rb(rect), natW: img.naturalWidth, natH: img.naturalHeight }, visible: rb(vis), ...base, notes: [...new Set(notes)] };
    },
    /** Everything painted outside the furniture and the badge, and the ground it is painted on. */
    frameInk() {
      fresh();
      const root = document.getElementById("root") ?? document.body;
      indexOrder(root);
      const outside = (el: Element) => !!el.closest("[data-ve-furniture],[data-ve-badge]");
      const texts = (textLines(root, outside, null) as { color: string; text: string }[]).map((t) => ({ color: t.color, text: t.text.slice(0, 40) }));
      const sh = (shapes(root, (el) => el.hasAttribute("data-ve-furniture") || el.hasAttribute("data-ve-badge"), null, false).shapes as { kind: string; color: string; desc: string; paper: boolean }[])
        .filter((x) => !x.paper && (x.kind === "stroke" || x.kind === "fill" || (x.kind === "image" && x.color === "url(image)")))
        .map((x) => ({ kind: x.kind, color: x.color, desc: x.desc.slice(0, 60) }));
      let ground = paperColor(null);
      if (!ground) {
        // No data-ve-paper on screen: the ground is the topmost opaque background that covers the whole frame.
        const covers = Array.from(root.querySelectorAll("*")).concat([root]).filter((el) => {
          if (!visibleEl(el) || alphaOf(st(el).backgroundColor) < 0.95) return false;
          const r = el.getBoundingClientRect();
          return r.left <= 1 && r.top <= 1 && r.right >= FW - 1 && r.bottom >= FH - 1;
        });
        ground = covers.length ? st(covers.sort((a, b) => orderOf(a) - orderOf(b))[covers.length - 1]).backgroundColor : null;
      }
      return { ground, texts, shapes: sh };
    },
    frameInfo() {
      fresh();
      return { badge: badgeRect(), furniture: furnitureRects(), paper: paperColor(null) };
    },
    fonts(scope: "all" | "badge") {
      fresh();
      const embedded = new Set<string>();
      const nonEmbedded: { family: string; src: string }[] = [];
      const unq = (f: string) => f.trim().replace(/^["']|["']$/g, "");
      for (const sheet of Array.from(document.styleSheets)) {
        let rules: CSSRuleList;
        try { rules = sheet.cssRules; } catch { continue; }
        for (const rule of Array.from(rules)) {
          if (!(rule instanceof CSSFontFaceRule)) continue;
          const family = unq(rule.style.getPropertyValue("font-family"));
          const src = rule.style.getPropertyValue("src");
          const urls = [...src.matchAll(/url\(\s*["']?([^"')]{0,16})/gi)].map((u) => u[1]);
          if (urls.length > 0 && urls.every((u) => u.startsWith("data:")) && !/local\(/i.test(src)) embedded.add(family.toLowerCase());
          else nonEmbedded.push({ family, src: src.slice(0, 80) });
        }
      }
      const badgeEl = document.querySelector("[data-ve-badge]");
      const scopeEl = scope === "badge" ? badgeEl : document.body;
      const owners: unknown[] = [];
      const generated: string[] = [];
      if (scopeEl) {
        const seen = new Set<Element>();
        const walker = document.createTreeWalker(scopeEl, NodeFilter.SHOW_TEXT);
        const range = document.createRange();
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const t = node as Text, el = t.parentElement;
          if (!el || !t.data.trim() || seen.has(el) || el.closest("script,style,title,noscript")) continue;
          const s = st(el);
          if (s.visibility !== "visible" || opacityOf(el) <= 0.05 || alphaOf(s.color) <= 0.05) continue;
          range.selectNodeContents(t);
          const vis = Array.from(range.getClientRects()).some((rc) => areaOf(isect(isect(boxOf(rc), clipFor(el)), FRAMEB)) > 0);
          if (!vis) continue;
          seen.add(el);
          const id = String(seen.size);
          el.setAttribute("data-ve-audit-font", id);
          const fams = s.fontFamily.split(",").map(unq);
          const first = fams[0] ?? "";
          const text = Array.from(el.childNodes).filter((c) => c.nodeType === 3).map((c) => (c as Text).data).join(" ").replace(/\s+/g, " ").trim();
          const spec = `${s.fontStyle} ${s.fontWeight} ${s.fontSize} "${first}"`;
          let check = false;
          try { check = document.fonts.check(spec, text); } catch { check = false; }
          const sample = cased(text, s).slice(0, 64) + " HMmwx019";
          const width = (font: string) => { ctx.font = font; return ctx.measureText(sample).width; };
          const at = `${s.fontStyle} ${s.fontWeight} 100px`;
          const fallsBack = ["monospace", "serif", "sans-serif"].every((g) => Math.abs(width(`${at} "${first}", ${g}`) - width(`${at} ${g}`)) < 0.01);
          owners.push({ id, desc: desc(el), family: s.fontFamily, first, spec, text: text.slice(0, 60), check, fallsBack, badge: !!el.closest("[data-ve-badge]") });
        }
        const all = [scopeEl, ...Array.from(scopeEl.querySelectorAll("*"))];
        for (const el of all) {
          if (el instanceof SVGElement || opacityOf(el) <= 0.05) continue;
          for (const pseudo of ["::before", "::after"]) {
            const content = getComputedStyle(el, pseudo).content;
            if (content && content !== "none" && content !== "normal" && content.replace(/^["']|["']$/g, "").trim()) generated.push(`${desc(el)}${pseudo} sets generated text ${content.slice(0, 24)}; its face cannot be audited`);
          }
        }
      }
      return { embedded: [...embedded], nonEmbedded, owners, generated, badgeFound: !!badgeEl };
    },
    unmark(): void {
      for (const el of Array.from(document.querySelectorAll("[data-ve-audit-font]"))) el.removeAttribute("data-ve-audit-font");
    },
  };
  type DomBeatShape = { id: string; type: string | null; settle: string | null; blocks: number; suppressed: string | null };
  (window as unknown as { __veAudit: typeof api }).__veAudit = api;
}

// ─────────────────────────────────────────────────────────────── browser (the seam's pinned Chrome, sandboxed)

/** Minimal flattened-session CDP client over Bun's WebSocket (protocol JSON is untyped; callers check what they read). */
export class CdpClient {
  private nextId = 1;
  private pending = new Map<number, { ok: (v: any) => void; fail: (e: Error) => void }>();
  private listeners: Array<(method: string, params: any, sessionId?: string) => void> = [];
  private constructor(private ws: WebSocket) {
    ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.error) p.fail(new Error(`CDP ${msg.error.code}: ${msg.error.message}`)); else p.ok(msg.result);
      } else if (msg.method) for (const l of this.listeners) l(msg.method, msg.params, msg.sessionId);
    };
  }
  static connect(url: string, timeoutMs: number): Promise<CdpClient> {
    return new Promise((ok, no) => {
      const ws = new WebSocket(url);
      const timer = setTimeout(() => no(new Error(`CDP connect timed out after ${timeoutMs} ms`)), timeoutMs);
      ws.onopen = () => { clearTimeout(timer); ok(new CdpClient(ws)); };
      ws.onerror = () => { clearTimeout(timer); no(new Error(`CDP connect failed: ${url}`)); };
    });
  }
  send(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = 30_000): Promise<any> {
    const id = this.nextId++;
    return new Promise((ok, no) => {
      const timer = setTimeout(() => { this.pending.delete(id); no(new Error(`CDP ${method} timed out after ${timeoutMs} ms`)); }, timeoutMs);
      this.pending.set(id, { ok: (v) => { clearTimeout(timer); ok(v); }, fail: (e) => { clearTimeout(timer); no(e); } });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  on(l: (method: string, params: any, sessionId?: string) => void): void { this.listeners.push(l); }
  close(): void { try { this.ws.close(); } catch { /* the browser already closed the socket */ } }
}

export async function devtoolsEndpoint(stderr: ReadableStream<Uint8Array>, timeoutMs: number): Promise<string> {
  const reader = stderr.getReader(), decoder = new TextDecoder(), deadline = Date.now() + timeoutMs;
  let text = "";
  while (Date.now() < deadline) {
    const chunk = await Promise.race([reader.read(), new Promise<null>((r) => setTimeout(() => r(null), Math.max(1, deadline - Date.now())))]);
    if (chunk === null || chunk.done) break;
    text += decoder.decode(chunk.value);
    const m = /DevTools listening on (ws:\/\/\S+)/.exec(text);
    if (m) { reader.releaseLock(); return m[1]; }
  }
  throw new Error(`headless Chrome reported no DevTools endpoint within ${timeoutMs} ms: ${text.slice(-400)}`);
}

/** Every live descendant of a pid, read before the kill (children reparent to launchd once the parent dies). */
export function descendants(pid: number): number[] {
  const table = new TextDecoder().decode(Bun.spawnSync(["/bin/ps", "-axo", "pid=,ppid="], { stdout: "pipe", stderr: "ignore" }).stdout);
  const kids = new Map<number, number[]>();
  for (const line of table.split("\n")) {
    const [c, p] = line.trim().split(/\s+/).map(Number);
    if (Number.isInteger(c) && Number.isInteger(p)) kids.set(p, [...(kids.get(p) ?? []), c]);
  }
  const out: number[] = [], stack = [...(kids.get(pid) ?? [])];
  while (stack.length) { const n = stack.pop()!; if (!out.includes(n)) { out.push(n); stack.push(...(kids.get(n) ?? [])); } }
  return out;
}

const liveBrowsers = new Set<AuditBrowser>();

export class AuditBrowser {
  private closed = false;
  private constructor(private proc: ReturnType<typeof Bun.spawn>, readonly cdp: CdpClient, private profile: string) {}

  static async launch(): Promise<AuditBrowser> {
    const { browserPath } = await ensureInstalled();
    const profile = mkdtempSync(join(tmpdir(), "ve-design-audit-"));
    const proc = Bun.spawn(sandboxed([
      // --no-sandbox: Chrome cannot start its own seatbelt inside sandbox-exec (the seam's probe measured it); the
      // outer profile is the boundary: no outbound network, and the page is our own local file.
      browserPath, "--headless", "--no-sandbox", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check",
      "--disable-background-networking", "--disable-component-update", "--disable-sync", "--allow-file-access-from-files", "--hide-scrollbars",
      "--force-color-profile=srgb", "--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE localhost", `--window-size=${FRAME.w},${FRAME.h}`, "about:blank",
    ]), { stdout: "ignore", stderr: "pipe", stdin: "ignore" });
    try {
      const cdp = await CdpClient.connect(await devtoolsEndpoint(proc.stderr as ReadableStream<Uint8Array>, 20_000), 10_000);
      const b = new AuditBrowser(proc, cdp, profile);
      liveBrowsers.add(b);
      return b;
    } catch (e) {
      for (const k of [...descendants(proc.pid)]) { try { process.kill(k, "SIGKILL"); } catch { /* already gone */ } }
      proc.kill("SIGKILL");
      await proc.exited;
      rmSync(profile, { recursive: true, force: true });
      throw e;
    }
  }

  /** Open a composed project's entry file, wait for __essayReady (and the font gate when present), install the agent. */
  async open(file: string, readyTimeoutMs = 180_000): Promise<AuditPage> {
    const { targetId } = await this.cdp.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await this.cdp.send("Target.attachToTarget", { targetId, flatten: true });
    const page = new AuditPage(this.cdp, sessionId, targetId);
    try {
      await page.load(file, readyTimeoutMs);
      return page;
    } catch (e) {
      await page.close();
      throw e;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    liveBrowsers.delete(this);
    const kids = descendants(this.proc.pid);
    this.cdp.close();
    this.proc.kill("SIGKILL");
    for (const k of kids) { try { process.kill(k, "SIGKILL"); } catch { /* exited with its parent */ } }
    await this.proc.exited;
    rmSync(this.profile, { recursive: true, force: true });
  }
}

export class AuditPage {
  readonly errors: string[] = [];
  private loaded = false;
  constructor(private cdp: CdpClient, private sessionId: string, private targetId: string) {
    cdp.on((method, params, sid) => {
      if (sid !== sessionId) return;
      if (method === "Runtime.exceptionThrown") this.errors.push(String(params?.exceptionDetails?.exception?.description ?? params?.exceptionDetails?.text ?? "page error").split("\n")[0]);
      if (method === "Runtime.consoleAPICalled" && params?.type === "error") this.errors.push(`console.error: ${(params.args ?? []).map((a: any) => a.value ?? a.description ?? "").join(" ").slice(0, 300)}`);
      if (method === "Page.loadEventFired") this.loaded = true;
    });
  }

  async load(file: string, readyTimeoutMs: number): Promise<void> {
    const s = this.sessionId;
    await this.cdp.send("Runtime.enable", {}, s);
    await this.cdp.send("Page.enable", {}, s);
    await this.cdp.send("DOM.enable", {}, s);
    await this.cdp.send("CSS.enable", {}, s);
    await this.cdp.send("Emulation.setDeviceMetricsOverride", { width: FRAME.w, height: FRAME.h, deviceScaleFactor: 1, mobile: false }, s);
    await this.cdp.send("Page.navigate", { url: pathToFileURL(file).href }, s);
    const deadline = Date.now() + readyTimeoutMs;
    while (!this.loaded) {
      if (Date.now() > deadline) throw new Error(`${file} did not finish loading within ${readyTimeoutMs} ms`);
      await Bun.sleep(50);
    }
    const left = () => Math.max(1000, deadline - Date.now());
    const ready = await this.eval<string>(`(async () => {
      const w = window;
      if (!w.__essayReady || typeof w.__essayReady.then !== "function") return "window.__essayReady is missing: the page contract requires it";
      const within = (p, what) => Promise.race([p.then(() => "ok"), new Promise((r) => setTimeout(() => r(what + " did not settle within ${Math.round(readyTimeoutMs / 1000)} s"), ${left()}))]);
      const a = await within(w.__essayReady, "window.__essayReady").catch((e) => "window.__essayReady rejected: " + (e && e.message || e));
      if (a !== "ok") return a;
      if (w.__hfFontsError) return "font gate failed: " + w.__hfFontsError;
      if (w.__hfFontsReady && typeof w.__hfFontsReady.then === "function") { const f = await within(w.__hfFontsReady, "the font gate (window.__hfFontsReady)"); if (f !== "ok") return w.__hfFontsError ? "font gate failed: " + w.__hfFontsError : f; }
      if (!w.__essayTimeline || typeof w.__essayTimeline.seek !== "function") return "window.__essayTimeline.seek is missing: the page contract requires a seekable timeline";
      return "ok";
    })()`, { awaitPromise: true, timeoutMs: readyTimeoutMs + 5_000 });
    if (ready !== "ok") throw new Error(ready);
    await this.eval(`(${pageAgent.toString()})(), true`);
  }

  async eval<T>(expression: string, opts: { awaitPromise?: boolean; timeoutMs?: number } = {}): Promise<T> {
    const res = await this.cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: !!opts.awaitPromise }, this.sessionId, opts.timeoutMs ?? 60_000);
    if (res?.exceptionDetails) throw new Error(`page evaluation failed: ${String(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text).split("\n").slice(0, 2).join(" ")}`);
    return res?.result?.value as T;
  }

  /** Call the installed agent: `__veAudit.<method>(...args)`, optionally after seeking to `t` seconds. */
  call<T>(method: string, args: unknown[] = [], t?: number): Promise<T> {
    const seek = t === undefined ? "" : `__veAudit.seek(${JSON.stringify(t)}), `;
    return this.eval<T>(`(${seek}__veAudit.${method}(${args.map((a) => JSON.stringify(a)).join(", ")}))`);
  }

  async screenshot(clip: Rect): Promise<Bitmap> {
    const c = { x: Math.max(0, Math.floor(clip.x0)), y: Math.max(0, Math.floor(clip.y0)) };
    const w = Math.min(FRAME.w, Math.ceil(clip.x1)) - c.x, h = Math.min(FRAME.h, Math.ceil(clip.y1)) - c.y;
    invariant(w > 0 && h > 0, `screenshot clip ${fmtRect(clip)} is empty`);
    const res = await this.cdp.send("Page.captureScreenshot", { format: "png", clip: { ...c, width: w, height: h, scale: 1 }, captureBeyondViewport: false, fromSurface: true }, this.sessionId);
    return decodePng(Buffer.from(String(res.data), "base64"));
  }

  /** CSS.getPlatformFontsForNode for every element the agent marked with data-ve-audit-font. */
  async platformFonts(): Promise<Map<string, { familyName: string; isCustomFont: boolean; glyphCount: number }[]>> {
    const s = this.sessionId, out = new Map<string, { familyName: string; isCustomFont: boolean; glyphCount: number }[]>();
    const doc = await this.cdp.send("DOM.getDocument", { depth: 0 }, s);
    const { nodeIds } = await this.cdp.send("DOM.querySelectorAll", { nodeId: doc.root.nodeId, selector: "[data-ve-audit-font]" }, s);
    for (const nodeId of nodeIds as number[]) {
      const { attributes } = await this.cdp.send("DOM.getAttributes", { nodeId }, s);
      const at = (attributes as string[]).indexOf("data-ve-audit-font");
      if (at < 0) continue;
      const { fonts } = await this.cdp.send("CSS.getPlatformFontsForNode", { nodeId }, s);
      out.set(String(attributes[at + 1]), (fonts ?? []).map((f: any) => ({ familyName: String(f.familyName), isCustomFont: !!f.isCustomFont, glyphCount: Number(f.glyphCount) })));
    }
    return out;
  }

  async close(): Promise<void> {
    try { await this.cdp.send("Target.closeTarget", { targetId: this.targetId }, undefined, 10_000); } catch { /* the browser is going away with it */ }
  }
}

function killLiveBrowsers(): void {
  for (const b of liveBrowsers) void b.close();
}

// ─────────────────────────────────────────────────────────────── the page audit

export interface AuditScript { beats: { id: string; chapter?: string; visual: { type: string; [k: string]: unknown } }[] }
export interface AuditInput {
  /** The composed project's entry HTML. */
  entry: string;
  timeline: Timeline;
  script?: AuditScript;
  checks: PageCheck[];
  scope?: "badge";
  cameraStep?: number;
  /** The Visual types the composition must render (types check); defaults to schemaVisualTypes(). */
  types?: string[];
  /** Receives every beat's settle time (absolute seconds, null when it never settles) once the page is read. */
  onSettle?: (settle: { id: string; start: number; settle: number | null }[]) => void;
}

interface BeatPlan { id: string; index: number; from: number; last: number; start: number; type: string | null; scriptType: string | null; chapter: boolean; settleFrame: number | null; dom: DomBeat | null;
  /** An insert the end screen legitimately suppressed: it starts in the last END_SCREEN_WINDOW_S seconds. */
  suppressed: boolean }

const INSERT = (t: string | null) => t !== null && t !== "read";
/** Types whose pieces build on cues, so their beats must carry data-ve-reveal (DomContract). */
const CUED_TYPES = new Set(["diagram", "stat", "compare", "points", "race"]);

function beatPlans(tl: Timeline, dom: DomBeat[], script: AuditScript | undefined, contract: string[]): BeatPlan[] {
  const fps = tl.fps, total = Math.ceil(tl.total * fps);
  const byId = new Map(dom.map((d) => [d.id, d]));
  const known = new Set(tl.beats.map((b) => b.id));
  for (const d of dom) if (!known.has(d.id)) contract.push(`data-ve-beat="${d.id}" is not a beat in timeline.json`);
  return tl.beats.map((b, index) => {
    const from = Math.round(b.start * fps);
    const next = tl.beats[index + 1];
    const last = (next ? Math.round(next.start * fps) : total) - 1;
    const d = byId.get(b.id) ?? null;
    const sb = script?.beats.find((x) => x.id === b.id);
    let settleFrame: number | null = null;
    let suppressed = false;
    if (d?.suppressed !== null && d?.suppressed !== undefined) {
      const window0 = tl.total - END_SCREEN_WINDOW_S;
      if (d.suppressed === "end-screen" && b.start >= window0 - 1e-6) suppressed = true;
      else contract.push(`${b.id}: data-ve-suppressed="${d.suppressed}" on a beat starting at ${b.start.toFixed(2)}s; only an insert starting in the end-screen window (the last ${END_SCREEN_WINDOW_S} s, from ${window0.toFixed(2)}s) may be suppressed`);
    }
    if (!d) contract.push(`${b.id}: missing contract attribute data-ve-beat (no beat root in the page)`);
    else {
      if (!d.type) contract.push(`${b.id}: missing contract attribute data-ve-type`);
      else if (sb && sb.visual.type !== d.type) contract.push(`${b.id}: data-ve-type="${d.type}" but Script.json says ${sb.visual.type}`);
      const settle = d.settle === null ? NaN : Number(d.settle);
      if (d.settle === null) contract.push(`${b.id}: missing contract attribute data-ve-settle`);
      else if (!Number.isFinite(settle) || settle < 0) contract.push(`${b.id}: data-ve-settle="${d.settle}" is not a non-negative number of seconds`);
      else {
        settleFrame = from + Math.ceil(settle * fps - 1e-6);
        if (settleFrame > last) contract.push(`${b.id}: data-ve-settle ${settle}s lands after the beat ends (beat-local ${((last - from + 1) / fps).toFixed(2)}s); the beat never settles on screen`);
      }
    }
    return { id: b.id, index, from, last, start: b.start, type: d?.type ?? sb?.visual.type ?? null, scriptType: sb?.visual.type ?? null, chapter: !!sb?.chapter, settleFrame: settleFrame !== null && settleFrame <= last ? settleFrame : null, dom: d, suppressed };
  });
}

/** Everything drawn for an insert, filtered to real ink: visible against the paper, not the paper, not the badge. */
function inkOf(m: Measure): { texts: TextLine[]; shapes: Shape[]; paper: Rgba | null } {
  const paperC = m.paper ? parseColor(m.paper) : null;
  const paper = paperC && paperC[3] > 0.5 ? paperC : null;
  return {
    texts: m.texts.filter((t) => !t.badge && showsOn(t.color, paper)),
    shapes: m.shapes.filter((s) => !s.badge && !s.paper && (s.kind === "image" || showsOn(s.color, paper))),
    paper,
  };
}

const rectsOf = (ink: { texts: TextLine[]; shapes: Shape[] }, pick: (x: { inBlock: boolean; furniture: boolean }) => boolean): Rect[] =>
  [...ink.texts.filter(pick).map((t) => t.rect), ...ink.shapes.filter(pick).map((s) => s.rect)].filter((r) => area(r) > 0);

export function judgeCenter(u: Rect): { cx: number; cy: number; dx: number; dy: number; ok: boolean } {
  const cx = (u.x0 + u.x1) / 2, cy = (u.y0 + u.y1) / 2, dx = cx - OPTICAL.x, dy = cy - OPTICAL.y;
  return { cx, cy, dx, dy, ok: Math.abs(dx) <= OPTICAL.tolX && Math.abs(dy) <= OPTICAL.tolY };
}

/** Theme FILL targets on the block's ink union; the 55% width-or-height floor applies to every type. */
export function judgeFill(type: string, visual: Record<string, unknown> | undefined, u: Rect, texts: TextLine[]): { ok: boolean; detail: string } {
  const w = u.x1 - u.x0, h = u.y1 - u.y0, wf = w / GRID_W, hf = h / SAFE_H;
  const pct = (f: number) => `${Math.round(f * 1000) / 10}%`;
  const size = `ink ${Math.round(w)}×${Math.round(h)} px = ${pct(wf)} of the ${GRID_W} px grid, ${pct(hf)} of the ${SAFE_H} px safe height`;
  const problems: string[] = [];
  if (!(wf >= 0.55 || hf >= 0.55)) problems.push("below the 55% width-or-height floor");
  switch (type) {
    case "stat": {
      const figures = texts.filter((t) => t.inBlock && /\d/.test(t.text)).sort((a, b) => b.fontPx - a.fontPx);
      const fig = figures[0];
      if (!fig) problems.push("no figure (a text line with a digit) in the block");
      else {
        const figW = fig.rect.x1 - fig.rect.x0, wide = figW >= 1190;
        const floor = wide ? 180 : 0.21 * FRAME.h;
        if (fig.capPx < floor) problems.push(`figure "${fig.text}" cap height ${px(fig.capPx)} is under ${wide ? "180 px (width-capped figure)" : `21% of frame height (${px(floor)})`}`);
      }
      if (hf < 0.45) problems.push(`block height ${pct(hf)} is under 45% of the safe height`);
      break;
    }
    case "compare": {
      const l = (visual?.left as { text?: string } | undefined)?.text, r = (visual?.right as { text?: string } | undefined)?.text;
      if (typeof l !== "string" || typeof r !== "string") { problems.push("cannot tell a numeric from a text compare without Script.json's left.text and right.text"); break; }
      const numeric = isNumericCompare(l, r), need = numeric ? 0.9 : 0.85;
      if (wf < need) problems.push(`${numeric ? "numeric" : "text"} compare width ${pct(wf)} is under ${pct(need)}`);
      break;
    }
    case "diagram": if (wf < 0.8 || hf < 0.4) problems.push(`diagram needs width ≥ 80% and height ≥ 40% (has ${pct(wf)}, ${pct(hf)})`); break;
    case "points": break;
    case "quote": {
      const byBlock = new Map<number, TextLine[]>();
      for (const t of texts.filter((x) => x.inBlock)) byBlock.set(t.block, [...(byBlock.get(t.block) ?? []), t]);
      const body = [...byBlock.values()].sort((a, b) => b.reduce((n, t) => n + t.text.length, 0) - a.reduce((n, t) => n + t.text.length, 0))[0] ?? [];
      const widest = Math.max(0, ...body.map((t) => t.rect.x1 - t.rect.x0));
      if (widest > 1400 + 2) problems.push(`quote line ${Math.round(widest)} px is wider than the 1400 px measure`);
      if (body.length >= 2 && widest < 1100) problems.push(`a ${body.length}-line quote wraps at ${Math.round(widest)} px, under the 1100 px measure`);
      break;
    }
    case "title": if (wf < 0.55) problems.push(`title width ${pct(wf)} is under 55%`); break;
    case "race": if (wf < 0.85) problems.push(`race width ${pct(wf)} is under 85%`); break;
    case "code": if (wf < 0.6) problems.push(`code width ${pct(wf)} is under 60%`); break;
    case "screenshot": case "scroll": case "zoom": if (!(wf >= 0.75 || hf >= 0.8)) problems.push(`capture card needs width ≥ 75% or height ≥ 80% (has ${pct(wf)}, ${pct(hf)})`); break;
    default: break;
  }
  return { ok: problems.length === 0, detail: problems.length ? `${problems.join("; ")} (${size})` : size };
}

export function judgeSafe(m: Measure): string[] {
  const ink = inkOf(m), out: string[] = [];
  const K = m.badge ? keepOut(m.badge) : null;
  const items: { desc: string; rect: Rect; raw: Rect; kind: string }[] = [
    ...ink.texts.filter((t) => !t.furniture).map((t) => ({ desc: `text "${t.text.slice(0, 40)}"`, rect: t.rect, raw: t.raw, kind: "text" })),
    ...ink.shapes.filter((s) => !s.furniture).map((s) => ({ desc: `${s.kind} ${s.desc}`, rect: s.rect, raw: s.raw, kind: s.kind })),
  ];
  for (const it of items) {
    // Safe judges what is visible; a capture image cropped by its card is meant to be cropped, so only non-image
    // ink that loses part of itself to a clip (an ancestor or the frame edge) is reported as clipped.
    if (!inside(it.rect, SAFE)) out.push(`${it.desc} at ${fmtRect(it.rect)} crosses the graphics-safe box (${fmtRect(SAFE)})${it.kind !== "image" && !inside(it.raw, it.rect, 1) ? `; drawn at ${fmtRect(it.raw)}` : ""}`);
    else if (K && area(intersect(it.rect, K)) > 0.5) out.push(`${it.desc} at ${fmtRect(it.rect)} enters the badge keep-out (${fmtRect(K)})`);
    else if (it.kind !== "image" && area(it.raw) > 0 && !inside(it.raw, it.rect, 1)) out.push(`${it.desc} is clipped: drawn at ${fmtRect(it.raw)}, visible only at ${fmtRect(it.rect)}`);
  }
  return out;
}

export function judgeCollide(m: Measure): string[] {
  const ink = inkOf(m), out: string[] = [];
  const texts = ink.texts.filter((t) => !t.furniture);
  for (let i = 0; i < texts.length; i++) {
    for (let j = i + 1; j < texts.length; j++) {
      const a = texts[i], b = texts[j];
      if (a.block === b.block) continue;
      const x = intersect(a.rect, b.rect);
      if (x.x1 - x.x0 > 1 && x.y1 - x.y0 > 1) out.push(`text "${a.text.slice(0, 36)}" and text "${b.text.slice(0, 36)}" overlap at ${fmtRect(x)}`);
    }
  }
  const paper = ink.paper;
  const isPaper = (c: string) => { const p = parseColor(c); return !!p && !!paper && p[3] >= 0.95 && deltaE00(toLab(p), toLab(paper)) < INK_MIN_DE; };
  for (const s of ink.shapes.filter((x) => x.kind === "stroke" && !x.furniture && x.points.length)) {
    for (const t of texts) {
      const box = inflate(t.rect, s.strokePx / 2);
      if (area(intersect(box, inflate(s.rect, 1))) <= 0) continue;
      let hit: [number, number] | null = null;
      for (let k = 0; k < s.points.length; k += 2) {
        const x = s.points[k], y = s.points[k + 1];
        if (x < box.x0 || x > box.x1 || y < box.y0 || y > box.y1) continue;
        const haloed = t.halo !== null && t.halo.strokeFirst && t.halo.px >= 12 && isPaper(t.halo.color) && t.order > s.order;
        const chipped = t.chip !== null && isPaper(t.chip.color) && t.chip.order > s.order && x >= t.chip.rect.x0 && x <= t.chip.rect.x1 && y >= t.chip.rect.y0 && y <= t.chip.rect.y1;
        if (haloed || chipped) continue;
        hit = [x, y];
        break;
      }
      if (hit) out.push(`stroke ${s.desc} crosses text "${t.text.slice(0, 36)}" at (${Math.round(hit[0])}, ${Math.round(hit[1])})`);
    }
  }
  return out;
}

export function judgeLegibility(m: Measure): string[] {
  const ink = inkOf(m), out: string[] = [];
  const seen = new Set<number>();
  for (const t of ink.texts) {
    if (t.furniture || seen.has(t.owner) || t.fontPx >= TEXT_FLOOR_PX - 0.01) continue;
    seen.add(t.owner);
    out.push(`text "${t.text.slice(0, 40)}" renders at ${px(t.fontPx)}, under the ${TEXT_FLOOR_PX} px floor`);
  }
  for (const s of ink.shapes) if (s.kind === "stroke" && !s.furniture && s.strokePx < STROKE_FLOOR_PX - 0.01) out.push(`stroke ${s.desc} is ${px(s.strokePx)}, under the ${STROKE_FLOOR_PX} px floor`);
  return out;
}

const where = (b: BeatPlan) => `${b.id} ${b.type ?? "?"}`;

/** Audit an open, composed page. Every page check fails loudly on a broken contract; none passes on nothing measured. */
export async function auditPage(page: AuditPage, input: AuditInput): Promise<CheckReport[]> {
  const tl = input.timeline, fps = tl.fps;
  invariant(fps > 0 && tl.beats.length > 0, "timeline has no beats");
  const reports = new Map<PageCheck, CheckReport>(input.checks.map((c) => [c, report(c)]));
  const contract: string[] = [];
  const dom = await page.call<DomBeat[]>("beats");
  const plans = beatPlans(tl, dom, input.script, contract);
  input.onSettle?.(plans.map((p) => ({ id: p.id, start: p.start, settle: p.settleFrame === null ? null : p.settleFrame / fps })));
  const propsTl = await page.call<{ id: string; start: number }[] | null>("propsTimeline");
  if (propsTl && (propsTl.length !== tl.beats.length || propsTl.some((b, i) => b.id !== tl.beats[i].id || Math.abs(b.start - tl.beats[i].start) > 1e-6))) {
    contract.push("the page's staged props carry a different timeline than timeline.json: the composition is stale");
  }
  const errorsBefore = page.errors.length;
  for (const r of reports.values()) {
    for (const e of page.errors) fail(r, "page", "page-error", e);
    for (const c of contract) fail(r, "contract", "contract", c);
  }
  const t = (frame: number) => frame / fps;

  // ── settle measures, one per beat, shared by the layout checks and types
  const settle = new Map<string, Measure>();
  const measureAt = async (b: BeatPlan): Promise<Measure | null> => {
    if (b.settleFrame === null) return null;
    if (!settle.has(b.id)) settle.set(b.id, await page.call<Measure>("measure", [b.id, null, true], t(b.settleFrame)));
    return settle.get(b.id)!;
  };
  const layoutChecks = (["center", "fill", "safe", "collide", "legibility"] as const).filter((c) => reports.has(c));
  const inserts = plans.filter((b) => INSERT(b.type) && !b.suppressed);
  for (const b of plans.filter((x) => x.suppressed)) for (const r of reports.values()) r.notes.push(`${where(b)} starts at ${b.start.toFixed(2)}s, inside the end-screen window, and is suppressed (data-ve-suppressed="end-screen"); not measured`);

  // ── chapter cards: each measured at its fullest frame in its beat's first four seconds
  const chapterMeasures: { label: string; m: Measure; frame: number }[] = [];
  if (layoutChecks.length || reports.has("fonts")) {
    const wanted = input.script ? plans.filter((b) => b.chapter) : [];
    const domChapters = await page.call<ChapterScan[]>("chapterScan");
    const scanFor = input.script ? wanted : plans.filter((b) => domChapters.some((c) => c.beat === b.id));
    for (const b of scanFor) {
      let best: { index: number; ink: number; frame: number } | null = null;
      for (let f = b.from; f <= Math.min(b.last, b.from + 4 * fps); f += 2) {
        for (const c of await page.call<ChapterScan[]>("chapterScan", [], t(f))) if (c.visible && (!best || c.ink > best.ink)) best = { index: c.index, ink: c.ink, frame: f };
      }
      if (!best) {
        for (const r of reports.values()) if (r.check !== "camera" && r.check !== "sync" && r.check !== "seam" && r.check !== "types") fail(r, `${b.id} chapter`, "contract", "missing contract attribute data-ve-chapter: Script.json opens a chapter here, but no chapter card is visible in the beat's first 4 s");
        continue;
      }
      chapterMeasures.push({ label: `${b.id} chapter (frame ${best.frame})`, m: await page.call<Measure>("measure", [null, best.index, true], t(best.frame)), frame: best.frame });
    }
  }

  // ── layout: center, fill, safe, collide, legibility
  if (layoutChecks.length) {
    for (const b of inserts) {
      const m = await measureAt(b);
      if (!m) continue;
      const w = where(b);
      const problems: string[] = [];
      if (!m.found) problems.push("beat root not found at its settle frame");
      else {
        if (!m.rootVisible) problems.push("beat root is not visible at its settle frame");
        if (m.chapterVisible) problems.push("a chapter card is still on screen at the settle frame, covering the insert");
        if (m.blocks === 0) problems.push("missing contract attribute data-ve-block");
        for (const g of m.generated) problems.push(g);
      }
      const ink = m.found ? inkOf(m) : null;
      const blockRects = ink ? rectsOf(ink, (x) => x.inBlock && !x.furniture) : [];
      const u = union(blockRects);
      for (const c of layoutChecks) {
        const r = reports.get(c)!;
        if (problems.length) { for (const p of problems) fail(r, w, "contract", p); continue; }
        r.measured++;
        if (c === "center") {
          if (!u) { fail(r, w, "empty-block", "data-ve-block has no ink at the settle frame"); continue; }
          const j = judgeCenter(u);
          const msg = `ink centre (${Math.round(j.cx)}, ${Math.round(j.cy)}), off the optical centre by ${Math.round(j.dx)} x, ${Math.round(j.dy)} y (tolerance ±${OPTICAL.tolX}, ±${OPTICAL.tolY})`;
          if (j.ok) pass(r, w, msg); else fail(r, w, "off-center", msg);
        } else if (c === "fill") {
          if (!u) { fail(r, w, "empty-block", "data-ve-block has no ink at the settle frame"); continue; }
          const sv = input.script?.beats.find((x) => x.id === b.id)?.visual;
          const j = judgeFill(b.type ?? "", sv, u, ink!.texts);
          if (j.ok) pass(r, w, j.detail); else fail(r, w, "under-fill", j.detail);
        } else {
          const found = c === "safe" ? judgeSafe(m) : c === "collide" ? judgeCollide(m) : judgeLegibility(m);
          if (found.length === 0) pass(r, w, `${m.texts.length} text lines, ${m.shapes.length} shapes clear`);
          for (const f of found) fail(r, w, c === "safe" ? "unsafe" : c === "collide" ? "collision" : "illegible", f);
        }
        for (const n of m.notes) r.notes.push(`${w}: ${n}`);
      }
    }
    for (const { label, m } of chapterMeasures) {
      for (const c of layoutChecks) {
        if (c === "fill") continue;
        const r = reports.get(c)!;
        r.measured++;
        for (const g of m.generated) fail(r, label, "contract", g);
        const ink = inkOf(m);
        if (c === "center") {
          const u2 = union(rectsOf(ink, (x) => !x.furniture));
          if (!u2) { fail(r, label, "empty-block", "chapter card has no ink"); continue; }
          const j = judgeCenter(u2);
          const msg = `ink centre (${Math.round(j.cx)}, ${Math.round(j.cy)}), off the optical centre by ${Math.round(j.dx)} x, ${Math.round(j.dy)} y`;
          if (j.ok) pass(r, label, msg); else fail(r, label, "off-center", msg);
        } else {
          const found = c === "safe" ? judgeSafe(m) : c === "collide" ? judgeCollide(m) : judgeLegibility(m);
          if (found.length === 0) pass(r, label, `${m.texts.length} text lines, ${m.shapes.length} shapes clear`);
          for (const f of found) fail(r, label, c === "safe" ? "unsafe" : c === "collide" ? "collision" : "illegible", f);
        }
      }
    }
  }

  // ── fonts: every beat's settle frame and every chapter frame
  const fontsR = reports.get("fonts");
  if (fontsR) {
    const frames = [...plans.filter((b) => b.settleFrame !== null).map((b) => ({ label: where(b), frame: b.settleFrame! })), ...chapterMeasures.map((c) => ({ label: c.label, frame: c.frame }))];
    const scope = input.scope === "badge" ? "badge" : "all";
    const seen = new Map<string, string[]>();
    const add = (key: string, where: string) => seen.set(key, [...(seen.get(key) ?? []), where]);
    let owners = 0, badgeMissing = false;
    for (const { label, frame } of frames) {
      const state = await page.call<FontState>("fonts", [scope], t(frame));
      const fonts = await page.platformFonts();
      await page.call("unmark");
      if (scope === "badge" && !state.badgeFound) { badgeMissing = true; break; }
      fontsR.measured++;
      for (const g of state.generated) add(g, label);
      const embedded = new Set(state.embedded);
      for (const n of state.nonEmbedded) add(`@font-face "${n.family}" is not embedded (src ${n.src}); faces must be data: URIs, never local() or a file/web URL`, label);
      for (const o of state.owners) {
        owners++;
        const who = `${o.desc}`;
        if (!embedded.has(o.first.toLowerCase())) add(`${who} is set in "${o.first}", which is not an embedded @font-face family (declared: ${o.family})`, label);
        if (!o.check) add(`${who}: document.fonts.check("${o.spec}") is false`, label);
        if (o.fallsBack) add(`${who}: "${o.first}" falls back; its glyph widths equal the monospace, serif and sans-serif fallbacks`, label);
        for (const f of fonts.get(o.id) ?? []) if (!f.isCustomFont) add(`${who} paints ${f.glyphCount} glyph(s) in the system face "${f.familyName}"`, label);
        if (!fonts.has(o.id)) add(`${who}: the browser reported no platform font for it`, label);
      }
    }
    if (badgeMissing) fail(fontsR, "badge", "contract", "missing contract attribute data-ve-badge: --scope badge has nothing to audit");
    else if (owners === 0) fail(fontsR, "run", "nothing-measured", `no visible text found${scope === "badge" ? " in [data-ve-badge]" : ""} at any measured frame`);
    for (const [msg, at] of seen) fail(fontsR, at.length > 3 ? `${at.slice(0, 3).join(", ")} and ${at.length - 3} more` : at.join(", "), "font", msg);
    if (seen.size === 0 && owners > 0) pass(fontsR, `${fontsR.measured} frames`, `${owners} text-node owners, every one in an embedded face with no system glyphs`);
  }

  // ── sync: first visible frame of each reveal against its cue word
  const syncR = reports.get("sync");
  if (syncR) {
    for (const b of inserts) {
      if (b.settleFrame === null) continue;
      const initial = await page.call<RevealState[]>("reveals", [b.id], t(b.from));
      if (initial.length === 0) {
        if (CUED_TYPES.has(b.type ?? "")) fail(syncR, where(b), "contract", `missing contract attribute data-ve-reveal: a ${b.type} builds its pieces on cues`);
        continue;
      }
      const words = tl.beats[b.index].words;
      const first: (number | null)[] = initial.map((s) => (s.visible ? b.from : null));
      for (let f = b.from + 1; f <= b.last && first.some((x) => x === null); f++) {
        const states = await page.call<RevealState[]>("reveals", [b.id], t(f));
        states.forEach((s, i) => { if (s.visible && first[i] === null) first[i] = f; });
      }
      initial.forEach((s, i) => {
        syncR.measured++;
        const w = `${where(b)} reveal "${s.label}"`;
        const tokens = contentTokens(s.label);
        if (!s.label.trim()) { fail(syncR, w, "contract", "data-ve-reveal has an empty label"); return; }
        if (s.text && contentTokens(s.text).length > 0 && !tokens.some((k) => contentTokens(s.text).includes(k))) fail(syncR, w, "label-mismatch", `the label names none of the piece's own text ("${s.text.slice(0, 60)}")`);
        const f = first[i];
        if (f === null) { fail(syncR, w, "never-visible", "never becomes visible during its beat"); return; }
        const cue = cueWord(s.label, words);
        const shown = t(f);
        if (!cue) { pass(syncR, w, `visible at ${shown.toFixed(3)}s; no timed word names it, so it is unconstrained`); return; }
        const lead = cue.s - shown;
        const msg = `first visible at ${shown.toFixed(3)}s, word "${cue.w}" at ${cue.s.toFixed(3)}s (lead ${Math.round(lead * 1000)} ms, limit ${Math.round(SYNC_LEAD_S * 1000)} ms)`;
        if (lead > SYNC_LEAD_S + 1e-6) fail(syncR, w, "early", msg); else pass(syncR, w, msg);
      });
    }
  }

  // ── camera: read beats, every step frames
  const camR = reports.get("camera");
  if (camR) {
    const step = Math.max(1, Math.floor(input.cameraStep ?? 1));
    let lastKey = "", lastLeak: string | null = null;
    for (const b of plans.filter((x) => x.type === "read")) {
      let frames = 0, bad = 0, missing: string | null = null, highlightSeen = 0;
      const leaks: string[] = [];
      for (let f = b.from; f <= b.last; f += step) {
        const c = await page.call<CameraState>("camera", [b.id], t(f));
        frames++;
        highlightSeen = Math.max(highlightSeen, c.highlightCount);
        if (c.clip === null) { missing = "missing contract attribute data-ve-post-clip"; break; }
        if (c.clip === "hidden") continue;
        const parts = (c.clipAttr ?? "").split(",").map(Number);
        if (parts.length !== 4 || !parts.every(Number.isFinite) || parts[2] <= 0 || parts[3] <= 0) { missing = `data-ve-post-clip="${c.clipAttr}" is not "x,y,w,h" in post-image pixels`; break; }
        if (!c.image) { missing = "no visible <img> of the post page inside data-ve-post-clip"; break; }
        for (const hl of c.highlights) if (!inside(hl, { x0: 0, y0: 0, x1: FRAME.w, y1: FRAME.h })) { bad++; leaks.push(`frame ${f} (${t(f).toFixed(2)}s): highlight at ${fmtRect(hl)} leaves the frame`); }
        const img = c.image, sx = (img.rect.x1 - img.rect.x0) / img.natW, sy = (img.rect.y1 - img.rect.y0) / img.natH;
        const C: Rect = { x0: img.rect.x0 + parts[0] * sx, y0: img.rect.y0 + parts[1] * sy, x1: img.rect.x0 + (parts[0] + parts[2]) * sx, y1: img.rect.y0 + (parts[1] + parts[3]) * sy };
        const bands = c.visible ? subtract(c.visible, C) : [];
        if (!bands.length) continue;
        const key = JSON.stringify([img.rect, bands]);
        let verdict: string | null;
        if (key === lastKey) verdict = lastLeak;
        else {
          const paper = c.paper ? parseColor(c.paper) : null;
          if (!paper || paper[3] < 0.5) verdict = `the page shows outside the post column (${bands.map(fmtRect).join("; ")}) and no data-ve-paper colour is known to prove it blank`;
          else {
            const K = c.badge ? keepOut(c.badge) : null;
            const skip = [...(K ? [K] : []), ...c.furniture];
            let count = 0;
            for (const band of bands) {
              const shot = await page.screenshot(band);
              const ox = Math.max(0, Math.floor(band.x0)), oy = Math.max(0, Math.floor(band.y0));
              const plab = toLab(paper);
              for (let y = 0; y < shot.height; y++) for (let x = 0; x < shot.width; x++) {
                const X = ox + x, Y = oy + y;
                const o = (y * shot.width + x) * 4;
                // Pixels within 2/255 per channel of the paper are paper; only the rest pay for a ΔE.
                if (Math.abs(shot.data[o] - paper[0]) + Math.abs(shot.data[o + 1] - paper[1]) + Math.abs(shot.data[o + 2] - paper[2]) <= 6) continue;
                if (skip.some((r) => X >= r.x0 && X < r.x1 && Y >= r.y0 && Y < r.y1)) continue;
                if (deltaE00(toLab([shot.data[o], shot.data[o + 1], shot.data[o + 2]]), plab) > LEAK_PIXEL_DE) count++;
              }
            }
            verdict = count >= LEAK_MIN_PIXELS ? `${count} page pixels show outside the post column + 64 px (${bands.map(fmtRect).join("; ")})` : null;
          }
          lastKey = key; lastLeak = verdict;
        }
        if (verdict) { bad++; leaks.push(`frame ${f} (${t(f).toFixed(2)}s): ${verdict}`); }
      }
      if (missing) { fail(camR, where(b), "contract", missing); continue; }
      if (highlightSeen === 0) fail(camR, where(b), "contract", "missing contract attribute data-ve-highlight");
      camR.measured++;
      if (bad === 0) pass(camR, where(b), `${frames} frames sampled, the page stays inside the post column and the highlight inside the frame`);
      else fail(camR, where(b), "camera", `${bad} of ${frames} sampled frames fail; first: ${leaks.slice(0, 3).join(" | ")}`);
    }
  }

  // ── seam: paper on both sides of every page↔insert cut
  const seamR = reports.get("seam");
  if (seamR) {
    const paperAt = async (frame: number) => {
      const info = await page.call<FrameInfo>("frameInfo", [], t(frame));
      const shot = await page.screenshot({ x0: 0, y0: 0, x1: FRAME.w, y1: FRAME.h });
      const skip = [...(info.badge ? [keepOut(info.badge)] : []), ...info.furniture];
      return { dom: info.paper, px: dominantColor(shot, skip) };
    };
    for (let i = 0; i + 1 < plans.length; i++) {
      const a = plans[i], b = plans[i + 1];
      if (a.suppressed || b.suppressed || !((a.type === "read" && INSERT(b.type)) || (INSERT(a.type) && b.type === "read"))) continue;
      const w = `${a.id} ${a.type} → ${b.id} ${b.type}`;
      const cut = b.from;
      const [pa, pb] = [await paperAt(cut - 1), await paperAt(cut)];
      if (!pa.px || !pb.px || pa.px.share < 0.25 || pb.px.share < 0.25) { fail(seamR, w, "no-paper", `no dominant paper colour on one side of the cut (shares ${Math.round((pa.px?.share ?? 0) * 100)}%, ${Math.round((pb.px?.share ?? 0) * 100)}%)`); continue; }
      seamR.measured++;
      const dE = deltaE00(toLab(pa.px.color), toLab(pb.px.color));
      const msg = `paper ${hex(pa.px.color)} (frame ${cut - 1}) vs ${hex(pb.px.color)} (frame ${cut}): ΔE00 ${dE.toFixed(2)} (limit < ${SEAM_MAX_DE}); data-ve-paper ${pa.dom ?? "none"} / ${pb.dom ?? "none"}`;
      if (dE < SEAM_MAX_DE) pass(seamR, w, msg); else fail(seamR, w, "seam", msg);
    }
  }

  // ── empty: no blank frame after the first second, beyond an ink-swap gap
  const emptyR = reports.get("empty");
  if (emptyR) {
    const totalFrames = Math.ceil(tl.total * fps);
    const firstFrame = Math.ceil(EMPTY_FROM_S * fps);
    const samples = new Set<number>();
    for (let s = EMPTY_FROM_S; s < tl.total; s += EMPTY_STEP_S) samples.add(Math.round(s * fps));
    for (const b of plans) { samples.add(b.from); samples.add(b.last); }
    const cache = new Map<number, { empty: boolean; ground: string | null }>();
    const isEmpty = async (f: number) => {
      const hit = cache.get(f);
      if (hit) return hit.empty;
      const fr = await page.call<FrameInkState>("frameInk", [], t(f));
      const g = fr.ground ? parseColor(fr.ground) : null;
      const ground = g && g[3] > 0.5 ? g : null;
      const empty = !fr.texts.some((x) => showsOn(x.color, ground)) && !fr.shapes.some((x) => x.kind === "image" || showsOn(x.color, ground));
      cache.set(f, { empty, ground: fr.ground });
      return empty;
    };
    const runs: [number, number][] = [];
    for (const f of [...samples].filter((f) => f >= firstFrame && f < totalFrames).sort((a, b) => a - b)) {
      emptyR.measured++;
      if (runs.some(([a, b]) => f >= a && f <= b) || !(await isEmpty(f))) continue;
      let a = f, b = f;
      while (a - 1 >= firstFrame && (await isEmpty(a - 1))) a--;
      while (b + 1 < totalFrames && (await isEmpty(b + 1))) b++;
      runs.push([a, b]);
    }
    for (const [a, b] of runs) {
      const n = b - a + 1;
      const beat = plans.find((p) => a >= p.from && a <= p.last);
      const span = `${t(a).toFixed(3)}–${t(b + 1).toFixed(3)}s (frames ${a}–${b}, ${n} frame${n === 1 ? "" : "s"})`;
      if (n <= INK_SWAP_MAX_FRAMES) pass(emptyR, beat ? where(beat) : "frame", `empty ${span}: an ink-swap gap of at most ${INK_SWAP_MAX_FRAMES} frames`);
      else fail(emptyR, beat ? where(beat) : "frame", "empty-frame", `no ink on screen for ${span}; ground ${cache.get(a)?.ground ?? "unknown"}`);
    }
    if (runs.length === 0 && emptyR.measured > 0) pass(emptyR, `${emptyR.measured} sampled frames`, `every sample from ${EMPTY_FROM_S}s to ${tl.total.toFixed(2)}s has ink`);
  }

  // ── types: every accepted Visual type renders a non-empty block
  const typesR = reports.get("types");
  if (typesR) {
    const want = input.types ?? schemaVisualTypes().types;
    const rendered = new Map<string, string[]>();
    const empty = new Map<string, string[]>();
    for (const b of plans) {
      if (!b.type || b.settleFrame === null || b.suppressed) continue;
      let ok = false;
      if (b.type === "read") {
        const c = await page.call<CameraState>("camera", [b.id], t(b.settleFrame));
        ok = !!c.image && !!c.visible && area(c.visible) > 0;
        if (!ok) { const m = await measureAt(b); ok = !!m && m.found && rectsOf(inkOf(m), (x) => x.inBlock && !x.furniture).length > 0; }
      } else {
        const m = await measureAt(b);
        ok = !!m && m.found && rectsOf(inkOf(m), (x) => x.inBlock && !x.furniture).length > 0;
      }
      (ok ? rendered : empty).set(b.type, [...((ok ? rendered : empty).get(b.type) ?? []), b.id]);
    }
    for (const ty of want) {
      typesR.measured++;
      const got = rendered.get(ty);
      if (got) pass(typesR, ty, `non-empty data-ve-block on ${got.slice(0, 4).join(", ")}${got.length > 4 ? ` and ${got.length - 4} more` : ""}${empty.has(ty) ? `; empty on ${empty.get(ty)!.join(", ")}` : ""}`);
      else fail(typesR, ty, "type-missing", empty.has(ty) ? `renders only empty blocks (${empty.get(ty)!.join(", ")})` : "no beat of this type in the run renders");
    }
  }

  for (const r of reports.values()) for (const e of page.errors.slice(errorsBefore)) fail(r, "page", "page-error", `while seeking: ${e}`);
  return [...reports.values()].map((r) => close(r, r.check === "types" ? "types" : r.check === "seam" ? "page↔insert cuts" : r.check === "sync" ? "reveals" : r.check === "empty" ? "frames" : "beats"));
}

// ─────────────────────────────────────────────────────────────── static checks

/** The Visual union in CompositionTypes.ts (string literal `type`s, following referenced aliases), cross-checked against Lib.ts VISUAL_TYPES. */
export function schemaVisualTypes(src = readFileSync(join(compositionDir(), "CompositionTypes.ts"), "utf8")): { types: string[]; drift: string[] } {
  const decl = (name: string): string | null => {
    const at = src.search(new RegExp(`export type ${name}\\s*=`));
    if (at < 0) return null;
    let depth = 0, i = src.indexOf("=", at) + 1;
    const start = i;
    for (; i < src.length; i++) {
      const ch = src[i];
      if ("{([<".includes(ch)) depth++;
      else if ("})]>".includes(ch)) depth--;
      else if (ch === ";" && depth === 0) break;
    }
    return src.slice(start, i);
  };
  const out = new Set<string>(), seen = new Set<string>();
  const walk = (name: string) => {
    if (seen.has(name)) return;
    seen.add(name);
    const body = decl(name);
    if (body === null) return;
    for (const m of body.matchAll(/\btype:\s*"([a-z]+)"/g)) out.add(m[1]);
    const top = body.replace(/\{[^{}]*\}/g, "");
    for (const m of top.matchAll(/\b([A-Z]\w*Visual)\b/g)) walk(m[1]);
  };
  walk("Visual");
  const types = [...out];
  const drift = [...[...VISUAL_TYPES].filter((t) => !out.has(t)).map((t) => `Lib.ts VISUAL_TYPES has "${t}" but CompositionTypes.ts Visual does not`), ...types.filter((t) => !VISUAL_TYPES.has(t)).map((t) => `CompositionTypes.ts Visual has "${t}" but Lib.ts VISUAL_TYPES does not`)];
  return { types, drift };
}

/** WOFF2's known-table index (spec §5.1); `name` is 5 and is never transformed. */
const WOFF2_TAGS = ["cmap", "head", "hhea", "hmtx", "maxp", "name", "OS/2", "post", "cvt ", "fpgm", "glyf", "loca", "prep", "CFF ", "VORG", "EBDT", "EBLC", "gasp", "hdmx", "kern", "LTSH", "PCLT", "VDMX", "vhea", "vmtx", "BASE", "GDEF", "GPOS", "GSUB", "EBSC", "JSTF", "MATH", "CBDT", "CBLC", "COLR", "CPAL", "SVG ", "sbix", "acnt", "avar", "bdat", "bloc", "bsln", "cvar", "fdsc", "feat", "fmtx", "fvar", "gvar", "hsty", "just", "lcar", "mort", "morx", "opbd", "prop", "trak", "Zapf", "Silf", "Glat", "Gloc", "Feat", "Sill"];

/** The raw name table of an sfnt (TrueType, OpenType, the first face of a collection), WOFF or WOFF2 file, or null. */
function nameTable(bytes: Uint8Array): Uint8Array | null {
  if (bytes.length < 12) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sig = String.fromCharCode(...bytes.subarray(0, 4));
  if (sig === "wOFF") {
    if (bytes.length < 44) return null;
    const n = dv.getUint16(12);
    for (let i = 0; i < n; i++) {
      const rec = 44 + i * 20;
      if (rec + 20 > bytes.length) return null;
      if (String.fromCharCode(...bytes.subarray(rec, rec + 4)) !== "name") continue;
      const off = dv.getUint32(rec + 4), comp = dv.getUint32(rec + 8), orig = dv.getUint32(rec + 12);
      const data = bytes.subarray(off, off + comp);
      return comp < orig ? new Uint8Array(inflateSync(data)) : data;
    }
    return null;
  }
  if (sig === "wOF2") {
    if (bytes.length < 48 || dv.getUint32(4) === 0x74746366) return null; // a WOFF2 collection: no single face to read
    const n = dv.getUint16(12), compressed = dv.getUint32(20);
    let p = 48, start = -1, length = 0, offset = 0;
    const base128 = (): number => {
      let v = 0;
      for (let k = 0; k < 5; k++) { const b = bytes[p++]; v = v * 128 + (b & 0x7f); if (!(b & 0x80)) return v; }
      return -1;
    };
    for (let i = 0; i < n; i++) {
      if (p >= bytes.length) return null;
      const flags = bytes[p++];
      let tag = WOFF2_TAGS[flags & 0x3f];
      if ((flags & 0x3f) === 63) { tag = String.fromCharCode(...bytes.subarray(p, p + 4)); p += 4; }
      const orig = base128(), version = flags >> 6;
      const transformed = tag === "glyf" || tag === "loca" ? version !== 3 : version !== 0;
      const stored = transformed ? base128() : orig;
      if (orig < 0 || stored < 0) return null;
      if (tag === "name") { start = offset; length = orig; }
      offset += stored;
    }
    if (start < 0 || p + compressed > bytes.length) return null;
    const stream = new Uint8Array(brotliDecompressSync(bytes.subarray(p, p + compressed)));
    return start + length <= stream.length ? stream.subarray(start, start + length) : null;
  }
  const base = sig === "ttcf" ? dv.getUint32(12) : 0;
  if (base + 12 > bytes.length) return null;
  const tag = dv.getUint32(base);
  if (tag !== 0x00010000 && tag !== 0x4f54544f && tag !== 0x74727565) return null;
  const n = dv.getUint16(base + 4);
  for (let i = 0; i < n; i++) {
    const rec = base + 12 + i * 16;
    if (rec + 16 > bytes.length) return null;
    if (String.fromCharCode(...bytes.subarray(rec, rec + 4)) !== "name") continue;
    const off = dv.getUint32(rec + 8), length = dv.getUint32(rec + 12);
    return bytes.subarray(off, off + length);
  }
  return null;
}

/** Family names from a font's name table (IDs 16, 1, 4), or null when it is not an sfnt, WOFF or WOFF2 file. */
export function fontNames(bytes: Uint8Array): string[] | null {
  let table: Uint8Array | null;
  try { table = nameTable(bytes); } catch { return null; }
  if (!table || table.length < 6) return null;
  const dv = new DataView(table.buffer, table.byteOffset, table.byteLength);
  const count = dv.getUint16(2), strings = dv.getUint16(4);
  const found = new Map<number, string>();
  for (let k = 0; k < count; k++) {
    const r = 6 + k * 12;
    if (r + 12 > table.length) break;
    const platform = dv.getUint16(r), nameId = dv.getUint16(r + 6), length = dv.getUint16(r + 8), so = dv.getUint16(r + 10);
    if (![1, 4, 16].includes(nameId) || found.has(nameId) && platform !== 3) continue;
    const raw = table.subarray(strings + so, strings + so + length);
    let s = "";
    if (platform === 3 || platform === 0) for (let j = 0; j + 1 < raw.length; j += 2) s += String.fromCharCode((raw[j] << 8) | raw[j + 1]);
    else if (platform === 1) s = String.fromCharCode(...raw);
    else continue;
    if (s) found.set(nameId, s);
  }
  return [16, 1, 4].map((id) => found.get(id)).filter((s): s is string => !!s);
}

const FONT_EXT = /\.(otf|ttf|woff2?)$/i;
function fontPathsOf(v: unknown): string[] {
  if (typeof v === "string") return FONT_EXT.test(v) ? [v] : [];
  if (Array.isArray(v)) return v.flatMap(fontPathsOf);
  if (v && typeof v === "object") return Object.values(v).flatMap(fontPathsOf);
  return [];
}

export function checkConfig(fonts: unknown = (loadSkillConfig() as { fonts?: unknown }).fonts, families: unknown = (loadSkillConfig() as { fontFamilies?: unknown }).fontFamilies, baseDir: string = dirname(skillConfigPath())): CheckReport {
  const r = report("config");
  if (!fonts || typeof fonts !== "object") { fail(r, "Config.json", "contract", "has no fonts object"); return close(r, "font roles"); }
  const roles = fonts as Record<string, unknown>;
  let expected: Partial<Record<FaceId, string[]>>;
  try { expected = familyMatchers(families); } catch (e) { fail(r, "Config.json fontFamilies", "contract", (e as Error).message); return close(r, "font roles"); }
  for (const role of FACE_IDS) {
    const paths = fontPathsOf(roles[role]);
    if (!(role in roles)) { fail(r, `fonts.${role}`, "missing-role", `missing: the ${role} face (${FACES[role].role})`); continue; }
    if (paths.length === 0) { fail(r, `fonts.${role}`, "missing-role", "names no font file (.otf/.ttf/.woff/.woff2)"); continue; }
    r.measured++;
    for (const p of paths) {
      const file = resolveConfigPath(p, baseDir);
      if (!existsSync(file)) { fail(r, `fonts.${role}`, "missing-file", `${p} does not exist`); continue; }
      const bytes = new Uint8Array(readFileSync(file));
      if (!sniffFontFormat(bytes)) { fail(r, `fonts.${role}`, "not-a-font", `${p} is not a font file`); continue; }
      const names = fontNames(bytes);
      if (!names) { fail(r, `fonts.${role}`, "unreadable", `${p}: cannot read its name table (OpenType/TrueType/WOFF/WOFF2 expected)`); continue; }
      const want = expected[role];
      if (want && !names.some((n) => want.some((w) => familyMatches(n, w)))) fail(r, `fonts.${role}`, "wrong-face", `${p} is "${names[0]}", not the ${role} face (fontFamilies: ${want.join(" | ")})`);
      else pass(r, `fonts.${role}`, `${p} is "${names[0]}"`);
    }
  }
  for (const [role, v] of Object.entries(roles)) {
    if (isFaceId(role)) continue;
    for (const p of fontPathsOf(v)) if (!existsSync(resolveConfigPath(p, baseDir))) fail(r, `fonts.${role}`, "missing-file", `${p} does not exist`);
  }
  return close(r, "font roles");
}

/** Every number and colour in an exported value tree, with its path; functions are skipped. */
export function themeConstants(mod: Record<string, unknown>): { path: string; value: number | string }[] {
  const out: { path: string; value: number | string }[] = [];
  const walk = (v: unknown, path: string, depth: number) => {
    if (depth > 8) return;
    if (typeof v === "number" && Number.isFinite(v)) out.push({ path, value: v });
    else if (typeof v === "string" && /^(#[0-9a-f]{3,8}|rgba?\([^)]*\))$/i.test(v.trim())) out.push({ path, value: v.trim() });
    else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`, depth + 1));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`, depth + 1);
  };
  for (const [k, v] of Object.entries(mod)) if (typeof v !== "function") walk(v, k, 0);
  return out;
}

/** Whether `doc` states the value: numbers as a standalone token at any precision down to 2 decimals, colours case-insensitively. */
export function docStates(doc: string, value: number | string): boolean {
  const text = doc.replace(/−/g, "-");
  if (typeof value === "string") {
    const v = value.toLowerCase().replace(/\s+/g, ""), d = text.toLowerCase().replace(/(rgba?\()([^)]*)\)/g, (_, a: string, b: string) => a + b.replace(/\s+/g, "") + ")");
    if (d.includes(v)) return true;
    const m = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(v);
    return !!m && d.includes(`#${m[1]}${m[1]}${m[2]}${m[2]}${m[3]}${m[3]}`);
  }
  const forms = new Set([String(value)]);
  if (!Number.isInteger(value)) for (let p = 2; p <= 4; p++) forms.add(String(Number(value.toFixed(p))));
  return [...forms].some((f) => new RegExp(`(^|[^\\d.])${f.replace(/[.+-]/g, (c) => `\\${c}`)}(?![\\d])`).test(text));
}

export async function checkStyleDoc(): Promise<CheckReport> {
  const r = report("style-doc");
  const docPath = join(skillDir(), "References", "Style.md");
  if (!existsSync(docPath)) { fail(r, "References/Style.md", "missing", "does not exist"); return close(r, "constants"); }
  let mod: Record<string, unknown>;
  try { mod = await import(join(compositionDir(), "Theme.ts")); } catch (e) { fail(r, "Theme.ts", "unloadable", (e as Error).message); return close(r, "constants"); }
  const doc = readFileSync(docPath, "utf8");
  const missing: string[] = [];
  for (const c of themeConstants(mod)) { r.measured++; if (!docStates(doc, c.value)) missing.push(`${c.path} = ${c.value}`); }
  if (missing.length) fail(r, "References/Style.md", "undocumented", `${missing.length} of ${r.measured} Theme.ts constants are not stated: ${missing.join(", ")}`);
  else pass(r, "References/Style.md", `states all ${r.measured} Theme.ts numbers and colours`);
  return close(r, "Theme.ts constants");
}

export const fontFilesIn = (paths: string[]): string[] => paths.filter((p) => FONT_EXT.test(p));

export function checkGitFonts(repos: string[] = forbiddenRunRoots()): CheckReport {
  const r = report("git-fonts");
  for (const repo of repos) {
    const p = Bun.spawnSync(["git", "-C", repo, "ls-files", "-z"], { stdout: "pipe", stderr: "pipe", timeout: 60_000 });
    if (p.exitCode !== 0) { fail(r, repo, "git", `git ls-files failed: ${p.stderr.toString().trim().slice(0, 200)}`); continue; }
    r.measured++;
    const tracked = fontFilesIn(p.stdout.toString().split("\0").filter(Boolean));
    if (tracked.length) fail(r, repo, "tracked-font", `${tracked.length} font file(s) tracked: ${tracked.slice(0, 10).join(", ")}${tracked.length > 10 ? " …" : ""}`);
    else pass(r, repo, "no font files tracked");
  }
  return close(r, "repos");
}

// ─────────────────────────────────────────────────────────────── staging (a private copy, never the run's own stage)

const AUDIT_SUFFIX = "--audit";

/** Remove a directory this tool created, only inside `root` (symlinks dereferenced before the boundary check). */
function removeOwned(dir: string, root: string, suffix: string): void {
  if (!existsSync(dir)) return;
  const real = realpathSync(dir), realRoot = realpathSync(root);
  invariant(real.startsWith(realRoot + sep) && real.endsWith(suffix), `refusing to remove ${real}: not an audit directory under ${realRoot}`);
  rmSync(real, { recursive: true, force: true });
}

const clone = (src: string, dst: string) => copyFileSync(src, dst, fsc.COPYFILE_FICLONE);

/**
 * Copy what staging reads (run.json, Script.json under the audit slug, the timeline and audio, Assets, Source) into a
 * temp run, so stageRun writes public/runs/<slug>--audit and never touches the stage a render of the real run may be reading.
 */
function copyRunForAudit(runDir: string, script: Script): string {
  const tmp = mkdtempSync(join(tmpdir(), "ve-audit-run-"));
  const p = runPaths(runDir), q = runPaths(tmp);
  const slug = `${script.slug}${AUDIT_SUFFIX}`;
  invariant(/^[a-z0-9-]+$/.test(slug), `audit slug ${slug} is not kebab-case`);
  if (existsSync(p.meta)) clone(p.meta, q.meta);
  writeJson(q.script, { ...script, slug });
  mkdirSync(q.narration, { recursive: true });
  clone(p.timeline, q.timeline);
  clone(p.narrationWav, q.narrationWav);
  if (existsSync(p.bedWav)) clone(p.bedWav, q.bedWav);
  for (const dir of [p.assets, p.source]) {
    if (!existsSync(dir)) continue;
    const to = dir === p.assets ? q.assets : q.source;
    mkdirSync(to, { recursive: true });
    for (const f of readdirSync(dir)) if (lstatSync(join(dir, f)).isFile()) clone(join(dir, f), join(to, f));
  }
  return tmp;
}

/** Stage and compose a run dir through the skill's own functions; returns the project entry and a cleanup. */
async function composeForAudit(runDir: string): Promise<{ entry: string; cleanup: () => void }> {
  const slug = readJson<Script>(runPaths(runDir).script).slug;
  invariant(slug.endsWith(AUDIT_SUFFIX) || slug === TYPES_SLUG, `refusing to stage ${slug}: the audit stages only its own copies (…${AUDIT_SUFFIX}, ${TYPES_SLUG})`);
  const runsDir = join(publicDir(), "runs");
  const stage = join(runsDir, slug);
  // stageRun creates the stage before its own checks run, so a refused run still leaves a directory to remove.
  const cleanup = () => removeOwned(stage, runsDir, slug.endsWith(AUDIT_SUFFIX) ? AUDIT_SUFFIX : TYPES_SLUG);
  try {
    const { stageRun } = await import("./Build.ts");
    const { composeEssay } = await import("./Compose.ts");
    const { props } = stageRun(runDir);
    invariant(props.script.slug === slug, `stageRun staged ${props.script.slug}, expected ${slug}`);
    await composeEssay(stage, props);
  } catch (e) {
    cleanup();
    throw e;
  }
  return { entry: join(stage, "index.html"), cleanup };
}

// ─────────────────────────────────────────────────────────────── the synthesized every-type run (types, no --run)

export const TYPES_SLUG = "design-audit-types";

function silenceWav(seconds: number, rate = 16_000): Uint8Array {
  const n = Math.ceil(seconds * rate), buf = new Uint8Array(44 + n * 2), dv = new DataView(buf.buffer);
  const s = (o: number, t: string) => [...t].forEach((c, i) => dv.setUint8(o + i, c.charCodeAt(0)));
  s(0, "RIFF"); dv.setUint32(4, 36 + n * 2, true); s(8, "WAVE"); s(12, "fmt "); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, rate, true); dv.setUint32(28, rate * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); s(36, "data"); dv.setUint32(40, n * 2, true);
  return buf;
}

/** One beat of every Visual type, with synthesized captures, post page and silent narration; nothing personal and nothing fetched. */
export function synthesizeTypesRun(dir: string, types: string[]): void {
  invariant(realpathSync(dir).startsWith(realpathSync(tmpdir())), `the synthesized run must live under the temp dir, got ${dir}`);
  const p = runPaths(dir);
  const PAPER: Rgba = [244, 241, 234, 1], INK: Rgba = [40, 38, 34, 1];
  const visuals: Record<string, Record<string, unknown>> = {
    title: { type: "title", title: "Every visual type", subtitle: "One beat each, rendered and measured" },
    points: { type: "points", heading: "Three points", points: ["The first point", "The second point", "The third point"] },
    compare: { type: "compare", left: { label: "Before", text: "40%" }, right: { label: "After", text: "80%" } },
    stat: { type: "stat", value: "42", label: "of 100 samples" },
    quote: { type: "quote", text: "A quoted sentence that the essay sets apart.", attribution: "A Source" },
    diagram: { type: "diagram", nodes: [{ id: "a", label: "Input" }, { id: "b", label: "Router" }, { id: "c", label: "Output" }], edges: [{ from: "a", to: "b" }, { from: "b", to: "c", label: "routes" }] },
    race: { type: "race", from: "Start", to: "Finish", lanes: [{ label: "Fast lane", result: "first" }, { label: "Slow lane", result: "second", gates: 3 }] },
    code: { type: "code", lang: "ts", code: "const total = items.reduce((a, b) => a + b, 0);\nconsole.log(total);" },
    screenshot: { type: "screenshot", url: "https://example.com/screenshot" },
    scroll: { type: "scroll", url: "https://example.com/scroll" },
    zoom: { type: "zoom", url: "https://example.com/zoom", selector: "main" },
  };
  // It opens and closes on the page: the closing read beat covers the end-screen window, so every insert starts before it.
  const order = ["read", ...types.filter((t) => t !== "read"), "read"];
  const unknown = order.filter((t) => t !== "read" && !visuals[t]);
  invariant(unknown.length === 0, `no synthesized visual for type(s) ${unknown.join(", ")}: add one to synthesizeTypesRun`);
  const SPAN = 4, TAIL = END_SCREEN_WINDOW_S + 4;
  const spans = order.map((_, n) => (n === order.length - 1 ? TAIL : SPAN));
  const starts = spans.map((_, n) => spans.slice(0, n).reduce((a, b) => a + b, 0));
  const readTexts = ["The page reads this sentence aloud while the camera follows it.", "The closing paragraph stays on the page while the end screen waits for the last words to finish."];
  const words: { w: string; s: number; e: number; p?: string; i?: number }[][] = [];
  const beats = order.map((type, n) => {
    const id = `beat-${n + 1}`;
    const para = n === 0 ? "p1" : "p2";
    const text = type === "read" ? readTexts[n === 0 ? 0 : 1] : `This beat shows the ${type} insert with its pieces named aloud: ${JSON.stringify(visuals[type]).replace(/[^A-Za-z ]+/g, " ").replace(/\b(type|label|text|id|from|to|nodes|edges|lanes|result|gates|url|https|example|com|selector|lang|code|heading|points|left|right|value|title|subtitle|attribution)\b/g, "").replace(/\s+/g, " ").trim()}`;
    const ws = text.split(" "), s0 = starts[n], d = spans[n];
    words.push(ws.map((w, i) => ({ w, s: s0 + 0.2 + (i * (d - 0.6)) / ws.length, e: s0 + 0.2 + ((i + 0.8) * (d - 0.6)) / ws.length, ...(type === "read" ? { p: para, i } : {}) })));
    return { id, ...(n === 0 ? { chapter: "Every visual type" } : {}), narration: text, visual: type === "read" ? { type: "read", paragraphs: [para] } : visuals[type] };
  });
  const total = starts[starts.length - 1] + TAIL;
  invariant(starts.slice(1, -1).every((s0) => s0 + SPAN <= total - END_SCREEN_WINDOW_S), "every synthesized insert must end before the end-screen window");
  const url = "https://example.com/every-visual-type";
  writeJson(p.meta, { slug: TYPES_SLUG, title: "Every visual type", mode: "voice", narrator: "da", source: { url, title: "Every visual type" }, createdAt: new Date(0).toISOString() });
  writeJson(p.script, { title: "Every visual type", slug: TYPES_SLUG, targetMinutes: total / 60, source: { url, title: "Every visual type", author: "" }, beats });
  writeJson(p.timeline, { fps: 30, gap: 0, total, narration: "narration.wav", beats: beats.map((b, n) => ({ id: b.id, start: starts[n], end: starts[n] + spans[n], words: words[n], chunk: "" })) });
  mkdirSync(p.narration, { recursive: true });
  writeFileSync(p.narrationWav, silenceWav(total));
  mkdirSync(p.assets, { recursive: true });
  mkdirSync(p.source, { recursive: true });
  writeJson(join(p.source, "post.json"), { title: "Every visual type", url, slug: "every-visual-type", links: [], paragraphs: readTexts.map((text, i) => ({ id: `p${i + 1}`, text })) });
  const PW = 1600, PH = 2400, lines: Rect[][] = [[{ x0: 360, y0: 400, x1: 1240, y1: 440 }, { x0: 360, y0: 470, x1: 1100, y1: 510 }], [{ x0: 360, y0: 600, x1: 1240, y1: 640 }, { x0: 360, y0: 670, x1: 1180, y1: 710 }]];
  writeFileSync(join(p.assets, "post.png"), encodePng(paintBitmap(PW, PH, PAPER, [{ r: { x0: 0, y0: 0, x1: 220, y1: PH }, c: [210, 206, 196, 1] }, ...lines.flat().map((r) => ({ r, c: INK }))])));
  writeJson(join(p.assets, "post.meta.json"), { url, width: PW, height: PH, cssWidth: PW / 2 });
  writeJson(join(p.assets, "post.sentences.json"), { pageWidth: PW, pageHeight: PH, title: { x: 360, y: 200, w: 880, h: 90 }, sentences: readTexts.map((t, k) => ({ id: `p${k + 1}-s1`, p: `p${k + 1}`, i0: 0, i1: t.split(" ").length - 1, rects: lines[k].map((r) => ({ x: r.x0, y: r.y0, w: r.x1 - r.x0, h: r.y1 - r.y0 })) })) });
  const CW = 1600, CH = 1000;
  for (const b of beats) {
    const t = (b.visual as { type: string }).type;
    if (t !== "screenshot" && t !== "scroll" && t !== "zoom") continue;
    writeFileSync(join(p.assets, `${b.id}.png`), encodePng(paintBitmap(CW, CH, [255, 255, 255, 1], [{ r: { x0: 0, y0: 0, x1: CW, y1: 80 }, c: [60, 60, 70, 1] }, { r: { x0: 200, y0: 220, x1: 1400, y1: 260 }, c: INK }, { r: { x0: 200, y0: 300, x1: 1100, y1: 340 }, c: INK }])));
    writeJson(join(p.assets, `${b.id}.meta.json`), { url: (b.visual as { url: string }).url, width: CW, height: CH, cssWidth: CW / 2 });
    if (t === "zoom") writeJson(join(p.assets, `${b.id}.region.json`), { x: 180, y: 200, w: 700, h: 180, pageWidth: CW, pageHeight: CH });
  }
}

// ─────────────────────────────────────────────────────────────── orchestration

export interface RunOptions { run?: string; checks: CheckName[]; scope?: "badge"; cameraStep?: number }

async function auditComposed(opts: { entry: string; timeline: Timeline; script: AuditScript; checks: PageCheck[]; scope?: "badge"; cameraStep?: number; onSettle?: AuditInput["onSettle"] }): Promise<CheckReport[]> {
  let browser: AuditBrowser | null = null;
  try {
    browser = await AuditBrowser.launch();
    const page = await browser.open(opts.entry);
    try { return await auditPage(page, opts); } finally { await page.close(); }
  } finally {
    await browser?.close();
  }
}

function failedAll(checks: CheckName[], where: string, message: string): CheckReport[] {
  return checks.map((c) => { const r = report(c); fail(r, where, "setup", message); r.ok = false; return r; });
}

export async function runChecks(o: RunOptions): Promise<CheckReport[]> {
  const out = await runChecksInner(o);
  const types = out.find((r) => r.check === "types");
  if (types) {
    for (const d of schemaVisualTypes().drift) fail(types, "schema", "drift", d);
    types.ok = types.findings.length === 0;
  }
  return out;
}

/**
 * Name the frame the ArtDirection critique judges each insert beat on: its settle time, when every piece has built on
 * its spoken cue. Without it the critique samples the middle of the beat's span, and a voice-mode insert whose words
 * come late in that span is judged as missing while the page is still reading (an insert not yet built at the midpoint is called "does-not" or "partly"). Writes `at` on Meaning/Direction.rendered.json
 * insert beats; a beat that never settles keeps no `at`, so the critique falls back to the midpoint and says so.
 */
export function critiqueTimes(direction: { beats: { choice: string; span?: { start: number; end: number }; at?: number }[] }, timeline: Timeline, settle: { id: string; start: number; settle: number | null }[]): number {
  const byId = new Map(settle.map((s) => [s.id, s.settle]));
  let stamped = 0;
  for (const b of direction.beats) {
    delete b.at;
    if (b.choice !== "insert" || !b.span) continue;
    const mid = (b.span.start + b.span.end) / 2;
    const beat = timeline.beats.find((x) => x.start <= mid && mid < x.end);
    const at = beat ? byId.get(beat.id) : null;
    if (at === null || at === undefined || at < b.span.start || at > b.span.end) continue;
    b.at = Number(at.toFixed(3));
    stamped++;
  }
  return stamped;
}

function stampCritiqueTimes(runDir: string, timeline: Timeline, settle: { id: string; start: number; settle: number | null }[]): void {
  const path = join(runDir, "Meaning", "Direction.rendered.json");
  if (!existsSync(path)) return;
  const direction = readJson<{ beats: { choice: string; span?: { start: number; end: number }; at?: number }[] }>(path);
  const n = critiqueTimes(direction, timeline, settle);
  writeJson(path, direction);
  console.log(`critique frames: ${n} insert beat(s) stamped with their settle time in Meaning/Direction.rendered.json`);
}

async function runChecksInner(o: RunOptions): Promise<CheckReport[]> {
  const out: CheckReport[] = [];
  for (const c of o.checks) {
    if (c === "config") out.push(checkConfig());
    else if (c === "style-doc") out.push(await checkStyleDoc());
    else if (c === "git-fonts") out.push(checkGitFonts());
  }
  const pageChecks = o.checks.filter((c): c is PageCheck => (PAGE_CHECKS as readonly string[]).includes(c));
  const schema = schemaVisualTypes();
  if (pageChecks.length === 0) return out;
  if (o.run) {
    const dir = resolveRunDir(o.run);
    const script = readJson<Script>(runPaths(dir).script);
    const timeline = readJson<Timeline>(runPaths(dir).timeline);
    let tmp: string | null = null, cleanup: (() => void) | null = null;
    try {
      tmp = copyRunForAudit(dir, script);
      const composed = await composeForAudit(tmp);
      cleanup = composed.cleanup;
      out.push(...(await auditComposed({ entry: composed.entry, timeline, script: script as unknown as AuditScript, checks: pageChecks, scope: o.scope, cameraStep: o.cameraStep, onSettle: (settle) => stampCritiqueTimes(dir, timeline, settle) })));
    } catch (e) {
      out.push(...failedAll(pageChecks, o.run, `could not stage, compose or open the run: ${(e as Error).message.split("\n").slice(0, 6).join(" | ")}`));
    } finally {
      cleanup?.();
      if (tmp) removeOwned(tmp, tmpdir(), tmp.slice(tmp.lastIndexOf("ve-audit-run-")));
    }
    return out;
  }
  const others = pageChecks.filter((c) => c !== "types");
  if (others.length) throw new UsageError(`--check ${others.join(",")} measures a composed run: pass --run <slug>`);
  const tmp = mkdtempSync(join(tmpdir(), "ve-audit-types-"));
  let cleanup: (() => void) | null = null;
  try {
    synthesizeTypesRun(tmp, schema.types);
    const composed = await composeForAudit(tmp);
    cleanup = composed.cleanup;
    out.push(...(await auditComposed({ entry: composed.entry, timeline: readJson<Timeline>(runPaths(tmp).timeline), script: readJson<AuditScript>(runPaths(tmp).script), checks: ["types"], cameraStep: o.cameraStep })));
  } catch (e) {
    out.push(...failedAll(["types"], TYPES_SLUG, `could not synthesize, stage, compose or open the every-type run: ${(e as Error).message.split("\n").slice(0, 6).join(" | ")}`));
  } finally {
    cleanup?.();
    removeOwned(tmp, tmpdir(), tmp.slice(tmp.lastIndexOf("ve-audit-types-")));
  }
  return out;
}

class UsageError extends Error {}

export function parseChecks(arg: string | undefined): CheckName[] {
  if (!arg) throw new UsageError("--check is required");
  const all = [...PAGE_CHECKS, ...STATIC_CHECKS] as readonly string[];
  const out: CheckName[] = [];
  for (const raw of arg.split(",").map((s) => s.trim()).filter(Boolean)) {
    const names = ALIASES[raw] ?? (all.includes(raw) ? [raw as CheckName] : null);
    if (!names) throw new UsageError(`unknown check "${raw}" (${[...all, ...Object.keys(ALIASES)].join(", ")})`);
    for (const n of names) if (!out.includes(n)) out.push(n);
  }
  if (out.length === 0) throw new UsageError("--check names no check");
  return out;
}

function printReports(reports: CheckReport[]): void {
  for (const r of reports) {
    console.log(`\n━━ ${r.check} ━━ ${r.measured} measured`);
    for (const l of r.lines) console.log(`  ${l}`);
    for (const n of [...new Set(r.notes)].slice(0, 20)) console.log(`  · ${n}`);
    console.log(r.ok ? `✓ ${r.check}: pass` : `✗ ${r.check}: ${r.findings.length} violation(s)`);
  }
}

/** Why `run` cannot be audited on this machine (no config, no run dir, no Script.json), or undefined when it can. */
export function runAbsent(run: string): string | undefined {
  let dir: string;
  try { dir = resolveRunDir(run); } catch (e) { return `run ${run} cannot be resolved here: ${(e as Error).message.split("\n")[0]}`; }
  if (!existsSync(runPaths(dir).script)) return `run ${run} has no Script.json at ${dir}`;
  return undefined;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const usage = "usage: DesignAudit.ts [--run <slug|dir> [--if-present]] --check <name[,name...]> [--scope badge] [--camera-step <frames>] [--json]";
  process.on("SIGINT", () => { killLiveBrowsers(); process.exit(130); });
  process.on("SIGTERM", () => { killLiveBrowsers(); process.exit(143); });
  try {
    const checks = parseChecks(argValue(argv, "--check"));
    const scope = argValue(argv, "--scope");
    if (scope !== undefined && scope !== "badge") throw new UsageError(`--scope must be badge, got ${scope}`);
    if (scope && !checks.includes("fonts")) throw new UsageError("--scope badge applies to the fonts check");
    const step = argValue(argv, "--camera-step");
    if (step !== undefined && !(Number.isInteger(Number(step)) && Number(step) >= 1)) throw new UsageError("--camera-step must be a whole number of frames ≥ 1");
    if (hasFlag(argv, "--if-present")) {
      const run = argValue(argv, "--run");
      if (!run) throw new UsageError("--if-present needs --run");
      const absent = runAbsent(run);
      if (absent) { console.log(`skipped: ${absent}`); process.exit(0); }
    }
    const reports = await runChecks({ run: argValue(argv, "--run"), checks, scope: scope as "badge" | undefined, cameraStep: step ? Number(step) : undefined });
    const ok = reports.every((r) => r.ok);
    if (hasFlag(argv, "--json")) console.log(JSON.stringify({ ok, run: argValue(argv, "--run") ?? null, checks: reports }, null, 2));
    else { printReports(reports); console.log(ok ? "\n✓ design audit passed" : "\n✗ design audit failed"); }
    process.exit(ok ? 0 : 1);
  } catch (e) {
    killLiveBrowsers();
    if (e instanceof UsageError) { console.error(`${e.message}\n${usage}`); process.exit(2); }
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
