/**
 * delegation.ts — has this session done its own bulk work instead of routing it?
 *
 * WHY (2026-09-15, the principal): ten sessions in one day ran 100% on the session
 * carrier with zero dispatches. OPERATIONAL_PREFERENCES § Model selection says the
 * mechanical legs go down to the codex workers by default, but nothing
 * measured it, so the rule never fired. This is the measurement; DriftReminder
 * puts it in the per-turn contract, the one place that runs pre-generation.
 *
 * Deterministic: counts tool_use blocks in the session transcript. A session
 * past the tool-call threshold with zero dispatches to a delegate lane gets a
 * one-line DELEGATION line; otherwise nothing.
 *
 * R41 (2026-09-24): per-session state is a meter only. The block and override
 * are retired because with Opus as the carrier the cheapest unlock was handing
 * a half-built job to a fresh Opus with none of the context.
 */

import { readFileSync, statSync, writeFileSync, mkdirSync, existsSync, openSync, readSync, closeSync } from "node:fs";
import { join, dirname } from "node:path";
import { lifeosPath } from "./paths";
import { invariant } from "../../LIFEOS/TOOLS/Invariant";
import { CURRENT, LEGACY_AGENT_VARIANTS, baseAgentOf } from "../../LIFEOS/TOOLS/models";

/** Install-local delegate agents: LIFEOS/USER/CUSTOMIZATIONS/ROUTER/delegate-agents.json. */
export const EXTRA_AGENTS_CONFIG_REL = ["USER", "CUSTOMIZATIONS", "ROUTER", "delegate-agents.json"] as const;
const AGENT_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

/**
 * Agent types this install adds to the shipped lanes (LOSIntegrity public-clean hooks#1, 2026-10-14): an
 * agent a public install does not have stays out of shipped code and is named in the USER zone instead.
 * Shape: `{ "delegate": ["Name"], "reset": ["Name"] }`; a `reset` name is a delegate too. A missing file
 * adds nothing. A file that is unreadable, not JSON, or carries a non-string or malformed name adds
 * nothing from that list: this is a meter, so a bad config costs measurement, never a block.
 */
