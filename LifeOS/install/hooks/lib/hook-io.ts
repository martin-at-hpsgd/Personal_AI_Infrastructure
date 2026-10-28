/**
 * @version 1.8.0
 * hook-io.ts — Shared stdin reader for Stop hooks
 *
 * Eliminates duplicated stdin-reading boilerplate across individual hooks.
 * Each hook calls readHookInput() to get the parsed JSON payload, and
 * parseTranscriptFromInput() if it needs the full transcript.
 *
 * 1.8.0 (2026-10-15, ISA 20261015-security-p1-batch1 C8): the Stop path is an ADVISE gate. Unusable Stop input
 * still lets the turn end (a block could deadlock the loop-breaker), but it now fails open loudly through
 * runGateSync("advise"): one Vigil hook-error event and one stderr line.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { lifeosPath } from '../../LIFEOS/TOOLS/Paths';
import { parseTranscript, type ParsedTranscript } from '../../LIFEOS/TOOLS/TranscriptParser';
import { parseHookStdin, isString } from './hook-input';
import { gateInput, runGateSync, type GateDeps } from './gate-run';

export interface HookInput {
  session_id: string;
  transcript_path: string;
  hook_event_name: string;
  last_assistant_message?: string;
  /**
   * Active effort level for the current run (Anthropic CC v2.1.133+).
   * Mirrors the same value as `$CLAUDE_EFFORT` in Bash subprocesses.
   * Absent when effort routing is undecided; treat absence as "run full work."
   */
  effort?: {
    level?: string;
  };
  /**
   * Anthropic Stop-hook loop-breaker (documented hook API).
   * `true` when this Stop hook is firing as a follow-up to a previous
   * `{"decision":"block"}` response — the hook MUST short-circuit (continue:true)
   * to avoid deadlocking the session. See OutputFormatGate.hook.ts +
   * VerificationGate.hook.ts for canonical usage.
   */
  stop_hook_active?: boolean;
  /** Present only on subagent hook input — the delegate's id. (public PR #1958, @theNetworkChuck) */
  agent_id?: string;
  /** Present only on subagent hook input; a forked subagent carries "fork". */
  agent_type?: string;
  /** SessionStart only: startup | resume | clear | compact | fork. */
  source?: string;
}

/**
 * Where a payload that arrived without a transcript_path is noted. A hook must never wedge the harness, so such a payload still
 * allows (readHookInput returns null); this local line is the only record that it happened. Override: LIFEOS_HOOK_IO_FALLBACK.
 * No static Vigil import: hook-io sits under every hook. The Stop path reaches Vigil only through gate-run, which
 * resolves Vigil lazily by a computed path at emit time (LIFEOS/TOOLS/lib/VigilOptional), so nothing cycles.
 */
export function hookIoFallbackPath(): string {
  if (process.env.LIFEOS_HOOK_IO_FALLBACK) return process.env.LIFEOS_HOOK_IO_FALLBACK;
  if (process.env.NODE_ENV === 'test') return join(tmpdir(), `lifeos-hook-io-fallback-test-${process.pid}`, 'hook-io-fallback.jsonl');
  return lifeosPath('MEMORY', 'STATE', 'hook-io-fallback.jsonl');
}

/** Append one content-free line (time, hook name, event name, reason) and name the hook on stderr. Never throws. */
export function recordMissingTranscript(payload: Record<string, unknown>): void {
  const hook = basename(process.argv[1] ?? '') || 'unknown-hook';
  const event = typeof payload.hook_event_name === 'string' ? payload.hook_event_name : 'unknown-event';
  console.error(`[hook-io] ${hook}: stdin missing transcript_path; allowing without a record (noted in hook-io-fallback.jsonl)`);
  try {
    const path = hookIoFallbackPath();
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify({ ts: new Date().toISOString(), hook, event, reason: 'missing_transcript_path' }) + '\n');
  } catch { /* the fallback record is best effort; the hook still allows */ }
}

/**
 * Why a hook payload could not be used. `empty` is a hook run with nothing on stdin; every other
 * reason is an integrity failure a gate must not read as "nothing to check" (LOSIntegrity
 * ).
 */
export type HookInputFailure = 'empty' | 'boundary_rejected' | 'missing_transcript_path' | 'read_error';
export type HookInputRead = { ok: true; input: HookInput } | { ok: false; reason: HookInputFailure; event: string };

