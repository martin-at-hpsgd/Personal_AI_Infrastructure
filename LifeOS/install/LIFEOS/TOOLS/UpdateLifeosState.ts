#!/usr/bin/env bun
/**
 * @version 1.5.1
 */
// Normalize env path vars Claude Code may inject unexpanded — literal $HOME/${HOME}
// in LIFEOS_DIR/LIFEOS_CONFIG_DIR/PROJECTS_DIR resolves to a shadow dir (#1404 / PR #1451, author jbmml).
for (const __k of ["LIFEOS_DIR", "LIFEOS_CONFIG_DIR", "PROJECTS_DIR"]) {
  const __v = process.env[__k];
  if (__v && /^\$\{?HOME\}?(\/|$)/.test(__v)) process.env[__k] = __v.replace(/^\$\{?HOME\}?/, process.env.HOME ?? "~");
}

/**
 * UpdateLifeosState — Writes LIFEOS_STATE.json with per-dimension pct scores read by
 * the statusline (LIFEOS/LIFEOS_StatusLine.sh) STATE strip and the Pulse TELOS
 * dashboard rings.
 *
 * Pct semantics:
 *   - If the ideal-state loop has measured bound target rows for the dimension
 *     (`IdealState.ts reconcile`), pct = mean progress of those rows × 100.
 *   - If `CURRENT_STATE/<DIM>.md` exists with `status: have|partial|missing`
 *     rows, pct = (have + 0.5 × partial) / total × 100 — real coverage.
 *   - Else falls back to IDEAL_STATE articulation completeness (also written
 *     on every dimension as `articulation_pct`, never mixed into a measured pct):
 *     `100 - (TBD markers × 10)`, clamped 0..100.
 *
 * The fallback measures whether the principal has articulated what "good"
 * looks like; the primary path measures whether reality matches it.
 *
 * Reads:  LIFEOS/USER/TELOS/IDEAL_STATE/<DIM>.md (target articulation)
 *         LIFEOS/USER/TELOS/CURRENT_STATE/<DIM>.md (actual coverage, when present)
 * Writes: LIFEOS/USER/TELOS/LIFEOS_STATE.json
 *
 * Template-style: works on any user's LifeOS install — no hardcoded paths,
 * no principal-specific names. Fresh installs land all dimensions at 0 until the
 * principal runs the IDEAL_STATE interview.
 *
 * Usage:
 *   bun ~/.claude/LIFEOS/TOOLS/UpdateLifeosState.ts
 *   bun ~/.claude/LIFEOS/TOOLS/UpdateLifeosState.ts --json
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "node:os";
import { invariant } from "./Invariant";
import { getLifeosDir } from "./Paths";
import { readJson, statePath } from "../IDEALSTATE/Store";
import type { ReconcileReport } from "../IDEALSTATE/Reconcile"; // public issue #1974 @sabo961, PR #1918 @PigLardLord

// Normalize env path vars that Claude Code injects without shell expansion (LifeOS#1404)
for (const k of ["LIFEOS_DIR", "LIFEOS_CONFIG_DIR", "PROJECTS_DIR"]) {
  const v = process.env[k];
  if (v && /^\$\{?HOME\}?(\/|$)/.test(v)) process.env[k] = v.replace(/^\$\{?HOME\}?/, process.env.HOME ?? "~");
}


const HOME = process.env.HOME ?? process.env.USERPROFILE ?? homedir();
const LIFEOS_DIR = getLifeosDir();
const IDEAL_DIR = join(LIFEOS_DIR, "USER", "TELOS", "IDEAL_STATE");
const CURRENT_DIR = join(LIFEOS_DIR, "USER", "TELOS", "CURRENT_STATE");
const STATE_FILE = join(LIFEOS_DIR, "USER", "TELOS", "LIFEOS_STATE.json");

// `file` is the IDEAL_STATE name. CURRENT_STATE names can differ for two dimensions: the
// shipped template carries MONEY.md and RELATIONSHIPS.md, and an install may name them
// FINANCIAL.md and SOCIAL.md, so `current` lists both and the first one that exists is read.
const DIMENSIONS = [
  { id: "health",         file: "HEALTH.md",         current: ["HEALTH.md"] },
  { id: "money",          file: "MONEY.md",          current: ["FINANCIAL.md", "MONEY.md"] },
  { id: "freedom",        file: "FREEDOM.md",        current: ["FREEDOM.md"] },
  { id: "creative",       file: "CREATIVE.md",       current: ["CREATIVE.md"] },
  { id: "relationships",  file: "RELATIONSHIPS.md",  current: ["SOCIAL.md", "RELATIONSHIPS.md"] },
  { id: "rhythms",        file: "RHYTHMS.md",        current: ["RHYTHMS.md"] },
  { id: "infrastructure", file: "INFRASTRUCTURE.md", current: ["INFRASTRUCTURE.md"] },
] as const;

type DimensionId = (typeof DIMENSIONS)[number]["id"];

interface DimensionState {
  pct: number | null;
  articulation_pct?: number | null;
  tbd_count: number;
  last_updated: string | null;
  source_file: string;
}

interface LifeosState {
  generated_at: string;
  dimensions: Record<DimensionId, DimensionState>;
}

function readFrontmatterField(content: string, key: string): string | null {
  if (!content.startsWith("---")) return null;
  const end = content.indexOf("\n---", 3);
  if (end === -1) return null;
  const fm = content.slice(3, end);
  const m = fm.match(new RegExp(`^${key}:\\s*(.+?)\\s*$`, "m"));
  return m ? m[1].replace(/^["']|["']$/g, "") : null;
}

function readFrontmatterDate(content: string): string | null {
  return readFrontmatterField(content, "last_updated");
}

// The shipped scaffold carries `provenance: template`; it is not captured
// state and must never score as a number (a template CURRENT file computed
// 0%, a template IDEAL file 70%, both rendered as real coverage on a fresh
// install). (public issues #2049, #2050, @lgertel; #1960, @hjbrandt)
function isTemplate(content: string): boolean {
  if (readFrontmatterField(content, "provenance") !== "template") return false;
  // The interview edits these files in place and stamps `last_updated_by`
  // (TelosFreshness.bumpReviewedTimestamp); a principal-reviewed file is
  // captured even if the provenance line was never removed by hand.
  const by = readFrontmatterField(content, "last_updated_by");
  return !by || by === "bootstrap-template";
}

function computeFromCurrent(files: readonly string[]): DimensionState | null {
  const file = files.find((f) => existsSync(join(CURRENT_DIR, f)));
  if (!file) return null;
  const path = join(CURRENT_DIR, file);
  const content = readFileSync(path, "utf-8");
  if (isTemplate(content)) return null; // fall through to IDEAL_STATE articulation
  const have    = (content.match(/\bstatus:\s*have\b/g)    || []).length;
  const partial = (content.match(/\bstatus:\s*partial\b/g) || []).length;
  const missing = (content.match(/\bstatus:\s*missing\b/g) || []).length;
  // Fail loud on unrecognized status keywords (public issue #1509): a synonym
  // like `status: populated` used to silently count as nothing, so a fully
  // populated file computed as 0% coverage with no signal anything was wrong.
  const RECOGNIZED = new Set(["have", "partial", "missing"]);
  const unrecognized = [...content.matchAll(/\bstatus:\s*([A-Za-z][\w-]*)/g)]
    .map((m) => m[1]!.toLowerCase())
    .filter((kw) => !RECOGNIZED.has(kw));
  if (unrecognized.length > 0) {
    const uniq = [...new Set(unrecognized)].join(", ");
    process.stderr.write(
      `[UpdateLifeosState] WARNING: ${file} has ${unrecognized.length} unrecognized status keyword(s) (${uniq}) — ` +
      `only have/partial/missing count toward coverage, so the reported percentage is wrong until fixed.\n`,
    );
  }
  const total = have + partial + missing;
  if (total === 0) return null;
  const pct = Math.round(((have + 0.5 * partial) / total) * 100);
  return {
    pct,
    tbd_count: missing,
    last_updated: readFrontmatterDate(content),
    source_file: `CURRENT_STATE/${file}`,
  };
}

function computeFromIdeal(file: string): DimensionState {
  const path = join(IDEAL_DIR, file);
  if (!existsSync(path)) {
    return { pct: null, tbd_count: 0, last_updated: null, source_file: file };
  }
  const content = readFileSync(path, "utf-8");
  const tbd_count = (content.match(/\bTBD\b/g) || []).length;
  // Template articulation is "not captured": null, never 100 - TBDs.
  const pct = isTemplate(content) ? null : Math.max(0, Math.min(100, 100 - tbd_count * 10));
  return {
    pct,
    tbd_count,
    last_updated: readFrontmatterDate(content),
    source_file: `IDEAL_STATE/${file}`,
  };
}

/** Measured progress from the ideal-state loop's latest reconcile, when it bound rows in this dimension. */
function computeFromReconcile(file: string, report: ReconcileReport | null): DimensionState | null {
  const rows = (report?.rows ?? []).filter((r) => r.file === file && typeof r.progress === "number");
  if (rows.length === 0) return null;
  const pct = Math.round((rows.reduce((s, r) => s + (r.progress as number), 0) / rows.length) * 100);
  const ideal = computeFromIdeal(file);
  return { pct, tbd_count: ideal.tbd_count, last_updated: ideal.last_updated, source_file: `reconcile:IDEAL_STATE/${file}` };
}

