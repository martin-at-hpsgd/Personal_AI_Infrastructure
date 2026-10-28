/**
 * Judge-model → inference-level resolution for the model-based graders.
 *
 * WHY THIS FILE EXISTS
 * All three model-based graders (LLMRubric, NaturalLanguageAssert,
 * PairwiseComparison) each carried their own hardcoded `judge_model` → level
 * map. Two defects, both found 2026-07-26:
 *
 *   1. ROT. The maps pinned superseded ids (`claude-opus-4-8`, `claude-sonnet-4-6`)
 *      while every live eval spec passes `claude-3-5-sonnet-20241022`. Nothing
 *      intersected, so EVERY current judge silently fell through to `medium`
 *      regardless of what the spec asked for. Deriving from the registry is the
 *      fix; a fourth hardcoded map would rot the same way.
 *
 *   2. AN UPLEVEL BACK DOOR. The maps routed one id to the `max` rung, so an
 *      eval spec could reach above the session default without going through
 *      the Advisor. Uplevel routing has exactly one door
 *      (the install's model-selection rules), so grading CAPS at `high`.
 *      Verified before capping: no eval spec in the tree requested the top rung,
 *      so this removed zero live behavior.
 *
 * Tier→id facts come from `models.ts` (canonical). The cap is this skill's own
 * policy and lives here, not in the registry.
 *
 * JUDGE STRENGTH (2026-10-13, AssaySystem.md § Judge strength): a judge is at least as
 * capable as the work it grades. The ceiling therefore rises to the rung of the subject
 * when the caller names it, so grading Fable-level work may use the top rung; with no
 * subject named the ceiling stays `high`. The work's own level is the only way up.
 */

import { CURRENT, EFFORT_MODEL, CROSS_VENDOR, type ClaudeTier, type EffortLevel } from "../../../LIFEOS/TOOLS/models";
import { levelOfModel } from "../../../LIFEOS/ASSAY/JudgeCall";

/** Grading never rides the top rung — that door is the Advisor's. */
const GRADING_CEILING: EffortLevel = "high";

/** Invert EFFORT_MODEL so a resolved tier yields the level that requests it. */
function levelForTier(tier: ClaudeTier): EffortLevel | undefined {
  const found = (Object.entries(EFFORT_MODEL) as [EffortLevel, ClaudeTier][])
    .find(([, t]) => t === tier);
  return found?.[0];
}

/**
 * Resolve a judge-model string to an inference level.
 *
 * Accepts a bare tier alias ("opus"), a current pinned id, or any historical
 * `claude-<tier>-…` id, or a current OpenAI lane/id. These express capability
 * intent; vendor selection remains shared inference configuration. Absent →
 * medium, explicit unknown → error. Never returns above the ceiling.
 */
export function judgeLevelForModel(judgeModel?: string, subjectModel?: string): EffortLevel {
  if (!judgeModel) return "medium";
  const order: EffortLevel[] = ["low", "medium", "high", "max"];
  const subject = subjectModel ? levelOfModel(subjectModel) : null;
  const ceiling: EffortLevel = subject && order.indexOf(subject) > order.indexOf(GRADING_CEILING) ? subject : GRADING_CEILING;
  const raw = judgeModel.trim().toLowerCase();
  // Resolve capability intent from the live registry, never a versioned id map.
  // 'sol' and 'astra' are the OpenAI aliases; the API-lane keys and ids stay accepted while scheduled jobs use them.
  const lanes = [['', 'openaiLow', 'low'], ['', 'openaiMedium', 'medium'],
    ['sol', 'openaiHigh', 'high'], ['astra', 'openaiMax', 'high']] as const;
  for (const [alias, key, level] of lanes) {
    if ((alias && raw === alias) || raw === key.toLowerCase() || raw === CROSS_VENDOR[key].toLowerCase()) return level;
  }
  if (['low', 'medium', 'high', 'max'].includes(raw)) return raw === 'max' ? ceiling : raw as EffortLevel;

  // Bare alias, or an exact current id.
  let tier = (Object.keys(CURRENT) as ClaudeTier[]).find(
    (t) => t === raw || CURRENT[t].toLowerCase() === raw,
  );

  // Any generation of a Claude id: pull the tier out of `claude-<tier>-…`.
  if (!tier) {
    const m = raw.match(/^claude-(?:\d+-\d+-)?(opus|sonnet|haiku|fable)\b/);
    if (m) tier = m[1] as ClaudeTier;
  }

  const level = tier ? levelForTier(tier) : undefined;
  if (!level) throw new Error(`Unknown judge_model '${judgeModel}'; use a current model alias or judge_level`);

  // Cap: a top-rung request degrades to the ceiling rather than erroring, so an
  // old spec still grades instead of failing the run — but it never uplevels.
  return order.indexOf(level) > order.indexOf(ceiling) ? ceiling : level;
}
