/** Shared adapter event/cursor helpers. @version 0.6.1 — personal adapters live in USER (userAdapterDir); an adapter whose source this install never had reports itself not installed instead of failing.
 * 0.6.0 (STATVS split, Lane C p1): every import is depth-stable, so this file resolves the same from LIFEOS/VIGIL/adapters/ and
 * LIFEOS/STATVS/adapters/; nothing here imports LIFEOS/VIGIL. Refusal rules come from STATVS refuse.ts, cursors from collectState.ts
 * (p1 root: Vigil's state dir), the burst limit from collectConfig.ts (p1 file: USER/VIGIL/policy.json). Personal adapters are found
 * in USER/STATVS/adapters first, then USER/VIGIL/adapters, so the p2 move never leaves an empty registry.
 * 0.6.1: the `abandoned` set and `isAbandoned` are STATVS collect.ts's, re-exported, so the tick and the collection runner share one set. */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { abandoned, isAbandoned } from "../../STATVS/lib/collect";
import { burstMax } from "../../STATVS/lib/collectConfig";
import { readJson, statePath, writeJson } from "../../STATVS/lib/collectState";
import { validateEvent, type VigilEvent } from "../../STATVS/lib/refuse";
import { invariant } from "../../TOOLS/Invariant";
import { principalTimezone } from "../../TOOLS/lib/Timezone";
import { lifeosPath } from "../../TOOLS/Paths";
/** The folders that may hold this install's personal adapters, in search order: STATVS's (their home from the switch), then Vigil's.
 * VIGIL_USER_ADAPTERS names the one folder instead (tests). */
export const userAdapterDirs = (): string[] => process.env.VIGIL_USER_ADAPTERS ? [process.env.VIGIL_USER_ADAPTERS] : [lifeosPath("USER", "STATVS", "adapters"), lifeosPath("USER", "VIGIL", "adapters")];
const holdsModules = (dir: string): boolean => { try { return readdirSync(dir).some((f) => f.endsWith(".ts") && !f.endsWith(".d.ts")); } catch { return false; } };
/** The folder holding this install's personal adapters, private by construction (Vigil ISA F14): the first of userAdapterDirs() that holds
 * a module file, so an empty or half-made USER/STATVS/adapters never hides the real set; with none, the last (Vigil's, p1). */
export const userAdapterDir = (): string => { const dirs = userAdapterDirs(); return dirs.find(holdsModules) ?? dirs[dirs.length - 1]!; };
/** `occurrence` names the source record behind a transition (an answer id, a snapshot time) so a second red next week is a new row while a replay of the same record still dedups. */
export const event = (source: string, ref: string, state: string, severity: VigilEvent["severity"], title: string, summary: string, kind: VigilEvent["kind"] = "infra", url: string | null = null, occurrence?: string): VigilEvent => settle({ id: randomUUID(), source, ts: new Date().toISOString(), kind, severity, title: title.slice(0, 140), summary: summary.slice(0, 1000), ref, url, privacy_class: "personal", dedup_key: `${source}:${ref}:${state}${occurrence ? `:${occurrence}` : ""}` });
/** An event the schema would refuse is lost at emit, so a refusal degrades instead (ISC-93): first drop the url (a long issue path reads as a token), then withhold the quoted detail, keeping the subject and the pointer. The event survives either way. */
export function settle(e: VigilEvent): VigilEvent {
  for (const candidate of [e, { ...e, url: null }, { ...e, url: null, summary: `Detail withheld: it matched the credential filter. Look at the source record for ${e.ref ?? e.source}.` }]) { try { validateEvent(candidate); return candidate; } catch {} }
  return e;
}
/** Bounds raw source text quoted into a summary (ISC-93): whitespace collapsed, at most `max` characters. */
export const clip = (text: string, max = 240): string => { const flat = String(text).replace(/\s+/g, " ").trim(); return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat; };
/** A timestamp as the reader sees it: 24-hour local time with its zone, plus the date when it is not today. */
/** HH:mm (24-hour) in the principal's current zone, which follows the location service; a day other than today adds its date. Every adapter's event text uses this (Pulse ISA F7, 2026-10-13: it used the zone the Vigil process started in, so a trip read "03:00 PDT"). */
export const clock = (ts: string, now = new Date()): string => { const d = new Date(ts); if (Number.isNaN(d.getTime())) return ts; const timeZone = principalTimezone(); const day = (x: Date) => new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(x); const zone = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "short" }).formatToParts(d).find((p) => p.type === "timeZoneName")?.value ?? timeZone; const time = `${new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d)} ${zone}`; return day(d) === day(now) ? time : `${day(d)} ${time}`; };
/** The shape of an adapter's saved state: a hash of every type declaration in its source. When it changes, the cursor on disk was written by different code, and diffing against it reads old records as new, so weeks-old entries come back as news and some as texts. */
export function shapeOf(name: string): string { for (const dir of [import.meta.dir, ...userAdapterDirs()]) { try { const src = readFileSync(join(dir, `${name}.ts`), "utf8"); return createHash("sha256").update(src.split("\n").filter((l) => /^\s*(export\s+)?type\s/.test(l)).join("\n")).digest("hex").slice(0, 16); } catch {} } return "unknown"; }
/** Adapters whose read a runner gave up on at its deadline (running-work watch ISC-15b), and the check `withCursor` makes against them. Such a read may still finish, but it never writes its
 * cursor: the events it found were never routed, so the next read must find them again. A reader may own several cursors, `<name>` and `<name>_<part>` (services reads services and
 * services_exit), so an abandoned reader silences all of them. There is ONE set, owned by STATVS's collection runner and re-exported here, so Vigil's tick (which adds to it through
 * this module) and `Statvs.ts collect` silence the same late reads. */
