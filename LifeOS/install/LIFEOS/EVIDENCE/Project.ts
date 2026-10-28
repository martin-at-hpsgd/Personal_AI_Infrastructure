#!/usr/bin/env bun
/**
 * @version 1.0.0
 * Project.ts — the evidence projector CLI.
 *
 *   bun LIFEOS/EVIDENCE/Project.ts build [--since YYYY-MM-DD]
 *   bun LIFEOS/EVIDENCE/Project.ts query by-model|by-skill|compliance [--since D] [--until D] [--origin O] [--json]
 *   bun LIFEOS/EVIDENCE/Project.ts query outcomes --by model|skill|lane_match|think_match [--since D] [--until D] [--json]
  bun LIFEOS/EVIDENCE/Project.ts query experiment [--since D] [--until D] [--json]
 *   bun LIFEOS/EVIDENCE/Project.ts query experiment [--since D] [--until D] [--json]
 *   bun LIFEOS/EVIDENCE/Project.ts label [--eval] [--json]
 *   bun LIFEOS/EVIDENCE/Project.ts trigger [--dry-run] [--max N] [--json]
 *   bun LIFEOS/EVIDENCE/Project.ts recommend [--dry-run] [--json]
 *
 * label votes every human turn with the labeling functions in Label.ts, fits Dawid–Skene, writes one
 * ds-v1 score per turn, and picks the trigger cut on the Errata v4 gold set (--gold-dir overrides).
 * --eval prints gold and holdout AUC beside every single function. trigger files confident misses
 * into Errata as source detected, at most 10 per run; --dry-run prints them and appends nothing.
 *
 * build streams the harness transcripts and the router decision log into
 * LIFEOS/MEMORY/EVIDENCE/evidence.sqlite and prints a JSON summary. The index is derived: delete it and
 * build again. Overrides for tests and dry runs: --db, --projects, --router, --errata-dir.
 * No network access of any kind.
 */
import { join } from "path";
import { getClaudeDir } from "../TOOLS/Paths";
import { build, openDb } from "./Store";
import { recommend } from "./Recommend";
import { byModel, bySkill, compliance, experiment, outcomes, type Report, type Compliance, type Experiment, type Outcomes, type OutcomeGroup } from "./Queries";
import { label, type LabelSummary } from "./Label";
import { MAX_PER_RUN, trigger } from "./Trigger";

/** 2026-07-01 (was 2026-09-19): the Errata v4 gold and holdout exchanges start 2026-07-03, and the label eval needs their turns. */
export const DEFAULT_SINCE = "2026-07-01";

const USAGE = `usage:
  bun LIFEOS/EVIDENCE/Project.ts build [--since YYYY-MM-DD]
  bun LIFEOS/EVIDENCE/Project.ts query by-model|by-skill|compliance [--since D] [--until D] [--origin human|peer|task|headless|test] [--json]
  bun LIFEOS/EVIDENCE/Project.ts query outcomes --by model|skill|lane_match|think_match [--since D] [--until D] [--json]
  bun LIFEOS/EVIDENCE/Project.ts query experiment [--since D] [--until D] [--json]
  bun LIFEOS/EVIDENCE/Project.ts label [--eval] [--json]
  bun LIFEOS/EVIDENCE/Project.ts trigger [--dry-run] [--max N] [--json]
  bun LIFEOS/EVIDENCE/Project.ts recommend [--dry-run] [--json]`;

function flags(argv: string[]): Map<string, string | true> {
  const out = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) { out.set(a.slice(2), next); i++; } else out.set(a.slice(2), true);
  }
  return out;
}

const strFlag = (f: Map<string, string | true>, k: string): string | undefined => { const v = f.get(k); return typeof v === "string" ? v : undefined; };

