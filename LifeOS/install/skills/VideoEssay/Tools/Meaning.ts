#!/usr/bin/env bun
/**
 * Meaning.ts — the meaning stage: the run's inserts come from a reviewed Direction
 * (LIFEOS/TOOLS/VideoMeaning), never from a keyword pass or a hand-typed plan.
 *
 *   bun Meaning.ts --run <slug|dir> [--force] [--accept-review-shortfall] [--polish]
 *
 * Voice mode (a Run.ts stage, after `plan` has the timeline and before `lint`):
 *   Source/post.json → Meaning/MeaningMap.json → Meaning/Direction.json (direct --mode voice
 *   --timeline Narration/timeline.json --revise 2) with Meaning/review.json and Meaning/rounds/,
 *   then the passing Direction compiles into Plan.json and PlanBeats re-plans Script.json and
 *   timeline.json from it. A hand-written Plan.json (one this stage did not write) wins.
 *
 * Essay mode (run by the Script intent, between Argue and Script):
 *   Essay.md `## The Argument` → Meaning/argument.md → map → direct --mode essay --revise 2,
 *   then Meaning/Visuals.json: each directed beat's paragraphs and its compiled visual.
 *   ScriptLint holds Script.json to it.
 *
 * Every Direction insert compiles to a Script visual or is reported unrenderable (a concept
 * with no fallback, a book or video card): those beats stay on the ground until the
 * composition gains a form for them. Meaning/Direction.rendered.json records what each beat actually shows,
 * for the post-render critique (ArtDirection Critique.ts --direction).
 *
 * Exit: 0 done · 1 the review failed (defects printed) or a VideoMeaning pass failed · 2 usage.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { invariant } from "../../../LIFEOS/TOOLS/Invariant.ts";
import { validateDirection, type Direction, type DirectionBeat, type InsertSpec, type MeaningMap, type Review } from "../../../LIFEOS/TOOLS/VideoMeaning/schema.ts";
import { parseMarkdown } from "../../../LIFEOS/TOOLS/VideoMeaning/source.ts";
import { argValue, hasFlag, readJson, resolveRunDir, runPaths, writeJson, type Post, type RunMeta, type Script, type Visual } from "./Lib.ts";
import { planBeats, type Plan } from "./PlanBeats.ts";
import type { AlignmentResult } from "./Align.ts";

const VIDEO_MEANING = join(import.meta.dir, "..", "..", "..", "LIFEOS", "TOOLS", "VideoMeaning", "VideoMeaning.ts");
/** Revision rounds after the first review (`--revise 2`). */
export const REVISE_ROUNDS = 2;
export const HYPERFRAMES_QUEUE = "queued for the HyperFrames port";

// ─────────────────────────────────────────────────────────────── compile

export type Compiled =
  | { ok: true; visual: Visual; via?: string }
  | { ok: false; reason: string };

/**
 * One Direction insert → one Script visual, copying only the fields the Script
 * schema knows. A concept compiles to its declared fallback (whose strings the
 * VideoMeaning validator already proved are the concept's own `text`); without one
 * it has no faithful form today and is reported, never approximated.
 */
