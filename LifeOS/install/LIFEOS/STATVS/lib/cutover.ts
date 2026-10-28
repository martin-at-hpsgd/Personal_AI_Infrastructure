/**
 * The STATVS cutover flag (migration design §3.0): USER/STATVS/cutover.json, today
 * `{ "dual_write": false }`. While dual_write is false the event writer only appends to
 * Vigil's legacy outbox; true makes it also append to the record.
 *
 * Read-only and fail-inert: a missing, unreadable or malformed file, or any value other
 * than the literal `true`, reads as dual_write false. The file is read on every call, so
 * a flip reaches short-lived hooks at once and long-lived processes on their next read.
 *
 * Tests (ISC-189): under `bun test` (NODE_ENV=test) the live file is ignored and the flag
 * reads false, unless the test names a file through STATVS_CUTOVER_FILE. Outside tests
 * STATVS_CUTOVER_FILE also overrides the path.
 *
 * @version 1.0.0
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { lifeosPath } from "../../TOOLS/Paths";

export interface Cutover {
  dual_write: boolean;
}

const INERT: Cutover = { dual_write: false };

/** The cutover file this process reads, or null under `bun test` when no test named one. */
export function cutoverPath(): string | null {
  const named = process.env.STATVS_CUTOVER_FILE;
  if (named) return resolve(named);
  if (process.env.NODE_ENV === "test") return null;
  return lifeosPath("USER", "STATVS", "cutover.json");
}

/** The current cutover state; anything but a readable object with `dual_write: true` is inert. */
export function readCutover(): Cutover {
  const path = cutoverPath();
  if (!path) return { ...INERT };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { ...INERT };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ...INERT };
  return { dual_write: (parsed as { dual_write?: unknown }).dual_write === true };
}

/** True only while the cutover file says `"dual_write": true`. */
export function dualWrite(): boolean {
  return readCutover().dual_write;
}
