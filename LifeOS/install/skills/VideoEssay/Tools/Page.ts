/**
 * Page.ts — the essay composition's entry inside the HyperFrames page.
 *
 * Compose.ts bundles this file into the project as `essay.js` and ships the staged props (base64 JSON) and the
 * narration spectrum beside it. Once every embedded face has loaded and passed the font gate, it builds the whole
 * picture (flat ground, the post page in voice mode, every insert, chapter cards, captions, the progress hairline, the
 * badge) and hands HyperFrames one paused GSAP timeline whose single tween drives a frame clock: every seek calls
 * `draw(frame)`, which shows what owns the frame and moves only what that frame needs.
 *
 * Timing. An insert holds the frame from the word that names its first piece until its last referent
 * plus a hold; outside that window voice mode shows the page. Every change is an ink swap on unchanging paper: the old
 * ink leaves over 233 ms, 4 frames of bare paper, then the new ink builds. Chapter cards swap the same way.
 */
import type { EssayProps, Timeline } from "./CompositionTypes.ts";
import { CARD_TIMES, cardSeconds, GAP, MOTION, progress, SWAP, type SpokenWord } from "./Motion.ts";
import { badgeVoiceFor, presence, type Spectrum } from "./PagePresence.ts";
import { beatInsert, canvasMeasure, css, darkenL, enterStyle, exitStyle, FILL_FRAME, h, insertCues, insertHold, pageLayer, placeBlock, readableOn, text, typeStyle, type CodeToken, type Env, type Insert, type Part } from "./PageVisuals.ts";
import { CODE_GROUND_DARKEN, DEFAULT_BADGE, DEFAULT_BADGE_COPY, DEFAULT_PALETTE, FACES, family, FRAME, TYPE, type Ink, type StagedFace } from "./Theme.ts";

/** What Compose.ts stages beyond the Build props: build-time syntax tokens for code beats. */
export type PageProps = EssayProps & { codeTokens?: Record<string, CodeToken[][]> };

interface GsapTimeline { to(target: object, vars: Record<string, unknown>, position?: number): GsapTimeline; duration(): number }
declare const gsap: { timeline(vars: Record<string, unknown>): GsapTimeline };

/**
 * A beat's place on the frame grid. Essay mode keeps its original rounding (a gap follows every beat). A gap-0
 * timeline (voice mode) tiles exactly: each beat ends on the frame the next one starts.
 */
export function beatSpan(timeline: Timeline, i: number, fps: number): { from: number; frames: number } {
  const tb = timeline.beats[i];
  const from = Math.round(tb.start * fps);
  if (timeline.gap === 0) return { from, frames: Math.max(1, Math.round(tb.end * fps) - from) };
  return { from, frames: Math.max(1, Math.round((tb.end - tb.start + timeline.gap) * fps)) };
}

/** The composition's length in frames: at least one second. */
export const durationInFrames = (total: number, fps: number) => Math.max(fps, Math.ceil(total * fps));

const CAPTURE_TYPES = new Set(["screenshot", "scroll", "zoom"]);

// ---------- the font gate: no timeline until every embedded face is really there ----------

/**
 * How the gate asks the page about a face: `check` is document.fonts.check, `width` a canvas advance, `loaded` every
 * face in document.fonts whose status is "loaded" (family unquoted, weight as a number).
 */
export interface LoadedFace { family: string; weight: number; style: string }
export interface FontProbe { check(spec: string): boolean; width(spec: string, sample: string): number; loaded(): LoadedFace[] }
export const GATE_SAMPLE = "Hamburgefonstiv 0123456789 ABCDEFG";

/**
 * Every face that is not really there. `document.fonts.check` returns true for a family it has never heard of, so
 * the gate also measures a sample in the face over two different generic fallbacks: a real face measures the same over
 * both and differently from both fallbacks alone; a missing one measures exactly as its fallback does. Faces that share a
 * family by weight or style (the body-serif cuts) would pass both tests on a synthesized cut, so the exact family, weight and style
 * must also be a loaded face in document.fonts.
 */
