/**
 * Metrics — the fixed catalog a prediction can name, computed in code so scoring never needs a model.
 * Every metric is a count over a denominator in a time window, so its minimum detectable change
 * between two windows comes from ChangeImpact.mdePct.
 *
 * @version 1.1.0
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { lifeosPath } from "../TOOLS/Paths";
import { mdePct, v4Verdicts, type Complaint, type Exchange } from "../TOOLS/ChangeImpact";
import { readAll, type TurnRecord } from "../TOOLS/TurnOutcomes";
import { ErrataStore } from "../ERRATA/Store";
import { loadSources, resolveComplaints, skillOf } from "../ERRATA/OutputJoin";

export const METRICS = {
  complaint_rate: "the principal's complaints and corrections per exchange",
  failure_rate: "v4 detector failures per labeled exchange",
  class_rate: "exchanges in one failure class (args.class) per classified exchange",
  rule_breaks: "breaks of one rule (args.rule) per exchange, from Errata v4 coverage",
  turn_corrections: "turns the next prompt corrected, per judged turn",
  skill_complaint_rate: "the principal's complaints and corrections about one skill (args.skill) per output that skill delivered",
} as const;
export type MetricId = keyof typeof METRICS;
export const isMetric = (m: string): m is MetricId => m in METRICS;
/** Which way is worse for each metric. Every catalog metric counts something going wrong, so up is worse. */
export const WORSE: Record<MetricId, "up" | "down"> = { complaint_rate: "up", failure_rate: "up", class_rate: "up", rule_breaks: "up", turn_corrections: "up", skill_complaint_rate: "up" };

/** A complaint carries the skills its delivered outputs belong to, the same join Errata's `impact --skill` makes. */
export type SkillComplaint = Complaint & { skills?: string[] };

export interface Data {
  exchanges: Array<Exchange & { session?: string }>;
  isFailure: (e: Exchange) => boolean | null;
  classOf: (id: string) => string | null;
  complaints: SkillComplaint[];
  /** Delivered outputs (blocked hand-offs excluded) and the skill each belongs to. */
  outputs: Array<{ ts: string; skill: string }>;
  coverage: Array<{ id: string; ts: string; rule: string; p: number }>;
  turns: TurnRecord[];
}

const principalComplaint = (c: Complaint) => (c.kind === "complaint" || c.kind === "correction") && c.status !== "duplicate" && (c.source ?? "principal") === "principal";

export interface Measure { count: number; n: number; rate: number | null }

export function measure(metric: MetricId, args: Record<string, string> = {}, from: number, to: number, d: Data): Measure {
  const inWin = (ts: string) => { const t = Date.parse(ts); return t >= from && t < to; };
  const exs = d.exchanges.filter((e) => inWin(e.ts));
  let count = 0, n = 0;
  switch (metric) {
    case "complaint_rate":
      n = exs.length;
      count = d.complaints.filter((c) => inWin(c.ts) && principalComplaint(c)).length;
      break;
    case "skill_complaint_rate":
      n = d.outputs.filter((o) => o.skill === args.skill && inWin(o.ts)).length;
      count = d.complaints.filter((c) => inWin(c.ts) && principalComplaint(c) && !!c.skills?.includes(args.skill)).length;
      break;
    case "failure_rate":
      for (const e of exs) { const v = d.isFailure(e); if (v === null) continue; n++; if (v) count++; }
      break;
    case "class_rate":
      for (const e of exs) { const c = d.classOf(e.id); if (c === null && d.isFailure(e) === null) continue; n++; if (c === args.class) count++; }
      break;
    case "rule_breaks": {
      const ids = new Set(d.coverage.filter((c) => c.rule === args.rule && c.p >= 0.7).map((c) => c.id));
      n = exs.length; count = exs.filter((e) => ids.has(e.id)).length;
      break;
    }
    case "turn_corrections":
      for (const t of d.turns) if (inWin(t.ts) && t.outcome && t.outcome !== "abandoned") { n++; if (t.outcome === "corrected") count++; }
      break;
  }
  return { count, n, rate: n ? count / n : null };
}

/** Relative change from the window before `cut` to the window after, and what could be detected. */
export function compare(metric: MetricId, args: Record<string, string> | undefined, cut: number, spanMs: number, d: Data) {
  const before = measure(metric, args, cut - spanMs, cut, d), after = measure(metric, args, cut, cut + spanMs, d);
  const change = before.rate && after.rate !== null ? Math.round(1000 * (after.rate - before.rate) / before.rate) / 10 : null;
  return { before, after, change_pct: change, mde_pct: mdePct(before.count, before.n, after.n) };
}

// ── Live data ───────────────────────────────────────────────────────────────

function jsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l) as T]; } catch { return []; } });
}

export const errataDir = (): string => process.env.ERRATA_DIR ?? lifeosPath("USER", "ERRATA");

export function loadData(): Data {
  const v4 = join(errataDir(), "v4");
  const tier = new Map<string, string>();
  for (const c of jsonl<{ id: string; class: string }>(join(v4, "classtier.jsonl"))) tier.set(c.id, c.class);
  const errata = new ErrataStore().list();
  const src = loadSources();
  const skills = new Map(resolveComplaints(errata, src).map((c) => [c.erratum.id, [...new Set(c.outputs.map((o) => skillOf(o, src)))]]));
  return {
    exchanges: jsonl<Exchange & { session?: string }>(join(v4, "exchanges.jsonl")),
    isFailure: v4Verdicts(v4),
    classOf: (id) => { const c = tier.get(id); return c && c !== "not_a_failure" ? c : null; },
    complaints: errata.map((e) => ({ ...(e as unknown as Complaint), skills: skills.get(e.id) })),
    outputs: src.outputs.filter((o) => o.decision !== "blocked").map((o) => ({ ts: o.ts, skill: skillOf(o, src) })),
    coverage: jsonl(join(v4, "coverage.jsonl")),
    turns: readAll(),
  };
}

export function asOf(d: Data) {
  const max = (xs: string[]) => xs.reduce<string | null>((m, x) => (!m || x > m ? x : m), null);
  return {
    exchanges: max(d.exchanges.map((e) => e.ts)),
    complaints: max(d.complaints.map((c) => c.ts)),
    coverage: max(d.coverage.map((c) => c.ts)),
    turns: max(d.turns.map((t) => t.ts)),
    outputs: max(d.outputs.map((o) => o.ts)),
  };
}
