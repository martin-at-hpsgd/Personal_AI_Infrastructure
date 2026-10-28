/**
 * PagePresence.ts — the presence layer inside the HyperFrames page: the DA's essay badge and the voice badges
 * (a, b, c, d, d-dark, e) that carry the reader's portrait over the author's words (the author's own portrait, or the
 * DA's on a DA-read run), each signal driven by the narration spectrum precomputed at build time. Every word a badge
 * prints about the run (whose words, the header, the struck claim) comes from Config.json `badge` (Theme BadgeCopy).
 *
 * Compose.ts runs the seam's `audioBands()` once and ships its `spectrum` lane (32 bins per frame), so the bars move
 * with the voice and nothing decodes audio at render time.
 *
 * Geometry is fixed and shared with the verifier: the essay bars sit where Verify.ts PRESENCE_REGION crops, and
 * every badge draws its signal inside Theme VOICE_LAYOUT.badge.signals[variant], the rect Verify crops.
 */
import { css, enterStyle, h, img, setAttrs, svg, type Part, type Style, readableOn } from "./PageVisuals.ts";
import { DEFAULT_BADGE_COPY, DEFAULT_POSSESSIVE, FACES, family, isSelfRead, VOICE_CREDIT, VOICE_LAYOUT, type BadgeCopy, type BadgeVariant, type FaceId, type Ink, type Rect } from "./Theme.ts";

export const PRESENCE = { size: 200, ring: 2, right: 40, bottom: 40, bars: 9, barWidth: 6, barGap: 5, barMin: 6, barRise: 40, barBaseline: 20, scrimHeight: 96, gain: 9, labelPx: 22, tie: 28 } as const;

/** Per-frame spectrum rows (the seam's `audioBands().spectrum.values`), indexed by the composition frame. */
export type Spectrum = readonly (readonly number[])[];

/** Spectrum bins a signal strip spreads from its centre (bin 0) to its ends. */
const STRIP_TOP_BIN = 14;

/**
 * Per-bar level for a voice signal strip, mirrored about its centre: the centre reads bin 0 and the ends read
 * STRIP_TOP_BIN, interpolated between neighbouring bins so the strip is a smooth contour, never a staircase. Speech
 * energy falls roughly as 1/(bin+1), so each bin is lifted by (bin+1)^1.1 and the whole strip moves on a word.
 */
export function stripLevels(spectrum: readonly number[] | undefined, bars: number, gain: number): number[] {
  if (!spectrum || bars <= 0) return Array(Math.max(0, bars)).fill(0);
  const lifted = (b: number) => (spectrum[b] ?? 0) * Math.pow(b + 1, 1.1);
  return Array.from({ length: bars }, (_, i) => {
    const u = bars === 1 ? 0 : Math.abs(i - (bars - 1) / 2) / ((bars - 1) / 2);
    const pos = u * STRIP_TOP_BIN;
    const lo = Math.floor(pos);
    const hi = Math.min(STRIP_TOP_BIN, lo + 1);
    const v = lifted(lo) + (lifted(hi) - lifted(lo)) * (pos - lo);
    return Math.min(1, v * gain);
  });
}

/** Essay bars: nine bars across the first ~14 bins with a mirrored ramp so the centre is tallest, gain 9. */
export function essayLevels(spectrum: readonly number[] | undefined): number[] {
  const { bars } = PRESENCE;
  if (!spectrum) return Array(bars).fill(0);
  return Array.from({ length: bars }, (_, i) => Math.min(1, (spectrum[1 + Math.round((Math.abs(i - (bars - 1) / 2) / ((bars - 1) / 2)) * 12)] ?? 0) * PRESENCE.gain));
}

/** The line every badge carries: whose words these are (BadgeCopy `wordsLine` with the label in place of {LABEL}). */
export const actualWordsLine = (label: string, copy: BadgeCopy = DEFAULT_BADGE_COPY): string => copy.wordsLine.split("{LABEL}").join(label.trim().toUpperCase());

/** Dark D's recorded-run claim, in the clone credit's place: the voice is the author's own, recorded. */
export const RECORDED_VOICE_LINE = "REAL VOICE · RECORDED";

/** Who voiced the run, as the badge states it: the author's clone, their own recording, or the DA reading their words (named). */
export type BadgeVoice = { narrator: "clone" } | { narrator: "recorded" } | { narrator: "da"; reader: string; possessive: string; self?: boolean };

/**
 * The badge voice a staged run carries: its narrator (run.json), with the DA's name on a DA-read run. A run from
 * before the narrator field (undefined) reads as recorded, which shows no credit, as it always did. A DA-read run
 * with no reader name is a staging bug and throws. `author` is the badge label: when it names the reader, the DA is
 * reading a post it wrote itself, and the read-by line says that instead of calling it someone else's AI.
 */
