// release-allow: profanity (complaint-classifier prompt quotes the frustration words it must read past)
/**
 * Questions.ts — Errata v4's question bank and its pure composers (ISC-40, ISC-41).
 *
 * v3 asked the engine (then Jev, retired 2026-10-10) one 14-way `failure_class` choice plus a vague `defect` noul, and it answered
 * `defect` at 0.27–0.38 on nearly every entry (Errata ISA § Learning). The router went from 63% to
 * 90% by splitting its one choice into small nouls that code composes (LIFEOS/ROUTER/LaneQuestions.ts).
 * v4 does the same for a principal's reaction: every question here is a noul — one plain yes/no
 * question with true/false criteria, answerable from one exchange (the prompt, the end of the
 * reply it reacts to, the ask before it, the last tool calls). Nothing here calls a model.
 *
 * Four labeled groups. Detect and blame are asked of every exchange; mode and cost only of exchanges
 * the detect composer calls failures. Beside them sit the discriminators (ISC-53): unlabeled stage-2
 * nouls that each separate one confused pair of classes, scored against the majority class; and the
 * calm-failure nouls (ISC-56): unlabeled stage-1 nouls read only by the detect head, asked when kept.
 * The labeling brief's failure definition and boundary rules live here too, so the brief and the
 * model class tier (ClassTier.ts) render from one source. The composers map answers plus registry cuts to is_failure,
 * defect, a primary class in v3's 14 `failure_class` values (so v3 and v4 compare directly),
 * secondary classes, and severity 0–3. They return null when any needed answer or cut is missing.
 *
 * Cuts are the errata-triage caller's registry thresholds (`cutsFrom`), never literals here: a
 * question counts as yes when its probability reaches its registered value. The values start
 * provisional (calibrated: null) and move only when Eval.ts has measured them against gold.
 */
import type { Answer, NoulQuestion, Questions } from "../ASSAY/Engine";
import { questions as V3_QUESTIONS } from "./Audit";
import { yesAt } from "../ASSAY/Cut";

type Noul = NoulQuestion & { criteria: { true: string; false: string } };
const q = (instructions: string, yes: string, no: string): Noul => ({ type: "noul", instructions, criteria: { true: yes, false: no } });

export const DETECT = {
  unhappy: q(
    "Is the user unhappy, annoyed or frustrated with something the assistant did, said or produced?",
    "the user shows displeasure with the assistant's work or behavior",
    "the user is neutral or pleased, or is upset only about something unrelated to the assistant's work"),
  corrects: q(
    "Does the user say that something specific the assistant stated or did was wrong?",
    "the user names a wrong fact, claim, file, step or result from the assistant",
    "the user points out no specific error"),
  reports_broken: q(
    "Does the user report that something the assistant built, changed or ran is broken, failing or not working?",
    "the user says the assistant's work is broken or not working",
    "the user reports nothing broken"),
  repeat_complaint: q(
    "Does the user say a problem or an ignored instruction has happened before, for example with 'again', 'still', 'I already told you' or 'how many times'?",
    "the user points to a repeat of an earlier problem or instruction",
    "no repeat is mentioned, or 'again' only asks to rerun something"),
  rejects_proposal: q(
    "Does the user reject or overrule a plan, suggestion or question the assistant put forward in its previous reply?",
    "the user turns down or overrides what the assistant proposed",
    "the user accepts it, or the assistant proposed nothing"),
  praise: q(
    "Does the user praise, thank or approve of the assistant's work?",
    "the user expresses approval or thanks",
    "no approval or thanks"),
  new_request: q(
    "Is the user's message a new request or a follow-on instruction that shows no reaction, good or bad, to the assistant's previous reply?",
    "a request with no judgment of the previous reply",
    "the message reacts to the previous reply, positively or negatively"),
} as const satisfies Record<string, Noul>;

export const BLAME = {
  assistant_caused: q(
    "Did something go wrong because of the assistant's own decisions: what it chose to do, say, assume or skip?",
    "the assistant's own choice caused the problem",
    "nothing went wrong, or the cause lies outside the assistant's choices"),
  external_caused: q(
    "Did something go wrong because of a third-party service, website, app, device or the outside world, rather than the assistant or LifeOS?",
    "an outside service or the world caused the problem",
    "nothing went wrong, or the cause is the assistant or LifeOS"),
  changed_mind: q(
    "Is the user changing or adding to their own earlier request, rather than saying the assistant got it wrong?",
    "the user changed their mind or added a new requirement",
    "the user holds the assistant responsible, or nothing changed"),
  harness_caused: q(
    "Did something go wrong because of LifeOS machinery (a hook, guard, permission prompt, configuration setting, or a LifeOS script or tool misbehaving) rather than the assistant's reasoning?",
    "a LifeOS hook, guard, setting or tool caused the problem",
    "nothing went wrong, or the cause is not LifeOS machinery"),
} as const satisfies Record<string, Noul>;

