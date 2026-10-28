#!/usr/bin/env bun
/**
 * QuestionSystemBakeoff.ts — one frozen question system, every engine, one table.
 *
 * Runs `runSystem` once per engine with `judge: makeJudge(engine)` (LIFEOS/ASSAY/EngineJudge.ts), on the same
 * system file and the same cases, all engines at once. Writes each engine's Report under <out>/<engine>/report.json
 * (plus report.md), a summary.json, and prints one table: per decision balanced accuracy, accuracy, escalation rate,
 * baseline margin (all scored and judged-only), failed calls, median ms per case, model.
 *
 * The production engine (clef-omni) reads text and images, so it always runs. A Clef alternate (clef, clef-flash)
 * on a text-only system that is not on the Clef text allowlist shows "fenced". The allowlist names the systems
 * whose cases are synthesized (DEFAULT_CLEF_TEXT_ALLOWLIST); the alternates never see anything else as text.
 *
 * Usage:
 *   bun LIFEOS/ASSAY/QuestionSystemBakeoff.ts run <system.json> --cases <cases.jsonl> [--engines clef-omni,clef,clef-flash,opus]
 *       [--split dev|holdout|all] [--out <dir>] [--concurrency N] [--clef-text-allowlist id,id] [--json]
 *
 * Exit codes: 0 ok · 1 error (bad arguments, broken system or cases, or an engine that failed every call it made)
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { checkCases, loadSystem, renderReportMarkdown, runSystem, assertReportShape, type Case, type QuestionSystem, type Report } from "./QuestionSystem";
import { engineModel, IMAGE_FIELD, isClef, isEngineName, makeJudge, ENGINE_NAMES, type EngineName, type Refusal } from "./EngineJudge";

export const DEFAULT_CLEF_TEXT_ALLOWLIST = ["guard-egress", "socialpost-ready", "errata-intake"] as const;

// ── Input reading ───────────────────────────────────────────────────────────

export function readCases(path: string): Case[] {
  const text = readFileSync(path, "utf8");
  if (text.trimStart().startsWith("[")) return JSON.parse(text) as Case[];
  return text.split("\n").filter((l) => l.trim()).map((l, i) => {
    try { return JSON.parse(l) as Case; } catch { throw new Error(`${path} line ${i + 1}: not valid JSON`); }
  });
}

export function selectSplit(cases: Case[], split: "dev" | "holdout" | "all"): Case[] {
  return cases.filter((c) => split === "all" || c.split === split);
}

/** How many selected cases carry an image the stages read. */
export function imageCases(system: QuestionSystem, cases: Case[]): number {
  const read = system.stages.some((s) => s.questions.some((q) => q.reads.includes(IMAGE_FIELD)));
  if (!read) return 0;
  return cases.filter((c) => typeof c.state[IMAGE_FIELD] === "string" && (c.state[IMAGE_FIELD] as string).length > 0).length;
}

export type Eligibility = { run: true } | { run: false; status: "fenced"; reason: string };

/** Whether an engine may run this system's cases at all. Mixed systems run; per-item refusals count as failed calls. */
export function eligibility(engine: EngineName, system: QuestionSystem, cases: Case[], allowlist: readonly string[]): Eligibility {
  const images = imageCases(system, cases);
  if (isClef(engine) && images === 0 && !allowlist.includes(system.id)) return { run: false, status: "fenced", reason: `text-only system "${system.id}" is not on the Clef text allowlist` };
  return { run: true };
}

// ── Table ───────────────────────────────────────────────────────────────────

export type TableRow = {
  engine: EngineName;
  status: "ran" | "fenced" | "error";
  decision: string | null;
  balanced_accuracy: number | null;
  accuracy: number | null;
  escalation_rate: number | null;
  margin: number | null;
  margin_judged: number | null;
  failed_calls: number;
  median_ms_per_case: number | null;
  model: string;
  note?: string;
};

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** One row per decision for an engine that ran; failed calls are the report's per-case-stage errors. */
export function rowsFor(engine: EngineName, report: Report, perCaseMs: number[]): TableRow[] {
  const model = report.models.join(", ") || engineModel(engine);
  const med = median(perCaseMs);
  return Object.entries(report.decisions).map(([id, d]) => ({
    engine, status: "ran" as const, decision: id,
    balanced_accuracy: d.balanced_accuracy, accuracy: d.accuracy, escalation_rate: d.escalation_rate,
    margin: d.margin, margin_judged: d.baseline?.judged.margin ?? null,
    failed_calls: report.errors.length, median_ms_per_case: med === null ? null : Math.round(med), model,
  }));
}

