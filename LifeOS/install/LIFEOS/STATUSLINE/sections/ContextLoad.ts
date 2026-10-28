import { join } from "node:path";
import { BAND, C, RESET, band, rgb } from "../Ansi";
import { readJson, readText } from "../Cache";
import { object, string, type State } from "../State";
import { cellWidth, fit } from "../Width";

/** Recommendations older than this are stale: the next /cl run republishes or clears them. */
const MAX_AGE_DAYS = 14;
const OPEN = new Set(["recommended", "accepted"]);

export interface Recommendation { key: string; label: string }

/**
 * The /cl recommendations still worth showing, at most two. A line drops by itself once its Upgrades record leaves
 * recommended/accepted (the principal said yes or no, or it expired), so nothing has to clear the file by hand.
 */
export function openRecommendations(root: string, now: number): Recommendation[] {
  const published = object(readJson(join(root, "MEMORY", "STATE", "context-load", "statusline.json")));
  const updated = Date.parse(string(published.updated)) / 1000;
  if (!Number.isFinite(updated) || now - updated > MAX_AGE_DAYS * 86400) return [];
  const out: Recommendation[] = [];
  for (const value of Array.isArray(published.items) ? published.items : []) {
    const item = object(value), id = string(item.upgrade), label = string(item.label).replace(/\x1b/g, "");
    if (!label || !/^[0-9]{8}-[0-9]{6}_[a-z0-9-]+$/.test(id)) continue;
    const status = (readText(join(root, "MEMORY", "UPGRADES", "records", `${id}.md`)) ?? "").match(/^status:\s*"?([a-z]+)"?\s*$/m)?.[1];
    if (status && OPEN.has(status)) out.push({ key: string(item.key, String(out.length + 1)), label });
    if (out.length === 2) break;
  }
  return out;
}

export function renderContextLoad(state: State): string {
  if (state.geometry.phone) return "";
  const width = state.geometry.content;
  const tag = `${C.slate400}${state.geometry.density === 3 ? "LOAD FIX:" : "FIX"}${RESET} `;
  return openRecommendations(state.root, state.now).map(({ key, label }) => {
    const command = `${rgb(219, 234, 254)}→${RESET} ${C.region}/cl apply ${key}${RESET}`;
    const room = width - cellWidth(tag + command) - 3;
    const short = room >= 8 && cellWidth(label) > room ? `${Array.from(label).slice(0, room - 1).join("").trimEnd()}…` : label;
    return band(fit(width, `${tag}${label}  ${command}`, `${tag}${short}  ${command}`, `${C.region}/cl apply ${key}${RESET}`), width, BAND.state) + "\n";
  }).join("");
}
