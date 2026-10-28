import { join } from "node:path";
import { GLYPHS, icon, type GlyphName } from "../Glyphs";
import { BAND, C, RESET, band, rgb } from "../Ansi";
import { readJson, readLastLine } from "../Cache";
import { number, object, string, type State } from "../State";
import { cellWidth, fit } from "../Width";

interface Dimension { label: string; value: string; tier: "unset" | "fresh" | "aging" | "stale"; age: string }
const KEYS = ["H", "M", "E", "S", "R", "F", "C", "CF", "W", "K"] as const;
const AMBER = rgb(251, 191, 36);
// The rated dimensions drawn on the row, in order: the glyph each is drawn as, and the word the "Log …" nudge uses.
// Each glyph takes its value's colour, never the table's, so the symbol and the number read as one band
// (a red smiley beside a 4 would contradict the rating).
// One colour per rating, 1 to 5: red, orange, yellow, light green, green. A 3 is fine (yellow, never an alarm) and 4 and 5 are the
// preferred range, so both are green (principal directive, 2026-10-24). Readiness maps onto the same five by Oura's bands.
export const RATING = [rgb(220, 38, 38), rgb(251, 146, 60), rgb(250, 204, 21), rgb(134, 239, 172), rgb(34, 197, 94)] as const;
export const ratingColor = (value: string): string => value === "-" ? C.slate600 : RATING[Math.min(5, Math.max(1, Number(value) || 1)) - 1];
export const readinessColor = (score: number): string => RATING[score >= 85 ? 4 : score >= 70 ? 3 : score >= 60 ? 2 : score >= 50 ? 1 : 0];
const SHOWN: Record<string, { glyph: GlyphName; word: string }> = {
  MOOD: { glyph: "mood", word: "mood" }, ENRG: { glyph: "energy", word: "energy" }, CREAT: { glyph: "creativity", word: "creativity" },
};

export function dimensions(current: unknown, now: number): Dimension[] {
  if (current === null || typeof current !== "object" || Array.isArray(current)) return [];
  const data = object(current), dims = object(data.dims), windows = object(data.windows), labels = object(data.labels);
  const rows: Dimension[] = [];
  for (const key of KEYS) {
    const dim = object(dims[key]), win = object(windows[key]);
    const label = string(labels[key], key);
    if (dims[key] == null || (dim.value == null && key !== "W" && key !== "K")) {
      rows.push({ label, value: "-", tier: "unset", age: "" });
      continue;
    }
    const at = Date.parse(string(dim.ts).replace(/\.\d+/, "")) / 1000;
    if (!Number.isFinite(at)) break; // jq emits earlier rows, then fails at the malformed timestamp.
    const hours = (now - at) / 3600;
    if (key === "W" || key === "K") {
      const days = Math.floor(hours / 24), target = number(win.target, key === "K" ? 1 : 2);
      rows.push({ label, value: `${days}d`, tier: days <= target ? "fresh" : days <= 2 * target ? "aging" : "stale", age: "" });
    } else {
      const tier = hours <= number(win.fresh, 24) ? "fresh" : hours <= number(win.stale, 72) ? "aging" : "stale";
      const age = tier === "fresh" ? "" : hours < 48 ? `${Math.round(hours)}h` : `${Math.floor(hours / 24)}d`;
      rows.push({ label, value: String(dim.value), tier, age });
    }
  }
  return rows;
}

// The current Oura readiness: the newest score in the hourly HealthSync day files, which Oura's own day tag names.
// Tomorrow comes first because the sync and this renderer can sit in different zones; a score from before today
// carries its age. Four direct reads, no directory scan, since the folder holds years of day files. Colors follow
// Oura's bands (85 optimal, 70 good).
export function readiness(root: string, now: number): { value: number; age: string } | null {
  const dir = join(root, "USER", "HEALTH", "DATA", "oura");
  for (const back of [-1, 0, 1, 2]) {
    const day = new Date((now - back * 86400) * 1000).toLocaleDateString("sv");
    const score = object(object(readJson(join(dir, `${day}.json`))).metrics).oura_readiness_score;
    if (typeof score === "number") return { value: score, age: back > 0 ? `${back}d` : "" };
  }
  return null;
}

