#!/usr/bin/env bun
/**
 * @version 1.4.11
 * VoiceCompletion.hook.ts — Send completion voice line to TTS server
 *
 * PURPOSE:
 * Extracts the 🗣️ voice line from Claude's response and sends it to
 * the Fish voice server for spoken playback.
 *
 * TRIGGER: Stop
 *
 * NEEDS TRANSCRIPT: Yes (for voice line extraction)
 *
 * VOICE GATE: Only fires for main terminal sessions (not subagents).
 * Checks for kitty-sessions/{sessionId}.json to determine if main session.
 *
 * HANDLER: handlers/VoiceNotification.ts
 */

import { readHookInput, parseTranscriptFromInput } from './lib/hook-io';
import { handleVoice } from './handlers/VoiceNotification';
import { extractVoiceCompletion } from '../LIFEOS/TOOLS/TranscriptParser';
import { isDesktopChannel, logSkippedVoice, getNotificationChannel } from './lib/notification-channel';
import { hookCovers } from './lib/function-hooks';
import type { ParsedTranscript } from '../LIFEOS/TOOLS/TranscriptParser';
import { isOn as voiceModeOn, spokenLine } from '../LIFEOS/TOOLS/VoiceMode';

// Only the 🗣️ closer is ever spoken (or 🎙️ SPOKEN in voice mode). A reply without one —
// an agent's hand-back, an interim stop, a gate-blocked turn — stays silent. The old
// first-sentence fallback spoke those aloud mid-turn (principal directive, 2026-10-14).

/**
 * Voice gate: only main terminal sessions get voice.
 * Subagents spawned via Task tool have CLAUDE_CODE_AGENT_TASK_ID set.
 * The old kitty-sessions file check was unreliable — new sessions
 * had no file and were incorrectly blocked.
 */
function isMainSession(): boolean {
  // Subagents set this env var; main sessions don't
  return !process.env.CLAUDE_CODE_AGENT_TASK_ID;
}

/** Unit E (2026-09-05): speak an answer's 🗣️ line. Called by HookBridge turn-complete in an
 *  armed LifeOSHooks session with the answer the engine handed the plugin; same gates as main. */
export async function speakAnswer(sessionId: string, answer: string): Promise<boolean> {
  if (!isMainSession()) return false;
  if (!isDesktopChannel()) { logSkippedVoice({ hookLabel: 'VoiceCompletion', message: '', sessionId }); return false; }
  // Voice mode off: spokenLine returns exactly this closer path's output (VoiceMode.ts, ISC-23).
  const pick = spokenLine(sessionId, answer, extractVoiceCompletion);
  if (!pick.text) return false;
  await handleVoice({ voiceCompletion: pick.text } as ParsedTranscript, sessionId, { interruptible: pick.interruptible, spoken: pick.source === 'spoken' });
  return true;
}

async function main() {
  const input = await readHookInput();
  if (!input) { process.exit(0); }
  // Armed LifeOSHooks session: turn.complete speaks through HookBridge turn-complete.
  if (hookCovers(String(input.session_id ?? ''), 'voice')) process.exit(0);

  // Voice gate: skip subagent sessions
  if (!isMainSession()) {
    console.error('[VoiceCompletion] Voice OFF (not main session)');
    process.exit(0);
  }

  // Channel gate: desktop /notify must not fire when the session is running
  // on behalf of a remote channel (iMessage, Siri). Those channels deliver
  // replies via their own APIs. See hooks/lib/notification-channel.ts.
  if (!isDesktopChannel()) {
    const channel = getNotificationChannel();
    console.error(`[VoiceCompletion] Voice OFF (remote channel: ${channel})`);
    logSkippedVoice({ hookLabel: 'VoiceCompletion', message: '', sessionId: input.session_id });
    process.exit(0);
  }

  const parsed = await parseTranscriptFromInput(input);

  // If transcript parsing found no voice line, try last_assistant_message's 🗣️ line. No closer, no speech.
  if (!parsed.voiceCompletion && input.last_assistant_message) {
    parsed.voiceCompletion = extractVoiceCompletion(input.last_assistant_message) || '';
    if (!parsed.voiceCompletion) console.error('[VoiceCompletion] no 🗣️ line — staying silent');
  }

  // Voice mode: speak the reply's 🎙️ SPOKEN field instead of the closer, interruptibly.
  let voiceOpts: { interruptible?: boolean; spoken?: boolean } | undefined;
  if (voiceModeOn(input.session_id) && input.last_assistant_message) {
    const pick = spokenLine(input.session_id, input.last_assistant_message, () => parsed.voiceCompletion || '', extractVoiceCompletion);
    parsed.voiceCompletion = pick.text;
    voiceOpts = { interruptible: pick.interruptible, spoken: pick.source === 'spoken' };
  }

  try {
    await handleVoice(parsed, input.session_id, voiceOpts);
  } catch (err) {
    console.error('[VoiceCompletion] Handler failed:', err);
  }

  process.exit(0);
}

// Guarded: HookBridge imports speakAnswer from this file, and an unguarded
// main() ran at import time inside the bridge child, consumed its stdin, and
// process.exit(0)'d it before prompt-context could store the session name
// (2026-09-07: unnamed sessions whenever the child outlived the 2 s stdin race).
if (import.meta.main) {
  main().catch((err) => {
    console.error('[VoiceCompletion] Fatal:', err);
    process.exit(0);
  });
}
