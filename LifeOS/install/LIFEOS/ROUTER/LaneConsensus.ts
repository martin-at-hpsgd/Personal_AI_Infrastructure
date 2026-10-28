#!/usr/bin/env bun
/**
 * LaneConsensus.ts — cross-check the router gold labels with independent labelers, then rescore.
 *
 *   bun LIFEOS/ROUTER/LaneConsensus.ts
 *
 * The first gold set was labeled by one Opus agent, and the Opus classifier reads the same rules,
 * so its lead could be Opus agreeing with itself. Fable (Anthropic) and Astra (OpenAI) labeled the
 * same prompts blind (`fixtures/labels/<labeler>.jsonl`). This reports how often the labelers
 * agree on the lane (raw and Cohen's kappa), builds a majority label (2 of 3; no majority =
 * contested, left out), and scores every picker against each labeler and against the majority.
 * Picker answers come from the LaneEval caches; nothing here calls a model.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { lifeosPath } from "../TOOLS/Paths";
import { goldLane, loadGold, withDepth, type Raw } from "./LaneEval";
import { composeLane } from "./LaneQuestions";

type Label = { id: string; lane: string };
const LABELERS = ["opus", "fable", "astra"] as const;
const DIR = join(import.meta.dir, "fixtures");

export function loadLabels(name: string): Map<string, string> {
  if (name === "opus") return new Map([...loadGold(join(DIR, "lane-eval.jsonl")), ...loadGold(join(DIR, "lane-holdout.jsonl"))].map(g => [g.id, g.lane]));
  const p = join(DIR, "labels", `${name}.jsonl`);
  return new Map(readFileSync(p, "utf8").trim().split("\n").map(l => JSON.parse(l) as Label).map(l => [l.id, l.lane]));
}

/** Cohen's kappa for two labelers over their shared ids. */
export function kappa(a: Map<string, string>, b: Map<string, string>): { agree: number; n: number; kappa: number } {
  const ids = [...a.keys()].filter(id => b.has(id));
  const n = ids.length; const agree = ids.filter(id => a.get(id) === b.get(id)).length;
  const cats = new Set([...ids.map(id => a.get(id)!), ...ids.map(id => b.get(id)!)]);
  let pe = 0; for (const c of cats) pe += (ids.filter(id => a.get(id) === c).length / n) * (ids.filter(id => b.get(id) === c).length / n);
  const po = agree / n;
  return { agree, n, kappa: pe === 1 ? 1 : (po - pe) / (1 - pe) };
}

export function majority(sets: Map<string, string>[]): Map<string, string | null> {
  const out = new Map<string, string | null>();
  for (const id of sets[0].keys()) {
    const votes = sets.map(s => s.get(id)).filter((v): v is string => !!v);
    const count = new Map<string, number>(); for (const v of votes) count.set(v, (count.get(v) ?? 0) + 1);
    const [top, k] = [...count.entries()].sort((x, y) => y[1] - x[1])[0] ?? [null, 0];
    out.set(id, k >= 2 ? top : null);
  }
  return out;
}

if (import.meta.main) {
  const labels = Object.fromEntries(LABELERS.filter(l => l === "opus" || existsSync(join(DIR, "labels", `${l}.jsonl`))).map(l => [l, loadLabels(l)]));
  const names = Object.keys(labels);
  console.log("lane agreement between labelers:");
  for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) {
    const k = kappa(labels[names[i]], labels[names[j]]);
    console.log(`  ${names[i]} × ${names[j]}`.padEnd(20), `${k.agree}/${k.n} (${(k.agree / k.n * 100).toFixed(1)}%)  kappa ${k.kappa.toFixed(2)}`);
  }
  const maj = majority(names.map(n => labels[n]));
  const contested = [...maj.values()].filter(v => v === null).length;
  console.log(`\nmajority labels: ${maj.size - contested} decided, ${contested} contested (left out)\n`);

  const gold = [...loadGold(join(DIR, "lane-eval.jsonl")), ...loadGold(join(DIR, "lane-holdout.jsonl"))];
  const raw = new Map<string, Raw>();
  for (const f of ["lane-eval", "lane-holdout"]) for (const r of JSON.parse(readFileSync(lifeosPath("MEMORY", "STATE", "router", `${f}-raw.json`), "utf8")) as Raw[]) raw.set(r.id, r);
  const pickers: Record<string, (r: Raw) => string | null> = {
    "single lane choice": r => r.single,
    "decomposed Glance + code": r => r.decomposed ? composeLane(r.decomposed)?.lane ?? null : null,
    "Opus classifier": r => r.classifier,
  };
  const targets: Record<string, Map<string, string | null>> = { ...labels, majority: maj };
  console.log("picker".padEnd(26), Object.keys(targets).map(t => `vs ${t}`.padEnd(18)).join(""));
  for (const [name, pick] of Object.entries(pickers)) {
    const cells = Object.values(targets).map(t => {
      let hit = 0, n = 0;
      for (const g of gold) { const label = t.get(g.id); const r = raw.get(g.id); if (!label || !r) continue; const p = withDepth(g.prompt, pick(r)); if (!p) continue; n++; if (p === goldLane(g.prompt, label)) hit++; }
      return `${hit}/${n} ${(hit / n * 100).toFixed(1)}%`.padEnd(18);
    });
    console.log(name.padEnd(26), cells.join(""));
  }
}
