#!/usr/bin/env bun
/**
 * @version 1.0.0
 * Recommend.ts — weekly recommendation cards from the evidence index (execution-evidence ISC-29..31).
 *
 * It evaluates only the comparisons registered below, fixed in advance and versioned, so a card can never come
 * from searching the data for something that looks significant. A comparison files one Upgrades record (source
 * `evidence`) only when its 95% interval excludes zero with at least MIN_PER_ARM turns in each arm. The claim
 * names the comparison id and the ISO week and carries no numbers, so Upgrades' claim-hash dedup makes a second
 * run in the same week file nothing. Every card is a recommendation: nothing here changes the router.
 *
 *   bun LIFEOS/EVIDENCE/Recommend.ts [--dry-run] [--emit] [--json]     (run by the evidence-weekly workflow)
 *   bun LIFEOS/EVIDENCE/Project.ts recommend [--dry-run] [--json]
 */
import type { Database } from "bun:sqlite";
import { join } from "path";
import { getClaudeDir } from "../TOOLS/Paths";
import { invariant } from "../TOOLS/Invariant";
import { emitVigilEvent } from "../TOOLS/lib/VigilOptional";
import { addUpgrade, type UpgradeInput } from "../TOOLS/Upgrades";
import { openDb } from "./Store";
import { experiment, type Difference } from "./Queries";

/** Bump when a comparison is added, removed or its rule changes. */
export const COMPARISONS_VERSION = "1";
/** Turns needed in each arm before a comparison may file: about a 0.04 detectable P(bad) difference at a 10% holdout. */
export const MIN_PER_ARM = 200;

type Card = { claim: string; recommendation: string; target_surface: string };
export interface Comparison { id: string; metric: Difference["metric"]; question: string; heldOutHigher: Card; heldOutLower: Card }

/** Pre-registered 2026-10-09 with the router holdout. Both read the randomized experiment, so they are causal. */
export const COMPARISONS: readonly Comparison[] = [
  {
    id: "holdout-p_bad", metric: "p_bad", question: "Does router advice change how often a turn goes badly?",
    heldOutHigher: { claim: "Router advice lowers how often a turn goes badly; keep routing on and consider enforcing its advice", recommendation: "Keep the router on. Consider moving the advice that is followed least (agent, effort) toward enforcement, one decision point at a time, each behind its own holdout.", target_surface: "rule" },
    heldOutLower: { claim: "Router advice raises how often a turn goes badly; strip routing advice back toward vanilla", recommendation: "Turn the advice off for the decision points that differ most between arms, starting with the route line, and re-read the experiment after two weeks.", target_surface: "hook" },
  },
  {
    id: "holdout-cost", metric: "cost_usd", question: "Does router advice change what a turn costs in the main loop?",
    heldOutHigher: { claim: "Router advice lowers main-loop cost per turn; keep it", recommendation: "Keep the router on. The cost here is the main loop only, so check dispatched agent spend before reading this as a total saving.", target_surface: "rule" },
    heldOutLower: { claim: "Router advice raises main-loop cost per turn; check whether its outcome gain pays for it", recommendation: "Read holdout-p_bad beside this. If P(bad) shows no gain, cut the advice that drives the extra spend (effort raises first).", target_surface: "settings" },
  },
];

/** ISO-8601 week, e.g. 2026-W41. */
export function isoWeek(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y = t.getUTCFullYear();
  const week = Math.ceil(((t.getTime() - Date.UTC(y, 0, 1)) / 86_400_000 + 1) / 7);
  return `${y}-W${String(week).padStart(2, "0")}`;
}

export interface Evaluated { id: string; question: string; routed_n: number; held_out_n: number; held_out_minus_routed: number | null; ci95: [number, number] | null; excludes_zero: boolean; enough_turns: boolean; card: string | null; upgrade_id: string | null; created: boolean }
export interface RecommendResult { version: string; week: string; min_per_arm: number; dry_run: boolean; evaluated: Evaluated[]; qualifying: number; filed: number }

