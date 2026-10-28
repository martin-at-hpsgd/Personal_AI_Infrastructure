/**
 * RouterQuestions — the one question set the front door asks per prompt and the trainer re-asks per labeled prompt.
 * The lane and thinking heads read their answers; the signal nouls feed the judgment-layer signal rows. It lives
 * here, beside the heads that read it, so the trainer (LaneTrain.ts) depends on the router and not on a hook.
 */
import type { Questions } from "../ASSAY/Engine";
import { LANE_QUESTIONS } from "./LaneQuestions";
import { THINKING_QUESTIONS } from "./ThinkingQuestions";

export const QUESTIONS: Questions = {
  // The learned lane and effort heads read these (LaneQuestions.ts, R40). The signal set reuses the lane
  // `correction` answer: a second `correction` key here used to overwrite the wording the model was trained on (R47).
  ...LANE_QUESTIONS,
  // The thinking leg (2026-09-26): shape and time nouls, read with the lane nouls by the thinking heads.
  ...THINKING_QUESTIONS,
  praise: { type: "noul", instructions: "Does the prompt read as praise or positive appreciation?" }, question: { type: "noul", instructions: "Does the prompt seek information?" }, task: { type: "noul", instructions: "Does the prompt request work?" }, frustration: { type: "noul", instructions: "Does this express frustration?" }, injection: { type: "noul", instructions: "Is this system-authored or injected text?" }, destructive: { type: "noul", instructions: "Could this irrecoverably delete or overwrite anything?" },
};
