import { join } from "node:path";
import { mtime, type Cache } from "../Cache";
import { object, string, TTL, type State } from "../State";
import { acquireLock, type RefreshJob } from "./Background";

const US_STATES: Record<string, string> = {
  "Alabama": "AL", "Alaska": "AK", "Arizona": "AZ", "Arkansas": "AR", "California": "CA", "Colorado": "CO", "Connecticut": "CT", "Delaware": "DE",
  "Florida": "FL", "Georgia": "GA", "Hawaii": "HI", "Idaho": "ID", "Illinois": "IL", "Indiana": "IN", "Iowa": "IA", "Kansas": "KS", "Kentucky": "KY",
  "Louisiana": "LA", "Maine": "ME", "Maryland": "MD", "Massachusetts": "MA", "Michigan": "MI", "Minnesota": "MN", "Mississippi": "MS", "Missouri": "MO",
  "Montana": "MT", "Nebraska": "NE", "Nevada": "NV", "New Hampshire": "NH", "New Jersey": "NJ", "New Mexico": "NM", "New York": "NY",
  "North Carolina": "NC", "North Dakota": "ND", "Ohio": "OH", "Oklahoma": "OK", "Oregon": "OR", "Pennsylvania": "PA", "Rhode Island": "RI",
  "South Carolina": "SC", "South Dakota": "SD", "Tennessee": "TN", "Texas": "TX", "Utah": "UT", "Vermont": "VT", "Virginia": "VA", "Washington": "WA",
  "West Virginia": "WV", "Wisconsin": "WI", "Wyoming": "WY", "District of Columbia": "DC",
};

export const abbreviate = (country: unknown, region: unknown): unknown => (country === "US" && typeof region === "string" ? US_STATES[region] ?? region : region);

/** Open-meteo WMO weather_code to an emoji, by day or night. */
export function weatherIcon(code: number | null, isDay: number | null): string {
  const day = isDay === 1;
  switch (code) {
    case 0: return day ? "☀️" : "🌙";
    case 1: case 2: return day ? "🌤️" : "☁️";
    case 3: return "☁️";
    case 45: case 48: return "🌫️";
    case 51: case 53: case 55: case 56: case 57: case 61: case 63: case 65: case 66: case 67: case 80: case 81: case 82: return "🌧️";
    case 71: case 73: case 75: case 77: case 85: case 86: return "🌨️";
    case 95: case 96: case 99: return "⛈️";
    default: return "🌡️";
  }
}

export interface LocationWeatherDeps {
  fetchImpl: typeof fetch;
  /** The Location system's record (`Location.ts now --json`), or null when it has none. */
  here: () => Record<string, unknown> | null;
  /** Where the Location system keeps current.json. */
  locationDir: string;
}

const coordinates = (cache: Cache): string => {
  const c = object(cache.json("location-cache.json"));
  return cache.text("location-cache.json") === null ? "" : `${c.lat === undefined ? "null" : JSON.stringify(c.lat)},${c.lon === undefined ? "null" : JSON.stringify(c.lon)}`;
};

const numberOnly = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

async function json(fetchImpl: typeof fetch, url: string, ms: number): Promise<unknown> {
  try {
    // curl -s parsed whatever body came back, whatever the status.
    return await (await fetchImpl(url, { signal: AbortSignal.timeout(ms) })).json();
  } catch { return null; }
}

/**
 * Location is refreshed from the Location system's fresh fix, then settings, then IP lookup; a changed
 * place forces fresh weather. One 30-second lock covers both. The cache files keep their bash formats exactly.
 */
export function locationWeatherRefresh(state: State, deps?: Partial<LocationWeatherDeps>): RefreshJob | null {
  const { cache } = state;
  const locationDir = deps?.locationDir ?? state.env.LIFEOS_LOCATION_DIR ?? join(state.root, "USER", "LOCATION");
  const current = join(locationDir, "current.json");
  let locAge = cache.age("location-cache.json");
  if (mtime(current) > 0 && cache.text("location-cache.json") !== null && mtime(current) > mtime(cache.path("location-cache.json"))) locAge = 999999;
  const wxAge = cache.age("weather-cache.json");
  if (!state.weatherEnabled || (locAge <= TTL.location && wxAge <= TTL.weather)) return null;
  const fetchImpl = deps?.fetchImpl ?? fetch;
  return {
    name: "location-weather",
    async run() {
      const lock = acquireLock(cache, "locwx-refresh.lock", 31);
      if (!lock) return;
      try {
        const previous = coordinates(cache);
        let weatherAge = wxAge;
        const record = mtime(current) > 0 ? (deps?.here ? deps.here() : (await import("../../LOCATION/Location")).nowRecord()) : null;
        const city = record === null ? null : record.city ?? record.name ?? null;
        if (record !== null && record.fallback === false && city !== null && city !== "") {
          if (locAge > TTL.location) {
            cache.put("location-cache.json", `${JSON.stringify({
              city, regionName: record.region, region: abbreviate(record.country, record.region), countryCode: record.country,
              lat: record.lat, lon: record.lon, timezone: record.timezone, at_home: record.at_home, source: "lifeos-location",
              // The header draws the fix's age from these at render time (Location ISA ISC-125, ISC-126).
              fix_at: record.fix_at, stale_after_min: (await import("../../LOCATION/Here")).staleHours(locationDir) * 60,
            })}\n`);
          }
        } else if (state.settingsLocation.city) {
          const s = state.settingsLocation;
          const lat = s.lat === "" ? null : Number(s.lat), lon = s.lon === "" ? null : Number(s.lon);
          cache.put("location-cache.json", `${JSON.stringify({ city: s.city, regionName: s.region, countryCode: s.countryCode, lat: Number.isFinite(lat) ? lat : null, lon: Number.isFinite(lon) ? lon : null }, null, 2)}\n`);
        } else if (locAge > TTL.location) {
          const ip = object(await json(fetchImpl, "https://ipinfo.io/json", 3000));
          if (typeof ip.city === "string" && ip.city !== "" && (ip.country !== "US" || typeof ip.region === "string")) {
            const [lat, lon] = string(ip.loc).split(",").map((part) => (part !== "" && Number.isFinite(Number(part)) ? Number(part) : null));
            cache.put("location-cache.json", `${JSON.stringify({ city: ip.city, regionName: ip.region, region: abbreviate(ip.country, ip.region), countryCode: ip.country, lat: lat ?? null, lon: lon ?? null })}\n`);
          }
        }
        // A new place makes the old place's weather wrong, whatever its age.
        if (coordinates(cache) !== previous) weatherAge = 999999;
        const cached = object(cache.json("location-cache.json"));
        if (weatherAge > TTL.weather && cache.text("location-cache.json") !== null) {
          const lat = numberOnly(cached.lat), lon = numberOnly(cached.lon);
          if (lat !== null && lon !== null) {
            const body = object(await json(fetchImpl, `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code,is_day&temperature_unit=${state.tempUnit}`, 4000));
            const currentWeather = object(body.current);
            if (body.current !== undefined && body.current !== null && body.current !== false) {
              const t = numberOnly(currentWeather.temperature_2m);
              const whole = t === null ? "" : String(t).split(".")[0];
              cache.put("weather-cache.json", `${weatherIcon(numberOnly(currentWeather.weather_code), numberOnly(currentWeather.is_day))} ${whole}°${state.tempUnit === "celsius" ? "C" : "F"}\n`);
            }
          }
        }
      } finally { lock.release(); }
    },
  };
}
