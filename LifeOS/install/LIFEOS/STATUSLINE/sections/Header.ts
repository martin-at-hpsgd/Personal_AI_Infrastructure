import { BAND, BOLD, C, LIFEOS_LOGO, RESET, band, separator } from "../Ansi";
import { icon } from "../Glyphs";
import { object, string, type State } from "../State";
import { cellWidth, fit } from "../Width";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { abbreviate } from "../producers/LocationWeather";

/**
 * The place to draw: the Location system's current.json when it holds a newer fix than the statusline cache, else the cache.
 * The cache is refreshed in the background after a draw and at most every 31 s, so drawing from it alone showed each fix
 * one refresh late (2026-10-18: a fix the sync had just written showed as minutes old). Location ISA ISC-151.
 */
export function freshestLocation(state: Pick<State, "env" | "root">, cached: Record<string, unknown>): Record<string, unknown> {
  let cur: Record<string, unknown>;
  try { cur = JSON.parse(readFileSync(join(state.env.LIFEOS_LOCATION_DIR ?? join(state.root, "USER", "LOCATION"), "current.json"), "utf8")); } catch { return cached; }
  const at = (v: unknown) => (typeof v === "string" ? Date.parse(v) : NaN);
  if (!(at(cur.fix_at) > (at(cached.fix_at) || 0)) || typeof cur.city !== "string" || !cur.city) return cached;
  return { ...cached, city: cur.city, regionName: cur.region ?? null, region: abbreviate(cur.country, cur.region) ?? null, countryCode: cur.country ?? null, fix_at: cur.fix_at };
}

const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * The tide line with its three heights (came from → now → going to) in three shades of the tide teal — dim, base,
 * pale — so they read apart at a glance. Arrows go slate; anything not shaped like a reading stays one colour.
 */
export function tideAnsi(tide: string): string {
  const segs = tide.split("→");
  const head = segs[0].match(/^(.*?)(-?[\d.]+)$/);
  const tail = segs[segs.length - 1].match(/^(-?[\d.]+)(.*)$/);
  if (segs.length < 2 || segs.length > 3 || !head || !tail) return `${C.tide}${tide}${RESET}`;
  const arrow = `${C.slate500}→${RESET}`;
  const now = segs.length === 3 ? `${C.tide}${segs[1]}${RESET}${arrow}` : "";
  const first = segs.length === 3 ? C.tideFrom : C.tide;
  return `${C.tide}${head[1]}${RESET}${first}${head[2]}${RESET}${arrow}${now}${C.tideTo}${tail[1]}${RESET}${C.tide}${tail[2]}${RESET}`;
}

/**
 * Words of `text` that fit `width` cells, closed with an ellipsis when any were dropped; a cut mid-word only when the
 * first word alone is too wide, and then by terminal cells and whole graphemes, so a double-width label never runs
 * past `width` (the ellipsis alone when not even one grapheme fits).
 */
export function wordsToFit(text: string, width: number): string {
  if (cellWidth(text) <= width) return text;
  let out = "";
  for (const word of text.split(" ")) {
    const next = out ? `${out} ${word}` : word;
    if (cellWidth(next) + 1 > width) break;
    out = next;
  }
  if (out) return `${out}…`;
  let cut = "";
  for (const { segment } of GRAPHEMES.segment(text)) {
    if (cellWidth(cut + segment) + 1 > width) break;
    cut += segment;
  }
  return `${cut}…`;
}

/** Visible cells of a chip string. */
const chipCells = (ansi: string): number => cellWidth(ansi.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ""));

/**
 * The SESSION band, fullest first: tab title and session name, then the session name alone (the tab title is dropped
 * outright when the session name already says it), then the shorter of the two, then the session name cut at a word.
 * The session-mode chips (⚡ULTRACODE, ⇶ Pn; Router ISA F7, R120) ride at the end of every form: the full chips on
 * every uncut form first, then the short chips, then the name cut at a word to leave room for them.
 */
export function sessionForms(state: State, width: number): string[] {
  if (!state.sessionLabel) return [];
  const upper = state.sessionLabel.toUpperCase();
  const tab = state.tabLabel && !upper.includes(state.tabLabel.toUpperCase()) ? state.tabLabel : "";
  const s = (text: string): string => `${C.session}${text}${RESET}`;
  const base = tab ? [`${BOLD}${C.session}${tab}${RESET}${C.session} · ${upper}${RESET}`, s(upper)] : [s(upper)];
  if (tab && cellWidth(tab) < cellWidth(upper)) base.push(`${BOLD}${C.session}${tab}${RESET}`);
  const full = state.ultracode, short = state.ultracodeShort || full;
  const forms = full
    ? [...base.map(f => f + full), ...base.map(f => f + short), ...(width - chipCells(full) >= 12 ? [s(wordsToFit(upper, width - chipCells(full))) + full] : []), s(wordsToFit(upper, Math.max(2, width - chipCells(short)))) + short]
    : [...base, s(wordsToFit(upper, width))];
  const label = `${icon("session")}${C.slate400}SESSION:${RESET} `;
  return [label + forms[0], ...forms];
}

