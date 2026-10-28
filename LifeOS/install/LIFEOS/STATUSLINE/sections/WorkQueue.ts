import { GLYPHS, icon } from "../Glyphs";
import { BAND, C, RESET, band, rgb } from "../Ansi";
import { number, object, string, type State } from "../State";
import { cellWidth, ellipsize, pack, type Segment } from "../Width";

const NUM = rgb(219, 234, 254), WORD = C.slate400, AMBER = rgb(251, 191, 36), SEP = ` ${C.slate600}│${RESET} `;
const STALE_S = 3600;
/** An ungraded capture older than this means the Synapse router has stopped; the router runs every 30 minutes. */
export const STUCK_MIN = 90;

/** "2h" or "45m". */
const ago = (minutes: number): string => minutes >= 60 ? `${Math.floor(minutes / 60)}h` : `${minutes}m`;

/** A coloured glyph, a count, and its word; the second form drops the word. */
function count(name: keyof typeof GLYPHS | null, value: number, word: string, group: number, rank: number): Segment {
  const g = name ? `${GLYPHS[name].color}${GLYPHS[name].glyph}${RESET} ` : "";
  const n = `${g}${NUM}${value}${RESET}`;
  return { group, rank, forms: [`${n} ${WORD}${word}${RESET}`, n] };
}

/** The cache, or null before it is first written. The phone layout draws neither row. */
function load(state: State): Record<string, unknown> | null {
  if (state.geometry.phone) return null;
  const raw = state.cache.json("work-queue.json");
  return raw === null ? null : object(raw);
}

/** "Stale 2h" when the cache is over an hour old, kept to the end of the row. */
function staleness(state: State, q: Record<string, unknown>): Segment[] {
  const age = Math.max(0, state.now - Date.parse(string(q.updated, "1970-01-01T00:00:00Z")) / 1000);
  return age > STALE_S ? [{ group: 9, rank: 99, forms: [`${C.slate500}Stale ${ago(Math.floor(age / 60))}${RESET}`] }] : [];
}

/** The row label: the glyph and the name, then the glyph alone. */
const tag = (glyph: keyof typeof GLYPHS, name: string): Segment => ({ group: 0, rank: 50, forms: [`${icon(glyph)}${WORD}${name}${RESET}`, `${GLYPHS[glyph].color}${GLYPHS[glyph].glyph}${RESET}`] });

/** `→ #N title` in whatever room the packed row leaves, the title cut at a word; `→ #N` alone when the title cannot keep 12 cells. */
function withTail(row: string, width: number, item: unknown): string {
  const t = object(item), n = number(t.number), title = string(t.title);
  if (!n) return row;
  const head = `${NUM}→ #${n}${RESET}`, left = width - cellWidth(row) - cellWidth(SEP) - cellWidth(`→ #${n}`);
  if (title && left - 1 >= 12) return `${row}${SEP}${head} ${C.region}${ellipsize(title, left - 1)}${RESET}`;
  return left >= 0 ? `${row}${SEP}${head}` : row;
}

/**
 * The WORK row under CURRENT STATE: the work {{PRINCIPAL_NAME}} owns, with ideas never counted in it. Active, Urgent (P0/P1) and
 * Open, then the top real P0/P1 item to work next. Reads only the cache the refresher writes; no row before it exists.
 */
export function renderWorkQueue(state: State): string {
  const q = load(state);
  if (!q) return "";
  const width = state.geometry.content;
  const row = pack(width, [
    tag("work", "WORK"),
    count("active", number(q.active), "Active", 0, 4),
    count("hot", number(q.urgent), "Urgent", 0, 3),
    count(null, number(q.open), "Open", 0, 2),
    ...staleness(state, q),
  ], SEP);
  return band(withTail(row, width, q.next), width, BAND.work) + "\n";
}

/**
 * The INPUTS row under WORK: what Synapse took in over the last day and filed as issues, the idea pile and how much of
 * it is core to our work, then the newest core idea. A Stuck chip draws only when a capture has waited past STUCK_MIN.
 */
export function renderInputs(state: State): string {
  const q = load(state);
  if (!q) return "";
  const width = state.geometry.content;
  const stuck = q.stuckMin === null || q.stuckMin === undefined ? -1 : number(q.stuckMin);
  const row = pack(width, [
    tag("inbox", "INPUTS"),
    count(null, number(q.captured), "Captured", 0, 2),
    count(null, number(q.filed), "Filed", 0, 1),
    ...(stuck > STUCK_MIN ? [{ group: 0, rank: 60, forms: [`${AMBER}Stuck ${ago(stuck)}${RESET}`] }] : []),
    count("rocket", number(q.ideas), "Ideas", 1, 4),
    { group: 1, rank: 0, forms: [`${NUM}${number(q.ideasCore)}${RESET} ${WORD}Core${RESET}`, ""] },
    ...staleness(state, q),
  ], SEP);
  return band(withTail(row, width, q.newestIdea), width, BAND.inputs) + "\n";
}
