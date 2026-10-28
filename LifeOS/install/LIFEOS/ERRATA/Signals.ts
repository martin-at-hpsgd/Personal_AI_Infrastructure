// release-allow: profanity (detector vocabulary: frustration and praise signals match these words on purpose)
/**
 * @version 1.0.0
 * Signals.ts — the deterministic complaint classifier shared by the
 * SatisfactionCapture hook and the Errata store. ZERO inference.
 *
 * Owns the phrase tables the hook carried until 2026-09-17 (moved here so the
 * hook and the ledger read one dictionary). Precision-first: a miss loses a
 * row, a false positive poisons every downstream analysis.
 */

import type { Decision } from "../ASSAY/Assay";

export const POSITIVE_PRAISE_WORDS = new Set([
  'excellent', 'amazing', 'brilliant', 'fantastic', 'wonderful', 'beautiful',
  'incredible', 'awesome', 'perfect', 'great', 'nice', 'superb', 'outstanding',
  'magnificent', 'stellar', 'phenomenal', 'remarkable', 'terrific', 'splendid',
]);
export const POSITIVE_PHRASES = new Set([
  'great job', 'good job', 'nice work', 'well done', 'nice job', 'good work',
  'love it', 'nailed it', 'looks great', 'looks good', 'thats great', 'that works',
]);

/** Unambiguous correction phrases (apostrophes normalized to straight, lowercased). */
export const CORRECTION_PHRASES = [
  "that's wrong",
  "that's not what i",
  "you didn't",
  "you ignored",
  "still broken",
  "still not",
  "didn't work",
  "not what i asked",
  "stop doing",
  "again?",
  "i already told you",
  "what the fuck is wrong",
  "what is wrong with you",
  "what the fuck did you",
  "what the fuck are you",
];

export const WORK_REFERENCE = /\b(you|your|it|code|banner|test|tests|build|hook|hooks|file|page|deploy|fix|script|output|response)\b/;
export const WORK_PROFANITY = /\b(fucking|wtf|what the fuck)\b/;
export const POSITIVE_CONTEXT = /\b(great|good|nice|awesome|perfect|excellent|amazing|fantastic|beautiful|incredible|well done|love (it|this)|works|those are (good|fine|right)|that's (good|fine|right))\b/;
export const NEGATIVE_SIGNAL = /\b(wrong|broken|broke|didn'?t|doesn'?t|isn'?t|aren'?t|wasn'?t|can'?t|won'?t|not|never|nothing|anymore|no idea|fail(ed|ing|ure)?|still|missing|ignor(ed|ing)|horribl\w*|garbage|slop|shitt?y?|ass|crap|useless|stupid|dumb|retard\w*|mess|sucks?|terrible|awful|worse|supposed to)\b/;

const PROFANITY_TOKENS = /\b(fuck\w*|wtf|shit\w*|goddamn|damn(it)?|bullshit|jesus christ|christ)\b/g;
const REPEAT_MARKERS = /\b(again|how many times|for the last time|i already told you|every (single )?time|keep (doing|breaking|ignoring)|once again|yet again)\b/;
const EXCLAIM = /!{2,}/;

export function normalize(prompt: string): string {
  return prompt.trim().toLowerCase().replace(/[‘’ʼ`]/g, "'");
}

/** Returns the verbatim complaint on a hit, else null. Same contract the hook has carried since 1.3.16. */
export function detectExplicitCorrection(prompt: string): string | null {
  const trimmed = prompt.trim();
  if (trimmed.length < 10) return null;
  if (trimmed.startsWith('/')) return null;
  const norm = normalize(trimmed);
  for (const phrase of CORRECTION_PHRASES) if (norm.includes(phrase)) return trimmed;
  if (POSITIVE_CONTEXT.test(norm) && !NEGATIVE_SIGNAL.test(norm)) return null;
  if ((/^no[,.]/.test(norm) || /^nope\b/.test(norm)) && NEGATIVE_SIGNAL.test(norm)) return trimmed;
  if (WORK_PROFANITY.test(norm) && WORK_REFERENCE.test(norm) && NEGATIVE_SIGNAL.test(norm)) return trimmed;
  return null;
}

export interface FrustrationRead {
  /** 0 none · 1 displeased · 2 upset · 3 furious */
  score: 0 | 1 | 2 | 3;
  profanity: number;
  caps_ratio: number;
  repeat: boolean;
  correction: boolean;
  /** True only when the prompt is a work-directed complaint worth a ledger line. */
  fires: boolean;
}

/**
 * Pure shadow comparison; the registry cut arrives as Glance's decide() of this same answer, never as a number. Glance says
 * "yes" when decide().yes is true: the answer's raw probability of yes is at or above the cut, exactly `p >= cut` for every
 * cut. A decision that could not score the answer (unregistered question, invalid probability) is no comparison. Uses the Glance system: see
 * LIFEOS/DOCUMENTATION/Assay/AssaySystem.md. `jev_value` is the persisted comparison-ledger field name (retired 2026-10-10).
 */
export function compareGlanceSignal(answer: { type: "noul"; noul: number }, verdict: boolean | FrustrationRead, decision: Pick<Decision, "yes">): { jev_value: number; keyword_verdict: boolean } | null {
  const keyword_verdict = typeof verdict === "boolean" ? verdict : verdict.fires;
  if (decision.yes === null || !Number.isFinite(answer.noul) || answer.noul < 0 || answer.noul > 1) return null;
  return decision.yes === keyword_verdict ? null : { jev_value: answer.noul, keyword_verdict };
}

/**
 * Deterministic frustration read. `fires` is the capture decision for the
 * hook's frustration leg: profanity + work reference + negative signal, or an
 * explicit correction. `score` is the 0–3 intensity from countable signals only.
 * Praise wrapped in profanity ("great fucking job") never fires.
 */
export function frustrationRead(prompt: string): FrustrationRead {
  const trimmed = prompt.trim();
  const norm = normalize(trimmed);
  const profanity = (norm.match(PROFANITY_TOKENS) ?? []).length;
  const letters = trimmed.replace(/[^A-Za-z]/g, "");
  const caps_ratio = letters.length >= 20 ? (trimmed.replace(/[^A-Z]/g, "").length / letters.length) : 0;
  const repeat = REPEAT_MARKERS.test(norm);
  const correction = detectExplicitCorrection(trimmed) !== null;
  const negative = NEGATIVE_SIGNAL.test(norm);
  const positiveOnly = POSITIVE_CONTEXT.test(norm) && !negative && !correction;
  const workDirected = WORK_REFERENCE.test(norm);
  const fires = !positiveOnly && !trimmed.startsWith('/') && trimmed.length >= 10 &&
    (correction || (profanity > 0 && workDirected && negative));

  let score: 0 | 1 | 2 | 3 = 0;
  if (fires) {
    score = 2;
    if (profanity >= 2 || caps_ratio > 0.5 || (repeat && profanity > 0) || (EXCLAIM.test(trimmed) && profanity > 0)) score = 3;
    if (correction && profanity === 0 && !repeat && caps_ratio <= 0.5) score = 1;
  } else if (negative && workDirected && !positiveOnly) {
    score = 1;
  }
  return { score, profanity, caps_ratio: Number(caps_ratio.toFixed(2)), repeat, correction, fires };
}
