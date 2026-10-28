/**
 * LaneQuestions.ts — the router's lane pick as small Glance questions plus deterministic code.
 *
 * The single `lane` choice asked the engine to hold every routing rule at once and pick one of seven
 * lanes; it agreed with the LLM classifier on 57% of prompts. The fix is the one in "How to Think
 * About the Difference Between Choice and Score in Jev" (2026-09-21; Jev retired 2026-10-10): ask many small questions,
 * each one a noul, and let code compose them. Each question is evaluable on its own
 * against `fixtures/lane-eval.jsonl`, and a miss is fixed by adding or sharpening a question,
 * not by growing a prompt.
 *
 * The composition mirrors Algorithm § Routing; the question wording is the only fuzzy part.
 * v1 asked one 0–4 judgment score; its levels 1 and 2 overlapped almost completely (medians 0.79
 * vs 1.01 on the gold set), so no cut point could separate them. v2 asks five small nouls instead.
 */

import type { Answer, Questions } from "../ASSAY/Engine";
import { yesAt } from "../ASSAY/Cut";
import { HEAD_EFFORTS, routedEffort, type Effort, type Lane } from "../../hooks/lib/lane-rules";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { matchDepthDirective } from "./Depth";

export const LANE_QUESTIONS: Questions = {
  wants_change: {
    type: "noul",
    instructions: "Does the prompt ask for something to be built, changed, written, fixed, generated or produced, rather than only answered or discussed?",
    criteria: { true: "asks for an artifact or a change", false: "asks a question, discusses, or chats" },
  },
  exhaustive: {
    type: "noul",
    instructions: "Does the work require finding every instance across a large corpus or codebase, where missing a single one is the failure?",
    criteria: { true: "exhaustive sweep or needle-in-a-haystack hunt", false: "a bounded task" },
  },
  blast: {
    type: "noul",
    instructions: "Does the work touch production deploys, secrets or credentials, authentication, database migrations, or data that cannot be regenerated?",
    criteria: { true: "a mistake would be expensive or irreversible", false: "a mistake is cheap to undo" },
  },
  second_look: {
    type: "noul",
    instructions: "Is the prompt asking for a review, critique, audit or second opinion of work that already exists?",
    criteria: { true: "review of existing work", false: "new work or a question" },
  },
  script_could_do: {
    type: "noul",
    instructions: "Could a careful script, codemod or find-and-replace do this work, with no reading or judgment along the way?",
    criteria: { true: "mechanical: a script could do it", false: "someone has to read or think" },
  },
  approach_decided: {
    type: "noul",
    instructions: "Is it already clear exactly what to do and how, so that only execution remains?",
    criteria: { true: "the what and the how are settled", false: "part of the job is deciding what or how" },
  },
  needs_reasoning: {
    type: "noul",
    instructions: "Does getting it right need real reasoning: subtle correctness, weighing trade-offs, or figuring out a cause?",
    criteria: { true: "an easy guess would often be wrong", false: "straightforward once you start" },
  },
  taste_or_design: {
    type: "noul",
    instructions: "Is the heart of the work judgment or taste: designing, analyzing, writing prose, or deciding what should exist?",
    criteria: { true: "the judgment is the work", false: "the judgment is incidental" },
  },
  expert_hard: {
    type: "noul",
    instructions: "Would this be hard even for a senior expert, or does it set strategy, doctrine or lasting architecture?",
    criteria: { true: "expert-hard or direction-setting", false: "within a competent practitioner's reach" },
  },
  // Effort signals: how hard the chosen model should think, independent of which model it is.
  breadth_not_depth: { type: "noul", instructions: "Is the work mostly broad coverage or volume, rather than hard thinking about one problem?", criteria: { true: "breadth or volume", false: "depth on a problem" } },
  costly_if_wrong: { type: "noul", instructions: "Would a subtly wrong result be costly, or hard to notice before it does damage?", criteria: { true: "costly or hidden errors", false: "cheap and visible errors" } },
  many_considerations: { type: "noul", instructions: "Does doing it well require weighing many interacting considerations at once?", criteria: { true: "many interacting factors", false: "few, independent factors" } },
  quick_once_understood: { type: "noul", instructions: "Once the request is understood, could it be done quickly with little deliberation?", criteria: { true: "quick once understood", false: "needs sustained thought" } },
  depth_request: { type: "noul", instructions: "Does the person explicitly ask for deep, careful or maximum-effort thinking?", criteria: { true: "asks for depth", false: "no such request" } },
  // Follow-up signals: most real prompts are short replies that take their meaning from the previous reply.
  approves_proposal: { type: "noul", instructions: "Is the prompt approving, or asking the assistant to carry out, something the assistant proposed in its previous reply?", criteria: { true: "go ahead with the proposal", false: "not an approval" } },
  reaction_only: { type: "noul", instructions: "Is the prompt only a reaction, thanks or acknowledgement, with nothing new to do?", criteria: { true: "nothing new to do", false: "asks for something" } },
  correction: { type: "noul", instructions: "Is the prompt correcting, rejecting or pushing back on what the assistant just said or did?", criteria: { true: "a correction or pushback", false: "no correction" } },
  new_topic: { type: "noul", instructions: "Does the prompt start a new request unrelated to the assistant's previous reply?", criteria: { true: "a new, unrelated request", false: "continues the previous thread" } },
};

