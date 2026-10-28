#!/usr/bin/env bun
/**
 * IdealState — CLI for the recommend-only ideal-state loop.
 *
 *   bun LIFEOS/IDEALSTATE/IdealState.ts rows [--json]        every target row and goal, with id, binding and pursuit
 *   bun LIFEOS/IDEALSTATE/IdealState.ts pursuit [<id>] [--json] what moves each row, from the latest reconcile
 *   bun LIFEOS/IDEALSTATE/IdealState.ts ids [--write]        rows lacking an id; --write assigns them (the principal's word)
 *   bun LIFEOS/IDEALSTATE/IdealState.ts reconcile [--json]   daily measurement pass (workflow ideal-reconcile)
 *   bun LIFEOS/IDEALSTATE/IdealState.ts gap [--json]         the latest reconcile report, with each bound row's tier and next move
 *   bun LIFEOS/IDEALSTATE/IdealState.ts scoreboard [--json]  targets bound and closures verified (read-only)
 *   bun LIFEOS/IDEALSTATE/IdealState.ts recommend [--json]   weekly recommendations pass (workflow ideal-recommend)
 *   bun LIFEOS/IDEALSTATE/IdealState.ts list [--all] [--json] open recommendations
 *   bun LIFEOS/IDEALSTATE/IdealState.ts accept <id>          the principal said yes
 *   bun LIFEOS/IDEALSTATE/IdealState.ts dismiss <id>         the principal said no
 *   bun LIFEOS/IDEALSTATE/IdealState.ts bind --propose-all [--by YYYY-MM-DD] [--json]
 *                                                            every obvious row-to-measurement match as one table; writes nothing
 *   bun LIFEOS/IDEALSTATE/IdealState.ts bind --accept <batch-id> [--by YYYY-MM-DD]
 *   bun LIFEOS/IDEALSTATE/IdealState.ts bind --accept-all [--by YYYY-MM-DD]
 *                                                            the principal said yes to the batch: back up, then bind every row in it
 *   bun LIFEOS/IDEALSTATE/IdealState.ts wants scan [--since <date>] [--sources a,b] [--dry-run] [--json]
 *                                                            catch the principal's wants from prompts, lifelog, corpus and praise (Wants.ts)
 *   bun LIFEOS/IDEALSTATE/IdealState.ts wants list [--all] [--json]   live wants; --all adds superseded and archived
 *   bun LIFEOS/IDEALSTATE/IdealState.ts wants keep <W-id…>   the principal keeps these wants (reversible: run drop to flip)
 *   bun LIFEOS/IDEALSTATE/IdealState.ts wants drop <W-id…>   the principal drops these wants: left out of the Ideal region and never resurrected by a scan (run keep to flip)
 *   bun LIFEOS/IDEALSTATE/IdealState.ts wants labels [--json]   keep, drop and unlabeled counts and the real-output precision keep/(keep+drop)
 *   bun LIFEOS/IDEALSTATE/IdealState.ts wants eval [--cases <jsonl>] [--json]   extractor precision on the original and held-out fixtures, each reported alone, plus the real-output precision; exit 1 when either fixture is below 0.9 or labeled real outputs are below 0.9
 *   bun LIFEOS/IDEALSTATE/IdealState.ts wants eval --labels [--json]   re-runs the extractor over the stored wants the principal labeled, in place; precision and recall against his keep/drop, overall and per source; exit 1 under precision 0.9 or recall 0.85 (ISC-31)
 *   bun LIFEOS/IDEALSTATE/IdealState.ts wants redomain [--dry-run] [--json]   re-asks the domain of kept wants filed under other (OpenAI lane) and moves each with a fold line; --dry-run asks and writes nothing
 *
 * reconcile and recommend write only to the loop state dir and the Vigil outbox.
 * accept, `ids --write` and `bind --accept` are the only commands that edit an
 * ideal-state file, and all run on the principal's word. Nothing here writes TELOS.md.
 *
 * @version 1.6.0
 *
 * 1.6.0: `wants eval --labels` (precision and recall on the principal's labeled real outputs, ISC-31); `wants redomain`.
 * 1.5.0: `wants keep|drop|labels`, the principal's reversible labels on stored wants; `wants eval` reports and gates on the real-output precision.
 * 1.4.0: `scoreboard`; `gap` shows tiers (Tiers.ts).
 * 1.3.0: `wants`, the principal's own wants (scan, list, eval); writes only the wants store in the state dir.
 * 1.2.0: `bind`, the one-yes binding sitting; Socrates-bound rows in gap.
 */
