#!/usr/bin/env bun
/**
 * Fingerprint.ts — the engine canary (concept: LIFEOS/DOCUMENTATION/Assay/AssaySystem.md).
 *
 * Judgment caller: `probe` by default (a registered shadow caller for fixed public text), or `--caller <name>`. Judgment layer
 * doc: LIFEOS/DOCUMENTATION/Assay/AssaySystem.md § Judgment layer.
 *
 * Clef-omni answers with the bare model id "clef-omni", so a change of weights under the same id is invisible to the
 * model-drift check. The canary asks twenty fixed synthetic questions (fixtures/engine-canary.json: invented public text, no
 * personal data) through ask(), rounds every answer, and hashes the rounded answers into a fingerprint. Clef-omni is
 * deterministic run to run (660 of 660 bake-off answers identical across two runs on 2026-10-10), so the same weights give the
 * same fingerprint and a change means the engine changed.
 *
 * A run writes the fingerprint to a small state file (Registry.fingerprintStatePath). ask() reads it and writes it into every
 * ledger row as `engine_fingerprint`; `model_versioned` stays the model id. After writing, the run calls checkModelDrift with
 * the new fingerprint, so an enforce row promoted under another fingerprint (or under none) goes back to shadow through the
 * same path a model change takes. An incomplete run (any question failed) writes nothing: a partial hash is not a fingerprint.
 *
 * Usage:
 *   bun LIFEOS/ASSAY/Fingerprint.ts run [--json] [--vigil] [--dry-run] [--caller name]
 *   bun LIFEOS/ASSAY/Fingerprint.ts show [--json]
 *
 * --vigil emits one Vigil event per run: info when unchanged or first, high when the fingerprint changed, medium when the
 * run was incomplete, high when the drift revert could not be persisted (the fingerprint was written, but enforce rows that
 * should be shadow are still enforce). Exit codes: 0 ok (a change is still a successful run) · 1 incomplete run, failed revert
 * persist, or bad arguments.
 */

import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { invariant } from "../TOOLS/Invariant";
import { checkModelDrift, judgeMany, type DriftEmitter, type DriftRevert, type ManyItem } from "./Assay.ts";
import type { Answer, Question, Questions } from "./Engine";
import { FINGERPRINT_RE, fingerprintStatePath, liveEngineId, readFingerprintState, type EngineFingerprintState } from "./Registry.ts";

export const CANARY_CALLER = "probe";
export const DEFAULT_CANARY_PATH = join(import.meta.dir, "fixtures", "engine-canary.json");
/** Answers are rounded to this many decimals before hashing. */
export const PRECISION = 2;

export type CanaryCase = { key: string; state: string; question: Question };
export type Canary = { v: 1; description: string; cases: CanaryCase[] };

/** Read and check the canary fixture. Throws on a malformed fixture: a canary that cannot be read must not fingerprint anything. */
export function loadCanary(path: string = DEFAULT_CANARY_PATH): Canary {
  const c = JSON.parse(readFileSync(path, "utf8")) as Canary;
  if (!c || c.v !== 1 || !Array.isArray(c.cases) || c.cases.length < 10) throw new Error(`canary ${path}: needs v 1 and at least 10 cases`);
  const keys = new Set<string>();
  for (const k of c.cases) {
    if (!k || typeof k.key !== "string" || !/^[a-z0-9_]+$/.test(k.key) || keys.has(k.key)) throw new Error(`canary ${path}: case keys must be unique lower_snake ids`);
    keys.add(k.key);
    if (typeof k.state !== "string" || !k.state.trim()) throw new Error(`canary ${path}: ${k.key} has no state`);
    if (!k.question || !["noul", "choice", "score"].includes(k.question.type)) throw new Error(`canary ${path}: ${k.key} has no typed question`);
  }
  return c;
}

const round = (x: number | undefined, precision: number): number | null => typeof x === "number" && Number.isFinite(x) ? Number(x.toFixed(precision)) : null;
const roundMap = (m: Record<string, number> | undefined, precision: number): Record<string, number | null> =>
  Object.fromEntries(Object.keys(m ?? {}).sort().map((k) => [k, round(m![k], precision)]));

/** One answer as the fingerprint reads it: its type and every number in it, rounded. Pure. */
export function roundAnswer(a: Answer, precision: number = PRECISION): Record<string, unknown> {
  if (a.type === "noul") return { type: "noul", noul: round(a.noul, precision) };
  if (a.type === "choice") return { type: "choice", choice: a.choice, probabilities: roundMap(a.probabilities, precision) };
  return { type: "score", score: round(a.score, precision), probabilities: roundMap(a.probabilities, precision) };
}

/** The fingerprint of a full set of canary answers: "fp1:" plus 16 hex of sha256 over the rounded answers in key order. Pure. */
export function fingerprintOf(answers: Record<string, Answer>, precision: number = PRECISION): string {
  const canonical = Object.keys(answers).sort().map((k) => [k, roundAnswer(answers[k]!, precision)]);
  return `fp1:${createHash("sha256").update(JSON.stringify({ precision, answers: canonical })).digest("hex").slice(0, 16)}`;
}

