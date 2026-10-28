#!/usr/bin/env bun
/**
 * @version 1.8.1
 * AgentInvocation.hook.ts — Agent (Task) subagent lifecycle tracker.
 *
 * v1.6.0 (2026-08-11, /algo pass #2 NP7): an omitted `model` used to log the
 * literal string "inherited", which made the dispatch tier mix uncomputable —
 * 21 of the ~180 dispatches since 08-01 were black holes. Now an inherited
 * dispatch resolves to the session's live carrier via ModelDriftGuard's
 * liveModel() (transcript tail, sidechain rows skipped) and logs it with
 * level "session-inherited". When the transcript can't answer (first turn,
 * nested agent-in-agent spawns whose rows are all sidechain), the record
 * honestly keeps "inherited" — never a guess. Observation only, unchanged.
 *
 * v1.5.3 (2026-07-24): MODEL-CHECK ADVISORY REMOVED. v1.5.0 emitted a
 * PreToolUse advisory whenever a dispatch carried no model, citing the rule
 * "every Agent dispatch sets model explicitly." That rule is RETIRED
 * (OPERATIONAL_PREFERENCES § Model selection, 2026-07-11, restated 2026-07-24): the
 * saved /model value is the single dial, an omitted `model` INHERITS it, and
 * that inheritance IS the intended carrier — naming a model is what rots. The
 * same rule scopes this hook to observe-and-log with no injection, and stdout
 * from a PreToolUse hook is injection, so the advisory violated both halves.
 * This hook now emits nothing on stdout. Nothing injects a model at dispatch.
 *
 * v1.4.0 (2026-07-13): background/mailbox spawns detected at PostToolUse. The
 * harness's async Agent spawns return "Spawned successfully" immediately, so
 * PostToolUse fires at spawn time — the old code logged subagent_stop with
 * duration 0 and deleted the start record, making background agents invisible
 * to the statusline ACTIVE ladder (the principal caught this live: an Opus dispatch
 * showed nothing). Now: a spawn-ack response logs subagent_spawned_async and
 * removes the start record; liveness for background agents comes from the
 * harness's own subagents/agent-*.jsonl transcript mtime (statusline reads it
 * directly — no hook bookkeeping can go stale).
 *
 * Claude Code's built-in SubagentStart/SubagentStop payloads do NOT include
 * subagent_type / description / prompt reliably — the prior tracker wrote
 * "unknown" for 5844 of 5846 historical events. This hook captures the data
 * at PreToolUse:Agent / PostToolUse:Agent where tool_input and tool_response
 * are present, and writes proper events to subagent-events.jsonl.
 *
 * THIS HOOK OBSERVES ONLY — it resolves and logs which model a dispatch carries
 * (cross-vendor > explicit param > frontmatter pin > inherited) and never mutates tool
 * input. Do not reintroduce model injection here. An injector that rewrites a no-model
 * dispatch to a rung depends on a tier signal, and when that signal goes away the injector
 * does not fail loudly — it silently flattens every dispatch to one rung, which is exactly
 * what happened before this hook was reduced to observation. Model selection is a
 * per-dispatch judgment; an unspecified model inherits the session model.
 * Earlier injection records remain in MEMORY/OBSERVABILITY/model-injections.jsonl.
 *
 * Wired in settings.json under:
 *   PreToolUse  matcher=Agent → subagent_start  (with real subagent_type)
 *   PostToolUse matcher=Agent → subagent_stop   (with duration)
 *
 * Correlation key: session_id + description (description is required by the
 * Agent tool). On PreToolUse we stash the start timestamp keyed by
 * session_id|description in subagent-starts.json; PostToolUse matches it back.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, chmodSync, statSync } from 'fs';
import { createHash } from 'crypto';
import { join } from 'path';
import { lifeosPath, getClaudeDir } from './lib/paths'; // public issue #1974 @sabo961, PR #1918 @PigLardLord
import { getISOTimestamp } from './lib/time';
import { EFFORT_MODEL, CROSS_VENDOR } from '../LIFEOS/TOOLS/models';
import { liveModel } from './ModelDriftGuard.hook';
import { hookDrawn } from './lib/function-hooks';
import { appendPrivateLine } from './lib/event-capture';
import { invariant } from '../LIFEOS/TOOLS/Invariant';

interface AgentToolInput {
  subagent_type?: string;
  description?: string;
  prompt?: string;
  model?: string;
}

/** Reverse-map a model alias/tier to its effort level via EFFORT_MODEL. */
function levelForModel(model: string): string {
  for (const [level, tier] of Object.entries(EFFORT_MODEL)) {
    if (tier === model) return level;
  }
  return 'custom';
}

/**
 * Resolve the dispatch's display level + model, mirroring the Agent tool's
 * precedence: cross-vendor engine > dispatch-time model param > agent
 * frontmatter pin > inherited from session.
 */
