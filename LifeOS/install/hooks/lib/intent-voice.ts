/**
 * @version 1.0.0
 * intent-voice.ts — the one intent announcement (SkillSystem.md § Intent anatomy, "No voice block").
 *
 * Replaces the per-intent curl blocks. When the MAIN session finishes a Read of
 * `skills/<Skill>/Intents/<Intent>.md` while that skill is executing, the desktop
 * voice says "Running the <Intent> intent in the <Skill> skill". "Executing" means
 * execution.jsonl holds a main-session Skill call for <Skill> in this session within
 * the last 15 minutes; reads made while editing a skill outside an execution stay
 * silent (ISA 20261009-intent-ideal-state ISC-6, ISC-A3).
 *
 * Silent when: the tool is not a completed Read of an intent file; the input carries
 * agent_id/agent_type (a subagent); no recent main-session Skill call for that skill;
 * this session already announced that intent in the last 10 minutes; or the channel
 * is not desktop (checked last, so a channel skip is logged only for a real announcement).
 *
 * Pure decision logic plus two small effects (dedupe state write, fire-and-forget POST),
 * all injectable for tests. Called from hooks/EventLogger.hook.ts on PostToolUse;
 * every failure is swallowed by the caller so a voice fault never touches the tool.
 */

import { closeSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { invariant } from '../../LIFEOS/TOOLS/Invariant';
import { intentFromPath } from '../../LIFEOS/TOOLS/lib/IntentSections';

export const SKILL_WINDOW_MS = 15 * 60 * 1000;
export const DEDUPE_WINDOW_MS = 10 * 60 * 1000;
export const POST_TIMEOUT_MS = 1500;
/** Bytes read from the end of execution.jsonl: far more than 15 minutes of Skill calls. */
const EXECUTION_TAIL_BYTES = 256 * 1024;
const SAFE_SESSION = /^[A-Za-z0-9_-]{1,128}$/;
/** Clock skew tolerated between a Skill line's ts and now (a line can't be from the future). */
const FUTURE_SKEW_MS = 60 * 1000;

export interface IntentVoiceInput {
  session_id?: unknown;
  tool_name?: unknown;
  tool_input?: unknown;
  agent_id?: unknown;
  agent_type?: unknown;
}

export interface IntentVoiceDeps {
  now: number;
  /** MEMORY/SKILLS/execution.jsonl */
  executionFile: string;
  /** Directory holding one dedupe file per session (MEMORY/STATE/intent-voice). */
  stateDir: string;
  isDesktop: () => boolean;
}

export type IntentVoiceDecision =
  | { announce: true; session: string; skill: string; intent: string; message: string }
  | { announce: false; reason: string; skill?: string; intent?: string; message?: string };

export function buildIntentMessage(intent: string, skill: string): string {
  return `Running the ${intent} intent in the ${skill} skill`;
}

/** The trailing lines of a JSONL file, without the partial first line of a mid-file read. */
function tailLines(file: string, bytes: number): string[] {
  let fd: number;
  try { fd = openSync(file, 'r'); } catch { return []; }
  try {
    const size = statSync(file).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    if (start > 0) lines.shift();
    return lines.filter(l => l.trim().length > 0);
  } finally {
    closeSync(fd);
  }
}

/** Skill names match case-insensitively; a namespaced call (`plugin:Skill`) matches its last segment. */
function sameSkill(logged: string, skill: string): boolean {
  const name = logged.includes(':') ? logged.slice(logged.lastIndexOf(':') + 1) : logged;
  return name.toLowerCase() === skill.toLowerCase();
}

/** True when execution.jsonl holds a main-session Skill call for `skill` in `session` within the window. */
export function recentSkillCall(executionFile: string, session: string, skill: string, now: number): boolean {
  for (const raw of tailLines(executionFile, EXECUTION_TAIL_BYTES).reverse()) {
    let line: Record<string, unknown>;
    try { line = JSON.parse(raw) as Record<string, unknown>; } catch { continue; }
    if (line.session_id !== session || typeof line.skill !== 'string' || typeof line.ts !== 'string') continue;
    if (typeof line.agent_id === 'string' || typeof line.agent_type === 'string') continue; // a subagent's Skill call
    if (!sameSkill(line.skill, skill)) continue;
    const ts = Date.parse(line.ts);
    if (Number.isFinite(ts) && ts >= now - SKILL_WINDOW_MS && ts <= now + FUTURE_SKEW_MS) return true;
  }
  return false;
}

type DedupeState = Record<string, number>;

function statePath(stateDir: string, session: string): string {
  return join(stateDir, session + '.json');
}

function readState(stateDir: string, session: string): DedupeState {
  try {
    const parsed = JSON.parse(readFileSync(statePath(stateDir, session), 'utf8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const out: DedupeState = {};
    for (const [k, v] of Object.entries(parsed)) if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    return out;
  } catch {
    return {};
  }
}

function dedupeKey(skill: string, intent: string): string {
  return `${skill}/${intent}`;
}

/** Records that `session` announced `skill/intent` at `now`, pruning entries past the dedupe window. */
export function recordAnnouncement(stateDir: string, session: string, skill: string, intent: string, now: number): void {
  const key = dedupeKey(skill, intent);
  const path = statePath(stateDir, session);
  invariant(SAFE_SESSION.test(session), 'intent-voice state is keyed by a safe session id');
  invariant(/^[^/\0]+\/[^/\0]+$/.test(key), 'an intent-voice dedupe key is exactly <skill>/<intent>');
  invariant(Number.isFinite(now) && now > 0, 'an intent-voice announcement time is a positive epoch ms');
  invariant(resolve(path).startsWith(resolve(stateDir) + '/'), 'the intent-voice state file stays inside its state dir');
  const state = readState(stateDir, session);
  for (const [k, t] of Object.entries(state)) if (now - t >= DEDUPE_WINDOW_MS) delete state[k];
  state[key] = now;
  mkdirSync(stateDir, { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
  renameSync(tmp, path);
}

export function decideIntentVoice(input: IntentVoiceInput, deps: IntentVoiceDeps): IntentVoiceDecision {
  if (input.tool_name !== 'Read') return { announce: false, reason: 'not-read' };
  const toolInput = input.tool_input as { file_path?: unknown } | undefined;
  const filePath = toolInput && typeof toolInput.file_path === 'string' ? toolInput.file_path : null;
  const names = filePath ? intentFromPath(filePath) : null;
  if (!names) return { announce: false, reason: 'not-intent' };
  const { skill, intent } = names;
  const message = buildIntentMessage(intent, skill);
  if (typeof input.agent_id === 'string' || typeof input.agent_type === 'string') {
    return { announce: false, reason: 'subagent', skill, intent, message };
  }
  const session = typeof input.session_id === 'string' ? input.session_id : '';
  if (!SAFE_SESSION.test(session)) return { announce: false, reason: 'no-session', skill, intent, message };
  if (!recentSkillCall(deps.executionFile, session, skill, deps.now)) {
    return { announce: false, reason: 'no-recent-skill-call', skill, intent, message };
  }
  const last = readState(deps.stateDir, session)[dedupeKey(skill, intent)];
  if (last !== undefined && deps.now - last >= 0 && deps.now - last < DEDUPE_WINDOW_MS) {
    return { announce: false, reason: 'dedupe', skill, intent, message };
  }
  // Channel last, so a skip is logged only for a read that would otherwise have announced.
  if (!deps.isDesktop()) return { announce: false, reason: 'channel', skill, intent, message };
  return { announce: true, session, skill, intent, message };
}

/** POSTs the message to the voice server; resolves false on any failure or after the timeout, never throws. */
export async function postIntentVoice(pulseBase: string, message: string, timeoutMs = POST_TIMEOUT_MS): Promise<boolean> {
  try {
    const res = await fetch(`${pulseBase}/notify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export interface AnnounceDeps extends IntentVoiceDeps {
  post: (message: string) => Promise<boolean>;
  /** Called when the only thing that kept the announcement silent was the channel (observability). */
  onChannelSkip?: (message: string, session: string) => void;
}

/**
 * Decides, records and posts. The dedupe record is written before the POST so two
 * reads of the same intent in quick succession announce once even if the voice
 * server is slow. Never throws for an expected failure (unreadable log, voice down).
 */
export async function maybeAnnounceIntent(input: IntentVoiceInput, deps: AnnounceDeps): Promise<IntentVoiceDecision> {
  const decision = decideIntentVoice(input, deps);
  if (!decision.announce) {
    if (decision.reason === 'channel' && decision.message && deps.onChannelSkip) {
      deps.onChannelSkip(decision.message, typeof input.session_id === 'string' ? input.session_id : 'unknown');
    }
    return decision;
  }
  recordAnnouncement(deps.stateDir, decision.session, decision.skill, decision.intent, deps.now);
  await deps.post(decision.message);
  return decision;
}
