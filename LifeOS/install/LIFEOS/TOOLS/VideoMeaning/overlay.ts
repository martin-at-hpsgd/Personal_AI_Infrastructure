/**
 * Overlay-mode checks for footage of people talking (Video Enhance/Augment):
 * The Video caller is optional and NOT in the public release payload; these checks work without it.
 * who said which words, and where the screen already shows the thing.
 *
 *  - Attribution: a card never puts words in the wrong speaker's mouth. Quoted
 *    on-card text is the speaker's exact words; a cut-down line is that speaker's
 *    words with some removed, never reworded. Deterministic, no model.
 *  - Live demos: a stretch where the speaker is already showing the thing on
 *    screen is never covered (the Video election test: his own screen wins).
 *  - Map attribution: a speaker-labelled MeaningMap records who makes each claim,
 *    and the record is checked against the transcript before the map is accepted.
 *
 * The lint (engine.ts), the map repair loop (engine.ts) and the Video card map
 * builder (skills/_VIDEO/Tools/CardMap.ts; maintainer-side, not in the public release payload) all call these.
 */

import { readFileSync } from "fs";
import { raceStrings, type Direction, type DirectionBeat, type InsertSpec, type MeaningMap, type Severity, type Span, type Speaker } from "./schema";
import { normText, SourceError, type SourceBlock, type SourceDoc } from "./source";

// ─────────────────────────────────────────────────────────────── speakers

/** A transcript is speaker-labelled when every block names its speaker. Partial labels prove nothing. */
export function hasSpeakerLabels(doc: SourceDoc): boolean {
  return doc.kind === "transcript" && doc.blocks.length > 0 && doc.blocks.every(b => !!b.speaker);
}

export interface Turn { speaker: string; text: string; start?: number; end?: number }

/** Another speaker's block this short is a backchannel ("Yeah", "Right, right") that does not end a turn. */
export const BACKCHANNEL_MAX_WORDS = 3;

/**
 * Each speaker's turns: consecutive blocks by the same speaker, merged, so a quote
 * may run across a paragraph break. A backchannel from someone else does not end
 * the turn, and its words stay out of the turn's text: "they are the ones, like,
 * [Yeah] guiding" is still one sentence of the person who said it.
 */
export function speakerTurns(doc: SourceDoc): Turn[] {
  const out: Turn[] = [];
  const open = new Map<string, Turn>();   // each speaker's turn, still open across backchannels
  for (const b of doc.blocks) {
    const who = b.speaker ?? "";
    const cur = open.get(who);
    if (cur) { cur.text += ` ${b.text}`; cur.end = b.end ?? cur.end; }
    else { const t: Turn = { speaker: who, text: b.text, start: b.start, end: b.end }; out.push(t); open.set(who, t); }
    if (toks(b.text).length > BACKCHANNEL_MAX_WORDS) for (const k of [...open.keys()]) if (k !== who) open.delete(k);
  }
  return out;
}

const toks = (s: string): string[] => normText(s).split(" ").filter(Boolean);
/** Segments of a quote that drops words with an ellipsis: "a … b" is two contiguous runs, in order. */
const segments = (line: string): string[][] => line.split(/\s*(?:…|\.\.\.)\s*/).map(toks).filter(s => s.length > 0);

function indexOfRun(hay: string[], run: string[], from: number): number {
  outer: for (let i = from; i + run.length <= hay.length; i++) {
    for (let j = 0; j < run.length; j++) if (hay[i + j] !== run[j]) continue outer;
    return i;
  }
  return -1;
}

/** Verbatim: every ellipsis-separated segment is a contiguous run of one text's words, in order. */
export function saysVerbatim(line: string, texts: string[]): boolean {
  const segs = segments(line);
  if (segs.length === 0) return true;
  return texts.some(t => {
    const hay = toks(t);
    let at = 0;
    for (const s of segs) {
      const i = indexOfRun(hay, s, at);
      if (i < 0) return false;
      at = i + s.length;
    }
    return true;
  });
}

