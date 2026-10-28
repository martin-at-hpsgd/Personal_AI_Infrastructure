/**
 * @version 1.0.0
 * run-attribution.ts — which run and turn an output belongs to, for the output ledger's join keys.
 *
 * EventLogger.hook.ts writes the run line (MEMORY/SKILLS/execution.jsonl) and, beside it, one small state file per
 * session: MEMORY/STATE/run-state/<session>.json = { run_id, turn, skill, ts }, the latest Skill invoked in that session.
 * An output's run_id is that latest run ("last Skill invoked; null if none", Design.md §4), its skill is the run's
 * skill, and its turn is the router turn id of the prompt being worked (readPick, with the same 6 h staleness guard
 * EventLogger applies). Unknown values stay null; nothing here guesses.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { lifeosPath } from "../../LIFEOS/TOOLS/Paths";
import { readPick } from "./router-pick";

const SAFE_SESSION = /^[A-Za-z0-9_-]{1,128}$/;
const TURN_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const RUN_ID = /^run_[0-9a-f-]{36}$/;

export type Attribution = { run_id: string | null; skill: string | null; turn: string | null };

export function runStateDir(): string {
  return process.env.LIFEOS_RUN_STATE_DIR || lifeosPath("MEMORY", "STATE", "run-state");
}

export function attribution(session: string | null | undefined, opts: { runStateDir?: string; pickDir?: string; now?: number } = {}): Attribution {
  const none: Attribution = { run_id: null, skill: null, turn: null };
  if (!session || !SAFE_SESSION.test(session)) return none;
  const out = { ...none };
  try {
    const s = JSON.parse(readFileSync(join(opts.runStateDir ?? runStateDir(), session + ".json"), "utf8")) as { run_id?: unknown; skill?: unknown };
    if (typeof s.run_id === "string" && RUN_ID.test(s.run_id)) {
      out.run_id = s.run_id;
      if (typeof s.skill === "string" && s.skill.length > 0) out.skill = s.skill;
    }
  } catch { /* no run recorded for this session */ }
  try {
    const pick = readPick(session, (opts.now ?? Date.now()) - TURN_MAX_AGE_MS, opts.pickDir);
    if (pick && typeof pick.turn === "string" && pick.turn.length > 0) out.turn = pick.turn;
  } catch { /* no pick: turn stays null */ }
  return out;
}
