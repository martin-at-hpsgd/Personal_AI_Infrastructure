/**
 * VideoMeaning schema — the MeaningMap (what a piece of content means) and the
 * Direction (what the viewer sees at every beat, and why).
 *
 * Engine-agnostic by contract: nothing here knows about any renderer. The
 * Direction is upstream of Plan.json (VideoEssay) and cards.json (_VIDEO).
 * These optional consumers are NOT in the public release payload; this schema works without them.
 *
 * Validators return a list of human-readable errors (expected, operator-visible
 * failures: a model returned a bad plan). Writers assert validity with
 * invariant() — reaching a write with an invalid document is a programmer error.
 */

import { writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import { invariant } from "../Invariant";

// ─────────────────────────────────────────────────────────────── shared

export type SourceKind = "post" | "transcript";
export type Mode = "voice" | "essay" | "overlay";
export const MODES: readonly Mode[] = ["voice", "essay", "overlay"];

export interface Span { start: number; end: number }
/** Normalized frame rectangle: every field a fraction of the frame, 0..1. */
export interface Rect { x: number; y: number; w: number; h: number }

// ─────────────────────────────────────────────────────────────── MeaningMap

export const UNIT_ROLES = ["setup", "claim", "evidence", "example", "turn", "payoff", "aside", "list"] as const;
export type UnitRole = typeof UNIT_ROLES[number];

export interface Speaker { id: string; name: string; role?: string }

export interface Claim {
  id: string;            // c1, c2 …
  statement: string;     // the claim in one sentence
  support: string[];     // what backs it in the piece (evidence, example, experience); may be empty when the author only asserts
  madeIn: string[];      // unit ids where the claim is made or carried
  speaker?: string;      // transcripts: speaker id of who makes it
}

/** Where a unit lives in the source: paragraph ids for posts, a time span for recordings. */
export type Anchor = { paragraphs: string[] } | { span: Span };

export interface Unit {
  id: string;            // u1, u2 …
  anchor: Anchor;
  role: UnitRole;
  serves: string | null; // claim id this unit serves; required for role "claim"
  takeaway: string;      // what the audience should come away with
  keyLine?: string;      // the unit's load-bearing sentence, verbatim from the source
  speaker?: string;      // transcripts: speaker id
}

export interface ArcPoint { unit: string; feeling: string; intensity: number }
export interface Term { term: string; meaning: string }

export interface MeaningMap {
  version: 1;
  source: {
    kind: SourceKind;
    path: string;
    title?: string;
    url?: string;
    paragraphIds?: string[];   // posts: the full ordered id list, so the map validates without the source file
    duration?: number;         // transcripts: seconds
  };
  thesis: string;
  claims: Claim[];
  units: Unit[];
  arc: ArcPoint[];
  terms: Term[];
  speakers: Speaker[];
}

const nonEmpty = (s: unknown): s is string => typeof s === "string" && s.trim().length > 0;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export function isSpanAnchor(a: Anchor): a is { span: Span } { return "span" in a }
export function isParagraphAnchor(a: Anchor): a is { paragraphs: string[] } { return "paragraphs" in a }

export function validateMeaningMap(input: unknown): string[] {
  const errs: string[] = [];
  if (!isObj(input)) return ["MeaningMap is not an object"];
  const m = input as Partial<MeaningMap>;
  if (m.version !== 1) errs.push("version must be 1");
  const src = m.source;
  if (!isObj(src)) return [...errs, "source missing"];
  if (src.kind !== "post" && src.kind !== "transcript") errs.push(`source.kind '${String(src.kind)}' must be post or transcript`);
  if (!nonEmpty(src.path)) errs.push("source.path missing");
  if (src.kind === "post" && (!Array.isArray(src.paragraphIds) || src.paragraphIds.length === 0)) errs.push("source.paragraphIds required for a post");
  if (src.kind === "transcript" && !(isNum(src.duration) && src.duration > 0)) errs.push("source.duration required for a transcript");
  if (!nonEmpty(m.thesis)) errs.push("thesis missing");

  const speakers = Array.isArray(m.speakers) ? m.speakers : (errs.push("speakers must be an array"), []);
  const speakerIds = new Set<string>();
  for (const s of speakers) {
    if (!isObj(s) || !nonEmpty(s.id) || !nonEmpty(s.name)) { errs.push(`speaker ${JSON.stringify(s)} needs id and name`); continue; }
    if (speakerIds.has(s.id)) errs.push(`duplicate speaker id ${s.id}`);
    speakerIds.add(s.id);
  }
  const checkSpeaker = (where: string, sp: unknown) => {
    if (sp === undefined) return;
    if (!nonEmpty(sp) || !speakerIds.has(sp)) errs.push(`${where}: unknown speaker '${String(sp)}'`);
  };

  const units = Array.isArray(m.units) ? m.units : (errs.push("units must be an array"), []);
  if (units.length === 0) errs.push("units is empty");
  const unitIds = new Set<string>();
  for (const u of units) {
    if (!isObj(u) || !nonEmpty(u.id)) { errs.push(`unit ${JSON.stringify(u)?.slice(0, 60)} has no id`); continue; }
    if (unitIds.has(u.id)) errs.push(`duplicate unit id ${u.id}`);
    unitIds.add(u.id);
  }

  const claims = Array.isArray(m.claims) ? m.claims : (errs.push("claims must be an array"), []);
  if (claims.length === 0) errs.push("claims is empty");
  const claimIds = new Set<string>();
  for (const c of claims) {
    if (!isObj(c) || !nonEmpty(c.id)) { errs.push("claim without id"); continue; }
    if (claimIds.has(c.id)) errs.push(`duplicate claim id ${c.id}`);
    if (unitIds.has(c.id)) errs.push(`claim id ${c.id} collides with a unit id`);
    claimIds.add(c.id);
    if (!nonEmpty(c.statement)) errs.push(`claim ${c.id}: statement missing`);
    if (!Array.isArray(c.support) || !c.support.every(nonEmpty)) errs.push(`claim ${c.id}: support must be an array of strings`);
    if (!Array.isArray(c.madeIn) || c.madeIn.length === 0) errs.push(`claim ${c.id}: madeIn must name at least one unit`);
    else for (const u of c.madeIn) if (!unitIds.has(u)) errs.push(`claim ${c.id}: madeIn references unknown unit ${u}`);
    checkSpeaker(`claim ${c.id}`, c.speaker);
  }

  // Units: role, serves, takeaway, anchor order and coverage.
  const known = src.kind === "post" && Array.isArray(src.paragraphIds) ? src.paragraphIds : [];
  const pIndex = new Map(known.map((p, i) => [p, i]));
  let nextP = 0;
  let lastEnd = -Infinity;
  for (const u of units) {
    if (!isObj(u) || !nonEmpty(u.id)) continue;
    if (!(UNIT_ROLES as readonly string[]).includes(u.role as string)) errs.push(`unit ${u.id}: role '${String(u.role)}' not one of ${UNIT_ROLES.join(", ")}`);
    if (u.serves !== null && !(nonEmpty(u.serves) && claimIds.has(u.serves))) errs.push(`unit ${u.id}: serves '${String(u.serves)}' is not a claim id`);
    if (u.role === "claim" && u.serves === null) errs.push(`unit ${u.id}: a claim unit must name the claim it serves`);
    if (!nonEmpty(u.takeaway)) errs.push(`unit ${u.id}: takeaway missing`);
    if (u.keyLine !== undefined && !nonEmpty(u.keyLine)) errs.push(`unit ${u.id}: keyLine is empty`);
    checkSpeaker(`unit ${u.id}`, u.speaker);
    const a = u.anchor as unknown;
    if (!isObj(a)) { errs.push(`unit ${u.id}: anchor missing`); continue; }
    if (src.kind === "post") {
      if (!Array.isArray(a.paragraphs) || a.paragraphs.length === 0) { errs.push(`unit ${u.id}: a post unit anchors to paragraphs`); continue; }
      for (const p of a.paragraphs as unknown[]) {
        const i = pIndex.get(p as string);
        if (i === undefined) { errs.push(`unit ${u.id}: unknown paragraph ${String(p)}`); continue; }
        if (i !== nextP) errs.push(`unit ${u.id}: paragraph ${String(p)} out of order (expected ${known[nextP] ?? "end of post"})`);
        nextP = i + 1;
      }
    } else {
      const s = a.span;
      if (!isObj(s) || !isNum(s.start) || !isNum(s.end)) { errs.push(`unit ${u.id}: a transcript unit anchors to a span`); continue; }
      if (!(s.start < s.end)) errs.push(`unit ${u.id}: span start must precede end`);
      if (s.start < 0 || (isNum(src.duration) && s.end > src.duration + 0.5)) errs.push(`unit ${u.id}: span outside the recording`);
      if (s.start < lastEnd - 0.05) errs.push(`unit ${u.id}: span overlaps or precedes the previous unit`);
      lastEnd = s.end;
    }
  }
  if (src.kind === "post" && known.length > 0 && nextP !== known.length && units.length > 0) {
    errs.push(`units do not cover the post: coverage stops before ${known[nextP]}`);
  }

  const arc = Array.isArray(m.arc) ? m.arc : (errs.push("arc must be an array"), []);
  if (arc.length === 0) errs.push("arc is empty");
  const order = new Map(units.filter(isObj).map((u, i) => [u.id as string, i]));
  let lastArc = -1;
  for (const p of arc) {
    if (!isObj(p) || !nonEmpty(p.unit) || !order.has(p.unit)) { errs.push(`arc point ${JSON.stringify(p)?.slice(0, 60)} names no known unit`); continue; }
    const i = order.get(p.unit)!;
    if (i <= lastArc) errs.push(`arc point at ${p.unit} is out of order`);
    lastArc = i;
    if (!nonEmpty(p.feeling)) errs.push(`arc point at ${p.unit}: feeling missing`);
    if (!(Number.isInteger(p.intensity) && (p.intensity as number) >= 1 && (p.intensity as number) <= 5)) errs.push(`arc point at ${p.unit}: intensity must be an integer 1–5`);
  }

  const terms = Array.isArray(m.terms) ? m.terms : (errs.push("terms must be an array"), []);
  for (const t of terms) if (!isObj(t) || !nonEmpty(t.term) || !nonEmpty(t.meaning)) errs.push(`term ${JSON.stringify(t)?.slice(0, 60)} needs term and meaning`);

  return errs;
}

// ─────────────────────────────────────────────────────────────── Direction

/**
 * The insert vocabulary. Motion/capture types mirror VideoEssay ScriptSchema.md;
 * `card` is the Video Cards reference card (book | video | page); `concept` is a
 * bespoke animation described in words for the animation author to build — `name`
 * optionally points at an existing Cards concept exemplar.
 */
export const INSERT_TYPES = ["points", "compare", "stat", "quote", "diagram", "race", "screenshot", "scroll", "zoom", "code", "title", "card", "concept"] as const;
export type InsertType = typeof INSERT_TYPES[number];

/** Cards concept exemplars registered in skills/_VIDEO/Tools/Cards/Concepts.tsx (maintainer-side, not in the public release payload; CONCEPTS). Each is a reusable diagram shape named for that shape. The test suite checks this list against that file. */
export const CARD_CONCEPT_EXEMPLARS = [
  "stat-card", "layered-stack", "operator-cutaway", "control-panel", "cycle", "doorway-reveal", "branching-tree",
  "radial-axes", "notification-choice", "timeline", "hub-and-spoke", "fan-out", "pillars", "scale-ladder", "stack-to-outcome",
] as const;

/** The typographic forms every renderer draws today; a concept's `fallback` is one of these. */
export const FALLBACK_TYPES = ["points", "compare", "stat", "quote", "diagram"] as const;
export type MotionSpec =
  | { type: "points"; heading?: string; points: string[] }
  | { type: "compare"; left: { label: string; text: string }; right: { label: string; text: string } }
  | { type: "stat"; value: string; label: string }
  | { type: "quote"; text: string; attribution: string }
  | { type: "diagram"; nodes: { id: string; label: string }[]; edges: { from: string; to: string; label?: string }[] };

/**
 * A concept is a bespoke animation described in words. `text` lists every string
 * that appears on screen, verbatim from the source, so the verbatim check reads a
 * list instead of parsing prose. `fallback` is the closest existing form the
 * concept degrades to on a renderer that cannot build bespoke animation yet; it may
 * show only strings from `text` (a quote's attribution excepted). No fallback means
 * no existing form carries the claim, and the concept waits for a renderer that can.
 */
export interface ConceptSpec { type: "concept"; description: string; text: string[]; name?: string; beats?: string[]; fallback?: MotionSpec }

/**
 * A race: the same journey (from → to) taken by 2–3 lanes at different speeds. A lane with `gates` (2–8) stops at
 * each gate and waits longer every time, parking short of the finish; a lane without them sweeps straight across.
 * `result` is the lane's outcome in the author's words, one string or pieces revealed as they are spoken (the last
 * piece lands as a stamp). Every string on it is the author's. Timing is measured from the narration, never
 * authored here. Voice and essay renderers draw it; overlay (the Video cards) does not.
 */
export interface RaceSpec { type: "race"; from: string; to: string; lanes: { label: string; result: string | string[]; gates?: number }[] }

/** Every string a race puts on screen: the endpoints, each lane's label, and each lane's result, pieces joined as spoken. */
export function raceStrings(v: RaceSpec): { endpoints: string[]; labels: string[]; results: string[] } {
  return { endpoints: [v.from, v.to], labels: v.lanes.map(l => l.label), results: v.lanes.map(l => (Array.isArray(l.result) ? l.result.join(" ") : l.result)) };
}

export type InsertSpec =
  | MotionSpec
  | RaceSpec
  | { type: "screenshot"; url: string; selector?: string; caption?: string }
  | { type: "scroll"; url: string; start?: number; travel?: number; caption?: string }
  | { type: "zoom"; url: string; selector: string; caption?: string }
  | { type: "code"; code: string; lang: string; highlight?: number[]; title?: string; caption?: string }
  | { type: "title"; title: string; subtitle?: string }
  | { type: "card"; kind: "book" | "video" | "page"; title: string; subtitle?: string; url: string }
  | ConceptSpec;

/** Every string a motion form puts on screen, except a quote's attribution (who said it, not what was said). */
export function motionStrings(v: MotionSpec): string[] {
  switch (v.type) {
    case "points": return [...(v.heading ? [v.heading] : []), ...v.points];
    case "compare": return [v.left.label, v.left.text, v.right.label, v.right.text];
    case "stat": return [v.value, v.label];
    case "quote": return [v.text];
    case "diagram": return [...v.nodes.map(n => n.label), ...v.edges.flatMap(e => (e.label ? [e.label] : []))];
  }
}

export type Choice = "page" | "speaker" | "insert" | "none";

/** What each mode's viewer sees when there is no insert, and which choices are legal. */
export const MODE_CHOICES: Record<Mode, readonly Choice[]> = {
  voice: ["page", "insert"],     // The author's live post is the ground
  essay: ["insert", "none"],     // every beat is drawn; none = a quiet hold on the presence layer
  overlay: ["speaker", "insert"], // the person on camera is the ground
};
/** Modes where the author's page is the ground and the opening belongs to it. */
export const PAGE_MODES: readonly Mode[] = ["voice"];

export interface Rationale {
  carries: string[];   // claim ids and/or unit ids this beat carries
  move?: string;       // the rhetorical move, when that is what the beat carries (the turn, the payoff)
  why: string;         // why this choice beats the alternatives
}

export interface DirectionBeat {
  id: string;             // d1, d2 …
  units: string[];        // contiguous unit ids, in order
  span?: Span;            // seconds; filled from the timeline (voice) or the transcript (overlay)
  intent: string;         // what the viewer should understand or feel here
  choice: Choice;
  visual?: InsertSpec;    // present iff choice === "insert"
  placement?: Placement;  // overlay inserts: where on the frame; absent = the centered content inset
  rationale: Rationale;
}

export interface Direction {
  version: 1;
  mode: Mode;
  treatment: string;      // the visual through-line of the whole piece, in a few sentences
  beats: DirectionBeat[];
}

/** faces.json: face regions over time, normalized to the frame. A face without start/end holds for the whole video. */
export interface FaceRegion extends Rect { start?: number; end?: number; speaker?: string }

/**
 * An overlay placement. Content insets sit centered at 66% and cover the face by
 * design (the principal, 2026-08-23), so the face refusal is opt-in per placement:
 * `keepClear: true` guards every face region, a list guards those speakers' faces
 * (a 2-up pane replacement keeps the talking guest clear). Absent = no face rule.
 */
export interface Placement extends Rect { keepClear?: boolean | string[] }
export interface Faces { faces: FaceRegion[] }

const HTTP = /^https?:\/\//i;
const X_HOST = /^https?:\/\/(www\.)?(x|twitter)\.com\//i;

function validateUrl(where: string, url: unknown, errs: string[]): void {
  if (!nonEmpty(url) || !HTTP.test(url)) errs.push(`${where}: url must be http(s)`);
  else if (X_HOST.test(url)) errs.push(`${where}: X/Twitter URLs are never captured`);
}

export function validateInsertSpec(where: string, v: unknown): string[] {
  const errs: string[] = [];
  if (!isObj(v)) return [`${where}: visual missing`];
  const t = v.type as string;
  if (!(INSERT_TYPES as readonly string[]).includes(t)) return [`${where}: unknown visual type '${t}'`];
  const str = (k: string) => { if (!nonEmpty(v[k])) errs.push(`${where}: ${t}.${k} missing`); };
  switch (t) {
    case "points": {
      const p = v.points;
      if (!Array.isArray(p) || p.length < 2 || p.length > 5 || !p.every(nonEmpty)) errs.push(`${where}: points needs 2–5 non-empty points`);
      break;
    }
    case "compare":
      for (const side of ["left", "right"]) {
        const s = v[side];
        if (!isObj(s) || !nonEmpty(s.label) || !nonEmpty(s.text)) errs.push(`${where}: compare.${side} needs label and text`);
      }
      break;
    case "stat": str("value"); str("label"); break;
    case "quote": str("text"); str("attribution"); break;
    case "diagram": {
      const nodes = v.nodes, edges = v.edges;
      if (!Array.isArray(nodes) || nodes.length < 2 || nodes.length > 8) { errs.push(`${where}: diagram needs 2–8 nodes`); break; }
      const ids = new Set<string>();
      for (const n of nodes) {
        if (!isObj(n) || !nonEmpty(n.id) || !nonEmpty(n.label)) errs.push(`${where}: diagram node needs id and label`);
        else ids.add(n.id);
      }
      if (!Array.isArray(edges)) { errs.push(`${where}: diagram.edges must be an array`); break; }
      for (const e of edges) if (!isObj(e) || !ids.has(e.from as string) || !ids.has(e.to as string)) errs.push(`${where}: diagram edge ${JSON.stringify(e)} names an unknown node`);
      break;
    }
    case "race": {
      str("from"); str("to");
      const lanes = v.lanes;
      if (!Array.isArray(lanes) || lanes.length < 2 || lanes.length > 3) { errs.push(`${where}: race needs 2–3 lanes`); break; }
      lanes.forEach((l, i) => {
        if (!isObj(l) || !nonEmpty(l.label)) { errs.push(`${where}: race lane ${i + 1} needs a label`); return; }
        const r = l.result;
        if (!(nonEmpty(r) || (Array.isArray(r) && r.length > 0 && r.every(nonEmpty)))) errs.push(`${where}: race lane ${i + 1} needs a result (a string or non-empty pieces)`);
        if (l.gates !== undefined && !(Number.isInteger(l.gates) && (l.gates as number) >= 2 && (l.gates as number) <= 8)) errs.push(`${where}: race lane ${i + 1} gates must be an integer 2–8`);
      });
      break;
    }
    case "screenshot": case "scroll": validateUrl(where, v.url, errs); break;
    case "zoom": validateUrl(where, v.url, errs); str("selector"); break;
    case "code": str("code"); str("lang"); break;
    case "title": str("title"); break;
    case "card":
      if (!["book", "video", "page"].includes(v.kind as string)) errs.push(`${where}: card.kind must be book, video or page`);
      str("title"); validateUrl(where, v.url, errs);
      break;
    case "concept": {
      str("description");
      if (v.beats !== undefined && !(Array.isArray(v.beats) && v.beats.every(nonEmpty))) errs.push(`${where}: concept.beats must be strings`);
      const text = v.text;
      if (!Array.isArray(text) || !text.every(nonEmpty)) { errs.push(`${where}: concept.text must list every on-screen string (an empty list when the animation shows no words)`); break; }
      if (v.fallback === undefined) break;
      const fb = v.fallback;
      if (!isObj(fb) || !(FALLBACK_TYPES as readonly string[]).includes(fb.type as string)) { errs.push(`${where}: concept.fallback must be one of ${FALLBACK_TYPES.join(", ")}`); break; }
      const fbErrs = validateInsertSpec(`${where} fallback`, fb);
      if (fbErrs.length) { errs.push(...fbErrs); break; }
      const onScreen = new Set((text as string[]).map(s => s.trim()));
      for (const s of motionStrings(fb as MotionSpec)) if (!onScreen.has(s.trim())) errs.push(`${where}: concept.fallback shows "${s}", which is not one of concept.text`);
      break;
    }
  }
  return errs;
}

function validRect(r: unknown): r is Rect {
  if (!isObj(r)) return false;
  const { x, y, w, h } = r;
  return isNum(x) && isNum(y) && isNum(w) && isNum(h) && x >= 0 && y >= 0 && w > 0 && h > 0 && x + w <= 1.0001 && y + h <= 1.0001;
}

export function rectOverlapArea(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

export function validateFaces(input: unknown): string[] {
  if (!isObj(input) || !Array.isArray(input.faces)) return ["faces.json must be { faces: [...] }"];
  const errs: string[] = [];
  input.faces.forEach((f, i) => {
    if (!validRect(f)) errs.push(`face ${i}: x,y,w,h must be fractions of the frame`);
    const fr = f as Partial<FaceRegion>;
    if ((fr.start !== undefined && !isNum(fr.start)) || (fr.end !== undefined && !isNum(fr.end))) errs.push(`face ${i}: start/end must be seconds`);
    if (isNum(fr.start) && isNum(fr.end) && !(fr.start < fr.end)) errs.push(`face ${i}: start must precede end`);
  });
  return errs;
}

/** The span a beat occupies: its own span, else the union of its units' spans (transcripts), else undefined. */
export function beatSpan(beat: DirectionBeat, map: MeaningMap): Span | undefined {
  if (beat.span) return beat.span;
  const spans = beat.units.map(id => map.units.find(u => u.id === id)).filter((u): u is Unit => !!u && isSpanAnchor(u.anchor)).map(u => (u.anchor as { span: Span }).span);
  if (spans.length === 0) return undefined;
  return { start: Math.min(...spans.map(s => s.start)), end: Math.max(...spans.map(s => s.end)) };
}

export interface DirectionContext { map: MeaningMap; faces?: Faces }

/**
 * Validate a Direction against its MeaningMap. The refusal rules (ISA M2):
 *  - an insert whose rationale references no existing claim or unit
 *  - an insert over the opening unit in page mode
 *  - two inserts in a row with no page between them in voice mode
 *  - an overlay whose placement opts into keepClear and covers a guarded face during its span
 */
export function validateDirection(input: unknown, ctx: DirectionContext): string[] {
  const errs: string[] = [];
  if (!isObj(input)) return ["Direction is not an object"];
  const d = input as Partial<Direction>;
  if (d.version !== 1) errs.push("version must be 1");
  if (!(MODES as readonly string[]).includes(d.mode as string)) return [...errs, `mode '${String(d.mode)}' must be one of ${MODES.join(", ")}`];
  const mode = d.mode as Mode;
  if (!nonEmpty(d.treatment)) errs.push("treatment missing");
  if (!Array.isArray(d.beats) || d.beats.length === 0) return [...errs, "beats must be a non-empty array"];

  const { map } = ctx;
  const unitOrder = map.units.map(u => u.id);
  const claimIds = new Set(map.claims.map(c => c.id));
  const unitIds = new Set(unitOrder);
  const beatIds = new Set<string>();
  let nextUnit = 0;
  let prevInsert: string | null = null;

  for (const raw of d.beats) {
    if (!isObj(raw) || !nonEmpty(raw.id)) { errs.push(`beat ${JSON.stringify(raw)?.slice(0, 60)} has no id`); continue; }
    const b = raw as unknown as DirectionBeat;
    const at = `beat ${b.id}`;
    if (beatIds.has(b.id)) errs.push(`duplicate beat id ${b.id}`);
    beatIds.add(b.id);

    if (!Array.isArray(b.units) || b.units.length === 0) errs.push(`${at}: units must name at least one unit`);
    else for (const u of b.units) {
      const i = unitOrder.indexOf(u);
      if (i < 0) { errs.push(`${at}: unknown unit ${u}`); continue; }
      if (i !== nextUnit) errs.push(`${at}: unit ${u} out of order (expected ${unitOrder[nextUnit] ?? "end of map"})`);
      nextUnit = i + 1;
    }

    if (!nonEmpty(b.intent)) errs.push(`${at}: intent missing`);
    if (!(MODE_CHOICES[mode] as readonly string[]).includes(b.choice)) errs.push(`${at}: choice '${String(b.choice)}' is not legal in ${mode} mode (${MODE_CHOICES[mode].join(" | ")})`);

    const r = b.rationale as Partial<Rationale> | undefined;
    const carries = isObj(r) && Array.isArray(r.carries) ? r.carries : null;
    if (!isObj(r) || !nonEmpty(r.why)) errs.push(`${at}: rationale.why missing`);
    if (carries === null) errs.push(`${at}: rationale.carries must be an array`);
    else for (const id of carries) if (!claimIds.has(id) && !unitIds.has(id)) errs.push(`${at}: rationale names unknown id '${id}'`);
    if (isObj(r) && r.move !== undefined && !nonEmpty(r.move)) errs.push(`${at}: rationale.move is empty`);

    if (b.span !== undefined) {
      if (!isObj(b.span) || !isNum(b.span.start) || !isNum(b.span.end) || !(b.span.start < b.span.end)) errs.push(`${at}: span must be {start<end} seconds`);
      else if (Array.isArray(b.units)) {
        const own = beatSpan({ ...b, span: undefined }, map);
        if (own && (b.span.start < own.start - 0.25 || b.span.end > own.end + 0.25)) errs.push(`${at}: span ${b.span.start}–${b.span.end} falls outside its units (${own.start}–${own.end})`);
      }
    }

    const isInsert = b.choice === "insert";
    if (isInsert) {
      errs.push(...validateInsertSpec(at, b.visual));
      const grounded = (carries ?? []).some(id => claimIds.has(id) || unitIds.has(id));
      if (!grounded) errs.push(`${at}: an insert must carry an existing claim or unit — its rationale references none`);
      if ((PAGE_MODES as readonly string[]).includes(mode) && Array.isArray(b.units) && b.units.includes(unitOrder[0])) {
        errs.push(`${at}: no insert over the opening unit in ${mode} mode — the author's page opens the piece`);
      }
      if (mode === "voice" && prevInsert !== null) errs.push(`${at}: two inserts in a row (${prevInsert}, ${b.id}) with no page between them`);
      if (mode === "overlay") errs.push(...overlayFaceErrors(at, b, map, ctx.faces));
      if (mode === "overlay" && (b.visual as { type?: unknown } | undefined)?.type === "race") errs.push(`${at}: race is drawn in voice and essay mode only; overlay cards have no race`);
      if (b.placement !== undefined && !validRect(b.placement)) errs.push(`${at}: placement must be a frame-fraction rect`);
      const kc = (b.placement as Partial<Placement> | undefined)?.keepClear;
      if (kc !== undefined && typeof kc !== "boolean" && !(Array.isArray(kc) && kc.every(nonEmpty))) errs.push(`${at}: placement.keepClear must be true or a list of speaker ids`);
    } else {
      if (b.visual !== undefined) errs.push(`${at}: visual present on a '${b.choice}' beat`);
      if (b.placement !== undefined) errs.push(`${at}: placement present on a '${b.choice}' beat`);
    }
    prevInsert = isInsert ? b.id : null;
  }
  if (nextUnit !== unitOrder.length) errs.push(`beats do not cover the map: coverage stops before ${unitOrder[nextUnit]}`);
  return errs;
}

/** The face refusal, opt-in per placement (see Placement). A placement without keepClear may cover faces. */
function overlayFaceErrors(at: string, b: DirectionBeat, map: MeaningMap, faces?: Faces): string[] {
  const keep = b.placement?.keepClear;
  if (!b.placement || keep === undefined || keep === false || !validRect(b.placement)) return [];
  if (!faces || faces.faces.length === 0) return [`${at}: placement.keepClear asks to keep faces clear, but no face regions were given to check it against`];
  const guarded = keep === true ? faces.faces : faces.faces.filter(f => f.speaker !== undefined && (keep as string[]).includes(f.speaker));
  if (Array.isArray(keep)) for (const s of keep) if (!faces.faces.some(f => f.speaker === s)) return [`${at}: placement.keepClear names '${s}', but no face region belongs to that speaker`];
  const span = beatSpan(b, map);
  const errs: string[] = [];
  for (const f of guarded) {
    const during = span === undefined || f.start === undefined || f.end === undefined || (f.start < span.end && f.end > span.start);
    if (during && rectOverlapArea(b.placement, f) > 0) {
      errs.push(`${at}: overlay covers the speaker's face${f.speaker ? ` (${f.speaker})` : ""} — the speaker stays the subject`);
    }
  }
  return errs;
}

// ─────────────────────────────────────────────────────────────── Review

export type Severity = "critical" | "major" | "minor";
export const SEVERITIES: readonly Severity[] = ["critical", "major", "minor"];

export interface Defect {
  name: string;           // kebab-case defect class, e.g. decorative-insert
  severity: Severity;
  beat?: string;          // direction beat id, when the defect is local
  detail: string;
  fix?: string;
  source: string;         // "lint" or the judge id
}

export interface JudgeVerdict {
  judge: string;          // anthropic | openai
  vendor: string;
  requestedLevel: string;
  executedModel?: string;
  downgraded?: boolean;
  ok: boolean;
  error?: string;
  score?: number;         // 0–10
  summary?: string;
  defects: Defect[];
}

export interface Review {
  version: 1;
  bar: number;
  median: number | null;
  verdict: "pass" | "fail";
  reasons: string[];      // why it failed; empty on a pass
  notes: string[];        // non-failing observations (a judge that ran on a lower rung than requested)
  judges: JudgeVerdict[];
  defects: Defect[];      // every defect, lint and judges, severity-ranked
}

/** A passing review needs at least this many independent judges (distinct judge ids and vendors) that answered with a score. */
export const MIN_PASSING_JUDGES = 2;

function medianOf(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Whether a review's own judge results justify the pass it states. Recomputes the verdict from the judges instead of
 * trusting the stated median: at least MIN_PASSING_JUDGES independent judges, every judge answered with a score in 0-10,
 * the stated median equal to the median of those scores and at or above the bar, no critical defect in any judge's list.
 */
function passingReviewProblems(r: Partial<Review>): string[] {
  const errs: string[] = [];
  const judges = Array.isArray(r.judges) ? r.judges : [];
  const valid: JudgeVerdict[] = [];
  judges.forEach((j, i) => {
    const at = `judges[${i}]`;
    if (!isObj(j) || !nonEmpty(j.judge) || !nonEmpty(j.vendor) || typeof j.ok !== "boolean" || !Array.isArray(j.defects)) { errs.push(`${at} needs judge, vendor, ok and defects`); return; }
    if (!j.ok) { errs.push(`${at} (${j.judge}) returned no verdict, so the review cannot pass`); return; }
    if (!isNum(j.score) || j.score < 0 || j.score > 10) { errs.push(`${at} (${j.judge}) has no score between 0 and 10`); return; }
    if (j.defects.some(d => isObj(d) && d.severity === "critical")) errs.push(`${at} (${j.judge}) lists a critical defect, so the review cannot pass`);
    valid.push(j);
  });
  if (valid.length < MIN_PASSING_JUDGES) errs.push(`a passing review needs ${MIN_PASSING_JUDGES} scored judges, this one has ${valid.length}`);
  else if (new Set(valid.map(j => j.judge)).size < MIN_PASSING_JUDGES || new Set(valid.map(j => j.vendor)).size < MIN_PASSING_JUDGES) errs.push("a passing review needs independent judges (distinct judge ids and vendors)");
  const med = medianOf(valid.map(j => j.score as number));
  if (med === null) errs.push("a passing review needs a median computed from its judges' scores");
  else {
    if (isNum(r.median) && Math.abs(r.median - med) > 1e-9) errs.push(`stated median ${r.median} does not match the judges' scores (median ${med})`);
    if (isNum(r.bar) && med < r.bar) errs.push(`the judges' median ${med} is below the bar ${r.bar}`);
  }
  return errs;
}

export function validateReview(input: unknown): string[] {
  const errs: string[] = [];
  if (!isObj(input)) return ["Review is not an object"];
  const r = input as Partial<Review>;
  if (r.version !== 1) errs.push("version must be 1");
  if (!isNum(r.bar)) errs.push("bar missing");
  if (r.median !== null && !isNum(r.median)) errs.push("median must be a number or null");
  if (r.verdict !== "pass" && r.verdict !== "fail") errs.push("verdict must be pass or fail");
  if (!Array.isArray(r.judges)) errs.push("judges must be an array");
  if (!Array.isArray(r.notes)) errs.push("notes must be an array");
  if (!Array.isArray(r.reasons)) errs.push("reasons must be an array");
  else if ((r.verdict === "fail") !== (r.reasons.length > 0)) errs.push("a failed review states its reasons, and a passing one has none");
  if (!Array.isArray(r.defects)) errs.push("defects must be an array");
  else for (const df of r.defects) {
    if (!isObj(df) || !nonEmpty(df.name) || !(SEVERITIES as readonly string[]).includes(df.severity as string) || !nonEmpty(df.detail)) errs.push(`defect ${JSON.stringify(df)?.slice(0, 80)} needs name, severity, detail`);
  }
  if (r.verdict === "pass" && Array.isArray(r.defects) && r.defects.some(df => df.severity === "critical")) errs.push("a review with a critical defect cannot pass");
  if (r.verdict === "pass" && (r.median === null || (isNum(r.bar) && isNum(r.median) && r.median < r.bar))) errs.push("a review below the bar cannot pass");
  if (r.verdict === "pass") errs.push(...passingReviewProblems(r));
  return errs;
}

// ─────────────────────────────────────────────────────────────── writers

function writeJson(path: string, doc: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(doc, null, 2) + "\n");
}

export function writeMeaningMap(path: string, map: MeaningMap): void {
  const errs = validateMeaningMap(map);
  invariant(errs.length === 0, `refusing to write an invalid MeaningMap to ${path}: ${errs.join("; ")}`);
  writeJson(path, map);
}

export function writeDirection(path: string, direction: Direction, ctx: DirectionContext): void {
  const errs = validateDirection(direction, ctx);
  invariant(errs.length === 0, `refusing to write an invalid Direction to ${path}: ${errs.join("; ")}`);
  writeJson(path, direction);
}

export function writeReview(path: string, review: Review): void {
  const errs = validateReview(review);
  invariant(errs.length === 0, `refusing to write an invalid review to ${path}: ${errs.join("; ")}`);
  writeJson(path, review);
}

/** Revision history is a record, not a plan: it is asserted to be well-formed before it is written. */
export interface RevisionRound { round: number; directionPath: string; reviewPath: string; verdict: "pass" | "fail"; median: number | null; criticals: number; defects: number }
/** The optional polish round after a pass: one revision against the remaining defects, kept only when its review still passes. */
export interface PolishRecord { against: number; kept: boolean; note: string; directionPath?: string; reviewPath?: string; verdict?: "pass" | "fail"; median?: number | null }
export interface RevisionLog { version: 1; rounds: RevisionRound[]; passed: boolean; maxRounds: number; shortfall?: string; polish?: PolishRecord }

export function writeRevisionLog(path: string, log: RevisionLog): void {
  invariant(log.version === 1 && Array.isArray(log.rounds) && log.rounds.length > 0, `revision log for ${path} has no rounds`);
  invariant(log.rounds.every((r, i) => r.round === i), `revision log rounds must be numbered 0..n in order`);
  invariant(log.passed === (log.rounds[log.rounds.length - 1].verdict === "pass"), `revision log 'passed' must match the last round's verdict`);
  invariant(log.passed || nonEmpty(log.shortfall), `a failed revision log must state its shortfall`);
  invariant(log.polish === undefined || (log.passed && (!log.polish.kept || log.polish.verdict === "pass")), `a polish round runs only after a pass, and is kept only when it still passes`);
  writeJson(path, log);
}