export function fontGateProblems(faces: readonly StagedFace[], probe: FontProbe): string[] {
  if (faces.length === 0) return ["no faces staged: the composition embeds its faces and never renders in a fallback"];
  const problems: string[] = [];
  const loaded = probe.loaded();
  for (const f of faces) {
    const spec = `${f.style} ${f.weight} 48px "${f.family}"`;
    if (!loaded.some((l) => l.family === f.family && l.weight === f.weight && l.style === f.style)) { problems.push(`${f.family} ${f.weight} ${f.style}: no loaded face in document.fonts (a synthesized cut is not the face)`); continue; }
    if (!probe.check(spec)) { problems.push(`${f.family} ${f.weight} ${f.style}: document.fonts.check failed`); continue; }
    const serif = probe.width(`${spec}, serif`, GATE_SAMPLE), mono = probe.width(`${spec}, monospace`, GATE_SAMPLE);
    const bareSerif = probe.width(`${f.style} ${f.weight} 48px serif`, GATE_SAMPLE), bareMono = probe.width(`${f.style} ${f.weight} 48px monospace`, GATE_SAMPLE);
    if (Math.abs(serif - bareSerif) < 0.01 || Math.abs(mono - bareMono) < 0.01 || Math.abs(serif - mono) > 0.01) problems.push(`${f.family} ${f.weight} ${f.style}: the glyph-width probe measures the fallback, not the face`);
  }
  return problems;
}

/** Throw unless every staged face is loaded and measures as itself; the timeline never registers after a throw. */
export function gateFonts(faces: readonly StagedFace[], probe: FontProbe): void {
  const problems = fontGateProblems(faces, probe);
  if (problems.length) throw new Error(`font gate refused the composition:\n- ${problems.join("\n- ")}`);
}

const QUOTE_MARKS = ['"', "'"];

function pageProbe(): FontProbe {
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) throw new Error("font gate: canvas 2d context unavailable");
  const weight = (w: string) => (w === "normal" ? 400 : w === "bold" ? 700 : Number(w));
  // FontFace.family may come back quoted. No quote character sits inside a regex literal here: the HyperFrames bundler
  // pairs the quotes of inlined scripts, and one inside a regex overflows its stack on a long run's bands.
  const unquote = (s: string) => (s.length > 1 && s[0] === s[s.length - 1] && QUOTE_MARKS.includes(s[0]) ? s.slice(1, -1) : s);
  return {
    check: (spec) => document.fonts.check(spec, GATE_SAMPLE),
    width: (spec, sample) => { ctx.font = spec; return ctx.measureText(sample).width; },
    loaded: () => {
      const out: LoadedFace[] = [];
      document.fonts.forEach((ff) => { if (ff.status === "loaded") out.push({ family: unquote(ff.family), weight: weight(ff.weight), style: ff.style }); });
      return out;
    },
  };
}

// ---------- ink windows ----------

/** A span (seconds on the composition timeline) during which an insert or a card owns the frame: builds from `a`, exits at `b`. */
export interface InkWindow { a: number; b: number }

/**
 * The page's ink level at t (1 = the page is on screen, 0 = bare paper under an insert or card). Before a window the
 * page ink leaves over 233 ms and 4 frames of paper follow; after it, 4 frames of paper and the page returns over 333 ms.
 */
export function pageInk(windows: readonly InkWindow[], t: number): number {
  let level = 1;
  for (const w of windows) {
    if (t < w.a - SWAP || t >= w.b + SWAP + MOTION.enterLine) continue;
    if (t < w.a - GAP) level = Math.min(level, 1 - progress(t, w.a - SWAP, MOTION.exit, "exit"));
    else if (t < w.b + SWAP) level = 0;
    else level = Math.min(level, progress(t, w.b + SWAP, MOTION.enterLine, "enter"));
  }
  return level;
}

/**
 * When an insert exits (beat-local seconds): after its last referent plus the hold, but never before its builds
 * have settled and held 2 s. One that would leave less than a second of page before the beat ends runs to the end,
 * leaving just enough time to swap to what follows. With no referent it holds the whole beat.
 */
