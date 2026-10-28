#!/usr/bin/env bun
/**
 * StatusLineClip — the last thing a statusline render passes through.
 *
 * Reads a rendered statusline on stdin and guarantees two things the harness
 * renderer depends on and cannot recover from when violated:
 *   1. no line is wider than `cols - slack` terminal cells (a wrapped line adds a
 *      row the renderer does not know about; every redraw below it then lands one
 *      row off and overdraws the transcript — the "garbled session" screenshot);
 *   2. no more than `maxLines` lines (a bottom region taller than the pane forces
 *      the renderer into scroll-and-repaint, with the same result).
 *
 * An over-wide line is REFLOWED first and only truncated when reflow cannot help
 * (2026-09-19): a narrow pane keeps the same information and spends rows on it
 * instead of losing the tail of every row. Rows are broken at spaces that are
 * outside any background-color span, so a meter bar or a context bar — whose
 * internal spaces are painted cells — is never split down the middle. A token
 * that is itself wider than the frame still falls back to a hard cut.
 *
 * Width is measured with Bun.stringWidth, which matches kitty's cell widths for
 * the glyphs the statusline uses (VS16 emoji = 2, flags = 2, box drawing = 1).
 * ANSI SGR sequences are preserved; a truncated line is closed with a reset.
 *
 * Usage: StatusLineClip.ts <cols> [maxLines] [--no-reflow]
 *   cols <= 0 disables width handling; maxLines omitted or <= 0 disables the cap.
 */