/**
 * Cut-down: the line's words appear in order inside one text, within a stretch at
 * most twice the line's length plus six words. Words removed, never added or reworded;
 * the window keeps a four-word line from matching across a whole monologue.
 */
export function saysCutDown(line: string, texts: string[]): boolean {
  const t = toks(line);
  if (t.length === 0) return true;
  const limit = t.length * 2 + 6;
  return texts.some(text => {
    const hay = toks(text);
    for (let i = 0; i < hay.length; i++) {
      if (hay[i] !== t[0]) continue;
      let k = 1, j = i + 1;
      for (; j < hay.length && k < t.length && j - i < limit; j++) if (hay[j] === t[k]) k++;
      if (k === t.length) return true;
    }
    return false;
  });
}

/**
 * Resolve a card's attribution ("Jane Speaker, Example Corp") to a speaker id:
 * an exact id or name, else the one speaker whose id or first name appears in it.
 */
export function resolveSpeaker(attribution: string, speakers: Speaker[]): { id?: string; error?: string } {
  const a = normText(attribution);
  const exact = speakers.filter(s => normText(s.id) === a || normText(s.name) === a);
  if (exact.length === 1) return { id: exact[0].id };
  const words = new Set(toks(attribution));
  const hits = speakers.filter(s => words.has(normText(s.id)) || (toks(s.name)[0] !== undefined && words.has(toks(s.name)[0])));
  if (hits.length === 1) return { id: hits[0].id };
  if (hits.length > 1) return { error: `attribution "${attribution}" matches more than one speaker (${hits.map(s => s.id).join(", ")})` };
  return { error: `attribution "${attribution}" names no speaker in the transcript (${speakers.map(s => `${s.id} = ${s.name}`).join("; ")})` };
}

// ─────────────────────────────────────────────────────────────── on-card words

/** Quoted spans in prose: '…', "…" or “…”, opened after a boundary so an apostrophe inside a word never opens one. */
export function quotedSpans(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/(?:^|[\s(\[:])(?:'([^']+?)'|"([^"]+?)"|“([^”]+?)”)(?=[\s.,;:)\]!?]|$)/g)) {
    const q = (m[1] ?? m[2] ?? m[3] ?? "").trim();
    if (q) out.add(q);
  }
  return [...out];
}

/**
 * The speaker's words a card puts on screen. `quoted` must be verbatim (a quote, a
 * concept's quoted or structured on-screen text); `cut` may be cut down (points,
 * compare sides). Labels (headings, node names, reference titles) are names, not
 * quotations, and are checked by the lint's vocabulary rule instead.
 */
export function onCardWords(v: InsertSpec): { quoted: string[]; cut: string[] } {
  switch (v.type) {
    case "quote": return { quoted: [v.text], cut: [] };
    case "points": return { quoted: [], cut: v.points };
    case "compare": return { quoted: [], cut: [v.left.text, v.right.text] };
    case "race": { const r = raceStrings(v); return { quoted: [], cut: [...r.endpoints, ...r.results] }; }
    case "concept": {
      const structured = (v as { text?: unknown }).text;
      const text = Array.isArray(structured) ? structured.filter((s): s is string => typeof s === "string" && s.trim().length > 0) : [];
      return { quoted: [...new Set([...text, ...quotedSpans([v.description, ...(v.beats ?? [])].join(" "))])], cut: [] };
    }
    default: return { quoted: [], cut: [] };
  }
}

/**
 * Whose words a card shows: the quote's attribution when it has one, else the
 * speakers of the claims it carries, else the speakers of its units.
 */
export function cardSpeakers(beat: DirectionBeat, map: MeaningMap): { ids: string[]; from: "attribution" | "claims" | "units" | "none"; error?: string } {
  if (beat.visual?.type === "quote") {
    const r = resolveSpeaker(beat.visual.attribution, map.speakers);
    return r.id ? { ids: [r.id], from: "attribution" } : { ids: [], from: "attribution", error: r.error };
  }
  const carried = beat.rationale?.carries ?? [];
  const claimSpeakers = map.claims.filter(c => carried.includes(c.id) && c.speaker).map(c => c.speaker as string);
  if (claimSpeakers.length) return { ids: [...new Set(claimSpeakers)], from: "claims" };
  const unitSpeakers = map.units.filter(u => beat.units.includes(u.id) && u.speaker).map(u => u.speaker as string);
  if (unitSpeakers.length) return { ids: [...new Set(unitSpeakers)], from: "units" };
  return { ids: [], from: "none" };
}

