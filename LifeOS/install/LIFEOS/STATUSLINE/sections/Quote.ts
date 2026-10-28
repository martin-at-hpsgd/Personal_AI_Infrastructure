import { join } from "node:path";
import { P, RESET, separator } from "../Ansi";
import type { State } from "../State";
import { readText } from "../Cache";

const len = (s: string): number => Array.from(s).length;

/** `fold -s -w N`: break after the last blank that fits, hard-break a word longer than the width. */
export function foldWords(text: string, width: number): string[] {
  const out: string[] = [];
  let line = "", lastBlank = -1;
  for (const ch of Array.from(text)) {
    if (Array.from(line).length >= width) {
      if (lastBlank >= 0) {
        const chars = Array.from(line);
        out.push(chars.slice(0, lastBlank + 1).join(""));
        line = chars.slice(lastBlank + 1).join("");
      } else { out.push(line); line = ""; }
      lastBlank = -1;
      const rest = Array.from(line);
      for (let i = rest.length - 1; i >= 0; i--) if (rest[i] === " ") { lastBlank = i; break; }
    }
    line += ch;
    if (ch === " ") lastBlank = Array.from(line).length - 1;
  }
  if (line) out.push(line);
  return out;
}

/**
 * The quote between two light rules, then a blank line. Claude Code drops empty statusline lines, so the blank line
 * carries a reset code to keep it.
 */
export function renderQuote(state: State): string {
  const quote = quoteLines(state);
  if (!quote) return "";
  const rule = separator(state.geometry.content, state.geometry.density, "┄");
  return `${rule}${quote}${rule}${RESET}\n`;
}

/** The deterministic minute quote: (epoch / 60) % count picks the row, no cache, no network. */
function quoteLines(state: State): string {
  if (state.geometry.phone) return "";
  const raw = readText(join(state.root, "USER", "PRINCIPAL", "Quotes.txt"));
  if (raw === null) return "";
  const count = raw.split("\n").length - 1;
  if (count <= 0) return "";
  const index = Math.trunc(state.now / 60) % count;
  const entry = raw.split("\n")[index];
  const bar = entry.indexOf("|");
  if (bar < 0) return "";
  const text = entry.slice(0, bar), author = entry.slice(bar + 1);
  if (!text || !author) return "";
  const width = state.geometry.content;
  const open = P.slate400, auth = P.quoteAuthor;
  if (len(text) + len(author) + 6 <= width) return `${open}"${text}"${RESET} ${auth}—${author}${RESET}\n`;
  // Continuation lines open with two spaces and the last one closes with a quote mark, so a folded line leaves 3 cells.
  const fold = Math.max(12, width - 3);
  const lines = foldWords(text, fold).map(l => l.replace(/ $/, "")).filter(l => l !== "");
  if (lines.length === 0) return "";
  let out = "";
  for (let i = 0; i < lines.length - 1; i++) out += i === 0 ? `${open}"${lines[i]}${RESET}\n` : `  ${open}${lines[i]}${RESET}\n`;
  const last = lines[lines.length - 1];
  const first = lines.length === 1;
  const prefix = first ? `${open}"` : `  ${open}`;
  const shared = (first ? 0 : 2) + (first ? 1 : 0) + len(last) + 1 + 1 + 3 + len(author);
  if (shared <= width) return `${out}${prefix}${last}"${RESET} ${auth}—${author}${RESET}\n`;
  // On its own line the author is indented when there is room, else flush, else only the surname.
  const byline = 3 + len(author) <= width ? `  —${author}` : 1 + len(author) <= width ? `—${author}` : `—${author.split(" ").pop()}`;
  return `${out}${prefix}${last}"${RESET}\n${auth}${byline}${RESET}\n`;
}
