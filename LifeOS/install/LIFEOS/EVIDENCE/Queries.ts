/**
 * @version 1.0.0
 * Queries.ts — read-only questions over the evidence index.
 *
 *   by-model    human-origin turns per model beside Errata complaints whose judged turn ran on it
 *   by-skill    human-origin turns per skill (Skill tool calls plus harness skill attribution) beside complaints
 *   compliance  per decision point, how often what happened matched the router's pick
 *
 * Errata join (same rule Errata's capture uses: the complaint judges the response to the prompt before
 * it). A complaint row carries context.session_id and ts. Its own prompt is the human turn in that
 * session starting within OWN_PROMPT_WINDOW_MS of ts; the judged turn is the turn just before that one.
 * When no own prompt is found (backfill, /er typed later), the judged turn is the latest turn starting
 * at or before ts. Only complaint-shaped kinds count, the set OutputJoin.ts uses.
 *
 * Rows with source `detected` (EVIDENCE/Trigger.ts inferred them) never count toward a complaint rate:
 * they are the label model's own output, and counting them would let it grade itself.
 *
 *   outcomes    per group (model, skill, lane_match, think_match): labeled human turns, mean P(bad) from
 *               the ds-v1 label model, and a 95% percentile-bootstrap interval of that mean
 *   experiment  the router holdout: routed vs held-out turns, mean P(bad) and main-loop cost per arm,
 *               and a 95% bootstrap interval on each held-out minus routed difference
 */
import type { Database } from "bun:sqlite";
import { ErrataStore } from "../ERRATA/Store";
import type { Erratum } from "../ERRATA/Schema";

export const COMPLAINT_KINDS: ReadonlySet<string> = new Set(["complaint", "correction", "bug", "incident"]);
export const OWN_PROMPT_WINDOW_MS = 120_000;

export interface WindowOpts { errataDir?: string; tenantDir?: string; since?: string; until?: string }
export interface Row { key: string; human_turns: number; complaints: number; complaints_per_100: number | null }
export interface Report {
  window: { since: string; until: string }; human_turns: number; errata_in_window: number;
  complaints_total: number; complaints_unlinked: number; join: Record<string, number>; rows: Row[];
}

export interface Turn { span_id: string; trace_id: string; start_time: string; origin: string; ms: number }

/** Errata rows the evidence projector wrote itself; excluded from every complaint rate. */
export const DETECTED_SOURCE = "detected";

function windowOf(db: Database, o: WindowOpts): { since: string; until: string } {
  const built = (db.query("SELECT value FROM meta WHERE key = 'since'").get() as { value: string } | null)?.value ?? "1970-01-01";
  const since = o.since ?? built;
  const until = o.until ?? "9999-12-31";
  return { since: `${since}T00:00:00.000Z`, until: until.length === 10 ? `${until}T23:59:59.999Z` : until };
}

function loadComplaints(o: WindowOpts, w: { since: string; until: string }): { all: number; rows: Erratum[] } {
  const store = o.errataDir ? new ErrataStore(o.errataDir, o.tenantDir ?? o.errataDir) : new ErrataStore();
  const inWindow = store.all().filter((e) => e.ts >= w.since && e.ts <= w.until);
  const counted = inWindow.filter((e) => e.source !== DETECTED_SOURCE);
  return { all: counted.length, rows: counted.filter((e) => COMPLAINT_KINDS.has(e.kind)) };
}

export function turnsBySession(db: Database): Map<string, Turn[]> {
  const rows = db.query("SELECT span_id, trace_id, start_time, origin FROM spans WHERE parent_span_id IS NULL ORDER BY trace_id, start_time, span_id").all() as Turn[];
  const out = new Map<string, Turn[]>();
  for (const r of rows) {
    r.ms = Date.parse(r.start_time);
    const list = out.get(r.trace_id) ?? [];
    list.push(r);
    out.set(r.trace_id, list);
  }
  return out;
}

