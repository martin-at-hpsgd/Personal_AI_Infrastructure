/**
 * Motion.ts — the frame-math the essay composition animates with: the three curves and the highlight slide,
 * eased progress over a span, frame snapping, and cues: the moment the narration names a thing.
 *
 * Every animated value is a pure function of the frame number, so seeking any frame paints the same picture. There
 * are no springs and no count-ups. Pure and browser-safe: Page.ts bundles it into the composition.
 */

export type EasingFn = (t: number) => number;

/** A CSS cubic-bezier(x1, y1, x2, y2). */
export type Bezier = readonly [number, number, number, number];

/**
 * CSS cubic-bezier timing: solve x(u) = t for u (Newton steps, bisection when the slope flattens), return y(u).
 * The end points are exact, so a finished move lands on its value.
 */
export function cubicBezier([x1, y1, x2, y2]: Bezier): EasingFn {
  if (!(x1 >= 0 && x1 <= 1 && x2 >= 0 && x2 <= 1)) throw new Error(`cubic-bezier x values must lie in [0, 1], got ${x1}, ${x2}`);
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const x = (u: number) => ((ax * u + bx) * u + cx) * u;
  const dx = (u: number) => (3 * ax * u + 2 * bx) * u + cx;
  const y = (u: number) => ((ay * u + by) * u + cy) * u;
  return (t: number) => {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    let u = t;
    for (let i = 0; i < 8; i++) {
      const err = x(u) - t;
      if (Math.abs(err) < 1e-7) return y(u);
      const d = dx(u);
      if (Math.abs(d) < 1e-6) break;
      u -= err / d;
    }
    let lo = 0, hi = 1;
    u = t;
    for (let i = 0; i < 40; i++) {
      const v = x(u);
      if (Math.abs(v - t) < 1e-7) break;
      if (v < t) lo = u; else hi = u;
      u = (lo + hi) / 2;
    }
    return y(u);
  };
}

/** The curves, and nothing else: every move uses one of these. Camera, zoom and FLIP share the draw curve. */
export const CURVES = {
  enter: [0.22, 1, 0.36, 1],
  exit: [0.4, 0, 1, 1],
  draw: [0.65, 0, 0.35, 1],
  camera: [0.65, 0, 0.35, 1],
  highlight: [0.45, 0, 0.2, 1],
} as const satisfies Record<string, Bezier>;
export type CurveName = keyof typeof CURVES;
const EASE: Record<CurveName, EasingFn> = {
  enter: cubicBezier(CURVES.enter),
  exit: cubicBezier(CURVES.exit),
  draw: cubicBezier(CURVES.draw),
  camera: cubicBezier(CURVES.camera),
  highlight: cubicBezier(CURVES.highlight),
};
export const ease = (curve: CurveName): EasingFn => EASE[curve];

/** Durations (seconds), distances (px) and rates (px per second) of every move. */
export const MOTION = {
  enterBlock: 0.433,
  enterLine: 0.333,
  rise: 24,
  exit: 0.233,
  fall: 12,
  drawRate: 1600,
  drawMin: 0.4,
  drawMax: 0.8,
  bar: 0.6,
  camera: 0.9,
  /** A scroll beat reads down the page for its whole narration at no less than this (px per second on the 1080p frame); slower reads as a still. */
  readScroll: 56,
  /** A scroll comes to rest this long before its beat ends. */
  readSettle: 0.5,
  /** A screenshot is toured, never held: the camera pushes in at this zoom per second from the card landing until readSettle before the beat ends. Under about 4%/s a push reads as drift, a still. */
  tourRate: 0.064,
  /** An image lands at least this close on its top-left before pulling back to the whole picture. */
  imageClose: 1.2,
  /** A diagram opens no closer than this on its first node and pulls back as each node arrives. */
  diagramClose: 1.3,
  flip: 0.7,
  highlight: 0.367,
  dim: 0.3,
  heroMask: 0.467,
  /** The furthest ahead of its word any motion may start: 4 frames. */
  lead: 4 / 30,
  /** Bare paper between one ink leaving and the next arriving: 4 frames. */
  paper: 4 / 30,
  stagger: 0.09,
  raceRate: 2400,
  raceMin: 0.35,
  raceMax: 0.9,
} as const;

