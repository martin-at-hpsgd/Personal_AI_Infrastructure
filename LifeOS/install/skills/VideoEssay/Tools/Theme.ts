/**
 * Theme.ts — the video essay's design system as constants: the face roles, the default paper and dark palettes
 * (Config.json `colors` overrides them), the frame grid, the badge copy defaults (Config.json `badge` overrides them),
 * and the badge geometry Verify shares. References/Style.md describes this file and quotes its numbers literally.
 * Browser-safe: no node imports.
 */

// ---------- faces ----------

/**
 * Every face the composition sets, keyed by the id Config.json `fonts` maps to a font file. `family` is the internal
 * name the page registers the embedded file under (a role name, never the font's own name); `role` says what kind of
 * cut belongs there. Each id is its own embedded family, except that the three body-serif cuts share one family by
 * weight and style, so nothing is ever synthesized and a missing file can never quietly borrow a neighbour.
 */
export const FACES = {
  serif: { family: "Essay Serif", weight: 400, style: "normal", role: "body serif, regular" },
  serifBold: { family: "Essay Serif", weight: 700, style: "normal", role: "body serif, bold" },
  serifItalic: { family: "Essay Serif", weight: 400, style: "italic", role: "body serif, italic" },
  serifTabBold: { family: "Essay Serif Tab", weight: 700, style: "normal", role: "body serif with tabular lining figures, bold" },
  figures: { family: "Essay Figures", weight: 600, style: "normal", role: "display face for large figures, semibold" },
  sans: { family: "Essay Sans", weight: 400, style: "normal", role: "sans, regular" },
  sansBold: { family: "Essay Sans", weight: 700, style: "normal", role: "sans, bold" },
  caption: { family: "Essay Caption", weight: 400, style: "normal", role: "the site's caption face: captions, edge labels, sources, attributions" },
  sansTab: { family: "Essay Sans Tab", weight: 400, style: "normal", role: "sans with tabular figures" },
  caps: { family: "Essay Small Caps", weight: 400, style: "normal", role: "small-caps sans: lowercase source renders as small caps" },
  kicker: { family: "Essay Caps Tab", weight: 400, style: "normal", role: "condensed all-caps face with tabular figures" },
  kickerBold: { family: "Essay Caps", weight: 700, style: "normal", role: "condensed all-caps face, bold" },
  display: { family: "Essay Caps Narrow", weight: 400, style: "normal", role: "narrow all-caps display face for headings" },
  cite: { family: "Essay Caps Condensed", weight: 400, style: "normal", role: "condensed all-caps face for attributions" },
  quote: { family: "Essay Quote", weight: 400, style: "normal", role: "serif for quotations" },
  mono: { family: "Essay Mono", weight: 400, style: "normal", role: "monospace for code" },
} as const satisfies Record<string, { family: string; weight: number; style: "normal" | "italic"; role: string }>;
export type FaceId = keyof typeof FACES;
export const FACE_IDS = Object.keys(FACES) as FaceId[];
export const isFaceId = (v: string): v is FaceId => Object.prototype.hasOwnProperty.call(FACES, v);
/** A face as the page's font gate checks it: no file path, only what CSS resolves. */
export interface StagedFace { id: FaceId; family: string; weight: number; style: "normal" | "italic" }
export const stagedFaces = (): StagedFace[] => FACE_IDS.map((id) => ({ id, family: FACES[id].family, weight: FACES[id].weight, style: FACES[id].style }));

/** A CSS font-family value for a face: the embedded family alone, never a system fallback behind it. */
export const family = (id: FaceId): string => `"${FACES[id].family}"`;

/**
 * Type roles, px at 1080p. `tracking` is em, `features` the font-feature-settings value. `house` names the role in the
 * house type system every video shares (the user's HyperFrames `TypeRoles.json`: Advocate for display lines and
 * captions, Concourse for kickers and body, Triplicate for code and data, Valkyrie only for quotations; {{PRINCIPAL_NAME}},
 * 2026-10-16 and 2026-10-24), and Verify's `type` check refuses a render whose face or case leaves that role.
 * `transform` is applied to the source text: "title" is Title Case (houseTitleCase), and nothing is ever set in all
 * lowercase. Code keeps its literal case.
 */
