/**
 * IscTierProposal — the on-disk contract between `IscTier.ts propose` and
 * `IscTier.ts apply`, plus the question-file shape both of them speak.
 *
 * Born in 20260922-isc-eval-tiers F3 (ISC-14 … ISC-17). The migration from a
 * `manual` Test Strategy row to a `bash` or `glance` row is a two-step motion
 * with a human in the middle: `propose` classifies and drafts, a person reads
 * the proposal and flips `ratified`, and only then does `apply` touch the ISA.
 * This module is the artifact that survives between those two steps, so the
 * schema is the place the ratification record actually lives (ISA anti-criterion
 * A2: no ISC is migrated by a tool without one).
 *
 * Nothing here compares a probability to anything. Thresholds live in the
 * caller registry (LIFEOS/USER/CONFIG/assay-callers.json) and nowhere else.
 *
 * QUESTION-FILE SCHEMA (2026-09-22): the canonical one is ISC-9's, in
 * `GlanceQuestion.ts`, and this module now delegates to it rather than keeping
 * the parallel shape it started with. The two had diverged in ways that would
 * have broken the pilot: `options` is a record there and was an array here, and
 * `validateProducer` rejects the `file:<path>` producer prefix this tool used
 * to emit, so every question file written before this change would have failed
 * to load in the Bunker runner.
 */

import { createHash } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { yesAt } from "../../ASSAY/Cut.ts";
import { validateGlanceQuestion, type GlanceQuestion } from "./GlanceQuestion.ts";

// ── Question files ──────────────────────────────────────────────────────────

export type QuestionKind = "noul" | "score" | "choice";

/**
 * `<isa-dir>/Questions/<file>.json`, pointed at by a Test Strategy tool cell of
 * the form `glance:<file>#<id>` (ISC-9). The canonical shape, plus the one
 * field this tool adds: `independent` (ISC-24), which the canonical validator
 * ignores.
 */
/**
 * Which end of a score question's ladder is the GOOD end.
 *
 * `criteria` is an ordered list, but nothing ever said which way it is ordered,
 * and the mutation pass was reading index 0 as "the lowest rung" on that
 * assumption. A criterion that lists its rungs best-first inverts the whole test
 * silently. The direction is recorded per question instead of inferred.
 */
export type ScoreDirection = "higher_is_better" | "lower_is_better";

export type IscQuestionFile = GlanceQuestion & {
  independent?: boolean;
  /** Required in practice for `score`; read instead of assuming index 0. */
  direction?: ScoreDirection;
  /** True when `propose` defaulted the direction rather than reading it off the criterion. */
  direction_assumed?: boolean;
};

const QUESTION_ID_RE = /^[A-Za-z0-9_.-]+$/;
/** The stem half of the `glance:<file>#<id>` pointer the ISA parser accepts. */
const QUESTION_STEM_RE = /^[A-Za-z0-9_-]+$/;

/**
 * Throws with a precise reason on a malformed question file, through the
 * canonical validator — which also runs `validateProducer`, so a question whose
 * producer is outside the allowlist or reaches a denied zone never gets written.
 *
 * `isaPath` matters: without it the producer's path operands are resolved
 * against the process's own directory rather than the ISA's, and an
 * in-directory file producer cannot be recognised at all.
 */
export function validateQuestionFile(value: unknown, where = "question file", isaPath?: string): asserts value is IscQuestionFile {
  const q = value as Partial<IscQuestionFile> | null;
  if (!q || typeof q !== "object" || Array.isArray(q)) throw new Error(`${where}: not a JSON object`);
  if (typeof q.id !== "string" || !QUESTION_ID_RE.test(q.id)) throw new Error(`${where}: id must match ${QUESTION_ID_RE}`);
  if (q.independent !== undefined && typeof q.independent !== "boolean") throw new Error(`${where}: independent must be a boolean`);
  try {
    validateGlanceQuestion(q, isaPath);
  } catch (e) {
    throw new Error(`${where}: ${(e as Error).message}`);
  }
}

/** The file stem a `glance:<stem>#<id>` pointer can name, derived from an ISC id. */
export function questionStem(isc: string): string {
  const stem = isc.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!QUESTION_STEM_RE.test(stem)) throw new Error(`cannot derive a question-file stem from "${isc}"`);
  return stem;
}

/** The Test Strategy tool cell for a question file. */
export function glancePointer(stem: string, id: string): string {
  return `glance:${stem}.json#${id}`;
}

// ── Drafted asserts ─────────────────────────────────────────────────────────

/**
 * The expectation vocabulary `propose` drafts with. Deliberately tiny: each
 * member has one unambiguous reading against a command's stdout and exit code,
 * because `isTrivial` is defined as "this expectation is satisfied by nothing
 * at all" and that only means something when the vocabulary is closed.
 */
export type Expectation = "exit:0" | "nonempty" | "count:0" | "min:1" | `contains:${string}`;

export const EXPECTATIONS = ["exit:0", "nonempty", "count:0", "min:1"] as const;

/**
 * Does this expectation hold for that result? Pure, and the only reading of the vocabulary.
 *
 * An execution failure never satisfies anything. Exit 2 and above
 * (rg usage error, curl failure, command not found, a timeout kill) and a null
 * exit (the process never finished) mean the probe did not look, so empty
 * output after one is not "no bad hits". Exit 1 is a defined answer only for a
 * negative search (`rg -c` finding nothing), which is the `count:0` reading.
 */
