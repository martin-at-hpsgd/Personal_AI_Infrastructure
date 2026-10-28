#!/usr/bin/env bun
/**
 * @version 1.2.0
 * Triage.ts — groups enriched Errata entries into clusters and files one
 * Upgrades record per cluster that recurs or hurt badly. Errata stays the
 * evidence store; Upgrades stays the action queue (ISA § Principles). Every
 * processed entry gets a terminal status (upgrade-filed or triaged) so a
 * re-run the same day is naturally a no-op: nothing left in new/enriched.
 *
 * Every report opens with `references: historical` frontmatter: it quotes skill
 * paths as they stood the day it was written, so ReferenceCheck skips it by that
 * per-file marker (never by its directory). `--mark-reports` adds the marker to
 * reports written before the change.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { invariant } from "../TOOLS/Invariant";
import { addUpgrade as addUpgradeReal, getUpgrade as getUpgradeReal, type UpgradeInput, type UpgradeRecord } from "../TOOLS/Upgrades";
import { ErrataStore, TENANT_SOURCES } from "./Store";
import type { Erratum } from "./Schema";
import { loadSources, skillRows, skillRowsMarkdown, type JoinSources } from "./OutputJoin";
import { readRuns } from "../TOOLS/OutputReconciler";

/** What the reconciler last measured: skills that delivered outputs with no receipt, and when it measured. */
export interface ReconcilerGaps { ts: string | null; gaps: string[] }

/** The newest reconciler trend line (reconciler-runs.jsonl): a skill with outputs and no receipts is a gap. Read-only; no rescan. */
export function latestReconcilerGaps(): ReconcilerGaps {
  const last = readRuns(1)[0];
  if (!last) return { ts: null, gaps: [] };
  const gaps = Object.entries(last.by_skill ?? {}).filter(([, v]) => v.outputs > 0 && v.receipted === 0).map(([k]) => k).sort();
  return { ts: last.ts, gaps };
}

export interface TriageOptions {
  /** Injected for tests; defaults to the real Upgrades.ts store. */
  addUpgrade?: (input: UpgradeInput) => { created: boolean; id: string; reason?: string };
  /** Injected for tests; used to detect linked upgrades that expired or were rejected (ISC-20). */
  getUpgrade?: (id: string) => Pick<UpgradeRecord, "status"> | null;
  /** Backfilled rows are evidence, not triage fuel (ISC-19); opt them in explicitly. */
  includeBackfill?: boolean;
  /** false: write the report and close entries as triaged, file nothing. The daily job passes false;
   *  Errata v4 is the one path into Upgrades (2026-09-28). */
  file?: boolean;
  now?: Date;
  /** Injected for tests; defaults to the live output ledger, receipts and run ledger (read-only). */
  joinSources?: JoinSources;
  /** Injected for tests; defaults to the newest line of the reconciler trend (ISC-41). */
  reconcilerGaps?: () => ReconcilerGaps;
}

export interface TriageResult {
  /** Distinct (system, class) clusters seen this run. */
  clusters: number;
  /** Upgrades records actually created this run (a resolved duplicate is not counted twice). */
  filed: number;
  /** Entries left in a singleton cluster below the filing bar, patched to status "triaged". */
  triaged: number;
  /** Entries whose linked upgrade had expired or been rejected, reverted to triaged (ISC-20). */
  reverted: number;
  reportPath: string;
  /** Skills the reconciler saw with outputs and no receipts, shown beside the complaint rows. */
  reconcilerGaps: string[];
}

/** The frontmatter every triage report opens with. ReferenceCheck reads `references: historical` per file. */
export function reportFrontmatter(day: string): string {
  return `---\nreferences: historical\ngenerated_by: LIFEOS/ERRATA/Triage.ts\ndate: ${day}\n---\n`;
}