export interface OverlayDefect { name: string; severity: Severity; beat: string; detail: string; fix?: string }

function whoSays(line: string, doc: SourceDoc, mode: "quoted" | "cut"): string[] {
  const texts = speakerTurns(doc);   // a cut-down stays tight through its word window, not through block edges
  return [...new Set(texts.filter(t => (mode === "quoted" ? saysVerbatim : saysCutDown)(line, [t.text])).map(t => t.speaker))];
}

/**
 * The deterministic speaker and verbatim check for every insert. Runs only on a
 * speaker-labelled transcript; a solo recording is labelled with its one speaker.
 */
export function attributionDefects(direction: Direction, map: MeaningMap, doc: SourceDoc): OverlayDefect[] {
  if (!hasSpeakerLabels(doc)) return [];
  const out: OverlayDefect[] = [];
  for (const b of direction.beats) {
    if (b.choice !== "insert" || !b.visual) continue;
    const who = cardSpeakers(b, map);
    if (who.error) { out.push({ name: "unknown-attribution", severity: "critical", beat: b.id, detail: who.error, fix: "attribute the quote to the speaker who said it, by the name the transcript uses" }); continue; }
    const names = (ids: string[]) => ids.map(id => map.speakers.find(s => s.id === id)?.name ?? id).join(" or ");
    const words = onCardWords(b.visual);
    const check = (line: string, mode: "quoted" | "cut") => {
      const saidBy = whoSays(line, doc, mode);
      if (who.ids.length === 0 ? saidBy.length > 0 : saidBy.some(s => who.ids.includes(s))) return;
      if (saidBy.length > 0) {
        out.push({ name: "wrong-speaker", severity: "critical", beat: b.id, detail: `"${line}" is ${names(saidBy)}'s words, but the card gives it to ${names(who.ids)} (from its ${who.from})`, fix: "attribute the words to the person who said them, or use the card speaker's own words" });
      } else if (mode === "quoted") {
        out.push({ name: "not-verbatim", severity: "critical", beat: b.id, detail: `quoted on-card text "${line}" is not ${who.ids.length ? names(who.ids) + "'s" : "anyone's"} exact words in the transcript`, fix: "copy the words exactly from the transcript; mark dropped words with an ellipsis" });
      } else {
        out.push({ name: "not-the-speakers-words", severity: "major", beat: b.id, detail: `"${line}" is not ${who.ids.length ? names(who.ids) + "'s" : "anyone's"} words cut down (words must come from the transcript in order, none added)`, fix: "cut the speaker's own sentence down; never reword it" });
      }
    };
    for (const line of words.quoted) check(line, "quoted");
    for (const line of words.cut) check(line, "cut");
  }
  return out;
}

// ─────────────────────────────────────────────────────────────── live demos

/** demos.json: stretches (final-cut seconds) where the thing being discussed is already on screen. */
export interface Demo extends Span { what?: string }
export interface Demos { demos: Demo[] }

export function validateDemos(input: unknown): string[] {
  const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  if (!isObj(input) || !Array.isArray(input.demos)) return ["demos.json must be { demos: [{ start, end, what? }] }"];
  const errs: string[] = [];
  input.demos.forEach((d, i) => {
    if (!isObj(d) || typeof d.start !== "number" || typeof d.end !== "number" || !Number.isFinite(d.start) || !Number.isFinite(d.end) || !(d.start < d.end)) errs.push(`demo ${i}: needs start<end in seconds`);
    else if (d.what !== undefined && typeof d.what !== "string") errs.push(`demo ${i}: what must be a string`);
  });
  return errs;
}