const ANSI = /^\x1b\[[0-9;?]*[A-Za-z]/;
const RESET = "\x1b[0m";

export function clipLine(line: string, maxCells: number): string {
  if (maxCells <= 0 || Bun.stringWidth(line) <= maxCells) return line;
  const seg = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  let out = "";
  let width = 0;
  let i = 0;
  while (i < line.length) {
    const m = ANSI.exec(line.slice(i));
    if (m) {
      out += m[0];
      i += m[0].length;
      continue;
    }
    // Take the next grapheme cluster from the plain run starting at i.
    let end = i;
    while (end < line.length && line[end] !== "\x1b") end++;
    const run = line.slice(i, end);
    let consumed = 0;
    for (const { segment } of seg.segment(run)) {
      const w = Bun.stringWidth(segment);
      if (width + w > maxCells) return out + RESET;
      out += segment;
      width += w;
      consumed += segment.length;
    }
    i += consumed;
  }
  return out;
}

type Piece = { text: string; width: number; breakable: boolean };

/**
 * Split a rendered line into pieces at break-safe spaces. A space counts as a
 * break only while no background color is active: inside a painted bar the
 * spaces ARE the bar, and breaking there would cut the meter in half.
 * SGR state is tracked so every piece carries the escapes that precede it and
 * each emitted row can be re-primed with the styling in force at its start.
 */
function split(line: string): { pieces: Piece[]; prefixAt: string[] } {
  const seg = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  const pieces: Piece[] = [];
  const prefixAt: string[] = [];
  let sgr: string[] = []; // escapes in force
  let bg = false;
  let cur = "";
  let curWidth = 0;
  let curPrefix = "";
  let pendingBreak = false;

  const flush = (breakable: boolean) => {
    if (cur === "") return;
    pieces.push({ text: cur, width: curWidth, breakable });
    prefixAt.push(curPrefix);
    cur = "";
    curWidth = 0;
    curPrefix = sgr.join("");
  };

  let i = 0;
  while (i < line.length) {
    const m = ANSI.exec(line.slice(i));
    if (m) {
      const code = m[0];
      // Track SGR state well enough to re-prime a continuation row.
      if (code.endsWith("m")) {
        const body = code.slice(2, -1);
        if (body === "" || body === "0") {
          sgr = [];
          bg = false;
        } else {
          sgr.push(code);
          const params = body.split(";");
          for (let p = 0; p < params.length; p++) {
            const n = Number(params[p]);
            if (n === 48) bg = true;
            else if (n === 49) bg = false;
            else if (n >= 40 && n <= 47) bg = true;
            else if (n >= 100 && n <= 107) bg = true;
          }
        }
      }
      cur += code;
      i += code.length;
      continue;
    }
    let end = i;
    while (end < line.length && line[end] !== "\x1b") end++;
    const run = line.slice(i, end);
    for (const { segment } of seg.segment(run)) {
      if (segment === " " && !bg) {
        // Break-safe gap: close the current piece, remember the gap.
        flush(true);
        pendingBreak = true;
        continue;
      }
      if (pendingBreak) {
        // The gap belongs to the piece that follows, so a row that starts
        // after a break does not open with a stray space.
        pendingBreak = false;
      }
      cur += segment;
      curWidth += Bun.stringWidth(segment);
    }
    i = end;
  }
  flush(true);
  return { pieces, prefixAt };
}

/**
 * Reflow one over-wide line onto as many rows as it needs. Continuation rows
 * are indented two cells so a wrapped row reads as a continuation rather than
 * as a new field. Returns the original line untouched when it already fits.
 */
export function reflowLine(line: string, maxCells: number, indent = "  "): string[] {
  if (maxCells <= 0 || Bun.stringWidth(line) <= maxCells) return [line];
  const { pieces, prefixAt } = split(line);
  if (pieces.length <= 1) return [clipLine(line, maxCells)];

  const rows: string[] = [];
  const indentWidth = Bun.stringWidth(indent);
  let row = "";
  let rowWidth = 0;
  let first = true;
  let open = false; // this row has styling that must be closed

  const push = () => {
    if (row === "") return;
    rows.push(open ? row + RESET : row);
    row = "";
    rowWidth = 0;
    open = false;
  };

  for (let p = 0; p < pieces.length; p++) {
    const piece = pieces[p];
    const budget = first ? maxCells : maxCells - indentWidth;
    const gap = row === "" ? 0 : 1;
    if (row !== "" && rowWidth + gap + piece.width > budget) {
      push();
      first = false;
    }
    if (row === "") {
      row = first ? "" : indent;
      rowWidth = first ? 0 : indentWidth;
      // Re-prime the styling that was in force where this piece started.
      const prime = prefixAt[p];
      if (prime) {
        row += prime;
        open = true;
      }
    } else {
      row += " ";
      rowWidth += 1;
    }
    // A single piece wider than the frame gets a hard cut — nothing else fits.
    const roomed = first ? maxCells : maxCells - indentWidth;
    if (piece.width > roomed) {
      row += clipLine(piece.text, roomed - (rowWidth - (first ? 0 : indentWidth)));
      rowWidth = roomed;
      open = true;
      push();
      first = false;
      continue;
    }
    row += piece.text;
    rowWidth += piece.width;
    if (piece.text.includes("\x1b[")) open = true;
  }
  push();
  return rows.length ? rows : [clipLine(line, maxCells)];
}

export function clip(
  text: string,
  cols: number,
  maxLines = 0,
  slack = 2,
  reflow = true,
): string {
  const lines = text.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  const maxCells = cols > 0 ? Math.max(1, cols - slack) : 0;
  const flowed: string[] = [];
  for (const l of lines) {
    if (maxCells > 0 && reflow) flowed.push(...reflowLine(l, maxCells));
    else flowed.push(clipLine(l, maxCells));
  }
  const kept = maxLines > 0 && flowed.length > maxLines ? flowed.slice(0, maxLines) : flowed;
  return kept.join("\n") + "\n";
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const reflow = !args.includes("--no-reflow");
  const pos = args.filter((a) => !a.startsWith("--"));
  const cols = Number(pos[0] ?? 0) || 0;
  const maxLines = Number(pos[1] ?? 0) || 0;
  const input = await Bun.stdin.text();
  process.stdout.write(clip(input, cols, maxLines, 2, reflow));
}
