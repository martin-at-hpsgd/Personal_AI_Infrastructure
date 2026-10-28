/**
 * Vera Scoring — projections over the claim ledger. Nothing here is stored.
 *
 * Invariants (ISA anti-claims):
 * - Absence widens the interval around a neutral prior; it NEVER lowers an
 *   estimate. Zero usable rows → insufficient signal (estimate null), never 0.
 * - sensitivity=personal rows are excluded before any computation.
 * - judged rows never enter an accuracy leaf; accuracy computes only from
 *   RESOLVED verifiable rows (Brier-style when stated_p exists).
 * - composite() rolls the leaves into one 1-100 VERA score per person, and
 *   branchComposites() into one per branch. Both are computed at read time,
 *   never stored, and decompose to the leaves and rows behind them.
 * - Row weight decays with age from `happened` (configurable half-life);
 *   trajectory is the slope of evidence over the trailing window.
 */

import { type AxesTree, type ClaimRow, type LeafScore } from "./Schema";

export interface ScoringConfig {
  /** Half-life in years for row weight decay. */
  halfLifeYears: number;
  /** Neutral prior for judged/structural leaves (0..1 scale). */
  neutralPrior: number;
  /** Pseudo-count of the prior — controls how fast evidence narrows the interval. */
  priorWeight: number;
  /** Trailing window (years) for trajectory. */
  trajectoryWindowYears: number;
}

export const DEFAULT_CONFIG: ScoringConfig = {
  // 8y half-life: forgiveness without erasing a career; prior mass of one
  // pseudo-observation so thin-but-strong evidence reads high-estimate/
  // wide-interval (the design's "thin bar, not a red bar" case) instead of
  // prior-dominated.
  halfLifeYears: 8,
  neutralPrior: 0.5,
  priorWeight: 1,
  trajectoryWindowYears: 6,
};

const MS_PER_YEAR = 365.25 * 24 * 3600 * 1000;

export function ageYears(iso: string, now = Date.now()): number {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 0;
  return Math.max(0, (now - t) / MS_PER_YEAR);
}

export function decayWeight(iso: string, cfg: ScoringConfig, now = Date.now()): number {
  return Math.pow(0.5, ageYears(iso, now) / cfg.halfLifeYears);
}

/** Rows eligible for scoring at all: public sensitivity only. */
export function scoreable(rows: ClaimRow[]): ClaimRow[] {
  return rows.filter((r) => r.sensitivity === "public");
}

/** Rows a given leaf may read: axis-tag match, sensitivity filter applied. */
export function rowsForLeaf(rows: ClaimRow[], tags: string[]): ClaimRow[] {
  const set = new Set(tags);
  return scoreable(rows).filter((r) => r.axes.some((a) => set.has(a)));
}

/**
 * A row's value on the 0..1 scale.
 * - accuracy leaves: resolved verifiable rows only. With stated_p, score is
 *   1 - Brier for the resolved outcome; without, 1/0 for true/false.
 * - judged/structural leaves: the recorder's confidence stands as the value
 *   for positive evidence rows; verifiable resolved rows count 1/0.
 */
function rowValue(r: ClaimRow, leafType: "accuracy" | "judged" | "structural"): number | null {
  if (leafType === "accuracy") {
    if (r.kind !== "verifiable") return null;
    if (r.resolution === "resolved_true") {
      if (typeof r.stated_p === "number") return 1 - Math.pow(1 - r.stated_p, 2);
      return 1;
    }
    if (r.resolution === "resolved_false") {
      if (typeof r.stated_p === "number") return 1 - Math.pow(r.stated_p, 2);
      return 0;
    }
    return null; // pending rows carry no accuracy signal
  }
  if (r.kind === "verifiable") {
    if (r.resolution === "resolved_true") return 1;
    if (r.resolution === "resolved_false") return 0;
    return null;
  }
  // Judged rows: explicit assessed value, else legacy fallback to confidence.
  // Biographical rows: explicit value, else a modest positive default — the
  // fact was recorded because it evidences standing; recorder confidence is a
  // WEIGHT, not a quality verdict (2026-08-28 audit: confidence-as-value made
  // a landmark design credit at import-confidence 0.4 read as mediocre evidence).
  if (r.value !== undefined) return r.value;
  return r.kind === "biographical" ? BIOGRAPHICAL_DEFAULT_VALUE : r.confidence;
}