function table(r: Report, label: string): string {
  const lines = [
    `${label} — window ${r.window.since.slice(0, 10)} .. ${r.window.until.slice(0, 10)}`,
    `human turns ${r.human_turns} · errata in window ${r.errata_in_window} · complaints linked ${r.complaints_total} · unlinked ${r.complaints_unlinked}`,
    `join: ${Object.entries(r.join).map(([k, v]) => `${k}=${v}`).join(" ") || "none"}`,
    "",
    `${"key".padEnd(36)} ${"human_turns".padStart(11)} ${"complaints".padStart(10)} ${"per_100".padStart(8)}`,
  ];
  for (const x of r.rows) lines.push(`${x.key.slice(0, 36).padEnd(36)} ${String(x.human_turns).padStart(11)} ${String(x.complaints).padStart(10)} ${(x.complaints_per_100 === null ? "-" : x.complaints_per_100.toFixed(2)).padStart(8)}`);
  return lines.join("\n");
}

function complianceTable(c: Compliance): string {
  const lines = [
    `compliance — window ${c.window.since.slice(0, 10)} .. ${c.window.until.slice(0, 10)} · turns ${c.turns}`,
    `router join: ${Object.entries(c.joined).map(([k, v]) => `${k}=${v}`).join(" ")}`,
    "",
    `${"decision point".padEnd(16)} ${"with_pick".padStart(9)} ${"matched".padStart(8)} ${"rate%".padStart(6)}  by join`,
  ];
  for (const p of c.points) {
    const bj = Object.entries(p.by_join).map(([k, v]) => `${k} ${v.matched}/${v.with_pick}`).join(", ");
    lines.push(`${p.point.padEnd(16)} ${String(p.with_pick).padStart(9)} ${String(p.matched).padStart(8)} ${(p.rate === null ? "-" : p.rate.toFixed(1)).padStart(6)}  ${bj || p.note || ""}`);
    for (const m of p.top_mismatches ?? []) lines.push(`${"".padEnd(18)}miss: picked ${m.pick} -> ran ${m.actual} (${m.n})`);
  }
  return lines.join("\n");
}

function outcomesTable(r: Outcomes): string {
  const lines = [
    `outcomes by ${r.by} — window ${r.window.since.slice(0, 10)} .. ${r.window.until.slice(0, 10)} · labeled human turns ${r.labeled_turns} · ${r.source}`,
    `interval: ${r.interval}`, "",
    `${"key".padEnd(36)} ${"turns".padStart(7)} ${"mean_P(bad)".padStart(11)}  95% CI`,
  ];
  for (const x of r.rows) lines.push(`${x.key.slice(0, 36).padEnd(36)} ${String(x.labeled_turns).padStart(7)} ${x.mean_p_bad.toFixed(4).padStart(11)}  [${x.ci95[0].toFixed(4)}, ${x.ci95[1].toFixed(4)}]`);
  return lines.join("\n");
}

function experimentTable(r: Experiment): string {
  const f = (x: number | null, d: number) => (x === null ? "-" : x.toFixed(d));
  const lines = [
    `router holdout experiment — window ${r.window.since.slice(0, 10)} .. ${r.window.until.slice(0, 10)} · held-out share ${f(r.held_out_share, 3)} · ${r.source}`,
    `interval: ${r.interval}`, "",
    `${"arm".padEnd(10)} ${"turns".padStart(7)} ${"labeled".padStart(8)} ${"mean_P(bad)".padStart(11)} ${"cost_turns".padStart(10)} ${"mean_cost".padStart(10)}`,
  ];
  for (const a of r.arms) lines.push(`${a.arm.padEnd(10)} ${String(a.turns).padStart(7)} ${String(a.labeled_turns).padStart(8)} ${f(a.mean_p_bad, 4).padStart(11)} ${String(a.cost_turns).padStart(10)} ${f(a.mean_cost_usd, 4).padStart(10)}`);
  lines.push("");
  for (const d of r.differences) lines.push(`${d.metric.padEnd(10)} held-out minus routed ${f(d.held_out_minus_routed, 4)}  95% CI ${d.ci95 ? `[${d.ci95[0].toFixed(4)}, ${d.ci95[1].toFixed(4)}]` : "-"}${d.excludes_zero ? "  (excludes 0)" : ""}`);
  lines.push("", ...r.notes);
  return lines.join("\n");
}