export function satisfies(expected: string, stdout: string, exitCode: number | null): boolean {
  if (exitCode === null || !Number.isInteger(exitCode) || exitCode < 0 || exitCode > 1) return false;
  if (exitCode === 1 && expected !== "count:0") return false;
  const out = stdout.trim();
  if (expected === "exit:0") return exitCode === 0;
  if (expected === "nonempty") return out.length > 0;
  if (expected === "count:0") {
    // A "no bad hits" assert. `rg -c` prints nothing and exits 1 when it finds
    // nothing, so empty output is the same criterion as a literal 0 — reading it
    // any other way would make every negative assert look like a failure.
    if (out === "") return true;
    const n = Number(out.split(/\s+/)[0]);
    return Number.isFinite(n) && n === 0;
  }
  if (expected === "min:1") {
    const n = Number(out.split(/\s+/)[0]);
    return Number.isFinite(n) && n >= 1;
  }
  if (expected.startsWith("contains:")) return out.includes(expected.slice("contains:".length));
  return false;
}

/**
 * A drafted assert is TRIVIAL when its expectation is met by an empty result:
 * it can go green while proving nothing exists. `exit:0` and `count:0` are both
 * trivial by this rule and both get flagged, which is the point — a grep that
 * finds nothing passes on an empty repository too. `min:1`, `nonempty` and
 * `contains:` all require the command to produce something, so none is trivial.
 */
export function isTrivial(expected: string): boolean {
  return satisfies(expected, "", 0);
}

export interface DryRun {
  /** False when the command was not executed (no runner, refused shape); then `satisfied` is meaningless. */
  ran: boolean;
  exit: number | null;
  stdout: string;
  stderr: string;
  /** Whether the expectation holds on current state. A drafted assert that already fails is a real finding. */
  satisfied: boolean;
  skipped_reason?: string;
}

export interface DraftedAssert {
  /** Always `bash` today; the drafts are shell one-liners a person reads before ratifying. */
  type: "bash";
  command: string;
  expected: Expectation;
  dry_run: DryRun;
  /** True when the expectation is satisfied by empty output — the assert proves nothing (ISC-14). */
  trivial: boolean;
  /** Which of the three allowed sources this draft came from (ISC-33). */
  source?: AssertSource;
  /** The second run, on a repo where the criterion is false. A draft with no discrimination is not recorded. */
  discrimination?: Discrimination;
}

/**
 * Where a codable draft is allowed to come from (ISC-33). There is no fourth
 * source, and in particular no keyword grep: `rg -l <a word from the criterion> .`
 * matches the ISA that states the criterion, so it passes on every repo and proves
 * nothing. Eighteen of those were written into a production app ISA and reverted.
 */
export type AssertSource = "claim-command" | "named-test" | "url-status";

/** Did the same assert come out differently on a repo where the criterion is false? */
export interface Discrimination {
  verdict: "discriminating" | "not a verifier" | "unverified";
  /** What was changed to make the criterion false: a path removed, or an expectation negated. */
  mutation: string;
  passed_on_repo: boolean;
  passed_on_mutation: boolean | null;
  note: string;
}

/**
 * The negation of an expectation, for a draft whose world cannot be mutated.
 * A curl against a live URL is the case: nothing local can make the site answer
 * differently, so the expectation is flipped instead and the same output has to
 * stop satisfying it.
 */
export function negateExpectation(expected: string): string | null {
  if (expected === "count:0") return "min:1";
  if (expected === "min:1") return "count:0";
  if (expected === "exit:0") return "exit:1";
  if (expected === "nonempty") return "empty";
  if (expected.startsWith("contains:")) {
    const token = expected.slice("contains:".length);
    // A status code negates to a different status; anything else to itself with
    // a marker appended, which no real output carries.
    if (/^\d{3}$/.test(token)) return `contains:${token === "404" ? "500" : "404"}`;
    return `contains:${token}-NEGATED`;
  }
  return null;
}

/** Reading a negated expectation. `satisfies` owns the real vocabulary; these are its two extra forms. */
export function satisfiesNegated(negated: string, stdout: string, exitCode: number | null): boolean {
  if (negated === "exit:1") return exitCode !== 0;
  if (negated === "empty") return exitCode !== null && stdout.trim().length === 0;
  return satisfies(negated, stdout, exitCode);
}

/** Commands that only read text. A pipeline made of nothing else cannot discriminate anything. */
const TEXT_ONLY = new Set(["rg", "grep", "egrep", "fgrep", "cat", "bat", "head", "tail", "wc", "sort", "uniq", "ls", "eza", "find", "fd", "echo", "printf", "cut", "tr", "awk", "sed"]);

/**
 * Is this draft nothing but a text search? Such a command answers "the words
 * appear somewhere", which is true of the document that states the criterion, so it
 * is refused as a source however it was reached.
 */
