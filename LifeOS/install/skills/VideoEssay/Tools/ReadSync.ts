/**
 * ReadSync.ts — the pure timing core of the `read` visual (voice mode).
 *
 * The narration is fixed; the page follows it. Two questions, answered from the word
 * timeline alone so the composition and the tests agree exactly:
 *
 *   activeSentence(t, words, sentences)  which sentence the narrator is reading at time t
 *   scrollTarget(t, plan)                where the camera sits on the page at time t
 *
 * plus parsePostSentences / scaleSentences, which Build.ts uses to validate and stage the sentence map.
 *
 * No node imports: bun tests and the bundled composition both load this file.
 * Units: seconds for time, post.png pixels for page geometry.
 */
import type { PostSentence, PostSentences, SentenceRect, Word } from "./CompositionTypes.ts";

/** The moment speech moved into a sentence: the start of the first matched word that belongs to it. */
/** A sentence as spoken: its first word starts at t; `end` is where its last word ends (absent from hand-made events). */
export interface SentenceEvent { t: number; id: string; end?: number }

/** Index sentences by paragraph so a word resolves in one short scan. */
function byParagraph(sentences: readonly PostSentence[]): Map<string, PostSentence[]> {
  const map = new Map<string, PostSentence[]>();
  for (const s of sentences) {
    const list = map.get(s.p);
    if (list) list.push(s);
    else map.set(s.p, [s]);
  }
  return map;
}

/** The sentence a word belongs to, or undefined when the word is unmatched or its index falls outside every sentence. */
function sentenceOfWord(word: Word, index: Map<string, PostSentence[]>): PostSentence | undefined {
  if (word.p === undefined || word.i === undefined) return undefined;
  const i = word.i;
  return index.get(word.p)?.find((s) => s.i0 <= i && i <= s.i1);
}

/**
 * Every change of sentence along the timeline, in time order. Consecutive words in the same sentence
 * collapse to one event; unmatched words produce none, so the previous sentence holds through them.
 */
export function sentenceEvents(words: readonly Word[], sentences: readonly PostSentence[]): SentenceEvent[] {
  const index = byParagraph(sentences);
  const sorted = [...words].sort((a, b) => a.s - b.s);
  const events: SentenceEvent[] = [];
  for (const w of sorted) {
    const s = sentenceOfWord(w, index);
    if (!s) continue;
    const last = events[events.length - 1];
    if (last && last.id === s.id) { last.end = Math.max(last.end ?? w.e, w.e); continue; }
    events.push({ t: w.s, id: s.id, end: w.e });
  }
  return events;
}

/** Index of the last event at or before t, or -1 before the first word is spoken. */
export function eventIndexAt(events: readonly SentenceEvent[], t: number): number {
  let lo = 0;
  let hi = events.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (events[mid].t <= t) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return found;
}

/**
 * The sentence being read at time t: the sentence of the most recent matched word whose index lies in
 * [i0, i1] of a sentence in its paragraph. Pauses and unmatched words hold the last one; null before speech.
 */
export function activeSentence(t: number, words: readonly Word[], sentences: readonly PostSentence[]): string | null {
  const events = sentenceEvents(words, sentences);
  const k = eventIndexAt(events, t);
  return k >= 0 ? events[k].id : null;
}

// ---------- camera ----------

export interface Bounds { top: number; bottom: number; left: number; right: number }

/** The union box of a sentence's line rects. A sentence with no rects is a contract violation upstream. */
export function sentenceBounds(s: PostSentence): Bounds {
  if (s.rects.length === 0) throw new Error(`sentence ${s.id} has no rects`);
  let top = Infinity, bottom = -Infinity, left = Infinity, right = -Infinity;
  for (const r of s.rects) {
    top = Math.min(top, r.y);
    bottom = Math.max(bottom, r.y + r.h);
    left = Math.min(left, r.x);
    right = Math.max(right, r.x + r.w);
  }
  return { top, bottom, left, right };
}

