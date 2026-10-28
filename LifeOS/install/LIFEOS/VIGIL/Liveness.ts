/**
 * Send-time liveness hooks, by source (migration design §1.3, Lane D).
 *
 * Just before a queued text is sent the tick asks the source whether its intent is still live
 * (`holdSuperseded` in Tick.ts). That used to load the source's adapter by path; the adapters move
 * to STATVS, so Vigil keeps its own small map instead. A source with no entry has no hook and its
 * texts always send. Today only Achilles withdraws texts.
 * @version 1.0.0
 */
import type { VigilEvent } from "./Schema";

export type LivenessHook = { stillLive?: (event: VigilEvent) => boolean };

const HOOKS: Readonly<Record<string, () => Promise<LivenessHook>>> = {
  achilles: () => import("../TOOLS/AchillesLiveness"),
};

/** Sources that carry a liveness hook. */
export const LIVENESS_SOURCES: readonly string[] = Object.keys(HOOKS);

export const hasLiveness = (source: string): boolean => Object.hasOwn(HOOKS, source);

/** The hook module for a source; a source with none resolves to an empty hook (always live). */
export function loadLiveness(source: string): Promise<LivenessHook> {
  return hasLiveness(source) ? HOOKS[source]!() : Promise.resolve({});
}
