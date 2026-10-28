#!/usr/bin/env bun
/**
 * @version 1.2.2
 * 1.2.0 (2026-10-02): `status` lists workflow agents too (subagents/workflows/<run-id>/).
 * 1.1.0 (2026-10-02): agentTranscript also finds a workflow agent's transcript under subagents/workflows/<run-id>/.
 * AgentBudget.ts — every agent's wall-clock budget, and the one way to extend it.
 *
 *   bun LIFEOS/TOOLS/AgentBudget.ts status [--session <id>] [--json]
 *   bun LIFEOS/TOOLS/AgentBudget.ts extend <agentId> <minutes> --reason "<the principal's words>"
 *
 * WHY (2026-09-27): background agents ran far past 30 minutes; some hit their
 * 250-turn limit and were resumed anyway. OPERATIONAL_PREFERENCES said an agent past 30 minutes "gets
 * checked", but while the main session waits nothing wakes it, so the check never happened.
 * No hook enforces the budget; Workflows own agent deadlines. This module holds the
 * arithmetic and the status/extend CLI.
 *
 * An agent's clock starts at the first line of its transcript and never resets: a resume
 * continues the same clock. `extend` is the only way past it, and only on the principal's word;
 * every extension is one reasoned row in MEMORY/STATE/agent-budget/extensions.jsonl. No hook
 * guards that file, so an extension is the principal's word recorded by whoever runs the command.
 */

import { appendFileSync, existsSync, mkdirSync, openSync, readFileSync, readSync, closeSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { invariant } from "./Invariant";
import { getClaudeDir, getLifeosDir } from "./Paths";

export const BUDGET_MIN = 30;
/** Minutes after the budget in which the agent may still commit and report. */
export const GRACE_MIN = 5;
/** Minutes before the budget when the wind-down notice starts. */
export const WARN_MIN = 5;
export const MAX_EXTENSION_MIN = 120;

export type Phase = "ok" | "warn" | "wind-down" | "over";

export interface BudgetState {
  elapsedMin: number;
  limitMin: number;
  phase: Phase;
  /** Minutes until the hard stop (limit + grace); negative once past it. */
  remainingMin: number;
}

export function extensionsPath(): string {
  return process.env.LIFEOS_AGENT_BUDGET_EXTENSIONS ?? join(getLifeosDir(), "MEMORY", "STATE", "agent-budget", "extensions.jsonl");
}

export function logPath(): string {
  return process.env.LIFEOS_AGENT_BUDGET_LOG ?? join(getLifeosDir(), "MEMORY", "OBSERVABILITY", "agent-budget.jsonl");
}

export function safeId(value: unknown): string {
  return String(value ?? "").replace(/[^A-Za-z0-9_-]/g, "");
}

/** The phase for an agent that started at `startMs`, with `extraMin` granted by extensions. */
export function budgetState(startMs: number, nowMs: number, extraMin = 0): BudgetState {
  const elapsedMin = (nowMs - startMs) / 60_000;
  const limitMin = BUDGET_MIN + extraMin;
  const phase: Phase =
    elapsedMin >= limitMin + GRACE_MIN ? "over" : elapsedMin >= limitMin ? "wind-down" : elapsedMin >= limitMin - WARN_MIN ? "warn" : "ok";
  return { elapsedMin, limitMin, phase, remainingMin: limitMin + GRACE_MIN - elapsedMin };
}

/** Timestamp of a transcript's first line: the moment the agent started. Reads only the head. */
export function transcriptStartMs(path: string): number | null {
  if (!existsSync(path)) return null;
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(64 * 1024);
    const n = readSync(fd, buf, 0, buf.length, 0);
    const first = buf.subarray(0, n).toString("utf-8").split("\n")[0] ?? "";
    const ts = Date.parse(String(JSON.parse(first)?.timestamp ?? ""));
    return Number.isFinite(ts) ? ts : null;
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/** The agent's transcript: <session transcript dir>/<session>/subagents/agent-<id>.jsonl, or for a
 *  workflow agent <session>/subagents/workflows/<run-id>/agent-<id>.jsonl. */
export function agentTranscript(agentId: string, input: { transcript_path?: unknown; agent_transcript_path?: unknown; session_id?: unknown }): string | null {
  const id = safeId(agentId);
  if (!id) return null;
  const direct = String(input.agent_transcript_path ?? "");
  if (direct && existsSync(direct)) return direct;
  const own = String(input.transcript_path ?? "");
  if (own && basename(own) === `agent-${id}.jsonl` && existsSync(own)) return own;
  const session = safeId(input.session_id);
  if (!own || !session) return null;
  // A subagent's transcript_path may already sit inside <session>/subagents/.
  const dirs = [join(dirname(own), session, "subagents"), dirname(own)];
  for (const dir of dirs) {
    const p = join(dir, `agent-${id}.jsonl`);
    if (existsSync(p)) return p;
  }
  // A workflow agent's lives one level down: <session>/subagents/workflows/<run-id>/agent-<id>.jsonl.
  // The run id is unknown here, so search each run directory. A caller already inside a run
  // directory searches its sibling runs from the workflows root.
  const roots = dirs.map((d) => join(d, "workflows"));
  if (basename(dirname(own)) !== "workflows" && basename(dirname(dirname(own))) === "workflows") roots.push(dirname(dirname(own)));
  for (const root of roots) {
    let runs: string[];
    try { runs = readdirSync(root); } catch { continue; }
    for (const run of runs) {
      const p = join(root, run, `agent-${id}.jsonl`);
      if (existsSync(p)) return p;
    }
  }
  return null;
}

/** Minutes granted to one agent by extension rows. */
export function extensionMin(agentId: string, path = extensionsPath()): number {
  if (!existsSync(path)) return 0;
  let total = 0;
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row?.agent_id === agentId && Number.isFinite(row?.minutes)) total += row.minutes;
    } catch { /* a torn line never grants time */ }
  }
  return total;
}

