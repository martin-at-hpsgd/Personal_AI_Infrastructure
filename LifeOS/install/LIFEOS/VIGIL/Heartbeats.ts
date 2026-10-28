/** Vigil heartbeat report: the tick's own freshness plus every heartbeat a subsystem writes under `heartbeats/`. Read-only, additive (Workflows ISC-122). @version 0.1.0 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readJson } from "./State";

export type HeartbeatEntry = { source: string; ts: string | null; interval_seconds: number | null; age_seconds: number | null; stale: boolean };

/** The Workflows dispatcher ticks every minute; it is reported even before its first beat so an absent one shows as stale, not missing. */
export const EXPECTED_SOURCES = ["workflows-dispatcher"] as const;
/** A heartbeat older than this many of its own intervals (never under five minutes) is stale. */
const STALE_INTERVALS = 5, STALE_FLOOR_MS = 5 * 60_000, TICK_STALE_MS = 10 * 60_000;
/** ISC-159: a beat whose interval is over four hours is stale after 26 hours, so a daily watch that died is noticed the same day instead of after five days. */
const LONG_INTERVAL_S = 4 * 3600, LONG_STALE_MS = 26 * 3_600_000;
const staleMsOf = (interval: number | null): number => {
  const byIntervals = Math.max(STALE_FLOOR_MS, STALE_INTERVALS * (interval ?? 0) * 1000);
  return interval !== null && interval > LONG_INTERVAL_S ? Math.min(byIntervals, LONG_STALE_MS) : byIntervals;
};

const entryOf = (source: string, ts: unknown, interval: unknown, staleMs: number, now: Date): HeartbeatEntry => {
  const at = typeof ts === "string" ? Date.parse(ts) : Number.NaN;
  if (!Number.isFinite(at)) return { source, ts: null, interval_seconds: typeof interval === "number" ? interval : null, age_seconds: null, stale: true };
  const age = now.getTime() - at;
  return { source, ts: new Date(at).toISOString(), interval_seconds: typeof interval === "number" ? interval : null, age_seconds: Math.round(age / 1000), stale: age > staleMs };
};

/** Every heartbeat as one array: `vigil-tick` first (last-tick.json, stale past 10 minutes), then each `heartbeats/<source>.json`, sorted by source. */
export function heartbeatReport(now: Date, stateDir: string): HeartbeatEntry[] {
  const tick = readJson<{ ts?: string } | null>(join(stateDir, "last-tick.json"), null);
  const out: HeartbeatEntry[] = [entryOf("vigil-tick", tick?.ts, null, TICK_STALE_MS, now)];
  const dir = join(stateDir, "heartbeats");
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)) : [];
  for (const source of [...new Set([...EXPECTED_SOURCES, ...files])].sort()) {
    const file = readJson<{ ts?: string; interval_seconds?: number } | null>(join(dir, `${source}.json`), null);
    const interval = typeof file?.interval_seconds === "number" ? file.interval_seconds : null;
    out.push(entryOf(source, file?.ts, interval, staleMsOf(interval), now));
  }
  return out;
}
