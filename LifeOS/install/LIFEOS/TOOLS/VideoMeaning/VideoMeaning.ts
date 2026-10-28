#!/usr/bin/env bun
/**
 * VideoMeaning — the meaning layer for video: decompose a piece of content into a
 * MeaningMap, direct every beat from it, and review the plan before any render.
 * Engine-agnostic: shared upstream of optional VideoEssay (voice, essay) and Video (overlay) consumers.
 * Those consumers are NOT in the public release payload; this tool works without them.
 *
 *   bun VideoMeaning.ts map      --source <post.json|transcript.json|file.md> --out MeaningMap.json
 *   bun VideoMeaning.ts direct   --map MeaningMap.json --mode voice|essay|overlay [--timeline timeline.json] [--faces faces.json] --out Direction.json [--revise N [--polish]]
 *   bun VideoMeaning.ts review   --map MeaningMap.json --direction Direction.json [--timeline …] [--faces …] --out review.json
 *   bun VideoMeaning.ts revise   --map MeaningMap.json --direction Direction.json --rounds N [--polish] [--review review.json] [--timeline …] [--faces …] --out Direction.json
 *
 * --polish: after a pass, one more revision against the defects the passing review
 * still names; the polished plan is kept only when its own review still passes.
 * --demos demos.json (overlay, on direct/review/revise): stretches where the thing is already on
 * screen ({demos:[{start,end,what?}]}); the director avoids them and the lint fails an insert on one.
 *   bun VideoMeaning.ts validate --map MeaningMap.json [--direction Direction.json] [--faces faces.json]
 *
 * Model flags mirror Inference.ts: --level low|medium|high|max, --vendor anthropic|openai, --timeout <ms>.
 * They set the author lane for map/direct/revise (default: anthropic, high = Opus). The review
 * judges are fixed: Anthropic max (Fable) and OpenAI max, fallback off. --source overrides the
 * map's recorded source path for direct/review/revise.
 *
 * Exit: 0 done (review: pass) · 1 failed (review: fail, or a pass could not produce a valid plan) · 2 usage/input error.
 */

import { existsSync, readFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { normalizeLevel, resolveVendor } from "../Inference";
import {
  MODES, validateDirection, validateFaces, validateMeaningMap, validateReview, writeDirection, writeMeaningMap, writeReview,
  type Direction, type Faces, type MeaningMap, type Mode, type Review, type Span,
} from "./schema";
import { AUTHOR_LANE, directMap, inferenceModel, mapSource, reviewDirection, reviseLoop, sourceMatchesMap, type Lane, type ModelCall } from "./engine";
import { loadSource, loadTimeline, SourceError, unitSpansFromTimeline, type SourceDoc } from "./source";
import { loadDemos } from "./overlay";

class UsageError extends Error {}

interface Args { cmd: string; flags: Map<string, string> }

/** Flags that take no value. */
const BOOLEAN_FLAGS = new Set(["polish"]);

export function parseArgs(argv: string[]): Args {
  const [cmd = "", ...rest] = argv;
  const flags = new Map<string, string>();
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith("--")) throw new UsageError(`unexpected argument '${a}'`);
    if (BOOLEAN_FLAGS.has(a.slice(2))) { flags.set(a.slice(2), "true"); continue; }
    const v = rest[i + 1];
    if (v === undefined || v.startsWith("--")) throw new UsageError(`${a} needs a value`);
    flags.set(a.slice(2), v);
    i++;
  }
  return { cmd, flags };
}

function need(f: Map<string, string>, k: string): string {
  const v = f.get(k);
  if (!v) throw new UsageError(`--${k} is required`);
  return v;
}

function readJson(path: string, what: string): unknown {
  if (!existsSync(path)) throw new UsageError(`${what} not found: ${path}`);
  try { return JSON.parse(readFileSync(path, "utf8")); } catch (e) { throw new UsageError(`${what} ${path} is not JSON: ${(e as Error).message}`); }
}

export function authorLane(f: Map<string, string>): Lane {
  const timeout = f.has("timeout") ? Number.parseInt(f.get("timeout")!, 10) : AUTHOR_LANE.timeout;
  if (!Number.isFinite(timeout) || timeout <= 0) throw new UsageError(`--timeout must be a positive number of ms`);
  try {
    return {
      level: f.has("level") ? normalizeLevel(f.get("level")!.toLowerCase()) : AUTHOR_LANE.level,
      vendor: f.has("vendor") ? resolveVendor(f.get("vendor")) : AUTHOR_LANE.vendor,
      timeout,
    };
  } catch (e) { throw new UsageError((e as Error).message); }
}

