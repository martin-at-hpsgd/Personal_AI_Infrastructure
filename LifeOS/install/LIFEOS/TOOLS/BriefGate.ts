/**
 * @version 1.0.2
 * BriefGate.ts — a leg below Astra arrives with the deciding already done, or it does not go.
 *
 * WHY (the principal's rule): "appropriately giving the context, the instructions, and everything
 * to a lower model so it knows exactly how to execute without thinking." A worker below the top rung is
 * an executor: every decision it would otherwise have to make is one the caller already made and wrote
 * down. Nothing measured that, so a one-line task reached a weak model with all the judgment undone.
 *
 * WHAT IS CHECKABLE FROM TEXT, and what is not. The 1.0.0 draft of this check lived in Worker.ts and
 * asked for a path token and a command token. A cross-vendor audit broke it in one line:
 * "Refactor LIFEOS/ROUTER/FrontDoor.ts so lane selection reads better; run bun test ./LIFEOS/ROUTER"
 * passes both and is pure undecided judgment. A carrier that has not thought still knows which file it
 * is pointing at. So the gate moved to the one section a caller cannot write without having decided:
 *
 *   - acceptance — what must be TRUE when this is done, in the caller's own words.
 *   - paths      — where the work happens, so the worker is not searching for its own target.
 *
 * It still cannot see whether the decision written down was the RIGHT one. No code can. This raises the
 * floor on thoughtlessness; it does not verify judgment, and it is not sold as doing so.
 *
 * The same audit found the 1.0.0 check guarded one door: the Sol agent wrapper calls
 * CodexProgress.ts directly, so they routed around it. It now runs in the helper every path shares.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { lifeosPath } from "./Paths";

/** Lanes whose brief must arrive decided. Astra is absent on purpose: an open question is a valid brief
 *  there, because judgment is what that lane is for. Luna and Terra (retired 2026-10-07) are gone: the Haiku agents are
 *  in-session Claude subagents, so their briefs never reach this codex door. */
export const EXECUTOR_LANES = new Set(["sol"]);

export const BRIEF_GAP_HELP: Record<string, string> = {
  acceptance: "say what must be TRUE when this is done — a `Done when:` line naming the command that proves it, or the condition an observer could check. This is the section that cannot be written without deciding, which is why it is the one being asked for",
  paths: "name the files or the directory the work happens in — a worker that has to find its own target is deciding, not executing",
};

/** Links and bare domains are not repo paths; a task whose only slash was a URL used to satisfy "paths". */
const URL_RE = /\bhttps?:\/\/\S+|\b[\w-]+\.(?:com|org|net|io|dev|ai|co|sh|app|gg|me|xyz)\b\S*/gi;
const PATH_RE = /(?:^|[\s"'`(])(?:\.{1,2}\/)?(?:[\w.-]+\/)+[\w.-]+|[\w-]+\.(?:ts|tsx|js|jsx|md|json|jsonl|sh|yaml|yml|toml|css|html|sql|txt|go|rs)\b/;
const ACCEPT_RE = /\b(?:done when|done looks like|acceptance criteria|acceptance|accept when|success when)\b[\s:.-]*\S/i;

/** The checkable gaps in a brief bound for an executor lane, in a stable order. Pure. */
export function briefGaps(task: string): string[] {
  const withoutUrls = task.replace(URL_RE, " ");
  const gaps: string[] = [];
  if (!ACCEPT_RE.test(task)) gaps.push("acceptance");
  if (!PATH_RE.test(withoutUrls)) gaps.push("paths");
  return gaps;
}

/** The refusal a caller reads. Pure. */
export function refusalMessage(agent: string, gaps: string[]): string {
  return (
    `this brief sends ${agent} work with the deciding still in it. Missing: ` +
    gaps.map(g => `${g} — ${BRIEF_GAP_HELP[g]}`).join("; ") +
    `. Add it and re-run, or run the leg in audit mode (read-only) if the judgment is the work.`
  );
}

/**
 * Every refusal is counted. An ungated escape hatch trains itself into a reflex, so there is none: the
 * 1.0.0 `NO-VERIFY:` line disabled the check with nothing recorded, and was retired the day it shipped.
 * If this ledger fills with refusals, the gate is mis-tuned and the ledger is the evidence for retuning it.
 */
export function logRefusal(agent: string, slug: string, gaps: string[], path = lifeosPath("MEMORY", "OBSERVABILITY", "route-fidelity.jsonl")): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify({ ts: new Date().toISOString(), kind: "brief-refused", agent, slug, gaps }) + "\n");
  } catch { /* observability is fail-open; the refusal itself is not */ }
}

/** The gate. Returns the refusal text, or null when the brief may go. */
export function checkBrief(lane: string, agent: string, slug: string, task: string, readOnly = false): string | null {
  // A read-only run is an audit or an analysis: an open question is its brief, so it is never held to the executor shape (Sol audit mode, 2026-10-12).
  if (readOnly || !EXECUTOR_LANES.has(lane.toLowerCase())) return null;
  const gaps = briefGaps(task);
  if (!gaps.length) return null;
  logRefusal(agent, slug, gaps);
  return refusalMessage(agent, gaps);
}
