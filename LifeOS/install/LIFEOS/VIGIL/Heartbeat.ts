/** Vigil tick freshness probe. @version 0.2.0 */
import { join } from "node:path";
import { readJson } from "./State";

export function heartbeatStale(now: Date, stateDir: string): boolean {
  const tick = readJson<{ ts?: string } | null>(join(stateDir, "last-tick.json"), null);
  return !tick?.ts || !Number.isFinite(Date.parse(tick.ts)) || now.getTime() - Date.parse(tick.ts) > 10 * 60_000;
}
