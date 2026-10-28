/**
 * ReadCamera.ts — where the reading camera puts the post page, and where the highlight lands, at any time.
 *
 * Voice mode shows the author's real post page with no browser chrome, clipped to the post column plus 64 image
 * px each side, so the site's rail, nav and footer can never show. The column is centred on x 960 at
 * s = min(56 / body px, 1600 / column px, 1728 / (column + 128) px); the spoken sentence stays in the band y 260–640,
 * and the camera moves only when the next sentence would leave it, placing that sentence's top at y 320 over 900 ms
 * on the camera curve. It never scrolls the post's last narrated line above y 640, so the closing paragraphs fill the
 * frame down to the band's foot; a post too short to reach it sits on the optical centre. Page text fades out between
 * y 640 and 700 and paper is solid below, under the badge (y 736 down).
 *
 * This module is the one source for that geometry: the composition (PageVisuals.ts) draws from `readFrameAt`, and
 * Verify.ts replays `markRectsOnFrame` for its clearance check, so the render and the check cannot drift. All timing
 * is absolute (seconds on the composition timeline), so the page reads as one continuous camera across beats.
 * Pure and browser-safe.
 */
import type { PostSentence, ReadPost, SentenceRect, Word } from "./CompositionTypes.ts";
import { ease, MOTION } from "./Motion.ts";
import { eventIndexAt, planCamera, sentenceBounds, sentenceEvents, type CameraKey, type SentenceEvent } from "./ReadSync.ts";
import { FRAME, HIGHLIGHT, OPTICAL, READ, type Rect } from "./Theme.ts";

/** The page fills the frame; there is no URL strip (`bar`) and no window radius. */
export const READ_WINDOW = { x: 0, y: 0, w: FRAME.w, h: FRAME.h, bar: 0, radius: 0 } as const;
/** A post line box is about this many times its font size (a typical body serif's content area), so body px ≈ line box / this. */
const BODY_BOX = 1.3;
/** The camera starts a move this long before the sentence that needs it, so the line has settled in the band by its first word. */
export const CAMERA_LEAD = 0.5;

/**
 * A sentence's lines as one run: rects that jump more than three line heights past the lines before them are dropped.
 * (The capture's range rects can include hidden widget text far down the page; framing or marking those would
 * throw the camera and the highlight off the sentence.)
 */
export function contiguousRects(rects: readonly SentenceRect[]): SentenceRect[] {
  if (rects.length === 0) return [];
  const kept = [rects[0]];
  for (const r of rects.slice(1)) {
    const bottom = Math.max(...kept.map((k) => k.y + k.h));
    const top = Math.min(...kept.map((k) => k.y));
    if (r.y <= bottom + 3 * rects[0].h && r.y + r.h >= top - 3 * rects[0].h) kept.push(r);
  }
  return kept;
}

/** The page's fixed placement for reading: its scale, the screen x of page x 0, and the clip in image pixels. */
export interface ReadLayout { scale: number; offsetX: number; viewportPage: number; clip: Rect }

/** The post column in image pixels: the union of every narrated sentence's lines. */
export function postColumn(post: ReadPost): { left: number; right: number; top: number; bottom: number; body: number } {
  let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity;
  const heights: number[] = [];
  for (const s of post.sentences) {
    const b = sentenceBounds(s);
    left = Math.min(left, b.left); right = Math.max(right, b.right); top = Math.min(top, b.top); bottom = Math.max(bottom, b.bottom);
    for (const r of s.rects) heights.push(r.h);
  }
  if (!Number.isFinite(left)) throw new Error("read post has no sentence rects: the column cannot be located");
  heights.sort((a, b) => a - b);
  return { left, right, top, bottom, body: heights[heights.length >> 1] / BODY_BOX };
}

