#!/usr/bin/env bun
/**
 * @version 1.0.4
 * MicroIntegrity.hook.ts — per-turn doc sync (Stop, async)
 *
 * After a turn that wrote files in ~/.claude or the USER tree, finds the docs that name those files and brings
 * them back in line: renames repointed by whole-path replacement, everything else through one medium-level model
 * call that proposes small exact edits. Edits land only in clean, unprotected Markdown and are committed with
 * commitOwn. The statusline's doc chip reads the per-session state file this writes.
 *
 * TRIGGER: Stop, registered `async: true`, so the turn never waits. Prints nothing.
 * SCOPE: every write and commit since this session's previous run (a cursor file beside the state), so a message sent
 * mid-turn never hides earlier edits; headless sessions skip.
 * FAST EXIT: the model, commit and redaction modules load only after the turn is known to have touched something.
 * Core: hooks/lib/micro-integrity.ts
 */
import { realpathSync } from "fs";
import { join } from "path";
import { readHookInput } from "./lib/hook-io";
import { isDesktopChannel } from "./lib/notification-channel";
import { getClaudeDir, lifeosPath } from "./lib/paths";
import { transcriptToolCalls } from "./ISAFoldGate.hook";
import { callsSince, microIntegrity, makeInfer, readCursor, withLock, writeCursor, writeState, SESSION_ID } from "./lib/micro-integrity";

async function main(): Promise<void> {
  if (!isDesktopChannel()) return;
  const input = await readHookInput();
  const session = input?.session_id;
  if (!input || typeof session !== "string" || !SESSION_ID.test(session)) return;
  const claude = realpathSync(getClaudeDir());
  let user: string;
  try { user = realpathSync(join(claude, "LIFEOS", "USER")); } catch { user = join(claude, "LIFEOS", "USER"); }
  const stateDir = process.env.LIFEOS_MICRO_INTEGRITY_DIR || lifeosPath("MEMORY", "STATE", "micro-integrity");
  const started = Date.now();
  const fail = (reason: string) => writeState(stateDir, session, { state: "error", updated: [], flags: [{ doc: "-", reason }], at: new Date().toISOString(), ms: Date.now() - started, touched: 0 });
  const result = await withLock(stateDir, session, async () => {
    // Everything since the previous run, so edits made before a mid-turn message are checked too. Inside the lock, so
    // two runs never read or move the cursor at once.
    const cursor = readCursor(stateDir, session);
    const read = transcriptToolCalls(input.transcript_path, cursor ? "session" : "turn", { lenient: true });
    if (!read.ok) return "nothing";
    const calls = cursor ? callsSince(read.calls, cursor) : read.calls;
    try {
      const [{ inference }, { commitOwn }, { redact }] = await Promise.all([
        import("../LIFEOS/TOOLS/Inference"), import("../LIFEOS/TOOLS/CommitOwn"), import("../LIFEOS/TOOLS/lib/Boundary"),
      ]);
      return await microIntegrity(session, calls, {
        roots: { claude, user },
        stateDir,
        infer: makeInfer(inference),
        commit: (paths, message, repo) => commitOwn(paths, [message], repo),
      }, redact) ?? "nothing";
    } catch (err) {
      // A crash must not leave the chip saying "running".
      fail(String(err).slice(0, 200));
      throw err;
    } finally {
      writeCursor(stateDir, session, read.calls);
    }
  });
  // The previous run in this session held the lock past the wait: say so rather than drop the turn silently.
  if (result === null) fail("the previous turn's doc sync was still running; this turn was not checked");
}

main().catch((err) => { console.error("[MicroIntegrity]", err); }).finally(() => process.exit(0));