/** The turn whose response drew the complaint, and how it was found. */
export function judgedTurn(turns: Turn[] | undefined, ts: string): { span_id: string | null; method: string } {
  if (!turns?.length) return { span_id: null, method: "no-session-turns" };
  const t = Date.parse(ts);
  let own = -1;
  let best = Infinity;
  turns.forEach((x, i) => {
    const d = Math.abs(x.ms - t);
    if (x.origin === "human" && d <= OWN_PROMPT_WINDOW_MS && d < best) { best = d; own = i; }
  });
  if (own > 0) return { span_id: turns[own - 1].span_id, method: "prompt-before-own" };
  if (own === 0) return { span_id: null, method: "own-is-first-turn" };
  let latest: Turn | null = null;
  for (const x of turns) if (x.ms <= t) latest = x;
  return latest ? { span_id: latest.span_id, method: "latest-before" } : { span_id: null, method: "none-before" };
}

/**
 * The human turn an Errata row judges: judgedTurn, then back to the human prompt that opened that stretch
 * of work (a task hand-back or peer turn between two human prompts belongs to the human turn before it).
 */
export function judgedHumanTurn(turns: Turn[] | undefined, ts: string): string | null {
  const j = judgedTurn(turns, ts);
  if (!j.span_id || !turns) return null;
  for (let i = turns.findIndex((t) => t.span_id === j.span_id); i >= 0; i--) if (turns[i].origin === "human") return turns[i].span_id;
  return null;
}

function tally(
  db: Database, o: WindowOpts, keysOf: (spanId: string) => string[],
): Report {
  const w = windowOf(db, o);
  const human = db.query("SELECT span_id FROM spans WHERE origin = 'human' AND parent_span_id IS NULL AND start_time >= ? AND start_time <= ?").all(w.since, w.until) as Array<{ span_id: string }>;
  const rows = new Map<string, Row>();
  const row = (k: string) => { let r = rows.get(k); if (!r) { r = { key: k, human_turns: 0, complaints: 0, complaints_per_100: null }; rows.set(k, r); } return r; };
  for (const h of human) for (const k of keysOf(h.span_id)) row(k).human_turns++;

  const { all, rows: complaints } = loadComplaints(o, w);
  const sessions = turnsBySession(db);
  const join: Record<string, number> = {};
  let linked = 0;
  for (const e of complaints) {
    const sid = e.context?.session_id ?? null;
    const j = sid ? judgedTurn(sessions.get(sid), e.ts) : { span_id: null, method: "no-session-id" };
    join[j.method] = (join[j.method] ?? 0) + 1;
    if (!j.span_id) continue;
    linked++;
    for (const k of keysOf(j.span_id)) row(k).complaints++;
  }
  const out = [...rows.values()].map((r) => ({ ...r, complaints_per_100: r.human_turns ? Math.round((r.complaints / r.human_turns) * 10000) / 100 : null }));
  out.sort((a, b) => b.human_turns - a.human_turns || b.complaints - a.complaints || a.key.localeCompare(b.key));
  return {
    window: { since: w.since, until: w.until }, human_turns: human.length, errata_in_window: all,
    complaints_total: linked, complaints_unlinked: complaints.length - linked, join, rows: out,
  };
}

export function byModel(db: Database, o: WindowOpts): Report {
  const q = db.query("SELECT act_model FROM decisions WHERE span_id = ?");
  return tally(db, o, (id) => [(q.get(id) as { act_model: string | null } | null)?.act_model ?? "(no model response)"]);
}

export function bySkill(db: Database, o: WindowOpts): Report {
  const tools = db.query("SELECT DISTINCT skill FROM tool_calls WHERE parent_span_id = ? AND skill IS NOT NULL");
  const attributed = db.query(`SELECT DISTINCT "lifeos.attribution_skill" AS skill FROM chat_spans WHERE parent_span_id = ? AND "lifeos.attribution_skill" IS NOT NULL`);
  return tally(db, o, (id) => {
    const s = new Set<string>();
    for (const r of tools.all(id) as Array<{ skill: string }>) s.add(r.skill);
    for (const r of attributed.all(id) as Array<{ skill: string }>) s.add(r.skill);
    return s.size ? [...s] : ["(no skill)"];
  });
}