/** Scale, horizontal placement and clip that frame the post column for reading. */
export function readLayout(post: ReadPost): ReadLayout {
  const col = postColumn(post);
  const width = col.right - col.left;
  const scale = Math.min(READ.bodyPx / col.body, READ.column / width, (READ.column + 2 * READ.margin) / (width + 2 * READ.margin));
  // Whole pixels: a page image placed at a fractional x is resampled across two columns and every letter softens.
  const offsetX = Math.round(FRAME.w / 2 - ((col.left + col.right) / 2) * scale);
  const x0 = Math.max(0, col.left - READ.margin);
  const x1 = Math.min(post.width, col.right + READ.margin);
  // Nothing below the last narrated line is the post: the footer and related links stay clipped away.
  const y1 = Math.min(post.height, col.bottom + READ.margin);
  return { scale, offsetX, viewportPage: FRAME.h / scale, clip: { x: x0, y: 0, w: x1 - x0, h: y1 } };
}

/** Everything the reading camera needs, computed once per post and narration. */
export interface ReadCamera { post: ReadPost; layout: ReadLayout; events: SentenceEvent[]; byId: Map<string, PostSentence>; initial: number; keys: CameraKey[] }

export function readCamera(source: ReadPost, words: readonly Word[]): ReadCamera {
  const post: ReadPost = { ...source, sentences: source.sentences.map((s) => ({ ...s, rects: contiguousRects(s.rects) })) };
  const layout = readLayout(post);
  const events = sentenceEvents(words, post.sentences);
  const byId = new Map(post.sentences.map((s) => [s.id, s]));
  const V = layout.viewportPage;
  // The planner may run past the last line onto paper; the page end then clamps it (below).
  const runout = (1 - READ.band[1] / FRAME.h) * V;
  const plan = planCamera(events, post.sentences, { viewport: V, pageHeight: post.height + runout, band: [READ.band[0] / FRAME.h, READ.band[1] / FRAME.h], anchor: READ.anchor / FRAME.h, lead: CAMERA_LEAD, move: MOTION.camera });
  const stop = pageEnd(post, layout);
  // Every move lasts 900 ms on the camera curve; one that starts mid-move starts from where the camera stands.
  const keys: CameraKey[] = [];
  const initial = stop(plan.initial);
  for (const k of plan.keys) {
    const from = scrollAt(initial, keys, k.t);
    keys.push({ t: k.t, from, to: stop(k.to), dur: MOTION.camera });
  }
  return { post, layout, events, byId, initial, keys };
}

/**
 * The camera's page end, as a clamp on its scroll (image px): it never scrolls the post's last narrated line above the
 * read band's foot (y 640), so the closing paragraphs fill the frame above it instead of rising into the top third over
 * blank paper. A post whose narrated column ends above y 640 even unscrolled cannot fill the frame, so it is held with
 * its column centred on the optical centre.
 */
export function pageEnd(post: ReadPost, layout: ReadLayout): (camY: number) => number {
  const col = postColumn(post);
  // Its highlight included: the line box plus the 4 px pad ends at the band foot, clear of the fade below it.
  const end = col.bottom - (READ.band[1] - HIGHLIGHT.padY) / layout.scale;
  if (end >= 0) return (camY) => Math.min(camY, end);
  const centred = (col.top + col.bottom) / 2 - OPTICAL.y / layout.scale;
  return () => centred;
}

function scrollAt(initial: number, keys: readonly CameraKey[], t: number): number {
  let k = -1;
  for (let i = 0; i < keys.length && keys[i].t <= t; i++) k = i;
  if (k < 0) return initial;
  const key = keys[k];
  const p = Math.min(1, Math.max(0, (t - key.t) / key.dur));
  return key.from + (key.to - key.from) * ease("camera")(p);
}

/** The page's placement and the spoken sentences at time t (seconds on the composition timeline). */
export function readFrameAt(cam: ReadCamera, t: number): { scale: number; offsetX: number; camY: number; current?: PostSentence; previous?: PostSentence; since: number } {
  const k = eventIndexAt(cam.events, t);
  return {
    scale: cam.layout.scale,
    offsetX: cam.layout.offsetX,
    camY: scrollAt(cam.initial, cam.keys, t),
    current: k >= 0 ? cam.byId.get(cam.events[k].id) : undefined,
    previous: k >= 1 ? cam.byId.get(cam.events[k - 1].id) : undefined,
    since: k >= 0 ? t - cam.events[k].t : 0,
  };
}

