#!/usr/bin/env bun
/**
 * Train.ts — fit and measure Errata v4's learned combiner and per-question cuts on gold (ISA F6, ISC-44).
 *
 *   bun LIFEOS/ERRATA/Train.ts                 cross-validated report on gold (no writes)
 *   bun LIFEOS/ERRATA/Train.ts --write         also write LIFEOS/ERRATA/triage-model.json, trained on all gold
 *   bun LIFEOS/ERRATA/Train.ts --calibrate     also write every question's cut to the errata-triage registry row
 *   bun LIFEOS/ERRATA/Train.ts --register      register every variant, discriminator and calm-failure noul id missing from the registry, in shadow
 *
 * The router's recipe (LIFEOS/ROUTER/LaneTrain.ts): softmax heads by deterministic zero-init batch
 * gradient descent, scored session-grouped 5-fold so no session is in both train and test. Two
 * departures, both forced by how gold was drawn. Gold over-samples v4's own failures (180 of 300
 * against 28% of the corpus), so each row carries its stratum's corpus weight in the loss and in
 * every accuracy, and argmax then targets the corpus rather than the sample. And cuts are fitted
 * inside the folds: a question's cut is the one with the best balanced accuracy on the training
 * folds, applied to the held-out fold, so the composer's cross-validated score is never scored on
 * rows its cuts were chosen on. The holdout set (Eval.ts --set holdout) is never read here.
 *
 * ISC-53 adds the class picker's choice. Discriminators (Questions.ts) get a cut per fold from their
 * pair's rows among majority failures; backward elimination keeps those whose removal costs
 * held-out class accuracy among majority failures; and the class source (class head, composer,
 * or composer settled by a discriminator tournament) is the one with the best such accuracy,
 * weighted. `--write` refuses a tournament whose played set differs from KEPT_DISCRIMINATORS.
 *
 * Reads gold through Eval.ts (cached Glance answers, offline; it asks no question itself). Writes
 * only triage-model.json and, with --calibrate or --register, the errata-triage caller's row of the
 * Glance system's registry (LIFEOS/DOCUMENTATION/Assay/AssaySystem.md, section The caller contract).
 */
import { readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { defaultCallersPath, loadRegistry, registerQuestion, thresholdRows, validateCallers, writeThresholdRows, yesAt, type CallerThreshold, type GroundTruth } from "../ASSAY/Assay";
import { invariant } from "../TOOLS/Invariant";
import { DETECT_CLASSES, EXTRA_FEATURES, FAILURE_CLASSES, MODEL_PATH, featureVector, loadTriageModel, predictTriage, softmax, validTriageModel, type Context, type Prediction, type TriageModel } from "./Combiner";
import { ASKED_FOR, DETECT_EXTRA_IDS, DISCRIMINATORS, DISCRIMINATOR_IDS, KEPT_DETECT_EXTRAS, KEPT_DISCRIMINATORS, QUESTION_IDS, SLOT_IDS, STAGE1, VARIANTS, VARIANT_IDS, composeDiagnosis, isDiscriminator, pairTruth, slotOf, toSlots, type Cuts, type DetectExtraId, type Diagnosis, type DiscriminatorId, type VariantId } from "./Questions";

export const CALLER = "errata-triage";
export const FOLDS = 5;
/** l2 chosen on gold CV from 0.0003–0.1 (0.001 best on both heads; the spread was under 2 points), with and without corpus weighting. */
export const TRAIN_OPTIONS = { l2: 0.001, lr: 0.5, epochs: 2000 } as const;
export type TrainOptions = { l2: number; lr: number; epochs: number };

/** One gold row as the trainer sees it. `answers` is keyed by question id (labeled slots and variants). */
export type Sample = {
  id: string;
  session: string;
  weight: number;
  answers: Record<string, number>;
  ctx: Context;
  gold: { answers: Record<string, boolean>; class: string | null; failure: boolean };
};

// ── fitting ─────────────────────────────────────────────────────────────────

/** Weighted softmax regression by batch gradient descent. Deterministic: zero init, fixed order, no randomness. */
export function trainSoftmax(X: number[][], y: number[], k: number, w: number[] | null = null, opts: TrainOptions = TRAIN_OPTIONS): number[][] {
  invariant(X.length > 0 && X.length === y.length && (!w || w.length === X.length), "trainSoftmax needs matching nonempty X, y and weights");
  invariant(y.every((c) => Number.isInteger(c) && c >= 0 && c < k), "trainSoftmax labels must be class indices");
  const d = X[0]!.length;
  const wt = w ?? X.map(() => 1);
  const total = wt.reduce((a, b) => a + b, 0);
  invariant(total > 0 && wt.every((v) => Number.isFinite(v) && v >= 0), "trainSoftmax weights must be nonnegative with a positive sum");
  const W = Array.from({ length: k }, () => new Array<number>(d + 1).fill(0));
  for (let e = 0; e < opts.epochs; e++) {
    const grad = Array.from({ length: k }, () => new Array<number>(d + 1).fill(0));
    for (let i = 0; i < X.length; i++) {
      const x = [1, ...X[i]!], p = softmax(W, X[i]!);
      for (let c = 0; c < k; c++) { const g = wt[i]! * (p[c]! - (y[i] === c ? 1 : 0)); for (let j = 0; j <= d; j++) grad[c]![j]! += g * x[j]!; }
    }
    for (let c = 0; c < k; c++) for (let j = 0; j <= d; j++) W[c]![j]! -= opts.lr * (grad[c]![j]! / total + (j ? opts.l2 * W[c]![j]! : 0));
  }
  return W;
}

/** The session's fold: a stable string hash, so every row of a session lands in the same fold. Pure. */
export function foldOf(session: string): number {
  let h = 0;
  for (const ch of session) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % FOLDS;
}

/** The asked question ids a head reads: detect reads stage 1 (with the calm-failure nouls in `detectExtras`), class reads every slot. */
export function headFeatures(head: "detect" | "class", detectExtras: readonly DetectExtraId[] = KEPT_DETECT_EXTRAS): string[] {
  const slots = head === "detect" ? QUESTION_IDS.filter((q) => Object.hasOwn(STAGE1, q)) : QUESTION_IDS;
  return [...slots.map((s) => ASKED_FOR[s]!), ...(head === "detect" ? detectExtras : []), ...EXTRA_FEATURES];
}

/** Fit both heads on `train`. Rows missing a feature are skipped; the class head sees only decided failures. */
export function fitModel(train: Sample[], opts: TrainOptions = TRAIN_OPTIONS, weighting: TriageModel["weighting"] = "corpus", classSource: TriageModel["class_source"] = "head", discriminators: readonly DiscriminatorId[] = [], detectExtras: readonly DetectExtraId[] = KEPT_DETECT_EXTRAS): Omit<TriageModel, "cv"> {
  const df = headFeatures("detect", detectExtras), cf = headFeatures("class");
  const dRows = train.flatMap((s) => { const x = featureVector(df, s.answers, s.ctx); return x ? [{ x, y: s.gold.failure ? 1 : 0, w: s.weight }] : []; });
  const cRows = train.flatMap((s) => {
    const c = s.gold.class;
    if (!c || c === "not_a_failure") return [];
    const x = featureVector(cf, s.answers, s.ctx);
    return x ? [{ x, y: FAILURE_CLASSES.indexOf(c), w: s.weight }] : [];
  });
  invariant(dRows.length > 0 && cRows.length > 0, "fitModel needs rows with complete answers and at least one decided failure");
  const wOf = (rows: { w: number }[]) => (weighting === "corpus" ? rows.map((r) => r.w) : null);
  return {
    version: 1, trained: new Date().toISOString(),
    detect: { features: df, classes: [...DETECT_CLASSES], weights: trainSoftmax(dRows.map((r) => r.x), dRows.map((r) => r.y), DETECT_CLASSES.length, wOf(dRows), opts) },
    class: { features: cf, classes: [...FAILURE_CLASSES], weights: trainSoftmax(cRows.map((r) => r.x), cRows.map((r) => r.y), FAILURE_CLASSES.length, wOf(cRows), opts) },
    l2: opts.l2, epochs: opts.epochs, samples: train.length, weighting, class_source: classSource, discriminators: [...discriminators],
  };
}

// ── cuts ────────────────────────────────────────────────────────────────────

export type CutScore = { cut: number; balanced: number; accuracy: number; positives: number; n: number };

/** Balanced accuracy of `p >= cut` against `truth`; NaN when a class is absent. Pure. */
export function scoreCut(p: number[], truth: boolean[], cut: number): CutScore {
  let tp = 0, tn = 0, fp = 0, fn = 0;
  for (let i = 0; i < p.length; i++) { const yhat = yesAt(p[i]!, cut) === true; if (truth[i]) (yhat ? tp++ : fn++); else (yhat ? fp++ : tn++); }
  const n = tp + tn + fp + fn;
  const balanced = tp + fn && tn + fp ? (tp / (tp + fn) + tn / (tn + fp)) / 2 : NaN;
  return { cut, balanced, accuracy: n ? (tp + tn) / n : NaN, positives: tp + fn, n };
}

/**
 * The cut in 0.05..0.95 (step 0.05) with the best balanced accuracy; ties go to the cut nearest
 * the middle, then the lower one. Null when the truth has no positives or no negatives. Pure.
 */
export function bestCut(p: number[], truth: boolean[]): CutScore | null {
  let best: CutScore | null = null;
  for (let c = 5; c <= 95; c += 5) {
    const s = scoreCut(p, truth, c / 100);
    if (!Number.isFinite(s.balanced)) return null;
    const better = !best || s.balanced > best.balanced + 1e-12 ||
      (Math.abs(s.balanced - best.balanced) <= 1e-12 && Math.abs(c - 50) < Math.abs(best.cut * 100 - 50));
    if (better) best = s;
  }
  return best;
}

/** The labeled slot whose gold scores a question id (itself, or the slot a variant rewords). */
export function goldSlot(id: string): string {
  const s = slotOf(id);
  invariant(s, `unknown question id ${id}`);
  return s;
}

/** Per-question cuts fitted on `train` for every id; an id whose truth is one-sided keeps its `fallback` cut. Pure. */
export function fitCuts(train: Sample[], ids: readonly string[], fallback: Cuts): Cuts {
  const out: Cuts = {};
  for (const id of ids) {
    const rows = train.filter((s) => Number.isFinite(s.answers[id]));
    const best = bestCut(rows.map((s) => s.answers[id]!), rows.map((s) => s.gold.answers[goldSlot(id)]!));
    const cut = best?.cut ?? fallback[id] ?? fallback[goldSlot(id)];
    invariant(typeof cut === "number" && Number.isFinite(cut), `no fitted or fallback cut for ${id}`);
    out[id] = cut;
  }
  return out;
}

// ── cross-validation ────────────────────────────────────────────────────────

/** A row the gold majority calls a failure and names a class for: where ISC-53 is scored and discriminators are fitted. Pure. */
export const isMajorityFailure = (s: { gold: { failure: boolean; class: string | null } }): boolean => s.gold.failure && s.gold.class !== null && s.gold.class !== "not_a_failure";

/**
 * Per discriminator: the cut with the best balanced accuracy on its pair's rows among the
 * majority failures in `train` (truth: `pairTruth`); a one-sided pair keeps its `fallback` cut, and
 * an id with neither is left out, so a tournament that plays it composes to null. Pure.
 */
export function fitDiscriminatorCuts(train: Sample[], ids: readonly DiscriminatorId[], fallback: Cuts): Cuts {
  const out: Cuts = {};
  for (const id of ids) {
    const rows = train.filter((s) => isMajorityFailure(s) && Number.isFinite(s.answers[id]) && pairTruth(id, s.gold.class) !== null);
    const best = bestCut(rows.map((s) => s.answers[id]!), rows.map((s) => pairTruth(id, s.gold.class)!));
    const cut = best?.cut ?? fallback[id];
    if (typeof cut === "number" && Number.isFinite(cut)) out[id] = cut;
  }
  return out;
}

/** One fold: its held-out rows, the heads trained on the other folds, and every slot and discriminator cut fitted there. */
export type Fold = { test: Sample[]; model: TriageModel; cuts: Cuts };

/** Session-grouped 5-fold fits: heads, slot cuts and discriminator cuts from four folds, for the fifth. Deterministic. */
export function fitFolds(samples: Sample[], fallback: Cuts, opts: TrainOptions = TRAIN_OPTIONS, weighting: TriageModel["weighting"] = "corpus", ids: readonly string[] = SLOT_IDS): Fold[] {
  const folds: Fold[] = [];
  for (let k = 0; k < FOLDS; k++) {
    const train = samples.filter((s) => foldOf(s.session) !== k), test = samples.filter((s) => foldOf(s.session) === k);
    if (!test.length) continue;
    const trainSessions = new Set(train.map((s) => s.session));
    invariant(test.every((s) => !trainSessions.has(s.session)), "a session is in both train and test");
    const model: TriageModel = { ...fitModel(train, opts, weighting, "head"), cv: { detect: NaN, class: NaN, class_among_failures: NaN } };
    folds.push({ test, model, cuts: { ...fitCuts(train, ids, fallback), ...fitDiscriminatorCuts(train, DISCRIMINATOR_IDS, fallback) } });
  }
  return folds;
}

/** Held-out predictions of the combiner's detect head with the discriminator tournament naming the class, playing `use`. Pure over the folds. */
export function tournamentPredictions(folds: Fold[], use: readonly DiscriminatorId[]): Map<string, Prediction | null> {
  const out = new Map<string, Prediction | null>();
  for (const f of folds) {
    const model: TriageModel = { ...f.model, class_source: "tournament", discriminators: [...use] };
    for (const s of f.test) out.set(s.id, predictTriage(model, s.answers, s.ctx, f.cuts));
  }
  return out;
}

export type OutOfFold = {
  /** The combiner with its class head, from heads trained on the other folds. */
  head: Map<string, Prediction | null>;
  /** The combiner's detect head with the composer naming the class, at cuts fitted on the other folds. */
  hybrid: Map<string, Prediction | null>;
  /** The combiner's detect head with the discriminator tournament naming the class (playing `discriminators`), at cuts fitted on the other folds. */
  tournament: Map<string, Prediction | null>;
  /** The discriminators the tournament played. */
  discriminators: DiscriminatorId[];
  /** The composer's diagnosis for each row, at cuts fitted on the other folds. */
  composer: Map<string, Diagnosis | null>;
  /** Per question id: the held-out yes/no at the cut fitted on the other folds. */
  noul: Map<string, Map<string, boolean>>;
  /** Per discriminator: the held-out yes/no at the pair cut fitted on the other folds. */
  disc: Map<DiscriminatorId, Map<string, boolean>>;
  folds: Fold[];
};

/** Session-grouped 5-fold: fit heads and cuts on four folds, predict the fifth. Deterministic. */
export function crossValidate(samples: Sample[], fallback: Cuts, opts: TrainOptions = TRAIN_OPTIONS, weighting: TriageModel["weighting"] = "corpus", ids: readonly string[] = SLOT_IDS, discriminators: readonly DiscriminatorId[] = DISCRIMINATOR_IDS): OutOfFold {
  const folds = fitFolds(samples, fallback, opts, weighting, ids);
  const out: OutOfFold = {
    head: new Map(), hybrid: new Map(), tournament: tournamentPredictions(folds, discriminators), discriminators: [...discriminators], composer: new Map(),
    noul: new Map(ids.map((id) => [id, new Map()])), disc: new Map(DISCRIMINATOR_IDS.map((id) => [id, new Map()])), folds,
  };
  for (const { test, model, cuts } of folds) {
    for (const s of test) {
      out.head.set(s.id, predictTriage(model, s.answers, s.ctx, cuts));
      out.hybrid.set(s.id, predictTriage({ ...model, class_source: "composer" }, s.answers, s.ctx, cuts));
      out.composer.set(s.id, composeDiagnosis(toSlots(s.answers), toSlots(cuts)));
      for (const id of ids) if (Number.isFinite(s.answers[id])) out.noul.get(id)!.set(s.id, yesAt(s.answers[id]!, cuts[id]!) === true);
      for (const id of DISCRIMINATOR_IDS) if (Number.isFinite(s.answers[id]) && cuts[id] !== undefined) out.disc.get(id)!.set(s.id, yesAt(s.answers[id]!, cuts[id]!) === true);
    }
  }
  return out;
}

/** Balanced accuracy of held-out yes/no answers against the gold slot. Pure. */
export function heldOutBalanced(samples: Sample[], id: string, heldOut: Map<string, boolean>): { balanced: number; positives: number; n: number } {
  let tp = 0, tn = 0, fp = 0, fn = 0;
  for (const s of samples) {
    const yhat = heldOut.get(s.id);
    if (yhat === undefined) continue;
    const y = s.gold.answers[goldSlot(id)]!;
    if (y) (yhat ? tp++ : fn++); else (yhat ? fp++ : tn++);
  }
  return { balanced: tp + fn && tn + fp ? (tp / (tp + fn) + tn / (tn + fp)) / 2 : NaN, positives: tp + fn, n: tp + tn + fp + fn };
}

export type DiscriminatorScore = { id: DiscriminatorId; yes: string; no: readonly string[]; balanced: number; positives: number; negatives: number };

/** Each discriminator's held-out balanced accuracy on its pair's rows among majority failures (truth: `pairTruth`). Pure. */
export function discriminatorScores(samples: Sample[], oof: OutOfFold): DiscriminatorScore[] {
  return DISCRIMINATOR_IDS.map((id) => {
    let tp = 0, tn = 0, fp = 0, fn = 0;
    for (const s of samples) {
      const yhat = oof.disc.get(id)!.get(s.id), t = isMajorityFailure(s) ? pairTruth(id, s.gold.class) : null;
      if (yhat === undefined || t === null) continue;
      if (t) (yhat ? tp++ : fn++); else (yhat ? fp++ : tn++);
    }
    return { id, yes: DISCRIMINATORS[id].yes, no: DISCRIMINATORS[id].no, balanced: tp + fn && tn + fp ? (tp / (tp + fn) + tn / (tn + fp)) / 2 : NaN, positives: tp + fn, negatives: tn + fp };
  });
}

/** Weighted accuracy of a picker against a truth over rows where both are defined. Pure. */
export function weightedAcc(samples: Sample[], pick: (s: Sample) => string | boolean | null, truth: (s: Sample) => string | boolean | null): number {
  let hit = 0, tot = 0;
  for (const s of samples) { const t = truth(s), p = pick(s); if (t === null || p === null) continue; tot += s.weight; if (p === t) hit += s.weight; }
  return tot ? hit / tot : NaN;
}

/**
 * ISC-53's measure: among rows the majority calls a failure, how often the picker names the
 * majority's class. A missing prediction or a not_a_failure call counts as a miss, so detection
 * recall is inside the number. Weighted by corpus stratum, and unweighted as `sample`. Pure.
 */
export function amongFailures(samples: Sample[], pick: (s: Sample) => string | null): { weighted: number; sample: number; n: number } {
  let hit = 0, tot = 0, n = 0, hits = 0;
  for (const s of samples) {
    if (!isMajorityFailure(s)) continue;
    n++; tot += s.weight;
    if (pick(s) === s.gold.class) { hit += s.weight; hits++; }
  }
  return { weighted: tot ? hit / tot : NaN, sample: n ? hits / n : NaN, n };
}

export type Selection = { steps: { set: DiscriminatorId[]; weighted: number; sample: number }[]; chosen: DiscriminatorId[] };

/**
 * Which discriminators the tournament plays, by backward elimination on held-out class accuracy
 * among majority failures (weighted, sample breaking ties): start from all of them and drop the
 * one whose removal scores best while that is no worse than keeping it; stop when every removal
 * loses. Ties drop, so a discriminator stays only when cross-validation shows it helps. The folds
 * are fitted once; only the tournament is replayed. Deterministic.
 */
export function selectDiscriminators(samples: Sample[], folds: Fold[]): Selection {
  const scoreOf = (set: DiscriminatorId[]) => { const p = tournamentPredictions(folds, set); const a = amongFailures(samples, (s) => p.get(s.id)?.primary ?? null); return { set, weighted: a.weighted, sample: a.sample }; };
  const better = (a: { weighted: number; sample: number }, b: { weighted: number; sample: number }) => a.weighted > b.weighted + 1e-12 || (Math.abs(a.weighted - b.weighted) <= 1e-12 && a.sample >= b.sample - 1e-12);
  let current = scoreOf([...DISCRIMINATOR_IDS]);
  const steps = [current];
  while (current.set.length > 1) {
    const trials = current.set.map((d) => scoreOf(current.set.filter((x) => x !== d)));
    const best = trials.reduce((a, b) => (better(b, a) && !(Math.abs(a.weighted - b.weighted) <= 1e-12 && Math.abs(a.sample - b.sample) <= 1e-12) ? b : a));
    if (!better(best, current)) break;
    current = best;
    steps.push(current);
  }
  return { steps, chosen: current.set };
}

export type VariantScore = { variant: VariantId; of: string; old: number; new: number; positives: number; kept: "old" | "new" };

/** Old wording vs variant, each by held-out balanced accuracy against the old slot's gold; the variant wins only when strictly higher. */
export function compareVariants(samples: Sample[], oof: OutOfFold): VariantScore[] {
  return VARIANT_IDS.map((v) => {
    const of = VARIANTS[v].of;
    const o = heldOutBalanced(samples, of, oof.noul.get(of)!), n = heldOutBalanced(samples, v, oof.noul.get(v)!);
    return { variant: v, of, old: o.balanced, new: n.balanced, positives: o.positives, kept: n.balanced > o.balanced ? "new" : "old" };
  });
}

// ── registry writes ─────────────────────────────────────────────────────────

export type Calibration = { id: string; value: number; samples: number; agreement: number; balanced: number };

/**
 * Write fitted cuts into the errata-triage row: value, calibrated date, model, sample size,
 * agreement and balanced accuracy per question. The caller stays shadow. The file write is Glance's
 * writeThresholdRows (parse, validate, change only this caller's named rows, validate again, temp
 * file and rename); this function checks the evidence and builds the rows and ground truths.
 */
export function writeCalibratedCuts(cals: Calibration[], model: string, date: string, callersPath: string = defaultCallersPath()): void {
  const { callers } = loadRegistry(callersPath);
  const cfg = callers[CALLER];
  invariant(cfg, `${CALLER} is not registered`);
  const current = thresholdRows(cfg);
  const rows: Record<string, CallerThreshold> = {};
  const truth: Record<string, GroundTruth> = {};
  invariant(cfg.mode === "shadow", `${CALLER} must stay shadow until ISC-44 holds on the holdout`);
  invariant(typeof model === "string" && model.length > 0, "calibration needs the model that answered");
  invariant(!Number.isNaN(Date.parse(date)), "calibration needs a date");
  invariant(new Set(cals.map((c) => c.id)).size === cals.length, "one calibration per question");
  for (const c of cals) {
    invariant(Object.hasOwn(current, c.id), `${CALLER}.${c.id} is not registered; run --register first`);
    invariant(Number.isFinite(c.value) && c.value >= 0 && c.value <= 1, `${c.id}: cut out of range`);
    invariant(Number.isInteger(c.samples) && c.samples > 0 && Number.isFinite(c.agreement) && Number.isFinite(c.balanced), `${c.id}: calibration evidence incomplete`);
    const t = current[c.id]!;
    rows[c.id] = { ...t, value: c.value, calibrated: date, model, samples: c.samples, agreement: Number(c.agreement.toFixed(4)), balanced_accuracy: Number(c.balanced.toFixed(4)), ...(t.mode ? { mode: "shadow" as const } : {}) };
    if (isDiscriminator(c.id)) {
      const d = DISCRIMINATORS[c.id];
      truth[c.id] = { source: `majority class of three blind labelers on the v4 gold set, on the failures whose class is ${d.yes} (yes) or ${d.no.join(" or ")} (no), ERRATA/v4/labels-gold/<labeler>.jsonl`, join_key: "exchange id (local join key; never sent with the state)" };
      continue;
    }
    const slot = goldSlot(c.id);
    if (slot !== c.id) truth[c.id] = { source: `majority of three blind labelers on the v4 gold set, their answers for ${slot} (this question rewords it), ERRATA/v4/labels-gold/<labeler>.jsonl`, join_key: "exchange id (local join key; never sent with the state)" };
  }
  writeThresholdRows(CALLER, rows, { callersPath, groundTruth: truth, requireShadow: true });
}

/** What a calm-failure noul is scored against: it rewords no labeled slot, so its truth is the majority's failure call. */
export const DETECT_EXTRA_GROUND_TRUTH = "majority failure call (class other than not_a_failure) of three blind labelers on the v4 gold set, ERRATA/v4/labels-gold/<labeler>.jsonl; read as a detect-head feature, never composed at this cut";

/**
 * Register every variant, discriminator and calm-failure noul id the caller does not have yet
 * (shadow, provisional cut), and point each calm-failure noul's ground truth at the majority's
 * failure call (registerQuestion writes a generic source). Returns the ids added.
 */
export function registerVariants(callersPath: string = defaultCallersPath()): string[] {
  const have = thresholdRows(loadRegistry(callersPath).callers[CALLER]);
  const added: string[] = [];
  for (const v of [...VARIANT_IDS, ...DISCRIMINATOR_IDS, ...DETECT_EXTRA_IDS]) if (!Object.hasOwn(have, v)) { registerQuestion(CALLER, v, { callersPath }); added.push(v); }
  const extras = added.filter((id) => (DETECT_EXTRA_IDS as readonly string[]).includes(id));
  if (extras.length) writeGroundTruth(extras, DETECT_EXTRA_GROUND_TRUTH, callersPath);
  return added;
}

/** Set the ground-truth source of registered errata-triage ids; same parse, validate, temp-file and rename discipline as writeCalibratedCuts. */
export function writeGroundTruth(ids: readonly string[], source: string, callersPath: string = defaultCallersPath()): void {
  const raw = JSON.parse(readFileSync(callersPath, "utf8")) as Record<string, unknown>;
  const { callers } = loadRegistry(callersPath);
  const cfg = callers[CALLER];
  invariant(cfg, `${CALLER} is not registered`);
  invariant(cfg.mode === "shadow", `${CALLER} must stay shadow`);
  invariant(source.trim().length > 0, "ground truth needs a source");
  for (const id of ids) {
    invariant(Object.hasOwn(thresholdRows(cfg), id), `${CALLER}.${id} is not registered`);
    cfg.ground_truth[id] = { source, join_key: "exchange id (local join key; never sent with the state)" };
  }
  validateCallers(callers);
  raw[CALLER] = cfg;
  const tmp = `${callersPath}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(raw, null, 2) + "\n", { flag: "wx", mode: statSync(callersPath).mode & 0o777 });
    renameSync(tmp, callersPath);
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** Write the model file after validating it; refuses a model the loader would reject. */
export function writeModel(model: TriageModel, path: string = MODEL_PATH): void {
  invariant(validTriageModel(model), "refusing to write a triage model the loader would reject");
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(model, null, 2) + "\n", { flag: "wx" });
    renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
}

// ── CLI ─────────────────────────────────────────────────────────────────────

const pct = (x: number): string => (Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : "n/a");

export type SourceScore = { source: TriageModel["class_source"]; among: number; amongSample: number; overall: number };

/**
 * The class source to ship (ISC-53): the best held-out class accuracy among majority failures,
 * weighted; then over every decided row; then the simpler source (composer, tournament, head). Pure.
 */
export function chooseClassSource(scores: SourceScore[]): SourceScore {
  invariant(scores.length > 0 && scores.every((s) => Number.isFinite(s.among) && Number.isFinite(s.overall)), "chooseClassSource needs finite scores");
  const simple: TriageModel["class_source"][] = ["composer", "tournament", "head"];
  return [...scores].sort((a, b) => b.among - a.among || b.overall - a.overall || simple.indexOf(a.source) - simple.indexOf(b.source))[0]!;
}

export async function main(argv: string[]): Promise<number> {
  const known = new Set(["--write", "--calibrate", "--register"]);
  if (argv.some((a) => !known.has(a))) { console.error("usage: Train.ts [--write] [--calibrate] [--register]"); return 2; }
  if (argv.includes("--register")) {
    const added = registerVariants();
    console.log(added.length ? `registered in shadow: ${added.join(", ")}` : "every variant and discriminator is already registered");
  }
  // Loaded at run time: Eval.ts imports this module's pure functions for its own scoring.
  const { loadSamples, sessionInterval } = await import("./Eval");
  const loaded = await loadSamples({ set: "gold", offline: true });
  if ("error" in loaded) { console.error(loaded.error); return 1; }
  const { samples, fallback, model: engineModel } = loaded;
  const oof = crossValidate(samples, fallback);
  const selection = selectDiscriminators(samples, oof.folds);
  const chosen = tournamentPredictions(oof.folds, selection.chosen);
  const cls = (s: Sample) => s.gold.class, fail = (s: Sample) => s.gold.failure;
  const detectAcc = weightedAcc(samples, (s) => oof.head.get(s.id)?.is_failure ?? null, fail);
  console.log(`gold: ${samples.length} rows, ${samples.filter(isMajorityFailure).length} majority failures with a class; features: detect ${headFeatures("detect").length}, class ${headFeatures("class").length}; l2 ${TRAIN_OPTIONS.l2}, ${TRAIN_OPTIONS.epochs} epochs, corpus-weighted`);
  console.log(`session 5-fold, weighted: combiner detection ${pct(detectAcc)}; composer alone at fold-fitted cuts: detection ${pct(weightedAcc(samples, (s) => oof.composer.get(s.id)?.is_failure ?? null, fail))}, class ${pct(weightedAcc(samples, (s) => oof.composer.get(s.id)?.primary ?? null, cls))}`);

  console.log("\ndiscriminators: held-out balanced accuracy on their pair among majority failures (cut fitted on the other folds)");
  for (const d of discriminatorScores(samples, oof)) console.log(`  ${d.id.padEnd(18)} ${d.yes} vs ${d.no.join("/")}: ${pct(d.balanced)} (yes ${d.positives}, no ${d.negatives})`);
  console.log("\ndiscriminator selection (backward elimination, class among majority failures, weighted / sample):");
  for (const st of selection.steps) console.log(`  ${pct(st.weighted).padEnd(7)} ${pct(st.sample).padEnd(7)} ${st.set.join(", ")}`);

  // Every class picker shares the detect head; they differ only in who names a failure's class.
  const pickers: { source: TriageModel["class_source"]; name: string; pred: Map<string, Prediction | null> }[] = [
    { source: "composer", name: "detect head + composer", pred: oof.hybrid },
    { source: "head", name: "detect head + class head", pred: oof.head },
    { source: "tournament", name: `detect head + tournament (selected ${selection.chosen.length})`, pred: chosen },
  ];
  const all = tournamentPredictions(oof.folds, DISCRIMINATOR_IDS);
  const extra = [{ name: "detect head + tournament (all six)", pred: all }];
  const recall = amongFailures(samples, (s) => (oof.head.get(s.id)?.is_failure ? s.gold.class : null));
  console.log(`\ndetect head recall among majority failures: ${pct(recall.weighted)} weighted, ${pct(recall.sample)} sample (a miss there is a class miss for every picker)`);
  console.log("\nclass pickers, session 5-fold; among failures counts a not_a_failure call as a miss; 95% intervals resample sessions");
  console.log(`  ${"picker".padEnd(44)}${"among failures, weighted".padEnd(28)}${"among failures, sample".padEnd(28)}overall, weighted`);
  const scores: SourceScore[] = [];
  for (const k of [...pickers, ...extra]) {
    const pick = (s: Sample) => k.pred.get(s.id)?.primary ?? null;
    const a = amongFailures(samples, pick);
    const fails = samples.filter(isMajorityFailure);
    const ci = sessionInterval(fails, pick, cls), ciu = sessionInterval(fails.map((s) => ({ ...s, weight: 1 })), pick, cls);
    const overall = weightedAcc(samples, pick, cls);
    console.log(`  ${k.name.padEnd(44)}${`${pct(a.weighted)} [${pct(ci.lo)}, ${pct(ci.hi)}]`.padEnd(28)}${`${pct(a.sample)} [${pct(ciu.lo)}, ${pct(ciu.hi)}]`.padEnd(28)}${pct(overall)}`);
    const src = pickers.find((x) => x === k)?.source;
    if (src) scores.push({ source: src, among: a.weighted, amongSample: a.sample, overall });
  }
  // The class source is the one model choice made on gold beyond the weights; the holdout judges it.
  const win = chooseClassSource(scores);
  console.log(`\n→ class_source ${win.source}${win.source === "tournament" ? ` playing ${selection.chosen.join(", ")}` : ""}`);
  console.log("\nvariant vs old wording (held-out balanced accuracy against the old slot's gold)");
  for (const v of compareVariants(samples, oof)) console.log(`  ${v.of.padEnd(18)} ${pct(v.old).padEnd(8)} → ${v.variant.padEnd(24)} ${pct(v.new).padEnd(8)} pos ${String(v.positives).padEnd(4)} keep ${v.kept}`);
  const plays = win.source === "tournament" ? selection.chosen : [];
  if (argv.includes("--write")) {
    const kept = new Set<string>(KEPT_DISCRIMINATORS);
    if (plays.length !== kept.size || plays.some((d) => !kept.has(d))) {
      console.error(`the winning tournament plays ${plays.join(", ") || "nothing"}, but Questions.ts KEPT_DISCRIMINATORS is [${[...kept].join(", ")}]: set KEPT_DISCRIMINATORS to the played set (production asks only those), then rerun --write`);
      return 1;
    }
    // The class tier is chosen by ClassTier.ts eval, not here: a retrain keeps what the file carries.
    const prior = loadTriageModel();
    const model: TriageModel = { ...fitModel(samples, TRAIN_OPTIONS, "corpus", win.source, plays), cv: { detect: detectAcc, class: win.overall, class_among_failures: win.among }, ...(prior?.class_tier ? { class_tier: prior.class_tier } : {}) };
    writeModel(model);
    console.log(`wrote ${MODEL_PATH}`);
  }
  if (argv.includes("--calibrate")) {
    invariant(engineModel, "no engine model recorded for the gold answers; rerun Eval.ts score to refresh the cache");
    const date = new Date().toISOString();
    const cals: Calibration[] = SLOT_IDS.flatMap((id) => {
      const rows = samples.filter((s) => Number.isFinite(s.answers[id]));
      const best = bestCut(rows.map((s) => s.answers[id]!), rows.map((s) => s.gold.answers[goldSlot(id)]!));
      return best ? [{ id, value: best.cut, samples: best.n, agreement: best.accuracy, balanced: best.balanced }] : [];
    });
    for (const id of DISCRIMINATOR_IDS) {
      const rows = samples.filter((s) => isMajorityFailure(s) && Number.isFinite(s.answers[id]) && pairTruth(id, s.gold.class) !== null);
      const best = bestCut(rows.map((s) => s.answers[id]!), rows.map((s) => pairTruth(id, s.gold.class)!));
      if (best) cals.push({ id, value: best.cut, samples: best.n, agreement: best.accuracy, balanced: best.balanced });
    }
    writeCalibratedCuts(cals, engineModel, date);
    console.log(`calibrated ${cals.length} cuts on ${CALLER} (${engineModel}, ${date}); caller stays shadow`);
    for (const c of cals) console.log(`  ${c.id.padEnd(24)} ${c.value.toFixed(2)}  bal ${pct(c.balanced)}  acc ${pct(c.agreement)}  n ${c.samples}`);
  }
  return 0;
}

if (import.meta.main) {
  main(process.argv.slice(2)).then((c) => process.exit(c)).catch((e) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
}