export type HouseRole = "display" | "kicker" | "body" | "caption" | "code" | "serif";
export interface TypeRole { face: FaceId; house: HouseRole; size: number; leading: number; tracking: number; features?: string; transform?: "uppercase" | "title" }
export const TYPE = {
  title: { face: "display", house: "display", size: 132, leading: 1.02, tracking: 0, transform: "title" },
  subtitle: { face: "sans", house: "body", size: 54, leading: 1.25, tracking: 0, transform: "title" },
  heading: { face: "display", house: "display", size: 80, leading: 1.05, tracking: 0, transform: "title" },
  sentence: { face: "sans", house: "body", size: 60, leading: 1.2, tracking: 0, transform: "title" },
  sentenceBold: { face: "sansBold", house: "body", size: 60, leading: 1.2, tracking: 0, transform: "title" },
  claim: { face: "sans", house: "body", size: 68, leading: 1.2, tracking: 0, transform: "title" },
  compareText: { face: "sans", house: "body", size: 68, leading: 1.2, tracking: 0, transform: "title" },
  hero: { face: "display", house: "display", size: 340, leading: 0.9, tracking: -0.01, features: '"lnum" 1, "tnum" 1', transform: "title" },
  figure: { face: "display", house: "display", size: 150, leading: 0.9, tracking: 0, features: '"lnum" 1, "tnum" 1', transform: "title" },
  tick: { face: "mono", house: "code", size: 40, leading: 1, tracking: 0, transform: "uppercase" },
  kicker: { face: "caps", house: "kicker", size: 40, leading: 1.1, tracking: 0.12, transform: "uppercase" },
  edge: { face: "caption", house: "caption", size: 46, leading: 1.05, tracking: 0.04, transform: "uppercase" },
  quote: { face: "quote", house: "serif", size: 67, leading: 1.3, tracking: 0, features: '"onum" 1' },
  quoteSmall: { face: "quote", house: "serif", size: 56, leading: 1.3, tracking: 0, features: '"onum" 1' },
  quoteGlyph: { face: "quote", house: "serif", size: 119, leading: 1, tracking: 0 },
  cite: { face: "caption", house: "caption", size: 46, leading: 1.1, tracking: 0.04, transform: "uppercase" },
  source: { face: "caption", house: "caption", size: 44, leading: 1.05, tracking: 0.04, transform: "uppercase" },
  code: { face: "mono", house: "code", size: 44, leading: 1.45, tracking: 0 },
  numeral: { face: "display", house: "display", size: 158, leading: 1, tracking: 0, features: '"lnum" 1', transform: "title" },
} as const satisfies Record<string, TypeRole>;

const SMALL_WORDS = new Set(["a", "an", "and", "as", "at", "but", "by", "for", "if", "in", "nor", "of", "off", "on", "or", "per", "so", "the", "to", "up", "via", "vs", "yet"]);
/**
 * Title Case for the house "title" roles: every word capitalized except short function words that are neither first,
 * last nor after a colon or dash; a word that already carries a capital past its first letter (LifeOS, AI, GitHub) or a
 * digit keeps its spelling.
 */