export const MODE = {
  ignored_ask: q(
    "Did the assistant fail to do something the user explicitly asked for in this conversation?",
    "an explicit request was not carried out", "every explicit request was carried out, or none is at issue"),
  broke_rule: q(
    "Did the assistant break a standing rule or preference the user set before, one that applies to all work rather than only this request?",
    "a standing rule or preference was broken", "no standing rule is at issue"),
  wrong_thing: q(
    "Did the assistant build or answer something different from what the user meant, misunderstanding the goal?",
    "the assistant misunderstood what was wanted", "the assistant understood the goal"),
  partial: q(
    "Did the assistant stop short: leave the work partial, fix only part of the problem, or miss closely related places?",
    "the work was left incomplete", "the work was complete, or completeness is not at issue"),
  unverified: q(
    "Did the assistant claim something was done, working or true without checking, and it turned out not to be?",
    "an unchecked claim of done or true turned out wrong", "no unchecked claim is at issue"),
  regression: q(
    "Did the assistant break something that used to work, or lose or delete work or data?",
    "something that worked broke, or work or data was lost", "nothing that worked was broken or lost"),
  format_voice: q(
    "Is the complaint about the form of the output (its format, length, tone, wording or writing style) rather than its substance?",
    "the problem is how the output looks or reads", "the problem is not the output's form"),
  unasked: q(
    "Did the assistant do things the user did not ask for or did not want?",
    "the assistant overreached", "the assistant did only what was asked"),
  asked_instead: q(
    "Did the assistant ask a question or wait for permission when it should simply have acted?",
    "a needless question or permission request", "no needless question"),
  wrong_tool: q(
    "Did the assistant use the wrong model, agent, skill, tool or workflow for the job?",
    "the wrong model, agent, skill, tool or workflow was used", "the choice of tool is not at issue"),
  hook_misfire: q(
    "Is the complaint about a hook, guard, block or permission prompt getting in the way?",
    "a hook, guard, block or permission prompt got in the way", "no hook, guard or prompt is at issue"),
  slow_or_crash: q(
    "Is the complaint that something was slow, hung, timed out or crashed?",
    "slowness, a hang, a timeout or a crash", "speed and stability are not at issue"),
  forgot_context: q(
    "Did the assistant forget or lose something from earlier in the conversation, or a past decision it should have known?",
    "earlier context or a known decision was forgotten", "no forgotten context"),
  stale_fact: q(
    "Did the assistant state an outdated or wrong fact about the world, the system or the user?",
    "a stale or wrong fact was stated", "no wrong fact is at issue"),
  security_privacy: q(
    "Did the assistant create a security or privacy risk, such as exposing a secret or personal data or taking an unsafe action?",
    "a security or privacy risk", "no security or privacy risk"),
} as const satisfies Record<string, Noul>;

/** "A repeat of a known issue" was cut from this group: it asks the same thing as detect.repeat_complaint, which severity reads instead. */
export const COST = {
  lost_time: q(
    "Did this cost the user real time or work (redoing, re-explaining or waiting) beyond a moment of annoyance?",
    "real time or work was lost", "only a moment of annoyance, or nothing"),
  risky_damage: q(
    "Did the assistant take a risky or damaging action, such as deleting, overwriting, deploying, publishing, spending or sending something it should not have?",
    "a risky or damaging action was taken", "no risky or damaging action"),
  blocked: q(
    "Is the user blocked from continuing until this is fixed?",
    "progress is blocked until it is fixed", "the user can carry on"),
} as const satisfies Record<string, Noul>;

/**
 * What the labelers were told a failure is, and the three boundary rules the principal's delegate
 * decided on 2026-09-27 (ISC-52). The labeling brief (Eval.ts renderBrief) and the model class tier
 * (ClassTier.ts) both render from these strings, so what the model is told cannot drift from what
 * the gold labelers were told.
 */
