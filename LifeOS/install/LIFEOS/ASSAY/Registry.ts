/**
 * Registry.ts — the leaf of the Glance system: the caller-registry shapes, where the registry lives, a raw read of it,
 * and the two pure readers of a caller row (thresholdRows, enforcedQuestions).
 *
 * It imports nothing from Assay.ts or the label store, so both can import it. That is what broke the
 * Assay.ts <-> LabelStore.ts cycle (ISA 20261010-evals-in-the-isa ISC-32): the label store reads registry floors here,
 * and Assay.ts loadRegistry() adds the full validateCallers pass (which asks the label store whether enforce is earned)
 * on top of readRegistry(). Runtime code and writers go through Assay.ts loadRegistry(), never readRegistry() alone.
 */

import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { invariant } from "../TOOLS/Invariant";
import { CROSS_VENDOR } from "../TOOLS/models";
import { lifeosPath } from "../TOOLS/Paths";

// Narrow re-exports for files outside Assay that need an engine limit or the secret-value check without importing the engine
// file (Glance.test.ts holds that boundary). They are not answer paths. Assay.ts's export list is pinned by RuntimeSplit.test.ts,
// so they live on this leaf instead.
export { DEFAULT_TIMEOUT_MS, carriesSecretValue } from "./Engine";

export type CallerMode = "shadow" | "enforce";
export type GroundTruth = { source: string; join_key: string; ledger?: "jev-signal-comparisons.jsonl" | "jev-stop.jsonl" | "jev-guard.jsonl" | "jev-guard-calibration.jsonl" };
/**
 * `model` is the engine the cut was measured on, as the ledger's `model_versioned` names it ("clef-omni"); `fingerprint` is the
 * engine canary's fingerprint the cut was measured under (Fingerprint.ts), stamped by the tool that re-cuts the row. Promotion
 * requires both to describe the engine answering now (promotionRefusal), and a change of weights under the same model id
 * reverts an enforce row through checkModelDrift.
 */
export type CallerThreshold = { value: number; calibrated: string | null; model: string | null; samples: number; agreement: number | null; balanced_accuracy?: number | null; mode?: CallerMode; min_positives?: number; min_labels?: number; fingerprint?: string };
export type EnforceEvidence = { agreement: number; date: string; model: string; positives?: number; fingerprint?: string };
export type CallerConfig = {
  mode: CallerMode;
  ground_truth: Record<string, GroundTruth | null>;
  ground_truth_note?: string;
  corrective: Record<string, boolean>;
  fail: "open" | "closed";
  budget: { calls_per_day: number; tokens_per_day: number };
  /**
   * Shadow callers only: the share of calls (0 < rate <= 1) that reach the engine, picked by a deterministic hash of the
   * caller and the state (sampleUnit), so the day's budget is spread over the whole day rather than spent on its first
   * N calls. Absent means every call is asked, the budget alone caps the day. Ignored while any question enforces.
   */
  sample_rate?: number;
  thresholds: Record<string, CallerThreshold>;
  enforce_evidence: EnforceEvidence | null;
  enforce_bar?: number;
  error_floor?: number;
  correlation_min_samples?: number;
  reverted?: { reason: string; from: string; to: string; date: string };
  /** The principal's waiver: an enforce row acts before its labels earn it, only until `expires` (principal, 2026-10-12). */
  waiver?: Waiver;
};
/**
 * A waiver is in force from `date` until `expires`, at most 31 days; outside that window the row acts only if its labels have
 * earned it (decide()).
 */
export type Waiver = { by: "principal"; date: string; expires: string; reason: string };
export const MAX_WAIVER_DAYS = 31;
/** Where a waiver stands at `now`: in force, not yet started, past its expiry, or malformed (not the principal's, no reason, bad dates, over the cap). */
export type WaiverState = "active" | "pending" | "expired" | "invalid";
export function waiverState(w: Waiver | undefined, now = Date.now()): WaiverState {
  if (!w || w.by !== "principal" || typeof w.reason !== "string" || w.reason.length === 0) return "invalid";
  const start = Date.parse(w.date), end = Date.parse(w.expires);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > MAX_WAIVER_DAYS * 86_400_000) return "invalid";
  if (now < start) return "pending";
  return now < end ? "active" : "expired";
}
/** True only while a well-formed principal waiver is in force: on or after its `date`, before its `expires`, within the cap. */
export function waiverActive(w: Waiver | undefined, now = Date.now()): boolean {
  return waiverState(w, now) === "active";
}
export type CallersConfig = Record<string, CallerConfig>;
export type RegistryDefaults = { min_labels?: number; provisional_threshold?: number };
export type CallerRegistry = { callers: CallersConfig; defaults: RegistryDefaults };

