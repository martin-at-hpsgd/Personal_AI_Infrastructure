/**
 * The pure clock: which occurrences of a time trigger fall in a window, and which one a wake-up runs (ISA F8 ISC-27,
 * 117, 120; F27 ISC-318). No filesystem, no process, no location lookup, so the Mac dispatcher and the `wf-clock`
 * Worker run this same code and compute the same occurrence keys, which is what lets the ledger dedupe a run the
 * cloud queued and the Mac's fallback clock also fired. A `timezone: principal` trigger is resolved by the caller
 * and passed in as `zone`.
 */
import { nextScheduledAt } from "./v1.ts";
import type { TriggerV2 } from "./format.ts";

export type TimeTrigger = Extract<TriggerV2, { type: "schedule" | "interval" | "once" }>;

export interface Occurrence {
  at: Date;
  key: string;
}

/** A wake-up this close to an occurrence is "on time"; older ones are catch-ups. */
export const ON_TIME_MS = 90_000;
const OCCURRENCE_CAP = 5_000;

export function graceMinutes(trigger: TimeTrigger): number | undefined {
  const g = (trigger as { grace_minutes?: unknown }).grace_minutes;
  return typeof g === "number" && Number.isFinite(g) && g >= 0 ? g : undefined;
}

/** Scheduled instants in (from, to], oldest first, at most `cap` (the newest are kept when the cap is hit). */
export function occurrencesIn(trigger: TimeTrigger, from: Date, to: Date, zone: string, cap: number = OCCURRENCE_CAP): Occurrence[] {
  const out: Occurrence[] = [];
  const push = (at: Date, kind: string) => {
    out.push({ at, key: `${kind}:${at.toISOString()}` });
    if (out.length > cap) out.shift();
  };
  if (to.getTime() <= from.getTime()) return out;
  switch (trigger.type) {
    case "once": {
      const at = new Date(trigger.at);
      if (at.getTime() > from.getTime() && at.getTime() <= to.getTime()) out.push({ at, key: `once:${trigger.at}` });
      return out;
    }
    case "interval": {
      const period = trigger.minutes * 60_000;
      for (let k = Math.floor(from.getTime() / period) + 1; k * period <= to.getTime(); k++) push(new Date(k * period), "interval");
      return out;
    }
    case "schedule": {
      // ISC-120: a cron entry names a LOCAL minute. The cron walks wall-clock time (a UTC parse over the local clock), and
      // each wall minute maps to one instant: the first of a repeated minute (fall back), the first valid minute after a
      // gap (spring forward, 02:30 fires at 03:00). The tz-aware parse only validates the expression and the zone.
      nextScheduledAt(cronProbe(trigger.cron, zone), from);
      const wallProbe = cronProbe(trigger.cron, "UTC");
      const wallEnd = wallOf(to.getTime(), zone) + WALL_MARGIN_MS;
      let cursor = new Date(wallOf(from.getTime(), zone) - WALL_MARGIN_MS);
      const seen = new Set<number>();
      for (let i = 0; i < cap * 4 + WALL_MARGIN_STEPS; i++) {
        const wall = nextScheduledAt(wallProbe, cursor);
        cursor = wall;
        if (wall.getTime() > wallEnd) break;
        const at = instantForWall(wall.getTime(), zone);
        if (at <= from.getTime() || at > to.getTime() || seen.has(at)) continue;
        seen.add(at);
        push(new Date(at), "schedule");
      }
      return out;
    }
  }
}

/** A one-step v1 workflow carrying only a schedule, the shape the v1 cron evaluator reads (format.ts v1ScheduleProbe, without its imports). */
const cronProbe = (cron: string, timezone: string) => ({ version: 1 as const, name: "schedule-probe", trigger: { type: "schedule" as const, cron, timezone }, steps: { probe: { uses: "probe" } } });

/** Wall-clock scan margin: a DST shift moves an instant's wall clock by at most this much (ISC-120). */
const WALL_MARGIN_MS = 3 * 3_600_000;
const WALL_MARGIN_STEPS = 400;
const MINUTE_MS = 60_000;
const wallFormatters = new Map<string, Intl.DateTimeFormat>();