export const FAILURE_DEFINITION = "A failure is a message where the user is reacting to something that went wrong with the assistant's work, or with a system the assistant was operating for the user, including when an outside service caused it (that is class `external`). A change of mind, a new requirement, a plain new request, a question or praise is not a failure.";
export const BOUNDARY_RULES: readonly string[] = [
  "Said done, wasn't. If the assistant said something was done, fixed, working or verified, and the user's message shows it was not, the class is `unverified_claim` and `unverified` is true, even when the work was also unfinished. `incomplete_work` is for work the assistant did not claim was finished.",
  "Design iteration. Feedback on a design, image, layout or piece of writing the user is still shaping (\"I don't like this theme\", \"make it more positive\", \"do some better ones\") is `not_a_failure`, and `changed_mind` may be true. It becomes a failure only when the user says the result breaks something they asked for or a standing rule.",
  "Bare go-ahead. A bare go-ahead (\"do it\", \"y\", \"continue\", \"fix it\") after the assistant asked a question or offered a choice is `not_a_failure`, with `new_request` true. It becomes `needless_question` only when the message itself shows displeasure at being asked (\"why are you asking\", \"stop asking\", \"just fucking do it\").",
];
/** The labelers' reading rule for every row: the message is a reaction to what came before it. */
export const READING_RULE = "Read the assistant's previous reply and the user's previous request before the user's message: the message is a reaction to them.";
/** How the labelers were told to pick the one class. */
export const CLASS_CHOICE_NOTE = "Which one class best describes this message? Choose `not_a_failure` when nothing went wrong; choose `external` when only an outside service or the world is to blame.";

/** The labeled bank: the ids the three gold labelers answer (LabelBrief.md) and the composers read. */
export const GROUPS = { detect: DETECT, blame: BLAME, mode: MODE, cost: COST } as const;
export type Group = keyof typeof GROUPS;
/** Stage 1 slots, asked of every exchange as one pool. */
export const STAGE1: Questions = { ...DETECT, ...BLAME };
/** Stage 2 slots, asked only of exchanges composed as failures. */
export const STAGE2: Questions = { ...MODE, ...COST };
export const ALL_QUESTIONS: Questions = { ...STAGE1, ...STAGE2 };
export const QUESTION_IDS = Object.keys(ALL_QUESTIONS);
export type ModeId = keyof typeof MODE;

/**
 * Miss-loop rewordings (Errata ISA F6, 2026-09-25, gold round 1). Each variant asks what its `of`
 * slot asks, sharper, under a new id registered in shadow; it is scored against the labelers'
 * answers for `of`, since the labelers never saw the new wording. The old id stays in the bank.
 *
 * Diagnosis, from the rows the old wording got wrong: the engine (then Jev, retired 2026-10-10) answered about the situation the
 * assistant's own reply described (a session limit, a gate that blocked it, work it said was
 * unfinished) rather than about what the user's message complained of, so `partial`,
 * `ignored_ask`, `harness_caused` and `blocked` fired on plain "do it", "continue" and "fix it
 * all" turns, and `ignored_ask` read any new request as "an explicit request not carried out".
 * Every variant anchors on what the user says and excludes the pattern that fooled the old one.
 */
export const VARIANTS = {
  blames_lifeos: { of: "harness_caused", q: q(
    "Judge what the user's message complains about, not problems the assistant reports in its own reply. Does the user blame LifeOS machinery itself (a hook, guard, permission prompt, configuration setting, or a LifeOS script, tool, dashboard, monitor or router giving wrong results) rather than the assistant's reasoning or an outside service?",
    "the user's complaint is about a LifeOS hook, guard, setting, script, tool, dashboard, monitor or router",
    "the user complains about nothing, about the assistant's own choices, or about an outside service") },
  disregarded_instruction: { of: "ignored_ask", q: q(
    "A request the user makes for the first time in this message does not count. Does the user say the assistant disregarded or failed to carry out an instruction the user had already given earlier, for example 'I told you to', 'I asked you to' or 'why didn't you do what I said'?",
    "the user says an instruction they gave earlier was not followed",
    "no earlier instruction is said to be disregarded, or the user is only asking for something now") },
  left_unfinished: { of: "partial", q: q(
    "A request to continue, to do more or to start new work does not count, and neither does unfinished work the assistant itself reported. Does the user complain that work the assistant presented as done is incomplete: parts missing, only some of the problem fixed, or related places left untouched?",
    "the user says the assistant's supposedly finished work is incomplete",
    "the user does not complain that finished work is incomplete") },
  broke_working: { of: "regression", q: q(
    "Does the user say the assistant broke something that used to work, made something worse than it was before, or lost or deleted work or data?",
    "the user says something that worked is now broken or worse, or that work or data was lost",
    "nothing is said to be made worse or lost; something that never worked does not count") },
  wrong_means: { of: "wrong_tool", q: q(
    "Does the user say the assistant used the wrong model, agent, skill, tool, workflow, account or channel for the job, or skipped one it was supposed to use?",
    "the user names a wrong or skipped model, agent, skill, tool, workflow, account or channel",
    "the user does not complain about which means were used") },
  forgot_known: { of: "forgot_context", q: q(
    "Does the user say the assistant forgot or overlooked something it should already have known: an earlier part of this conversation, a past decision, or something that already exists in the system, as in 'we already have that' or 'we did that already'?",
    "the user says the assistant forgot earlier context, a known decision, or something that already exists",
    "no forgotten context or already-existing thing is at issue") },
  false_belief: { of: "stale_fact", q: q(
    "A claim that the assistant's own work is done or working does not count here. Does the user say the assistant believed or stated something false about the world, the system or the user's own situation, such as what exists, how something is set up, or what has already happened?",
    "the user corrects a false belief the assistant held about the world, the system or the user",
    "no false belief is at issue, or the only false claim is that the assistant's own work is done") },
  security_exposure: { of: "security_privacy", q: q(
    "Does the user raise a security or privacy problem with what the assistant did: a secret, key, token or personal data exposed or placed where it should not be, access protection removed or missing, or an unsafe action?",
    "the user points to a security or privacy problem in the assistant's work",
    "the user raises no security or privacy problem") },
  harmful_action: { of: "risky_damage", q: q(
    "Does the user say the assistant took an action with real consequences that it should not have taken: deleting or overwriting something, deploying, publishing or posting (including under the wrong identity), spending money, or sending a message?",
    "the user objects to a consequential action the assistant took",
    "no consequential action is at issue; a mistake inside the work alone does not count") },
  cannot_proceed: { of: "blocked", q: q(
    "A usage or session limit shown in the assistant's reply, or the assistant waiting for approval, does not count. Does the user say they themselves cannot get on with what they are doing until this is fixed, because something they need is broken, missing or unusable?",
    "the user says they are stuck until it is fixed",
    "the user can carry on, or only the assistant is waiting") },
} as const satisfies Record<string, { of: string; q: Noul }>;
export type VariantId = keyof typeof VARIANTS;
export const VARIANT_IDS = Object.keys(VARIANTS) as VariantId[];