export function badgeVoiceFor(narrator: "recorded" | "clone" | "da" | undefined, reader?: string, author?: string, possessive: string = DEFAULT_POSSESSIVE): BadgeVoice {
  if (narrator === "clone") return { narrator: "clone" };
  if (narrator !== "da") return { narrator: "recorded" };
  if (!reader?.trim()) throw new Error("a DA-read run needs the reader's name (props.reader) for its read-by line");
  return isSelfRead(author, reader) ? { narrator: "da", reader, possessive, self: true } : { narrator: "da", reader, possessive };
}

/**
 * The longest read-by line every design's credit band holds: dark D's bold 16 px mono with its accent dot is the
 * widest style, about 12 px a character plus 22 px for the dot, inside a 328 px band.
 */
export const READ_BY_MAX_CHARS = 24;

/**
 * A DA-read run's credit line: the DA named as the reader and called an AI, so the badge says plainly that an AI
 * voice reads the author's own words (the struck claim above it is about the words). A reader name too long for
 * the band drops the possessive tail ("· THEIR AI") rather than overflow. A self-read run (the DA reads a post it wrote)
 * says the reader wrote it too, since the tail would point at an author who is not there; a name too long for that line
 * falls back to "READ BY THE AUTHOR" (the headline above already names the author). `possessive` is the author's
 * (Config.json `possessive`, default "their").
 */
export function readByLine(reader: string, self = false, possessive: string = DEFAULT_POSSESSIVE): string {
  const name = reader.trim().toUpperCase();
  const full = self ? `WRITTEN AND READ BY ${name}` : `READ BY ${name} · ${possessive.trim().toUpperCase()} AI`;
  if (full.length <= READ_BY_MAX_CHARS) return full;
  return self ? "READ BY THE AUTHOR" : `READ BY ${name}`;
}

/** What a design's credit band shows: a line (the clone credit, a recorded run's claim or the DA's read-by), or nothing. */
export type CreditContent = { kind: "line"; text: string } | { kind: "none" };

/**
 * A clone run ALWAYS carries the vendor-neutral "AI VOICE CLONE" label. A DA-read run ALWAYS carries its read-by
 * line and NEVER a clone credit, whatever the design. A recorded run NEVER carries the clone credit: it shows the
 * design's own line when it has one.
 */
export function creditContent(_variant: BadgeVariant, voice: BadgeVoice, recordedLine?: string): CreditContent {
  switch (voice.narrator) {
    case "clone": return { kind: "line", text: VOICE_CREDIT.label };
    case "da": return { kind: "line", text: readByLine(voice.reader, voice.self, voice.possessive) };
    case "recorded": return recordedLine ? { kind: "line", text: recordedLine } : { kind: "none" };
  }
}

const SIGNAL_GAIN = 4;
const INK = "#1D1A22";
const STRIKE_RED = "#D8262E";
/** The strike rule on the struck claim: the badge's own mark, outside the inserts' one-accent rule (Style.md § Badge). */
const STRIKE_RULE = "#E5484D";
/** No drop shadows anywhere, the badge included (Style.md § Badge): designs keep their edge as a hairline only. */
const SHADOW = "none";
/** Every design sets its type in the embedded faces: the bold condensed caps face for grotesk and condensed lines, the bold serif for the serif. */
const typeFace = (id: FaceId): Style => ({ fontFamily: family(id), fontWeight: FACES[id].weight, fontStyle: FACES[id].style, fontSynthesis: "none" });
const GROTESK = family("kickerBold");
const CONDENSED = family("kickerBold");
const SERIF = family("serifBold");

/** A badge design: static markup plus the signal it redraws each frame from the strip levels. */
interface Badge { nodes: HTMLElement[]; draw(levels: (bars: number) => number[]): void }
/** `dark` is the palette's dark ink (Config.json colors.darkInk over Theme DEFAULT_PALETTE): the portrait's backing and D-dark's secondary lines read from it. */
interface BadgeArgs { name: string; accent: string; voice: BadgeVoice; copy: BadgeCopy; dark: Ink }

const signalBox = (variant: BadgeVariant): Style => {
  const s: Rect = VOICE_LAYOUT.badge.signals[variant];
  return { position: "absolute", left: s.x, top: s.y, width: s.w, height: s.h };
};

