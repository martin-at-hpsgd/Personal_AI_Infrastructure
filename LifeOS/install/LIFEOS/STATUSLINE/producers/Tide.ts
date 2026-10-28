import { mtime, type Cache } from "../Cache";
import { TTL } from "../State";
import { acquireLock, type RefreshJob } from "./Background";

export interface TideDeps { line: () => Promise<string> }

/** The cached tide line, or empty. Trailing newlines drop, as $(cat) does. */
export function tideView(cache: Cache): string {
  return (cache.text("tide-line.txt") ?? "").replace(/\n+$/, "");
}

/** Refresh past 300 s behind a 30-second lock, and at once when the place moved (the location cache is newer), so a new
 * place never shows the old place's tide or the old place's empty line. An empty answer is cached too, so a tideless place is not re-probed every render. */
export function tideRefresh(cache: Cache, deps: TideDeps = { line: async () => (await import("../../TOOLS/Tide")).tideLine() }): RefreshJob | null {
  const moved = mtime(cache.path("location-cache.json")) > mtime(cache.path("tide-line.txt"));
  if (cache.age("tide-line.txt") <= TTL.tide && !moved) return null;
  return {
    name: "tide",
    async run() {
      const lock = acquireLock(cache, "tide-refresh.lock", 30);
      if (!lock) return;
      try { cache.put("tide-line.txt", (await deps.line()).replace(/\n+$/, "")); }
      finally { lock.release(); }
    },
  };
}
