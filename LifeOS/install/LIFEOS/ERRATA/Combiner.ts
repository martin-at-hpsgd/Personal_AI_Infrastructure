/**
 * Combiner.ts — Errata v4's learned combiner at read time (ISA F6, ISC-44).
 *
 * The composers in Questions.ts turn noul answers into a diagnosis with hand-written rules and one
 * registry cut per question. Fed the labelers' own answers they score 91.8% on gold, so the rules
 * are sound; fed the engine's probabilities at fixed cuts they lose most of that, because a single cut
 * throws away how far each probability sits from it and how the questions co-vary. The combiner
 * reads the probabilities directly, the way the router's learned heads do (LIFEOS/ROUTER/LaneQuestions.ts):
 *
 * - a detect head (softmax over [not_failure, failure]) over the stage-1 answers plus cheap
 *   deterministic features of the prompt, so production can decide who gets stage 2 from stage 1;
 * - a class head (softmax over the 13 failure classes) over every asked answer plus the same
 *   features, read only when the detect head calls a failure.
 *
 * `class_source` says which call names a failure's primary class: the class head; the
 * composer's rules over the registry cuts (`composeFailure`); or the composer with its primary
 * settled by a discriminator tournament (`composeFailureWithDiscriminators`, ISC-53), playing the
 * discriminators the model file lists. Train.ts picks it by cross-validated class accuracy among
 * the exchanges the gold majority calls failures. The heads decide by argmax, so no probability is
 * compared against a literal here; cuts stay in the registry and only the composer reads them.
 * Severity and secondary classes always come from the composer's flags. The model file is written by Train.ts and validated on every
 * load; a missing or malformed file makes `loadTriageModel` return null and callers fall back to
 * the composer. Nothing here calls a model.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { lengthFeature } from "../ROUTER/LaneQuestions";
import type { Exchange } from "./Exchanges";
import { KEPT_DISCRIMINATORS, KNOWN_IDS, V3_CLASSES, composeFailure, composeFailureWithDiscriminators, prob, stageOf, toSlots, type Cuts, type Diagnosis, type DiscriminatorId } from "./Questions";
import { frustrationRead } from "./Signals";
import { validClassTierConfig, type ClassTierConfig } from "./ClassTier";

export const MODEL_PATH = join(import.meta.dir, "triage-model.json");

/**
 * Cheap deterministic features beside the nouls, each justified on gold round 1: the regex read is
 * an independent detection signal (79.6% weighted on its own) and its parts separate a profane
 * complaint from profane enthusiasm; length separates one-word approvals ("y", "do it") from
 * complaints; a session's first message cannot be reacting to a reply.
 */
export const EXTRA_FEATURES = ["length", "no_reply", "regex_fires", "regex_score", "regex_profanity", "regex_repeat", "regex_correction"] as const;
export type ExtraFeature = (typeof EXTRA_FEATURES)[number];
export const DETECT_CLASSES = ["not_failure", "failure"] as const;
export const FAILURE_CLASSES: readonly string[] = Object.keys(V3_CLASSES).filter((c) => c !== "not_a_failure");

export type Head = { features: string[]; classes: string[]; weights: number[][] };
export const CLASS_SOURCES = ["head", "composer", "tournament"] as const;
export type ClassSource = (typeof CLASS_SOURCES)[number];
export type TriageModel = {
  version: 1;
  trained: string;
  detect: Head;
  class: Head;
  l2: number;
  epochs: number;
  samples: number;
  /** "corpus": each gold row weighted by its stratum's share of the corpus, so argmax targets the population. */
  weighting: "corpus" | "none";
  /** Who names a failure's primary class: the class head, the composer's rules at the registry cuts, or the composer settled by a discriminator tournament. */
  class_source: ClassSource;
  /** The discriminators the tournament plays: empty unless class_source is "tournament", and then a nonempty subset of Questions.ts KEPT_DISCRIMINATORS, since only those are asked. */
  discriminators: DiscriminatorId[];
  /** Session-grouped 5-fold accuracy on gold, corpus-weighted, at training time: detection, class over every decided row, and class among the rows the majority calls failures (ISC-53). */
  cv: { detect: number; class: number; class_among_failures: number };
  /**
   * The model class tier (ClassTier.ts, ISC-53) and its second look (ISC-56), as chosen on gold by
   * `ClassTier.ts eval --write`. Absent: the glance tier names every class and the detect head alone detects.
   */
  class_tier?: ClassTierConfig;
};
export type Context = { prompt: string; hasReply: boolean };
export const contextOf = (ex: Pick<Exchange, "prompt" | "reply_tail">): Context => ({ prompt: ex.prompt, hasReply: ex.reply_tail.trim().length > 0 });

