#!/usr/bin/env bun
/**
 * ScriptLint.ts — validates a run's Script.json.
 *
 *   bun ScriptLint.ts --run <slug|dir> [--require-classes motion,screenshot,scroll,zoom,code] [--json]
 *
 * Essay runs with a Meaning/Visuals.json (Meaning.ts) are also held to their Direction:
 * every directed insert appears on a beat inside its paragraphs, and no beat straddles one.
 *
 * Exit 0 when the script is well-formed; exit 1 with one line per problem otherwise.
 * Pure `lintScript()` is exported for tests.
 */
import { join } from "node:path";
import { existsSync } from "node:fs";
import { readJson, runPaths, type RunMeta, type Post } from "./Lib.ts";
import { directedVisualProblems, meaningPaths, type DirectedVisuals } from "./Meaning.ts";
import { daVoice } from "./Narrate.ts";
import { BEAT_GAP_SECONDS, MOTION_TYPES, VISUAL_TYPES, argValue, estimateSeconds, hasFlag, loadScript, resolveRunDir, visualClass, type Script, type VisualClass } from "./Lib.ts";

export interface LintResult { ok: boolean; problems: string[]; estimatedSeconds: number; classes: VisualClass[] }

const MAX_BEAT_WORDS = 90;
const MIN_BEAT_WORDS = 4;
/** The longest run of one visual type a script may hold: the same bar as the video eval set's visual-variety check. */
export const SAME_TYPE_MAX = 2;

const nonEmpty = (s: unknown): s is string => typeof s === "string" && s.trim().length > 0;

/**
 * A race: both endpoints named, 2–3 lanes, each with a label and a result (one string or non-empty pieces).
 * `gates` is an integer 2–8 (the gated dot parks at gate g-2, so fewer than two leaves it nowhere to stall).
 * `resultAt` cues each piece in beat-local seconds: one non-negative number per piece, in order.
 */
export function raceProblems(at: string, v: { from?: unknown; to?: unknown; lanes?: unknown }): string[] {
  const out: string[] = [];
  if (!nonEmpty(v.from) || !nonEmpty(v.to)) out.push(`${at}: race needs from and to`);
  if (!Array.isArray(v.lanes) || v.lanes.length < 2 || v.lanes.length > 3) return [...out, `${at}: race needs 2–3 lanes`];
  v.lanes.forEach((raw, i) => {
    const lane = (raw ?? {}) as { label?: unknown; result?: unknown; gates?: unknown; resultAt?: unknown };
    const where = `${at}: race lane ${i + 1}`;
    if (!nonEmpty(lane.label)) out.push(`${where} needs a label`);
    const pieces = typeof lane.result === "string" ? [lane.result] : Array.isArray(lane.result) ? lane.result : null;
    if (!pieces || pieces.length === 0 || !pieces.every(nonEmpty)) { out.push(`${where} needs a non-empty result (a string or non-empty pieces)`); return; }
    if (lane.gates !== undefined && !(Number.isInteger(lane.gates) && (lane.gates as number) >= 2 && (lane.gates as number) <= 8)) out.push(`${where}: gates must be an integer 2–8`);
    if (lane.resultAt === undefined) return;
    const cues = typeof lane.resultAt === "number" ? [lane.resultAt] : Array.isArray(lane.resultAt) ? lane.resultAt : null;
    if (!cues || cues.length !== pieces.length) { out.push(`${where}: resultAt needs one cue per result piece (${pieces.length})`); return; }
    if (!cues.every((c) => typeof c === "number" && Number.isFinite(c) && c >= 0)) out.push(`${where}: resultAt cues must be seconds ≥ 0`);
    else if (cues.some((c, k) => k > 0 && c < cues[k - 1])) out.push(`${where}: resultAt cues must be in order`);
  });
  return out;
}

