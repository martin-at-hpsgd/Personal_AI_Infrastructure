#!/usr/bin/env bun
/**
 * EngineBakeoff.ts — Glance's engine against its second-option engines on authored labels.
 *
 * Assay caller: `guard-calibration` (shadow, offline) for the production leg.
 * Doc: LIFEOS/DOCUMENTATION/Assay/AssaySystem.md § Second-option engines.
 *
 * Runs the production engine (Clef-omni, through Assay.ask) and each alternate (Cloudflare's Clef and
 * Clef-flash on Workers AI, called through Engine.ts callEngine, which refuses secret-shaped state and validates
 * every answer) over the synthesized guard corpus, redacted exactly as the live guard redacts it, and scores every
 * engine against the authored per-question labels: accuracy at the registered cut (through
 * decide(), never a literal), AUC, Brier and calibration error, plus latency from this machine.
 *
 * DATA CLASS: the ONLY state this file sends anywhere is the synthesized fixture corpus (--fixtures only swaps which synthesized guard-case file is read; every case still goes through redactForEngine).
 *
 * Writes: one raw file per run under MEMORY/OBSERVABILITY/assay-engine-bakeoff/ and one
 * summary line in MEMORY/OBSERVABILITY/assay-engine-bakeoff.jsonl. When an alternate beats
 * the production engine on pooled AUC and Brier both, it emits one Vigil event so the principal hears about it.
 *
 * Usage:
 *   bun LIFEOS/ASSAY/EngineBakeoff.ts run [--fixtures PATH] [--json] [--no-vigil]   call every engine, record, print summary
 *       --fixtures: a guard-cases JSONL; defaults to ASSAY/fixtures/guard-cases.jsonl where the install carries that
 *       corpus (a public install does not, so pass --fixtures there). With neither, usage error, exit 2.
 *   bun LIFEOS/ASSAY/EngineBakeoff.ts report [--file PATH]         score a recorded raw file (latest by default)
 *   bun LIFEOS/ASSAY/EngineBakeoff.ts history                      one line per past run
 *
 * Exit codes: 0 ok · 1 error (missing credentials, an engine failed on every case) · 2 usage (no fixtures file to run on)
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { CALIBRATION_CALLER, CALIBRATION_QUESTION_IDS, CALIBRATION_QUESTIONS, defaultFixturesPath, readGuardCases, type GuardCase } from "./Calibrate";
import { ask, decide } from "./Assay";
import { callEngine, describeFailure, redactForEngine, resolveCredentials, type EngineCredentials } from "./Engine";
import { CROSS_VENDOR } from "../TOOLS/models";
import { lifeosPath } from "../TOOLS/Paths";
import { invariant } from "../TOOLS/Invariant";
import { loadVigilEmit, type VigilEvent } from "../TOOLS/lib/VigilOptional";

type Q = (typeof CALIBRATION_QUESTION_IDS)[number];
export type Engine = { id: string; kind: "glance" | "workers-ai"; model: string };

/** The engine Assay.ask runs in production: every alternate is measured against it. */
export const PRODUCTION_ENGINE = "clef-omni";

export const ENGINES: Engine[] = [
  // The production engine, called through Assay.ask (registry, budget, ledger): Clef-omni. Not run a second time directly.
  { id: PRODUCTION_ENGINE, kind: "glance", model: CROSS_VENDOR.assayEngine! },
  { id: "clef", kind: "workers-ai", model: CROSS_VENDOR.clef! },
  { id: "clef-flash", kind: "workers-ai", model: CROSS_VENDOR.clefFlash! },
];
const BASELINE: string = PRODUCTION_ENGINE;
const POOL = 8;
const REQUEST_TIMEOUT_MS = 15_000;

export type Row = { engine: string; id: string; model: string | null; latency_ms: number; error: string | null; p: Partial<Record<Q, number>>; labels: GuardCase["labels"] };
export type Metrics = { n: number; positives: number; accuracy: number; balanced: number; auc: number; brier: number; ece: number };
export type EngineSummary = { engine: string; model: string; answered: number; failed: number; pooled: Metrics; questions: Record<Q, Metrics>; latency: { median: number; p95: number } };
export type RunSummary = { ts: string; run_id: string; cases: number; pool: number; raw: string; engines: EngineSummary[]; ahead: string[] };

const OBS = () => lifeosPath("MEMORY", "OBSERVABILITY");
const rawDir = () => join(OBS(), "assay-engine-bakeoff");
const historyPath = () => join(OBS(), "assay-engine-bakeoff.jsonl");

