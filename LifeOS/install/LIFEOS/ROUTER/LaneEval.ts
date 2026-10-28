#!/usr/bin/env bun
/**
 * LaneEval.ts — score the router's lane pickers against a gold set (fixtures/lane-eval.jsonl by default).
 *
 *   bun LIFEOS/ROUTER/LaneEval.ts [--run [--only-decomposed] [--no-classifier]] [--fixture <jsonl>] [--cache <path>]
 *
 * --run asks the live engines and writes the raw answers to the cache; without it the report is
 * recomputed from the cache, so thresholds can be tuned offline without spending calls.
 * --only-decomposed re-asks only the Glance questions and keeps the cached single/classifier answers.
 * Four pickers are scored: the single `lane` choice (ROUTER_QUESTIONS), the decomposed Glance
 * questions composed by code (LaneQuestions.ts), the composer fed the GOLD per-question labels
 * (does the composition logic itself match the Rules?), and the Opus classifier. Depth words bind
 * before any classifier in production (FrontDoor), so every picker gets that same override.
 * Every engine call goes through Assay's ask with a scratch shadow log, never the live ledger.
 *
 * Uses Assay's judgment layer (LIFEOS/DOCUMENTATION/Assay/AssaySystem.md).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { ask, yesAt } from "../ASSAY/Assay";
import type { Answer, NoulAnswer } from "../ASSAY/Engine";
import { inference } from "../TOOLS/Inference";
import { lifeosPath } from "../TOOLS/Paths";
import { LANE_RULES, type Lane } from "../../hooks/lib/lane-rules";
import { CLASSIFIER_SYSTEM, ROUTER_QUESTIONS } from "./FrontDoor";
import { matchDepthDirective } from "./Depth";
import { composeLane, liveLane, predictLane, DEFAULT_THRESHOLDS, LANE_QUESTIONS, type ComposeThresholds } from "./LaneQuestions";

export type Gold = { id: string; prompt: string; lane: Lane; wants_change: boolean; exhaustive: boolean; blast: boolean; second_look: boolean; judgment: number; note?: string };
export type Raw = { id: string; single: string | null; decomposed: Record<string, Answer> | null; classifier: string | null; errors: string[] };

export const FIXTURE = join(import.meta.dir, "fixtures", "lane-eval.jsonl");
const GOLD_NOULS = ["wants_change", "exhaustive", "blast", "second_look"] as const;

export function loadGold(path = FIXTURE): Gold[] {
  return readFileSync(path, "utf8").trim().split("\n").map(l => JSON.parse(l) as Gold);
}

/** Gold per-question labels as synthetic answers; the gold 0–4 judgment maps onto the five judgment nouls. */
export function goldAnswers(g: Gold): Record<string, Answer> {
  const n = (b: boolean): NoulAnswer => ({ type: "noul", noul: b ? 1 : 0 });
  const j = g.judgment;
  return { wants_change: n(g.wants_change), exhaustive: n(g.exhaustive), blast: n(g.blast), second_look: n(g.second_look),
    script_could_do: n(j === 0), approach_decided: n(j <= 2), needs_reasoning: n(j === 2), taste_or_design: n(j === 3), expert_hard: n(j === 4) };
}

/**
 * The depth override production applies (FrontDoor.route): depth words mean Opus at xhigh, or Astra when
 * the pick was already astra. It said fable until 2026-09-25, a rule production dropped on 2026-09-24,
 * so these floors were scoring a different router (router review, 2026-09-25). Glance system caller:
 * the scores here grade the dispatch-advisor answers.
 */
export function withDepth(prompt: string, lane: string | null): string | null {
  return lane !== null && lane !== "astra" && matchDepthDirective(prompt) ? "opus" : lane;
}

/**
 * A gold label as the live router would route it. The fixtures keep the labels they were written with: luna and
 * terra are the retired classes that now run as haiku and sonnet (liveLane), and a depth prompt labelled fable is
 * routed to opus by the same override every picker gets. Scoring raw labels counted those correct picks as misses.
 */
export function goldLane(prompt: string, lane: string): string {
  return withDepth(prompt, liveLane(lane)) ?? lane;
}

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } }));
  return out;
}

