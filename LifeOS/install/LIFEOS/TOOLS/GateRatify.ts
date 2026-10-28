#!/usr/bin/env bun
/**
 * @version 1.1.0
 * 1.1.0 (2026-10-13, LOSIntegrity security rank 18): spending a row is part of the check.
 *   isRatified() returns a row only after its consume marker is durably appended and this
 *   caller won the spend (the first consume for that row in file order), so a failed write
 *   denies instead of leaving the row reusable, and two concurrent callers cannot both spend
 *   it. consumeRatification() is idempotent and throws when it cannot persist.
 * GateRatify.ts — write a principal-ratification row authorizing ONE gate-class
 * hook removal or de-fanging within the next 24h.
 *
 * No hook consumes a row today: no LifeOS hook reads a tool call to decide
 * whether it may run, and native permission rules hold the boundaries
 * (LIFEOS/DOCUMENTATION/Hooks/HookSystem.md § Native enforcement). The rows
 * still record intent, and isRatified() spends one for any caller that asks.
 *
 * Usage:
 *   bun LIFEOS/TOOLS/GateRatify.ts <HookFileName> "<reason>"
 *   bun LIFEOS/TOOLS/GateRatify.ts --list          # show unexpired rows
 *
 * The row states intent; it is not itself an approval workflow. Writing one is
 * a deliberate act the principal sees in the ⚙️ SYSTEM line and git history.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, basename } from "node:path";
import { invariant, InvariantViolation } from "./Invariant";
import { lifeosPath } from "./Paths"; // public issue #1974 @sabo961, PR #1918 @PigLardLord

const STORE = lifeosPath("MEMORY", "STATE", "gate-ratifications.jsonl");
export const RATIFICATION_TTL_MS = 24 * 3600_000;

export interface RatificationRow {
  ts: string;
  hook: string;   // basename, e.g. "FormatGate.hook.ts"
  reason: string;
  /** "consume" rows mark an authorization as spent (single-use, Astra P-note 2026-08-17). */
  type?: "ratify" | "consume";
  consumed_ref?: string; // ts of the ratify row this consume spends
  /** Unique per spend attempt; the first consume row for a ref, in file order, is the spend that won. */
  nonce?: string;
}

export function readRatifications(): RatificationRow[] {
  try {
    if (!existsSync(STORE)) return [];
    return readFileSync(STORE, "utf-8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => { try { return JSON.parse(l) as RatificationRow; } catch { return null; } })
      .filter((r): r is RatificationRow => !!r?.ts && !!r?.hook);
  } catch {
    return [];
  }
}

/**
 * A ratify row is live only when its timestamp parses to a finite instant and its age is
 * between zero and the TTL. A malformed ts (NaN age) or a future ts (negative age) is never
 * live: both would otherwise slip past an `age >= TTL` test and stretch the 24h lifetime.
 */
export function ratificationAlive(ts: unknown, now = Date.now()): boolean {
  if (typeof ts !== "string") return false;
  const at = Date.parse(ts);
  if (!Number.isFinite(at)) return false;
  const age = now - at;
  return age >= 0 && age < RATIFICATION_TTL_MS;
}

const isSpendOf = (r: RatificationRow, row: RatificationRow): boolean =>
  r.type === "consume" && r.hook === row.hook && r.consumed_ref === row.ts;

/**
 * Append a consume marker for `row`, then read the store back: this attempt won only when its
 * marker is the FIRST consume for that row in file order. Appends are O_APPEND, so two racing
 * spenders are ordered by the file itself and exactly one of them wins. Throws when the marker
 * cannot be written; returns false when the read-back does not show this attempt first (it
 * lost the race, or the store could not be read back, which never counts as a win).
 */
function spend(row: RatificationRow): boolean {
  invariant(row.type !== "consume" && !!row.ts && !!row.hook, `only a ratify row with ts and hook can be spent (got ${JSON.stringify(row)})`);
  const nonce = randomUUID();
  const marker: RatificationRow = { ts: new Date().toISOString(), hook: row.hook, reason: "consumed", type: "consume", consumed_ref: row.ts, nonce };
  mkdirSync(dirname(STORE), { recursive: true });
  appendFileSync(STORE, JSON.stringify(marker) + "\n");
  return readRatifications().find((r) => isSpendOf(r, row))?.nonce === nonce;
}

/**
 * Take an unexpired, UNSPENT ratification row for this hook file, spending it in the same step.
 * Single-use (2026-08-17, Max second-look finding: one row must never authorize unlimited
 * removals for 24h). The row comes back only after its consume marker is persisted and this
 * caller won the spend, so an authorization never outlives a failed write (LOSIntegrity rank 18,
 * 2026-10-13: the old fail-open append left the row reusable for its whole TTL, and the guard
 * that calls this fails open on a throw). A write failure returns null: not authorized.
 */
export function isRatified(hookFile: string, now = Date.now()): RatificationRow | null {
  const base = basename(hookFile);
  const rows = readRatifications();
  const spent = new Set(rows.filter((r) => r.type === "consume" && r.hook === base).map((r) => r.consumed_ref));
  for (const row of [...rows].reverse()) {
    if (row.type === "consume") continue;
    if (row.hook !== base || spent.has(row.ts) || !ratificationAlive(row.ts, now)) continue;
    let won: boolean;
    try { won = spend(row); } catch (err) {
      if (err instanceof InvariantViolation) throw err;
      return null; // the spend cannot be persisted: not authorized
    }
    if (won) return row;
    // Another caller spent this row first; an older unspent row may still be live.
  }
  return null;
}

/**
 * Spend a ratification row. Idempotent: a row isRatified() already spent is left as it is.
 * Throws when the consume marker cannot be persisted, so no caller mistakes an unsaved spend
 * for a saved one.
 */
export function consumeRatification(row: RatificationRow): void {
  if (readRatifications().some((r) => isSpendOf(r, row))) return;
  spend(row);
}

export function ratify(hookFile: string, reason: string): RatificationRow {
  const row: RatificationRow = { ts: new Date().toISOString(), hook: basename(hookFile), reason };
  mkdirSync(dirname(STORE), { recursive: true });
  appendFileSync(STORE, JSON.stringify(row) + "\n");
  return row;
}

if (import.meta.main) {
  const [a, b] = process.argv.slice(2);
  if (a === "--list") {
    const now = Date.now();
    const live = readRatifications().filter((r) => r.type !== "consume" && ratificationAlive(r.ts, now));
    console.log(live.length ? live.map((r) => `${r.ts}  ${r.hook}  ${r.reason}`).join("\n") : "(no unexpired ratifications)");
    process.exit(0);
  }
  if (!a || !b) {
    console.log('usage: GateRatify.ts <HookFileName> "<reason>"  |  --list');
    process.exit(1);
  }
  const row = ratify(a, b);
  console.log(JSON.stringify(row));
}
