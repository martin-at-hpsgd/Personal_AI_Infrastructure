// Timezone.ts — the principal's IANA timezone, from config, never a literal.
//
// Order: LIFEOS_TIMEZONE (tests, one-off runs) → the zone of a fresh iPhone fix (LIFEOS/LOCATION, so
// quiet hours and stamps follow the principal on a trip) → `[principal] timezone` in LIFEOS_CONFIG.toml
// → the machine's own zone → UTC. Eleven shipped sites once carried the maintainer's zone as
// a literal, so every Pulse-hosted DA turn told anyone outside it the wrong hour (Fable
// in-family audit, 7.52.0 cut). Import this; never write a zone into code.
import { lastTimezone } from "../../LOCATION/Here";
import { loadLifeosConfig } from "../LifeosConfig";

let cached: string | undefined;

/** Forget the configured zone so the next call re-reads it (tests). The location zone is never cached: it is read on every call. */
export function resetPrincipalTimezoneCache(): void { cached = undefined; }

/** True when Intl accepts the zone; an unfilled template token or a typo is not a zone. */
export function isValidTimezone(tz: string): boolean {
  try { new Intl.DateTimeFormat(undefined, { timeZone: tz }); return true; } catch { return false; }
}

/** Short display name for the configured zone ("PDT", "CEST"), for stamped timestamps. */
export function principalTimezoneShort(): string {
  const tz = principalTimezone();
  return new Date().toLocaleString("en-US", { timeZone: tz, timeZoneName: "short" }).split(" ").pop() || tz;
}

export function principalTimezone(): string {
  const env = process.env.LIFEOS_TIMEZONE;
  if (env && isValidTimezone(env)) return env;
  try { const here = lastTimezone(); if (here && isValidTimezone(here)) return here; } catch { /* no location: fall through */ }
  if (cached) return cached;
  try {
    // A scaffold that still carries the install token, or a hand-typed zone Intl rejects,
    // falls through to the machine's zone instead of throwing in every DA turn (round-6 audit).
    const tz = loadLifeosConfig().principal.timezone;
    if (tz && isValidTimezone(tz)) return (cached = tz);
  } catch { /* no config yet: fall through to the machine's zone */ }
  return (cached = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
}
