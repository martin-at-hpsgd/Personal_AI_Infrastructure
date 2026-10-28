/**
 * @version 1.0.0
 * Label.ts — outcome labels for every human turn: labeling-function votes combined by Dawid–Skene.
 *
 * Each labeling function looks at one kind of evidence and votes 1 (bad), 0 (good) or abstains:
 *
 *   errata         a deliberate human filing (er-command / terminal, principal or team) or an explicit 1–10
 *                  rating that judges the turn. Hook captures (hook:prompt), transcript backfill text and
 *                  `detected` rows never vote: the first two come from the same frustrationRead as the
 *                  frustration function, the last is this model's own output.
 *   interrupt      the principal stopped the turn ([Request interrupted by user], not a shutdown) -> bad
 *   frustration    frustrationRead(next prompt).fires -> bad
 *   reformulation  correctionSignal(next) is the "no, I meant …" leg Signals.ts misses -> bad
 *   reask          next prompt repeats this one (word Jaccard >= 0.6, TurnOutcomes rule) -> bad
 *   approval       next prompt is a bare go-ahead (y, c, si, do it, ship it) -> good
 *   praise         next prompt praises with no negative signal -> good
 *
 * There is no "the next prompt moved on" function: it would be the exact complement of the others firing,
 * which breaks the independence the fit assumes, and on the live index it pulled the prior to 0.63
 * (2026-10-09). The last five read the next human prompt, so they are eligible only when one exists. A turn followed by
 * silence gets no vote from them and contributes no likelihood term at all: silence never counts as success.
 *
 * Dawid–Skene (1979): each function j has a confusion matrix π_j[y][v] over v in {0, 1, abstain}, fitted by
 * EM with every item where j is eligible. Abstaining while eligible is informative (the person spoke and did
 * not complain); being ineligible is not observed. Nothing is hand-weighted.
 *
 * The fit is anchored: the Errata v4 gold exchanges (majority of three blind labelers) are clamped to their
 * labels during EM, so "bad" means what the labelers meant and cannot drift onto the bulk of quiet turns.
 * Every turn, gold included, is then scored with the fitted parameters and no clamp, so the cut chosen on
 * gold is not chosen on its own answers. Holdout is never clamped and stays the honest check.
 */
import type { Database } from "bun:sqlite";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { ErrataStore } from "../ERRATA/Store";
import { MACHINE_SOURCES, type Erratum, type Source } from "../ERRATA/Schema";
import { invariant } from "../TOOLS/Invariant";
import { COMPLAINT_KINDS, DETECTED_SOURCE, OWN_PROMPT_WINDOW_MS, judgedHumanTurn, turnsBySession, type Turn } from "./Queries";

export const LABEL_SOURCE = "ds-v1";
export const FUNCTIONS = ["errata", "interrupt", "frustration", "reformulation", "reask", "approval", "praise"] as const;
export type Fn = (typeof FUNCTIONS)[number];
export const REACTION_FUNCTIONS: ReadonlySet<Fn> = new Set<Fn>(["frustration", "reformulation", "reask", "approval", "praise"]);
export const REASK_JACCARD = 0.6;
export const DELIBERATE_CHANNELS: ReadonlySet<string> = new Set(["er-command", "terminal"]);
export const RATING_BAD_MAX = 5;
export const RATING_GOOD_MIN = 8;
/** Trigger cut: the lowest P(bad) whose gold precision is at least this, with at least MIN_CUT_SUPPORT turns above it. */
export const CUT_PRECISION = 0.8;
export const MIN_CUT_SUPPORT = 5;

export type Vote = 0 | 1 | null;
export interface FnVote { vote: Vote; eligible: boolean }

export interface ReactionRow {
  has_next: number; frustration: number | null; correction: string | null; approval: number | null; praise: number | null;
  reask_jaccard: number | null; interrupted: number; next_chars: number | null;
}

