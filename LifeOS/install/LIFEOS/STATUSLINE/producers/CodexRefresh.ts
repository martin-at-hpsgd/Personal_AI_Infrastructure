import { appendFileSync, utimesSync, writeFileSync } from "node:fs";
import { mtime, readJson } from "../Cache";
import { object, TTL, type State } from "../State";
import { acquireOwnedLockAt, alive, type RefreshJob } from "./Background";

export interface CodexDeps {
  /** CodexUsage.refresh against the given cache path. */
  refresh: (path: string) => Promise<unknown>;
  /** Whether a codex process is running now (pgrep -x codex). */
  codexRunning: () => boolean;
}

const livePgrep = (): boolean => {
  try { return Bun.spawnSync(["/usr/bin/pgrep", "-x", "codex"], { stdout: "ignore", stderr: "ignore", stdin: "ignore", timeout: 2000 }).exitCode === 0; } catch { return false; }
};

/** Where the Codex plan windows are cached; LIFEOS_CODEX_USAGE_CACHE moves it, and the lock, busy and failed stamps sit beside it. */
export function codexCachePath(state: Pick<State, "cache" | "env">): string {
  return state.env.LIFEOS_CODEX_USAGE_CACHE || state.cache.path("codex-usage.json");
}

/**
 * Two ages: fetched_at is the observation and drives display freshness; attempted_at is the last refresh
 * attempt and drives the spawn throttle, so an API outage served from an old rollout does not refetch every tick.
 */
export function codexRefresh(state: State, deps: Partial<CodexDeps> = {}): RefreshJob | null {
  const { now } = state;
  const path = codexCachePath(state);
  const hard = TTL.usageHardExpiry;
  let attemptAge = hard;
  if (mtime(path) > 0) {
    const body = object(readJson(path));
    const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : 0);
    const fetched = num(body.fetched_at);
    const attempted = typeof body.attempted_at === "number" ? num(body.attempted_at) : fetched;
    if (attempted > 0) attemptAge = Math.max(0, now - attempted);
  }
  // A running codex process stamps a marker; for the afterglow after it the TTL drops to the active one.
  let ttl = TTL.codex;
  if (attemptAge >= TTL.codexActive) {
    const busy = path.replace(/\.json$/, ".busy");
    if ((deps.codexRunning ?? livePgrep)()) { try { writeFileSync(busy, "", { flag: "a" }); utimesSync(busy, now, now); } catch { /* the marker is advisory */ } }
    if (mtime(busy) > 0 && now - mtime(busy) <= TTL.codexAfterglow) ttl = TTL.codexActive;
  }
  // The failure stamp keeps a dead endpoint to one attempt per TTL.
  const failed = `${path}.failed`;
  if (mtime(failed) > 0 && now - mtime(failed) < ttl) return null;
  if (attemptAge < ttl) return null;
  return {
    name: "codex",
    async run() {
      // Reaped when the owner is gone or the lock is over two minutes old.
      const lock = acquireOwnedLockAt(path.replace(/\.json$/, ".lock"), now, (owner, age) => owner === null || !alive(owner) || age > 120);
      if (!lock) return;
      try {
        if (state.env.LIFEOS_USAGE_FETCH_TRACE) appendFileSync(state.env.LIFEOS_USAGE_FETCH_TRACE, `codex ttl=${ttl}\n`);
        await (deps.refresh ?? (async (target: string) => (await import("../../TOOLS/CodexUsage")).refresh({ path: target })))(path);
      } finally { lock.release(); }
    },
  };
}

