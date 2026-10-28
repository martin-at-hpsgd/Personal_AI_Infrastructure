#!/usr/bin/env bun
/**
 * Act.ts — Errata M7b end to end: rule index → coverage → clusters → recommendations → report
 * (Errata ISA F6, ISC-45..48, 51). The Glance calls live in Coverage.ts, Cluster.ts and Recommend.ts
 * (caller errata-coverage, shadow; see LIFEOS/DOCUMENTATION/Assay/AssaySystem.md); this file only
 * sequences them and renders their report sections.
 *
 *   bun LIFEOS/ERRATA/Errata.ts v4 rules build|show <id>|search <text>
 *   bun LIFEOS/ERRATA/Errata.ts v4 cover [--limit N] [--dry-run]
 *   bun LIFEOS/ERRATA/Errata.ts v4 cluster [--dry-run]
 *   bun LIFEOS/ERRATA/Errata.ts v4 recommend [--top N] [--file] [--dry-run]   (--top: clusters per fix type)
 *   bun LIFEOS/ERRATA/Errata.ts v4 act [--top N] [--file]      (the weekly pass: every step, then the report)
 *   bun LIFEOS/ERRATA/Act.ts recheck [--day YYYY-MM-DD] [--from <file in v4>] [--tag <name>]
 *                                                                (every current check on a stored list; writes only recommendations-recheck-<day>[-<tag>].jsonl)
 *   bun LIFEOS/ERRATA/Act.ts calib draw [--seed N] [--force] | brief [--check] | agreement | calibrate [--dry-run]   (ISC-54, CalibrateAct.ts)
 *   bun LIFEOS/ERRATA/Act.ts register                             (add any M7b question the errata-coverage row lacks)
 *
 * `--file` is the only path into the Upgrades store. Without it nothing leaves
 * LIFEOS/USER/ERRATA/v4/. Each step is fault-isolated inside `act`: a failed step is reported and
 * the later steps run on what is already stored, so the report is always rewritten.
 */
import { extract, v4Dir, loadExchanges } from "./Exchanges";
import { detect, diagnose, report as triageReport } from "./Triage4";
import { getUpgrade, listUpgrades, type UpgradeRecord } from "../TOOLS/Upgrades";
import { actCaller, cover, coverageTable, diagnosedFailures, formatLeaderboard, leaderboard, loadCoverage, type Failure } from "./Coverage";
import type { ActCuts } from "./ActQuestions";
import { bucketsOf, cluster, clustersFrom, loadPairs, type Cluster } from "./Cluster";
import { FIX_TYPES, filedRates, formatRates, formatRecommendations, loadFiled, recheck, recommend, recommendationsPath, withHandFiled, type Recommendation } from "./Recommend";
import { buildRuleIndex, loadRuleIndex, main as rulesMain, retriever } from "./Rules";
import { calibrate, checkBrief, draw, formatAgreement, loadTaskLabels, registerActQuestions, taskAgreement, TASKS, writeBrief, BRIEF_PATH } from "./CalibrateAct";
import { existsSync, readdirSync, readFileSync } from "node:fs";

type Log = (s: string) => void;
const stderr: Log = (s) => process.stderr.write(`${s}\n`);

/** The newest recommendations and dropped files under the v4 dir, if any. */
function latestRecommendations(dir: string): { survivors: Recommendation[]; dropped: Recommendation[]; day: string | null } {
  if (!existsSync(dir)) return { survivors: [], dropped: [], day: null };
  const days = readdirSync(dir).map((f) => /^recommendations-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(f)?.[1]).filter((d): d is string => !!d).sort();
  const day = days[days.length - 1] ?? null;
  if (!day) return { survivors: [], dropped: [], day: null };
  const read = (p: string): Recommendation[] => (existsSync(p) ? readFileSync(p, "utf8").split("\n").filter((l) => l.trim()).flatMap((l) => { try { return [JSON.parse(l) as Recommendation]; } catch { return []; } }) : []);
  return { survivors: read(recommendationsPath(dir, day)), dropped: read(recommendationsPath(dir, day, true)), day };
}