/** Votes of the seven transcript functions for one turn. `errata` comes from errataVote. */
export function reactionVotes(r: ReactionRow | null): Record<Exclude<Fn, "errata">, FnVote> {
  const next = !!r && r.has_next === 1;
  const v = (cond: boolean, value: 0 | 1): FnVote => ({ vote: next && cond ? value : null, eligible: next });
  const j = r?.reask_jaccard ?? null;
  return {
    interrupt: { vote: r?.interrupted === 1 ? 1 : null, eligible: true },
    frustration: v(r?.frustration === 1, 1),
    reformulation: v(r?.correction === "reformulation", 1),
    reask: v(j !== null && j >= REASK_JACCARD, 1),
    approval: v(r?.approval === 1, 0),
    praise: v(r?.praise === 1, 0),
  };
}

/** The vote one Errata row casts, or null when it is not a deliberate human judgment. */
export function errataVote(e: Erratum): Vote {
  if (e.source === DETECTED_SOURCE || MACHINE_SOURCES.has(e.source as Source)) return null;
  if (typeof e.rating === "number") return e.rating <= RATING_BAD_MAX ? 1 : e.rating >= RATING_GOOD_MIN ? 0 : null;
  if (e.source === "backfill" || !DELIBERATE_CHANNELS.has(e.channel)) return null;
  if (COMPLAINT_KINDS.has(e.kind)) return 1;
  return e.kind === "praise" ? 0 : null;
}