function labelTable(s: LabelSummary, withEval: boolean): string {
  const f3 = (x: number | null | undefined) => (x === null || x === undefined ? "-" : x.toFixed(3));
  const lines = [
    `label ${s.source} · human turns ${s.human_turns} · with next prompt ${s.turns_with_next} · reactions missing ${s.reactions_missing}`,
    `fit: prior P(bad) ${f3(s.fit.prior)} · ${s.fit.iterations} EM iterations · converged ${s.fit.converged} · mean P(bad) ${f3(s.mean_p_bad)}`, "",
    `${"function".padEnd(14)} ${"bad".padStart(6)} ${"good".padStart(6)} ${"eligible".padStart(8)} ${"accuracy".padStart(8)}${withEval ? ` ${"auc_gold".padStart(8)} ${"auc_hold".padStart(8)}` : ""}`,
  ];
  for (const [fn, v] of Object.entries(s.votes_by_fn)) lines.push(`${fn.padEnd(14)} ${String(v.bad).padStart(6)} ${String(v.good).padStart(6)} ${String(v.eligible).padStart(8)} ${f3(s.fit.accuracy[fn]).padStart(8)}${withEval ? ` ${f3(s.eval.gold?.auc_by_fn[fn]).padStart(8)} ${f3(s.eval.holdout?.auc_by_fn[fn]).padStart(8)}` : ""}`);
  if (withEval) {
    lines.push("");
    for (const [name, e] of [["gold", s.eval.gold], ["holdout", s.eval.holdout]] as const) {
      lines.push(e ? `${name}: mapped ${e.mapped}/${e.of} · unhappy ${e.unhappy} · AUC ds-v1 ${f3(e.auc_ds)} · best single ${e.best_single ? `${e.best_single.fn} ${f3(e.best_single.auc)}` : "-"}` : `${name}: not available`);
    }
  }
  lines.push(s.cut ? `trigger cut ${f3(s.cut.cut)} · gold precision ${f3(s.cut.precision)} (${s.cut.true_positive}/${s.cut.flagged}) · holdout precision ${f3(s.cut.holdout?.precision)} (${s.cut.holdout?.true_positive ?? 0}/${s.cut.holdout?.flagged ?? 0})` : "trigger cut: none (no gold threshold reached precision 0.8 with 5+ turns); trigger will append nothing");
  return lines.join("\n");
}