/** The nine nouls the deterministic composer reads (the Rules applied by hand). */
export const NOULS = ["wants_change", "exhaustive", "blast", "second_look", "script_could_do", "approach_decided", "needs_reasoning", "taste_or_design", "expert_hard"] as const;
export type Noul = (typeof NOULS)[number];
/** The lane head's classes as it was trained (2026-09-24); luna and terra are retired lanes the head still names. */
export const LANES = ["inline", "luna", "terra", "sol", "opus", "fable", "astra"] as const;
/** A head class as a live lane: the retired luna class is the Haiku low rung and terra the Sonnet medium rung (2026-10-07). Retire once the head is retrained. */
export function liveLane(headClass: string): Lane {
  return headClass === "luna" ? "haiku" : headClass === "terra" ? "sonnet" : headClass as Lane;
}
/** Features the learned model reads besides the nouls, computed from the prompt itself. */
export const PROMPT_FEATURES = ["depth", "length", "has_context"] as const;

/**
 * The learned router, v2 (2026-09-24): two softmax heads, lane and effort, over all eighteen nouls
 * plus the prompt features, trained on 1,000 real typed prompts against the three-labeler majority
 * (LaneTrain.ts). The lane head hands work off only when P(hand-off) reaches `handoff_threshold`,
 * then names the likeliest non-inline lane. `cv` is session-grouped 5-fold accuracy.
 */
export type Head = { classes: string[]; weights: number[][] };
export type LaneModel = { version: 2; trained: string; features: string[]; lane: Head; effort: Head; handoff_threshold: number; l2: number; epochs: number; samples: number; cv: { lane: number; stay_handoff: number; handoff_model: number; effort: number } };
export type Prediction = { lane: Lane; p: number; pHandoff: number; effort: Effort; pEffort: number; effortProbs: Record<Effort, number> };
export type PromptContext = { prompt: string; hasContext: boolean };
let cachedModel: LaneModel | null | undefined;

const finite = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
function validHead(h: unknown, classes: readonly string[], width: number): boolean {
  if (typeof h !== "object" || h === null) return false;
  const { classes: c, weights: w } = h as Head;
  return Array.isArray(c) && c.length === classes.length && c.every((x, i) => x === classes[i]) &&
    Array.isArray(w) && w.length === classes.length && w.every(row => Array.isArray(row) && row.length === width + 1 && row.every(finite));
}

export function loadLaneModel(): LaneModel | null {
  if (cachedModel !== undefined) return cachedModel;
  try {
    const value: unknown = JSON.parse(readFileSync(join(import.meta.dir, "lane-model.json"), "utf8"));
    if (typeof value !== "object" || value === null) return cachedModel = null;
    const m = value as LaneModel;
    const known = new Set<string>([...Object.keys(LANE_QUESTIONS), ...PROMPT_FEATURES]);
    if (m.version !== 2 || typeof m.trained !== "string" || !Array.isArray(m.features) || !m.features.length || m.features.some(f => !known.has(f)) ||
        !validHead(m.lane, LANES, m.features.length) || !validHead(m.effort, HEAD_EFFORTS, m.features.length) ||
        !finite(m.handoff_threshold) || m.handoff_threshold <= 0 || m.handoff_threshold >= 1 ||
        ![m.l2, m.epochs, m.samples].every(finite) || typeof m.cv !== "object" || m.cv === null ||
        ![m.cv.lane, m.cv.stay_handoff, m.cv.handoff_model, m.cv.effort].every(finite)) return cachedModel = null;
    return cachedModel = m;
  } catch { return cachedModel = null; }
}

