/**
 * router-pick.ts — the dispatch advisor's pick for the current turn, on disk, so the surfaces
 * that show routing can read it: the LifeOSHooks plugin's router line under the prompt (through
 * the bridge verb `router-pick`) and the statusline's ▸ mark (FUNCTIONHOOKS ISA ISC-60..62).
 *
 * Caller context: the pick is the `dispatch-advisor` caller's `lane` answer (Assay's judgment
 * layer, engine Clef-omni; LIFEOS/DOCUMENTATION/Assay/AssaySystem.md § Judgment layer). Nothing that reads this file
 * may dispatch, block, or select a model or mode. Nothing acts on it since effort routing was
 * deleted 2026-10-25 (Router ISA R42–R45); EventLogger and run attribution read it as a record. This row is overwritten by every prompt,
 * notifications included.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { lifeosPath } from "../../LIFEOS/TOOLS/Paths";
import { CROSS_VENDOR, CURRENT, EFFORT_MODEL, WORK_LADDER } from "../../LIFEOS/TOOLS/models";
import { invariant } from "../../LIFEOS/TOOLS/Invariant";
import type { RouterLevels } from "./route-label";

export interface RouterPickRow {
  ts: number;
  session: string;
  lane: string | null;
  p: number | null;
  confidence: number | null;
  skip: string | null;
  /** Display: true on a binding (MAX) verdict. Nothing enforces it. */
  binding?: boolean;
  thinking?: string[];
  directive?: string | null;
  /** The reasoning effort the router picked (low|medium|high|xhigh), independent of the model. */
  effort?: string | null;
  /** The concrete runner: the base Claude agent (Opus, Sonnet, Haiku, Fable; the effort rides in `effort` and is passed as the Agent tool's `effort` parameter) or `Worker.ts <lane> --effort <e>`. Rows written before 2026-10-15 may carry a retired variant name such as OpusXHigh; `baseAgentOf` in LIFEOS/TOOLS/models.ts maps it to its base. */
  agent?: string | null;
  /** The router turn id, joining this row to router-decisions.jsonl and the plugin's effort rows. */
  turn?: string;
  /** Who decided: jev (the judgment layer; stored value named for the engine retired 2026-10-10), opus, directive, skip, unavailable. */
  source?: string;
  /** The learned effort head's probability per level (R42). */
  effortProbs?: Record<string, number> | null;
  /** The prompt arrived wrapped as a paste (dictation). */
  dictated?: boolean;
}

const SAFE_SESSION = /^[A-Za-z0-9_-]{1,128}$/;

/** The pick directory; LIFEOS_ROUTER_PICK_DIR redirects it so a test never writes the live state. */
export function pickDir(): string {
  return process.env.LIFEOS_ROUTER_PICK_DIR || lifeosPath("MEMORY", "STATE", "router-pick");
}

export function pickPath(session: string, dir = pickDir()): string {
  return `${dir}/${session}.json`;
}

/** Write this turn's pick, replacing the last one. Atomic: a reader never sees half a row. */
export function writePick(row: RouterPickRow, dir?: string): void {
  invariant(SAFE_SESSION.test(row.session), "router-pick: session id must be a plain token");
  invariant(Number.isFinite(row.ts) && row.ts > 0, "router-pick: ts must be a positive epoch ms");
  invariant(row.lane !== null || !!row.skip, "router-pick: a row carries a lane or a skip reason");
  invariant(row.p === null || (row.p >= 0 && row.p <= 1), "router-pick: p must be a probability");
  const path = pickPath(row.session, dir);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(row));
  renameSync(tmp, path);
}

/** The pick written at or after `sinceMs`, or null: an older row belongs to an earlier prompt. */
export function readPick(session: string, sinceMs = 0, dir?: string): RouterPickRow | null {
  if (!SAFE_SESSION.test(session)) return null;
  try {
    const row = JSON.parse(readFileSync(pickPath(session, dir), "utf8")) as RouterPickRow;
    if (typeof row.ts !== "number" || row.ts < sinceMs) return null;
    return row;
  } catch { return null; }
}

/** Lane → level and lane → model id, from the registry. The plugin gets this through `codex-lanes`. */
export function routerLevels(): RouterLevels {
  const lanes: Record<string, string> = {};
  const tiers: Record<string, string> = {};
  const models: Record<string, string> = {};
  // A lane on several rungs reports its highest work rung (Opus: high; Sol sits on medium and high since 2026-10-07, so it stays high).
  for (const [level, agents] of Object.entries(WORK_LADDER)) for (const a of agents) { const k = a.toLowerCase(); if (lanes[k] === "high" && (level === "medium" || level === "low")) continue; lanes[k] = level; }
  // First write wins, and EFFORT_MODEL is declared max→low, so a tier serving several rungs
  // (sonnet holds medium and low since 2026-09-28) reports its HIGHEST.
  for (const [level, tier] of Object.entries(EFFORT_MODEL)) { tiers[tier] ??= level; lanes[tier] ??= level; }
  for (const lane of Object.keys(lanes)) {
    const id = (CROSS_VENDOR as Record<string, string>)[lane] ?? (CURRENT as Record<string, string>)[lane];
    if (id) models[lane] = id;
  }
  return { lanes, tiers, models };
}