export function houseTitleCase(s: string): string {
  const words = s.split(/(\s+)/);
  const real = words.map((w, i) => (/\S/.test(w) ? i : -1)).filter((i) => i >= 0);
  const first = real[0], last = real[real.length - 1];
  let afterBreak = false;
  return words.map((w, i) => {
    if (!/\S/.test(w)) return w;
    const lead = w.match(/^[^A-Za-z0-9]*/)![0];
    const core = w.slice(lead.length);
    const bare = core.replace(/[^A-Za-z'’]+$/, "").toLowerCase();
    const forceCap = i === first || i === last || afterBreak;
    afterBreak = /[:—–]$/.test(w) || w === "—" || w === "–";
    if (/[A-Z]/.test(core.slice(1)) || /\d/.test(core)) return w;
    if (!forceCap && SMALL_WORDS.has(bare)) return lead + core.toLowerCase();
    return lead + core.charAt(0).toUpperCase() + core.slice(1).toLowerCase();
  }).join("");
}
export type TypeName = keyof typeof TYPE;

// ---------- palette ----------

/**
 * The ink tokens (Style.md § Colour). Voice mode sets them on the capture's own paper (sampled at build); essay mode on
 * flat dark ground. Dimmed elements go to solid `secondary`, never to alpha. A frame carries at most one `accent`.
 */
export interface Ink { ground: string; ink: string; secondary: string; muted: string; rule: string; connector: string; accent: string; codeGround: string }
export type PaperInk = Omit<Ink, "ground" | "codeGround">;
/**
 * Every colour a render takes from config (Config.json `colors`, each key optional): `accent` is the brand colour (the
 * badge signals, the essay ring, the progress line, the thumbnail border, and what Verify's presence check measures);
 * `highlight` is the reading highlight, multiplied onto the paper, and the tint of highlighted code lines; `paper` is
 * the ground voice mode falls back to when a run has no post capture to sample; `paperInk` and `darkInk` are the ink
 * tokens on paper (voice) and on the dark ground (essay).
 */
export interface Palette { accent: string; highlight: string; paper: string; paperInk: PaperInk; darkInk: Ink }
/** The palette when Config.json sets no `colors`: neutral greys with a teal accent and a yellow marker. */
export const DEFAULT_PALETTE: Palette = {
  accent: "#0D9488",
  highlight: "#FACC15",
  paper: "#F3F1EA",
  paperInk: { ink: "#1C1B19", secondary: "#6B6A63", muted: "#7A776C", rule: "#B9B8AB", connector: "#2A2824", accent: "#0F766E" },
  darkInk: { ground: "#0C0C0D", ink: "#EDEDE8", secondary: "#9E9E98", muted: "#67675F", rule: "#3B3B38", connector: "#CFCFC9", accent: "#2DD4BF", codeGround: "#171717" },
};
const PAPER_INK_KEYS = ["ink", "secondary", "muted", "rule", "connector", "accent"] as const;
const DARK_INK_KEYS = ["ground", ...PAPER_INK_KEYS, "codeGround"] as const;
const HEX = /^#[0-9a-f]{6}$/i;

/**
 * Config.json `colors` merged over DEFAULT_PALETTE, every key optional. Each value must be `#rrggbb`; anything else
 * (a name, a short hex, an unknown key) is a config error, so a typo never renders in a fallback colour.
 */
export function resolvePalette(raw: unknown): Palette {
  if (raw === undefined || raw === null) return DEFAULT_PALETTE;
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error(`Config.json colors must be an object, got ${JSON.stringify(raw)}`);
  const problems: string[] = [];
  const pick = (from: Record<string, unknown>, keys: readonly string[], base: Record<string, string>, where: string): Record<string, string> => {
    const out = { ...base };
    for (const [k, v] of Object.entries(from)) {
      if (!keys.includes(k)) { problems.push(`${where}.${k} is not a colour key (keys: ${keys.join(", ")})`); continue; }
      if (typeof v !== "string" || !HEX.test(v.trim())) { problems.push(`${where}.${k} must be #rrggbb, got ${JSON.stringify(v)}`); continue; }
      out[k] = v.trim().toUpperCase();
    }
    return out;
  };
  const obj = (v: unknown, where: string): Record<string, unknown> => {
    if (v === undefined) return {};
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
    problems.push(`${where} must be an object`);
    return {};
  };
  const { paperInk, darkInk, ...top } = raw as Record<string, unknown>;
  const flat = pick(top, ["accent", "highlight", "paper"], { accent: DEFAULT_PALETTE.accent, highlight: DEFAULT_PALETTE.highlight, paper: DEFAULT_PALETTE.paper }, "colors");
  const palette: Palette = {
    accent: flat.accent, highlight: flat.highlight, paper: flat.paper,
    paperInk: pick(obj(paperInk, "colors.paperInk"), PAPER_INK_KEYS, { ...DEFAULT_PALETTE.paperInk }, "colors.paperInk") as unknown as PaperInk,
    darkInk: pick(obj(darkInk, "colors.darkInk"), DARK_INK_KEYS, { ...DEFAULT_PALETTE.darkInk }, "colors.darkInk") as unknown as Ink,
  };
  if (problems.length) throw new Error(`Config.json colors:\n- ${problems.join("\n- ")}`);
  return palette;
}

/** The reading highlight's shape: its colour is the palette's `highlight`, at this opacity, multiplied onto the paper. */
export const HIGHLIGHT = { opacity: 0.3, radius: 4, padX: 8, padY: 4 } as const;
/** The code block's ground on paper: this many L* darker than the paper it sits on. */
export const CODE_GROUND_DARKEN = 4;

// ---------- frame ----------

export interface Rect { x: number; y: number; w: number; h: number }
export const FRAME = { w: 1920, h: 1080 } as const;
/** Graphics-safe box (SMPTE ST 2046-1 / EBU R95). */
export const SAFE: Rect = { x: 96, y: 54, w: 1728, h: 972 };
/** Twelve 104 px columns with 40 px gutters. */
export const GRID = { x0: 116, x1: 1804, width: 1688, col: 104, gutter: 40, columns: 12 } as const;
/** Where a block's ink centroid lands (the optical centre, a little above the geometric one), and how far it may sit from it. */
export const OPTICAL = { x: 960, y: 508, tolX: 38, tolY: 32 } as const;
/**
 * Badge avoidance by collision: a block that meets the keep-out first rises (at most `maxLift`, never above
 * `minTop`), then re-lays with its right extent `pad` left of the keep-out (x 1559 in voice mode). Never a reserved column.
 */
export const COLLISION = { pad: 24, maxLift: 32, minTop: 96 } as const;

/** Fill targets on the settled ink box, as fractions of GRID.width and SAFE.h: an insert owns its frame, never floats small in it. */
export const FILL = {
  stat: { heroCap: 0.21, height: 0.45 },
  compareNumeric: { width: 0.9 },
  compareText: { width: 0.85 },
  diagram: { width: 0.8, height: 0.4 },
  points: { either: 0.55 },
  quote: { measureMin: 1100, measureMax: 1400 },
  title: { width: 0.55 },
  race: { width: 0.85 },
  code: { width: 0.6 },
  capture: { width: 0.75, height: 0.8 },
} as const;

/**
 * Voice mode: the post column on screen. Body lands at up to `bodyPx`; the column plus `margin` image px each side fits
 * the safe width. Paper edges over the page: `topFade` is solid to its first y and clear by its second, so a line
 * leaving the top recedes rather than being sliced; `footFade` fades in from its first y and is solid from its second
 * down, so no page ink runs behind the badge; the page's own end fades to paper over `endRamp` px below its last
 * narrated line.
 *
 * Text must read crisp and enough of the post must be on screen, so the page is captured at 3 image px per CSS px (Capture.ts POST_CAPTURE_SCALE)
 * and `maxScale` 1 means the camera only ever shrinks page pixels, never enlarges them (Verify `readscale` fails a
 * run above it). The column is at most 1200 px wide, centred, so its right edge (1560, 1568 with the highlight pad)
 * stays clear of the badge (x 1607) and the page can run down beside it to `footFade` 990–1060: about 14 lines on
 * screen, body text near 40 px. The spoken sentence rides the band 240–780, entering at 300.
 */
export const READ = { bodyPx: 40, column: 1200, margin: 64, band: [240, 780] as const, anchor: 300, topFade: [16, 110] as const, footFade: [990, 1060] as const, endRamp: 24, maxScale: 1 } as const;

/**
 * The badge designs voice mode can wear (Config.json presenter.badge); each is a Presence variant. "d-dark" is the
 * Strike tile (D) on a near-black tile: same geometry as D, so it shares D's signal and credit rects.
 */
export const BADGE_VARIANTS = ["a", "b", "c", "d", "e", "d-dark"] as const;
export type BadgeVariant = (typeof BADGE_VARIANTS)[number];
export const DEFAULT_BADGE: BadgeVariant = "a";

export function isBadgeVariant(v: unknown): v is BadgeVariant {
  return typeof v === "string" && (BADGE_VARIANTS as readonly string[]).includes(v);
}

/**
 * The ground each design's credit sits on. B's credit band sits on its dark glass; dark D's on its near-black tile.
 */
/**
 * The possessive the badge's read-by line uses for the author ("READ BY <READER> · <POSSESSIVE> AI"). Config.json
 * `possessive` sets it ("his", "her", "their"); unset means this neutral default. Lives here, with no node imports,
 * because the page (PagePresence) and the tools (Setup) both use it.
 */
export const DEFAULT_POSSESSIVE = "their";

/** A configured possessive, lowercased: one short word, or the default when unset. Anything else is a config error. */
export function normalizePossessive(raw: unknown): string {
  if (raw === undefined || raw === null) return DEFAULT_POSSESSIVE;
  if (typeof raw !== "string" || !/^[A-Za-z]{2,6}$/.test(raw.trim())) {
    throw new Error(`Config.json possessive must be one short word such as "his", "her" or "their", got ${JSON.stringify(raw)}`);
  }
  return raw.trim().toLowerCase();
}

/**
 * The words a voice badge prints, from Config.json `badge` (each key optional). `wordsLine` is whose words these are,
 * with `{LABEL}` replaced by the badge label; `header` is the strike tile's header band; `andNot` and `struck` are the
 * claim every design makes, the `struck` text drawn crossed out ("<NAME>'S OWN WORDS · AND NOT · ~~A SUMMARY~~").
 * Lives here, with no node imports, because the page (PagePresence) and the tools (Setup) both use it.
 */
export interface BadgeCopy { header: string; andNot: string; struck: string; wordsLine: string }
export const DEFAULT_BADGE_COPY: BadgeCopy = { header: "VIDEO ESSAY", andNot: "AND NOT", struck: "A SUMMARY", wordsLine: "{LABEL}'S OWN WORDS" };
/** The longest badge copy line that still fits the narrowest design at its smallest fitted size. */
export const BADGE_COPY_MAX_CHARS = 24;

/** Config.json `badge` merged over DEFAULT_BADGE_COPY, uppercased. An empty, over-long or unknown entry is a config error. */
export function resolveBadgeCopy(raw: unknown): BadgeCopy {
  if (raw === undefined || raw === null) return DEFAULT_BADGE_COPY;
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error(`Config.json badge must be an object, got ${JSON.stringify(raw)}`);
  const out: BadgeCopy = { ...DEFAULT_BADGE_COPY };
  const problems: string[] = [];
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!(k in DEFAULT_BADGE_COPY)) { problems.push(`badge.${k} is not a badge line (lines: ${Object.keys(DEFAULT_BADGE_COPY).join(", ")})`); continue; }
    const text = typeof v === "string" ? v.trim().replace(/\s+/g, " ") : "";
    if (!text || text.length > BADGE_COPY_MAX_CHARS) { problems.push(`badge.${k} must be 1 to ${BADGE_COPY_MAX_CHARS} characters, got ${JSON.stringify(v)}`); continue; }
    if (k === "wordsLine" && !text.includes("{LABEL}")) { problems.push(`badge.wordsLine must contain {LABEL}, got ${JSON.stringify(v)}`); continue; }
    out[k as keyof BadgeCopy] = k === "wordsLine" ? text.replace(/\{LABEL\}/g, "\u0000").toUpperCase().replace(/\u0000/g, "{LABEL}") : text.toUpperCase();
  }
  if (problems.length) throw new Error(`Config.json badge:\n- ${problems.join("\n- ")}`);
  return out;
}