/** The design's credit band. `lineText` and `lineMark` style any line it shows (the recorded claim or the DA's read-by). */
function creditBand(variant: BadgeVariant, voice: BadgeVoice, text: Style, recordedLine?: string, lineText?: Style, lineMark?: HTMLElement): HTMLElement {
  const b = VOICE_LAYOUT.badge.credits[variant];
  const line: Style = { whiteSpace: "nowrap", lineHeight: 1, ...text };
  const c = creditContent(variant, voice, recordedLine);
  const band = h("div", { position: "absolute", left: b.x, top: b.y, width: b.w, height: b.h, display: "flex", alignItems: "center", justifyContent: "center" });
  if (c.kind === "line") { if (lineMark) band.append(lineMark); band.append(h("span", { ...line, ...lineText }, c.text)); }
  return band;
}

const monoCredit = (color: string): Style => ({ ...typeFace("caps"), fontSize: 15, letterSpacing: 2, color, textTransform: "lowercase" });

/** The essay badge's bar scrim: the palette's dark ground (`#rrggbb`, validated by Theme resolvePalette) at 90% opacity. */
const scrim = (ground: string): string => {
  const n = parseInt(ground.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},0.9)`;
};

/** The portrait frame, backed by the palette's dark ground so a transparent or letterboxed portrait never shows the tile. */
const portrait = (ground: string, style: Style, position = "50% 38%") => h("div", { position: "absolute", overflow: "hidden", background: ground, ...style }, img("avatar.png", { width: "100%", height: "100%", objectFit: "cover", objectPosition: position, display: "block" }));

/** Bars centred on the strip's midline, growing up and down with the voice. */
function mirrorBars(count: number, w: number, hgt: number, barW: (i: number) => number, accent: string, min = 3): { el: SVGElement; draw(levels: number[]): void } {
  const step = w / count;
  const rects = Array.from({ length: count }, (_, i) => { const bw = barW(i); return svg("rect", { x: i * step + (step - bw) / 2, width: bw, rx: Math.min(bw / 2, 1.5), fill: accent }); });
  const el = svg("svg", { width: w, height: hgt, style: "position: absolute; left: 0px; top: 0px" }, ...rects);
  return { el, draw(levels) { rects.forEach((r, i) => { const bh = min + levels[i] * (hgt - min); setAttrs(r, { y: (hgt - bh) / 2, height: bh }); }); } };
}

/** A filled waveform envelope about the strip's midline: a hairline in silence, a body of sound mid-word. */
function envelope(count: number, w: number, hgt: number, accent: string, min = 1.5): { el: SVGElement; draw(levels: number[]): void } {
  const poly = svg("polygon", { fill: accent, "stroke-linejoin": "round" });
  const el = svg("svg", { width: w, height: hgt, style: "position: absolute; left: 0px; top: 0px; overflow: visible" }, poly);
  return {
    el,
    draw(levels) {
      const x = (i: number) => (i / (count - 1)) * w;
      const a = (i: number) => min + levels[i] * (hgt / 2 - min);
      const top = levels.map((_, i) => `${x(i).toFixed(1)},${(hgt / 2 - a(i)).toFixed(1)}`);
      const bottom = levels.map((_, i) => `${x(count - 1 - i).toFixed(1)},${(hgt / 2 + a(count - 1 - i)).toFixed(1)}`);
      setAttrs(poly, { points: [...top, ...bottom].join(" ") });
    },
  };
}

function noSign(size: number, stroke: number): SVGElement {
  const r = (size - stroke) / 2, c = size / 2, d = r * Math.SQRT1_2;
  return svg("svg", { width: size, height: size, style: "position: absolute; left: 0px; top: 0px" },
    svg("circle", { cx: c, cy: c, r, fill: "none", stroke: STRIKE_RED, "stroke-width": stroke, opacity: 0.92 }),
    svg("line", { x1: c - d, y1: c - d, x2: c + d, y2: c + d, stroke: STRIKE_RED, "stroke-width": stroke, opacity: 0.92 }));
}

/** A badge line's size: its design size when it fits `width` (design px) in the bold condensed face, smaller when it does not. */
const fitBold = (line: string, max: number, width: number, tracking = 0): number => fitSize(line, "kickerBold", max, width, tracking);

function wrapSvg(style: Style, child: SVGElement): HTMLElement { const d = h("div", style); d.append(child); return d; }

/** A — Press credential: a lanyard ID card whose barcode is the author's voice. */
function badgeA({ name, accent, voice, copy, dark }: BadgeArgs): Badge {
  const s = VOICE_LAYOUT.badge.signals.a;
  const [first, ...rest] = name.split(" ");
  const bars = mirrorBars(46, s.w, s.h, (i) => (i % 3 === 0 ? 4 : 2), accent, 4);
  // The struck claim inside the no-sign, its first word over the rest, both fitted inside the ring.
  const [claimFirst, ...claimRest] = copy.struck.split(" ");
  const claimLines = claimRest.length ? [claimFirst, claimRest.join(" ")] : [claimFirst];
  const claimPx = Math.min(...claimLines.map((l) => fitBold(l, 45, 112)));
  const slop = h("div", { position: "absolute", left: 200, top: 131, width: 136, height: 136 },
    h("div", { position: "absolute", inset: 0, fontFamily: CONDENSED, fontWeight: 700, fontSize: claimPx, lineHeight: 0.86, color: INK, textAlign: "center", paddingTop: 38 }, ...claimLines.flatMap((l, i) => (i ? [h("br"), l] : [l]))));
  slop.append(noSign(136, 10));
  return {
    nodes: [
      h("div", { position: "absolute", left: 150, top: 0, width: 60, height: 34, borderRadius: 8, background: "linear-gradient(#C9C6CF, #8C8894)", boxShadow: "0 2px 4px rgba(0,0,0,0.3)" }),
      h("div", { position: "absolute", left: 6, top: 22, width: 348, height: 378, borderRadius: 22, background: "#FBFAF7", boxShadow: SHADOW, overflow: "hidden" },
        h("div", { position: "absolute", left: 0, right: 0, top: 0, height: 98, background: accent, color: "#FFFFFF", fontFamily: CONDENSED, fontWeight: 700, textAlign: "center", paddingTop: 20, lineHeight: 1 },
          h("div", { position: "absolute", left: 149, top: 8, width: 50, height: 9, borderRadius: 5, background: "rgba(255,255,255,0.35)" }),
          h("div", { fontSize: 38, letterSpacing: 2 }, first),
          h("div", { fontSize: 38, letterSpacing: 2, marginTop: 2 }, rest.join(" ")))),
      portrait(dark.ground, { left: 26, top: 130, width: 156, height: 138, borderRadius: 10, boxShadow: "inset 0 0 0 1px rgba(0,0,0,0.2)" }),
      slop,
      wrapSvg(signalBox("a"), bars.el),
      creditBand("a", voice, monoCredit("#6E6878"), "VOICEPRINT · UNEDITED"),
    ],
    draw: (levels) => bars.draw(levels(46)),
  };
}

/** B — On-air source bug: dark glass, the author's picture as the live feed, a stereo LED meter bouncing with their voice. */
function badgeB({ name, accent, voice, copy, dark }: BadgeArgs): Badge {
  const s = VOICE_LAYOUT.badge.signals.b;
  const segments = 15;
  const segH = (s.h - (segments - 1) * 3) / segments;
  const cells = [0, 1].map((c) => Array.from({ length: segments }, (_, k) => h("div", { position: "absolute", left: c * 20, bottom: k * (segH + 3), width: 16, height: segH, borderRadius: 2 })));
  const x = svg("svg", { width: 58, height: 58, style: "position: absolute; left: 0px; top: 0px" },
    svg("line", { x1: 17, y1: 17, x2: 41, y2: 41, stroke: "#FFFFFF", "stroke-width": 7, "stroke-linecap": "round" }),
    svg("line", { x1: 41, y1: 17, x2: 17, y2: 41, stroke: "#FFFFFF", "stroke-width": 7, "stroke-linecap": "round" }));
  return {
    nodes: [
      h("div", { position: "absolute", left: 0, top: 20, width: 360, height: 380, borderRadius: 16, background: "rgba(14,12,20,0.94)", boxShadow: `${SHADOW}, inset 0 0 0 1.5px rgba(255,255,255,0.08)`, overflow: "hidden" },
        h("div", { position: "absolute", left: 14, top: 12, right: 14, display: "flex", alignItems: "center", gap: 9, fontFamily: CONDENSED, fontWeight: 700, fontSize: 31, letterSpacing: 1, color: "#FFFFFF", lineHeight: 1 },
          h("span", { width: 13, height: 13, borderRadius: 7, background: STRIKE_RED, flexShrink: 0 }),
          h("span", { paddingTop: 4 }, name)),
        portrait(dark.ground, { left: 12, top: 50, width: 290, height: s.h, borderRadius: 8 }, "50% 34%"),
        h("div", { position: "absolute", left: s.x, top: s.y - 20, width: s.w, height: s.h }, ...cells.flat()),
        h("div", { position: "absolute", left: 0, right: 0, top: 284, bottom: 0, background: "#F4F1EA", display: "flex", alignItems: "center", gap: 14, padding: "0 16px" },
          wrapSvg({ position: "relative", width: 58, height: 58, borderRadius: 8, background: STRIKE_RED, flexShrink: 0 }, x),
          h("div", { position: "relative", fontFamily: CONDENSED, fontWeight: 700, fontSize: fitBold(copy.struck, 64, 246), lineHeight: 1, color: INK, paddingTop: 10, whiteSpace: "nowrap" }, copy.struck,
            h("div", { position: "absolute", left: -5, right: -5, top: 31, height: 7, borderRadius: 4, background: STRIKE_RED })))),
      creditBand("b", voice, monoCredit("rgba(255,255,255,0.72)")),
    ],
    draw(levels) {
      const spread = levels(10);
      const channel = (from: number, to: number) => Math.min(1, (spread.slice(from, to).reduce((a, b) => a + b, 0) / (to - from)) * 1.25);
      [channel(3, 7), channel(0, 10)].forEach((m, c) => {
        const lit = 1 + Math.round(m * (segments - 1));
        cells[c].forEach((cell, k) => css(cell, { background: k < lit ? accent : "rgba(255,255,255,0.07)" }));
      });
    },
  };
}

/** The scalloped outline of a perforated stamp, as one SVG path (holes of radius r every `pitch` px). */
function stampPath(w: number, hh: number, r: number, pitch: number): string {
  const edge = (len: number) => Math.max(1, Math.round(len / pitch));
  const nx = edge(w), ny = edge(hh);
  const sx = w / nx, sy = hh / ny;
  let d = `M 0 0`;
  for (let i = 0; i < nx; i++) d += ` L ${i * sx + sx / 2 - r} 0 A ${r} ${r} 0 0 0 ${i * sx + sx / 2 + r} 0`;
  d += ` L ${w} 0`;
  for (let i = 0; i < ny; i++) d += ` L ${w} ${i * sy + sy / 2 - r} A ${r} ${r} 0 0 0 ${w} ${i * sy + sy / 2 + r}`;
  d += ` L ${w} ${hh}`;
  for (let i = nx - 1; i >= 0; i--) d += ` L ${i * sx + sx / 2 + r} ${hh} A ${r} ${r} 0 0 0 ${i * sx + sx / 2 - r} ${hh}`;
  d += ` L 0 ${hh}`;
  for (let i = ny - 1; i >= 0; i--) d += ` L 0 ${i * sy + sy / 2 + r} A ${r} ${r} 0 0 0 0 ${i * sy + sy / 2 - r}`;
  return `${d} Z`;
}

/**
 * Badge C's denomination. "100% HUMAN" is a claim about the voice, so it prints only on a real human recording.
 * A voice-clone run reads "AI CLONE", matching its AI VOICE CLONE credit, and a DA-read run reads "AI VOICE".
 */
export function stampDenomination(voice: BadgeVoice): { amount: string; percent: boolean; unit: string } {
  if (voice.narrator === "recorded") return { amount: "100", percent: true, unit: "HUMAN" };
  return { amount: "AI", percent: false, unit: voice.narrator === "clone" ? "CLONE" : "VOICE" };
}

/** C — First-class stamp: engraved name line, a "100% HUMAN" denomination (real recording only; "AI CLONE" on a clone run), the author's voice as the postmark. */
function badgeC({ name, accent, voice, copy, dark }: BadgeArgs): Badge {
  const s = VOICE_LAYOUT.badge.signals.c;
  const denom = stampDenomination(voice);
  const [first, ...rest] = name.split(" ");
  const env = envelope(28, s.w, s.h, accent);
  const stamp = svg("svg", { width: 360, height: 400, style: "position: absolute; left: 0px; top: 0px; overflow: visible; filter: drop-shadow(0 18px 26px rgba(20,16,30,0.32)) drop-shadow(0 2px 4px rgba(20,16,30,0.2))" },
    svg("path", { d: stampPath(344, 384, 6, 18), transform: "translate(8 8)", fill: "#FBF7EC" }));
  return {
    nodes: [
      wrapSvg({ position: "absolute", left: 0, top: 0 }, stamp),
      h("div", { position: "absolute", left: 26, top: 26, width: 308, height: 348, border: `2px solid ${INK}`, borderRadius: 2 }),
      h("div", { position: "absolute", left: 26, top: 38, width: 308, textAlign: "center", fontFamily: SERIF, fontWeight: 700, color: INK, lineHeight: 1 },
        h("div", { fontSize: 29, letterSpacing: 1 }, first),
        h("div", { fontSize: 27, letterSpacing: 0, marginTop: 3 }, rest.join(" "))),
      portrait(dark.ground, { left: 46, top: 104, width: 160, height: 116, border: `2px solid ${INK}` }, "50% 38%"),
      h("div", { position: "absolute", left: 208, top: 108, width: 120, textAlign: "center", color: INK },
        h("div", { fontFamily: SERIF, fontWeight: 700, fontSize: 54, lineHeight: 1 }, denom.amount, ...(denom.percent ? [h("span", { fontSize: 26 }, "%")] : [])),
        h("div", { fontFamily: CONDENSED, fontWeight: 700, fontSize: 25, letterSpacing: 2, marginTop: 4 }, denom.unit),
        h("div", { ...typeFace("caps"), fontSize: 13, letterSpacing: 2, marginTop: 10, color: "#6E6878", textTransform: "lowercase" }, "FIRST CLASS")),
      wrapSvg(signalBox("c"), env.el),
      h("div", { position: "absolute", left: 70, top: 270, width: 220, height: 40, transform: "rotate(-4deg)", border: `4px solid ${STRIKE_RED}`, borderRadius: 6, boxShadow: `inset 0 0 0 3px #FBF7EC, inset 0 0 0 5px ${STRIKE_RED}`, display: "flex", alignItems: "center", justifyContent: "center", color: STRIKE_RED, fontFamily: CONDENSED, fontWeight: 700, fontSize: fitBold(copy.struck, 34, 196, 4 / 34), letterSpacing: 4, paddingTop: 5, opacity: 0.92, whiteSpace: "nowrap" },
        copy.struck, h("div", { position: "absolute", left: 10, right: 10, top: "50%", height: 5, marginTop: -3, background: STRIKE_RED })),
      creditBand("c", voice, { ...monoCredit("#6E6878"), fontSize: 12, letterSpacing: 1.5 }),
    ],
    draw: (levels) => env.draw(levels(28)),
  };
}