export function exitAt(seconds: number, settle: number, lastReferent: number | undefined, hold: number, last: boolean): number {
  const end = last ? seconds : seconds - SWAP;
  if (lastReferent === undefined) return end;
  const b = Math.max(settle + 2, lastReferent + hold);
  return b > end - 1 ? end : b;
}

// ---------- chapter card ----------

/** Chapter card timing, seconds from the card's start. The hold after the last build is 1.6 s. */
export { CARD_TIMES } from "./Motion.ts";
/** The chapter ruler: a 960 px hairline across x 480–1440, a 2 × 20 px tick per chapter, the current chapter in 4 px accent. */
export const RULER = { x0: 480, x1: 1440, tickW: 2, tickH: 20, line: 2, accent: 4, minSegment: 8 } as const;
export { cardSeconds } from "./Motion.ts";
/**
 * Voice mode: the longest a chapter card holds past its own exit waiting for its beat's insert. Longer than this and
 * the card leaves on time and the page carries the reading until the insert's first word, as it does for every insert
 * without a card (a card held for many seconds covers paragraphs the viewer should be reading).
 */
export const CARD_HOLD_MAX = 1.5;

/** The smallest a chapter title steps down to before it takes a third line. */
export const TITLE_MIN_SIZE = 88;

/**
 * A chapter title's lines and size: one line at 119 px when it fits the 1400 px measure, else the most even two-line
 * split; a title too long for two lines at 119 px steps down to 88 px, and only past that takes three.
 */
function titleLines(s: string, width: number): { lines: string[]; size: number } {
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return { lines: [s], size: TYPE.title.size };
  const words = s.trim().split(/\s+/);
  const split = (n: number): { lines: string[]; w: number } | undefined => {
    let best: { lines: string[]; w: number } | undefined;
    const go = (from: number, left: number, acc: string[]) => {
      if (left === 1) { const lines = [...acc, words.slice(from).join(" ")]; const w = Math.max(...lines.map((l) => ctx.measureText(l).width)); if (!best || w < best.w) best = { lines, w }; return; }
      for (let k = from + 1; k <= words.length - left + 1; k++) go(k, left - 1, [...acc, words.slice(from, k).join(" ")]);
    };
    if (words.length >= n) go(0, n, []);
    return best && best.w <= width ? best : undefined;
  };
  for (const n of [1, 2]) for (let size = TYPE.title.size; size >= (n === 1 ? TYPE.title.size : TITLE_MIN_SIZE); size -= 4) {
    ctx.font = `${FACES[TYPE.title.face].weight} ${size}px ${family(TYPE.title.face)}`;
    const r = split(n);
    if (r) return { lines: r.lines, size };
  }
  ctx.font = `${FACES[TYPE.title.face].weight} ${TITLE_MIN_SIZE}px ${family(TYPE.title.face)}`;
  return { lines: split(3)?.lines ?? [s], size: TITLE_MIN_SIZE };
}

/** A chapter card; `update` takes the time its exit starts, which holds past CARD_TIMES.exit until the beat's insert is due. */
interface ChapterCard { el: HTMLElement; layout(): void; update(t: number, exit: number): void }