import { allRows, formatMeasure, formatPursuit, goalRows } from "./Rows";
import { acceptBatch, proposeAll } from "./Bind";
import { assignRowIds, liveGoals } from "./Ids";
import { reconcile, daysLeft, type ReconcileReport } from "./Reconcile";
import { acceptRec, dismissRec, loadStore, recommend } from "./Recommend";
import { readJson, readLines, statePath } from "./Store";
import { scoreboard } from "./Scoreboard";
import { liveUpgrades, type Verification } from "./Verify";
import { activeWants, evalLabeledWants, evalWantSets, labelWants, loadWants, redomainWants, scanWants, wantLabelStats, wantsEvalPassed, WANT_SOURCES, type EvalResult, type LabelCounts, type LabelStats, type WantSource } from "./Wants";

const [cmd, ...rest] = process.argv.slice(2);
const json = rest.includes("--json");
const out = (v: unknown, text: () => string) => console.log(json ? JSON.stringify(v, null, 2) : text());
/** The value after a flag, or undefined when the flag is absent. A flag with no value is an error. */
function flagValue(name: string): string | undefined {
  const i = rest.indexOf(name);
  if (i < 0) return undefined;
  const v = rest[i + 1];
  if (!v || v.startsWith("--")) throw new Error(`${name} needs a value`);
  return v;
}

const labelsLine = (s: LabelStats): string => `keep ${s.keep}, drop ${s.drop}, unlabeled ${s.unlabeled}, precision ${s.precision === null ? "—" : s.precision.toFixed(3)}`;
const fmt = (n: number | null): string => (n === null ? "—" : n.toFixed(3));
const countsLine = (c: LabelCounts): string => `keep ${c.keep}, drop ${c.drop}  precision ${fmt(c.precision)}  recall ${fmt(c.recall)}  (tp ${c.tp}, fp ${c.fp}, fn ${c.fn}, tn ${c.tn})`;
const realLine = (s: LabelStats): string => `real outputs: keep ${s.keep}, drop ${s.drop}, precision ${s.precision === null ? "— (none labeled)" : s.precision.toFixed(3)}`;