/** Badge type sizes are frame pixels at 1080p (Style.md § Badge); the design space is drawn at 1 / scale of that. */
const px = (framePx: number) => framePx / VOICE_LAYOUT.badge.scale;

/** The largest size up to `max` (design px) at which a line fits `width` in a face with em tracking, measured on the embedded face. */
function fitSize(line: string, id: FaceId, max: number, width: number, tracking: number): number {
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return max;
  ctx.font = `${FACES[id].style} ${FACES[id].weight} ${max}px ${family(id)}`;
  const w = ctx.measureText(line).width + tracking * max * line.length;
  return w <= width ? max : Math.floor((max * width) / w * 10) / 10;
}

/** D's two grounds: the paper tile, and the near-black tile that holds the same type in light ink. */
const STRIKE_TILE = {
  light: { tile: "#F4F1EA", hairline: "#CFCBBF", name: INK, rule: INK, andNot: "#5E5868", slop: "#6B6A63", credit: "#5E5868" },
  dark: { tile: "#121017", hairline: "#2A2733", name: "#F2F1EA", rule: "#F2F1EA", slop: "#B7B4C0" },
} as const;

/**
 * D — Strike tile: a header band (BadgeCopy `header`, what this video is), the headline beside the portrait, `andNot`,
 * then `struck` crossed out by a 4 px red rule, with the live trace of the voice on its own row beneath (the strike is
 * drawn as an obvious cross-out). `d-dark` is the near-black tile. Typography per Style.md § Badge, every line in an
 * embedded face; the header is set in the caps face, since an emoji would need a system font.
 */
