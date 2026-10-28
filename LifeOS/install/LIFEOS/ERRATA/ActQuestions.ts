/**
 * ActQuestions.ts — the questions Errata M7b asks and the pure code that composes their answers
 * (Errata ISA F6, ISC-45, 47, 48). Nothing here calls a model or imports the Glance front door.
 *
 * Every question is a noul asked under the shadow caller `errata-coverage`. Its cut is that caller's
 * registry threshold for the question (`actCutsFrom`), never a literal here: an answer counts as yes
 * when its probability reaches the registered value. The values start at the registry's provisional
 * default and move only when labels measure them.
 *
 * - `rule_covers` (ISC-45): does this rule, as written, forbid or require what the assistant did or
 *   failed to do? Asked once per (exchange, candidate rule) pair; several pairs of one exchange travel
 *   in one call under position ids `rule_1..rule_K`, each joined back to `rule_covers` in the ledger.
 * - `same_root_cause` (ISC-47): do two failures in one bucket share a root cause one fix would remove?
 * - `rec_already_done`, `rec_more_prose`, `rec_addresses` (ISC-48): the checks a written
 *   recommendation must pass before it can be filed.
 * - `rec_recreates_retired`, `rec_contradicts_doctrine` (ISC-55): set beside the doctrine rules nearest
 *   it (retrieved by the coverage retriever), does the change bring back a kind of mechanism a rule
 *   retired, or require what a rule forbids? A yes to either drops it. They are two questions, not
 *   one: on the 2026-09-27 list the single combined question answered the retired-gate survivor at
 *   0.74 with the next highest at 0.51, while the re-creation question alone answered it 0.91 with
 *   every other recommendation at or under 0.06.
 * - `rec_mandates_optional` (ISC-55, 2026-09-27): does the change make mandatory what a rule leaves
 *   optional, advisory or allowed to skip? A yes drops it. The contradiction question reads "forbids
 *   what a rule allows", which is not quite this shape: the "routing decisions must control execution"
 *   survivor made every router verdict binding beside the Route paragraph that keeps lower verdicts
 *   advisory. It scored 0.26 on contradiction when that paragraph never reached the state; with the
 *   paragraph read whole it scored 0.80 on contradiction and 0.85 here (2026-09-27 recheck).
 * - `rec_model_in_hook`: does the change put a model call inside a hook? LIFEOS/RULES/SelfHealing.md
 *   admits two classes of hook (a checkable property of an artifact, a gate on an irreversible act)
 *   and wants enforcement code deterministic, so a yes is a visible flag for the reader, never a drop.
 *
 * The three doctrine questions are asked of the nearest doctrine together and of each nearest rule on
 * its own (Recommend.checkDrafts); the per-rule answers name the rule a drop matched. They are also
 * asked of the rules of LIFEOS/RULES/SelfHealing.md nearest the change (where a fix of each kind may
 * live), and there a yes is a visible flag, never a drop: whether that file rules out a class of hook
 * outright is the principal's call, so the reader sees the conflict and the rule it names.
 */
import type { NoulQuestion, Questions } from "../ASSAY/Engine";
import { invariant } from "../TOOLS/Invariant";
import { yesAt } from "../ASSAY/Cut";

type Noul = NoulQuestion & { criteria: { true: string; false: string } };
const q = (instructions: string, yes: string, no: string): Noul => ({ type: "noul", instructions, criteria: { true: yes, false: no } });

export const ACT_CALLER = "errata-coverage";
/** Candidate rules retrieved per failure, and so the number of coverage nouls in one call. */
export const RULES_PER_FAILURE = 4;

/** The coverage noul for the rule at position `n` in the state's `rules` object. */
export function ruleCoversQuestion(n: number): Noul {
  return q(
    `Look only at rule "${n}" in \`rules\`. The user's message reacts to something the assistant did or failed to do. Does rule "${n}", as written, forbid what the assistant did or require what it failed to do, so that following that rule would have prevented what the user reacts to?`,
    `rule "${n}" directly forbids the assistant's action or requires the thing it skipped`,
    `rule "${n}" is about something else or only loosely related; following it would not have prevented this`,
  );
}
export const ruleWireId = (n: number): string => `rule_${n}`;

export const SAME_ROOT_CAUSE = q(
  "Two separate moments where the user was unhappy with the assistant are shown as `failure_a` and `failure_b`. Do both come from the same root cause in the assistant or in LifeOS (the same ignored rule, the same missing check, the same bug, or the same habit), so that one change to LifeOS would have prevented both?",
  "one change would prevent both; they share a root cause",
  "they have different causes, or only a surface topic in common",
);