export function isTextGrep(command: string): boolean {
  const stages = command.split(/\|\||&&|\||;/).map((s) => s.trim()).filter(Boolean);
  if (stages.length === 0) return false;
  return stages.every((s) => {
    const head = s.replace(/^\(\s*/, "").split(/\s+/)[0] ?? "";
    return TEXT_ONLY.has(head.replace(/^.*\//, ""));
  });
}

/**
 * The five lines a Sol leg needs to write the assert this draft could not be.
 * Not prose: the fields are what BriefGate looks for — a boundary to test, the
 * commands allowed, what TRUE means, and the command that proves it landed.
 */
export interface SolBrief {
  claim: string;
  boundary: string;
  commands: string;
  truth: string;
  acceptance: string;
}

export function renderSolBrief(b: SolBrief): string {
  return [
    `CRITERION: ${b.claim}`,
    `BOUNDARY: ${b.boundary}`,
    `COMMANDS: ${b.commands}`,
    `TRUE WHEN: ${b.truth}`,
    `ACCEPTANCE: ${b.acceptance}`,
  ].join("\n");
}

// ── Mutation sensitivity (ISC-30) ───────────────────────────────────────────
//
// A question that answers the same way whether or not the claimed property is
// there is not a verifier, it is a rubber stamp. So every proposed question is
// asked twice: once against the state the producer emits, and once against that
// state with the claimed property deliberately removed or inverted. The mass the
// engine puts on its own baseline answer has to COLLAPSE on the mutated state.
//
// Everything in this section is pure and deterministic, so the mutation a
// person reads in the proposal is exactly the one the engine was shown.

/** The registry question id carrying the bar a mutated-state probability must fall below. */
export const MUTATION_BAR_ID = "mutation-sensitivity";

export type MutationVerdict = "sensitive" | "insensitive" | "unverified";

export interface MutationReport {
  verdict: MutationVerdict;
  /** Mass the engine put on its own answer, on the ORIGINAL state. */
  baseline_probability?: number;
  /** The same mass on the MUTATED state. `sensitive` means this fell below the bar. */
  mutated_probability?: number;
  /** The bar, read from the caller registry. Never a literal in code. */
  bar?: number;
  /** The engine's baseline answer, so a reader can see what the mass is mass OF. */
  baseline_answer?: string;
  /** What the mutation did, in words, so a person can check it removed the right thing. */
  mutation?: string;
  note: string;
}

const STOPWORDS = new Set([
  "that", "this", "with", "from", "when", "then", "every", "each", "must", "will", "does", "the", "and",
  "for", "are", "its", "has", "have", "into", "over", "only", "never", "always", "which", "their", "there",
  "been", "were", "shall", "would", "could", "should", "than", "them", "they", "what", "such", "also", "both",
]);

/** The criterion's own distinctive words, deterministic: longest first, capped. */
export function keyTerms(claim: string, limit = 6): string[] {
  const words = claim.toLowerCase().replace(/[^a-z0-9 ._/-]+/g, " ").split(/\s+/)
    .filter((w) => w.length >= 4 && !STOPWORDS.has(w));
  const unique = [...new Set(words)];
  unique.sort((a, b) => (b.length - a.length) || a.localeCompare(b));
  return unique.slice(0, limit);
}

/** The text payload inside a producer's state, whatever shape it came back in. */
export function stateText(state: string | object): string {
  if (typeof state === "string") return state;
  const o = state as Record<string, unknown>;
  if (typeof o.text === "string") return o.text;
  if (typeof o.stdout === "string") return o.stdout;
  return JSON.stringify(state, null, 2);
}

/** Put a mutated payload back into the shape it came from, so the engine sees the same kind of thing twice. */
export function withStateText(state: string | object, text: string): string | object {
  if (typeof state === "string") return text;
  const o = state as Record<string, unknown>;
  if (typeof o.text === "string") return { ...o, text };
  if (typeof o.stdout === "string") return { ...o, stdout: text };
  return text;
}

/** Mutate a named JSON field or row, preserving every unrelated value and the JSON shape. */
export function mutateState(state: string | object, q: IscQuestionFile, baseline?: string): { state: string | object; effective: boolean; note: string } {
  let value: unknown = state;
  let wrapper: "text" | "stdout" | undefined;
  const structured = /^(?:d1|http-json|test-json|log-tail|kv):/.test(q.state.producer);
  if (!structured && typeof state === "object" && !Array.isArray(state)) {
    const o = state as Record<string, unknown>;
    wrapper = typeof o.text === "string" ? "text" : typeof o.stdout === "string" ? "stdout" : undefined;
    if (wrapper) value = o[wrapper];
  }
  if (typeof value === "string") {
    const text = value;
    try { value = JSON.parse(text); } catch {
      if (structured) return { state, effective: false, note: "structured source did not contain JSON" };
      const m = mutateText(text, q, baseline);
      return { state: withStateText(state, m.text), effective: m.effective, note: m.note };
    }
  }
  const original = JSON.stringify(value);
  if (original === undefined) return { state, effective: false, note: "state is not JSON serializable" };
  const copy = JSON.parse(original);
  const names = new Set((q.claim.toLowerCase().match(/[a-z_][a-z0-9_-]*/g) ?? []).filter(n => !STOPWORDS.has(n)));
  let note = "no JSON row, field or key named the criterion";
  const visit = (v: unknown, path: string): boolean => {
    if (Array.isArray(v)) {
      const row = v.findIndex(x => x && typeof x === "object" && Object.values(x).some(y => typeof y === "string" && names.has(y.toLowerCase())));
      if (row >= 0) { v.splice(row, 1); note = `dropped named row ${path}[${row}]`; return true; }
      return v.some((x, i) => visit(x, `${path}[${i}]`));
    }
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      for (const key of Object.keys(o)) {
        if (names.has(key.toLowerCase())) {
          if (typeof o[key] === "boolean") { o[key] = !o[key]; note = `flipped ${path}.${key}`; }
          else { delete o[key]; note = `dropped field ${path}.${key}`; }
          return true;
        }
      }
      return Object.entries(o).some(([key, x]) => visit(x, `${path}.${key}`));
    }
    return false;
  };
  const effective = visit(copy, "$") && JSON.stringify(copy) !== original;
  if (!effective) return { state, effective: false, note };
  const result = typeof state === "string" ? JSON.stringify(copy, null, 2) : wrapper ? { ...state, [wrapper]: JSON.stringify(copy, null, 2) } : copy;
  return { state: result, effective: true, note };
}

/** A score question's ordered rungs. The canonical schema lets `criteria` also be a noul's true/false object, so this narrows. */
export function scoreRungs(q: IscQuestionFile): string[] {
  return Array.isArray(q.criteria) ? q.criteria : [];
}

/** The rung the criterion is NOT satisfied at, per the question's own recorded direction. */
export function worstRung(q: IscQuestionFile): string | undefined {
  const rungs = scoreRungs(q);
  return q.direction === "lower_is_better" ? rungs[rungs.length - 1] : rungs[0];
}

/** The rung the criterion IS satisfied at. */
export function bestRung(q: IscQuestionFile): string | undefined {
  const rungs = scoreRungs(q);
  return q.direction === "lower_is_better" ? rungs[0] : rungs[rungs.length - 1];
}

/**
 * Where a score mutation should push the state: away from whatever rung the
 * engine put it on. A baseline at the bad end is mutated toward the good end,
 * which is just as discriminating as the other direction and is why a score
 * question is never "untestable" for sitting at an end of its own ladder.
 */
export function scoreTarget(q: IscQuestionFile, baseline: string): string | undefined {
  const worst = worstRung(q);
  return baseline === worst ? bestRung(q) : worst;
}

/** A choice question's option names. The canonical schema stores them as the KEYS of a record. */
export function choiceOptions(q: IscQuestionFile): string[] {
  return q.options ? Object.keys(q.options) : [];
}

export interface Mutation {
  text: string;
  note: string;
  /**
   * Did the mutation actually take the claimed property OUT of the state?
   *
   * A score or choice mutation falls back to appending the other answer's
   * name to UNCHANGED state when no sentence names the criterion. The engine then
   * moves, but it moves because a bare word was appended, not because the
   * evidence went away — a tautology wearing a sensitivity verdict. Two
   * project rows passed that way. When this is false the row is unverified,
   * never sensitive.
   */
  effective: boolean;
}

/**
 * Remove or invert the property the question claims. Deterministic by
 * construction: sentence removal by key term first, and only when that removes
 * nothing does it fall through to negation.
 *
 * `baseline` is the engine's own answer on the original state, which is what
 * makes the `choice` mutation meaningful — swapping to a different option only
 * says something once you know which option was there.
 */
export function mutateText(text: string, q: IscQuestionFile, baseline?: string): Mutation {
  const terms = keyTerms(q.claim);
  const sentences = text.split(/(?<=[.!?])\s+/);
  const kept = sentences.filter((s) => !terms.some((t) => s.toLowerCase().includes(t)));
  const removed = sentences.length - kept.length;
  const strippedNote = `removed ${removed} of ${sentences.length} sentence(s) naming ${terms.slice(0, 3).join(", ")}`;

  if (q.kind === "score") {
    // Push away from wherever the engine put the state, using the question's
    // own recorded direction rather than assuming index 0 is the bad end.
    const target = scoreTarget(q, baseline ?? "") ?? scoreRungs(q)[0]!;
    const end = target === worstRung(q) ? "worst" : "best";
    return { text: `${kept.join(" ")}\n${target}`.trim(), note: `${strippedNote}, then asserted the ${end} rung: "${target}"`, effective: removed > 0 };
  }

  if (q.kind === "choice") {
    const opts = choiceOptions(q);
    const other = opts.find((o) => o !== baseline) ?? opts[0]!;
    if (baseline) {
      const re = new RegExp(`\\b${baseline.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi");
      if (re.test(text)) return { text: text.replace(re, other), note: `swapped every mention of "${baseline}" for "${other}"`, effective: true };
    }
    return { text: `${kept.join(" ")}\n${other}`.trim(), note: `${strippedNote}, then asserted "${other}"`, effective: removed > 0 };
  }

  if (removed > 0) return { text: kept.join(" ").trim(), note: strippedNote, effective: true };
  // Nothing named the criterion, so invert instead of deleting: a question whose
  // subject is not in the state at all still has to notice a negated predicate.
  const negated = text.replace(/\b(is|are|was|were|has|have|does|do|will|can|must)\b/i, (m) => `${m} not`);
  if (negated !== text) return { text: negated, note: "negated the first predicate in the state", effective: true };
  return { text: `It is false that: ${text}`, note: "no predicate to negate; prefixed an explicit falsehood", effective: true };
}

/**
 * Can this mutation say anything about this baseline?
 *
 * The mutation REMOVES the claimed property, so it can only move an answer in
 * one direction: toward "the property is absent". That makes it a real test
 * only when the engine started out saying the property IS present.
 *
 * A noul that already answered "no" has never demonstrated it can say yes, so
 * deleting the evidence and watching it stay "no" proves nothing — and on the
 * live production app ISA every such row grew MORE confident after the mutation
 * (0.66 → 0.87, 0.54 → 0.94), which is the engine being right and the test
 * being pointed the wrong way. Calling those questions "insensitive" would be a
 * false finding. They are untested, and usually because the producer is aimed
 * at the wrong state.
 *
 * Same trap for a score already sitting on the lowest rung: dropping it to the
 * lowest rung is a no-op.
 */
export function mutationTestable(q: IscQuestionFile, baseline: string): { testable: boolean; why?: string } {
  if (q.kind === "noul" && baseline !== "yes") {
    return { testable: false, why: "the engine already answered no on the original state, so removing the claimed property cannot show the question able to tell the two apart — check that the question's state producer is aimed at the artifact the criterion is about" };
  }
  // A score is always testable: a baseline at either end of the ladder mutates
  // toward the OTHER end, so there is no rung the mutation cannot move off.
  // Only a ladder with nowhere to go is untestable.
  if (q.kind === "score" && scoreRungs(q).length < 2) {
    return { testable: false, why: "the score question names fewer than two rungs, so there is no other rung to move the state to" };
  }
  return { testable: true };
}

/** The engine's own answer, as the key its probability mass is filed under. */
export function baselineAnswer(answer: { type: string; [k: string]: unknown }): string | null {
  if (answer.type === "noul") {
    const p = answer.noul as number;
    if (!Number.isFinite(p)) return null;
    // Mirrors Glance.noulValue: yes when p is at least its own complement; the comparison is Glance's yesAt.
    const yes = yesAt(p, 1 - p);
    return yes === null ? null : yes ? "yes" : "no";
  }
  if (answer.type === "choice") return typeof answer.choice === "string" ? answer.choice : null;
  if (answer.type === "score") {
    const probs = answer.probabilities as Record<string, number> | undefined;
    if (!probs) return null;
    const best = Object.entries(probs).sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))[0];
    return best ? best[0] : null;
  }
  return null;
}

/** How much probability mass sits on `baseline`. One rule for all three kinds. */
export function massOnBaseline(answer: { type: string; [k: string]: unknown }, baseline: string): number | null {
  if (answer.type === "noul") {
    const p = answer.noul as number;
    if (!Number.isFinite(p)) return null;
    return baseline === "yes" ? p : 1 - p;
  }
  const probs = answer.probabilities as Record<string, number> | undefined;
  if (probs && typeof probs[baseline] === "number") return probs[baseline];
  const confidence = answer.confidence as number | undefined;
  const picked = answer.type === "choice" ? answer.choice : undefined;
  if (typeof confidence === "number" && picked === baseline) return confidence;
  return null;
}

// ── State shaping ───────────────────────────────────────────────────────────
//
// An HTTP producer hands back a whole page, and the first 8 KB of a page is
// almost entirely <head>: meta tags, inlined CSS, a script bundle. Every
// Website question asked against that answered "no" and the mutation pass could
// not tell the two states apart, because the criterion's subject was never in the
// window. The fix is to send what a reader would see — the visible text — and,
// when the criterion names something distinctive, the window around it.

/** How the state handed to the engine was derived. Absent means it went through as the producer emitted it. */
export type StateShaping = "text" | "text+region";

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–",
  hellip: "…", rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”", middot: "·", bull: "•", copy: "©",
};

/** A numeric reference as a character, or undefined when it names no Unicode code point (fromCodePoint would throw). */
function codePoint(n: number): string | undefined {
  return Number.isInteger(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : undefined;
}

/** Decode the entity forms a page actually uses. Anything else is left alone rather than guessed at. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    const b = body.toLowerCase();
    if (b.startsWith("#x")) return codePoint(Number.parseInt(b.slice(2), 16)) ?? whole;
    if (b.startsWith("#")) return codePoint(Number.parseInt(b.slice(1), 10)) ?? whole;
    return NAMED_ENTITIES[b] ?? whole;
  });
}

/**
 * Is this producer output a page rather than data? Checked on the content, not
 * on the command, so a page read off disk is shaped the same way one fetched
 * over HTTP is.
 */
export function looksLikeHtml(raw: string): boolean {
  const head = raw.slice(0, 2_000).toLowerCase();
  if (/<!doctype\s+html/.test(head) || /<html[\s>]/.test(head) || /<head[\s>]/.test(head)) return true;
  // A fragment with no <html> wrapper still counts when it is mostly markup.
  const tags = raw.match(/<\/?[a-z][a-z0-9-]*\b[^>]*>/gi)?.length ?? 0;
  return tags >= 10 && /<\/(div|p|section|body|main|article|li|h[1-6])>/i.test(raw);
}

/** The visible text of a page: no markup, no script or style bodies, whitespace collapsed. */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, " ")
      // Script and style bodies are not visible text, and they are most of the
      // byte count. An unclosed one would swallow the rest of the page, so the
      // fallback below drops only the opening tag.
      .replace(/<(script|style|noscript|template|svg|iframe)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
      .replace(/<(?:script|style|noscript|template|svg|iframe)\b[^>]*>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|h[1-6]|tr|section|article|header|footer|nav|main|ul|ol|table|blockquote|pre)\s*>/gi, "\n")
      .replace(/<[^>]*>/g, " "),
  )
    .replace(/[^\S\n]+/g, " ")
    .replace(/ *\n[ \n]*/g, "\n")
    .trim();
}

/** Words too common to anchor a window on: they match boilerplate on every page. */
const SHAPING_STOPWORDS = new Set([
  "that", "this", "with", "from", "have", "has", "been", "they", "them", "their", "there", "then",
  "when", "what", "which", "while", "will", "would", "should", "must", "shall", "each", "every",
  "some", "any", "all", "not", "and", "the", "for", "are", "was", "were", "its", "into",
  "over", "under", "after", "before", "than", "also", "only", "both", "same", "other", "more",
  "most", "less", "least", "such", "does", "done", "make", "made", "show", "shows", "shown",
  "state", "states", "claim", "claims", "check", "checks", "page", "pages", "site", "sites",
  "file", "files", "text", "value", "values", "name", "names", "list", "lists", "item", "items",
  "user", "users", "data", "code", "line", "lines", "case", "cases", "work", "works", "true",
  "false", "yes", "one", "two", "three", "http", "https", "www", "com",
]);

/**
 * The criterion's own distinctive words, in the order the criterion gives them. A
 * backticked or quoted phrase is distinctive by construction, so those come
 * first; ordinary words qualify when they are long enough and not boilerplate.
 */
export function distinctiveTerms(claim: string): string[] {
  const quoted = [...claim.matchAll(/`([^`]{2,60})`|"([^"]{2,60})"|“([^”]{2,60})”/g)]
    .map((m) => (m[1] ?? m[2] ?? m[3]).trim())
    .filter((t) => t.length >= 2);
  const words = (claim.toLowerCase().match(/[a-z][a-z0-9'’_-]{3,}/g) ?? []).filter((w) => !SHAPING_STOPWORDS.has(w));
  const out: string[] = [];
  for (const t of [...quoted, ...words]) if (!out.some((s) => s.toLowerCase() === t.toLowerCase())) out.push(t);
  return out;
}

/** Where the first of the criterion's distinctive terms lands in the text, or null when none of them do. */
export function firstTermMatch(text: string, claim: string): { term: string; index: number } | null {
  for (const term of distinctiveTerms(claim)) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // A term that starts or ends with a non-word character cannot carry a word
    // boundary there, so the boundary is applied per side.
    const left = /^\w/.test(term) ? "\\b" : "";
    const right = /\w$/.test(term) ? "\\b" : "";
    const m = new RegExp(left + escaped + right, "i").exec(text);
    if (m) return { term, index: m.index };
  }
  return null;
}

export interface ShapedState { text: string; shaping?: StateShaping; term?: string }

/**
 * Turn what a producer emitted into the state the engine is asked about.
 *
 * Non-HTML output is passed through and merely capped. A page becomes its
 * visible text; when that still exceeds the cap the window is centred on the
 * first distinctive term of the criterion, so the engine reads the part of the page
 * the criterion is actually about instead of the head.
 */
export function shapeState(raw: string, claim: string, cap: number): ShapedState {
  // Everything returned here fits INSIDE the cap, elision markers included. A
  // window that overflows is truncated again downstream, and the tail it loses
  // is the end of the very region it was centred on.
  const MARKERS = 4;
  const clip = (t: string) => (t.length > cap ? t.slice(0, cap - 2) + " …" : t);
  if (!looksLikeHtml(raw)) return { text: clip(raw) };
  const text = htmlToText(raw);
  if (text.length <= cap) return { text, shaping: "text" };
  const hit = firstTermMatch(text, claim);
  if (!hit) return { text: clip(text), shaping: "text" };
  const inner = Math.max(1, cap - MARKERS);
  const start = Math.max(0, Math.min(hit.index - Math.floor(inner / 2), text.length - inner));
  const end = Math.min(text.length, start + inner);
  const head = start > 0 ? "… " : "";
  const tail = end < text.length ? " …" : "";
  return { text: head + text.slice(start, end) + tail, shaping: "text+region", term: hit.term };
}

// ── The proposal file ───────────────────────────────────────────────────────

/**
 * What tier the row is proposed for.
 *
 * `manual` is the mechanical human rung: the row could be read by a question,
 * but no boundary producer could be drafted or run for it, so there is nothing
 * to propose. It is distinct from `taste`, which stays manual because a person's
 * preference is the only thing that can decide it. Keeping them apart matters:
 * a `manual` row is a producer away from being a glance row, a `taste` row
 * never will be.
 */
export type Classification = "codable" | "readable" | "taste" | "manual" | "retire";

/**
 * The corroboration of a `codable` choice by the `shell-settles` noul asked
 * beside it. `confirmed: false` demotes the row to `readable`.
 */
export interface Confirmation {
  /** The noul's question id, which is also its registry threshold key. */
  question: string;
  /** The bar, from the caller registry. Never a literal in code. */
  bar?: number;
  /** The noul's probability that a shell command would settle the criterion. */
  probability?: number;
  confirmed: boolean;
  note: string;
}

/**
 * Who decided a row's tier.
 *
 * `engine-shadow` — Glance answered, in shadow mode. The ANSWER is what gets
 * read (the choice and its probabilities), never `decide()`'s verdict: a
 * shadow caller always returns `act: false`, and a proposal is a draft for a
 * human to ratify, not an action. Nothing in this file acts on a probability.
 * `fallback` — the engine was disabled, unregistered-and-failing, or errored,
 * and a deterministic keyword pass decided instead.
 */
export type ClassifierPath = "engine-shadow" | "fallback";

export interface ProposalRow {
  isc: string;
  /**
   * Which manual row of this ISC the proposal is about, 1-based. A criterion may
   * carry several manual checks, so the id alone does not address a row; `apply`
   * counts manual rows per id and matches on the pair. Absent on a proposal
   * written before this field existed, and read as 1.
   */
  occurrence?: number;
  /** The criterion's prose from the ISA body, or "" when the row has no matching criterion. */
  claim: string;
  /** The manual row's `check` cell, verbatim. */
  check: string;
  /** The manual row's `threshold` cell, verbatim. Kept so `apply` can see what it replaces. */
  threshold: string;
  classification: Classification;
  classified_by: ClassifierPath;
  /** The engine's certainty in its own pick, when the engine decided. Never compared to anything here. */
  confidence?: number;
  /**
   * The second, independent route to the same fact: a noul asked in the same
   * call as the tier choice. A `codable` choice this does not confirm is
   * recorded as `readable` instead, and the record of why stays here.
   */
  confirmation?: Confirmation;
  reason: string;
  /** Present when `classification` is `codable`. */
  assert?: DraftedAssert;
  /**
   * Present when `classification` is `retire` (ISC-35): the non-manual rows of
   * the same criterion that already check it, named so a reader can see the row is
   * a duplicate rather than an unchecked criterion being dropped.
   */
  covered_by?: string[];
  /**
   * Present when a codable draft was refused as `not a verifier` (ISC-33). The
   * row stays manual and this is the dispatch: five lines a Sol leg can act on
   * without re-deriving the criterion.
   */
  brief?: SolBrief;
  /** Present when `classification` is `readable`. */
  question?: IscQuestionFile;
  /**
   * How the state the engine was asked about was derived from the producer's
   * raw output. Absent means it went through as emitted. A reader ratifying the
   * row needs this: "the page text around `sponsor`" and "the first 8 KB of
   * HTML" are different questions with the same producer.
   */
  state_shaping?: StateShaping;
  /** The criterion term a `text+region` window was centred on. */
  state_region_term?: string;
  /** Path relative to the ISA directory that `apply` writes the question to. */
  question_file?: string;
  /**
   * ISC-27. The boundary the question's state is fetched through, and what
   * happened when `propose` ran it once. `resolved: false` means no producer
   * could be drafted, or the drafted one failed or returned nothing — the row
   * then carries no usable question and its mutation stays unverified.
   */
  producer?: {
    resolved: boolean;
    command?: string;
    /** Which boundary this reads, in words, so a person can see whether it is the right one. */
    boundary?: string;
    exit?: number | null;
    bytes?: number;
    reason?: string;
  };
  /**
   * ISC-30. Present on every readable row. `apply` writes a question only when
   * the verdict is `sensitive`: the drafted question stays in the proposal
   * either way, because "here is what we tried and here is why it cannot fail"
   * is the finding, and deleting it would hide it.
   */
  mutation?: MutationReport;
  /** The human ratification record. `apply` touches nothing that is not true. */
  ratified: boolean;
}

export interface IscTierProposal {
  version: 1;
  isa: string;
  /** sha256 of the ISA at propose time. `apply` refuses on a mismatch rather than editing a table it never read. */
  isa_sha256: string;
  generated: string;
  classifier: { path: ClassifierPath; caller: string; note: string };
  rows: ProposalRow[];
}

export const PROPOSAL_FILENAME = "IscTierProposal.json";
/**
 * The proposal is tooling state, not part of the project, so it lives in a dot
 * directory rather than the repo root. An ISA often sits at the root of a
 * product repo, and a 30 KB draft landing beside package.json is noise in
 * someone else's working tree.
 */
export const PROPOSAL_DIR = ".isc-tier";

/** Where propose writes and shadow looks first. */
export function proposalPathFor(isaDir: string): string {
  return join(isaDir, PROPOSAL_DIR, PROPOSAL_FILENAME);
}

/** The pre-.isc-tier location, still read so an existing proposal keeps working. */
export function legacyProposalPathFor(isaDir: string): string {
  return join(isaDir, PROPOSAL_FILENAME);
}
export const PROPOSAL_VERSION = 1 as const;

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function renderProposal(p: IscTierProposal): string {
  return `${JSON.stringify(p, null, 2)}\n`;
}

/** Throws with a precise reason on a malformed proposal. Never returns a partly-valid object. */
/**
 * Reading a proposal back.
 *
 * `isaPath` lets a producer be checked against the directory it will actually
 * run in; without it a `file:` producer has no root and is always denied.
 * `notes` collects the problems that belong to rows nobody ratified: those are
 * reported, never thrown, because one unratified row with an unusable producer
 * must not make the whole proposal unreadable. A ratified row still throws —
 * that one is about to be written into an ISA.
 */
export function parseProposal(text: string, where = "proposal", opts: { isaPath?: string; notes?: string[] } = {}): IscTierProposal {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch (e) { throw new Error(`${where}: not valid JSON — ${(e as Error).message}`); }
  const p = raw as Partial<IscTierProposal> | null;
  if (!p || typeof p !== "object" || Array.isArray(p)) throw new Error(`${where}: not a JSON object`);
  if (p.version !== PROPOSAL_VERSION) throw new Error(`${where}: version must be ${PROPOSAL_VERSION} (got ${String(p.version)})`);
  if (typeof p.isa !== "string" || p.isa === "") throw new Error(`${where}: isa path is required`);
  if (typeof p.isa_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(p.isa_sha256)) throw new Error(`${where}: isa_sha256 must be a sha256 hex digest`);
  if (typeof p.generated !== "string" || p.generated === "") throw new Error(`${where}: generated timestamp is required`);
  if (!p.classifier || typeof p.classifier !== "object") throw new Error(`${where}: classifier block is required`);
  if (p.classifier.path !== "engine-shadow" && p.classifier.path !== "fallback") throw new Error(`${where}: classifier.path must be engine-shadow or fallback`);
  if (!Array.isArray(p.rows)) throw new Error(`${where}: rows must be an array`);
  p.rows.forEach((row, i) => validateRow(row, `${where}.rows[${i}]`, opts));
  return p as IscTierProposal;
}

function validateRow(value: unknown, where: string, opts: { isaPath?: string; notes?: string[] } = {}): void {
  const r = value as Partial<ProposalRow> | null;
  if (!r || typeof r !== "object" || Array.isArray(r)) throw new Error(`${where}: not a JSON object`);
  if (typeof r.isc !== "string" || r.isc === "") throw new Error(`${where}: isc is required`);
  if (r.occurrence !== undefined && (!Number.isInteger(r.occurrence) || r.occurrence < 1)) throw new Error(`${where}: occurrence must be a positive integer`);
  if (!(["codable", "readable", "taste", "manual", "retire"] as const).includes(r.classification as Classification)) {
    throw new Error(`${where}: classification must be codable, readable, taste, manual or retire`);
  }
  if (r.classified_by !== "engine-shadow" && r.classified_by !== "fallback") throw new Error(`${where}: classified_by must be engine-shadow or fallback`);
  if (typeof r.ratified !== "boolean") throw new Error(`${where}: ratified must be a boolean`);
  if (r.classification === "codable") {
    const a = r.assert;
    if (!a || typeof a !== "object") throw new Error(`${where}: a codable row needs a drafted assert`);
    if (typeof a.command !== "string" || a.command.trim() === "") throw new Error(`${where}.assert: command is required`);
    if (typeof a.expected !== "string" || a.expected.trim() === "") throw new Error(`${where}.assert: expected is required`);
    if (typeof a.trivial !== "boolean") throw new Error(`${where}.assert: trivial flag is required`);
    if (!a.dry_run || typeof a.dry_run !== "object") throw new Error(`${where}.assert: dry_run is required`);
    if (a.trivial !== isTrivial(a.expected)) throw new Error(`${where}.assert: trivial flag disagrees with expectation "${a.expected}"`);
    // ISC-33: a recorded codable draft has been shown to come out differently
    // on a repo where the criterion is false. Anything else stays manual.
    if (!a.source) throw new Error(`${where}.assert: source is required (claim-command, named-test or url-status)`);
    if (!a.discrimination || a.discrimination.verdict !== "discriminating") {
      throw new Error(`${where}.assert: a codable row needs a discriminating draft, not ${a.discrimination?.verdict ?? "an unchecked one"}`);
    }
  }
  if (r.classification === "readable") {
    // `readable` now means exactly "this becomes a glance row", so the question
    // and its file are required. A row that could be read but has no boundary
    // producer is classified `manual` instead, which is why this check can be
    // unconditional: it used to throw on rows propose had legitimately emitted
    // without a question, and a proposal that cannot be parsed cannot be
    // ratified or applied at all.
    if (typeof r.question_file !== "string" || r.question_file === "") throw new Error(`${where}: a readable row needs a question_file path`);
    // The path is written to at apply time, so it has to be a plain relative
    // path inside the ISA directory. apply re-checks by realpath;
    // this catches the lexical escapes before a proposal can be ratified.
    if (isAbsolute(r.question_file) || r.question_file.includes("\0") || r.question_file.split(/[\\/]/).includes("..")) {
      throw new Error(`${where}: question_file must be a relative path inside the ISA directory, not "${r.question_file}"`);
    }
    try {
      validateQuestionFile(r.question, `${where}.question`, opts.isaPath);
    } catch (e) {
      // A producer is only a problem for a row that is about to be written. For
      // an unratified row it is a note: refusing the file would hide every other
      // row, including the ratified ones, behind a draft nobody chose.
      const message = (e as Error).message;
      if (r.ratified || !/producer denied/.test(message)) throw e;
      opts.notes?.push(`${where}: left as a draft — its producer is not usable as written: ${message}`);
    }
    const m = r.mutation;
    if (!m || typeof m !== "object") throw new Error(`${where}: a readable row needs a mutation-sensitivity report (ISC-30)`);
    if (m.verdict !== "sensitive" && m.verdict !== "insensitive" && m.verdict !== "unverified") {
      throw new Error(`${where}.mutation: verdict must be sensitive, insensitive or unverified`);
    }
    if (typeof m.note !== "string" || m.note.trim() === "") throw new Error(`${where}.mutation: note is required`);
  }
  if ((r.classification === "taste" || r.classification === "manual" || r.classification === "retire") && (typeof r.reason !== "string" || r.reason.trim() === "")) {
    throw new Error(`${where}: a row that stays on the human rung, or leaves the table, must say why`);
  }
  if (r.classification === "retire") {
    // ISC-35: a retire row is a dead duplicate. It proposes nothing, because
    // there is nothing left to propose — the criterion is already covered.
    if (r.question !== undefined || r.question_file !== undefined) throw new Error(`${where}: a retire row proposes no question`);
    if (r.assert !== undefined) throw new Error(`${where}: a retire row proposes no assert`);
    if (r.brief !== undefined) throw new Error(`${where}: a retire row proposes no brief: nothing needs writing`);
    if (!Array.isArray(r.covered_by) || r.covered_by.length === 0) throw new Error(`${where}: a retire row names the rows that already cover the criterion`);
  }
  if (r.classification === "manual") {
    if (r.question !== undefined) throw new Error(`${where}: a manual row proposes no question`);
    if (r.question_file !== undefined) throw new Error(`${where}: a manual row proposes no question file`);
  }
}

// ── Test Strategy cell surgery ──────────────────────────────────────────────
//
// `apply` edits INDIVIDUAL CELLS of an existing row rather than rebuilding the
// line, so a table whose column order differs from the legacy one (real ISAs
// disagree — see IsaTestStrategy.ts § COLUMN IDENTITY) keeps every other cell
// byte-identical. Column identity is resolved from the table's own header, and
// every edit is guarded by an identity check on the cells it is about to touch:
// if the resolved `isc` and `type` cells do not hold the values the parser
// reported, the row is refused instead of edited.

export type Field = "isc" | "type" | "check" | "threshold" | "tool" | "anchors_to" | "severity" | "tier" | "stage";

/** Mirrors IsaTestStrategy.ts HEADER_ALIASES; that map is not exported, so it is duplicated here and must stay in step. */
const HEADER_ALIASES: Readonly<Record<string, Field>> = {
  isc: "isc", type: "type", check: "check", threshold: "threshold", tool: "tool",
  anchors_to: "anchors_to", "anchors to": "anchors_to", severity: "severity",
  tier: "tier", lane: "tier", stage: "stage",
};
/** Mirrors IsaTestStrategy.ts LEGACY_INDEX. */
const LEGACY_INDEX: Readonly<Record<Field, number>> = {
  isc: 0, type: 1, check: 2, threshold: 3, tool: 4, anchors_to: 5, severity: 6, tier: 7, stage: 8,
};

/** Split a markdown table row on unescaped pipes, exactly as the ISA parser does. */
export function splitRow(line: string): string[] {
  return line.split(/(?<!\\)\|/).slice(1, -1).map((c) => c.trim().replace(/\\\|/g, "|"));
}

/** Rejoin cells into a table row, re-escaping any literal pipe a cell now holds. */
export function joinRow(cells: string[]): string {
  return `| ${cells.map((c) => c.replace(/\|/g, "\\|")).join(" | ")} |`;
}

/** Resolve each semantic field to a cell index for one table's header. Mirrors IsaTestStrategy.resolveColumns. */
export function resolveColumns(header: string[] | null): Record<Field, number> {
  const idx: Partial<Record<Field, number>> = {};
  const claimed = new Set<number>();
  if (header) {
    header.forEach((cell, i) => {
      const key = HEADER_ALIASES[cell.trim().toLowerCase()];
      if (key && idx[key] === undefined) { idx[key] = i; claimed.add(i); }
    });
  }
  for (const key of Object.keys(LEGACY_INDEX) as Field[]) {
    if (idx[key] !== undefined) continue;
    const legacy = LEGACY_INDEX[key];
    if (claimed.has(legacy)) continue;
    idx[key] = legacy;
  }
  return idx as Record<Field, number>;
}

/** Strip one wrapping pair of backticks, as the ISA parser does before reading a tool cell. */
export function unwrapCode(cell: string): string {
  const t = cell.trim();
  return t.length > 1 && t.startsWith("`") && t.endsWith("`") ? t.slice(1, -1).trim() : cell;
}
