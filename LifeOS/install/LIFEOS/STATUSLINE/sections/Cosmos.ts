import { BAND, P, RESET, band } from "../Ansi";
import type { State } from "../State";

const LABEL = P.slate400, VALUE = "\x1b[38;2;199;210;254m", UNIT = P.slate500;
const len = (s: string): number => Array.from(s).length;

/**
 * `IFS=$'\t' read -r a b c ...`: tabs are IFS whitespace, so runs collapse and edge tabs vanish; the last
 * name takes the rest of the line. Names not reached are empty.
 */
export function readFields(line: string, count: number): string[] {
  const out: string[] = [];
  let rest = line.replace(/^\t+/, "");
  while (out.length < count - 1 && rest !== "") {
    const i = rest.indexOf("\t");
    if (i < 0) { out.push(rest); rest = ""; break; }
    out.push(rest.slice(0, i));
    rest = rest.slice(i).replace(/^\t+/, "");
  }
  if (out.length < count) out.push(rest.replace(/\t+$/, ""));
  while (out.length < count) out.push("");
  return out;
}

/** How fast we are moving: segments flow into rows no wider than the frame, breaking only between segments. */
export function renderCosmos(state: State): string {
  if (state.geometry.phone) return "";
  const raw = state.cache.text("cosmos-line.txt");
  if (!raw) return "";
  const width = state.geometry.content;
  // The refresh caches without a trailing newline, so the final line is a full segment; blank lines are skipped below.
  const lines = raw.split("\n");
  let out = "", row = "", used = 0;
  for (const line of lines) {
    const [icon, label, num, unit] = readFields(line, 4);
    if (!label || !num) continue;
    let segWidth = 2 + 1 + len(label) + 1 + len(num);
    let seg = `${icon} ${LABEL}${label}${RESET} ${VALUE}${num}${RESET}`;
    // A unit that would push the segment past the frame is dropped; the number keeps its label.
    if (unit && segWidth + 1 + len(unit) <= width) { segWidth += 1 + len(unit); seg += ` ${UNIT}${unit}${RESET}`; }
    if (used > 0 && used + 3 + segWidth > width) { out += `${row}\n`; row = ""; used = 0; }
    if (used > 0) { row += `   ${seg}`; used += 3 + segWidth; }
    else { row = seg; used = segWidth; }
  }
  const lit = used > 0 ? `${out}${row}\n` : out;
  return lit.split("\n").map((line) => line ? band(line, width, BAND.cosmos) : line).join("\n");
}
