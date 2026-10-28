/**
 * glyph-core.ts — the one table of symbols for every LifeOS terminal surface (ISA 20261015-statusline-glyphs).
 *
 * IMPORT-FREE ON PURPOSE: the status line imports it (LIFEOS/STATUSLINE/Glyphs.ts), and each mod carries a byte-identical
 * copy (a hooks module cannot import outside its plugin folder), moved by its SyncCores script and held by a parity test.
 * The response-format markers ride here too, so the status line, hooks and mods draw one consistent set. Only the drawn
 * copy changes; stored replies and model-facing text keep their emoji.
 *
 * Every icon on the line is a Nerd Font symbol in a colour that means something, replacing a mix of emoji from four
 * tools, a weather service and the sections themselves, for higher quality symbols with colour. Two ways in:
 * - `icon(name)` for a section that draws a symbol itself.
 * - `glyphify(frame)`, run once by Frame.finish, for emoji that arrive as data: the tide, cosmos, money and pool lines,
 *   and the weather code. A country flag is left as the real flag. Those writers keep their plain text; the render decides how it looks.
 *
 * Width parity is the whole contract. An emoji takes two cells; a glyph plus a space takes two, and kitty draws a
 * private-use glyph followed by a space across both cells. Every glyph sits below U+1F000, because `pictographCells`
 * counts everything from U+1F000 as two cells. The symbols are checked against both machines' Hack Nerd Font builds;
 * the desktop's is older, so Font Awesome's water waves (U+EF30) is out and the tide is a plain `≋`.
 */
const RESET = "\x1b[0m";

interface Glyph { glyph: string; color: string }

const hex = (h: string): string => {
  const n = Number.parseInt(h.slice(1), 16);
  return `\x1b[38;2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}m`;
};
const g = (cp: number, color: string): Glyph => ({ glyph: String.fromCodePoint(cp), color: hex(color) });

/** Name → symbol and colour. Codes are nf-weather (U+E3xx) and nf-fa (U+F0xx–F2xx), present in every Nerd Font build. */
export const GLYPHS = {
  sun: g(0xe30d, "#e0af68"), night: g(0xf186, "#c0caf5"), partly: g(0xe302, "#e0af68"), cloudy: g(0xe312, "#9aa5ce"),
  fog: g(0xe313, "#737aa2"), rain: g(0xe318, "#7aa2f7"), snow: g(0xe31a, "#c0caf5"), storm: g(0xe31d, "#bb9af7"),
  thermo: g(0xe350, "#ff9e64"), tide: g(0x224b, "#73daca"),
  galaxy: g(0xe370, "#bb9af7"), meteor: g(0xe36a, "#2ac3de"), wind: g(0xe34b, "#73daca"), magnet: g(0xf076, "#f7768e"),
  moonNew: g(0xe38d, "#565f89"), moonWaxCrescent: g(0xe390, "#c0caf5"), moonFirstQuarter: g(0xe394, "#c0caf5"),
  moonWaxGibbous: g(0xe397, "#c0caf5"), moonFull: g(0xe39b, "#e0af68"), moonWanGibbous: g(0xe39e, "#c0caf5"),
  moonThirdQuarter: g(0xe3a2, "#c0caf5"), moonWanCrescent: g(0xe3a5, "#c0caf5"),
  marker: g(0xf041, "#f7768e"), globe: g(0xf0ac, "#7dcfff"),
  money: g(0xf0d6, "#9ece6a"), card: g(0xf09d, "#7aa2f7"), pool: g(0xf074, "#2ac3de"), api: g(0xf1e6, "#ff9e64"),
  bolt: g(0xf0e7, "#e0af68"), locked: g(0xf05e, "#f7768e"),
  session: g(0xf120, "#7dcfff"), state: g(0xf21e, "#73daca"), models: g(0xf2db, "#bb9af7"), context: g(0xf1c0, "#7aa2f7"),
  // The state row: smile, lightning bolt, paint brush, and a gauge for Oura's 0-100 readiness score. Energy is the bolt
  // in orange, apart from ultracode's amber one (the battery and the open circle did not read).
  // The work-queue row: tasks list, rocket for project ideas, fire for P0/P1, play for active work, inbox for Synapse.
  work: g(0xf0ae, "#ff9e64"), rocket: g(0xf135, "#f7768e"), hot: g(0xf06d, "#ef4444"), active: g(0xf04b, "#9ece6a"),
  inbox: g(0xf01c, "#7dcfff"),
  mood: g(0xf118, "#f7768e"), energy: g(0xf0e7, "#ff9e64"), creativity: g(0xf1fc, "#bb9af7"), readiness: g(0xf0e4, "#73daca"),
  // The response format: bullseye, lightbulb, triangle, wrench, check, question, people, speech, microphone.
  lead: g(0xf140, "#3B82F6"), insight: g(0xf0eb, "#e0af68"), caution: g(0xf071, "#FFB000"), change: g(0xf0ad, "#3B82F6"),
  verify: g(0xf058, "#22c55e"), open: g(0xf059, "#eab308"), agents: g(0xf0c0, "#bb9af7"), closer: g(0xf075, "#3B82F6"),
  spoken: g(0xf130, "#bb9af7"), failed: g(0xf057, "#ef4444"), dotGreen: g(0xf111, "#22c55e"), dotYellow: g(0xf111, "#eab308"),
  dotRed: g(0xf111, "#ef4444"), pending: g(0xf252, "#FFB000"), system: g(0xf013, "#9aa5ce"), secret: g(0xf023, "#f7768e"),
  // The docs chip (MicroIntegrity): a document page drawn in its mark's colour (principal directive, 2026-10-24): orange with a pen while
  // docs are being written, green with a check when they are in line, red with a cross when a mismatch is left unaddressed.
  doc: g(0xf15c, "#7dcfff"), pen: g(0xf040, "#f97316"), check: g(0xf00c, "#22c55e"), cross: g(0xf00d, "#ef4444"),
  // The doctrine mark (ISA 20261025-doctrine-mark): a judge's gavel, drawn with the docs marks above (principal directive, 2026-10-25; was a balance scale, which did not read as doctrine).
  doctrine: g(0xf0e3, "#bb9af7"),
} as const satisfies Record<string, Glyph>;

