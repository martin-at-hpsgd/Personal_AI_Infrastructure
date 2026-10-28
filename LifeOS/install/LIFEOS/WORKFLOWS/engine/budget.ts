/**
 * Monthly spend ceiling (ISC-145). A workflow's month-to-date spend is the sum
 * of the estimated step costs its ledger lines carry for the current UTC
 * month. A run that would start after that sum reaches `budget_usd_month` is
 * refused before it claims anything, and the refusal is recorded as one line
 * in `refusals.jsonl` beside the ledger.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { invariant } from "../../TOOLS/Invariant.ts";
import { readLedger } from "./ledger.ts";
import type { StepCost } from "./steps/types.ts";

export const refusalsPath = (ledger: string): string => join(dirname(ledger), "refusals.jsonl");

const monthOf = (iso: string): string => iso.slice(0, 7);

const dollars = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);

/**
 * Model dollars one ledger line carries, summed per step (ISC-128). The step's own `cost_usd` is the truth; a legacy
 * top-level `step_costs[id]` is read only for a step that has no cost field of its own, so a line carrying both is never
 * double counted. Null when the line carries no cost at all.
 */
export function stepCostsUsd(line: unknown): number | null {
  const record = line as { steps?: Record<string, { cost_usd?: unknown }>; step_costs?: Record<string, Pick<StepCost, "cost_usd">> };
  const steps = record.steps && typeof record.steps === "object" ? record.steps : {};
  const legacy = record.step_costs && typeof record.step_costs === "object" ? record.step_costs : {};
  let total: number | null = null;
  for (const id of new Set([...Object.keys(steps), ...Object.keys(legacy)])) {
    const value = dollars(steps[id]?.cost_usd) ?? dollars(legacy[id]?.cost_usd);
    if (value !== null) total = (total ?? 0) + value;
  }
  return total;
}

/** Dollars recorded for `workflow` in the UTC month containing `now`. */
export function monthSpend(ledger: string, workflow: string, now: Date): number {
  const month = monthOf(now.toISOString());
  let total = 0;
  for (const record of readLedger(ledger).records) {
    if (record.workflow !== workflow || typeof record.started_at !== "string" || monthOf(record.started_at) !== month) continue;
    total += stepCostsUsd(record) ?? 0;
  }
  return total;
}

export interface BudgetVerdict {
  allowed: boolean;
  spent: number;
  budget: number | null;
}

export function checkBudget(ledger: string, workflow: string, budget: number | undefined, now: Date): BudgetVerdict {
  if (budget === undefined) return { allowed: true, spent: 0, budget: null };
  const spent = monthSpend(ledger, workflow, now);
  return { allowed: spent < budget, spent, budget };
}

export function recordRefusal(ledger: string, line: { workflow: string; occurrence_key: string; reason: string; spent: number; budget: number; at: string }): void {
  invariant(line.workflow.length > 0 && line.reason.length > 0, "A refusal needs a workflow and a reason");
  const path = refusalsPath(ledger);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify({ kind: "budget", ...line })}\n`);
}
