#!/usr/bin/env bun
/**
 * HillClimb — the climb ledger, the system survey, the stop rule and the before/after verify.
 *
 * The instruments already exist (Errata, Assay, the ISA, Upgrades). This tool holds what they
 * don't: which hill is steepest right now, one climb's baseline and experiments, the rule that
 * says a change may be kept, the rule that says the climb has plateaued, and whether the
 * complaint rate actually moved after the climb landed.
 *
 * Usage:
 *   bun HillClimb.ts survey [--since YYYY-MM-DD] [--top N] [--json]
 *   bun HillClimb.ts start --type <type> --target <what> --metric <name> --direction higher|lower --why "<text>" [--skill <Name>]
 *                          [--budget <n experiments>] [--budget-reads <n candidate reads of test and screen>]
 *   bun HillClimb.ts baseline <id> --from-run <run.json> [--field pass_to_k|mean_score] [--instrument <file>]... [--seed s] [--train-frac 0.5] [--min-split 10]
 *                                 [--screen-frac f] [--holdout-frac f] [--ceiling n] [--min-win n] [--noise n --noise-source "<where>"] [--checks <n>]
 *   bun HillClimb.ts baseline <id> --value <n> [--train <n>] --source "<how measured>" [--noise n --noise-source "<where>"] [--instrument <file>]... [--ceiling n] [--min-win n] [--checks <n>] [--served-model m]
 *   bun HillClimb.ts baseline <id> --from-critique <Critique.json>... [--instrument <file>]... [--checks <n>]
 *   bun HillClimb.ts baseline <id> ... --force --reason "<why the old reading is replaced>"     (before any experiment; the old one goes to baseline_history)
 *   bun HillClimb.ts preflight <id>
 *   bun HillClimb.ts exp <id> --hypothesis "<text>" (--from-run <run.json> | --value <n> [--train n] [--served-model m]) (--keep|--revert)
 *                            [--kind <kind> [--kind-as-proposed "<proposer's word>"]] [--origin "<proposer>"] [--parent <n>]... [--path <file|dir>] [--generation <g> [--proposal <id>]]
 *                            [--simpler --before <file|dir> --after <file|dir>]
 *                            [--tag required|tune] [--spot-checked] [--ref <sha>] [--checks <n>] [--note "<text>"]
 *   bun HillClimb.ts exp <id> --hypothesis "<text>" --from-critique <Critique.json>... --parent-critique <Critique.json>... (--keep|--revert)
 *                            [--kind <kind>] [--origin "<proposer>"] [--parent <n>]... [--tag required|tune] [--ref <sha>] [--checks <n>] [--note "<text>"]
 *   bun HillClimb.ts exp <id> --hypothesis "<text>" (--train <n> | --screened) [--revert] [--kind ...] [--origin ...] [--parent <n>]... [--generation <g> [--proposal <id>]]
 *   bun HillClimb.ts screen <id> --from-run <run.json> [--hypothesis "<text>"] [--generation <g> [--proposal <id>]] [--field pass_to_k|mean_score]
 *   bun HillClimb.ts digest <id> --train-only
 *   bun HillClimb.ts archive <id>
 *   bun HillClimb.ts plateau <id> [--window 3]
 *   bun HillClimb.ts stall <id> [--artifact n] [--grader n] [--harness n] [--structural n] [--variance n] [--note "<text>"]
 *   bun HillClimb.ts close <id> --stop plateau|target|budget|abort|reviewed [--reason "<text>"] [--window 3] [--holdout-run <run.json>] [--field pass_to_k|mean_score] [--upgrade <upgrade-id> | --no-upgrade]
 *   bun HillClimb.ts verify <id> [--days 14] [--dry-run]
 *   bun HillClimb.ts status <id> | list [--json]
 *
 * Types: skill | workflow | eval | isa | prompt | rule | metric | miss
 * Kinds (exp --kind): knob | wording | rule | structure | delete | add | import
 * Ledger: $HILLCLIMB_DIR, else <configRoot>/LIFEOS/MEMORY/STATE/HillClimb/<id>/{climb.json,experiments.jsonl,reads.jsonl,archive/}
 * Exit codes: 0 ok · 1 refused, not plateaued, or widen · 2 usage or runtime error.
 *
 * Population (1.3.0). Each experiment records its kind of change, the proposer it came from (--origin)
 * and the experiments it was built from (--parent, repeatable; 0 is the baseline). `status` reports the
 * keep rate by kind and by origin. `plateau` answers widen, never plateaued, while the reverts since the
 * last keep span fewer than three kinds. `digest --train-only` is the proposer view: every hypothesis
 * with kind, origin, outcome and train delta, and no test, screen or holdout number or case id.
 * A revert that beat the incumbent on train goes into the archive (a copy of --path, or --ref) for
 * recombination, read back with `archive`.
 *
 * Held-out data. The baseline may set aside a screen split (cut many candidates to a few with `screen`)
 * and a holdout (read once, at close, against the final system). Every test, screen and holdout read is
 * logged in reads.jsonl, refused keeps included, and `status` shows the counts. `screen` scores the screen
 * cases only and never computes a test number, so a run of just the screen cases is enough.
 *
 * Screened-out candidates. A candidate cut before any test read (it lost on train, failed to build, or lost
 * on the screen) is recorded with `exp --train <n>` and no --value, or `exp --screened`: outcome "screened",
 * value null (never a made-up zero), no test read logged, and it can never be kept.
 *
 * Generations. `exp --generation <g>` says the experiment measures a proposal of Population.ts generation g;
 * it is refused unless <climb>/ideate/gen-<g>.json holds that hypothesis (or --proposal <id>). Once any
 * experiment names a generation the climb is in population mode, and `plateau` counts generations without
 * a keep (window 3 = three generations), not single reverts; the categorize prompt and `stall` follow it.
 *
 * Multiple comparisons. Every candidate read on test since the last keep is another chance at a lucky win,
 * so a keep's significance is Bonferroni-corrected over m, the distinct candidates read on test since the last
 * keep (this one included; refused keeps count; the same run re-recorded counts once; m is never less than the
 * measured reverts since the keep plus one). The scalar floor widens to noise × z(1 − 0.025/m) / z(0.975),
 * McNemar needs one-sided p below 0.025/m, and a paired CI's lower bound is taken at the same corrected level.
 * The --simpler "not worse" check stays uncorrected, which is the strict side. `exp` prints m as `comparisons`.
 *
 * Paired keeps on runs. A --from-run keep compares per case with the incumbent run (the last keep, else
 * the baseline): exact McNemar on 0/1 cases, the paired 95% CI (Assay Stats.pairedDiff) otherwise.
 * --simpler keeps a tie (not significantly worse, within the noise floor of the best) when the change
 * removed material: --after must have fewer non-blank lines than --before.
 *
 * Budget and stop (1.4.0). `start --budget <n>` caps the experiments a climb may record and `--budget-reads <n>` the
 * candidate reads of test and screen (baseline and close reads never count). Once either is spent, `exp` and `screen` refuse
 * (a screened-out candidate, which reads nothing, still records while only reads are spent); `plateau`, `status` and `exp` report
 * the budget. `close` refuses without `--stop`: plateau needs plateau's verdict plateaued, budget a spent budget, target a
 * keep, abort a `--reason`, and reviewed (a Loop, whose passes the principal reviewed in its ISA) a climb with no `exp` rows
 * and a `--reason` carrying the measured delta. A `baseline --force` needs `--reason` and keeps the replaced baseline in baseline_history,
 * which close lists in its result.
 *
 * Rosters and kinds (1.4.0). An `exp --generation` row names an origin on that generation's roster (recorded by Population.ts),
 * and must be the measured proposal's own; with no --origin it takes the proposal's. A proposer's word for a kind outside the
 * seven goes in `--kind-as-proposed`, beside the canonical `--kind` it maps to; the list stays seven.
 *
 * The experiment discipline follows Anthropic's eval hill-climbing guide (Claude Code's bundled
 * `/claude-api hillclimb`, shared/evals/eval-hillclimb.md): prove the eval can see the win before
 * round 1, score a held-out split recomputed from raw per-case rows, keep only gains above the noise
 * floor on an unchanged instrument, distrust implausible jumps, and categorize stalls before grinding.
 *
 * Judged climbs (ArtDirection Critique.json readings) use a paired rule instead of a scalar floor:
 * each arm's k readings are averaged per sample, samples pair by index and per vendor, and a keep
 * needs the 95% CI lower bound of the mean paired difference (Assay Stats.pairedDiff) above zero.
 * Paired samples whose times differ by more than 0.05 s are refused, the parent must be the incumbent
 * film (baseline, else the last kept one), and a bare --value is refused on such a climb.
 *
 * @version 1.4.0
 */

import { appendFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { invariant } from "../../../LIFEOS/TOOLS/Invariant.ts";
import { pairedDiff } from "../../Assay/Tools/Stats.ts";
import { getClaudeDir } from "../../../LIFEOS/TOOLS/Paths.ts";

// ── paths ────────────────────────────────────────────────────────────────────

export const configRoot = (): string => getClaudeDir();
export const ledgerDir = (): string => process.env.HILLCLIMB_DIR ?? join(configRoot(), "LIFEOS/MEMORY/STATE/HillClimb");
const erratav4Dir = (): string => join(process.env.ERRATA_DIR ?? join(configRoot(), "LIFEOS/USER/ERRATA"), "v4");

// ── types ────────────────────────────────────────────────────────────────────

export const TYPES = ["skill", "workflow", "eval", "isa", "prompt", "rule", "metric", "miss"] as const;
export type TargetType = (typeof TYPES)[number];
export type Direction = "higher" | "lower";

/** The workflow that climbs each target type. */
export const WORKFLOW: Record<TargetType, string> = {
  skill: "Skill", workflow: "Workflow", eval: "Eval", isa: "IsaClimb", prompt: "Prompt", rule: "Prompt", metric: "Metric", miss: "Miss",
};

/** The kind of change an experiment made. Plateau needs reverts across several kinds, not one knob turned many ways. */
export const KINDS = ["knob", "wording", "rule", "structure", "delete", "add", "import"] as const;
export type Kind = (typeof KINDS)[number];
/** Reverts since the last keep must span this many kinds before the climb may call itself plateaued. */
export const MIN_KINDS = 3;

/**
 * A proposer's word for a kind outside the seven is kept beside the canonical kind it was mapped to, never added
 * to the list: it needs a canonical kind, is one line, and is not itself one of the seven.
 */
export function assertKindAsProposed(kind: string | null, asProposed: string | null): void {
  if (asProposed === null || asProposed === undefined) return;
  const w = asProposed.trim();
  if (!w || /[\r\n]/.test(w)) throw new Refusal("kind-as-proposed is one non-empty line: the proposer's own word for the kind");
  if ((KINDS as readonly string[]).includes(w.toLowerCase())) throw new Refusal(`kind-as-proposed "${w}" is already one of the seven kinds; pass it as --kind`);
  if (kind === null || !(KINDS as readonly string[]).includes(kind)) throw new Refusal(`kind-as-proposed "${w}" maps onto a canonical kind; pass --kind <${KINDS.join("|")}> beside it`);
}

/**
 * Cases split once, at random by seed, never by baseline score. Test is scored every round and is the headline.
 * Screen (optional) ranks candidates without spending test reads; holdout (optional) is read once, at close.
 * Splits written before 1.3.0 lack screen and holdout; they read as empty.
 */
export interface Split { seed: string; train: string[]; test: string[]; directional: boolean; screen?: string[]; holdout?: string[] }

/** The baseline's holdout reading: its value, case count and per-case scores, compared with the final system at close. */
export interface HoldoutScore { value: number; n: number; cases: Record<string, number> }

export interface Climb {
  v: 1;
  id: string;
  type: TargetType;
  target: string;
  why: string;
  skill: string | null;
  metric: { name: string; direction: Direction };
  created: string;
  status: "open" | "closed" | "verified";
  baseline: {
    value: number; train: number | null; source: string; at: string; checks: number | null; served_model: string | null;
    /** 1.3.0 run baselines: the screen score, per-case scores on train/test/screen (never holdout), and the holdout reading. */
    screen?: number | null; cases?: Record<string, number> | null; holdout?: HoldoutScore | null;
  } | null;
  /** Half-width of the 95% interval on the headline value. A keep must clear it. */
  noise: { value: number; source: string } | null;
  ceiling: number | null;
  min_win: number | null;
  split: Split | null;
  /** sha256 over the files that define the measurement (suite, judge prompts, grader). A change breaks comparability. */
  instrument: { paths: string[]; sha256: string } | null;
  /** The run field a --from-run baseline scored; every later run read on the climb scores the same field, or the series changes. */
  field: RunField | null;
  /** Set when the baseline came from Critique.json readings; the climb then keeps only on the paired rule. */
  critique: CritiqueBaseline | null;
  stalls: Stall[];
  /** 1.4.0: the experiment and held-out read budget set at start; null when none was set. */
  budget: Budget | null;
  /** 1.4.0: every baseline a --force replaced, with when and why. */
  baseline_history: BaselineReplacement[];
  upgrade_id: string | null;
  closed_at: string | null;
  result: {
    baseline: number; best: number; delta: number; noise: number | null; experiments: number; kept: number; changes: Array<{ n: number; hypothesis: string; tag: Tag }>;
    /** 1.3.0: the holdout delta beside the test delta, and the read counts at close. */
    holdout?: HoldoutResult | null; reads?: ReadCounts;
    /** 1.4.0: why the climb stopped, the budget as it stood, and every replaced baseline. */
    stop?: StopRecord; budget?: BudgetState; baseline_history?: BaselineReplacement[];
  } | null;
  verify: { at: string; verdict: VerifyVerdict; before: number | null; after: number | null } | null;
}

/** REQUIRED fixes something broken; TUNE is a judgment call the principal could decline. */
export type Tag = "required" | "tune";

export interface Experiment {
  n: number;
  at: string;
  hypothesis: string;
  /** The test headline; null on a screened-out candidate, which was never read on test. */
  value: number | null;
  /** kept, reverted, or screened (cut before any test read). Rows written before it read from `kept`. */
  outcome: Outcome;
  /** The Population.ts generation this experiment measured, and the proposal id within it. */
  generation: number | null;
  proposal: string | null;
  /** m, the candidates read on test since the last keep, that this keep's significance was corrected for. */
  comparisons: number | null;
  train: number | null;
  kept: boolean;
  tag: Tag | null;
  ref: string | null;
  checks: number | null;
  served_model: string | null;
  flags: string[];
  note: string | null;
  /** The paired comparison against the incumbent, on judged climbs only. */
  paired: PairedSummary | null;
  /** The child film's readings, on judged climbs only; the next experiment's parent must be this film. */
  critique: { files: string[]; artifact_sha256: string } | null;
  /** 1.3.0 population fields; rows written earlier read as null / empty. */
  kind: Kind | null;
  /** 1.4.0: the proposer's own word for a kind outside the seven, kept beside the canonical kind it was mapped to. */
  kind_as_proposed: string | null;
  origin: string | null;
  /** Experiments this one was built from; 0 is the baseline; empty means the incumbent. */
  parents: number[];
  /** Per-case scores on train, test and screen (never holdout), from a --from-run measurement. */
  cases: Record<string, number> | null;
  /** The per-case comparison against the incumbent run, on --from-run experiments. */
  paired_cases: CasePairs | null;
  /** Non-blank line counts before and after a --simpler change. */
  simpler: { before: number; after: number } | null;
  /** Set on a revert that beat the incumbent on train: where the variant lives, kept for recombination. */
  archive: ArchiveEntry | null;
}

export type Outcome = "kept" | "reverted" | "screened";

/** A limit on experiments recorded and on candidate reads of test and screen. Baseline and close reads never count. */
export interface Budget { experiments: number | null; reads: number | null }
export interface BudgetLine { limit: number; used: number; left: number }
export interface BudgetState { experiments: BudgetLine | null; reads: BudgetLine | null; spent: boolean; spent_on: Array<"experiments" | "reads"> }

/** A baseline a --force replaced: the old reading in full, the floor it carried, and the stated reason. */
export interface BaselineReplacement {
  replaced_at: string; reason: string; baseline: NonNullable<Climb["baseline"]>;
  noise: Climb["noise"]; ceiling: number | null; min_win: number | null; instrument_sha256: string | null; critique_sha256: string | null;
}

/**
 * Why a climb stopped. plateau needs plateau's verdict, budget a spent budget, target a keep, abort a reason, and reviewed
 * (a Loop: passes reviewed by the principal and recorded in its ISA, not as exp rows) no exp rows plus a reason with the delta.
 */
export const STOP_REASONS = ["plateau", "target", "budget", "abort", "reviewed"] as const;
export type StopReason = (typeof STOP_REASONS)[number];
export interface StopInput { reason: StopReason; note?: string | null; window?: number }
export interface StopRecord { reason: StopReason; note: string | null; at: string }

/** A near-miss kept for recombination. `stored` is relative to the climb's ledger directory. */
export interface ArchiveEntry { path: string | null; stored: string | null; ref: string | null; sha256: string | null }

/** A per-case paired comparison of a candidate run against the incumbent run, oriented so a positive gain is better. */
export interface CasePairs {
  against: number; n: number; mean_gain: number; ci95_lo: number; ci95_hi: number;
  wins: number; losses: number; test: "mcnemar" | "paired-ci";
  p_better: number | null; p_worse: number | null;
  better: boolean; worse: boolean;
  /** Bonferroni: m comparisons, so "better" is judged at one-sided level 0.025/m (McNemar) or the matching CI bound. */
  m: number; alpha: number; ci_lo_corrected: number;
}

export interface HoldoutResult { baseline: number; final: number; delta: number; n: number; paired: CasePairs | null }

export type ReadSplit = "test" | "screen" | "holdout";
export interface ReadCounts { test: number; test_distinct: number; screen: number; holdout: number; untracked: number }

/** Step 4.5 of the Anthropic hillclimb guide, mapped onto our instruments. */
export const STALL_BUCKETS = ["artifact", "grader", "harness", "structural", "variance"] as const;
export type StallBucket = (typeof STALL_BUCKETS)[number];
export interface Stall { at: string; after_experiment: number; after_generation?: number | null; counts: Record<StallBucket, number>; note: string | null }
export const STALL_ROUTE: Record<StallBucket, string> = {
  artifact: "keep climbing the target; these are its real gaps",
  grader: "climb the instrument (Eval intent): read the judge's reasoning, get principal labels (LabelBatch), recalibrate, re-grade every variant from stored outputs",
  harness: "fix the runner or infra (Workflow intent); drop errored cases from the denominator until fixed",
  structural: "reorganize the target (consolidate duplicated facts, split a monolith, fix routing) instead of adding content",
  variance: "you are at the noise floor; add cases from real misses (FailureToCase) or trials, or report best-so-far",
};

export type VerifyVerdict = "improved" | "no-change" | "worse" | "insufficient-data";

// ── ledger ───────────────────────────────────────────────────────────────────

const climbPath = (id: string) => join(ledgerDir(), id, "climb.json");
const expPath = (id: string) => join(ledgerDir(), id, "experiments.jsonl");

export function loadClimb(id: string): Climb | null {
  if (!/^hc-[a-z0-9-]+$/.test(id) || !existsSync(climbPath(id))) return null;
  const c = JSON.parse(readFileSync(climbPath(id), "utf-8")) as Partial<Climb>;
  // Climbs written by v1.0.0 lack the eval-discipline fields; they read as unset, never as zero.
  return { noise: null, ceiling: null, min_win: null, split: null, instrument: null, field: null, critique: null, stalls: [], budget: null, baseline_history: [], ...c } as Climb;
}

export function loadExperiments(id: string): Experiment[] {
  if (!existsSync(expPath(id))) return [];
  return readFileSync(expPath(id), "utf-8").split("\n").filter(Boolean)
    .map((l) => ({
      train: null, tag: null, served_model: null, flags: [], paired: null, critique: null,
      kind: null, kind_as_proposed: null, origin: null, parents: [], cases: null, paired_cases: null, simpler: null, archive: null,
      generation: null, proposal: null, comparisons: null,
      ...(JSON.parse(l) as Partial<Experiment>),
    }) as Experiment)
    .map((e) => ({ ...e, outcome: e.outcome ?? (e.kept ? "kept" : "reverted") }));
}

// ── reads: every look at test, screen or holdout, refused keeps included ─────

const readsPath = (id: string) => join(ledgerDir(), id, "reads.jsonl");
const READ_SPLITS: readonly ReadSplit[] = ["test", "screen", "holdout"];

export type ReadRole = "baseline" | "candidate" | "close";
export interface ReadRow { at: string; split: ReadSplit; source: string; hypothesis: string | null; role?: ReadRole; after?: number; generation?: number | null }

/**
 * Appends one read before its result is shown to anyone, so a refused keep still counts.
 * `after` is how many experiments the ledger held at the time, which places the read relative to the last keep.
 */
function appendRead(id: string, r: { split: ReadSplit; source: string; hypothesis: string | null; role: ReadRole; after: number; generation?: number | null }): void {
  invariant(/^hc-[a-z0-9-]+$/.test(id), `climb id malformed: ${id}`);
  invariant(READ_SPLITS.includes(r.split), `a read is of test, screen or holdout, not ${r.split}`);
  invariant(r.source.trim().length > 0, "a read names what was measured");
  invariant(Number.isInteger(r.after) && r.after >= 0, "a read records how many experiments preceded it");
  mkdirSync(join(ledgerDir(), id), { recursive: true });
  appendFileSync(readsPath(id), JSON.stringify({ at: new Date().toISOString(), ...r }) + "\n", { mode: 0o600 });
}

export function loadReads(id: string): ReadRow[] {
  return existsSync(readsPath(id)) ? readFileSync(readsPath(id), "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as ReadRow) : [];
}

/**
 * Pure over the ledger: m, the distinct candidates read on test since the last keep. Called inside
 * recordExperiment after the candidate's own read is logged, so there it includes the candidate.
 * A run is one candidate however often it is re-recorded (its source carries the run's hash); a bare value
 * is one candidate per hypothesis. When the log holds test reads written before reads were placed
 * (no `after`), they cannot be placed, so m never falls below the measured reverts since the keep plus one.
 */
export function candidatesSinceKeep(id: string, exps: Experiment[]): number {
  const lastKeep = exps.filter((e) => e.kept).at(-1)?.n ?? 0;
  const test = loadReads(id).filter((r) => r.split === "test" && r.role !== "baseline" && r.hypothesis !== "baseline" && r.role !== "close");
  const rows = test.filter((r) => typeof r.after === "number" && r.after >= lastKeep);
  const keys = new Set(rows.map((r) => (r.source.includes(" sha256:") ? r.source : `${r.hypothesis ?? ""}\u0000${r.source}`)));
  const unplaced = test.some((r) => typeof r.after !== "number");
  const reverts = exps.filter((e) => e.n > lastKeep && e.outcome === "reverted").length;
  return Math.max(1, keys.size, unplaced ? reverts + 1 : 0);
}

/** Pure: the standard normal quantile (Acklam's rational approximation, |error| < 1.2e-9 after one Newton step). */
export function normInv(p: number): number {
  invariant(p > 0 && p < 1, `normInv takes p in (0, 1), got ${p}`);
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const cc = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const lo = 0.02425;
  let x: number;
  if (p < lo) { const q = Math.sqrt(-2 * Math.log(p)); x = (((((cc[0] * q + cc[1]) * q + cc[2]) * q + cc[3]) * q + cc[4]) * q + cc[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  else if (p > 1 - lo) { const q = Math.sqrt(-2 * Math.log(1 - p)); x = -(((((cc[0] * q + cc[1]) * q + cc[2]) * q + cc[3]) * q + cc[4]) * q + cc[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  else { const q = p - 0.5, r = q * q; x = (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1); }
  // One Newton step on the error function sharpens the tails.
  const e = 0.5 * erfc(-x / Math.SQRT2) - p;
  const u = e * Math.sqrt(2 * Math.PI) * Math.exp((x * x) / 2);
  return x - u / (1 + (x * u) / 2);
}

function erfc(x: number): number {
  const z = Math.abs(x), t = 1 / (1 + 0.5 * z);
  const r = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
  return x >= 0 ? r : 2 - r;
}

/** How much wider a 95% interval gets under a Bonferroni correction for m comparisons: z(1 − 0.025/m) / z(0.975). */
export function bonferroniWiden(m: number): number {
  invariant(Number.isInteger(m) && m >= 1, `m is a positive integer, got ${m}`);
  return m === 1 ? 1 : normInv(1 - PAIRED_ALPHA / m) / normInv(1 - PAIRED_ALPHA);
}

/**
 * Pure over the ledger: reads per split. `test_distinct` counts distinct measured inputs (the same run
 * re-recorded after a refusal is one look). `untracked` is the lower bound of test reads made before
 * 1.3.0 logged them: baseline plus experiments, less the logged test reads.
 */
export function readCounts(id: string): ReadCounts {
  const rows = loadReads(id);
  const test = rows.filter((r) => r.split === "test");
  const c = loadClimb(id);
  // A screened-out candidate was never read on test, so it is not an untracked read either.
  const recorded = loadExperiments(id).filter((e) => e.outcome !== "screened").length + (c?.baseline ? 1 : 0);
  return {
    test: test.length, test_distinct: new Set(test.map((r) => r.source)).size,
    screen: rows.filter((r) => r.split === "screen").length, holdout: rows.filter((r) => r.split === "holdout").length,
    untracked: Math.max(0, recorded - test.length),
  };
}

/** A candidate read: a look at test or screen made for a candidate, never the baseline's or the close's. */
const isCandidateRead = (r: ReadRow) => (r.split === "test" || r.split === "screen") && r.role !== "baseline" && r.role !== "close" && r.hypothesis !== "baseline" && r.hypothesis !== "close";

/** Pure over the ledger: what the climb's budget allows and what it has used. Experiments count every recorded row. */
export function budgetState(c: Climb, exps: Experiment[] = loadExperiments(c.id)): BudgetState {
  const b = c.budget ?? null;
  const line = (limit: number | null | undefined, used: number): BudgetLine | null => (limit === null || limit === undefined ? null : { limit, used, left: Math.max(0, limit - used) });
  const experiments = line(b?.experiments, exps.length);
  const reads = line(b?.reads, loadReads(c.id).filter(isCandidateRead).length);
  const spent_on = [...(experiments && experiments.left === 0 ? ["experiments" as const] : []), ...(reads && reads.left === 0 ? ["reads" as const] : [])];
  return { experiments, reads, spent: spent_on.length > 0, spent_on };
}

/**
 * Refuses once the budget is spent: any experiment when the experiment budget is used up, and any candidate read
 * of test or screen when the read budget is. Runs before the read is logged, so a refused call costs nothing.
 */
export function assertBudget(c: Climb, exps: Experiment[], reads: boolean): void {
  const st = budgetState(c, exps);
  if (st.experiments && st.experiments.left === 0) throw new Refusal(`budget spent: ${st.experiments.used} of ${st.experiments.limit} experiments recorded; close with --stop budget`);
  if (reads && st.reads && st.reads.left === 0) throw new Refusal(`budget spent: ${st.reads.used} of ${st.reads.limit} candidate reads of test and screen; close with --stop budget (a screened-out candidate, which reads nothing, may still be recorded)`);
}

// ── measurement: split, raw-run scoring, noise floor, preflight ──────────────

const sha256 = (s: string | Uint8Array) => new Bun.CryptoHasher("sha256").update(s).digest("hex");

/**
 * Deterministic split by seed. Order comes from a hash of seed+id, so it never depends on scores.
 * The holdout takes the first slice of that order, the screen the next, and train/test split the rest;
 * with both fractions zero the result is identical to 1.2.0's.
 */
export function seededSplit(ids: string[], seed: string, trainFrac = 0.5, minSplit = 10, o: { screenFrac?: number; holdoutFrac?: number } = {}): Split {
  const sf = o.screenFrac ?? 0;
  const hf = o.holdoutFrac ?? 0;
  if (!(sf >= 0 && hf >= 0 && sf + hf < 0.8)) throw new Refusal(`screen (${sf}) and holdout (${hf}) fractions must be non-negative and leave at least 20% for train and test`);
  const uniq = [...new Set(ids)];
  if (uniq.length < minSplit) {
    if (sf > 0 || hf > 0) throw new Refusal(`${uniq.length} cases is under --min-split ${minSplit}: too few to set aside a screen or holdout split`);
    return { seed, train: [], test: uniq.sort(), directional: true, screen: [], holdout: [] };
  }
  const ordered = [...uniq].sort((a, b) => sha256(seed + a).localeCompare(sha256(seed + b)));
  const nH = hf > 0 ? Math.max(1, Math.round(uniq.length * hf)) : 0;
  const nS = sf > 0 ? Math.max(1, Math.round(uniq.length * sf)) : 0;
  const rest = ordered.slice(nH + nS);
  if (rest.length < 2) throw new Refusal(`after a holdout of ${nH} and a screen of ${nS}, ${rest.length} case(s) remain; train and test need at least one each`);
  const nTrain = Math.min(rest.length - 1, Math.max(1, Math.round(rest.length * trainFrac)));
  return {
    seed, train: rest.slice(0, nTrain).sort(), test: rest.slice(nTrain).sort(), directional: false,
    screen: ordered.slice(nH, nH + nS).sort(), holdout: ordered.slice(0, nH).sort(),
  };
}

export type RunField = "pass_to_k" | "mean_score";

/**
 * The field a run read on this climb scores. A climb whose baseline came from a run keeps that field for every
 * later read: pass_to_k and mean_score are different series, so a different --field is refused, never compared.
 * Climbs baselined before the field was recorded read pass_to_k unless told otherwise, as they always did.
 */
export function climbField(c: Climb, asked?: string | null): RunField {
  if (asked != null && asked !== "pass_to_k" && asked !== "mean_score") throw new Refusal("--field must be pass_to_k or mean_score");
  if (c.field && asked != null && asked !== c.field) throw new Refusal(`climb ${c.id}'s baseline scored ${c.field}, so a ${asked} read is a different series; drop --field or open a new climb`);
  return c.field ?? (asked as RunField | null | undefined) ?? "pass_to_k";
}

/** The shape of an Assay EvalRunner run.json that HillClimb reads. */
export interface RunFile { run_id?: string; agent_model?: string | null; cases: Array<{ id: string; pass_to_k?: number; mean_score?: number; infra_errors?: number }> }

export interface RunScore {
  test: number; train: number | null; noise: number; n_test: number; excluded: string[]; served_model: string | null; run_id: string | null;
  /** Screen score and its noise, when the split has a screen. */
  screen: number | null; screen_noise: number | null; n_screen: number;
  /** Per-case scores on train, test and screen. Holdout cases are never read here. */
  cases: Record<string, number>;
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

/** Mean and 95% half-width, floored at 0.5/sqrt(n) for 0–1 metrics so a tiny set cannot look precise. */
function meanAndNoise(t: number[]): { mean: number; noise: number } {
  const m = mean(t);
  const sd = t.length > 1 ? Math.sqrt(t.reduce((a, x) => a + (x - m) ** 2, 0) / (t.length - 1)) : 0;
  const bounded = t.every((x) => x >= 0 && x <= 1);
  return { mean: m, noise: Math.max(1.96 * (sd / Math.sqrt(t.length)), bounded ? 0.5 / Math.sqrt(t.length) : 0) };
}

const runValues = (run: RunFile, field: "pass_to_k" | "mean_score") =>
  new Map(run.cases.filter((c) => (c.infra_errors ?? 0) === 0 && typeof c[field] === "number").map((c) => [c.id, c[field] as number]));

/**
 * Pure: the headline recomputed from raw per-case rows, never from an aggregate field.
 * Cases with infra errors leave the denominator and are listed. Holdout cases in the run are ignored.
 */
export function scoreRun(run: RunFile, split: Split, field: "pass_to_k" | "mean_score" = "pass_to_k"): RunScore {
  const excluded = run.cases.filter((c) => (c.infra_errors ?? 0) > 0).map((c) => c.id);
  const val = runValues(run, field);
  const holdout = new Set(split.holdout ?? []);
  const pick = (ids: string[]) => ids.filter((id) => val.has(id)).map((id) => val.get(id)!);
  const testIds = split.directional ? [...val.keys()].filter((id) => !holdout.has(id)) : split.test;
  const t = pick(testIds);
  invariant(t.length > 0, `run ${run.run_id ?? "?"} has no scorable ${split.directional ? "" : "test "}cases`);
  const tr = split.directional ? [] : pick(split.train);
  const sc = split.directional ? [] : pick(split.screen ?? []);
  const { mean: m, noise } = meanAndNoise(t);
  const scoredIds = split.directional ? testIds : [...split.train, ...split.test, ...(split.screen ?? [])];
  const cases = Object.fromEntries(scoredIds.filter((id) => val.has(id)).map((id) => [id, val.get(id)!]));
  invariant(Object.keys(cases).every((id) => !holdout.has(id)), "a holdout case leaked into a per-round score");
  const s = sc.length ? meanAndNoise(sc) : null;
  return {
    test: +m.toFixed(6), train: tr.length ? +mean(tr).toFixed(6) : null, noise: +noise.toFixed(6), n_test: t.length, excluded,
    served_model: run.agent_model ?? null, run_id: run.run_id ?? null,
    screen: s ? +s.mean.toFixed(6) : null, screen_noise: s ? +s.noise.toFixed(6) : null, n_screen: sc.length, cases,
  };
}

/** What `screen` reads from a run: the screen cases and nothing else. */
export interface ScreenScore { screen: number | null; screen_noise: number | null; n_screen: number; excluded: string[]; served_model: string | null; run_id: string | null }

/**
 * Pure: the screen cases of a run, scored. It never computes a test or train number, so a run of only the
 * screen cases is enough and a screen look can never become an unlogged test read.
 */
export function scoreScreen(run: RunFile, split: Split, field: "pass_to_k" | "mean_score" = "pass_to_k"): ScreenScore {
  const val = runValues(run, field);
  const ids = (split.screen ?? []).filter((id) => val.has(id));
  const xs = ids.map((id) => val.get(id)!);
  const s = xs.length ? meanAndNoise(xs) : null;
  const screenSet = new Set(split.screen ?? []);
  return {
    screen: s ? +s.mean.toFixed(6) : null, screen_noise: s ? +s.noise.toFixed(6) : null, n_screen: xs.length,
    excluded: run.cases.filter((c) => (c.infra_errors ?? 0) > 0 && screenSet.has(c.id)).map((c) => c.id),
    served_model: run.agent_model ?? null, run_id: run.run_id ?? null,
  };
}

/** Pure: the holdout cases of a run, scored. Called only at baseline and at close. */
export function scoreHoldout(run: RunFile, split: Split, field: "pass_to_k" | "mean_score" = "pass_to_k"): HoldoutScore {
  const val = runValues(run, field);
  const ids = (split.holdout ?? []).filter((id) => val.has(id));
  invariant(ids.length > 0, `run ${run.run_id ?? "?"} has no scorable holdout cases`);
  const cases = Object.fromEntries(ids.map((id) => [id, val.get(id)!]));
  return { value: +mean(ids.map((id) => cases[id])).toFixed(6), n: ids.length, cases };
}

// ── paired per-case comparison of two runs ───────────────────────────────────

/** Pure: P(X >= k) for X ~ Binomial(n, 1/2), summed in log space so large suites do not underflow. */
export function binomUpperTail(k: number, n: number): number {
  invariant(Number.isInteger(k) && Number.isInteger(n) && n >= 0, "binomial tail takes integer counts");
  if (k <= 0) return 1;
  if (k > n) return 0;
  const logs: number[] = [];
  let lt = n * Math.log(0.5);
  for (let i = 0; i <= n; i++) {
    if (i >= k) logs.push(lt);
    lt += Math.log((n - i) / (i + 1));
  }
  const mx = Math.max(...logs);
  return Math.min(1, Math.exp(mx) * logs.reduce((s, l) => s + Math.exp(l - mx), 0));
}

/** One-sided level for each direction, matching a two-sided 95% interval. */
export const PAIRED_ALPHA = 0.025;

/**
 * Pure: the candidate against the incumbent over the cases both scored, gain oriented by direction.
 * 0/1 cases use exact McNemar on the discordant pairs; other scores use Assay's pairedDiff 95% CI.
 * Null when fewer than two cases pair, so the caller can fall back and say so.
 */
export function pairCases(incumbent: Record<string, number>, candidate: Record<string, number>, ids: string[], direction: Direction, against: number, m = 1): CasePairs | null {
  invariant(Number.isInteger(m) && m >= 1, `comparisons m is a positive integer, got ${m}`);
  const has = (o: Record<string, number>, id: string) => Object.prototype.hasOwnProperty.call(o, id);
  const common = ids.filter((id) => has(incumbent, id) && has(candidate, id));
  if (common.length < 2) return null;
  const a = common.map((id) => (direction === "higher" ? incumbent[id] : candidate[id]));
  const b = common.map((id) => (direction === "higher" ? candidate[id] : incumbent[id]));
  const r = pairedDiff(a, b);
  const wins = b.filter((x, i) => x > a[i]).length;
  const losses = b.filter((x, i) => x < a[i]).length;
  const binary = [...a, ...b].every((x) => x === 0 || x === 1);
  const pB = binary ? binomUpperTail(wins, wins + losses) : null;
  const pW = binary ? binomUpperTail(losses, wins + losses) : null;
  const alpha = PAIRED_ALPHA / m;
  const loM = r.mean_diff - bonferroniWiden(m) * (r.mean_diff - r.ci95_lo);
  return {
    against, n: r.n, mean_gain: round6(r.mean_diff), ci95_lo: round6(r.ci95_lo), ci95_hi: round6(r.ci95_hi), wins, losses,
    test: binary ? "mcnemar" : "paired-ci", p_better: pB === null ? null : round6(pB), p_worse: pW === null ? null : round6(pW),
    // Better is corrected for m comparisons; worse stays at the uncorrected level, the strict side for a tie.
    better: binary ? pB! < alpha : loM > 0,
    worse: binary ? pW! < PAIRED_ALPHA : r.ci95_hi < 0,
    m, alpha: round6(alpha), ci_lo_corrected: round6(loM),
  };
}

/** The incumbent's per-case scores: the last keep's, else the baseline's. Null when it has none (a --value keep, a pre-1.3.0 baseline). */
function incumbentCases(c: Climb, exps: Experiment[]): { n: number; cases: Record<string, number> } | null {
  const last = exps.filter((e) => e.kept).at(-1);
  if (last) return last.cases ? { n: last.n, cases: last.cases } : null;
  return c.baseline?.cases ? { n: 0, cases: c.baseline.cases } : null;
}

// ── material size, for --simpler ─────────────────────────────────────────────

const SKIP_DIRS = new Set([".git", "node_modules"]);

function walkFiles(p: string, out: string[] = []): string[] {
  const st = lstatSync(p);
  if (st.isSymbolicLink()) return out;
  if (st.isFile()) { out.push(p); return out; }
  if (st.isDirectory()) for (const f of readdirSync(p).sort()) if (!SKIP_DIRS.has(f)) walkFiles(join(p, f), out);
  return out;
}

/** Non-blank lines across a file or a directory tree; binary files (a NUL byte) count zero. */
export function materialSize(path: string): number {
  invariant(existsSync(path), `no such file or directory: ${path}`);
  let n = 0;
  for (const f of walkFiles(path)) {
    const buf = readFileSync(f);
    if (buf.includes(0)) continue;
    n += buf.toString("utf-8").split("\n").filter((l) => l.trim().length > 0).length;
  }
  return n;
}

export function instrumentHash(paths: string[]): { paths: string[]; sha256: string } {
  const sorted = [...paths].sort();
  const h = new Bun.CryptoHasher("sha256");
  for (const p of sorted) { invariant(existsSync(p), `instrument file missing: ${p}`); h.update(p).update(readFileSync(p)); }
  return { paths: sorted, sha256: h.digest("hex") };
}

/** Can this measurement show the win at all? Noise must sit below the headroom and below the smallest win worth having. */
export function preflight(c: Climb): { climbable: boolean; noise: number | null; headroom: number | null; min_win: number | null; directional: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const noise = c.noise?.value ?? null;
  const base = c.baseline?.value ?? null;
  const headroom = c.ceiling !== null && base !== null ? (c.metric.direction === "higher" ? c.ceiling - base : base - c.ceiling) : null;
  if (base === null) reasons.push("no baseline yet");
  // A judged climb's floor is the paired CI computed per experiment, so it needs no scalar noise.
  if (noise === null && !c.critique) reasons.push("no noise floor recorded; measure one (baseline --from-run, or --noise with its source)");
  if (noise !== null && headroom !== null && noise >= headroom) reasons.push(`noise ±${noise} is not below the headroom ${+headroom.toFixed(6)}; no change can show as a win`);
  if (noise !== null && c.min_win !== null && noise > c.min_win) reasons.push(`noise ±${noise} is above the smallest win worth having (${c.min_win}); add cases or trials first`);
  return { climbable: reasons.length === 0, noise, headroom: headroom === null ? null : +headroom.toFixed(6), min_win: c.min_win, directional: c.split?.directional ?? false, reasons };
}

function saveClimb(c: Climb): void {
  invariant(c.v === 1 && /^hc-[a-z0-9-]+$/.test(c.id), `climb id malformed: ${c.id}`);
  invariant((TYPES as readonly string[]).includes(c.type), `climb ${c.id} has unknown type ${c.type}`);
  invariant(c.metric.direction === "higher" || c.metric.direction === "lower", `climb ${c.id} has no metric direction`);
  invariant(c.status !== "closed" || c.result !== null, `climb ${c.id} closed without a result`);
  invariant(c.status !== "verified" || c.verify?.verdict === "improved", `climb ${c.id} verified without an improved verdict`);
  if (c.split) {
    // Proposers see train only; that promise holds only while no case sits in two splits.
    const all = [...c.split.train, ...c.split.test, ...(c.split.screen ?? []), ...(c.split.holdout ?? [])];
    invariant(new Set(all).size === all.length, `climb ${c.id} has a case in two splits`);
    invariant(!c.split.directional || ((c.split.screen ?? []).length === 0 && (c.split.holdout ?? []).length === 0), `climb ${c.id} is directional but sets aside screen or holdout cases`);
  }
  if (c.baseline?.cases && c.split?.holdout?.length) {
    const hold = new Set(c.split.holdout);
    invariant(Object.keys(c.baseline.cases).every((id) => !hold.has(id)), `climb ${c.id} baseline per-case scores include holdout cases`);
  }
  mkdirSync(join(ledgerDir(), c.id), { recursive: true });
  writeFileSync(climbPath(c.id), JSON.stringify(c, null, 2) + "\n", { mode: 0o600 });
}

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "target";

export function startClimb(o: { type: TargetType; target: string; metric: string; direction: Direction; why: string; skill?: string | null; now?: Date; budget?: Partial<Budget> | null }): Climb {
  const now = o.now ?? new Date();
  const budget: Budget | null = o.budget && (o.budget.experiments != null || o.budget.reads != null) ? { experiments: o.budget.experiments ?? null, reads: o.budget.reads ?? null } : null;
  for (const [k, v] of Object.entries(budget ?? {})) invariant(v === null || (Number.isInteger(v) && v >= 1), `a ${k} budget is a positive integer, got ${v}`);
  const id = `hc-${now.toISOString().slice(0, 10).replace(/-/g, "")}-${slugify(o.target)}-${crypto.randomUUID().slice(0, 4)}`;
  const c: Climb = {
    v: 1, id, type: o.type, target: o.target, why: o.why, skill: o.skill ?? (o.type === "skill" ? o.target : null),
    metric: { name: o.metric, direction: o.direction }, created: now.toISOString(), status: "open",
    baseline: null, noise: null, ceiling: null, min_win: null, split: null, instrument: null, field: null, critique: null, stalls: [],
    budget, baseline_history: [], upgrade_id: null, closed_at: null, result: null, verify: null,
  };
  invariant(o.why.trim().length >= 8, "a climb names why it is worth climbing (8+ chars)");
  saveClimb(c);
  return c;
}

export interface BaselineOpts {
  value: number; source: string; checks?: number | null; force?: boolean;
  train?: number | null; served_model?: string | null;
  noise?: { value: number; source: string } | null; ceiling?: number | null; min_win?: number | null;
  split?: Split | null; instrument?: { paths: string[]; sha256: string } | null;
  /** The run field a --from-run baseline scored; a scalar or critique baseline has none. */
  field?: RunField | null;
  critique?: CritiqueBaseline | null;
  /** From a run baseline: the screen score, per-case scores (train/test/screen), and the holdout reading. */
  screen?: number | null; cases?: Record<string, number> | null; holdout?: HoldoutScore | null;
  /** What was measured, for the read log (a run path and its hash, or the value). */
  read_source?: string;
  /** Why a --force replaces the standing baseline; required then, and kept in baseline_history. */
  reason?: string | null;
}

export function setBaseline(c: Climb, o: BaselineOpts): Climb {
  if (c.baseline && !o.force) throw new Refusal(`climb ${c.id} already has a baseline (${c.baseline.value}); pass --force to replace it`);
  if (c.status !== "open") throw new Refusal(`climb ${c.id} is ${c.status}`);
  if (o.force && loadExperiments(c.id).length) throw new Refusal(`climb ${c.id} already has experiments; a new baseline would break comparability, so open a new climb`);
  const reason = o.reason?.trim() ?? "";
  if (c.baseline && o.force && !reason) throw new Refusal(`replacing climb ${c.id}'s baseline (${c.baseline.value}) needs --reason "<why the old reading is wrong>"; the old one is kept in baseline_history`);
  invariant(Number.isFinite(o.value), "baseline value must be a finite number");
  if (o.critique && c.metric.direction !== "higher") throw new Refusal(`climb ${c.id} has direction ${c.metric.direction}; critique scores are higher-is-better, so start the climb with --direction higher`);
  invariant(!o.noise || (Number.isFinite(o.noise.value) && o.noise.value >= 0 && o.noise.source.trim().length > 0), "a noise floor is a non-negative number with a stated source");
  const split = o.split !== undefined ? o.split : c.split;
  if (o.holdout && !(split?.holdout ?? []).length) throw new Refusal(`climb ${c.id} has no holdout split, so a holdout reading has nowhere to belong`);
  invariant(!o.holdout || Object.keys(o.holdout.cases).every((id) => split!.holdout!.includes(id)), "the holdout reading scores only holdout cases");
  const rb = { source: o.read_source ?? `value:${o.value}`, hypothesis: "baseline", role: "baseline" as const, after: 0 };
  appendRead(c.id, { split: "test", ...rb });
  if (o.screen !== undefined && o.screen !== null) appendRead(c.id, { split: "screen", ...rb });
  if (o.holdout) appendRead(c.id, { split: "holdout", ...rb });
  if (c.baseline) {
    const prior = c.baseline_history ?? [];
    c.baseline_history = [...prior, {
      replaced_at: new Date().toISOString(), reason, baseline: c.baseline, noise: c.noise, ceiling: c.ceiling, min_win: c.min_win,
      instrument_sha256: c.instrument?.sha256 ?? null, critique_sha256: c.critique?.artifact_sha256 ?? null,
    }];
    invariant(c.baseline_history.length === prior.length + 1, "a replaced baseline is appended to the history, never dropped");
  }
  c.baseline = {
    value: o.value, train: o.train ?? null, source: o.source, at: new Date().toISOString(), checks: o.checks ?? null, served_model: o.served_model ?? null,
    screen: o.screen ?? null, cases: o.cases ?? null, holdout: o.holdout ?? null,
  };
  if (o.noise !== undefined) c.noise = o.noise;
  if (o.ceiling !== undefined) c.ceiling = o.ceiling;
  if (o.min_win !== undefined) c.min_win = o.min_win;
  if (o.split !== undefined) c.split = o.split;
  if (o.instrument !== undefined) c.instrument = o.instrument;
  c.field = o.field ?? null;
  c.critique = o.critique ?? null;
  saveClimb(c);
  return c;
}

const better = (d: Direction, a: number, b: number) => (d === "higher" ? a > b : a < b);

/** A served model counts as changed when the two sides differ, an omitted one included: a missing name cannot show it is the same model. */
const modelChanged = (base: string | null, now: string | null | undefined) => (base ?? null) !== (now ?? null);
const modelName = (m: string | null | undefined) => m ?? "an unnamed model";

/** The value to beat: the best kept experiment, else the baseline. */
export function bestValue(c: Climb, exps: Experiment[]): number {
  invariant(c.baseline !== null, `climb ${c.id} has no baseline`);
  // Judged climbs: each keep beat its parent on the paired rule, so the latest keep is the incumbent.
  // Headline means from different rounds are not on one scale, so they are never compared directly.
  const kept = exps.filter((e): e is Experiment & { value: number } => e.kept && e.value !== null);
  if (c.critique) return kept.at(-1)?.value ?? c.baseline.value;
  return kept.reduce((best, e) => (better(c.metric.direction, e.value, best) ? e.value : best), c.baseline.value);
}

/** Last known standing-check count: the latest experiment that recorded one, else the baseline's. */
function lastChecks(c: Climb, exps: Experiment[]): number | null {
  for (let i = exps.length - 1; i >= 0; i--) if (exps[i].kept && exps[i].checks !== null) return exps[i].checks;
  return c.baseline?.checks ?? null;
}

export class Refusal extends Error {}

export interface ExperimentInput {
  /** The test headline; null only on a screened-out candidate. */
  hypothesis: string; value: number | null; keep: boolean;
  /** Cut before any test read: recorded with value null and no test read, never kept. */
  screened?: boolean;
  /** The Population.ts generation this measures, and the proposal id in it; refused unless the generation holds it. */
  generation?: number | null; proposal?: string | null; train?: number | null; tag?: Tag | null;
  ref?: string | null; checks?: number | null; note?: string | null; served_model?: string | null;
  /** sha256 of the instrument as it stands now; compared with the baseline's. */
  instrument_sha?: string | null;
  /** The principal or a fresh reader looked at the outputs behind a jump too big to trust. */
  spot_checked?: boolean;
  /** A paired comparison of Critique readings against the incumbent; required on judged climbs, refused elsewhere. */
  paired?: PairedCritique | null;
  /** 1.3.0 population fields. */
  kind?: Kind | null; origin?: string | null; parents?: number[];
  /** The proposer's own word for a kind outside the seven; needs the canonical kind it maps to. */
  kind_as_proposed?: string | null;
  /** Per-case scores from a --from-run measurement; a keep then pairs them with the incumbent's. */
  cases?: Record<string, number> | null;
  /** Non-blank line counts before and after; a keep inside the noise floor stands only when after < before. */
  simpler?: { before: number; after: number } | null;
  /** Where the variant lives. Required on a revert that beat the incumbent on train (unless --ref names it). */
  path?: string | null;
  /** What was measured, for the read log (a run path and its hash, or the value). */
  read_source?: string;
}

const signed = (d: Direction, x: number) => (d === "higher" ? x : -x);

/** The incumbent's train score as it stood after `exps`: the last keep's, else the baseline's. Null when unknown. */
function incumbentTrain(c: Climb, exps: Experiment[]): number | null {
  let t = c.baseline?.train ?? null;
  for (const e of exps) if (e.kept) t = e.train;
  return t;
}

/** Pure: each experiment's train delta against the incumbent it was built on, signed so positive is better. */
export function trainDeltas(c: Climb, exps: Experiment[]): Array<number | null> {
  let t = c.baseline?.train ?? null;
  return exps.map((e) => {
    const d = e.train !== null && t !== null ? round6(signed(c.metric.direction, e.train - t)) : null;
    if (e.kept) t = e.train;
    return d;
  });
}

/** Total bytes under a path, stopping early past the cap. */
function treeBytes(p: string, cap: number): number {
  let n = 0;
  for (const f of walkFiles(p)) { n += statSync(f).size; if (n > cap) return n; }
  return n;
}

/** The archive copy is bounded so a mistaken --path (a home directory) cannot fill the ledger. */
export const ARCHIVE_CAP_BYTES = 50 * 1024 * 1024;

/** Copies a near-miss variant into <climb>/archive/<n>/ so it outlives the scratch copy it was built in. */
function storeArchive(id: string, n: number, path: string | null, ref: string | null): ArchiveEntry {
  invariant(path !== null || ref !== null, "an archived variant names a path or a ref");
  if (path === null) return { path: null, stored: null, ref, sha256: null };
  const src = realpathSync(resolve(path));
  const bytes = treeBytes(src, ARCHIVE_CAP_BYTES);
  if (bytes > ARCHIVE_CAP_BYTES) throw new Refusal(`--path ${path} is over ${ARCHIVE_CAP_BYTES / 1024 / 1024} MB; archive the target's files, not a whole tree`);
  const climbDir = join(ledgerDir(), id);
  const dest = join(climbDir, "archive", String(n), basename(src) || "variant");
  invariant(!existsSync(dest), `archive slot ${n} already holds ${dest}`);
  mkdirSync(join(climbDir, "archive", String(n)), { recursive: true });
  cpSync(src, dest, { recursive: true, filter: (s) => !SKIP_DIRS.has(basename(s)) });
  const h = new Bun.CryptoHasher("sha256");
  for (const f of walkFiles(dest)) h.update(relative(dest, f)).update(readFileSync(f));
  return { path: src, stored: relative(climbDir, dest), ref, sha256: h.digest("hex") };
}

export const normHyp = (h: string) => h.toLowerCase().replace(/\s+/g, " ").trim();
export const normOrigin = (o: string) => o.toLowerCase().replace(/\s+/g, " ").trim();
export const generationPath = (id: string, g: number) => join(ledgerDir(), id, "ideate", `gen-${String(g).padStart(3, "0")}.json`);

/** What a generation file says about the proposal an experiment measures, and who was allowed to propose. */
export interface GenerationMember {
  generation: number;
  proposal: { id: string; hypothesis: string; origin: string | null };
  /** Origins on the roster the generation was checked against; null when it recorded none. */
  roster_origins: string[] | null;
  /** The reason a generation was persisted off its roster, when it was. */
  off_roster: string | null;
  /** A generation written before 1.4.0 recorded neither a roster nor an off-roster reason. */
  legacy: boolean;
  /** Origins an experiment of this generation may name. */
  allowed_origins: string[];
}

/**
 * Refuses an experiment that claims generation g unless <climb>/ideate/gen-g.json holds it: the proposal
 * with id `proposal` when one is named, else a proposal whose hypothesis matches (case and spacing ignored).
 * Returns the matched proposal and the origins the generation allows: its roster's, plus its proposals' own
 * when it was persisted off-roster (or, for a pre-1.4.0 file, its proposals' own only).
 */
export function assertGenerationMember(c: Climb, g: number, hypothesis: string, proposal: string | null = null): GenerationMember {
  invariant(Number.isInteger(g) && g >= 1, `a generation is a positive integer, got ${g}`);
  const file = generationPath(c.id, g);
  if (!existsSync(file)) throw new Refusal(`climb ${c.id} has no generation ${g} (${file}); record it with Population.ts generation before measuring its proposals`);
  const real = realpathSync(file);
  const climbDir = realpathSync(join(ledgerDir(), c.id));
  invariant(!relative(climbDir, real).startsWith(".."), `generation file ${real} escapes climb ${climbDir}`);
  const gen = JSON.parse(readFileSync(real, "utf-8")) as {
    proposals?: Array<{ id?: unknown; hypothesis?: unknown; origin?: unknown; build?: { ok?: unknown; exit?: unknown } | null }>;
    roster?: { slots?: Array<{ origin?: unknown }> } | null; off_roster?: unknown;
  };
  const props = gen.proposals ?? [];
  const idx = proposal !== null
    ? props.findIndex((p) => String(p.id ?? "") === proposal)
    : props.findIndex((p) => typeof p.hypothesis === "string" && normHyp(p.hypothesis) === normHyp(hypothesis));
  if (idx < 0) {
    const ids = props.map((p, i) => String(p.id ?? i + 1)).join(", ");
    throw new Refusal(`generation ${g} holds no ${proposal !== null ? `proposal ${proposal}` : `proposal with this hypothesis`} (its proposals: ${ids || "none"}); an experiment measures a proposal of the generation it claims`);
  }
  const hit = props[idx];
  // A proposal the target's validator rejected never became an applicable candidate and is not measured.
  if (hit.build && hit.build.ok === false) {
    throw new Refusal(`proposal ${String(hit.id ?? idx + 1)} of generation ${g} failed the target's build check (failed_build); a proposal that does not build is recorded, never measured`);
  }
  const str = (x: unknown) => (typeof x === "string" && x.trim() ? x.trim() : null);
  const rosterOrigins = gen.roster && Array.isArray(gen.roster.slots) ? gen.roster.slots.map((x) => str(x.origin)).filter((x): x is string => x !== null) : null;
  const offRoster = str(gen.off_roster);
  const legacy = rosterOrigins === null && offRoster === null;
  const own = props.map((p) => str(p.origin)).filter((x): x is string => x !== null);
  const allowed = [...new Set([...(rosterOrigins ?? []), ...(offRoster !== null || legacy ? own : [])])];
  return { generation: g, proposal: { id: String(hit.id ?? idx + 1), hypothesis: String(hit.hypothesis ?? ""), origin: str(hit.origin) }, roster_origins: rosterOrigins, off_roster: offRoster, legacy, allowed_origins: allowed };
}

/**
 * The origin an experiment of a generation records: the one named, which must be on that generation's roster and
 * be the measured proposal's own; else the proposal's own. Refuses an origin the generation never allowed.
 */
export function generationOrigin(m: GenerationMember, origin: string | null | undefined): string {
  const named = origin?.trim() || null;
  const chosen = named ?? m.proposal.origin;
  if (chosen === null) throw new Refusal(`proposal ${m.proposal.id} of generation ${m.generation} names no origin; pass --origin with a slot on that generation's roster`);
  if (!m.allowed_origins.some((o) => normOrigin(o) === normOrigin(chosen))) {
    throw new Refusal(`origin "${chosen}" is not on generation ${m.generation}'s roster (${m.allowed_origins.join(", ") || "none"}); an experiment of a generation names the slot that proposed it`);
  }
  if (named !== null && m.proposal.origin !== null && normOrigin(named) !== normOrigin(m.proposal.origin)) {
    throw new Refusal(`proposal ${m.proposal.id} of generation ${m.generation} came from "${m.proposal.origin}", not "${named}"; record the measurement under the proposer that made it`);
  }
  return chosen;
}

/**
 * The keep rule. A keep must beat the best so far by more than the noise floor, on an unchanged
 * instrument, served by the same model, without removing standing checks; a jump past three times
 * the noise needs a spot check first, because a gamed judge looks exactly like a breakthrough.
 * A --from-run keep is decided per case against the incumbent run instead of by the scalar floor.
 * A --simpler keep may tie (not significantly worse, within the noise of the best) when it removed material.
 * Significance is Bonferroni-corrected over the candidates read on test since the last keep.
 * Every call logs a test read before any refusal can show the number; a screened-out candidate reads none.
 */
export function recordExperiment(c: Climb, e: ExperimentInput): Experiment {
  if (c.status !== "open") throw new Refusal(`climb ${c.id} is ${c.status}; experiments go on open climbs`);
  if (!c.baseline) throw new Refusal(`climb ${c.id} has no baseline; measure one first`);
  assertBudget(c, loadExperiments(c.id), !e.screened);
  invariant(e.proposal === undefined || e.proposal === null || (e.generation !== undefined && e.generation !== null), "a proposal id is named only with its generation");
  if (e.generation !== undefined && e.generation !== null) {
    const member = assertGenerationMember(c, e.generation, e.hypothesis, e.proposal ?? null);
    // Record the proposal's own hypothesis when one is named by id: a supplied text that differs would leave a
    // read whose hypothesis the generation never held, which voidGeneration could not match back to it.
    e = { ...e, origin: generationOrigin(member, e.origin), hypothesis: e.proposal != null && member.proposal.hypothesis.trim() ? member.proposal.hypothesis : e.hypothesis };
  }
  assertKindAsProposed(e.kind ?? null, e.kind_as_proposed ?? null);
  if (e.screened) return recordScreened(c, e);
  invariant(e.value !== null && Number.isFinite(e.value), "experiment value must be a finite number");
  const value: number = e.value;
  invariant(e.kind === undefined || e.kind === null || (KINDS as readonly string[]).includes(e.kind), `kind must be one of ${KINDS.join("|")}`);
  invariant(e.origin === undefined || e.origin === null || (e.origin.trim().length > 0 && !/[\r\n]/.test(e.origin)), "an origin is one non-empty line");
  invariant(!e.simpler || (Number.isInteger(e.simpler.before) && Number.isInteger(e.simpler.after) && e.simpler.before >= 0 && e.simpler.after >= 0), "simpler sizes are non-negative line counts");
  invariant(!e.path || existsSync(e.path), `--path ${e.path} does not exist`);
  if (c.critique && !e.paired) throw new Refusal(`climb ${c.id} is judged: its baseline came from --from-critique, so a bare value cannot be paired. Measure with exp --from-critique <readings> --parent-critique <incumbent readings>`);
  if (!c.critique && e.paired) throw new Refusal(`climb ${c.id} took a scalar baseline; paired readings need a baseline taken with --from-critique`);
  if (c.critique && e.simpler) throw new Refusal(`climb ${c.id} is judged; --simpler ties apply to value and run climbs, and a judged keep stands only on the paired CI`);
  const exps = loadExperiments(c.id);
  const parents = [...new Set(e.parents ?? [])].sort((a, b) => a - b);
  invariant(parents.every((p) => Number.isInteger(p) && p >= 0 && p <= exps.length), `parents name experiments 0..${exps.length} (0 is the baseline)`);
  appendRead(c.id, { split: "test", source: e.read_source ?? `value:${value}`, hypothesis: e.hypothesis, role: "candidate", after: exps.length, generation: e.generation ?? null });
  const m = candidatesSinceKeep(c.id, exps);
  const pop = { kind: e.kind ?? null, kind_as_proposed: e.kind_as_proposed?.trim() || null, origin: e.origin?.trim() ?? null, parents, generation: e.generation ?? null, proposal: e.proposal ?? null, comparisons: m };
  if (c.critique && e.paired) return recordPairedExperiment(c, exps, e, e.paired, pop);
  const best = bestValue(c, exps);
  const gain = signed(c.metric.direction, value - best);
  const noise = c.noise?.value ?? null;
  const floor = noise === null ? null : round6(noise * bonferroniWiden(m));
  const flags: string[] = [];
  if (c.instrument && e.instrument_sha && e.instrument_sha !== c.instrument.sha256) flags.push("instrument-changed");
  if (modelChanged(c.baseline.served_model, e.served_model)) flags.push("served-model-changed");
  if (e.train !== null && e.train !== undefined && c.baseline.train !== null && noise !== null) {
    const trainGain = c.metric.direction === "higher" ? e.train - c.baseline.train : c.baseline.train - e.train;
    const testGain = c.metric.direction === "higher" ? value - c.baseline.value : c.baseline.value - value;
    if (trainGain > noise && testGain <= noise) flags.push("overfit");
  }
  if (noise !== null && gain > 3 * noise && noise > 0) flags.push("implausible-jump");
  let pc: CasePairs | null = null;
  if (e.cases) {
    const inc = incumbentCases(c, exps);
    const ids = !c.split || c.split.directional ? Object.keys(e.cases) : c.split.test;
    pc = inc ? pairCases(inc.cases, e.cases, ids, c.metric.direction, inc.n, m) : null;
    if (!pc) flags.push("unpaired-incumbent");
  }
  const simplerOk = !!e.simpler && e.simpler.after < e.simpler.before;
  if (e.simpler && simplerOk) flags.push("simpler");
  if (e.keep) {
    // A keep needs a measurement that can tell a win from chance: no noise floor, no instrument
    // record, or an unclimbable preflight means the gate could not decide, so it refuses.
    const pf = preflight(c);
    if (noise === null) throw new Refusal("keep refused: no noise floor recorded, so a gain cannot be told from chance. Re-baseline with --from-run or --noise with --noise-source");
    if (!c.instrument) throw new Refusal("keep refused: the baseline recorded no instrument, so a changed judge or suite would go unseen. Re-baseline with --instrument <file>");
    if (!e.instrument_sha) throw new Refusal("keep refused: the current instrument hash was not supplied, so it cannot be compared with the baseline's");
    if (!pf.climbable) throw new Refusal(`keep refused: preflight says this climb cannot show a win (${pf.reasons.join("; ")})`);
    if (e.simpler && !simplerOk) {
      throw new Refusal(`keep refused: --simpler keeps a tie only when the change removes material, but it went from ${e.simpler.before} to ${e.simpler.after} non-blank lines`);
    }
    const won = pc ? pc.better && gain > 0 : gain > floor!;
    const corr = m > 1 ? `, Bonferroni-corrected for ${m} candidates read on test since the last keep` : "";
    if (!won) {
      if (!e.simpler) {
        if (!better(c.metric.direction, value, best)) {
          throw new Refusal(`keep refused: ${c.metric.name}=${value} does not beat ${best} (${c.metric.direction} is better); record it with --revert`);
        }
        if (pc) {
          throw new Refusal(`keep refused: the per-case comparison against ${pc.against === 0 ? "the baseline" : `experiment ${pc.against}`} is inside the noise floor (${pc.test}: ${pc.wins} better, ${pc.losses} worse over ${pc.n} cases${pc.p_better !== null ? `, one-sided p ${pc.p_better} against ${pc.alpha}` : `, corrected gain CI lower bound ${pc.ci_lo_corrected}`}${corr}); the measurement cannot tell it from chance. Record it with --revert, or add cases or trials`);
        }
        throw new Refusal(`keep refused: gain ${+gain.toFixed(6)} is inside the noise floor ±${floor}${m > 1 ? ` (±${noise}${corr})` : ""}; the measurement cannot tell it from chance. Record it with --revert, or add cases or trials`);
      }
      if (gain <= -noise || pc?.worse) {
        throw new Refusal(`keep refused: --simpler keeps a tie, but this is worse than ${best} by more than chance (${pc ? `${pc.test}: ${pc.wins} better, ${pc.losses} worse` : `gain ${+gain.toFixed(6)}, noise ±${noise}`}); record it with --revert`);
      }
    }
    if (flags.includes("instrument-changed")) throw new Refusal("keep refused: the instrument changed since the baseline, so the two numbers are different series. Re-baseline in a new climb");
    if (flags.includes("served-model-changed")) throw new Refusal(`keep refused: served by ${modelName(e.served_model)}, baseline by ${modelName(c.baseline.served_model)}; name the model with --served-model (or measure from a run that records it), or re-baseline in a new climb`);
    if (flags.includes("implausible-jump") && !e.spot_checked) {
      throw new Refusal(`keep refused: a gain of ${+gain.toFixed(6)} is over three times the noise. Read a handful of the outputs and the judge's reasons, then keep with --spot-checked`);
    }
    const prior = lastChecks(c, exps);
    if (prior !== null && (e.checks === null || e.checks === undefined)) {
      throw new Refusal(`keep refused: standing checks stood at ${prior}, but this keep supplied no count, so it cannot show they did not drop; pass --checks <n>`);
    }
    if (prior !== null && e.checks !== null && e.checks !== undefined && e.checks < prior) {
      throw new Refusal(`keep refused: standing checks fell from ${prior} to ${e.checks}; a climb never wins by removing checks`);
    }
  }
  invariant(e.hypothesis.trim().length > 0, "an experiment names its hypothesis");
  // A revert that beat the incumbent on train is a near-miss: it goes in the archive for recombination.
  const it = incumbentTrain(c, exps);
  const trainGain = e.train !== null && e.train !== undefined && it !== null ? signed(c.metric.direction, e.train - it) : null;
  let archive: ArchiveEntry | null = null;
  if (!e.keep && trainGain !== null && trainGain > 0) {
    if (!e.path && !e.ref) {
      throw new Refusal(`this revert beat the incumbent on train by ${round6(trainGain)}, so it belongs in the climb's archive for recombination; name where the variant lives with --path <file|dir> (or --ref <sha>)`);
    }
    archive = storeArchive(c.id, exps.length + 1, e.path ?? null, e.ref ?? null);
  }
  if (m > 1) flags.push(`bonferroni-m${m}`);
  const x: Experiment = {
    n: exps.length + 1, at: new Date().toISOString(), hypothesis: e.hypothesis, value, train: e.train ?? null,
    kept: e.keep, outcome: e.keep ? "kept" : "reverted", tag: e.keep ? (e.tag ?? "tune") : null, ref: e.ref ?? null, checks: e.checks ?? null,
    served_model: e.served_model ?? null, flags, note: e.note ?? null, paired: null, critique: null,
    ...pop, cases: e.cases ?? null, paired_cases: pc, simpler: e.simpler ?? null, archive,
  };
  invariant(!x.kept || !x.paired_cases || x.paired_cases.better || x.flags.includes("simpler"), "a run keep carries a significant per-case gain or a simpler tie");
  invariant(!x.archive || !x.kept, "only reverts are archived");
  appendFileSync(expPath(c.id), JSON.stringify(x) + "\n", { mode: 0o600 });
  return x;
}

/**
 * A candidate cut before any test read: value null, no test read logged, never kept. A screened candidate
 * that beat the incumbent on train is still a near-miss and goes to the archive like any revert.
 */
function recordScreened(c: Climb, e: ExperimentInput): Experiment {
  if (e.keep) throw new Refusal("keep refused: a screened-out candidate was never read on test, so there is nothing a keep could stand on");
  invariant(e.value === null || e.value === undefined, "a screened-out candidate carries no test value; it was never read on test");
  invariant(!e.cases && !e.paired && !e.simpler, "a screened-out candidate carries no per-case, paired or simpler measurement");
  invariant(e.train === undefined || e.train === null || Number.isFinite(e.train), "a train score is a finite number");
  invariant(e.hypothesis.trim().length > 0, "an experiment names its hypothesis");
  invariant(e.kind === undefined || e.kind === null || (KINDS as readonly string[]).includes(e.kind), `kind must be one of ${KINDS.join("|")}`);
  invariant(!e.path || existsSync(e.path), `--path ${e.path} does not exist`);
  const exps = loadExperiments(c.id);
  const parents = [...new Set(e.parents ?? [])].sort((a, b) => a - b);
  invariant(parents.every((p) => Number.isInteger(p) && p >= 0 && p <= exps.length), `parents name experiments 0..${exps.length} (0 is the baseline)`);
  const it = incumbentTrain(c, exps);
  const trainGain = e.train !== null && e.train !== undefined && it !== null ? signed(c.metric.direction, e.train - it) : null;
  let archive: ArchiveEntry | null = null;
  if (trainGain !== null && trainGain > 0) {
    if (!e.path && !e.ref) throw new Refusal(`this screened-out candidate beat the incumbent on train by ${round6(trainGain)}, so it belongs in the climb's archive for recombination; name where the variant lives with --path <file|dir> (or --ref <sha>)`);
    archive = storeArchive(c.id, exps.length + 1, e.path ?? null, e.ref ?? null);
  }
  const x: Experiment = {
    n: exps.length + 1, at: new Date().toISOString(), hypothesis: e.hypothesis, value: null, train: e.train ?? null,
    kept: false, outcome: "screened", tag: null, ref: e.ref ?? null, checks: e.checks ?? null, served_model: e.served_model ?? null,
    flags: ["screened"], note: e.note ?? null, paired: null, critique: null,
    kind: e.kind ?? null, kind_as_proposed: e.kind_as_proposed?.trim() || null, origin: e.origin?.trim() ?? null, parents, generation: e.generation ?? null, proposal: e.proposal ?? null, comparisons: null,
    cases: null, paired_cases: null, simpler: null, archive,
  };
  invariant(x.value === null && !x.kept, "a screened row has no value and is not kept");
  appendFileSync(expPath(c.id), JSON.stringify(x) + "\n", { mode: 0o600 });
  return x;
}

// ── judged climbs: paired keeps over Critique.json readings ──────────────────

/** Paired samples further apart than this are different frames, so their scores cannot be differenced. */
export const T_TOLERANCE_S = 0.05;

/** One Critique.json reduced to what pairing needs. A score is the judge's overall, or null when UNKNOWN. */
export interface CritiqueReading {
  path: string;
  artifact_sha256: string;
  judges: Record<string, string>;
  sample_seed: number | null;
  samples: Array<{ id: string; t: number | null; scores: Record<string, number | null> }>;
}

export interface CritiqueBaseline {
  files: string[];
  artifact_sha256: string;
  k: number;
  n_samples: number;
  times: Array<number | null>;
  vendors: string[];
  judges: Record<string, string>;
}

export interface PairedSummary {
  n: number; mean_diff: number; sem: number; ci95_lo: number; ci95_hi: number;
  vendors: string[]; unpaired_vendors: string[]; dropped: number;
  k_parent: number; k_child: number; parent_value: number; child_value: number;
}

export interface PairedCritique extends PairedSummary {
  parent_sha256: string; child_sha256: string;
  parent_files: string[]; child_files: string[];
  judges_child: Record<string, string>;
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

/** Parses one Critique.json. Throws a plain Error on a malformed file (a usage error, not a refusal). */
export function readCritique(path: string): CritiqueReading {
  const j = JSON.parse(readFileSync(path, "utf-8")) as unknown;
  const bad = (why: string): never => { throw new Error(`${path} is not a Critique.json: ${why}`); };
  if (!isObj(j)) return bad("not an object");
  if (typeof j.artifactSha256 !== "string" || !j.artifactSha256) return bad("no artifactSha256");
  if (!Array.isArray(j.samples) || j.samples.length === 0) return bad("no samples");
  const judges: Record<string, string> = {};
  for (const jd of Array.isArray(j.judges) ? j.judges : []) if (isObj(jd) && typeof jd.vendor === "string" && typeof jd.model === "string") judges[jd.vendor] = jd.model;
  const samples = j.samples.map((s, i) => {
    if (!isObj(s) || typeof s.id !== "string" || !isObj(s.scores)) return bad(`sample ${i} lacks id or scores`);
    if (s.t !== null && !(typeof s.t === "number" && Number.isFinite(s.t))) return bad(`sample ${s.id} has a non-numeric t`);
    const scores: Record<string, number | null> = {};
    for (const [vendor, sc] of Object.entries(s.scores)) {
      if (isObj(sc) && typeof sc.overall === "number" && Number.isFinite(sc.overall)) scores[vendor] = sc.overall;
      else if (isObj(sc) && sc.status === "UNKNOWN") scores[vendor] = null;
      else return bad(`sample ${s.id} vendor ${vendor} has neither an overall score nor UNKNOWN`);
    }
    return { id: s.id, t: s.t as number | null, scores };
  });
  const seed = typeof j.sampleSeed === "number" ? j.sampleSeed : null;
  return { path, artifact_sha256: j.artifactSha256, judges, sample_seed: seed, samples };
}

/** Refuses unless the two readings sampled the same frames: same count, same ids, and t within tolerance. */
function assertSameFrames(a: CritiqueReading, b: CritiqueReading): void {
  if (a.samples.length !== b.samples.length) throw new Refusal(`readings differ in sample count (${a.samples.length} vs ${b.samples.length} samples): ${a.path} vs ${b.path}`);
  a.samples.forEach((s, i) => {
    const o = b.samples[i];
    if (s.id !== o.id) throw new Refusal(`sample ${i} is ${s.id} in ${a.path} but ${o.id} in ${b.path}; pairing is by sample index`);
    if (s.t === null && o.t === null) return;
    if (s.t === null || o.t === null) throw new Refusal(`sample ${s.id} is timed in one reading and untimed in the other (${s.t} vs ${o.t}): ${a.path} vs ${b.path}`);
    const gap = Math.abs(s.t - o.t);
    if (gap > T_TOLERANCE_S) throw new Refusal(`sample ${s.id} t=${s.t} vs t=${o.t} differs by ${gap.toFixed(2)} s, over the ${T_TOLERANCE_S} s pairing tolerance; these are different frames (${a.path} vs ${b.path})`);
  });
}

/** One arm: k readings of one film, averaged per sample per vendor over the readings that scored it. */
function armMeans(readings: CritiqueReading[], arm: string): { sha: string; means: Map<string, Array<number | null>>; judges: Record<string, string> } {
  invariant(readings.length > 0, `the ${arm} arm has no readings`);
  const [first] = readings;
  const judges: Record<string, string> = {};
  for (const r of readings) {
    if (r.artifact_sha256 !== first.artifact_sha256) throw new Refusal(`the ${arm} readings must all be the same film: ${first.path} is ${first.artifact_sha256.slice(0, 12)}, ${r.path} is ${r.artifact_sha256.slice(0, 12)}`);
    assertSameFrames(first, r);
    for (const [v, m] of Object.entries(r.judges)) {
      if (judges[v] && judges[v] !== m) throw new Refusal(`the ${arm} readings used two ${v} judge models (${judges[v]}, ${m}); one arm is one instrument`);
      judges[v] = m;
    }
  }
  const vendors = [...new Set(readings.flatMap((r) => r.samples.flatMap((s) => Object.keys(s.scores))))];
  const means = new Map<string, Array<number | null>>();
  for (const v of vendors) {
    means.set(v, first.samples.map((_, i) => {
      const xs = readings.map((r) => r.samples[i].scores[v]).filter((x): x is number => typeof x === "number");
      return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
    }));
  }
  return { sha: first.artifact_sha256, means, judges };
}

const round6 = (x: number) => +x.toFixed(6);

/**
 * Pure: the paired comparison of a child film against its parent. Each arm's
 * readings are averaged per sample first, then samples pair by index and per vendor; a pair with no
 * known score on either side is dropped and counted. The statistics are Assay's pairedDiff (child − parent).
 */
export function pairCritiques(parent: CritiqueReading[], child: CritiqueReading[]): PairedCritique {
  const p = armMeans(parent, "parent");
  const ch = armMeans(child, "child");
  assertSameFrames(parent[0], child[0]);
  const pv = [...p.means.keys()].filter((v) => p.means.get(v)!.some((x) => x !== null));
  const cv = [...ch.means.keys()].filter((v) => ch.means.get(v)!.some((x) => x !== null));
  const vendors = pv.filter((v) => cv.includes(v)).sort();
  const unpaired = [...pv, ...cv].filter((v) => !vendors.includes(v)).filter((v, i, xs) => xs.indexOf(v) === i).sort();
  const a: number[] = [];
  const b: number[] = [];
  let dropped = 0;
  for (const v of vendors) {
    const pm = p.means.get(v)!;
    const cm = ch.means.get(v)!;
    pm.forEach((x, i) => {
      const y = cm[i];
      if (x === null || y === null) { dropped++; return; }
      a.push(x); b.push(y);
    });
  }
  if (a.length < 2) throw new Refusal(`only ${a.length} paired sample(s) across vendors [${vendors.join(", ")}]; a paired interval needs at least 2`);
  const r = pairedDiff(a, b);
  return {
    n: r.n, mean_diff: round6(r.mean_diff), sem: round6(r.sem), ci95_lo: round6(r.ci95_lo), ci95_hi: round6(r.ci95_hi),
    vendors, unpaired_vendors: unpaired, dropped, k_parent: parent.length, k_child: child.length,
    parent_value: round6(a.reduce((s, x) => s + x, 0) / a.length), child_value: round6(b.reduce((s, x) => s + x, 0) / b.length),
    parent_sha256: p.sha, child_sha256: ch.sha, parent_files: parent.map((x) => x.path), child_files: child.map((x) => x.path),
    judges_child: ch.judges,
  };
}

/** The baseline options for a judged climb: k readings of one film, checked to share their frames. */
export function critiqueBaseline(files: string[]): BaselineOpts & { critique: CritiqueBaseline } {
  invariant(files.length > 0, "a judged baseline needs at least one Critique.json");
  const readings = files.map(readCritique);
  const { sha, means, judges } = armMeans(readings, "baseline");
  const vendors = [...means.keys()].filter((v) => means.get(v)!.some((x) => x !== null)).sort();
  const known = vendors.flatMap((v) => means.get(v)!.filter((x): x is number => x !== null));
  if (!known.length) throw new Refusal(`no known judge scores in ${files.join(", ")}`);
  const value = round6(known.reduce((s, x) => s + x, 0) / known.length);
  const n = readings[0].samples.length;
  return {
    value,
    source: `${files.length} critique reading(s) of ${sha.slice(0, 12)}: mean of per-sample means over ${n} samples, vendors ${vendors.join(", ")}`,
    critique: { files, artifact_sha256: sha, k: files.length, n_samples: n, times: readings[0].samples.map((s) => s.t), vendors, judges },
  };
}

/** The ExperimentInput fields a paired comparison fills: the child's headline and the comparison itself. */
export function pairedInput(p: PairedCritique): { value: number; paired: PairedCritique } {
  return { value: p.child_value, paired: p };
}

/**
 * The judged keep rule. The parent must be the incumbent film, the judges must be the baseline's,
 * standing checks may not fall, and a keep needs the paired 95% CI lower bound above zero.
 */
function recordPairedExperiment(c: Climb, exps: Experiment[], e: ExperimentInput, p: PairedCritique, pop: { kind: Kind | null; kind_as_proposed: string | null; origin: string | null; parents: number[]; generation: number | null; proposal: string | null; comparisons: number }): Experiment {
  const m = pop.comparisons;
  const loM = round6(p.mean_diff - bonferroniWiden(m) * (p.mean_diff - p.ci95_lo));
  invariant(c.critique !== null, `climb ${c.id} is not judged`);
  const incumbent = exps.filter((x) => x.kept && x.critique).at(-1)?.critique?.artifact_sha256 ?? c.critique.artifact_sha256;
  if (p.parent_sha256 !== incumbent) {
    throw new Refusal(`the parent readings are film ${p.parent_sha256.slice(0, 12)}, but the incumbent is ${incumbent.slice(0, 12)} (${exps.some((x) => x.kept) ? "the last kept film" : "the baseline film"}); pair against the incumbent`);
  }
  const flags: string[] = [];
  if (c.instrument && e.instrument_sha && e.instrument_sha !== c.instrument.sha256) flags.push("instrument-changed");
  const changed = p.vendors.filter((v) => c.critique!.judges[v] && p.judges_child[v] && p.judges_child[v] !== c.critique!.judges[v]);
  if (changed.length) flags.push("judge-changed");
  if (e.keep) {
    if (flags.includes("instrument-changed")) throw new Refusal("keep refused: the instrument changed since the baseline, so the two numbers are different series. Re-baseline in a new climb");
    if (c.instrument && !e.instrument_sha) throw new Refusal("keep refused: the current instrument hash was not supplied, so it cannot be compared with the baseline's");
    if (changed.length) throw new Refusal(`keep refused: the judge model changed since the baseline (${changed.map((v) => `${v}: ${c.critique!.judges[v]} → ${p.judges_child[v]}`).join("; ")}); re-baseline in a new climb`);
    const prior = lastChecks(c, exps);
    if (prior !== null && (e.checks === null || e.checks === undefined)) {
      throw new Refusal(`keep refused: standing checks stood at ${prior}, but this keep supplied no count, so it cannot show they did not drop; pass --checks <n>`);
    }
    if (prior !== null && e.checks !== null && e.checks !== undefined && e.checks < prior) {
      throw new Refusal(`keep refused: standing checks fell from ${prior} to ${e.checks}; a climb never wins by removing checks`);
    }
    if (!(loM > 0)) {
      throw new Refusal(`keep refused: the paired 95% CI lower bound is ${p.ci95_lo}${m > 1 ? ` (${loM} after the Bonferroni correction for ${m} candidates read on test since the last keep)` : ""} (mean diff ${p.mean_diff}, CI [${p.ci95_lo}, ${p.ci95_hi}], n=${p.n} over ${p.vendors.join(", ")}); it must be above zero. Record it with --revert, or take more readings`);
    }
  }
  if (m > 1) flags.push(`bonferroni-m${m}`);
  const { parent_sha256: _ps, child_sha256, parent_files: _pf, child_files, judges_child: _j, ...summary } = p;
  const x: Experiment = {
    n: exps.length + 1, at: new Date().toISOString(), hypothesis: e.hypothesis, value: p.child_value, train: null,
    kept: e.keep, outcome: e.keep ? "kept" : "reverted", tag: e.keep ? (e.tag ?? "tune") : null, ref: e.ref ?? null, checks: e.checks ?? null,
    served_model: null, flags, note: e.note ?? null, paired: summary, critique: { files: child_files, artifact_sha256: child_sha256 },
    ...pop, cases: null, paired_cases: null, simpler: null, archive: null,
  };
  invariant(x.hypothesis.trim().length > 0, "an experiment names its hypothesis");
  invariant(!x.kept || (x.paired!.ci95_lo > 0 && loM > 0), "a judged keep carries a paired CI above zero after correction");
  appendFileSync(expPath(c.id), JSON.stringify(x) + "\n", { mode: 0o600 });
  return x;
}

export interface PlateauVerdict {
  verdict: "climbing" | "widen" | "plateaued";
  /** since_last_keep counts generations in population mode (any experiment names a generation), experiments otherwise. */
  plateaued: boolean; widen: boolean; since_last_keep: number; categorize: boolean;
  unit: "generations" | "experiments"; experiments_since_keep: number;
  /** Kinds tried among the reverts since the last keep, and how many of those reverts named no kind. */
  kinds_since_keep: Kind[]; untyped_since_keep: number;
}

/**
 * Plateaued when the last `window` experiments were all reverted and those reverts span at least
 * MIN_KINDS kinds of change; with fewer kinds the answer is widen, because one kind turned many ways is
 * not a search of the hill. Untyped reverts count toward the run, never toward the kinds. After two
 * reverts in a row with no categorization since the last keep, the next round is a categorization.
 */
export function plateau(exps: Experiment[], window = 3, stalls: Stall[] = []): PlateauVerdict {
  let since = 0;
  for (let i = exps.length - 1; i >= 0 && !exps[i].kept; i--) since++;
  const lastKeep = exps.length - since;
  const categorized = stalls.some((s) => s.after_experiment > lastKeep);
  const reverts = exps.slice(lastKeep);
  const kinds = [...new Set(reverts.map((e) => e.kind).filter((k): k is Kind => !!k))].sort();
  // Population mode: a generation is one search step, so the run without a keep is counted in generations.
  // The keep's own generation is not a generation without a keep, even if later proposals of it reverted.
  const population = exps.some((e) => e.generation !== null);
  const keepGen = lastKeep > 0 ? exps[lastKeep - 1].generation : null;
  const gens = new Set(reverts.map((e) => e.generation).filter((g): g is number => g !== null && (keepGen === null || g > keepGen))).size;
  const unitSince = population ? gens : since;
  const stuck = population ? gens >= window : exps.length >= window && since >= window;
  const widen = stuck && kinds.length < MIN_KINDS;
  const plateaued = stuck && !widen;
  return {
    verdict: plateaued ? "plateaued" : widen ? "widen" : "climbing", plateaued, widen, since_last_keep: unitSince,
    unit: population ? "generations" : "experiments", experiments_since_keep: since,
    categorize: unitSince >= 2 && !categorized, kinds_since_keep: kinds, untyped_since_keep: reverts.filter((e) => !e.kind).length,
  };
}

export interface Rate { tried: number; kept: number; rate: number }

/** Pure: keep rate by kind and by origin, the measured record of which kinds of change and which proposers pay. */
export function keepRates(exps: Experiment[]): { by_kind: Record<string, Rate>; by_origin: Record<string, Rate> } {
  const tally = (key: (e: Experiment) => string) => {
    const m: Record<string, Rate> = {};
    for (const e of exps) {
      const k = key(e);
      m[k] ??= { tried: 0, kept: 0, rate: 0 };
      m[k].tried++;
      if (e.kept) m[k].kept++;
    }
    for (const r of Object.values(m)) r.rate = +(r.kept / r.tried).toFixed(4);
    return m;
  };
  return { by_kind: tally((e) => e.kind ?? "(untyped)"), by_origin: tally((e) => e.origin ?? "(none)") };
}

export interface DigestRow {
  n: number; hypothesis: string; kind: Kind | null; kind_as_proposed: string | null; origin: string | null; parents: number[];
  outcome: Outcome; train: number | null; train_delta: number | null; archived: boolean;
}

export interface Digest {
  climb: string; target: string; metric: { name: string; direction: Direction };
  baseline_train: number | null; train_cases: string[]; experiments: DigestRow[];
}

/**
 * Pure: the proposer view. Every prior hypothesis with its kind, origin, parents, outcome and train delta
 * against the incumbent it was built on. No test, screen or holdout number, case id, flag or note, so a
 * proposer briefed from it cannot tune against held-out data.
 */
export function digest(c: Climb, exps: Experiment[]): Digest {
  const td = trainDeltas(c, exps);
  return {
    climb: c.id, target: c.target, metric: { name: c.metric.name, direction: c.metric.direction },
    baseline_train: c.baseline?.train ?? null,
    train_cases: c.split && !c.split.directional ? [...c.split.train] : [],
    experiments: exps.map((e, i) => ({
      n: e.n, hypothesis: e.hypothesis, kind: e.kind, kind_as_proposed: e.kind_as_proposed, origin: e.origin, parents: e.parents,
      outcome: e.outcome, train: e.train, train_delta: td[i], archived: e.archive !== null,
    })),
  };
}

export interface ArchiveRow { n: number; hypothesis: string; kind: Kind | null; origin: string | null; parents: number[]; train_delta: number | null; path: string | null; stored: string | null; ref: string | null; sha256: string | null }

/** Pure: the near-miss archive, train-only like the digest, each with where its variant lives. */
export function archiveEntries(c: Climb, exps: Experiment[]): ArchiveRow[] {
  const td = trainDeltas(c, exps);
  return exps.flatMap((e, i) => e.archive ? [{
    n: e.n, hypothesis: e.hypothesis, kind: e.kind, origin: e.origin, parents: e.parents, train_delta: td[i],
    path: e.archive.path, stored: e.archive.stored ? join(ledgerDir(), c.id, e.archive.stored) : null, ref: e.archive.ref, sha256: e.archive.sha256,
  }] : []);
}

/** Scores a candidate on the screen split and logs the read. The screen ranks candidates; it never decides a keep. */
export function screenRead(c: Climb, s: { screen: number | null; screen_noise: number | null; n_screen: number }, source: string, hypothesis: string | null, generation: number | null = null, proposal: string | null = null): { screen: number; noise: number; n: number; baseline_screen: number | null; gain: number | null } {
  if (!(c.split?.screen ?? []).length) throw new Refusal(`climb ${c.id} has no screen split; declare one at baseline with --screen-frac`);
  assertBudget(c, loadExperiments(c.id), true);
  // A screen read names the generation it screened, so a voided generation can prove nothing was read from it.
  if (generation !== null) {
    if (hypothesis === null && proposal === null) throw new Refusal("a screen read of a generation names the proposal: --hypothesis or --proposal");
    assertGenerationMember(c, generation, hypothesis ?? "", proposal);
  }
  if (s.screen === null || s.screen_noise === null || s.n_screen === 0) throw new Refusal(`the run scored none of the ${c.split!.screen!.length} screen cases (missing or infra errors)`);
  invariant(!("test" in s) && !("train" in s), "a screen read carries no test or train number");
  appendRead(c.id, { split: "screen", source, hypothesis, role: "candidate", after: loadExperiments(c.id).length, generation });
  const base = c.baseline?.screen ?? null;
  return { screen: s.screen, noise: s.screen_noise, n: s.n_screen, baseline_screen: base, gain: base === null ? null : round6(signed(c.metric.direction, s.screen - base)) };
}

export function recordStall(c: Climb, counts: Partial<Record<StallBucket, number>>, note: string | null = null): { stall: Stall; routes: Array<{ bucket: StallBucket; count: number; route: string }> } {
  if (c.status !== "open") throw new Refusal(`climb ${c.id} is ${c.status}`);
  const full = Object.fromEntries(STALL_BUCKETS.map((b) => [b, counts[b] ?? 0])) as Record<StallBucket, number>;
  invariant(Object.values(full).every((n) => Number.isInteger(n) && n >= 0), "stall counts are non-negative integers");
  if (Object.values(full).every((n) => n === 0)) throw new Refusal("a categorization names at least one failure");
  const exps = loadExperiments(c.id);
  const gens = exps.map((e) => e.generation).filter((g): g is number => g !== null);
  const stall: Stall = { at: new Date().toISOString(), after_experiment: exps.length, after_generation: gens.length ? Math.max(...gens) : null, counts: full, note };
  c.stalls = [...c.stalls, stall];
  saveClimb(c);
  const routes = STALL_BUCKETS.filter((b) => full[b] > 0).sort((a, b) => full[b] - full[a]).map((b) => ({ bucket: b, count: full[b], route: STALL_ROUTE[b] }));
  return { stall, routes };
}

/** The final system's holdout reading, with what it was served by and measured with. */
export interface HoldoutReading extends HoldoutScore { served_model: string | null; instrument_sha: string | null; source: string }

/**
 * Refuses a close that would leave the climb's result unchecked: a declared holdout must be read
 * against the final system when anything was kept, on the baseline's instrument and served model.
 * Called before the CLI files an Upgrade, so a refused close leaves nothing behind.
 */
export function assertCloseable(c: Climb, holdout: HoldoutReading | null, stop: StopInput | null = null): Experiment[] {
  if (c.status !== "open") throw new Refusal(`climb ${c.id} is already ${c.status}`);
  if (!c.baseline) throw new Refusal(`climb ${c.id} has no baseline; nothing to close against`);
  const exps = loadExperiments(c.id);
  const declared = (c.split?.holdout ?? []).length > 0;
  if (holdout && !declared) throw new Refusal(`climb ${c.id} declared no holdout at baseline; --holdout-run has nothing to compare`);
  if (declared && !holdout && exps.some((e) => e.kept)) {
    throw new Refusal(`climb ${c.id} declared a holdout and kept changes; close with --holdout-run <run of the final system> so the result is checked on data the climb never tuned on`);
  }
  if (holdout) {
    if (!c.baseline.holdout) throw new Refusal(`climb ${c.id} has a holdout split but its baseline read no holdout cases`);
    if (c.instrument && holdout.instrument_sha !== c.instrument.sha256) throw new Refusal("holdout refused: the instrument changed since the baseline, so the two holdout numbers are different series");
    if (modelChanged(c.baseline.served_model, holdout.served_model)) throw new Refusal(`holdout refused: served by ${modelName(holdout.served_model)}, baseline by ${modelName(c.baseline.served_model)}`);
  }
  assertStop(c, exps, stop);
  return exps;
}

/**
 * Refuses a close that does not say why the climb stopped, or says something the ledger contradicts:
 * plateau needs plateau's verdict to be plateaued (widen is not a stop), budget needs a spent budget,
 * target needs at least one keep, abort needs a reason, and reviewed needs a climb with no exp rows (a Loop, whose
 * keep rule is the principal's review) plus a reason carrying the measured delta and why it ended.
 */
export function assertStop(c: Climb, exps: Experiment[], stop: StopInput | null): void {
  if (!stop) throw new Refusal(`close needs --stop ${STOP_REASONS.join("|")}: say why climb ${c.id} stopped`);
  if (!(STOP_REASONS as readonly string[]).includes(stop.reason)) throw new Refusal(`--stop must be one of ${STOP_REASONS.join("|")} (got ${stop.reason})`);
  const note = stop.note?.trim() ?? "";
  if (stop.reason === "abort" && !note) throw new Refusal('--stop abort needs --reason "<why the climb is being abandoned>"');
  if (stop.reason === "reviewed") {
    if (exps.length > 0) throw new Refusal(`--stop reviewed refused: climb ${c.id} has ${exps.length} exp row(s), so its ledger decides the stop; use plateau, target, budget or abort`);
    if (!note) throw new Refusal('--stop reviewed needs --reason "<measured delta against baseline; goal met | iteration cap reached | principal stopped>"');
  }
  if (stop.reason === "plateau") {
    const p = plateau(exps, stop.window ?? 3, c.stalls);
    if (!p.plateaued) throw new Refusal(`--stop plateau refused: plateau says ${p.verdict} (${p.since_last_keep} ${p.unit} since the last keep${p.widen ? `, reverts span only ${p.kinds_since_keep.length} kind(s)` : ""}); keep climbing, or stop with budget or abort`);
  }
  if (stop.reason === "budget") {
    const b = budgetState(c, exps);
    if (!c.budget) throw new Refusal("--stop budget refused: this climb set no budget at start (start --budget <n>)");
    if (!b.spent) throw new Refusal(`--stop budget refused: the budget is not spent (${b.experiments ? `${b.experiments.left} experiments left` : ""}${b.experiments && b.reads ? ", " : ""}${b.reads ? `${b.reads.left} reads left` : ""})`);
  }
  if (stop.reason === "target" && !exps.some((e) => e.kept)) throw new Refusal("--stop target refused: nothing was kept, so no target was reached; stop with plateau, budget or abort");
}

export function closeClimb(c: Climb, upgradeId: string | null, holdout: HoldoutReading | null, stop: StopInput): Climb {
  const exps = assertCloseable(c, holdout, stop);
  invariant(c.baseline !== null, `climb ${c.id} has no baseline`);
  const best = bestValue(c, exps);
  let hold: HoldoutResult | null = null;
  if (holdout) {
    const base = c.baseline.holdout!;
    invariant(Object.keys(holdout.cases).every((id) => c.split!.holdout!.includes(id)), "the holdout reading scores only holdout cases");
    appendRead(c.id, { split: "holdout", source: holdout.source, hypothesis: "close", role: "close", after: exps.length });
    hold = { baseline: base.value, final: holdout.value, delta: round6(holdout.value - base.value), n: holdout.n, paired: pairCases(base.cases, holdout.cases, c.split!.holdout!, c.metric.direction, 0) };
  }
  c.result = {
    baseline: c.baseline.value, best, delta: +(best - c.baseline.value).toFixed(6), noise: c.noise?.value ?? null,
    experiments: exps.length, kept: exps.filter((e) => e.kept).length,
    changes: exps.filter((e) => e.kept).map((e) => ({ n: e.n, hypothesis: e.hypothesis, tag: e.tag ?? "tune" })),
    holdout: hold, reads: readCounts(c.id),
    stop: { reason: stop.reason, note: stop.note?.trim() || null, at: new Date().toISOString() },
    budget: budgetState(c, exps), baseline_history: [...(c.baseline_history ?? [])],
  };
  invariant(c.result.stop !== undefined && ((c.result.stop.reason !== "abort" && c.result.stop.reason !== "reviewed") || c.result.stop.note !== null), "a closed climb records why it stopped");
  c.status = "closed";
  c.closed_at = new Date().toISOString();
  c.upgrade_id = upgradeId;
  saveClimb(c);
  return c;
}

/** Errata impact's own verdict words → the climb's. A lower complaint rate is the improvement. */
export function mapImpact(v: string): VerifyVerdict {
  if (v === "lower") return "improved";
  if (v === "higher") return "worse";
  if (v === "unchanged") return "no-change";
  return "insufficient-data";
}

export function recordVerify(c: Climb, verdict: VerifyVerdict, before: number | null, after: number | null): Climb {
  if (c.status === "open") throw new Refusal(`climb ${c.id} is still open; close it before verifying`);
  c.verify = { at: new Date().toISOString(), verdict, before, after };
  // A later verify replaces the earlier one, so a verified climb that no longer shows improvement drops back to closed.
  c.status = verdict === "improved" ? "verified" : "closed";
  saveClimb(c);
  return c;
}

export function listClimbs(): Climb[] {
  if (!existsSync(ledgerDir())) return [];
  return readdirSync(ledgerDir()).map(loadClimb).filter((c): c is Climb => c !== null).sort((a, b) => b.created.localeCompare(a.created));
}

// ── survey ───────────────────────────────────────────────────────────────────

export interface Hill {
  score: number;        // 0–100, higher hurts more
  type: TargetType;
  target: string;
  workflow: string;
  source: string;
  evidence: string;
}

export interface SurveyInputs {
  skills?: Array<{ skill: string; outputs: number; complaints: number; rate: number | null; false_passes: number }>;
  misses?: { false_passes: Array<Record<string, unknown>>; retire_candidates: Array<Record<string, unknown>> };
  rules?: Array<{ rule: string; text: string; sessions: number; count: number; sev3: number }>;
  suites?: Array<{ name: string; type: string; cases: number; judged_residue: number; last_run?: { passed: boolean; pass_to_k: number; ts: string } | null }>;
  upgrades?: Array<{ id: string; status: string; claim: string; source: string }>;
  climbs?: Climb[];
}

const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));
const str = (x: unknown, d = "?") => (typeof x === "string" && x ? x : d);

/**
 * Pure: every signal becomes a hill with a score. The weights are a ranking, not a measurement:
 * a false pass (a receipt said pass, the principal caught a defect) outranks everything because it
 * names a check that is missing or wrong; a broken rule scales with how many sessions broke it.
 */
export function rankHills(i: SurveyInputs, now = new Date()): Hill[] {
  const hills: Hill[] = [];
  for (const f of i.misses?.false_passes ?? []) {
    const skill = str(f.skill, "(unattributed)");
    hills.push({ score: 95, type: "miss", target: skill, workflow: WORKFLOW.miss, source: "errata:false-pass", evidence: `receipt passed, then the principal said: "${str(f.complaint, "").slice(0, 120)}" (${str(f.erratum_id)}, ${str(f.output_id)})` });
  }
  for (const s of i.skills ?? []) {
    if (s.skill === "(no skill)" || (s.complaints <= 0 && s.false_passes <= 0)) continue;
    const rate = s.rate ?? 0;
    hills.push({ score: clamp(30 + Math.min(60, rate * 120) + 5 * s.false_passes), type: "skill", target: s.skill, workflow: WORKFLOW.skill, source: "errata:skills", evidence: `${s.complaints} complaints over ${s.outputs} outputs (rate ${rate.toFixed(2)}), ${s.false_passes} false passes` });
  }
  for (const r of i.rules ?? []) {
    hills.push({ score: clamp(20 + r.sessions / 2 + r.sev3 / 4), type: "rule", target: r.rule, workflow: WORKFLOW.rule, source: "errata:v4-broken-rules", evidence: `broken in ${r.sessions} sessions (${r.count} failures, ${r.sev3} severity-3): ${r.text.slice(0, 140)}` });
  }
  for (const s of i.suites ?? []) {
    const lr = s.last_run ?? null;
    if (!lr) { hills.push({ score: 25, type: "eval", target: s.name, workflow: WORKFLOW.eval, source: "assay:suites", evidence: "suite has never run" }); continue; }
    if (!lr.passed && s.type === "regression") hills.push({ score: 70, type: "eval", target: s.name, workflow: WORKFLOW.eval, source: "assay:suites", evidence: `regression suite failing: pass^k ${(lr.pass_to_k * 100).toFixed(0)}% at ${lr.ts.slice(0, 10)}` });
    else if (s.type === "capability" && lr.pass_to_k < 0.8) hills.push({ score: 50, type: "eval", target: s.name, workflow: WORKFLOW.eval, source: "assay:suites", evidence: `capability pass^k ${(lr.pass_to_k * 100).toFixed(0)}%` });
    if (s.judged_residue > 0.5) hills.push({ score: 30, type: "eval", target: s.name, workflow: WORKFLOW.eval, source: "assay:residue", evidence: `judged residue ${(s.judged_residue * 100).toFixed(0)}%; judges are debt` });
  }
  for (const r of i.misses?.retire_candidates ?? []) {
    hills.push({ score: 35, type: "eval", target: `${str(r.skill)}:${str(r.check)}`, workflow: WORKFLOW.eval, source: "errata:retire-candidate", evidence: `standing check dismissed ${String(r.dismissals ?? "3+")} times with no matching complaint` });
  }
  for (const u of i.upgrades ?? []) {
    if (u.status !== "applied") continue;
    hills.push({ score: 40, type: "skill", target: u.id, workflow: "Verify", source: "upgrades:applied-unverified", evidence: `applied, never verified: ${u.claim.slice(0, 120)}` });
  }
  for (const c of i.climbs ?? []) {
    const ageDays = c.closed_at ? (now.getTime() - Date.parse(c.closed_at)) / 86_400_000 : 0;
    if (c.status === "closed" && ageDays >= 7) hills.push({ score: 45, type: c.type, target: c.target, workflow: "Verify", source: "hillclimb:closed-unverified", evidence: `climb ${c.id} closed ${Math.floor(ageDays)}d ago, before/after not yet checked` });
  }
  return hills.sort((a, b) => b.score - a.score || a.target.localeCompare(b.target));
}

/** Pure: the "Most-broken rules" table and its numbered text lines, from an Errata v4 report. */
export function parseBrokenRules(md: string): SurveyInputs["rules"] {
  const sec = md.split(/^## Most-broken rules\s*$/m)[1]?.split(/^## /m)[0];
  if (!sec) return [];
  const text = new Map<string, string>();
  for (const m of sec.matchAll(/^\d+\. `([^`]+)`: (.+)$/gm)) text.set(m[1], m[2].trim());
  const rows: NonNullable<SurveyInputs["rules"]> = [];
  for (const m of sec.matchAll(/^\| \d+ \| `([^`]+)` \| (\d+) \| (\d+) \| (\d+)\/(\d+)\/(\d+)\/(\d+) \|$/gm)) {
    rows.push({ rule: m[1], text: text.get(m[1]) ?? "", sessions: +m[2], count: +m[3], sev3: +m[7] });
  }
  return rows;
}

export type Runner = (argv: string[]) => { ok: boolean; stdout: string; err: string };

const bunRunner: Runner = (argv) => {
  const p = Bun.spawnSync(["bun", ...argv], { cwd: configRoot(), stdout: "pipe", stderr: "pipe", env: process.env });
  return { ok: p.exitCode === 0, stdout: p.stdout.toString(), err: p.stderr.toString().trim().slice(0, 200) || `exit ${p.exitCode}` };
};

/** Collects every source; a source that fails lands in `unavailable` by name and adds no hills. */
export function collectSurvey(o: { since: string; run?: Runner; v4Dir?: string }): { inputs: SurveyInputs; unavailable: Array<{ source: string; reason: string }> } {
  const run = o.run ?? bunRunner;
  const inputs: SurveyInputs = {};
  const unavailable: Array<{ source: string; reason: string }> = [];
  const json = <T>(source: string, argv: string[], set: (v: T) => void) => {
    const r = run(argv);
    if (!r.ok) return void unavailable.push({ source, reason: r.err });
    try { set(JSON.parse(r.stdout) as T); } catch (e) { unavailable.push({ source, reason: `unparseable output: ${(e as Error).message.slice(0, 80)}` }); }
  };
  json<SurveyInputs["skills"]>("errata:skills", ["LIFEOS/ERRATA/Errata.ts", "skills", "--since", o.since, "--json"], (v) => (inputs.skills = v));
  json<SurveyInputs["misses"]>("errata:misses", ["LIFEOS/ERRATA/Errata.ts", "misses", "--json"], (v) => (inputs.misses = v));
  json<SurveyInputs["suites"]>("assay:suites", ["skills/Assay/Tools/SuiteManager.ts", "list", "--json"], (v) => (inputs.suites = v));
  json<SurveyInputs["upgrades"]>("upgrades", ["LIFEOS/TOOLS/Upgrades.ts", "list", "--status", "applied", "--json"], (v) => (inputs.upgrades = v));
  const dir = o.v4Dir ?? erratav4Dir();
  try {
    const reports = readdirSync(dir).filter((f) => /^report-\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort();
    if (!reports.length) unavailable.push({ source: "errata:v4-broken-rules", reason: `no report-*.md in the v4 dir` });
    else {
      const rules = parseBrokenRules(readFileSync(join(dir, reports[reports.length - 1]), "utf-8"));
      if (!rules?.length) unavailable.push({ source: "errata:v4-broken-rules", reason: `${reports[reports.length - 1]} has no Most-broken rules table` });
      else inputs.rules = rules;
    }
  } catch (e) { unavailable.push({ source: "errata:v4-broken-rules", reason: (e as Error).message.slice(0, 120) }); }
  try { inputs.climbs = listClimbs(); } catch (e) { unavailable.push({ source: "hillclimb:ledger", reason: (e as Error).message.slice(0, 120) }); }
  return { inputs, unavailable };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

const flag = (a: string[], f: string) => { const i = a.indexOf(f); return i >= 0 && a[i + 1] !== undefined ? a[i + 1] : undefined; };
const num = (a: string[], f: string) => { const v = flag(a, f); return v === undefined ? undefined : Number(v); };
const flagAll = (a: string[], f: string) => a.flatMap((x, i) => (x === f && a[i + 1] !== undefined ? [a[i + 1]] : []));
function readRun(path: string): RunFile {
  const r = JSON.parse(readFileSync(path, "utf-8")) as RunFile;
  if (!Array.isArray(r.cases) || !r.cases.every((c) => typeof c.id === "string")) { console.error(`${path} is not an Assay run file (no cases[].id)`); process.exit(2); }
  return r;
}
const out = (x: unknown) => console.log(JSON.stringify(x, null, 2));
/** Per-case maps print as their case count; the ledger keeps them in full. */
const countCases = (x: unknown): unknown => JSON.parse(JSON.stringify(x, (k, v) => (k === "cases" && v && typeof v === "object" && !Array.isArray(v) ? Object.keys(v).length : v)));
const fieldOf = (a: string[], c?: Climb): RunField => {
  const f = flag(a, "--field");
  if (a.includes("--field") && f !== "pass_to_k" && f !== "mean_score") { console.error("--field must be pass_to_k or mean_score"); process.exit(2); }
  // A baseline sets the field (a --force re-baseline may change it); every later read is held to it.
  return c ? climbField(c, f ?? null) : (f as RunField | undefined) ?? "pass_to_k";
};
/** A run read is identified by its path and content hash, so the same run re-recorded counts as one distinct look. */
const runSource = (p: string) => `${p} sha256:${sha256(readFileSync(p)).slice(0, 16)}`;
function need<T>(v: T | undefined | null, what: string): T { if (v === undefined || v === null || (typeof v === "number" && !Number.isFinite(v))) { console.error(`missing or invalid ${what}`); process.exit(2); } return v; }
function readCritiquesOr2(paths: string[]): CritiqueReading[] {
  try { return paths.map(readCritique); } catch (e) { console.error((e as Error).message); process.exit(2); }
}
function climbOr2(id: string | undefined): Climb { const c = id ? loadClimb(id) : null; if (!c) { console.error(`no climb ${id ?? "(none given)"}`); process.exit(2); } return c; }

async function main(argv: string[]): Promise<number> {
  const [cmd, ...a] = argv;
  if (!cmd || cmd === "help" || cmd === "--help") {
    const head = readFileSync(import.meta.path, "utf-8").split("*/")[0];
    console.log(head.replace(/^\/\*\*?|^ \* ?/gm, "").replace(/^#!.*\n/, "").trim());
    return cmd ? 0 : 2;
  }
  switch (cmd) {
    case "survey": {
      const since = flag(a, "--since") ?? new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
      const { inputs, unavailable } = collectSurvey({ since });
      const hills = rankHills(inputs).slice(0, num(a, "--top") ?? 15);
      if (a.includes("--json")) out({ since, hills, unavailable });
      else {
        console.log(`HillClimb survey since ${since}: ${hills.length} hills`);
        hills.forEach((h, n) => console.log(`${String(n + 1).padStart(2)}. [${h.score}] ${h.workflow.padEnd(8)} ${h.target}\n      ${h.source} · ${h.evidence}`));
        for (const u of unavailable) console.log(`  unavailable: ${u.source} (${u.reason})`);
      }
      return 0;
    }
    case "start": {
      const type = need(flag(a, "--type"), "--type") as TargetType;
      if (!(TYPES as readonly string[]).includes(type)) { console.error(`--type must be one of ${TYPES.join("|")}`); return 2; }
      const direction = need(flag(a, "--direction"), "--direction") as Direction;
      if (direction !== "higher" && direction !== "lower") { console.error("--direction must be higher or lower"); return 2; }
      const budget: Partial<Budget> = {};
      for (const [f, k] of [["--budget", "experiments"], ["--budget-reads", "reads"]] as const) {
        if (!a.includes(f)) continue;
        const v = num(a, f);
        if (v === undefined || !Number.isInteger(v) || v < 1) { console.error(`${f} is a positive whole number (${k})`); return 2; }
        budget[k] = v;
      }
      out(startClimb({ type, target: need(flag(a, "--target"), "--target"), metric: need(flag(a, "--metric"), "--metric"), direction, why: need(flag(a, "--why"), "--why"), skill: flag(a, "--skill") ?? null, budget }));
      return 0;
    }
    case "baseline": {
      const c = climbOr2(a[0]);
      const instPaths = flagAll(a, "--instrument");
      const instrument = instPaths.length ? instrumentHash(instPaths) : undefined;
      const reason = flag(a, "--reason");
      if (a.includes("--reason") && (!reason || reason.startsWith("--"))) { console.error('--reason needs text: --reason "<why the old baseline is replaced>"'); return 2; }
      const common = { checks: num(a, "--checks") ?? null, force: a.includes("--force"), ceiling: num(a, "--ceiling") ?? null, min_win: num(a, "--min-win") ?? null, instrument, reason: reason ?? null };
      const runPath = flag(a, "--from-run");
      const critFiles = flagAll(a, "--from-critique");
      if (critFiles.length && (runPath || flag(a, "--value") !== undefined)) { console.error("--from-critique replaces --from-run and --value; pass one source"); return 2; }
      let res: Climb;
      if (critFiles.length) {
        readCritiquesOr2(critFiles);
        res = setBaseline(c, { ...common, ...critiqueBaseline(critFiles) });
      } else if (runPath) {
        const run = readRun(runPath);
        const screenFrac = num(a, "--screen-frac");
        const holdoutFrac = num(a, "--holdout-frac");
        if (c.split && (screenFrac !== undefined || holdoutFrac !== undefined)) { console.error(`climb ${c.id} already has its split; screen and holdout are set when the split is first made`); return 2; }
        for (const [f, v] of [["--screen-frac", screenFrac], ["--holdout-frac", holdoutFrac]] as const) {
          if (v !== undefined && !(Number.isFinite(v) && v > 0 && v < 0.5)) { console.error(`${f} must be a fraction between 0 and 0.5`); return 2; }
        }
        const split = c.split ?? seededSplit(run.cases.map((x) => x.id), flag(a, "--seed") ?? c.id, num(a, "--train-frac") ?? 0.5, num(a, "--min-split") ?? 10, { screenFrac, holdoutFrac });
        const field = fieldOf(a);
        const s = scoreRun(run, split, field);
        const noiseOverride = num(a, "--noise");
        res = setBaseline(c, {
          ...common, value: s.test, train: s.train, served_model: s.served_model, split, field,
          screen: s.screen, cases: s.cases, holdout: (split.holdout ?? []).length ? scoreHoldout(run, split, field) : null,
          read_source: runSource(runPath),
          source: `${runPath} (run ${s.run_id ?? "?"}, ${s.n_test} ${split.directional ? "cases, directional" : "test cases"}${s.excluded.length ? `, ${s.excluded.length} infra-error cases excluded` : ""})`,
          noise: noiseOverride !== undefined ? { value: noiseOverride, source: need(flag(a, "--noise-source"), "--noise-source") } : { value: s.noise, source: `95% half-width over ${s.n_test} cases from the raw run` },
        });
      } else {
        const nv = num(a, "--noise");
        // The train score of the same measurement, so digest can show train deltas and near-misses reach the archive.
        const tr = num(a, "--train");
        if (tr !== undefined && !Number.isFinite(tr)) { console.error("--train must be a number"); return 2; }
        res = setBaseline(c, { ...common, value: need(num(a, "--value"), "--value"), train: tr ?? null, served_model: flag(a, "--served-model") ?? null, source: need(flag(a, "--source"), "--source"), noise: nv !== undefined ? { value: nv, source: need(flag(a, "--noise-source"), "--noise-source") } : undefined });
      }
      out(countCases({ climb: res, preflight: preflight(res) }));
      return 0;
    }
    case "preflight": {
      const p = preflight(climbOr2(a[0]));
      out(p);
      return p.climbable ? 0 : 1;
    }
    case "exp": {
      const c = climbOr2(a[0]);
      const runPath = flag(a, "--from-run");
      const childFiles = flagAll(a, "--from-critique");
      const parentFiles = flagAll(a, "--parent-critique");
      // Screened out: cut before any test read (--train with no --value, or --screened). No test number exists to record.
      const screened = !runPath && !childFiles.length && flag(a, "--value") === undefined && (flag(a, "--train") !== undefined || a.includes("--screened"));
      if (screened && a.includes("--keep")) { console.error("a screened-out candidate was never read on test, so it cannot be kept; record it with --train <n> (or --screened) and no --keep"); return 2; }
      if (!screened && a.includes("--keep") === a.includes("--revert")) { console.error("pass exactly one of --keep or --revert (a candidate cut before any test read takes --train <n> or --screened instead)"); return 2; }
      if (a.includes("--screened") && (runPath || childFiles.length || flag(a, "--value") !== undefined)) { console.error("--screened means no test read; it takes no --value, --from-run or --from-critique"); return 2; }
      const tag = flag(a, "--tag");
      if (tag !== undefined && tag !== "required" && tag !== "tune") { console.error("--tag must be required or tune"); return 2; }
      if ((childFiles.length > 0) !== (parentFiles.length > 0)) { console.error("a paired experiment needs both --from-critique (the candidate) and --parent-critique (the incumbent)"); return 2; }
      if (childFiles.length && (runPath || flag(a, "--value") !== undefined)) { console.error("--from-critique replaces --from-run and --value; pass one source"); return 2; }
      const kind = flag(a, "--kind");
      if (kind !== undefined && !(KINDS as readonly string[]).includes(kind)) { console.error(`--kind must be one of ${KINDS.join("|")}`); return 2; }
      const kindAs = flag(a, "--kind-as-proposed");
      if (a.includes("--kind-as-proposed") && (!kindAs || kindAs.startsWith("--"))) { console.error("--kind-as-proposed needs the proposer's word for the kind"); return 2; }
      const origin = flag(a, "--origin");
      if (origin !== undefined && (!origin.trim() || /[\r\n]/.test(origin))) { console.error("--origin is one non-empty line naming the proposer"); return 2; }
      const nExp = loadExperiments(c.id).length;
      const parents = flagAll(a, "--parent").map(Number);
      if (!parents.every((p) => Number.isInteger(p) && p >= 0 && p <= nExp)) { console.error(`--parent names an experiment 0..${nExp} (0 is the baseline)`); return 2; }
      const path = flag(a, "--path");
      if (path !== undefined && !existsSync(path)) { console.error(`--path ${path} does not exist`); return 2; }
      const genFlag = flag(a, "--generation");
      const generation = genFlag === undefined ? null : Number(genFlag);
      if (generation !== null && !(Number.isInteger(generation) && generation >= 1)) { console.error("--generation is a positive integer (the Population.ts generation number)"); return 2; }
      const proposal = flag(a, "--proposal") ?? null;
      if (proposal !== null && generation === null) { console.error("--proposal names a proposal within --generation <g>; pass both"); return 2; }
      const hypothesis = need(flag(a, "--hypothesis"), "--hypothesis");
      // The membership check runs before anything is measured, so a refused claim reads nothing.
      if (generation !== null) generationOrigin(assertGenerationMember(c, generation, hypothesis, proposal), origin);
      assertKindAsProposed(kind ?? null, kindAs ?? null);
      assertBudget(c, loadExperiments(c.id), !screened);
      let simpler: { before: number; after: number } | null = null;
      if (a.includes("--simpler")) {
        const before = flag(a, "--before"); const after = flag(a, "--after");
        if (!before || !after || !existsSync(before) || !existsSync(after)) { console.error("--simpler needs --before <file|dir> and --after <file|dir>, both existing, so the tool can see material was removed"); return 2; }
        simpler = { before: materialSize(before), after: materialSize(after) };
      }
      let measured: { value: number | null; train?: number | null; served_model?: string | null; paired?: PairedCritique; cases?: Record<string, number>; read_source?: string; screened?: boolean };
      if (screened) {
        const tr = num(a, "--train");
        if (tr !== undefined && !Number.isFinite(tr)) { console.error("--train must be a number"); return 2; }
        measured = { value: null, train: tr ?? null, served_model: flag(a, "--served-model") ?? null, screened: true };
      } else if (childFiles.length) {
        measured = { ...pairedInput(pairCritiques(readCritiquesOr2(parentFiles), readCritiquesOr2(childFiles))), read_source: `critique:${childFiles.join(",")}` };
      } else if (runPath) {
        if (!c.split) { console.error(`climb ${c.id} has no split; take the baseline with --from-run first`); return 2; }
        const s = scoreRun(readRun(runPath), c.split, fieldOf(a, c));
        measured = { value: s.test, train: s.train, served_model: s.served_model, cases: s.cases, read_source: runSource(runPath) };
      } else measured = { value: need(num(a, "--value"), "--value"), train: num(a, "--train") ?? null, served_model: flag(a, "--served-model") ?? null };
      const instrument_sha = c.instrument ? instrumentHash(c.instrument.paths).sha256 : null;
      const x = recordExperiment(c, {
        hypothesis, ...measured, keep: a.includes("--keep"), tag: (tag as Tag) ?? null,
        ref: flag(a, "--ref"), checks: num(a, "--checks") ?? null, note: flag(a, "--note"), instrument_sha, spot_checked: a.includes("--spot-checked"),
        kind: (kind as Kind | undefined) ?? null, kind_as_proposed: kindAs ?? null, origin: origin ?? null, parents, path: path ?? null, simpler, generation, proposal,
      });
      const exps = loadExperiments(c.id);
      out(countCases({ ...x, best: bestValue(c, exps), noise: c.noise?.value ?? null, ...plateau(exps, num(a, "--window") ?? 3, c.stalls), budget: budgetState(c, exps) }));
      return 0;
    }
    case "screen": {
      const c = climbOr2(a[0]);
      const runPath = need(flag(a, "--from-run"), "--from-run");
      if (!c.split) { console.error(`climb ${c.id} has no split; take the baseline with --from-run first`); return 2; }
      if (!(c.split.screen ?? []).length) { console.error(`climb ${c.id} has no screen split; declare one at baseline with --screen-frac`); return 2; }
      // Screen cases only: no test number is computed, so a screen look is never an unlogged test read.
      const sg = flag(a, "--generation");
      const sgen = sg === undefined ? null : Number(sg);
      if (sgen !== null && !(Number.isInteger(sgen) && sgen >= 1)) { console.error("--generation is a positive integer (the Population.ts generation number)"); return 2; }
      const sprop = flag(a, "--proposal") ?? null;
      if (sprop !== null && sgen === null) { console.error("--proposal names a proposal within --generation <g>; pass both"); return 2; }
      const s = scoreScreen(readRun(runPath), c.split, fieldOf(a, c));
      out({ ...screenRead(c, s, runSource(runPath), flag(a, "--hypothesis") ?? null, sgen, sprop), excluded: s.excluded, budget: budgetState(loadClimb(c.id)!) });
      return 0;
    }
    case "digest": {
      const c = climbOr2(a[0]);
      if (!a.includes("--train-only")) { console.error("digest is the proposer view and is always train-only; pass --train-only to say so (the full ledger is status)"); return 2; }
      out(digest(c, loadExperiments(c.id)));
      return 0;
    }
    case "archive": {
      const c = climbOr2(a[0]);
      out(archiveEntries(c, loadExperiments(c.id)));
      return 0;
    }
    case "plateau": {
      const c = climbOr2(a[0]);
      const exps = loadExperiments(c.id);
      const p = plateau(exps, num(a, "--window") ?? 3, c.stalls);
      out({ ...p, budget: budgetState(c, exps) });
      return p.plateaued ? 0 : 1;
    }
    case "stall": {
      const c = climbOr2(a[0]);
      const counts = Object.fromEntries(STALL_BUCKETS.map((b) => [b, num(a, `--${b}`) ?? 0]));
      out(recordStall(c, counts, flag(a, "--note") ?? null));
      return 0;
    }
    case "close": {
      const c = climbOr2(a[0]);
      const holdPath = flag(a, "--holdout-run");
      let holdout: HoldoutReading | null = null;
      if (holdPath) {
        if (!(c.split?.holdout ?? []).length) { console.error(`climb ${c.id} declared no holdout at baseline; --holdout-run has nothing to compare`); return 2; }
        const run = readRun(holdPath);
        holdout = {
          ...scoreHoldout(run, c.split!, fieldOf(a, c)), served_model: run.agent_model ?? null,
          instrument_sha: c.instrument ? instrumentHash(c.instrument.paths).sha256 : null, source: runSource(holdPath),
        };
      }
      const sr = flag(a, "--stop");
      if (sr !== undefined && !(STOP_REASONS as readonly string[]).includes(sr)) { console.error(`--stop must be one of ${STOP_REASONS.join("|")}`); return 2; }
      const note = flag(a, "--reason");
      if (a.includes("--reason") && (!note || note.startsWith("--"))) { console.error('--reason needs text: --reason "<why the climb stopped>"'); return 2; }
      const stop: StopInput | null = sr ? { reason: sr as StopReason, note: note ?? null, window: num(a, "--window") ?? 3 } : null;
      assertCloseable(c, holdout, stop);
      let upgrade = flag(a, "--upgrade") ?? null;
      if (!upgrade && !a.includes("--no-upgrade") && c.baseline) {
        const exps = loadExperiments(c.id);
        const best = bestValue(c, exps);
        const r = bunRunner(["LIFEOS/TOOLS/Upgrades.ts", "add", "--source", "hillclimb", "--target", c.type,
          "--claim", `HillClimb ${c.id}: ${c.target} ${c.metric.name} ${c.baseline.value} → ${best}`,
          "--current", c.why, "--recommendation", exps.filter((e) => e.kept).map((e) => e.hypothesis).join("; ") || "no change kept",
          "--evidence", c.id]);
        try { upgrade = (JSON.parse(r.stdout) as { id?: string }).id || null; } catch { upgrade = null; }
        if (!upgrade) console.error(`upgrade record not filed: ${r.err}`);
      }
      out(countCases(closeClimb(c, upgrade, holdout, stop!)));
      return 0;
    }
    case "verify": {
      const c = climbOr2(a[0]);
      if (!c.skill) { console.error(`climb ${c.id} names no skill; the complaint-rate check is per skill. Verify by re-running its measurement instead.`); return 2; }
      if (!c.closed_at) { console.error(`climb ${c.id} is not closed`); return 2; }
      const days = String(num(a, "--days") ?? 14);
      const r = bunRunner(["LIFEOS/ERRATA/Errata.ts", "impact", "--skill", c.skill, "--since", c.closed_at.slice(0, 10), "--days", days, "--json"]);
      if (!r.ok) { console.error(`Errata impact unavailable: ${r.err}`); return 2; }
      const imp = JSON.parse(r.stdout) as { verdict: string; before: { rate: number | null }; after: { rate: number | null } };
      const verdict = mapImpact(imp.verdict);
      if (a.includes("--dry-run")) { out({ verdict, before: imp.before.rate, after: imp.after.rate }); return 0; }
      const v = recordVerify(c, verdict, imp.before.rate, imp.after.rate);
      if (verdict === "improved" && c.upgrade_id) {
        const u = bunRunner(["LIFEOS/TOOLS/Upgrades.ts", "verify", c.upgrade_id, "--note", `HillClimb ${c.id}: complaint rate ${imp.before.rate} → ${imp.after.rate}`]);
        if (!u.ok) console.error(`upgrade ${c.upgrade_id} not marked verified: ${u.err}`);
      }
      out(v);
      return 0;
    }
    case "status": {
      const c = climbOr2(a[0]);
      const exps = loadExperiments(c.id);
      out(countCases({
        climb: c, experiments: exps, best: c.baseline ? bestValue(c, exps) : null, preflight: preflight(c),
        ...plateau(exps, num(a, "--window") ?? 3, c.stalls), rates: keepRates(exps), reads: readCounts(c.id), budget: budgetState(c, exps), archived: exps.filter((e) => e.archive).length,
      }));
      return 0;
    }
    case "list": {
      const cs = listClimbs();
      if (a.includes("--json")) out(cs);
      else for (const c of cs) console.log(`${c.status.padEnd(8)} ${c.id}  ${c.type}:${c.target}  ${c.metric.name}${c.result ? ` ${c.result.baseline} → ${c.result.best}` : ""}`);
      return 0;
    }
    default:
      console.error("usage: HillClimb.ts survey|start|baseline|preflight|exp|screen|digest|archive|plateau|stall|close|verify|status|list (see header)");
      return 2;
  }
}

if (import.meta.main) {
  try { process.exit(await main(process.argv.slice(2))); }
  catch (e) {
    if (e instanceof Refusal) { console.error(e.message); process.exit(1); }
    throw e;
  }
}
