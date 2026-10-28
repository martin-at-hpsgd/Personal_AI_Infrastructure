/**
 * @version 1.0.2
 * function-hooks.ts — the command-hook side of the LifeOSHooks bridge.
 *
 * The LifeOSHooks plugin (skills/LifeOSHooks) carries the hook-fed
 * 🧠 / ⚙️ / 🩺 lines in-process. When it is loaded for a session it writes a
 * per-session STAMP through LIFEOS/TOOLS/HookBridge.ts at `session.start`, which
 * is awaited before the first prompt. Every command hook that used to inject an
 * echo contract for those lines checks `hookDrawn(sessionId)` and goes quiet
 * when the stamp is fresh; with no stamp (the switch is off, the build is too
 * old, the module failed to load) they keep today's echo path unchanged.
 *
 * Why a stamp and not the env switch: CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 says
 * the runtime is on, not that THIS plugin loaded — the 2026-09-05 import probe
 * failed to load with the switch set. Liveness has to come from the plugin
 * itself, per session, or a silent load failure would also silence the lines.
 *
 * Shared by hooks (MemoryTurnStart, PostToolObserver, ISASync, FormatGate,
 * DriftReminder) and the bridge. No imports beyond node:fs/path.
 */

import { existsSync, statSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { getLifeosDir } from "./paths";

/** A stamp older than this is a dead session's; ignore it. Seven days, not one: a
 *  continuous session that outlives its stamp would get the echo blocks back while
 *  the plugin still draws (the double line ISC-17 forbids). Session ids are unique,
 *  so a lingering stamp is never read by another session. */
export const STAMP_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function safeId(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80) || "unknown";
}

export function stampDir(): string {
  return join(getLifeosDir(), "MEMORY", "STATE", "function-hooks");
}

export function stampPath(sessionId: string): string {
  return join(stampDir(), `${safeId(sessionId)}.json`);
}

/** Where MemoryTurnStart leaves the composed 🧠 / 🩺 lines for the plugin to draw. */
export function memoryLinePath(sessionId: string): string {
  return join(getLifeosDir(), "MEMORY", "STATE", "memory-inject", `${safeId(sessionId)}.line.json`);
}

/** True when the LifeOSHooks plugin stamped this session within the TTL. Fails OPEN (false). */
export function hookDrawn(sessionId: string | undefined | null, now: number = Date.now()): boolean {
  try {
    if (!sessionId) return false;
    const p = stampPath(sessionId);
    if (!existsSync(p)) return false;
    // Whole ms on both sides: since Bun 1.4 mtimeMs carries a sub-ms fraction, so a stamp written
    // this millisecond read as up to 1 ms in the future against integer Date.now() and failed age >= 0.
    const age = now - Math.floor(statSync(p).mtimeMs);
    return age >= 0 && age < STAMP_TTL_MS;
  } catch {
    return false;
  }
}

/**
 * What the plugin module loaded in a session has PROVEN it covers. The stamp
 * alone says a LifeOSHooks module is present; a session started on an older
 * module stays stamped after the source changes on disk (the skills-dir plugin
 * is not hot-reloaded), so a native hook that fast-exited on the stamp alone
 * went silent with nothing replacing it (2026-09-05, three sessions). The
 * bridge's `prompt-context` verb writes these the first time it runs, which
 * only a module that calls it can do; a native hook fast-exits only on the
 * capability it hands over. No caps → the native path runs exactly as before.
 */
export type HookCap = "prompt-context" | "turn-complete" | "band" | "voice";
export const PROMPT_MODULE_CAPS: readonly HookCap[] = ["prompt-context", "turn-complete", "band", "voice"];

export function readStamp(sessionId: string | undefined | null): { caps: HookCap[]; ts?: string } | null {
  try {
    if (!sessionId) return null;
    const p = stampPath(sessionId);
    if (!existsSync(p)) return null;
    const j = JSON.parse(readFileSync(p, "utf8")) as { caps?: unknown; ts?: string };
    const caps = Array.isArray(j.caps) ? (j.caps.filter((c): c is HookCap => typeof c === "string") as HookCap[]) : [];
    return { caps, ts: typeof j.ts === "string" ? j.ts : undefined };
  } catch {
    return null;
  }
}

/** True only when the session is stamped within the TTL AND the loaded module has claimed `cap`. Fails OPEN (false). */
export function hookCovers(sessionId: string | undefined | null, cap: HookCap, now: number = Date.now()): boolean {
  if (!hookDrawn(sessionId, now)) return false;
  return readStamp(sessionId)?.caps.includes(cap) ?? false;
}

/** Merge capabilities into the stamp, keeping its other fields. Best-effort; mtime is refreshed (the TTL clock). */
export function mergeStampCaps(sessionId: string, caps: readonly HookCap[]): void {
  try {
    if (!sessionId) return;
    const p = stampPath(sessionId);
    let cur: Record<string, unknown> = {};
    try { cur = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>; } catch { /* absent or unreadable: rebuild */ }
    const have = Array.isArray(cur.caps) ? (cur.caps as unknown[]).filter((c): c is string => typeof c === "string") : [];
    const merged = [...new Set([...have, ...caps])];
    if (merged.length === have.length && merged.every((c, i) => have[i] === c)) return; // unchanged: leave the file alone
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify({ session_id: safeId(sessionId), plugin: "LifeOSHooks", ...cur, caps: merged, caps_ts: new Date().toISOString() }) + "\n", "utf8");
  } catch {
    /* a missing cap keeps the native path running, never breaks the prompt */
  }
}

export interface SurfaceLines {
  memory?: string;
  health?: string;
}

/**
 * Pull the verbatim 🧠 MEMORY and 🩺 MEMORY HEALTH lines out of the blocks
 * MemoryDeltaSurface composes, so they can be handed to the plugin instead of
 * the model. The blocks are `<lifeos-memory-delta>` / `<lifeos-memory-health>`
 * with one instruction line then the payload line.
 */
export function extractSurfaceLines(blocks: readonly string[]): SurfaceLines {
  const out: SurfaceLines = {};
  for (const b of blocks) {
    for (const line of b.split("\n")) {
      const t = line.trim();
      if (!out.memory && /^🧠\s+\S/.test(t)) out.memory = t;
      else if (!out.health && /^🩺\s*MEMORY HEALTH\s*:/.test(t)) out.health = t;
    }
  }
  return out;
}

/** Read the lines file the plugin draws from; empty object when absent or unreadable. */
export function readSurfaceLines(sessionId: string): SurfaceLines {
  try {
    const p = memoryLinePath(sessionId);
    if (!existsSync(p)) return {};
    const parsed = JSON.parse(readFileSync(p, "utf8")) as SurfaceLines;
    return {
      memory: typeof parsed.memory === "string" ? parsed.memory : undefined,
      health: typeof parsed.health === "string" ? parsed.health : undefined,
    };
  } catch {
    return {};
  }
}

/** MemoryTurnStart hands the composed lines to the plugin here instead of the model. Best-effort. */
export function writeSurfaceLines(sessionId: string, lines: SurfaceLines): void {
  try {
    const p = memoryLinePath(sessionId);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify({ ...lines, ts: new Date().toISOString() }) + "\n", "utf8");
  } catch {
    /* a missing line degrades the draw, never the prompt */
  }
}
