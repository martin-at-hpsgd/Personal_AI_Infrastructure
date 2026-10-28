/** TELOS document and LIFEOS-state movement transitions: a section update says how much each section grew or shrank, a dimension move says by how many points, never the value. Section hashes cover only hand-written bytes: the machine-owned AUTOMATED regions (TOOLS/TelosRegions.ts) are excised first, so a region render never reads as a TELOS update. @version 0.4.0 */
import { lifeosPath } from "../../TOOLS/Paths";
import { createHash } from "node:crypto"; import { join } from "node:path"; import type { VigilEvent } from "../../STATVS/lib/refuse"; import { event, jsonFile, need, readSource, withCursor } from "./common"; import { collectConfig } from "../../STATVS/lib/collectConfig"; import { exciseRegions } from "../../TOOLS/TelosRegions";
/** `lines` is each section's line count, absent on cursors written before 0.3.0. */
export type Snapshot = { sections: Record<string, string>; dimensions: Record<string, number>; lines?: Record<string, number> };
const growth = (name: string, prev: Snapshot, next: Snapshot): string => { const was = prev.lines?.[name], now = next.lines?.[name]; if (was === undefined && prev.sections[name] === undefined) return `${name} (new${now !== undefined ? `, ${now} lines` : ""})`; if (was === undefined || now === undefined) return `${name} (size change not recorded)`; const d = now - was; return `${name} (${d === 0 ? "same length, edited" : `${d > 0 ? "+" : ""}${d} lines`})`; };
export function diff(prev: Snapshot | undefined, next: Snapshot): VigilEvent[] {
  if (!prev) return [];
  const changed = Object.keys(next.sections).filter((name) => prev.sections[name] !== next.sections[name]), removed = Object.keys(prev.sections).filter((name) => next.sections[name] === undefined), out: VigilEvent[] = [];
  if (changed.length || removed.length) { const names = [...changed, ...removed].join(", ").slice(0, 100); out.push(event("telos", "sections", "updated", "info", `TELOS updated: ${names}`, `Changed: ${changed.map((n) => growth(n, prev, next)).join("; ") || "none"}.${removed.length ? ` Removed: ${removed.join(", ")}.` : ""} Look: LIFEOS/USER/TELOS/TELOS.md`, "life", null, createHash("sha256").update([...changed.map((n) => next.sections[n]), ...removed].join("")).digest("hex").slice(0, 16))); }
  const step = Number((collectConfig() as any).adapters?.telos?.pctStep ?? 5);
  for (const [name, pct] of Object.entries(next.dimensions)) { const was = prev.dimensions[name]; if (typeof was !== "number" || Math.abs(pct - was) < step) continue; const direction = pct > was ? "up" : "down"; out.push(event("telos", name, direction, "low", `${name[0]!.toUpperCase()}${name.slice(1)} moved ${direction} in LIFEOS state`, `${name} moved ${direction} ${Math.abs(pct - was)} points since the last read. Values stay out of events (personal data). Look: LIFEOS/USER/TELOS/LIFEOS_STATE.json`, "life", null, `${name}:${pct}`)); }
  return out;
}
/** Per-section hash and line count over the bytes outside the AUTOMATED regions. */
export function sectionsOf(text: string): Pick<Snapshot, "sections" | "lines"> {
  const named = exciseRegions(text).split(/^## /m).slice(1).map((chunk) => { const name = chunk.split("\n", 1)[0]!.trim(); need(!!name, "TELOS section name"); return [name, chunk] as const; });
  return { sections: Object.fromEntries(named.map(([name, chunk]) => [name, createHash("sha256").update(chunk).digest("hex")])), lines: Object.fromEntries(named.map(([name, chunk]) => [name, chunk.split("\n").length])) };
}
export async function live(): Promise<Snapshot> {
  const base = lifeosPath("USER", "TELOS"), text = readSource(join(base, "TELOS.md")), s = jsonFile<{ dimensions?: Record<string, { pct?: number }> }>(join(base, "LIFEOS_STATE.json")), own = sectionsOf(text);
  need(Object.keys(own.sections).length > 0 && !!s.dimensions, "TELOS sections and dimensions");
  need(Object.values(s.dimensions).every((d) => typeof d.pct === "number"), "LIFEOS dimension percentages");
  return { ...own, dimensions: Object.fromEntries(Object.entries(s.dimensions).map(([name, d]) => [name, d.pct!])) };
}
export const read = () => withCursor("telos", live, diff);
