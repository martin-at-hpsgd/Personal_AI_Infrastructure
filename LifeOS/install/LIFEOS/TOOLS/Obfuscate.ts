#!/usr/bin/env bun
/**
 * Obfuscate — the one obfuscation switch for streaming and screen sharing (the
 * obfuscation-mode ISA). While it is on, the statusline names accounts by nickname instead of
 * email and Pulse turns on Observer mode.
 *
 * It is on when OBS is running, or when the principal forced it on with `ob`. Typing `ob` while OBS holds it on
 * records an off override for that OBS run only, so a later OBS run is covered again and an old choice never
 * exposes a new stream.
 *
 * State: MEMORY/STATE/obfuscate.json (LIFEOS_OBFUSCATE_FILE overrides). OBS is detected by its crash sentinel: OBS
 * (30+) writes a run_<id> file to ~/Library/Application Support/obs-studio/.sentinel at launch and deletes it on a clean
 * exit (LIFEOS_OBS_SENTINEL_DIR overrides). Reading a directory starts no process, so every statusline draw can check it.
 * A crash leaves the file behind, which errs toward hiding; `ob` turns it off for that run.
 *
 * Usage: bun LIFEOS/TOOLS/Obfuscate.ts [status|toggle|on|off|auto] [--json]
 */
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { invariant } from "./Invariant.ts";
import { lifeosDirFor } from "./Paths.ts";

export type Forced = "on" | "off" | null;
export interface ObfuscateState { forced: Forced; obsRun: string | null; at: string }
export type Reason = "manual" | "obs" | "override" | "off";
export interface Obfuscation { on: boolean; reason: Reason; obsRun: string | null }

export interface Opts {
  env?: Record<string, string | undefined>;
  now?: number;
}

const env = (o: Opts) => o.env ?? process.env;
const home = (o: Opts) => env(o).HOME || homedir();
export const stateFile = (o: Opts = {}): string =>
  env(o).LIFEOS_OBFUSCATE_FILE || join(lifeosDirFor(env(o), home(o)), "MEMORY", "STATE", "obfuscate.json");
export const sentinelDir = (o: Opts = {}): string =>
  env(o).LIFEOS_OBS_SENTINEL_DIR || join(home(o), "Library", "Application Support", "obs-studio", ".sentinel");

function readJson(path: string): unknown {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

function writeJson(path: string, value: unknown): void {
  invariant(path.length > 0, "an obfuscation file has a path");
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp.${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  renameSync(temp, path);
}

/**
 * The current OBS run id: its newest sentinel file by modification time, so a crash leftover beside a new run never
 * names the run. Null when OBS is not running.
 */
export function obsRun(o: Opts = {}): string | null {
  const dir = sentinelDir(o);
  let runs: { name: string; at: number }[];
  try {
    runs = readdirSync(dir).filter((n) => n.startsWith("run_")).map((name) => {
      try { return { name, at: statSync(join(dir, name)).mtimeMs }; } catch { return { name, at: 0 }; }
    });
  } catch { return null; }
  runs.sort((x, y) => x.at - y.at || x.name.localeCompare(y.name));
  return runs.at(-1)?.name ?? null;
}

export function readState(o: Opts = {}): ObfuscateState {
  const raw = readJson(stateFile(o)) as Partial<ObfuscateState> | null;
  const forced: Forced = raw?.forced === "on" || raw?.forced === "off" ? raw.forced : null;
  return { forced, obsRun: typeof raw?.obsRun === "string" ? raw.obsRun : null, at: typeof raw?.at === "string" ? raw.at : "" };
}

/** The rule: forced on wins; an off override holds only for the OBS run it was made under; OBS running is on. */
export function evaluate(state: ObfuscateState, run: string | null): Obfuscation {
  if (state.forced === "on") return { on: true, reason: "manual", obsRun: run };
  if (run !== null && state.forced === "off" && state.obsRun === run) return { on: false, reason: "override", obsRun: run };
  if (run !== null) return { on: true, reason: "obs", obsRun: run };
  return { on: false, reason: "off", obsRun: null };
}

/** Whether obfuscation is on now. Never throws: an unreadable state reads as no override. */
export function obfuscation(o: Opts = {}): Obfuscation {
  return evaluate(readState(o), obsRun(o));
}

/** Writes an explicit choice. "auto" clears any override, so OBS alone decides. */
export function setMode(mode: "on" | "off" | "auto", o: Opts = {}): Obfuscation {
  const run = obsRun(o);
  const next: ObfuscateState = {
    // "off" with no OBS running needs no override: off is already what OBS-absent means.
    forced: mode === "auto" ? null : mode === "off" ? (run === null ? null : "off") : "on",
    obsRun: mode === "off" ? run : null,
    at: new Date(o.now ?? Date.now()).toISOString(),
  };
  invariant(next.forced !== "off" || next.obsRun !== null, "an off override names the OBS run it holds for");
  writeJson(stateFile(o), next);
  return evaluate(next, run);
}

/** Flips what is showing now: on becomes off (for this OBS run when OBS holds it), off becomes forced on. */
export function toggle(o: Opts = {}): Obfuscation {
  return setMode(obfuscation(o).on ? "off" : "on", o);
}

export function describe(s: Obfuscation): string {
  const why: Record<Reason, string> = {
    manual: "turned on with ob",
    obs: "OBS is running",
    override: "turned off with ob for this OBS run",
    off: "OBS is not running",
  };
  return `Obfuscation ${s.on ? "ON" : "OFF"} (${why[s.reason]})`;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const cmd = args.find((a) => !a.startsWith("--")) ?? "status";
  let result: Obfuscation;
  if (cmd === "status") result = obfuscation();
  else if (cmd === "toggle") result = toggle();
  else if (cmd === "on" || cmd === "off" || cmd === "auto") result = setMode(cmd);
  else {
    console.error("usage: Obfuscate.ts [status|toggle|on|off|auto] [--json]");
    process.exit(2);
  }
  console.log(json ? JSON.stringify(result) : describe(result));
}
