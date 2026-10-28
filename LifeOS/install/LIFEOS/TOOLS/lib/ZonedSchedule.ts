// ZonedSchedule.ts — the shared facts for schedules read in the principal's current timezone.
//
// A Workflows schedule trigger with `timezone: principal` is read in wherever the principal is now (the location
// service via principalTimezone()), so an 08:00 schedule is 08:00 local on a trip (otherwise, while traveling,
// launchd fires in the Mac's home zone and a morning job arrives hours late). The engine lives in
// LIFEOS/WORKFLOWS/engine/schedule.ts; this file holds only what the engine and the job clock line share.

/** The `timezone` value that means the principal's current zone, read at each wake. */
export const PRINCIPAL_ZONE = "principal";
/** Every UTC offset is a whole number of quarter hours, so a principal-zone schedule wakes every this many minutes. */
export const ZONED_TICK_MINUTES = 15;

/** The zone's UTC offset at an instant, as `+02:00` or `-07:00`. */
export function utcOffset(now: Date, tz: string): string {
  const name = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" }).formatToParts(now).find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  const m = name.match(/^GMT([+-]\d{2}):?(\d{2})?$/);
  return m ? `${m[1]}:${m[2] ?? "00"}` : "+00:00";
}