/** Every Errata row mapped to the human turn it judges (same join as Queries.judgedTurn). */
export function errataByTurn(sessions: Map<string, Turn[]>, rows: Erratum[]): Map<string, Erratum[]> {
  const out = new Map<string, Erratum[]>();
  for (const e of rows) {
    const sid = e.context?.session_id;
    if (!sid) continue;
    const span = judgedHumanTurn(sessions.get(sid), e.ts);
    if (!span) continue;
    const list = out.get(span) ?? [];
    list.push(e);
    out.set(span, list);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// Dawid–Skene

/** Per item, per function: -1 ineligible, 0 good, 1 bad, 2 abstained while eligible. */
export type Matrix = Int8Array[];
export const INELIGIBLE = -1;
export const ABSTAIN = 2;

export interface DsFit {
  prior: number; iterations: number; converged: boolean;
  /** confusion[j][y][v], v in {0, 1, abstain} */
  confusion: number[][][];
  /** P(bad) per item */
  posterior: Float64Array;
  /** P(vote is right | function voted), from the fitted confusion and the prior over items where it is eligible */
  accuracy: Array<number | null>;
  votes: number[];
  /** Items clamped to a known label during EM. */
  anchored: number;
}

export function encode(v: FnVote): number { return !v.eligible ? INELIGIBLE : v.vote === null ? ABSTAIN : v.vote; }

/** Majority of the non-abstaining votes: 1, 0, or null on a tie or no votes. */
export function majorityVote(row: Int8Array): 0 | 1 | null {
  let bad = 0, good = 0;
  for (const v of row) { if (v === 1) bad++; else if (v === 0) good++; }
  return bad > good ? 1 : good > bad ? 0 : null;
}

export function fitDawidSkene(m: Matrix, opts: { maxIter?: number; tol?: number; smoothing?: number; anchors?: Map<number, 0 | 1> } = {}): DsFit {
  const N = m.length;
  const J = N ? m[0].length : 0;
  const maxIter = opts.maxIter ?? 500, tol = opts.tol ?? 1e-7, alpha = opts.smoothing ?? 0.5;
  const q = new Float64Array(N);
  // Initialize from majority vote so class 1 starts as "bad"; no votes -> 0.5.
  const anchors = opts.anchors ?? new Map<number, 0 | 1>();
  for (const [i, y] of anchors) invariant(i >= 0 && i < N && (y === 0 || y === 1), `anchor ${i}=${y} out of range`);
  for (let i = 0; i < N; i++) { const mv = majorityVote(m[i]); q[i] = anchors.get(i) ?? (mv === null ? 0.5 : mv === 1 ? 0.9 : 0.1); }
  let prior = 0.5;
  const confusion: number[][][] = Array.from({ length: J }, () => [[1 / 3, 1 / 3, 1 / 3], [1 / 3, 1 / 3, 1 / 3]]);
  let iter = 0, converged = false;
  for (; iter < maxIter; iter++) {
    // M-step
    let sq = 0;
    for (let i = 0; i < N; i++) sq += q[i];
    prior = Math.min(1 - 1e-4, Math.max(1e-4, N ? sq / N : 0.5));
    for (let j = 0; j < J; j++) {
      const c = [[alpha, alpha, alpha], [alpha, alpha, alpha]];
      for (let i = 0; i < N; i++) {
        const v = m[i][j];
        if (v === INELIGIBLE) continue;
        c[1][v] += q[i];
        c[0][v] += 1 - q[i];
      }
      for (const y of [0, 1]) { const s = c[y][0] + c[y][1] + c[y][2]; confusion[j][y] = c[y].map((x) => x / s); }
    }
    // E-step
    let delta = 0;
    for (let i = 0; i < N; i++) {
      const p = anchors.get(i) ?? score(i);
      delta = Math.max(delta, Math.abs(p - q[i]));
      q[i] = p;
    }
    if (delta < tol) { converged = true; iter++; break; }
  }
  function score(i: number): number {
    let z = Math.log(prior / (1 - prior));
    for (let j = 0; j < J; j++) { const v = m[i][j]; if (v !== INELIGIBLE) z += Math.log(confusion[j][1][v] / confusion[j][0][v]); }
    return 1 / (1 + Math.exp(-z));
  }
  // Report every item unclamped, so an anchored item is scored by the model, not by its own label.
  const posterior = new Float64Array(N);
  for (let i = 0; i < N; i++) posterior[i] = score(i);
  const accuracy: Array<number | null> = [];
  const votes: number[] = [];
  for (let j = 0; j < J; j++) {
    let eligible = 0, sum = 0, nv = 0;
    for (let i = 0; i < N; i++) { const v = m[i][j]; if (v === INELIGIBLE) continue; eligible++; sum += posterior[i]; if (v === 0 || v === 1) nv++; }
    votes.push(nv);
    if (!eligible || !nv) { accuracy.push(null); continue; }
    const p1 = sum / eligible, p0 = 1 - p1;
    const c = confusion[j];
    const voted = p0 * (1 - c[0][ABSTAIN]) + p1 * (1 - c[1][ABSTAIN]);
    accuracy.push((p0 * c[0][0] + p1 * c[1][1]) / voted);
  }
  return { prior, iterations: iter, converged, confusion, posterior, accuracy, votes, anchored: anchors.size };
}

// ---------------------------------------------------------------------------------------------------------
// Evaluation

/** Area under the ROC curve (Mann–Whitney, ties count half). Null when one class is empty. */
export function auc(scores: number[], labels: boolean[]): number | null {
  const idx = scores.map((s, i) => i).sort((a, b) => scores[a] - scores[b]);
  const ranks = new Float64Array(scores.length);
  for (let i = 0; i < idx.length;) {
    let k = i;
    while (k + 1 < idx.length && scores[idx[k + 1]] === scores[idx[i]]) k++;
    const r = (i + k) / 2 + 1;
    for (let t = i; t <= k; t++) ranks[idx[t]] = r;
    i = k + 1;
  }
  let pos = 0, sumPos = 0;
  labels.forEach((l, i) => { if (l) { pos++; sumPos += ranks[i]; } });
  const neg = labels.length - pos;
  if (!pos || !neg) return null;
  return (sumPos - (pos * (pos + 1)) / 2) / (pos * neg);
}

export interface Cut { cut: number; precision: number; flagged: number; true_positive: number }

/** Lowest threshold with precision >= minPrecision and at least minSupport items at or above it. */
export function chooseCut(scores: number[], labels: boolean[], minPrecision = CUT_PRECISION, minSupport = MIN_CUT_SUPPORT): Cut | null {
  const order = scores.map((s, i) => i).sort((a, b) => scores[b] - scores[a]);
  let best: Cut | null = null, tp = 0;
  for (let k = 0; k < order.length; k++) {
    if (labels[order[k]]) tp++;
    const t = scores[order[k]];
    if (k + 1 < order.length && scores[order[k + 1]] === t) continue; // take ties together
    const n = k + 1;
    if (n >= minSupport && tp / n >= minPrecision) best = { cut: t, precision: tp / n, flagged: n, true_positive: tp };
  }
  return best;
}

export function precisionAt(scores: number[], labels: boolean[], cut: number): { precision: number | null; flagged: number; true_positive: number } {
  let n = 0, tp = 0;
  scores.forEach((s, i) => { if (s >= cut) { n++; if (labels[i]) tp++; } });
  return { precision: n ? tp / n : null, flagged: n, true_positive: tp };
}

export interface LabeledSet { name: string; ids: number; mapped: number; unhappy: number; spans: string[]; unhappyBy: boolean[] }

/**
 * An Errata v4 exchange set mapped onto index turns. The exchange prompt is the reaction, so the judged
 * turn is the human turn whose next human prompt is that exchange's own prompt (reactions.next_span_id).
 * Label: majority of the three blind labelers' answers.unhappy.
 */
export function loadLabeledSet(db: Database, dir: string, name: "gold" | "holdout", sessions: Map<string, Turn[]>): LabeledSet | null {
  const input = join(dir, `${name}-input.jsonl`);
  const exch = join(dir, "exchanges.jsonl");
  if (!existsSync(input) || !existsSync(exch)) return null;
  const lines = (p: string) => readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, any>);
  const ids = lines(input).map((r) => String(r.id));
  const want = new Set(ids);
  const ex = new Map<string, { ts: string; session: string }>();
  for (const r of lines(exch)) if (want.has(r.id)) ex.set(r.id, { ts: r.ts, session: r.session });
  const votes = new Map<string, boolean[]>();
  for (const labeler of ["opus", "fable", "astra"]) {
    const p = join(dir, `labels-${name}`, `${labeler}.jsonl`);
    if (!existsSync(p)) continue;
    for (const r of lines(p)) if (typeof r.answers?.unhappy === "boolean") { const v = votes.get(r.id) ?? []; v.push(r.answers.unhappy); votes.set(r.id, v); }
  }
  const byNext = db.query("SELECT span_id FROM reactions WHERE next_span_id = ?");
  const set: LabeledSet = { name, ids: ids.length, mapped: 0, unhappy: 0, spans: [], unhappyBy: [] };
  for (const id of ids) {
    const e = ex.get(id);
    const v = votes.get(id);
    if (!e || !v?.length) continue;
    const turns = sessions.get(e.session);
    if (!turns) continue;
    const t = Date.parse(e.ts);
    let own: Turn | null = null, bestD = Infinity;
    for (const x of turns) { const d = Math.abs(x.ms - t); if (x.origin === "human" && d <= OWN_PROMPT_WINDOW_MS && d < bestD) { bestD = d; own = x; } }
    if (!own) continue;
    const judged = byNext.get(own.span_id) as { span_id: string } | null;
    if (!judged) continue;
    const unhappy = v.filter(Boolean).length * 2 > v.length;
    set.mapped++; if (unhappy) set.unhappy++;
    set.spans.push(judged.span_id); set.unhappyBy.push(unhappy);
  }
  return set;
}

// ---------------------------------------------------------------------------------------------------------
// The label run

export interface LabelOptions { errataDir?: string; tenantDir?: string; goldDir?: string; now?: Date }
export interface SetEval { mapped: number; of: number; unhappy: number; auc_ds: number | null; auc_by_fn: Record<string, number | null>; best_single: { fn: string; auc: number } | null }
export interface LabelSummary {
  source: string; human_turns: number; turns_with_next: number; reactions_missing: number;
  votes_by_fn: Record<string, { bad: number; good: number; eligible: number }>;
  fit: { prior: number; anchored: number; iterations: number; converged: boolean; accuracy: Record<string, number | null> };
  mean_p_bad: number;
  eval: { gold: SetEval | null; holdout: SetEval | null };
  cut: (Cut & { holdout: ReturnType<typeof precisionAt> | null }) | null;
}

function evalSet(set: LabeledSet | null, p: Map<string, number>, fnVotes: Map<string, Record<Fn, FnVote>>): SetEval | null {
  if (!set) return null;
  const scores = set.spans.map((s) => p.get(s) ?? NaN);
  const keep = scores.map((s) => Number.isFinite(s));
  const sc = scores.filter((_, i) => keep[i]);
  const lb = set.unhappyBy.filter((_, i) => keep[i]);
  const auc_by_fn: Record<string, number | null> = {};
  for (const fn of FUNCTIONS) {
    const s = set.spans.filter((_, i) => keep[i]).map((span) => { const v = fnVotes.get(span)?.[fn]?.vote; return v === 1 ? 1 : v === 0 ? 0 : 0.5; });
    auc_by_fn[fn] = auc(s, lb);
  }
  const ranked = Object.entries(auc_by_fn).filter((e): e is [string, number] => e[1] !== null).sort((a, b) => b[1] - a[1]);
  return { mapped: sc.length, of: set.ids, unhappy: lb.filter(Boolean).length, auc_ds: auc(sc, lb), auc_by_fn, best_single: ranked.length ? { fn: ranked[0][0], auc: ranked[0][1] } : null };
}

export function label(db: Database, o: LabelOptions = {}): LabelSummary {
  const now = (o.now ?? new Date()).toISOString();
  const turns = db.query(`SELECT s.span_id, r.has_next, r.frustration, r.correction, r.approval, r.praise, r.reask_jaccard, r.interrupted, r.next_chars, r.span_id AS r_span
    FROM spans s LEFT JOIN reactions r USING (span_id) WHERE s.origin = 'human' AND s.parent_span_id IS NULL ORDER BY s.start_time, s.span_id`).all() as Array<ReactionRow & { span_id: string; r_span: string | null }>;
  const sessions = turnsBySession(db);
  const store = o.errataDir ? new ErrataStore(o.errataDir, o.tenantDir ?? o.errataDir) : new ErrataStore();
  const linked = errataByTurn(sessions, store.all());

  const fnVotes = new Map<string, Record<Fn, FnVote>>();
  const votesByFn: LabelSummary["votes_by_fn"] = Object.fromEntries(FUNCTIONS.map((f) => [f, { bad: 0, good: 0, eligible: 0 }]));
  const matrix: Matrix = [];
  let missing = 0, withNext = 0;
  for (const t of turns) {
    if (!t.r_span) missing++;
    if (t.has_next === 1) withNext++;
    const ev = (linked.get(t.span_id) ?? []).map(errataVote).filter((v): v is 0 | 1 => v !== null);
    const errata: FnVote = { vote: ev.length ? (ev.includes(1) ? 1 : 0) : null, eligible: true };
    const all = { errata, ...reactionVotes(t.r_span ? t : null) } as Record<Fn, FnVote>;
    fnVotes.set(t.span_id, all);
    const row = new Int8Array(FUNCTIONS.length);
    FUNCTIONS.forEach((fn, j) => {
      const v = all[fn];
      row[j] = encode(v);
      if (v.eligible) votesByFn[fn].eligible++;
      if (v.vote === 1) votesByFn[fn].bad++; else if (v.vote === 0) votesByFn[fn].good++;
    });
    matrix.push(row);
  }

  const goldDir = o.goldDir;
  const goldSet = goldDir ? loadLabeledSet(db, goldDir, "gold", sessions) : null;
  const holdoutSet = goldDir ? loadLabeledSet(db, goldDir, "holdout", sessions) : null;
  const index = new Map(turns.map((t, i) => [t.span_id, i]));
  const anchors = new Map<number, 0 | 1>();
  goldSet?.spans.forEach((s, k) => { const i = index.get(s); if (i !== undefined) anchors.set(i, goldSet.unhappyBy[k] ? 1 : 0); });
  const fit = fitDawidSkene(matrix, { anchors });
  const p = new Map<string, number>();
  turns.forEach((t, i) => p.set(t.span_id, fit.posterior[i]));

  const insVote = db.query("INSERT INTO votes (span_id, fn, vote, eligible) VALUES (?, ?, ?, ?)");
  const insScore = db.query("INSERT INTO scores (span_id, source, value, confidence, ts) VALUES (?, ?, ?, ?, ?)");
  db.transaction(() => {
    db.exec("DELETE FROM votes");
    db.query("DELETE FROM scores WHERE source = ?").run(LABEL_SOURCE);
    for (const t of turns) {
      const all = fnVotes.get(t.span_id)!;
      for (const fn of FUNCTIONS) {
        const v = all[fn];
        invariant(v.vote === null || v.vote === 0 || v.vote === 1, `vote ${v.vote} for ${fn}`);
        invariant(v.eligible || v.vote === null, `${fn} voted on ${t.span_id} while ineligible`);
        if (REACTION_FUNCTIONS.has(fn) && t.has_next !== 1) invariant(v.vote === null, `${fn} voted on ${t.span_id} with no next prompt`);
        insVote.run(t.span_id, fn, v.vote, v.eligible ? 1 : 0);
      }
      const pb = p.get(t.span_id)!;
      invariant(Number.isFinite(pb) && pb >= 0 && pb <= 1, `P(bad) ${pb} for ${t.span_id}`);
      insScore.run(t.span_id, LABEL_SOURCE, pb, Math.abs(2 * pb - 1), now);
    }
  })();

  const gold = evalSet(goldSet, p, fnVotes);
  const holdout = evalSet(holdoutSet, p, fnVotes);
  let cut: LabelSummary["cut"] = null;
  {
    const gs = goldSet;
    if (gs) {
      const sc = gs.spans.map((s) => p.get(s) ?? 0);
      const c = chooseCut(sc, gs.unhappyBy);
      if (c) {
        const hold = holdoutSet ? precisionAt(holdoutSet.spans.map((s) => p.get(s) ?? 0), holdoutSet.unhappyBy, c.cut) : null;
        cut = { ...c, holdout: hold };
      }
    }
  }
  db.transaction(() => {
    db.query("INSERT OR REPLACE INTO meta (key, value) VALUES ('label_fit', ?)").run(JSON.stringify({ source: LABEL_SOURCE, ts: now, prior: fit.prior, anchored: fit.anchored, accuracy: fit.accuracy }));
    if (cut) db.query("INSERT OR REPLACE INTO meta (key, value) VALUES ('trigger_cut', ?)").run(JSON.stringify({ source: LABEL_SOURCE, ts: now, ...cut }));
    else db.query("DELETE FROM meta WHERE key = 'trigger_cut'").run();
  })();

  let sum = 0;
  for (const v of fit.posterior) sum += v;
  return {
    source: LABEL_SOURCE, human_turns: turns.length, turns_with_next: withNext, reactions_missing: missing, votes_by_fn: votesByFn,
    fit: { prior: fit.prior, anchored: fit.anchored, iterations: fit.iterations, converged: fit.converged, accuracy: Object.fromEntries(FUNCTIONS.map((f, j) => [f, fit.accuracy[j]])) },
    mean_p_bad: turns.length ? sum / turns.length : 0,
    eval: { gold, holdout }, cut,
  };
}
