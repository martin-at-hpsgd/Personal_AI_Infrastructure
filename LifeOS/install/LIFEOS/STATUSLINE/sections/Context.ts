import { P, RESET, separator, usageColor } from "../Ansi";
import { icon } from "../Glyphs";
import { modelBarColor, renderContextBar } from "../ContextBar";
import { contextInput } from "../producers/Startup";
import { cellWidth, codepoints, label } from "../Width";
import type { State } from "../State";
import { startupLoad } from "./Files";
import { ladderModel } from "./Ladder";

/** C's `printf '%.1f'`: round-half-even on exact ties, which JavaScript's toFixed rounds up. */
export function oneDecimal(value: number): string {
  const quarters = value * 4;
  if (Number.isInteger(quarters) && quarters % 2 !== 0) {
    const tenths = value * 10;
    const down = Math.floor(tenths);
    return ((down % 2 === 0 ? down : down + 1) / 10).toFixed(1);
  }
  return value.toFixed(1);
}

/** CONTEXT row: the session-mix bar and percentage, the startup-load cell, then the closing rule. */
export function renderContext(state: State): string {
  if (state.geometry.phone) return "";
  const { pct } = contextInput(state);
  const { content, density } = state.geometry;
  const raw = /^-?\d+/.exec(pct);
  const rawPct = raw ? Number(raw[0]) : 0;
  const numeric = Number(pct);
  const display = Number.isFinite(numeric) && pct.trim() !== "" ? oneDecimal(numeric) : String(rawPct);
  // The label with its symbol, measured rather than assumed, plus the space after it.
  const tag = density === 1 ? icon("context").trimEnd() : `${icon("context")}${P.ctxSecondary}${label(density, "CONTEXT:", "CTX", "◉")}${RESET}`;
  const prefix = cellWidth(tag) + 1;
  const full = startupLoad(state);
  const room = content - prefix - (1 + display.length + 1);
  const load = room - codepoints(full.plain) >= 6 ? full : { plain: "", cell: "" };
  const { mix } = ladderModel(state);
  const row = (barWidth: number, cell: string): string =>
    `${tag} ${renderContextBar(barWidth, rawPct, mix, modelBarColor(state.model))} ${usageColor(rawPct)}${display}%${RESET}${cell}`;
  // The bar glyphs can draw a cell wider than the width asked for, so the row is measured: the startup cell goes first, then the bar narrows.
  let barWidth = Math.max(6, room - codepoints(load.plain)), cell = load.cell, line = row(barWidth, cell);
  if (cellWidth(line) > content && cell) { cell = ""; barWidth = Math.max(6, room); line = row(barWidth, cell); }
  while (cellWidth(line) > content && barWidth > 1) line = row(--barWidth, cell);
  return `${line}\n${separator(content, density)}`;
}
