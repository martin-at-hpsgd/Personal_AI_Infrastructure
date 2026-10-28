/**
 * ModelMap.ts — every model LifeOS uses, its vendor, how it is upgraded, and where it is used.
 *
 * The list is the registry (`LIFEOS/TOOLS/models.ts`: CURRENT Claude tiers + CROSS_VENDOR lanes);
 * the "where" is computed on every call from the tree, so there is no hand-kept list to rot.
 * A consumer is any file that reaches a model through the registry: `CROSS_VENDOR.<lane>`,
 * `CROSS_VENDOR["<lane>"]`, `CURRENT.<tier>`, `currentModel("<tier>")`, `--lane <lane>`, or an
 * agent whose frontmatter resolves to the lane or tier. A model id typed anywhere else is drift,
 * and `UpdateModels.ts --check` fails on it. (principal directive, 2026-09-22)
 */

import { spawnSync } from "node:child_process";
import { relative } from "node:path";
import { CURRENT, CROSS_VENDOR } from "../TOOLS/models";
import { isRosterless } from "../TOOLS/UpdateModels";
import { vendorOf } from "../../hooks/lib/route-label";
import type { AgentRoute } from "./Router";

export type ModelEntry = {
  key: string;
  kind: "claude-tier" | "lane";
  vendor: string;
  id: string;
  /** which tool moves this id to the vendor's latest */
  upgrade: string;
  consumers: string[];
};

const REF =
  /CROSS_VENDOR(?:\.([A-Za-z]\w*)|\[\s*["']([A-Za-z]\w*)["']\s*\])|CURRENT\.(fable|opus|sonnet|haiku)\b|currentModel\(\s*["'](fable|opus|sonnet|haiku)["']|--lane\s+([a-z]\w*)|(?:LANE|lane)["']?\s*[:=]\s*["']([a-z][A-Za-z]*)["']/;

const SCAN_DIRS = ["agents", "skills", "hooks", "LIFEOS", "commands", "settings.json"];
const SCAN_GLOBS = ["!**/node_modules/**", "!LIFEOS/MEMORY/**", "!LIFEOS/ALGORITHM/v*", "!LIFEOS_RELEASES/**", "!**/*.test.ts", "!**/test/**", "!**/tests/**", "!LIFEOS/TOOLS/models.ts"];

export function upgradePath(kind: ModelEntry["kind"], id: string): string {
  if (kind === "claude-tier") return "ModelSync --daily (Anthropic models page)";
  if (id.endsWith("-latest")) return "vendor alias (moves itself)";
  if (isRosterless(id)) return "Upgrade Models intent (researched; no public roster)";
  return "UpdateModels --cross-vendor --sync (live roster + probe, daily)";
}

/** Parse `rg -o -n` lines (path:line:match) into key → files. Pure; drives the tests. */
export function consumersFromRg(output: string, root: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const line of output.split("\n")) {
    const m = line.match(/^(.*?):\d+:(.*)$/);
    if (!m) continue;
    const r = m[2].match(REF);
    if (!r) continue;
    const key = r[1] ?? r[2] ?? r[3] ?? r[4] ?? r[5] ?? r[6];
    if (!key) continue;
    const file = relative(root, m[1]) || m[1];
    if (!out.has(key)) out.set(key, new Set());
    out.get(key)!.add(file);
  }
  return out;
}

export function modelMap(root: string, routes: AgentRoute[]): ModelEntry[] {
  const rg = spawnSync("rg", ["--no-heading", "-n", "-o", REF.source, ...SCAN_GLOBS.flatMap((g) => ["-g", g]), ...SCAN_DIRS], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const refs = consumersFromRg((rg.stdout ?? "").split("\n").map((l) => (l && !l.startsWith("/") ? `${root}/${l}` : l)).join("\n"), root);
  for (const r of routes) {
    const key = r.lane ?? r.modelPin;
    if (!key) continue;
    if (!refs.has(key)) refs.set(key, new Set());
    refs.get(key)!.add(`agents/${r.agent}.md`);
  }
  const entries: ModelEntry[] = [];
  for (const [tier, id] of Object.entries(CURRENT)) {
    entries.push({ key: tier, kind: "claude-tier", vendor: vendorOf(id), id, upgrade: upgradePath("claude-tier", id), consumers: [...(refs.get(tier) ?? [])].sort() });
  }
  for (const [lane, id] of Object.entries(CROSS_VENDOR)) {
    entries.push({ key: lane, kind: "lane", vendor: vendorOf(id), id, upgrade: upgradePath("lane", id), consumers: [...(refs.get(lane) ?? [])].sort() });
  }
  return entries.sort((a, b) => a.vendor.localeCompare(b.vendor) || a.key.localeCompare(b.key));
}

export function formatModelMap(entries: ModelEntry[], showFiles: boolean): string {
  const lines: string[] = [];
  let vendor = "";
  for (const e of entries) {
    if (e.vendor !== vendor) { vendor = e.vendor; lines.push(`\n${vendor}`); }
    const used = e.consumers.length === 0 ? "UNUSED" : `${e.consumers.length} file${e.consumers.length === 1 ? "" : "s"}`;
    lines.push(`  ${e.key.padEnd(20)} ${e.id.padEnd(32)} ${used.padEnd(9)} ${e.upgrade}`);
    if (showFiles) for (const c of e.consumers) lines.push(`      ${c}`);
  }
  const vendors = new Set(entries.map((e) => e.vendor)).size;
  lines.push(`\n${entries.length} models across ${vendors} vendors · registry LIFEOS/TOOLS/models.ts · drift gate: bun LIFEOS/TOOLS/UpdateModels.ts --check`);
  return lines.join("\n").trimStart();
}