/** Word-count feature, log-scaled into 0..1 (a 1,000-word prompt reads as 1). */
export function lengthFeature(prompt: string): number {
  const words = prompt.trim() ? prompt.trim().split(/\s+/).length : 0;
  return Math.min(1, Math.log10(words + 1) / 3);
}

/** The model's input row, in `features` order; null when any noul answer is missing or mistyped. */
export function featureVector(features: readonly string[], answers: Record<string, Answer | undefined>, ctx: PromptContext): number[] | null {
  const x: number[] = [];
  for (const f of features) {
    if (f === "depth") x.push(matchDepthDirective(ctx.prompt) ? 1 : 0);
    else if (f === "length") x.push(lengthFeature(ctx.prompt));
    else if (f === "has_context") x.push(ctx.hasContext ? 1 : 0);
    else { const a = answers[f]; if (a?.type !== "noul" || !finite(a.noul)) return null; x.push(a.noul); }
  }
  return x;
}

export function softmax(weights: number[][], x0: number[]): number[] {
  const x = [1, ...x0];
  const z = weights.map(row => row.reduce((sum, w, i) => sum + w * x[i], 0));
  const m = Math.max(...z), e = z.map(v => Math.exp(v - m)), s = e.reduce((a, b) => a + b, 0);
  return e.map(v => v / s);
}

/** Lane and effort from the learned heads, or null when the model is absent or an answer is missing. */
export function predictLane(answers: Record<string, Answer | undefined>, ctx: PromptContext, model: LaneModel | null = loadLaneModel()): Prediction | null {
  if (!model) return null;
  const x = featureVector(model.features, answers, ctx);
  if (!x) return null;
  const pl = softmax(model.lane.weights, x), pe = softmax(model.effort.weights, x);
  const pHandoff = 1 - pl[0];
  let top = 0;
  if (pHandoff >= model.handoff_threshold) for (let i = 1; i < pl.length; i++) if (top === 0 || pl[i] > pl[top]) top = i;
  // The head still has a low class; routedEffort folds it into medium and keeps high the default.
  const { effort, probs: effortProbs } = routedEffort(Object.fromEntries(model.effort.classes.map((c, i) => [c, pe[i]])));
  return { lane: liveLane(model.lane.classes[top]), p: pl[top], pHandoff, effort, pEffort: effortProbs[effort], effortProbs };
}
export type ComposeThresholds = { noul: number; per?: Partial<Record<Noul, number>> };
/** Provisional until LaneEval calibrates them; the registry value wins once it exists. */
export const DEFAULT_THRESHOLDS: ComposeThresholds = { noul: 0.5 };

export type Composed = { lane: Lane; level: 0 | 1 | 2 | 3 | 4; flags: Record<Noul, boolean>; reason: string };

const WORK_LANE: Record<number, Lane> = { 0: "haiku", 1: "sonnet", 2: "sonnet", 3: "opus", 4: "fable" };

/** How much deciding is left, from the five judgment nouls: 0 haiku, 1 and 2 sonnet … 4 fable (the rung-by-deciding-left guardrail). */
export function judgmentLevel(f: Record<Noul, boolean>): Composed["level"] {
  if (f.expert_hard) return 4;
  if (f.taste_or_design) return 3;
  if (f.needs_reasoning) return f.approach_decided ? 2 : 3;
  if (f.script_could_do) return 0;
  return f.approach_decided ? 1 : 2;
}

/** Pure: the Rules applied to the answers. Returns null when an answer is missing or mistyped. */
export function composeLane(answers: Record<string, Answer | undefined>, t: ComposeThresholds = DEFAULT_THRESHOLDS): Composed | null {
  const flags = {} as Record<Noul, boolean>;
  for (const q of NOULS) { const a = answers[q]; if (a?.type !== "noul") return null; flags[q] = yesAt(a, t.per?.[q] ?? t.noul) === true; }
  const f = flags; const level = judgmentLevel(f);
  const done = (lane: Lane, reason: string): Composed => ({ lane, level, flags: f, reason });
  if (f.exhaustive && !f.script_could_do) return done("astra", "exhaustive coverage that needs reading (Astra rule)");
  if (level === 4) return done("fable", "hardest judgment (Fable rule, effort levels)");
  if (f.second_look && level >= 3) return done("fable", "second opinion on judgment work (Fable rule)");
  if (!f.wants_change) return done("inline", "a question or conversation (Inline rule)");
  const lane = WORK_LANE[level];
  if (f.blast && lane === "haiku") return done("sol", "blast-radius floor");
  return done(lane, `judgment level ${level} (the ladder)`);
}