function strikeTile({ name, accent, voice, copy, dark }: BadgeArgs, variant: "d" | "d-dark"): Badge {
  const s = VOICE_LAYOUT.badge.signals[variant];
  // D-dark's secondary lines (andNot, credit) take the palette's dark secondary ink.
  const p = variant === "d-dark" ? { ...STRIKE_TILE.dark, andNot: dark.secondary, credit: dark.secondary } : STRIKE_TILE.light;
  const tileTop = 10;
  const bars = mirrorBars(48, s.w, s.h, () => px(2), accent, 6);
  const recorded = variant === "d-dark" ? RECORDED_VOICE_LINE : "THE STRIKE IS THE REAL VOICE";
  const c = creditContent(variant, voice, recorded);
  const band = VOICE_LAYOUT.badge.credits[variant];
  // The credit is set at 22 px; a line too long for the band steps down until it fits (badge text is furniture, exempt from the insert floor).
  const creditPx = c.kind === "line" ? fitSize(c.text.toLowerCase(), "caps", px(22), band.w - 24, 0.08) : px(22);
  const credit = creditBand(variant, voice, { ...typeFace("caps"), fontSize: creditPx, letterSpacing: "0.08em", color: p.credit, textTransform: "lowercase" }, recorded);
  const slop = h("span", { ...typeFace("kickerBold"), fontSize: fitSize(copy.struck, "kickerBold", px(40), 328, 0), lineHeight: 1, color: p.slop, whiteSpace: "nowrap", textDecoration: "line-through", textDecorationColor: STRIKE_RULE, textDecorationThickness: px(4), textDecorationSkipInk: "none" }, copy.struck);
  return {
    nodes: [
      h("div", { position: "absolute", left: 0, top: tileTop, width: 360, height: 390, background: p.tile, borderRadius: 4, outline: `1px solid ${p.hairline}`, outlineOffset: -1 },
        // The header band names the format.
        h("div", { position: "absolute", left: 0, right: 0, top: 0, height: 30, background: readableOn(accent, "#FFFFFF"), borderRadius: "4px 4px 0 0", display: "flex", alignItems: "center", padding: "0 14px", ...typeFace("kickerBold"), fontSize: fitSize(copy.header, "kickerBold", 17, 332, 0.12), letterSpacing: "0.12em", color: "#FFFFFF", whiteSpace: "nowrap" }, copy.header),
        portrait(dark.ground, { left: 16, top: 42, width: 132, height: 132, borderRadius: 2 }),
        h("div", { position: "absolute", left: 162, top: 44, width: 188, ...typeFace("kickerBold"), fontSize: px(36), lineHeight: 0.95, letterSpacing: "0.04em", color: p.name }, ...name.split(" ").map((w) => h("div", {}, w))),
        h("div", { position: "absolute", left: 16, right: 16, top: 186, height: 2, background: p.rule }),
        // Both lines on a 1.0 line box: `andNot` ends at 222, `struck` runs 230–281, clear of the signal row at 286 (tile space).
        h("div", { position: "absolute", left: 16, top: 194, ...typeFace("kicker"), fontSize: fitSize(copy.andNot, "kicker", px(22), 328, 0.12), lineHeight: 1, letterSpacing: "0.12em", color: p.andNot, whiteSpace: "nowrap" }, copy.andNot),
        // The strike is the text's own line-through, so no element sits over the words (HyperFrames' layout audit
        // refuses text under an opaque box).
        h("div", { position: "absolute", left: 16, width: 328, top: 230, lineHeight: 1 }, slop)),
      wrapSvg(signalBox(variant), bars.el),
      credit,
    ],
    draw: (levels) => bars.draw(levels(48)),
  };
}

