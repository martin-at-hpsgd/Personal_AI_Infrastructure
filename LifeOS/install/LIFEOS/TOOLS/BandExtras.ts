/**
 * BandExtras.ts — the four facts the LifeOSHooks band and footer add in F12 (FUNCTIONHOOKS ISC-173):
 * voice mode, fast mode, this session's deadline, and the next scheduled workflow fire.
 *
 * Read-only. `HookBridge band-state` merges `bandExtras(sid)` into its reply; each field degrades to its
 * empty value on its own, so one unreadable source never blanks the others.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getClaudeDir } from "./Paths";
import { isOn as voiceOn } from "./VoiceMode";
import { deadlinesPath } from "../ROUTER/Shape";
import { DEFINITION_SUFFIX, definitionsDir, ledgerPath } from "../WORKFLOWS/engine/paths.ts";
import { loadDefinitionFile } from "../WORKFLOWS/engine/format.ts";
import { nextFire, scheduleStateDir } from "../WORKFLOWS/engine/schedule.ts";
import { readLedger } from "../WORKFLOWS/engine/ledger.ts";
import { isGloballyPaused } from "../WORKFLOWS/engine/pause.ts";

export interface BandExtras {
  voice: boolean;
  fast: boolean;
  /** ISO due time of this session's latest deadline row, or null. */
  deadline: string | null;
  /** The soonest scheduled fire across valid, unpaused definitions. */
  nextWorkflow: { name: string; at: string } | null;
}

export function fastModeOn(settingsPath = join(getClaudeDir(), "settings.json")): boolean {
  try { return (JSON.parse(readFileSync(settingsPath, "utf8")) as { fastMode?: unknown }).fastMode === true; } catch { return false; }
}

/** The due time of the last deadline row this session wrote; rows are append-only, so the tail is newest. */
export function sessionDeadline(sid: string, path = deadlinesPath()): string | null {
  if (!sid || !existsSync(path)) return null;
  const lines = readFileSync(path, "utf8").trimEnd().split("\n");
  for (let i = lines.length - 1; i >= 0 && i >= lines.length - 400; i--) {
    try {
      const row = JSON.parse(lines[i]!) as { session?: string; due?: string | null };
      if (row.session === sid) return typeof row.due === "string" ? row.due : null;
    } catch { /* a torn line */ }
  }
  return null;
}

export function nextWorkflow(now = new Date(), dir = definitionsDir()): { name: string; at: string } | null {
  if (!existsSync(dir) || isGloballyPaused()) return null;
  const ledger = readLedger(ledgerPath()).records;
  const stateDir = scheduleStateDir(ledgerPath());
  let best: { name: string; at: string } | null = null;
  for (const file of readdirSync(dir).filter((f) => f.endsWith(DEFINITION_SUFFIX))) {
    try {
      const { def } = loadDefinitionFile(join(dir, file));
      if ((def as { enabled?: boolean }).enabled === false) continue;
      const runs = ledger.filter((r) => r.workflow === def.name);
      const lastStart = runs.length ? Date.parse(runs[runs.length - 1]!.started_at) : Number.NaN;
      for (const t of def.triggers) {
        // Calendar and one-time fires only: interval heartbeats (a refresh every few minutes) would always win and say nothing.
        if (t.type !== "schedule" && t.type !== "once") continue;
        const at = nextFire(t, def.name, now, lastStart, stateDir)?.toISOString();
        if (at && (!best || at < best.at)) best = { name: def.name, at };
      }
    } catch { /* an invalid definition has no fire */ }
  }
  return best;
}

export function bandExtras(sid: string): BandExtras {
  let voice = false, deadline: string | null = null, next: BandExtras["nextWorkflow"] = null;
  try { voice = voiceOn(sid); } catch { /* off */ }
  try { deadline = sessionDeadline(sid); } catch { /* none */ }
  try { next = nextWorkflow(); } catch { /* none */ }
  return { voice, fast: fastModeOn(), deadline, nextWorkflow: next };
}

if (import.meta.main) console.log(JSON.stringify(bandExtras(process.argv[2] ?? "")));