/** `pace` is the narrating voice's speed multiplier (Narrate.ts daVoice: main's fish_speed), so the runtime estimate matches the voice that will read it. */
export function lintScript(script: Script, requireClasses: VisualClass[] = [], mode: "essay" | "voice" = "essay", post?: Post, directed?: DirectedVisuals, pace = 1): LintResult {
  const problems: string[] = [];
  if (!script.title?.trim()) problems.push("script.title missing");
  if (!/^[a-z0-9-]+$/.test(script.slug ?? "")) problems.push("script.slug must be kebab-case");
  if (mode !== "voice" && !(script.targetMinutes > 0)) problems.push("script.targetMinutes must be > 0");
  if (!script.source?.url) problems.push("script.source.url missing");
  if (!Array.isArray(script.beats) || script.beats.length === 0) {
    problems.push("script.beats empty");
    return { ok: false, problems, estimatedSeconds: 0, classes: [] };
  }
  const ids = new Set<string>();
  let est = 0;
  let chapters = 0;
  let sameTypeRun = 0;
  let lastType = "";
  const classes = new Set<VisualClass>();
  script.beats.forEach((b, i) => {
    const at = `beat[${i}]${b.id ? ` (${b.id})` : ""}`;
    if (!b.id || !/^[a-z0-9-]+$/.test(b.id)) problems.push(`${at}: id must be kebab-case`);
    if (ids.has(b.id)) problems.push(`${at}: duplicate id`);
    ids.add(b.id);
    const words = (b.narration ?? "").trim().split(/\s+/).filter(Boolean).length;
    if (words < (mode === "voice" ? 1 : MIN_BEAT_WORDS)) problems.push(`${at}: narration under ${MIN_BEAT_WORDS} words`);
    if (mode !== "voice" && words > MAX_BEAT_WORDS) problems.push(`${at}: narration over ${MAX_BEAT_WORDS} words (${words}) — split the beat`);
    est += estimateSeconds(b.narration ?? "") / pace + BEAT_GAP_SECONDS;
    if (b.chapter) chapters++;
    const v = b.visual as any;
    if (!v || !VISUAL_TYPES.has(v.type) || (mode !== "voice" && v.type === "read")) {
      problems.push(`${at}: visual.type unknown (${v?.type})`);
      return;
    }
    classes.add(visualClass(v));
    if (v.type === lastType) sameTypeRun++; else sameTypeRun = 1;
    // Three in a row is one more than the video eval set allows (VideoEval visual-variety, MOTION.sameTypeMax = 2): lint
    // refuses it here, before narration and capture spend anything on a script the render would fail.
    if (sameTypeRun === SAME_TYPE_MAX + 1 && !(mode === "voice" && v.type === "read")) problems.push(`${at}: three consecutive '${v.type}' visuals — vary the class (at most ${SAME_TYPE_MAX} in a row)`);
    lastType = v.type;
    switch (v.type) {
      case "read": if (!Array.isArray(v.paragraphs) || !v.paragraphs.length || v.paragraphs.some((id: unknown) => typeof id !== "string" || (post && !post.paragraphs.some(p => p.id === id)))) problems.push(`${at}: read needs known paragraph ids`); break;
      case "title": if (!v.title) problems.push(`${at}: title.title missing`); break;
      case "points": if (!Array.isArray(v.points) || v.points.length < 2 || v.points.length > 5) problems.push(`${at}: points needs 2–5 items`); break;
      case "compare": if (!v.left?.text || !v.right?.text) problems.push(`${at}: compare needs left.text and right.text`); break;
      case "stat": if (!v.value || !v.label) problems.push(`${at}: stat needs value and label`); break;
      case "quote": if (!v.text || !v.attribution) problems.push(`${at}: quote needs text and attribution`); break;
      case "diagram": {
        const nodeIds = new Set((v.nodes ?? []).map((n: any) => n.id));
        if (nodeIds.size < 2) problems.push(`${at}: diagram needs ≥2 nodes`);
        for (const e of v.edges ?? []) if (!nodeIds.has(e.from) || !nodeIds.has(e.to)) problems.push(`${at}: diagram edge references unknown node`);
        break;
      }
      case "race": problems.push(...raceProblems(at, v)); break;
      case "screenshot": case "scroll": if (!/^https?:\/\//.test(v.url ?? "")) problems.push(`${at}: ${v.type} needs an http(s) url`); break;
      case "zoom": if (!/^https?:\/\//.test(v.url ?? "")) problems.push(`${at}: zoom needs an http(s) url`); if (!v.selector) problems.push(`${at}: zoom needs a selector`); break;
      case "code": if (!v.code?.trim() || !v.lang) problems.push(`${at}: code needs code and lang`); break;
    }
    if ("url" in (v as object) && /^https?:\/\/([a-z0-9-]+\.)*(x\.com|twitter\.com)\//.test(v.url ?? "")) problems.push(`${at}: X/Twitter URLs are never captured`);
  });
  if (chapters === 0) problems.push("no chapters: set `chapter` on at least the opening beat");
  if (!script.beats[0]?.chapter) problems.push("first beat must open a chapter");
  const target = script.targetMinutes * 60;
  if (mode !== "voice" && (est < target * 0.75 || est > target * 1.25)) problems.push(`estimated runtime ${Math.round(est)}s is outside ±25% of target ${target}s`);
  for (const c of requireClasses) if (!classes.has(c)) problems.push(`required visual class missing: ${c}`);
  if (directed && mode === "essay") problems.push(...directedVisualProblems(script, directed));
  return { ok: problems.length === 0, problems, estimatedSeconds: est, classes: [...classes] };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const run = argValue(argv, "--run");
  if (!run) { console.error("usage: ScriptLint.ts --run <slug|dir> [--require-classes a,b,c] [--json]"); process.exit(2); }
  const dir = resolveRunDir(run);
  const req = (argValue(argv, "--require-classes") ?? "").split(",").filter(Boolean) as VisualClass[];
  const metaPath = runPaths(dir).meta;
  const mode = existsSync(metaPath) ? readJson<RunMeta>(metaPath).mode ?? "essay" : "essay";
  const post = mode === "voice" ? readJson<Post>(join(runPaths(dir).source, "post.json")) : undefined;
  const visualsPath = meaningPaths(dir).visuals;
  const directed = mode === "essay" && existsSync(visualsPath) ? readJson<DirectedVisuals>(visualsPath) : undefined;
  const result = lintScript(loadScript(dir), req, mode, post, directed, daVoice().speed ?? 1);
  if (hasFlag(argv, "--json")) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`estimated ${Math.round(result.estimatedSeconds)}s · classes: ${result.classes.join(", ")}`);
    for (const p of result.problems) console.log(`✗ ${p}`);
    if (result.ok) console.log("✓ script ok");
  }
  process.exit(result.ok ? 0 : 1);
}
