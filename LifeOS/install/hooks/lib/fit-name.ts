/**
 * fit-name.ts — fit a session name to the columns a surface has.
 *
 * Every naming surface used to cut the name by counting words: the shared label
 * took three, the herdr sidebar five. What each surface really has is a fixed
 * number of columns, so word counts gave "FIX SEARCH FOR" on one session and a
 * clipped label on the next (ISA 20260911-session-identity-unify, F5). fitName
 * returns the longest whole-word prefix of the name that fits the width and ends
 * on a content word, so the label still reads as the name (2026-09-16)
 * and only its length moves with the surface.
 */
import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

/** Words a fitted name may not end on: a label ending "FOR" or "THE" reads cut off. */
export const STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'nor', 'for', 'of', 'to', 'in', 'on', 'at', 'by',
  'with', 'from', 'into', 'onto', 'via', 'per', 'as', 'is', 'are', 'was', 'be', 'vs',
  'than', 'then', 'so', 'if', 'every', 'each', 'its', 'my', 'our', 'your', 'their',
  'this', 'that', 'these', 'those', 'not', 'no',
]);

// herdr draws the state icon and padding in the first columns of a sidebar row:
// sidebar_width 33 leaves 27 for the name.
const SIDEBAR_GUTTER = 6;
const DEFAULT_SIDEBAR_WIDTH = 33;
const HERDR_CONFIG = join(homedir(), '.config', 'herdr', 'config.toml');

/** Name columns in herdr's sidebar, read from its `sidebar_width` setting. */
export function herdrSidebarCols(configPath = HERDR_CONFIG): number {
  let width = DEFAULT_SIDEBAR_WIDTH;
  try {
    if (existsSync(configPath)) {
      const m = readFileSync(configPath, 'utf-8').match(/^\s*sidebar_width\s*=\s*(\d+)/m);
      if (m) width = Number(m[1]);
    }
  } catch { /* default */ }
  return Math.max(10, width - SIDEBAR_GUTTER);
}

/** The width each surface fits the name to. The label is the one string every
 * tab and the statusline share: 28 columns is about what three words used to
 * take, without cutting a short fourth word or keeping a dangling third. */
export const SURFACE_WIDTHS = {
  label: { cols: 28, lines: 1 },
  get sidebar() { return { cols: herdrSidebarCols(), lines: 2 }; },
};

const wordsOf = (name: string): string[] => name.split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w));
const bare = (w: string): string => w.replace(/[^A-Za-z0-9]+$/, '');

/** The first k words with the last one cleaned, or null when they cannot end a name. */
function cleanPrefix(words: string[], k: number): string[] | null {
  const out = words.slice(0, k);
  const last = bare(out[k - 1]);
  if (!last || (k > 1 && STOP_WORDS.has(last.toLowerCase()))) return null;
  out[k - 1] = last;
  return out;
}

/** The longest clean whole-word prefix of `name` within `cols`. A first word wider
 * than the surface is cut; a name with no words gives ''. Pure. */
export function fitName(name: string | null | undefined, cols: number): string {
  const words = wordsOf(name || '');
  if (!words.length) return '';
  for (let k = words.length; k >= 1; k--) {
    const pre = cleanPrefix(words, k);
    if (pre && pre.join(' ').length <= cols) return pre.join(' ');
  }
  const first = bare(words[0]) || words[0];
  return bare(first.slice(0, cols)) || first.slice(0, cols);
}

/** Lay `words` over at most `lines` lines of `cols`, breaking where the lines come
 * out most even. Null when they do not fit. */
function layout(words: string[], cols: number, lines: number): string[] | null {
  const whole = words.join(' ');
  if (whole.length <= cols) return [whole];
  if (lines <= 1) return null;
  let best: string[] | null = null;
  for (let i = 1; i < words.length; i++) {
    const head = words.slice(0, i).join(' ');
    if (head.length > cols) break;
    const rest = layout(words.slice(i), cols, lines - 1);
    if (!rest) continue;
    const cand = [head, ...rest];
    if (!best || Math.max(...cand.map((l) => l.length)) < Math.max(...best.map((l) => l.length))) best = cand;
  }
  return best;
}

/** fitName over several lines: the longest clean prefix that fits `lines` lines of
 * `cols`, broken as evenly as it can be. Pure. */
export function fitNameLines(name: string | null | undefined, cols: number, lines: number): string[] {
  const words = wordsOf(name || '');
  if (!words.length) return [];
  for (let k = words.length; k >= 1; k--) {
    const pre = cleanPrefix(words, k);
    const laid = pre && layout(pre, cols, lines);
    if (laid) return laid;
  }
  return [fitName(name, cols)];
}
