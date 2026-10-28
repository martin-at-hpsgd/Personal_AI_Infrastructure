import { invariant } from "../TOOLS/Invariant";

const DAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"] as const;

/**
 * Epoch seconds from a plain integer (native rate_limits) or an ISO 8601 string (OAuth cache).
 * Fractional seconds are dropped and a missing zone means UTC; anything unparseable is 0
 *.
 */
export function parseIsoEpoch(ts: unknown): number {
  if (typeof ts === "number") return Number.isFinite(ts) && ts > 0 && Number.isInteger(ts) ? ts : 0;
  if (typeof ts !== "string" || ts === "") return 0;
  if (/^[0-9]+$/.test(ts)) return Number(ts);
  let clean = ts;
  const frac = /^(.*)\.[0-9]+(Z|[+-][0-9]{2}:[0-9]{2})$/.exec(clean) ?? /^(.*)\.[0-9]+$/.exec(clean);
  if (frac) clean = frac[1] + (frac[2] ?? "");
  const zoned = /^(.*)([+-][0-9]{2}):([0-9]{2})$/.exec(clean);
  if (zoned) clean = zoned[1] + zoned[2] + zoned[3];
  else if (clean.endsWith("Z")) clean = clean.slice(0, -1) + "+0000";
  else clean += "+0000";
  const m = /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})([+-])([0-9]{2})([0-9]{2})$/.exec(clean);
  if (!m) return 0;
  const [y, mo, d, h, mi, s, sign, oh, om] = [...m.slice(1, 7).map(Number), m[7], Number(m[8]), Number(m[9])] as [number, number, number, number, number, number, string, number, number];
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 60) return 0;
  const ms = Date.UTC(y, mo - 1, d, h, mi, s);
  if (new Date(ms).getUTCDate() !== d) return 0;
  const epoch = Math.floor(ms / 1000) - (sign === "-" ? -1 : 1) * (oh * 3600 + om * 60);
  return epoch > 0 ? epoch : 0;
}

interface Parts { day: string; hhmm: string; dow: number }

function partsIn(epoch: number, timezone: string): Parts {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23" });
  const p: Record<string, string> = {};
  for (const part of f.formatToParts(epoch * 1000)) p[part.type] = part.value;
  return { day: `${p.year}-${p.month}-${p.day}`, hhmm: `${p.hour}${p.minute}`, dow: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday) };
}

/** The calendar day of `epoch` in `timezone` as YYYY-MM-DD (bash _SL_TODAY). */
export function dayIn(epoch: number, timezone: string): string { return partsIn(epoch, timezone).day; }

/**
 * Absolute reset time: "TODAY@1500" or "THU@0900", rounded to the nearest minute because the
 * OAuth API jitters resets_at around the second. At or before `now` the answer is "now".
 */
export function resetTimeStr(epoch: number | string | null | undefined, timezone: string, now: number): string {
  invariant(Number.isSafeInteger(now), "reset time needs an epoch-seconds clock");
  const e = Number(epoch);
  if (!Number.isFinite(e) || e <= 0 || e <= now) return "now";
  const rounded = Math.floor((Math.floor(e) + 30) / 60) * 60;
  const when = partsIn(rounded, timezone);
  if (when.day === dayIn(now, timezone)) return `TODAY@${when.hhmm}`;
  return `${DAYS[when.dow] ?? "NOW"}@${when.hhmm}`;
}

/** `${s%%@*}` and `${s#*@}`: both halves of a reset string; without an @ each is the whole string. */
export function splitReset(text: string): { day: string; time: string } {
  const i = text.indexOf("@");
  return i < 0 ? { day: text, time: text } : { day: text.slice(0, i), time: text.slice(i + 1) };
}
