/**
 * VideoMeaning engine: the three judgment passes (map, direct, review), the
 * deterministic plan lint, the verdict, and the revise loop.
 *
 * Every model call goes through an injected ModelCall, so the tests run a fake
 * model and the CLI runs Inference.ts. Lanes (ISA Constraints, 2026-09-24):
 *  - map and direct are the workhorse judgment: Anthropic, `high` = Opus
 *  - review is the second opinion: two independent judges, Anthropic `max`
 *    (Fable) and OpenAI `max` (Astra's model), vendor fallback off so the two
 *    stay on two vendors.
 */

import { join } from "path";
import { createHash } from "crypto";
import type { InferenceLevel, InferenceVendor } from "../Inference";
import {
  SEVERITIES, beatSpan, raceStrings, validateDirection, validateMeaningMap, writeDirection, writeReview, writeRevisionLog,
  type Defect, type Direction, type DirectionBeat, type Faces, type InsertSpec, type JudgeVerdict, type MeaningMap, type Mode,
  type PolishRecord, type Review, type RevisionLog, type RevisionRound, type Severity, type Span,
} from "./schema";
import { DIRECT_SYSTEM, MAP_SYSTEM, REVIEW_BAR, REVIEW_SYSTEM, directUserPrompt, mapUserPrompt, reviewUserPrompt } from "./prompts";
import { normText, sourceText, urlIsKnown, type SourceDoc } from "./source";
import { attributionDefects, demoDefects, mapSpeakerErrors, type Demos } from "./overlay";

// ─────────────────────────────────────────────────────────────── model seam

export interface Lane { vendor: InferenceVendor; level: InferenceLevel; timeout: number }
export interface ModelRequest { pass: "map" | "direct" | "judge"; judge?: string; system: string; user: string; lane: Lane }
export interface ModelResponse { ok: boolean; parsed?: unknown; output: string; error?: string; executedModel?: string; downgraded?: boolean; vendor?: string }
export type ModelCall = (req: ModelRequest) => Promise<ModelResponse>;

/** Map and direct: Opus. 15 minutes covers a long post on the high rung; a hung call fails loud at the bound. */
export const AUTHOR_LANE: Lane = { vendor: "anthropic", level: "high", timeout: 900_000 };
export interface JudgeLane extends Lane { id: string }
export const JUDGE_LANES: readonly JudgeLane[] = [
  { id: "anthropic", vendor: "anthropic", level: "max", timeout: 900_000 },
  { id: "openai", vendor: "openai", level: "max", timeout: 900_000 },
];
/** Bounded repair: a model answer that fails validation is sent back with its errors at most this many times. */
export const REPAIR_ATTEMPTS = 2;
/** Minimum seconds between insert starts in voice and overlay modes. */
export const MIN_INSERT_SPACING_S = 30;

/** The production ModelCall: Assay's one judge transport (JudgeCall.ts, forwarding to Inference.ts), JSON expected, vendor fallback off. */
export function inferenceModel(): ModelCall {
  return async (req) => {
    const { judgeText } = await import("../../ASSAY/JudgeCall");
    const r = await judgeText({
      systemPrompt: req.system, userPrompt: req.user, level: req.lane.level, vendor: req.lane.vendor,
      timeout: req.lane.timeout, expectJson: true, allowVendorFallback: false,
    });
    return { ok: r.success, parsed: r.parsed, output: r.output, error: r.error, executedModel: r.executedModel, downgraded: r.modelDowngraded, vendor: r.vendor };
  };
}

// ─────────────────────────────────────────────────────────────── map

export type Outcome<T> = { ok: true; value: T; attempts: number; executedModel?: string } | { ok: false; errors: string[]; attempts: number };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function assembleMap(doc: SourceDoc, parsed: unknown): MeaningMap {
  const p = isObj(parsed) ? parsed : {};
  return {
    version: 1,
    source: {
      kind: doc.kind, path: doc.path,
      ...(doc.title ? { title: doc.title } : {}), ...(doc.url ? { url: doc.url } : {}),
      ...(doc.kind === "post" ? { paragraphIds: doc.blocks.map(b => b.id) } : { duration: doc.duration }),
    },
    thesis: p.thesis as string,
    claims: (p.claims ?? []) as MeaningMap["claims"],
    units: (p.units ?? []) as MeaningMap["units"],
    arc: (p.arc ?? []) as MeaningMap["arc"],
    terms: (p.terms ?? []) as MeaningMap["terms"],
    speakers: (p.speakers ?? (doc.kind === "transcript" ? doc.speakers : [])) as MeaningMap["speakers"],
  };
}

