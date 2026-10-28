/**
 * ThinkingQuestions.ts — the router's thinking leg as small Glance questions plus learned heads.
 *
 * Same shape as LaneQuestions.ts, for the same reason: one big choice asks the engine to hold every rule
 * at once, while many small nouls composed by code measured 90% against 75% on the lane pick. The
 * lane nouls already answer difficulty and stakes (needs_reasoning, expert_hard, costly_if_wrong,
 * many_considerations, depth_request, approves_proposal); these add the SHAPE of the work, one or
 * two per skill, and the time the principal is giving it.
 *
 * Three softmax heads over the lane nouls, these nouls and the prompt features
 * (thinking-model.json, ThinkingTrain.ts): `whether` (none | think), `which` (a skill or sequence,
 * trained only on prompts labeled with one), and `mode` (light | full). The rubric they learn is
 * ThinkingRules.ts.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Answer, Questions } from "../ASSAY/Engine";
import { yesAt } from "../ASSAY/Cut";
import { LANE_QUESTIONS, PROMPT_FEATURES, featureVector, softmax, type Head, type PromptContext } from "./LaneQuestions";
import { MODES, SEQUENCES, type Mode, type Sequence } from "./ThinkingRules";
import { THINKING_SKILLS, type ThinkingSkill } from "./Depth";

const noul = (instructions: string, yes: string, no: string) => ({ type: "noul" as const, instructions, criteria: { true: yes, false: no } });

export const THINKING_QUESTIONS: Questions = {
  // Shape: which method's structure fits the work (wording sharpened by the 2026-09-26 Council review).
  real_options: noul("Is the person asking for a recommendation among two or more options that already exist, where reasonable experts could disagree?", "a choice among existing options", "no open choice"),
  wants_many_ideas: noul("Does the person want many different ideas, names or angles generated, rather than a recommendation among a fixed set?", "expand the option set", "no idea generation wanted"),
  artifact_in_hand: noul("Is there already a concrete draft, plan, design or claim in the conversation that the person wants examined?", "something written to examine", "nothing written yet"),
  about_to_commit: noul("Is the person about to commit to, ship, send or publish something?", "about to commit", "not committing"),
  acts_right_after: noul("Does the prompt say the chosen option will be shipped, sent, merged or signed as soon as it is picked?", "acted on right after choosing", "no immediate action"),
  unstated_requirements: noul("Is something substantial about to be built, with nothing written yet, whose requirements or edge cases have not been surfaced?", "requirements still to discover", "requirements known or nothing to build"),
  failure_unknown_cause: noul("Is the person reporting a specific symptom or failure, possibly recurring, whose cause is not yet known?", "a failure with an unknown cause", "no unexplained failure"),
  testable_claim: noul("Is the person asking whether an idea, change or claim actually works or is better, in a way a measurement could settle?", "settle it by measuring", "not a testable claim"),
  questions_framing: noul("Does the person challenge whether the problem, a requirement or the options themselves are framed correctly or needed at all?", "challenges the framing", "accepts the framing"),
  recurring_class: noul("Is the person asking why a pattern keeps happening across a class of problems, driven by feedback, incentives or many interacting parts?", "a recurring pattern across a system", "a single case"),
  scope_level: noul("Is the person asking at which level to act: fix it locally or change the whole system?", "which level to act at", "the level is clear"),
  // Time: how long the principal is giving it. Stated, never inferred.
  asks_for_speed: noul("Does the prompt explicitly signal speed or brevity, for example 'quick', 'just', 'briefly'?", "asks for speed", "no speed signal"),
  time_granted: noul("Does the person give the work time or ask for depth, for example 'take your time', overnight, 'think deeply'?", "time or depth granted", "none granted"),
  names_irreversible: noul("Does the prompt itself name an irreversible commitment, such as a release, spending money, a security boundary, or a change to how a core system works?", "names an irreversible commitment", "names none"),
};

/** The lane nouls the thinking heads read beside their own: difficulty, stakes and follow-up signals. */
export const SHARED_LANE_NOULS = ["needs_reasoning", "expert_hard", "costly_if_wrong", "many_considerations", "depth_request", "approves_proposal", "reaction_only", "correction", "taste_or_design", "approach_decided"] as const;
/** The one shape noul per skill. */
export const SHAPE_NOUL: Record<ThinkingSkill, string> = {
  Council: "real_options", BeCreative: "wants_many_ideas", RedTeam: "artifact_in_hand", IterativeDepth: "unstated_requirements",
  RootCauseAnalysis: "failure_unknown_cause", Science: "testable_claim", FirstPrinciples: "questions_framing",
  SystemsThinking: "recurring_class", ApertureOscillation: "scope_level",
};
/** Derived input: the strongest shape answer. A linear head cannot express "any one shape is very strong" on its own (CV: precision 0.575 → 0.605, recall 0.619 → 0.632). */
export const MAX_SHAPE = "max_shape";
export const THINKING_FEATURES: string[] = [...SHARED_LANE_NOULS, ...Object.keys(THINKING_QUESTIONS), ...PROMPT_FEATURES, MAX_SHAPE];