export function recommend(db: Database, opts: { dryRun?: boolean; now?: Date; add?: (u: UpgradeInput) => { created: boolean; id: string } } = {}): RecommendResult {
  const now = opts.now ?? new Date();
  const week = isoWeek(now);
  const add = opts.add ?? addUpgrade;
  const exp = experiment(db, {});
  const routed = exp.arms.find((a) => a.arm === "routed")!;
  const held = exp.arms.find((a) => a.arm === "held_out")!;
  const evaluated: Evaluated[] = [];
  for (const c of COMPARISONS) {
    const d = exp.differences.find((x) => x.metric === c.metric)!;
    const [rn, hn] = c.metric === "p_bad" ? [routed.labeled_turns, held.labeled_turns] : [routed.cost_turns, held.cost_turns];
    const enough = rn >= MIN_PER_ARM && hn >= MIN_PER_ARM;
    const e: Evaluated = { id: c.id, question: c.question, routed_n: rn, held_out_n: hn, held_out_minus_routed: d.held_out_minus_routed, ci95: d.ci95, excludes_zero: d.excludes_zero, enough_turns: enough, card: null, upgrade_id: null, created: false };
    if (enough && d.excludes_zero && d.held_out_minus_routed !== null && d.ci95) {
      const card = d.held_out_minus_routed > 0 ? c.heldOutHigher : c.heldOutLower;
      e.card = `[evidence ${c.id} ${week}] ${card.claim}`;
      if (!opts.dryRun) {
        const input: UpgradeInput = {
          claim: e.card, source: "evidence", recommendation: card.recommendation, target_surface: card.target_surface,
          current_state: `${c.question} Held-out minus routed ${c.metric} = ${d.held_out_minus_routed}, 95% CI [${d.ci95[0]}, ${d.ci95[1]}], routed n=${rn}, held-out n=${hn} (comparisons v${COMPARISONS_VERSION}, ${exp.source}).`,
          confidence: 0.95, evidence: [`bun LIFEOS/EVIDENCE/Project.ts query experiment --until ${now.toISOString().slice(0, 10)}`, `comparison:${c.id}@v${COMPARISONS_VERSION}`],
        };
        invariant(enough && d.excludes_zero && input.claim.includes(c.id) && input.claim.includes(week), `evidence card ${c.id} would file without a qualifying interval`);
        const r = add(input);
        e.upgrade_id = r.id || null;
        e.created = r.created;
      }
    }
    evaluated.push(e);
  }
  return { version: COMPARISONS_VERSION, week, min_per_arm: MIN_PER_ARM, dry_run: opts.dryRun === true, evaluated, qualifying: evaluated.filter((e) => e.card).length, filed: evaluated.filter((e) => e.created).length };
}

/** The weekly run: recommend, then one Vigil event with the count, quiet runs included. A failure still emits and exits 1. */
export function weekly(opts: { emit?: (e: Record<string, unknown>) => unknown; dryRun?: boolean; db?: string } = {}): { ok: boolean; error: string | null; result: RecommendResult | null; emitted: boolean } {
  const path = opts.db ?? join(getClaudeDir(), "LIFEOS/MEMORY/EVIDENCE/evidence.sqlite");
  let result: RecommendResult | null = null, error: string | null = null;
  try {
    const h = openDb(path, { readonly: true });
    try { result = recommend(h, { dryRun: opts.dryRun }); } finally { h.close(); }
  } catch (e) { error = e instanceof Error ? e.message.slice(0, 300) : String(e).slice(0, 300); }
  let emitted = false;
  if (opts.emit) {
    const now = new Date();
    const week = result?.week ?? isoWeek(now);
    const sent = opts.emit({
      id: crypto.randomUUID(), source: "evidence-weekly", ts: now.toISOString(), kind: "ai", severity: result ? (result.filed ? "low" : "info") : "medium",
      title: result ? `Evidence weekly: ${result.filed} recommendation card${result.filed === 1 ? "" : "s"} filed` : "Evidence weekly failed",
      summary: result ? result.evaluated.map((e) => `${e.id}: n ${e.routed_n}/${e.held_out_n}, diff ${e.held_out_minus_routed ?? "-"}${e.ci95 ? ` [${e.ci95[0]}, ${e.ci95[1]}]` : ""}${e.card ? (e.created ? " → filed" : " → already filed") : e.enough_turns ? " → no difference" : " → not enough turns"}`).join("; ") : `Error: ${error}`,
      ref: "LIFEOS/EVIDENCE/Recommend.ts", url: null, privacy_class: "personal", dedup_key: `evidence-weekly-${week}`,
      meta: { week, filed: result?.filed ?? 0, qualifying: result?.qualifying ?? 0, version: COMPARISONS_VERSION, ok: result !== null },
    });
    emitted = sent !== false;
  }
  return { ok: result !== null, error, result, emitted };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const emit = args.includes("--emit") ? ((e: Record<string, unknown>) => emitVigilEvent(e as never)) : undefined;
  const r = weekly({ emit, dryRun: args.includes("--dry-run") });
  const out = { ok: r.ok, error: r.error, filed: r.result?.filed ?? 0, qualifying: r.result?.qualifying ?? 0, week: r.result?.week ?? null, emitted: r.emitted, evaluated: r.result?.evaluated ?? [] };
  console.log(args.includes("--json") ? JSON.stringify(out) : out);
  process.exit(r.ok ? 0 : 1);
}
