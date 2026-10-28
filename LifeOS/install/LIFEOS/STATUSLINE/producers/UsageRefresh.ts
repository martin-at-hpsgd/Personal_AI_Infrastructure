import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { mtime, readJson } from "../Cache";
import { object, TTL, type State } from "../State";
import { parseIsoEpoch } from "../Time";
import { acquireOwnedLock, alive, anySessionActive, type RefreshJob } from "./Background";

export const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

export interface UsageDeps {
  fetchImpl: typeof fetch;
  /** The OAuth access token, or null when none is stored. Never logged, never written to a cache. */
  token: () => Promise<string | null>;
  /** Wall-clock seconds, for the backoff stamp (the bash read `date +%s` there, not the render clock). */
  realNow: () => number;
}

/** Whether any window in the cached payload has already reset. */
export function cacheResetCrossed(payload: unknown, now: number): boolean {
  const body = object(payload);
  const stamps: unknown[] = [object(body.five_hour).resets_at, object(body.seven_day).resets_at, object(body.seven_day_opus).resets_at, object(body.seven_day_sonnet).resets_at];
  if (Array.isArray(body.limits)) for (const limit of body.limits) stamps.push(object(limit).resets_at);
  return stamps.some((ts) => {
    if (typeof ts !== "string" || ts === "") return false;
    const epoch = parseIsoEpoch(ts);
    return epoch > 0 && epoch <= now;
  });
}

/** In-data fetched_at beats file mtime, so a touched or restored file cannot fake freshness. */
export function usageDataAge(cache: State["cache"], now: number): number {
  const path = cache.path("usage.json");
  if (cache.text("usage.json") === null) return 999999;
  const stamp = object(readJson(path)).fetched_at;
  if (typeof stamp === "number" && Number.isInteger(stamp) && stamp >= 0) return now - stamp;
  if (typeof stamp === "string" && /^\d+$/.test(stamp)) return now - Number(stamp);
  return now - mtime(path);
}

async function keychainToken(env: Record<string, string | undefined>, claude: string): Promise<string | null> {
  const read = async (args: string[]): Promise<string> => {
    const child = Bun.spawn(["/usr/bin/security", ...args], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const timer = setTimeout(() => child.kill(), 5000);
    try { return await new Response(child.stdout).text(); } finally { clearTimeout(timer); }
  };
  const tokenOf = (json: string): string => { try { const t = object(object(JSON.parse(json)).claudeAiOauth).accessToken; return typeof t === "string" ? t : ""; } catch { return ""; } };
  if (process.platform === "darwin") {
    // A legacy stub with empty tokens can sit beside the live item: ask for the user's item first.
    let token = tokenOf(await read(["find-generic-password", "-s", "Claude Code-credentials", "-a", env.USER ?? "", "-w"]));
    if (!token) token = tokenOf(await read(["find-generic-password", "-s", "Claude Code-credentials", "-w"]));
    return token || null;
  }
  const file = Bun.file(join(claude, ".credentials.json"));
  try { return tokenOf(await file.text()) || null; } catch { return null; }
}

const liveDeps = (state: State): UsageDeps => ({ fetchImpl: fetch, token: () => keychainToken(state.env, state.claude), realNow: () => Math.floor(Date.now() / 1000) });

/**
 * Decides, from the cache as it stands now, how old the last good fetch is and whether a fetch is due, and
 * returns that age. The scheduled refresher (Refresh.ts) runs the job; the statusline only reads usage.json.
 */
export function planUsageRefresh(state: State, deps: Partial<UsageDeps> = {}): { dataAge: number; ttl: number; job: RefreshJob | null } {
  const { cache, now } = state;
  const live = { ...liveDeps(state), ...deps };
  let dataAge = usageDataAge(cache, now);
  // One shared fetch serves every session, so the active TTL applies while any session on the machine is working.
  const busy = anySessionActive(state, TTL.usageBusyWindow);
  const ttl = busy ? TTL.usageActive : TTL.usage;
  let originalAge: number | null = null;
  // A young cache with a crossed reset forces one refetch attempt a minute (the endpoint 429s aggressively).
  if (dataAge <= ttl && cacheResetCrossed(readJson(cache.path("usage.json")), now)) {
    if (now - mtime(cache.path("usage.json.resetprobe")) > 60) {
      cache.put("usage.json.resetprobe", "");
      originalAge = dataAge;
      dataAge = ttl + 1;
    }
  }
  const backoffText = (cache.text("usage.json.backoff") ?? "").split("\n")[0]?.trim() ?? "";
  const backoffUntil = /^\d+$/.test(backoffText) ? Number(backoffText) : 0;
  let job: RefreshJob | null = null;
  if (dataAge > ttl && now >= backoffUntil) {
    job = {
      name: "usage",
      async run() {
        // Reap only a lock whose owner is dead: a slow but live winner is never taken over.
        const lock = acquireOwnedLock(cache, "usage.lock", (owner, age) => age > 15 && !alive(owner));
        if (!lock) return;
        try {
          if (state.env.LIFEOS_USAGE_FETCH_TRACE) appendFileSync(state.env.LIFEOS_USAGE_FETCH_TRACE, `claude ttl=${ttl}\n`);
          const token = await live.token();
          if (!token) return;
          const response = await live.fetchImpl(USAGE_URL, {
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "anthropic-beta": "oauth-2025-04-20" },
            signal: AbortSignal.timeout(3000),
          });
          if (response.status === 429) {
            const after = response.headers.get("retry-after") ?? "";
            cache.put("usage.json.backoff", `${live.realNow() + (/^\d+$/.test(after) ? Number(after) : 300)}\n`);
          }
          let body: unknown = null;
          try { body = await response.json(); } catch { /* HTML or truncated: fail closed */ }
          const five = object(body).five_hour;
          // Install only a real payload with a five_hour field: last-known-good is never overwritten with garbage.
          if (five !== undefined && five !== null && five !== false) cache.put("usage.json", `${JSON.stringify({ ...object(body), fetched_at: now }, null, 2)}\n`);
        } finally { lock.release(); }
      },
    };
  }
  // A failed forced attempt restores the true data age; a success lands on the next tick.
  if (originalAge !== null && dataAge !== 0) dataAge = originalAge;
  return { dataAge, ttl, job };
}
