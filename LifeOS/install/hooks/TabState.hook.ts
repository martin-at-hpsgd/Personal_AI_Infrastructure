#!/usr/bin/env bun
/**
 * @version 1.2.3
 * TabState.hook.ts — Unified Kitty tab-state hook (PreToolUse + PostToolUse + PermissionRequest + Stop + StopFailure)
 *
 * Since 2026-08-12 EVERY stamp routes through setAscentTab: the tab color is
 * always the run's ascent-state color (the same paint as the Pulse phase list),
 * and the "waiting on you" signal is the ⏳ activity glyph, not a special color
 * (question teal and blocked amber are retired).
 *
 * CONSOLIDATION (2026-07-10, the principal's hook consolidation):
 * Merges three former hooks into ONE file, dispatched on `hook_event_name`:
 *   - PreToolUse  (matcher AskUserQuestion) ← SetQuestionTab.hook.ts
 *       Stamps ⏳ on the run's ascent color; saves previousTitle for restore.
 *   - PostToolUse (matcher AskUserQuestion) ← QuestionAnswered.hook.ts
 *       Restores the run's prior ascent state after the user answers.
 *   - Stop                                  ← ResponseTabReset.hook.ts
 *       Sets completion/past-tense tab state via handlers/TabState.ts.
 *
 * PURE TERMINAL-UI PLUMBING: writes ZERO bytes to model context. All output is
 * tab title/color via kitty remote control plus stderr diagnostics; stdout is empty.
 *
 * INPUT:  stdin — hook input JSON (read ONCE, shared across branches).
 * OUTPUT: stdout: None · stderr: status · exit(0): always (non-blocking, fail-open).
 *
 * ERROR HANDLING:
 * - Kitty unavailable: silent failure (other terminals not supported).
 * - stdin empty/malformed: fail-open, exit(0) with no tab change.
 */

import { readTabState, tabTitleActivity, getSessionShortLabel, setAscentTab } from './lib/tab-setter';
import { isValidQuestionTitle, getQuestionFallback } from './lib/output-validators';
import { readHookInput, parseTranscriptFromInput, type HookInput } from './lib/hook-io';
import { handleTabState } from './handlers/TabState';
import { clearHerdrWait, reportHerdrBlocked, reportHerdrTurnEnd } from './lib/herdr-tabs';
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { getClaudeDir } from './lib/paths';
import { closeTurn, doctrineDir } from '../LIFEOS/TOOLS/DoctrineMark';
import {
  contentToText, detectResponseState, extractCompletionPlain, extractStructuredSections, extractVoiceCompletion,
  type ParsedTranscript,
} from '../LIFEOS/TOOLS/TranscriptParser';

const FALLBACK_TITLE = getQuestionFallback();

// ---------------------------------------------------------------------------
// PreToolUse (AskUserQuestion) — formerly SetQuestionTab.hook.ts
// ---------------------------------------------------------------------------

/**
 * Extract a short summary from the AskUserQuestion tool_input.
 * Uses the header field (already a concise label); falls back to first 3 words
 * of the question text.
 */
function extractSummary(input: any): string {
  try {
    const questions = input?.tool_input?.questions;
    if (!Array.isArray(questions) || questions.length === 0) return FALLBACK_TITLE;

    const q = questions[0];

    // Prefer the header field — it's already a short label
    if (q.header && typeof q.header === 'string' && q.header.trim().length > 0) {
      return q.header.trim();
    }

    // Fallback: first 3 words of the question text
    if (q.question && typeof q.question === 'string') {
      const words = q.question.trim().split(/\s+/).slice(0, 3);
      return words.join(' ').replace(/\?$/, '');
    }
  } catch {
    // Fall through to default
  }
  return FALLBACK_TITLE;
}

