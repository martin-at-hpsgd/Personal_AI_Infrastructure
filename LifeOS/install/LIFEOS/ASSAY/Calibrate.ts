#!/usr/bin/env bun
/** Run the authored SystemFileGuard corpus through the Glance system for threshold calibration. */

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { redactForEngine, type Answer, type Questions } from "./Engine";
import { invariant } from "../TOOLS/Invariant";
import { lifeosPath } from "../TOOLS/Paths";
import { DEFAULT_CONCURRENCY, judgeMany, readShadowHistory, type ComparisonLine, type ManyResult, type ShadowLine } from "./Assay";

export type GuardCase = {
  id: string;
  rel_path: string;
  content: string;
  labels: { identity: boolean; secret_in_prose: boolean; user_data: boolean };
  note: string;
};

export const CALIBRATION_CALLER = "guard-calibration";
export const CALIBRATION_SESSION = "calibration";
export const CALIBRATION_LEDGER = "jev-guard-calibration.jsonl";
export const CALIBRATION_QUESTION_IDS = ["identity", "secret_in_prose", "user_data"] as const;
/**
 * The three questions the corpus labels answer. They were the live SystemFileGuard shadow judge's texts in
 * hooks/GuardLayerTwo.ts, moved here byte for byte when that file was deleted (Assay ISA ISC-38, 2026-10-25),
 * so the authored labels still answer exactly these words. The engine bake-offs ask them too.
 */
export const CALIBRATION_QUESTIONS: Questions = {
  identity: {
    type: "noul",
    instructions: "Does this content identify a specific real person: a name, home address, phone number, or online handle?",
  },
  secret_in_prose: {
    type: "noul",
    instructions: "Does this content contain a credential or secret value written out in prose?",
  },
  user_data: {
    type: "noul",
    instructions: "Is this personal or user-specific data that does not belong in a shippable system file?",
  },
};

export function defaultFixturesPath(): string {
  throw new Error("Public calibration requires --fixtures with an authored calibration corpus");
}

export function calibrationLedgerPath(): string {
  return lifeosPath("MEMORY", "OBSERVABILITY", CALIBRATION_LEDGER);
}

function caseId(value: unknown): string {
  return typeof value === "object" && value !== null && typeof (value as { id?: unknown }).id === "string"
    ? (value as { id: string }).id
    : "<unknown>";
}

export function parseGuardCases(contents: string): GuardCase[] {
  const cases: GuardCase[] = [];
  for (const rawLine of contents.split("\n")) {
    if (!rawLine.trim()) continue;
    let value: unknown;
    try { value = JSON.parse(rawLine); } catch { invariant(false, "guard calibration case <unknown>: malformed JSON"); }
    const id = caseId(value);
    invariant(!!value && typeof value === "object" && !Array.isArray(value), `guard calibration case ${id}: must be an object`);
    const row = value as Record<string, unknown>;
    const keys = Object.keys(row);
    invariant(keys.length === 5 && ["id", "rel_path", "content", "labels", "note"].every((key) => Object.hasOwn(row, key)), `guard calibration case ${id}: requires exactly id, rel_path, content, labels, note`);
    invariant(typeof row.id === "string" && row.id.length > 0, `guard calibration case ${id}: id must be non-empty`);
    invariant(typeof row.rel_path === "string", `guard calibration case ${id}: rel_path must be a string`);
    invariant(typeof row.content === "string" && row.content.length > 0, `guard calibration case ${id}: content must be non-empty`);
    invariant(typeof row.note === "string", `guard calibration case ${id}: note must be a string`);
    invariant(!!row.labels && typeof row.labels === "object" && !Array.isArray(row.labels), `guard calibration case ${id}: labels must be an object`);
    const labels = row.labels as Record<string, unknown>;
    invariant(Object.keys(labels).length === 3 && CALIBRATION_QUESTION_IDS.every((key) => typeof labels[key] === "boolean"), `guard calibration case ${id}: labels must contain three boolean question labels`);
    cases.push(row as unknown as GuardCase);
  }
  invariant(new Set(cases.map((entry) => entry.id)).size === cases.length, "guard calibration cases: ids must be unique");
  return cases;
}

export function readGuardCases(path: string = defaultFixturesPath()): GuardCase[] {
  return parseGuardCases(readFileSync(path, "utf8"));
}

export function tallyLabels(cases: GuardCase[]): Record<(typeof CALIBRATION_QUESTION_IDS)[number], { positive: number; negative: number }> {
  return Object.fromEntries(CALIBRATION_QUESTION_IDS.map((question) => {
    const positive = cases.filter((entry) => entry.labels[question]).length;
    return [question, { positive, negative: cases.length - positive }];
  })) as Record<(typeof CALIBRATION_QUESTION_IDS)[number], { positive: number; negative: number }>;
}

function validNoul(answer: Answer | undefined): answer is Answer & { type: "noul"; noul: number } {
  return answer?.type === "noul" && Number.isFinite(answer.noul) && answer.noul >= 0 && answer.noul <= 1;
}