/** Write the canary state atomically. Asserts the state is whole before anything lands. */
export function writeFingerprintState(state: EngineFingerprintState, path: string = fingerprintStatePath()): void {
  invariant(state.v === 1 && FINGERPRINT_RE.test(state.fingerprint), `fingerprint state: ${state.fingerprint} is not an fp1 fingerprint`);
  invariant(typeof state.engine === "string" && state.engine.length > 0, "fingerprint state names the engine it measured");
  invariant(Number.isInteger(state.cases) && state.cases > 0 && Number.isFinite(Date.parse(state.at)), "fingerprint state carries a case count and an ISO time");
  invariant(state.previous === null || FINGERPRINT_RE.test(state.previous.fingerprint), "fingerprint state: previous is null or an fp1 fingerprint");
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${randomUUID()}.tmp`;
  try { writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 }); renameSync(tmp, path); }
  finally { rmSync(tmp, { force: true }); }
}

export type CanaryResult = {
  ok: boolean;
  fingerprint: string | null;
  previous: string | null;
  /** True when a previous fingerprint for this engine existed and differs (or the previous state measured another engine). */
  changed: boolean;
  engine: string;
  model: string | null;
  cases: number;
  errors: Array<{ key: string; error: string }>;
  reverts: DriftRevert[];
  written: boolean;
  /** Set when the fingerprint was written but checkModelDrift could not persist its reverts: ok is false and reverts is empty. */
  drift_error?: string;
};

export type CanaryOptions = {
  canaryPath?: string;
  statePath?: string;
  caller?: string;
  dryRun?: boolean;
  /** Test seams, passed through to judgeMany/ask and checkModelDrift. */
  callersPath?: string;
  logPath?: string;
  fetchImpl?: typeof fetch;
  apiKey?: string;
  env?: NodeJS.ProcessEnv;
  emitter?: DriftEmitter;
  now?: () => Date;
};

/**
 * Run the canary once: ask every case, fingerprint the rounded answers, write the state (unless dryRun), then run the drift
 * check keyed on the new fingerprint. Writes nothing when any case failed.
 */
export async function runCanary(opts: CanaryOptions = {}): Promise<CanaryResult> {
  const canary = loadCanary(opts.canaryPath);
  const engine = liveEngineId();
  const statePath = opts.statePath ?? fingerprintStatePath();
  const prev = readFingerprintState(statePath);
  const items: ManyItem[] = canary.cases.map((c) => ({ key: c.key, state: c.state, questions: { [c.key]: c.question } as Questions }));
  const results = await judgeMany(items, items[0]!.questions!, {
    caller: opts.caller ?? CANARY_CALLER, concurrency: 5, retries: 1,
    callersPath: opts.callersPath, logPath: opts.logPath, fetchImpl: opts.fetchImpl, apiKey: opts.apiKey, env: opts.env,
  });
  const answers: Record<string, Answer> = {};
  const errors: CanaryResult["errors"] = [];
  const models = new Set<string>();
  for (const r of results) {
    const got = r.result?.[r.key];
    if (r.error || !got) { errors.push({ key: r.key, error: r.error ?? "no answer" }); continue; }
    answers[r.key] = got.answer;
    if (got.model) models.add(got.model);
  }
  const base = { engine, cases: canary.cases.length, previous: prev?.fingerprint ?? null, errors, reverts: [] as DriftRevert[] };
  if (errors.length > 0 || models.size > 1) {
    if (models.size > 1) errors.push({ key: "*", error: `answers came from more than one model: ${[...models].sort().join(", ")}` });
    return { ...base, ok: false, fingerprint: null, changed: false, model: null, written: false };
  }
  const fingerprint = fingerprintOf(answers);
  const model = [...models][0] ?? null;
  const changed = !!prev && (prev.engine !== engine || prev.fingerprint !== fingerprint);
  if (opts.dryRun) return { ...base, ok: true, fingerprint, changed, model, written: false };
  const at = (opts.now?.() ?? new Date()).toISOString();
  const keepPrevious = prev && prev.fingerprint === fingerprint && prev.engine === engine ? prev.previous : prev ? { fingerprint: prev.fingerprint, at: prev.at } : null;
  writeFingerprintState({ v: 1, fingerprint, engine, model, at, cases: canary.cases.length, precision: PRECISION, previous: keepPrevious }, statePath);
  // Every run, not only a change: an enforce row promoted under another fingerprint, or none, goes back to shadow.
  // A revert that did not persist is a failed run: report it, never success (checkModelDrift throws before announcing anything).
  let reverts: DriftRevert[];
  try { reverts = checkModelDrift(opts.callersPath, opts.logPath, opts.emitter, { fingerprint }); }
  catch (e) {
    const drift_error = String((e as Error)?.message ?? e);
    return { ...base, ok: false, fingerprint, changed, model, written: true, errors: [...errors, { key: "drift", error: drift_error }], drift_error };
  }
  return { ...base, ok: true, fingerprint, changed, model, written: true, reverts };
}

/** The one Vigil event a run reports. A failed revert names only its errno code: the raw message carries file paths. */
export function canaryEvent(r: CanaryResult, now: Date = new Date()) {
  const driftCode = r.drift_error ? (/\b(E[A-Z]{2,})\b/.exec(r.drift_error)?.[1] ?? "write error") : null;
  const severity = r.drift_error ? "high" : !r.ok ? "medium" : r.changed ? "high" : "info";
  const title = r.drift_error ? "Assay engine canary: drift revert NOT persisted" : !r.ok ? "Assay engine canary incomplete" : r.changed ? "Assay engine fingerprint changed" : r.previous ? "Assay engine canary: fingerprint unchanged" : "Assay engine canary: first fingerprint";
  const summary = r.drift_error
    ? `The ${r.engine} canary wrote fingerprint ${r.fingerprint}, but reverting enforce rows to shadow failed to persist (${driftCode}), so they are still enforce. Fix the registry write and rerun the canary or \`Assay.ts drift\`.`
    : !r.ok
    ? `${r.errors.length} of ${r.cases} canary questions failed on ${r.engine}; no fingerprint was written. First: ${r.errors[0]?.error ?? "unknown"}`.slice(0, 1000)
    : r.changed
      ? `The ${r.engine} canary fingerprint moved from ${r.previous} to ${r.fingerprint}. ${r.reverts.length} enforce question(s) reverted to shadow; thresholds cut on the old weights need re-cutting.`
      : `${r.cases} canary questions on ${r.engine} (${r.model ?? "model unknown"}) gave ${r.fingerprint}.`;
  return {
    id: randomUUID(), source: "assay", ts: now.toISOString(), kind: "ai" as const, severity: severity as "info" | "medium" | "high",
    title, summary, ref: "LIFEOS/ASSAY/Fingerprint.ts", url: null, privacy_class: "public" as const,
    dedup_key: `assay:engine-canary:${r.engine}:${r.drift_error ? `revert-unpersisted:${r.fingerprint}:${now.toISOString().slice(0, 10)}` : r.ok ? r.fingerprint : `incomplete:${now.toISOString().slice(0, 10)}`}`,
    meta: { engine: r.engine, model: r.model, fingerprint: r.fingerprint, previous: r.previous, changed: r.changed, cases: r.cases, failed: r.errors.length, reverted: r.reverts.length, ...(driftCode ? { drift_error: driftCode } : {}) },
  };
}

