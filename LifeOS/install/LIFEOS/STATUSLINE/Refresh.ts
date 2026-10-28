#!/usr/bin/env bun
/**
 * The statusline's one refresher, run every minute by the `statusline-refresh` workflow. It plans every shared refresh
 * from the caches as they stand (tide, cosmos, location and weather, Claude usage, Codex usage,
 * the Claude Code version, and the herdr sidebar report for every pane the render saw), runs the stale ones under one deadline that fits inside the minute, prints a JSON report for
 * the workflow ledger, and exits. The statusline itself only reads these caches.
 *
 * TTLs, locks, cache names and atomic writes are the producers' own, unchanged from the bash. A signal releases every lock
 * this process holds before it exits, so a cancelled run never blocks the next one. An InvariantViolation fails the run.
 */
import { buildState, type State } from "./State";
import { releaseHeldLocks, runRefreshes, type RefreshJob, type RefreshReport } from "./producers/Background";
import { tideRefresh } from "./producers/Tide";
import { cosmosRefresh } from "./producers/Cosmos";
import { locationWeatherRefresh, type LocationWeatherDeps } from "./producers/LocationWeather";
import { planUsageRefresh } from "./producers/UsageRefresh";
import { codexRefresh } from "./producers/CodexRefresh";
import { harnessVersionRefresh } from "./producers/Versions";
import { herdrRefresh, herdrWaitRefresh } from "./producers/Herdr";
import { workQueueRefreshFor } from "./producers/WorkQueue";
import { fastProofRefresh } from "./producers/FastProof";

/** Every job is awaited at most this long, leaving room inside the minute for start-up and the next tick. */
export const REFRESH_DEADLINE_MS = 45_000;

/** Test seams for the jobs that reach the network; production passes none. */
export interface PlanDeps { locationWeather?: Partial<LocationWeatherDeps> }

/** Every stale shared cache's refresh job, planned from the caches as they stand now. */
export function planRefreshes(state: State, deps: PlanDeps = {}): RefreshJob[] {
  const { cache } = state;
  const jobs: Array<RefreshJob | null> = [
    tideRefresh(cache),
    cosmosRefresh(cache),
    locationWeatherRefresh(state, deps.locationWeather),
    planUsageRefresh(state).job,
    codexRefresh(state),
    harnessVersionRefresh(cache),
    herdrRefresh(cache, state.home),
    herdrWaitRefresh(state.root),
    workQueueRefreshFor(state),
    fastProofRefresh(cache),
  ];
  return jobs.filter((job): job is RefreshJob => job !== null);
}

export interface RefreshRun extends RefreshReport { planned: string[]; skipped?: string }

/** Plan and run once. `env` and `nowMs` are injectable so tests run against a temp tree. */
export async function refreshOnce(env: Record<string, string | undefined>, nowMs = Date.now(), deadlineMs = REFRESH_DEADLINE_MS): Promise<RefreshRun> {
  // A fixed width keeps buildState from probing the terminal: this process has none.
  const state = buildState("{}", { ...env, COLUMNS: "80" }, nowMs);
  if (state.failClosed) return { planned: [], ran: [], timedOut: [], failed: [], skipped: "install root is not absolute" };
  state.cache.initialize();
  // The Location system's zone governs local-time helpers, as it did in the render.
  if (state.timezoneOverride) process.env.TZ = state.timezone;
  const jobs = planRefreshes(state);
  const report = await runRefreshes(jobs, deadlineMs);
  return { planned: jobs.map((job) => job.name), ...report };
}

if (import.meta.main) {
  const stop = (code: number) => (): void => { releaseHeldLocks(); process.exit(code); };
  process.on("SIGTERM", stop(143));
  process.on("SIGHUP", stop(129));
  process.on("SIGINT", stop(130));
  const run = await refreshOnce(process.env);
  process.stdout.write(`${JSON.stringify(run)}\n`);
  // Jobs past the deadline still hold the event loop; their locks were left for the age rule to throttle.
  process.exit(0);
}