export function resolveDispatch(subagentType: string, inputModel?: string, agentsDir = join(getClaudeDir(), 'agents')): { model: string; level: string } {
  let fm = '';
  // P2 #19: a type is a bare name, never a path. Anything else reads no file.
  const safeType = /^[A-Za-z0-9][A-Za-z0-9_:.-]{0,127}$/.test(subagentType) && !subagentType.includes('..');
  if (safeType) {
    try { fm = readFileSync(join(agentsDir, `${subagentType}.md`), 'utf-8').slice(0, 4000); } catch { /* no agent file — built-in type */ }
  }
  // Cross-vendor key: an explicit `lane:` frontmatter key wins (the workers), else the
  // type with a lower-cased first letter (Astra → astra). Mirrors HookBridge codex-lanes.
  const laneKey = fm.match(/^lane:\s*(\S+)/m)?.[1];
  const cvKey = laneKey ?? subagentType.charAt(0).toLowerCase() + subagentType.slice(1);
  if (Object.hasOwn(CROSS_VENDOR, cvKey) && typeof CROSS_VENDOR[cvKey] === 'string') return { model: CROSS_VENDOR[cvKey], level: 'cross-vendor' };
  if (inputModel) return { model: inputModel, level: levelForModel(inputModel) };
  const m = fm.match(/^model:\s*(\S+)/m);
  if (m) return { model: m[1], level: `${levelForModel(m[1])}-pin` };
  return { model: 'inherited', level: 'session' };
}

interface ToolHookInput {
  session_id?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: AgentToolInput;
  tool_response?: unknown;
  transcript_path?: string;
}

const OBS_DIR = lifeosPath('MEMORY', 'OBSERVABILITY');
const EVENTS_NAME = 'subagent-events.jsonl';
const STARTS_NAME = 'agent-starts.json';
const PRIVATE_FILE = 0o600;
const PRIVATE_DIR = 0o700;
/** stdin past this is not a real Agent payload; refuse to parse it (P2 #21). */
const MAX_STDIN_BYTES = 4 * 1024 * 1024;

type StartRecord = { epoch: number; timestamp: string; subagent_type: string; description: string; model?: string; level?: string };

/**
 * v1.8.0 (2026-10-13, hooks audit shard aa #1): the log carries the prompt's
 * length and a short sha256, never its text. The old 200-char prompt_preview
 * sat at rest at 0644. Files are 0600, the directory 0700, and existing files
 * are tightened on every write (idempotent repair).
 */
export function promptFingerprint(prompt: string): { prompt_chars: number; prompt_sha256: string } {
  return { prompt_chars: prompt.length, prompt_sha256: createHash('sha256').update(prompt).digest('hex').slice(0, 16) };
}

/** Make a directory exist at 0700 and tighten it if looser. */
export function ensurePrivateDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR });
  if ((statSync(dir).mode & 0o077) !== 0) chmodSync(dir, PRIVATE_DIR);
}

function readStarts(startsFile: string): Record<string, StartRecord> {
  try {
    if (existsSync(startsFile)) {
      const parsed: unknown = JSON.parse(readFileSync(startsFile, 'utf-8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, StartRecord>;
    }
  } catch { /* corrupted — reset */ }
  return {};
}

/** Atomic 0600 write: temp file then rename, so a concurrent reader never sees half a file (P2 #20). */
function writeStarts(startsFile: string, starts: Record<string, StartRecord>) {
  invariant(starts !== null && typeof starts === 'object' && !Array.isArray(starts), 'agent-starts must be a plain object');
  const tmp = startsFile + '.' + process.pid + '.' + Date.now() + '.tmp';
  writeFileSync(tmp, JSON.stringify(starts, null, 2), { encoding: 'utf-8', mode: PRIVATE_FILE });
  chmodSync(tmp, PRIVATE_FILE);
  renameSync(tmp, startsFile);
}

/** Tighten the files this hook already wrote. Idempotent; never reads content. Returns the paths it changed. */
export function repairModes(obsDir: string): string[] {
  const changed: string[] = [];
  for (const p of [join(obsDir, EVENTS_NAME), join(obsDir, STARTS_NAME)]) {
    if (existsSync(p) && (statSync(p).mode & 0o077) !== 0) { chmodSync(p, PRIVATE_FILE); changed.push(p); }
  }
  return changed;
}

async function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    const timer = setTimeout(() => resolve(data), 2000);
    process.stdin.on('data', (c) => { data += c.toString(); });
    process.stdin.on('end', () => { clearTimeout(timer); resolve(data); });
    process.stdin.on('error', () => { clearTimeout(timer); resolve(data); });
  });
}

function correlationKey(sessionId: string, description: string): string {
  return `${sessionId}::${description}`;
}

