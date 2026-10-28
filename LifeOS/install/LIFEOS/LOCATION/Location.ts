#!/usr/bin/env bun
/**
 * Location — keeps LifeOS's one answer to "where is the principal" current, from his iPhone.
 *
 *   sync [--json]          pull the newest fix from the Location Worker into current.json (the sync-location workflow, every 5 min)
 *   now [--json]           one plain sentence: where, how long ago, home or away
 *   health                 the Worker's /health answers 200
 *   pair                   new phone bearer; text your own line a one-time setup link (15 min, single use)
 *   pair-device <label>    new Seat bearer for a Mac; text your own line a one-time seat:// setup link
 *   devices [--json]       which Mac or phone he is on now, and how to reach him there (ISC-108, ISC-109)
 *   rotate <write|read>    mint a new bearer, store only its hash in D1, revoke the old one
 *                          write: the Overland setup link goes to the clipboard, never stdout
 *                          read: the bearer goes to the login Keychain
 *
 * Exact coordinates live only in the Worker's D1 and in current.json (0600). Nothing this tool prints, emits or sends to a
 * geocoder carries more than two decimal places (ISC-16, ISC-31). @version 0.1.0
 */
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { invariant } from "../TOOLS/Invariant";
import { lifeosPath } from "../TOOLS/Paths";
import { ageMinutes, type Current, distanceKm, type HomePoint, here, isFresh, locationDir, readConfig, readCurrent, round2, staleHours } from "./Here";

// Vigil and the watches are optional neighbours: this file ships, they may not, so they load at run time when present.
export type VigilEvent = { id: string; source: string; ts: string; kind: "life"; severity: "critical" | "high" | "medium" | "low" | "info"; title: string; summary: string; ref: null; url: null; privacy_class: "personal"; dedup_key: string; meta: Record<string, string> };
function optional<T>(rel: string): T | null { const p = join(import.meta.dir, rel); return existsSync(p) ? (require(p) as T) : null; }

// MAX_SPEED_MS sits above an airliner's ground speed in a jet stream (about 340 m/s), so flight fixes are never held (ISC-140).
export const SYNC_INTERVAL_S = 60, HOME_RADIUS_M = 500, REGEOCODE_KM = 5, JUMP_KM = 5, MAX_SPEED_MS = 400;
export const EVENT_COOLDOWN_MS = 12 * 3_600_000, WORKER_DOWN_AFTER = 3, FETCH_TIMEOUT_MS = 20_000;
const KEYCHAIN_SERVICE = "lifeos-location-read", KEYCHAIN_ACCOUNT = "lifeos";
const WORKER_DIR = resolve(import.meta.dir, "worker");
const USER_AGENT = "LifeOS-Location/0.1 (personal use)";

/** `source` is absent on fixes from a Worker older than 0.3.0, which only ever had the phone. */
export type Fix = { fix_at: string; lat: number; lon: number; accuracy_m: number | null; motion: string | null; battery: number | null; source?: string };
export const PHONE_SOURCE = "overland";
const isPhone = (c: { source?: string }): boolean => (c.source ?? PHONE_SOURCE) === PHONE_SOURCE;
export type Place = { city: string | null; region: string | null; country: string | null; timezone: string | null };
export type State = {
  status?: "fresh" | "stale";
  last_accepted?: { fix_at: string; lat: number; lon: number } | null;
  pending?: { fix_at: string; lat: number; lon: number } | null;
  geocode?: (Place & { lat: number; lon: number }) | null;
  tz?: { current: string | null; candidate: string | null; count: number };
  failures?: number;
  emitted?: Record<string, string>;
  /** The home point's place, geocoded once for desk fixes. */
  home_place?: Place | null;
};
export type Deps = {
  now: Date; dir: string; home: HomePoint; url: string | null; token: string | null;
  fetchImpl: typeof fetch; geocode: (lat: number, lon: number) => Promise<Place>; emit: (e: VigilEvent) => void;
  /** True when someone is using a desktop Mac right now. A desktop never leaves home, so that is a fix at home. */
  atDesk?: () => boolean;
};
export const DESK_SOURCE = "this-mac";

/** The phone's own freshness, from its last accepted fix. A desk fix in current.json never hides a silent phone. */
export function phoneFresh(state: State, now: Date, dir: string): boolean {
  const at = state.last_accepted?.fix_at;
  return !!at && (now.getTime() - Date.parse(at)) / 60_000 <= staleHours(dir) * 60;
}
export type SyncResult = { ok: boolean; state: "fresh" | "stale" | "held" | "no_fix" | "worker_down" | "auth_refused" | "unconfigured"; city: string | null; age_min: number | null; at_home: boolean | null; emitted: string[] };

const statePathOf = (dir: string) => join(dir, "state.json");
export function readState(dir: string): State { try { return JSON.parse(readFileSync(statePathOf(dir), "utf8")) as State; } catch { return {}; } }