export function defaultCallersPath(): string {
  if (process.env.LIFEOS_GLANCE_CALLERS) return process.env.LIFEOS_GLANCE_CALLERS;
  if (process.env.LIFEOS_JEV_CALLERS) return process.env.LIFEOS_JEV_CALLERS;
  const glance = lifeosPath("USER", "CONFIG", "assay-callers.json");
  return existsSync(glance) ? glance : lifeosPath("USER", "CONFIG", "jev-callers.json");
}

/**
 * Parse the registry file and check only what a floor reader depends on: the defaults block and each row's label and
 * positive floors. Missing file or unparsable JSON reads as empty (fail open, as loadRegistry does). It does NOT run
 * validateCallers, so a row that breaks a policy rule (unearned enforce, bad ground truth) still reads here; every
 * runtime read and every writer validates through Assay.ts loadRegistry(), which is where that gate lives.
 */
export function readRegistry(path?: string): CallerRegistry {
  const p = path ?? defaultCallersPath();
  if (!existsSync(p)) return { callers: {}, defaults: {} };
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>; } catch { return { callers: {}, defaults: {} }; }
  const defaults = (parsed.defaults ?? {}) as RegistryDefaults;
  invariant(defaults && typeof defaults === "object" && !Array.isArray(defaults), "assay-callers.json: defaults must be an object");
  if (defaults.min_labels !== undefined) invariant(Number.isInteger(defaults.min_labels) && defaults.min_labels >= 1, "assay-callers.json: defaults.min_labels must be a positive integer");
  if (defaults.provisional_threshold !== undefined) invariant(Number.isFinite(defaults.provisional_threshold) && defaults.provisional_threshold >= 0 && defaults.provisional_threshold <= 1, "assay-callers.json: defaults.provisional_threshold must be finite and between 0 and 1");
  const callers = Object.fromEntries(Object.entries(parsed).filter(([name]) => name !== "defaults")) as CallersConfig;
  for (const [name, cfg] of Object.entries(callers)) {
    for (const [id, threshold] of Object.entries(cfg?.thresholds ?? {})) {
      if (threshold?.min_labels !== undefined) invariant(Number.isInteger(threshold.min_labels) && threshold.min_labels >= 1, `${name}.${id}: invalid label floor`);
      if (threshold?.min_positives !== undefined) invariant(Number.isInteger(threshold.min_positives) && threshold.min_positives >= 1, `${name}.${id}: invalid positive label floor`);
    }
  }
  return { callers, defaults };
}

/** The questions a caller row would enforce: every threshold row not marked shadow on an enforce caller, plus any row marked enforce. */
export function enforcedQuestions(cfg: Pick<CallerConfig, "mode" | "thresholds">): string[] {
  return Object.entries(cfg.thresholds ?? {}).filter(([, t]) => (cfg.mode === "enforce" && t?.mode !== "shadow") || t?.mode === "enforce").map(([id]) => id);
}

/**
 * The one read of a caller's registered threshold rows, keyed by question id, for code that MEASURES or REPORTS on
 * thresholds: calibration, offline scoring, status, hashing. Pass a caller row (or anything shaped like one); a missing row
 * gives {}. The result is a frozen copy, so writing to it changes nothing; calibrated values are written back through
 * writeThresholdRows. Acting on an answer never reads a cut: it goes through decide().
 */
export function thresholdRows<T>(cfg: { thresholds: Record<string, T> } | null | undefined): Readonly<Record<string, T>> {
  return Object.freeze(structuredClone(cfg?.thresholds ?? {}));
}

// ── The engine now answering (ISA LIFEOS/ASSAY M7, ISC-58..ISC-60) ─────────────────────────────────────────────────────

/**
 * The engine id a threshold stamp is compared with: the last path segment of the engine alias, so
 * "@cf/cloudflare/clef-omni" reads "clef-omni", which is what the engine returns as its model and what the ledger's
 * `model_versioned` records. The alias lives only in CROSS_VENDOR.assayEngine.
 */
export function liveEngineId(model: string = CROSS_VENDOR.assayEngine): string {
  const id = model.split("/").at(-1) ?? "";
  invariant(id.length > 0, `engine alias ${JSON.stringify(model)} has no model id`);
  return id;
}

/** One threshold row whose model stamp is not the engine now answering: cut on another engine, or never cut (model null). */
export type StaleStamp = { caller: string; question: string; model: string | null; engine: string; mode: CallerMode };

