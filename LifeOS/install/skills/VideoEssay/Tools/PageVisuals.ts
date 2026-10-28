/**
 * PageVisuals.ts — the essay composition's DOM kit and every beat visual, running inside the HyperFrames page.
 *
 * Each insert is another page of the author's own publication (Style.md § Inserts): set in the configured faces in their
 * roles, on the same paper as the post (voice) or on flat dark ground (essay), with no chrome, boxes or decoration.
 * An insert is built once as real DOM, laid out on its rendered strings, centred on the optical centre and kept off the
 * badge by collision (`placeBlock`), then `update(t)` sets only what moves at beat-local second t. Every piece that
 * builds does so on the word that names it (Motion.ts cues), never earlier than 4 frames before it.
 *
 * Bundled into the project by Compose.ts (Bun.build, browser target). No clock, no network, no async: every frame
 * depends only on its number.
 */
import type { CaptureMeta, RaceLane, RaceVisual, ReadPost, Region, Visual, Word } from "./CompositionTypes.ts";
import { DIAGRAM, layoutDiagram, type DiagramText, type Measure, type PlacedNode } from "./DiagramLayout.ts";
import { cueOf, drawSeconds, frameBox, framingAt, holdSeconds, tourZoom, type Box, type Framing, lastMentionOf, mix, MOTION, multiDigitFigures, progress, readScrollPlan, span, SWAP, wordCount, type SpokenWord } from "./Motion.ts";
import { highlightBoxes, highlightLines, postColumn, readCamera, readFrameAt, type ReadCamera } from "./ReadCamera.ts";
import { CODE_GROUND_DARKEN, COLLISION, FACES, family, FILL, FRAME, GRID, HIGHLIGHT, KEEP_OUT, OPTICAL, READ, SAFE, TYPE, houseTitleCase, type Ink, type Rect, type TypeName } from "./Theme.ts";

// ---------- DOM kit ----------

export type Style = Record<string, string | number | undefined>;
/** Unitless properties: every other number gets px. */
const UNITLESS = new Set(["opacity", "fontWeight", "lineHeight", "flex", "flexGrow", "flexShrink", "zIndex", "order"]);
type Child = Node | string | null | undefined | false;

export function css(el: HTMLElement | SVGElement, s: Style): void {
  const st = el.style as unknown as Record<string, string>;
  for (const [k, v] of Object.entries(s)) st[k] = v === undefined ? "" : typeof v === "number" && !UNITLESS.has(k) ? `${v}px` : String(v);
}

