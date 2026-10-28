/**
 * ThinkingRules.ts — what the ideal thinking plan for a prompt is, in one place.
 *
 * The router's thinking leg answers three questions per prompt: whether any thinking skill is
 * worth its time, which one, and how deep (light or full). This file is the rubric: the blind
 * labelers read THINKING_RULES verbatim to write the answer key (ThinkingLabel.ts), and the docs
 * point here. The learned heads (ThinkingTrain.ts) are trained against those labels, never against
 * what the carrier happened to invoke.
 *
 * Labels are one skill (or none) plus a rare second skill. The three sequences are composed from
 * a (first, second) pair, never labeled as classes of their own: the Council review (2026-09-26)
 * counted 5–15 likely majority labels per sequence, too few for a head to learn.
 */
import { THINKING_SKILLS, type ThinkingSkill } from "./Depth";

export const SEQUENCES = {
  decide: ["FirstPrinciples", "Council"],
  diagnose: ["RootCauseAnalysis", "FirstPrinciples"],
  plan: ["Council", "RedTeam"],
} as const satisfies Record<string, readonly ThinkingSkill[]>;
export type Sequence = keyof typeof SEQUENCES;

export const SKILL_LABELS = ["none", ...THINKING_SKILLS] as const;
export type SkillLabel = (typeof SKILL_LABELS)[number];
export const MODES = ["light", "full"] as const;
export type Mode = (typeof MODES)[number];

/** The sequence a (first, second) pair forms, or null when the pair is not one of the three. */
export function sequenceFor(first: SkillLabel, second: SkillLabel | null): Sequence | null {
  if (!second || second === "none") return null;
  for (const [name, [a, b]] of Object.entries(SEQUENCES)) if (a === first && b === second) return name as Sequence;
  return null;
}

export const THINKING_RULES = `You are labeling the ideal thinking plan for one prompt the principal typed to his AI assistant. The assistant is already a strong reasoner. A thinking skill is a structured method it can run first; it costs about one to two minutes in light mode and five to twenty minutes in full mode, usually while the principal waits at the terminal.

THE GATE. Choose a skill only if the prompt states one of the shapes below AND you can name, in one short phrase, what a direct answer would get wrong without it. Importance, technicality or stakes alone never qualify. Otherwise the skill is none.

NONE (most prompts): conversation, reactions, thanks, approving what the assistant proposed ("do it", "yes", "go ahead"), corrections of the assistant's last move, lookups and factual questions, status checks, explanations of how something works, mechanical or clearly specified work however large, follow-up steps inside an approach already decided, producing an artifact whose approach is settled, and anything the principal asked to be quick. An "X or Y?" that a knowledgeable person answers in one sentence is a lookup: none. A new error whose cause is evident is none.

SKILL SHAPES (pick the one the prompt states most directly):
- Council: a recommendation among two or more options that already exist, where reasonable experts could disagree.
- BeCreative: expand the option set: many ideas, names or angles wanted; no recommendation among a fixed set.
- RedTeam: a draft, plan, design or claim already exists in the conversation and the value is finding how it fails. "What am I missing" about something already written is RedTeam.
- IterativeDepth: nothing is written yet and something substantial is about to be built whose requirements or edge cases have not been surfaced. "What am I missing" before anything exists is IterativeDepth.
- RootCauseAnalysis: a reported symptom or failure, even a recurring one, whose cause is not known. The same failure persisting after the assistant's fix is RootCauseAnalysis.
- Science: competing explanations or a claim about how things are, where gathering evidence first would tell them apart ("which of these explanations holds", "how likely is X", "is this claim true"). A comparison or change that is settled by running it and measuring ("is A faster", "does this help", "does X actually work", "make X better") is a HillClimb experiment, not a thinking skill: label it none.
- FirstPrinciples: the principal questions whether a requirement, a convention or the framing itself is needed at all ("do we even need X", "why do we do it this way").
- SystemsThinking: the principal asks why a pattern keeps happening across a class of problems, driven by feedback, incentives or many interacting parts over time; not a single incident.
- ApertureOscillation: the principal explicitly asks at which level to act: fix it locally or change the whole system.

SECOND SKILL (rare): name a second skill only when the prompt itself asks for both steps, in this order: pick one, then tear it apart (Council then RedTeam); question whether these options are even the right ones, then choose (FirstPrinciples then Council); find the cause, then rethink the fix from scratch (RootCauseAnalysis then FirstPrinciples). Otherwise second is none.

MODE (only when skill is not none):
- light: the default.
- full: only when the principal grants time or asks for depth ("think deeply", "take your time", overnight), or the prompt itself names an irreversible commitment (a release, spending money, a security boundary, a change to how a core system works) and does not ask for speed. Stakes you infer but the prompt does not state are light. "Quick" or "briefly" always means light.

When unsure between none and a skill, choose none. Use the previous assistant reply only to understand what a short prompt refers to.`;

export function isSkillLabel(v: unknown): v is SkillLabel { return typeof v === "string" && (SKILL_LABELS as readonly string[]).includes(v); }
export function isMode(v: unknown): v is Mode { return typeof v === "string" && (MODES as readonly string[]).includes(v); }
