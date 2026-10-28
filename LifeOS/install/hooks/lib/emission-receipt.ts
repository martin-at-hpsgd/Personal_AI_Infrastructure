/**
 * emission-receipt.ts — file-based channel for delivery acknowledgment.
 *
 * MemoryTurnStart writes the emissionId to a file when chunks are emitted.
 * LifeOSHooks reads this file and acknowledges delivery at the acceptance boundary.
 * This avoids needing to modify HookBridge (which may have peer edits).
 *
 * ISC-14: Idempotent receipts — acknowledging the same id multiple times is safe.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { resolve as pathResolve } from "node:path";

export interface EmissionFile {
  emissionId: string;
  createdAt: string;
}

export function getEmissionPath(sessionId: string, claudeDir: string): string {
  return pathResolve(claudeDir, "LIFEOS/MEMORY/STATE/memory-emit", `${sessionId.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
}

export function readEmission(sessionId: string, claudeDir: string): EmissionFile | null {
  try {
    const path = getEmissionPath(sessionId, claudeDir);
    if (!existsSync(path)) return null;
    const data = JSON.parse(readFileSync(path, "utf8")) as EmissionFile;
    return data && typeof data.emissionId === "string" ? data : null;
  } catch { return null; }
}

export function writeEmission(sessionId: string, claudeDir: string, data: EmissionFile): void {
  try {
    const path = getEmissionPath(sessionId, claudeDir);
    mkdirSync(pathResolve(claudeDir, "LIFEOS/MEMORY/STATE/memory-emit"), { recursive: true });
    writeFileSync(path, JSON.stringify(data), { mode: 0o600 });
  } catch { /* best-effort */ }
}

export function clearEmission(sessionId: string, claudeDir: string): void {
  try {
    const path = getEmissionPath(sessionId, claudeDir);
    if (existsSync(path)) unlinkSync(path);
  } catch { /* best-effort */ }
}