async function main(): Promise<number> {
  switch (cmd) {
    case "rows": {
      const g = liveGoals();
      const rows = [...allRows(), ...goalRows(g.goals, g.ids)];
      out(rows, () => rows.map((r) => `${(r.id ?? "—").padEnd(8)} ${r.measure ? "bound  " : "unbound"} ${(r.type === "goal" ? `goal:${r.status}` : r.type).padEnd(14)} ${r.file.padEnd(18)} ${r.text.slice(0, 80)}${r.pursuit ? `  [pursuit ${formatPursuit(r.pursuit)}]` : ""}${r.issues ? `  !! ${r.issues.join("; ")}` : ""}`).join("\n"));
      return 0;
    }
    case "ids": {
      const write = rest.includes("--write");
      const assigned = assignRowIds({ write });
      out({ write, assigned }, () => assigned.length ? `${write ? "assigned" : "would assign"} ${assigned.length} ids:\n` + assigned.map((a) => `${a.id}  ${a.file}:${a.line}  ${a.text.slice(0, 70)}`).join("\n") : "every row has an id");
      return 0;
    }
    case "pursuit": {
      const report = readJson<ReconcileReport | null>(statePath("reconcile.json"), null);
      if (!report?.pursuit) { console.error(report?.pursuit_error ? `pursuit graph unreadable on the last reconcile: ${report.pursuit_error}` : "no pursuit graph yet: run `IdealState.ts reconcile`"); return 1; }
      const id = rest.find((a) => !a.startsWith("--"));
      const rows = id ? report.pursuit.filter((p) => p.id === id) : report.pursuit;
      const s = report.pursuit_summary!;
      out(id ? rows : { summary: s, rows }, () => [
        ...(id ? [] : [`targets: ${s.targets.pursued} pursued, ${s.targets.stalled} stalled, ${s.targets.unpursued} unpursued, ${s.targets.declined} declined of ${s.targets.total} (${s.targets.sensed} sensed)`, `goals:   ${s.goals.pursued} pursued, ${s.goals.stalled} stalled, ${s.goals.unpursued} unpursued, ${s.goals.declined} declined of ${s.goals.total} active`]),
        ...rows.map((p) => `${p.id.padEnd(16)} ${p.state.padEnd(9)} ${p.sensed ? "sensed " : "       "} ${p.file} § ${p.section}${p.links.length ? "  ← " + p.links.map((l) => `${l.kind}/${l.name} (${l.live ? "live" : l.why})`).join(", ") : ""}${p.reason ? `  (${p.reason})` : ""}`),
      ].join("\n"));
      return 0;
    }
    case "reconcile": {
      const { report, events } = reconcile();
      const off = report.rows.filter((r) => r.state === "off-track").length;
      const ps = report.pursuit_summary;
      out({ ok: true, bound: report.bound, unbound_targets: report.unbound_targets, off_track: off, events, pursuit: ps ?? null, pursuit_error: report.pursuit_error ?? null }, () => `reconciled ${report.bound} bound rows (${off} off pace); ${report.unbound_targets} target rows unbound; ${ps ? `pursued ${ps.targets.pursued}/${ps.targets.total} targets, ${ps.goals.pursued}/${ps.goals.total} goals` : `pursuit unreadable: ${report.pursuit_error}`}; ${events} Vigil events`);
      return 0;
    }
    case "gap": {
      const report = readJson<ReconcileReport | null>(statePath("reconcile.json"), null);
      if (!report) { console.error("no reconcile yet: run `IdealState.ts reconcile`"); return 1; }
      out(report, () => [`${report.generated_at}  bound ${report.bound}  unbound targets ${report.unbound_targets}`,
        ...(report.tiers ? [`tiers: ${Object.entries(report.tiers).map(([t, n]) => `${n} ${t}`).join(", ")}`] : []),
        ...report.rows.map((r) => `${(r.tier ?? r.state).padEnd(12)} ${r.key.padEnd(14)} ${r.file.padEnd(18)} ${r.question ? `${r.question} answers ${r.answer ?? "unknown"}${r.by ? ` by ${r.by} (${daysLeft(r.by)}d)` : ""}` : `${r.value ?? "—"} → ${r.target} by ${r.by} (${daysLeft(r.by)}d)`}${r.error ? `  ${r.error}` : ""}${r.next_move ? `\n${" ".repeat(13)}next: ${r.next_move.kind}: ${r.next_move.text}` : ""}`)].join("\n"));
      return 0;
    }
    case "scoreboard": {
      const report = readJson<ReconcileReport | null>(statePath("reconcile.json"), null);
      const s = scoreboard({ now: new Date(), report, rows: allRows(), upgrades: liveUpgrades(), recs: loadStore().recs, verifications: readLines<Verification>("verifications.jsonl") });
      out(s, () => [`targets bound ${s.targets_bound}/${s.targets_total}${s.reconcile_at ? ` (reconcile ${s.reconcile_at})` : " (no reconcile yet)"}`, `closures verified ${s.closures_verified}`,
        ...s.closures.map((c) => `  ${c.upgrade_id} closed ${c.row}`), ...(s.not_counted.length ? [`not counted (${s.not_counted.length}):`, ...s.not_counted.map((n) => `  ${n.upgrade_id} ${n.row}: ${n.why}`)] : []),
        `14-day checks: ${s.checks.closer} closer, ${s.checks.not_closer} not closer, ${s.checks.unreadable} unreadable`].join("\n"));
      return 0;
    }
    case "recommend": {
      const r = await recommend();
      out({ ok: true, added: r.added.length, expired: r.expired, pool: r.pool, skipped: r.skipped ?? null }, () => `pool ${r.pool}; added ${r.added.length}; expired ${r.expired}${r.skipped ? ` (${r.skipped})` : ""}`);
      return 0;
    }
    case "list": {
      const recs = loadStore().recs.filter((r) => rest.includes("--all") || r.status === "open");
      out(recs, () => recs.length ? recs.map((r) => r.kind === "row"
        ? `${r.id}  row    ${r.file} § ${r.section}\n    ${r.text}\n    from ${r.source_id}: "${r.source_quote}"`
        : r.kind === "binding"
        ? `${r.id}  measure ${r.file} § ${r.section}\n    ${r.text}\n    measured by ${formatMeasure(r.measure!)}`
        : `${r.id}  pursue ${r.serves ?? "—"}  ${r.title} (${r.owner ?? "system"}, ${r.cadence}, ${r.severity})\n    ${r.brief}\n    data: ${r.data_source}\n    serves: ${r.gap}`).join("\n") : "no open recommendations");
      return 0;
    }
    case "accept":
    case "dismiss": {
      const id = rest.find((a) => !a.startsWith("--"));
      if (!id) { console.error(`usage: IdealState.ts ${cmd} <id>`); return 2; }
      const rec = cmd === "accept" ? acceptRec(id) : dismissRec(id);
      out(rec, () => `${rec.id} ${rec.status}${rec.kind === "row" && cmd === "accept" ? ` — row added to ${rec.file} § ${rec.section}` : ""}`);
      return 0;
    }
    case "bind": {
      const by = flagValue("--by");
      const byArg = by ? ` --by ${by}` : "";
      if (rest.includes("--propose-all")) {
        const p = proposeAll(by ? { by } : {});
        out(p, () => [
          `${p.batch}  ${p.proposals.length} binding(s) proposed; nothing written`,
          ...p.proposals.map((x) => `${x.id.padEnd(14)} ${x.file.padEnd(18)} ${x.text.slice(0, 56).padEnd(56)}  ${x.measure.file}#${x.measure.path}  now ${x.value} → ${x.measure.target} by ${x.measure.by}${x.by_source === "row" ? "" : ` (${x.by_source} date)`}\n${" ".repeat(15)}why: ${x.reason}`),
          ...(p.skipped.length ? ["", `not proposed (${p.skipped.length}):`, ...p.skipped.map((s) => `  ${s.id.padEnd(14)} ${s.file.padEnd(18)} ${s.why}`)] : []),
          ...(p.proposals.length ? ["", `one yes binds them all: bun LIFEOS/IDEALSTATE/IdealState.ts bind --accept ${p.batch}${byArg}`] : []),
        ].join("\n"));
        return 0;
      }
      const id = rest.includes("--accept-all") ? "all" : flagValue("--accept");
      if (!id) { console.error("usage: IdealState.ts bind --propose-all | --accept <batch-id> | --accept-all [--by YYYY-MM-DD] [--json]"); return 2; }
      const r = acceptBatch(id, by ? { by } : {});
      out(r, () => [`${r.batch}: bound ${r.bound.length} row(s)`, ...r.bound.map((x) => `  ${x.id.padEnd(14)} ${x.file} — measure: ${formatMeasure(x.measure)}`), `backups: ${r.backups.join(", ")}`, ...(r.superseded.length ? [`superseded open recommendations: ${r.superseded.join(", ")}`] : [])].join("\n"));
      return 0;
    }
    case "wants": {
      const sub = rest.find((a) => !a.startsWith("--"));
      if (sub === "list") {
        const ws = rest.includes("--all") ? loadWants() : activeWants();
        out(ws, () => ws.length ? ws.map((w) => `${w.id}  ${w.domain.padEnd(14)} ${w.said_at.slice(0, 10)}  ${w.source.padEnd(13)} ${w.superseded_by ? `superseded by ${w.superseded_by}  ` : ""}${w.archived ? "archived  " : ""}${w.text}`).join("\n") : "no wants recorded");
        return 0;
      }
      if (sub === "scan") {
        const sinceRaw = flagValue("--since");
        const since = sinceRaw ? new Date(sinceRaw) : undefined;
        if (since && Number.isNaN(since.getTime())) throw new Error(`--since: not a date: ${sinceRaw}`);
        const sourcesRaw = flagValue("--sources");
        const sources = sourcesRaw?.split(",").map((s) => s.trim()) as WantSource[] | undefined;
        if (sources?.some((s) => !(WANT_SOURCES as readonly string[]).includes(s))) throw new Error(`--sources: one or more of ${WANT_SOURCES.join(", ")}`);
        const r = await scanWants({ since, dryRun: rest.includes("--dry-run"), sources });
        out(r, () => [`${r.dry_run ? "dry run, nothing written: " : ""}${r.raw} lines read, ${r.candidates} candidates, ${r.classified} classified; ${r.added} new, ${r.folded} repeats folded, ${r.superseded} superseded, ${r.archived} archived`,
          ...Object.entries(r.by_source).map(([s, b]) => `  ${s.padEnd(14)} ${b.raw} read, ${b.candidates} candidates, ${b.added} new${b.error ? `  (${b.error})` : ""}`)].join("\n"));
        return 0;
      }
      if (sub === "keep" || sub === "drop") {
        const ids = rest.filter((a) => !a.startsWith("--") && a !== sub);
        if (!ids.length) { console.error(`usage: IdealState.ts wants ${sub} <W-id…>`); return 2; }
        labelWants(ids, sub);
        out({ verdict: sub, ids }, () => `${sub}: ${ids.join(", ")}`);
        return 0;
      }
      if (sub === "labels") {
        const s = wantLabelStats();
        out(s, () => labelsLine(s));
        return 0;
      }
      if (sub === "eval" && rest.includes("--labels")) {
        const r = await evalLabeledWants();
        out(r, () => [
          `labeled real outputs: ${r.labeled} (keep ${r.keep}, drop ${r.drop})`,
          `precision ${fmt(r.precision)}  recall ${fmt(r.recall)}  (tp ${r.tp}, fp ${r.fp}, fn ${r.fn}, tn ${r.tn})  ${r.passed ? "PASS" : "FAIL"} at precision >= ${r.precision_floor} and recall >= ${r.recall_floor}`,
          ...Object.entries(r.by_source).map(([src, c]) => `  ${src.padEnd(14)} ${countsLine(c)}`),
          ...(r.false_positives.length ? [`  dropped but still extracted: ${r.false_positives.join(", ")}`] : []),
          ...(r.missed_keeps.length ? [`  kept but now refused: ${r.missed_keeps.join(", ")}`] : []),
        ].join("\n"));
        return r.passed ? 0 : 1;
      }
      if (sub === "redomain") {
        const r = await redomainWants({ dryRun: rest.includes("--dry-run") });
        out(r, () => [`${r.dry_run ? "dry run, nothing written: " : ""}${r.considered} kept want(s) in other asked; ${r.proposals.length} would move; ${r.written} written`,
          ...r.proposals.map((p) => `  ${p.id}  ${p.from} → ${p.to}  ${p.text}`)].join("\n"));
        return 0;
      }
      if (sub === "eval") {
        // --cases runs one file; with no --cases both labeled sets run, and each reports its own precision.
        const cases = flagValue("--cases");
        const r = await evalWantSets(cases ? { sets: [{ name: "cases", path: cases }] } : {});
        const line = (name: string, x: EvalResult) => [`wants-extractor ${name}: ${x.cases} cases  precision ${x.precision === null ? "—" : x.precision.toFixed(3)}  recall ${x.recall === null ? "—" : x.recall.toFixed(3)}  (tp ${x.tp}, fp ${x.fp}, fn ${x.fn}, tn ${x.tn})  ${x.passed ? "PASS" : "FAIL"} at precision >= ${x.threshold}`,
          ...(x.false_positives.length ? [`  false positives: ${x.false_positives.join(", ")}`] : []), ...(x.false_negatives.length ? [`  missed wants: ${x.false_negatives.join(", ")}`] : [])];
        const labels = wantLabelStats();
        const passed = wantsEvalPassed(r, labels);
        out({ ...r, passed, real_outputs: labels }, () => [...r.sets.flatMap((x) => line(x.name, x.result)), realLine(labels), `overall: ${passed ? "PASS" : "FAIL"} (every set, and the labeled real outputs once any exist, must reach the precision floor)`].join("\n"));
        return passed ? 0 : 1;
      }
      console.error("usage: IdealState.ts wants scan [--since <date>] [--sources prompt,lifelog,corpus,errata-praise] [--dry-run] [--json] | wants list [--all] [--json] | wants keep <W-id…> | wants drop <W-id…> | wants labels [--json] | wants eval [--cases <jsonl>] [--json] | wants eval --labels [--json] | wants redomain [--dry-run] [--json]");
      return 2;
    }
    default:
      console.error("usage: IdealState.ts rows|pursuit [<id>]|ids [--write]|reconcile|gap|scoreboard|recommend|list|accept <id>|dismiss <id>|bind --propose-all|--accept <batch-id>|--accept-all|wants scan|list|keep|drop|labels|eval [--json]");
      return 2;
  }
}

main().then((c) => process.exit(c), (e) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