function chapterCard(ink: Ink, index: number, title: string, chapters: { start: number; end: number }[], current: number, total: number): ChapterCard {
  const kicker = text("kicker", "Chapter", ink.secondary, { textAlign: "center" });
  const numeral = text("numeral", String(index), ink.ink, { textAlign: "center", marginTop: 24 });
  const set = titleLines(title, 1400);
  const lines = set.lines.map((l) => text("title", l, ink.ink, { textAlign: "center", whiteSpace: "nowrap", fontSize: set.size }));
  const titleEl = h("div", { marginTop: 40 }, ...lines);
  const x = (t: number) => RULER.x0 + ((RULER.x1 - RULER.x0) * t) / Math.max(1e-6, total);
  const hair = h("div", { position: "absolute", left: RULER.x0, top: (RULER.tickH - RULER.line) / 2, width: RULER.x1 - RULER.x0, height: RULER.line, background: ink.rule, transformOrigin: "left center" });
  const ticks = chapters.map((c) => h("div", { position: "absolute", left: x(c.start) - RULER.tickW / 2, top: 0, width: RULER.tickW, height: RULER.tickH, background: ink.ink }));
  const seg = chapters[current];
  const accent = h("div", { position: "absolute", left: x(seg.start), top: (RULER.tickH - RULER.accent) / 2, width: Math.max(RULER.minSegment, x(seg.end) - x(seg.start)), height: RULER.accent, background: ink.accent });
  for (const el of [hair, ...ticks, accent]) el.setAttribute("data-ink", "");
  const ruler = h("div", { position: "relative", width: FRAME.w, height: RULER.tickH, marginTop: 56 }, hair, ...ticks, accent);
  const block = h("div", { position: "absolute", left: 0, top: 0, width: FRAME.w }, kicker, numeral, titleEl, ruler);
  const el = h("div", { ...FILL_FRAME }, block);
  el.setAttribute("data-ve-chapter", String(index));
  // Text layered over the beat it opens is deliberate; HyperFrames' overlap audit needs the flag on each text block.
  for (const t of [kicker, numeral, ...lines]) t.setAttribute("data-layout-allow-overlap", "");
  return {
    el,
    layout: () => { placeBlock(block); },
    update(t, exit) {
      css(el, t >= exit ? exitStyle(t, exit) : { opacity: 1, transform: "none", visibility: "visible" });
      css(kicker, enterStyle(t, 0, MOTION.enterLine));
      css(numeral, enterStyle(t, 0));
      const d = progress(t, CARD_TIMES.ruler, CARD_TIMES.rulerDraw, "draw");
      css(hair, { transform: `scaleX(${d.toFixed(4)})`, visibility: d > 0 ? "visible" : "hidden" });
      ticks.forEach((tk, k) => css(tk, { visibility: d * (RULER.x1 - RULER.x0) >= x(chapters[k].start) - RULER.x0 && d > 0 ? "visible" : "hidden" }));
      lines.forEach((l, k) => css(l, enterStyle(t, CARD_TIMES.title + k * CARD_TIMES.titleStagger, MOTION.enterLine)));
      // The segment arrives by ink, not by growing: a short last chapter would draw as a sub-pixel sliver.
      const a = progress(t, CARD_TIMES.accent, CARD_TIMES.accentDraw, "draw");
      css(accent, { opacity: a.toFixed(4), visibility: a > 0 ? "visible" : "hidden" });
    },
  };
}

function captions(timeline: Timeline, ink: Ink, fps: number): Part {
  const el = h("div", { position: "absolute", bottom: 60, left: 0, right: 0, textAlign: "center", ...typeStyle("sentence", ink.ink, { fontSize: 44 }) });
  return {
    el,
    update(frame) {
      const t = frame / fps;
      const beat = timeline.beats.find((b) => t >= b.start && t <= b.end + timeline.gap);
      if (!beat) { el.replaceChildren(); return; }
      const idx = beat.words.findIndex((w) => t >= w.s && t < w.e);
      const cur = idx >= 0 ? idx : beat.words.findIndex((w) => w.s > t) - 1;
      const from = Math.max(0, Math.floor(cur / 6) * 6);
      el.replaceChildren(...beat.words.slice(from, from + 6).map((w, i) => h("span", { color: from + i === cur ? ink.accent : ink.ink, marginRight: 14 }, w.w)));
    },
  };
}

// ---------- mount ----------

/** YouTube's end screen needs the last seconds clear: no insert starts in them. */
export const END_SCREEN_SECONDS = 5;

interface BeatPart { el: HTMLElement; from: number; frames: number; insert?: Insert; b: number; /** Frames the beat stays on after its cut while its insert finishes leaving. */ tail: number; card?: ChapterCard; /** When the card's exit starts (beat-local). */ cardExit: number; /** Where the page layer sits while this beat is on: a read beat's root, or under an insert. */ pageHost: HTMLElement; /** A beat showing the page: its contract root. */ marker?: HTMLElement }