function computeState(file: string, current: readonly string[], report: ReconcileReport | null): DimensionState {
  const base = computeFromReconcile(file, report) ?? computeFromCurrent(current) ?? computeFromIdeal(file);
  return { ...base, articulation_pct: computeFromIdeal(file).pct };
}

function build(): LifeosState {
  const dimensions = {} as Record<DimensionId, DimensionState>;
  const report = readJson<ReconcileReport | null>(statePath("reconcile.json"), null);
  for (const d of DIMENSIONS) {
    dimensions[d.id] = computeState(d.file, d.current, report);
  }
  return {
    generated_at: new Date().toISOString(),
    dimensions,
  };
}

function main(): void {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log("usage: bun UpdateLifeosState.ts [--json]   rewrites LIFEOS_STATE.json");
    return;
  }
  const state = build();
  for (const d of DIMENSIONS) {
    const p = state.dimensions[d.id].pct;
    invariant(p === null || (Number.isInteger(p) && p >= 0 && p <= 100), `${d.id} pct must be null or 0..100, got ${p}`);
  }
  const dir = dirname(STATE_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n");
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(state, null, 2));
  } else {
    console.log(`LIFEOS_STATE.json updated: ${STATE_FILE}`);
    for (const d of DIMENSIONS) {
      const s = state.dimensions[d.id];
      const pctStr = s.pct === null ? "—" : `${s.pct}%`;
      console.log(`  ${d.id.padEnd(14)} ${pctStr.padStart(5)}  (${s.tbd_count} TBDs, updated ${s.last_updated ?? "unknown"})`);
    }
  }
}

main();