export { abandoned, isAbandoned };
export async function withCursor<T>(name: string, live: () => Promise<T>, diff: (a: T | undefined, b: T) => VigilEvent[]): Promise<VigilEvent[]> {
  const path = statePath("cursors", `${name}.json`), readPath = statePath("cursors", `${name}.read.json`), prev = readJson<T | undefined>(path, undefined), ts = new Date().toISOString();
  const shape = shapeOf(name), savedShape = readJson<{ shape?: string }>(readPath, {}).shape;
  const found = new Set<string>();
  try {
    const next = await sourcesFound.run(found, live);
    if (isAbandoned(name)) return [];
    invariant(next !== undefined, `${name} cursor value exists`);
    const rebaseline = prev !== undefined && savedShape !== shape, raw = rebaseline ? [] : diff(prev, next), max = burstMax();
    const events = raw.length > max ? [event(raw[0]!.source, `${name}:burst`, "held", "medium", `Vigil held ${raw.length} events from ${name} in one read`, `One read of ${name} produced ${raw.length} events, over the burst limit of ${max}, so they were held and the cursor re-baselined. First three: ${raw.slice(0, 3).map((e) => clip(e.title, 60)).join("; ")}. Usually a changed source or cursor shape.`, "infra", null, ts)] : raw;
    writeJson(path, next); writeJson(readPath, { ok: true, ts, shape, ...(rebaseline ? { rebaselined: savedShape ?? "none" } : {}), ...(raw.length > max ? { held: raw.length } : {}) });
    return events;
  }
  catch (error) {
    if (isAbandoned(name)) return [];
    const message = error instanceof Error ? error.message : String(error);
    // Never read on this install and none of its sources is there: the subsystem behind it is probably not installed. The read is recorded
    // as not ok and marked not_installed, so it never reads as a success, and readers.ts raises no blind event for it. A missing source is a
    // real failure (ISC-45) once a read has succeeded (a cursor exists), or when this read already found another of the adapter's sources
    // (Relay with bridge.log but no guard.log is installed and broken): silence must mean nothing happened, never that the adapter went blind.
    if (prev === undefined && isSourceMissing(error) && found.size === 0) { writeJson(readPath, { ok: false, ts, shape, not_installed: message }); return []; }
    const partial = isSourceMissing(error) && found.size > 0 ? ` (installed: ${found.size} other source${found.size === 1 ? "" : "s"} present)` : "";
    writeJson(readPath, { ok: false, ts, shape: savedShape ?? shape, error: message + partial }); return [];
  }
}
/** The source an adapter reads is absent. Thrown for a missing file or directory, or a prerequisite (a tool, a credential) the install lacks. */
export class SourceMissing extends Error { constructor(what: string) { super(`source missing: ${what}`); this.name = "SourceMissing"; } }
/** A SourceMissing, or a raw file-not-found from reading a source directly. */
export const isSourceMissing = (error: unknown): boolean => error instanceof SourceMissing || (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
/** The sources the current withCursor read has found present. A missing source after one was found means installed and broken, never not installed. */
const sourcesFound = new AsyncLocalStorage<Set<string>>();
/** Throws SourceMissing unless `path` exists; for sources read some other way (a directory scan, a spawned tool). A present source is recorded for this read. */
export function requireSource(path: string, what: string = path): void { if (!existsSync(path)) throw new SourceMissing(what); sourcesFound.getStore()?.add(path); }
/** A text source: SourceMissing when absent, and recorded as found when present. Prefer it to a raw readFileSync so a later missing source in the same read is a failure. */
export function readSource(path: string, what: string = path): string { requireSource(path, what); return readFileSync(path, "utf8"); }
/** A missing source is an error, never an empty read: silence has to mean nothing happened, not that the adapter went blind (ISC-45). */
export const jsonFile = <T>(path: string): T => { requireSource(path); return JSON.parse(readFileSync(path, "utf8")); };
export function need(ok: unknown, what: string): asserts ok { if (!ok) throw new Error(`source shape changed: ${what}`); }