const f = (v: number | null, d = 3) => (v === null ? "—" : v.toFixed(d));
const s = (v: number | null) => (v === null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(3)}`);
const p = (v: number | null) => (v === null ? "—" : `${(v * 100).toFixed(0)}%`);

export function renderTable(rows: TableRow[]): string {
  const head = ["engine", "decision", "bal.acc", "acc", "escalated", "margin", "margin(judged)", "failed", "ms/case", "model"];
  const body = rows.map((r) => r.status === "ran"
    ? [r.engine, r.decision ?? "—", f(r.balanced_accuracy), f(r.accuracy), p(r.escalation_rate), s(r.margin), s(r.margin_judged), String(r.failed_calls), r.median_ms_per_case === null ? "—" : String(r.median_ms_per_case), r.model]
    : [r.engine, r.status, "", "", "", "", "", "", "", `${r.model}${r.note ? ` (${r.note})` : ""}`]);
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i]!.length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i]!)).join("  ").trimEnd();
  return [line(head), line(widths.map((w) => "-".repeat(w))), ...body.map(line)].join("\n");
}

// ── Run ─────────────────────────────────────────────────────────────────────

export type BakeoffOptions = {
  engines: EngineName[];
  split: "dev" | "holdout" | "all";
  out: string;
  concurrency?: number;
  clefTextAllowlist: readonly string[];
  /** Test seam: replaces makeJudge. */
  judgeFor?: typeof makeJudge;
};

export type BakeoffResult = { rows: TableRow[]; refusals: Refusal[]; reports: Partial<Record<EngineName, Report>> };

export async function bakeoff(system: QuestionSystem, cases: Case[], o: BakeoffOptions): Promise<BakeoffResult> {
  const selected = selectSplit(cases, o.split);
  if (!selected.length) throw new Error(`no cases in split "${o.split}"`);
  const refusals: Refusal[] = [];
  const reports: Partial<Record<EngineName, Report>> = {};
  const workDir = mkdtempSync(join(tmpdir(), "qs-bakeoff-"));
  try {
    const perEngine = await Promise.all(o.engines.map(async (engine): Promise<TableRow[]> => {
      const elig = eligibility(engine, system, selected, o.clefTextAllowlist);
      const stub = (status: TableRow["status"], note: string): TableRow => ({ engine, status, decision: null, balanced_accuracy: null, accuracy: null, escalation_rate: null, margin: null, margin_judged: null, failed_calls: 0, median_ms_per_case: null, model: engineModel(engine), note });
      if (!elig.run) return [stub(elig.status, elig.reason)];
      const ms = new Map<string, number>();
      const judge = (o.judgeFor ?? makeJudge)(engine, {
        systemId: system.id, clefTextAllowlist: o.clefTextAllowlist, workDir,
        onRefuse: (r) => { refusals.push(r); console.error(`[bakeoff] ${r.engine} refused ${r.key}: ${r.reason}`); },
        onTiming: (key, t) => ms.set(key, (ms.get(key) ?? 0) + t),
      });
      try {
        const report = await runSystem(system, cases, { split: o.split, judge, ...(o.concurrency ? { concurrency: o.concurrency } : {}) });
        assertReportShape(report);
        reports[engine] = report;
        const dir = join(o.out, engine);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "report.json"), JSON.stringify(report, null, 2) + "\n");
        writeFileSync(join(dir, "report.md"), renderReportMarkdown(report) + "\n");
        return rowsFor(engine, report, [...ms.values()]);
      } catch (e) {
        return [stub("error", String((e as Error)?.message ?? e).slice(0, 200))];
      }
    }));
    const rows = perEngine.flat();
    mkdirSync(o.out, { recursive: true });
    writeFileSync(join(o.out, "summary.json"), JSON.stringify({ system: system.id, split: o.split, cases: selected.length, generated_at: new Date().toISOString(), rows, refusals }, null, 2) + "\n");
    return { rows, refusals, reports };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

/** An engine that ran and failed every call it made: every selected case errored at its first stage. */
export function engineFailedAll(report: Report): boolean {
  const firstStage = report.layers.stages.find((st) => st.ran_for > 0);
  if (!firstStage) return false;
  return report.errors.filter((e) => e.stage === firstStage.id).length >= firstStage.ran_for;
}

// ── CLI ─────────────────────────────────────────────────────────────────────

const USAGE = `Usage:
  bun LIFEOS/ASSAY/QuestionSystemBakeoff.ts run <system.json> --cases <cases.jsonl> [--engines ${ENGINE_NAMES.join(",")}]
      [--split dev|holdout|all] [--out <dir>] [--concurrency N] [--clef-text-allowlist id,id] [--json]`;

export function parseArgs(argv: string[]): { pos: string[]; flags: Map<string, string | true> } {
  const pos: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--json") flags.set("json", true);
    else if (a.startsWith("--")) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) throw new Error(`${a} needs a value`);
      flags.set(a.slice(2), v);
      i++;
    } else pos.push(a);
  }
  return { pos, flags };
}

export async function main(argv: string[]): Promise<number> {
  const cmd = argv[0];
  if (!cmd || cmd === "-h" || cmd === "--help") { console.log(USAGE); return cmd ? 0 : 1; }
  if (cmd !== "run") { console.error(`unknown command: ${cmd}\n${USAGE}`); return 1; }
  const { pos, flags } = parseArgs(argv.slice(1));
  const file = pos[0];
  const casesFlag = flags.get("cases");
  if (!file || typeof casesFlag !== "string") { console.error(USAGE); return 1; }
  const engines = String(flags.get("engines") ?? ENGINE_NAMES.join(",")).split(",").map((e) => e.trim()).filter(Boolean);
  const bad = engines.filter((e) => !isEngineName(e));
  if (bad.length || !engines.length) { console.error(`unknown engine(s): ${bad.join(", ") || "(none)"}; known: ${ENGINE_NAMES.join(", ")}`); return 1; }
  const split = String(flags.get("split") ?? "dev");
  if (split !== "dev" && split !== "holdout" && split !== "all") { console.error("--split must be dev, holdout or all"); return 1; }
  let concurrency: number | undefined;
  if (flags.has("concurrency")) {
    concurrency = Number(flags.get("concurrency"));
    if (!Number.isInteger(concurrency) || concurrency < 1) { console.error("--concurrency needs a positive integer"); return 1; }
  }
  const allowFlag = flags.get("clef-text-allowlist");
  const allowlist = typeof allowFlag === "string" ? allowFlag.split(",").map((x) => x.trim()).filter(Boolean) : [...DEFAULT_CLEF_TEXT_ALLOWLIST];

  const systemPath = resolve(file);
  const system = loadSystem(systemPath);
  const cases = readCases(resolve(casesFlag));
  const check = checkCases(system, cases);
  if (check.errors.length) { for (const i of check.errors) console.error(`ERROR ${i.path || "(root)"}: ${i.message}`); console.error("cases are broken; fix them before run"); return 1; }
  const out = typeof flags.get("out") === "string" ? resolve(flags.get("out") as string) : join(dirname(systemPath), `bakeoff-${system.id}`);

  const t0 = performance.now();
  const r = await bakeoff(system, cases, { engines: engines as EngineName[], split, out, concurrency, clefTextAllowlist: allowlist });
  const secs = ((performance.now() - t0) / 1000).toFixed(1);
  if (flags.has("json")) console.log(JSON.stringify({ system: system.id, split, out, seconds: Number(secs), rows: r.rows, refusals: r.refusals.length }));
  else {
    console.log(`${system.id}: ${selectSplit(cases, split).length} ${split} cases, ${engines.length} engine(s), ${secs}s`);
    console.log(renderTable(r.rows));
    if (r.refusals.length) console.log(`refused items: ${r.refusals.length} (logged above; listed in summary.json)`);
    console.log(`wrote ${out}/<engine>/report.json and ${join(out, "summary.json")}`);
  }
  const dead = Object.entries(r.reports).filter(([, rep]) => rep && engineFailedAll(rep)).map(([e]) => e);
  const errored = r.rows.filter((x) => x.status === "error").map((x) => x.engine);
  if (dead.length || errored.length) { console.error(`engine(s) that failed every call or errored: ${[...new Set([...dead, ...errored])].join(", ")}`); return 1; }
  return 0;
}

if (import.meta.main) {
  main(process.argv.slice(2)).then((code) => process.exit(code)).catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