export interface CameraOptions {
  /** Visible page height, in page pixels. */
  viewport: number;
  /** Full page height, in page pixels. */
  pageHeight: number;
  /** Where a sentence the camera moves to lands: its top at this fraction of the viewport. */
  anchor?: number;
  /** Comfort band (fractions of the viewport): a sentence wholly inside it never moves the camera. */
  band?: readonly [number, number];
  /** Seconds the move starts before the sentence's first word, so the line is in place as the narrator reaches it. */
  lead?: number;
  /**
   * Seconds a camera move lasts. When given, a move may start earlier than `lead`, as soon as the previous sentence
   * has been spoken and at most `move` before the next one, so a far jump (past a table, a code block or an insert
   * the reading skipped) lands in the pause instead of arriving under the first word (without it, the first sentences after a skipped table or an insert sit under the badge fade at their first word).
   */
  move?: number;
  /**
   * Open on the post's head: the camera starts with the title's top just below the window edge and holds
   * there until `until` (seconds), so the viewer meets the page (title, date, header art) before it
   * follows the reading. `viewport` is the visible page height during the hold (the opening shot is wider
   * than the reading zoom, sized by the caller so the title and the first sentence both fit). Page pixels.
   * `bottom` (fraction of that viewport, default 0.95) is the lowest the first sentence may sit during the hold:
   * voice mode passes the line above the presenter's badge, so the marked sentence is never under it.
   */
  opening?: { top: number; until: number; viewport: number; bottom?: number };
}

/** Air above the title when the camera opens on it, as a fraction of the viewport. */
export const OPENING_MARGIN = 0.02;

/** One camera move: from `from` to `to` (page-pixel scroll offsets), starting at t, lasting dur seconds. */
export interface CameraKey { t: number; from: number; to: number; dur: number }
/** `opening`: keys[0] is the push from the opening shot (the head, wider) to the first sentence at reading zoom. */
export interface CameraPlan { initial: number; keys: CameraKey[]; opening?: boolean }

export const CAMERA_DEFAULTS = { anchor: 0.3, band: [0.12, 0.8] as const, lead: 0.3 };

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Cubic in-out: the camera eases off its hold and settles, never snaps. */
export function easeInOutCubic(p: number): number {
  return p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
}

/** The scroll offset that frames a sentence: its top at the anchor line, or at the band top when it is too tall for the band. */
export function framingFor(b: Bounds, opts: CameraOptions): number {
  const anchor = opts.anchor ?? CAMERA_DEFAULTS.anchor;
  const [b0, b1] = opts.band ?? CAMERA_DEFAULTS.band;
  const V = opts.viewport;
  const y = b.bottom - b.top > (b1 - b0) * V ? b.top - b0 * V : b.top - anchor * V;
  return clamp(y, 0, Math.max(0, opts.pageHeight - V));
}

/** Whether a sentence sits inside the comfort band when the camera rests at scroll offset y. */
export function inComfort(b: Bounds, y: number, opts: CameraOptions): boolean {
  const [b0, b1] = opts.band ?? CAMERA_DEFAULTS.band;
  return b.top >= y + b0 * opts.viewport && b.bottom <= y + b1 * opts.viewport;
}

/**
 * The camera's moves for a whole narration. It holds while the spoken sentence stays in the comfort band
 * and moves only when the next sentence would leave it, so reading a paragraph is a few calm pushes,
 * never a nudge per sentence. Deterministic over the whole timeline, so contiguous read beats share one
 * camera and the cut between them is invisible.
 */
export function planCamera(events: readonly SentenceEvent[], sentences: readonly PostSentence[], opts: CameraOptions): CameraPlan {
  const byId = new Map(sentences.map((s) => [s.id, s]));
  const lead = opts.lead ?? CAMERA_DEFAULTS.lead;
  const first = events.length ? byId.get(events[0].id) : undefined;
  const framed = first ? framingFor(sentenceBounds(first), opts) : 0;
  const plan: CameraPlan = { initial: framed, keys: [] };
  let settled = framed;
  if (first && opts.opening) {
    const V = opts.opening.viewport;
    // The head, unless that would push the first sentence off the bottom of the opening shot.
    const head = clamp(Math.max(opts.opening.top - OPENING_MARGIN * V, sentenceBounds(first).bottom - (opts.opening.bottom ?? 0.95) * V), 0, Math.max(0, opts.pageHeight - V));
    if (head < framed) {
      // One dedicated push from the head to the first sentence; the caller eases its zoom on this key.
      plan.initial = head;
      plan.opening = true;
      plan.keys.push({ t: opts.opening.until, from: head, to: framed, dur: clamp(0.9 + (0.6 * (framed - head)) / opts.viewport, 0.9, 1.6) });
    }
  }
  for (const [i, ev] of events.entries()) {
    const s = byId.get(ev.id);
    if (!s) continue;
    const b = sentenceBounds(s);
    if (inComfort(b, settled, opts)) continue;
    const to = framingFor(b, opts);
    if (Math.abs(to - settled) < 1) continue;
    const prevT = plan.keys.length ? plan.keys[plan.keys.length - 1].t : -Infinity;
    const spoken = i > 0 ? events[i - 1].end : undefined;
    const early = opts.move !== undefined && spoken !== undefined ? Math.max(spoken, ev.t - opts.move) : ev.t - lead;
    const t = Math.max(Math.min(ev.t - lead, early), prevT);
    const from = scrollTarget(t, plan);
    // Longer travel takes a little longer; a short push stays brisk.
    const dur = clamp(0.7 + (0.6 * Math.abs(to - from)) / opts.viewport, 0.7, 1.4);
    plan.keys.push({ t, from, to, dur });
    settled = to;
  }
  return plan;
}