export function h(tag: string, style: Style = {}, ...children: Child[]): HTMLElement {
  const el = document.createElement(tag);
  css(el, style);
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

export function img(src: string, style: Style): HTMLImageElement {
  const el = h("img", style) as HTMLImageElement;
  el.src = src;
  el.decoding = "sync";
  return el;
}

const SVG_NS = "http://www.w3.org/2000/svg";
export function svg(tag: string, attrs: Record<string, string | number | undefined> = {}, ...children: Child[]): SVGElement {
  const el = document.createElementNS(SVG_NS, tag);
  setAttrs(el, attrs);
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}
export function setAttrs(el: Element, attrs: Record<string, string | number | undefined>): void {
  for (const [k, v] of Object.entries(attrs)) if (v === undefined) el.removeAttribute(k); else el.setAttribute(k, String(v));
}

/** A built piece of the picture: its root element, and how it moves at a time local to where it starts. */
export interface Part { el: HTMLElement; update(t: number): void }

/** A full-frame layer. */
export const FILL_FRAME: Style = { position: "absolute", left: 0, top: 0, width: FRAME.w, height: FRAME.h };

/** The case a role sets its source text in (the caps roles expect caps faces; Theme TYPE `transform`). */
export const cased = (role: TypeName, s: string): string => {
  const t = (TYPE[role] as { transform?: string }).transform;
  return t === "uppercase" ? s.toUpperCase() : t === "title" ? houseTitleCase(s) : s;
};

/** The CSS of a type role. */
export function typeStyle(role: TypeName, color: string, extra: Style = {}): Style {
  const r = TYPE[role];
  const f = FACES[r.face];
  return {
    fontFamily: family(r.face), fontWeight: f.weight, fontStyle: f.style, fontSize: r.size, lineHeight: r.leading,
    letterSpacing: r.tracking ? `${r.tracking}em` : "normal", fontFeatureSettings: (r as { features?: string }).features ?? "normal",
    fontKerning: "normal", fontSynthesis: "none", color, ...extra,
  };
}
export const text = (role: TypeName, content: string, color: string, extra: Style = {}): HTMLElement => h("div", typeStyle(role, color, extra), cased(role, content));

// ---------- colour and motion helpers ----------

const rgb = (hex: string): [number, number, number] => { const m = hex.match(/^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i); if (!m) throw new Error(`colour must be #rrggbb, got ${hex}`); return [1, 2, 3].map((i) => parseInt(m[i], 16)) as [number, number, number]; };
/** A colour between a and b (#rrggbb), k in [0, 1]. */
export function mixColor(a: string, b: string, k: number): string {
  const [x, y] = [rgb(a), rgb(b)];
  return `#${x.map((v, i) => Math.round(v + (y[i] - v) * Math.min(1, Math.max(0, k))).toString(16).padStart(2, "0")).join("")}`;
}

/** Darken a paper colour by `dl` L* (CIELAB), keeping its hue: the code block's ground. */
export function darkenL(hex: string, dl: number): string {
  const lin = (c: number) => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const gam = (v: number) => Math.round(255 * Math.min(1, Math.max(0, v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055)));
  const [r, g, b] = rgb(hex).map(lin);
  const Y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const L = Y > 0.008856 ? 116 * Math.cbrt(Y) - 16 : 903.3 * Y;
  const L2 = Math.max(0, L - dl);
  const Y2 = L2 > 8 ? ((L2 + 16) / 116) ** 3 : L2 / 903.3;
  const k = Y > 0 ? Y2 / Y : 0;
  return `#${[r, g, b].map((v) => gam(v * k).toString(16).padStart(2, "0")).join("")}`;
}

/** WCAG 2 contrast ratio between two #rrggbb colours. */
export function contrastRatio(a: string, b: string): number {
  const lum = (hex: string) => { const [r, g, b2] = rgb(hex).map((c) => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b2; };
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

/**
 * `fg` moved along L* (keeping its hue) away from `ground` until it reads at `min`:1 or better, so a text colour set for
 * one paper still clears WCAG AA (and HyperFrames' pre-render contrast check) on a darker or lighter capture. A colour
 * already there comes back unchanged.
 */
export function readableOn(fg: string, ground: string, min = 4.6): string {
  const darker = contrastRatio(ground, "#000000") >= contrastRatio(ground, "#ffffff");
  let c = fg;
  for (let i = 0; i < 100 && contrastRatio(c, ground) < min; i++) c = darkenL(c, darker ? 1 : -1);
  if (contrastRatio(c, ground) < min) throw new Error(`no ${darker ? "darker" : "lighter"} shade of ${fg} reaches ${min}:1 on ${ground}`);
  return c;
}

/** An entrance at reveal time r: rise 24 px (or `rise`) and fade in on the enter curve. Hidden before it starts. */
export function enterStyle(t: number, r: number, dur: number = MOTION.enterBlock, rise: number = MOTION.rise): Style {
  const p = progress(t, r, dur, "enter");
  return { opacity: p, transform: rise ? `translateY(${((1 - p) * rise).toFixed(2)}px)` : undefined, visibility: p > 0 ? "visible" : "hidden" };
}
/** An exit starting at x: fall 12 px and fade out on the exit curve. */
export function exitStyle(t: number, x: number): Style {
  const p = progress(t, x, MOTION.exit, "exit");
  return { opacity: 1 - p, transform: `translateY(${(p * MOTION.fall).toFixed(2)}px)`, visibility: p < 1 ? "visible" : "hidden" };
}

// ---------- environment ----------

/** What every insert builder gets: the frame rate, the mode and its inks, the paper, and the beat's timing. */
export interface Env {
  fps: number;
  mode: "essay" | "voice";
  ink: Ink;
  /** The highlight colour (Config.json colors.highlight): highlighted code lines take it. */
  highlight: string;
  /** Beat-local second the insert may start building: nothing reveals before it. */
  start: number;
  /** The beat's length in seconds. */
  seconds: number;
  /** The beat's spoken words, beat-local. */
  words: readonly SpokenWord[];
  /** Advance widths in the embedded faces, for layouts fitted to the rendered strings. */
  measure: Measure;
}

/** A built insert: its root (data-ve-block holds the composition), when its last build settles, and its frame painter. */
export interface Insert extends Part { block: HTMLElement; /** Beat-local second of its first reveal. */ first: number; settle: number; layout(): void }

/** A reveal time for a piece: its cue, never before the insert may start, snapped up to a frame. */
/**
 * A build's start: its cue (or the fallback), never before the insert's start, on the frame grid. `tail` is how long the
 * build runs after it starts: a start so late that the build would still be moving when the beat cuts away moves up
 * just enough to settle first. Callers pass a tail only for builds the voice does not cue (the sync rule binds the rest).
 */
const at = (env: Env, cue: number | undefined, fallback: number, tail = 0): number => {
  const latest = Math.floor((env.seconds - SWAP - tail) * env.fps + 1e-6) / env.fps;
  const t = Math.ceil(Math.max(env.start, cue ?? fallback) * env.fps - 1e-6) / env.fps;
  return Math.max(env.start, Math.min(t, latest));
};

// ---------- ink measurement and placement ----------

/** The stage's placement on the page, so measurements are in 1920×1080 frame pixels whatever the host does. */
function stageFrame(): { x: number; y: number; k: number } {
  const stage = document.getElementById("stage");
  if (!stage) return { x: 0, y: 0, k: 1 };
  const r = stage.getBoundingClientRect();
  return { x: r.left, y: r.top, k: r.width > 0 ? FRAME.w / r.width : 1 };
}

/**
 * The ink of a block: every text line as its glyphs' own bounds (the line box tightened to the text's actual ascent
 * and descent, measured in its computed font, so an optical centre is the letters' centre, not the line boxes'), every
 * SVG shape, and every element marked `data-ink` (bars, rules, tracks). Frame pixels. Invisible pieces count: layout
 * is for the settled frame.
 */
export function inkRects(root: Element): Rect[] {
  const f = stageFrame();
  const out: Rect[] = [];
  const ctx = document.createElement("canvas").getContext("2d");
  const add = (r: { left: number; top: number; width: number; height: number }) => { if (r.width > 0 && r.height > 0) out.push({ x: (r.left - f.x) * f.k, y: (r.top - f.y) * f.k, w: r.width * f.k, h: r.height * f.k }); };
  const glyphs = (el: Element, text: string, box: DOMRect) => {
    if (!ctx) { add(box); return; }
    const st = getComputedStyle(el);
    ctx.font = `${st.fontStyle} ${st.fontWeight} ${st.fontSize} ${st.fontFamily}`;
    const m = ctx.measureText(st.textTransform === "uppercase" ? text.toUpperCase() : st.textTransform === "lowercase" ? text.toLowerCase() : text);
    const fontH = m.fontBoundingBoxAscent + m.fontBoundingBoxDescent;
    const k = fontH > 0 ? box.height / fontH : 1;
    const kx = m.width > 0 ? box.width / m.width : k;
    const base = box.top + m.fontBoundingBoxAscent * k;
    // A range's box for one line of a wrapped node spans only that line, so the horizontal ink stays the box when the
    // measured text is the whole node rather than the line.
    const whole = Math.abs(m.width * kx - box.width) < 1;
    const left = whole ? box.left - m.actualBoundingBoxLeft * kx : box.left;
    const right = whole ? box.left + m.actualBoundingBoxRight * kx : box.left + box.width;
    add({ left, top: base - m.actualBoundingBoxAscent * k, width: right - left, height: (m.actualBoundingBoxAscent + m.actualBoundingBoxDescent) * k });
  };
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const el = n.parentElement;
    if (!el || !n.textContent?.trim() || el.closest("svg")) continue;
    const range = document.createRange();
    range.selectNodeContents(n);
    for (const r of Array.from(range.getClientRects())) if (r.width > 0) glyphs(el, n.textContent, r);
  }
  root.querySelectorAll("svg text").forEach((el) => glyphs(el, el.textContent ?? "", el.getBoundingClientRect()));
  // An SVG shape's client box is its geometry: a horizontal line has no height until its stroke is counted.
  root.querySelectorAll("svg path, svg line, svg rect, svg circle").forEach((el) => {
    const r = el.getBoundingClientRect();
    // Not rendered (a hidden state's group): no box at all, so no ink, whatever its stroke says.
    if (r.width === 0 && r.height === 0) return;
    const w = parseFloat(getComputedStyle(el).strokeWidth) || 0;
    add({ left: r.left - w / 2, top: r.top - w / 2, width: r.width + w, height: r.height + w });
  });
  root.querySelectorAll("[data-ink]").forEach((el) => add(el.getBoundingClientRect()));
  return out;
}

export function union(rects: readonly Rect[]): Rect {
  if (rects.length === 0) return { x: OPTICAL.x, y: OPTICAL.y, w: 0, h: 0 };
  const x0 = Math.min(...rects.map((r) => r.x)), y0 = Math.min(...rects.map((r) => r.y));
  const x1 = Math.max(...rects.map((r) => r.x + r.w)), y1 = Math.max(...rects.map((r) => r.y + r.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
const meets = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * The badge keep-out K on this frame: the badge root's box (voice badge or essay presence) grown by 24 px, out to the
 * frame's edge. Read off the DOM, so it is right for whichever badge the run wears; Theme KEEP_OUT when there is none.
 */
export function keepOut(): Rect {
  const badge = document.querySelector("[data-ve-badge]");
  if (!badge) return KEEP_OUT;
  const f = stageFrame();
  const r = badge.getBoundingClientRect();
  if (!(r.width > 0)) return KEEP_OUT;
  const x = (r.left - f.x) * f.k - COLLISION.pad, y = (r.top - f.y) * f.k - COLLISION.pad;
  return { x, y, w: FRAME.w - x, h: FRAME.h - y };
}
/** Where a block narrowed off the badge may reach: the keep-out's left edge less the same 24 px (x 1559 in voice mode). */
export const narrowRight = (): number => keepOut().x - COLLISION.pad;

/**
 * Centre a block's ink on the optical centre and keep it off the badge: a block whose ink meets the
 * keep-out rises by at most 32 px (never above y 96); if it still meets it, `narrow(dy)` re-lays the block with its
 * right extent at x 1559 (given the vertical offset the block will sit at) and it is centred again. A block is never
 * pushed left to escape the badge. Returns the final offset and anything that still does not fit.
 */
export function placeBlock(block: HTMLElement, narrow?: (dy: number) => void): { dx: number; dy: number; problems: string[] } {
  const problems: string[] = [];
  css(block, { transform: "none" });
  const measure = (dx: number, dy: number) => inkRects(block).map((r) => ({ ...r, x: r.x + dx, y: r.y + dy }));
  const centre = () => { const u = union(inkRects(block)); return { dx: OPTICAL.x - (u.x + u.w / 2), dy: OPTICAL.y - (u.y + u.h / 2) }; };
  // Touching counts: a pixel on the keep-out's edge is a pixel in it.
  const ko = keepOut();
  const K = { x: ko.x - 1, y: ko.y - 1, w: ko.w + 1, h: ko.h + 1 };
  let { dx, dy } = centre();
  const lift = (dx0: number, dy0: number): number | undefined => {
    const rects = measure(dx0, dy0);
    const hit = rects.filter((r) => meets(r, K));
    if (hit.length === 0) return 0;
    const need = Math.max(...hit.map((r) => r.y + r.h - K.y)) + 1;
    const top = Math.min(...rects.map((r) => r.y));
    return need <= COLLISION.maxLift && top - need >= COLLISION.minTop ? need : undefined;
  };
  let up = lift(dx, dy);
  if (up === undefined && narrow) {
    narrow(dy - COLLISION.maxLift);
    ({ dx, dy } = centre());
    up = lift(dx, dy);
  }
  if (up === undefined) { problems.push("ink meets the badge keep-out after lifting and narrowing"); up = 0; }
  dy -= up;
  const u = union(measure(dx, dy));
  if (u.x < SAFE.x || u.y < SAFE.y || u.x + u.w > SAFE.x + SAFE.w || u.y + u.h > SAFE.y + SAFE.h) problems.push(`ink ${JSON.stringify(u)} leaves the graphics-safe box`);
  css(block, { transform: `translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px)` });
  if (problems.length) block.dataset.veLayoutProblems = problems.join("; ");
  for (const p of problems) console.warn(`[layout] ${block.dataset.veBlock ?? "block"}: ${p}`);
  return { dx, dy, problems };
}

/** The insert's root: a full-frame layer carrying the DOM contract (data-ve-beat, data-ve-type, data-ve-settle). */
function insertRoot(id: string, type: string, block: HTMLElement, ...extra: HTMLElement[]): HTMLElement {
  const el = h("div", { ...FILL_FRAME, pointerEvents: "none" }, block, ...extra);
  el.dataset.veBeat = id;
  el.dataset.veType = type;
  block.dataset.veBlock = id;
  return el;
}
const reveal = (el: Element, label: string): void => { el.setAttribute("data-ve-reveal", label); };
function finish(root: HTMLElement, block: HTMLElement, first: number, settle: number, layout: () => void, update: (t: number) => void): Insert {
  root.dataset.veSettle = settle.toFixed(3);
  return { el: root, block, first, settle, layout, update };
}

// ---------- cues per insert (what Page.ts plans the insert's window from) ----------

/** When the narration first and last names an insert's content, and how much it holds for after that (Motion.ts holdSeconds). */
export interface InsertCues { first?: number; lastReferent?: number; words: number; figures: number }

function cuesOver(labels: readonly string[], words: readonly SpokenWord[]): InsertCues {
  const firsts = labels.map((l) => cueOf(l, words)).filter((v): v is number => v !== undefined);
  const lasts = labels.map((l) => lastMentionOf(l, words)).filter((v): v is number => v !== undefined);
  const all = labels.join(" ");
  return { ...(firsts.length ? { first: Math.min(...firsts) } : {}), ...(lasts.length ? { lastReferent: Math.max(...lasts) } : {}), words: wordCount(all), figures: multiDigitFigures(all) };
}

export function insertCues(v: Visual, words: readonly SpokenWord[]): InsertCues {
  switch (v.type) {
    case "stat": { const c = cuesOver([v.value], words); const l = cuesOver([v.label], words); return { ...c, ...(c.first === undefined && l.first !== undefined ? { first: l.first } : {}), lastReferent: Math.max(c.lastReferent ?? -1, l.lastReferent ?? -1) >= 0 ? Math.max(c.lastReferent ?? -1, l.lastReferent ?? -1) : undefined, words: c.words + l.words, figures: c.figures + l.figures }; }
    case "compare": return cuesOver([v.left.label, v.left.text, v.right.label, v.right.text], words);
    case "diagram": return cuesOver(v.nodes.map((n) => n.label), words);
    case "points": return cuesOver([...(v.heading ? [v.heading] : []), ...v.points], words);
    case "quote": return cuesOver([v.text], words);
    case "title": return cuesOver([v.title, ...(v.subtitle ? [v.subtitle] : [])], words);
    case "race": return cuesOver(v.lanes.map((l) => l.label), words);
    case "code": return { words: 0, figures: 0 };
    default: return { words: 0, figures: 0 };
  }
}

/** The hold after an insert's last referent. */
export const insertHold = (c: InsertCues): number => holdSeconds(c.words, c.figures);

// ---------- stat ----------

/** "N of M" in a stat's figure and label ("12" + "of the 40 samples…", "(3 of 8)"); never an invented denominator. */
export function partOfWhole(value: string, label: string): { n: number; m: number; nText: string; mText: string } | undefined {
  const m = `${value} ${label}`.match(/(\d[\d,]*)\s+of\s+(?:the\s+)?(\d[\d,]*)/i);
  if (!m) return undefined;
  const n = Number(m[1].replace(/,/g, "")), total = Number(m[2].replace(/,/g, ""));
  return total > 0 && n >= 0 && n <= total ? { n, m: total, nText: m[1], mText: m[2] } : undefined;
}

/**
 * The scale (at most 1) that fits a screenshot credit, kicker caption plus source domain on one line, inside `width`:
 * both are measured in their own faces, case and tracking, and shrink together so the line keeps its proportions.
 */
export function creditScale(caption: string, domain: string, width: number): number {
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return 1;
  const wide = (role: "kicker" | "source", s: string, tracking: number) => {
    const r = TYPE[role], f = FACES[r.face];
    ctx.font = `${f.style} ${f.weight} ${r.size}px ${family(r.face)}`;
    const t = cased(role, s);
    return ctx.measureText(t).width + tracking * r.size * t.length;
  };
  const total = wide("kicker", caption, 0.06) + 14 + wide("source", domain, TYPE.source.tracking);
  return total > width ? width / total : 1;
}

/** The hero figure's size: 340 px, scaled down so it is no wider than 1200 px, never below a 180 px cap height. */
function heroSize(env: Env, value: string): number {
  const ctx = document.createElement("canvas").getContext("2d");
  const base = TYPE.hero.size;
  if (!ctx) return base;
  ctx.font = `${FACES[TYPE.hero.face].weight} ${base}px ${family(TYPE.hero.face)}`;
  const w = ctx.measureText(value).width;
  const minSize = 180 / 0.68;
  return w > 1200 ? Math.max(minSize, (base * 1200) / w) : base;
}

/** The largest a bare stat's figure grows to meet the fill floor (cap height 326 px, 30% of the frame). */
export const STAT_MAX_SIZE = 480;

function statInsert(env: Env, id: string, v: { value: string; label: string }): Insert {
  const I = env.ink;
  const size = heroSize(env, v.value);
  const figure = text("hero", v.value, I.ink, { fontSize: size, textAlign: "center", whiteSpace: "nowrap" });
  const claim = text("claim", v.label, I.ink, { textAlign: "center", maxWidth: 1200, margin: "40px auto 0", textWrap: "balance" });
  const part = partOfWhole(v.value, v.label);
  const figCue = at(env, cueOf(v.value, env.words), env.start);
  const claimAt = figCue + 0.2;
  let bar: { el: HTMLElement; fill: HTMLElement; track: HTMLElement; nTick: HTMLElement; mTick: HTMLElement; fillAt: number } | undefined;
  if (part) {
    const W = 1200;
    const track = h("div", { position: "absolute", left: 0, top: 0, width: W, height: 24, background: I.rule });
    const fill = h("div", { position: "absolute", left: 0, top: 0, width: (W * part.n) / part.m, height: 24, background: I.accent, transformOrigin: "left center" });
    track.setAttribute("data-ink", "");
    fill.setAttribute("data-ink", "");
    const nTick = text("tick", part.nText, I.secondary, { position: "absolute", top: 36, left: (W * part.n) / part.m, transform: "translateX(-50%)", whiteSpace: "nowrap" });
    const mTick = text("tick", part.mText, I.secondary, { position: "absolute", top: 36, right: 0, whiteSpace: "nowrap" });
    // The track and the whole arrive with the claim; the part (fill and its tick) is the piece that builds on its word.
    const partEl = h("div", { position: "absolute", left: 0, top: 0, width: W, height: 24 + 36 + 44 }, fill, nTick);
    reveal(partEl, part.nText);
    const el = h("div", { position: "relative", width: W, height: 24 + 36 + 44, margin: "56px auto 0" }, track, mTick, partEl);
    const nCue = cueOf(part.nText, env.words);
    const fillAt = Math.max(figCue + MOTION.heroMask, at(env, nCue, figCue + MOTION.heroMask));
    bar = { el, fill, track, nTick, mTick, fillAt };
  }
  const block = h("div", { position: "absolute", left: 0, top: 0, width: FRAME.w }, figure, claim, bar?.el);
  reveal(figure, v.value);
  reveal(claim, v.label);
  const settle = bar ? bar.fillAt + MOTION.bar + MOTION.enterLine : claimAt + MOTION.enterLine;
  return finish(insertRoot(id, "stat", block), block, figCue, settle, () => {
    // A stat with no part-to-whole bar owns the frame through its figure: one narrower than 55% of the grid grows (to
    // 480 px at most) until it is that wide, so the block clears the 55% fill floor.
    if (!bar) {
      const w = Math.max(union(inkRects(figure)).w, union(inkRects(claim)).w);
      const floor = 0.55 * GRID.width + 4;
      if (w < floor) css(figure, { fontSize: Math.min(STAT_MAX_SIZE, (size * floor) / Math.max(1, union(inkRects(figure)).w)) });
    }
    placeBlock(block);
  }, (t) => {
    const m = progress(t, figCue, MOTION.heroMask, "enter");
    css(figure, { clipPath: `inset(${((1 - m) * 100).toFixed(2)}% -20% -10% -20%)`, visibility: m > 0 ? "visible" : "hidden" });
    css(claim, enterStyle(t, claimAt, MOTION.enterLine));
    if (bar) {
      css(bar.track, enterStyle(t, claimAt, MOTION.enterLine, 0));
      css(bar.mTick, enterStyle(t, claimAt, MOTION.enterLine, 0));
      const f = progress(t, bar.fillAt, MOTION.bar, "draw");
      css(bar.fill, { transform: `scaleX(${f.toFixed(4)})` });
      css(bar.nTick, enterStyle(t, bar.fillAt + MOTION.bar, MOTION.enterLine, 0));
    }
  });
}

// ---------- compare ----------

/**
 * A figure in a compare: "61.4%", "$1,200", "47 times", "3×". The grammar is DesignAudit's `isNumericCompare` (the page
 * bundle cannot import that node-side tool, so Page.test.ts holds the two to the same answers): an optional sign and
 * currency mark, digits with thousands commas, an optional decimal, and an optional unit of % or up to 12 letters.
 */
export function parseFigure(s: string): { value: number; unit: string } | undefined {
  const m = FIGURE.exec(s);
  if (!m) return undefined;
  const sign = m[1] === "-" || m[1] === "−" ? -1 : 1;
  const value = sign * Number(`${m[2].replace(/,/g, "")}${m[3] ?? ""}`);
  return { value, unit: (m[4] ?? "").toLowerCase() };
}
const FIGURE = /^\s*([-+−]?)[$€£]?\s*(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?\s*(%|[a-z×]{1,12})?\s*$/i;

/** Both sides are figures in one unit: the compare is drawn to a shared scale, not set as two columns. */
export function isNumericPair(left: string, right: string): boolean {
  const a = parseFigure(left), b = parseFigure(right);
  return !!a && !!b && a.unit === b.unit;
}

/** The shared scale's end: 100 for shares, else the larger value rounded up to a clean tick. */
export function scaleMax(values: readonly number[], unit: string): number {
  if (unit === "%") return 100;
  const max = Math.max(...values);
  if (!(max > 0)) return 1;
  const step = 10 ** Math.floor(Math.log10(max));
  return Math.ceil(max / step) * step;
}

type Side = { label: string; text: string };

function numericCompare(env: Env, id: string, sides: [Side, Side], figs: [{ value: number; unit: string }, { value: number; unit: string }]): Insert {
  const I = env.ink;
  const max = scaleMax(figs.map((f) => f.value), figs[0].unit);
  const winner = figs[0].value === figs[1].value ? -1 : figs[0].value > figs[1].value ? 0 : 1;
  // Rows in the order the voice names their figures; an unnamed figure keeps its plan order.
  const cues = sides.map((s) => cueOf(s.text, env.words));
  const order = [0, 1].sort((a, b) => (cues[a] ?? Infinity) - (cues[b] ?? Infinity) || a - b);
  let right: number = GRID.x1;
  const rows = order.map((k) => {
    const s = sides[k];
    const label = text("sentence", s.label, I.ink, { position: "absolute", left: GRID.x0, textWrap: "balance" });
    const figure = text("figure", s.text, I.ink, { position: "absolute", whiteSpace: "nowrap" });
    const barEl = h("div", { position: "absolute", left: GRID.x0, height: 56, background: k === winner ? I.accent : I.muted, transformOrigin: "left center" });
    const track = h("div", { position: "absolute", height: 2, background: I.rule });
    barEl.setAttribute("data-ink", "");
    track.setAttribute("data-ink", "");
    const row = h("div", { position: "absolute", left: 0, top: 0, width: FRAME.w }, track, barEl, label, figure);
    reveal(row, s.label);
    const figCue = cues[k];
    const labelAt = at(env, cueOf(s.label, env.words), figCue !== undefined ? figCue - 0.6 : env.start);
    // A label named late in the beat keeps its word; the bar and the figure after it run faster (down to 35% of their
    // time) so the row settles before the cut, rather than start ahead of the voice.
    const pace = Math.min(1, Math.max(0.35, (env.seconds - SWAP - labelAt) / (0.2 + MOTION.bar + MOTION.heroMask)));
    const barDur = MOTION.bar * pace, maskDur = MOTION.heroMask * pace;
    const barAt = Math.max(labelAt, at(env, figCue !== undefined ? figCue - MOTION.lead : undefined, labelAt + 0.2 * pace, barDur + maskDur));
    return { k, row, label, figure, barEl, track, labelAt, barAt, barDur, maskDur, figAt: barAt + barDur };
  });
  const block = h("div", { position: "absolute", left: 0, top: 0, width: FRAME.w, height: FRAME.h }, ...rows.map((r) => r.row));
  const zero = h("div", { position: "absolute", left: GRID.x0 - 2, width: 2, background: I.ink });
  zero.setAttribute("data-ink", "");
  block.append(zero);
  const lay = () => {
    const scale = (right - GRID.x0) / max;
    const k = stageFrame().k;
    const lh = TYPE.sentence.size * TYPE.sentence.leading;
    // Both rows take one arrangement, the first that fits them all, so the two figures read as a pair: figure beside
    // its label, figure on the bar's line past its end, or figure on a line of its own over the bar's end. In every
    // arrangement a label sits 12 px over its own bar.
    const linesAt = (r: (typeof rows)[number], width: number) => { css(r.label, { width }); return Math.round((r.label.getBoundingClientRect().height * k) / lh); };
    const fit = rows.map((r) => {
      const end = GRID.x0 + scale * Math.max(0, figs[r.k].value);
      css(r.figure, { left: 0, top: 0 });
      const figW = r.figure.getBoundingClientRect().width * k;
      const budget = end - GRID.x0 - figW - 48;
      const beside = budget >= 300 && linesAt(r, budget) <= 2;
      const after = end - GRID.x0 >= 300 && end + 24 + figW <= right && linesAt(r, end - GRID.x0) <= 2;
      return { end, figW, budget, beside, after };
    });
    const mode = fit.every((x) => x.beside) ? "beside" : fit.every((x) => x.after) ? "after" : "over";
    let y = 0;
    for (const [n, r] of rows.entries()) {
      const f = figs[r.k];
      const { end, figW, budget } = fit[n];
      // Beside: the label keeps clear of the figure. After: the label ends at the bar's end, clear of the figure past it.
      css(r.label, { width: mode === "beside" ? budget : mode === "after" ? end - GRID.x0 : right - GRID.x0 });
      const labelH = (r.label.getBoundingClientRect().height * stageFrame().k);
      const figH = TYPE.figure.size * TYPE.figure.leading;
      let barTop: number;
      if (mode === "beside") {
        // The label's last line shares the figure's baseline: both bottoms sit on the line box's foot.
        const lineH = Math.max(labelH, figH);
        css(r.label, { top: y + lineH - labelH });
        css(r.figure, { left: end - figW, top: y + lineH - figH });
        barTop = y + lineH + 12;
      } else if (mode === "after") {
        // The figure sits on the bar's line, 24 px past its end, centred on the bar.
        css(r.label, { top: y });
        barTop = y + labelH + 12;
        css(r.figure, { left: end + 24, top: barTop + 28 - figH / 2 });
      } else {
        // The figure on its own line, ending at the bar's end; the label under it; the bar.
        css(r.figure, { left: Math.max(GRID.x0, end - figW), top: y });
        css(r.label, { top: y + figH + 12 });
        barTop = y + figH + 12 + labelH + 12;
      }
      css(r.barEl, { top: barTop, width: scale * Math.max(0, f.value) });
      // The scale's remainder runs on from the bar's end, or from past the figure when the figure sits on the bar's line.
      const from = mode === "after" ? end + 24 + figW + 24 : end;
      css(r.track, { left: from, top: barTop + 27, width: Math.max(0, right - from) });
      y = barTop + 56 + (mode === "after" ? (figH - 56) / 2 : 0) + 48;
    }
    const barTops = rows.map((r) => parseFloat(r.barEl.style.top));
    css(zero, { top: barTops[0] - 8, height: barTops[barTops.length - 1] + 56 + 8 - (barTops[0] - 8) });
  };
  const settle = Math.max(...rows.map((r) => r.figAt + r.maskDur));
  return finish(insertRoot(id, "compare", block), block, Math.min(...rows.map((r) => r.labelAt)), settle, () => {
    lay();
    placeBlock(block, (dy) => {
      // First only the scale's hairline tracks that would run under the badge stop at x 1559; if a bar or a figure itself
      // still would, the whole scale re-lays to end there.
      const ko = keepOut();
      const low = (el: HTMLElement) => parseFloat(el.style.top) + dy + el.getBoundingClientRect().height * stageFrame().k >= ko.y - 1;
      for (const r of rows) if (low(r.track)) css(r.track, { width: Math.max(0, narrowRight() - parseFloat(r.track.style.left)) });
      const reach = (el: HTMLElement) => parseFloat(el.style.left) + el.getBoundingClientRect().width * stageFrame().k;
      if (rows.some((r) => (low(r.barEl) && reach(r.barEl) > ko.x - 1) || (low(r.figure) && reach(r.figure) > ko.x - 1))) { right = narrowRight(); lay(); }
    });
  }, (t) => {
    css(zero, enterStyle(t, rows[0].labelAt, MOTION.enterLine, 0));
    for (const r of rows) {
      css(r.label, enterStyle(t, r.labelAt, MOTION.enterLine));
      css(r.track, enterStyle(t, r.labelAt, MOTION.enterLine, 0));
      const g = progress(t, r.barAt, r.barDur, "draw");
      css(r.barEl, { transform: `scaleX(${g.toFixed(4)})`, visibility: g > 0 ? "visible" : "hidden" });
      const m = progress(t, r.figAt, r.maskDur, "enter");
      css(r.figure, { clipPath: `inset(${((1 - m) * 100).toFixed(2)}% -10% -10% -10%)`, visibility: m > 0 ? "visible" : "hidden" });
      css(r.row, { visibility: t >= r.labelAt ? "visible" : "hidden" });
    }
  });
}

function textCompare(env: Env, id: string, sides: [Side, Side]): Insert {
  const I = env.ink;
  let colW = 784;
  const gutter = 120;
  const cols = sides.map((s) => {
    const kicker = text("kicker", s.label, I.secondary);
    const body = text("compareText", s.text, I.ink, { marginTop: 32, textWrap: "pretty" });
    // The two sides mirror about the rule: the left column sets flush left, the right one flush right.
    const col = h("div", { position: "absolute", top: 0, width: colW, textAlign: sides.indexOf(s) === 1 ? "right" : "left" }, kicker, body);
    reveal(col, s.label);
    const cue = [cueOf(s.label, env.words), cueOf(s.text, env.words)].filter((c): c is number => c !== undefined);
    return { col, cue: cues0(cue) };
  });
  const times = cols.map((c, k) => at(env, c.cue, env.start + k * 0.6));
  if (times[1] < times[0]) times[1] = times[0];
  const rule = h("div", { position: "absolute", top: 0, width: 2, background: I.rule });
  rule.setAttribute("data-ink", "");
  const block = h("div", { position: "absolute", left: 0, top: 0, width: FRAME.w }, cols[0].col, rule, cols[1].col);
  const lay = (left: number, right: number) => {
    colW = (right - left - gutter) / 2;
    css(cols[0].col, { left, width: colW });
    css(cols[1].col, { left: left + colW + gutter, width: colW });
    css(rule, { left: left + colW + gutter / 2 - 1, height: Math.max(...cols.map((c) => c.col.getBoundingClientRect().height * stageFrame().k)) });
  };
  const settle = times[1] + MOTION.enterBlock;
  return finish(insertRoot(id, "compare", block), block, times[0], settle, () => { lay(GRID.x0, GRID.x1); placeBlock(block, () => lay(FRAME.w - narrowRight(), narrowRight())); }, (t) => {
    cols.forEach((c, k) => css(c.col, enterStyle(t, times[k])));
    const p = progress(t, times[0], MOTION.bar, "draw");
    css(rule, { transform: `scaleY(${p.toFixed(4)})`, transformOrigin: "top", visibility: p > 0 ? "visible" : "hidden" });
  });
}
const cues0 = (c: number[]): number | undefined => (c.length ? Math.min(...c) : undefined);

function compareInsert(env: Env, id: string, v: { left: Side; right: Side }): Insert {
  if (!isNumericPair(v.left.text, v.right.text)) return textCompare(env, id, [v.left, v.right]);
  const a = parseFigure(v.left.text)!, b = parseFigure(v.right.text)!;
  // Bars grow from a zero baseline; a negative figure has no bar to draw, so the pair shows as figures alone at zero length.
  return numericCompare(env, id, [v.left, v.right], [a, b]);
}

// ---------- points ----------

const POINTS_PER_STATE = 5;

/** The most a sparse list scales its type to meet the fill floor. */
export const POINTS_MAX_SCALE = 1.4;

function pointsInsert(env: Env, id: string, v: { heading?: string; points: string[] }): Insert {
  const I = env.ink;
  let measureW = 1300;
  const head = v.heading ? text("heading", v.heading, I.ink, { marginBottom: 56 }) : null;
  if (head) reveal(head, v.heading!);
  let prev = env.start - MOTION.stagger;
  const items = v.points.map((p, i) => {
    const cue = cueOf(p, env.words, prev);
    const r = cue !== undefined ? at(env, cue, 0) : Math.max(env.start, prev + MOTION.stagger);
    prev = Math.max(prev, r);
    const num = text("tick", String(i + 1), I.secondary, { position: "absolute", left: -72, top: (TYPE.sentence.size * TYPE.sentence.leading - TYPE.tick.size) / 2 + 6 });
    const body = text("sentence", p, I.ink, { textWrap: "pretty" });
    const el = h("div", { position: "relative", marginTop: i % POINTS_PER_STATE === 0 ? 0 : 40 }, num, body);
    reveal(el, p);
    return { el, body, num, r, state: Math.floor(i / POINTS_PER_STATE) };
  });
  const states = Math.ceil(items.length / POINTS_PER_STATE);
  const stateStart = Array.from({ length: states }, (_, s) => items.find((it) => it.state === s)!.r);
  const list = h("div", { position: "relative" }, ...items.map((it) => it.el));
  const inner = h("div", { position: "absolute", left: 0, top: 0, width: measureW, paddingLeft: 72 }, head, list);
  const block = h("div", { position: "absolute", left: 0, top: 0, width: FRAME.w }, inner);
  const headAt = head ? Math.min(stateStart[0], at(env, cueOf(v.heading!, env.words), stateStart[0])) : 0;
  const settle = items[items.length - 1].r + MOTION.enterBlock;
  // Only the last state is on screen at settle, so layout (and centring) is measured on it.
  const showState = (s: number) => items.forEach((it) => css(it.el, { display: it.state === s ? "block" : "none" }));
  // A sparse list scales its type (to 1.4x at most) until it meets the 55% width-or-height floor.
  let k = 1;
  const scale = () => {
    const gap = 72 * k, lead = TYPE.sentence.size * TYPE.sentence.leading * k;
    css(inner, { width: measureW * k, paddingLeft: gap });
    if (head) css(head, { fontSize: TYPE.heading.size * k, marginBottom: 56 * k });
    items.forEach((it, i) => {
      css(it.body, { fontSize: TYPE.sentence.size * k });
      css(it.num, { fontSize: TYPE.tick.size * k, left: -gap, top: (lead - TYPE.tick.size * k) / 2 + 6 * k });
      css(it.el, { marginTop: i % POINTS_PER_STATE === 0 ? 0 : 40 * k });
    });
  };
  return finish(insertRoot(id, "points", block), block, head ? Math.min(headAt, items[0].r) : items[0].r, settle, () => {
    showState(states - 1);
    const u = union(inkRects(block));
    const floorW = FILL.points.either * GRID.width + 4, floorH = FILL.points.either * SAFE.h + 4;
    if (u.w > 0 && u.w < floorW && u.h < floorH) {
      k = Math.min(POINTS_MAX_SCALE, floorW / u.w, floorH / u.h);
      measureW = Math.min(measureW, (GRID.width - 72 * k) / k);
      scale();
    }
    placeBlock(block, () => { measureW = Math.min(measureW, 1100 / k); scale(); });
  }, (t) => {
    if (head) css(head, enterStyle(t, headAt, MOTION.enterLine));
    let s = 0;
    for (let k = 1; k < states; k++) if (t >= stateStart[k] - SWAP) s = k;
    items.forEach((it, i) => {
      if (it.state !== s) { css(it.el, { display: it.state < s && t < stateStart[s] ? "block" : "none", ...exitStyle(t, stateStart[s] - SWAP) }); return; }
      css(it.el, { display: "block", ...enterStyle(t, it.r) });
      const next = items[i + 1]?.state === s ? items[i + 1].r : Infinity;
      const dim = span(t, next, next + MOTION.dim);
      const color = mixColor(I.ink, I.secondary, dim);
      css(it.body, { color });
    });
  });
}

// ---------- quote and title ----------

function quoteInsert(env: Env, id: string, v: { text: string; attribution: string }): Insert {
  const I = env.ink;
  const glyph = text("quoteGlyph", "“", I.accent, { textAlign: "center", height: TYPE.quoteGlyph.size * 0.62, overflow: "visible" });
  const body = text("quote", v.text, I.ink, { textAlign: "center", width: 1300, margin: "24px auto 0", textWrap: "balance" });
  const cite = v.attribution ? text("cite", v.attribution, I.secondary, { textAlign: "center", marginTop: 40 }) : null;
  // The glyph's line box overflows its clipped height by design and reaches into the quote's first line box, with
  // no ink touching; HyperFrames check reads that as content_overlap and refuses the render. The attribute is not inherited, so both blocks carry it (as the chapter card's do).
  for (const t of [glyph, body]) t.setAttribute("data-layout-allow-overlap", "");
  const block = h("div", { position: "absolute", left: 0, top: 0, width: FRAME.w }, glyph, body, cite);
  reveal(body, v.text);
  const r = at(env, cueOf(v.text, env.words), env.start);
  return finish(insertRoot(id, "quote", block), block, r, r + 0.2 + MOTION.enterLine, () => {
    const lines = Math.round((body.getBoundingClientRect().height * stageFrame().k) / (TYPE.quote.size * TYPE.quote.leading));
    if (lines > 4) css(body, typeStyle("quoteSmall", I.ink, { textAlign: "center", width: 1300, margin: "24px auto 0", textWrap: "balance" }));
    placeBlock(block);
  }, (t) => {
    css(glyph, enterStyle(t, r));
    css(body, enterStyle(t, r));
    if (cite) css(cite, enterStyle(t, r + 0.2, MOTION.enterLine));
  });
}

/** The largest a short title insert grows to meet the fill floor. */
export const TITLE_MAX_SIZE = 168;

function titleInsert(env: Env, id: string, v: { title: string; subtitle?: string }): Insert {
  const I = env.ink;
  const title = text("title", v.title, I.ink, { textAlign: "center", maxWidth: 1400, margin: "0 auto", textWrap: "balance" });
  const sub = v.subtitle ? text("subtitle", v.subtitle, I.secondary, { textAlign: "center", maxWidth: 1400, margin: "32px auto 0", textWrap: "balance" }) : null;
  const block = h("div", { position: "absolute", left: 0, top: 0, width: FRAME.w }, title, sub);
  reveal(title, v.title);
  const r = at(env, cueOf(v.title, env.words), env.start);
  return finish(insertRoot(id, "title", block), block, r, r + 0.2 + MOTION.enterLine, () => {
    // A short title grows (to 168 px at most) until it spans 55% of the grid: a title card owns its frame.
    // Ink width is not quite linear in size (side bearings), so the size is corrected against a fresh measure.
    const floor = FILL.title.width * GRID.width + 8;
    let size: number = TYPE.title.size;
    for (let pass = 0; pass < 3; pass++) {
      const w = union(inkRects(title)).w;
      if (!(w > 0) || w >= floor || size >= TITLE_MAX_SIZE) break;
      size = Math.min(TITLE_MAX_SIZE, (size * floor) / w);
      css(title, { fontSize: size });
    }
    placeBlock(block);
  }, (t) => {
    css(title, enterStyle(t, r));
    if (sub) css(sub, enterStyle(t, r + 0.2, MOTION.enterLine));
  });
}

// ---------- diagram ----------

/** Canvas advance widths in the embedded faces, per diagram role (tracking added per character, as CSS applies it). */
export function canvasMeasure(): Measure {
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) throw new Error("canvas 2d context unavailable: diagrams are laid out on measured strings");
  const roles: Record<DiagramText, TypeName> = { node: "sentence", nodeBold: "sentenceBold", edge: "edge" };
  return (s, role) => {
    const r = TYPE[roles[role]];
    const f = FACES[r.face];
    ctx.font = `${f.style} ${f.weight} ${r.size}px ${family(r.face)}`;
    return ctx.measureText(s).width + r.tracking * r.size * [...s].length;
  };
}

function svgText(role: TypeName, content: string, x: number, y: number, fill: string, extra: Record<string, string | number> = {}): SVGElement {
  const r = TYPE[role];
  const f = FACES[r.face];
  return svg("text", { x, y, fill, "font-family": FACES[r.face].family, "font-weight": f.weight, "font-style": f.style, "font-size": r.size, "letter-spacing": r.tracking ? `${r.tracking}em` : undefined, style: `font-feature-settings: ${(r as { features?: string }).features ?? "normal"}; font-kerning: normal; font-synthesis: none`, ...extra }, cased(role, content));
}

interface DrawnNode { node: PlacedNode; g: SVGElement; texts: SVGElement[]; shelf: SVGElement; r: number }
interface DrawnEdge { path: SVGElement; head: SVGElement; label?: SVGElement; leader?: SVGElement; from: string; to: string; start: number; dur: number; length: number; carried: boolean }

/**
 * The diagram's camera (ISC-51): it opens close on the first node and pulls back as each node arrives, travelling the
 * whole gap between arrivals, so the build reads as one move that ends on the rest view. Every framing keeps the nodes
 * shown so far inside the graphics-safe box left of the badge. Camera transforms are in the svg's own px: the block sits
 * at (dx, dy), so a frame framing F' = s·F + t is s·L + (s·d + t − d) on the svg.
 */
function diagramCamera(states: readonly { nodes: DrawnNode[] }[], at: { dx: number; dy: number }, measure: Measure): { t: number; f: Framing }[] {
  const avail: Box = { x: SAFE.x, y: SAFE.y, w: narrowRight() - SAFE.x, h: SAFE.h };
  const nodeBox = (d: DrawnNode): Box => {
    const n = d.node, right = Math.max(n.x + n.shelf, ...d.texts.map((t) => n.x + measure(t.textContent ?? "", t.getAttribute("font-weight") === "700" ? "nodeBold" : "node")));
    const top = Math.min(n.top, n.kickerTop ?? n.top);
    return { x: n.x + at.dx - 24, y: top + at.dy - 24, w: right - n.x + 48, h: n.bottom + DIAGRAM.sinkShelf - top + 48 };
  };
  const keys: { t: number; f: Framing }[] = [];
  for (const st of states) {
    const fresh = st.nodes.filter((d) => !d.node.carried).sort((a, b) => a.r - b.r);
    const shown = st.nodes.filter((d) => d.node.carried);
    for (const d of fresh) {
      shown.push(d);
      const u = union(shown.map(nodeBox));
      const f = frameBox(u, avail, MOTION.diagramClose);
      const svgF = { s: f.s, tx: f.s * at.dx + f.tx - at.dx, ty: f.s * at.dy + f.ty - at.dy };
      if (keys.length && d.r - keys[keys.length - 1].t < 1 / 30) keys[keys.length - 1] = { t: keys[keys.length - 1].t, f: svgF };
      else keys.push({ t: d.r, f: svgF });
    }
  }
  if (keys.length) keys[keys.length - 1] = { t: keys[keys.length - 1].t, f: { s: 1, tx: 0, ty: 0 } };
  return keys;
}

function diagramInsert(env: Env, id: string, v: { nodes: { id: string; label: string }[]; edges: { from: string; to: string; label?: string }[] }): Insert {
  const I = env.ink;
  const root = svg("svg", { width: FRAME.w, height: FRAME.h, viewBox: `0 0 ${FRAME.w} ${FRAME.h}`, style: "position: absolute; left: 0px; top: 0px; overflow: visible" });
  const block = h("div", { position: "absolute", left: 0, top: 0, width: FRAME.w, height: FRAME.h });
  block.append(root);
  let states: { g: SVGElement; nodes: DrawnNode[]; edges: DrawnEdge[]; start: number; end: number }[] = [];
  let settle = env.start;
  let camera: { t: number; f: Framing }[] = [];
  const build = (left: number, right: number) => {
    root.replaceChildren();
    const g = layoutDiagram(v.nodes, v.edges, { left, right, centerY: OPTICAL.y, maxHeight: SAFE.h - 40, measure: env.measure });
    for (const s of g.states) if (!s.fits) console.warn(`[layout] ${id}: ${s.problems.join("; ")}`);
    const label = new Map(v.nodes.map((n) => [n.id, n.label]));
    // Cues: named nodes on their words; unnamed ones in topological order across the first 60% of the beat.
    const named = new Map<string, number>();
    for (const n of v.nodes) { const c = cueOf(n.label, env.words); if (c !== undefined) named.set(n.id, c); }
    const topo = g.states.flatMap((s) => s.nodes.filter((n) => !n.carried).sort((a, b) => a.layer - b.layer || a.top - b.top));
    const unnamed = topo.filter((n) => !named.has(n.id));
    const cue = new Map<string, number>(named);
    unnamed.forEach((n, k) => cue.set(n.id, env.start + (0.6 * (env.seconds - env.start) * k) / Math.max(1, unnamed.length)));
    let prevEnd = env.start;
    const prevPos = new Map<string, PlacedNode>();
    states = g.states.map((st, si) => {
      const fresh = st.nodes.filter((n) => !n.carried);
      const firstCue = Math.min(...fresh.map((n) => cue.get(n.id)!));
      // A new state takes the frame just before its first node is named, after the last one has landed.
      const start = si === 0 ? env.start : Math.max(prevEnd + 0.8, Math.ceil((firstCue - MOTION.flip - MOTION.lead) * env.fps) / env.fps);
      const group = svg("g", {});
      root.append(group);
      const nodes: DrawnNode[] = st.nodes.map((n) => {
        const ng = svg("g", {});
        const texts: SVGElement[] = [];
        n.kicker.forEach((k, j) => texts.push(svgText("edge", k, n.x, n.kickerTop + (j + 0.78) * TYPE.edge.size * TYPE.edge.leading, I.secondary)));
        n.lines.forEach((line, j) => texts.push(svgText(n.bold ? "sentenceBold" : "sentence", line, n.x, n.baselines[j], I.ink)));
        const sinkNow = n.sink && si === g.states.length - 1;
        const sw = sinkNow ? DIAGRAM.sinkShelf : DIAGRAM.shelf;
        // The shelf hangs from shelfY: a thicker sink shelf grows downward, away from the descenders.
        const shelf = svg("line", { x1: n.x, y1: n.shelfY + sw / 2, x2: n.x + n.shelf, y2: n.shelfY + sw / 2, stroke: sinkNow ? I.accent : I.ink, "stroke-width": sw });
        // Whitespace between the lines keeps the group's text readable as words (the reveal label is matched against it).
        ng.append(...texts.flatMap((t) => [t, " "]), shelf);
        group.append(ng);
        const r = n.carried ? start : Math.max(start + (si === 0 ? 0 : MOTION.flip), Math.ceil(Math.max(env.start, cue.get(n.id)!) * env.fps - 1e-6) / env.fps);
        if (!n.carried) reveal(ng, label.get(n.id)!);
        return { node: n, g: ng, texts, shelf, r };
      });
      const byId = new Map(nodes.map((d) => [d.node.id, d]));
      const edges: DrawnEdge[] = st.edges.map((e) => {
        const target = byId.get(e.to)!, source = byId.get(e.from)!;
        const carried = target.node.carried && source.node.carried;
        const dur = drawSeconds(e.length);
        const s0 = carried ? start + MOTION.flip : Math.max(source.r, target.r - MOTION.lead);
        const path = svg("path", { d: e.d, fill: "none", stroke: I.connector, "stroke-width": 2, "stroke-linecap": "round", "stroke-dasharray": e.length.toFixed(1) });
        const head = svg("path", { d: e.chevron, fill: "none", stroke: I.connector, "stroke-width": 2, "stroke-linejoin": "miter", "stroke-linecap": "butt" });
        let lab: SVGElement | undefined, leader: SVGElement | undefined;
        if (e.label) {
          // Only a label riding its connector needs the paper halo; one under a run or above the graph sits on bare paper.
          const halo: Record<string, string | number> = e.label.kind === "line" ? { stroke: env.ink.ground, "stroke-width": 16, "paint-order": "stroke", "stroke-linejoin": "round" } : {};
          lab = svgText("edge", e.label.text, e.label.x, e.label.y + TYPE.edge.size * 0.33, I.secondary, { "text-anchor": "middle", ...halo });
          const l = e.label.leader;
          if (l) leader = svg("line", { x1: l.x, y1: l.y0, x2: l.x, y2: l.y1, stroke: I.secondary, "stroke-width": 2, "stroke-linecap": "butt" });
        }
        group.insertBefore(svg("g", {}, path, head, leader, lab), group.firstChild);
        return { path, head, label: lab, leader, from: e.from, to: e.to, start: s0, dur, length: e.length, carried };
      });
      const end = Math.max(...nodes.map((d) => d.r + MOTION.enterBlock), ...edges.map((e) => e.start + e.dur));
      prevEnd = end;
      for (const d of nodes) prevPos.set(d.node.id, d.node);
      return { g: group, nodes, edges, start, end };
    });
    // FLIP: a carried node remembers where it stood in the state before.
    for (let si = 1; si < states.length; si++) for (const d of states[si].nodes) if (d.node.carried) {
      const was = g.states[si - 1].nodes.find((n) => n.id === d.node.id)!;
      (d as DrawnNode & { from?: { dx: number; dy: number } }).from = { dx: was.x - d.node.x, dy: was.top - d.node.top };
    }
    settle = states[states.length - 1].end;
  };
  build(GRID.x0, GRID.x1);
  const nodeTexts = (d: DrawnNode, color: string) => d.texts.forEach((t, j) => setAttrs(t, { fill: j < d.node.kicker.length ? env.ink.secondary : color }));
  const paint = (t: number) => {
    const f = framingAt(camera, t);
    css(root as unknown as HTMLElement, { transformOrigin: "0 0", transform: f.s === 1 && f.tx === 0 && f.ty === 0 ? "none" : `translate(${f.tx.toFixed(2)}px, ${f.ty.toFixed(2)}px) scale(${f.s.toFixed(4)})` });
    states.forEach((s, si) => {
      const next = states[si + 1];
      const gone = next !== undefined && t >= next.start;
      css(s.g, { display: gone || t < (si === 0 ? -Infinity : s.start) ? "none" : "inline" });
      if (gone) return;
      for (const d of s.nodes) {
        if (d.node.carried) {
          const k = progress(t, s.start, MOTION.flip, "camera");
          const from = (d as DrawnNode & { from?: { dx: number; dy: number } }).from ?? { dx: 0, dy: 0 };
          setAttrs(d.g, { transform: `translate(${(from.dx * (1 - k)).toFixed(1)},${(from.dy * (1 - k)).toFixed(1)})`, opacity: 1, visibility: "visible" });
          nodeTexts(d, env.ink.secondary);
          setAttrs(d.shelf, { stroke: env.ink.secondary, "stroke-width": DIAGRAM.shelf });
          continue;
        }
        const e = progress(t, d.r, MOTION.enterBlock, "enter");
        setAttrs(d.g, { transform: `translate(0,${((1 - e) * MOTION.rise).toFixed(2)})`, opacity: e.toFixed(4), visibility: e > 0 ? "visible" : "hidden" });
        // Dims once the next state carries it.
        nodeTexts(d, env.ink.ink);
      }
      // The outgoing state's ink leaves while the next one arrives.
      if (next) {
        const leaving = next.nodes.filter((d) => d.node.carried).map((d) => d.node.id);
        for (const d of s.nodes) if (!leaving.includes(d.node.id)) { const x = progress(t, next.start - MOTION.exit, MOTION.exit, "exit"); setAttrs(d.g, { opacity: ((1 - x) * Number(d.g.getAttribute("opacity") ?? 1)).toFixed(4) }); }
      }
      for (const e of s.edges) {
        if (e.carried) {
          const k = span(t, s.start + MOTION.flip, s.start + MOTION.flip + MOTION.dim);
          for (const el of [e.path, e.head]) setAttrs(el, { stroke: env.ink.secondary, opacity: k.toFixed(4), visibility: k > 0 ? "visible" : "hidden" });
          setAttrs(e.path, { "stroke-dashoffset": 0 });
          for (const el of [e.label, e.leader]) if (el) setAttrs(el, { opacity: k.toFixed(4) });
          continue;
        }
        const p = progress(t, e.start, e.dur, "draw");
        setAttrs(e.path, { "stroke-dashoffset": (e.length * (1 - p)).toFixed(1), visibility: p > 0 ? "visible" : "hidden" });
        setAttrs(e.head, { visibility: p >= 1 ? "visible" : "hidden" });
        const q = progress(t, e.start + e.dur * 0.5, MOTION.enterLine, "enter");
        for (const el of [e.label, e.leader]) if (el) setAttrs(el, { opacity: q.toFixed(4), visibility: q > 0 ? "visible" : "hidden" });
      }
    });
  };
  const rootEl = insertRoot(id, "diagram", block);
  const firstReveal = () => Math.min(...states.flatMap((s) => s.nodes.filter((d) => !d.node.carried).map((d) => d.r)));
  const ins = finish(rootEl, block, firstReveal(), settle, () => {
    camera = [];
    paint(Infinity);
    const at = placeBlock(block, (dy) => {
      // A shelf that runs under the badge stops at x 1559; if a label itself would, the graph re-lays narrower, centred.
      let text = false;
      const ko = keepOut();
      for (const s of states) for (const d of s.nodes) {
        const n = d.node;
        if (n.bottom + DIAGRAM.sinkShelf + dy < ko.y - 1) continue;
        const inkRight = Math.max(n.x, ...d.texts.map((t) => n.x + env.measure(t.textContent ?? "", t.getAttribute("font-weight") === "700" ? "nodeBold" : "node")));
        if (inkRight > ko.x - 1) { text = true; continue; }
        if (n.x + n.shelf > ko.x - 1) setAttrs(d.shelf, { x2: Math.max(inkRight, narrowRight()) });
      }
      if (text) { build(FRAME.w - narrowRight(), narrowRight()); paint(Infinity); }
    });
    camera = diagramCamera(states, at, env.measure);
    ins.settle = settle;
    ins.first = firstReveal();
    rootEl.dataset.veSettle = settle.toFixed(3);
  }, paint);
  return ins;
}

// ---------- race ----------

/** Race geometry, px at 1080p. */
export const RACE = { labelLeft: GRID.x0, labelRight: 516, trackLeft: 556, trackRight: 1560, pitch: 120, maxLanes: 5, dot: 16, gateW: 2, gateH: 32, gateSpan: 0.92 } as const;

/** Gate j of g sits at (j+1)/(g+1) of the gate span. */
export const gateFracs = (g: number): number[] => Array.from({ length: g }, (_, j) => ((j + 1) / (g + 1)) * RACE.gateSpan);

// \x27 is the apostrophe: a literal quote inside a regex trips the HyperFrames bundler's quote pairing (see Page.ts pageProbe).
const cueTokens = (s: string) => s.toLowerCase().replace(/[’‘]/g, "'").replace(/[^\p{L}\p{N}\x27]+/gu, " ").trim().split(" ").filter(Boolean);
const CUE_STOP = new Set(["or", "and", "the", "a", "an", "of", "to", "in", "for", "but", "even"]);

/**
 * Each result piece's cue from the beat's spoken words: the start of the piece's first content word where the
 * whole piece is next said, in order. A piece the narration never says gets undefined (the caller's fallback).
 */
export function raceCues(pieces: readonly string[], spoken: readonly { w: string; s: number }[]): (number | undefined)[] {
  const said = spoken.map((w) => ({ t: cueTokens(w.w).join(" "), s: w.s }));
  let cursor = 0;
  return pieces.map((piece) => {
    const want = cueTokens(piece);
    if (want.length === 0) return undefined;
    for (let i = cursor; i + want.length <= said.length; i++) {
      if (!want.every((tok, k) => said[i + k].t === tok)) continue;
      const lead = Math.max(0, want.findIndex((tok) => !CUE_STOP.has(tok)));
      cursor = i + want.length;
      return said[i + lead].s;
    }
    return undefined;
  });
}

/** Where a lane's dot stops, as a fraction of the track: the end, or (gated) just short of gate g−2, which never opens. */
export const laneStop = (lane: RaceLane): number => (lane.gates && lane.gates >= 2 ? gateFracs(lane.gates)[lane.gates - 2] - 0.02 : 1);

/** How long a dot takes to travel a distance: 2.4 px/ms, clamped to 350–900 ms. */
export const raceTravel = (px: number): number => Math.min(MOTION.raceMax, Math.max(MOTION.raceMin, px / MOTION.raceRate));

/**
 * One lane's result cue times. Explicit `resultAt` wins; otherwise each piece lands on its spoken word; a piece never
 * said lands when the dot stops, the later pieces 0.6 s apart.
 */
export function laneCues(lane: RaceLane, stopAt: number, spoken: readonly { w: string; s: number }[]): number[] {
  const pieces = typeof lane.result === "string" ? [lane.result] : lane.result;
  if (lane.resultAt !== undefined) return typeof lane.resultAt === "number" ? [lane.resultAt] : [...lane.resultAt];
  const heard = raceCues(pieces, spoken);
  return pieces.map((_, k) => heard[k] ?? stopAt + 0.6 * k);
}

function raceInsert(env: Env, id: string, v: RaceVisual): Insert {
  const I = env.ink;
  if (v.lanes.length > RACE.maxLanes) console.warn(`[layout] ${id}: ${v.lanes.length} lanes, only ${RACE.maxLanes} fit; the rest are not drawn`);
  const lanes = v.lanes.slice(0, RACE.maxLanes);
  const trackW = RACE.trackRight - RACE.trackLeft;
  const gated = lanes.filter((l) => l.gates !== undefined);
  // The lane the story singles out: the one gated lane, when there is exactly one.
  const single = gated.length === 1 ? lanes.indexOf(gated[0]) : -1;
  const top0 = 110;
  const from = text("kicker", v.from, I.secondary, { position: "absolute", left: RACE.trackLeft, top: 0, whiteSpace: "nowrap" });
  // The finish label ends at the track's end, anchored by `right`: its entrance sets `transform`, which would wipe a
  // translateX(-100%) and push the whole label past the finish and off the frame.
  const to = text("kicker", v.to, I.secondary, { position: "absolute", right: FRAME.w - RACE.trackRight, top: 0, textAlign: "right", whiteSpace: "nowrap" });
  let prev = env.start;
  const rows = lanes.map((lane, li) => {
    const y = top0 + li * RACE.pitch;
    const cue = cueOf(lane.label, env.words, prev);
    const named = cue !== undefined;
    const r = at(env, cue, prev + (li ? 0.6 : 0));
    prev = r;
    const stop = laneStop(lane);
    const travel = raceTravel(stop * trackW);
    // The trailing space collapses on screen and keeps the lane's text "label result", never "labelresult".
    const label = text("sentence", `${lane.label} `, I.ink, { position: "absolute", left: RACE.labelLeft, width: RACE.labelRight - RACE.labelLeft, top: y - TYPE.sentence.size * 0.62, textAlign: "right", whiteSpace: "nowrap" });
    const track = h("div", { position: "absolute", left: RACE.trackLeft, top: y - 1, width: trackW, height: 2, background: I.rule, transformOrigin: "left center" });
    track.setAttribute("data-ink", "");
    const gates = (lane.gates ? gateFracs(lane.gates) : []).map((f) => { const g = h("div", { position: "absolute", left: RACE.trackLeft + f * trackW - 1, top: y - RACE.gateH / 2, width: RACE.gateW, height: RACE.gateH, background: I.ink }); g.setAttribute("data-ink", ""); return g; });
    const accent = li === single;
    const dot = named ? h("div", { position: "absolute", left: RACE.trackLeft - RACE.dot / 2, top: y - RACE.dot / 2, width: RACE.dot, height: RACE.dot, borderRadius: "50%", background: accent ? I.accent : I.ink }) : null;
    dot?.setAttribute("data-ink", "");
    const pieces = typeof lane.result === "string" ? [lane.result] : lane.result;
    const stopX = RACE.trackLeft + stop * trackW;
    const numeric = pieces.every((p) => /^[\d\s.,%x×+-]+$/i.test(p));
    const color = !named ? I.muted : accent ? I.accent : I.ink;
    const resultEls = pieces.map((p) => h("span", { ...typeStyle(numeric ? "tick" : "sentence", color), marginRight: 18, whiteSpace: "nowrap", background: I.ground, padding: "0 6px" }, p));
    // The result sits just after the stop, past the closed gate on a gated lane so the gate that held the dot stays in
    // view; it carries the ground behind it, so the untravelled track never runs through its letters. One that would
    // run into the frame edge sits under the track, ending at the stop.
    const wall = lane.gates && lane.gates >= 2 ? RACE.trackLeft + gateFracs(lane.gates)[lane.gates - 2] * trackW + RACE.gateW : stopX;
    const resultLeft = Math.max(stopX + 24, wall + 16);
    // The result's width from the embedded faces' advances (each piece plus its 18 px margin and 2×6 px padding), not a
    // DOM read: a read taken while the stage is scaled for a host came back inflated and threw a fitting result off the track.
    const resultW = pieces.reduce((sum, p) => sum + env.measure(p, "node") + 18 + 12, 0);
    const result = h("div", { position: "absolute", top: y - (numeric ? TYPE.tick.size : TYPE.sentence.size) * 0.62, left: resultLeft, display: "flex", whiteSpace: "nowrap" }, ...resultEls);
    const el = h("div", { position: "absolute", left: 0, top: 0 }, label, track, ...gates, dot, result);
    reveal(el, lane.label);
    const cues = laneCues(lane, r + travel, env.words).map((c) => Math.max(r + travel, at(env, c, r + travel)));
    return { el, label, track, gates, dot, result, resultEls, r, travel, stop, stopX, resultLeft, resultW, cues };
  });
  const block = h("div", { position: "absolute", left: 0, top: 0, width: FRAME.w }, from, to, ...rows.map((r) => r.el));
  const settle = Math.max(...rows.map((r) => Math.max(...r.cues) + MOTION.enterLine));
  return finish(insertRoot(id, "race", block), block, rows[0].r, settle, () => {
    for (const r of rows) {
      // A result too long for the space past the stop sets under its track instead, from the track's start, wrapping between
      // pieces within the track's width, so it never runs off the frame or back under the lane label.
      if (r.resultLeft + r.resultW > GRID.x1) css(r.result, { left: RACE.trackLeft, top: parseFloat(r.track.style.top) + 18, width: RACE.trackRight - RACE.trackLeft, flexWrap: "wrap", whiteSpace: "normal", rowGap: 4 });
    }
    placeBlock(block);
  }, (t) => {
    css(from, enterStyle(t, rows[0].r, MOTION.enterLine));
    css(to, enterStyle(t, rows[0].r, MOTION.enterLine));
    for (const r of rows) {
      css(r.label, enterStyle(t, r.r, MOTION.enterLine));
      const d = progress(t, r.r, MOTION.bar, "draw");
      css(r.track, { transform: `scaleX(${d.toFixed(4)})`, visibility: d > 0 ? "visible" : "hidden" });
      for (const g of r.gates) css(g, enterStyle(t, r.r + MOTION.bar * 0.5, MOTION.enterLine, 0));
      if (r.dot) {
        const k = progress(t, r.r + 0.1, r.travel, "camera");
        css(r.dot, { transform: `translateX(${(k * r.stop * (RACE.trackRight - RACE.trackLeft)).toFixed(1)}px)`, visibility: t >= r.r ? "visible" : "hidden" });
      }
      r.resultEls.forEach((el, k) => css(el, enterStyle(t, r.cues[k], MOTION.enterLine, 0)));
    }
  });
}

// ---------- code ----------

/** A syntax token, tokenised at build time (Compose.ts runs shiki), so the page never tokenises. */
export interface CodeToken { content: string; color?: string }
/** The comment colour of the build-time theme: comments set in secondary ink, everything else in ink. */
export const CODE_COMMENT_COLOR = "#8B949E";
export const CODE_MAX_COLUMNS = 60;

/**
 * The lines [from, to) of an n-line block that stay on screen when only `keep` fit: the window centred on the
 * highlighted lines (1-based), or starting at the first of them when they span more than `keep`; the top of the block
 * when nothing is highlighted.
 */
export function codeExcerpt(n: number, highlight: readonly number[], keep: number): { from: number; to: number } {
  if (keep >= n) return { from: 0, to: n };
  const k = Math.max(1, keep);
  const hs = highlight.filter((l) => l >= 1 && l <= n).map((l) => l - 1);
  if (hs.length === 0) return { from: 0, to: k };
  const lo = Math.min(...hs), hi = Math.max(...hs);
  const start = hi - lo + 1 > k ? lo : Math.round((lo + hi) / 2 - (k - 1) / 2);
  const from = Math.max(0, Math.min(n - k, start));
  return { from, to: from + k };
}

function codeInsert(env: Env, id: string, v: { code: string; lang: string; highlight?: number[]; tokens?: CodeToken[][] }): Insert {
  const I = env.ink;
  const lines: CodeToken[][] = v.tokens ?? v.code.split("\n").map((l) => [{ content: l }]);
  const hl = new Set(v.highlight ?? []);
  const long = lines.map((l) => l.reduce((a, tk) => a + tk.content.length, 0)).filter((n) => n > CODE_MAX_COLUMNS);
  if (long.length) console.warn(`[layout] ${id}: ${long.length} code line(s) past ${CODE_MAX_COLUMNS} columns; the meaning stage should excerpt, never shrink`);
  const rows = lines.map((line, i) => h("div", { position: "relative", whiteSpace: "pre-wrap", overflowWrap: "anywhere", paddingLeft: "2ch", textIndent: "-2ch", minHeight: TYPE.code.size * TYPE.code.leading },
    hl.has(i + 1) ? h("div", { position: "absolute", left: -HIGHLIGHT.padX, right: -HIGHLIGHT.padX, top: 0, bottom: 0, borderRadius: HIGHLIGHT.radius, background: env.highlight, opacity: HIGHLIGHT.opacity, mixBlendMode: env.mode === "voice" ? "multiply" : "screen" }) : null,
    h("span", { position: "relative" }, ...line.map((tk) => h("span", { color: tk.color?.toUpperCase() === CODE_COMMENT_COLOR ? I.secondary : I.ink }, tk.content || " ")))));
  const ground = env.mode === "voice" ? darkenL(I.ground, CODE_GROUND_DARKEN) : I.codeGround;
  // Where the block is cut, an elision line in secondary says so.
  const elision = () => h("div", { minHeight: TYPE.code.size * TYPE.code.leading, color: I.secondary }, "…");
  const above = elision(), below = elision();
  // A line past 60 columns wraps inside the block (hanging under itself) rather than shrink the type or leave the frame.
  const card = h("div", { ...typeStyle("code", I.ink), background: ground, borderRadius: 4, padding: 48, minWidth: FILL.code.width * GRID.width, maxWidth: `calc(${CODE_MAX_COLUMNS}ch + 96px)`, boxSizing: "border-box", display: "inline-block" }, above, ...rows, below);
  const block = h("div", { position: "absolute", left: 0, top: 0, width: FRAME.w, textAlign: "left", display: "flex", justifyContent: "center" }, card);
  card.setAttribute("data-ink", "");
  // A block taller than the safe height keeps the lines around its highlight, never a smaller size and never overflow.
  const fitRows = () => {
    let keep = lines.length;
    for (;;) {
      const { from, to } = codeExcerpt(lines.length, v.highlight ?? [], keep);
      rows.forEach((el, i) => css(el, { display: i >= from && i < to ? "block" : "none" }));
      css(above, { display: from > 0 ? "block" : "none" });
      css(below, { display: to < lines.length ? "block" : "none" });
      if (card.getBoundingClientRect().height * stageFrame().k <= SAFE.h || keep <= 1) break;
      keep--;
    }
    if (keep < lines.length) console.warn(`[layout] ${id}: ${lines.length} code lines do not fit the safe height; showing ${keep} around the highlight`);
  };
  const r = env.start;
  return finish(insertRoot(id, "code", block), block, r, r + MOTION.enterBlock, () => {
    fitRows();
    // Off the badge by width: the block narrows to end left of the keep-out, its lines rewrapping, and is fitted again.
    placeBlock(block, () => { const w = 2 * (narrowRight() - OPTICAL.x); css(card, { maxWidth: w, minWidth: Math.min(FILL.code.width * GRID.width, w) }); fitRows(); });
  }, (t) => css(card, enterStyle(t, r)));
}

// ---------- capture cards ----------


/**
 * The capture card: 1280 wide (76% of the grid, so a card shortened to end on a paragraph still fills the frame by
 * width) and at most 778 tall (80% of the safe height), clear of the badge when centred, a source line under it.
 * Corners are rounded at 24 px (1080p), and the card's `overflow: hidden` clips the picture and its fades to that radius
 * (principal directive, 2026-10-24; Assay's video eval set measures it as `card-corners`, ≥ 16 px).
 */
export const CARD = { w: 1280, h: 778, border: 2, radius: 24, sourceGap: 16, fade: 48, margin: 32 } as const;
/** A capture is shown at a scale where its body text's x-height is at least this (px at 1080p), as the read beats are. */
export const CAPTURE_X_HEIGHT = 22;

/** A block of a capture, rows [top, bottom) in image px; a picture is marked "figure". */
export type CaptureBlock = readonly [number, number] | readonly [number, number, "figure"];

/**
 * A capture's blocks down the page, top to bottom (image px): its text lines grouped into paragraphs, a gap over 1.6
 * times the median line gap (and at least an x-height over it) starting a new one, and its pictures, each a block.
 */
export function captureBlocks(lay: { lines: readonly [number, number][]; figures: readonly [number, number][]; xHeight: number }): CaptureBlock[] {
  const { lines, figures, xHeight } = lay;
  const gaps = lines.slice(1).map((l, i) => l[0] - lines[i][1]).sort((a, b) => a - b);
  const gap = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 0;
  const breakAt = Math.max(gap * 1.6, gap + xHeight);
  const paragraphs: [number, number][] = [];
  for (const [a, b] of lines) {
    const last = paragraphs[paragraphs.length - 1];
    if (last && a - last[1] <= breakAt && !figures.some(([fa]) => fa >= last[1] && fa < a)) last[1] = b;
    else paragraphs.push([a, b]);
  }
  return [...paragraphs, ...figures.map(([a, b]): CaptureBlock => [a, b, "figure"])].sort((p, q) => p[0] - q[0]);
}

/**
 * A view at rest fitted to whole blocks, so its text starts and ends on a paragraph boundary. `keep` (image rows, a
 * zoom's region) first slides the view so every block the region touches is in it whole, when they fit. A top edge
 * that cuts a block or its top padding moves up to just above it when the block is text that fits the view, else (a
 * picture, a paragraph too tall, or when moving up would lose the kept blocks) down to just below it, where the next
 * block starts; the visible height then ends just
 * below the last block the view shows whole. Padding at a boundary is half the gap to the neighbouring block, at most
 * two x-heights. Only when neither move is open does an edge stay where it is and fade over 48 px (`topFade`,
 * `bottomFade`). `h` is card px, at most H.
 */
export function fitRest(blocks: readonly CaptureBlock[], xHeight: number, v: { k: number; y: number }, H: number, keep?: readonly [number, number]): { y: number; h: number; topFade: number; bottomFade: number } {
  const span = H / v.k, most = 2 * xHeight;
  const above = (i: number) => Math.min(most, blocks[i][0], i > 0 ? (blocks[i][0] - blocks[i - 1][1]) / 2 : most);
  const below = (i: number) => Math.min(most, i + 1 < blocks.length ? (blocks[i + 1][0] - blocks[i][1]) / 2 : most);
  let y = v.y, lo = Infinity, hi = -Infinity;
  if (keep) {
    const hit = blocks.flatMap((b, i) => (b[0] < keep[1] && b[1] > keep[0] ? [i] : []));
    if (hit.length) {
      lo = blocks[hit[0]][0] - above(hit[0]);
      hi = blocks[hit[hit.length - 1]][1] + below(hit[hit.length - 1]);
      if (hi - lo <= span) y = Math.min(Math.max(y, hi - span), lo);
      else { lo = Infinity; hi = -Infinity; }
    }
  }
  const keeps = (c: number) => c <= lo && hi <= c + span;
  let topFade = 0;
  const cut = blocks.findIndex(([a, b], i) => a - above(i) < y && y < b);
  if (cut >= 0) {
    const up = blocks[cut][0] - above(cut), down = blocks[cut][1] + below(cut);
    if (blocks[cut][2] !== "figure" && blocks[cut][1] + below(cut) - up <= span && keeps(up)) y = up;
    else if (cut + 1 < blocks.length && keeps(down)) y = down;
    else topFade = CARD.fade;
  }
  let last = -1;
  for (let j = 0; j < blocks.length; j++) {
    if (blocks[j][1] <= y) continue;
    if (blocks[j][1] <= y + span) last = j;
    else break;
  }
  if (last < 0) return { y, h: H, topFade, bottomFade: CARD.fade };
  return { y, h: Math.min(H, (blocks[last][1] + below(last) - y) * v.k), topFade, bottomFade: 0 };
}

/** The least share of the card a whole-block trim may keep before the card falls back to its full height with fades. */
export const MIN_HELD_FRACTION = 0.5;

function captureInsert(env: Env, id: string, type: "screenshot" | "scroll" | "zoom", url: string, cap: CaptureMeta, region: Region | undefined, caption: string | undefined, opts: { start?: number; travel?: number }): Insert {
  const I = env.ink;
  const W = CARD.w - 2 * CARD.border, H = CARD.h - 2 * CARD.border;
  const fit = W / cap.width;
  const picture = img(`${id}.png`, { position: "absolute", left: 0, top: 0, width: cap.width * fit, transformOrigin: "0 0" });
  // The frame must show against the ground: the paper's rule on paper; on dark, where the rule is near-invisible
  // against the dark ground, the muted ink.
  const frameInk = env.mode === "essay" ? I.muted : I.rule;
  const paper = cap.layout?.paper ?? "#FFFFFF";
  // The crop's sides fade over the 32 px margin the text column is kept inside, so only what runs past the column (a
  // wide nav row) meets them, and it fades rather than being cut. Its top and bottom edges are paper covers (see edges).
  const fade = (edge: "top" | "bottom" | "left" | "right") => {
    const across = edge === "left" || edge === "right";
    const toward = { top: "bottom", bottom: "top", left: "right", right: "left" }[edge];
    return h("div", { position: "absolute", ...(across ? { top: 0, bottom: 0, width: CARD.margin } : { left: 0, right: 0, height: CARD.fade }), [edge]: 0, background: `linear-gradient(to ${toward}, ${paper}, ${paper}00)` });
  };
  const cover = { top: fade("top"), bottom: fade("bottom") };
  const card = h("div", { position: "relative", width: CARD.w, height: CARD.h, boxSizing: "border-box", border: `${CARD.border}px solid ${frameInk}`, borderRadius: CARD.radius, overflow: "hidden", background: paper, margin: "0 auto" }, picture, fade("left"), fade("right"), cover.top, cover.bottom);
  card.setAttribute("data-ink", "");
  const domain = url.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  // The credit sits flush with the card's left edge, 16 px under it: kicker and domain tracked +6%/+5%, in secondary.
  // It never runs past the card: a long caption scales the whole line down (it would otherwise reach the badge).
  const credit = caption ?? "source";
  const k = creditScale(credit, domain, CARD.w);
  const source = h("div", { display: "flex", alignItems: "baseline", gap: 14 * k, width: CARD.w, margin: `${CARD.sourceGap}px auto 0` },
    text("kicker", credit, I.secondary, { whiteSpace: "nowrap", letterSpacing: "0.06em", fontSize: TYPE.kicker.size * k }), text("source", domain, I.secondary, { whiteSpace: "nowrap", fontSize: TYPE.source.size * k }));
  const block = h("div", { position: "absolute", left: 0, top: 0, width: FRAME.w }, card, source);
  const r = env.start;
  // A scroll starts reading as the card lands; a zoom holds the overview a moment first so the push has a context.
  const move = type !== "zoom" ? r + MOTION.enterBlock : Math.max(r + MOTION.enterBlock + 1.0, Math.min(r + 1.6, env.seconds - MOTION.camera - 1));
  let moveDur: number = MOTION.camera;
  let imageMove: number | undefined;
  let shrink = 1;
  // Where the picture sits at rest and after its one move, as a scale and a page offset (image px at the card's top-left).
  // A page shown whole is shown at reading size, its body x-height 22 px, but never so large that its text column's
  // lines run off the card's sides; the top and bottom end on paragraph boundaries (below).
  const lay = cap.layout;
  const fitWidth = (w: number) => (W - 2 * CARD.margin) / w;
  const read = lay ? Math.max(fit, Math.min(CAPTURE_X_HEIGHT / lay.xHeight, fitWidth(lay.column[1] - lay.column[0]))) : fit;
  const columnX = (k: number) => {
    if (!lay) return 0;
    const [c0, c1] = lay.column, view = W / k;
    const x = (c1 - c0) <= view - (2 * CARD.margin) / k ? (c0 + c1) / 2 - view / 2 : c0 - CARD.margin / k;
    return Math.max(0, Math.min(cap.width - view, x));
  };
  // A page screenshot reads down its page like a scroll (ISC-51): any push into a page or an image crops its lines.
  // Staging gives every capture a layout, a post's own image included, so a page is one with at least half a card of
  // page below the first view; anything shorter is an image.
  const readsPage = type === "scroll" || (type === "screenshot" && !!lay && !region && cap.height > (1.5 * H) / read);
  let from = { k: read, x: columnX(read), y: (opts.start ?? 0) * (cap.width / cap.cssWidth) };
  if (type === "screenshot" && lay) from.y = Math.max(0, lay.top - CARD.margin / read);
  let to = from;
  if (type === "screenshot" && region) {
    const k = Math.min(W / region.w, H / region.h) * 0.92;
    from = to = { k, x: region.x + region.w / 2 - W / 2 / k, y: region.y + region.h / 2 - H / 2 / k };
  } else if (type === "zoom" && region) {
    // The push ends on the region with whole lines in view: across the region and the page's text column together (the
    // lines around the region run the column's width), at reading size when that span fits the card there, else as
    // large as its width allows, never past 2.5x the overview.
    const x0 = lay ? Math.min(region.x, lay.column[0]) : region.x, x1 = lay ? Math.max(region.x + region.w, lay.column[1]) : region.x + region.w;
    const k = Math.min(fit * 2.5, H / region.h, lay ? Math.min(CAPTURE_X_HEIGHT / lay.xHeight, fitWidth(x1 - x0)) : Math.min(W / region.w, H / region.h) * 0.8);
    from = { k: fit, x: 0, y: Math.max(0, Math.min(cap.height - H / fit, region.y + region.h / 2 - H / 2 / fit)) };
    to = { k, x: (x0 + x1) / 2 - W / 2 / k, y: region.y + region.h / 2 - H / 2 / k };
  } else if (readsPage) {
    // A scroll reads down the page for the whole beat, never one jump and a long hold, so each beat
    // shows more visual change: it travels at least MOTION.readScroll frame px a second until the page runs out.
    const room = Math.max(0, cap.height - H / from.k - from.y);
    const asked = opts.travel ? opts.travel * (cap.width / cap.cssWidth) : (H / from.k) * 0.8;
    const plan = readScrollPlan({ move, seconds: env.seconds, asked, room, k: from.k });
    moveDur = plan.dur;
    to = { ...from, y: from.y + plan.dist };
  }
  // Every view stays on the capture: no paper past its edges.
  const onImage = (v: { k: number; x: number; y: number }) => ({ k: v.k, x: Math.max(0, Math.min(cap.width - W / v.k, v.x)), y: Math.max(0, Math.min(cap.height - H / v.k, v.y)) });
  from = onImage(from);
  to = onImage(to);
  // Top and bottom edges end on paragraph boundaries. The view the card holds (the zoom's region, the scroll's end,
  // the screenshot) is fitted to whole blocks, and the card is shortened to end just below its last whole paragraph.
  // The opening view is fitted into that same height, the paper below its last whole paragraph covered. While the
  // view moves, lines slide through the edges, so the cover gives way to 48 px fades and comes back as it settles.
  const blocks = lay ? captureBlocks(lay) : [];
  const unfitted = (v: { y: number }, h: number) => ({ y: v.y, h, topFade: CARD.fade, bottomFade: CARD.fade });
  const keep: [number, number] | undefined = region && type !== "scroll" ? [region.y, region.y + region.h] : undefined;
  // A trim to whole blocks that leaves under half the card means the next block is taller than the card (an image-led
  // post's header image after its nav, 2026-10-24): the card shrank to the nav strip. Show the full card with its fades.
  const fitted = lay ? fitRest(blocks, lay.xHeight, to, H, keep) : unfitted(to, H);
  // An image is shown whole: the card is the picture's own height (never past the card), with no paragraph trim and no
  // fades at rest; the paragraph fitting is for pages.
  const image = type === "screenshot" && !readsPage;
  const held = image ? { y: 0, h: Math.min(H, cap.height * to.k), topFade: 0, bottomFade: 0 } : fitted.h < H * MIN_HELD_FRACTION ? unfitted(to, H) : fitted;
  const opening = type === "screenshot" && !readsPage ? held : lay ? fitRest(blocks, lay.xHeight, from, held.h) : unfitted(from, held.h);
  from = { ...from, y: opening.y };
  to = { ...to, y: held.y };
  if (type === "screenshot" && !readsPage) {
    // An image is never held (ISC-51; the camera moves build): it lands close on its top-left, where
    // its title sits, and pulls back to the whole picture by the beat's midpoint, so the rest of the beat (and the frame
    // review reads) shows it uncropped. A push about the middle barely changes the picture's centre and the motion check
    // reads it as still; anchoring the close view on a corner carries the whole picture across the card.
    imageMove = r;
    moveDur = Math.max(MOTION.camera, env.seconds / 2 - 0.25 - imageMove);
    const k2 = from.k * Math.max(MOTION.imageClose, tourZoom(moveDur));
    to = from;
    from = onImage({ k: k2, x: to.x, y: to.y });
  }
  css(card, { height: held.h + 2 * CARD.border });
  const rest = { from: { bottom: held.h - opening.h, topFade: opening.topFade, bottomFade: opening.bottomFade }, to: { bottom: 0, topFade: held.topFade, bottomFade: held.bottomFade } };
  const edge = (el: HTMLElement, dir: "top" | "bottom", solid: number, soft: number) =>
    css(el, { height: solid + soft, background: `linear-gradient(to ${dir === "top" ? "bottom" : "top"}, ${paper} ${solid.toFixed(1)}px, ${paper}00 ${(solid + soft).toFixed(1)}px)` });
  return finish(insertRoot(id, type, block), block, r, r + MOTION.enterBlock, () => {
    // Off the badge by width, never by shrinking below 80% of the safe height: the card and its source line narrow to
    // end left of the keep-out while staying centred.
    placeBlock(block, () => {
      const w = Math.floor(2 * (keepOut().x - 2 - OPTICAL.x));
      css(card, { width: w });
      css(source, { width: w });
      // A narrowed image scales with its card rather than losing its right edge.
      if (image) { shrink = (w - 2 * CARD.border) / W; css(card, { height: held.h * shrink + 2 * CARD.border }); }
    });
  }, (t) => {
    css(block.firstElementChild as HTMLElement, enterStyle(t, r));
    css(source, enterStyle(t, r + 0.1, MOTION.enterLine));
    const m = progress(t, imageMove ?? move, moveDur, "camera");
    const k = mix(from.k, to.k, m), x = mix(from.x, to.x, m), y = mix(from.y, to.y, m);
    css(picture, { width: cap.width * k * shrink, transform: `translate(${(-x * k * shrink).toFixed(1)}px, ${(-y * k * shrink).toFixed(1)}px)` });
    // Full fades for all but the move's first and last tenth (sin ≥ 1/3), so no mid-move frame shows a line cut at an edge.
    const moving = Math.min(1, 3 * Math.sin(Math.PI * m));
    edge(cover.top, "top", 0, mix(mix(rest.from.topFade, rest.to.topFade, m), CARD.fade, moving));
    edge(cover.bottom, "bottom", mix(mix(rest.from.bottom, rest.to.bottom, m), 0, moving), mix(mix(rest.from.bottomFade, rest.to.bottomFade, m), CARD.fade, moving));
  });
}

// ---------- the post page (voice mode) ----------

const cameras = new WeakMap<ReadPost, ReadCamera>();

/**
 * The page layer: the real post, clipped to its column plus 64 image px each side (`data-ve-post-clip`), the camera on
 * the spoken sentence and the highlight (`highlight`, Config.json colors.highlight) sliding between sentences. Driven by absolute time, so every beat
 * that shows the page shows one continuous camera. `ink` is the page's ink level from the ink swap (0 = bare paper).
 */
export function pageLayer(post: ReadPost, words: readonly Word[], highlight: string): { el: HTMLElement; update(t: number, ink: number): void } {
  let cam = cameras.get(post);
  if (!cam) { cam = readCamera(post, words); cameras.set(post, cam); }
  const camera = cam;
  const { scale, offsetX, clip } = camera.layout;
  const picture = img(post.image, { position: "absolute", left: 0, top: 0, width: post.width * scale, height: post.height * scale });
  const marks = h("div", { position: "absolute", left: 0, top: 0 });
  // The page ends in paper: below the last narrated line only the post's notes and footer follow, and the clip's
  // margin would slice the next of them in half, so the page fades to paper over `endRamp` px under that line (over
  // twice that when the capture itself ends sooner).
  const bottom = clip.h * scale, last = postColumn(post).bottom * scale;
  const short = last > bottom - 2 * READ.endRamp;
  const foot = short ? bottom - 2 * READ.endRamp : last, ramp = short ? 2 * READ.endRamp : READ.endRamp;
  const end = h("div", { position: "absolute", left: clip.x * scale, top: foot, width: clip.w * scale, height: bottom - foot, background: `linear-gradient(to bottom, ${post.paper}00, ${post.paper} ${ramp}px)` });
  // The clip sits on a whole pixel and the page inside it lands back on offsetX (itself whole), so the picture is
  // never drawn at a fractional x; pageTop is rounded per frame for the same reason (letters stay sharp).
  const clipLeft = Math.round(offsetX + clip.x * scale);
  const page = h("div", { position: "absolute", left: offsetX - clipLeft, top: 0 }, picture, marks, end);
  const clipEl = h("div", { position: "absolute", left: clipLeft, top: 0, width: clip.w * scale, height: FRAME.h, overflow: "hidden" }, page);
  clipEl.setAttribute("data-ve-post-clip", [clip.x, clip.y, clip.w, clip.h].map((n) => Math.round(n)).join(","));
  // The frame's own paper edges, full width over the page: a line leaving the top recedes into paper rather than being
  // sliced, and nothing of the page runs behind the badge (the highlight band already ends at y 700).
  const [t0, t1] = READ.topFade, [f0, f1] = READ.footFade;
  const topEdge = h("div", { position: "absolute", left: 0, top: 0, width: FRAME.w, height: t1, background: `linear-gradient(to bottom, ${post.paper} ${t0}px, ${post.paper}00 ${t1}px)` });
  const footEdge = h("div", { position: "absolute", left: 0, top: f0, width: FRAME.w, height: FRAME.h - f0, background: `linear-gradient(to bottom, ${post.paper}00 0px, ${post.paper} ${f1 - f0}px)` });
  const el = h("div", { ...FILL_FRAME }, clipEl, topEdge, footEdge);
  return {
    el,
    update(t, ink) {
      css(el, { opacity: ink.toFixed(4), visibility: ink > 0 ? "visible" : "hidden" });
      if (ink <= 0) return;
      const f = readFrameAt(camera, t);
      const pageTop = Math.round(-f.camY * scale);
      css(page, { transform: `translateY(${pageTop}px)` });
      // The page ends where the post does: below the clip's foot is paper.
      css(clipEl, { height: Math.max(0, Math.min(FRAME.h, pageTop + clip.h * scale)) });
      // A marked line only draws while it is wholly on screen: a sentence the camera is carrying off the top is leaving.
      const onScreen = (b: { y: number; h: number }) => { const y = b.y - f.camY * scale; return y >= 0 && y + b.h <= FRAME.h; };
      marks.replaceChildren(...highlightBoxes(highlightLines(camera, t), scale).filter(onScreen).map((b) => {
        const m = h("div", { position: "absolute", left: b.x, top: b.y, width: b.w, height: b.h, borderRadius: b.radii.map((r) => `${r}px`).join(" "), background: highlight, opacity: HIGHLIGHT.opacity, mixBlendMode: "multiply" });
        m.setAttribute("data-ve-highlight", "");
        return m;
      }));
    },
  };
}

// ---------- router ----------

export function beatInsert(env: Env, a: { id: string; visual: Visual & { tokens?: CodeToken[][] }; regions: Record<string, Region>; captures: Record<string, CaptureMeta> }): Insert {
  const v = a.visual;
  switch (v.type) {
    case "title": return titleInsert(env, a.id, v);
    case "points": return pointsInsert(env, a.id, v);
    case "compare": return compareInsert(env, a.id, v);
    case "stat": return statInsert(env, a.id, v);
    case "quote": return quoteInsert(env, a.id, v);
    case "diagram": return diagramInsert(env, a.id, v);
    case "race": return raceInsert(env, a.id, v);
    case "code": return codeInsert(env, a.id, v);
    case "scroll": return captureInsert(env, a.id, "scroll", v.url, a.captures[a.id], undefined, v.caption, { start: v.start, travel: v.travel });
    case "screenshot": return captureInsert(env, a.id, "screenshot", v.url, a.captures[a.id], a.regions[a.id], v.caption, {});
    case "zoom": return captureInsert(env, a.id, "zoom", v.url, a.captures[a.id], a.regions[a.id], v.caption, {});
    case "read": throw new Error(`${a.id}: a read beat is the page layer, not an insert`);
  }
}

