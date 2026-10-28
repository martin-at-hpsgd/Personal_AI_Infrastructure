/**
 * Where the principal is, for every reader in LifeOS. Reads the local `current.json` that `Location.ts sync` writes and
 * never touches the network. `here()` returns a point rounded to two decimals (about a kilometre) (ISC-1); `readCurrent()`
 * returns the exact local fix, and a caller that reads it must coarsen the point before anything leaves the machine. A stale fix still gives the last known place, marked `stale: true` (ISC-5, 2026-10-14).
 * Only a missing or corrupt file gives the home the caller passes, marked `fallback: true` with `at_home: null`, because a
 * fallback home is not a fact (ISC-32). Dependency-free on purpose: the watches and
 * the timezone helper import it. @version 0.1.0
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const LIFEOS_DIR = resolve(import.meta.dir, "..");
/** The location user-data directory; LIFEOS_LOCATION_DIR moves it (tests, sandboxes). */
export const locationDir = (): string => { const o = process.env.LIFEOS_LOCATION_DIR; return o && o.trim() ? resolve(o) : join(LIFEOS_DIR, "USER", "LOCATION"); };
export const DEFAULT_STALE_HOURS = 6;

/** What `Location.ts sync` writes. Exact coordinates: local only, mode 0600. */
export type Current = {
  /** "overland" for the phone, or the Seat label of the Mac the fix came from (ISC-122). */
  source: string; lat: number; lon: number; accuracy_m: number | null; fix_at: string; synced_at: string;
  city: string | null; region: string | null; country: string | null; timezone: string | null;
  distance_home_km: number | null; at_home: boolean | null; motion: string | null; battery: number | null;
};
export type HomePoint = { name?: string; lat: number; lon: number; timezone?: string };
export type Config = { url?: string; stale_hours?: number; home_radius_m?: number; home?: HomePoint };
export type Here = { name: string; lat: number; lon: number; timezone: string | null; at_home: boolean | null; fallback: boolean; stale: boolean; fix_at: string | null; age_min: number | null };

export const round2 = (n: number): number => Math.round(n * 100) / 100;

const rad = (d: number) => (d * Math.PI) / 180;
/** Haversine distance in kilometres. Kept here so the shipped Location code imports nothing private. */
export function distanceKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lon - a.lon) / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function readCurrent(dir: string = locationDir()): Current | null {
  try {
    const c = JSON.parse(readFileSync(join(dir, "current.json"), "utf8")) as Current;
    return c && typeof c.lat === "number" && typeof c.lon === "number" && Number.isFinite(Date.parse(c.fix_at)) ? c : null;
  } catch { return null; }
}
export function readConfig(dir: string = locationDir()): Config {
  try { return JSON.parse(readFileSync(join(dir, "config.json"), "utf8")) as Config; } catch { return {}; }
}
export const staleHours = (dir: string = locationDir()): number => { const h = readConfig(dir).stale_hours; return typeof h === "number" && h > 0 ? h : DEFAULT_STALE_HOURS; };
export const ageMinutes = (c: Current, now: Date): number => Math.max(0, Math.round((now.getTime() - Date.parse(c.fix_at)) / 60_000));
export const isFresh = (c: Current | null, now: Date, dir: string = locationDir()): c is Current => !!c && ageMinutes(c, now) <= staleHours(dir) * 60;

/** Where he is now, or where he was last seen (`stale: true`), or with no fix at all the given home marked as a fallback. Never throws. */
export function here(home: HomePoint, opts: { now?: Date; dir?: string } = {}): Here {
  const now = opts.now ?? new Date(), dir = opts.dir ?? locationDir();
  const c = readCurrent(dir);
  if (c) {
    const name = [c.city, c.region].filter(Boolean).join(", ") || "last known location";
    return { name, lat: round2(c.lat), lon: round2(c.lon), timezone: c.timezone, at_home: c.at_home, fallback: false, stale: !isFresh(c, now, dir), fix_at: c.fix_at, age_min: ageMinutes(c, now) };
  }
  return { name: home.name || "home", lat: round2(home.lat), lon: round2(home.lon), timezone: home.timezone ?? null, at_home: null, fallback: true, stale: false, fix_at: null, age_min: null };
}

/** The last known fix's IANA zone, stale or fresh, or null when there is no fix or it carries none. Used by `principalTimezone()`. */
export function lastTimezone(opts: { dir?: string } = {}): string | null {
  return readCurrent(opts.dir ?? locationDir())?.timezone ?? null;
}