export const REC_ALREADY_DONE = q(
  "`recommendation` proposes a change to LifeOS. `existing` lists changes already queued or applied and the current head of the target file. Is the recommended change already made or already queued there, in substance if not in wording?",
  "the change already exists or is already queued",
  "the change is new",
);
export const REC_MORE_PROSE = q(
  "Is `recommendation` mainly to add or reword written guidance (a rule, a doc, a prompt or an instruction), rather than to add a mechanical check, hook, gate, test or code change that enforces it?",
  "it adds or rewords written guidance",
  "it adds a check, hook, gate, test or code change",
);
export const REC_ADDRESSES = q(
  "`examples` are messages in which the user was unhappy with the assistant. If `recommendation` had been in place, would it have prevented most of those moments?",
  "the change would have prevented most of the example failures",
  "the change would not have prevented most of them, or targets something else",
);

export const REC_RECREATES_RETIRED = q(
  "`doctrine` lists LifeOS rules as they stand today. Does one of them say that a mechanism of the same kind as the one `recommendation` adds (a gate, hook, block or check that holds or refuses the assistant's turn) was retired, removed or rejected, so that the recommendation would bring that kind of mechanism back?",
  "a listed rule retired, removed or rejected this kind of mechanism, and the recommendation brings it back",
  "no listed rule retired, removed or rejected a mechanism of this kind",
);
export const REC_CONTRADICTS_DOCTRINE = q(
  "Does `recommendation` require something that a rule in `doctrine` explicitly forbids, or forbid something a rule in `doctrine` explicitly requires or allows?",
  "the change requires what a listed rule forbids, or forbids what a listed rule requires or allows",
  "the change forbids and requires nothing that a listed rule says otherwise about",
);
export const REC_MANDATES_OPTIONAL = q(
  "`doctrine` lists LifeOS rules as they stand today. Does `recommendation` make mandatory, binding or enforced something that one of those rules explicitly leaves optional, advisory or allowed to skip, taking away a choice that rule gives?",
  "the change makes mandatory what a listed rule leaves optional, advisory or allowed to skip",
  "no listed rule leaves optional, advisory or allowed what the change makes mandatory",
);
export const REC_MODEL_IN_HOOK = q(
  "Does `recommendation` add or extend a Claude Code hook (a file under hooks/, such as a Stop, PreToolUse or UserPromptSubmit hook) that calls a language model (an LLM auditor, reviewer, classifier or judge) while the hook runs?",
  "the change puts a model call inside a hook",
  "the change puts no model call inside a hook",
);

/** Every registered question id of the caller, with the question itself. */
export const ACT_QUESTIONS: Questions = {
  rule_covers: ruleCoversQuestion(1),
  same_root_cause: SAME_ROOT_CAUSE,
  rec_already_done: REC_ALREADY_DONE,
  rec_more_prose: REC_MORE_PROSE,
  rec_addresses: REC_ADDRESSES,
  rec_recreates_retired: REC_RECREATES_RETIRED,
  rec_contradicts_doctrine: REC_CONTRADICTS_DOCTRINE,
  rec_model_in_hook: REC_MODEL_IN_HOOK,
  rec_mandates_optional: REC_MANDATES_OPTIONAL,
};
export const ACT_QUESTION_IDS = Object.keys(ACT_QUESTIONS);
/** Asked of the check state: the recommendation beside its rule, existing Upgrades, target head and examples. */
export const REC_QUESTIONS: Questions = { rec_already_done: REC_ALREADY_DONE, rec_more_prose: REC_MORE_PROSE, rec_addresses: REC_ADDRESSES };
/** Asked of one doctrine state (the nearest rules together, one rule alone, or one fix-placement rule). */
export const RULE_QUESTIONS: Questions = { rec_recreates_retired: REC_RECREATES_RETIRED, rec_contradicts_doctrine: REC_CONTRADICTS_DOCTRINE, rec_mandates_optional: REC_MANDATES_OPTIONAL };
/** Asked of the doctrine state: the recommendation beside the doctrine rules nearest it. */
export const DOCTRINE_QUESTIONS: Questions = { ...RULE_QUESTIONS, rec_model_in_hook: REC_MODEL_IN_HOOK };
export type DoctrineQuestion = "rec_recreates_retired" | "rec_contradicts_doctrine" | "rec_mandates_optional";
export const DOCTRINE_QUESTION_IDS = Object.keys(RULE_QUESTIONS) as DoctrineQuestion[];