/**
 * Which question Glance is asked for each slot: the slot's own id, or the variant that scored the
 * higher cross-validated balanced accuracy on gold (Train.ts `variants`). Only ids listed here
 * change what production asks; the losing wording stays registered for the record.
 */
export const KEPT_VARIANTS: readonly VariantId[] = [
  "blames_lifeos", "disregarded_instruction", "left_unfinished", "broke_working", "wrong_means",
  "forgot_known", "false_belief", "security_exposure", "cannot_proceed",
];

export const ASKED_FOR: Record<string, string> = Object.fromEntries(QUESTION_IDS.map((id) => [id, KEPT_VARIANTS.find((v) => VARIANTS[v].of === id) ?? id]));

/**
 * Discriminators (Errata ISA F6, ISC-53, 2026-09-27). Among failures the picker's errors and the
 * labelers' splits fall between neighbouring classes, because the engine (Jev at the time, retired 2026-10-10) answered the mode nouls with one
 * halo: an angry message lifts `unverified`, `partial`, `wrong_thing` and `unasked` together. Each
 * discriminator separates one confused pair (`yes` against the classes in `no`) on something the
 * user's message and the reply before it show, and is asked only of failures (stage 2). None is a
 * labeled slot: its truth is the majority class on the rows whose class is in its pair, so it is
 * scored by `pairTruth`, never by a labeler's answer, and the labeling brief never shows it.
 * Pairs measured on gold 2026-09-27 (picker errors + labeler splits + multi-mode rows, among
 * majority failures): incomplete_work ↔ unverified_claim 19, ignored_instruction ↔ wrong_routing 10,
 * misunderstood_intent ↔ context_or_memory 7, format_or_voice ↔ ignored_instruction 7,
 * misunderstood_intent ↔ overreach 6, ignored_instruction ↔ misunderstood_intent 5.
 */
