#!/usr/bin/env bun
/**
 * Stats — the statistical layer for eval results.
 *
 * Implements Anthropic's "A Statistical Approach to Model Evaluations"
 * (anthropic.com/research/statistical-approach-to-model-evals, Nov 2024):
 *   1. Report SEM + 95% CI with every eval score, never a bare mean.
 *   2. Use PAIRED differences when comparing two configurations on the same
 *      cases — question-difficulty variance cancels, so smaller real effects
 *      become detectable.
 *   3. Reduce within-question variance by resampling (trials) and feeding
 *      question-level AVERAGES into the CLT — which is what EvalRunner's
 *      per-case mean over trials already produces.
 *   4. Cluster standard errors when cases are not independent (share a source
 *      document/scenario) — naive SEs can be 3x too small.
 *   5. Power analysis to size a suite before trusting a null result.
 *
 * Pure functions, zero dependencies, zero model calls.
 */

export interface Summary {
  n: number;
  mean: number;
  sem: number;
  ci95_lo: number;
  ci95_hi: number;
}

export interface PairedResult {
  n: number;
  mean_diff: number; // mean(b - a): positive = B better
  sem: number;
  ci95_lo: number;
  ci95_hi: number;
  significant: boolean; // 95% CI excludes 0
  correlation: number; // Pearson r between arms (sanity: frontier models correlate 0.3-0.7)
}

const Z95 = 1.959964;

export function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((s, x) => s + x, 0) / xs.length;
}

function sampleVariance(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1);
}

/** Standard error of the mean. 0 when n < 2 (report, don't crash, on tiny suites). */
export function sem(xs: number[]): number {
  return xs.length < 2 ? 0 : Math.sqrt(sampleVariance(xs) / xs.length);
}

/** Mean with SEM and the 95% confidence interval, clamped to [0,1] for scores. */
export function summarize(xs: number[], clamp01 = true): Summary {
  const m = mean(xs);
  const se = sem(xs);
  let lo = m - Z95 * se;
  let hi = m + Z95 * se;
  if (clamp01) {
    lo = Math.max(0, lo);
    hi = Math.min(1, hi);
  }
  return { n: xs.length, mean: m, sem: se, ci95_lo: lo, ci95_hi: hi };
}

/**
 * Paired-difference comparison of two arms over the SAME cases, index-aligned.
 * The sanctioned way to compare prompts/models/configs (Anthropic rec #4) —
 * two-sample comparisons throw away the pairing and need far more cases.
 */
export function pairedDiff(a: number[], b: number[]): PairedResult {
  if (a.length !== b.length) throw new Error(`pairedDiff: arms differ in length (${a.length} vs ${b.length}) — pair per-case scores, index-aligned`);
  const diffs = b.map((x, i) => x - a[i]);
  const md = mean(diffs);
  const se = sem(diffs);
  const lo = md - Z95 * se;
  const hi = md + Z95 * se;
  const ma = mean(a);
  const mb = mean(b);
  const cov = a.length < 2 ? 0 : a.reduce((s, x, i) => s + (x - ma) * (b[i] - mb), 0) / (a.length - 1);
  const denom = Math.sqrt(sampleVariance(a) * sampleVariance(b));
  return {
    n: a.length,
    mean_diff: md,
    sem: se,
    ci95_lo: lo,
    ci95_hi: hi,
    significant: a.length >= 2 && (lo > 0 || hi < 0),
    correlation: denom === 0 ? 0 : cov / denom,
  };
}

/**
 * Cluster-robust SEM (Anthropic rec #2): when several cases derive from the
 * same source (a shared document, scenario, or seed), their errors correlate
 * and the naive SEM understates uncertainty. Pass a parallel array of cluster
 * keys; independent cases just use their own index.
 */
export function clusteredSem(xs: number[], clusters: (string | number)[]): number {
  if (xs.length !== clusters.length) throw new Error('clusteredSem: values and clusters must align');
  if (xs.length < 2) return 0;
  const m = mean(xs);
  const byCluster = new Map<string | number, number>();
  for (let i = 0; i < xs.length; i++) {
    byCluster.set(clusters[i], (byCluster.get(clusters[i]) ?? 0) + (xs[i] - m));
  }
  const g = byCluster.size;
  if (g < 2) return sem(xs);
  const sumSq = [...byCluster.values()].reduce((s, v) => s + v * v, 0);
  // Cluster-robust variance of the mean with small-sample correction g/(g-1).
  return Math.sqrt((sumSq / (xs.length * xs.length)) * (g / (g - 1)));
}

/**
 * Paired power analysis (Anthropic rec #5): cases needed to detect a mean
 * paired difference `delta` given the sd of paired differences, at 5% alpha
 * and 80% power. Rule of thumb before trusting "no significant difference".
 */
export function pairedPowerN(delta: number, sdDiff: number, power = 0.8): number {
  if (delta <= 0 || sdDiff <= 0) throw new Error('pairedPowerN: delta and sdDiff must be > 0');
  const zBeta = power === 0.8 ? 0.8416 : power === 0.9 ? 1.2816 : 0.8416;
  return Math.ceil(((Z95 + zBeta) * sdDiff / delta) ** 2);
}

// ---- self-test ----------------------------------------------------------------
if (import.meta.main) {
  let pass = 0;
  const total = 6;
  const s = summarize([0.8, 0.9, 1.0, 0.7, 0.6]);
  if (Math.abs(s.mean - 0.8) < 1e-9 && s.sem > 0.07 && s.sem < 0.071) pass++;
  console.log(`summarize: mean=${s.mean.toFixed(3)} sem=${s.sem.toFixed(4)} CI[${s.ci95_lo.toFixed(3)},${s.ci95_hi.toFixed(3)}]`);
  const p = pairedDiff([0.5, 0.6, 0.7, 0.5], [0.7, 0.8, 0.9, 0.7]);
  if (Math.abs(p.mean_diff - 0.2) < 1e-9 && p.significant) pass++;
  console.log(`pairedDiff clear-win: diff=${p.mean_diff.toFixed(3)} significant=${p.significant}`);
  const tie = pairedDiff([0.5, 0.9, 0.4, 0.8], [0.6, 0.7, 0.5, 0.7]);
  if (!tie.significant) pass++;
  console.log(`pairedDiff noisy-tie: diff=${tie.mean_diff.toFixed(3)} significant=${tie.significant}`);
  const cs = clusteredSem([1, 1, 0, 0], ['a', 'a', 'b', 'b']);
  const ns = sem([1, 1, 0, 0]);
  if (cs > ns) pass++;
  console.log(`clusteredSem ${cs.toFixed(4)} > naive ${ns.toFixed(4)} on clustered data`);
  const n = pairedPowerN(0.1, 0.2);
  if (n >= 30 && n <= 35) pass++;
  console.log(`pairedPowerN(delta=0.1, sd=0.2) = ${n} cases`);
  const empty = summarize([]);
  if (empty.n === 0 && empty.mean === 0 && empty.sem === 0) pass++;
  console.log(`empty input safe: ${JSON.stringify(empty)}`);
  console.log(`\n${pass}/${total} stats self-tests passed`);
  process.exit(pass === total ? 0 : 1);
}
