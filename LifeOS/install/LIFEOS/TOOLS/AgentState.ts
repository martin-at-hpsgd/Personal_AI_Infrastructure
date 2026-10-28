#!/usr/bin/env bun
/**
 * AgentState.ts — the ONE resolver for the statusline's agent-row and OpenAI-lane used-states.
 *
 * Before this tool the statusline reconciled three logs by hand for those rows: agent-starts.json
 * (the command hook), this session's subagents/*.meta.json, and inline jq over subagent-events.jsonl.
 * That divergence is what let an Astra (then Max) dispatch light the 🔀 route trail but not the agent row
 * (2026-09-10). This reads the SAME rich, canonical log the route trail reads
 * (subagent-events.jsonl, via RouteTrail.readDispatches) and emits shell-evalable state.
 *
 * agent-starts.json is deliberately untouched — AgentWatchdog.ts and CarrierProbe.ts still consume it.
 *
 * State per agent: 2 = live (a start with no matching stop, within the window), 1 = used earlier
 * this session, 0 = idle. The window matches the statusline's ▸ LIVE cutoff so a killed agent's
 * orphaned start row (no stop) ages out of "live" into "used" rather than lying live forever.
 *
 * Usage: bun LIFEOS/TOOLS/AgentState.ts --session <id> [--now <ms>] [--window <s>] [--json]
 *   Default: KV lines for `eval` in the statusline. --json: the full object for tests/other readers.
 * Env (tests): AGENT_STATE_EVENTS overrides the events file (passed through to readDispatches).
 */

import { readDispatches, type Dispatch } from './RouteTrail.ts';
import { lifeosPath } from './Paths';

/** Named agents that get their own token on the agent row. subagent_type (any case) → key. */
const AGENT_KEYS = ['astra', 'fable', 'opus', 'sonnet', 'haiku', 'sol'] as const;
export type AgentKey = (typeof AGENT_KEYS)[number];

/** Map a dispatch's subagent_type to an agent-row key, or null if it isn't one of ours.
 *  The generated effort variants (SonnetMedium, HaikuMedium, OpusXHigh …) light their base agent's key.
 *  Luna and Terra (retired 2026-10-07) are nobody; the Haiku agents took their rungs. */
export function agentKeyOf(type: string): AgentKey | null {
  const t = type.toLowerCase().replace(/(?:xhigh|medium|high)$/, '');
  return (AGENT_KEYS as readonly string[]).includes(t) ? (t as AgentKey) : null;
}

/** The OpenAI lane a dispatch's model id belongs to, for the ladder's used-flags (astra = the flagship rung). */
export function laneOf(model: string): 'sol' | 'astra' | null {
  const m = model.toLowerCase();
  // Retired lanes: an old gpt-*-luna / gpt-*-terra dispatch in history lights nothing (it is not the flagship rung either).
  if (m.endsWith('-luna') || m.endsWith('-terra')) return null;
  if (m.endsWith('-sol')) return 'sol';
  if (m.startsWith('gpt-')) return 'astra';
  return null;
}

export interface AgentStates {
  agents: Record<AgentKey, 0 | 1 | 2>;
  laneUsed: Record<'sol' | 'astra', 0 | 1>;
  /** subagent_type strings seen this session — live set and full (used) set — for the shell's private cyber match. */
  liveTypes: string[];
  usedTypes: string[];
}

const DEFAULT_WINDOW_S = 300;

export function computeStates(dispatches: Dispatch[], nowMs: number, windowS = DEFAULT_WINDOW_S): AgentStates {
  const windowMs = windowS * 1000;
  const isLive = (d: Dispatch) => d.stoppedMs === null && nowMs - d.startedMs <= windowMs;

  const agents = Object.fromEntries(AGENT_KEYS.map((k) => [k, 0])) as Record<AgentKey, 0 | 1 | 2>;
  const laneUsed = { sol: 0, astra: 0 } as Record<'sol' | 'astra', 0 | 1>;
  const liveTypes = new Set<string>();
  const usedTypes = new Set<string>();

  for (const d of dispatches) {
    usedTypes.add(d.type);
    const live = isLive(d);
    if (live) liveTypes.add(d.type);

    const key = agentKeyOf(d.type);
    if (key) agents[key] = Math.max(agents[key], live ? 2 : 1) as 0 | 1 | 2;

    const lane = laneOf(d.model);
    if (lane) laneUsed[lane] = 1;
  }

  return { agents, laneUsed, liveTypes: [...liveTypes], usedTypes: [...usedTypes] };
}

/** The charset a subagent_type may use to reach the statusline's `eval`; anything else is dropped. */
const SAFE_TYPE_RE = /^[A-Za-z0-9:_.-]+$/;

/**
 * A type list as ONE single-quoted shell word for the statusline's `eval`. subagent_type is
 * caller-supplied text, so an unfiltered `$(…)` in it ran as shell (GHSA-r4v7-4f75-h7ch class
 * follow-up, @krish-221). Only safe-charset tokens survive; the quote escaping keeps the word closed even so.
 */
export function shShellList(items: string[]): string {
  const joined = items.filter((t) => SAFE_TYPE_RE.test(t)).join(' ');
  return `'${joined.replaceAll("'", "'\\''")}'`;
}

/** The KV lines the CLI prints for the statusline's `eval` (no trailing newline). */
export function agentStateText(states: AgentStates): string {
  const out: string[] = [];
  for (const k of AGENT_KEYS) out.push(`st_${k}=${states.agents[k]}`);
  for (const l of ['sol', 'astra'] as const) out.push(`lane_used_${l}=${states.laneUsed[l]}`);
  out.push(`sess_live_types=${shShellList(states.liveTypes)}`);
  out.push(`sess_used_types=${shShellList(states.usedTypes)}`);
  return out.join('\n');
}

/** What `AgentState.ts --session <id> --now <ms>` prints, for in-process callers. */
export function agentStateFor(session: string, nowMs: number, windowS = DEFAULT_WINDOW_S, eventsFile = process.env.AGENT_STATE_EVENTS ?? lifeosPath('MEMORY', 'OBSERVABILITY', 'subagent-events.jsonl')): string {
  return agentStateText(computeStates(readDispatches(eventsFile, session), nowMs, windowS));
}

function main() {
  const args = process.argv.slice(2);
  const get = (flag: string) => {
    const i = args.indexOf(flag);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
  };
  const session = get('--session');
  if (!session) {
    console.error('AgentState.ts: --session <id> required');
    process.exit(2);
  }
  const nowMs = Number(get('--now') ?? Date.now());
  const windowS = Number(get('--window') ?? DEFAULT_WINDOW_S);
  const eventsFile = process.env.AGENT_STATE_EVENTS ?? lifeosPath('MEMORY', 'OBSERVABILITY', 'subagent-events.jsonl');

  const states = computeStates(readDispatches(eventsFile, session), nowMs, windowS);

  if (args.includes('--json')) {
    console.log(JSON.stringify(states));
    return;
  }
  // KV lines for `eval` in the statusline. st_* = agent-row state; lane_used_* = ladder used-flag.
  console.log(agentStateText(states));
}

if (import.meta.main) main();