/** Report sections from stored answers only (no calls): the leaderboard, the top clusters, the latest recommendations, before/after. */
export function m7bSections(dir = v4Dir(), now = new Date(), deps: { failures?: Failure[]; cuts?: ActCuts; upgrades?: () => UpgradeRecord[] } = {}): string[] {
  const index = loadRuleIndex(dir);
  if (!index) return ["## Most-broken rules", "No rule index yet (`errata v4 rules build`).", ""];
  const r = retriever(index);
  const cuts = deps.cuts ?? actCaller().cuts;
  const failures = deps.failures ?? diagnosedFailures({ dir });
  const table = coverageTable(failures, r, loadCoverage(dir), cuts);
  const clusters = clustersFrom(bucketsOf(failures, table), loadPairs(dir), cuts);
  const recs = latestRecommendations(dir);
  const lines = [...formatLeaderboard(leaderboard(failures, table, r.byId))];
  lines.push("## Top clusters", `${clusters.length} clusters over ${clusters.reduce((s, c) => s + c.count, 0)} defects; keyed by the broken rule when one covers, else class × component, split by same-root-cause pairs. The two fix types rank apart, so the missing-rule gaps are never crowded out by one large rule bucket.`);
  for (const ft of FIX_TYPES) {
    const group = clusters.filter((c) => c.fix_type === ft);
    lines.push("", `### ${ft}: ${group.length} clusters, ${group.filter((c) => c.count >= 5).length} with at least five failures`, "",
      "| cluster | failures | sessions | mean severity | score |", "|---|---|---|---|---|",
      ...group.slice(0, 8).map((c) => `| \`${c.key.replace(/\|/g, "\\|")}\` | ${c.count} | ${c.sessions} | ${c.mean_severity} | ${c.score} |`));
  }
  lines.push("");
  lines.push(...formatRecommendations(recs, r.byId, cuts).map((l, i) => (i === 0 && recs.day ? `${l} (${recs.day})` : l)));
  // Upgrades filed by hand never reached filed.jsonl; the ones citing exchange ids still get a row (ISC-37).
  const filed = withHandFiled(loadFiled(dir), (deps.upgrades ?? (() => listUpgrades({ source: "errata" })))(), failures, table);
  lines.push(...formatRates(filedRates(filed, failures, table, loadExchanges(dir), getUpgrade, now)));
  return lines;
}

export type DailyV4Result = { extract?: unknown; detect?: unknown; diagnose?: unknown; errors: string[] };
export type DailyV4Deps = { extract?: typeof extract; detect?: typeof detect; diagnose?: typeof diagnose };
/** Per-stage cap for the daily pass; a day's typed prompts are in the low hundreds. */
export const DAILY_V4_LIMIT = 3000;

/**
 * The daily v4 pass (ISC-51): pull the new typed exchanges, ask the detect nouls of every exchange
 * without them (new rows first), then the diagnosis nouls of the new failures. Each stage is
 * isolated; an error is recorded and the next stage still runs.
 */
export async function dailyV4(deps: DailyV4Deps = {}, limit = DAILY_V4_LIMIT): Promise<DailyV4Result> {
  const out: DailyV4Result = { errors: [] };
  const run = async (name: "extract" | "detect" | "diagnose", fn: () => Promise<unknown>): Promise<void> => {
    try { out[name] = await fn(); } catch (e) { out.errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); }
  };
  await run("extract", () => (deps.extract ?? extract)({}));
  await run("detect", async () => ({ ...(await (deps.detect ?? detect)({ limit, newFirst: true })), example: undefined }));
  await run("diagnose", async () => ({ ...(await (deps.diagnose ?? diagnose)({ limit, newFirst: true })), example: undefined }));
  return out;
}

export type ActResult = { rules?: number; cover?: unknown; cluster?: unknown; recommend?: unknown; report?: string; errors: string[] };