export const DISCRIMINATORS = {
  said_done_not_so: { yes: "unverified_claim", no: ["incomplete_work"], q: q(
    "Read the end of the assistant's previous reply first. Did that reply say or clearly imply that something was done, fixed, working, live, delivered or verified, and does the user's message show that this is not so?",
    "the reply claimed something was done or working, and the user shows it is not",
    "the reply made no such claim, or the user asks for more or different work without contradicting a claim") },
  names_means: { yes: "wrong_routing", no: ["ignored_instruction"], q: q(
    "Does the user say the work should have been done with a different model, agent, skill, workflow or LifeOS system, or that the wrong one did it? Which identity or account something was posted or sent as does not count.",
    "the user names the model, agent, skill, workflow or system that should have done the work, or objects to the one that did",
    "the complaint is not about which model, agent, skill, workflow or system did the work") },
  fact_not_goal: { yes: "context_or_memory", no: ["misunderstood_intent"], q: q(
    "Is the user correcting a fact the assistant got wrong or forgot (what exists, what already happened, what was decided earlier, how something is set up, or what the user owns or uses), rather than explaining what the user wanted or meant by a request?",
    "the user corrects a wrong or forgotten fact",
    "the user explains what they wanted or meant, or corrects no fact") },
  form_only: { yes: "format_or_voice", no: ["ignored_instruction", "misunderstood_intent", "incomplete_work"], q: q(
    "Would the user be satisfied if the same content were only reformatted, shortened, reworded, restyled or laid out differently? Answer yes only when the complaint is about how the output looks or reads, not about what it says or does.",
    "only the form, wording, tone, length or layout is at issue",
    "what the output says, does or leaves out is at issue") },
  did_extra: { yes: "overreach", no: ["misunderstood_intent"], q: q(
    "Is the user objecting that the assistant did more than was asked (extra work, extra changes, removals, or time and effort the user did not want), rather than doing something different in place of what was asked?",
    "the assistant went beyond the request and the user objects to the extra",
    "the assistant did not go beyond the request, or did something different instead of it") },
  misread_request: { yes: "misunderstood_intent", no: ["ignored_instruction"], q: q(
    "Is the user explaining what they actually meant because the assistant took their request the wrong way, rather than saying the assistant knew what to do and did not do it?",
    "the assistant misread the request and the user explains the intended meaning",
    "the assistant understood what was asked or required and did not do it, or no request was misread") },
} as const satisfies Record<string, { yes: string; no: readonly string[]; q: Noul }>;
export type DiscriminatorId = keyof typeof DISCRIMINATORS;
export const DISCRIMINATOR_IDS = Object.keys(DISCRIMINATORS) as DiscriminatorId[];

/**
 * The discriminators production asks of failures and the tournament plays: the set Train.ts kept
 * by backward elimination on held-out class accuracy among majority failures (gold, 2026-09-27:
 * dropping `misread_request` gained two rows and dropping `did_extra` changed none). The model
 * file lists the same set and the loader refuses a mismatch. An unlisted discriminator stays
 * registered in shadow for the record.
 */
export const KEPT_DISCRIMINATORS: readonly DiscriminatorId[] = ["said_done_not_so", "names_means", "fact_not_goal", "form_only"];

/** Pure: a discriminator's truth on a row whose majority class is `cls`; null when the class is outside its pair. */
export function pairTruth(id: DiscriminatorId, cls: string | null): boolean | null {
  const d = DISCRIMINATORS[id];
  if (cls === d.yes) return true;
  return cls !== null && (d.no as readonly string[]).includes(cls) ? false : null;
}

/**
 * Calm-failure nouls (Errata ISA F6, ISC-56, 2026-09-27). The detect head missed most majority
 * failures in the heavy non-failure stratum, and those misses read calm: a polite correction ("not
 * signed in as personal, it's the admin one"), a question about a wrong-looking result ("why is
 * Bunker showing criticals for a 200?"), a nudge after the assistant went quiet ("hello?"). Each is a
 * stage-1 noul asked of every exchange when kept; none is a labeled slot, so it is scored against
 * the majority's failure call and read only as a detect-head feature (never composed at a cut).
 */
export const DETECT_EXTRAS = {
  points_out_miss: q(
    "Set the tone aside: a calm, polite or passing remark counts, and so does one phrased as a question or mixed with thanks. Does the user's message point out something the assistant got wrong, missed, forgot, misread, or did differently from what the user wanted?",
    "the user points out, even calmly or in passing, a mistake, omission or misreading by the assistant",
    "the user only asks for something new, answers a question or approves, and points out nothing the assistant got wrong"),
  asks_why_wrong: q(
    "Does the user ask why something the assistant did or produced, or something a LifeOS tool, dashboard or report shows, looks wrong, broken, missing or unexpected?",
    "the user questions why a result or display looks wrong, broken, missing or unexpected",
    "the user asks a neutral question, or no question about a wrong-looking result"),
  nudges_silence: q(
    "Is the user's message a nudge because the assistant stopped, went quiet or seems stuck, as in 'hello?', 'are you there' or 'what's happening'? A go-ahead after the assistant asked a question does not count.",
    "the user is prodding an assistant that went quiet or seems stuck",
    "the assistant did not go quiet, or the user is answering a question it asked"),
} as const satisfies Record<string, Noul>;
export type DetectExtraId = keyof typeof DETECT_EXTRAS;
export const DETECT_EXTRA_IDS = Object.keys(DETECT_EXTRAS) as DetectExtraId[];
/**
 * The calm-failure nouls production asks in stage 1 and the detect head reads: the set Train.ts
 * kept on held-out weighted recall at no loss of detection (gold, 2026-09-27). An unlisted one
 * stays registered in shadow for the record.
 */