const MARKER_LINE = /^references:\s*(["']?)historical\1\s*$/m;

/** Does this report already open with frontmatter carrying the marker? */
export function hasHistoricalMarker(md: string): boolean {
  if (!md.startsWith("---\n")) return false;
  const end = md.indexOf("\n---\n", 3);
  return end > 0 && MARKER_LINE.test(md.slice(4, end + 1));
}

/** The report text with the marker added; unchanged when it is already there. */
export function withHistoricalMarker(md: string, day: string): string {
  if (hasHistoricalMarker(md)) return md;
  if (md.startsWith("---\n") && md.indexOf("\n---\n", 3) > 0) return `---\nreferences: historical\n${md.slice(4)}`;
  return reportFrontmatter(day) + md;
}

/**
 * Backfill: add the marker to every triage-*.md under <dir>/reports that lacks it.
 * Only reports this writer generates (triage-YYYY-MM-DD.md) are touched; any other
 * file in the folder is left alone, so it stays subject to ReferenceCheck.
 */
export function markExistingReports(dir: string): { marked: string[]; already: number } {
  const reports = join(dir, "reports");
  const marked: string[] = [];
  let already = 0;
  if (!existsSync(reports)) return { marked, already };
  for (const name of readdirSync(reports).sort()) {
    const m = name.match(/^triage-(\d{4}-\d{2}-\d{2})\.md$/);
    if (!m) continue;
    const path = join(reports, name);
    const before = readFileSync(path, "utf8");
    if (hasHistoricalMarker(before)) { already++; continue; }
    const after = withHistoricalMarker(before, m[1]);
    invariant(after.endsWith(before.startsWith("---\n") ? before.slice(4) : before), `marking ${path} would change its body`);
    invariant(hasHistoricalMarker(after), `marking ${path} produced no marker`);
    writeFileSync(path, after);
    marked.push(name);
  }
  return { marked, already };
}

function reportPathFor(store: ErrataStore, now: Date): string {
  return join(store.dir, "reports", `triage-${now.toISOString().slice(0, 10)}.md`);
}

export function triage(store: ErrataStore, opts: TriageOptions = {}): TriageResult {
  const addUp = opts.addUpgrade ?? addUpgradeReal;
  const getUp = opts.getUpgrade ?? getUpgradeReal;
  const now = opts.now ?? new Date();

  // ISC-20: a dead upgrade never reads as an answered erratum.
  let reverted = 0;
  for (const e of store.list({ status: "upgrade-filed" })) {
    const id = e.links.upgrade_id; if (!id) continue;
    const u = getUp(id);
    if (u && (u.status === "expired" || u.status === "rejected")) {
      store.patch(e.id, { status: "triaged", tags: [...new Set([...e.tags, "upgrade-expired"])] });
      reverted++;
    }
  }

  // Only entries still awaiting triage. Once patched below (either upgrade-filed
  // or triaged) they drop out of this filter, which is what makes a same-day
  // re-run file zero: there is nothing left to group.
  // ISC-19 / ISC-21: backfill rows stay out unless opted in; reporter_right is tallied, never a filter.
  const rows = store.list({}).filter((e) => e.enrichment !== null && (e.status === "new" || e.status === "enriched") && (opts.includeBackfill || e.source !== "backfill"));

  const groups = new Map<string, Erratum[]>();
  for (const e of rows) {
    const key = `${e.system}::${e.enrichment!.class}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(e);
  }

  const day = now.toISOString().slice(0, 10);
  const lines: string[] = [`# Errata triage — ${day}`, ""];
  let filed = 0;
  let triaged = 0;

  for (const [key, entries] of groups) {
    const [system, cls] = key.split("::");
    const anyFurious = entries.some((e) => e.enrichment!.how_upset === 3);
    const qualifies = entries.length >= 2 || anyFurious;

    const tally = { true: 0, false: 0, null: 0 };
    for (const e of entries) {
      const r = e.enrichment!.reporter_right;
      tally[r === null ? "null" : (String(r) as "true" | "false")]++;
    }

    lines.push(`## ${system} — ${cls} (${entries.length} entr${entries.length === 1 ? "y" : "ies"})`);
    lines.push(`reporter_right: true=${tally.true} false=${tally.false} null=${tally.null}`);
    for (const e of entries) {
      // Tenant rows (app customers and users) live outside git; the report sits in the git-backed ledger, so it names
      // them by id only. Their words stay in the tenant ledger.
      if (TENANT_SOURCES.has(e.source)) {
        lines.push(`- **${e.id}** (how_upset ${e.enrichment!.how_upset}): tenant report, text kept in the tenant ledger`);
        continue;
      }
      lines.push(`- **${e.id}** (how_upset ${e.enrichment!.how_upset}): "${e.complaint}"`);
      lines.push(`  proposed fix: ${e.enrichment!.proposed_fix}`);
    }
    lines.push("");

    if (!qualifies || opts.file === false) {
      for (const e of entries) store.patch(e.id, { status: "triaged" });
      triaged += entries.length;
      continue;
    }

    const meanConfidence = entries.reduce((a, e) => a + e.enrichment!.confidence, 0) / entries.length;
    // The upgrade record is stored in the git-backed USER tree too, so neither its claim nor its target surface takes
    // text from a tenant row.
    const componentGuess = entries.filter((e) => !TENANT_SOURCES.has(e.source)).map((e) => e.context.component).find((c): c is string => !!c);
    const own = entries.find((e) => !TENANT_SOURCES.has(e.source));
    const claim = own
      ? own.enrichment!.proposed_fix.trim().slice(0, 300)
      : `Recurring ${cls} reports from app tenants in ${system}; the reports are in the tenant ledger under the evidence ids`;
    invariant(claim.length > 0, `triage cluster ${key} produced an empty claim`);

    const res = addUp({
      claim,
      source: "errata",
      current_state: `${cls} × ${entries.length} in ${system}`,
      evidence: entries.map((e) => e.id),
      confidence: meanConfidence,
      target_surface: componentGuess,
    });

    if (res.created || res.reason === "duplicate") {
      for (const e of entries) store.patch(e.id, { links: { ...e.links, upgrade_id: res.id }, status: "upgrade-filed" });
      if (res.created) filed++;
    } else {
      console.error(`[Triage] ${key}: addUpgrade refused (${res.reason ?? "unknown"}); leaving entries unpatched`);
    }
  }

  // assay-everywhere S10: per-skill delivered / complaints / false passes. Read-only; never breaks triage.
  try {
    const md = skillRowsMarkdown(skillRows(store.list({}), opts.joinSources ?? loadSources()));
    if (md) lines.push(md);
  } catch (e) { console.error(`[Triage] per-skill rows skipped: ${e instanceof Error ? e.message : e}`); }

  // assay-everywhere ISC-41: the reconciler's gaps (outputs, no receipts) sit beside the complaint rows. A skill nobody has complained about still shows up here.
  let reconcilerGaps: string[] = [];
  try {
    const g = (opts.reconcilerGaps ?? latestReconcilerGaps)();
    reconcilerGaps = g.gaps;
    lines.push("", "## Reconciler gaps (skills with outputs and no receipts)", "");
    if (g.ts === null) lines.push("no reconciler run recorded yet");
    else if (g.gaps.length === 0) lines.push(`none in the reconciler run at ${g.ts.slice(0, 16)}Z`);
    else for (const k of g.gaps) lines.push(`- ${k}`);
  } catch (e) { console.error(`[Triage] reconciler gaps skipped: ${e instanceof Error ? e.message : e}`); }

  const reportPath = reportPathFor(store, now);
  mkdirSync(join(store.dir, "reports"), { recursive: true });
  const md = reportFrontmatter(day) + lines.join("\n") + "\n";
  invariant(hasHistoricalMarker(md), `triage report for ${day} is missing its references: historical marker`);
  writeFileSync(reportPath, md);
  invariant(existsSync(reportPath), `triage report failed to write: ${reportPath}`);

  return { clusters: groups.size, filed, triaged, reverted, reportPath, reconcilerGaps };
}

if (import.meta.main) {
  const store = new ErrataStore();
  if (process.argv.includes("--mark-reports")) {
    console.log(JSON.stringify(markExistingReports(store.dir)));
    process.exit(0);
  }
  const result = triage(store);
  console.log(JSON.stringify(result));
  process.exit(0);
}
