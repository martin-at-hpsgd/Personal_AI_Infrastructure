#!/usr/bin/env bun
/**
 * ModelEstate — the registry as data any repo can read, plus the one set of rules for
 * telling what a model id in the wild is: which vendor, which class, and whether the
 * registry has moved past it. models.ts stays the one list; this file never names a model.
 *
 *   bun ModelEstate.ts export [--registry <models.ts>] [--out <models.json>]   regenerate the export
 *   bun ModelEstate.ts check                                                     exit 1 when models.json is behind models.ts
 *
 * Consumers: the Atlas model collectors (LIFEOS/ATLAS/collectors/Models.ts), product lock
 * files (Model Estate ISA F4), and ModelSync/UpdateModels, which regenerate the export
 * whenever they write the registry.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { invariant } from "./Invariant";
import { parseModelId } from "./UpdateModels";
import { CROSS_VENDOR, CURRENT, PER_MESSAGE_EFFORT_MODELS, cmpClaudeVersion, parseClaudeId, type ClaudeTier } from "./models";

export const EXPORT_PATH = join(import.meta.dir, "models.json");
const REGISTRY_PATH = join(import.meta.dir, "models.ts");

export type Vendor =
  | "anthropic" | "openai" | "google" | "xai" | "perplexity"
  | "replicate" | "suno" | "typesafe" | "cloudflare" | "meta" | "fish" | "unknown";

/** Vendor of a model id, from its shape. Pure. */
export function vendorOfId(id: string): Vendor {
  if (id.startsWith("claude-")) return "anthropic";
  if (id.startsWith("@cf/")) return "cloudflare";
  if (id.startsWith("jev-")) return "typesafe"; // TypeSafe's Jev ids: the judgment engine until it was retired 2026-10-10; some consumers still call it
  if (/^(gpt-|whisper-|o\d)/.test(id)) return "openai";
  if (id.startsWith("gemini-")) return "google";
  if (id.startsWith("grok-")) return "xai";
  if (id.startsWith("muse-")) return "meta";
  if (/^sonar\b/.test(id)) return "perplexity";
  if (id.startsWith("chirp-")) return "suno";
  if (/^(drama|s\d)(-|\.|$)/.test(id)) return "fish"; // Fish Audio TTS models (drama-3, s2.1-pro): the one voice engine since 2026-10-25
  if (/^[a-z0-9-]+\/[a-z0-9._-]+$/.test(id)) return "replicate";
  return "unknown";
}

export type Shape = { family: string; version: number[]; alias: boolean };

/** Family + version + alias flag for any id, Claude and media ids included. Pure. */
export function shapeOf(id: string): Shape {
  const c = parseClaudeId(id);
  if (c) return { family: `claude-${c.family}`, version: [...c.version], alias: false };
  const p = parseModelId(id);
  return { family: p.family, version: p.version, alias: p.stability === "alias" };
}