export type ActCuts = Record<string, number>;

/** The M7b question ids the caller's registry row does not carry yet, in bank order. Pure. */
export function missingActQuestions(cfg: { thresholds: Record<string, unknown> }): string[] {
  return ACT_QUESTION_IDS.filter((id) => !Object.hasOwn(cfg.thresholds, id));
}

/** The caller's registry cut for every M7b question, or null when any is missing or out of range. Takes the caller's threshold rows (Glance's thresholdRows); this module stays free of Glance. Pure. */
export function actCutsFrom(rows: Readonly<Record<string, { value: number }>> | null | undefined): ActCuts | null {
  if (!rows) return null;
  const out: ActCuts = {};
  for (const id of ACT_QUESTION_IDS) {
    const v = rows[id]?.value;
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1) return null;
    out[id] = v;
  }
  return out;
}

export type FixType = "enforce_rule" | "add_rule";
export type Coverage = { covered: boolean; rule: string | null; p: number; fix_type: FixType };

/**
 * Pure: a failure is covered when any candidate rule's answer reaches the `rule_covers` cut; the
 * covering rule is the highest such answer (ties by rule id). Covered is `enforce_rule`, uncovered
 * `add_rule`. Null when there are no answered candidates or a probability is out of range.
 */
export function composeCoverage(answers: { rule: string; p: number }[], cuts: ActCuts): Coverage | null {
  if (!answers.length || answers.some((a) => !Number.isFinite(a.p) || a.p < 0 || a.p > 1)) return null;
  const cut = cuts.rule_covers;
  if (typeof cut !== "number") return null;
  const best = [...answers].sort((a, b) => b.p - a.p || a.rule.localeCompare(b.rule))[0]!;
  return yesAt(best.p, cut) === true
    ? { covered: true, rule: best.rule, p: best.p, fix_type: "enforce_rule" }
    : { covered: false, rule: null, p: best.p, fix_type: "add_rule" };
}

/** Pure: a pair merges when its `same_root_cause` answer reaches the cut. */
export function sameRootCause(p: number, cuts: ActCuts): boolean {
  const cut = cuts.same_root_cause;
  return typeof cut === "number" && yesAt(p, cut) === true;
}

/**
 * The answers a recommendation is judged on. Each doctrine answer is the highest over the nearest
 * rules read together and each read alone; `placement` holds the same three questions' highest
 * answers over the fix-placement rules (SelfHealing), which only flag.
 */
export type RecCheck = {
  already_done: number; more_prose: number; addresses: number;
  recreates_retired: number; contradicts_doctrine: number; mandates_optional: number; model_in_hook: number;
  placement: Record<DoctrineQuestion, number>;
};
export type DropReason = "already implemented or queued" | "more prose where a rule already exists" | "does not address the exemplars" | "re-creates what doctrine retired" | "contradicts a doctrine rule" | "makes mandatory what doctrine leaves optional";
/** The drop reason each doctrine question gives on a yes. */
export const DOCTRINE_DROP_OF: Record<DoctrineQuestion, DropReason> = {
  rec_recreates_retired: "re-creates what doctrine retired",
  rec_contradicts_doctrine: "contradicts a doctrine rule",
  rec_mandates_optional: "makes mandatory what doctrine leaves optional",
};
/** The drop reasons the doctrine check (ISC-55) gives. */
export const DOCTRINE_DROPS: readonly DropReason[] = Object.values(DOCTRINE_DROP_OF);
export type Flag = "puts a model call inside a hook" | "conflicts with where a fix may live (SelfHealing)";
const CHECK_FIELD: Record<DoctrineQuestion, "recreates_retired" | "contradicts_doctrine" | "mandates_optional"> = {
  rec_recreates_retired: "recreates_retired", rec_contradicts_doctrine: "contradicts_doctrine", rec_mandates_optional: "mandates_optional",
};

/** Pure: a check is well formed when every answer is a probability. */
export function validRecCheck(c: RecCheck): boolean {
  const ps = [c.already_done, c.more_prose, c.addresses, c.recreates_retired, c.contradicts_doctrine, c.mandates_optional, c.model_in_hook, ...DOCTRINE_QUESTION_IDS.map((id) => c.placement?.[id])];
  return ps.every((p) => typeof p === "number" && Number.isFinite(p) && p >= 0 && p <= 1);
}

