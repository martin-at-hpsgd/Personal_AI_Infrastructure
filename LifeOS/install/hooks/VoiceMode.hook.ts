#!/usr/bin/env bun
/**
 * @version 1.0.0
 * VoiceMode.hook.ts — voice mode's per-prompt half (UserPromptSubmit).
 *
 * When voice mode is on for this session (LIFEOS/TOOLS/VoiceMode.ts):
 *   1. stops the DA's speech, since a submitted prompt means the principal has the floor;
 *   2. injects the voice-mode instruction: the `🎙️ SPOKEN:` field, and when the session
 *      has an ISA, the spoken-interview rules naming that ISA.
 * When it is off the hook exits at once and prints nothing.
 *
 * Doc: LIFEOS/DOCUMENTATION/VoiceMode/VoiceMode.md
 */

import { join } from "node:path";
import { instruction, isOn } from "../LIFEOS/TOOLS/VoiceMode";
import { PULSE_BASE } from "../LIFEOS/PULSE/endpoint";
import { readRegistry } from "./lib/isa-utils";
import { PHASE_TO_ASCENT } from "../LIFEOS/TOOLS/ascent";

const LIFEOS_ROOT = join(import.meta.dir, "..", "LIFEOS");
// Never hand-list phase names (isa-utils.ts ACTIVE_LOOKUP_PHASES note): a phase is
// active when the one ascent table derives it as marking or ascending.
const isActive = (phase: unknown) => {
  const s = PHASE_TO_ASCENT[String(phase ?? "").toLowerCase()];
  return s === "marking" || s === "ascending";
};

/** The session's ISA: its active one if any, else the one it touched most recently. */
export function sessionIsaPath(sessionId: string, sessions: Record<string, any> = readRegistry().sessions): string | null {
  const rows = Object.values(sessions).filter((s: any) => s?.sessionUUID === sessionId && typeof s?.isa === "string");
  if (!rows.length) return null;
  const at = (s: any) => Date.parse(s.updatedAt ?? s.started ?? "") || 0;
  rows.sort((a: any, b: any) => {
    const act = Number(isActive(b.phase)) - Number(isActive(a.phase));
    return act || at(b) - at(a);
  });
  const isa = String((rows[0] as any).isa);
  return isa.startsWith("/") ? isa : join(LIFEOS_ROOT, isa);
}

export async function onPrompt(
  sessionId: string,
  deps: { stop?: () => Promise<unknown>; isaPath?: (id: string) => string | null; prompt?: string } = {},
): Promise<string | null> {
  if (!isOn(sessionId)) return null;
  const stop = deps.stop ?? (() => fetch(`${PULSE_BASE}/voice/stop`, { method: "POST", signal: AbortSignal.timeout(800) }));
  try { await stop(); } catch { /* voice server down: nothing is playing anyway */ }
  // A `/voice` prompt is the toggle itself; commands/voice.md says what that reply holds,
  // so the voice-mode instruction would contradict it on the turn that switches it off.
  if (/^\s*\/voice\b/.test(deps.prompt ?? "")) return null;
  let isa: string | null = null;
  try { isa = (deps.isaPath ?? sessionIsaPath)(sessionId); } catch { isa = null; }
  return JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: instruction(isa) } });
}

if (import.meta.main) {
  try {
    const raw = await Bun.stdin.text();
    const input = raw ? JSON.parse(raw) : {};
    const out = await onPrompt(String(input.session_id ?? ""), { prompt: String(input.prompt ?? "") });
    if (out) process.stdout.write(out);
  } catch (err) {
    console.error("[VoiceMode] hook failed:", err);
  }
  process.exit(0);
}