/** keyLine must be the source's own sentence; a paraphrase is a validation failure the model repairs. */
export function keyLineErrors(map: MeaningMap, doc: SourceDoc): string[] {
  const text = sourceText(doc);
  return map.units.filter(u => u.keyLine && !text.includes(normText(u.keyLine))).map(u => `unit ${u.id}: keyLine is not verbatim from the source`);
}

export async function mapSource(doc: SourceDoc, model: ModelCall, lane: Lane = AUTHOR_LANE): Promise<Outcome<MeaningMap>> {
  let repair: string[] | undefined;
  for (let attempt = 1; attempt <= REPAIR_ATTEMPTS + 1; attempt++) {
    const r = await model({ pass: "map", system: MAP_SYSTEM, user: mapUserPrompt(doc, repair), lane });
    if (!r.ok) return { ok: false, errors: [`map call failed: ${r.error ?? "no error text"}`], attempts: attempt };
    const map = assembleMap(doc, r.parsed);
    const shapeErrs = validateMeaningMap(map);
    const errs = shapeErrs.length ? shapeErrs : [...keyLineErrors(map, doc), ...mapSpeakerErrors(map, doc)];
    if (errs.length === 0) return { ok: true, value: map, attempts: attempt, executedModel: r.executedModel };
    repair = errs;
  }
  return { ok: false, errors: repair ?? [], attempts: REPAIR_ATTEMPTS + 1 };
}

/** The source a map was built from must still be the same shape (same paragraph ids, same kind). */
export function sourceMatchesMap(doc: SourceDoc, map: MeaningMap): string[] {
  if (doc.kind !== map.source.kind) return [`source is a ${doc.kind} but the map was built from a ${map.source.kind}`];
  if (doc.kind === "post") {
    const ids = doc.blocks.map(b => b.id).join(",");
    if (ids !== (map.source.paragraphIds ?? []).join(",")) return ["the source's paragraph ids differ from the map's; rebuild the map"];
  }
  return [];
}

// ─────────────────────────────────────────────────────────────── direct

export interface DirectArgs {
  doc: SourceDoc;
  map: MeaningMap;
  mode: Mode;
  unitSpans?: Map<string, Span>;
  faces?: Faces;
  previous?: Direction;
  defects?: Defect[];
  demos?: Demos;          // overlay: stretches where the thing is already on screen
}

function union(spans: Span[]): Span | undefined {
  return spans.length ? { start: Math.min(...spans.map(s => s.start)), end: Math.max(...spans.map(s => s.end)) } : undefined;
}