export interface Point { point: string; with_pick: number; matched: number; rate: number | null; by_join: Record<string, { with_pick: number; matched: number }>; note?: string; top_mismatches?: Array<{ pick: string; actual: string; n: number }> }
export interface Compliance { window: { since: string; until: string }; turns: number; joined: Record<string, number>; points: Point[] }

export function compliance(db: Database, o: WindowOpts & { origin?: string }): Compliance {
  const w = windowOf(db, o);
  const where = `start_time >= ? AND start_time <= ?${o.origin ? " AND d.origin = ?" : ""}`;
  const args = o.origin ? [w.since, w.until, o.origin] : [w.since, w.until];
  const rows = db.query(`SELECT d.* FROM decisions d JOIN spans s USING (span_id) WHERE ${where}`).all(...args) as Array<Record<string, any>>;
  const joined: Record<string, number> = {};
  for (const r of rows) joined[r.join_method] = (joined[r.join_method] ?? 0) + 1;

  const point = (name: string, pickCol: string, matchCol: string, actual: (r: Record<string, any>) => string): Point => {
    const p: Point = { point: name, with_pick: 0, matched: 0, rate: null, by_join: {} };
    const miss = new Map<string, number>();
    for (const r of rows) {
      if (r[matchCol] === null || r[matchCol] === undefined) continue;
      p.with_pick++;
      const bj = (p.by_join[r.join_method] ??= { with_pick: 0, matched: 0 });
      bj.with_pick++;
      if (r[matchCol] === 1) { p.matched++; bj.matched++; }
      else { const k = `${r[pickCol]}\u0000${actual(r)}`; miss.set(k, (miss.get(k) ?? 0) + 1); }
    }
    p.rate = p.with_pick ? Math.round((p.matched / p.with_pick) * 1000) / 10 : null;
    p.top_mismatches = [...miss.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, n]) => { const [pick, act] = k.split("\u0000"); return { pick, actual: act, n }; });
    return p;
  };
  const agentsOf = (r: Record<string, any>) => (JSON.parse(r.act_agents) as string[]).join("+") || "inline";
  const skillTurns = rows.filter((r) => (JSON.parse(r.act_skills) as string[]).length > 0).length;
  return {
    window: w, turns: rows.length, joined,
    points: [
      point("lane", "pick_lane", "lane_match", agentsOf),
      point("agent", "pick_agent", "agent_match", agentsOf),
      point("effort", "pick_effort", "effort_match", (r) => String(r.act_effort)),
      point("thinking_skill", "pick_think", "think_match", (r) => (JSON.parse(r.act_think) as string[]).join("+") || "none"),
      { point: "skill", with_pick: 0, matched: 0, rate: null, by_join: {}, note: `the router log records no skill pick; ${skillTurns} of ${rows.length} turns invoked a skill` },
    ],
  };
}

export const OUTCOME_GROUPS = ["model", "skill", "lane_match", "think_match"] as const;
export type OutcomeGroup = (typeof OUTCOME_GROUPS)[number];
export const BOOTSTRAP_RESAMPLES = 2000;
export interface OutcomeRow { key: string; labeled_turns: number; mean_p_bad: number; ci95: [number, number] }
export interface Outcomes { window: { since: string; until: string }; by: OutcomeGroup; source: string; labeled_turns: number; interval: string; rows: OutcomeRow[] }

/** Seeded generator so the same index prints the same interval. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** 95% percentile-bootstrap interval of the mean. */
export function bootstrapMeanCi(values: number[], resamples = BOOTSTRAP_RESAMPLES, seed = 1): [number, number] {
  if (values.length === 0) return [NaN, NaN];
  const rnd = mulberry32(seed);
  const means = new Float64Array(resamples);
  for (let r = 0; r < resamples; r++) {
    let s = 0;
    for (let i = 0; i < values.length; i++) s += values[Math.floor(rnd() * values.length)];
    means[r] = s / values.length;
  }
  means.sort();
  return [means[Math.floor(0.025 * (resamples - 1))], means[Math.ceil(0.975 * (resamples - 1))]];
}