function handlePreToolUse(input: HookInput): void {
  let summary = extractSummary(input as any);
  const sessionId = input.session_id;

  // Validate the summary for question titles
  if (!isValidQuestionTitle(summary)) {
    summary = FALLBACK_TITLE;
  }

  try {
    // Read current working title so the PostToolUse branch can restore it
    const currentState = readTabState(sessionId);
    const previousTitle = currentState?.title || undefined;

    // The question keeps the run's ascent COLOR (tab colors are the six run
    // states since 2026-08-12); the ⏳ activity glyph carries "waiting on you".
    // previousTitle + previousAscent ride along so the answer restores the run.
    const prior = currentState?.ascent;
    const stampState = prior && !['idle', 'cairn'].includes(prior) ? prior : 'traverse';
    setAscentTab(stampState, sessionId, summary, {
      activity: 'waiting',
      previousTitle,
      previousAscent: prior,
    });

    console.error(`[TabState/PreToolUse] Question stamp (⏳, ${stampState}): "${summary}"`);
  } catch (error) {
    // Silently fail if kitty remote control is not available
    console.error('[TabState/PreToolUse] Kitty remote control unavailable');
  }
}

// ---------------------------------------------------------------------------
// PermissionRequest — blocked-on-approval stamp (Herdr steal, 2026-08-11)
// ---------------------------------------------------------------------------

/** Short human-readable detail for the blocked title: what needs approving. */
function permissionDetail(input: any): string {
  const toolName = typeof input?.tool_name === 'string' ? input.tool_name : 'tool';
  try {
    const ti = input?.tool_input;
    if (toolName === 'Bash' && typeof ti?.command === 'string') {
      const cmd = ti.command.trim().replace(/\s+/g, ' ');
      return `Bash ${cmd.slice(0, 40)}${cmd.length > 40 ? '…' : ''}`;
    }
    if (typeof ti?.file_path === 'string') {
      const base = ti.file_path.split('/').filter(Boolean).pop();
      if (base) return `${toolName} ${base}`;
    }
  } catch { /* fall through */ }
  return toolName;
}

function handlePermissionRequest(input: HookInput): void {
  const sessionId = input.session_id;
  try {
    const currentState = readTabState(sessionId);
    // A second request while already blocked must not overwrite the REAL
    // previous title/ascent with the blocked stamp itself.
    const alreadyBlocked = currentState?.blocked === true;
    const previousTitle = alreadyBlocked ? currentState?.previousTitle : (currentState?.title || undefined);
    const previousAscent = alreadyBlocked ? currentState?.previousAscent : currentState?.ascent;

    // Approval stamps keep the run's ascent color too — ⏳ + the APPROVE text
    // carry the "waiting on you" signal (the amber blocked color is retired).
    const stampState = previousAscent && !['idle', 'cairn'].includes(previousAscent) ? previousAscent : 'traverse';
    setAscentTab(stampState, sessionId, `APPROVE: ${permissionDetail(input as any)}`, {
      activity: 'waiting',
      literal: true,
      blocked: true,
      previousTitle,
      previousAscent,
    });
    console.error(`[TabState/PermissionRequest] Approval stamp (⏳, ${stampState})`);
  } catch {
    console.error('[TabState/PermissionRequest] Kitty remote control unavailable');
  }
  // Herdr agents row: say what is waiting on approval, not only that something is. No-op outside herdr.
  try {
    const ti = (input as any)?.tool_input;
    reportHerdrBlocked(typeof (input as any)?.tool_name === 'string' ? (input as any).tool_name : 'tool', ti && typeof ti === 'object' ? ti : undefined);
  } catch (err) {
    console.error('[TabState/PermissionRequest] herdr blocked label failed:', err);
  }
}

// ---------------------------------------------------------------------------
// StopFailure — the turn died on an API error (colorizer steal)
// ---------------------------------------------------------------------------

/** Short label for the failed title: the error's first line, or a generic one. */
export function failureDetail(error: unknown): string {
  const first = typeof error === 'string' ? error.trim().split('\n')[0].replace(/\s+/g, ' ') : '';
  if (!first) return 'API error';
  return first.length > 40 ? `${first.slice(0, 40)}…` : first;
}