/**
 * The author reads their own words: the DA reads a post the DA wrote (badge label and reader name the same). Lives here,
 * with no node imports, because the page (PagePresence) and the tools (Describe) both decide on it.
 */
export const isSelfRead = (label: string | undefined, reader: string | undefined): boolean =>
  !!label?.trim() && !!reader?.trim() && label.trim().toUpperCase() === reader.trim().toUpperCase();

export const BADGE_GROUND: Record<BadgeVariant, "light" | "dark"> = { a: "light", b: "dark", c: "light", d: "light", e: "light", "d-dark": "dark" };

/**
 * Voice-mode frame geometry (1920x1080). The post page fills the frame with no browser chrome. The presenter's badge floats over it in `box`, bottom-right; every variant
 * draws inside that box. Each variant's audio signal lives in `signals[variant]` (badge-local pixels, clear of
 * the portrait and of any text colour the measure would count), painted in `color`: PagePresence.ts places the
 * signal from these numbers and Verify.ts crops exactly this rect, so the render and the check cannot drift.
 * `credits[variant]` is the band (badge-local, clear of the signal) that carries the voice-clone credit on clone
 * runs (VOICE_CREDIT), the DA's read-by line on DA-read runs, and the design's own footer line on recorded runs.
 * `clearance` is the air kept between the highlighted sentence and the badge's top edge.
 */