/** The name with the LifeOS staircase mark in front, as the LifeOSHooks band draws it. */
const NAME = `${LIFEOS_LOGO} ${BOLD}${C.blue}LifeOS${RESET}`;
/** The name alone, for a pane too narrow to carry the mark. */
const BARE = `${BOLD}${C.blue}LifeOS${RESET}`;

/** Minutes as "45m", "1h12m", "3h" or "1d2h". */
function span(min: number): string {
  if (min < 60) return `${min}m`;
  if (min < 1440) { const h = Math.floor(min / 60), m = min % 60; return m ? `${h}h${m}m` : `${h}h`; }
  const d = Math.floor(min / 1440), h = Math.floor((min % 1440) / 60);
  return h ? `${d}d${h}h` : `${d}d`;
}

/**
 * How old the shown place is, computed at draw time so a stopped sync cannot freeze it (Location ISA F8, ISC-150): always
 * shown in capitals like the place, quiet up to 30 minutes ("NOW", "4M AGO"), then "1H12M AGO" in amber, then "STALE 7H" in rose past the stale window
 * (principal directive, 2026-10-18).
 */
export function locationAge(location: Record<string, unknown>, nowMs: number): string {
  const at = typeof location.fix_at === "string" ? Date.parse(location.fix_at) : NaN;
  if (Number.isNaN(at)) return "";
  const min = Math.max(0, Math.floor((nowMs - at) / 60_000));
  const staleAfter = typeof location.stale_after_min === "number" && location.stale_after_min > 0 ? location.stale_after_min : 360;
  // Capitals, like the place beside it (principal directive, 2026-10-18, "capitalization").
  if (min >= staleAfter) return `${C.rose}STALE ${span(min).toUpperCase()}${RESET}`;
  if (min > 30) return `${C.fixAge}${span(min).toUpperCase()} AGO${RESET}`;
  return `${C.slate600}${min < 1 ? "NOW" : `${span(min).toUpperCase()} AGO`}${RESET}`;
}