async function runLive(gold: Gold[], withClassifier: boolean, logPath: string, reuse?: Map<string, Raw>): Promise<Raw[]> {
  return pool(gold, 6, async g => {
    const errors: string[] = [];
    const opts = { caller: "dispatch-advisor", session: "lane-eval", logPath, timeoutMs: 10_000 };
    const old = reuse?.get(g.id);
    const single = old ? Promise.resolve(old.single) : ask({ prompt: g.prompt, rules: LANE_RULES }, ROUTER_QUESTIONS, opts)
      .then(r => { const a = r.answers.lane; return a?.type === "choice" ? a.choice : null; })
      .catch(e => { errors.push(`single: ${String(e).slice(0, 80)}`); return null; });
    const decomposed = ask({ prompt: g.prompt }, LANE_QUESTIONS, opts)
      .then(r => r.answers)
      .catch(e => { errors.push(`decomposed: ${String(e).slice(0, 80)}`); return null; });
    const classifier = old ? Promise.resolve(old.classifier) : !withClassifier ? Promise.resolve(null) :
      inference({ systemPrompt: CLASSIFIER_SYSTEM, userPrompt: g.prompt, level: "high", effort: "low", vendor: "anthropic", allowVendorFallback: false, maxAttempts: 1, expectJson: true, timeout: 30_000 })
        .then(r => { const route = (r.parsed as { route?: unknown } | undefined)?.route; return r.success && typeof route === "string" ? route : null; })
        .catch(e => { errors.push(`classifier: ${String(e).slice(0, 80)}`); return null; });
    return { id: g.id, single: await single, decomposed: await decomposed, classifier: await classifier, errors };
  });
}

const pct = (a: number, b: number) => b ? `${a}/${b} (${(a / b * 100).toFixed(1)}%)` : "n/a";

export function report(gold: Gold[], raw: Raw[], t: ComposeThresholds = DEFAULT_THRESHOLDS): string {
  const byId = new Map(raw.map(r => [r.id, r]));
  const lines: string[] = [];
  const score = (name: string, pick: (g: Gold, r: Raw) => string | null) => {
    let hit = 0, n = 0; const miss: string[] = [];
    for (const g of gold) { const r = byId.get(g.id); if (!r) continue; const p = withDepth(g.prompt, pick(g, r)); if (p === null) continue; const want = goldLane(g.prompt, g.lane); n++; if (p === want) hit++; else miss.push(`${g.id} ${want}→${p}`); }
    lines.push(`${name.padEnd(34)} ${pct(hit, n)}`);
    return miss;
  };
  score("single lane choice", (_, r) => r.single);
  const decMiss = score("decomposed Glance + code", (_, r) => r.decomposed ? composeLane(r.decomposed, t)?.lane ?? null : null);
  score("decomposed + learned model (in-sample)", (g, r) => r.decomposed ? predictLane(r.decomposed, { prompt: g.prompt, hasContext: false })?.lane ?? null : null);
  const goldMiss = score("composer on gold labels (logic)", g => composeLane(goldAnswers(g), t)?.lane ?? null);
  score("Opus classifier", (_, r) => r.classifier);
  lines.push("", "per question (decomposed, vs gold):");
  for (const q of GOLD_NOULS) {
    let hit = 0, n = 0, tp = 0, pos = 0;
    for (const g of gold) { const a = byId.get(g.id)?.decomposed?.[q]; if (a?.type !== "noul") continue; n++; const y = yesAt(a, t.per?.[q] ?? t.noul) === true; if (y === g[q]) hit++; if (g[q]) { pos++; if (y) tp++; } }
    lines.push(`  ${q.padEnd(14)} ${pct(hit, n)}  recall on true ${pct(tp, pos)}`);
  }
  let exact = 0, near = 0, n = 0;
  for (const g of gold) { const d = byId.get(g.id)?.decomposed; const c = d ? composeLane(d, t) : null; if (!c) continue; n++; if (c.level === g.judgment) exact++; if (Math.abs(c.level - g.judgment) <= 1) near++; }
  lines.push(`  judgment level exact ${pct(exact, n)}  within one ${pct(near, n)}`);
  const errs = raw.flatMap(r => r.errors); if (errs.length) lines.push("", `errors: ${errs.length} (first: ${errs[0]})`);
  lines.push("", `decomposed misses: ${decMiss.join(", ") || "none"}`, `composer-on-gold misses: ${goldMiss.join(", ") || "none"}`);
  return lines.join("\n");
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const fi = argv.indexOf("--fixture");
  const fixture = fi >= 0 ? argv[fi + 1] : FIXTURE;
  const ci = argv.indexOf("--cache");
  const cache = ci >= 0 ? argv[ci + 1] : lifeosPath("MEMORY", "STATE", "router", `${basename(fixture, ".jsonl")}-raw.json`);
  const gold = loadGold(fixture);
  let raw: Raw[];
  if (argv.includes("--run")) {
    mkdirSync(dirname(cache), { recursive: true });
    const prior = new Map(existsSync(cache) ? (JSON.parse(readFileSync(cache, "utf8")) as Raw[]).map(r => [r.id, r]) : []);
    raw = await runLive(gold, !argv.includes("--no-classifier"), join(dirname(cache), "lane-eval-shadow.jsonl"), argv.includes("--only-decomposed") ? prior : undefined);
    writeFileSync(cache, JSON.stringify(raw, null, 1));
  } else {
    if (!existsSync(cache)) { console.error(`no cache at ${cache}; run with --run first`); process.exit(2); }
    raw = JSON.parse(readFileSync(cache, "utf8")) as Raw[];
  }
  console.log(report(gold, raw));
}