export function main(argv: string[]): number {
  const [cmd, sub] = argv;
  const f = flags(argv);
  const claude = getClaudeDir();
  const db = strFlag(f, "db") ?? join(claude, "LIFEOS/MEMORY/EVIDENCE/evidence.sqlite");
  if (cmd === "build") {
    const since = strFlag(f, "since") ?? DEFAULT_SINCE;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(since)) { console.error(`--since must be YYYY-MM-DD\n${USAGE}`); return 2; }
    const summary = build({
      db, since,
      projects: strFlag(f, "projects") ?? join(claude, "projects"),
      router: strFlag(f, "router") ?? join(claude, "LIFEOS/MEMORY/OBSERVABILITY/router-decisions.jsonl"),
      pricing: join(claude, "LIFEOS/TOOLS/model-pricing.json"),
    });
    console.log(JSON.stringify({ ...summary, db, note: summary.bytes_read === 0 && summary.router_bytes_read === 0 ? "no new bytes: 0 bytes read" : undefined }, null, 2));
    return 0;
  }
  if (cmd === "label") {
    const handle = openDb(db);
    try {
      const s = label(handle, { errataDir: strFlag(f, "errata-dir"), tenantDir: strFlag(f, "errata-tenant-dir"), goldDir: strFlag(f, "gold-dir") ?? join(claude, "LIFEOS/USER/ERRATA/v4") });
      console.log(f.has("json") ? JSON.stringify(s, null, 2) : labelTable(s, f.has("eval")));
      return 0;
    } finally { handle.close(); }
  }
  if (cmd === "recommend") {
    const handle = openDb(db, { readonly: true });
    try {
      const r = recommend(handle, { dryRun: f.has("dry-run") });
      if (f.has("json")) console.log(JSON.stringify(r, null, 2));
      else {
        console.log(`recommend ${r.week} · comparisons v${r.version} · min ${r.min_per_arm} turns per arm${r.dry_run ? " · dry run" : ""} · qualifying ${r.qualifying} · filed ${r.filed}`);
        for (const e of r.evaluated) console.log(`  ${e.id.padEnd(14)} n ${e.routed_n}/${e.held_out_n}  diff ${e.held_out_minus_routed ?? "-"}  ${e.ci95 ? `[${e.ci95[0]}, ${e.ci95[1]}]` : "-"}  ${e.card ? (e.created ? `filed ${e.upgrade_id}` : r.dry_run ? `would file: ${e.card}` : `already filed ${e.upgrade_id}`) : e.enough_turns ? "no difference" : "not enough turns"}`);
      }
      return 0;
    } finally { handle.close(); }
  }
  if (cmd === "trigger") {
    const maxRaw = strFlag(f, "max");
    const max = maxRaw === undefined ? MAX_PER_RUN : Number(maxRaw);
    if (!Number.isInteger(max) || max < 0 || max > MAX_PER_RUN) { console.error(`--max must be an integer 0..${MAX_PER_RUN}`); return 2; }
    const handle = openDb(db);
    try {
      const r = trigger(handle, { dryRun: f.has("dry-run"), max, errataDir: strFlag(f, "errata-dir"), tenantDir: strFlag(f, "errata-tenant-dir") });
      if (f.has("json")) console.log(JSON.stringify(r, null, 2));
      else {
        console.log(`trigger${r.dry_run ? " (dry run: nothing appended)" : ""} · cut ${r.cut ?? "-"} · qualifying ${r.qualifying} · already linked ${r.already_linked} · already filed ${r.already_filed} · too fresh ${r.too_fresh} · no bad vote ${r.no_bad_vote} · ${r.dry_run ? "would append" : "appended"} ${r.dry_run ? r.planned.length : r.appended}${r.reason ? ` · ${r.reason}` : ""}`);
        for (const p of r.planned) console.log(`  ${p.p_bad.toFixed(3)}  ${p.span_id}  ${p.ts}  ${p.complaint}`);
      }
      return 0;
    } finally { handle.close(); }
  }
  if (cmd === "query") {
    const handle = openDb(db, { readonly: true });
    try {
      const o = { since: strFlag(f, "since"), until: strFlag(f, "until"), errataDir: strFlag(f, "errata-dir"), tenantDir: strFlag(f, "errata-tenant-dir"), origin: strFlag(f, "origin") };
      const json = f.has("json");
      if (sub === "by-model") { const r = byModel(handle, o); console.log(json ? JSON.stringify(r, null, 2) : table(r, "by-model")); return 0; }
      if (sub === "by-skill") { const r = bySkill(handle, o); console.log(json ? JSON.stringify(r, null, 2) : table(r, "by-skill")); return 0; }
      if (sub === "outcomes") {
        const by = (strFlag(f, "by") ?? "model") as OutcomeGroup;
        const r = outcomes(handle, { ...o, by });
        console.log(json ? JSON.stringify(r, null, 2) : outcomesTable(r));
        return 0;
      }
      if (sub === "experiment") { const r = experiment(handle, o); console.log(json ? JSON.stringify(r, null, 2) : experimentTable(r)); return 0; }
      if (sub === "compliance") { const r = compliance(handle, o); console.log(json ? JSON.stringify(r, null, 2) : complianceTable(r)); return 0; }
    } finally { handle.close(); }
  }
  console.error(USAGE);
  return 2;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