const r4 = (x: number) => Math.round(x * 10000) / 10000;

/** Turns with no evidence (no next prompt and no vote) are left out: their score is only the prior, and silence is not an outcome. */
export function outcomes(db: Database, o: WindowOpts & { by: OutcomeGroup; source?: string }): Outcomes {
  if (!(OUTCOME_GROUPS as readonly string[]).includes(o.by)) throw new Error(`--by must be one of ${OUTCOME_GROUPS.join("|")}`);
  const w = windowOf(db, o);
  const source = o.source ?? "ds-v1";
  const rows = db.query(`SELECT s.span_id, sc.value AS p, d.act_model, d.lane_match, d.think_match FROM scores sc JOIN spans s USING (span_id) LEFT JOIN decisions d USING (span_id)
    WHERE sc.source = ? AND s.origin = 'human' AND s.parent_span_id IS NULL AND s.start_time >= ? AND s.start_time <= ?
      AND EXISTS (SELECT 1 FROM votes v WHERE v.span_id = s.span_id AND (v.vote IS NOT NULL OR (v.fn = 'frustration' AND v.eligible = 1)))`).all(source, w.since, w.until) as Array<{ span_id: string; p: number; act_model: string | null; lane_match: number | null; think_match: number | null }>;
  const tools = db.query("SELECT DISTINCT skill FROM tool_calls WHERE parent_span_id = ? AND skill IS NOT NULL");
  const attributed = db.query(`SELECT DISTINCT "lifeos.attribution_skill" AS skill FROM chat_spans WHERE parent_span_id = ? AND "lifeos.attribution_skill" IS NOT NULL`);
  const match = (v: number | null) => (v === null ? "(no pick)" : v === 1 ? "match" : "miss");
  const keysOf = (r: (typeof rows)[number]): string[] => {
    if (o.by === "model") return [r.act_model ?? "(no model response)"];
    if (o.by === "lane_match") return [match(r.lane_match)];
    if (o.by === "think_match") return [match(r.think_match)];
    const s = new Set<string>();
    for (const x of tools.all(r.span_id) as Array<{ skill: string }>) s.add(x.skill);
    for (const x of attributed.all(r.span_id) as Array<{ skill: string }>) s.add(x.skill);
    return s.size ? [...s] : ["(no skill)"];
  };
  const groups = new Map<string, number[]>();
  for (const r of rows) for (const k of keysOf(r)) { const g = groups.get(k) ?? []; g.push(r.p); groups.set(k, g); }
  const out: OutcomeRow[] = [...groups.entries()].map(([key, ps]) => {
    const [lo, hi] = bootstrapMeanCi(ps);
    return { key, labeled_turns: ps.length, mean_p_bad: r4(ps.reduce((a, b) => a + b, 0) / ps.length), ci95: [r4(lo), r4(hi)] as [number, number] };
  });
  out.sort((a, b) => b.labeled_turns - a.labeled_turns || a.key.localeCompare(b.key));
  return { window: w, by: o.by, source, labeled_turns: rows.length, interval: `95% percentile bootstrap of the mean, ${BOOTSTRAP_RESAMPLES} resamples, seed 1`, rows: out };
}

/** 95% percentile-bootstrap interval of mean(b) − mean(a), each arm resampled on its own. */
export function bootstrapDiffCi(a: number[], b: number[], resamples = BOOTSTRAP_RESAMPLES, seed = 1): [number, number] {
  if (a.length === 0 || b.length === 0) return [NaN, NaN];
  const rnd = mulberry32(seed);
  const mean = (xs: number[]) => { let s = 0; for (let i = 0; i < xs.length; i++) s += xs[Math.floor(rnd() * xs.length)]; return s / xs.length; };
  const diffs = new Float64Array(resamples);
  for (let r = 0; r < resamples; r++) diffs[r] = mean(b) - mean(a);
  diffs.sort();
  return [diffs[Math.floor(0.025 * (resamples - 1))], diffs[Math.ceil(0.975 * (resamples - 1))]];
}

