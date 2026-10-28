/**
 * ReviewEntry.ts — the code reviewer's evals as an Assay entry (review-miss-evals ISA F9, ISC-49, ISC-15).
 *
 * The suite itself lives in LIFEOS/TOOLS/ReviewSuite.ts (replay one missed case, run the morning suite) and the cases and
 * {{PRINCIPAL_NAME}}'s case labels in LIFEOS/TOOLS/ReviewCases.ts. This file is only the door: `Assay.ts replay --review <case id>`
 * and `Assay.ts suite --review` call ReviewSuite's own functions and pass their flags through, and `Assay.ts report`
 * reads the suite's rows and the case labels into one "Code reviewer" block. Nothing here scores, judges or calls a model
 * except through ReviewSuite; the report half only reads files.
 *
 * Loaded lazily by Report.ts, so a hook that imports the Assay runtime never pays for the reviewer modules.
 */
import { agreement, DEFECT_CALLER, readCases, readJudgments, readLabels } from "../TOOLS/ReviewCases";
import {
  admitted, committedReviewerSource, DEFAULT_K, DEFAULT_MAX_CALLS, formatSuite, loadReviewerSpec, readReplays, readSuiteRuns, replayCase, reviewerSource, runSuite, SUITE_MAX_CALLS, suiteEvent,
  type ReplayResult, type ReviewerSpec, type SuiteResult,
} from "../TOOLS/ReviewSuite";

/** The ReviewSuite options a caller may inject (tests do; the CLI passes none). */
export type ReviewDeps = Omit<NonNullable<Parameters<typeof runSuite>[0]>, "k" | "maxCalls" | "dryRun"> & { log?: (line: string) => void };

const flagValue = (argv: string[], f: string): string | undefined => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
/** A positive whole number from a flag, the default when absent; null (after saying so) when it is not one. */
function positive(argv: string[], f: string, d: number): number | null {
  const raw = flagValue(argv, f);
  if (raw === undefined) return d;
  const n = Number(raw);
  if (Number.isInteger(n) && n >= 1) return n;
  console.error(`${f} takes a positive whole number`);
  return null;
}

const pct = (x: number | null): string => (x === null ? "—" : `${Math.round(x * 100)}%`);

/** `Assay.ts replay --review <case id> [--k N] [--max-calls N] [--json]`: ReviewSuite.replayCase on one case. */
export async function replayMain(argv: string[], deps: ReviewDeps = {}): Promise<number> {
  const log = deps.log ?? ((l: string) => console.log(l));
  const valued = new Set(["--k", "--max-calls"]);
  const id = argv.find((a, i) => !a.startsWith("--") && !valued.has(argv[i - 1] ?? ""));
  if (!id) { console.error("usage: Assay.ts replay --review <case id> [--k 3] [--max-calls 24] [--json]   (cases: bun LIFEOS/TOOLS/ReviewCases.ts list)"); return 2; }
  const k = positive(argv, "--k", DEFAULT_K), maxCalls = positive(argv, "--max-calls", DEFAULT_MAX_CALLS);
  if (k === null || maxCalls === null) return 2;
  const c = readCases().find((x) => x.id === id);
  if (!c) { console.error(`no case ${id}; bun LIFEOS/TOOLS/ReviewCases.ts list`); return 2; }
  const { log: _log, ...suiteDeps } = deps;
  const r = await replayCase(c, { ...suiteDeps, k, maxCalls });
  if (argv.includes("--json")) { log(JSON.stringify(r, null, 2)); return r.error ? 1 : 0; }
  if (r.error) { log(`Replay ${id}: ${r.error}`); return 1; }
  log(`Replay ${id}: k=${r.k}, ${r.batches} batch(es), ${r.vendors.join(" + ")}, prompt ${r.promptHash}`);
  for (const a of r.arms) {
    const nr = a.samples.filter((s) => "noResult" in s).length;
    log(`  ${a.arm.padEnd(9)} catch ${a.catchRate === null ? "—" : `${pct(a.catchRate)} of ${a.scored}`}  blocking ${pct(a.blockingRate)}${nr ? `  no result ${nr}/${a.samples.length}` : ""}  models ${a.models.join(", ") || "—"}`);
  }
  return 0;
}

