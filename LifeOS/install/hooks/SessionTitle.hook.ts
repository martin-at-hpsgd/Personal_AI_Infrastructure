#!/usr/bin/env bun
/**
 * @version 1.0.0
 * SessionTitle.hook.ts — Claude Code's own session title follows ours.
 *
 * UserPromptSubmit, synchronous. The harness keeps its title in memory and
 * re-appends it to the JSONL every turn, so the only way to change it is
 * `hookSpecificOutput.sessionTitle` from a hook the harness waits on; an async
 * hook's output is recorded and ignored (an async hook returned the right title
 * and the harness kept the old one).
 *
 * reconcileHarnessTitle adopts a genuine `/rename` on a native session, projects
 * the work.json row (ISA name) into the stores otherwise, and returns the name
 * the harness should show. Runs in armed plugin sessions too: no other path can
 * set the title. Fails open.
 */
import { readFileSync } from 'node:fs';
import { getCustomTitle, reconcileHarnessTitle } from './lib/session-identity';

/** The hook's stdout for one input, or null when the harness already agrees. */
export function run(input: { session_id?: string; session_title?: string }): string | null {
  const sid = input.session_id ?? '';
  if (!sid) return null;
  const harness = input.session_title ?? getCustomTitle(sid);
  const canonical = reconcileHarnessTitle(sid, harness);
  if (!canonical || canonical === harness) return null;
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', sessionTitle: canonical } });
}

if (import.meta.main) {
  try {
    const out = run(JSON.parse(readFileSync(0, 'utf8') || '{}'));
    if (out) process.stdout.write(out);
  } catch (err) {
    console.error(`[SessionTitle] ${err}`);
  }
}