/** The instant's local wall clock, read as if it were UTC (minute precision). */
export function wallOf(instant: number, timeZone: string): number {
  let fmt = wallFormatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" });
    wallFormatters.set(timeZone, fmt);
  }
  const parts = fmt.formatToParts(new Date(instant));
  const get = (t: string) => Number(parts.find(p => p.type === t)!.value);
  return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"));
}

const offsetAt = (instant: number, timeZone: string): number => wallOf(instant, timeZone) - Math.floor(instant / MINUTE_MS) * MINUTE_MS;

/**
 * The one instant a local wall-clock minute means: the first instance when the minute repeats (fall back), and the first
 * valid minute after the gap when it does not exist (spring forward).
 */
export function instantForWall(wall: number, timeZone: string): number {
  const before = offsetAt(wall - 86_400_000, timeZone);
  const after = offsetAt(wall + 86_400_000, timeZone);
  const valid = [...new Set([wall - before, wall - after])].filter(c => wallOf(c, timeZone) === wall);
  if (valid.length) return Math.min(...valid);
  // A gap: the transition lies between the two candidate instants; find its first minute.
  let lo = Math.min(wall - before, wall - after);
  let hi = Math.max(wall - before, wall - after);
  const loOffset = offsetAt(lo, timeZone);
  if (hi === lo) return hi;
  while (hi - lo > MINUTE_MS) {
    const mid = lo + Math.floor((hi - lo) / (2 * MINUTE_MS)) * MINUTE_MS;
    if (mid === lo) break;
    if (offsetAt(mid, timeZone) === loOffset) lo = mid;
    else hi = mid;
  }
  return hi;
}

/* ── Catch-up and grace (ISC-27, ISC-117) ───────────────────────────────── */

export interface Skipped {
  key: string;
  at: string;
  reason: "outside_grace" | "superseded" | "missed_run_skip";
}

export interface CatchUpPlan {
  /** Exactly zero or one occurrence to run. */
  run: Occurrence | null;
  skipped: Skipped[];
}

/**
 * Turns every occurrence a wake-up finds into at most one run. A machine that
 * slept through several occurrences gets one catch-up (`missed_run: once`) or
 * none (`skip`); an occurrence older than `grace_minutes` is skipped either way.
 *
 * `awake` is the caller's word that its own clock ran on cadence up to this wake.
 * An interval wake is also on time when `lastEvaluated` (the previous wake) is within one period plus ON_TIME_MS: the
 * clock was awake on the cadence and nothing was missed. A longer gap is a real miss and `missed_run` decides.
 */
export function planCatchUp(trigger: TimeTrigger, occurrences: Occurrence[], now: Date, lastEvaluated?: Date, awake: boolean = false): CatchUpPlan {
  const grace = graceMinutes(trigger);
  const skipped: Skipped[] = [];
  const skip = (o: Occurrence, reason: Skipped["reason"]) => skipped.push({ key: o.key, at: o.at.toISOString(), reason });
  const fresh: Occurrence[] = [];
  for (const o of occurrences) {
    if (grace !== undefined && now.getTime() - o.at.getTime() > grace * 60_000) skip(o, "outside_grace");
    else fresh.push(o);
  }
  const latest = fresh[fresh.length - 1];
  if (!latest) return { run: null, skipped };
  const onCadence = trigger.type === "interval" && lastEvaluated !== undefined
    && now.getTime() - lastEvaluated.getTime() <= trigger.minutes * 60_000 + ON_TIME_MS;
  // `awake`: the caller's clock was itself on its cadence (the cloud's minute cron with a recent previous tick), so a
  // late cron tick is not a missed occurrence for any trigger type.
  const onTime = now.getTime() - latest.at.getTime() <= ON_TIME_MS || onCadence || awake;
  const policy = trigger.missed_run;
  const run = onTime || policy === "once" ? latest : null;
  for (const o of fresh) if (o !== run) skip(o, run ? "superseded" : "missed_run_skip");
  return { run, skipped };
}

/** Whether a trigger is one the clock fires (schedule, interval, once) and is not switched off. */
export function isTimeTrigger(t: TriggerV2): t is TimeTrigger {
  return (t.type === "schedule" || t.type === "interval" || t.type === "once") && (t as { enabled?: boolean }).enabled !== false;
}