/** `Assay.ts suite --review [--candidate <rev|path>] [--max-calls N] [--k N] [--dry-run] [--vigil] [--json]`: ReviewSuite.runSuite. A candidate is scored against Review.ts at HEAD before it lands (ISC-45). */
export async function suiteMain(argv: string[], deps: ReviewDeps = {}): Promise<number> {
  const log = deps.log ?? ((l: string) => console.log(l));
  if (!argv.includes("--review")) { console.error("usage: Assay.ts suite --review [--candidate <rev|path>] [--max-calls 200] [--k 3] [--dry-run] [--vigil] [--json]"); return 2; }
  const maxCalls = positive(argv, "--max-calls", SUITE_MAX_CALLS), k = positive(argv, "--k", DEFAULT_K);
  if (maxCalls === null || k === null) return 2;
  const ci = argv.indexOf("--candidate");
  const candidateArg = ci >= 0 ? argv[ci + 1] : undefined;
  if (ci >= 0 && (!candidateArg || candidateArg.startsWith("--"))) { console.error("--candidate takes a git revision or a path to a Review.ts"); return 2; }
  if (candidateArg && argv.includes("--vigil")) { console.error("--vigil is for the scheduled run; a candidate run never emits an event"); return 2; }
  let incumbent: ReviewerSpec | undefined, candidate: ReviewerSpec | undefined;
  if (candidateArg) {
    try {
      const src = reviewerSource(candidateArg);
      incumbent = await loadReviewerSpec(committedReviewerSource(), "incumbent (HEAD)");
      candidate = await loadReviewerSpec(src.source, src.label);
    } catch (e) { console.error(`suite: ${(e as Error).message}`); return 2; }
  }
  const { log: _log, ...suiteDeps } = deps;
  const r = await runSuite({ ...suiteDeps, k, maxCalls, dryRun: argv.includes("--dry-run"), incumbent, candidate });
  if (argv.includes("--vigil") && r.mode !== "planned") {
    try { const sent = (await import("../STATVS/index")).writeEvent(suiteEvent(r)) as { ok: boolean; refused?: string }; if (!sent.ok) console.error(`suite: STATVS refused the event: ${sent.refused}`); }
    catch (e) { console.error(`suite: event write failed: ${(e as Error).message}`); }
  }
  if (argv.includes("--json")) log(JSON.stringify(r));
  else for (const line of formatSuite(r)) log(line);
  return 0; // a lane outage is the event's news, not an engine failure that escalates through a streak
}

// ── the report half: reads only, never calls a model ──────────────────────────

/** Arms are named as ReviewSuite recorded them, so rows from before a rename read beside current rows. */
const ARM_ORDER = ["incumbent", "treatment", "candidate", "missed", "control"];
type ArmRate = { caught: number; scored: number; cases: number };

/** Pooled catch rate per arm over the admitted cases: each case's latest answered row per arm. */
export function catchRates(cases: ReadonlySet<string>, replays: ReplayResult[]): Record<string, ArmRate> {
  const out: Record<string, ArmRate> = {};
  const latest = new Map<string, ReplayResult["arms"][number]>();
  for (const r of [...replays].sort((a, b) => a.at.localeCompare(b.at))) {
    if (!cases.has(r.caseId) || r.error) continue;
    for (const a of r.arms) if (a.ran && a.scored > 0) latest.set(`${r.caseId}\0${a.arm}`, a);
  }
  for (const [key, a] of latest) {
    const o = (out[key.split("\0")[1]!] ??= { caught: 0, scored: 0, cases: 0 });
    o.cases++;
    o.scored += a.scored;
    o.caught += a.samples.filter((s) => "caught" in s && s.caught).length;
  }
  return out;
}

/** The review-case-defect caller against {{PRINCIPAL_NAME}}'s case labels (ISC-15): how often its reading at 0.5 matches them. */
export function defectAgreementLines(): string[] {
  const labels = readLabels().size, judged = readJudgments().size;
  if (labels === 0) return [`defect: no labels yet (${judged} case(s) judged); label one with: bun LIFEOS/TOOLS/ReviewCases.ts label <id> y|n`];
  const a = agreement();
  if (a.labelled === 0) return [`defect: ${labels} label(s), none on a judged case yet, agreement not computable (${judged} case(s) judged)`];
  return [`defect: ${DEFECT_CALLER} agrees with {{PRINCIPAL_NAME}}'s labels on ${a.agree}/${a.labelled} judged and labelled case(s) (${pct(a.agree / a.labelled)}); ${labels} label(s), ${judged} case(s) judged`];
}

export function reviewerBlock(opts: { withAgreement?: boolean } = {}): string {
  const lines = ["Code reviewer (review-miss-evals, LIFEOS/TOOLS/ReviewSuite.ts)"];
  const cases = readCases();
  const ok = cases.filter((c) => admitted(c).ok);
  const run: SuiteResult | undefined = readSuiteRuns().filter((x) => x.mode !== "candidate").at(-1);
  if (!run) lines.push("  suite: no run yet (Assay.ts suite --review)");
  else {
    const fps = Object.entries(run.fingerprints ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(([s, f]) => `${s} ${f}`).join(", ") || "none";
    lines.push(`  suite: last run ${run.at} (${run.mode}), reviewer fingerprint ${fps}`);
    lines.push(`  cases: ${run.cases.admitted} of ${run.cases.total} admitted at that run, ${run.cases.replayed} replayed, ${run.cases.cached} cached, ${run.cases.unscorable} unscorable; ${run.calls.used} reviewer calls; verdict ${run.verdict} (${run.reason})`);
  }
  if (ok.length === 0) lines.push(`  catch rate: nothing admitted yet (${cases.length} case(s) built; a case counts once labelled a defect or judged 0.5 or more)`);
  else {
    const r = catchRates(new Set(ok.map((c) => c.id)), readReplays());
    const names = Object.keys(r).sort((a, b) => (ARM_ORDER.indexOf(a) + 1 || 99) - (ARM_ORDER.indexOf(b) + 1 || 99) || a.localeCompare(b));
    lines.push(names.length
      ? `  catch rate over ${ok.length} admitted case(s): ${names.map((a) => `${a} ${pct(r[a]!.caught / r[a]!.scored)} (${r[a]!.caught}/${r[a]!.scored} samples, ${r[a]!.cases} case(s))`).join(" · ")}`
      : `  catch rate over ${ok.length} admitted case(s): no answered samples yet`);
  }
  if (opts.withAgreement !== false) lines.push(`  ${defectAgreementLines()[0]}`);
  return lines.join("\n");
}