function arg(flag: string, argv: string[]): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

export async function main(argv: string[]): Promise<number> {
  const cmd = argv[0];
  const json = argv.includes("--json");
  if (cmd === "show") {
    const s = readFingerprintState();
    if (json) console.log(JSON.stringify(s));
    else console.log(s ? `${s.engine}: ${s.fingerprint} (${s.cases} questions, ${s.at}${s.previous ? `, was ${s.previous.fingerprint}` : ""})` : `no fingerprint yet (${fingerprintStatePath()})`);
    return 0;
  }
  if (cmd !== "run") {
    console.error("Usage: bun LIFEOS/ASSAY/Fingerprint.ts run [--json] [--vigil] [--dry-run] [--caller name] | show [--json]");
    return cmd ? 1 : 0;
  }
  const r = await runCanary({ dryRun: argv.includes("--dry-run"), caller: arg("--caller", argv) });
  if (argv.includes("--vigil") && !argv.includes("--dry-run")) {
    // STATVS writeEvent (migration design §2.1) never throws on a refusal; it returns ok:false, which is logged the same way.
    const statvsPath = join(import.meta.dir, "../STATVS/index.ts");
    if (existsSync(statvsPath)) {
      try {
        const sent = (await import(statvsPath)).writeEvent(canaryEvent(r)) as { ok: boolean; refused?: string };
        if (!sent.ok) console.error(`[Fingerprint] STATVS refused the canary event: ${sent.refused}`);
      } catch (e) { console.error(`[Fingerprint] canary event write failed: ${(e as Error)?.message ?? e}`); }
    }
  }
  if (json) console.log(JSON.stringify(r));
  else if (r.drift_error) console.error(`canary fingerprinted ${r.engine} as ${r.fingerprint}, but the drift revert FAILED to persist: ${r.drift_error}`);
  else if (!r.ok) console.error(`canary incomplete on ${r.engine}: ${r.errors.length} failed (${r.errors.map((e) => `${e.key}: ${e.error}`).join("; ")}); nothing written`);
  else console.log(`${r.engine}: ${r.fingerprint}${r.changed ? ` (changed from ${r.previous})` : r.previous ? " (unchanged)" : " (first)"} · ${r.cases} questions · ${r.reverts.length} reverted${r.written ? "" : " · dry run, nothing written"}`);
  return r.ok ? 0 : 1;
}

if (import.meta.main) {
  main(process.argv.slice(2)).then((code) => process.exit(code)).catch((e) => { console.error(String((e as Error)?.message ?? e)); process.exit(1); });
}
