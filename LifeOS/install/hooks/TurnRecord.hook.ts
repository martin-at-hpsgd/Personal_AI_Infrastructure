#!/usr/bin/env bun
/**
 * TurnRecord.hook.ts — UserPromptSubmit, async: one STATVS `turn` row per human prompt (STATVS ISA ISC-85),
 * tying the prompt to both repos' full commits and uncommitted changes, the model and effort it ran on, the
 * notification channel, this Mac's keyboard idle time and the record's size, so Rewind and Replay can put the turn
 * back together. The config repo's uncommitted changes and untracked files under hooks/, LIFEOS/ and skills/ are
 * stored once by hash (CENSVS ISA ISC-55). Prints nothing and never blocks or fails a prompt.
 * @version 1.1.0
 */
import { realpathSync } from "node:fs";
import { getClaudeDir, lifeosPath } from "./lib/paths";
import { hardwareIdleMinutes } from "./lib/seat-guard";
import { getNotificationChannel } from "./lib/notification-channel";
import { appendTurn, BODY_SCOPE, isOwnTranscript, turnData, type TurnHookInput } from "../LIFEOS/STATVS/lib/turn";

/** The USER data repo: LIFEOS/USER is a symlink into it, so follow the link to the repo itself. */
function userRepoDir(): string {
  const link = lifeosPath("USER");
  try { return realpathSync(link); } catch { return link; }
}

try {
  const input = JSON.parse(await Bun.stdin.text()) as { session_id?: string; transcript_path?: string } & TurnHookInput;
  // A turn row is only useful pointing at the session's own Claude Code transcript; anything else (a bridge
  // test's temp file, another front door's log) is input Rewind cannot read, so it is not recorded.
  if (input.session_id && input.transcript_path && isOwnTranscript(input.session_id, input.transcript_path)) {
    const data = await turnData({
      transcriptPath: input.transcript_path,
      repos: { config: getClaudeDir(), user: userRepoDir() },
      bodies: { config: BODY_SCOPE },
      session: input.session_id,
      hook: { model: input.model, effort: input.effort },
      channel: getNotificationChannel(),
      idle: hardwareIdleMinutes,
    });
    appendTurn(input.session_id, data);
  }
} catch {
  // The record must never cost a prompt; STATVS counts its own refusals and spools.
}
process.exit(0);