/** E — Content facts: a nutrition label whose "% daily voice" meter is the author's live spectrum. */
function badgeE({ name, accent, voice, copy, dark }: BadgeArgs): Badge {
  const s = VOICE_LAYOUT.badge.signals.e;
  const [first, ...rest] = name.split(" ");
  const rule = (top: number, hh: number) => h("div", { position: "absolute", left: 18, right: 18, top, height: hh, background: INK });
  const inset = { x: 4 + 3, y: 3 };
  const c = VOICE_LAYOUT.badge.credits.e;
  const bars = Array.from({ length: 40 }, () => h("div", { width: 5, background: accent, borderRadius: 1 }));
  return {
    nodes: [
      h("div", { position: "absolute", left: 4, top: 0, width: 352, height: 400, background: "#FFFFFF", border: `3px solid ${INK}`, boxSizing: "border-box", boxShadow: SHADOW, fontFamily: GROTESK, color: INK },
        h("div", { position: "absolute", left: 15, top: 7, fontWeight: 900, fontSize: 40, letterSpacing: -1.5, lineHeight: 1 }, "Content", h("br"), "Facts"),
        h("div", { position: "absolute", left: 15, top: 92, fontSize: 15 }, "1 essay, read aloud"),
        portrait(dark.ground, { left: 232, top: 10, width: 100, height: 98, border: `2px solid ${INK}` }),
        rule(116, 10),
        h("div", { position: "absolute", left: 15, top: 132, right: 15, display: "flex", justifyContent: "space-between", alignItems: "center" },
          h("div", { fontWeight: 900, fontSize: 27, lineHeight: 1.02, letterSpacing: -0.5, whiteSpace: "nowrap" }, first, h("br"), rest.join(" ")),
          h("div", { fontWeight: 900, fontSize: 36, letterSpacing: -1 }, "100%")),
        rule(194, 2),
        h("div", { position: "absolute", left: 15, top: 204, right: 15, display: "flex", justifyContent: "space-between", alignItems: "center" },
          h("div", { position: "relative", fontWeight: 900, fontSize: fitBold(copy.struck, 38, 220), lineHeight: 1, whiteSpace: "nowrap" }, copy.struck,
            h("div", { position: "absolute", left: -4, right: -4, top: "50%", height: 6, marginTop: -4, borderRadius: 3, background: STRIKE_RED })),
          h("div", { fontWeight: 900, fontSize: 36, letterSpacing: -1, color: STRIKE_RED }, "0%")),
        rule(254, 6),
        h("div", { position: "absolute", left: 15, top: 268, fontSize: 14, fontWeight: 700, letterSpacing: 0.5 }, "% DAILY VOICE"),
        h("div", { position: "absolute", left: s.x - inset.x, top: s.y - inset.y, width: s.w, height: s.h, display: "flex", alignItems: "flex-end", justifyContent: "space-between" }, ...bars),
        rule(c.y - inset.y - 6, 2)),
      creditBand("e", voice, { fontFamily: GROTESK, fontSize: 14, fontWeight: 700, letterSpacing: 0.5, color: INK }),
    ],
    draw(levels) { levels(40).forEach((l, i) => css(bars[i], { height: 3 + l * (s.h - 3) })); },
  };
}