function loadMap(path: string): MeaningMap {
  const m = readJson(path, "MeaningMap");
  const errs = validateMeaningMap(m);
  if (errs.length) throw new UsageError(`MeaningMap ${path} is invalid:\n  ${errs.join("\n  ")}`);
  return m as MeaningMap;
}

function loadFaces(path: string | undefined): Faces | undefined {
  if (!path) return undefined;
  const j = readJson(path, "faces");
  const errs = validateFaces(j);
  if (errs.length) throw new UsageError(`faces ${path} is invalid:\n  ${errs.join("\n  ")}`);
  return j as Faces;
}

function loadDocFor(map: MeaningMap, f: Map<string, string>, mapPath: string): SourceDoc {
  const recorded = map.source.path;
  const path = f.get("source") ?? (existsSync(recorded) ? recorded : resolve(dirname(mapPath), recorded));
  const doc = loadSource(path);
  const mismatch = sourceMatchesMap(doc, map);
  if (mismatch.length) throw new UsageError(mismatch.join("; "));
  return doc;
}

function spansFor(map: MeaningMap, f: Map<string, string>): Map<string, Span> | undefined {
  const tl = f.get("timeline");
  if (tl) {
    if (!existsSync(tl)) throw new UsageError(`timeline not found: ${tl}`);
    const spans = unitSpansFromTimeline(map.units, loadTimeline(tl));
    return spans.size ? spans : undefined;
  }
  if (map.source.kind === "transcript") return unitSpansFromTimeline(map.units, { total: map.source.duration ?? 0, beats: [] });
  return undefined;
}

function parseMode(v: string): Mode {
  if (!(MODES as readonly string[]).includes(v)) throw new UsageError(`--mode must be ${MODES.join(" | ")}`);
  return v as Mode;
}

function summarize(review: Review): string {
  const lines = [`verdict: ${review.verdict} · median ${review.median ?? "—"} (bar ${review.bar})`];
  for (const j of review.judges) lines.push(`  judge ${j.judge}: ${j.ok ? `score ${j.score}` : `FAILED ${j.error}`}${j.executedModel ? ` [${j.executedModel}]` : ""}${j.downgraded ? " ⚠ downgraded" : ""}`);
  for (const r of review.reasons) lines.push(`  reason: ${r}`);
  for (const n of review.notes) lines.push(`  note: ${n}`);
  for (const d of review.defects) lines.push(`  [${d.severity}] ${d.name}${d.beat ? ` @${d.beat}` : ""} (${d.source}): ${d.detail}`);
  return lines.join("\n");
}

const log = (msg: string) => console.error(`[VideoMeaning] ${msg}`);

