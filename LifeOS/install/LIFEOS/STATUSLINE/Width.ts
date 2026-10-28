export type Density = 1 | 2 | 3;
export type Tier = "xs" | "sm" | "md" | "lg" | "xl" | "xxl";
export interface Geometry {
  columns: number;
  lines: number;
  width: number;
  content: number;
  density: Density;
  tier: Tier;
  phone: boolean;
  /** Left padding that centers the content block in the pane; 0 when left-aligned. */
  margin: number;
  /** Lines are centered at every size (block in the pane, each line in the block); LIFEOS_STATUSLINE_ALIGN=left turns it off. */
  centered: boolean;
  stamp: string;
}

/** Cells Claude Code keeps for itself across a status line: 2 of padding on each side. */
export const CHROME = 4;

export function positiveInt(value: string | undefined): number {
  return value && /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : 0;
}

/**
 * The width comes from COLUMNS, which Claude Code sets to the pane it draws into, then the width the last COLUMNS render
 * persisted, then 80. The bash's tiers 1-3 (kitten @ ls, stty size </dev/tty, tput cols) are gone: each cost a process
 * every render, the statusline process has no controlling terminal (ps shows tty ??), so stty cannot answer, and
 * kitten reports the whole Kitty window, which is wider than a herdr or split pane.
 */
export function geometry(env: Record<string, string | undefined>, cachedWidth: string | null): Geometry {
  const columns = positiveInt(env.COLUMNS);
  const lines = positiveInt(env.LINES);
  const width = columns || positiveInt(cachedWidth?.trim()) || 80;
  const tier: Tier = width < 30 ? "xs" : width < 45 ? "sm" : width < 60 ? "md" : width < 80 ? "lg" : width < 110 ? "xl" : "xxl";
  const density: Density = width < 45 ? 1 : width < 80 ? 2 : 3;
  const cap = /^\d+$/.test(env.LIFEOS_STATUSLINE_MAX_WIDTH ?? "100") ? Number(env.LIFEOS_STATUSLINE_MAX_WIDTH ?? 100) : 100;
  // Claude Code draws the status line 2 cells in from each pane edge and ends any longer line with "…" (measured at
  // COLUMNS=100: 96 cells show, the 97th is cut), so the usable width is the pane less CHROME.
  const content = Math.max(10, cap > 0 ? Math.min(width - CHROME, cap) : width - CHROME);
  // The full layout is about 28 rows at any width, so a phone pane kept only a few rows for the conversation and the
  // prompt (principal directive, 2026-10-20). A pane under 60 columns or under 30 lines gets the
  // three-row phone layout; LIFEOS_STATUSLINE_COMPACT=0 or 1 forces either.
  const phone = env.LIFEOS_STATUSLINE_COMPACT === "1" || (env.LIFEOS_STATUSLINE_COMPACT !== "0" && ((columns > 0 && columns < 60) || (lines > 0 && lines < 30)));
  // Every layout is centered, the phone one included (principal directive, 2026-10-24).
  const centered = env.LIFEOS_STATUSLINE_ALIGN !== "left";
  const margin = centered ? Math.max(0, Math.trunc((width - CHROME - content) / 2)) : 0;
  return { columns, lines, width, content, density, tier, phone, margin, centered, stamp: `${env.COLUMNS || "0"}x${env.LINES || "0"}` };
}

export function label(density: Density, full: string, short: string, glyph: string): string {
  return density === 3 ? full : density === 2 ? short : glyph;
}

export const cellWidth = (text: string): number => Bun.stringWidth(text);

/**
 * The first candidate that fits `width` terminal cells, else the last. Rows list their forms fullest first, so a row
 * fills a wide pane and gets more concise as the pane narrows instead of wrapping. ANSI codes are not counted.
 */
export function fit(width: number, ...candidates: string[]): string {
  for (const candidate of candidates) if (cellWidth(candidate) <= width) return candidate;
  return candidates[candidates.length - 1] ?? "";
}
/** One piece of a packed row: its forms fullest first ("" means it may vanish), and its rank (lower gives way first). */
export interface Segment { group: number; rank: number; forms: string[] }

/**
 * A row from ranked segments: segments in one group join with two spaces, groups with `sep`. While the row is wider
 * than `width`, the lowest-ranked segment with a shorter form left steps to it, so the least important detail goes
 * first and no row lists its narrower versions by hand.
 */
export function pack(width: number, segments: Segment[], sep: string): string {
  const at = segments.map(() => 0);
  const draw = (): string => {
    const groups = new Map<number, string[]>();
    segments.forEach((s, i) => { const f = s.forms[at[i]!] ?? ""; if (f) groups.set(s.group, [...(groups.get(s.group) ?? []), f]); });
    return [...groups.keys()].sort((a, b) => a - b).map((g) => groups.get(g)!.join("  ")).join(sep);
  };
  for (;;) {
    const row = draw();
    if (cellWidth(row) <= width) return row;
    const order = segments.map((_, i) => i).filter((i) => at[i]! < segments[i]!.forms.length - 1).sort((a, b) => segments[a]!.rank - segments[b]!.rank);
    if (order.length === 0) return row;
    at[order[0]!]!++;
  }
}

/** Cut `text` to `width` cells at a word boundary with an ellipsis; a single over-long word is cut mid-word. */
export function ellipsize(text: string, width: number): string {
  if (cellWidth(text) <= width) return text;
  let out = "";
  for (const word of text.split(" ")) {
    const next = out ? `${out} ${word}` : word;
    if (cellWidth(next) + 1 > width) break;
    out = next;
  }
  if (out) return `${out}…`;
  return `${Array.from(text).slice(0, Math.max(0, width - 1)).join("")}…`;
}

/**
 * Terminal cells by the simple rule the money row and the account chips use: astral-plane pictographs (emoji) take
 * two cells, variation selectors and joiners none, everything else one. ANSI codes are not counted.
 */
export function pictographCells(s: string): number {
  const plain = s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
  let w = 0;
  for (const ch of plain) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp === 0xfe0f || cp === 0x200d) continue;
    w += cp >= 0x1f000 ? 2 : 1;
  }
  return w;
}

/** Legacy header padding uses code points, not terminal cells. */
export const codepoints = (text: string): number => Array.from(text).length;
