#!/usr/bin/env bun
/**
 * Tide — current tide state for the statusline, from NOAA CO-OPS.
 *
 * Free, keyless, unlimited: api.tidesandcurrents.noaa.gov. We pull the
 * high/low predictions for a 3-day window once every few hours and derive the
 * current water level locally by cosine interpolation between the bracketing
 * extremes (the standard harmonic approximation tide widgets use).
 *
 * The station is resolved from the statusline's own location cache via the
 * NOAA station index, so it follows the principal when he travels. A location
 * with no station within range reports nothing rather than lying.
 *
 * Heights are fetched in metres and shown in the principal's unit: metres by
 * default, feet when PRINCIPAL_IDENTITY.md frontmatter sets `preferences.length_unit: feet`
 * (or, with no length_unit, `temperature_unit: fahrenheit`). The --json output stays in metres.
 *
 * Usage:
 *   bun Tide.ts                 # statusline string: 🌊 1.9→1.5→1.1M in 2h14M
 *   bun Tide.ts --json          # full state
 *   bun Tide.ts --station <id>  # force a specific NOAA station
 *
 * @version 1.0.4
 */

import { mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { invariant } from "./Invariant.ts";
import { lifeosPath } from "./Paths.ts";
import { getPrincipalPreferences } from "../../hooks/lib/identity";

const API = "https://api.tidesandcurrents.noaa.gov";
const STATE_DIR =
  process.env.STATUSLINE_LOCAL_STATE ||
  join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "lifeos-statusline");
const LOCATION_CACHE = join(STATE_DIR, "location-cache.json");
const STATION_CACHE = join(STATE_DIR, "tide-station.json");
const PRED_CACHE = join(STATE_DIR, "tide-predictions.json");

/** Station lookup is stable for a place; predictions are published well ahead. */
const STATION_TTL_S = 7 * 24 * 3600;
const PRED_TTL_S = 6 * 3600;
/** NOAA tide stations thin out fast inland; beyond this a location has no tide. */
const STATION_RADIUS_MI = 40;

type Extreme = { t: number; v: number; type: "H" | "L" };
type Station = { id: string; name: string };
type Predictions = { station: string; name: string; fetched: number; extremes: Extreme[] };

function ageSeconds(path: string): number {
  try {
    return (Date.now() - statSync(path).mtimeMs) / 1000;
  } catch {
    return Infinity;
  }
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function writeJson(path: string, data: unknown): void {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(path, JSON.stringify(data));
}

/**
 * NOAA is asked for GMT ("2026-09-20 22:56", no offset), so the station's zone and
 * this machine's zone never have to agree: a station read from a machine in another
 * time zone used to land hours off.
 */
function parseGmt(s: string): number {
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/);
  invariant(m, `unparseable NOAA timestamp: ${s}`);
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
}

type Loc = { lat?: number; lon?: number; source?: string; at_home?: boolean | null };

/** Great-circle distance in km. */
function km(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const r = Math.PI / 180, dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}
/** A resolved station is reused only while the principal is within this of where it was resolved. */
const STATION_REUSE_KM = 20;

