/**
 * The principal's IANA timezone for every clock the dashboard draws (Workflows ISC-107, Pulse ISA F7).
 *
 * The browser cannot read the LifeOS config, so the zone starts as the browser's own and is
 * replaced by the server's zone (GET /api/config/timezone, TOOLS/lib/Timezone.ts, which follows a
 * fresh location fix) as soon as <PrincipalTzSync> loads it. A laptop set to another zone
 * then still reads the principal's clock. Never write a zone literal here.
 */

let zone: string = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

function valid(tz: string): boolean {
  try { new Intl.DateTimeFormat(undefined, { timeZone: tz }); return true; } catch { return false; }
}

export function principalTz(): string {
  return zone;
}

/** The zone as words for a tooltip: "New York" for America/New_York, "UTC" as is. */
export function principalTzLabel(): string {
  return zone.replace(/^.*\//, "").replace(/_/g, " ");
}

/** Adopts the server's zone; an empty or unknown value leaves the current zone in place. */
export function setPrincipalTz(tz: unknown): void {
  if (typeof tz === "string" && tz && valid(tz)) zone = tz;
}

const cache = new Map<string, Intl.DateTimeFormat>();

/** A formatter pinned to the principal's zone, rebuilt when the zone changes. */
export function tzFormat(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${zone}|${locale}|${JSON.stringify(options)}`;
  let fmt = cache.get(key);
  if (!fmt) { fmt = new Intl.DateTimeFormat(locale, { ...options, timeZone: zone }); cache.set(key, fmt); }
  return fmt;
}