export function loadDemos(path: string): Demos {
  let j: unknown;
  try { j = JSON.parse(readFileSync(path, "utf8")); } catch (e) { throw new SourceError(`cannot read demos ${path}: ${(e as Error).message}`); }
  const errs = validateDemos(j);
  if (errs.length) throw new SourceError(`demos ${path} is invalid: ${errs.join("; ")}`);
  return j as Demos;
}

export const overlaps = (a: Span, b: Span): boolean => a.start < b.end && b.start < a.end;

/** An insert whose span touches a live demo covers the thing the speaker is showing. */
export function demoDefects(direction: Direction, spanOf: (b: DirectionBeat) => Span | undefined, demos?: Demos): OverlayDefect[] {
  if (!demos || demos.demos.length === 0) return [];
  const out: OverlayDefect[] = [];
  for (const b of direction.beats) {
    if (b.choice !== "insert") continue;
    const s = spanOf(b);
    if (!s) continue;
    for (const d of demos.demos) if (overlaps(s, d)) out.push({
      name: "over-live-demo", severity: "critical", beat: b.id,
      detail: `insert ${s.start.toFixed(1)}–${s.end.toFixed(1)} s covers a live demo (${d.start}–${d.end} s${d.what ? `: ${d.what}` : ""}); his own screen wins`,
      fix: "stay on the speaker here, or move the insert outside the demo",
    });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────── map attribution

function spoken(doc: SourceDoc, speaker: string, span: Span): SourceBlock[] {
  return doc.blocks.filter(b => b.speaker === speaker && b.start !== undefined && b.end !== undefined && overlaps({ start: b.start, end: b.end }, span));
}

/**
 * A speaker-labelled MeaningMap must say who makes each claim, and the record must
 * hold against the transcript: the claim's speaker talks inside the units that make
 * it, a unit's speaker talks inside the unit, and a unit's keyLine is its speaker's
 * own sentence. Returned as repair errors for the map pass.
 */
export function mapSpeakerErrors(map: MeaningMap, doc: SourceDoc): string[] {
  if (!hasSpeakerLabels(doc)) return [];
  const errs: string[] = [];
  const docIds = new Set(doc.blocks.map(b => b.speaker as string));
  const mapIds = new Set(map.speakers.map(s => s.id));
  for (const id of docIds) if (!mapIds.has(id)) errs.push(`speakers must list '${id}', who speaks in the transcript (use the transcript's speaker ids)`);
  for (const id of mapIds) if (!docIds.has(id)) errs.push(`speaker '${id}' never speaks in the transcript`);
  const units = new Map(map.units.map(u => [u.id, u]));
  const spanOf = (id: string): Span | undefined => { const a = units.get(id)?.anchor; return a && "span" in a ? a.span : undefined; };

  for (const c of map.claims) {
    if (!c.speaker) { errs.push(`claim ${c.id} names no speaker; the transcript is speaker-labelled, so every claim records who makes it`); continue; }
    const where = c.madeIn.map(spanOf).filter((s): s is Span => !!s);
    if (where.length && !where.some(s => spoken(doc, c.speaker as string, s).length > 0)) {
      errs.push(`claim ${c.id} is attributed to '${c.speaker}', who says nothing in its units (${c.madeIn.join(", ")})`);
    }
  }
  const turns = speakerTurns(doc);
  for (const u of map.units) {
    if (!u.speaker) { errs.push(`unit ${u.id} names no speaker; the transcript is speaker-labelled`); continue; }
    const s = spanOf(u.id);
    if (s && spoken(doc, u.speaker, s).length === 0) errs.push(`unit ${u.id} is attributed to '${u.speaker}', who says nothing between ${s.start} and ${s.end} s`);
    if (u.keyLine && !saysVerbatim(u.keyLine, turns.filter(t => t.speaker === u.speaker).map(t => t.text))) {
      const other = turns.filter(t => t.speaker !== u.speaker && saysVerbatim(u.keyLine as string, [t.text])).map(t => t.speaker);
      errs.push(`unit ${u.id}: keyLine is not ${u.speaker}'s words${other.length ? ` (${[...new Set(other)].join(", ")} said it)` : ""}`);
    }
  }
  return errs;
}