/** Stamp ❌ on the run's ascent color; the next prompt's working stamp replaces it. */
function handleStopFailure(input: HookInput): void {
  const sessionId = input.session_id;
  try {
    const prior = readTabState(sessionId)?.ascent;
    const stampState = prior && !['idle', 'cairn'].includes(prior) ? prior : 'traverse';
    setAscentTab(stampState, sessionId, `FAILED: ${failureDetail((input as any).error)}`, {
      activity: 'failed',
      literal: true,
    });
    console.error(`[TabState/StopFailure] Failed stamp (❌, ${stampState})`);
  } catch {
    console.error('[TabState/StopFailure] Kitty remote control unavailable');
  }
  // Herdr agents row: the turn is over, so a stale `$doing` must not read as live. No-op outside herdr.
  try {
    reportHerdrTurnEnd('', new Date(), true);
  } catch (err) {
    console.error('[TabState/StopFailure] herdr turn-end report failed:', err);
  }
}

/** Restore a blocked tab after the approved tool completed. */
function restoreFromBlocked(input: HookInput): void {
  try {
    const sessionId = input.session_id;
    const currentState = readTabState(sessionId);
    if (!currentState?.blocked) return; // not blocked — fast no-op (wildcard path)

    // Fall back to the traverse gerund, never a bare state word — and never
    // "restore" a stacked APPROVE stamp as if it were the run's real title.
    let restoredTitle = 'Traversing.';
    if (currentState.previousTitle) {
      const rawTitle = tabTitleActivity(currentState.previousTitle, getSessionShortLabel(sessionId));
      if (rawTitle && !/^APPROVE:/i.test(rawTitle)) restoredTitle = rawTitle;
    }
    const prior = currentState.previousAscent;
    const restoreState = prior && !['idle', 'cairn'].includes(prior) ? prior : 'traverse';
    setAscentTab(restoreState, sessionId, restoredTitle);
    console.error(`[TabState/PostToolUse] Blocked tab restored to ascent state: ${restoreState}`);
  } catch {
    console.error('[TabState/PostToolUse] Blocked-restore failed (kitty unavailable)');
  }
}

// ---------------------------------------------------------------------------
// PostToolUse — question restore (AskUserQuestion) or blocked restore (any tool)
// ---------------------------------------------------------------------------

function handlePostToolUse(input: HookInput): void {
  // Herdr space row: the tool ran, so an approval or a question it waited on was answered. No-op outside herdr.
  try { clearHerdrWait(); } catch (err) { console.error('[TabState/PostToolUse] herdr wait clear failed:', err); }
  // Wildcard registration: any tool other than AskUserQuestion only ever
  // clears a blocked stamp; everything else exits untouched.
  if ((input as any).tool_name !== 'AskUserQuestion') {
    restoreFromBlocked(input);
    return;
  }
  try {
    const sessionId = input.session_id;

    // Read previous working title saved by the PreToolUse branch
    const currentState = readTabState(sessionId);
    let restoredTitle = 'Processing answer.';

    if (currentState?.previousTitle) {
      // Strip any emoji prefix from the saved title and re-add working prefix
      const rawTitle = tabTitleActivity(currentState.previousTitle, getSessionShortLabel(sessionId));
      if (rawTitle) {
        restoredTitle = rawTitle;
      }
    }

    // Restore the run's real ascent state (carried through the question stamp);
    // un-ISA'd work restores to traverse — the pre-Algorithm gear is retired.
    const prior = currentState?.previousAscent;
    const restoreState = prior && !['idle', 'cairn'].includes(prior) ? prior : 'traverse';
    setAscentTab(restoreState, sessionId, restoredTitle);

    console.error(`[TabState/PostToolUse] Tab restored to ascent state: ${restoreState}`);
  } catch (error) {
    // Silently fail if kitty remote control is not available
    console.error('[TabState/PostToolUse] Kitty remote control unavailable');
  }
}

