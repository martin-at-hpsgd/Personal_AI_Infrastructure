/**
 * Part of the Glance system (see LIFEOS/DOCUMENTATION/Assay/AssaySystem.md). The one comparison of an engine probability to
 * a cut, kept in a leaf module with no I/O and no model call so pure composers (ERRATA/Questions, ROUTER/LaneQuestions)
 * can use it without importing the judgment layer. Assay.ts re-exports it, and decide() uses it for `yes`.
 */
import type { Answer } from "./Engine";

/**
 * The raw reading of a probability against a cut: p >= cut. Pure. Used by decide() for `yes` and by calibrators fitting a
 * cut, so a fitted cut means exactly what decide() applies. Takes a noul answer, a choice answer (probability of its
 * chosen option), a score answer with a confidence, or a bare number already read off an answer. Null when the value is
 * not a finite probability in [0,1] or the cut is not finite.
 */
export function yesAt(answerOrP: Answer | number | null | undefined, cut: number): boolean | null {
  if (!Number.isFinite(cut)) return null;
  let p: number | null | undefined;
  if (typeof answerOrP === "number") p = answerOrP;
  else if (answerOrP == null) p = null;
  else if (answerOrP.type === "noul") p = answerOrP.noul;
  else if (answerOrP.type === "choice") p = answerOrP.probabilities?.[answerOrP.choice] ?? answerOrP.confidence;
  else if (answerOrP.type === "score") p = answerOrP.confidence;
  if (typeof p !== "number" || !Number.isFinite(p) || p < 0 || p > 1) return null;
  return p >= cut;
}
