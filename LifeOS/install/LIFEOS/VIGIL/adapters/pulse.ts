/** Pulse cron jobs that latch failing and recover, read from Pulse's own state.json. @version 0.1.0 */
import { lifeosPath } from "../../TOOLS/Paths";
import { join } from "node:path"; import type { VigilEvent } from "../../STATVS/lib/refuse"; import { clock, event, jsonFile, need, withCursor } from "./common";
/** Pulse stops retrying a job at this many consecutive failures and its /healthz turns degraded (pulse.ts MAX_FAILURES); a single failure is routine and stays silent. */
export const LATCH = 3;
export type Snapshot = Record<string, { failures: number; at: string }>;
export function diff(prev: Snapshot | undefined, next: Snapshot): VigilEvent[] {
  if (!prev) return [];
  return Object.entries(next).flatMap(([name, row]) => {
    const was = prev[name]?.failures ?? 0, look = "Look: LIFEOS/PULSE/state/state.json and the Pulse daemon log";
    if (was < LATCH && row.failures >= LATCH) return [event("pulse", name, "latched", "medium", `Pulse job ${name} has failed ${row.failures} times in a row`, `Pulse cron job ${name} failed ${row.failures} consecutive runs, the last at ${clock(row.at)}, so Pulse now retries it only every six hours and reports degraded. ${look}.`, "infra", null, row.at)];
    if (was >= LATCH && row.failures === 0) return [event("pulse", name, "recovered", "info", `Pulse job ${name} recovered`, `Pulse cron job ${name} ran cleanly at ${clock(row.at)} after ${was} consecutive failures. ${look}.`, "infra", null, row.at)];
    return [];
  });
}
/** Only jobs Pulse has enabled: a retired job keeps its last failure count in state.json forever and must not read as failing. */
export async function live(path = lifeosPath("PULSE", "state", "state.json")): Promise<Snapshot> {
  const s = jsonFile<{ jobs?: Record<string, { lastRun?: number; consecutiveFailures?: number }>; enabledJobs?: string[] }>(path);
  need(s.jobs && typeof s.jobs === "object" && Array.isArray(s.enabledJobs), "pulse state jobs and enabledJobs");
  const rows = s.enabledJobs.flatMap((name) => { const j = s.jobs![name]; return j ? [[name, j] as const] : []; });
  need(rows.every(([, j]) => typeof j.lastRun === "number" && typeof j.consecutiveFailures === "number"), "pulse job lastRun and consecutiveFailures");
  return Object.fromEntries(rows.map(([name, j]) => [name, { failures: j.consecutiveFailures!, at: new Date(j.lastRun!).toISOString() }]));
}
export const read = () => withCursor("pulse", () => live(), diff);
