/** Workflows run ledger: one event per typed-workflow run batch, so `Vigil.ts list --source workflows` shows runs. Reads the ledger's evidence index (one scan of appended bytes), never the whole file. @version 0.1.0 */
import type { VigilEvent } from "../../STATVS/lib/refuse"; import { clock, event, withCursor } from "./common";
import { ledgerEvidence, type RunStatus } from "../../WORKFLOWS/engine/ledger"; import { ledgerPath } from "../../WORKFLOWS/engine/paths";
export type Snapshot = Record<string, { status: RunStatus; at: string; runs: number }>;
const look = "Look: bun LIFEOS/WORKFLOWS/workflow.ts runs";
/** A workflow with more runs than the cursor remembers gets one event for the newest run; how many runs it covers is in the summary. A failed or abandoned last run is medium, a success is info (list only). */
export function diff(prev: Snapshot | undefined, next: Snapshot): VigilEvent[] {
  if (!prev) return [];
  return Object.entries(next).flatMap(([name, row]) => {
    const was = prev[name], added = row.runs - (was?.runs ?? 0);
    if (added <= 0) return [];
    const bad = row.status !== "succeeded", occurrence = `${row.runs}:${row.at}`;
    const batch = added === 1 ? "1 new run" : `${added} new runs`;
    const detail = `${batch} since the last read; ${row.runs} in the ledger. Newest finished ${clock(row.at)} with status ${row.status}${was ? `; the run before it was ${was.status}` : "; first run on record"}. ${look} ${name}`;
    return [event("workflows", name, bad ? row.status : "succeeded", bad ? "medium" : "info", bad ? `${name} run ${row.status}` : `${name} ran`, detail, "infra", null, occurrence)];
  });
}
export async function live(): Promise<Snapshot> {
  const { by } = ledgerEvidence(ledgerPath());
  return Object.fromEntries([...by].map(([name, e]) => [name, { status: e.last_status, at: e.last_finished_at, runs: e.runs }]));
}
export const read = () => withCursor("workflows", live, diff);