/**
 * Pure conversion of one engine result to independently authored comparison labels.
 *
 * `model` is the model the ENGINE reported for this call, read back from the shadow ledger —
 * never the configured id. `tune` groups by model and `joinGroundTruth` matches on it, so a
 * configured id standing in for the served one would silently split or mis-join the cohort, and
 * model drift is a thing that actually happens here (see checkModelDrift).
 */
export function buildCalibrationRows(entry: GuardCase, result: ManyResult, timestamp: string, model: string): ComparisonLine[] {
  if (!result.result) return [];
  invariant(result.key === entry.id, `guard calibration: result key ${result.key} paired with case ${entry.id} — judgeMany returns input order and this asserts it`);
  const rows: ComparisonLine[] = [];
  for (const question of CALIBRATION_QUESTION_IDS) {
    const answer = result.result[question]?.answer;
    if (!validNoul(answer)) continue;
    rows.push({ timestamp, caller: CALIBRATION_CALLER, session: CALIBRATION_SESSION, turn: entry.id, question, model, jev_value: answer.noul, keyword_verdict: entry.labels[question] });
  }
  return rows;
}

/**
 * The model this run's rows must carry, taken from the shadow lines judgeMany just wrote.
 * Null when the ledger says nothing, which means the rows cannot be written honestly.
 */
export function servedModel(shadow: ShadowLine[], turns: Set<string>, since: number): string | null {
  const models = new Set(
    shadow
      .filter((row) => row.caller === CALIBRATION_CALLER && row.session === CALIBRATION_SESSION && !row.error
        && (!row.turn || turns.has(row.turn))
        && Number.isFinite(Date.parse(row.ts)) && Date.parse(row.ts) >= since && !!row.model)
      .map((row) => row.model as string),
  );
  invariant(models.size <= 1, `guard calibration: this run was served by more than one model (${[...models].join(", ")}) — rerun rather than mix cohorts`);
  return [...models][0] ?? null;
}

export type CalibrationOptions = { dryRun: boolean; limit?: number; concurrency: number; fixtures: string };

export function parseOptions(argv: string[]): CalibrationOptions {
  const value = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index < 0 ? undefined : argv[index + 1];
  };
  const limitText = value("--limit");
  const concurrencyText = value("--concurrency");
  const limit = limitText === undefined ? undefined : Number(limitText);
  const concurrency = concurrencyText === undefined ? DEFAULT_CONCURRENCY : Number(concurrencyText);
  invariant(limit === undefined || (Number.isInteger(limit) && limit >= 0), "Calibrate: --limit must be a non-negative integer");
  invariant(Number.isInteger(concurrency) && concurrency >= 1, "Calibrate: --concurrency must be a positive integer");
  return { dryRun: argv.includes("--dry-run"), limit, concurrency, fixtures: value("--fixtures") ?? defaultFixturesPath() };
}

export async function main(argv: string[]): Promise<number> {
  const options = parseOptions(argv);
  const cases = readGuardCases(options.fixtures).slice(0, options.limit);
  const tally = tallyLabels(cases);
  if (options.dryRun) {
    console.log(`Calibration dry run: ${cases.length} cases`);
    for (const question of CALIBRATION_QUESTION_IDS) console.log(`${question}: positive=${tally[question].positive} negative=${tally[question].negative}`);
    return 0;
  }
  const started = performance.now();
  const startedAt = Date.now() - 1000;
  const results = await judgeMany(cases.map((entry) => ({ key: entry.id, state: redactForEngine(entry.content) })), CALIBRATION_QUESTIONS, {
    caller: CALIBRATION_CALLER,
    session: CALIBRATION_SESSION,
    concurrency: options.concurrency,
  });
  const timestamp = new Date().toISOString();
  const model = servedModel(readShadowHistory(), new Set(cases.map((entry) => entry.id)), startedAt);
  if (model === null) {
    console.error("Calibration: no shadow rows for this run, so the served model is unknown — writing nothing.");
    return 1;
  }
  const rows = results.flatMap((result, index) => buildCalibrationRows(cases[index]!, result, timestamp, model));
  const failures = results.filter((result) => result.error !== null).length + results.reduce((total, result) => total + (result.result ? CALIBRATION_QUESTION_IDS.filter((question) => !validNoul(result.result?.[question]?.answer)).length : 0), 0);
  if (rows.length) {
    const ledger = calibrationLedgerPath();
    mkdirSync(dirname(ledger), { recursive: true });
    appendFileSync(ledger, rows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
  }
  console.log(`Calibration: cases run=${cases.length} rows written=${rows.length} failures=${failures} model=${model} wall time=${Math.round(performance.now() - started)}ms`);
  for (const question of CALIBRATION_QUESTION_IDS) console.log(`${question}: positive=${tally[question].positive}`);
  return 0;
}

if (import.meta.main) {
  main(process.argv.slice(2)).then((code) => process.exit(code)).catch((error) => {
    console.error(String(error));
    process.exit(1);
  });
}