/** Atomic 0600 write: temp file then rename, so a reader never sees half a file (ISC-7). */
function writePrivate(path: string, value: unknown): void {
  const body = JSON.stringify(value, null, 2) + "\n";
  invariant(body.length > 2 && path.endsWith(".json"), "a location file is nonempty JSON");
  mkdirSync(resolve(path, ".."), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, body, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

/** Two-decimal geocoding: Nominatim for the place name, Open-Meteo for the IANA zone. Only the rounded point leaves. */
export async function geocode(lat: number, lon: number, fetchImpl: typeof fetch = fetch): Promise<Place> {
  invariant(round2(lat) === lat && round2(lon) === lon, "the geocoder only ever sees a two-decimal point");
  const get = async (u: string) => { const r = await fetchImpl(u, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }); if (!r.ok) throw new Error(`geocoder answered ${r.status}`); return r.json() as Promise<any>; };
  const [osm, meteo] = await Promise.allSettled([
    get(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=10&accept-language=en&lat=${lat}&lon=${lon}`),
    get(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&timezone=auto&forecast_days=1&current=temperature_2m`),
  ]);
  const a = osm.status === "fulfilled" ? (osm.value?.address ?? {}) : {};
  const tz = meteo.status === "fulfilled" && typeof meteo.value?.timezone === "string" && meteo.value.timezone !== "GMT" ? meteo.value.timezone : null;
  const country = a.country_code ? String(a.country_code).toUpperCase() : null;
  // No place on land under the point means water, coastal waters included (a country but no state, as off the Dutch coast):
  // name the sea and whose waters it is (ISC-152).
  const city = a.city ?? a.town ?? a.village ?? a.municipality ?? a.county ?? null;
  const region = a.state ?? a.region ?? (city ? null : await seaDescription(lat, lon, fetchImpl));
  return { city, region, country, timezone: tz };
}

type SeaRecord = { placeType?: unknown; preferredGazetteerName?: unknown; preferredGazetteerNameLang?: unknown; precision?: unknown };
/**
 * A rough description of open water from the Marine Regions gazetteer: the most specific IHO sea area with an English name,
 * and whose 200-mile economic zone it is in ("Gulf of Guinea, Nigerian waters"; "North Atlantic Ocean, international waters").
 * Only IHO sea areas, general sea areas and EEZs are read: other layers match by bounding box and can name a far-off sea.
 */
export function describeSea(records: SeaRecord[]): string | null {
  const english = (r: SeaRecord) => typeof r.preferredGazetteerName === "string" && r.preferredGazetteerNameLang === "English";
  const size = (r: SeaRecord) => (typeof r.precision === "number" ? r.precision : Number.POSITIVE_INFINITY);
  const of = (type: string) => records.filter((r) => r.placeType === type && english(r)).sort((x, y) => size(x) - size(y));
  const sea = (of("IHO Sea Area")[0] ?? of("General Sea Area")[0])?.preferredGazetteerName as string | undefined;
  const eez = of("EEZ")[0]?.preferredGazetteerName as string | undefined;
  const waters = eez ? `${eez.replace(/\s*Exclusive Economic Zone\s*$/i, "")} waters` : "international waters";
  return sea ? `${sea}, ${waters}` : eez ? waters : null;
}

async function seaDescription(lat: number, lon: number, fetchImpl: typeof fetch): Promise<string | null> {
  try {
    const r = await fetchImpl(`https://www.marineregions.org/rest/getGazetteerRecordsByLatLong.json/${lat}/${lon}/`, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    return r.ok ? describeSea((await r.json()) as SeaRecord[]) : null;
  } catch { return null; }
}

function vigilEvent(kind: string, severity: VigilEvent["severity"], title: string, summary: string, now: Date): VigilEvent {
  return { id: randomUUID(), source: "location", ts: now.toISOString(), kind: "life", severity, title, summary, ref: null, url: null, privacy_class: "personal", dedup_key: `location:${kind}:${now.toISOString()}`, meta: { location_event: kind } };
}

/** Emits once per kind per cooldown window, however often the condition flaps (ISC-29). */
function emitOnce(state: State, deps: Deps, kind: string, severity: VigilEvent["severity"], title: string, summary: string, out: string[]): void {
  const last = state.emitted?.[kind] ? Date.parse(state.emitted[kind]!) : 0;
  if (deps.now.getTime() - last < EVENT_COOLDOWN_MS) return;
  deps.emit(vigilEvent(kind, severity, title, summary, deps.now));
  state.emitted = { ...(state.emitted ?? {}), [kind]: deps.now.toISOString() };
  out.push(kind);
}

/**
 * Accept a fix, or hold an impossible jump until a second fix near it confirms the move (ISC-28). The Worker always answers
 * with its newest fix, so an answer older than the accepted one means the Worker no longer holds that fix (deleted or
 * withdrawn), and its answer replaces it with no jump to judge (ISC-159).
 */
export function judgeFix(state: State, fix: Fix): "new" | "same" | "held" {
  const last = state.last_accepted;
  if (last && Date.parse(fix.fix_at) === Date.parse(last.fix_at)) return "same";
  if (last && Date.parse(fix.fix_at) < Date.parse(last.fix_at)) { state.pending = null; return "new"; }
  if (last) {
    const km = distanceKm(last, fix), seconds = Math.max(1, (Date.parse(fix.fix_at) - Date.parse(last.fix_at)) / 1000);
    if (km > JUMP_KM && (km * 1000) / seconds > MAX_SPEED_MS) {
      const p = state.pending;
      if (p && Date.parse(fix.fix_at) > Date.parse(p.fix_at) && distanceKm(p, fix) <= JUMP_KM) return "new";
      if (!p || Date.parse(fix.fix_at) > Date.parse(p.fix_at)) state.pending = { fix_at: fix.fix_at, lat: fix.lat, lon: fix.lon };
      return "held";
    }
  }
  return "new";
}

/** The zone moves only after two consecutive syncs agree on it (ISC-34). */
export function settleTimezone(state: State, seen: string | null): string | null {
  const tz = state.tz ?? { current: null, candidate: null, count: 0 };
  if (!seen) { state.tz = tz; return tz.current; }
  if (tz.current === null) state.tz = { current: seen, candidate: null, count: 0 };
  else if (seen === tz.current) state.tz = { ...tz, candidate: null, count: 0 };
  else if (seen === tz.candidate && tz.count + 1 >= 2) state.tz = { current: seen, candidate: null, count: 0 };
  else state.tz = { current: tz.current, candidate: seen, count: seen === tz.candidate ? tz.count + 1 : 1 };
  return state.tz.current;
}

/** A fix at home stamped now, from a desktop Mac in use. The home place is geocoded once and kept in state. */
async function writeDeskFix(state: State, deps: Deps): Promise<void> {
  if (!state.home_place) {
    try { state.home_place = await deps.geocode(round2(deps.home.lat), round2(deps.home.lon)); } catch { state.home_place = null; }
  }
  const p = state.home_place ?? { city: deps.home.name ?? "Home", region: null, country: null, timezone: null };
  const current: Current = {
    source: DESK_SOURCE, lat: deps.home.lat, lon: deps.home.lon, accuracy_m: null, fix_at: deps.now.toISOString(), synced_at: deps.now.toISOString(),
    city: p.city, region: p.region, country: p.country, timezone: deps.home.timezone ?? p.timezone,
    distance_home_km: 0, at_home: true, motion: null, battery: null,
  };
  invariant(Math.abs(current.lat) <= 90 && Math.abs(current.lon) <= 180, "a desk fix carries the configured home point");
  writePrivate(join(deps.dir, "current.json"), current);
}

export async function sync(deps: Deps): Promise<SyncResult> {
  const state = readState(deps.dir), emitted: string[] = [];
  // The location-receiving check may already have texted; its record joins this cooldown.
  state.emitted = mergeEmitted(state.emitted, readReceiving(deps.dir).emitted);
  const result = async (s: SyncResult["state"], ok = true): Promise<SyncResult> => {
    const fresh = phoneFresh(state, deps.now, deps.dir);
    // A desktop Mac in use means he is at home now: home replaces a stale fix, and always replaces a plane, since he
    // cannot be on a flight and at his desk at once (ISC-153, ISC-157).
    if (deps.atDesk?.() && (!fresh || readCurrent(deps.dir)?.source === "flight")) await writeDeskFix(state, deps);
    const c = readCurrent(deps.dir);
    if (!fresh && state.status !== "stale" && (c || s === "no_fix")) {
      state.status = "stale";
      // High, so it reaches the principal's phone as a text: a silent phone means every place-aware part is guessing.
      emitOnce(state, deps, "stale", "high", "iPhone location is stale", `No usable location from the iPhone for more than ${readConfig(deps.dir).stale_hours ?? 6} hours. Everything keeps the last known place until it reports again. Check that Overland is still tracking.`, emitted);
    } else if (fresh && state.status === "stale") {
      state.status = "fresh";
      emitOnce(state, deps, "recovered", "low", "iPhone location is back", `The iPhone is reporting again${c?.city ? `, from ${c.city}` : ""}. Watches follow it again.`, emitted);
    } else if (fresh) state.status = "fresh";
    writePrivate(statePathOf(deps.dir), state);
    const seen = c && isFresh(c, deps.now, deps.dir) ? c : null;
    return { ok, state: fresh || s !== "fresh" ? s : "stale", city: seen?.city ?? null, age_min: c ? ageMinutes(c, deps.now) : null, at_home: seen?.at_home ?? null, emitted };
  };
  if (!deps.url || !deps.token) return result("unconfigured", false);

  let res: Response | null = null;
  try { res = await deps.fetchImpl(`${deps.url.replace(/\/$/, "")}/latest`, { headers: { Authorization: `Bearer ${deps.token}` }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }); } catch { res = null; }
  if (!res || res.status >= 500) {
    state.failures = (state.failures ?? 0) + 1;
    if (state.failures >= WORKER_DOWN_AFTER) emitOnce(state, deps, "worker_down", "medium", "Location Worker is not answering", `The Location Worker failed ${state.failures} syncs in a row${res ? ` (HTTP ${res.status})` : ""}. The last known location is kept until it goes stale.`, emitted);
    return result("worker_down", false);
  }
  state.failures = 0;
  if (res.status === 401 || res.status === 403) {
    emitOnce(state, deps, "auth_refused", "high", "Location Worker refused this Mac's read token", "The Location Worker refused the read bearer. Run `bun LIFEOS/LOCATION/Location.ts rotate read` to mint a new one.", emitted);
    return result("auth_refused", false);
  }
  if (!res.ok) return result("worker_down", false);
  const body = (await res.json().catch(() => null)) as { point?: Fix | null } | null;
  const fix = body?.point ?? null;
  // A point with no accuracy (Overland's 0,0 placeholder) is not a fix, whatever the Worker stored (ISC-42).
  if (!fix || typeof fix.lat !== "number" || typeof fix.lon !== "number" || !Number.isFinite(Date.parse(fix.fix_at)) || fix.accuracy_m === null) return result("no_fix");

  const verdict = judgeFix(state, fix);
  if (verdict === "held") return result("held");
  if (verdict === "new") {
    state.last_accepted = { fix_at: fix.fix_at, lat: fix.lat, lon: fix.lon };
    state.pending = null;
    const lat2 = round2(fix.lat), lon2 = round2(fix.lon), g = state.geocode;
    if (!g || distanceKm(g, { lat: lat2, lon: lon2 }) > REGEOCODE_KM) {
      try { state.geocode = { ...(await deps.geocode(lat2, lon2)), lat: lat2, lon: lon2 }; } catch { state.geocode = g ?? null; }
    }
  }
  const place = state.geocode ?? { city: null, region: null, country: null, timezone: null };
  const timezone = settleTimezone(state, place.timezone);
  const accepted = state.last_accepted!;
  const prior = readCurrent(deps.dir);
  const source = verdict === "new" ? fix : prior && prior.fix_at === accepted.fix_at ? prior : fix;
  const homeKm = distanceKm(deps.home, accepted);
  const current: Current = {
    source: (source as { source?: string }).source ?? PHONE_SOURCE, lat: accepted.lat, lon: accepted.lon, accuracy_m: source.accuracy_m ?? null, fix_at: accepted.fix_at, synced_at: deps.now.toISOString(),
    // A flight fix always shows ✈ and the plane's position, so it visibly moves every minute; the place below it, when there
    // is one, goes where the region goes. A place name alone can hold still for the half hour it takes to cross one region (ISC-147).
    ...((source as { source?: string }).source === "flight"
      ? { city: `✈ ${flightLabel(accepted)}`, region: place.city ?? place.region }
      : { city: place.city, region: place.region }),
    country: place.country, timezone,
    distance_home_km: Math.round(homeKm * 10) / 10, at_home: homeKm * 1000 <= (readConfig(deps.dir).home_radius_m ?? HOME_RADIUS_M), motion: source.motion ?? null, battery: source.battery ?? null,
  };
  invariant(Math.abs(current.lat) <= 90 && Math.abs(current.lon) <= 180 && Number.isFinite(Date.parse(current.fix_at)), "current.json carries an in-range point and a real fix time");
  writePrivate(join(deps.dir, "current.json"), current);
  return result("fresh");
}

// ── wiring ──────────────────────────────────────────────────────────────────

function homeFromPlaces(): HomePoint {
  const watches = optional<{ loadPlaces: () => { home: HomePoint } }>("../WATCHES/lib/config.ts");
  const h = watches?.loadPlaces().home ?? readConfig(locationDir()).home;
  invariant(h, "a home point is configured: the watches' places file, or `home` in USER/LOCATION/config.json");
  return { name: h.name, lat: h.lat, lon: h.lon, timezone: h.timezone };
}

function keychainToken(): string | null {
  if (process.env.LOCATION_READ_TOKEN) return process.env.LOCATION_READ_TOKEN;
  try { return execFileSync("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null; } catch { return null; }
}

function writeSyncHeartbeat(now: Date, ok: boolean): void {
  const body = { source: "location-sync", ts: now.toISOString(), interval_seconds: SYNC_INTERVAL_S, ok };
  invariant(Number.isFinite(Date.parse(body.ts)), "a heartbeat carries a timestamp");
  const state = optional<{ statePath: (...p: string[]) => string; writeJson: (p: string, v: unknown) => void }>("../VIGIL/State.ts");
  if (state) state.writeJson(state.statePath("heartbeats", "location-sync.json"), body);
}

/** The sync writes state.json every run, so its age past this means the sync itself has stopped. */
export const SYNC_DOWN_MIN = 10;
export type ReceivingResult = { ok: boolean; fix_age_min: number | null; source: string | null; sync_age_min: number | null; problems: string[]; emitted: string[] };

/** The check keeps its own record so it never touches state.json, whose age is how it knows the sync is alive. */
const receivingPathOf = (dir: string) => join(dir, "receiving.json");
export function readReceiving(dir: string): Pick<State, "emitted"> { try { return JSON.parse(readFileSync(receivingPathOf(dir), "utf8")) as State; } catch { return {}; } }

/** The later of two emission times per kind, so the sync and the check share one cooldown and a quiet phone texts once. */
function mergeEmitted(a: Record<string, string> = {}, b: Record<string, string> = {}): Record<string, string> {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) if (!out[k] || Date.parse(v) > Date.parse(out[k]!)) out[k] = v;
  return out;
}

/**
 * The watch on the service from outside the sync (the `location-receiving` workflow): is a fix still arriving, and is
 * the sync still running? A sync that has stopped cannot report its own silence, so this runs on its own clock.
 */
export function checkReceiving(deps: Pick<Deps, "now" | "dir" | "emit">): ReceivingResult {
  const own = readReceiving(deps.dir), emitted: string[] = [], problems: string[] = [];
  const record: State = { emitted: mergeEmitted(readState(deps.dir).emitted, own.emitted) };
  const c = readCurrent(deps.dir), city = c?.city ?? null;
  let syncAt: number | null = null;
  try { syncAt = statSync(statePathOf(deps.dir)).mtimeMs; } catch { syncAt = null; }
  const syncAge = syncAt === null ? null : Math.floor((deps.now.getTime() - syncAt) / 60_000);
  const hours = readConfig(deps.dir).stale_hours ?? 6;
  if (syncAge === null || syncAge > SYNC_DOWN_MIN) {
    problems.push("sync_down");
    emitOnce(record, deps as Deps, "sync_down", "high", "Location sync has stopped", `The sync-location workflow has not run for ${syncAge === null ? "an unknown time" : `${syncAge} minutes`}, so nothing is reading the iPhone's location. Check \`workflow runs sync-location\`.`, emitted);
  }
  if (!phoneFresh(readState(deps.dir), deps.now, deps.dir)) {
    problems.push("stale");
    emitOnce(record, deps as Deps, "stale", "high", "iPhone location is stale", `No usable location from the iPhone for more than ${hours} hours${city ? `; the last fix was ${city}` : ""}. Check that Overland is still tracking.`, emitted);
  }
  if (emitted.length) writePrivate(receivingPathOf(deps.dir), { emitted: record.emitted });
  return { ok: problems.length === 0, fix_age_min: c ? ageMinutes(c, deps.now) : null, source: c?.source ?? null, sync_age_min: syncAge, problems, emitted };
}

export function liveDeps(now = new Date()): Deps {
  const dir = locationDir();
  return { now, dir, home: homeFromPlaces(), url: readConfig(dir).url ?? null, token: keychainToken(), fetchImpl: fetch, geocode: (a, b) => geocode(a, b), emit: writeLocationEvent,
    atDesk: () => isDesktopMac() && (localIdleMinutes() ?? Infinity) < ACTIVE_IDLE_MIN };
}

/** A Mac with no internal battery is a desktop, and a desktop stays at home. A Mac Studio still lists an empty
 * AppleSmartBattery node in ioreg, so the test is pmset's battery list, which names `InternalBattery` only on a laptop. */
export function isDesktopMac(): boolean {
  if (process.platform !== "darwin") return false;
  try { return !/InternalBattery/.test(execFileSync("pmset", ["-g", "batt"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000 })); } catch { return false; }
}

/** Location events go to STATVS writeEvent (migration design §2.1); it never throws on a refusal, so one is logged. Absent STATVS, nothing is written. */
function writeLocationEvent(e: VigilEvent): void {
  const sent = optional<{ writeEvent: (e: VigilEvent) => { ok: boolean; refused?: string } }>("../STATVS/index.ts")?.writeEvent(e);
  if (sent && !sent.ok) console.error(`location: STATVS refused the ${e.meta.location_event} event: ${sent.refused}`);
}

/** "Springfield, Illinois, 4 minutes ago, away from home." Never a coordinate. */
export function sentence(c: Current | null, now: Date, home: HomePoint, dir: string): string {
  if (!c) return "I have no location from the iPhone yet.";
  const age = ageMinutes(c, now);
  const ago = age < 1 ? "just now" : age < 90 ? `${age} minute${age === 1 ? "" : "s"} ago` : age < 48 * 60 ? `${Math.round(age / 60)} hours ago` : `${Math.round(age / 1440)} days ago`;
  const where = [c.city, c.region].filter(Boolean).join(", ") || "an unnamed place";
  const status = c.at_home ? "at home" : `away from home, ${Math.round(c.distance_home_km ?? distanceKm(home, c))} km out`;
  const from = isPhone(c) ? "" : ` from the ${c.source}`;
  return isFresh(c, now, dir) ? `${where}, ${ago}${from}, ${status}.` : `Last fix was ${where}, ${ago}${from}. That is stale, so everything is using that last known place.`;
}

/** Hash-only token write through CfEnv, run from the Worker dir so it reads the D1 binding from cloudflare.config.ts. */
export function tokenUpsertSql(name: string, hash: string, scope: "write" | "read"): string {
  invariant(/^[a-f0-9]{64}$/.test(hash) && /^[a-z]+$/.test(name), "only a sha256 hex hash and a plain name go into the token SQL");
  return `INSERT INTO tokens (name, token_hash, scope) VALUES ('${name}', '${hash}', '${scope}') ON CONFLICT(name) DO UPDATE SET token_hash = excluded.token_hash, scope = excluded.scope`;
}
const sha256 = (v: string) => new Bun.CryptoHasher("sha256").update(v).digest("hex");

export const PAIRING_TTL_MS = 15 * 60_000;
/**
 * A one-time phone setup (ISC-40): a fresh write bearer, the Overland link that carries it, and a short code whose hash the
 * Worker keys the link by. The text names only `<url>/setup/<code>`; the bearer itself never enters a message.
 */
export function pairing(url: string, now: Date): { code: string; token: string; link: string; expires_at: string; sql: string; text: string } {
  const base = url.replace(/\/$/, ""), token = randomBytes(32).toString("base64url"), code = randomBytes(12).toString("base64url");
  const link = `overland://setup?url=${encodeURIComponent(base + "/overland")}&token=${encodeURIComponent(token)}&device_id=iphone`;
  const expires_at = new Date(now.getTime() + PAIRING_TTL_MS).toISOString();
  invariant(/^overland:\/\/setup\?[A-Za-z0-9%._~=&-]+$/.test(link) && /^[A-Za-z0-9_-]{16}$/.test(code), "the pairing link and code carry only URL-safe characters, so the SQL needs no escaping");
  const sql = `INSERT INTO pairings (code_hash, link, expires_at) VALUES ('${sha256(code)}', '${link}', '${expires_at}')`;
  const { textCard } = require("../TOOLS/TextFormat.ts") as { textCard: (c: { kind: string; title: string; body: string[]; url?: string }) => string };
  const text = textCard({ kind: "default", title: "LifeOS location setup", body: ["Install Overland from the App Store and allow location Always.", "Then open the link below on the iPhone: it fills in the server and key, works once, and expires in 15 minutes.", "In Overland: tracking Both, accuracy 100 m, send every 5 minutes."], url: `${base}/setup/${code}` });
  return { code, token, link, expires_at, sql, text };
}

/**
 * The D1 query tool pair and rotate shell out to: config.json `d1_tool`, a CLI run as `<tool> d1 query <database-id> --sql <sql>`.
 * No such tool ships with LifeOS, so on an install without one these two commands stop here with the setting to add.
 */
function d1Tool(): string {
  const raw = (readConfig() as { d1_tool?: unknown }).d1_tool;
  const tool = typeof raw === "string" && raw.startsWith("~/") ? join(process.env.HOME ?? "", raw.slice(2)) : raw;
  if (typeof tool !== "string" || !tool || !existsSync(tool)) throw new Error("pair and rotate need a D1 query tool: set d1_tool in LIFEOS/USER/LOCATION/config.json to a CLI run as `<tool> d1 query <database-id> --sql <sql>`");
  return tool;
}

/** Mint a phone bearer and text the principal's own line a one-time setup link (Relay Send contract: own line from the 0600 bridge config, never typed). */
async function pair(): Promise<void> {
  const url = readConfig().url;
  if (!url) throw new Error("set url in LIFEOS/USER/LOCATION/config.json first");
  const dbId = /id:\s*"([0-9a-f-]{36})"/.exec(readFileSync(join(WORKER_DIR, "cloudflare.config.ts"), "utf8"))?.[1];
  if (!dbId) throw new Error("no D1 id in worker/cloudflare.config.ts");
  const cf = d1Tool(), p = pairing(url, new Date());
  execFileSync("bun", [cf, "d1", "query", dbId, "--sql", tokenUpsertSql("phone", sha256(p.token), "write")], { cwd: WORKER_DIR, stdio: ["ignore", "ignore", "inherit"] });
  execFileSync("bun", [cf, "d1", "query", dbId, "--sql", p.sql], { cwd: WORKER_DIR, stdio: ["ignore", "ignore", "inherit"] });
  const cfg = JSON.parse(readFileSync(lifeosPath("USER", "RELAY", "state", "bridge-config.json"), "utf8"));
  const own = cfg.ownChannels?.numbers;
  if (!Array.isArray(own) || own.length !== 1) throw new Error("the Relay bridge config has no single own line");
  execFileSync("bun", [lifeosPath("RELAY", "bridge", "send.ts"), own[0], p.text, "--origin", "requested"], { stdio: ["ignore", "ignore", "inherit"] });
  console.log(`Phone bearer rotated (the old one is revoked). A one-time setup link went to your line; it expires at ${p.expires_at}.`);
}

async function rotate(kind: "write" | "read"): Promise<void> {
  const dbId = /id:\s*"([0-9a-f-]{36})"/.exec(readFileSync(join(WORKER_DIR, "cloudflare.config.ts"), "utf8"))?.[1];
  if (!dbId) throw new Error("no D1 id in worker/cloudflare.config.ts");
  const cf = d1Tool(), token = randomBytes(32).toString("base64url"), name = kind === "write" ? "phone" : "mac";
  execFileSync("bun", [cf, "d1", "query", dbId, "--sql", tokenUpsertSql(name, sha256(token), kind)], { cwd: WORKER_DIR, stdio: ["ignore", "ignore", "inherit"] });
  if (kind === "read") {
    execFileSync("security", ["add-generic-password", "-U", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w", token], { stdio: "ignore" });
    console.log("Read bearer rotated; the new one is in the login Keychain and the old one is revoked.");
    return;
  }
  const url = readConfig().url;
  if (!url) throw new Error("set url in LIFEOS/USER/LOCATION/config.json first");
  const link = `overland://setup?url=${encodeURIComponent(url.replace(/\/$/, "") + "/overland")}&token=${encodeURIComponent(token)}&device_id=iphone`;
  execFileSync("pbcopy", [], { input: link });
  console.log("Write bearer rotated and the old one is revoked. The Overland setup link is on the clipboard (Universal Clipboard reaches the iPhone): paste it into Safari on the phone and open it.");
}

// ── flight: the Mac hands the Worker a flight number from email, once per flight (ISC-143) ─────

/**
 * Flight numbers mentioned in email text, most mentioned first. A flight number never starts with 0, and a code right
 * after "gate", "seat", "terminal", "zone", "group" or "row" is a place in the airport or the cabin, not a flight.
 */
export function flightIdents(text: string): string[] {
  const counts = new Map<string, number>();
  for (const m of text.matchAll(/\b([A-Z]{2}|[A-Z]\d|\d[A-Z])\s?([1-9]\d{0,3})\b/g)) {
    if (m[1] === "AM" || m[1] === "PM") continue;
    // Only a code right after the word: "Gate G10", "Seat: 12A". Text after a line break ("new gate" then the flight) still counts.
    if (/\b(gate|seat|terminal|zone|group|row)s?:? ?#?$/i.test(text.slice(Math.max(0, m.index - 16), m.index))) continue;
    const id = m[1] + m[2];
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

/** The words a person sees in an HTML email: style blocks, CSS and HTML comments, and tags removed (airline mail carries CSS comments like B01). */
export function mailText(html: string): string {
  return html.replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/\/\*[\s\S]*?\*\//g, " ").replace(/<!--[\s\S]*?-->/g, " ").replace(/<[^>]+>/g, " ");
}

/** Trip organizers repeat a booking second-hand and keep a changed one; the airline's own mail is the record (an organizer can still show the original flight after the airline rebooks it). */
export const SECOND_HAND_SENDERS = /@(?:[a-z0-9-]+\.)*(?:tripit|tripcase|kayak|expedia|booking|hopper|google)\.com\b/i;
export type FlightMail = { from: string; date: string; text: string };

/** Flight numbers across emails, best first: any first-hand (airline) mention beats second-hand only, then the newest mention, then the most mentioned. */
export function rankFlightIdents(mails: FlightMail[]): string[] {
  const seen = new Map<string, { firstHand: boolean; at: number; n: number }>();
  for (const m of mails) {
    const firstHand = !SECOND_HAND_SENDERS.test(m.from), at = Date.parse(m.date) || 0;
    for (const id of flightIdents(m.text)) {
      const s = seen.get(id) ?? { firstHand: false, at: 0, n: 0 };
      // A first-hand mention resets the clock to first-hand time, so a newer organizer alert never lifts a number above the airline's.
      if (firstHand && !s.firstHand) seen.set(id, { firstHand: true, at, n: s.n + 1 });
      else seen.set(id, { firstHand: s.firstHand, at: firstHand === s.firstHand ? Math.max(s.at, at) : s.at, n: s.n + 1 });
    }
  }
  return [...seen.entries()].sort(([, a], [, b]) => Number(b.firstHand) - Number(a.firstHand) || b.at - a.at || b.n - a.n).map(([id]) => id);
}

/** The plane's position as the statusline shows it over open water: two decimals, about a kilometre ("59.30°N 11.24°W"). */
export function flightLabel(p: { lat: number; lon: number }): string {
  return `${Math.abs(p.lat).toFixed(2)}°${p.lat >= 0 ? "N" : "S"} ${Math.abs(p.lon).toFixed(2)}°${p.lon >= 0 ? "E" : "W"}`;
}

/** A flight number is offered for this long; the Worker narrows it to the real arrival once it finds the flight in the air. */
export const FLIGHT_OFFER_MS = 20 * 3_600_000, FLIGHT_SCAN_EVERY_MS = 30 * 60_000, PHONE_QUIET_MIN = 10;
export type FlightState = { idents: string[]; until: string | null; scanned_at: string | null };

/**
 * The upsert that hands a flight number to the Worker. A row for the same number from an earlier, finished trip is reset;
 * one still running is left alone. Values are checked to a safe charset, so the SQL needs no escaping.
 */
export function flightOfferSql(ident: string, now: Date): string {
  const set = now.toISOString(), ends = new Date(now.getTime() + FLIGHT_OFFER_MS).toISOString();
  invariant(/^[A-Z0-9]{2,8}$/.test(ident) && Date.parse(ends) > Date.parse(set), "a flight number is a short code and its offer ends after it starts");
  return `INSERT INTO flights (ident, set_at, ends_at, done) VALUES ('${ident}', '${set}', '${ends}', 0) ON CONFLICT(ident) DO UPDATE SET set_at = excluded.set_at, ends_at = excluded.ends_at, done = 0, fa_flight_id = NULL, checked_at = NULL WHERE flights.done = 1 OR flights.ends_at < excluded.set_at`;
}

/**
 * Whether this sync should read email for a flight (ISC-143, ISC-146): never while an offer is still running (once per flight),
 * never while the phone is reporting (iPhone first), and at most every half hour otherwise.
 */
export function shouldScanForFlight(state: FlightState, current: Current | null, now: Date, atDesk = false): boolean {
  // At a desktop Mac he is home, not in the air (ISC-157).
  if (atDesk) return false;
  if (state.until && Date.parse(state.until) > now.getTime()) return false;
  if (current && isPhone(current) && ageMinutes(current, now) < PHONE_QUIET_MIN) return false;
  return !state.scanned_at || now.getTime() - Date.parse(state.scanned_at) >= FLIGHT_SCAN_EVERY_MS;
}

/**
 * Hand the Worker a flight number from email when the phone has gone quiet. The Mac holds no FlightAware key: the Worker
 * decides whether the number is in the air and tracks it. `ident` (from `Location.ts flight <IDENT>`) skips the email read.
 */
async function offerFlight(ident: string | undefined, force: boolean): Promise<string> {
  const dir = locationDir(), statePath = join(dir, "flight.json"), now = new Date();
  const state: FlightState = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { idents: [], until: null, scanned_at: null };
  const atDesk = isDesktopMac() && (localIdleMinutes() ?? Infinity) < ACTIVE_IDLE_MIN;
  if (!ident && !force && !shouldScanForFlight(state, readCurrent(dir), now, atDesk)) return "skip";
  let idents = ident ? [ident.toUpperCase().replace(/\s+/g, "")] : [];
  if (!ident) {
    const gmail = lifeosPath("TOOLS", "gmail.ts");
    const q = "newer_than:2d (subject:flight OR subject:gate OR subject:boarding OR subject:\"check in\" OR subject:itinerary OR subject:\"your trip\")";
    const rows = execFileSync("bun", [gmail, "list", q, "5"], { encoding: "utf8", timeout: 30_000 }).split("\n").filter(Boolean).map((l) => JSON.parse(l) as { id: string; from?: string; date?: string; subject?: string; snippet?: string });
    const mails = rows.map((r) => ({ from: r.from ?? "", date: r.date ?? "", text: `${r.subject ?? ""} ${r.snippet ?? ""} ${mailText(execFileSync("bun", [gmail, "body", r.id], { encoding: "utf8", timeout: 30_000 }))}` }));
    idents = rankFlightIdents(mails).slice(0, 2);
  }
  if (idents.length === 0) { writePrivate(statePath, { ...state, scanned_at: now.toISOString() }); return "no_flight_in_email"; }
  const dbId = /id:\s*"([0-9a-f-]{36})"/.exec(readFileSync(join(WORKER_DIR, "cloudflare.config.ts"), "utf8"))?.[1];
  if (!dbId) throw new Error("no D1 id in worker/cloudflare.config.ts");
  const cf = d1Tool();
  // The best number gets the newest set_at, so the Worker checks it first.
  idents.forEach((id, i) => execFileSync("bun", [cf, "d1", "query", dbId, "--sql", flightOfferSql(id, new Date(now.getTime() - i))], { cwd: WORKER_DIR, stdio: ["ignore", "ignore", "inherit"], timeout: 60_000 }));
  writePrivate(statePath, { idents, until: new Date(now.getTime() + FLIGHT_OFFER_MS).toISOString(), scanned_at: now.toISOString() } satisfies FlightState);
  return `offered ${idents.join(", ")}`;
}

// ── presence: which device he is on, and how to reach him there (F7) ─────────

export type DeviceRow = { device: string; idle_s: number; locked: number; version: string | null; reported_at: string };
export type Device = { name: string; kind: "this-mac" | "mac" | "phone" | "unknown"; signal: string; age_min: number | null };
export type Reach = { channel: "open" | "pulse" | "share" | "text"; for: "files" | "pages" | "urgent" | "anything"; how: string; url?: string };
export const PRESENCE_FRESH_MIN = 5, ACTIVE_IDLE_MIN = 10, PHONE_FRESH_MIN = 15;

/** Minutes since this Mac last saw keyboard or mouse input, or null off macOS. */
export function localIdleMinutes(): number | null {
  if (process.platform !== "darwin") return null;
  try {
    const out = execFileSync("ioreg", ["-c", "IOHIDSystem"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000 });
    const m = /"HIDIdleTime"\s*=\s*(\d+)/.exec(out);
    return m ? Math.floor(Number(m[1]) / 1e9 / 60) : null;
  } catch { return null; }
}

/** Which device he is on (ISC-108): this Mac if its keyboard is live, else the freshest active Seat report, else a fresh phone fix. */
export function pickDevice(o: { now: Date; localIdleMin: number | null; devices: DeviceRow[]; current: Current | null }): Device {
  if (o.localIdleMin !== null && o.localIdleMin < ACTIVE_IDLE_MIN) return { name: "this-mac", kind: "this-mac", signal: `keyboard used ${o.localIdleMin} min ago`, age_min: 0 };
  const live = o.devices
    .map((d) => ({ d, age: (o.now.getTime() - Date.parse(d.reported_at)) / 60_000 }))
    .filter(({ d, age }) => age >= 0 && age < PRESENCE_FRESH_MIN && d.idle_s < ACTIVE_IDLE_MIN * 60 && !d.locked)
    .sort((a, b) => a.d.idle_s - b.d.idle_s);
  if (live[0]) return { name: live[0].d.device, kind: "mac", signal: `Seat: idle ${Math.round(live[0].d.idle_s / 60)} min, reported ${Math.round(live[0].age)} min ago`, age_min: Math.round(live[0].age) };
  // Only the phone's own fix says he is on the phone; a Mac's fix says where a Mac is (ISC-123).
  if (o.current && isPhone(o.current)) {
    const age = ageMinutes(o.current, o.now);
    if (age < PHONE_FRESH_MIN) return { name: "phone", kind: "phone", signal: `iPhone fix ${age} min ago, no Mac in use`, age_min: age };
  }
  return { name: "unknown", kind: "unknown", signal: "no Mac in use and no fresh phone fix", age_min: null };
}

/** How to get something to him on that device (ISC-109), first channel first. Pulse URLs come from config.json `reach`. */
export function reachFor(device: Device, cfg: { pulse_local_url?: string; pulse_tailnet_url?: string } = {}): Reach[] {
  const share: Reach = { channel: "share", for: "files", how: "upload through the share service and put the link in the answer" };
  const text: Reach = { channel: "text", for: "urgent", how: "Relay text to his own line" };
  if (device.kind === "this-mac") return [
    { channel: "open", for: "anything", how: "open it on this Mac" },
    { channel: "pulse", for: "pages", how: "Pulse on this Mac", url: cfg.pulse_local_url ?? "http://localhost:31337" },
    share,
  ];
  if (device.kind === "mac") return [
    ...(cfg.pulse_tailnet_url ? [{ channel: "pulse", for: "pages", how: "Pulse over the tailnet", url: cfg.pulse_tailnet_url } as Reach] : []),
    share,
    text,
  ];
  return [share, text];
}

function readDevices(dir: string): DeviceRow[] {
  try { const j = JSON.parse(readFileSync(join(dir, "devices.json"), "utf8")) as { devices?: DeviceRow[] }; return Array.isArray(j.devices) ? j.devices : []; } catch { return []; }
}

/** Pull every Seat report into devices.json (ISC-114). A failure leaves the last file in place. */
export async function syncPresence(deps: Deps): Promise<boolean> {
  if (!deps.url || !deps.token) return false;
  try {
    const res = await deps.fetchImpl(`${deps.url.replace(/\/$/, "")}/presence`, { headers: { Authorization: `Bearer ${deps.token}` }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return false;
    const body = (await res.json()) as { devices?: DeviceRow[] };
    if (!Array.isArray(body.devices)) return false;
    writePrivate(join(deps.dir, "devices.json"), { synced_at: deps.now.toISOString(), devices: body.devices });
    return true;
  } catch { return false; }
}

export function devicesRecord(now: Date = new Date(), dir: string = locationDir(), localIdleMin: number | null = localIdleMinutes()): { device: Device; reach: Reach[] } {
  const device = pickDevice({ now, localIdleMin, devices: readDevices(dir), current: readCurrent(dir) });
  return { device, reach: reachFor(device, (readConfig(dir) as { reach?: { pulse_local_url?: string; pulse_tailnet_url?: string } }).reach ?? {}) };
}

export const SEAT_LABEL = /^[a-z0-9][a-z0-9-]{0,31}$/;
/** A one-time Seat setup (ISC-115): the seat:// link carries the bearer; only `<url>/setup/<code>` is ever texted. */
export function devicePairing(url: string, label: string, now: Date): { code: string; token: string; link: string; expires_at: string; tokenSql: string; pairingSql: string } {
  invariant(SEAT_LABEL.test(label), "a device label is lowercase letters, digits and dashes");
  invariant(label !== PHONE_SOURCE && label !== "flight", `"${label}" names the phone's or the plane's fixes, so no Mac may be paired under it`);
  const base = url.replace(/\/$/, ""), token = randomBytes(32).toString("base64url"), code = randomBytes(12).toString("base64url");
  const link = `seat://setup?url=${encodeURIComponent(base + "/presence")}&token=${encodeURIComponent(token)}&device=${label}`;
  const expires_at = new Date(now.getTime() + PAIRING_TTL_MS).toISOString();
  invariant(/^seat:\/\/setup\?[A-Za-z0-9%._~=&-]+$/.test(link) && /^[A-Za-z0-9_-]{16}$/.test(code), "the Seat link and code carry only URL-safe characters, so the SQL needs no escaping");
  const tokenSql = `INSERT INTO device_tokens (device, token_hash) VALUES ('${label}', '${sha256(token)}') ON CONFLICT(device) DO UPDATE SET token_hash = excluded.token_hash`;
  const pairingSql = `INSERT INTO pairings (code_hash, link, expires_at) VALUES ('${sha256(code)}', '${link}', '${expires_at}')`;
  return { code, token, link, expires_at, tokenSql, pairingSql };
}

async function pairDevice(label: string): Promise<void> {
  const url = readConfig().url;
  if (!url) throw new Error("set url in LIFEOS/USER/LOCATION/config.json first");
  const dbId = /id:\s*"([0-9a-f-]{36})"/.exec(readFileSync(join(WORKER_DIR, "cloudflare.config.ts"), "utf8"))?.[1];
  if (!dbId) throw new Error("no D1 id in worker/cloudflare.config.ts");
  const cf = d1Tool(), p = devicePairing(url, label, new Date());
  execFileSync("bun", [cf, "d1", "query", dbId, "--sql", p.tokenSql], { cwd: WORKER_DIR, stdio: ["ignore", "ignore", "inherit"] });
  execFileSync("bun", [cf, "d1", "query", dbId, "--sql", p.pairingSql], { cwd: WORKER_DIR, stdio: ["ignore", "ignore", "inherit"] });
  const { textCard } = require("../TOOLS/TextFormat.ts") as { textCard: (c: { kind: string; title: string; body: string[]; url?: string }) => string };
  const text = textCard({ kind: "default", title: `Seat setup for "${label}"`, body: ["Open the link below on that Mac, with Seat installed: it fills in the server and key, works once, and expires in 15 minutes."], url: `${url.replace(/\/$/, "")}/setup/${p.code}` });
  const cfg = JSON.parse(readFileSync(lifeosPath("USER", "RELAY", "state", "bridge-config.json"), "utf8"));
  const own = cfg.ownChannels?.numbers;
  if (!Array.isArray(own) || own.length !== 1) throw new Error("the Relay bridge config has no single own line");
  execFileSync("bun", [lifeosPath("RELAY", "bridge", "send.ts"), own[0], text, "--origin", "requested"], { stdio: ["ignore", "ignore", "inherit"] });
  console.log(`Seat bearer for "${label}" minted (any old one is revoked). A one-time setup link went to your line; it expires at ${p.expires_at}.`);
}

/** The record `now --json` prints: where he is (rounded), flagged `stale` when the fix is old and `fallback` when there is none, with the place names from current.json. */
export function nowRecord(now: Date = new Date(), dir: string = locationDir(), home: HomePoint = homeFromPlaces()): Record<string, unknown> {
  const c = readCurrent(dir), h = here(home, { now, dir });
  return { ...h, source: c?.source ?? null, city: c?.city ?? null, region: c?.region ?? null, country: c?.country ?? null, distance_home_km: c?.distance_home_km ?? null, ...devicesRecord(now, dir) };
}

if (import.meta.main) {
  const [cmd, arg] = process.argv.slice(2), asJson = process.argv.includes("--json");
  if (cmd === "sync") {
    const deps = liveDeps();
    const r = await sync(deps);
    await syncPresence(deps);
    // A failed email read or D1 write never fails the sync; the next run tries again.
    try { await offerFlight(undefined, false); } catch (e) { console.error(`location: flight offer failed: ${e instanceof Error ? e.message : e}`); }
    writeSyncHeartbeat(deps.now, r.ok);
    console.log(JSON.stringify(r));
    process.exit(r.ok || r.state === "unconfigured" ? 0 : 1);
  } else if (cmd === "receiving") {
    console.log(JSON.stringify(checkReceiving(liveDeps())));
  } else if (cmd === "now") {
    const now = new Date(), dir = locationDir(), home = homeFromPlaces(), c = readCurrent(dir);
    if (asJson) console.log(JSON.stringify(nowRecord(now, dir, home)));
    else console.log(sentence(c, now, home, dir));
  } else if (cmd === "health") {
    const url = readConfig().url;
    const status = url ? (await fetch(`${url.replace(/\/$/, "")}/health`).catch(() => null))?.status ?? 0 : 0;
    console.log(url ? `${new URL(url).host} /health ${status}` : "no url in config.json");
    process.exit(status === 200 ? 0 : 1);
  } else if (cmd === "pair") {
    await pair();
  } else if (cmd === "pair-device" && arg && SEAT_LABEL.test(arg)) {
    await pairDevice(arg);
  } else if (cmd === "devices") {
    const r = devicesRecord();
    if (asJson) console.log(JSON.stringify(r));
    else console.log(`On: ${r.device.name} (${r.device.signal}). Reach: ${r.reach.map((x) => x.url ?? x.channel).join(", ")}.`);
  } else if (cmd === "rotate" && (arg === "write" || arg === "read")) {
    await rotate(arg);
  } else if (cmd === "flight") {
    console.log(await offerFlight(arg && !arg.startsWith("--") ? arg : undefined, process.argv.includes("--force")));
  } else {
    console.log("usage: Location.ts sync [--json] | now [--json] | devices [--json] | health | pair | pair-device <label> | rotate <write|read> | flight [IDENT] [--force]");
    process.exit(cmd ? 2 : 0);
  }
}