// ── Engine calls ────────────────────────────────────────────────────────────

/** The engine client's one credential reader (Engine.ts resolveCredentials). */
function cloudflare(): EngineCredentials {
  const creds = resolveCredentials();
  if (!creds) throw new Error("EngineBakeoff: CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_API_TOKEN missing");
  return creds;
}

function nouls(answers: Record<string, { type?: string; noul?: number }> | undefined): Partial<Record<Q, number>> {
  const p: Partial<Record<Q, number>> = {};
  for (const q of CALIBRATION_QUESTION_IDS) {
    const a = answers?.[q];
    if (a?.type === "noul" && typeof a.noul === "number" && Number.isFinite(a.noul)) p[q] = a.noul;
  }
  return p;
}

/** An alternate, direct on Workers AI through callEngine: secret-shape refusal, then answer validation for every question. */
export async function callWorkersAi(model: string, state: string, cf: EngineCredentials, fetchImpl?: typeof fetch): Promise<Omit<Row, "engine" | "id" | "labels">> {
  const t0 = performance.now();
  try {
    const r = await callEngine(state, CALIBRATION_QUESTIONS, { model, apiKey: cf.apiToken, accountId: cf.accountId, timeoutMs: REQUEST_TIMEOUT_MS, ...(fetchImpl ? { fetchImpl } : {}) }, t0);
    if (!r.ok) return { model: null, latency_ms: r.latencyMs, error: describeFailure(r), p: {} };
    return { model: r.response.model, latency_ms: r.response.latency_ms, error: null, p: nouls(r.response.answers as Record<string, { type?: string; noul?: number }>) };
  } catch (e) {
    return { model: null, latency_ms: Math.round(performance.now() - t0), error: String(e).slice(0, 200), p: {} };
  }
}

async function callGlance(state: string): Promise<Omit<Row, "engine" | "id" | "labels">> {
  const t0 = performance.now();
  try {
    const r = await ask(state, CALIBRATION_QUESTIONS, { caller: CALIBRATION_CALLER, session: "engine-bakeoff" });
    return { model: r.model, latency_ms: Math.round(performance.now() - t0), error: null, p: nouls(r.answers as Record<string, { type?: string; noul?: number }>) };
  } catch (e) {
    return { model: null, latency_ms: Math.round(performance.now() - t0), error: String(e).slice(0, 200), p: {} };
  }
}

/** Every engine on every case, one shuffled pool so no engine gets a quieter slice of it. */
export async function runAll(cases: GuardCase[], engines: Engine[] = ENGINES): Promise<Row[]> {
  const cf = engines.some((e) => e.kind === "workers-ai") ? cloudflare() : null;
  const jobs = engines.flatMap((engine) => cases.map((c) => ({ engine, c })));
  for (let i = jobs.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [jobs[i], jobs[j]] = [jobs[j]!, jobs[i]!]; }
  const out: Row[] = [];
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const { engine, c } = jobs[next++]!;
      const state = redactForEngine(c.content);
      const r = engine.kind === "glance" ? await callGlance(state) : await callWorkersAi(engine.model, state, cf!);
      out.push({ engine: engine.id, id: c.id, labels: c.labels, ...r });
    }
  };
  await Promise.all(Array.from({ length: POOL }, worker));
  return out;
}

// ── Scoring (pure) ──────────────────────────────────────────────────────────

/** AUC by pairwise comparison: the chance a random positive outranks a random negative. */
export function auc(pairs: { p: number; y: boolean }[]): number {
  const pos = pairs.filter((x) => x.y), neg = pairs.filter((x) => !x.y);
  if (!pos.length || !neg.length) return NaN;
  let s = 0;
  for (const a of pos) for (const b of neg) s += a.p === b.p ? 0.5 : Number(a.p > b.p);
  return s / (pos.length * neg.length);
}

/** `yes` comes from decide() at the registered cut for the question, never from a literal here. */
export function metrics(pairs: { p: number; y: boolean; yes: boolean }[]): Metrics {
  const n = pairs.length;
  const pos = pairs.filter((x) => x.y), neg = pairs.filter((x) => !x.y);
  const rate = (xs: typeof pairs) => (xs.length ? xs.filter((x) => x.yes === x.y).length / xs.length : NaN);
  let ece = 0;
  for (let b = 0; b < 10; b++) {
    const bin = pairs.filter((x) => Math.min(9, Math.floor(x.p * 10)) === b);
    if (!bin.length) continue;
    const conf = bin.reduce((s, x) => s + x.p, 0) / bin.length;
    ece += (bin.length / n) * Math.abs(conf - bin.filter((x) => x.y).length / bin.length);
  }
  return {
    n,
    positives: pos.length,
    accuracy: rate(pairs),
    balanced: (rate(pos) + rate(neg)) / 2,
    auc: auc(pairs),
    brier: pairs.reduce((s, x) => s + (x.p - Number(x.y)) ** 2, 0) / n,
    ece,
  };
}