function cmp(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

export type LaneEntry = { lane: string; vendor: Vendor; id: string; class: string; alias: boolean; kind: "claude-tier" | "cross-vendor" };
export type RegistryExport = { source: "LIFEOS/TOOLS/models.ts"; lanes: Record<string, LaneEntry> };

/** The export for a registry. Deterministic (no timestamp) so a regenerate with no
 *  registry change writes identical bytes. Claude tiers are keyed `claude.<tier>`. */
export function buildExport(current: Record<string, string> = CURRENT, cross: Record<string, string> = CROSS_VENDOR): RegistryExport {
  const lanes: Record<string, LaneEntry> = {};
  for (const [tier, id] of Object.entries(current)) {
    lanes[`claude.${tier}`] = { lane: `claude.${tier}`, vendor: "anthropic", id, class: tier, alias: false, kind: "claude-tier" };
  }
  for (const [lane, id] of Object.entries(cross)) {
    const s = shapeOf(id);
    lanes[lane] = { lane, vendor: vendorOfId(id), id, class: s.family, alias: s.alias, kind: "cross-vendor" };
  }
  return { source: "LIFEOS/TOOLS/models.ts", lanes };
}

export type UseStatus = "tracks" | "pinned" | "stale" | "auto-moving";
export type Classified = {
  status: UseStatus;
  vendor: Vendor;
  /** Registry lanes this id currently is, or would be on (same class). */
  lanes: string[];
  /** The id the registry holds for this class when the use is behind it. */
  currentId?: string;
  /** True when no registry lane shares this id's class: nothing upgrades it. */
  unregistered?: boolean;
  /** True when the use is newer than the registry: the registry is what's behind. */
  ahead?: boolean;
};

/** Status of a model id typed in code or config, against a registry export. Pure. */
export function classifyTyped(id: string, reg: RegistryExport = buildExport()): Classified {
  const vendor = vendorOfId(id);
  const entries = Object.values(reg.lanes);
  const exact = entries.filter((e) => e.id === id).map((e) => e.lane);
  const s = shapeOf(id);
  if (s.alias) return { status: "auto-moving", vendor, lanes: exact };
  const c = parseClaudeId(id);
  if (c?.tier) {
    const lane = `claude.${c.tier}`;
    const cur = reg.lanes[lane]?.id;
    if (!cur || cur === id) return { status: "pinned", vendor, lanes: [lane] };
    let d = -1;
    try { d = cmpClaudeVersion(id, cur); } catch { /* unparsable registry entry reads as behind */ }
    if (d > 0) return { status: "pinned", vendor, lanes: [lane], ahead: true };
    if (d === 0) return { status: "pinned", vendor, lanes: [lane] }; // a dated form of the current version
    return { status: "stale", vendor, lanes: [lane], currentId: cur };
  }
  if (exact.length) return { status: "pinned", vendor, lanes: exact };
  const kin = entries.filter((e) => !e.alias && shapeOf(e.id).family === s.family && s.family !== "");
  if (!kin.length) return { status: "pinned", vendor, lanes: [], unregistered: true };
  const newest = kin.reduce((a, b) => (cmp(shapeOf(b.id).version, shapeOf(a.id).version) > 0 ? b : a));
  const lanes = kin.filter((e) => e.id === newest.id).map((e) => e.lane);
  return cmp(shapeOf(newest.id).version, s.version) > 0
    ? { status: "stale", vendor, lanes, currentId: newest.id }
    : { status: "pinned", vendor, lanes, ahead: cmp(s.version, shapeOf(newest.id).version) > 0 || undefined };
}

/** Status of a use that names a lane (CROSS_VENDOR.x, CURRENT.tier, a lock-file lane). Pure. */
export function classifyLane(lane: string, reg: RegistryExport = buildExport()): (Classified & { id: string }) | null {
  const e = reg.lanes[lane] ?? reg.lanes[`claude.${lane}`];
  if (!e) return null;
  return { status: e.alias ? "auto-moving" : "tracks", vendor: e.vendor, lanes: [e.lane], id: e.id };
}

// ── Detection in text ────────────────────────────────────────────────

/** Claude families the registry knows: the tiers in CURRENT plus any family a registry id names (PER_MESSAGE_EFFORT_MODELS), so a family
 *  that is not a tier is recognised from registry data and never written here. */
const CLAUDE_FAMILIES: readonly string[] = [...new Set([
  ...Object.keys(CURRENT),
  ...PER_MESSAGE_EFFORT_MODELS.map((id) => parseClaudeId(id)?.family).filter((f): f is string => !!f),
])];

/** OpenAI ids that name a lane instead of carrying a version number (gpt-<name>-...), read from the CROSS_VENDOR pins. */
const NAMED_GPT_PREFIXES: readonly string[] = [...new Set(
  Object.values(CROSS_VENDOR)
    .filter((id) => /^gpt-[a-z]+-/.test(id) && !id.split("-").some((t) => /^\d+(?:\.\d+)*$/.test(t)))
    .map((id) => id.match(/^gpt-[a-z]+-/)![0]),
)];

/** Every model-id shape we recognise, as an rg-compatible pattern (Rust regex).
 *  TypeSafe's Jev ids stay in it (Jev retired 2026-10-10 as our engine) so a stray one in code is still found. */
export const MODEL_ID_RG =
  String.raw`claude-(?:${CLAUDE_FAMILIES.join("|")})-\d+(?:-\d{1,3})?(?:-\d{8})?|\b(?:gpt-\d[A-Za-z0-9.-]*|${NAMED_GPT_PREFIXES.map((p) => `${p}[a-z][A-Za-z0-9.-]*|`).join("")}gemini-\d[A-Za-z0-9.-]*|grok-\d[A-Za-z0-9.-]*|muse-[a-z]+(?:-[a-z]+)*-\d[A-Za-z0-9.-]*|sonar(?:-[a-z]+)*|whisper-\d|chirp-v[0-9-]+|jev-latest|jev-\d[a-z0-9.-]*)\b|@cf/[a-z0-9-]+/[a-z0-9._-]+|black-forest-labs/[a-z0-9._-]+|google/nano-banana[a-z0-9.-]*`; // jev-: TypeSafe ids, retired 2026-10-10 as our engine

/** Is a matched token a real model selection rather than prose or a label?
 *  Mirrors UpdateModels' vendor sweep: bare family+number (gpt-4, gemini-3) is noise. */
export function isModelSelection(id: string): boolean {
  if (parseClaudeId(id)) return true;
  if (/^(sonar(-[a-z]+)*$|whisper-\d$|chirp-v|jev-|@cf\/|black-forest-labs\/|google\/nano-banana)/.test(id)) return true; // jev-: TypeSafe ids, retired 2026-10-10 as our engine
  const tokens = id.split("-");
  const vIdx = tokens.findIndex((t) => /^\d+(?:\.\d+)*$/.test(t));
  if (vIdx === -1) return NAMED_GPT_PREFIXES.some((p) => id.startsWith(p));
  const v = tokens[vIdx];
  if (v.includes(".") || /^\d{2,}$/.test(v)) return true;
  return tokens.slice(vIdx + 1).some((t) => /[A-Za-z]/.test(t));
}

/** Lane references in source text: CROSS_VENDOR.x, CROSS_VENDOR["x"], CURRENT.tier,
 *  CURRENT["tier"], currentModel("tier"). Returns lane keys as the export names them. */
export function laneRefs(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/CROSS_VENDOR(?:\.([A-Za-z_]\w*)|\[\s*["']([A-Za-z_]\w*)["']\s*\])/g)) out.add(m[1] ?? m[2]);
  for (const m of text.matchAll(/\bCURRENT(?:\.(opus|sonnet|haiku|fable)\b|\[\s*["'](opus|sonnet|haiku|fable)["']\s*\])/g)) out.add(`claude.${m[1] ?? m[2]}`);
  for (const m of text.matchAll(/currentModel\(\s*["'](opus|sonnet|haiku|fable)["']\s*\)/g)) out.add(`claude.${m[1]}`);
  return [...out];
}

// ── Export file ──────────────────────────────────────────────────────

export function renderExport(exp: RegistryExport): string {
  return JSON.stringify(exp, null, 2) + "\n";
}

/** Load a registry module from an arbitrary path (a temp copy in tests) and build its export. */
async function exportFromRegistry(registryPath: string): Promise<RegistryExport> {
  const mod = (await import(resolve(registryPath))) as { CURRENT: Record<ClaudeTier, string>; CROSS_VENDOR: Record<string, string> };
  invariant(mod.CURRENT && mod.CROSS_VENDOR, `registry at ${registryPath} exports CURRENT and CROSS_VENDOR`);
  return buildExport(mod.CURRENT, mod.CROSS_VENDOR);
}

/** Write the export atomically; returns true when the bytes changed. */
export function writeExport(exp: RegistryExport, out: string = EXPORT_PATH): boolean {
  invariant(Object.keys(exp.lanes).length > 0, "registry export has at least one lane");
  const text = renderExport(exp);
  if (existsSync(out) && readFileSync(out, "utf8") === text) return false;
  const tmp = `${out}.tmp-${process.pid}`;
  writeFileSync(tmp, text);
  renameSync(tmp, out);
  return true;
}

/** Regenerate the export in a fresh process, so a caller that just rewrote models.ts
 *  (and still holds the old module in memory) exports what is on disk now. */
export function regenerateExport(): { ok: boolean; detail: string } {
  const r = Bun.spawnSync(["bun", join(import.meta.dir, "ModelEstate.ts"), "export"], { stdout: "pipe", stderr: "pipe" });
  return { ok: r.exitCode === 0, detail: (r.stdout.toString() + r.stderr.toString()).trim() };
}

if (import.meta.main) {
  const [cmd, ...rest] = process.argv.slice(2);
  const flag = (name: string) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; };
  if (cmd === "export") {
    const out = flag("--out") ?? EXPORT_PATH;
    const exp = await exportFromRegistry(flag("--registry") ?? REGISTRY_PATH);
    const changed = writeExport(exp, out);
    console.log(`${changed ? "wrote" : "unchanged"} ${out} (${Object.keys(exp.lanes).length} lanes)`);
  } else if (cmd === "check") {
    const want = renderExport(buildExport());
    const have = existsSync(EXPORT_PATH) ? readFileSync(EXPORT_PATH, "utf8") : "";
    if (want !== have) {
      console.error(`models.json is behind models.ts — run: bun ${join(dirname(EXPORT_PATH), "ModelEstate.ts")} export`);
      process.exit(1);
    }
    console.log("models.json matches models.ts");
  } else {
    console.log("ModelEstate: export [--registry <models.ts>] [--out <models.json>] | check");
    process.exit(cmd ? 2 : 0);
  }
}