function ymd(d: Date): string {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * A pinned station in USER config wins over geolocation: the IP-derived city
 * can sit closer to a neighbouring station than to the one the principal
 * actually watches. The pin is the home station, so it yields when the Location
 * system says he is away from home.
 */
function configuredStation(loc: Loc | null): Station | null {
  const env = process.env.LIFEOS_TIDE_STATION;
  if (env) return { id: env, name: env };
  if (loc?.source === "lifeos-location" && loc.at_home === false) return null;
  const toml = lifeosPath("USER/CONFIG/LIFEOS_CONFIG.toml");
  try {
    const m = readFileSync(toml, "utf8").match(/^\s*tide_station\s*=\s*"(\d{7})"/m);
    return m ? { id: m[1], name: "" } : null;
  } catch {
    return null;
  }
}

async function resolveStation(): Promise<Station | null> {
  const loc = readJson<Loc>(LOCATION_CACHE);
  const pinned = configuredStation(loc);
  if (pinned) return pinned;
  if (typeof loc?.lat !== "number" || typeof loc?.lon !== "number") return null;
  const here = { lat: loc.lat, lon: loc.lon };

  if (ageSeconds(STATION_CACHE) < STATION_TTL_S) {
    const cached = readJson<(Station | { none: true }) & { at?: { lat: number; lon: number } }>(STATION_CACHE);
    // A station found for another place is not this place's station.
    if (cached?.at && km(cached.at, here) <= STATION_REUSE_KM) {
      if ("none" in cached) return null;
      if ("id" in cached) return { id: cached.id, name: cached.name };
    }
  }

  const url = `${API}/mdapi/prod/webapi/tidepredstations.json?lat=${loc.lat}&lon=${loc.lon}&radius=${STATION_RADIUS_MI}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
  if (!res.ok) return null;
  const body = (await res.json()) as {
    stationList?: { stationId: string; etidesStnName: string; distance: number }[];
  };

  const nearest = (body.stationList ?? []).sort((a, b) => a.distance - b.distance)[0];
  if (!nearest) {
    writeJson(STATION_CACHE, { none: true, at: here });
    return null;
  }

  invariant(/^\d{7}$/.test(nearest.stationId), `bad NOAA station id: ${nearest.stationId}`);
  const station: Station = { id: nearest.stationId, name: nearest.etidesStnName };
  writeJson(STATION_CACHE, { ...station, at: here });
  return station;
}

async function loadPredictions(station: Station): Promise<Predictions | null> {
  const now = Date.now();
  const cached = readJson<Predictions>(PRED_CACHE);
  if (cached && cached.station === station.id && ageSeconds(PRED_CACHE) < PRED_TTL_S) {
    // The cached window must still bracket now, or interpolation has nothing to work with.
    const last = cached.extremes[cached.extremes.length - 1];
    if (cached.extremes.length >= 2 && cached.extremes[0].t < now && last.t > now + 6 * 3600 * 1000) {
      return cached;
    }
  }

  const day = 86400000;
  const begin = ymd(new Date(now - day));
  const end = ymd(new Date(now + 2 * day));
  const url =
    `${API}/api/prod/datagetter?product=predictions&application=LifeOS` +
    `&begin_date=${begin}&end_date=${end}&datum=MLLW&station=${station.id}` +
    `&time_zone=gmt&units=metric&interval=hilo&format=json`;

  // A failed fetch falls back to the cache only when it is this station's: another station's tide is not this place's.
  const fallback = cached && cached.station === station.id ? cached : null;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) return fallback;
  const body = (await res.json()) as {
    predictions?: { t: string; v: string; type: "H" | "L" }[];
    error?: { message: string };
  };
  if (body.error || !body.predictions?.length) return fallback;

  const extremes: Extreme[] = body.predictions.map((p) => ({
    t: parseGmt(p.t),
    v: Number(p.v),
    type: p.type,
  }));

  invariant(extremes.length >= 4, `too few tide extremes for ${station.id}: ${extremes.length}`);
  invariant(
    extremes.every((e) => Number.isFinite(e.v)),
    `non-numeric tide height from ${station.id}`,
  );
  invariant(
    extremes.every((e, i) => i === 0 || e.t > extremes[i - 1].t),
    `NOAA extremes out of chronological order for ${station.id}`,
  );

  const preds: Predictions = { station: station.id, name: station.name, fetched: now, extremes };
  writeJson(PRED_CACHE, preds);
  return preds;
}

/**
 * Water level between two extremes, cosine-interpolated — the smooth
 * approximation behind the "rule of twelfths" every tide table uses.
 */
function levelAt(extremes: Extreme[], t: number): number | null {
  for (let i = 0; i < extremes.length - 1; i++) {
    const a = extremes[i];
    const b = extremes[i + 1];
    if (t >= a.t && t <= b.t) {
      const x = (t - a.t) / (b.t - a.t);
      return a.v + (b.v - a.v) * ((1 - Math.cos(Math.PI * x)) / 2);
    }
  }
  return null;
}

function humanDelta(ms: number): string {
  const mins = Math.max(0, Math.round(ms / 60000));
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `${h}h${String(m).padStart(2, "0")}M` : `${m}M`;
}

function emit(json: boolean, payload: object): void {
  if (json) console.log(JSON.stringify(payload));
}

type TideReading =
  | { available: false; reason: string }
  | { available: true; preds: Predictions; level: number; next: Extreme; prev: Extreme | undefined; rising: boolean; eta: string };

async function reading(stationArg?: string): Promise<TideReading> {
  const station: Station | null = stationArg ? { id: stationArg, name: stationArg } : await resolveStation();
  if (!station) return { available: false, reason: "no station in range" };
  const preds = await loadPredictions(station);
  const now = Date.now();
  const level = preds ? levelAt(preds.extremes, now) : null;
  if (!preds || level === null) return { available: false, reason: "no predictions" };
  const next = preds.extremes.find((e) => e.t > now);
  if (!next) return { available: false, reason: "prediction window exhausted" };
  /** The extreme the water is coming from — the left end of the readout. */
  const prev = [...preds.extremes].reverse().find((e) => e.t <= now);
  return { available: true, preds, level, next, prev, rising: next.type === "H", eta: humanDelta(next.t - now) };
}

/**
 * Reads left to right as came from → is now → going to. The arrow already
 * says which way, so the extremes' H/L labels would only repeat it. No sparkline,
 * no arrow: the trailing time is how long until the water reaches the third
 * number (2026-09-24).
 */
function lineOf(r: Extract<TideReading, { available: true }>): string {
  const feet = lengthUnit() === "feet";
  const heights = [r.prev?.v, r.level, r.next.v]
    .filter((v): v is number => v !== undefined)
    .map((v) => (feet ? v * 3.28084 : v).toFixed(1))
    .join("→");
  return `🌊 ${heights}${feet ? "FT" : "M"} in ${r.eta}`;
}

/** The principal's display unit for heights, from PRINCIPAL_IDENTITY.md `preferences`; metres when unset or unreadable. */
function lengthUnit(): "metres" | "feet" {
  try {
    const prefs = getPrincipalPreferences();
    const length = String(prefs.length_unit ?? "").toLowerCase();
    if (length) return /^(ft|feet|foot|imperial)$/.test(length) ? "feet" : "metres";
    return String(prefs.temperature_unit ?? "").toLowerCase() === "fahrenheit" ? "feet" : "metres";
  } catch {
    return "metres";
  }
}

/** The statusline line without the CLI's trailing newline. Empty when there is no station or prediction, and on any failure. */
export async function tideLine(): Promise<string> {
  try {
    const r = await reading();
    return r.available ? lineOf(r) : "";
  } catch {
    return "";
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const wantJson = args.includes("--json");
  const stationIdx = args.indexOf("--station");
  const stationArg = stationIdx >= 0 ? args[stationIdx + 1] : undefined;
  const r = await reading(stationArg);
  if (!r.available) {
    emit(wantJson, { available: false, reason: r.reason });
    return;
  }
  if (wantJson) {
    emit(true, {
      available: true,
      station: r.preds.station,
      name: r.preds.name,
      level: Number(r.level.toFixed(2)),
      direction: r.rising ? "rising" : "falling",
      next: { type: r.next.type, at: new Date(r.next.t).toISOString(), height: r.next.v, in: r.eta },
      extremes: r.preds.extremes.map((e) => ({ type: e.type, at: new Date(e.t).toISOString(), height: e.v })),
    });
    return;
  }
  console.log(lineOf(r));
}

if (import.meta.main) main().catch(() => process.exit(0));
