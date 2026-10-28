/** Vigil's own readers: an adapter that has failed every read for 30 minutes is blind, and says so. Reads the tick's ping record (ticks.jsonl), never an adapter's source, so an adapter that is not installed (its ping is not ok and carries not_installed, see common.ts withCursor) is never reported. @version 0.2.0 — a tick with no ping for a reader is unknown, never a break; a streak needs 4 failed reads as well as 30 minutes, so two reads either side of a sleep never report; 3 or more readers going blind together are one outage event. 0.1.0 — first version: a reader that failed for a day was visible only on the dashboard's ping panel. */
import { existsSync, readFileSync } from "node:fs";
import type { VigilEvent } from "../../STATVS/lib/refuse";
import { readJson, statePath } from "../../STATVS/lib/collectState";
import { clip, clock, event, need, withCursor } from "./common";

type Ping = { name: string; ok: boolean; error?: string; not_installed?: true };
type Tick = { ts: string; pings: Ping[]; dry_run?: boolean };
/** `since` starts the current unbroken failure streak (null while reads succeed); `fails` counts its failed reads; `announced` once the streak has been reported, so a cursor taken mid-streak still reports it once. */
type Reader = { since: string | null; error: string | null; fails: number; announced: boolean };
export type Snapshot = { at: string; readers: Record<string, Reader> };

/** How long every read must have failed before it is news. */
export const BLIND_MS = 30 * 60_000;
/** And how many failed reads, so a Mac asleep between two failed ticks never reports on two reads. */
export const BLIND_READS = 4;
/** This many readers going blind (or recovering) in one read is one outage, not one event each. */
export const OUTAGE_MIN = 3;
const LOOK = "Look: Pulse /vigil recent pings, or bun LIFEOS/VIGIL/Vigil.ts status.";

/**
 * The next snapshot from every kept tick, oldest first, so a streak older than the read reports its real start.
 * A tick with no ping for a reader (a tick that failed before its reads, a reader that runs only on some ticks) says nothing about it:
 * it neither breaks nor extends the streak, and a reader missing from the newest tick keeps what it had.
 */
export function fromTicks(prev: Snapshot | null, ticks: Tick[]): Snapshot {
  const real = ticks.filter((t) => !t.dry_run && Array.isArray(t.pings));
  need(real.length > 0, "ticks.jsonl holds a tick");
  const latest = real[real.length - 1]!, readers: Record<string, Reader> = { ...(prev?.readers ?? {}) };
  for (const p of latest.pings) {
    const before = prev?.readers[p.name];
    if (p.ok || p.not_installed) { readers[p.name] = { since: null, error: null, fails: 0, announced: false }; continue; }
    let start = latest.ts, fails = 0;
    for (let i = real.length - 1; i >= 0; i--) { const q = real[i]!.pings.find((x) => x.name === p.name); if (!q) continue; if (q.ok || q.not_installed) break; start = real[i]!.ts; fails++; }
    const since = before?.since ?? start, blind = Date.parse(latest.ts) - Date.parse(since) >= BLIND_MS && fails >= BLIND_READS;
    // A first read baselines: a streak already running is reported on the next read, never skipped.
    readers[p.name] = { since, error: clip(p.error ?? "read failed", 200), fails, announced: prev ? (before?.since === since && before.announced) || blind : false };
  }
  return { at: latest.ts, readers };
}

export function diff(prev: Snapshot | undefined, next: Snapshot): VigilEvent[] {
  if (!prev) return [];
  const when = (ts: string) => clock(ts, new Date(next.at));
  const blind: [string, Reader][] = [], back: [string, Reader][] = [];
  for (const [name, r] of Object.entries(next.readers)) {
    const was = prev.readers[name];
    if (r.since && r.announced && !(was?.announced && was.since === r.since)) blind.push([name, r]);
    if (!r.since && was?.since && was.announced) back.push([name, was]);
  }
  const out: VigilEvent[] = [];
  if (blind.length >= OUTAGE_MIN) {
    const names = blind.map(([n]) => n).sort(), first = blind.map(([, r]) => r.since!).sort()[0]!;
    out.push(event("readers", "outage", "blind", "medium", `Vigil is blind to ${blind.length} readers at once: ${clip(names.join(", "), 80)}`, `${blind.length} readers have failed every read since about ${when(first)}, so this is probably one shared cause (network, sleep, credentials) rather than ${blind.length} problems. Errors: ${clip(blind.map(([n, r]) => `${n}: ${r.error}`).join("; "), 400)}. ${LOOK}`, "infra", null, first));
  } else for (const [name, r] of blind)
    out.push(event("readers", name, "blind", "medium", `Vigil is blind to ${name}: every read has failed since ${when(r.since!)}`, `Vigil's ${name} reader has failed all ${r.fails} reads since ${when(r.since!)}, so nothing from ${name} reaches you until it is fixed. Last error: ${r.error}. ${LOOK}`, "infra", null, r.since!));
  if (back.length >= OUTAGE_MIN) {
    const first = back.map(([, r]) => r.since!).sort()[0]!;
    out.push(event("readers", "outage", "recovered", "info", `Vigil can read ${back.length} readers again`, `${back.map(([n]) => n).sort().join(", ")} succeeded at ${when(next.at)} after failing since about ${when(first)}.`, "infra", null, first));
  } else for (const [name, was] of back)
    out.push(event("readers", name, "recovered", "info", `Vigil can read ${name} again`, `The ${name} reader succeeded at ${when(next.at)} after failing on every read since ${when(was.since!)}.`, "infra", null, was.since!));
  return out;
}

export async function live(prev: Snapshot | null = readJson<Snapshot | null>(statePath("cursors", "readers.json"), null), path = statePath("ticks.jsonl")): Promise<Snapshot> {
  // The tick writes this record at the end of every tick, so it is missing only before a fresh install's first tick finishes; a deleted one is back one tick later.
  if (!existsSync(path)) return { at: new Date().toISOString(), readers: prev?.readers ?? {} };
  const ticks = readFileSync(path, "utf8").trim().split("\n").flatMap((line) => { try { return [JSON.parse(line) as Tick]; } catch { return []; } });
  return fromTicks(prev, ticks);
}

export const read = () => withCursor("readers", () => live(), diff);
