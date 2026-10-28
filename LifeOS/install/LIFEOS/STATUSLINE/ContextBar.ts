import { P, RESET, rgb } from "./Ansi";

/** Model-ladder rung hues used by the bar: full-strength RGB of each rung. */
export const BAR_C = {
  low: rgb(74, 222, 128), medium: rgb(59, 130, 246), high: rgb(239, 68, 68), max: rgb(168, 85, 247),
} as const;

export interface BarMix { low: number; medium: number; high: number; max: number }

/** The session model's rung hue, used until a mix exists. Patterns mirror the carrier-rung match; unknown → green. */
export function modelBarColor(modelName: string): string {
  if (/[Hh]aiku/.test(modelName)) return BAR_C.low;
  if (/[Ss]onnet/.test(modelName)) return BAR_C.medium;
  if (/[Ff]able/.test(modelName)) return BAR_C.max;
  if (/[Oo]pus/.test(modelName)) return BAR_C.high;
  return BAR_C.low;
}

/**
 * Session-mix context bar. The filled region is partitioned by each rung's share of output
 * tokens, low → max, via cumulative floor division; the two ⛁ markers keep the compaction thresholds visible.
 * `cells` is a CELL budget: a spaced bar (cells <= 20) halves it. Integer math truncates like bash.
 */
export function renderContextBar(cells: number, pct: number, mix: BarMix, fallbackColor: string): string {
  let width = cells;
  const filled = Math.max(0, Math.trunc((pct * width) / 100));
  const spaced = width <= 20;
  if (spaced) width = Math.max(4, Math.trunc(width / 2));
  const pos20 = Math.trunc(width / 3);
  const pos60 = Math.trunc((2 * width) / 3);
  const mtot = mix.low + mix.medium + mix.high + mix.max;
  let seg1 = 0, seg2 = 0, seg3 = 0;
  if (mtot > 0) {
    seg1 = Math.trunc((filled * mix.low) / mtot);
    seg2 = Math.trunc((filled * (mix.low + mix.medium)) / mtot);
    seg3 = Math.trunc((filled * (mix.low + mix.medium + mix.high)) / mtot);
  }
  let out = "";
  for (let i = 1; i <= width; i++) {
    if (i === pos20) out += `${rgb(251, 146, 60)}⛁${RESET}`;
    else if (i === pos60) out += `${rgb(180, 40, 40)}⛁${RESET}`;
    else if (i <= filled) {
      let color = fallbackColor;
      if (mtot > 0) color = i <= seg1 ? BAR_C.low : i <= seg2 ? BAR_C.medium : i <= seg3 ? BAR_C.high : BAR_C.max;
      out += `${color}⛁${RESET}`;
    } else out += `${P.ctxBucketEmpty}⛁${RESET}`;
    if (spaced) out += " ";
  }
  return out.endsWith(" ") ? out.slice(0, -1) : out;
}