/** A highlight line box on the page at its scale (px), with its corner radii: top-left, top-right, bottom-right, bottom-left. */
export interface HighlightBox extends Rect { radii: [number, number, number, number] }

/**
 * A sentence's highlight as line boxes on the page at its scale (px, not yet placed by the camera). Each box is its
 * line grown by 8 px each side. Consecutive lines (the next starting within a line height) meet at the middle of the
 * gap between them, so boxes butt and never overlap; an outer edge is padded 4 px. Only a corner no neighbouring box
 * continues is rounded.
 */
export function highlightBoxes(lines: readonly SentenceRect[], scale: number): HighlightBox[] {
  const L = lines.map((r) => ({ x0: r.x * scale - HIGHLIGHT.padX, x1: (r.x + r.w) * scale + HIGHLIGHT.padX, y0: r.y * scale, y1: (r.y + r.h) * scale }));
  type Line = (typeof L)[number];
  const joined = (a: Line, b: Line) => b.y0 - a.y1 < a.y1 - a.y0;
  const R = HIGHLIGHT.radius;
  return L.map((r, k) => {
    const up = k > 0 && joined(L[k - 1], r) ? L[k - 1] : undefined;
    const down = k + 1 < L.length && joined(r, L[k + 1]) ? L[k + 1] : undefined;
    const top = up ? (up.y1 + r.y0) / 2 : r.y0 - HIGHLIGHT.padY;
    const bottom = down ? (r.y1 + down.y0) / 2 : r.y1 + HIGHLIGHT.padY;
    const open = (n: Line | undefined, side: "x0" | "x1") => (!n ? R : side === "x0" ? (n.x0 > r.x0 + 0.5 ? R : 0) : n.x1 < r.x1 - 0.5 ? R : 0);
    return { x: r.x0, y: top, w: r.x1 - r.x0, h: bottom - top, radii: [open(up, "x0"), open(up, "x1"), open(down, "x1"), open(down, "x0")] };
  });
}

/** The highlighted sentence's line boxes in frame pixels at time t (empty before the first word), exactly as drawn. */
export function markRectsOnFrame(cam: ReadCamera, t: number): Rect[] {
  const f = readFrameAt(cam, t);
  if (!f.current) return [];
  return highlightBoxes(f.current.rects, f.scale).map((b) => ({ x: READ_WINDOW.x + f.offsetX + b.x, y: READ_WINDOW.y + b.y - f.camY * f.scale, w: b.w, h: b.h }));
}

/** The highlight slides only between sentences this many of the old last line's heights apart, or closer. */
export const HIGHLIGHT_SLIDE_LINES = 2.5;

/**
 * The highlight as drawn at time t, in page image pixels (the page layer draws it inside the moving page, so it rides
 * every camera move with its words). Between neighbouring sentences (the new first line within 2.5 line heights of the
 * old last line) it slides from the old lines to the new in 367 ms on the highlight curve, line k of the new sentence
 * travelling from line min(k, last) of the old. A sentence farther away (past a quote, a figure or a heading) gets the
 * highlight at once: sliding across the page between would sweep it over unrelated lines while the camera moves.
 */
export function highlightLines(cam: ReadCamera, t: number): SentenceRect[] {
  const f = readFrameAt(cam, t);
  if (!f.current) return [];
  const p = f.previous ? Math.min(1, f.since / MOTION.highlight) : 1;
  if (p >= 1 || !f.previous) return f.current.rects;
  const from = f.previous.rects;
  const last = from[from.length - 1], first = f.current.rects[0];
  if (!last || !first || Math.abs(first.y - last.y) > HIGHLIGHT_SLIDE_LINES * last.h) return f.current.rects;
  const e = ease("highlight")(p);
  return f.current.rects.map((r, k) => {
    const o = from[Math.min(k, from.length - 1)];
    return { x: o.x + (r.x - o.x) * e, y: o.y + (r.y - o.y) * e, w: o.w + (r.w - o.w) * e, h: o.h + (r.h - o.h) * e };
  });
}
