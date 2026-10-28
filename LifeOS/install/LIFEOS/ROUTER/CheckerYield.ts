/**
 * CheckerYield.ts — does a separate checker agent ever catch anything?
 *
 * Development runs a checker only when a trigger fires (skills/Development/SKILL.md
 * § Execution, principal 2026-10-10). The main session logs each checker's result here,
 * and `Router.ts audit` reports the yield per trigger, so a trigger that keeps
 * coming back clean can be dropped on evidence instead of opinion.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { invariant } from "../TOOLS/Invariant";
import { lifeosPath } from "../TOOLS/Paths";

export const TRIGGERS = ["judged", "high-risk-path", "no-review", "fix-round", "manual"] as const;
export type Trigger = (typeof TRIGGERS)[number];
export type CheckerRow = { ts: string; trigger: Trigger; result: "found" | "clean"; run?: string };
export type TriggerYield = { trigger: Trigger; runs: number; found: number; dropCandidate: boolean };

/** Runs with no catch before a trigger is flagged as a drop candidate. */
export const DROP_AFTER = 20;

export function yieldLogPath(env: Record<string, string | undefined> = process.env): string {
  return env.LIFEOS_ROUTER_CHECKER_LOG || lifeosPath("MEMORY", "OBSERVABILITY", "checker-yield.jsonl");
}

export function appendChecker(row: CheckerRow, path = yieldLogPath()): void {
  invariant((TRIGGERS as readonly string[]).includes(row.trigger), `checker trigger must be one of ${TRIGGERS.join(", ")}`);
  invariant(row.result === "found" || row.result === "clean", "checker result must be found or clean");
  invariant(Number.isFinite(Date.parse(row.ts)), "checker row needs an ISO timestamp");
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(row) + "\n");
}

export function readChecker(path = yieldLogPath()): CheckerRow[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).flatMap((l) => {
    try { return [JSON.parse(l) as CheckerRow]; } catch { return []; }
  });
}

export function yieldByTrigger(rows: CheckerRow[]): TriggerYield[] {
  return TRIGGERS.map((trigger) => {
    const mine = rows.filter((r) => r.trigger === trigger);
    const found = mine.filter((r) => r.result === "found").length;
    return { trigger, runs: mine.length, found, dropCandidate: mine.length >= DROP_AFTER && found === 0 };
  }).filter((y) => y.runs > 0);
}

export function formatYield(ys: TriggerYield[]): string {
  if (!ys.length) return "Checker yield: no checker runs logged yet.";
  return ["Checker yield (separate checker agents, by trigger):",
    ...ys.map((y) => `  ${y.trigger}: ${y.found}/${y.runs} found something${y.dropCandidate ? ` — drop candidate (${DROP_AFTER}+ runs, nothing caught)` : ""}`)].join("\n");
}