// ---------------------------------------------------------------------------
// Stop — formerly ResponseTabReset.hook.ts
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Stop transcript read — tail only (2026-10-09)
// ---------------------------------------------------------------------------
//
// parseTranscript() reads the WHOLE transcript and JSON-parses every line three
// times, and parseTranscriptFromInput() sleeps a fixed 150ms first. A long session
// made every Stop cost ~250ms before any tab work. The tab title only needs the
// current turn, so this reads the file from the end, a growing window at a time,
// until it holds everything parseTranscript() would have derived the fields from:
// the last real user prompt, the last assistant text, and the last assistant entry.
// The result is field-for-field what parseTranscript() returns (parity-tested in
// TabState.test.ts); `raw` carries only the window.

const TAIL_START_BYTES = 256 * 1024;

function readRange(path: string, start: number, end: number): string {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.allocUnsafe(end - start);
    let got = 0;
    while (got < buf.length) {
      const n = readSync(fd, buf, got, buf.length - got, start + got);
      if (n <= 0) break;
      got += n;
    }
    return buf.subarray(0, got).toString('utf8');
  } finally { closeSync(fd); }
}

/** parseTranscript()'s "real user prompt" test, on one parsed entry. */
function isRealUserPrompt(entry: any): boolean {
  if (entry?.type !== 'human' && entry?.type !== 'user') return false;
  const content = entry.message?.content;
  if (typeof content === 'string') return true;
  return Array.isArray(content) && content.some((b: any) => b?.type === 'text' && b?.text?.trim());
}

/** The fields of parseTranscript() derived from `lines`, or null when the window is too short to be sure. */
function scanWindow(lines: string[], windowIsWholeFile: boolean): ParsedTranscript | null {
  const entries: (any | undefined)[] = new Array(lines.length);
  const entryAt = (i: number): any => {
    if (entries[i] !== undefined) return entries[i];
    let e: any = null;
    if (lines[i].trim()) { try { e = JSON.parse(lines[i]); } catch { e = null; } }
    return (entries[i] = e);
  };
  let lastHuman = -1;
  let humanFound = false;
  let lastMessageIdx = -1;
  let lastAssistantIdx = -1;
  const turnTexts: { idx: number; text: string }[] = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const e = entryAt(i);
    if (!e) continue;
    if (!humanFound && isRealUserPrompt(e)) { lastHuman = i; humanFound = true; }
    if (e.type === 'assistant' && e.message?.content) {
      if (lastAssistantIdx === -1) lastAssistantIdx = i;
      const text = contentToText(e.message.content);
      if (text) {
        if (lastMessageIdx === -1) lastMessageIdx = i;
        if (!humanFound) turnTexts.push({ idx: i, text });
      }
    }
    if (humanFound && lastMessageIdx !== -1 && lastAssistantIdx !== -1) break;
  }
  if (!windowIsWholeFile && !(humanFound && lastMessageIdx !== -1 && lastAssistantIdx !== -1)) return null;
  const lastMessage = lastMessageIdx === -1 ? '' : contentToText(entryAt(lastMessageIdx).message.content);
  const currentResponseText = turnTexts.reverse().map((t) => t.text).join('\n');
  const rawFromLastAssistant = lastAssistantIdx === -1 ? '' : lines.slice(lastAssistantIdx).join('\n');
  return {
    raw: lines.join('\n'),
    lastMessage,
    currentResponseText,
    voiceCompletion: extractVoiceCompletion(currentResponseText),
    plainCompletion: extractCompletionPlain(currentResponseText),
    structured: extractStructuredSections(currentResponseText),
    responseState: detectResponseState(lastMessage, rawFromLastAssistant),
  };
}

