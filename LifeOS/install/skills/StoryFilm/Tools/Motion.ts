/**
 * Motion.ts — the camera on a still painting. Pure; shared by the composition, Build.ts and the tests.
 *
 * A shot's motion word maps to a transform over the beat's visual window, progress p ∈ [0,1]:
 *   push       slow move in toward the focus point
 *   pull       slow move out from the focus point
 *   pan-left   the view slides left across the painting (the image moves right)
 *   pan-right  the view slides right
 *   tilt-up    the view rises (the image moves down)
 *   tilt-down  the view sinks
 *   hold       the smallest push — a breath, never a freeze, so a "hold" still reads as film
 * Returned tx/ty are fractions of the frame width/height; scale is applied about the frame center.
 * Every move keeps the painting covering the frame: the image is laid out at cover size × the minimum scale.
 */
import type { Motion } from "./Lib.ts";

export interface Transform { scale: number; tx: number; ty: number }
export interface Focus { x: number; y: number }

/** Gentle ease so a move starts and ends without a snap; near-linear through the middle. */
export function ease(p: number): number { const c = Math.min(1, Math.max(0, p)); return c * c * (3 - 2 * c) * 0.4 + c * 0.6; }

export const MIN_SCALE = 1.06;
export const MAX_SCALE = 1.2;

/** Translation that keeps the focus point near the center when scaled: fraction of frame, clamped so the image still covers. */
function toward(focus: Focus, scale: number, amount: number): { tx: number; ty: number } {
  const dx = (0.5 - focus.x) * amount, dy = (0.5 - focus.y) * amount;
  const lim = (scale - 1) / 2 / scale; // max fraction we can shift before an edge shows
  return { tx: Math.max(-lim, Math.min(lim, dx)), ty: Math.max(-lim, Math.min(lim, dy)) };
}

export function motionTransform(motion: Motion, p: number, focus: Focus = { x: 0.5, y: 0.5 }): Transform {
  const e = ease(p);
  const lerp = (a: number, b: number) => a + (b - a) * e;
  switch (motion) {
    case "push": { const s = lerp(1.08, 1.2); const t = toward(focus, s, 0.12 * e); return { scale: s, ...t }; }
    case "pull": { const s = lerp(1.2, 1.08); const t = toward(focus, s, 0.12 * (1 - e)); return { scale: s, ...t }; }
    case "pan-left": { const s = 1.14; const lim = (s - 1) / 2 / s; return { scale: s, tx: lerp(-lim, lim), ty: (0.5 - focus.y) * 0.03 }; }
    case "pan-right": { const s = 1.14; const lim = (s - 1) / 2 / s; return { scale: s, tx: lerp(lim, -lim), ty: (0.5 - focus.y) * 0.03 }; }
    case "tilt-up": { const s = 1.14; const lim = (s - 1) / 2 / s; return { scale: s, tx: (0.5 - focus.x) * 0.03, ty: lerp(-lim, lim) }; }
    case "tilt-down": { const s = 1.14; const lim = (s - 1) / 2 / s; return { scale: s, tx: (0.5 - focus.x) * 0.03, ty: lerp(lim, -lim) }; }
    case "hold": { const s = lerp(1.06, 1.095); const t = toward(focus, s, 0.03 * e); return { scale: s, ...t }; }
  }
}

/** CSS transform for a frame-sized image element. */
export function transformCss(t: Transform, width: number, height: number): string {
  return `translate(${(t.tx * width).toFixed(2)}px, ${(t.ty * height).toFixed(2)}px) scale(${t.scale.toFixed(4)})`;
}
