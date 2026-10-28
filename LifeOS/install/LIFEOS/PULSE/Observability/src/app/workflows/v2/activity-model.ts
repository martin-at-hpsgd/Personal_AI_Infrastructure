/**
 * Activity tab logic with no React in it: what outcome a run row reads as,
 * the status and trigger-kind filters, and the search over runs (ISC-104).
 * Tested in activity-model.test.ts.
 */

import type { ActivityRow } from "./api";

/** The outcomes the status filter offers, in the ISA's words (ISC-104), plus the two a source can also report. */
export type Outcome = "succeeded" | "failed" | "stopped" | "timed_out" | "abandoned" | "running" | "unknown";
export const OUTCOMES: readonly Outcome[] = ["succeeded", "failed", "stopped", "timed_out", "abandoned", "running", "unknown"];
/** Always offered, even at zero, so the filter reads the same every day. */
export const CORE_OUTCOMES: readonly Outcome[] = ["succeeded", "failed", "stopped", "timed_out", "abandoned"];

export const OUTCOME_LABEL: Record<Outcome, string> = {
  succeeded: "Succeeded",
  failed: "Failed",
  stopped: "Stopped",
  timed_out: "Timed out",
  abandoned: "Abandoned",
  running: "Running",
  unknown: "Unknown",
};

/**
 * One row's outcome. A failed run with a timed-out step is `timed_out`; a run
 * with a start and no end (or a ledger `abandoned`) is `abandoned`; a trigger
 * that was skipped because the previous run held the lock is `stopped`.
 */
export function outcomeOf(r: Pick<ActivityRow, "status" | "timedOut">): Outcome {
  switch (r.status) {
    case "ok": return "succeeded";
    case "error": return r.timedOut ? "timed_out" : "failed";
    case "incomplete": return "abandoned";
    case "skipped": return "stopped";
    case "running": return "running";
    default: return "unknown";
  }
}

/** Trigger kinds read in plain words; an unknown kind is shown as itself. */
const capitalized = (k: string): string => k.charAt(0).toUpperCase() + k.slice(1);
export const TRIGGER_LABEL: Record<string, string> = {
  // Kinds whose label is the kind itself with a capital.
  ...Object.fromEntries(["schedule", "interval", "manual", "daemon", "webhook", "event"].map((k) => [k, capitalized(k)])),
  once: "One-off",
  after: "After a workflow",
  "on-demand": "On demand",
};
export const triggerLabel = (k: string | null | undefined): string => (k ? TRIGGER_LABEL[k] ?? k : "Unknown trigger");
export const NO_TRIGGER = "unknown";
export const triggerKey = (r: Pick<ActivityRow, "trigger">): string => r.trigger || NO_TRIGGER;

export interface ActivityFilter {
  q: string;
  /** Empty set means every outcome. */
  outcomes: ReadonlySet<Outcome>;
  /** Null means every trigger kind. */
  trigger: string | null;
}

/** The text a run is searched by: its workflow, run id, outcome, trigger, step ids and error text. */
export function runText(r: ActivityRow, title: string | undefined): string {
  return [
    title ?? "",
    r.recordId,
    r.runId ?? "",
    OUTCOME_LABEL[outcomeOf(r)],
    triggerLabel(r.trigger),
    r.trigger ?? "",
    r.detail ?? "",
    ...(r.steps ?? []).flatMap((s) => [s.id, s.error ?? ""]),
  ].join("\n").toLowerCase();
}

/** Every whitespace-separated term must appear somewhere in the run's text. */
export function matchesRun(r: ActivityRow, title: string | undefined, q: string): boolean {
  const terms = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const hay = runText(r, title);
  return terms.every((t) => hay.includes(t));
}

export function filterRuns(rows: readonly ActivityRow[], titleOf: (id: string) => string | undefined, f: ActivityFilter): ActivityRow[] {
  return rows.filter(
    (r) =>
      (f.outcomes.size === 0 || f.outcomes.has(outcomeOf(r))) &&
      (f.trigger === null || triggerKey(r) === f.trigger) &&
      matchesRun(r, titleOf(r.recordId), f.q),
  );
}

/** Counts per outcome and per trigger kind, each computed with the OTHER filters applied, so a chip's number is what clicking it shows. */
export function facetCounts(rows: readonly ActivityRow[], titleOf: (id: string) => string | undefined, f: ActivityFilter): { outcomes: Map<Outcome, number>; triggers: Map<string, number> } {
  const outcomes = new Map<Outcome, number>();
  const triggers = new Map<string, number>();
  for (const r of rows) {
    if (!matchesRun(r, titleOf(r.recordId), f.q)) continue;
    const o = outcomeOf(r);
    const t = triggerKey(r);
    if (f.trigger === null || t === f.trigger) outcomes.set(o, (outcomes.get(o) ?? 0) + 1);
    if (f.outcomes.size === 0 || f.outcomes.has(o)) triggers.set(t, (triggers.get(t) ?? 0) + 1);
  }
  return { outcomes, triggers };
}

export const parseOutcomes = (s: string | null): Set<Outcome> =>
  new Set((s ?? "").split(",").filter((x): x is Outcome => (OUTCOMES as readonly string[]).includes(x)));