/**
 * The time from one ink's exit tween ending to the next ink's first build. Three frames of a swap are bare without any
 * gap: the exit's last frame (its fade is below ΔE 2 there), the frame it ends on, and the arriving ink's first frame
 * (progress 0). So four bare frames in all need the new ink to start two frames after the exit ends.
 */
export const GAP = MOTION.paper - 2 / 30;
/** Page-to-insert swap: old ink leaves, then four frames of bare paper, then the new ink starts. */
export const SWAP = MOTION.exit + GAP;

/** A chapter card's times in seconds from its beat's start; it is gone `cardSeconds` in. */
export const CARD_TIMES = { ruler: 0.2, rulerDraw: 0.6, title: 0.5, titleStagger: 0.08, accent: 0.8, accentDraw: 0.4, exit: 2.8 } as const;
export const cardSeconds = CARD_TIMES.exit + MOTION.exit;

/** Eased progress of a move that starts at t0 and lasts dur, clamped to [0, 1]. */
export function progress(t: number, t0: number, dur: number, curve: CurveName): number {
  if (!(dur > 0)) throw new Error(`a move needs a positive duration, got ${dur}`);
  const k = (t - t0) / dur;
  return k <= 0 ? 0 : k >= 1 ? 1 : EASE[curve](k);
}

/** A connector's draw time: 1.6 px/ms, clamped to 400–800 ms. */
export const drawSeconds = (length: number): number => Math.min(MOTION.drawMax, Math.max(MOTION.drawMin, length / MOTION.drawRate));

/**
 * A scroll beat's read down the page: it moves from `move` until MOTION.readSettle before the beat ends, and travels
 * the distance asked or MOTION.readScroll frame px a second, whichever is further, never past the page's room.
 * Distances are in image px; `k` is image-to-frame scale.
 */
export function readScrollPlan(o: { move: number; seconds: number; asked: number; room: number; k: number }): { dur: number; dist: number } {
  const dur = Math.max(MOTION.camera, o.seconds - o.move - MOTION.readSettle);
  return { dur, dist: Math.min(o.room, Math.max(o.asked, (MOTION.readScroll * dur) / o.k)) };
}

/** A screenshot tour's end zoom over a move of `dur` seconds. */
export const tourZoom = (dur: number): number => 1 + MOTION.tourRate * Math.max(0, dur);

export interface Box { x: number; y: number; w: number; h: number }
/** A camera as F' = s·F + (tx, ty) in frame px. */
export interface Framing { s: number; tx: number; ty: number }
export const IDENTITY_FRAMING: Framing = { s: 1, tx: 0, ty: 0 };

/**
 * The camera that frames `box` (frame px, where it stands at rest) inside `avail`: as close as fits, never closer than
 * `close` nor wider than rest. A closer framing centres the box in `avail`; one at rest scale leaves it where it stands,
 * so the last framing of a build is the rest view. The framed box never leaves `avail`.
 */
export function frameBox(box: Box, avail: Box, close: number): Framing {
  const s = Math.max(1, Math.min(close, avail.w / Math.max(1, box.w), avail.h / Math.max(1, box.h)));
  const w = close > 1 ? (s - 1) / (close - 1) : 0;
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
  let px = mix(cx, avail.x + avail.w / 2, w), py = mix(cy, avail.y + avail.h / 2, w);
  const hw = (s * box.w) / 2, hh = (s * box.h) / 2;
  px = Math.min(Math.max(px, avail.x + hw), avail.x + avail.w - hw);
  py = Math.min(Math.max(py, avail.y + hh), avail.y + avail.h - hh);
  return { s, tx: px - s * cx, ty: py - s * cy };
}

/** The camera at time t over keyed framings (times ascending): it travels from each key to the next for the whole gap between them. */
export function framingAt(keys: readonly { t: number; f: Framing }[], t: number): Framing {
  if (keys.length === 0) return IDENTITY_FRAMING;
  if (t <= keys[0].t) return keys[0].f;
  for (let i = 0; i + 1 < keys.length; i++) {
    const a = keys[i], b = keys[i + 1];
    if (t < b.t) { const m = progress(t, a.t, b.t - a.t, "camera"); return { s: mix(a.f.s, b.f.s, m), tx: mix(a.f.tx, b.f.tx, m), ty: mix(a.f.ty, b.f.ty, m) }; }
  }
  return keys[keys.length - 1].f;
}