export async function run(argv: string[], model: ModelCall = inferenceModel()): Promise<number> {
  const { cmd, flags: f } = parseArgs(argv);
  switch (cmd) {
    case "map": {
      const doc = loadSource(need(f, "source"));
      const out = need(f, "out");
      const lane = authorLane(f);
      log(`mapping ${doc.kind} ${doc.path} (${doc.blocks.length} blocks) on ${lane.vendor}/${lane.level}`);
      const r = await mapSource({ ...doc, path: resolve(doc.path) }, model, lane);
      if (!r.ok) { log(`no valid MeaningMap after ${r.attempts} attempt(s):\n  ${r.errors.join("\n  ")}`); return 1; }
      writeMeaningMap(out, r.value);
      log(`wrote ${out}: ${r.value.claims.length} claims, ${r.value.units.length} units (attempts ${r.attempts}${r.executedModel ? `, ${r.executedModel}` : ""})`);
      return 0;
    }
    case "direct":
    case "revise": {
      if (f.has("polish") && !(cmd === "revise" || f.has("revise"))) throw new UsageError("--polish needs a review loop: use it with direct --revise N or revise");
      const mapPath = need(f, "map");
      const map = loadMap(mapPath);
      const doc = loadDocFor(map, f, mapPath);
      const faces = loadFaces(f.get("faces"));
      const demos = f.has("demos") ? loadDemos(f.get("demos")!) : undefined;
      const unitSpans = spansFor(map, f);
      const out = need(f, "out");
      const lane = authorLane(f);
      let direction: Direction;
      let mode: Mode;
      if (cmd === "direct") {
        mode = parseMode(need(f, "mode"));
        log(`directing ${map.units.length} units in ${mode} mode on ${lane.vendor}/${lane.level}${unitSpans ? " with timing" : ""}`);
        const r = await directMap({ doc, map, mode, unitSpans, faces, demos }, model, lane);
        if (!r.ok) { log(`no valid Direction after ${r.attempts} attempt(s):\n  ${r.errors.join("\n  ")}`); return 1; }
        direction = r.value;
        writeDirection(out, direction, { map, faces });
        log(`wrote ${out}: ${direction.beats.length} beats, ${direction.beats.filter(b => b.choice === "insert").length} inserts (attempts ${r.attempts})`);
        if (!f.has("revise")) return 0;
      } else {
        const d = readJson(need(f, "direction"), "Direction");
        const errs = validateDirection(d, { map, faces });
        if (errs.length) throw new UsageError(`Direction is invalid:\n  ${errs.join("\n  ")}`);
        direction = d as Direction;
        mode = direction.mode;
      }
      const roundsArg = cmd === "direct" ? f.get("revise")! : need(f, "rounds");
      const maxRounds = Number.parseInt(roundsArg, 10);
      if (!Number.isInteger(maxRounds) || maxRounds < 0) throw new UsageError(`revision rounds must be a non-negative integer`);
      let initialReview: Review | undefined;
      if (f.has("review")) {
        const r = readJson(f.get("review")!, "review");
        const errs = validateReview(r);
        if (errs.length) throw new UsageError(`review ${f.get("review")} is invalid:\n  ${errs.join("\n  ")}`);
        initialReview = r as Review;
      }
      const roundsDir = join(dirname(resolve(out)), "rounds");
      const res = await reviseLoop({ doc, map, mode, unitSpans, faces, demos, direction, review: initialReview, maxRounds, roundsDir, authorLane: lane, log, polish: f.has("polish") }, model);
      writeDirection(out, res.direction, { map, faces });
      const reviewOut = f.get("review-out") ?? join(dirname(resolve(out)), "review.json");
      writeReview(reviewOut, res.review);
      log(`chose ${res.chosenRound === "polish" ? "the polished plan" : `round ${res.chosenRound}`}; wrote ${out} and ${reviewOut}; rounds in ${roundsDir}`);
      console.log(summarize(res.review));
      if (!res.log.passed) log(`shortfall: ${res.log.shortfall}`);
      return res.log.passed ? 0 : 1;
    }
    case "review": {
      const mapPath = need(f, "map");
      const map = loadMap(mapPath);
      const doc = loadDocFor(map, f, mapPath);
      const faces = loadFaces(f.get("faces"));
      const demos = f.has("demos") ? loadDemos(f.get("demos")!) : undefined;
      const d = readJson(need(f, "direction"), "Direction");
      const errs = validateDirection(d, { map, faces });
      if (errs.length) throw new UsageError(`Direction is invalid:\n  ${errs.join("\n  ")}`);
      const out = need(f, "out");
      log("reviewing with two judges (anthropic max, openai max)");
      const review = await reviewDirection({ doc, map, direction: d as Direction, unitSpans: spansFor(map, f), faces, demos }, model);
      writeReview(out, review);
      console.log(summarize(review));
      return review.verdict === "pass" ? 0 : 1;
    }
    case "validate": {
      const map = loadMap(need(f, "map"));
      if (f.has("direction")) {
        const errs = validateDirection(readJson(f.get("direction")!, "Direction"), { map, faces: loadFaces(f.get("faces")) });
        if (errs.length) { console.log(errs.join("\n")); return 1; }
      }
      console.log("valid");
      return 0;
    }
    default:
      throw new UsageError(`unknown command '${cmd}' — use map | direct | review | revise | validate`);
  }
}

if (import.meta.main) {
  run(process.argv.slice(2)).then(code => process.exit(code), (e: unknown) => {
    if (e instanceof UsageError || e instanceof SourceError) { console.error(`[VideoMeaning] ${e.message}`); process.exit(2); }
    console.error(e);
    process.exit(1);
  });
}

export { UsageError };