/** parseTranscript() for the Stop path, reading from the end of the file. Throws only if the file cannot be read. */
export function parseTranscriptTail(path: string, startBytes = TAIL_START_BYTES): ParsedTranscript {
  const size = statSync(path).size;
  for (let want = Math.max(1, startBytes); ; want *= 4) {
    const start = Math.max(0, size - want);
    let text = readRange(path, start, size);
    if (start > 0) { // the window opens mid-line: drop the partial first line
      const nl = text.indexOf('\n');
      text = nl === -1 ? '' : text.slice(nl + 1);
    }
    const parsed = scanWindow(text.trim().split('\n'), start === 0);
    if (parsed) return parsed;
  }
}

/**
 * The transcript parse for Stop. parseTranscriptFromInput() always waits 150ms for the harness to
 * flush the transcript; the wait is skipped when the transcript's last assistant text equals the final
 * message the Stop payload carries. Without that proof, the 150ms wait runs as before.
 */
export async function parseForStop(input: HookInput): Promise<ParsedTranscript> {
  try {
    const final = typeof input.last_assistant_message === 'string' ? input.last_assistant_message.trim() : '';
    if (final) {
      const early = parseTranscriptTail(input.transcript_path);
      // Whole-message equality: a short final message ("Done.") can appear inside the previous turn,
      // so a substring match would skip the wait before this turn is flushed (review, 2026-10-09).
      if (early.lastMessage.trim() === final) return early;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
    return parseTranscriptTail(input.transcript_path);
  } catch {
    return parseTranscriptFromInput(input);
  }
}

async function handleStop(input: HookInput): Promise<void> {
  const parsed = await parseForStop(input);

  try {
    await handleTabState(parsed, input.session_id);
  } catch (err) {
    console.error('[TabState/Stop] Handler failed:', err);
  }

  // The statusline's doctrine mark (ISA 20261025-doctrine-mark): record doctrine writes this turn made from any
  // tool (a shell rewrite included), then turn a "from now on" turn with none red. The transcript is read only when a
  // doctrine file changed recently.
  try {
    if (input.session_id) await closeTurn(doctrineDir(join(getClaudeDir(), 'LIFEOS')), input.session_id, getClaudeDir(), async () => {
      const { transcriptToolCalls } = await import('./ISAFoldGate.hook');
      const read = transcriptToolCalls(input.transcript_path, 'turn', { lenient: true });
      if (!read.ok) return [];
      return read.calls.filter((c) => !c.sidechain).map((c) => ({ text: JSON.stringify(c.input), start: c.ts ?? 0, end: c.resultTs ?? Date.now(), ok: c.ok }));
    });
  } catch (err) {
    console.error('[TabState/Stop] doctrine mark failed:', err);
  }

  // Herdr agents row: when this turn ended and how many items it left open. No-op outside herdr.
  try {
    reportHerdrTurnEnd(input.last_assistant_message || parsed.currentResponseText || parsed.lastMessage || '');
  } catch (err) {
    console.error('[TabState/Stop] herdr turn-end report failed:', err);
  }
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/** Dispatch by event. Pure terminal-UI plumbing: never emits model context. */
export async function run(input: HookInput): Promise<null> {
  try {
    process.env.LIFEOS_SESSION_PROVIDER = process.env.LIFEOS_HARNESS === 'pai' ? 'LifeOS' : process.env.LIFEOS_HARNESS === 'codex' ? 'Codex' : 'Claude Code';
    const model = (input as HookInput & { model?: unknown }).model;
    if (typeof model === 'string' && model.trim()) {
      process.env.LIFEOS_SESSION_MODEL = model.trim();
    }
    switch (input.hook_event_name) {
      case 'PreToolUse':
        handlePreToolUse(input);
        break;
      case 'PostToolUse':
        handlePostToolUse(input);
        break;
      case 'PermissionRequest':
        handlePermissionRequest(input);
        break;
      case 'Stop':
        await handleStop(input);
        break;
      case 'StopFailure':
        handleStopFailure(input);
        break;
      default:
        // Unknown event — no-op, fail open
        break;
    }
  } catch (err) {
    console.error('[TabState] Dispatch failed:', err);
  }
  return null;
}

if (import.meta.main) {
  const input = await readHookInput();
  if (input) await run(input);
  process.exit(0);
}