/** The weekly M7b pass. Never throws for a step; a failed step lands in `errors`. */
export async function act(opts: { dir?: string; file?: boolean; top?: number; log?: Log } = {}): Promise<ActResult> {
  const dir = opts.dir ?? v4Dir();
  const log = opts.log ?? stderr;
  const out: ActResult = { errors: [] };
  const step = async <T>(name: string, fn: () => Promise<T> | T): Promise<T | undefined> => {
    try { return await fn(); } catch (e) { const m = `${name}: ${e instanceof Error ? e.message : String(e)}`; out.errors.push(m); log(`act ${m}`); return undefined; }
  };
  out.rules = (await step("rules", () => buildRuleIndex({ dir })))?.rules.length;
  const failures = await step("failures", () => diagnosedFailures({ dir }));
  if (failures) {
    const c = await step("cover", () => cover({ dir, failures, log }));
    if (c) out.cover = { ...c, example: undefined };
    const index = loadRuleIndex(dir);
    if (index) {
      const r = retriever(index);
      const cuts = await step("caller", () => actCaller().cuts);
      if (cuts) {
        const table = coverageTable(failures, r, loadCoverage(dir), cuts);
        const cl = await step("cluster", () => cluster({ dir, failures, table, cuts, log }));
        if (cl) out.cluster = { buckets: cl.buckets, split_buckets: cl.split_buckets, pairs_asked: cl.pairs_asked, errors: cl.errors, clusters: cl.clusters.length };
        if (cl) {
          const rec = await step("recommend", () => recommend({ dir, failures, clusters: cl.clusters, rules: r.byId, cuts, file: opts.file, top: opts.top, log }));
          if (rec) out.recommend = { eligible: rec.eligible, considered: rec.considered, eligible_by_fix: rec.eligible_by_fix, considered_by_fix: rec.considered_by_fix, written: rec.written, survivors: rec.survivors.length, dropped: rec.dropped.length, filed: rec.filed };
        }
      }
    }
  }
  const rep = await step("report", () => triageReport({ dir, sections: () => m7bSections(dir) }));
  if (rep) out.report = rep.path;
  return out;
}