export function compileInsert(v: InsertSpec): Compiled {
  switch (v.type) {
    case "points": return { ok: true, visual: { type: "points", ...(v.heading ? { heading: v.heading } : {}), points: [...v.points] } };
    case "compare": return { ok: true, visual: { type: "compare", left: { label: v.left.label, text: v.left.text }, right: { label: v.right.label, text: v.right.text } } };
    case "stat": return { ok: true, visual: { type: "stat", value: v.value, label: v.label } };
    case "quote": return { ok: true, visual: { type: "quote", text: v.text, attribution: v.attribution } };
    case "diagram": return { ok: true, visual: { type: "diagram", nodes: v.nodes.map(n => ({ id: n.id, label: n.label })), edges: v.edges.map(e => ({ from: e.from, to: e.to, ...(e.label ? { label: e.label } : {}) })) } };
    // Cues are not authored: the renderer lands each result piece on its spoken word (PageVisuals raceCues).
    case "race": return { ok: true, visual: { type: "race", from: v.from, to: v.to, lanes: v.lanes.map(l => ({ label: l.label, result: Array.isArray(l.result) ? [...l.result] : l.result, ...(l.gates !== undefined ? { gates: l.gates } : {}) })) } };
    case "screenshot": return { ok: true, visual: { type: "screenshot", url: v.url, ...(v.selector ? { selector: v.selector } : {}), ...(v.caption ? { caption: v.caption } : {}) } };
    case "scroll": return { ok: true, visual: { type: "scroll", url: v.url, ...(v.start !== undefined ? { start: v.start } : {}), ...(v.travel !== undefined ? { travel: v.travel } : {}), ...(v.caption ? { caption: v.caption } : {}) } };
    case "zoom": return { ok: true, visual: { type: "zoom", url: v.url, selector: v.selector, ...(v.caption ? { caption: v.caption } : {}) } };
    case "code": return { ok: true, visual: { type: "code", code: v.code, lang: v.lang, ...(v.highlight ? { highlight: [...v.highlight] } : {}), ...(v.title ? { title: v.title } : {}), ...(v.caption ? { caption: v.caption } : {}) } };
    case "title": return { ok: true, visual: { type: "title", title: v.title, ...(v.subtitle ? { subtitle: v.subtitle } : {}) } };
    case "card":
      // A page card names a page the source links: a still of that page, captioned with the card's title, carries the same reference.
      if (v.kind === "page") return { ok: true, visual: { type: "screenshot", url: v.url, caption: v.title }, via: "page card → screenshot of the page" };
      return { ok: false, reason: `a ${v.kind} reference card ("${v.title}") has no form in the Script vocabulary; ${HYPERFRAMES_QUEUE}` };
    case "concept": {
      if (!v.fallback) return { ok: false, reason: `concept with no faithful existing form (no fallback): "${clip(v.description, 110)}"; ${HYPERFRAMES_QUEUE}` };
      const inner = compileInsert(v.fallback);
      invariant(inner.ok, "a concept fallback is a motion form, and every motion form compiles");
      return { ok: true, visual: inner.visual, via: `concept → its ${v.fallback.type} fallback (the animation itself is ${HYPERFRAMES_QUEUE})` };
    }
  }
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The paragraph ids a Direction beat covers, from its units' anchors. */
export function beatParagraphs(beat: DirectionBeat, map: MeaningMap): string[] {
  return beat.units.flatMap(id => {
    const u = map.units.find(x => x.id === id);
    invariant(u !== undefined, `beat ${beat.id} names unknown unit ${id}`);
    invariant("paragraphs" in u.anchor, `beat ${beat.id}: unit ${id} is not anchored to paragraphs`);
    return u.anchor.paragraphs;
  });
}

export interface CompiledBeat { id: string; paragraphs: string[]; choice: DirectionBeat["choice"]; planned?: string; visual?: Visual; via?: string; unrenderable?: string }
export interface CompileReport { beats: CompiledBeat[]; inserts: number; unrenderable: { beat: string; reason: string }[] }

export function compileDirection(direction: Direction, map: MeaningMap): CompileReport {
  const beats: CompiledBeat[] = direction.beats.map(b => {
    const base = { id: b.id, paragraphs: beatParagraphs(b, map), choice: b.choice };
    if (b.choice !== "insert") return base;
    invariant(b.visual !== undefined, `insert beat ${b.id} has no visual`);
    const c = compileInsert(b.visual);
    return c.ok ? { ...base, planned: b.visual.type, visual: c.visual, ...(c.via ? { via: c.via } : {}) } : { ...base, planned: b.visual.type, unrenderable: c.reason };
  });
  return {
    beats,
    inserts: beats.filter(b => b.visual).length,
    unrenderable: beats.filter(b => b.unrenderable).map(b => ({ beat: b.id, reason: b.unrenderable! })),
  };
}

/** Voice: Plan.json inserts, paragraph-keyed, in Direction order (the contract PlanBeats reads, unchanged). */
export function voicePlan(report: CompileReport): Plan {
  return { inserts: report.beats.filter(b => b.visual).map(b => ({ paragraphs: b.paragraphs, visual: b.visual! })) };
}

/**
 * What each beat actually shows once rendered, beside why: the Direction with every
 * compiled insert's visual replaced by the Script visual it became, the unrenderable
 * ones marked, and the carried claims spelled out. The critique judges frames against this.
 */
export function renderedDirection(direction: Direction, map: MeaningMap, report: CompileReport): unknown {
  const statement = (id: string) => map.claims.find(c => c.id === id)?.statement ?? map.units.find(u => u.id === id)?.takeaway;
  return {
    ...direction,
    beats: direction.beats.map((b, i) => {
      const c = report.beats[i];
      invariant(c.id === b.id, "compile report is in Direction order");
      const claims = b.rationale.carries.map(statement).filter((s): s is string => !!s);
      return {
        ...b,
        ...(claims.length ? { claims } : {}),
        ...(c.visual ? { visual: c.visual } : {}),
        ...(c.via ? { renderedAs: c.via } : {}),
        ...(c.unrenderable ? { unrendered: c.unrenderable } : {}),
      };
    }),
  };
}

// ─────────────────────────────────────────────────────────────── essay mode

export interface DirectedVisuals {
  version: 1;
  argument: { id: string; text: string }[];
  beats: CompiledBeat[];
}

/** Essay.md's `## The Argument` section as markdown: the narration, which is what the essay's meaning is mapped from. */
export function argumentSection(essay: string): string {
  const body = essay.replace(/^---\n[\s\S]*?\n---\n?/, "");
  const m = body.match(/^## The Argument[ \t]*\n([\s\S]*?)(?=^## |\s*$(?![\s\S]))/m);
  invariant(m !== null && m[1].trim().length > 0, "Essay.md has no `## The Argument` section to map");
  return m[1].trim() + "\n";
}

const tokens = (s: string) => s.toLowerCase().replace(/[’‘]/g, "'").replace(/[^\p{L}\p{N}'%$]+/gu, " ").trim().split(" ").filter(Boolean);

/**
 * Essay Script beats against the directed visuals. Each beat's narration is located in
 * the argument (it is the argument cut into beats), which gives its paragraphs. A beat may
 * not straddle a directed insert's edge, and every compiled insert must appear, exactly, on
 * at least one beat inside its paragraphs; which beat carries it is the Script writer's call.
 * `none` beats and unrenderable inserts leave the visual to the writer.
 */
export function directedVisualProblems(script: Script, dv: DirectedVisuals): string[] {
  const stream = dv.argument.flatMap(p => tokens(p.text).map(t => ({ t, p: p.id })));
  const beatParas: (Set<string> | null)[] = [];
  const problems: string[] = [];
  let cursor = 0;
  for (const b of script.beats) {
    const want = tokens(b.narration ?? "");
    let at = -1;
    for (let i = cursor; want.length && i + want.length <= stream.length && at < 0; i++) if (want.every((t, k) => stream[i + k].t === t)) at = i;
    if (at < 0) { problems.push(`beat ${b.id}: narration is not in order in Essay.md's ## The Argument, so its directed visual cannot be checked (Meaning/Visuals.json)`); beatParas.push(null); continue; }
    beatParas.push(new Set(stream.slice(at, at + want.length).map(x => x.p)));
    cursor = at + want.length;
  }
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  for (const d of dv.beats) {
    if (!d.visual) continue;
    const span = new Set(d.paragraphs);
    const inside: number[] = [];
    script.beats.forEach((b, i) => {
      const ps = beatParas[i];
      if (!ps || ![...ps].some(p => span.has(p))) return;
      if ([...ps].every(p => span.has(p))) inside.push(i);
      else problems.push(`beat ${b.id} straddles the edge of directed insert ${d.id} (${d.paragraphs.join(", ")}); split it at the paragraph boundary`);
    });
    if (!inside.some(i => same(script.beats[i].visual, d.visual))) problems.push(`directed insert ${d.id} (${d.visual.type} over ${d.paragraphs.join(", ")}) is carried by no beat: copy Meaning/Visuals.json's visual onto the beat whose sentence carries the claim`);
  }
  return problems;
}

// ─────────────────────────────────────────────────────────────── stage

export const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");

export interface MeaningPaths { dir: string; map: string; direction: string; review: string; rounds: string; rendered: string; compile: string; stamp: string; provenance: string; argument: string; visuals: string; plan: string }
export function meaningPaths(runDir: string): MeaningPaths {
  const dir = join(runDir, "Meaning");
  return {
    dir, map: join(dir, "MeaningMap.json"), direction: join(dir, "Direction.json"), review: join(dir, "review.json"), rounds: join(dir, "rounds"),
    rendered: join(dir, "Direction.rendered.json"), compile: join(dir, "compile.json"), stamp: join(dir, "stamp.json"), provenance: join(dir, "plan.provenance.json"),
    argument: join(dir, "argument.md"), visuals: join(dir, "Visuals.json"), plan: join(runDir, "Plan.json"),
  };
}

/** A Plan.json this stage did not write (no provenance, or its bytes changed since) is hand-written, and it wins. */
export function handWrittenPlan(p: MeaningPaths): boolean {
  if (!existsSync(p.plan)) return false;
  if (!existsSync(p.provenance)) return true;
  return readJson<{ planSha256: string }>(p.provenance).planSha256 !== sha(p.plan);
}

interface Stamp { source: string; timing?: string; revise: number; polish: boolean }

function defectLines(review: Review): string[] {
  return [
    `review: ${review.verdict} · median ${review.median ?? "—"} (bar ${review.bar})`,
    ...review.reasons.map(r => `  reason: ${r}`),
    ...review.defects.map(d => `  [${d.severity}] ${d.name}${d.beat ? ` @${d.beat}` : ""} (${d.source}): ${d.detail}${d.fix ? ` → ${d.fix}` : ""}`),
  ];
}

/** Runs one VideoMeaning command. Each model call inside it is bounded by its lane timeout (15 min) and at most three repair attempts, so the child cannot hang unbounded. */
async function videoMeaning(args: string[]): Promise<number> {
  const p = Bun.spawn(["bun", VIDEO_MEANING, ...args], { stdout: "inherit", stderr: "inherit" });
  return p.exited;
}

interface StageOpts { force: boolean; acceptShortfall: boolean; polish: boolean }

/**
 * map (when the source changed) → direct with review and revision (when source or
 * timing changed) → the review verdict decides whether to go on. Returns the exit
 * code, or the passing (or accepted) Direction with its map.
 */
async function directed(p: MeaningPaths, source: string, mode: "voice" | "essay", timeline: string | undefined, timingSha: string | undefined, opts: StageOpts): Promise<number | { map: MeaningMap; direction: Direction; review: Review }> {
  mkdirSync(p.dir, { recursive: true });
  const stamp: Stamp = { source: sha(source), ...(timingSha ? { timing: timingSha } : {}), revise: REVISE_ROUNDS, polish: opts.polish };
  const prev = existsSync(p.stamp) ? readJson<Stamp>(p.stamp) : undefined;
  const mapFresh = !opts.force && prev?.source === stamp.source && existsSync(p.map);
  const directionFresh = mapFresh && JSON.stringify(prev) === JSON.stringify(stamp) && existsSync(p.direction) && existsSync(p.review);
  if (!mapFresh) {
    console.log(`meaning: mapping ${source}`);
    const code = await videoMeaning(["map", "--source", source, "--out", p.map]);
    if (code !== 0) { console.error(`✗ VideoMeaning map failed (${code})`); return code === 2 ? 2 : 1; }
  } else console.log(`meaning: MeaningMap is current for this source (${p.map})`);
  if (!directionFresh) {
    const started = Date.now();
    const code = await videoMeaning(["direct", "--map", p.map, "--source", source, "--mode", mode, ...(timeline ? ["--timeline", timeline] : []), "--out", p.direction, "--revise", String(REVISE_ROUNDS), ...(opts.polish ? ["--polish"] : [])]);
    if (code === 2) { console.error("✗ VideoMeaning direct refused its input (exit 2)"); return 2; }
    // A review.json older than this call is a previous run's: exit 1 without a fresh one means no Direction was produced.
    if (!existsSync(p.review) || statSync(p.review).mtimeMs < started || (code !== 0 && code !== 1)) { console.error(`✗ VideoMeaning direct produced no reviewed Direction (exit ${code})`); return 1; }
    writeJson(p.stamp, stamp);
  } else console.log(`meaning: Direction and review are current for this source and timing (${p.direction})`);
  const map = readJson<MeaningMap>(p.map);
  const direction = readJson<Direction>(p.direction);
  const errs = validateDirection(direction, { map });
  if (errs.length) { console.error(`✗ Meaning/Direction.json is invalid:\n  ${errs.join("\n  ")}`); return 1; }
  const review = readJson<Review>(p.review);
  if (review.verdict !== "pass") {
    console.error(defectLines(review).join("\n"));
    if (!opts.acceptShortfall) { console.error("✗ the Direction did not pass its review; fix the plan or re-run with --accept-review-shortfall to go on with the best round"); return 1; }
    console.warn("⚠ going on with a Direction that did not pass its review (--accept-review-shortfall); the shortfall above ships with it");
  }
  return { map, direction, review };
}

function reportCompile(report: CompileReport): void {
  for (const b of report.beats) {
    if (b.visual) console.log(`  ${b.id} ${b.paragraphs.join(",")}: ${b.visual.type}${b.via ? ` (${b.via})` : ""}`);
    else if (b.unrenderable) console.log(`  ${b.id} ${b.paragraphs.join(",")}: ✗ unrenderable today, stays on the ground: ${b.unrenderable}`);
  }
}

export async function voiceStage(runDir: string, opts: StageOpts): Promise<number> {
  const paths = runPaths(runDir), p = meaningPaths(runDir);
  if (handWrittenPlan(p)) { console.log(`meaning: Plan.json is hand-written (this stage did not write it), so it wins; no Direction was compiled over it (${p.plan})`); return 0; }
  const post = join(paths.source, "post.json"), words = join(paths.narration, "words.json");
  if (!existsSync(paths.timeline) || !existsSync(words)) { console.error("✗ the meaning stage needs the plan stage's timeline: run --from plan"); return 2; }
  const r = await directed(p, post, "voice", paths.timeline, sha(words), opts);
  if (typeof r === "number") return r;
  const report = compileDirection(r.direction, r.map);
  const plan = voicePlan(report);
  writeJson(p.plan, plan);
  writeJson(p.provenance, { planSha256: sha(p.plan), direction: p.direction, directionSha256: sha(p.direction), review: r.review.verdict, compiledAt: new Date().toISOString() });
  writeJson(p.compile, report);
  writeJson(p.rendered, renderedDirection(r.direction, r.map, report));
  const result = planBeats(readJson<Post>(post), readJson<AlignmentResult>(words), readJson<RunMeta>(paths.meta), plan);
  writeJson(paths.script, result.script);
  writeJson(paths.timeline, result.timeline);
  console.log(`✓ Plan.json compiled from the Direction: ${report.inserts} insert(s), ${report.unrenderable.length} unrenderable; ${result.script.beats.length} beats tile [0, ${result.timeline.total.toFixed(3)}]`);
  reportCompile(report);
  return 0;
}

export async function essayStage(runDir: string, opts: StageOpts): Promise<number> {
  const paths = runPaths(runDir), p = meaningPaths(runDir);
  if (!existsSync(paths.essay)) { console.error("✗ essay mode maps Essay.md; run Argue first"); return 2; }
  const essay = readFileSync(paths.essay, "utf8");
  const title = essay.match(/^---\n[\s\S]*?^title:\s*["']?(.+?)["']?\s*$/m)?.[1];
  mkdirSync(p.dir, { recursive: true });
  const md = `${title ? `---\ntitle: "${title.replace(/"/g, "'")}"\n---\n` : ""}${argumentSection(essay)}`;
  if (!existsSync(p.argument) || readFileSync(p.argument, "utf8") !== md) writeFileSync(p.argument, md);
  const r = await directed(p, p.argument, "essay", undefined, undefined, opts);
  if (typeof r === "number") return r;
  const report = compileDirection(r.direction, r.map);
  const visuals: DirectedVisuals = { version: 1, argument: parseMarkdown(p.argument, md).blocks.map(b => ({ id: b.id, text: b.text })), beats: report.beats };
  writeJson(p.visuals, visuals);
  writeJson(p.compile, report);
  writeJson(p.rendered, renderedDirection(r.direction, r.map, report));
  console.log(`✓ Meaning/Visuals.json: ${report.inserts} directed insert(s), ${report.unrenderable.length} unrenderable; Script.json must carry each one (ScriptLint checks)`);
  reportCompile(report);
  return 0;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const run = argValue(argv, "--run");
  if (!run) { console.error("usage: Meaning.ts --run <slug|dir> [--force] [--accept-review-shortfall] [--polish]"); process.exit(2); }
  const dir = resolveRunDir(run);
  const meta = readJson<RunMeta>(runPaths(dir).meta);
  const opts = { force: hasFlag(argv, "--force"), acceptShortfall: hasFlag(argv, "--accept-review-shortfall"), polish: hasFlag(argv, "--polish") };
  process.exit(await (meta.mode === "voice" ? voiceStage(dir, opts) : essayStage(dir, opts)));
}