export function recordExtension(agentId: string, minutes: number, reason: string, path = extensionsPath(), nowMs = Date.now()): void {
  const id = safeId(agentId);
  invariant(id.length > 0 && id === agentId, "an extension needs a plain agent id");
  invariant(Number.isInteger(minutes) && minutes > 0 && minutes <= MAX_EXTENSION_MIN, `an extension is 1..${MAX_EXTENSION_MIN} whole minutes`);
  invariant(reason.trim().length >= 8, "an extension needs a reason naming who asked for it");
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify({ ts: new Date(nowMs).toISOString(), agent_id: id, minutes, reason: reason.trim() })}\n`);
}

export function logEvent(row: Record<string, unknown>, path = logPath()): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify({ ts: new Date().toISOString(), ...row })}\n`);
  } catch { /* the log never decides a verdict */ }
}

// ---------------------------------------------------------------------------------------
// CLI

interface AgentRow {
  id: string;
  type: string;
  description: string;
  elapsedMin: number;
  limitMin: number;
  phase: Phase;
  lastActivityMin: number;
}

/** Every directory that holds agent transcripts: <session>/subagents, plus each workflow run under
 *  <session>/subagents/workflows/<run-id>/, where workflow lanes write theirs. */
function sessionDirs(session?: string, root = join(getClaudeDir(), "projects")): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  for (const project of readdirSync(root)) {
    const pdir = join(root, project);
    let entries: string[];
    try { entries = readdirSync(pdir); } catch { continue; }
    for (const s of entries) {
      if (session && s !== session) continue;
      const sub = join(pdir, s, "subagents");
      if (!existsSync(sub)) continue;
      out.push(sub);
      let runs: string[] = [];
      try { runs = readdirSync(join(sub, "workflows")); } catch { /* no workflow runs in this session */ }
      for (const run of runs) {
        const runDir = join(sub, "workflows", run);
        try { if (statSync(runDir).isDirectory()) out.push(runDir); } catch { /* vanished between list and stat */ }
      }
    }
  }
  return out;
}

export function agentRows(session?: string, nowMs = Date.now(), withinMin = 240, projectsRoot?: string): AgentRow[] {
  const rows: AgentRow[] = [];
  for (const dir of projectsRoot === undefined ? sessionDirs(session) : sessionDirs(session, projectsRoot)) {
    for (const f of readdirSync(dir)) {
      const m = /^agent-([A-Za-z0-9_-]+)\.jsonl$/.exec(f);
      if (!m) continue;
      const path = join(dir, f);
      const lastMs = statSync(path).mtimeMs;
      if ((nowMs - lastMs) / 60_000 > withinMin) continue;
      const start = transcriptStartMs(path);
      if (start === null) continue;
      let meta: { agentType?: string; description?: string } = {};
      try { meta = JSON.parse(readFileSync(join(dir, `agent-${m[1]}.meta.json`), "utf-8")); } catch { /* optional */ }
      const st = budgetState(start, nowMs, extensionMin(m[1]!));
      rows.push({
        id: m[1]!,
        type: meta.agentType ?? "?",
        description: meta.description ?? "",
        elapsedMin: Math.round(st.elapsedMin),
        limitMin: st.limitMin,
        phase: st.phase,
        lastActivityMin: Math.round((nowMs - lastMs) / 60_000),
      });
    }
  }
  return rows.sort((a, b) => b.elapsedMin - a.elapsedMin);
}

function usage(): never {
  console.error('usage: AgentBudget.ts status [--session <id>] [--json]\n       AgentBudget.ts extend <agentId> <minutes> --reason "<who asked and why>"');
  process.exit(2);
}

if (import.meta.main) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "status") {
    const si = rest.indexOf("--session");
    const rows = agentRows(si >= 0 ? rest[si + 1] : undefined);
    if (rest.includes("--json")) console.log(JSON.stringify(rows, null, 2));
    else if (rows.length === 0) console.log("no agents active in the last 4 hours");
    else for (const r of rows)
      console.log(`${r.phase.padEnd(9)} ${String(r.elapsedMin).padStart(4)}/${r.limitMin} min  ${r.type.padEnd(10)} ${r.id}  ${r.description}  (last activity ${r.lastActivityMin} min ago)`);
  } else if (cmd === "extend") {
    const [id, minutes] = rest;
    const ri = rest.indexOf("--reason");
    const reason = ri >= 0 ? rest[ri + 1] ?? "" : "";
    if (!id || !minutes || !reason) usage();
    recordExtension(id, Number(minutes), reason);
    logEvent({ kind: "extend", agent_id: id, minutes: Number(minutes), reason });
    console.log(`extended ${id} by ${minutes} min`);
  } else usage();
}
