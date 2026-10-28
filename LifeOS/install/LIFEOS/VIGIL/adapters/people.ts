/** People source sync failures, human-grant blocks and recoveries. @version 0.3.0 */
import { lifeosPath } from "../../TOOLS/Paths";
import { readFileSync } from "node:fs"; import { join } from "node:path"; import type { VigilEvent } from "../../STATVS/lib/refuse"; import { clip, clock, event, need, withCursor } from "./common";
export type Snapshot = { at: string; sources: Record<string, string>; errors?: Record<string, string> };
/** A source is down when the tick marks it `failed` (a code or remote fault) or `blocked` (it waits on a human grant, e.g. macOS Contacts access). People ISC-47: both reach Vigil. */
const DOWN = new Set(["failed", "blocked"]);
const UNRECORDED = "not recorded in LIFEOS/USER/CONTACTS/runs.jsonl";
export function diff(prev: Snapshot | undefined, next: Snapshot): VigilEvent[] {
  if (!prev) return [];
  return Object.entries(next.sources).flatMap(([src, status]) => {
    const was = prev.sources[src];
    if (was === "ok" && DOWN.has(status)) {
      const detail = next.errors?.[src] ? `error: ${clip(next.errors[src]!)}` : `error ${UNRECORDED}`;
      const title = status === "blocked" ? `People sync: ${src} source blocked, needs a human grant` : `People sync: ${src} source failing`;
      return [event("people", src, status, "medium", title, `${src} source ${status} at ${clock(next.at)}; ${detail}.`, "infra", null, next.at)];
    }
    if (was !== undefined && DOWN.has(was) && status === "ok") return [event("people", src, "ok", "info", `People sync: ${src} source recovered`, `${src} source recovered at ${clock(next.at)} after being ${was}; prior error: ${prev.errors?.[src] ? clip(prev.errors[src]!) : UNRECORDED}.`, "infra", null, next.at)];
    return [];
  });
}
/** The tick (LIFEOS/PEOPLE/tick.ts) writes the reason as `note`; older lines used `error`. A note on an `ok` source is a count, not an error, so only down sources carry one. */
export async function live(): Promise<Snapshot> { const path = lifeosPath("USER", "CONTACTS", "runs.jsonl"); const lines = readFileSync(path, "utf8").trim().split("\n"); need(lines[0], "people run line"); const s = JSON.parse(lines.at(-1)!) as { at?: string; sources?: Record<string, { status?: string; error?: string; note?: string }> }; need(typeof s.at === "string" && s.sources && typeof s.sources === "object" && Object.values(s.sources).every((v) => typeof v.status === "string"), "people run fields"); return { at: s.at, sources: Object.fromEntries(Object.entries(s.sources).map(([k, v]) => [k, v.status!])), errors: Object.fromEntries(Object.entries(s.sources).flatMap(([k, v]) => { const why = v.error ?? (v.status !== "ok" ? v.note : undefined); return typeof why === "string" ? [[k, why]] : []; })) }; }
export const read = () => withCursor("people", live, diff);