export const KEPT_DETECT_EXTRAS: readonly DetectExtraId[] = [];
export const isDetectExtra = (id: string): id is DetectExtraId => Object.hasOwn(DETECT_EXTRAS, id);

/** Every question id that may carry an answer: the labeled slots, every variant, every discriminator and every calm-failure noul. */
export const KNOWN_IDS: readonly string[] = [...QUESTION_IDS, ...VARIANT_IDS, ...DISCRIMINATOR_IDS, ...DETECT_EXTRA_IDS];
/** The ids scored against a labeler's answer for a slot: the labeled slots and their variants. */
export const SLOT_IDS: readonly string[] = [...QUESTION_IDS, ...VARIANT_IDS];
const QUESTION_BY_ID: Questions = { ...ALL_QUESTIONS, ...Object.fromEntries(VARIANT_IDS.map((v) => [v, VARIANTS[v].q])), ...Object.fromEntries(DISCRIMINATOR_IDS.map((d) => [d, DISCRIMINATORS[d].q])), ...DETECT_EXTRAS };
/** The slot a question id stands for: itself for a labeled id, `of` for a variant, undefined otherwise (discriminators included). */
export function slotOf(id: string): string | undefined {
  if (Object.hasOwn(ALL_QUESTIONS, id)) return id;
  return Object.hasOwn(VARIANTS, id) ? VARIANTS[id as VariantId].of : undefined;
}
export const isDiscriminator = (id: string): id is DiscriminatorId => Object.hasOwn(DISCRIMINATORS, id);
/** The stage a known id is asked in: stage 1 for detect and blame slots and their variants, stage 2 for the rest; undefined for an unknown id. */
export function stageOf(id: string): 1 | 2 | undefined {
  if (isDiscriminator(id)) return 2;
  if (isDetectExtra(id)) return 1;
  const slot = slotOf(id);
  if (slot === undefined) return undefined;
  return Object.hasOwn(STAGE1, slot) ? 1 : 2;
}
/** The questions production asks for these slots, keyed by the asked id. Pure. */
export function askedBank(slots: readonly string[]): Questions {
  return Object.fromEntries(slots.map((s) => [ASKED_FOR[s]!, QUESTION_BY_ID[ASKED_FOR[s]!]!]));
}
/** Any known ids' questions (labeled, variant or discriminator), for measurement. Pure. */
export function questionsFor(ids: readonly string[]): Questions {
  return Object.fromEntries(ids.map((id) => { const q0 = QUESTION_BY_ID[id]; if (!q0) throw new Error(`unknown question id ${id}`); return [id, q0]; }));
}
/** Stage 1 as production asks it: the detect and blame slots, plus the kept calm-failure nouls. */
export const ASKED_STAGE1: Questions = { ...askedBank(Object.keys(STAGE1)), ...questionsFor(KEPT_DETECT_EXTRAS) };
/** Stage 2 as production asks it: the mode and cost slots, plus the kept discriminators. */
export const ASKED_STAGE2: Questions = { ...askedBank(Object.keys(STAGE2)), ...questionsFor(KEPT_DISCRIMINATORS) };
/** Answers and cuts keyed by asked id, re-keyed by slot for the composers; absent entries stay absent (the composers then return null). Pure. */
export function toSlots<T>(byAskedId: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const s of QUESTION_IDS) { const v = byAskedId[ASKED_FOR[s]!]; if (v !== undefined) out[s] = v; }
  return out;
}

/** v3's 14 failure classes, taken from Audit.ts so the two taxonomies cannot drift apart. */
const V3_CLASS_QUESTION = V3_QUESTIONS.failure_class;
if (V3_CLASS_QUESTION?.type !== "choice") throw new Error("Audit.ts failure_class must be a choice question");
export const V3_CLASSES: Record<string, string> = Object.fromEntries(Object.entries(V3_CLASS_QUESTION.criteria).map(([k, v]) => [k, String(v ?? "")]));
export type V3Class = string;

/** Each failure mode maps onto one v3 class; `external` and `not_a_failure` come from blame and detect. */
export const MODE_CLASS: Record<ModeId, V3Class> = {
  ignored_ask: "ignored_instruction",
  broke_rule: "ignored_instruction",
  wrong_thing: "misunderstood_intent",
  partial: "incomplete_work",
  unverified: "unverified_claim",
  regression: "broke_something",
  format_voice: "format_or_voice",
  unasked: "overreach",
  asked_instead: "needless_question",
  wrong_tool: "wrong_routing",
  hook_misfire: "harness_mechanics",
  slow_or_crash: "harness_mechanics",
  forgot_context: "context_or_memory",
  stale_fact: "context_or_memory",
  security_privacy: "security_or_privacy",
};