export function renderHeader(state: State): string {
  const { cache, geometry: g, clock, versions } = state;
  // The mode chips sit on the SESSION line when there is one (Router ISA F7, R120), and on this row otherwise (R121).
  const onHeader = !state.sessionLabel;
  const uc = { ansi: onHeader ? state.ultracode : "", short: onHeader ? state.ultracodeShort || state.ultracode : "" };
  const weather = state.weatherEnabled ? (cache.text("weather-cache.json")?.replace(/\n+$/, "") ?? "—") : "—";
  // Last resort with chips on: the bare name and the short chips, no clock, so the chips still show in a tiny pane; with
  // every mode on (Router ISA F10, R143) the narrowest pane drops the name and keeps the short chips alone.
  const chipsOnly = uc.short ? [`${BARE}${uc.short}`, uc.short.trimStart()] : [];
  const missing = cache.text("location-cache.json") === null;
  if (g.phone) {
    // The city stays on the phone row longest: the version goes first, then the fix age, then the weather (principal directive, 2026-10-24).
    const fix = missing ? {} : freshestLocation(state, object(cache.json("location-cache.json")));
    const town = state.weatherEnabled && !missing ? string(fix.city).toUpperCase() : "";
    const fixAge = town ? locationAge(fix, state.nowMs) : "";
    const wx = weather && weather !== "—" ? `  ${C.weather}${weather}${RESET}` : "";
    const head = (v: boolean, w: boolean, mark = true, chips = uc.ansi, place = 0): string => {
      const at = town && place ? ` ${C.city}${town}${RESET}${place > 1 && fixAge ? ` ${fixAge}` : ""}` : "";
      return `${mark ? NAME : BARE}${v ? ` ${C.blue}${versions.lifeos}${RESET}` : ""}${chips} ${C.slate600}│${RESET} ${C.time}${clock}${RESET}${at}${w ? wx : ""}`;
    };
    const placed = town ? [head(true, true, true, uc.ansi, 2), head(false, true, true, uc.ansi, 2), head(false, true, true, uc.ansi, 1), head(false, false, true, uc.ansi, 1), head(false, false, false, uc.ansi, 1)] : [];
    const shortForms = uc.short ? [head(false, false, true, uc.short), head(false, false, false, uc.short)] : [];
    return `${fit(g.content, ...placed, head(true, true), head(false, true), head(false, false), head(false, false, false), ...shortForms, ...chipsOnly)}\n`;
  }
  const location = missing ? object(cache.json("location-cache.json")) : freshestLocation(state, object(cache.json("location-cache.json")));
  const city = state.weatherEnabled ? (missing ? "UNKNOWN" : string(location.city).toUpperCase()) : "";
  const region = state.weatherEnabled ? string(location.region ?? location.regionName).toUpperCase() : "";
  const cc = string(location.countryCode).toUpperCase();
  // A known place with no country is open water (a flight over the ocean), so it gets the sea instead of a flag (Location ISA ISC-149).
  const flag = !state.weatherEnabled ? "" : missing ? "🌐" : /^[A-Z]{2}$/.test(cc) ? Array.from(cc, c => String.fromCodePoint(0x1f1e6 + c.charCodeAt(0) - 65)).join("") : city ? "🌊" : "";
  const age = state.weatherEnabled && !missing ? locationAge(location, state.nowMs) : "";
  const version = versions.lifeos && versions.lifeos !== "—" ? ` ${C.blue}${versions.lifeos}${RESET}` : "";
  const tide = cache.text("tide-line.txt")?.replace(/\n+$/, "") || "";
  // Fullest form first; a narrower pane drops the region, then the tide, then the city, the version, the flag, the weather.
  const line = (o: { gap: string; region: boolean; tide: boolean; city: boolean; version: boolean; loc?: boolean; weather?: boolean; mark?: boolean; chips?: string }): string => {
    const place = city && o.city ? `${C.city}${city}${RESET}${region && o.region ? `${C.slate600}, ${RESET}${C.region}${region}${RESET}` : ""}${age ? ` ${age}` : ""}` : "";
    const loc = [flag, place].filter(Boolean).join(" ") || (city ? "" : "—");
    const parts = [o.loc === false ? "" : loc, `${C.time}${clock}${RESET}`, o.weather === false ? "" : `${C.weather}${weather}${RESET}`, o.tide && tide ? tideAnsi(tide) : ""].filter(Boolean);
    return `${o.mark === false ? BARE : NAME}${o.version ? version : ""}${o.chips ?? uc.ansi} ${C.slate600}│${RESET} ${parts.join(o.gap)}`;
  };
  const left = fit(g.content,
    line({ gap: "  ", region: true, tide: true, city: true, version: true }),
    line({ gap: " ", region: true, tide: true, city: true, version: true }),
    line({ gap: " ", region: false, tide: true, city: true, version: true }),
    line({ gap: " ", region: false, tide: false, city: true, version: true }),
    line({ gap: " ", region: false, tide: false, city: false, version: true }),
    line({ gap: " ", region: false, tide: false, city: false, version: false }),
    line({ gap: " ", region: false, tide: false, city: false, version: false, loc: false }),
    line({ gap: " ", region: false, tide: false, city: false, version: false, loc: false, weather: false }),
    line({ gap: " ", region: false, tide: false, city: false, version: false, loc: false, weather: false, mark: false }),
    // With chips on, the short chips before giving them up: the narrowest two forms again, then the name and chips alone.
    ...(uc.short ? [line({ gap: " ", region: false, tide: false, city: false, version: false, loc: false, weather: false, chips: uc.short }), line({ gap: " ", region: false, tide: false, city: false, version: false, loc: false, weather: false, mark: false, chips: uc.short })] : []),
    ...chipsOnly);
  const fill = g.content - cellWidth(left) - 1;
  const rule = (n: number): string => `${C.slate600}${"─".repeat(n)}${RESET}`;
  // Centered, the rule splits around the text so the name sits in the middle; left-aligned, it trails the text.
  const sides = fill - 1;
  let out = g.density < 2 || fill < 3 ? `${left}\n`
    : g.centered && sides >= 4 ? `${rule(Math.trunc(sides / 2))} ${left} ${rule(sides - Math.trunc(sides / 2))}\n`
    : `${left} ${rule(fill)}\n`;
  const session = sessionForms(state, g.content);
  // A faint dotted rule, dimmer than every other rule on the bar, sets the session band off from the top line.
  if (session.length && g.density >= 2) out += `${C.slate700}${"┈".repeat(g.content)}${RESET}\n`;
  if (session.length) out += band(fit(g.content, ...session), g.content, BAND.session) + "\n";
  return out + separator(g.content, g.density, "┄");
}
