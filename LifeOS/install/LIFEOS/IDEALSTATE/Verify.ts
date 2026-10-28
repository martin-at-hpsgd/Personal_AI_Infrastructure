/**
 * Verify — the reconcile-side check that an applied move actually moved its target.
 *
 * An Upgrades record serves an ideal-state row when its claim, evidence, notes or target
 * surface name the row's IS- id. VERIFY_AFTER_DAYS after the record was applied, reconcile
 * compares the row's reading from before the apply with its latest reading since, and records
 * one verdict per record and row in the loop's state dir (verifications.jsonl):
 *
 *   closer       the reading moved toward the target
 *   not-closer   it held or moved away
 *   unreadable   no reading before the apply, none since, or the row reads nothing today
 *
 * This never changes an Upgrades record: moving one to `verified` stays a decision for the
 * principal or the tool that applied it. Pure; reconcile passes the stores in and writes the result.
 *
 * @version 1.0.0
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ReconcileReport } from "./Reconcile";

export const VERIFY_AFTER_DAYS = 14;
const DAY = 86_400_000;
const IS_ID = /\bIS-\d{4,}\b/g;

/** The fields of an Upgrades record this reads (LIFEOS/TOOLS/Upgrades.ts UpgradeRecord). */
export type UpgradeLike = { id: string; status: string; claim: string; evidence?: string[]; notes?: string[]; target_surface?: string; recommendation?: string };
export type Measurement = { ts: string; key: string; value: number; kind?: string };
export type Verdict = "closer" | "not-closer" | "unreadable";
export type Verification = { upgrade_id: string; row: string; applied_at: string; checked_at: string; before: number | null; after: number | null; target: number | null; verdict: Verdict };

/** The IS- ids an Upgrades record names, in order, each once. */
export function servedRows(u: UpgradeLike): string[] {
  const text = [u.claim, u.target_surface ?? "", u.recommendation ?? "", ...(u.evidence ?? []), ...(u.notes ?? [])].join("\n");
  return [...new Set(text.match(IS_ID) ?? [])];
}

/** When the record was applied, from its `<iso> — applied` note. */
export function appliedAt(u: UpgradeLike): string | null {
  for (const n of u.notes ?? []) { const m = n.match(/^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\s+—\s+applied\b/); if (m) return m[1]!; }
  return null;
}

/** Every applied record serving a bound row, due and not yet checked, with its verdict. */
export function verifyApplied(o: { now: Date; upgrades: UpgradeLike[]; report: ReconcileReport; history: Measurement[]; done: Verification[] }): Verification[] {
  const done = new Set(o.done.map((v) => `${v.upgrade_id}|${v.row}`));
  const rows = new Map(o.report.rows.map((r) => [r.key, r]));
  const out: Verification[] = [];
  for (const u of o.upgrades) {
    if (u.status !== "applied" && u.status !== "verified") continue;
    const at = appliedAt(u);
    if (!at || o.now.getTime() - Date.parse(at) < VERIFY_AFTER_DAYS * DAY) continue;
    for (const id of servedRows(u)) {
      const row = rows.get(id);
      if (!row || done.has(`${u.id}|${id}`)) continue; // serves no bound row, or already checked
      const mine = o.history.filter((h) => h.key === id).sort((a, b) => a.ts.localeCompare(b.ts));
      const before = mine.filter((h) => h.ts <= at).at(-1)?.value ?? null;
      const after = row.state === "unreadable" ? null : (mine.filter((h) => h.ts > at && Date.parse(h.ts) <= o.now.getTime()).at(-1)?.value ?? null);
      const target = row.target ?? null;
      let verdict: Verdict = "unreadable";
      if (before !== null && after !== null && target !== null) verdict = Math.abs(target - after) < Math.abs(target - before) ? "closer" : "not-closer";
      out.push({ upgrade_id: u.id, row: id, applied_at: at, checked_at: o.now.toISOString(), before, after, target, verdict });
    }
  }
  return out;
}

/**
 * The Upgrades records, read-only. Under `bun test` it reads only a store a test names
 * (LIFEOS_UPGRADES_DIR), so no test ever depends on the live queue.
 */
export function liveUpgrades(): UpgradeLike[] {
  const dir = process.env.LIFEOS_UPGRADES_DIR;
  if (process.env.NODE_ENV === "test" && !dir) return [];
  if (dir && !existsSync(join(dir, "records"))) return [];
  const { listUpgrades } = require("../TOOLS/Upgrades") as { listUpgrades: () => unknown[] }; // loaded only when needed: reconcile stays light without it
  return listUpgrades() as unknown as UpgradeLike[];
}