export type Cuts = Record<string, number>;
export type AnswerMap = Record<string, Answer | number | boolean | undefined>;

/** Registry cuts for every labeled and asked question (kept discriminators included), keyed by question id, or null when any is missing or out of range. Takes the caller's threshold rows (Glance's thresholdRows); this module stays free of Glance. Pure. */
export function cutsFrom(rows: Readonly<Record<string, { value: number }>> | null | undefined): Cuts | null {
  if (!rows) return null;
  const out: Cuts = {};
  for (const id of new Set([...QUESTION_IDS, ...Object.values(ASKED_FOR), ...KEPT_DISCRIMINATORS])) {
    const v = rows[id]?.value;
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1) return null;
    out[id] = v;
  }
  return out;
}

/** A noul's probability from a Glance answer, a stored number, or a labeler's boolean; null when missing or mistyped. */
export function prob(a: Answer | number | boolean | undefined): number | null {
  if (typeof a === "boolean") return a ? 1 : 0;
  if (typeof a === "number") return Number.isFinite(a) && a >= 0 && a <= 1 ? a : null;
  if (a && typeof a === "object" && a.type === "noul" && Number.isFinite(a.noul) && a.noul >= 0 && a.noul <= 1) return a.noul;
  return null;
}

function flags(ids: readonly string[], answers: AnswerMap, cuts: Cuts): Record<string, boolean> | null {
  const out: Record<string, boolean> = {};
  for (const id of ids) {
    const p = prob(answers[id]);
    const cut = cuts[id];
    if (p === null || typeof cut !== "number" || !Number.isFinite(cut)) return null;
    out[id] = yesAt(p, cut) === true;
  }
  return out;
}

export type Detected = { is_failure: boolean; flags: Record<string, boolean> };

/**
 * Pure: is the principal reacting to something that went wrong? A negative signal (unhappy,
 * corrects, reports broken, repeat complaint, rejects a proposal) makes a failure, unless the
 * message is only a change of mind that blames nobody, or a new request whose only signal is
 * weak (a rejection or a repeat marker without displeasure, a correction or a broken report).
 */
export function composeDetect(answers: AnswerMap, cuts: Cuts): Detected | null {
  const f = flags(Object.keys(STAGE1), answers, cuts);
  if (!f) return null;
  const strong = f.unhappy || f.corrects || f.reports_broken;
  const negative = strong || f.repeat_complaint || f.rejects_proposal;
  const onlyChangedMind = f.changed_mind && !f.unhappy && !f.assistant_caused && !f.harness_caused;
  const weakNewRequest = f.new_request && !strong;
  const praiseOnly = f.praise && !strong;
  return { is_failure: negative && !onlyChangedMind && !weakNewRequest && !praiseOnly, flags: f };
}

export type Diagnosis = {
  is_failure: boolean;
  defect: boolean;
  primary: V3Class;
  secondary: V3Class[];
  severity: 0 | 1 | 2 | 3;
  /** True when no mode cleared its cut and the primary class is the likeliest mode's best guess. */
  weak: boolean;
};

const MODE_IDS = Object.keys(MODE) as ModeId[];

/**
 * Pure: the full diagnosis. A non-failure needs only stage-1 answers. A failure needs every stage-2
 * answer too, else null. Primary: `external` when only the outside world is blamed; else
 * security_or_privacy when that mode clears its cut (the class a reviewer must never miss); else
 * the mode with the highest probability among those that clear their cuts; else the likeliest
 * mode, flagged weak. Severity: 3 for a risky or damaging action; 2 for lost time together with a
 * block or a repeat; 1 for any one of lost time, a block or a repeat; 0 otherwise.
 */
export function composeDiagnosis(answers: AnswerMap, cuts: Cuts): Diagnosis | null {
  const d = composeDetect(answers, cuts);
  if (!d) return null;
  if (!d.is_failure) return { is_failure: false, defect: false, primary: "not_a_failure", secondary: [], severity: 0, weak: false };
  return composeFailure(answers, cuts);
}

/**
 * Pure: the diagnosis of an exchange already known to be a failure (by the detect composer or by
 * the combiner's detect head): primary and secondary classes and severity from the stage-2 flags
 * and the blame flags, by the rules above. Null when any answer or cut is missing.
 */
