/**
 * Scoreboard — whether the delta loop is working, in two numbers.
 *
 *   targets bound       ideal-state target rows with a live measurement, from the latest reconcile
 *   closures verified   Upgrades records marked `verified` that serve a target row, counted only when
 *                       the row is ratified (a target row in the ideal-state files, never a want or an
 *                       open proposal), bound, read fresh by the latest reconcile, and measured for a
 *                       reason he approved (current-ideal delta ISC-58, ISC-78)
 *
 * Records that serve a row but fail one of those tests are listed with the reason, so a closure
 * that did not count is visible rather than silently dropped. The reconcile-side 14-day checks
 * (Verify.ts) are tallied beside it. Pure and read-only.
 *
 * @version 1.0.0
 */
import type { Rec } from "./Recommend";
import type { ReconcileReport } from "./Reconcile";
import { rowRef, type Row } from "./Rows";
import { measurementReason } from "./Tiers";
import { servedRows, type UpgradeLike, type Verification } from "./Verify";

/** A reconcile older than this is not a fresh source: closures measured by it do not count. */
export const FRESH_HOURS = 48;

export type Scoreboard = {
  generated_at: string;
  reconcile_at: string | null;
  targets_bound: number;
  targets_total: number;
  closures_verified: number;
  closures: Array<{ upgrade_id: string; row: string }>;
  not_counted: Array<{ upgrade_id: string; row: string; why: string }>;
  checks: { closer: number; not_closer: number; unreadable: number };
};

export function scoreboard(o: { now: Date; report: ReconcileReport | null; rows: Row[]; upgrades: UpgradeLike[]; recs: Rec[]; verifications: Verification[] }): Scoreboard {
  const targets = new Map(o.rows.filter((r) => r.type === "target").map((r) => [rowRef(r), r]));
  const fresh = !!o.report && o.now.getTime() - Date.parse(o.report.generated_at) <= FRESH_HOURS * 3_600_000;
  const read = new Map((o.report?.rows ?? []).map((r) => [r.key, r]));
  const closures: Scoreboard["closures"] = [], not_counted: Scoreboard["not_counted"] = [];
  for (const u of o.upgrades.filter((x) => x.status === "verified")) {
    for (const id of servedRows(u)) {
      const row = targets.get(id);
      const why = !row ? "not a ratified target row"
        : !row.measure ? "its target is not measured"
        : !fresh ? `the latest reconcile is not fresh (older than ${FRESH_HOURS}h)`
        : !read.has(id) || read.get(id)!.state === "unreadable" ? "its measurement did not read on the latest reconcile"
        : (() => { const r = measurementReason(o.recs, row); return r.ok ? null : r.why; })();
      if (why) not_counted.push({ upgrade_id: u.id, row: id, why }); else closures.push({ upgrade_id: u.id, row: id });
    }
  }
  return {
    generated_at: o.now.toISOString(),
    reconcile_at: o.report?.generated_at ?? null,
    targets_bound: o.report?.bound ?? 0,
    targets_total: o.report ? o.report.bound + o.report.unbound_targets : targets.size,
    closures_verified: closures.length,
    closures,
    not_counted,
    checks: {
      closer: o.verifications.filter((v) => v.verdict === "closer").length,
      not_closer: o.verifications.filter((v) => v.verdict === "not-closer").length,
      unreadable: o.verifications.filter((v) => v.verdict === "unreadable").length,
    },
  };
}