export function assembleDirection(mode: Mode, parsed: unknown, map: MeaningMap, unitSpans?: Map<string, Span>): Direction {
  const p = isObj(parsed) ? parsed : {};
  const beats = (Array.isArray(p.beats) ? p.beats : []) as DirectionBeat[];
  for (const b of beats) {
    if (!isObj(b) || !Array.isArray(b.units)) continue;
    if (mode !== "overlay") delete b.span; // voice/essay timing is measured, never authored
    if (b.span === undefined) {
      const s = unitSpans ? union(b.units.map(u => unitSpans.get(u)).filter((x): x is Span => !!x)) : beatSpan(b, map);
      if (s) b.span = { start: round2(s.start), end: round2(s.end) };
    }
  }
  return { version: 1, mode, treatment: p.treatment as string, beats };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export async function directMap(args: DirectArgs, model: ModelCall, lane: Lane = AUTHOR_LANE): Promise<Outcome<Direction>> {
  let repair: string[] | undefined;
  for (let attempt = 1; attempt <= REPAIR_ATTEMPTS + 1; attempt++) {
    const r = await model({ pass: "direct", system: DIRECT_SYSTEM, user: directUserPrompt({ ...args, repair }), lane });
    if (!r.ok) return { ok: false, errors: [`direct call failed: ${r.error ?? "no error text"}`], attempts: attempt };
    const direction = assembleDirection(args.mode, r.parsed, args.map, args.unitSpans);
    const errs = validateDirection(direction, { map: args.map, faces: args.faces });
    if (errs.length === 0) return { ok: true, value: direction, attempts: attempt, executedModel: r.executedModel };
    repair = errs;
  }
  return { ok: false, errors: repair ?? [], attempts: REPAIR_ATTEMPTS + 1 };
}

// ─────────────────────────────────────────────────────────────── lint

/** Rationales that justify an insert by how it looks instead of what it carries. */
const DECORATIVE = /\b(visual interest|break(s|ing)? up|keep(s|ing)? (it|things|the viewer) (interesting|engaged|moving)|variety|eye[- ]candy|decorat\w*|pacing|something to look at|more (dynamic|engaging))\b/i;
const STOP = new Set(["the", "and", "for", "that", "this", "with", "from", "are", "was", "you", "your", "our", "its", "a", "an", "of", "to", "in", "on", "is", "it", "or", "as", "at", "by", "be", "i", "my", "me", "we", "vs"]);

function words(s: string): string[] { return normText(s).split(" ").filter(Boolean) }

/** A line is the author's when it is a substring of one block, or its words appear in order inside one block (cut down, not reworded). */
export function isAuthorsLine(line: string, doc: SourceDoc): boolean {
  const target = words(line);
  if (target.length === 0) return true;
  for (const b of doc.blocks) {
    const hay = words(`${b.heading ?? ""} ${b.text}`);
    if (` ${hay.join(" ")} `.includes(` ${target.join(" ")} `)) return true;
    let i = 0;
    for (const w of hay) if (w === target[i]) i++;
    if (i === target.length) return true;
  }
  return false;
}

/** A short label passes when every content word in it appears somewhere in the source. */
export function labelFromSource(label: string, vocab: Set<string>): boolean {
  return words(label).filter(w => w.length > 2 && !STOP.has(w)).every(w => vocab.has(w) || vocab.has(w.replace(/s$/, "")) || vocab.has(`${w}s`));
}

function numbersIn(s: string): string[] { return s.match(/\d+(?:\.\d+)?/g) ?? [] }

/** Quoted spans in prose: '…', "…" or “…”, opened after a boundary so an apostrophe inside a word never opens one. */
export function quotedSpans(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/(?:^|[\s(\[:])(?:'([^']+?)'|"([^"]+?)"|“([^”]+?)”)(?=[\s.,;:)\]!?]|$)/g)) {
    const q = (m[1] ?? m[2] ?? m[3] ?? "").trim();
    if (q) out.add(q);
  }
  return [...out];
}

function insertTexts(v: InsertSpec): { lines: string[]; labels: string[]; numbers: string[] } {
  switch (v.type) {
    case "points": return { lines: v.points, labels: v.heading ? [v.heading] : [], numbers: [] };
    case "quote": return { lines: [v.text], labels: [], numbers: [] };
    case "compare": return { lines: [v.left.text, v.right.text], labels: [v.left.label, v.right.label], numbers: [] };
    case "stat": return { lines: [], labels: [v.label], numbers: numbersIn(v.value) };
    case "diagram": return { lines: [], labels: [...v.nodes.map(n => n.label), ...v.edges.map(e => e.label ?? "")].filter(Boolean), numbers: [] };
    case "race": {
      // Endpoints and results are the author's lines (verbatim or cut down); lane labels are names.
      const r = raceStrings(v);
      return { lines: [...r.endpoints, ...r.results], labels: r.labels, numbers: [] };
    }
    case "title": return { lines: [], labels: [v.title, v.subtitle ?? ""].filter(Boolean), numbers: [] };
    case "concept": {
      // `text` is the on-screen list; a string quoted in the prose but missing from it is still checked.
      const listed = Array.isArray(v.text) ? v.text : [];
      const known = new Set(listed.map(s => normText(s)));
      const onScreen = [...listed, ...quotedSpans([v.description, ...(v.beats ?? [])].join(" ")).filter(q => !known.has(normText(q)))];
      const stat = v.fallback?.type === "stat" ? numbersIn(v.fallback.value) : [];
      return { lines: onScreen.filter(q => words(q).length >= 4), labels: onScreen.filter(q => words(q).length < 4), numbers: stat };
    }
    default: return { lines: [], labels: [], numbers: [] };
  }
}

/**
 * Deterministic plan lint: the checks a model is not needed for. Runs before and
 * beside the judges; its defects count in the verdict like theirs.
 */
export function lintDirection(direction: Direction, map: MeaningMap, doc: SourceDoc, faces?: Faces, demos?: Demos): Defect[] {
  const out: Defect[] = [];
  const add = (name: string, severity: Severity, detail: string, beat?: string, fix?: string) => out.push({ name, severity, detail, source: "lint", ...(beat ? { beat } : {}), ...(fix ? { fix } : {}) });

  for (const e of validateDirection(direction, { map, faces })) add("invalid-direction", "critical", e);
  const vocab = new Set(sourceText(doc).split(" "));
  const srcNumbers = new Set(numbersIn(doc.blocks.map(b => b.text).join(" ")));
  const hasKnownUrls = !!doc.url || doc.links.length > 0;

  for (const b of direction.beats) {
    if (b.choice !== "insert" || !b.visual) continue;
    if (DECORATIVE.test(b.rationale?.why ?? "")) add("decorative-rationale", "critical", `rationale justifies the insert by its look: "${b.rationale.why}"`, b.id, "name the claim the picture carries better than the ground, or stay on the ground");
    const t = insertTexts(b.visual);
    for (const line of t.lines) if (!isAuthorsLine(line, doc)) add("invented-words", "major", `"${line}" is not the author's words (not a verbatim line or a cut-down of one)`, b.id, "use the source sentence, cut down without rewording");
    for (const label of t.labels) if (!labelFromSource(label, vocab)) add("label-not-from-source", "minor", `label "${label}" uses words the source never says`, b.id);
    for (const n of t.numbers) if (!srcNumbers.has(n)) add("invented-number", "critical", `number ${n} does not appear in the source`, b.id);
    const url = "url" in b.visual ? (b.visual as { url?: string }).url : undefined;
    if (url && !urlIsKnown(doc, url)) {
      if (hasKnownUrls) add("unsourced-url", "major", `${url} is not the source's URL or one of its links`, b.id, "point at a URL the source names");
      else add("unverified-url", "minor", `${url} cannot be checked against the source (it names no links)`, b.id);
    }
  }

  // Footage of people: whose words each card shows, and never over a live demo.
  for (const d of [...attributionDefects(direction, map, doc), ...demoDefects(direction, b => beatSpan(b, map), demos)]) add(d.name, d.severity, d.detail, d.beat, d.fix);

  if (direction.mode !== "essay") {
    const inserts = direction.beats.filter(b => b.choice === "insert" && b.span);
    for (let i = 1; i < inserts.length; i++) {
      const gap = inserts[i].span!.start - inserts[i - 1].span!.start;
      if (gap < MIN_INSERT_SPACING_S) add("crowded-inserts", "major", `${inserts[i - 1].id} and ${inserts[i].id} start ${gap.toFixed(1)} s apart (minimum ${MIN_INSERT_SPACING_S} s)`, inserts[i].id, "keep the insert that carries the more important claim");
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────── review

function kebab(s: string): string { return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "unnamed" }

/** Shape-check one judge's answer. A malformed answer is a failed judge, never a silent pass. */
export function parseJudge(lane: JudgeLane, r: ModelResponse, beatIds: Set<string>): JudgeVerdict {
  const base: JudgeVerdict = {
    judge: lane.id, vendor: r.vendor ?? lane.vendor, requestedLevel: lane.level, ok: false, defects: [],
    ...(r.executedModel ? { executedModel: r.executedModel } : {}), ...(r.downgraded !== undefined ? { downgraded: r.downgraded } : {}),
  };
  if (!r.ok) return { ...base, error: r.error ?? "judge call failed" };
  const p = r.parsed;
  if (!isObj(p) || typeof p.score !== "number" || !Number.isFinite(p.score) || p.score < 0 || p.score > 10) return { ...base, error: "judge answer has no 0–10 score" };
  if (!Array.isArray(p.defects)) return { ...base, error: "judge answer has no defects array" };
  const defects: Defect[] = [];
  // Every defect must satisfy its schema. A judge that drops a malformed defect, or coerces an
  // unknown severity down to "major", would hide exactly what it was asked to find, so any
  // violation fails the whole answer (a failed judge fails the verdict) instead of being repaired quietly.
  for (const [i, d] of p.defects.entries()) {
    if (!isObj(d)) return { ...base, error: `judge defect #${i + 1} is not an object` };
    if (typeof d.detail !== "string" || !d.detail.trim()) return { ...base, error: `judge defect #${i + 1} has no detail text` };
    if (typeof d.severity !== "string" || !(SEVERITIES as readonly string[]).includes(d.severity)) return { ...base, error: `judge defect #${i + 1} has severity ${JSON.stringify(d.severity)}; it must be one of ${SEVERITIES.join(", ")}` };
    if (d.name !== undefined && typeof d.name !== "string") return { ...base, error: `judge defect #${i + 1} has a non-string name` };
    if (d.beat !== undefined && typeof d.beat !== "string") return { ...base, error: `judge defect #${i + 1} has a non-string beat` };
    if (d.fix !== undefined && typeof d.fix !== "string") return { ...base, error: `judge defect #${i + 1} has a non-string fix` };
    const severity = d.severity as Severity;
    const beat = typeof d.beat === "string" && beatIds.has(d.beat) ? d.beat : undefined;
    defects.push({ name: kebab(String(d.name ?? d.detail).slice(0, 60)), severity, detail: d.detail, source: lane.id, ...(beat ? { beat } : {}), ...(typeof d.fix === "string" && d.fix.trim() ? { fix: d.fix } : {}) });
  }
  return { ...base, ok: true, score: p.score, ...(typeof p.summary === "string" ? { summary: p.summary } : {}), defects };
}

export function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b), m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const SEV_RANK: Record<Severity, number> = { critical: 0, major: 1, minor: 2 };

/**
 * The verdict: pass only when every judge answered, no defect is critical, and the
 * median score meets the bar. Every other outcome fails and says why.
 */
export function decideVerdict(judges: JudgeVerdict[], lint: Defect[], bar: number = REVIEW_BAR, expectedJudges = JUDGE_LANES.length): Review {
  const defects = [...lint, ...judges.flatMap(j => j.defects)].sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity]);
  const scores = judges.filter(j => j.ok && typeof j.score === "number").map(j => j.score as number);
  const med = median(scores);
  const reasons: string[] = [];
  for (const j of judges) if (!j.ok) reasons.push(`judge ${j.judge} returned no verdict: ${j.error ?? "unknown"}`);
  if (judges.length < expectedJudges) reasons.push(`${judges.length} of ${expectedJudges} judges ran`);
  const criticals = defects.filter(d => d.severity === "critical");
  if (criticals.length) reasons.push(`${criticals.length} critical defect(s): ${[...new Set(criticals.map(d => d.name))].join(", ")}`);
  if (med === null) reasons.push("no judge scored the plan");
  else if (med < bar) reasons.push(`median ${med} is below the bar ${bar}`);
  const notes = judges.filter(j => j.downgraded).map(j => `judge ${j.judge} ran on ${j.executedModel ?? "an unknown model"}, below its requested ${j.requestedLevel} rung`);
  return { version: 1, bar, median: med, verdict: reasons.length ? "fail" : "pass", reasons, notes, judges, defects };
}

export interface ReviewArgs { doc: SourceDoc; map: MeaningMap; direction: Direction; unitSpans?: Map<string, Span>; faces?: Faces; demos?: Demos }

/**
 * What a review was made FOR. Persisted inside the review file (the schema validator ignores extra
 * keys), so a review handed back later is accepted only when every hash still matches the plan,
 * map, source and review policy it is being used for. Hashes stop an unrelated or since-edited
 * plan from riding on an old pass; they are not a signature against someone who forges the file.
 */
export interface ReviewBinding { source: string; map: string; direction: string; policy: string; context: string }
export type BoundReview = Review & { binding?: ReviewBinding };

function stable(v: unknown): string {
  if (v instanceof Map) return stable([...v.entries()].sort(([a], [b]) => String(a).localeCompare(String(b))));
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (isObj(v)) return `{${Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => `${JSON.stringify(k)}:${stable(v[k])}`).join(",")}}`;
  return JSON.stringify(v) ?? "null";
}
const sha = (v: unknown): string => createHash("sha256").update(stable(v)).digest("hex");

export function reviewBinding(args: ReviewArgs, judges: readonly JudgeLane[] = JUDGE_LANES, bar = REVIEW_BAR): ReviewBinding {
  return {
    source: sha({ kind: args.doc.kind, url: args.doc.url, links: args.doc.links, blocks: args.doc.blocks }),
    map: sha(args.map),
    direction: sha(args.direction),
    policy: sha({ bar, judges: judges.map(j => ({ id: j.id, vendor: j.vendor, level: j.level })), system: REVIEW_SYSTEM }),
    context: sha({ unitSpans: args.unitSpans ?? null, faces: args.faces ?? null, demos: args.demos ?? null }),
  };
}

/** A supplied review is usable only when it carries a binding that matches the current inputs exactly and a fresh lint finds nothing critical. */
export function suppliedReviewProblem(review: Review, args: ReviewArgs, judges: readonly JudgeLane[] = JUDGE_LANES, bar = REVIEW_BAR): string | null {
  const b = (review as BoundReview).binding;
  if (!isObj(b)) return "it carries no binding to a source, map, direction and policy";
  const now = reviewBinding(args, judges, bar);
  for (const k of ["source", "map", "direction", "policy", "context"] as const) if (b[k] !== now[k]) return `its ${k} hash does not match the current inputs`;
  const crit = lintDirection(args.direction, args.map, args.doc, args.faces, args.demos).filter(d => d.severity === "critical");
  if (crit.length) return `a fresh lint finds ${crit.length} critical defect(s): ${[...new Set(crit.map(d => d.name))].join(", ")}`;
  return null;
}

export async function reviewDirection(args: ReviewArgs, model: ModelCall, judges: readonly JudgeLane[] = JUDGE_LANES, bar = REVIEW_BAR): Promise<Review> {
  const lint = lintDirection(args.direction, args.map, args.doc, args.faces, args.demos);
  const user = reviewUserPrompt(args.doc, args.map, args.direction, args.unitSpans, { faces: args.faces, demos: args.demos });
  const beatIds = new Set(args.direction.beats.map(b => b.id));
  const verdicts = await Promise.all(judges.map(async lane => parseJudge(lane, await model({ pass: "judge", judge: lane.id, system: REVIEW_SYSTEM, user, lane }), beatIds)));
  const review: BoundReview = decideVerdict(verdicts, lint, bar, judges.length);
  review.binding = reviewBinding(args, judges, bar);
  return review;
}

// ─────────────────────────────────────────────────────────────── revise

export interface ReviseArgs extends DirectArgs {
  direction: Direction;
  review?: Review;       // the initial direction's review, when it already exists
  maxRounds: number;     // revisions allowed after round 0
  roundsDir: string;     // where every round's direction and review are recorded
  authorLane?: Lane;
  judges?: readonly JudgeLane[];
  bar?: number;
  log?: (msg: string) => void;
  /** After a pass, one more revision against the remaining defects, kept only if its review still passes. */
  polish?: boolean;
}

export interface ReviseResult { direction: Direction; review: Review; chosenRound: number | "polish"; log: RevisionLog }

/** Better round: fewer criticals, then higher median. */
function better(a: { review: Review }, b: { review: Review }): boolean {
  const ca = a.review.defects.filter(d => d.severity === "critical").length, cb = b.review.defects.filter(d => d.severity === "critical").length;
  if (a.review.verdict !== b.review.verdict) return a.review.verdict === "pass";
  if (ca !== cb) return ca < cb;
  return (a.review.median ?? -1) > (b.review.median ?? -1);
}

/**
 * Review → revise → review until the plan passes or maxRounds revisions run out.
 * Every round is written to roundsDir. The result is the best round, with a
 * shortfall stated when none passed.
 */
export async function reviseLoop(args: ReviseArgs, model: ModelCall): Promise<ReviseResult> {
  const say = args.log ?? (() => {});
  const ctx = { map: args.map, faces: args.faces };
  const rounds: RevisionRound[] = [];
  const kept: { direction: Direction; review: Review; round: number }[] = [];
  let direction = args.direction;
  // A supplied review is evidence only if it was made for exactly these inputs. Otherwise it is
  // discarded and a fresh review runs, so an old or unrelated pass can never end the loop at zero rounds.
  let supplied = args.review;
  if (supplied) {
    const problem = suppliedReviewProblem(supplied, { ...args, direction }, args.judges, args.bar);
    if (problem) { say(`supplied review not accepted (${problem}); running a fresh review`); supplied = undefined; }
  }
  let review = supplied ?? await reviewDirection({ ...args, direction }, model, args.judges, args.bar);
  let shortfall: string | undefined;

  const record = (k: number, d: Direction, r: Review) => {
    const directionPath = join(args.roundsDir, `round-${k}.direction.json`), reviewPath = join(args.roundsDir, `round-${k}.review.json`);
    writeDirection(directionPath, d, ctx);
    writeReview(reviewPath, r);
    rounds.push({ round: k, directionPath, reviewPath, verdict: r.verdict, median: r.median, criticals: r.defects.filter(x => x.severity === "critical").length, defects: r.defects.length });
    kept.push({ direction: d, review: r, round: k });
    say(`round ${k}: ${r.verdict} (median ${r.median ?? "—"}, ${r.defects.length} defects)`);
  };
  record(0, direction, review);

  for (let k = 1; k <= args.maxRounds && review.verdict === "fail"; k++) {
    const judged = review.defects.length ? review.defects : review.reasons.map(reason => ({ name: "review-failed", severity: "major" as Severity, detail: reason, source: "verdict" }));
    const next = await directMap({ ...args, previous: direction, defects: judged }, model, args.authorLane);
    if (!next.ok) { shortfall = `revision ${k} produced no valid Direction: ${next.errors.slice(0, 5).join("; ")}`; say(shortfall); break; }
    direction = next.value;
    review = await reviewDirection({ ...args, direction }, model, args.judges, args.bar);
    record(k, direction, review);
  }

  let best = kept[0];
  for (const c of kept.slice(1)) if (better(c, best)) best = c;
  const passed = rounds[rounds.length - 1].verdict === "pass";
  if (!passed && !shortfall) shortfall = `no round passed in ${args.maxRounds} revision(s); best is round ${best.round}: ${best.review.reasons.join("; ")}`;
  let result = { direction: best.direction, review: best.review, chosenRound: best.round as number | "polish" };
  let polish: PolishRecord | undefined;
  if (passed && args.polish) {
    const p = await polishRound(args, model, best, ctx, say);
    polish = p.record;
    if (p.record.kept) result = { direction: p.direction!, review: p.review!, chosenRound: "polish" };
  }
  const log: RevisionLog = { version: 1, rounds, passed, maxRounds: args.maxRounds, ...(passed ? {} : { shortfall }), ...(polish ? { polish } : {}) };
  writeRevisionLog(join(args.roundsDir, "revisions.json"), log);
  return { ...result, log };
}

/**
 * One revision against the defects a passing review still names (all non-critical
 * by construction: a critical fails the verdict). The polished plan is re-reviewed
 * and kept only when that review still passes; otherwise the passing plan stands.
 */
async function polishRound(
  args: ReviseArgs, model: ModelCall, best: { direction: Direction; review: Review }, ctx: { map: MeaningMap; faces?: Faces }, say: (m: string) => void,
): Promise<{ record: PolishRecord; direction?: Direction; review?: Review }> {
  const against = best.review.defects;
  const minor = against.filter(d => d.severity === "minor").length;
  if (against.length === 0) { say("polish: the passing review named no defects; nothing to polish"); return { record: { against: 0, kept: false, note: "the passing review named no defects" } }; }
  const next = await directMap({ ...args, previous: best.direction, defects: against }, model, args.authorLane);
  if (!next.ok) {
    const note = `polish produced no valid Direction: ${next.errors.slice(0, 5).join("; ")}`;
    say(note);
    return { record: { against: against.length, kept: false, note } };
  }
  const review = await reviewDirection({ ...args, direction: next.value }, model, args.judges, args.bar);
  const directionPath = join(args.roundsDir, "polish.direction.json"), reviewPath = join(args.roundsDir, "polish.review.json");
  writeDirection(directionPath, next.value, ctx);
  writeReview(reviewPath, review);
  const kept = review.verdict === "pass";
  const note = kept
    ? `polished against ${against.length} defect(s) (${minor} minor); the review still passes (median ${review.median}), so the polished plan is kept`
    : `polished against ${against.length} defect(s) (${minor} minor); the review failed (${review.reasons.join("; ")}), so the passing plan stands`;
  say(`polish: ${note}`);
  return { record: { against: against.length, kept, note, directionPath, reviewPath, verdict: review.verdict, median: review.median }, ...(kept ? { direction: next.value, review } : {}) };
}