export function composeFailure(answers: AnswerMap, cuts: Cuts): Diagnosis | null {
  const f = flags(Object.keys(STAGE1), answers, cuts);
  const m = flags([...MODE_IDS, ...Object.keys(COST)], answers, cuts);
  if (!f || !m) return null;
  const p = (id: string): number => prob(answers[id]) ?? 0;
  const cleared = MODE_IDS.filter((id) => m[id]).sort((a, b) => p(b) - p(a) || MODE_IDS.indexOf(a) - MODE_IDS.indexOf(b));
  const externalOnly = f.external_caused && !f.assistant_caused && !f.harness_caused;
  let primary: V3Class;
  let weak = false;
  if (externalOnly) primary = "external";
  else if (m.security_privacy) primary = MODE_CLASS.security_privacy;
  else if (cleared.length) primary = MODE_CLASS[cleared[0]!];
  else {
    const best = [...MODE_IDS].sort((a, b) => p(b) - p(a) || MODE_IDS.indexOf(a) - MODE_IDS.indexOf(b))[0]!;
    primary = MODE_CLASS[best];
    weak = true;
  }
  const secondary = [...new Set(cleared.map((id) => MODE_CLASS[id]))].filter((c) => c !== primary);
  const severity = severityOf({ risky_damage: m.risky_damage!, lost_time: m.lost_time!, blocked: m.blocked!, repeat: f.repeat_complaint! });
  return { is_failure: true, defect: primary !== "external", primary, secondary, severity, weak };
}

/** Severity from the cost flags and the repeat marker: 3 risky or damaging; 2 lost time with a block or a repeat; 1 any one of those; else 0. Pure. */
export function severityOf(f: { risky_damage: boolean; lost_time: boolean; blocked: boolean; repeat: boolean }): Diagnosis["severity"] {
  if (f.risky_damage) return 3;
  if (f.lost_time && (f.blocked || f.repeat)) return 2;
  return f.lost_time || f.blocked || f.repeat ? 1 : 0;
}

/**
 * Pure: the classes the composer puts forward for a failure, in its order: the cleared modes'
 * classes by probability (ties by bank order), or, when no mode cleared, every mode's class by
 * probability. The first entry is `composeFailure`'s primary unless blame or security took
 * precedence. Null when a mode answer or cut is missing.
 */
export function failureCandidates(answers: AnswerMap, cuts: Cuts): V3Class[] | null {
  const m = flags(MODE_IDS, answers, cuts);
  if (!m) return null;
  const p = (id: string): number => prob(answers[id]) ?? 0;
  const byProb = [...MODE_IDS].sort((a, b) => p(b) - p(a) || MODE_IDS.indexOf(a) - MODE_IDS.indexOf(b));
  const cleared = byProb.filter((id) => m[id]);
  return [...new Set((cleared.length ? cleared : byProb).map((id) => MODE_CLASS[id]))];
}

/** Pure: the discriminator among `use` that separates classes `a` and `b`, with the class its yes and its no name; null when none does. */
export function discriminatorFor(a: V3Class, b: V3Class, use: readonly DiscriminatorId[]): { id: DiscriminatorId; yes: V3Class; no: V3Class } | null {
  for (const id of use) {
    const d = DISCRIMINATORS[id], no = d.no as readonly string[];
    if (d.yes === a && no.includes(b)) return { id, yes: a, no: b };
    if (d.yes === b && no.includes(a)) return { id, yes: b, no: a };
  }
  return null;
}

/**
 * Pure: the class picker Train.ts chose on gold (ISC-53): the composer's diagnosis with its primary
 * settled by a discriminator tournament. `external` and `security_or_privacy` keep their
 * precedence. Otherwise the first candidate is champion, and each later candidate that shares a
 * discriminator with the champion plays it: a probability at or above the discriminator's registry
 * cut hands the win to the pair's yes class, below it to the no class. A candidate with no shared
 * discriminator never displaces the champion. Secondary classes are the cleared candidates other
 * than the winner; severity and `weak` are the composer's. Null when any answer or cut the
 * composer or a discriminator in `use` needs is missing.
 */
export function composeFailureWithDiscriminators(answers: AnswerMap, cuts: Cuts, use: readonly DiscriminatorId[]): Diagnosis | null {
  const f = composeFailure(answers, cuts);
  const candidates = failureCandidates(answers, cuts);
  if (!f || !candidates) return null;
  for (const id of use) {
    if (prob(answers[id]) === null || typeof cuts[id] !== "number" || !Number.isFinite(cuts[id])) return null;
  }
  if (f.primary === "external" || f.primary === MODE_CLASS.security_privacy) return f;
  let champion = candidates[0]!;
  for (const c of candidates.slice(1)) {
    const d = discriminatorFor(champion, c, use);
    if (d) champion = yesAt(prob(answers[d.id]), cuts[d.id]!) === true ? d.yes : d.no;
  }
  const cleared = f.weak ? [] : [f.primary, ...f.secondary];
  return { ...f, primary: champion, defect: true, secondary: cleared.filter((c) => c !== champion) };
}