/** Snap a time up to the next frame boundary, so a cued start never lands earlier than its cue. */
export const snapUp = (t: number, fps: number): number => Math.ceil(t * fps - 1e-6) / fps;

/** Linear map of t from [a, b] to [0, 1], clamped. */
export const span = (t: number, a: number, b: number): number => (b <= a ? (t >= b ? 1 : 0) : Math.min(1, Math.max(0, (t - a) / (b - a))));
export const mix = (a: number, b: number, k: number): number => a + (b - a) * k;

// ---------- cues ----------

/** A spoken word in beat-local seconds. */
export interface SpokenWord { w: string; s: number; e?: number }

/** A word reduced to letters and digits, lowercased: "90" ".1" "%" read back as "90", "1", "". */
export const normToken = (w: string): string => w.toLowerCase().replace(/[’‘]/g, "'").replace(/[^\p{L}\p{N}]+/gu, "");

const STOP = new Set(("a an the of to in on at by for from with and or but nor so as is are was were be been being it its it's this that these those " +
  "i my me we our you your he his she her they their them what which who whom how when where why do does did not no than then there here " +
  "if into onto over under up out about just also only very can will would should could may might must has have had each every all more most").split(" ").map(normToken));

/** The words of a label that can name it aloud: letters and digits, stop words dropped ("83.7%" is "837", "--verbose" is "verbose"). */
export function contentTokens(label: string): string[] {
  return label.split(/[\s/–—]+/).map(normToken).filter((t) => t && !STOP.has(t));
}

interface Match { token: number; at: number; end: number }

/** Every place a content token is spoken: one word, or up to four words run together ("x" "-large" is "xlarge"). */
function matches(content: readonly string[], spoken: readonly string[]): Match[] {
  const out: Match[] = [];
  for (let i = 0; i < spoken.length; i++) {
    if (!spoken[i]) continue;
    content.forEach((tok, k) => {
      let joined = "";
      for (let j = i; j < Math.min(spoken.length, i + 4); j++) {
        joined += spoken[j];
        if (joined === tok) { out.push({ token: k, at: i, end: j }); return; }
        if (!tok.startsWith(joined)) return;
      }
    });
  }
  return out.sort((a, b) => a.at - b.at || a.end - b.end);
}

/**
 * The windows where the narration names a label: a run of at most `window` words holding at least two of its content
 * tokens (one, when it has only one), starting on a match. A label the narration never names that closely is named by
 * its single matches ("classes" said as "class" still leaves "visual"). Ordered by start.
 */
function mentions(label: string, words: readonly SpokenWord[]): { at: number; end: number }[] {
  const content = contentTokens(label);
  if (content.length === 0) return [];
  const need = Math.min(2, content.length);
  const window = Math.max(8, content.length * 2);
  const ms = matches(content, words.map((w) => normToken(w.w)));
  const out: { at: number; end: number }[] = [];
  for (const m of ms) {
    const inside = ms.filter((o) => o.at >= m.at && o.at < m.at + window);
    const found = new Set(inside.map((o) => o.token));
    if (found.size >= need) out.push({ at: m.at, end: Math.max(...inside.map((o) => o.end)) });
  }
  return out.length ? out : ms.map((m) => ({ at: m.at, end: m.end }));
}

/** When the narration first names a label (the onset of the first matched word), or undefined when it never does. */
export function cueOf(label: string, words: readonly SpokenWord[], after = -Infinity): number | undefined {
  for (const m of mentions(label, words)) if (words[m.at].s >= after) return words[m.at].s;
  return undefined;
}

/** When the narration last finishes naming a label (the end of the last matched word), or undefined when it never does. */
export function lastMentionOf(label: string, words: readonly SpokenWord[]): number | undefined {
  const ms = mentions(label, words);
  if (ms.length === 0) return undefined;
  const w = words[ms[ms.length - 1].end];
  return w.e ?? w.s + 0.3;
}

/** How long a settled insert holds after its last referent: max(0.6 s per word on screen, 2 s) plus 1 s per multi-digit figure. */
export function holdSeconds(wordsOnScreen: number, multiDigitFigures: number): number {
  return Math.max(0.6 * wordsOnScreen, 2) + multiDigitFigures;
}

/** Figures of two or more digits in a text ("248 of 431" has two; "9" has none). */
export const multiDigitFigures = (text: string): number => (text.match(/\d[\d,.]*\d/g) ?? []).length;
export const wordCount = (text: string): number => text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
