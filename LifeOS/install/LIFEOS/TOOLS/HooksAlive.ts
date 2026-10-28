/**
 * HooksAlive — is the always-on layer actually firing in main sessions?
 *
 * Every hook fails open, so a bug that silences the per-prompt hooks looks
 * like nothing at all: no error, no missing line anyone notices, just a
 * system running without its memory, retrieval, and ISA sync. That is how
 * the fork-subagent misclassification (public issue #1911) stayed invisible
 * for three days privately and twenty on the public build — every main
 * session was treated as a subagent and nine hooks early-exited.
 *
 * The check is deterministic and needs no hook to cooperate: MemoryTurnStart
 * writes `MEMORY/STATE/memory-inject/<session>.json` on every prompt it
 * handles in a main session. So over a recent window, main-session transcripts
 * (`projects/<dir>/<session>.jsonl`) should have injection state. Headless
 * sessions (the texting bridge, scheduled jobs, `claude -p` inference calls)
 * exit before writing state and produce transcripts too, so partial coverage
 * is normal. The failure mode is all-or-nothing: sessions exist and NONE were
 * injected. That, and only that, blocks.
 *
 * Consumed by IntegrityCheck (`/ic`) as the `hooks-alive` check.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface HooksAliveInput {
  projectsDir: string;
  injectDir: string;
  windowHours?: number;
  /** minimum recent main sessions before a zero-injection window counts as evidence */
  minSessions?: number;
  now?: number;
}

export interface HooksAliveResult {
  mainSessions: number;
  injected: number;
  windowHours: number;
  /** stamps that exist for a recent session but are empty, corrupt or unreadable */
  unreadable: number;
  /** stamps that parse but were last written before the window opened */
  stale: number;
  verdict: "alive" | "dead" | "no-evidence" | "indeterminate";
  detail: string;
}

/** Main-session transcript ids modified inside the window. Subagent transcripts live in per-session subdirectories and are not counted. */
function recentMainSessions(projectsDir: string, cutoffMs: number): string[] {
  const ids: string[] = [];
  if (!existsSync(projectsDir)) return ids;
  for (const d of readdirSync(projectsDir)) {
    const pd = join(projectsDir, d);
    let entries: string[];
    try { if (!statSync(pd).isDirectory()) continue; entries = readdirSync(pd); } catch { continue; }
    for (const f of entries) {
      if (!f.endsWith(".jsonl")) continue;
      try { if (statSync(join(pd, f)).mtimeMs >= cutoffMs) ids.push(f.slice(0, -".jsonl".length)); } catch { /* raced */ }
    }
  }
  return ids;
}

type StampState = "valid" | "stale" | "unreadable" | "absent";

/**
 * What one session's injection stamp proves. Existence alone proves nothing: a
 * stamp left from an old session, an empty file, or a corrupt write would read as
 * alive. A stamp counts only when it parses to a non-empty JSON object and was
 * written inside the window.
 */
function stampState(path: string, cutoffMs: number): StampState {
  let st;
  try { st = statSync(path); } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unreadable";
  }
  if (!st.isFile()) return "unreadable";
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, "utf8")); } catch { return "unreadable"; }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed) || Object.keys(parsed).length === 0) return "unreadable";
  return st.mtimeMs >= cutoffMs ? "valid" : "stale";
}

export function assessHooksAlive(i: HooksAliveInput): HooksAliveResult {
  const windowHours = i.windowHours ?? 24;
  const minSessions = i.minSessions ?? 3;
  const now = i.now ?? Date.now();
  const cutoff = now - windowHours * 3600_000;
  const sessions = recentMainSessions(i.projectsDir, cutoff);
  const states = sessions.map((id) => stampState(join(i.injectDir, `${id.replace(/[^A-Za-z0-9._-]/g, "_")}.json`), cutoff));
  const injected = states.filter((x) => x === "valid").length;
  const unreadable = states.filter((x) => x === "unreadable").length;
  const stale = states.filter((x) => x === "stale").length;
  const base = { mainSessions: sessions.length, injected, unreadable, stale, windowHours };
  if (sessions.length < minSessions) {
    return { ...base, verdict: "no-evidence", detail: `${sessions.length} main session(s) in the last ${windowHours}h (need ${minSessions}) — nothing to judge yet` };
  }
  if (injected === 0 && unreadable > 0) {
    return { ...base, verdict: "indeterminate", detail: `${sessions.length} main sessions in the last ${windowHours}h, none with a valid recent memory-injection stamp, and ${unreadable} stamp(s) empty, corrupt or unreadable — liveness cannot be established` };
  }
  if (injected === 0) {
    return { ...base, verdict: "dead", detail: `${sessions.length} main sessions in the last ${windowHours}h and NONE received a memory injection — the always-on layer is silently off (the #1911 class: every hook fails open, so nothing else will tell you)` };
  }
  return { ...base, verdict: "alive", detail: `${injected}/${sessions.length} recent main sessions received a memory injection (headless sessions never do; partial is normal)` };
}