export function renderStateRow(state: State): string {
  if (state.geometry.phone) return "";
  const current = readJson(join(state.root, "USER", "STATE", "current.json"));
  if (current === null) return "\n";
  const dims = dimensions(current, state.now);
  if (!dims.length) return "\n";
  const values: string[] = [], bare: string[] = [], log: string[] = [];
  let workout = false, walk = false;
  for (const d of dims) {
    if (d.label === "WKOUT") { workout = d.tier !== "fresh"; continue; }
    if (d.label === "WALK") { walk = d.tier !== "fresh"; continue; }
    const shown = SHOWN[d.label];
    if (!shown) continue;
    const color = ratingColor(d.value);
    if (d.value === "-" || d.tier === "stale") log.push(shown.word);
    bare.push(`${color}${GLYPHS[shown.glyph].glyph} ${d.value}${RESET}`);
    values.push(`${bare[bare.length - 1]}${d.age ? ` ${C.slate500}${d.age}${RESET}` : ""}`);
  }
  const ready = readiness(state.root, state.now);
  if (ready) {
    const color = readinessColor(ready.value);
    bare.push(`${color}${GLYPHS.readiness.glyph} ${ready.value}${RESET}`);
    values.push(`${bare[bare.length - 1]}${ready.age ? ` ${C.slate500}${ready.age}${RESET}` : ""}`);
  }
  let action = "", color: string = C.region, warning = "";
  // The log is append-only and grows without bound (50 MB here): read only its last line, as the bash tail -1 did.
  const healthLine = readLastLine(join(state.root, "MEMORY", "OBSERVABILITY", "memory-health.jsonl"));
  let health: Record<string, unknown> = {};
  try { health = object(JSON.parse(healthLine || "{}")); } catch { /* No usable final observation. */ }
  for (const value of Array.isArray(health.actions) ? health.actions : []) {
    const item = object(value), text = string(item.text).replace(/\x1b/g, "");
    if (!text) continue;
    if (item.severity === "critical") { if (!action) { action = text; color = rgb(239, 68, 68); } }
    else if (!warning) warning = text;
  }
  const attention = object(readJson(join(state.root, "MEMORY", "STATE", "work-attention.json")));
  const age = (state.now - Date.parse(string(attention.updated, "1970-01-01T00:00:00Z").replace(/\.\d+/, "")) / 1000) / 86400;
  const overdue = age <= 3 && Array.isArray(attention.overdue) ? attention.overdue.length : 0;
  const ble = object(attention.ble);
  const bleReason = age <= 3 && ble.overdue === true ? string(ble.reason, "due") : "";
  if (!action && overdue > 0) { action = `${overdue} issues overdue`; color = AMBER; }
  if (!action && object(readJson(join(state.root, "USER", "CACHE", "interview-due.json"))).due === true) { action = "Interview due"; color = AMBER; }
  if (!action && log.length) action = `Log ${log.join(", ")}`;
  if (!action && workout) action = "Workout due";
  if (!action && walk) action = "Walk due";
  if (!action && warning) { action = warning; color = AMBER; }
  if (!action && bleReason) { action = `BLE pass due: ${bleReason}`; color = AMBER; }
  // Fullest form first: a narrower pane drops the ages, then shortens the action, then drops it.
  const width = state.geometry.content;
  const row = (dims: string[], gap: string, text: string): string =>
    dims.join(gap) + (text ? `${gap}${C.slate600}│${RESET} ${rgb(219, 234, 254)}→${RESET} ${color}${text}${RESET}` : "");
  const room = width - cellWidth(row(bare, " ", "")) - 5;
  const short = room >= 8 && cellWidth(action) > room ? `${Array.from(action).slice(0, room - 1).join("").trimEnd()}…` : action;
  const tag = `${icon("state")}${C.slate400}${state.geometry.density === 3 ? "CURRENT STATE:" : "STATE"}${RESET} `;
  return band(fit(width, tag + row(values, "  ", action), tag + row(bare, "  ", action), row(values, "  ", action), row(bare, "  ", action), row(bare, " ", action), row(bare, " ", short), row(bare, " ", "")), width, BAND.state) + "\n";
}