export interface ArmRow { arm: "routed" | "held_out"; turns: number; labeled_turns: number; mean_p_bad: number | null; cost_turns: number; mean_cost_usd: number | null }
export interface Difference { metric: "p_bad" | "cost_usd"; held_out_minus_routed: number | null; ci95: [number, number] | null; excludes_zero: boolean }
export interface Experiment { window: { since: string; until: string }; source: string; held_out_share: number | null; arms: ArmRow[]; differences: Difference[]; interval: string; notes: string[] }

/**
 * The router holdout read (execution-evidence ISC-28). Only turns that were in the experiment count
 * (decisions.holdout not null), so both arms share one window and one eligibility rule: advised, not
 * binding, not dictated. P(bad) uses the evidenced turns the way `outcomes` does; cost is the main loop's.
 */
export function experiment(db: Database, o: WindowOpts & { source?: string }): Experiment {
  const w = windowOf(db, o);
  const source = o.source ?? "ds-v1";
  const rows = db.query(`SELECT d.holdout AS holdout, d.act_cost_usd AS cost, sc.value AS p,
      EXISTS (SELECT 1 FROM votes v WHERE v.span_id = s.span_id AND (v.vote IS NOT NULL OR (v.fn = 'frustration' AND v.eligible = 1))) AS evidenced
    FROM decisions d JOIN spans s USING (span_id) LEFT JOIN scores sc ON sc.span_id = s.span_id AND sc.source = ?
    WHERE d.holdout IS NOT NULL AND s.origin = 'human' AND s.parent_span_id IS NULL AND s.start_time >= ? AND s.start_time <= ?`)
    .all(source, w.since, w.until) as Array<{ holdout: number; cost: number | null; p: number | null; evidenced: number }>;
  const arm = (h: number) => {
    const xs = rows.filter((r) => r.holdout === h);
    const ps = xs.filter((r) => r.evidenced && r.p !== null).map((r) => r.p as number);
    const cs = xs.filter((r) => r.cost !== null).map((r) => r.cost as number);
    return { xs, ps, cs };
  };
  const routed = arm(0), held = arm(1);
  const mean = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : null);
  const r6 = (x: number) => Math.round(x * 1e6) / 1e6;
  const row = (name: ArmRow["arm"], a: ReturnType<typeof arm>, round: (x: number) => number): ArmRow => {
    const mp = mean(a.ps), mc = mean(a.cs);
    return { arm: name, turns: a.xs.length, labeled_turns: a.ps.length, mean_p_bad: mp === null ? null : r4(mp), cost_turns: a.cs.length, mean_cost_usd: mc === null ? null : round(mc) };
  };
  const diff = (metric: Difference["metric"], a: number[], b: number[], round: (x: number) => number): Difference => {
    const ma = mean(a), mb = mean(b);
    if (ma === null || mb === null) return { metric, held_out_minus_routed: null, ci95: null, excludes_zero: false };
    const [lo, hi] = bootstrapDiffCi(a, b);
    return { metric, held_out_minus_routed: round(mb - ma), ci95: [round(lo), round(hi)], excludes_zero: lo > 0 || hi < 0 };
  };
  return {
    window: w, source,
    held_out_share: rows.length ? r4(held.xs.length / rows.length) : null,
    arms: [row("routed", routed, r6), row("held_out", held, r6)],
    differences: [diff("p_bad", routed.ps, held.ps, r4), diff("cost_usd", routed.cs, held.cs, r6)],
    interval: `95% percentile bootstrap of the difference, arms resampled separately, ${BOOTSTRAP_RESAMPLES} resamples, seed 1`,
    notes: [
      "Cost is the main loop only: dispatched agents and workers are not in act_cost_usd, so the routed arm's cost is understated.",
      "A positive p_bad difference means held-out turns went worse, i.e. the router helped.",
    ],
  };
}
