#!/usr/bin/env bun
// Normalize env path vars Claude Code may inject unexpanded — literal $HOME/${HOME}
// in LIFEOS_DIR/LIFEOS_CONFIG_DIR/PROJECTS_DIR resolves to a shadow dir.
for (const __k of ["LIFEOS_DIR", "LIFEOS_CONFIG_DIR", "PROJECTS_DIR"]) {
  const __v = process.env[__k];
  if (__v && /^\$\{?HOME\}?(\/|$)/.test(__v)) process.env[__k] = __v.replace(/^\$\{?HOME\}?/, process.env.HOME ?? "~");
}

/**
 * @version 1.0.1
 * TurnOutcome.hook.ts — appends the turn's K1 record and resolves the previous turn's outcome.
 *
 * TRIGGER: Stop, last in the chain so a gate-held turn is recorded as it finally ended.
 * NEEDS TRANSCRIPT: only the bytes appended since the previous record's transcript_bytes.
 * Fail-soft by contract: it can never block or fail a turn.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { getSettingsPath, lifeosPath } from "../LIFEOS/TOOLS/Paths.ts";
import { appendTurn, classifyOutcome, deriveWorkKind, lastUnresolved, nextTurnIndex, resolveOutcome, tailLines, toolsSince, correctionSignal, sweepAbandoned, modelFromTranscript } from "../LIFEOS/TOOLS/TurnOutcomes.ts";
import { readHookInput } from './lib/hook-io';

function transcriptBytes(path: string): number { try { return path ? Bun.file(path).size : 0; } catch { return 0; } }

function lastForSession(path: string, session: string): Record<string, unknown> | null {
  const lines = tailLines(path, 5000);
  // The streams disagree on the field name: prompt-processing and depth-fidelity write `session_id`,
  // router-decisions writes `session`. Matching only the first left `route` null on every record.
  for (let i = lines.length - 1; i >= 0; i--) try { const row = JSON.parse(lines[i]); if (row.session_id === session || row.session === session) return row; } catch {}
  return null;
}
function text(path: string): string | null { try { return readFileSync(path, "utf8").trim() || null; } catch { return null; } }
function era(transcriptPath: string) {
  let carrier: string | null = null, system_prompt: string | null = null, router: string | null = null;
  try { const model = JSON.parse(readFileSync(getSettingsPath(), "utf8")).model; carrier = typeof model === "string" ? model : null; } catch {}
  // No pinned model in settings is the normal case, so read what the session actually ran on.
  if (!carrier) carrier = modelFromTranscript(transcriptPath);
  try { system_prompt = readFileSync(lifeosPath("LIFEOS_SYSTEM_PROMPT.md"), "utf8").match(/^version:\s*["']?([^\n"']+)/m)?.[1]?.trim() ?? null; } catch {}
  try { router = readFileSync(lifeosPath("ROUTER", "FrontDoor.ts"), "utf8").match(/@version\s+([^\s*]+)/)?.[1] ?? null; } catch {}
  return { carrier, system_prompt, algorithm: text(lifeosPath("ALGORITHM", "LATEST")), router };
}
async function main() {
  try {
    const input = await readHookInput(); const session = String(input?.session_id ?? ""); if (!session) return;
    const promptRow = lastForSession(lifeosPath("MEMORY", "OBSERVABILITY", "prompt-processing.jsonl"), session);
    const prompt = typeof promptRow?.prompt_excerpt === "string" ? promptRow.prompt_excerpt : null; if (!prompt) return;
    // Abandoned turns are swept from here rather than a launchd job: this hook already fires on
    // every turn, so a once-an-hour guard costs nothing and adds no new infrastructure to keep alive.
    try {
      const stamp = lifeosPath("MEMORY", "STATE", "turn-outcome-sweep");
      const last = existsSync(stamp) ? Number(readFileSync(stamp, "utf8")) : 0;
      if (Date.now() - last > 3600_000) { sweepAbandoned(); mkdirSync(dirname(stamp), { recursive: true }); writeFileSync(stamp, String(Date.now())); }
    } catch {}
    const previous = lastUnresolved(session);
    // Stop can fire more than once for one turn (a gate holds, the turn resumes, Stop fires again).
    // The prompt that started the turn is the same both times, so that is the dedup key: without it
    // every held turn would append a second record and inflate the denominator.
    if (previous && previous.prompt_excerpt === prompt.slice(0, 200)) return;
    if (previous) resolveOutcome(previous.turn, classifyOutcome(prompt, previous.prompt_excerpt), undefined, correctionSignal(prompt));
    const routeRow = lastForSession(lifeosPath("MEMORY", "OBSERVABILITY", "router-decisions.jsonl"), session);
    const fidelityRow = lastForSession(lifeosPath("MEMORY", "OBSERVABILITY", "depth-fidelity.jsonl"), session);
    // The turn's own boundary: the previous record stored the transcript size at its end, so only
    // the bytes appended since belong to this turn. No previous record means read nothing and
    // record zero rather than attribute another turn's tools to this one.
    const transcriptPath = typeof input?.transcript_path === "string" ? input.transcript_path : "";
    const scan = previous?.transcript_bytes != null ? toolsSince(transcriptPath, previous.transcript_bytes) : { tools: [] as string[], calls: 0, delegated: false, bytes: transcriptBytes(transcriptPath) };
    const tools = scan.tools;
    appendTurn({ schema: 1, turn: `${session}:${nextTurnIndex(session)}`, session, ts: new Date().toISOString(), prompt_excerpt: prompt.slice(0, 200), work_kind: deriveWorkKind(prompt, tools), work_kind_source: "derived", transcript_bytes: scan.bytes, route: routeRow ? { lane: typeof routeRow.lane === "string" ? routeRow.lane : null, level: typeof routeRow.level === "string" ? routeRow.level : null, binding: routeRow.binding === true, source: typeof routeRow.source === "string" ? routeRow.source : null } : null, fidelity: ["pass", "inline", "hold", "unresolved"].includes(String(fidelityRow?.outcome)) ? fidelityRow?.outcome as "pass" | "inline" | "hold" | "unresolved" : null, tool_calls: scan.calls, delegated: scan.delegated, outcome: null, outcome_resolved_ts: null, era: era(transcriptPath) });
  } catch {}
}
main().then(() => process.exit(0)).catch(() => process.exit(0));