export const BIOGRAPHICAL_DEFAULT_VALUE = 0.65;

/**
 * Row weight (2026-08-28 audit):
 * - resolved_true ages from the RESOLVED date — the proof is the evidence,
 *   and a correct call is not stale merely because it was made early.
 * - resolved_false ages from the happened date — forgiveness decays old
 *   mistakes (the design's stated purpose for decay).
 * - Both resolved kinds carry a horizon bonus: hard, long-range calls weigh
 *   more than same-week ones, capped at 3x at a 10-year horizon.
 * - Everything else ages from happened.
 */
export function rowWeight(r: ClaimRow, cfg: ScoringConfig, now = Date.now()): number {
  let ageRef = r.happened;
  let horizon = 1;
  if (r.kind === "verifiable" && (r.resolution === "resolved_true" || r.resolution === "resolved_false")) {
    const resolvedAt = r.resolved ?? r.happened;
    const horizonYears = Math.max(0, (Date.parse(resolvedAt) - Date.parse(r.happened)) / MS_PER_YEAR) || 0;
    horizon = 1 + Math.min(2, horizonYears / 5);
    if (r.resolution === "resolved_true") ageRef = resolvedAt;
  }
  return decayWeight(ageRef, cfg, now) * r.confidence * horizon;
}

export function scoreLeaf(
  rows: ClaimRow[],
  leaf: { name: string; tags: string[]; type: "accuracy" | "judged" | "structural" },
  branch: string,
  cfg: ScoringConfig = DEFAULT_CONFIG,
  now = Date.now(),
): LeafScore {
  const candidates = rowsForLeaf(rows, leaf.tags);
  const valued: { v: number; w: number; t: number }[] = [];
  for (const r of candidates) {
    const v = rowValue(r, leaf.type);
    if (v === null) continue;
    valued.push({ v, w: rowWeight(r, cfg, now), t: Date.parse(r.happened) });
  }
  const n = valued.reduce((s, x) => s + x.w, 0);
  if (valued.length === 0 || n <= 0) {
    return {
      leaf: leaf.name, branch, estimate: null,
      interval: 0.5, n: 0, rows: candidates.length, trajectory: null, insufficient: true,
    };
  }
  // Shrink toward the neutral prior; prior mass shrinks nothing downward on
  // its own — with sparse evidence the ESTIMATE stays near the prior and the
  // INTERVAL stays wide. Absence widens; it never subtracts.
  const mean = valued.reduce((s, x) => s + x.v * x.w, 0) / n;
  const estimate = (mean * n + cfg.neutralPrior * cfg.priorWeight) / (n + cfg.priorWeight);
  const interval = 0.5 / Math.sqrt(1 + n);
  // Trajectory: weighted least-squares slope of value vs time over the window.
  let trajectory: number | null = null;
  const cutoff = now - cfg.trajectoryWindowYears * MS_PER_YEAR;
  const windowed = valued.filter((x) => x.t >= cutoff && !Number.isNaN(x.t));
  if (windowed.length >= 3) {
    const W = windowed.reduce((s, x) => s + x.w, 0);
    const mt = windowed.reduce((s, x) => s + x.t * x.w, 0) / W;
    const mv = windowed.reduce((s, x) => s + x.v * x.w, 0) / W;
    const cov = windowed.reduce((s, x) => s + (x.t - mt) * (x.v - mv) * x.w, 0);
    const varT = windowed.reduce((s, x) => s + (x.t - mt) ** 2 * x.w, 0);
    trajectory = varT > 0 ? (cov / varT) * MS_PER_YEAR : null;
  }
  return {
    leaf: leaf.name, branch, estimate: round3(estimate),
    interval: round3(interval), n: round3(n), rows: candidates.length,
    trajectory: trajectory === null ? null : round3(trajectory), insufficient: false,
  };
}

