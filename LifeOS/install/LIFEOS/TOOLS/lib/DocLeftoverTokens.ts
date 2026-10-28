/**
 * Detector for leftover JavaScript string-replace debris in markdown prose.
 *
 * 2026-10-02: a bulk doc edit passed a replacer example through
 * String.prototype.replace as the replacement text, and the literal
 * "() => b" landed in eleven doc spots. The /ic lane `doc-leftover-tokens`
 * (IntegrityCheck.ts) uses this.
 *
 * What counts as a hit, per line, outside a fenced code block: the literal text
 * `() => b` with no identifier character after the b, inline code included (that
 * is how the debris reads: it replaced a real word in a sentence). An arrow
 * function whose body starts with a b-word (`() => backToTop…`) is code, not debris.
 *
 * Only that literal is checked. A replacement string carrying a dollar-quote or
 * dollar-ampersand token does splice file text, but JS consumes the token while
 * splicing, so the damaged file holds the spliced text and never the token. A
 * literal dollar token in prose was written on purpose (a function replacer,
 * split/join, a doc quoting the hazard), so it is not a signal and is not flagged.
 *
 * A fence opens and closes on a line starting with three or more backticks or
 * tildes. An unclosed fence runs to the end of the file, so a stray fence
 * hides the rest of the file from this check; that is the accepted cost.
 */
export interface LeftoverHit {
  line: number;   // 1-based
  token: string;
  text: string;   // trimmed source line, clipped
}

const ARROW_B = "() => b";
const ARROW_B_RE = /\(\) => b(?![\w$])/;
const FENCE_RE = /^\s*(```+|~~~+)/;

export function findLeftoverTokens(text: string): LeftoverHit[] {
  const hits: LeftoverHit[] = [];
  const lines = text.split("\n");
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const f = FENCE_RE.exec(line);
    if (f) {
      const mark = f[1][0];
      if (fence === null) fence = mark;
      else if (fence === mark) fence = null;
      continue;
    }
    if (fence !== null) continue;
    if (ARROW_B_RE.test(line)) hits.push({ line: i + 1, token: ARROW_B, text: line.trim().slice(0, 120) });
  }
  return hits;
}