export type GlyphName = keyof typeof GLYPHS;

/** A symbol in its colour with the space that gives it its second cell. The caller's own colour follows. */
export function icon(name: GlyphName): string {
  const { glyph, color } = GLYPHS[name];
  return `${color}${glyph}${RESET} `;
}

/** Emoji the line receives as data, by the symbol that replaces each. */
const EMOJI: Record<string, GlyphName> = {
  "☀": "sun", "🌙": "night", "🌤": "partly", "☁": "cloudy", "🌫": "fog", "🌧": "rain", "🌨": "snow", "⛈": "storm",
  "🌡": "thermo", "🌊": "tide", "🌌": "galaxy", "🌠": "meteor", "💨": "wind", "🧲": "magnet",
  "🌑": "moonNew", "🌒": "moonWaxCrescent", "🌓": "moonFirstQuarter", "🌔": "moonWaxGibbous", "🌕": "moonFull",
  "🌖": "moonWanGibbous", "🌗": "moonThirdQuarter", "🌘": "moonWanCrescent",
  "🌐": "globe", "💵": "money", "💳": "card", "♻": "pool", "📊": "api", "⚡": "bolt", "⛔": "locked",
  "🎯": "lead", "💡": "insight", "⚠": "caution", "🔧": "change", "✅": "verify", "❓": "open", "🤖": "agents",
  "🗣": "closer", "🎙": "spoken", "❌": "failed", "🟢": "dotGreen", "🟡": "dotYellow", "🔴": "dotRed", "⏳": "pending",
  "⚙": "system", "🔒": "secret",
};

// One token at a time: an SGR sequence, a flag (two regional indicators), or one character with an optional U+FE0F.
const TOKEN = /\x1b\[[0-9;]*m|[\u{1F1E6}-\u{1F1FF}]{2}|[\s\S]️?/gu;
const SGR = /^\x1b\[[0-9;]*m$/;
const isReset = (sgr: string): boolean => sgr === RESET || sgr === "\x1b[m";

/** The symbol for one token, or null to leave it alone. A text-presentation character counts only with U+FE0F. */
function glyphFor(token: string): GlyphName | null {
  // A country flag stays the real flag: it says which country the principal is in, which one marker glyph cannot.
  // Two regional indicators already take two cells, so width parity holds.
  if (/^[\u{1F1E6}-\u{1F1FF}]{2}$/u.test(token)) return null;
  const base = token.replace("️", "");
  const name = EMOJI[base];
  if (!name) return null;
  return token.endsWith("️") || /\p{Emoji_Presentation}/u.test(base) ? name : null;
}

/**
 * The same swap with no colour: glyph and space only, for text the engine draws itself (toasts, settled tool-row marks)
 * where an escape code would show as text. Width-neutral like glyphify. Pure.
 */
export function plainGlyphify(text: string): string {
  let out = "";
  for (const [token] of text.matchAll(TOKEN)) {
    const name = SGR.test(token) ? null : glyphFor(token);
    out += name ? `${GLYPHS[name].glyph} ` : token;
  }
  return out;
}

/**
 * Replace every mapped emoji in `text` with its coloured symbol and a space, then put back the colours that were
 * active at that point on the line (everything since its last reset), so a band's tint and the text's colour carry on.
 * Width-neutral by construction. Pure.
 */
export function glyphify(text: string): string {
  return text.split("\n").map((line) => {
    let active: string[] = [];
    let out = "";
    for (const [token] of line.matchAll(TOKEN)) {
      if (SGR.test(token)) {
        active = isReset(token) ? [] : [...active, token];
        out += token;
        continue;
      }
      const name = glyphFor(token);
      if (!name) { out += token; continue; }
      const { glyph, color } = GLYPHS[name];
      out += `${color}${glyph}${RESET}${active.join("")} `;
    }
    return out;
  }).join("\n");
}