/** Every threshold row, across callers, whose `model` differs from `engine` (default: the live engine). Sorted by caller, then question. Pure. */
export function staleStamps(callers: CallersConfig, engine: string = liveEngineId()): StaleStamp[] {
  const out: StaleStamp[] = [];
  for (const [caller, cfg] of Object.entries(callers).sort(([a], [b]) => a.localeCompare(b))) {
    if (caller === "defaults" || !cfg?.thresholds) continue;
    for (const [question, t] of Object.entries(cfg.thresholds).sort(([a], [b]) => a.localeCompare(b))) {
      if (t?.model === engine) continue;
      out.push({ caller, question, model: t?.model ?? null, engine, mode: (cfg.mode === "enforce" && t?.mode !== "shadow") || t?.mode === "enforce" ? "enforce" : "shadow" });
    }
  }
  return out;
}

/**
 * The one rule for whether a threshold row's evidence describes the engine answering now (ISC-59, ISC-60): null when it does,
 * else why not. The row must be cut on `engine` (its model stamp) and under `fingerprint` (the canary's current fingerprint for
 * that engine). A row with no recorded fingerprint, or no known current fingerprint, has no evidence tied to these weights, so
 * it is refused: same-model weight changes cannot be erased by promoting the old cut. Re-cut the row under the current
 * fingerprint first. Pure.
 */
export function promotionRefusal(t: Pick<CallerThreshold, "model" | "fingerprint"> | undefined, engine: string, fingerprint: string | null): string | null {
  if (!t || typeof t.model !== "string" || !t.model) return `was never cut (no model stamp); cut it on ${engine} first`;
  if (t.model !== engine) return `was cut on ${t.model}, but the engine now answering is ${engine}; re-cut it on ${engine} first`;
  if (!fingerprint) return `has no canary fingerprint to be checked against: the assay-engine-fingerprint canary has not fingerprinted ${engine}; run it, then re-cut`;
  if (!t.fingerprint) return `records no canary fingerprint, so its cut is not tied to the weights now answering (${fingerprint}); re-cut it under ${fingerprint} first`;
  if (t.fingerprint !== fingerprint) return `was cut under canary fingerprint ${t.fingerprint}, but ${engine} now fingerprints as ${fingerprint}; re-cut it under ${fingerprint} first`;
  return null;
}

// ── Engine fingerprint state (written by Fingerprint.ts, read by ask() and checkModelDrift) ─────────────────────────────

/** The fingerprint format: a version tag and 16 hex characters of sha256 over the canary's rounded answers. */
export const FINGERPRINT_RE = /^fp1:[0-9a-f]{16}$/;
export type EngineFingerprintState = {
  v: 1;
  fingerprint: string;
  /** liveEngineId() when the canary ran; a fingerprint is only ever read back for this engine. */
  engine: string;
  /** The model id the engine answered with. */
  model: string | null;
  at: string;
  cases: number;
  precision: number;
  previous: { fingerprint: string; at: string } | null;
};

/**
 * Where the canary keeps the current fingerprint. LIFEOS_ASSAY_FINGERPRINT overrides; under `bun test` with no override it is a
 * per-process temp file, so a suite never reads or writes the real one.
 */
export function fingerprintStatePath(): string {
  if (process.env.LIFEOS_ASSAY_FINGERPRINT) return process.env.LIFEOS_ASSAY_FINGERPRINT;
  if (process.env.NODE_ENV === "test") return join(tmpdir(), `lifeos-assay-fingerprint-test-${process.pid}`, "assay-engine-fingerprint.json");
  return lifeosPath("MEMORY", "STATE", "assay-engine-fingerprint.json");
}

/** The canary's state, or null when it is missing, unreadable or malformed (fail open: no fingerprint is known). */
export function readFingerprintState(path: string = fingerprintStatePath()): EngineFingerprintState | null {
  try {
    const s = JSON.parse(readFileSync(path, "utf8")) as EngineFingerprintState;
    return s && s.v === 1 && typeof s.fingerprint === "string" && FINGERPRINT_RE.test(s.fingerprint) && typeof s.engine === "string" && s.engine.length > 0 ? s : null;
  } catch { return null; }
}

/** The current fingerprint for `engine` (default: the live engine), or null when the canary has not fingerprinted that engine. */
export function currentFingerprint(opts: { path?: string; engine?: string } = {}): string | null {
  const s = readFingerprintState(opts.path);
  return s && s.engine === (opts.engine ?? liveEngineId()) ? s.fingerprint : null;
}