/** The heads' input row: lane-style features plus the derived max_shape; null when any answer is missing. */
export function thinkingVector(features: readonly string[], answers: Record<string, Answer | undefined>, ctx: PromptContext): number[] | null {
  const x: number[] = [];
  for (const f of features) {
    if (f === MAX_SHAPE) {
      const vals = Object.values(SHAPE_NOUL).map((k) => answers[k]);
      if (vals.some((a) => a?.type !== "noul" || !finite(a.noul))) return null;
      x.push(Math.max(...vals.map((a) => (a as { noul: number }).noul)));
    } else { const v = featureVector([f], answers, ctx); if (!v) return null; x.push(v[0]); }
  }
  return x;
}

export const WHETHER = ["none", "think"] as const;
export const WHICH = THINKING_SKILLS;

export type ThinkingModel = {
  version: 1; trained: string; features: string[];
  whether: Head; which: Head; mode: Head;
  think_threshold: number; l2: number; epochs: number; samples: number;
  cv: Record<string, number | null>;
};
export type ThinkingPrediction = { skill: ThinkingSkill | "none"; sequence: Sequence | null; skills: ThinkingSkill[]; mode: Mode | null; pThink: number; pSkill: number; pMode: number | null };

/** A noul answer as a number, or null. */
function p(answers: Record<string, Answer | undefined>, id: string): number | null {
  const a = answers[id];
  return a?.type === "noul" && typeof a.noul === "number" && Number.isFinite(a.noul) ? a.noul : null;
}

/**
 * The second step, composed by code from the picked skill and one shape noul (sequences are too
 * sparse to learn as classes). Council + acted on right after → plan; FirstPrinciples + a real
 * choice → decide; RootCauseAnalysis + a challenged framing → diagnose. Pure.
 */
export function composeSequence(skill: ThinkingSkill, answers: Record<string, Answer | undefined>, cut = 0.5): Sequence | null {
  if (skill === "Council" && yesAt(p(answers, "acts_right_after") ?? 0, cut) === true) return "plan";
  if (skill === "FirstPrinciples" && yesAt(p(answers, "real_options") ?? 0, cut) === true) return "decide";
  if (skill === "RootCauseAnalysis" && yesAt(p(answers, "questions_framing") ?? 0, cut) === true) return "diagnose";
  return null;
}

const finite = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
function validHead(h: unknown, classes: readonly string[], width: number): boolean {
  if (typeof h !== "object" || h === null) return false;
  const { classes: c, weights: w } = h as Head;
  return Array.isArray(c) && c.length === classes.length && c.every((x, i) => x === classes[i]) &&
    Array.isArray(w) && w.length === classes.length && w.every((row) => Array.isArray(row) && row.length === width + 1 && row.every(finite));
}

export const THINKING_MODEL_PATH = join(import.meta.dir, "thinking-model.json");
let cached: ThinkingModel | null | undefined;

/** The trained heads, or null when the file is absent or malformed (the leg then stays silent). */
export function loadThinkingModel(path: string = THINKING_MODEL_PATH): ThinkingModel | null {
  if (path === THINKING_MODEL_PATH && cached !== undefined) return cached;
  let m: ThinkingModel | null = null;
  try {
    if (existsSync(path)) {
      const v = JSON.parse(readFileSync(path, "utf8")) as ThinkingModel;
      const known = new Set<string>([...Object.keys(LANE_QUESTIONS), ...Object.keys(THINKING_QUESTIONS), ...PROMPT_FEATURES, MAX_SHAPE]);
      const w = Array.isArray(v?.features) ? v.features.length : -1;
      if (v?.version === 1 && w > 0 && v.features.every((f) => known.has(f)) && validHead(v.whether, WHETHER, w) && validHead(v.which, WHICH, w) &&
          validHead(v.mode, MODES, w) && finite(v.think_threshold) && v.think_threshold > 0 && v.think_threshold < 1) m = v;
    }
  } catch { m = null; }
  if (path === THINKING_MODEL_PATH) cached = m;
  return m;
}

/** The thinking plan for one prompt, or null when the model is absent or an answer is missing. Pure given the model. */
export function predictThinking(answers: Record<string, Answer | undefined>, ctx: PromptContext, model: ThinkingModel | null = loadThinkingModel()): ThinkingPrediction | null {
  if (!model) return null;
  const x = thinkingVector(model.features, answers, ctx);
  if (!x) return null;
  const pThink = softmax(model.whether.weights, x)[1];
  if (pThink < model.think_threshold) return { skill: "none", sequence: null, skills: [], mode: null, pThink, pSkill: 1 - pThink, pMode: null };
  const pw = softmax(model.which.weights, x), pm = softmax(model.mode.weights, x);
  const i = pw.indexOf(Math.max(...pw)), j = pm.indexOf(Math.max(...pm));
  const skill = model.which.classes[i] as ThinkingSkill;
  const sequence = composeSequence(skill, answers);
  return { skill, sequence, skills: sequence ? [...SEQUENCES[sequence]] : [skill], mode: model.mode.classes[j] as Mode, pThink, pSkill: pw[i], pMode: pm[j] };
}
