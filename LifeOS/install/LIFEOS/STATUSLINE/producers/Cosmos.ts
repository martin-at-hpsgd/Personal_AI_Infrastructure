import type { Cache } from "../Cache";
import { TTL } from "../State";
import { acquireLock, type RefreshJob } from "./Background";

export interface CosmosDeps { lines: () => Promise<string> }

/** Refresh past 300 s behind a 30-second lock. Empty means unconfigured or unreachable; it is cached so the line hides and the next probe waits a full TTL. */
export function cosmosRefresh(cache: Cache, deps: CosmosDeps = { lines: async () => (await import("../../TOOLS/Cosmos")).cosmosOutput() }): RefreshJob | null {
  if (cache.age("cosmos-line.txt") <= TTL.cosmos) return null;
  return {
    name: "cosmos",
    async run() {
      const lock = acquireLock(cache, "cosmos-refresh.lock", 30);
      if (!lock) return;
      try { cache.put("cosmos-line.txt", (await deps.lines()).replace(/\n+$/, "")); }
      finally { lock.release(); }
    },
  };
}