export const VOICE_LAYOUT = {
  badge: {
    /**
     * Every design is drawn in a 360x400 design space and scaled by `scale` into `box`, anchored at the frame's
     * bottom-right (right edge 1888, bottom 1048). `signals` and `credits` are design-space pixels; frame pixels are
     * box + rect × scale (badgeSignalRect). 0.78: small enough that the card does not dominate the page.
     */
    scale: 0.78,
    box: { x: 1888 - Math.round(360 * 0.78), y: 1048 - Math.round(400 * 0.78), w: Math.round(360 * 0.78), h: Math.round(400 * 0.78) } as Rect,
    clearance: 28,
    signals: {
      a: { x: 30, y: 280, w: 300, h: 40 },
      b: { x: 312, y: 70, w: 36, h: 164 },
      c: { x: 46, y: 226, w: 268, h: 34 },
      d: { x: 30, y: 296, w: 300, h: 30 },
      e: { x: 22, y: 294, w: 312, h: 38 },
      "d-dark": { x: 30, y: 296, w: 300, h: 30 },
    } as Record<BadgeVariant, Rect>,
    credits: {
      a: { x: 30, y: 326, w: 300, h: 48 },
      b: { x: 12, y: 244, w: 336, h: 48 },
      c: { x: 30, y: 322, w: 300, h: 48 },
      d: { x: 16, y: 334, w: 328, h: 48 },
      e: { x: 18, y: 342, w: 316, h: 48 },
      "d-dark": { x: 16, y: 334, w: 328, h: 48 },
    } as Record<BadgeVariant, Rect>,
  },
} as const;

/**
 * The voice-clone credit a clone run's badge carries: a plain, vendor-neutral label. Narration is synthesized
 * on Fish Audio (Narrate.ts), so crediting any vendor's name or logo here would misattribute the voice; the
 * badge discloses that the voice is an AI clone and names no company. `logoH` is the credit band's unit: a
 * band is 3 × logoH tall.
 */
export const VOICE_CREDIT = {
  label: "AI VOICE CLONE",
  logoH: 16,
} as const;

/** A variant's signal rect in frame pixels. */
export function badgeSignalRect(variant: BadgeVariant): Rect {
  const { box, signals, scale } = VOICE_LAYOUT.badge;
  const s = signals[variant];
  return { x: Math.round(box.x + s.x * scale), y: Math.round(box.y + s.y * scale), w: Math.round(s.w * scale), h: Math.round(s.h * scale) };
}


/** The badge keep-out K: the badge box grown by COLLISION.pad, to the frame's edge. No insert ink meets it. */
export const KEEP_OUT: Rect = (() => {
  const b = VOICE_LAYOUT.badge.box;
  const x = b.x - COLLISION.pad, y = b.y - COLLISION.pad;
  return { x, y, w: FRAME.w - x, h: FRAME.h - y };
})();
