/**
 * Monthly — is LifeOS getting better, and is the Review any good?
 *
 * Scores every accepted prediction that came due, grades each generator on what it got accepted and
 * how its predictions held up (hit rate and Brier score), writes a label batch so the v4 detector can
 * be checked against the principal, runs a fire drill on the daily watch, and reports the class trend.
 *
 * @version 1.0.0
 */
import { compare, type Data } from "./Metrics";
import { controlChart, fireDrillSeries } from "./Watch";
import type { Rec, Score } from "./Store";
import type { UpgradeLike } from "./Weekly";
import type { Exchange } from "../TOOLS/ChangeImpact";

const DAY = 86_400_000;

/** Hit when the metric moved the predicted way by at least the predicted size; underpowered when the windows could not see it. */
export function scoreRec(rec: Rec, d: Data, now: Date): Score | null {
  const p = rec.prediction;
  if (rec.status !== "accepted" || !p || rec.score || !rec.decided || Date.parse(p.due) > now.getTime()) return null;
  const cut = Date.parse(rec.decided), span = Math.max(DAY, Date.parse(p.due) - cut);
  const c = compare(p.metric as never, p.args, cut, span, d);
  const ts = now.toISOString();
  if (c.change_pct === null || c.mde_pct > p.size_pct) return { result: "underpowered", change_pct: c.change_pct, mde_pct: c.mde_pct, ts };
  const moved = p.direction === "down" ? -c.change_pct : c.change_pct;
  return { result: moved >= p.size_pct ? "hit" : "miss", change_pct: c.change_pct, mde_pct: c.mde_pct, ts };
}

export interface GeneratorCard { generator: string; recommended: number; accepted: number; applied: number; verified: number; scored: number; hits: number; hit_rate: number | null; brier: number | null }

/**
 * One row per Upgrades source over the last 60 days, plus one for the Review's own recommendations,
 * so the Review is graded by the same card it grades everyone else with.
 */
export function scorecard(upgrades: UpgradeLike[], recs: Rec[], now: Date): GeneratorCard[] {
  const since = now.getTime() - 60 * DAY;
  const rows = new Map<string, GeneratorCard>();
  const row = (g: string) => rows.get(g) ?? rows.set(g, { generator: g, recommended: 0, accepted: 0, applied: 0, verified: 0, scored: 0, hits: 0, hit_rate: null, brier: null }).get(g)!;
  for (const u of upgrades) {
    if (Date.parse(u.created) < since) continue;
    const r = row(u.source);
    r.recommended++;
    if (u.status === "accepted") r.accepted++;
    if (u.status === "applied") r.applied++;
    if (u.status === "verified") r.verified++;
  }
  const review = row("review");
  const brierTerms: number[] = [];
  for (const rec of recs) {
    if (Date.parse(rec.created) < since) continue;
    review.recommended++;
    if (rec.status === "accepted") review.accepted++;
    if (rec.score && rec.score.result !== "underpowered" && rec.prediction) {
      review.scored++;
      const hit = rec.score.result === "hit" ? 1 : 0;
      review.hits += hit;
      brierTerms.push((rec.prediction.p - hit) ** 2);
    }
  }
  for (const r of rows.values()) r.hit_rate = r.scored ? Math.round(1000 * r.hits / r.scored) / 1000 : null;
  review.brier = brierTerms.length ? Math.round(1000 * brierTerms.reduce((a, b) => a + b, 0) / brierTerms.length) / 1000 : null;
  return [...rows.values()].sort((a, b) => b.recommended - a.recommended);
}

// ── Label batch: is the v4 detector right? ──────────────────────────────────

export interface LabelItem { id: string; ts: string; detector: "failure" | "pass"; prompt: string; reply: string; label: "y" | "n" | null }
export interface LabelBatch { month: string; created: string; items: LabelItem[] }

/** 10 detected failures and 10 passes from the last 30 days, picked deterministically by month. */
export function labelBatch(d: Data, now: Date, perSide = 10): LabelBatch {
  const month = now.toISOString().slice(0, 7);
  const since = now.getTime() - 30 * DAY;
  const pick = (want: boolean) => d.exchanges
    .filter((e) => Date.parse(e.ts) >= since && d.isFailure(e) === want && (e.prompt ?? "").trim().length > 10)
    .sort((a, b) => hash(month + a.id) - hash(month + b.id)).slice(0, perSide);
  const item = (e: Exchange, detector: LabelItem["detector"]): LabelItem => ({ id: e.id, ts: e.ts, detector, prompt: (e.prompt ?? "").slice(0, 400), reply: (e.reply_tail ?? "").slice(-400), label: null });
  return { month, created: now.toISOString(), items: [...pick(true).map((e) => item(e, "failure")), ...pick(false).map((e) => item(e, "pass"))] };
}

const hash = (s: string) => { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; };

/**
 * Cohen's kappa between the detector and the principal's truth. A "y" label means the detector was right,
 * so the truth is the detector's call; "n" flips it.
 */
export function detectorAgreement(batch: LabelBatch): { labeled: number; agreement: number | null; kappa: number | null } {
  const done = batch.items.filter((i) => i.label);
  if (done.length < 4) return { labeled: done.length, agreement: null, kappa: null };
  let a = 0, b = 0, c = 0, d = 0; // detector failure/pass × truth failure/pass
  for (const i of done) {
    const det = i.detector === "failure", truth = i.label === "y" ? det : !det;
    if (det && truth) a++; else if (det && !truth) b++; else if (!det && truth) c++; else d++;
  }
  const n = a + b + c + d, po = (a + d) / n, pe = ((a + b) * (a + c) + (c + d) * (b + d)) / (n * n);
  return { labeled: n, agreement: Math.round(1000 * po) / 1000, kappa: pe === 1 ? null : Math.round(1000 * (po - pe) / (1 - pe)) / 1000 };
}

// ── Fire drill and trend ────────────────────────────────────────────────────

/** The daily watch must alarm on an injected spike; if it cannot, its silence means nothing. */
export function fireDrill(now: Date): { fired: boolean; rules: string[] } {
  const alarms = controlChart(fireDrillSeries(now));
  return { fired: alarms.length > 0, rules: alarms.map((a) => a.rule) };
}

/** Each failure class per 100 classified exchanges, this month against last month. */
export function classTrend(d: Data, now: Date) {
  const startThis = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const startLast = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1);
  const count = (from: number, to: number) => {
    const m = new Map<string, number>(); let n = 0;
    for (const e of d.exchanges) {
      const t = Date.parse(e.ts); if (t < from || t >= to) continue;
      if (d.isFailure(e) === null) continue;
      n++; const c = d.classOf(e.id); if (c) m.set(c, (m.get(c) ?? 0) + 1);
    }
    return { n, m };
  };
  const last = count(startLast, startThis), cur = count(startThis, now.getTime());
  const classes = new Set([...last.m.keys(), ...cur.m.keys()]);
  const per100 = (k: number, n: number) => (n ? Math.round(1000 * k / n) / 10 : null);
  return [...classes].map((cls) => ({ class: cls, last_month: per100(last.m.get(cls) ?? 0, last.n), this_month: per100(cur.m.get(cls) ?? 0, cur.n) }))
    .sort((a, b) => (b.this_month ?? 0) - (a.this_month ?? 0));
}
