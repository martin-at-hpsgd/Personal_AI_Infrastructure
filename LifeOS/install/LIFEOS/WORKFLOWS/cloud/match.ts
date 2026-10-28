/**
 * The cloud runner's schedule matcher (ISC-136).
 *
 * The Worker's cron fires every minute in UTC; this decides whether a
 * definition's IANA-timezone `schedule` is due at that minute. It asks the
 * engine's own occurrencesBetween (engine/schedule.ts), which walks the v1
 * nextScheduledAt DST logic, for occurrences in the minute ending at the fire
 * time. A spring-forward minute that does not exist locally follows the
 * engine's verdict. A fall-back minute that repeats fires once: the engine
 * returns both instants, and the matcher drops the second (see below).
 */
import { clockIn, occurrencesBetween, type Occurrence } from "../engine/schedule.ts";
import { v1ScheduleProbe, type TriggerV2 } from "../engine/format.ts";
import { nextScheduledAt } from "../engine/v1.ts";

type ScheduleTrigger = Extract<TriggerV2, { type: "schedule" }>;

const MINUTE_MS = 60_000;
const UTC_ZONES = new Set(["UTC", "Etc/UTC"]);

/** The minute a cron event belongs to: Cloudflare's scheduledTime floored to the minute. */
export function fireMinute(scheduledTime: number): Date {
  if (!Number.isFinite(scheduledTime)) throw new Error("A cron event needs a numeric scheduledTime");
  return new Date(Math.floor(scheduledTime / MINUTE_MS) * MINUTE_MS);
}

/** Occurrences of one schedule trigger that fall on the fire minute; empty when it is not due or is disabled. */
export function dueAt(trigger: TriggerV2, scheduledTime: number): Occurrence[] {
  if (trigger.type !== "schedule" || trigger.enabled === false) return [];
  const minute = fireMinute(scheduledTime);
  // UTC has no daylight-saving shift, so the wall-clock scan (a three-hour margin either side, about 37 ms
  // per call for a five-minute cron) answers the same as one cron step from the previous minute (ISC-269).
  if (UTC_ZONES.has(trigger.timezone)) {
    const next = nextScheduledAt(v1ScheduleProbe(trigger.cron, "UTC"), new Date(minute.getTime() - MINUTE_MS));
    return next.getTime() === minute.getTime() ? [{ at: minute, key: `schedule:${minute.toISOString()}` }] : [];
  }
  const due = occurrencesBetween(trigger as ScheduleTrigger, new Date(minute.getTime() - MINUTE_MS), minute)
    .filter(o => o.at.getTime() === minute.getTime());
  return due.filter(o => !repeatsEarlierWallClock(trigger as ScheduleTrigger, o.at));
}

/**
 * Fall back repeats an hour of wall-clock time, and the engine's occurrencesBetween
 * returns the schedule at both instants. A local cron entry means "this local
 * minute once", so the second instant is dropped when the same wall-clock minute
 * already fired exactly one hour earlier.
 */
function repeatsEarlierWallClock(trigger: ScheduleTrigger, at: Date): boolean {
  const earlier = new Date(at.getTime() - 60 * MINUTE_MS);
  const a = clockIn(at, trigger.timezone);
  const b = clockIn(earlier, trigger.timezone);
  if (a.Day !== b.Day || a.Month !== b.Month || a.Hour !== b.Hour || a.Minute !== b.Minute) return false;
  return occurrencesBetween(trigger, new Date(earlier.getTime() - MINUTE_MS), earlier).some(o => o.at.getTime() === earlier.getTime());
}

/** Every due occurrence across a definition's triggers, one per distinct key. */
export function dueOccurrences(triggers: readonly TriggerV2[], scheduledTime: number): Occurrence[] {
  const byKey = new Map<string, Occurrence>();
  for (const trigger of triggers) for (const o of dueAt(trigger, scheduledTime)) byKey.set(o.key, o);
  return [...byKey.values()];
}
