#!/usr/bin/env bun
/**
 * ObservabilityPrune — keep MEMORY/OBSERVABILITY/*.jsonl inside CortexHealth's caps.
 *
 * Rows older than --days (default 30) move to OBSERVABILITY/ARCHIVE/<name>.before-<date>.jsonl.gz;
 * rows without a parseable ts/timestamp are kept. Dry-run by default; --apply writes.
 * bunker-runs.jsonl keeps 7 days instead and its per-revision close files compact.
 * The 🧠 "Prune memory observability logs" action resolves here.
 *
 *   bun LIFEOS/TOOLS/ObservabilityPrune.ts            # report
 *   bun LIFEOS/TOOLS/ObservabilityPrune.ts --apply    # write
 *   add --json for one machine-readable summary line (the nightly workflow step)
 */
import { existsSync, readdirSync, statSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { invariant } from "./Invariant";
import { lifeosPath } from "./Paths";

// The race-safe window pruner lives with the Bunker harness, which a public install does not ship. It loads by a
// computed path, and without it this tool reports that nothing was pruned and leaves every log untouched.
type PruneReport = { archivedRows: number; archivedBytes: number; compacted: number; backedOff: string[] };
type Ledger = {
  pruneLedger: (p: string, o: { days: number; apply: boolean; archiveDir: string }) => PruneReport;
  pruneWindow: (p: string, o: { cutoff: number; apply: boolean; archiveDir: string }) => { archivedRows: number; archivedBytes: number };
};
function loadLedger(): Ledger | null {
  const path = join(import.meta.dir, "..", "PULSE", "Bunker", "src", "ledger.ts");
  return existsSync(path) ? (require(path) as Ledger) : null;
}
const ledger = loadLedger();

const ROOT = realpathSync(lifeosPath("MEMORY", "OBSERVABILITY"));
const args = new Set(process.argv.slice(2));
const apply = args.has("--apply");
const daysArg = process.argv.find((a) => a.startsWith("--days="));
const days = daysArg ? Number(daysArg.split("=")[1]) : 30;
invariant(Number.isFinite(days) && days > 0, `bad --days: ${daysArg}`);
const cutoff = Date.now() - days * 86_400_000;
const stamp = new Date(cutoff).toISOString().slice(0, 10);
const archiveDir = join(ROOT, "ARCHIVE");
const BUNKER_LEDGER = "bunker-runs.jsonl";
const BUNKER_DAYS = 7;

let freed = 0;
const report: string[] = [];
// Every rewrite goes through Bunker's race-safe window: these logs take appends
// while the prune runs, and an in-place overwrite dropped whatever landed
// between read and write.
if (!ledger) report.push("race-safe pruner not installed: no log was pruned");
for (const f of (ledger ? readdirSync(ROOT) : []).filter((n) => n.endsWith(".jsonl")).sort()) {
  const p = join(ROOT, f);
  if (statSync(p).size < 1_000_000) continue;
  if (!ledger) continue; // unreachable: the list is empty without it
  if (f === BUNKER_LEDGER) {
    // The run ledger keeps a shorter full-history window; close evidence lives
    // in its per-revision files, which only ever compact (Bunker ISC-37/37b).
    const r = ledger.pruneLedger(p, { days: BUNKER_DAYS, apply, archiveDir });
    freed += r.archivedBytes;
    report.push(`${f}: archive ${r.archivedRows} rows (${(r.archivedBytes / 1048576).toFixed(1)} MiB, keep ${BUNKER_DAYS}d)${apply ? `, ${r.compacted} revision files compacted` : ""}${r.backedOff.length ? `, backed off: ${r.backedOff.join(" ")}` : ""}`);
    continue;
  }
  const r = ledger.pruneWindow(p, { cutoff, apply, archiveDir });
  if (r.archivedRows === 0) continue;
  freed += r.archivedBytes;
  report.push(`${f}: archive ${r.archivedRows} rows (${(r.archivedBytes / 1048576).toFixed(1)} MiB)`);
}
if (args.has("--json")) {
  console.log(JSON.stringify({ applied: apply, keep_days: days, bunker_keep_days: BUNKER_DAYS, cutoff: stamp, freed_bytes: freed, files: report }));
} else {
  console.log(`ObservabilityPrune (${apply ? "APPLIED" : "dry-run"}, keep ${days}d, cutoff ${stamp})`);
  for (const r of report) console.log("  " + r);
  console.log(`  ${(freed / 1048576).toFixed(1)} MiB ${apply ? "moved to ARCHIVE/" : "would move to ARCHIVE/"}`);
}