const BADGES: Record<BadgeVariant, (a: BadgeArgs) => Badge> = { a: badgeA, b: badgeB, c: badgeC, d: (a) => strikeTile(a, "d"), e: badgeE, "d-dark": (a) => strikeTile(a, "d-dark") };


/**
 * `essay`: the DA badge (accent ring and glow, bars over the avatar) with the DA label beside it, in the dark ink
 * `dark`. `voice`: the reader's badge floating over the author's page, in the design `badge` names, printing `copy`.
 * Driven by the global frame.
 */
export function presence(a: { fps: number; spectrum: Spectrum; label: string; accent: string; dark: Ink; variant: "essay" | "voice"; badge: BadgeVariant; copy: BadgeCopy; voice: BadgeVoice }): Part {
  const at = (f: number) => a.spectrum[f];
  if (a.variant === "voice") {
    const { box, scale } = VOICE_LAYOUT.badge;
    const design = BADGES[a.badge]({ name: actualWordsLine(a.label, a.copy), accent: a.accent, voice: a.voice, copy: a.copy, dark: a.dark });
    // Designs draw in 360x400 design space; the inner sheet scales them into the (smaller) frame box.
    const sheet = h("div", { position: "absolute", left: 0, top: 0, width: 360, height: 400, transform: `scale(${scale})`, transformOrigin: "0 0" }, ...design.nodes);
    const el = h("div", { position: "absolute", left: box.x, top: box.y, width: box.w, height: box.h }, sheet);
    el.setAttribute("data-ve-badge", "");
    el.setAttribute("data-ve-furniture", "");
    return { el, update(f) { css(el, enterStyle(f / a.fps, 0)); const s = at(f); design.draw((bars) => stripLevels(s, bars, SIGNAL_GAIN)); } };
  }
  const { size, ring, right, bottom } = PRESENCE;
  const bars = Array.from({ length: PRESENCE.bars }, () => h("div", { width: PRESENCE.barWidth, borderRadius: PRESENCE.barWidth / 2, background: a.accent }));
  // The name in the caps face at the badge floor, joined to the ring by a hairline in the ring's accent: one object,
  // not a floating tag. A flat 2 px ring, no glow or shadow (Style.md § Badge).
  const el = h("div", { position: "absolute", right, bottom, display: "flex", flexDirection: "row", alignItems: "center" },
    h("div", { ...typeFace("caps"), fontSize: PRESENCE.labelPx, letterSpacing: "0.08em", color: a.dark.secondary, textTransform: "lowercase", marginRight: 12 }, a.label),
    h("div", { width: PRESENCE.tie, height: ring, background: a.accent }),
    h("div", { width: size, height: size, borderRadius: size / 2, padding: ring, background: a.accent },
      h("div", { position: "relative", width: "100%", height: "100%", borderRadius: "50%", overflow: "hidden", background: a.dark.codeGround },
        img("avatar.png", { width: "100%", height: "100%", objectFit: "cover", display: "block" }),
        h("div", { position: "absolute", left: 0, right: 0, bottom: 0, height: PRESENCE.scrimHeight, background: scrim(a.dark.ground) }),
        h("div", { position: "absolute", left: 0, right: 0, bottom: PRESENCE.barBaseline, display: "flex", justifyContent: "center", alignItems: "flex-end", gap: PRESENCE.barGap, height: PRESENCE.barMin + PRESENCE.barRise }, ...bars))));
  el.setAttribute("data-ve-badge", "");
  el.setAttribute("data-ve-furniture", "");
  return {
    el,
    update(f) {
      css(el, enterStyle(f / a.fps, 0));
      essayLevels(at(f)).forEach((l, i) => css(bars[i], { height: PRESENCE.barMin + l * PRESENCE.barRise, opacity: 0.55 + l * 0.45 }));
    },
  };
}