/** Build the picture into `root` and return the frame painter. */
export function mount(root: HTMLElement, props: PageProps, spectrum: Spectrum, fps: number): { draw(frame: number): void; total: number } {
  const total = durationInFrames(props.timeline.total, fps);
  const voice = props.mode === "voice";
  const palette = props.palette ?? DEFAULT_PALETTE;
  const paper = voice ? props.post?.paper ?? palette.paper : palette.darkInk.ground;
  const base: Ink = voice ? { ...palette.paperInk, ground: paper, codeGround: darkenL(paper, CODE_GROUND_DARKEN) } : palette.darkInk;
  // Every token that sets text is held to AA on this run's own ground: a darker capture paper would otherwise pull the greys under 4.5:1.
  const ink: Ink = { ...base, secondary: readableOn(base.secondary, base.ground), muted: readableOn(base.muted, base.ground), accent: readableOn(base.accent, base.ground) };
  const measure = canvasMeasure();
  const words = props.timeline.beats.flatMap((b) => b.words);
  const beats = props.script.beats.map((b, i) => ({ b, i, tb: props.timeline.beats[i] })).filter((x) => x.tb);
  // Chapters: where each starts and ends on the timeline, for every card's ruler.
  const chapterBeats = beats.filter((x) => x.b.chapter);
  const chapterSpans = chapterBeats.map((x, k) => ({ start: beatSpan(props.timeline, x.i, fps).from / fps, end: k + 1 < chapterBeats.length ? beatSpan(props.timeline, chapterBeats[k + 1].i, fps).from / fps : total / fps }));
  const windows: { a: number; b: number }[] = [];
  const parts: BeatPart[] = [];
  const ground = h("div", { ...FILL_FRAME, background: paper });
  ground.setAttribute("data-ve-paper", "");
  const page = voice && props.post ? pageLayer(props.post, words, palette.highlight) : undefined;
  const layer = h("div", { ...FILL_FRAME });
  root.append(h("div", { ...FILL_FRAME, overflow: "hidden" }, ground, layer));
  for (const [k, { b, i, tb }] of beats.entries()) {
    const { from, frames } = beatSpan(props.timeline, i, fps);
    const start = from / fps, seconds = frames / fps;
    const last = k === beats.length - 1;
    const chapterIndex = chapterBeats.findIndex((x) => x.i === i);
    const card = chapterIndex >= 0 ? chapterCard(ink, chapterIndex + 1, b.chapter!, chapterSpans, chapterIndex, total / fps) : undefined;
    const minA = card ? cardSeconds + GAP : 0;
    const el = h("div", { ...FILL_FRAME, display: "none" });
    layer.append(el);
    if (card) el.append(card.el);
    // A beat that shows the page carries a bare root for the DOM contract, and the page layer sits in it while the beat is on.
    const pageBeat = (type: string, suppressed?: string) => {
      const marker = h("div", { ...FILL_FRAME, pointerEvents: "none" });
      marker.dataset.veBeat = b.id;
      marker.dataset.veType = type;
      marker.dataset.veSettle = "0"; // set once the ink windows are known (below)
      if (suppressed) marker.dataset.veSuppressed = suppressed;
      el.prepend(marker);
      parts.push({ el, from, frames, b: seconds, tail: 0, card, cardExit: CARD_TIMES.exit, pageHost: marker, marker });
    };
    if (b.visual.type === "read") { pageBeat("read"); continue; }
    const local: SpokenWord[] = tb.words.map((w) => ({ w: w.w, s: w.s - start, e: w.e - start }));
    const cues = insertCues(b.visual, local);
    const capture = CAPTURE_TYPES.has(b.visual.type);
    const a = voice && !capture ? Math.max(minA, Math.min(cues.first ?? minA, seconds - 2)) : minA;
    // The end screen owns the last 5 s: an insert that would start there is not drawn, and the page stays.
    if (voice && start + a > total / fps - END_SCREEN_SECONDS) { pageBeat(b.visual.type, "end-screen"); continue; }
    const env: Env = { fps, mode: voice ? "voice" : "essay", ink, highlight: palette.highlight, start: a, seconds, words: local, measure };
    const visual = { ...b.visual, ...(b.visual.type === "code" && props.codeTokens?.[b.id] ? { tokens: props.codeTokens[b.id] } : {}) };
    const insert = beatInsert(env, { id: b.id, visual, regions: props.regions, captures: props.captures });
    el.prepend(insert.el);
    parts.push({ el, from, frames, insert, b: seconds, tail: 0, card, cardExit: CARD_TIMES.exit, pageHost: el });
  }
  const caps = props.captions ? captions(props.timeline, ink, fps) : undefined;
  const progressLine = h("div", { position: "absolute", left: 0, bottom: 0, height: 4, background: props.accent });
  progressLine.setAttribute("data-ve-furniture", "");
  const badge = presence({ fps, spectrum, label: props.daLabel, accent: props.accent, dark: palette.darkInk, variant: voice ? "voice" : "essay", badge: props.badge ?? DEFAULT_BADGE, copy: props.badgeCopy ?? DEFAULT_BADGE_COPY, voice: badgeVoiceFor(props.narrator, props.reader, props.daLabel, props.possessive) });
  root.append(...[caps?.el, progressLine, badge.el].filter((x): x is HTMLElement => !!x));
  // Lay every insert and card out on its rendered strings, each while it is displayed, then plan its exit.
  for (const [k, p] of parts.entries()) {
    css(p.el, { display: "block" });
    p.card?.layout();
    if (p.insert) {
      p.insert.layout();
      const seconds = p.frames / fps;
      const next = parts[k + 1];
      const tb = props.timeline.beats[beats[k].i];
      const local: SpokenWord[] = tb.words.map((w) => ({ w: w.w, s: w.s - p.from / fps, e: w.e - p.from / fps }));
      const cues = insertCues(beats[k].b.visual, local);
      const nextIsCard = !!next?.card;
      const capture = CAPTURE_TYPES.has(beats[k].b.visual.type);
      p.b = voice && !capture && !nextIsCard ? exitAt(seconds, p.insert.settle, cues.lastReferent, insertHold(cues), !next) : next ? seconds - SWAP : seconds;
    }
    css(p.el, { display: "none" });
  }
  // Where no page returns between two inks (essay mode, or a card next), the leaving insert holds through its cut until
  // the next ink is due, so the only bare frames are the swap's four and never the wait for the next word; its beat
  // stays on past the cut for those frames. A card holds the same way until its beat's insert is due.
  for (const [k, p] of parts.entries()) {
    const seconds = p.frames / fps;
    if (p.card && p.insert) {
      const due = p.insert.first - SWAP;
      p.cardExit = voice && due - CARD_TIMES.exit > CARD_HOLD_MAX ? CARD_TIMES.exit : Math.max(CARD_TIMES.exit, Math.min(seconds - MOTION.exit, due));
    }
    const next = parts[k + 1];
    if (p.insert && next && (!voice || next.card)) {
      const nextInk = next.from / fps + (next.card ? 0 : next.insert ? next.insert.first : 0) - p.from / fps;
      p.b = Math.max(p.b, nextInk - SWAP);
      p.tail = Math.max(0, Math.ceil((p.b + MOTION.exit - seconds) * fps - 1e-6));
    }
    if (p.card) windows.push({ a: p.from / fps, b: p.from / fps + p.cardExit });
    if (p.insert) windows.push({ a: p.from / fps + p.insert.first, b: p.from / fps + p.b });
  }
  // A beat that shows the page settles once the page is fully back: after the swap from whatever ink held the frame as
  // it opened (the previous beat's insert, or its own chapter card), never at 0 while that ink is still leaving.
  for (const p of parts) {
    if (!p.marker) continue;
    const start = p.from / fps, seconds = p.frames / fps;
    const back = Math.max(0, ...windows.filter((w) => w.a < start + seconds && w.b + SWAP + MOTION.enterLine > start).map((w) => w.b + SWAP + MOTION.enterLine - start));
    p.marker.dataset.veSettle = Math.min(seconds, Math.ceil(back * fps - 1e-6) / fps).toFixed(3);
  }
  let lastFrame = -1;
  const draw = (frame: number) => {
    if (frame === lastFrame) return;
    lastFrame = frame;
    const t = frame / fps;
    for (const p of parts) {
      const on = frame >= p.from && frame < p.from + p.frames + p.tail;
      css(p.el, { display: on ? "block" : "none" });
      if (!on) continue;
      // One page layer travels with the beat on screen, always beneath its insert and card (DOM contract: a read beat's
      // root holds the element that clips the post).
      if (page && page.el.parentElement !== p.pageHost) p.pageHost.prepend(page.el);
      const local = (frame - p.from) / fps;
      if (p.insert) {
        p.insert.update(local);
        css(p.insert.el, local >= p.b ? exitStyle(local, p.b) : { opacity: 1, transform: "none", visibility: "visible" });
      }
      if (p.card) { const cardOn = local < p.cardExit + MOTION.exit; css(p.card.el, { display: cardOn ? "block" : "none" }); if (cardOn) p.card.update(local, p.cardExit); }
    }
    page?.update(t, pageInk(windows, t));
    caps?.update(frame);
    css(progressLine, { width: `${(frame / total) * 100}%` });
    badge.update(frame);
  };
  return { draw, total };
}

