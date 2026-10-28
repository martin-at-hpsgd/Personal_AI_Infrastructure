/**
 * The global pause (ISA ISC-123): one switch that stops the whole Workflows
 * fleet from starting anything new. State is `paused.json` beside the ledger.
 * `workflow pause --all` and `resume --all` flip it, `workflow run` refuses
 * while it is set, the dispatcher starts nothing while it is set, and Pulse
 * reads it for the header indicator. A run already going is not touched; use
 * `workflow stop` for that.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { invariant } from "../../TOOLS/Invariant.ts";
import { ensureInside, writeFileAtomic } from "./ledger.ts";
import { ledgerPath } from "./paths.ts";

export function pausePath(ledger: string = ledgerPath()): string {
  return join(dirname(ledger), "paused.json");
}

/** True while the global pause is on. A missing, unreadable or malformed file means not paused. */
export function isGloballyPaused(ledger: string = ledgerPath()): boolean {
  const path = pausePath(ledger);
  if (!existsSync(path)) return false;
  try {
    return (JSON.parse(readFileSync(path, "utf8")) as { paused?: unknown }).paused === true;
  } catch {
    return false;
  }
}

/** Turns the global pause on or off. Writes through a temp file and a rename, so a reader never sees half a file. */
export function setGlobalPause(on: boolean, ledger: string = ledgerPath()): void {
  invariant(typeof on === "boolean", "The global pause is on or off");
  invariant(ledger.endsWith(".jsonl"), `Ledger path must be a .jsonl file: ${ledger}`);
  const path = pausePath(ledger);
  ensureInside(dirname(ledger), path, "Pause state");
  mkdirSync(dirname(path), { recursive: true });
  const state = { paused: on, at: new Date().toISOString() };
  invariant(Number.isFinite(Date.parse(state.at)), "The pause state carries a timestamp");
  writeFileAtomic(path, `${JSON.stringify(state)}\n`);
}
