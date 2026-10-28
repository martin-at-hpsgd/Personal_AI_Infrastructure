/**
 * evals adapter — answers "is any judged eval suite running without an earned
 * calibration record?" from the eval census's own coverage verb
 * (`EvalCensus.ts --calibration-coverage --json`), which applies the one
 * earned rule in LIFEOS/TOOLS/lib/Calibration.ts: agreement ≥ 85%, kappa ≥ 0.4,
 * two labels per rung, nothing stale in the judge chain, rubric, or labels.
 *
 * refs: calibration-coverage, proxy-share
 *
 * Reads the engine's output only; never re-derives a suite's status here.
 * Unknown (never pass) when the census cannot run.
 */

import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Adapter } from "./types";
import type { AnswerInput } from "../Store";
import type { Question } from "../Registry";

const VERSION = "evals/1.0.0";
const CLAUDE = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
const CENSUS = join(CLAUDE, "LIFEOS/TOOLS/EvalCensus.ts");

interface CoverageRow { suite: string; judged: number; earned: boolean; reason: string; age_days: number | null; red: boolean }
interface Coverage { total: number; earned: number; provisional: number; rows: CoverageRow[] }

export function coverageAnswer(q: Question, c: Coverage): AnswerInput {
  const bad = c.rows.filter((r) => !r.earned);
  const computed_from = {
    touched: [`EvalCensus --calibration-coverage (${c.total} judged suites)`],
    untouched: ["suites outside USER/Assay/Suites and skills/Assay/Suites", "deterministic-only suites (no judge to calibrate)"],
  };
  // No judged suites at all is a pass: nothing to calibrate. Any provisional suite is a fail.
  return {
    question_id: q.id,
    verdict: bad.length === 0 ? "pass" : "fail",
    value: `${c.earned}/${c.total} judged suites on an earned record`,
    evidence: bad.length === 0
      ? (c.total === 0 ? "no judged suites in the estate" : `every judged suite calibrated: ${c.rows.map((r) => r.suite).join(", ")}`)
      : `provisional: ${bad.slice(0, 6).map((r) => `${r.suite} (${r.age_days !== null ? `${r.age_days}d, ` : ""}${r.reason})`).join("; ")}${bad.length > 6 ? ` +${bad.length - 6} more` : ""}`,
    computed_from,
    closer_version: VERSION,
  };
}

export function runCoverage(exec: typeof spawnSync = spawnSync): Coverage {
  const r = exec("bun", [CENSUS, "--calibration-coverage", "--json"], { encoding: "utf8", timeout: 120_000 });
  const out = String(r.stdout ?? "");
  if (r.error) throw new Error(`census did not run: ${r.error.message}`);
  const start = out.indexOf("{");
  if (start < 0) throw new Error(`census printed no JSON (exit ${r.status}): ${String(r.stderr ?? "").slice(0, 160)}`);
  const c = JSON.parse(out.slice(start)) as Coverage;
  if (!Array.isArray(c.rows)) throw new Error("census JSON carries no rows[]");
  return c;
}

/**
 * proxy-share — "is any judged suite calibrated only against proxy truth?"
 * A proxy record's labels came from a model or the deterministic layer, never
 * from a principal attestation (Calibration.ts third state, ISC eval tiers
 * ISC-6, 2026-09-22). The coverage row's reason starts with "proxy:" for those.
 * Pass only when zero judged suites are proxy-calibrated; the count is the
 * value so the answer history shows whether the share is falling.
 */
export function proxyShareAnswer(q: Question, c: Coverage): AnswerInput {
  const proxy = c.rows.filter((r) => /^proxy\b/i.test(r.reason));
  return {
    question_id: q.id,
    verdict: proxy.length === 0 ? "pass" : "fail",
    value: `${proxy.length}/${c.total} judged suites on proxy calibration`,
    evidence: proxy.length === 0
      ? (c.total === 0 ? "no judged suites in the estate" : "no judged suite rests on model-only or guard-only labels")
      : `proxy: ${proxy.slice(0, 8).map((r) => r.suite).join(", ")}${proxy.length > 8 ? ` +${proxy.length - 8} more` : ""}`,
    computed_from: {
      touched: [`EvalCensus --calibration-coverage (${c.total} judged suites)`, "Calibration.ts proxy state"],
      untouched: ["Glance callers with no eval suite (their proxy truth is reported by Assay.ts status)"],
    },
    closer_version: VERSION,
  };
}

export const evals: Adapter = {
  name: "evals",
  version: VERSION,

  async answers(questions: Question[]): Promise<AnswerInput[]> {
    const c = runCoverage();
    return questions.map((q) => (q.answerer?.ref === "proxy-share" ? proxyShareAnswer(q, c) : coverageAnswer(q, c)));
  },
};