/** Pure: the doctrine questions whose answer reaches its cut, over the nearest rules or over the placement rules. */
export function doctrineYes(c: RecCheck, cuts: ActCuts, over: "nearest" | "placement"): DoctrineQuestion[] {
  return DOCTRINE_QUESTION_IDS.filter((id) => {
    const p = over === "nearest" ? c[CHECK_FIELD[id]] : c.placement?.[id];
    return typeof cuts[id] === "number" && typeof p === "number" && yesAt(p, cuts[id]!) === true;
  });
}

/**
 * Pure: why a recommendation is dropped, or [] when it survives. `more_prose` drops only an
 * `enforce_rule` recommendation, because a missing rule is correctly answered with prose.
 */
export function recommendationDrops(c: RecCheck, fixType: FixType, cuts: ActCuts): DropReason[] {
  const yes = (id: string, p: number): boolean => typeof cuts[id] === "number" && yesAt(p, cuts[id]!) === true;
  const out: DropReason[] = [];
  if (yes("rec_already_done", c.already_done)) out.push("already implemented or queued");
  if (fixType === "enforce_rule" && yes("rec_more_prose", c.more_prose)) out.push("more prose where a rule already exists");
  if (!yes("rec_addresses", c.addresses)) out.push("does not address the exemplars");
  for (const id of doctrineYes(c, cuts, "nearest")) out.push(DOCTRINE_DROP_OF[id]);
  return out;
}

/**
 * Pure: the visible flags on a recommendation. A flag never drops; the reader weighs it. A model call
 * inside a hook flags, and so does a yes to a doctrine question over the fix-placement rules.
 */
export function recommendationFlags(c: RecCheck, cuts: ActCuts): Flag[] {
  const out: Flag[] = [];
  if (typeof cuts.rec_model_in_hook === "number" && c.model_in_hook >= cuts.rec_model_in_hook) out.push("puts a model call inside a hook");
  if (doctrineYes(c, cuts, "placement").length) out.push("conflicts with where a fix may live (SelfHealing)");
  return out;
}

// ── Calibration (ISC-54) ────────────────────────────────────────────────────

/** The two cuts calibrated against blind labels; the recommendation checks stay provisional. */
export const CALIBRATED_IDS = ["rule_covers", "same_root_cause"] as const;
export type CalibratedId = (typeof CALIBRATED_IDS)[number];
export type ActCalibration = { id: CalibratedId; value: number; samples: number; agreement: number; balanced: number };
type ThresholdRow = { value: number; calibrated?: string | null; model?: string | null; samples?: number; agreement?: number | null; balanced_accuracy?: number | null; mode?: string };
type CalibratableRow = { mode?: string; thresholds: Record<string, ThresholdRow>; ground_truth: Record<string, unknown> };

/**
 * Pure: the caller row with each calibrated cut written in: value, calibrated date, model, samples,
 * agreement (Glance vs the majority at the cut) and balanced accuracy, and the ground truth named.
 * Everything else in the row is kept. Bad evidence is an invariant violation, raised before the
 * writer touches the file.
 */
export function withActCalibration<T extends CalibratableRow>(row: T, cals: ActCalibration[], model: string, date: string, groundTruth: (id: CalibratedId) => { source: string; join_key: string }): T {
  invariant(row.mode === "shadow", `${ACT_CALLER} must stay shadow while it is calibrated`);
  invariant(model.length > 0, "calibration needs the model that answered");
  invariant(/^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(date)), "calibration needs a YYYY-MM-DD date");
  invariant(new Set(cals.map((c) => c.id)).size === cals.length, "one calibration per question");
  const rows: Record<string, ThresholdRow> = { ...row.thresholds };
  const truth = { ...row.ground_truth };
  for (const c of cals) {
    const t = rows[c.id];
    invariant(t, `${ACT_CALLER}.${c.id} is not registered`);
    invariant(Number.isFinite(c.value) && c.value >= 0 && c.value <= 1, `${c.id}: cut out of range`);
    invariant(Number.isInteger(c.samples) && c.samples > 0 && Number.isFinite(c.agreement) && Number.isFinite(c.balanced), `${c.id}: calibration evidence incomplete`);
    rows[c.id] = { ...t, value: c.value, calibrated: date, model, samples: c.samples, agreement: Number(c.agreement.toFixed(4)), balanced_accuracy: Number(c.balanced.toFixed(4)), mode: "shadow" };
    truth[c.id] = groundTruth(c.id);
  }
  return { ...row, thresholds: rows, ground_truth: truth };
}
