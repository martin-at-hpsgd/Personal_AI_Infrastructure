/**
 * FilmTimeline.ts — the film as a schedule: when every painting, caption, word and card is on screen and how
 * bright. Pure; no DOM. Build.ts turns the plan into a HyperFrames composition (FilmComposition.ts), and the
 * page's runtime (FilmRuntime.ts) turns it into one paused GSAP timeline.
 *
 * The rules are the ones the Remotion composition evaluated per frame, kept as functions of time t:
 *   windows     each beat's painting enters by a 1.1 s cross-dissolve inside a scene, a 0.8 s fade from black
 *               at a scene break, a 1 s fade after the title; it leaves the same way (visualWindows)
 *   opacity     the painting's opacity is the lower of its in-ramp and out-ramp (windowOpacity)
 *   band        the caption shading under the text follows the brightest painting on screen
 *   caption     from 0.15 s before a beat's first word to 0.6 s after its last, the sentence being spoken is
 *               shown; a word is white while spoken (to 80 ms after it ends), cream once said, dim before
 *   cards       the title fades in over 1 s and out 0.4 s before the first word; the end card fades in 1.9 s
 *               after the last word and out over the final 0.9 s
 *
 * Continuous values are piecewise linear in t, so the plan stores exact keyframes and the page interpolates
 * between them. Discrete changes (caption shown, sentence, word state) are stored as the first frame at which
 * the new state holds, computed by evaluating the same rule at frame/fps, so every frame matches the rule.
 */
import type { Motion, Timeline, TimelineBeat, Word } from "./Lib.ts";

/** Seconds of cross-dissolve between beats in the same scene; fade to black at a scene break; the title/end handoffs. */
export const DISSOLVE = 1.1;
export const SCENE_FADE = 0.8;
export const CARD_FADE = 1.0;
/** Caption timing: shown from 0.15 s before the beat to 0.6 s after it; a sentence holds 0.35 s past its last word; a word stays lit 80 ms past its end. */
export const CAPTION_LEAD = 0.15;
export const CAPTION_TAIL = 0.6;
export const SENTENCE_HOLD = 0.35;
export const WORD_LIT_TAIL = 0.08;

/** Clamped piecewise-linear interpolation over a strictly increasing input range. */
export function interpolate(t: number, xs: readonly number[], ys: readonly number[]): number {
  if (t <= xs[0]!) return ys[0]!;
  for (let i = 1; i < xs.length; i++) {
    if (t <= xs[i]!) { const a = xs[i - 1]!, b = xs[i]!; return ys[i - 1]! + ((ys[i]! - ys[i - 1]!) * (t - a)) / (b - a); }
  }
  return ys[ys.length - 1]!;
}

/** Each beat's visual window: when its painting is on screen, and how it enters and leaves. */
export interface Window { id: string; vs: number; ve: number; inDur: number; outDur: number }
export function visualWindows(tl: Timeline): Window[] {
  const out: Window[] = [];
  for (let i = 0; i < tl.beats.length; i++) {
    const b = tl.beats[i]!, prev = tl.beats[i - 1], next = tl.beats[i + 1];
    let vs: number, inDur: number, ve: number, outDur: number;
    if (!prev) { vs = b.start - CARD_FADE; inDur = CARD_FADE; }
    else if (prev.scene !== b.scene) { vs = b.start - SCENE_FADE; inDur = SCENE_FADE; }
    else { const m = (prev.end + b.start) / 2; vs = m - DISSOLVE / 2; inDur = DISSOLVE; }
    if (!next) { ve = b.end + 1.6; outDur = CARD_FADE; }
    else if (next.scene !== b.scene) { ve = b.end + 0.35 + SCENE_FADE; outDur = SCENE_FADE; }
    else { const m = (b.end + next.start) / 2; ve = m + DISSOLVE / 2; outDur = DISSOLVE; }
    out.push({ id: b.id, vs, ve, inDur, outDur });
  }
  return out;
}

export function windowOpacity(w: Window, t: number): number {
  if (t <= w.vs || t >= w.ve) return 0;
  const a = interpolate(t, [w.vs, w.vs + w.inDur], [0, 1]);
  const b = interpolate(t, [w.ve - w.outDur, w.ve], [1, 0]);
  return Math.min(a, b);
}

/** The caption band's shading: the brightest painting on screen. */
export function bandOpacity(wins: readonly Window[], t: number): number {
  let m = 0;
  for (const w of wins) m = Math.max(m, windowOpacity(w, t));
  return m;
}

export function titleOpacity(tl: Timeline, t: number): number {
  const first = tl.beats[0]!;
  return interpolate(t, [0, CARD_FADE, first.start - CARD_FADE - 0.4, first.start - 0.4], [0, 1, 1, 0]);
}
export function endCardStart(tl: Timeline): number { return tl.beats[tl.beats.length - 1]!.end + 1.9; }
export function endOpacity(tl: Timeline, t: number): number {
  const s = endCardStart(tl);
  return interpolate(t, [s, s + CARD_FADE, tl.total - 0.9, tl.total - 0.05], [0, 1, 1, 0]);
}