/** Decode the staged props: base64 UTF-8 JSON, so no text in them can read as code to the preflight scan. */
function decodeProps(b64: string): PageProps {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return JSON.parse(new TextDecoder().decode(bytes)) as PageProps;
}

interface PageWindow { __ESSAY_PROPS?: string; __ESSAY_BANDS?: { spectrum: { values: number[][] } | null }; __essayTimeline?: GsapTimeline; __essayReady?: Promise<void>; __hfFontsReady?: Promise<void> }

/**
 * Wait for the embedded faces, refuse unless every one passes the gate, then build and paint frame 0. The registration
 * line in index.html waits on `__essayReady`, so a face that fails anywhere means no timeline, never a fallback frame.
 */
export async function boot(w: PageWindow, doc: Document, probe: () => FontProbe = pageProbe): Promise<void> {
  const root = doc.getElementById("stage");
  if (!root || !w.__ESSAY_PROPS || !w.__ESSAY_BANDS?.spectrum) throw new Error("essay page: #stage, props and bands (with a spectrum lane) must load before essay.js");
  if (!w.__hfFontsReady) throw new Error("essay page: the embedded-font loader did not run (index.html needs injectFonts)");
  await w.__hfFontsReady;
  const props = decodeProps(w.__ESSAY_PROPS);
  gateFonts(props.fonts ?? [], probe());
  const fps = props.timeline.fps;
  const { draw, total } = mount(root, props, w.__ESSAY_BANDS.spectrum.values, fps);
  const seconds = total / fps;
  let now = 0;
  // GSAP calls a function-valued property as its getter and setter, so every seek lands here, events suppressed or not.
  const clock = { t(v?: number): number { if (v !== undefined) { now = v; draw(Math.min(total - 1, Math.round(v * fps))); } return now; } };
  draw(0);
  const tl = gsap.timeline({ paused: true });
  tl.to(clock, { t: seconds, duration: seconds, ease: "none" }, 0);
  w.__essayTimeline = tl;
  await Promise.all(Array.from(doc.images).map((im) => im.decode().catch(() => { throw new Error(`image failed to load: ${im.getAttribute("src")}`); })));
}

/**
 * The HyperFrames compiler inlines this script ahead of the body, so it runs before #stage exists: build on
 * DOMContentLoaded. `__essayReady` exists synchronously so the registration gate can wait on it.
 */
if (typeof document !== "undefined" && typeof window !== "undefined") {
  const w = window as unknown as PageWindow;
  w.__essayReady = new Promise<void>((resolve, reject) => {
    const go = () => { boot(w, document).then(resolve, (e) => { console.error(`[essay] ${(e as Error).message}`); reject(e); }); };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", go, { once: true }); else go();
  });
}
