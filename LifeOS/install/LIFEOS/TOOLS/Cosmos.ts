#!/usr/bin/env bun
/**
 * Cosmos — how fast we are moving, for the statusline line above the quote.
 *
 * The cosmos Worker does the physics (spin at this latitude, Earth's orbit,
 * the Sun around the galaxy, net speed against the CMB) and adds NOAA's live
 * solar wind and Kp. Spin is left off the statusline: it is the ground
 * turning under you, not Earth moving against anything, so it does not
 * belong with the other speeds. This tool turns its JSON into one segment per line,
 * tab-separated: icon, LABEL, number, UNIT. The statusline colours them and
 * flows them into rows that fit its width, breaking only between segments.
 * Empty output means the Worker is not configured or unreachable; the
 * statusline then shows nothing.
 *
 * Config: LIFEOS/USER/CONFIG/cosmos.json → { "url": "https://…" }.
 * Latitude comes from the statusline's location cache when present, so spin
 * follows the principal; otherwise the Worker uses the request's geo.
 *
 * Usage:
 *   bun Cosmos.ts           # segments: icon<TAB>LABEL<TAB>number<TAB>UNIT
 *   bun Cosmos.ts --json    # the Worker's full JSON, with sources
 *
 * @version 2.0.0
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { lifeosPath } from "./Paths.ts";
import { nextPhase } from "./MoonPhase.ts";

const STATE_DIR =
  process.env.STATUSLINE_LOCAL_STATE ||
  join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "lifeos-statusline");
const LOCATION_CACHE = join(STATE_DIR, "location-cache.json");
const DEADLINE_MS = 5000;

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function baseUrl(): string | null {
  const url = readJson<{ url?: unknown }>(lifeosPath("USER", "CONFIG", "cosmos.json"))?.url;
  return typeof url === "string" && /^https:\/\/[^/\s]+\/?$/.test(url) ? url.replace(/\/$/, "") : null;
}

async function get(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(DEADLINE_MS) });
    return res.ok ? await res.text() : null;
  } catch {
    return null;
  }
}

/** Segment fields reach a bash printf %b, so only these characters survive. */
const SAFE = /^[A-Z0-9 ,.%/→]*$/;
const ICONS = new Set(["☀️", "🌌", "🌠", "💨", "🧲", "🌑", "🌒", "🌓", "🌔", "🌕", "🌖", "🌗", "🌘"]);

type Segment = [icon: string, label: string, num: string, unit: string];

const fmt = (n: number, digits = 0) =>
  n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
/** The Worker's "toward Cygnus" becomes " → CYGNUS"; anything else adds nothing. */
const toward = (d: unknown) =>
  typeof d === "string" && d.startsWith("toward ") ? ` → ${d.slice(7).toUpperCase()}` : "";

/** "IN 3D", or "IN 9H" inside a day. */
const until = (ms: number) => {
  const h = ms / 3_600_000;
  return h < 24 ? `IN ${Math.max(1, Math.round(h))}H` : `IN ${Math.round(h / 24)}D`;
};
const day = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" }).toUpperCase();

/**
 * The Worker's illumination plus local true phases: MOON 19% WANING, then the
 * next new and full moon, the nearer one first. Waxing means full comes first.
 */
function moon(m: { icon: string; illumination: number }, now: Date): Segment[] {
  const next = (["new", "full"] as const)
    .map((kind) => ({ kind, at: nextPhase(now, kind) }))
    .sort((a, b) => a.at.getTime() - b.at.getTime());
  const waxing = next[0].kind === "full";
  return [
    [m.icon, "MOON", `${Math.round(m.illumination * 100)}%`, waxing ? "WAXING" : "WANING"],
    ...next.map(({ kind, at }): Segment => [
      kind === "new" ? "🌑" : "🌕",
      kind.toUpperCase(),
      day(at),
      until(at.getTime() - now.getTime()),
    ]),
  ];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function segments(c: any): Segment[] {
  const out: Segment[] = [];
  if (isNum(c?.orbit?.kms)) out.push(["☀️", "ORBIT", fmt(c.orbit.kms, 1), "KM/S"]);
  if (isNum(c?.galaxy?.kms)) out.push(["🌌", "GALAXY", fmt(c.galaxy.kms), `KM/S${toward(c.galaxy.direction)}`]);
  if (isNum(c?.cmb?.kms)) out.push(["🌠", "CMB", fmt(c.cmb.kms), `KM/S${toward(c.cmb.direction)}`]);
  if (isNum(c?.solarWind?.kms)) out.push(["💨", "WIND", fmt(c.solarWind.kms), "KM/S"]);
  // Kp runs 0–9, so the denominator travels with the value.
  if (isNum(c?.solarWind?.kp)) out.push(["🧲", "KP", `${fmt(c.solarWind.kp, 1)}/9`, ""]);
  if (isNum(c?.moon?.illumination)) out.push(...moon(c.moon, new Date()));
  return out.filter(([icon, ...rest]) => ICONS.has(icon) && rest.every((f) => SAFE.test(f)));
}

/** The Worker's JSON body for this location, or null when unconfigured or unreachable. */
async function fetchBody(): Promise<string | null> {
  const base = baseUrl();
  if (!base) return null;
  const lat = readJson<{ lat?: unknown }>(LOCATION_CACHE)?.lat;
  const q = typeof lat === "number" && Math.abs(lat) <= 90 ? `?lat=${lat.toFixed(2)}` : "";
  return get(`${base}/${q}`);
}

/** The segment lines the statusline caches (tab-separated, newline-joined, no trailing newline); empty when nothing is worth drawing. */
export async function cosmosOutput(): Promise<string> {
  const body = await fetchBody();
  if (!body) return "";
  let data: unknown = null;
  try {
    data = JSON.parse(body);
  } catch {
    return "";
  }
  const segs = segments(data);
  // Without the core motion numbers the row is not worth drawing.
  return segs.length >= 3 ? segs.map((s) => s.join("\t")).join("\n") : "";
}

if (import.meta.main) {
  if (process.argv.includes("--json")) {
    if (!baseUrl()) process.exit(0);
    const body = await fetchBody();
    if (!body) process.exit(1);
    console.log(body);
    process.exit(0);
  }
  const out = await cosmosOutput();
  if (out) console.log(out);
}
