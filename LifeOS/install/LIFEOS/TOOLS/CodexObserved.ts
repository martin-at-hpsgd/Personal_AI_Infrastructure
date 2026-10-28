/**
 * CodexObserved.ts — what model a `codex exec` run actually ran on, per process.
 *
 * FUNCTIONHOOKS ISA ISC-53. `CodexProgress.ts` passes `--model <lane>` and stamps that as
 * `forge.model.resolved` — the invocation, a config echo. Codex's own session log (the rollout
 * under `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<local ts>-<thread_id>.jsonl`) carries a
 * `turn_context` row naming the model the turn ran on. The rollout filename ends in the
 * thread id the `thread.started` event reports on stdout (verified 2026-09-09: session_meta
 * `payload.id` == filename uuid == every `thread_id` in the file), so the binding is exact:
 * this run, this thread, this model — no time-window overlap.
 *
 * Runs whose isolated home passed `--ephemeral` wrote no rollout; ISC-53 dropped that flag
 * so the scratch home keeps the log until the next run of the same agent wipes the dir.
 *
 * One row per run is appended to `MEMORY/OBSERVABILITY/codex-runs.jsonl` for RouteTrail.ts.
 */

import { existsSync, readdirSync, readFileSync, openSync, readSync, closeSync, statSync, appendFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

const ROLLOUT_HEAD_BYTES = 256 * 1024;

export interface CodexRun {
  ts: string;
  agent: string;
  slug: string;
  thread_id: string | null;
  requested: string;
  observed: string | null;
  verdict: string;
  duration_ms: number;
  /** Router R67: the `model_reasoning_effort` the child was started with. Absent on records written before 2026-10-04. */
  effort?: string;
  /** ISC-58: `LIFEOS_DISPATCH_ID` from the environment the wrapper ran the helper in (`<session>::<description>`); absent on runs outside a dispatch. */
  dispatch_id?: string;
  /** The first substantive line of the child's final message (≤160 chars): what this model said, for the 🔀 ROUTED block and the statusline detail rows. Absent when the child wrote nothing. */
  summary?: string;
}

/**
 * One line that says what a codex child concluded (LifeOS Advisor ISA ISC-7). A report's
 * BOTTOM LINE / RECOMMENDATION / SUMMARY line wins when present (the agent contracts put the
 * verdict there); otherwise the first line that is not a heading, a rule, a fence, or a
 * label-only header. Never longer than `max`.
 */
export function summarize(finalMessage: string, max = 160): string | undefined {
  const lines = finalMessage.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return undefined;
  const clean = (s: string) => s.replace(/^[#>*_\-\s]+/, "").replace(/\*\*/g, "").trim();
  const clipTo = (s: string) => (s.length <= max ? s : s.slice(0, max - 1).trimEnd() + "…");
  for (const key of [/BOTTOM LINE:\s*(.+)/i, /RECOMMENDATION:\s*(.+)/i, /\bSUMMARY:\s*(.+)/i]) {
    for (const l of lines) { const m = l.match(key); if (m && m[1].trim()) return clipTo(clean(m[1])); }
  }
  for (const l of lines) {
    if (/^(#|```|[━─═]|-{3,}|\*{3,})/.test(l)) continue;
    if (/REPORT\s*$/i.test(l)) continue;
    const c = clean(l);
    if (c) return clipTo(c);
  }
  return undefined;
}

/**
 * The thread id from the LAST `thread.started` row of a run's events file (null when absent).
 * Last, not first: a slug is reused across an ISA's open and close consults, so the file holds
 * every run's stream appended, and the newest row is the run that just finished. The helper
 * passes its own run's id when it saw the event live; this is the fallback.
 */
export function threadIdFromEvents(eventsFile: string): string | null {
  if (!existsSync(eventsFile)) return null;
  let last: string | null = null;
  for (const line of readFileSync(eventsFile, "utf8").split("\n")) {
    if (!line.includes("thread.started")) continue;
    try {
      const r = JSON.parse(line) as Record<string, unknown>;
      if (r.type === "thread.started" && typeof r.thread_id === "string" && r.thread_id.length > 0) last = r.thread_id;
    } catch { /* stdout noise is persisted too */ }
  }
  return last;
}

/** The rollout file for a thread under a codex home's `sessions/` tree, or null. */
export function findRollout(codexHome: string, threadId: string): string | null {
  const root = join(codexHome, "sessions");
  if (!existsSync(root)) return null;
  const suffix = `-${threadId}.jsonl`;
  const walk = (dir: string, depth: number): string | null => {
    let names: string[];
    try { names = readdirSync(dir); } catch { return null; }
    for (const name of names) {
      const p = join(dir, name);
      if (name.startsWith("rollout-") && name.endsWith(suffix)) return p;
      if (depth < 3) { try { if (statSync(p).isDirectory()) { const hit = walk(p, depth + 1); if (hit) return hit; } } catch { /* skip */ } }
    }
    return null;
  };
  return walk(root, 0);
}

/**
 * The model the rollout's `turn_context` row names; falls back to the first `"model"` value
 * in the head of the file. Reads the head only: rollouts reach MB and the row sits near the top.
 */
export function observedModelOf(rolloutPath: string): string | null {
  let text: string;
  try {
    const size = statSync(rolloutPath).size;
    const fd = openSync(rolloutPath, "r");
    try {
      const buf = Buffer.alloc(Math.min(ROLLOUT_HEAD_BYTES, size));
      const n = readSync(fd, buf, 0, buf.length, 0);
      text = buf.subarray(0, n).toString("utf8");
    } finally { closeSync(fd); }
  } catch { return null; }
  for (const line of text.split("\n")) {
    if (!line.includes("turn_context")) continue;
    try {
      const r = JSON.parse(line) as { type?: string; payload?: { model?: string } };
      if (r.type === "turn_context" && typeof r.payload?.model === "string") return r.payload.model;
    } catch { /* a cut last line */ }
  }
  const m = text.match(/"model":"([^"]+)"/);
  return m ? m[1] : null;
}

/** Observe one run: thread id from its events, rollout in its home, model from the rollout. */
export function observeRun(eventsFile: string, codexHome: string | null): { threadId: string | null; observed: string | null; rollout: string | null } {
  const threadId = threadIdFromEvents(eventsFile);
  if (!threadId || !codexHome) return { threadId, observed: null, rollout: null };
  const rollout = findRollout(codexHome, threadId);
  return { threadId, observed: rollout ? observedModelOf(rollout) : null, rollout };
}

export function appendRun(file: string, run: CodexRun): void {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(run)}\n`);
}

/** Tail-read the run records (newest last). */
export function readRuns(file: string, maxBytes = 512 * 1024): CodexRun[] {
  if (!existsSync(file)) return [];
  const size = statSync(file).size;
  const offset = Math.max(0, size - maxBytes);
  const fd = openSync(file, "r");
  let text: string;
  try {
    const buf = Buffer.alloc(size - offset);
    const n = readSync(fd, buf, 0, buf.length, offset);
    text = buf.subarray(0, n).toString("utf8");
  } finally { closeSync(fd); }
  if (offset > 0) text = text.slice(text.indexOf("\n") + 1);
  const out: CodexRun[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line) as CodexRun); } catch { /* partial line */ }
  }
  return out;
}