/** Append one content-free integrity-failure line (time, hook, event, reason). Never throws. */
export function recordInputFailure(reason: HookInputFailure, event: string): void {
  const hook = basename(process.argv[1] ?? '') || 'unknown-hook';
  try {
    const path = hookIoFallbackPath();
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify({ ts: new Date().toISOString(), hook, event, reason }) + '\n');
  } catch { /* best effort; the typed result still carries the failure */ }
}

/**
 * The hook output a Stop-event GATE emits when its input could not be used. Every Stop gate is an ADVISE gate
 * (ISA 20261015-security-p1-batch1): it fails open, loudly. The input failure runs through
 * runGateSync("advise"), which records one Vigil `hook-error` event naming the gate and prints one stderr line,
 * and the principal sees the unresolved obligation (`systemMessage`). It does not block: the harness's
 * loop-breaker (`stop_hook_active`) cannot be read from a broken payload, so a block here would deadlock a
 * harness that keeps sending the same malformed input. Returns null, and records nothing, for `empty` input,
 * which is not a gate run. `deps` stubs the emitter and logger in tests.
 */
export function gateInputFailureDecision(read: HookInputRead, gate: string, deps: GateDeps = {}): { systemMessage: string } | null {
  if (read.ok || read.reason === 'empty') return null;
  const run = runGateSync('advise', gate, () => gateInput(read), deps);
  const recorded = run.status === 'failed' && run.emitted;
  return {
    systemMessage: `[${gate}] UNRESOLVED: the Stop hook input could not be read (${read.reason}, event ${read.event}), ` +
      'so no stop gate ran for this turn. Nothing it checks was verified. ' +
      (recorded ? 'A Vigil hook-error event records it.' : 'The Vigil hook-error event could not be recorded.'),
  };
}

/**
 * Read and parse JSON from stdin with a 2000ms timeout. Returns the parsed input or a typed failure;
 * every failure except `empty` is recorded to the fallback ledger. Gate callers use this, never the null form.
 */
export async function readHookInputResult(): Promise<HookInputRead> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  try {
    const decoder = new TextDecoder();
    reader = Bun.stdin.stream().getReader();
    let input = '';

    const timeoutPromise = new Promise<void>((resolve) => {
      setTimeout(() => resolve(), 2000);
    });

    const readPromise = (async () => {
      while (true) {
        const { done, value } = await reader!.read();
        if (done) break;
        input += decoder.decode(value, { stream: true });
      }
    })();

    await Promise.race([readPromise, timeoutPromise]);
    reader.cancel().catch(() => {});

    if (!input.trim()) return { ok: false, reason: 'empty', event: 'unknown-event' };
    const parsed = parseHookStdin(input);
    if (!parsed.ok) {
      console.error('[hook-io] stdin rejected at boundary:', parsed.reason);
      recordInputFailure('boundary_rejected', 'unknown-event');
      return { ok: false, reason: 'boundary_rejected', event: 'unknown-event' };
    }
    const event = isString(parsed.value.hook_event_name) ? parsed.value.hook_event_name : 'unknown-event';
    if (!isString(parsed.value.transcript_path)) {
      recordMissingTranscript(parsed.value as Record<string, unknown>);
      return { ok: false, reason: 'missing_transcript_path', event };
    }
    return { ok: true, input: parsed.value as unknown as HookInput };
  } catch (error) {
    if (reader) reader.cancel().catch(() => {});
    console.error('[hook-io] Error reading stdin:', error);
    recordInputFailure('read_error', 'unknown-event');
    return { ok: false, reason: 'read_error', event: 'unknown-event' };
  }
}

/**
 * Read and parse JSON from stdin with a 2000ms timeout.
 * Returns null if stdin is empty or malformed. For hooks that only observe: a GATE must use
 * readHookInputResult so a null never reads as "passed".
 */
export async function readHookInput(): Promise<HookInput | null> {
  const read = await readHookInputResult();
  return read.ok ? read.input : null;
}

/**
 * Parse transcript from hook input. Waits 150ms for transcript to be
 * fully written to disk before parsing.
 *
 * Memoized on the input object (2026-10-16 native-unblock ISC-13): StopGates hands one input to every gate, and four
 * of them each paid the wait and the parse, 600ms of sleep per stop. One input now waits and parses once; a new turn
 * is a new input object, so a long-lived process never reads a stale transcript.
 */
const parsedByInput = new WeakMap<HookInput, Promise<ParsedTranscript>>();
export function parseTranscriptFromInput(input: HookInput): Promise<ParsedTranscript> {
  let p = parsedByInput.get(input);
  if (!p) {
    p = new Promise<void>(resolve => setTimeout(resolve, 150)).then(() => parseTranscript(input.transcript_path));
    parsedByInput.set(input, p);
  }
  return p;
}