export function extraFeature(f: ExtraFeature, ctx: Context): number {
  const r = frustrationRead(ctx.prompt);
  switch (f) {
    case "length": return lengthFeature(ctx.prompt);
    case "no_reply": return ctx.hasReply ? 0 : 1;
    case "regex_fires": return r.fires ? 1 : 0;
    case "regex_score": return r.score / 3;
    case "regex_profanity": return Math.min(1, r.profanity / 3);
    case "regex_repeat": return r.repeat ? 1 : 0;
    case "regex_correction": return r.correction ? 1 : 0;
  }
}

/** The input row in `features` order; null when a question's answer is missing or out of range. Pure. */
export function featureVector(features: readonly string[], answers: Record<string, unknown>, ctx: Context): number[] | null {
  const x: number[] = [];
  for (const f of features) {
    if ((EXTRA_FEATURES as readonly string[]).includes(f)) { x.push(extraFeature(f as ExtraFeature, ctx)); continue; }
    const p = prob(answers[f] as number | undefined);
    if (p === null) return null;
    x.push(p);
  }
  return x;
}

export function softmax(weights: number[][], x0: number[]): number[] {
  const x = [1, ...x0];
  const z = weights.map((row) => row.reduce((s, w, i) => s + w * x[i]!, 0));
  const m = Math.max(...z), e = z.map((v) => Math.exp(v - m)), s = e.reduce((a, b) => a + b, 0);
  return e.map((v) => v / s);
}

const finite = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const argmax = (p: number[]): number => p.reduce((best, v, i) => (v > p[best]! ? i : best), 0);

function validHead(h: unknown, classes: readonly string[], allowed: ReadonlySet<string>): h is Head {
  if (!h || typeof h !== "object") return false;
  const { features, classes: c, weights: w } = h as Head;
  return Array.isArray(features) && features.length > 0 && new Set(features).size === features.length && features.every((f) => typeof f === "string" && allowed.has(f)) &&
    Array.isArray(c) && c.length === classes.length && c.every((x, i) => x === classes[i]) &&
    Array.isArray(w) && w.length === classes.length && w.every((row) => Array.isArray(row) && row.length === features.length + 1 && row.every(finite));
}

/** The tournament plays a nonempty, duplicate-free subset of the kept (asked) discriminators; every other class source plays none. Pure. */
function validDiscriminators(m: TriageModel): boolean {
  const d: unknown = m.discriminators;
  if (!Array.isArray(d) || new Set(d).size !== d.length) return false;
  if (m.class_source !== "tournament") return d.length === 0;
  return d.length > 0 && d.every((x) => (KEPT_DISCRIMINATORS as readonly string[]).includes(x));
}

/** Structural check of a parsed model file. Detect features may only be stage-1 answers or extras, since stage 2 is asked after detection. Pure. */
export function validTriageModel(value: unknown): value is TriageModel {
  if (!value || typeof value !== "object") return false;
  const m = value as TriageModel;
  const stage1 = new Set<string>([...KNOWN_IDS.filter((id) => stageOf(id) === 1), ...EXTRA_FEATURES]);
  const all = new Set<string>([...KNOWN_IDS, ...EXTRA_FEATURES]);
  return m.version === 1 && typeof m.trained === "string" && !Number.isNaN(Date.parse(m.trained)) &&
    validHead(m.detect, DETECT_CLASSES, stage1) && validHead(m.class, FAILURE_CLASSES, all) &&
    finite(m.l2) && m.l2 >= 0 && Number.isInteger(m.epochs) && m.epochs > 0 && Number.isInteger(m.samples) && m.samples > 0 &&
    (m.weighting === "corpus" || m.weighting === "none") && (CLASS_SOURCES as readonly string[]).includes(m.class_source) && validDiscriminators(m) &&
    !!m.cv && typeof m.cv === "object" && finite(m.cv.detect) && finite(m.cv.class) && finite(m.cv.class_among_failures) &&
    (m.class_tier === undefined || validClassTierConfig(m.class_tier));
}