export function loadExtraDelegateAgents(path: string = lifeosPath(...EXTRA_AGENTS_CONFIG_REL)): { delegate: string[]; reset: string[] } {
  const none = { delegate: [], reset: [] };
  let raw: unknown;
  try {
    if (!existsSync(path)) return none;
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch { return none; }
  const names = (v: unknown): string[] =>
    Array.isArray(v) && v.every(n => typeof n === "string" && AGENT_NAME.test(n)) ? (v as string[]) : [];
  const cfg = (raw ?? {}) as { delegate?: unknown; reset?: unknown };
  const reset = names(cfg.reset);
  return { delegate: [...new Set([...names(cfg.delegate), ...reset])], reset };
}

const EXTRA_AGENTS = loadExtraDelegateAgents();

/**
 * Agent types that count as routed work (codex lanes + Anthropic build/audit seats), plus the install's own.
 * The retired effort-variant names (OpusXHigh …) stay recognised so an old transcript still counts as routed work
 * and reads as its base agent; a new dispatch is the base agent with an `effort` parameter.
 */
export const DELEGATE_TYPES = new Set(["Astra", "Sol", "Opus", "Sonnet", "Haiku", "Fable", ...Object.keys(LEGACY_AGENT_VARIANTS), ...EXTRA_AGENTS.delegate]);

/**
 * Agent types whose dispatch RESETS the mechanical counter (R10): the execution lanes. Fable is
 * the read-only in-family audit seat — a Fable dispatch is routed work for the audit measure but
 * moves no mechanical leg off the carrier, so it does not reset the meter.
 */
export const RESET_TYPES = new Set(["Sol", "Astra", "Opus", "Sonnet", "Haiku", ...Object.keys(LEGACY_AGENT_VARIANTS).filter(n => baseAgentOf(n) !== "Fable"), ...EXTRA_AGENTS.reset]);

/**
 * A Bash call that hands a task straight to a codex worker (R31, 2026-09-19): `Worker.ts <lane>`,
 * or the helper itself with a resetting `--agent`. It is a dispatch, the same as an Agent call to
 * that worker, minus the Claude wrapper that used to burn its 20 turns before handing back.
 */
export function isDirectDispatch(command: string): boolean {
  if (/\bWorker\.ts\s+(sol|astra)\b/i.test(command)) return true;
  const m = command.match(/\bCodexProgress\.ts\b[^\n]*--agent\s+["']?([A-Za-z]+)/);
  return !!m && RESET_TYPES.has(m[1]);
}

/** Tool calls a session may make before an undelegated session is flagged. */
export const TOOL_CALL_THRESHOLD = 40;

const TAIL_BYTES = 8 * 1024 * 1024;
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export interface DelegationMeasure {
  toolCalls: number;
  dispatches: number;
  delegates: string[];
}

export interface DelegationState {
  sinceDispatch: number;
  total: number;
  dispatches: number;
}

/** Tools that count as mechanical work (must be edited if new tools are added). */
export const MECHANICAL_TOOLS = new Set(["Bash", "Edit", "Write", "MultiEdit", "NotebookEdit"]);

/**
 * Get the path to the delegation state file for a session.
 * Session IDs must match /^[A-Za-z0-9_-]{1,128}$/; invalid IDs return null.
 */
export function delegationStatePath(sessionId: string): string | null {
  if (!SESSION_ID_RE.test(sessionId)) return null;
  const dir = process.env.DELEGATION_STATE_DIR ?? lifeosPath("MEMORY", "STATE", "delegation");
  return join(dir, `${sessionId}.json`);
}

/**
 * Read the delegation state for a session. Returns empty state if not found.
 */
export function readDelegationState(sessionId: string): DelegationState {
  const path = delegationStatePath(sessionId);
  if (!path) return { sinceDispatch: 0, total: 0, dispatches: 0 };
  try {
    if (!existsSync(path)) return { sinceDispatch: 0, total: 0, dispatches: 0 };
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<DelegationState>;
    return {
      sinceDispatch: typeof raw.sinceDispatch === "number" ? raw.sinceDispatch : 0,
      total: typeof raw.total === "number" ? raw.total : 0,
      dispatches: typeof raw.dispatches === "number" ? raw.dispatches : 0,
    };
  } catch {
    return { sinceDispatch: 0, total: 0, dispatches: 0 };
  }
}

/**
 * Write the delegation state for a session. Asserts invariants before writing.
 */
function writeDelegationState(sessionId: string, state: DelegationState): void {
  const path = delegationStatePath(sessionId);
  if (!path) return;
  invariant(typeof state.sinceDispatch === "number" && state.sinceDispatch >= 0, "sinceDispatch must be non-negative");
  invariant(typeof state.total === "number" && state.total >= 0, "total must be non-negative");
  invariant(typeof state.dispatches === "number" && state.dispatches >= 0, "dispatches must be non-negative");
  invariant(state.sinceDispatch <= state.total, "sinceDispatch cannot exceed total");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2) + "\n");
}

/**
 * Observe a tool call and update delegation state. Returns the updated state.
 * - Mechanical tools (Bash, Edit, Write, MultiEdit, NotebookEdit) increment sinceDispatch and total.
 * - Agent/Task calls to delegate types, or spawn_agent calls, reset sinceDispatch to 0 and increment dispatches.
 * - Everything else changes nothing.
 * - Claude subagents (input carries agent_id or agent_type) are exempt from metering.
 */
export function observeToolCall(
  sessionId: string,
  toolName: string,
  toolInput: Record<string, unknown> | undefined
): DelegationState {
  const state = readDelegationState(sessionId);

  // Check if it's a delegate dispatch (reset sinceDispatch)
  if (toolName === "Agent" || toolName.endsWith("spawn_agent")) {
    if (toolName === "Agent") {
      const subagentType = String(toolInput?.subagent_type ?? "");
      if (RESET_TYPES.has(subagentType)) {
        state.sinceDispatch = 0;
        state.dispatches += 1;
      }
    } else if (toolName.endsWith("spawn_agent")) {
      // Codex spawn_agent resets
      state.sinceDispatch = 0;
      state.dispatches += 1;
    }
  }
  // A direct worker hand-off through Bash is a dispatch, never a mechanical call (R31)
  else if (toolName === "Bash" && isDirectDispatch(String(toolInput?.command ?? ""))) {
    state.sinceDispatch = 0;
    state.dispatches += 1;
  }
  // Check if it's a mechanical tool (increment counters)
  else if (MECHANICAL_TOOLS.has(toolName)) {
    state.sinceDispatch += 1;
    state.total += 1;
  }

  writeDelegationState(sessionId, state);
  return state;
}

/** Meter one PreToolUse event. The caller isolates any filesystem failure. */
export function observeHookInput(input: any): void {
  if (input?.agent_id || input?.agent_type) return;
  const sessionId = input?.session_id;
  if (typeof sessionId !== "string" || !delegationStatePath(sessionId)) return;
  observeToolCall(sessionId, String(input?.tool_name ?? ""), input?.tool_input as Record<string, unknown> | undefined);
}

/** Tier of the last assistant entry in the transcript tail. */
export function carrierTier(transcriptPath: string): "opus" | "fable" | null {
  try {
    const size = statSync(transcriptPath).size;
    const tailBytes = 512 * 1024;
    const fd = openSync(transcriptPath, "r");
    let raw: string;
    try {
      const count = Math.min(size, tailBytes);
      const buffer = Buffer.alloc(count);
      const read = readSync(fd, buffer, 0, count, size - count);
      raw = buffer.subarray(0, read).toString("utf8");
    } finally { closeSync(fd); }
    const lines = raw.split("\n");
    if (size > tailBytes) lines.shift();
    for (let i = lines.length - 1; i >= 0; i--) {
      let entry: any;
      try { entry = JSON.parse(lines[i]); } catch { continue; }
      if (entry?.type !== "assistant" && entry?.message?.role !== "assistant") continue;
      const model = entry?.message?.model;
      // Harness-written entries (API errors, interrupts) carry "<synthetic>"; they say nothing about the carrier.
      if (typeof model !== "string" || !model.startsWith("claude-")) continue;
      return model === CURRENT.opus ? "opus" : model === CURRENT.fable ? "fable" : null;
    }
  } catch { return null; }
  return null;
}

export function measureDelegation(transcriptPath: string): DelegationMeasure {
  const empty: DelegationMeasure = { toolCalls: 0, dispatches: 0, delegates: [] };
  let raw: string;
  try {
    const size = statSync(transcriptPath).size;
    raw = readFileSync(transcriptPath, "utf8");
    if (size > TAIL_BYTES) raw = raw.slice(-TAIL_BYTES);
  } catch { return empty; }

  const m = { ...empty, delegates: [] as string[] };
  for (const line of raw.split("\n")) {
    if (!line.includes('"tool_use"')) continue;
    let entry: any;
    try { entry = JSON.parse(line); } catch { continue; }
    const content = entry?.message?.content ?? entry?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (b?.type !== "tool_use") continue;
      m.toolCalls += 1;
      if (b.name === "Agent") {
        const t = String(b.input?.subagent_type ?? "");
        if (DELEGATE_TYPES.has(t)) { m.dispatches += 1; m.delegates.push(baseAgentOf(t)); }
      }
    }
  }
  return m;
}

