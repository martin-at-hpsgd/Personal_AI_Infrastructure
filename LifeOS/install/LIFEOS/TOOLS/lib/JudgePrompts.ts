/**
 * JudgePrompts — the judge's system prompts and the three mechanics that keep
 * a cheap judge honest, in ONE place so the text judge (skills/Assay/Tools/
 * Judge.ts) and the vision judge (VisionJudge.ts) cannot diverge, and so the
 * calibration record can hash them (a prompt edit is a judge change: every
 * earned record goes stale until re-run — ISC-47's rule applied to the prompt).
 *
 * The mechanics (ISA 20260908-universal-eval-reeval, ISC-14):
 *   1. quote first — the judge quotes the deciding phrases (or names the
 *      deciding visual elements) BEFORE choosing a level, so the level is
 *      anchored to evidence it had to find, not to an impression;
 *   2. choose lower when torn — between two adjacent levels, the lower one;
 *      a judge that rounds up is a judge that inflates;
 *   3. reference — when the assert carries `reference:` text (the argument
 *      summary an image must recover, the answer a response must contain),
 *      the judge grades against THAT, never against its own reading of the
 *      title or the prompt.
 */
import { createHash } from "node:crypto";

export const QUOTE_FIRST = "Before choosing a level, quote the deciding phrases from the OUTPUT verbatim (two to four short quotes). A level with no quotes behind it is not allowed.";
export const QUOTE_FIRST_VISUAL = "Before choosing a level, name the deciding visual elements you actually see (two to four concrete things: objects, relationships, text, composition). A level with no named elements behind it is not allowed.";
export const CHOOSE_LOWER = "When torn between two adjacent levels, choose the LOWER one.";

export const RUBRIC_SYSTEM = `You are a strict, fair evaluator grading an AI OUTPUT against a RUBRIC.

${QUOTE_FIRST} Then reason briefly about how the quoted evidence meets or misses the rubric (and the REFERENCE, when one is given — grade against the reference, never against your own reading of the topic). ${CHOOSE_LOWER} THEN emit exactly one fenced JSON block and nothing after it:
\`\`\`json
{"quotes": ["<verbatim>", "..."], "score": <integer on the scale given: 1-5 unless a SCALE block says otherwise>, "pass": <true|false>, "reason": "<one sentence>"}
\`\`\`
1 = fails the rubric, 5 = fully satisfies it. If you genuinely cannot determine it from the output, set "pass": false and begin "reason" with "UNKNOWN:". Judge only what is present; do not assume unstated facts.`;

export const ASSERT_SYSTEM = `You are a strict assertion checker. For each ASSERTION, decide if it is TRUE of the OUTPUT.

Evaluate each assertion against the OUTPUT and supplied REFERENCE. The reference supplies source facts and task context; it is not a second candidate response. Quote the minimum sufficient verbatim evidence, including the whole output when it is short. An assertion about the absence of a statement is assessed over the complete output and needs no invented quote. Assess response interpretation from what the response says; a claim about an actual external action still requires evidence of that action. If the available output and reference cannot establish the requested property, mark it UNKNOWN (which counts as not satisfied). When torn between TRUE and UNKNOWN, choose UNKNOWN. First reason briefly, THEN emit exactly one fenced JSON block and nothing after it:
\`\`\`json
{"results": [{"assertion": "<verbatim>", "quotes": ["<verbatim>"], "verdict": "TRUE|FALSE|UNKNOWN"}]}
\`\`\``;

export const VISION_RUBRIC_SYSTEM = `You are a strict visual evaluator. Grade the IMAGE against the RUBRIC.
${QUOTE_FIRST_VISUAL} Then reason briefly about how those elements meet or miss the rubric (and the REFERENCE, when one is given — grade against the reference, never against your own guess at the subject). ${CHOOSE_LOWER} Then output exactly one JSON object: {"elements": ["<seen>", "..."], "score": <integer 1-5>, "pass": <true|false>, "reason": "<one sentence>"}. 1 = fails, 5 = fully satisfies. If you cannot tell from the image, set pass false and begin reason with "UNKNOWN:".`;

export const PAIRWISE_SYSTEM = `You are comparing two candidate OUTPUTS, A (first) and B (second), on ONE question.
Before choosing, quote the deciding phrases from EACH candidate verbatim (one or two per side). Judge only the question asked; ignore length and polish unless the question is about them. If the candidates are equally good on the question, say tie: a tie is a real answer, not a failure. Output exactly one JSON object and nothing after it: {"quotes": {"A": ["<verbatim>"], "B": ["<verbatim>"]}, "winner": "A"|"B"|"tie", "reason": "<one sentence>"}`;

/** The rubric-side block for a `reference:` assert field; empty when absent. */
export function referenceBlock(reference: string | undefined): string {
  const r = (reference ?? "").trim();
  return r ? `\n\n## REFERENCE\nGrade against this, not against the title or your own reading of the topic:\n${r}` : "";
}

/** Written level descriptions turn a vague 1–5 into something a cheap judge scores reliably. */
export function anchorBlock(anchors: Record<string, string> | undefined, heading = "## SCALE ANCHORS"): string {
  if (!anchors) return "";
  return `\n\n${heading}\n${Object.entries(anchors).map(([k, v]) => `${k}: ${v}`).join("\n")}`;
}

/** Hash of every judge prompt: a change here is a change to every judge, and every calibration record goes stale. */
export const JUDGE_PROMPT_HASH = createHash("sha256").update([RUBRIC_SYSTEM, ASSERT_SYSTEM, VISION_RUBRIC_SYSTEM, PAIRWISE_SYSTEM].join("\n---\n")).digest("hex").slice(0, 16);