function percentile(xs: number[], q: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))]! : NaN;
}

function pairsFor(rows: Row[], questions: readonly Q[]) {
  return rows.filter((r) => !r.error).flatMap((r) => questions.filter((q) => typeof r.p[q] === "number").map((q) => {
    const p = r.p[q]!;
    return { p, y: r.labels[q], yes: decide(CALIBRATION_CALLER, q, { type: "noul", noul: p }).yes === true };
  }));
}

export function summarize(rows: Row[], engines: Engine[], meta: { run_id: string; ts: string; raw: string; cases: number }): RunSummary {
  const summaries: EngineSummary[] = engines.map((e) => {
    const mine = rows.filter((r) => r.engine === e.id);
    const ok = mine.filter((r) => !r.error);
    const lat = ok.map((r) => r.latency_ms);
    return {
      engine: e.id,
      model: [...new Set(ok.map((r) => r.model).filter(Boolean))].join(",") || e.model,
      answered: ok.length,
      failed: mine.length - ok.length,
      pooled: metrics(pairsFor(mine, CALIBRATION_QUESTION_IDS)),
      questions: Object.fromEntries(CALIBRATION_QUESTION_IDS.map((q) => [q, metrics(pairsFor(mine, [q]))])) as Record<Q, Metrics>,
      latency: { median: percentile(lat, 0.5), p95: percentile(lat, 0.95) },
    };
  });
  const base = summaries.find((s) => s.engine === BASELINE);
  const ahead = base
    ? summaries.filter((s) => s.engine !== BASELINE && s.answered > 0 && s.pooled.auc > base.pooled.auc && s.pooled.brier < base.pooled.brier).map((s) => s.engine)
    : [];
  return { ts: meta.ts, run_id: meta.run_id, cases: meta.cases, pool: POOL, raw: meta.raw, engines: summaries, ahead };
}

// ── Output ──────────────────────────────────────────────────────────────────

export function renderSummary(s: RunSummary): string {
  const f = (x: number) => (Number.isNaN(x) ? "  n/a" : x.toFixed(3));
  const lines = [`Glance engine bake-off ${s.ts} · ${s.cases} cases · pool ${s.pool}`, "", "engine         model                answered failed  acc    bal    auc    brier  ece    median  p95"];
  for (const e of s.engines) lines.push(`${e.engine.padEnd(14)} ${e.model.padEnd(20)} ${String(e.answered).padStart(8)} ${String(e.failed).padStart(6)}  ${f(e.pooled.accuracy)}  ${f(e.pooled.balanced)}  ${f(e.pooled.auc)}  ${f(e.pooled.brier)}  ${f(e.pooled.ece)}  ${String(e.latency.median).padStart(5)}ms ${String(e.latency.p95).padStart(5)}ms`);
  lines.push("", "per question (auc / brier / ece)");
  for (const q of CALIBRATION_QUESTION_IDS) lines.push(`  ${q.padEnd(16)} ` + s.engines.map((e) => `${e.engine} ${f(e.questions[q].auc)}/${f(e.questions[q].brier)}/${f(e.questions[q].ece)}`).join("   "));
  lines.push("", s.ahead.length ? `AHEAD OF ${BASELINE.toUpperCase()}: ${s.ahead.join(", ")} (better pooled AUC and Brier)` : `No alternate beats ${BASELINE} on pooled AUC and Brier.`);
  return lines.join("\n");
}

/** The Vigil event for a run where an alternate pulled ahead; null when none did. */
export function aheadEvent(s: RunSummary): VigilEvent | null {
  if (!s.ahead.length) return null;
  const base = s.engines.find((e) => e.engine === BASELINE)!;
  const detail = s.engines.filter((e) => s.ahead.includes(e.engine))
    .map((e) => `${e.engine} AUC ${e.pooled.auc.toFixed(3)} vs ${base.pooled.auc.toFixed(3)}, Brier ${e.pooled.brier.toFixed(3)} vs ${base.pooled.brier.toFixed(3)}, median ${e.latency.median}ms vs ${base.latency.median}ms`).join("; ");
  return {
    id: randomUUID(), source: "glance-engine-bakeoff", ts: s.ts, kind: "ai", severity: "medium",
    title: `A second-option engine now beats the production engine (${BASELINE}): ${s.ahead.join(", ")}`,
    summary: `${detail}. Details: bun LIFEOS/ASSAY/EngineBakeoff.ts report`,
    ref: s.run_id, url: null, privacy_class: "personal", dedup_key: `glance-engine-bakeoff:ahead:${s.ahead.join(",")}:${s.ts.slice(0, 7)}`,
  };
}

