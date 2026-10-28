/**
 * Watch — the daily "did anything break" checks. Code only, no model calls.
 *
 * The outcome series is the v4 failure rate per 100 exchanges, one point a day. A day alarms on two
 * Western Electric rules against the trailing 28-day baseline: one point beyond 3 standard
 * deviations, or 8 consecutive points on one side of the mean. A failure class alarms when its
 * sessions in the last 48 hours reach 3 and at least 3 times its trailing rate.
 *
 * @version 1.0.0
 */
import type { Exchange } from "../TOOLS/ChangeImpact";

const DAY = 86_400_000;
export const MIN_DAY_N = 20;

export interface DayPoint { date: string; n: number; failures: number; rate: number | null }
export interface Alarm { rule: "three-sigma" | "run-of-eight" | "new-cluster"; date: string; detail: string; value: number; mean?: number; sd?: number; class?: string }

export const dayOf = (ts: string | number): string => new Date(ts).toISOString().slice(0, 10);

/** One point per UTC day for the `days` days ending on `now`'s day; days under MIN_DAY_N labeled exchanges carry no rate. */
export function dailySeries(exchanges: Exchange[], isFailure: (e: Exchange) => boolean | null, now: Date, days = 60): DayPoint[] {
  const end = Date.parse(dayOf(now.getTime())) + DAY;
  const start = end - days * DAY;
  const byDay = new Map<string, { n: number; failures: number }>();
  for (let t = start; t < end; t += DAY) byDay.set(dayOf(t), { n: 0, failures: 0 });
  for (const e of exchanges) {
    const t = Date.parse(e.ts);
    if (!(t >= start && t < end)) continue;
    const v = isFailure(e);
    if (v === null) continue;
    const d = byDay.get(dayOf(t))!;
    d.n++; if (v) d.failures++;
  }
  return [...byDay].map(([date, d]) => ({ date, n: d.n, failures: d.failures, rate: d.n >= MIN_DAY_N ? Math.round(1000 * 100 * d.failures / d.n) / 1000 : null }));
}

/** The spread has a floor of 1 percentage point: a perfectly flat baseline would otherwise make any spike invisible (sd 0). */
export const SD_FLOOR = 1;
const stats = (xs: number[]) => {
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, xs.length - 1));
  return { mean, sd: Math.max(sd, SD_FLOOR) };
};

/** Western Electric rules 1 and 4 on the latest day, against the 28 days before the window under test. */
export function controlChart(series: DayPoint[], baselineDays = 28): Alarm[] {
  const pts = series.filter((p) => p.rate !== null) as Array<DayPoint & { rate: number }>;
  const alarms: Alarm[] = [];
  if (pts.length < 10) return alarms;
  const last = pts[pts.length - 1];
  const base = pts.slice(Math.max(0, pts.length - 1 - baselineDays), pts.length - 1).map((p) => p.rate);
  if (base.length >= 10) {
    const { mean, sd } = stats(base);
    if (Math.abs(last.rate - mean) > 3 * sd)
      alarms.push({ rule: "three-sigma", date: last.date, value: last.rate, mean: round(mean), sd: round(sd), detail: `failure rate ${last.rate}% vs baseline ${round(mean)}% ± ${round(sd)}` });
  }
  if (pts.length >= 18) {
    const run = pts.slice(-8);
    const before = pts.slice(Math.max(0, pts.length - 8 - baselineDays), pts.length - 8).map((p) => p.rate);
    if (before.length >= 10) {
      const { mean, sd } = stats(before);
      const side = run.map((p) => Math.sign(p.rate - mean));
      if (side.every((s) => s === 1) || side.every((s) => s === -1))
        alarms.push({ rule: "run-of-eight", date: last.date, value: last.rate, mean: round(mean), sd: round(sd), detail: `8 days in a row ${side[0] === 1 ? "above" : "below"} the baseline mean ${round(mean)}%` });
    }
  }
  return alarms;
}

const round = (x: number) => Math.round(x * 100) / 100;

/**
 * Failure classes whose distinct sessions in the last 48 hours reach `min` and at least `factor`
 * times their average 48-hour count over the prior `baselineDays`.
 */
export function newClusters(exchanges: Array<Exchange & { session?: string }>, classOf: (id: string) => string | null, now: Date, opts: { min?: number; factor?: number; baselineDays?: number } = {}): Alarm[] {
  const min = opts.min ?? 3, factor = opts.factor ?? 3, baselineDays = opts.baselineDays ?? 28;
  const t0 = now.getTime(), recentFrom = t0 - 2 * DAY, baseFrom = recentFrom - baselineDays * DAY;
  const recent = new Map<string, Set<string>>(), base = new Map<string, Set<string>>();
  for (const e of exchanges) {
    const cls = classOf(e.id); if (!cls) continue;
    const t = Date.parse(e.ts), session = e.session ?? e.id;
    const bucket = t >= recentFrom && t < t0 ? recent : t >= baseFrom && t < recentFrom ? base : null;
    if (!bucket) continue;
    if (!bucket.has(cls)) bucket.set(cls, new Set());
    bucket.get(cls)!.add(session);
  }
  const alarms: Alarm[] = [];
  for (const [cls, sessions] of recent) {
    const per48 = (base.get(cls)?.size ?? 0) / (baselineDays / 2);
    if (sessions.size >= min && sessions.size >= factor * per48)
      alarms.push({ rule: "new-cluster", date: dayOf(t0), class: cls, value: sessions.size, mean: round(per48), detail: `${cls}: ${sessions.size} sessions in 48h vs ${round(per48)} usual` });
  }
  return alarms.sort((a, b) => b.value - a.value);
}

/** A synthetic series with a spike on the last day: the monthly fire drill runs the chart on it. */
export function fireDrillSeries(now: Date): DayPoint[] {
  const pts: DayPoint[] = [];
  for (let i = 40; i >= 1; i--) pts.push({ date: dayOf(now.getTime() - i * DAY), n: 200, failures: 40 + (i % 5) - 2, rate: 20 + ((i % 5) - 2) / 2 });
  pts.push({ date: dayOf(now.getTime()), n: 200, failures: 120, rate: 60 });
  return pts;
}