function num(args: string[], flag: string): number | undefined {
  const i = args.indexOf(flag);
  if (i < 0) return undefined;
  const n = Number(args[i + 1]);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${flag} must be a nonnegative integer`);
  return n;
}

/** The newest day with a stored recommendations file, or "". */
function latestDay(dir: string): string {
  return latestRecommendations(dir).day ?? "";
}

/** `calib draw|brief|agreement|calibrate` (ISC-54). */
async function calibMain(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  const dir = v4Dir();
  if (sub === "draw") {
    const index = loadRuleIndex(dir);
    if (!index) { console.error("no rule index; run `errata v4 rules build` first"); return 1; }
    const r = draw({ dir, failures: diagnosedFailures({ dir }), rules: retriever(index).byId, seed: num(rest, "--seed"), force: rest.includes("--force") });
    console.log(JSON.stringify(r));
    return 0;
  }
  if (sub === "brief") {
    if (rest.includes("--check")) {
      const same = checkBrief();
      console.log(same ? "brief matches the questions" : "brief is stale: run bun LIFEOS/ERRATA/Act.ts calib brief");
      return same ? 0 : 1;
    }
    console.log(writeBrief(BRIEF_PATH));
    return 0;
  }
  if (sub === "agreement") {
    let problems = 0;
    for (const t of TASKS) {
      const labels = loadTaskLabels(t, dir);
      const a = taskAgreement(t, labels);
      console.log(formatAgreement(a, labels.ids.length).join("\n"));
      for (const p of a.problems) console.error(p);
      problems += a.problems.length + (a.majority.size === labels.ids.length ? 0 : 1);
    }
    return problems ? 1 : 0;
  }
  if (sub === "calibrate") {
    const r = calibrate({ dir, dryRun: rest.includes("--dry-run") });
    for (const a of r.agreements) console.log(formatAgreement(a, a.majority.size).join("\n"));
    for (const c of r.calibrations) console.log(`${c.id.padEnd(16)} cut ${c.value.toFixed(2)}  balanced ${(c.balanced * 100).toFixed(1)}%  agreement ${(c.agreement * 100).toFixed(1)}%  n ${c.samples} (majority yes ${c.positives})  unweighted cut ${c.unweighted_cut ?? "n/a"}  model ${c.model ?? "?"}`);
    for (const p of r.problems) console.error(p);
    console.log(JSON.stringify({ ok: r.ok, written: r.written }));
    return r.ok ? 0 : 1;
  }
  console.error("usage: Act.ts calib draw [--seed N] [--force] | brief [--check] | agreement | calibrate [--dry-run]");
  return 2;
}

/** Stored clusters without asking anything new: the pairs already answered decide the merges. */
async function storedClusters(dir: string, failures: Failure[]): Promise<Cluster[]> {
  const index = loadRuleIndex(dir);
  if (!index) throw new Error("no rule index; run `errata v4 rules build` first");
  const { cuts } = actCaller();
  const table = coverageTable(failures, retriever(index), loadCoverage(dir), cuts);
  return (await cluster({ dir, failures, table, cuts, dryRun: true })).clusters;
}

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...args] = argv;
  const dir = v4Dir();
  const dryRun = args.includes("--dry-run");
  if (cmd === "rules") return rulesMain(args);
  if (cmd === "cover") {
    const r = await cover({ dir, limit: num(args, "--limit"), dryRun });
    if (dryRun && r.example) console.log(`example state (${r.example.length} chars): ${r.example}`);
    console.log(JSON.stringify({ ...r, example: undefined }));
    return r.errors ? 1 : 0;
  }
  if (cmd === "cluster") {
    const index = loadRuleIndex(dir);
    if (!index) { console.error("no rule index; run `errata v4 rules build` first"); return 1; }
    const failures = diagnosedFailures({ dir });
    const { cuts } = actCaller();
    const table = coverageTable(failures, retriever(index), loadCoverage(dir), cuts);
    const r = await cluster({ dir, failures, table, cuts, dryRun });
    console.log(JSON.stringify({ buckets: r.buckets, split_buckets: r.split_buckets, pairs_asked: r.pairs_asked, errors: r.errors, clusters: r.clusters.length, path: r.path }));
    for (const c of r.clusters.slice(0, 10)) console.log(`${c.key}  ${c.fix_type}  ${c.count} failures, ${c.sessions} sessions`);
    return r.errors ? 1 : 0;
  }
  if (cmd === "recommend") {
    const failures = diagnosedFailures({ dir });
    const clusters = await storedClusters(dir, failures);
    const r = await recommend({ dir, failures, clusters, rules: retriever(loadRuleIndex(dir)!).byId, top: num(args, "--top"), file: args.includes("--file"), dryRun });
    console.log(JSON.stringify({ eligible: r.eligible, considered: r.considered, eligible_by_fix: r.eligible_by_fix, considered_by_fix: r.considered_by_fix, considered_keys: r.considered_keys, written: r.written, survivors: r.survivors.length, dropped: r.dropped.length, filed: r.filed, paths: r.paths }));
    console.log(formatRecommendations(r, retriever(loadRuleIndex(dir)!).byId, actCaller().cuts).join("\n"));
    return 0;
  }
  if (cmd === "recheck") {
    const opt = (flag: string): string | undefined => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] ?? "" : undefined; };
    const day = opt("--day") ?? latestDay(dir);
    if (!day) { console.error("no stored recommendations to recheck"); return 1; }
    const index = loadRuleIndex(dir);
    if (!index) { console.error("no rule index; run `errata v4 rules build` first"); return 1; }
    const rules = retriever(index).byId;
    const { cuts } = actCaller();
    // Exemplars resolve against the exchanges, never the diagnosis, so a stored list rechecks on the text it was written from.
    const r = await recheck({ dir, day, exchanges: loadExchanges(dir), rules, cuts, from: opt("--from"), tag: opt("--tag") });
    console.log(JSON.stringify({ day, from: opt("--from") ?? null, survivors: r.survivors.length, dropped: r.dropped.length, path: r.path }));
    console.log(formatRecommendations(r, rules, cuts).join("\n"));
    return 0;
  }
  if (cmd === "register") {
    const added = registerActQuestions();
    console.log(JSON.stringify({ caller: "errata-coverage", added }));
    return 0;
  }
  if (cmd === "calib") return calibMain(args);
  if (cmd === "act") {
    const r = await act({ dir, file: args.includes("--file"), top: num(args, "--top") });
    console.log(JSON.stringify(r));
    return r.errors.length ? 1 : 0;
  }
  console.error("usage: Act.ts rules build|show <id>|search <text> | cover [--limit N] [--dry-run] | cluster [--dry-run] | recommend [--top N] [--file] [--dry-run] | act [--top N] [--file] | recheck [--day YYYY-MM-DD] [--from <file>] [--tag <name>] | register | calib draw|brief|agreement|calibrate");
  return 2;
}

if (import.meta.main) {
  main(process.argv.slice(2)).then((c) => process.exit(c)).catch((e) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
}
