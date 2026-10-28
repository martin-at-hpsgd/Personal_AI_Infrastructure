import { P, RESET, rgb } from "../Ansi";
import { contextFiles, listingBytes } from "../producers/ContextFiles";
import { contextInput } from "../producers/Startup";
import type { State } from "../State";

const GREEN = rgb(22, 163, 74);
/**
 * Colour by share of the context window, tenths of a percent: under 10% green, 10–12% orange, over 12% up to 15%
 * coral, over 15% red (the principal, 2026-10-15).
 */
export const sizeColor = (tenths: number): string =>
  tenths > 150 ? P.ratingLow : tenths > 120 ? P.rating4 : tenths >= 100 ? P.rating5 : GREEN;
const tenthsOf = (bytes: number, max: number): number => max > 0 ? Math.trunc((Math.trunc(bytes / 4) * 1000) / max) : 0;
/** The LD cell shows a whole percent (the principal, 2026-10-15); colour reads the shown number so the two agree. */
const wholePercent = (tenths: number): number => Math.round(tenths / 10);

/**
 * The startup-load cell: every startup file plus Claude Code's own skill, agent and MCP listings as one share of
 * the window (the last measured listing stands in until the transcript carries this session's). It sits at the
 * end of the CONTEXT row; the per-file breakdown rows were dropped on 2026-10-12, so the row is
 * the context meter followed by one LD: N% cell.
 */
export function startupLoad(state: State): { plain: string; cell: string } {
  const { max } = contextInput(state);
  const totalBytes = contextFiles(state).reduce((sum, file) => sum + file.bytes, 0) + listingBytes(state);
  const shown = wholePercent(tenthsOf(totalBytes, max));
  return {
    plain: `  LD: ${shown}%`,
    cell: `  ${P.ctxSecondary}LD:${RESET} ${sizeColor(shown * 10)}${shown}%${RESET}`,
  };
}