/** One sentence of a beat's text with each text word's timing (words past the alignment take the last timed end). */
export interface Sentence { words: Word[]; lastEnd: number | null }

/** Split a beat's text into sentences and walk the timed words across them by word count. */
export function beatSentences(beat: TimelineBeat, text: string): Sentence[] {
  if (!beat.words.length) return [];
  const sentences = text.replace(/\s+/g, " ").trim().match(/[^.!?]+[.!?]+["”’)]?|[^.!?]+$/g) ?? [text];
  let cursor = 0;
  return sentences.map((s) => {
    const textWords = s.trim().split(/\s+/);
    const g = beat.words.slice(cursor, cursor + textWords.length);
    cursor += textWords.length;
    if (!g.length) return { words: [], lastEnd: null };
    const last = g[g.length - 1]!.e;
    return { lastEnd: last, words: textWords.map((w, i) => ({ w, s: g[i]?.s ?? last, e: g[i]?.e ?? last })) };
  });
}

/** Index of the sentence on screen at t, or null when the beat shows none. */
export function sentenceAt(sentences: readonly Sentence[], t: number): number | null {
  if (!sentences.length) return null;
  let idx = sentences.findIndex((s) => s.lastEnd !== null && t < s.lastEnd + SENTENCE_HOLD);
  if (idx === -1) idx = sentences.length - 1;
  return sentences[idx]!.words.length ? idx : null;
}

export type WordState = "ahead" | "now" | "said";
export function wordState(w: Word, t: number): WordState {
  if (t >= w.s && t < w.e + WORD_LIT_TAIL) return "now";
  return t >= w.s ? "said" : "ahead";
}
export const WORD_COLOR: Record<WordState, string> = { now: "#FFFFFF", said: "#EDE6DA", ahead: "rgba(237,230,218,0.42)" };

/** Whether the beat's caption is shown at t (before its window opacity is applied). */
export function captionShown(beat: TimelineBeat, t: number): boolean { return t >= beat.start - CAPTION_LEAD && t <= beat.end + CAPTION_TAIL; }

// ─────────────────────────────────────────────────────────────── the plan

/** A linear ramp from v0 at t0 to v1 at t1. */
export interface Ramp { t0: number; t1: number; v0: number; v1: number }
/** A discrete change: from `frame` on (inclusive) the value is `value`. */
export interface Step<T> { frame: number; value: T }
export interface Discrete<T> { initial: T; steps: Step<T>[] }

export interface PlanPainting { id: string; image: string; start: number; duration: number; motion: Motion; focus: { x: number; y: number }; opacity: Ramp[] }
export interface PlanWord { w: string; color: Discrete<string> }
export interface PlanSentence { shown: Discrete<boolean>; words: PlanWord[] }
export interface PlanCaption { id: string; shown: Discrete<boolean>; opacity: Ramp[]; sentences: PlanSentence[] }
export interface FilmPlan {
  fps: number; width: number; height: number; total: number;
  title: string; titleLine?: string; endLine: string;
  paintings: PlanPainting[];
  band: Ramp[];
  captions: PlanCaption[] | null;
  titleCard: Ramp[];
  endCard: Ramp[];
}

/** Smallest frame i with i/fps ≥ x (strict: > x), evaluated exactly as the frame's time is. */
export function firstFrameAtOrAfter(x: number, fps: number, strict = false): number {
  const ok = (i: number) => (strict ? i / fps > x : i / fps >= x);
  let i = Math.max(0, Math.ceil(x * fps));
  while (i > 0 && ok(i - 1)) i--;
  while (!ok(i)) i++;
  return i;
}

/** A discrete function of the frame, sampled at every candidate frame where it may change. */
export function discrete<T>(fn: (frame: number) => T, candidates: readonly number[]): Discrete<T> {
  const initial = fn(0);
  const steps: Step<T>[] = [];
  let cur = initial;
  for (const f of [...new Set(candidates)].filter((c) => c > 0).sort((a, b) => a - b)) {
    const v = fn(f);
    if (v !== cur) { steps.push({ frame: f, value: v }); cur = v; }
  }
  return { initial, steps };
}

/** Keyframes of a piecewise-linear function whose kinks all lie in `times`, as ramps; flat stretches are dropped. */
export function ramps(fn: (t: number) => number, times: readonly number[]): Ramp[] {
  const ts = [...new Set(times)].sort((a, b) => a - b);
  const out: Ramp[] = [];
  for (let i = 1; i < ts.length; i++) {
    const t0 = ts[i - 1]!, t1 = ts[i]!;
    if (t1 - t0 < 1e-9) continue;
    const v0 = fn(t0), v1 = fn(t1);
    if (Math.abs(v1 - v0) < 1e-12) continue;
    out.push({ t0, t1, v0, v1 });
  }
  return out;
}

/** The kinks of one window's opacity: its four ramp ends and the point where the two ramps cross. */
export function windowKinks(w: Window): number[] {
  const cross = (w.vs * w.outDur + w.ve * w.inDur) / (w.inDur + w.outDur);
  return [w.vs, w.vs + w.inDur, w.ve - w.outDur, w.ve, cross].filter((t) => t >= w.vs && t <= w.ve);
}

/** The kinks of the band (the max over windows): every window's kinks plus every crossing of two windows between them. */
export function bandKinks(wins: readonly Window[]): number[] {
  const base = [...new Set(wins.flatMap(windowKinks))].sort((a, b) => a - b);
  const out = [...base];
  for (let i = 1; i < base.length; i++) {
    const a = base[i - 1]!, b = base[i]!;
    const live = wins.filter((w) => w.ve > a && w.vs < b);
    for (let x = 0; x < live.length; x++) for (let y = x + 1; y < live.length; y++) {
      const da = windowOpacity(live[x]!, a) - windowOpacity(live[y]!, a), db = windowOpacity(live[x]!, b) - windowOpacity(live[y]!, b);
      if (da * db < 0) out.push(a + ((b - a) * da) / (da - db));
    }
  }
  return out;
}

export interface PlanInput {
  timeline: Timeline;
  beats: { id: string; text: string; image: string; motion: Motion; focus: { x: number; y: number } }[];
  title: string; author?: string; endLine?: string; captions: boolean;
  width: number; height: number;
}

export function buildPlan(input: PlanInput): FilmPlan {
  const tl = input.timeline, fps = tl.fps;
  const wins = visualWindows(tl);
  const byId = new Map(input.beats.map((b) => [b.id, b]));
  const at = (frame: number) => frame / fps;
  const frameOf = (x: number) => firstFrameAtOrAfter(x, fps);
  const paintings: PlanPainting[] = wins.map((w) => {
    const b = byId.get(w.id);
    if (!b) throw new Error(`timeline beat ${w.id} has no film beat`);
    return { id: w.id, image: b.image, start: w.vs, duration: w.ve - w.vs, motion: b.motion, focus: b.focus, opacity: ramps((t) => windowOpacity(w, t), windowKinks(w)) };
  });
  const captions = input.captions ? tl.beats.map((beat, i): PlanCaption => {
    const w = wins[i]!;
    const sentences = beatSentences(beat, byId.get(beat.id)!.text);
    const shownCandidates = [frameOf(beat.start - CAPTION_LEAD), firstFrameAtOrAfter(beat.end + CAPTION_TAIL, fps, true)];
    const sentenceCandidates = sentences.flatMap((s) => (s.lastEnd === null ? [] : [frameOf(s.lastEnd + SENTENCE_HOLD)]));
    return {
      id: beat.id,
      shown: discrete((f) => captionShown(beat, at(f)), shownCandidates),
      opacity: ramps((t) => windowOpacity(w, t), windowKinks(w)),
      sentences: sentences.map((s, k) => ({
        shown: discrete((f) => sentenceAt(sentences, at(f)) === k, sentenceCandidates),
        words: s.words.map((word) => ({ w: word.w, color: discrete((f) => WORD_COLOR[wordState(word, at(f))], [frameOf(word.s), frameOf(word.e + WORD_LIT_TAIL)]) })),
      })),
    };
  }) : null;
  const first = tl.beats[0]!, endStart = endCardStart(tl);
  return {
    fps, width: input.width, height: input.height, total: tl.total,
    title: input.title, titleLine: input.author ? `by ${input.author}` : undefined, endLine: input.endLine ?? "an animated reading",
    paintings,
    band: ramps((t) => bandOpacity(wins, t), bandKinks(wins)),
    captions,
    titleCard: ramps((t) => titleOpacity(tl, t), [0, CARD_FADE, first.start - CARD_FADE - 0.4, first.start - 0.4]),
    endCard: ramps((t) => endOpacity(tl, t), [endStart, endStart + CARD_FADE, tl.total - 0.9, tl.total - 0.05]),
  };
}

/** Value of a ramp list at t: the ramps are contiguous where the value changes, and flat between them. */
export function rampValue(rs: readonly Ramp[], t: number, before = 0): number {
  let v = before;
  for (const r of rs) {
    if (t < r.t0) return v;
    if (t <= r.t1) return r.v0 + ((r.v1 - r.v0) * (t - r.t0)) / (r.t1 - r.t0);
    v = r.v1;
  }
  return v;
}

/** Value of a discrete track at a frame. */
export function discreteValue<T>(d: Discrete<T>, frame: number): T {
  let v = d.initial;
  for (const s of d.steps) { if (s.frame > frame) break; v = s.value; }
  return v;
}
