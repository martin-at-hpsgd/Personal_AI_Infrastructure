/**
 * The pending-approval queue (ISC-129, the read half). One row per human step
 * a parked run is still waiting on, oldest first, for Pulse to list with its
 * approve and decline controls. `pendingApprovals` is pure: it takes the
 * parked runs and an "is this step answered" predicate and never touches disk.
 * `readPendingApprovals` is the thin disk reader around it.
 */
import { listWaiting, readAnswer, type WaitingRun } from "./human.ts";
import { ledgerPath } from "./paths.ts";

export interface PendingApproval {
  run_id: string;
  workflow: string;
  step_id: string;
  prompt: string;
  parked_at: string;
}

/**
 * Lists every unanswered human step across the parked runs, oldest park first
 * (ties by run id, then step id, so the order is stable). A parked file is
 * external data: an entry missing its run id, workflow, waiting list or park
 * time is skipped rather than shown half-formed.
 */
export function pendingApprovals(runs: readonly WaitingRun[], answered: (runId: string, stepId: string) => boolean = () => false): PendingApproval[] {
  const rows: PendingApproval[] = [];
  for (const run of runs) {
    if (!run || typeof run.run_id !== "string" || typeof run.workflow !== "string" || !Array.isArray(run.waiting_on)) continue;
    if (typeof run.parked_at !== "string" || Number.isNaN(Date.parse(run.parked_at))) continue;
    const prompts = run.prompts && typeof run.prompts === "object" ? run.prompts : {};
    for (const step of run.waiting_on) {
      if (typeof step !== "string" || answered(run.run_id, step)) continue;
      const prompt = prompts[step];
      rows.push({ run_id: run.run_id, workflow: run.workflow, step_id: step, prompt: typeof prompt === "string" ? prompt : "", parked_at: run.parked_at });
    }
  }
  return rows.sort((a, b) => Date.parse(a.parked_at) - Date.parse(b.parked_at) || a.run_id.localeCompare(b.run_id) || a.step_id.localeCompare(b.step_id));
}

/** The queue as it stands on disk beside `ledger`. */
export function readPendingApprovals(ledger: string = ledgerPath()): PendingApproval[] {
  return pendingApprovals(listWaiting(ledger), (runId, stepId) => readAnswer(ledger, runId, stepId) !== null);
}
