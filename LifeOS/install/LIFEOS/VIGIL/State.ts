/** Vigil local state paths and guarded JSON writes. @version 0.1.0 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { invariant } from "../TOOLS/Invariant";

/** Under `bun test` with no VIGIL_STATE_DIR the state is a per-process temp dir, so a test can never write the real outbox. */
export const stateDir = () => process.env.VIGIL_STATE_DIR || (process.env.NODE_ENV === "test" ? join(tmpdir(), `lifeos-vigil-state-test-${process.pid}`) : join(homedir(), ".local/state/lifeos/vigil"));
export const statePath = (...parts: string[]) => join(stateDir(), ...parts);
export function readJson<T>(path: string, fallback: T): T { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; } }
export function writeJson(path: string, value: unknown): void { const body = JSON.stringify(value, null, 2) + "\n"; invariant(body.length > 2, "state JSON is nonempty"); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, body); }
export function appendJson(path: string, value: unknown): void { const body = JSON.stringify(value); invariant(!body.includes("\n"), "JSONL record is one line"); mkdirSync(dirname(path), { recursive: true }); appendFileSync(path, body + "\n"); }
