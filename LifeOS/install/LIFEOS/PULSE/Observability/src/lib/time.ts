/**
 * Every clock and date the dashboard draws (Pulse ISA F7): 24-hour HH:mm, in the principal's current zone
 * (src/lib/principal-tz.ts, which follows the location service). Format times here, never with
 * toLocaleTimeString / toLocaleString / an `hour:` option at the call site; ISC-33 fails on those.
 */
import { principalTz, tzFormat } from "./principal-tz";

type When = Date | string | number | null | undefined;

const toDate = (w: When): Date | null => {
  if (w === null || w === undefined || w === "") return null;
  const d = w instanceof Date ? w : new Date(w);
  return Number.isNaN(d.getTime()) ? null : d;
};

const CLOCK: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit", hourCycle: "h23" };
const DAY: Intl.DateTimeFormatOptions = { day: "numeric", month: "short" };
const DAY_YEAR: Intl.DateTimeFormatOptions = { ...DAY, year: "numeric" };

/** "13:05". An empty or invalid input gives the fallback. */
export function fmtClock(w: When, fallback = "—"): string {
  const d = toDate(w);
  return d ? tzFormat("en-GB", CLOCK).format(d) : fallback;
}

/** "14 Oct" (or "14 Oct 2025" outside the current year). */
export function fmtDate(w: When, fallback = "—"): string {
  const d = toDate(w);
  if (!d) return fallback;
  const sameYear = tzFormat("en-GB", { year: "numeric" }).format(d) === tzFormat("en-GB", { year: "numeric" }).format(new Date());
  return tzFormat("en-GB", sameYear ? DAY : DAY_YEAR).format(d);
}

/** "14 Oct 13:05" — the default for a timestamp shown in full (titles, "updated" lines). */
export function fmtDateTime(w: When, fallback = "—"): string {
  const d = toDate(w);
  return d ? `${fmtDate(d)} ${fmtClock(d)}` : fallback;
}

/** "Wed 13:05" within six days either side of now; further out a weekday is ambiguous, so it gives fmtDateTime ("22 Oct 06:00"). */
export function fmtWeekdayClock(w: When, fallback = "—"): string {
  const d = toDate(w);
  if (!d) return fallback;
  if (Math.abs(d.getTime() - Date.now()) > 6 * 86_400_000) return fmtDateTime(d);
  return `${tzFormat("en-GB", { weekday: "short" }).format(d)} ${fmtClock(d)}`;
}

/** "Oct 2026" / "14 Oct" style labels for chart axes: any date-only Intl options, in the principal zone. */
export function fmtDateParts(w: When, options: Omit<Intl.DateTimeFormatOptions, "hour" | "minute" | "second" | "hour12" | "hourCycle" | "timeZone">, fallback = "—"): string {
  const d = toDate(w);
  return d ? tzFormat("en-GB", options).format(d) : fallback;
}

/** "Wednesday 14 October" for a calendar day key ("2026-10-14"), which has no zone of its own. */
export function fmtLongDay(dayKey: string): string {
  const d = new Date(`${dayKey}T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? dayKey : new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }).format(d);
}

/** Date-only parts of a calendar day key ("2026-10-14", or an ISO string that starts with one), which has
 * no zone of its own: drawn in UTC at noon, so no principal zone (UTC-12 through UTC+14) shifts the day. */
export function fmtDayKeyParts(dayKey: string, options: Omit<Intl.DateTimeFormatOptions, "hour" | "minute" | "second" | "hour12" | "hourCycle" | "timeZone">, fallback = "—"): string {
  const m = dayKey.match(/^(\d{4}-\d{2}-\d{2})/);
  const d = m ? new Date(`${m[1]}T12:00:00Z`) : null;
  return d && !Number.isNaN(d.getTime()) ? new Intl.DateTimeFormat("en-GB", { ...options, timeZone: "UTC" }).format(d) : fallback;
}

/** Epoch ms of midnight that starts a calendar day key ("2026-10-14") in the principal's zone. */
export function zonedMidnight(dayKey: string): number {
  const [y, m, d] = dayKey.split("-").map(Number);
  const utc = Date.UTC(y, m - 1, d);
  const parts = Object.fromEntries(
    tzFormat("en-US", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(new Date(utc)).map((p) => [p.type, p.value]),
  );
  const asIfUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute);
  return utc - (asIfUtc - utc);
}

/** The hour (0–23) right now, or at `w`, in the principal's zone. */
export function zonedHour(w: When = new Date()): number {
  const d = toDate(w) ?? new Date();
  return Number(tzFormat("en-GB", { hour: "2-digit", hourCycle: "h23" }).format(d));
}

/** The calendar day key ("2026-10-14") right now, or at `w`, in the principal's zone. */
export function zonedDayKey(w: When = new Date()): string {
  const d = toDate(w) ?? new Date();
  return tzFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

export { principalTz };