export function scoreTree(rows: ClaimRow[], axes: AxesTree, cfg: ScoringConfig = DEFAULT_CONFIG, now = Date.now()): LeafScore[] {
  const out: LeafScore[] = [];
  for (const b of axes.branches) for (const leaf of b.leaves) out.push(scoreLeaf(rows, leaf, b.name, cfg, now));
  return out;
}

/** Explain: the exact rows (with weights) behind one leaf's score. */
export function explainLeaf(
  rows: ClaimRow[],
  leaf: { name: string; tags: string[]; type: "accuracy" | "judged" | "structural" },
  cfg: ScoringConfig = DEFAULT_CONFIG,
  now = Date.now(),
): { id: string; statement: string; happened: string; source: string; weight: number; value: number }[] {
  return rowsForLeaf(rows, leaf.tags)
    .map((r) => {
      const v = rowValue(r, leaf.type);
      if (v === null) return null;
      return {
        id: r.id, statement: r.statement, happened: r.happened, source: r.source,
        weight: round3(rowWeight(r, cfg, now)), value: round3(v),
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .sort((a, b) => b.weight - a.weight);
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

/**
 * Composite VERA score, 1-100 (principal override 2026-08-28; supersedes the
 * original root-is-a-shape rule). 100 = a perfectly kind, perfectly intelligent
 * ASI: every leaf at 1.0 with strong evidence. Real humans top out well below.
 *
 * Evidence-weighted mean over leaves: a leaf with more (decayed) evidence
 * pulls harder; a leaf with no signal contributes the neutral prior at a
 * small weight, so unknown never zeroes anyone and never flatters anyone.
 */
export interface Composite {
  /** 1-100 integer. */
  score: number;
  /** Total effective evidence behind the number. */
  n: number;
  /** How much of the tree has real signal, 0..1. */
  coverage: number;
}

const INSUFFICIENT_WEIGHT = 0.15;

export function composite(leaves: LeafScore[], neutralPrior = DEFAULT_CONFIG.neutralPrior): Composite {
  let num = 0, den = 0, n = 0, withSignal = 0;
  for (const l of leaves) {
    if (l.insufficient || l.estimate === null) {
      num += neutralPrior * INSUFFICIENT_WEIGHT;
      den += INSUFFICIENT_WEIGHT;
    } else {
      const w = l.n / (l.n + 1);
      num += l.estimate * w;
      den += w;
      n += l.n;
      withSignal++;
    }
  }
  const raw = den > 0 ? num / den : neutralPrior;
  return {
    score: displayScore(raw),
    n: round3(n),
    coverage: leaves.length > 0 ? round3(withSignal / leaves.length) : 0,
  };
}

/**
 * Raw→display calibration (principal directive, 2026-08-28). The evidence math compresses
 * humans into roughly 0.45-0.75 raw, so a linear ×100 read the strongest
 * evidence profiles as high-60s. This tanh expansion spreads the human band while keeping BOTH
 * anchors: 50 = neutral/unknown, 100 = the perfect-ASI asymptote (reached
 * only at raw 1.0). Roughly: 0.55→64, 0.60→73, 0.65→80, 0.70→88, 0.75→93.
 */
const DISPLAY_SPREAD = 5;

export function displayScore(raw: number): number {
  const t = Math.tanh(DISPLAY_SPREAD * (raw - 0.5)) / Math.tanh(DISPLAY_SPREAD * 0.5);
  return Math.min(100, Math.max(1, Math.round(50 + 50 * t)));
}

/** Branch-level composites: same roll-up, per branch. */
export function branchComposites(leaves: LeafScore[]): { branch: string; composite: Composite }[] {
  const by = new Map<string, LeafScore[]>();
  for (const l of leaves) {
    if (!by.has(l.branch)) by.set(l.branch, []);
    by.get(l.branch)!.push(l);
  }
  return [...by.entries()].map(([branch, ls]) => ({ branch, composite: composite(ls) }));
}