/** The model at `path`, or null when it is absent, unparsable or fails validation. Never throws. */
export function loadTriageModel(path: string = MODEL_PATH): TriageModel | null {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return validTriageModel(value) ? value : null;
  } catch {
    return null;
  }
}

export type Prediction = { is_failure: boolean; pFailure: number; primary: string; pClass: number };

/** Detection from stage-1 answers; null when a feature is missing. Pure. */
export function predictDetect(model: TriageModel, answers: Record<string, unknown>, ctx: Context): { is_failure: boolean; pFailure: number } | null {
  const x = featureVector(model.detect.features, answers, ctx);
  if (!x) return null;
  const p = softmax(model.detect.weights, x);
  return { is_failure: model.detect.classes[argmax(p)] === "failure", pFailure: p[model.detect.classes.indexOf("failure")]! };
}

/**
 * The composer's diagnosis of a failure over answers and cuts keyed by asked id: plain for the
 * head and composer sources, settled by the model's discriminator tournament for "tournament".
 * Discriminators are not slots, so their answers and cuts pass through beside the re-keyed slots. Pure.
 */
function composedFailure(model: TriageModel, answers: Record<string, number>, cuts: Cuts): Diagnosis | null {
  if (model.class_source !== "tournament") return composeFailure(toSlots(answers), toSlots(cuts));
  const pick = (m: Record<string, number>) => Object.fromEntries(model.discriminators.filter((id) => m[id] !== undefined).map((id) => [id, m[id]!]));
  return composeFailureWithDiscriminators({ ...toSlots(answers), ...pick(answers) }, { ...toSlots(cuts), ...pick(cuts) }, model.discriminators);
}

/**
 * Detection plus, for a failure, the primary class from the model's `class_source`; null when any
 * needed answer is missing, or when the composer names the class and no cuts are given. Pure.
 */
export function predictTriage(model: TriageModel, answers: Record<string, number>, ctx: Context, cuts?: Cuts): Prediction | null {
  const d = predictDetect(model, answers, ctx);
  if (!d) return null;
  if (!d.is_failure) return { ...d, primary: "not_a_failure", pClass: 1 - d.pFailure };
  if (model.class_source !== "head") {
    if (!cuts) return null;
    const f = composedFailure(model, answers, cuts);
    return f ? { ...d, primary: f.primary, pClass: NaN } : null;
  }
  const x = featureVector(model.class.features, answers, ctx);
  if (!x) return null;
  const p = softmax(model.class.weights, x);
  const k = argmax(p);
  return { ...d, primary: model.class.classes[k]!, pClass: p[k]! };
}

/**
 * The combiner's full diagnosis over answers keyed by asked question id: detection and primary
 * class from the heads, secondary classes and severity from the composer's registry-cut flags.
 * Null when an answer or cut it needs is missing (a failure without its stage-2 answers is pending).
 */
export function diagnoseWithModel(model: TriageModel, answers: Record<string, number>, ctx: Context, cuts: Cuts): Diagnosis | null {
  const d = predictDetect(model, answers, ctx);
  if (!d) return null;
  if (!d.is_failure) return { is_failure: false, defect: false, primary: "not_a_failure", secondary: [], severity: 0, weak: false };
  return failureDiagnosisWithModel(model, answers, ctx, cuts);
}

/**
 * The glance-tier diagnosis of an exchange already known to be a failure, by the detect head or by the
 * model class tier's second look (ClassTier.ts): the primary class from the model file's class
 * source, secondary classes and severity from the composer. Null when an answer or cut is missing. Pure.
 */
export function failureDiagnosisWithModel(model: TriageModel, answers: Record<string, number>, ctx: Context, cuts: Cuts): Diagnosis | null {
  const f = composedFailure(model, answers, cuts);
  if (!f) return null;
  if (model.class_source !== "head") return f;
  const x = featureVector(model.class.features, answers, ctx);
  if (!x) return null;
  const primary = model.class.classes[argmax(softmax(model.class.weights, x))]!;
  const cleared = [f.primary, ...f.secondary].filter((c) => c !== primary);
  return { ...f, primary, defect: primary !== "external", secondary: f.weak ? f.secondary.filter((c) => c !== primary) : cleared, weak: false };
}