/** Log subagent start/stop for an Agent tool call (Pre + Post). Never emits model context. */
export function run(data: ToolHookInput, obsDir: string = OBS_DIR): null {
  const EVENTS_FILE = join(obsDir, EVENTS_NAME);
  const STARTS_FILE = join(obsDir, STARTS_NAME);
  try {
    if (data.tool_name !== 'Agent') return null;
    // Function-hook era (2026-09-05): when the LifeOSHooks plugin stamped this
    // session its agent.spawn hook logs the start with the RESOLVED model and its
    // agent poll logs the stop; this hook is the fallback path only (no plugin).
    if (hookDrawn(data.session_id)) return null;

    const sessionId = data.session_id || 'unknown';
    const input = data.tool_input || {};
    const subagentType = input.subagent_type || 'general-purpose';
    const description = input.description || '(no description)';
    const prompt = typeof input.prompt === 'string' ? input.prompt : '';
    const isPost = data.hook_event_name === 'PostToolUse';
    const key = correlationKey(sessionId, description);

    ensurePrivateDir(obsDir);
    repairModes(obsDir);

    if (!isPost) {
      const now = Date.now();
      const dispatch = resolveDispatch(subagentType, input.model);

      // NP7 (2026-08-11): resolve an inherited dispatch to the session's live
      // carrier so the tier mix is computable from telemetry. liveModel() reads
      // the transcript tail and skips sidechain rows; when it can't answer
      // (first turn, nested spawns) the record keeps the honest 'inherited'.
      if (dispatch.model === 'inherited') {
        const carrier = liveModel(data.transcript_path);
        if (carrier) {
          dispatch.model = carrier;
          dispatch.level = 'session-inherited';
        }
      }

      const starts = readStarts(STARTS_FILE);
      starts[key] = {
        epoch: now,
        timestamp: getISOTimestamp(),
        subagent_type: subagentType,
        description,
        model: dispatch.model,
        level: dispatch.level,
      };
      writeStarts(STARTS_FILE, starts);

      const event = {
        timestamp: getISOTimestamp(),
        event: 'subagent_start',
        session_id: sessionId,
        subagent_id: key,
        subagent_type: subagentType,
        subagent_model: dispatch.model,
        subagent_level: dispatch.level,
        description,
        ...promptFingerprint(prompt),
      };
      appendPrivateLine(EVENTS_FILE, event);
      console.error(`[AgentInvocation] START: ${subagentType} (${dispatch.level} → ${dispatch.model}) — ${description.slice(0, 48)}`);

      // Observe and log only — no advisory, no classifier, no tier rubric.
      // The saved /model value is the single dial; a dispatch that omits
      // `model` inherits it, which is the intended carrier (OPERATIONAL_PREFERENCES
      // § Model selection, 2026-07-11). The former explicit-model advisory
      // that lived here was removed when that rule was retired.
    } else {
      const starts = readStarts(STARTS_FILE);
      const startRec = Object.hasOwn(starts, key) ? starts[key] : undefined;
      let duration: number | null = null;
      if (startRec) {
        duration = Math.round((Date.now() - startRec.epoch) / 1000);
        delete starts[key];
        writeStarts(STARTS_FILE, starts);
      }

      // Background/mailbox spawn: PostToolUse fires at spawn, not completion.
      // A duration-0 "stop" here is a lie — the agent is still running. Log the
      // async spawn; the statusline tracks its liveness from the harness's
      // subagents/agent-*.jsonl transcript mtime.
      const respStr = typeof data.tool_response === 'string'
        ? data.tool_response
        : JSON.stringify(data.tool_response ?? '');
      // `Async agent launched successfully` is the current harness wording for a background Agent (2026-09-10: it was
      // being logged as a stop at launch, so RouteTrail read every background dispatch as ∅ the moment it started).
      const isAsyncSpawn = /Spawned successfully|Async agent launched|running and will receive instructions via mailbox/i.test(respStr);

      const event = {
        timestamp: getISOTimestamp(),
        event: isAsyncSpawn ? 'subagent_spawned_async' : 'subagent_stop',
        session_id: sessionId,
        subagent_id: key,
        subagent_type: subagentType,
        description,
        duration_seconds: isAsyncSpawn ? null : duration,
      };
      appendPrivateLine(EVENTS_FILE, event);
      console.error(`[AgentInvocation] ${isAsyncSpawn ? 'ASYNC-SPAWN' : 'STOP'}: ${subagentType} — ${description.slice(0, 48)}${isAsyncSpawn ? '' : ` (${duration ?? '?'}s)`}`);
    }
  } catch (e) {
    console.error('[AgentInvocation]', e instanceof Error ? e.message : String(e));
  }
  return null;
}

if (import.meta.main) {
  const raw = await readStdin();
  if (raw.trim() && raw.length <= MAX_STDIN_BYTES) { try { run(JSON.parse(raw) as ToolHookInput); } catch { /* never block */ } }
  process.exit(0);
}
