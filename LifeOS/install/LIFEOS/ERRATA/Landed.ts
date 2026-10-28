/**
 * @version 1.0.0
 * Landed.ts — the weekly impact read for assay-miss upgrades that landed (assay-everywhere S3).
 *
 * An assay-miss Upgrades item is filed when a passing receipt let an output through and the principal then called it wrong
 * (OutputJoin.fileAssayMissUpgrades). Once such an item is applied or verified, the question is whether the skill's complaint
 * rate fell. This runs `impact()` for each one: the skill comes from the output the item cites as evidence, the `since` date from
 * the note stamped when the item moved to applied. Read-only; an item with no resolvable skill or landing date is reported as
 * skipped with the reason, never dropped silently.
 */
import { listUpgrades, type UpgradeRecord } from "../TOOLS/Upgrades";
import { complaintRows, impact, skillOf, type Impact, type JoinSources } from "./OutputJoin";
import type { ErrataStore } from "./Store";

export interface LandedImpact { upgrade_id: string; status: string; landed: string; impact: Impact }
export interface LandedSkip { upgrade_id: string; reason: string }
export interface LandedReport { checked: number; impacts: LandedImpact[]; skipped: LandedSkip[] }

const APPLIED_NOTE = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z) — applied\b/;

/** The ISO time of the note that recorded the move to applied (the last one when several), or null. */
export function landedAt(r: Pick<UpgradeRecord, "notes">): string | null {
  let at: string | null = null;
  for (const n of r.notes ?? []) { const m = APPLIED_NOTE.exec(n); if (m) at = m[1]!; }
  return at;
}

export function landedImpacts(store: ErrataStore, src: JoinSources, o: { days?: number; now?: Date; upgrades?: UpgradeRecord[] } = {}): LandedReport {
  const days = o.days ?? 14;
  const now = o.now ?? new Date();
  const landed = (o.upgrades ?? [...listUpgrades({ source: "assay-miss", status: "applied" }), ...listUpgrades({ source: "assay-miss", status: "verified" })]).filter((u) => u.source === "assay-miss");
  const byOutput = new Map(src.outputs.map((l) => [l.output_id, l]));
  const rows = complaintRows(store);
  const report: LandedReport = { checked: landed.length, impacts: [], skipped: [] };
  for (const u of landed) {
    const since = landedAt(u);
    if (!since) { report.skipped.push({ upgrade_id: u.id, reason: "no applied note with a timestamp" }); continue; }
    const out = (u.evidence ?? []).map((id) => byOutput.get(id)).find((l) => l !== undefined);
    if (!out) { report.skipped.push({ upgrade_id: u.id, reason: "no cited output found in the output ledger" }); continue; }
    report.impacts.push({ upgrade_id: u.id, status: u.status, landed: since, impact: impact(rows, src, skillOf(out, src), new Date(since), days, now) });
  }
  return report;
}

export function formatLanded(r: LandedReport): string {
  const L = [`assay-miss upgrades that landed: ${r.checked} (${r.impacts.length} measured, ${r.skipped.length} skipped)`];
  for (const i of r.impacts) L.push(`- ${i.upgrade_id} (${i.status}, landed ${i.landed.slice(0, 10)}) ${i.impact.skill}: ${i.impact.verdict}${i.impact.delta === null ? "" : ` (${(i.impact.delta * 100).toFixed(1)} points)`}`);
  for (const s of r.skipped) L.push(`- ${s.upgrade_id}: skipped, ${s.reason}`);
  return L.join("\n");
}