function notify(s: RunSummary): void {
  const event = aheadEvent(s);
  if (event) loadVigilEmit()?.(event as never);
}

function latestRaw(): string {
  const dir = rawDir();
  invariant(existsSync(dir), "EngineBakeoff: no recorded runs yet — run `EngineBakeoff.ts run` first");
  const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort();
  invariant(files.length > 0, "EngineBakeoff: no recorded runs yet");
  return join(dir, files[files.length - 1]!);
}

function readRaw(path: string): Row[] {
  return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Row);
}

export const USAGE = "bun LIFEOS/ASSAY/EngineBakeoff.ts run [--fixtures PATH] [--json] [--no-vigil] | report [--file PATH] | history";

export async function main(argv: string[]): Promise<number> {
  const cmd = argv[0];
  const value = (flag: string) => { const i = argv.indexOf(flag); return i < 0 ? undefined : argv[i + 1]; };
  if (cmd === "run") {
    // A public build ships no default corpus and its defaultFixturesPath() throws; that is "no fixtures" (exit 2), not an error.
    let fixtures = value("--fixtures");
    if (fixtures === undefined) { try { fixtures = defaultFixturesPath(); } catch { fixtures = undefined; } }
    if (fixtures === undefined || !existsSync(fixtures)) {
      console.error(`EngineBakeoff: no guard-case fixtures${fixtures ? ` at ${fixtures}` : " (pass --fixtures PATH)"}\nusage: ${USAGE}`);
      return 2;
    }
    const cases = readGuardCases(fixtures);
    const ts = new Date().toISOString();
    const run_id = `${ts.slice(0, 19).replace(/:/g, "")}Z`;
    const rows = await runAll(cases);
    invariant(rows.length === cases.length * ENGINES.length, `EngineBakeoff: expected ${cases.length * ENGINES.length} rows, got ${rows.length}`);
    mkdirSync(rawDir(), { recursive: true });
    const raw = join(rawDir(), `${run_id}.jsonl`);
    writeFileSync(raw, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const s = summarize(rows, ENGINES, { run_id, ts, raw, cases: cases.length });
    invariant(s.engines.length === ENGINES.length, "EngineBakeoff: one summary per engine");
    appendFileSync(historyPath(), JSON.stringify(s) + "\n");
    if (!argv.includes("--no-vigil")) notify(s);
    if (argv.includes("--json")) console.log(JSON.stringify({ ok: true, run_id, ahead: s.ahead, engines: s.engines.map((e) => ({ engine: e.engine, model: e.model, failed: e.failed, auc: e.pooled.auc, brier: e.pooled.brier, ece: e.pooled.ece, median_ms: e.latency.median })) }));
    else console.log(renderSummary(s));
    return s.engines.some((e) => e.answered === 0) ? 1 : 0;
  }
  if (cmd === "report") {
    const path = value("--file") ?? latestRaw();
    const rows = readRaw(path);
    const cases = new Set(rows.map((r) => r.id)).size;
    console.log(renderSummary(summarize(rows, ENGINES.filter((e) => rows.some((r) => r.engine === e.id)), { run_id: path, ts: "recorded", raw: path, cases })));
    return 0;
  }
  if (cmd === "history") {
    if (!existsSync(historyPath())) { console.log("no runs yet"); return 0; }
    for (const line of readFileSync(historyPath(), "utf8").trim().split("\n").filter(Boolean)) {
      const s = JSON.parse(line) as RunSummary;
      console.log(`${s.ts.slice(0, 16)}  ` + s.engines.map((e) => `${e.engine} auc ${e.pooled.auc.toFixed(3)} brier ${e.pooled.brier.toFixed(3)} ${e.latency.median}ms`).join(" · ") + (s.ahead.length ? `  AHEAD: ${s.ahead.join(",")}` : ""));
    }
    return 0;
  }
  console.log(`usage: ${USAGE}`);
  return cmd ? 1 : 0;
}

if (import.meta.main) {
  main(process.argv.slice(2)).then((code) => process.exit(code)).catch((e) => { console.error(String(e)); process.exit(1); });
}