/** The camera's scroll offset (page pixels) at time t. Continuous: a move that interrupts another starts where it stood. */
export function scrollTarget(t: number, plan: CameraPlan): number {
  let k = -1;
  for (let i = 0; i < plan.keys.length && plan.keys[i].t <= t; i++) k = i;
  if (k < 0) return plan.initial;
  const key = plan.keys[k];
  const p = clamp((t - key.t) / key.dur, 0, 1);
  return key.from + (key.to - key.from) * easeInOutCubic(p);
}

// ---------- staging (Build.ts) ----------

function finite(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * Validate Assets/post.sentences.json (written by Capture) before anything trusts it. Throws with the
 * offending sentence named: a malformed map would otherwise render a video with the wrong line marked.
 */
export function parsePostSentences(raw: unknown): PostSentences {
  const fail = (why: string): never => { throw new Error(`post.sentences.json: ${why}`); };
  if (!raw || typeof raw !== "object") return fail("not an object");
  const r = raw as Record<string, unknown>;
  if (!finite(r.pageWidth) || r.pageWidth <= 0) fail("pageWidth must be a positive number");
  if (!finite(r.pageHeight) || r.pageHeight <= 0) fail("pageHeight must be a positive number");
  if (!Array.isArray(r.sentences) || r.sentences.length === 0) fail("sentences must be a non-empty array");
  const seen = new Set<string>();
  const sentences = (r.sentences as unknown[]).map((s, n): PostSentence => {
    const o = (s ?? {}) as Record<string, unknown>;
    const where = typeof o.id === "string" ? o.id : `#${n}`;
    if (typeof o.id !== "string" || !o.id) fail(`${where}: id missing`);
    if (seen.has(o.id as string)) fail(`${where}: duplicate id`);
    seen.add(o.id as string);
    if (typeof o.p !== "string" || !o.p) fail(`${where}: p missing`);
    if (!Number.isInteger(o.i0) || !Number.isInteger(o.i1) || (o.i0 as number) < 0 || (o.i1 as number) < (o.i0 as number)) fail(`${where}: need integers 0 <= i0 <= i1`);
    if (!Array.isArray(o.rects) || o.rects.length === 0) fail(`${where}: rects must be non-empty`);
    const rects = (o.rects as unknown[]).map((q) => {
      const b = (q ?? {}) as Record<string, unknown>;
      if (![b.x, b.y, b.w, b.h].every(finite) || (b.w as number) <= 0 || (b.h as number) <= 0) fail(`${where}: every rect needs finite x, y and positive w, h`);
      return { x: b.x as number, y: b.y as number, w: b.w as number, h: b.h as number };
    });
    return { id: o.id as string, p: o.p as string, i0: o.i0 as number, i1: o.i1 as number, rects };
  });
  const parsed: PostSentences = { pageWidth: r.pageWidth as number, pageHeight: r.pageHeight as number, sentences };
  if (r.title !== undefined) {
    const t = (r.title ?? {}) as Record<string, unknown>;
    if (![t.x, t.y, t.w, t.h].every(finite) || (t.w as number) <= 0 || (t.h as number) <= 0) fail("title needs finite x, y and positive w, h");
    parsed.title = { x: t.x as number, y: t.y as number, w: t.w as number, h: t.h as number };
  }
  return parsed;
}

/** Rescale one rect from a map's pixel space to the capture's. */
export function scaleRect(r: SentenceRect, map: PostSentences, imageWidth: number): SentenceRect {
  const k = imageWidth / map.pageWidth;
  return k === 1 ? r : { x: r.x * k, y: r.y * k, w: r.w * k, h: r.h * k };
}

/** Rescale a sentence map to the capture's pixel width (a map measured in CSS pixels scales by the DPR). */
export function scaleSentences(map: PostSentences, imageWidth: number): PostSentence[] {
  const k = imageWidth / map.pageWidth;
  if (k === 1) return map.sentences;
  return map.sentences.map((s) => ({ ...s, rects: s.rects.map((r) => scaleRect(r, map, imageWidth)) }));
}
