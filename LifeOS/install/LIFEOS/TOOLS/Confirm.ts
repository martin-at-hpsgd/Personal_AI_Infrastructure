#!/usr/bin/env bun
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, openSync, closeSync } from "node:fs";
import { join, resolve } from "node:path";

export type Confirmation = { action: string; detail: string; amountUsd?: number; token?: string };
export type ConfirmationResult = { ok: true } | { ok: false; reason: string };
const stateDir = () => process.env.LIFEOS_CONFIRM_STATE_DIR ?? resolve(import.meta.dir, "../MEMORY/STATE/confirm");

/** Return a challenge for the principal to echo, never an assertion of approval.
 * The caller must obtain the echo from a trusted principal turn. This local bearer
 * token cannot authenticate chat provenance or defend against a caller with state access.
 * Include the complete immutable transaction (including price) in detail.
 */
export function issue(action: string, detail: string, ttlMs = 10 * 60_000, amountUsd?: number): string {
  if (!action.trim() || !detail.trim() || !Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > 10 * 60_000) throw new Error("Invalid confirmation challenge");
  if (amountUsd !== undefined && (!Number.isFinite(amountUsd) || amountUsd < 0)) throw new Error("Invalid confirmation amount");
  const id = randomBytes(32).toString("hex");
  mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
  writeFileSync(join(stateDir(), `${id}.json`), JSON.stringify({ nonce: id, action, detail, amountUsd, expiresAt: Date.now() + ttlMs }), { flag: "wx", mode: 0o600 });
  return id;
}

export function requireConfirmation({ action, detail, amountUsd, token }: Confirmation): ConfirmationResult {
  const refuse = (reason: string): ConfirmationResult => ({ ok: false, reason: `Confirmation refused: ${reason}` });
  if (!token) return refuse("missing principal confirmation token");
  if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)) return refuse("invalid confirmation token");
  if (amountUsd !== undefined && (!Number.isFinite(amountUsd) || amountUsd < 0)) return refuse("invalid amount");
  try {
    const record = JSON.parse(readFileSync(join(stateDir(), `${token}.json`), "utf8"));
    if (record.nonce !== token || record.action !== action || record.detail !== detail || record.amountUsd !== amountUsd) return refuse("action or detail mismatch");
    if (!Number.isFinite(record.expiresAt) || record.expiresAt <= Date.now()) return refuse("expired token");
    // Exclusive creation is the cross-process consumption boundary. Never delete
    // the marker: crashes and failed downstream operations also spend the token.
    const fd = openSync(join(stateDir(), `${token}.used`), "wx", 0o600);
    closeSync(fd);
    return { ok: true };
  } catch (error) {
    return refuse((error as NodeJS.ErrnoException).code === "EEXIST" ? "reused token" : "unknown token or unavailable confirmation state");
  }
}

export function probeConfirmation(): number {
  const result = requireConfirmation({ action: "probe", detail: "no external action" });
  if (!result.ok) console.error(result.reason);
  return result.ok ? 0 : 1;
}

if (import.meta.main) {
  if (process.argv.includes("--probe")) process.exit(probeConfirmation());
  const [command, action, detail, token] = process.argv.slice(2);
  if (command === "issue" && action && detail) console.log(issue(action, detail));
  else if (command === "confirm" && action && detail) {
    const result = requireConfirmation({ action, detail, token });
    if (!result.ok) console.error(result.reason);
    process.exit(result.ok ? 0 : 1);
  } else {
    console.error("Usage: Confirm.ts issue <action> <exact-detail> | confirm <action> <exact-detail> <principal-token> | --probe");
    process.exit(2);
  }
}
