/**
 * The cloud clock (WORKFLOWS ISA F27, ISC-316, ISC-318): the schedules of every local workflow and the queue of runs
 * they produce, kept in the Workflows' own D1 database so the clock survives the Mac rebooting, sleeping or pegging
 * its CPU. Each minute the Worker's cron calls `clockTick`; the Mac's dispatcher calls `syncWorkflows` when its
 * definitions change, `leaseRuns` each pass, and `completeRun` once it has handed a run to its local queue.
 *
 * The clock math is engine/clock.ts, the same code the Mac ran, so occurrence keys match the Mac's and the Mac's
 * ledger refuses a second start of an occurrence its fallback clock already ran (ISC-319).
 *
 * Run states: queued (waiting for the Mac) → leased (the Mac has it for LEASE_MS) → done (submitted, or already known
 * to the Mac's ledger). Off ramps: superseded (a newer occurrence of the same workflow arrived while this one still
 * waited), expired (past its trigger's grace_minutes, a `missed_run: skip` run the Mac did not take on time, or
 * MAX_WAIT_MS), skipped (planCatchUp declined it, or the Mac's no-overlap rule), failed (leased MAX_ATTEMPTS times
 * without an answer, or refused). Nothing leaves without a reason.
 *
 * A database error is never swallowed: the tick throws before `last_tick` moves, so the next minute re-reads the same
 * window, and every write here is idempotent by run id, so the retry is safe.
 */
import { invariant } from "../../TOOLS/Invariant.ts";
import { graceMinutes, isTimeTrigger, occurrencesIn, planCatchUp, type CatchUpPlan, type TimeTrigger } from "../engine/clock.ts";
import type { TriggerV2 } from "../engine/format.ts";

/** The subset of the D1 API the clock uses; tests pass a bun:sqlite double. */
export interface ClockDb {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      run(): Promise<{ meta?: { changes?: number } }>;
      all<T = Record<string, unknown>>(): Promise<{ results?: T[] }>;
      first<T = Record<string, unknown>>(): Promise<T | null>;
    };
  };
}

/** Sends one text to the principal; true only when it was accepted. The Worker binds it to Twilio, tests record it. */
export type Notify = (text: string) => Promise<boolean>;

export const LEASE_MS = 5 * 60_000;
export const MAX_ATTEMPTS = 5;
/** A run nobody leased for this long is expired rather than started days late. */
export const MAX_WAIT_MS = 7 * 86_400_000;
/** The Mac counts as gone when it has not leased (or heartbeated) for this long (ISC-316). */
export const WORKER_STALE_MS = 10 * 60_000;
/** A `missed_run: skip` run the Mac has not taken this long after its time is a missed run, as on the Mac's own clock. */
export const SKIP_LATE_MS = 3 * 60_000;
/** A previous tick this recent means the cron itself was awake, so a late tick is not a miss. */
const AWAKE_MS = 3 * 60_000;
/** How far back a newly synced workflow's window may start (the Mac's last evaluation, at most this old). */
const MAX_BACKFILL_MS = 86_400_000;
const RETAIN_MS = 14 * 86_400_000;
/** Only before the first sync, which always writes the zone. */
const DEFAULT_ZONE = "UTC";
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface WorkflowSpec {
  name: string;
  alert?: string;
  triggers: TimeTrigger[];
  /** The Mac's last evaluation of this workflow, so a workflow new to the cloud starts where the Mac stopped. */
  since?: string;
}

export interface SyncBody {
  /** The principal's zone now, for `timezone: principal` triggers. */
  zone: string;
  workflows: WorkflowSpec[];
  /** Workflows whose definition did not load this time; kept scheduled as they were, never dropped by a typo. */
  keep?: string[];
}

export interface LeasedRun {
  id: string;
  workflow: string;
  occurrence_key: string;
  due_at: string;
  attempts: number;
}

export type Outcome = "submitted" | "duplicate" | "skipped" | "refused";

const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS clock_workflows (name TEXT PRIMARY KEY, spec TEXT NOT NULL, added_at TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS clock_runs (id TEXT PRIMARY KEY, workflow TEXT NOT NULL, occurrence_key TEXT NOT NULL, due_at TEXT NOT NULL, state TEXT NOT NULL, reason TEXT, attempts INTEGER NOT NULL DEFAULT 0, lease_until TEXT, leased_by TEXT, policy TEXT, grace_ms INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
  "CREATE INDEX IF NOT EXISTS idx_clock_runs_state ON clock_runs(state, due_at)",
  "CREATE INDEX IF NOT EXISTS idx_clock_runs_workflow ON clock_runs(workflow, state)",
  "CREATE TABLE IF NOT EXISTS clock_once (workflow TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (workflow, at))",
  "CREATE TABLE IF NOT EXISTS clock_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
];

const q = (db: ClockDb, sql: string, ...values: unknown[]) => db.prepare(sql).bind(...values);
const iso = (ms: number) => new Date(ms).toISOString();

/** Tables are created once per database handle per isolate, not on every request. */
const ready = new WeakSet<object>();
export async function ensureSchema(db: ClockDb): Promise<void> {
  if (ready.has(db)) return;
  for (const statement of SCHEMA) await q(db, statement).run();
  ready.add(db);
}

async function meta(db: ClockDb, key: string): Promise<string | undefined> {
  return (await q(db, "SELECT value FROM clock_meta WHERE key = ?", key).first<{ value: string }>())?.value;
}

async function setMeta(db: ClockDb, key: string, value: string): Promise<void> {
  await q(db, "INSERT INTO clock_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value).run();
}

const validZone = (zone: unknown): zone is string => {
  if (typeof zone !== "string" || !zone) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
};

/** A synced trigger is checked field by field: a bad number here would wedge every tick for every workflow. */
function validTrigger(t: unknown): t is TimeTrigger {
  if (!t || typeof t !== "object" || !isTimeTrigger(t as TriggerV2)) return false;
  const r = t as Record<string, unknown>;
  if (r.missed_run !== undefined && r.missed_run !== "once" && r.missed_run !== "skip") return false;
  if (r.grace_minutes !== undefined && !(typeof r.grace_minutes === "number" && Number.isFinite(r.grace_minutes) && r.grace_minutes >= 0)) return false;
  if (r.type === "interval") return Number.isInteger(r.minutes) && (r.minutes as number) >= 1 && (r.minutes as number) <= 525_600;
  if (r.type === "once") return typeof r.at === "string" && Number.isFinite(Date.parse(r.at));
  return typeof r.cron === "string" && r.cron.length > 0 && r.cron.length <= 120 && (r.timezone === "principal" || validZone(r.timezone));
}

/** Replaces the set of scheduled workflows with what the Mac holds; a workflow no longer sent (and not kept) stops being scheduled. */
export async function syncWorkflows(db: ClockDb, body: SyncBody, now: Date): Promise<{ workflows: number; removed: number }> {
  invariant(validZone(body.zone), `"${String(body.zone)}" is not a time zone`);
  invariant(Array.isArray(body.workflows), "sync needs a workflows list");
  const names = new Set<string>();
  for (const w of body.workflows) {
    invariant(typeof w.name === "string" && NAME_RE.test(w.name), `"${String(w.name)}" is not a workflow name`);
    invariant(Array.isArray(w.triggers) && w.triggers.every(validTrigger), `${w.name}: a trigger is not a valid schedule, interval or once`);
    invariant(w.since === undefined || Number.isFinite(Date.parse(w.since)), `${w.name}: since is not a timestamp`);
    names.add(w.name);
  }
  const keep = new Set((body.keep ?? []).filter(n => typeof n === "string" && NAME_RE.test(n)));
  await ensureSchema(db);
  await setMeta(db, "zone", body.zone);
  for (const w of body.workflows) {
    // added_at is set once: the Mac's last evaluation when it has one (at most a day back), else now.
    const since = w.since ? Math.max(Date.parse(w.since), now.getTime() - MAX_BACKFILL_MS) : now.getTime();
    await q(db, "INSERT INTO clock_workflows (name, spec, added_at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET spec = excluded.spec",
      w.name, JSON.stringify({ name: w.name, alert: w.alert, triggers: w.triggers }), iso(Math.min(since, now.getTime()))).run();
  }
  const existing = (await q(db, "SELECT name FROM clock_workflows").all<{ name: string }>()).results ?? [];
  let removed = 0;
  for (const { name } of existing) {
    if (names.has(name) || keep.has(name)) continue;
    await q(db, "DELETE FROM clock_workflows WHERE name = ?", name).run();
    await q(db, "UPDATE clock_runs SET state = 'expired', reason = 'unscheduled', updated_at = ? WHERE workflow = ? AND state = 'queued'", now.toISOString(), name).run();
    removed++;
  }
  return { workflows: names.size, removed };
}

/** Queues one occurrence; an older run of the same workflow still waiting is superseded, so at most one waits (ISC-318). */
async function enqueue(db: ClockDb, workflow: string, trigger: TimeTrigger, key: string, dueAt: Date, now: Date): Promise<boolean> {
  const id = `${workflow}|${key}`;
  const grace = graceMinutes(trigger);
  const inserted = await q(db, "INSERT INTO clock_runs (id, workflow, occurrence_key, due_at, state, policy, grace_ms, created_at, updated_at) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING",
    id, workflow, key, dueAt.toISOString(), trigger.missed_run === "once" ? "once" : "skip", grace === undefined ? null : grace * 60_000, now.toISOString(), now.toISOString()).run();
  if ((inserted.meta?.changes ?? 0) !== 1) return false;
  await q(db, "UPDATE clock_runs SET state = 'superseded', reason = ?, updated_at = ? WHERE workflow = ? AND state = 'queued' AND id <> ?", `newer occurrence ${key}`, now.toISOString(), workflow, id).run();
  return true;
}

async function recordSkip(db: ClockDb, workflow: string, key: string, at: string, reason: string, now: Date): Promise<void> {
  await q(db, "INSERT INTO clock_runs (id, workflow, occurrence_key, due_at, state, reason, created_at, updated_at) VALUES (?, ?, ?, ?, 'skipped', ?, ?, ?) ON CONFLICT(id) DO NOTHING",
    `${workflow}|${key}`, workflow, key, at, reason, now.toISOString(), now.toISOString()).run();
}

/** Why a waiting run should no longer start, or null. Shared by the tick's sweep and the lease, so neither hands out a stale run. */
function staleReason(run: { due_at: string; policy: string | null; grace_ms: number | null }, now: Date): string | null {
  const age = now.getTime() - Date.parse(run.due_at);
  if (run.grace_ms !== null && run.grace_ms !== undefined && age > run.grace_ms) return "outside_grace";
  if (run.policy === "skip" && age > SKIP_LATE_MS) return "missed_run_skip";
  return age > MAX_WAIT_MS ? "max_wait" : null;
}

const hhmm = (ms: number, zone: string) => new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(ms));

export interface TickSummary {
  queued: string[];
  skipped: number;
  requeued: number;
  failed: string[];
  expired: number;
  workerStale: boolean;
  /** Workflows whose stored spec could not be evaluated this minute (logged; the rest still ran). */
  broken: string[];
}

/** One minute of the clock: queue what is due, return dead leases, expire what waited too long, and watch the Mac. */
export async function clockTick(db: ClockDb, now: Date, notify: Notify): Promise<TickSummary> {
  await ensureSchema(db);
  const summary: TickSummary = { queued: [], skipped: 0, requeued: 0, failed: [], expired: 0, workerStale: false, broken: [] };
  const lastTickRaw = await meta(db, "last_tick");
  const lastTick = lastTickRaw ? new Date(lastTickRaw) : undefined;
  const awake = lastTick !== undefined && now.getTime() - lastTick.getTime() <= AWAKE_MS;
  const zone = (await meta(db, "zone")) ?? DEFAULT_ZONE;
  const rows = (await q(db, "SELECT name, spec, added_at FROM clock_workflows ORDER BY name").all<{ name: string; spec: string; added_at: string }>()).results ?? [];
  const consumed = new Set(((await q(db, "SELECT workflow, at FROM clock_once").all<{ workflow: string; at: string }>()).results ?? []).map(r => `${r.workflow}|${r.at}`));
  for (const row of rows) {
    const added = Date.parse(row.added_at);
    // A workflow new since the last tick starts at its added_at (the Mac's last evaluation), never further back.
    const floor = lastTick && lastTick.getTime() >= added ? lastTick.getTime() : Math.max(added, lastTick ? 0 : now.getTime() - MAX_BACKFILL_MS);
    const fresh = !(lastTick && lastTick.getTime() >= added);
    // Pure computation first: a spec that cannot be evaluated is reported and skipped, and is never confused with a database failure.
    const plans: Array<{ trigger: TimeTrigger; plan: CatchUpPlan }> = [];
    try {
      const spec = JSON.parse(row.spec) as WorkflowSpec;
      for (const trigger of spec.triggers) {
        if (trigger.type === "once" && consumed.has(`${row.name}|${trigger.at}`)) continue;
        const triggerZone = trigger.type === "schedule" ? (trigger.timezone === "principal" ? zone : trigger.timezone) : "UTC";
        const occurrences = occurrencesIn(trigger, trigger.type === "once" ? new Date(0) : new Date(floor), now, triggerZone);
        if (!occurrences.length) continue;
        plans.push({ trigger, plan: planCatchUp(trigger, occurrences, now, fresh ? undefined : lastTick, awake && !fresh) });
      }
    } catch (e) {
      console.error(`clock: ${row.name}: ${e instanceof Error ? e.message : String(e)}`);
      summary.broken.push(row.name);
      continue;
    }
    // Writes: any throw leaves last_tick where it was, so the next minute retries this window. The once trigger is
    // consumed only after its run is queued.
    for (const { trigger, plan } of plans) {
      for (const s of plan.skipped) {
        await recordSkip(db, row.name, s.key, s.at, s.reason, now);
        summary.skipped++;
      }
      if (plan.run && await enqueue(db, row.name, trigger, plan.run.key, plan.run.at, now)) summary.queued.push(`${row.name}|${plan.run.key}`);
      if (trigger.type === "once") await q(db, "INSERT INTO clock_once (workflow, at) VALUES (?, ?) ON CONFLICT DO NOTHING", row.name, trigger.at).run();
    }
  }

  // Leases the Mac never answered go back to the queue; one leased MAX_ATTEMPTS times fails loudly.
  const dead = (await q(db, "SELECT id, workflow, attempts FROM clock_runs WHERE state = 'leased' AND lease_until < ?", now.toISOString()).all<{ id: string; workflow: string; attempts: number }>()).results ?? [];
  for (const run of dead) {
    if (run.attempts >= MAX_ATTEMPTS) {
      await q(db, "UPDATE clock_runs SET state = 'failed', reason = 'lease never completed', updated_at = ? WHERE id = ? AND state = 'leased'", now.toISOString(), run.id).run();
      summary.failed.push(run.id);
    } else if (await q(db, "SELECT 1 AS x FROM clock_runs WHERE workflow = ? AND state = 'queued'", run.workflow).first()) {
      // A newer occurrence already waits; the dead lease would make two.
      await q(db, "UPDATE clock_runs SET state = 'superseded', reason = 'lease expired behind a newer occurrence', lease_until = NULL, updated_at = ? WHERE id = ? AND state = 'leased'", now.toISOString(), run.id).run();
    } else {
      await q(db, "UPDATE clock_runs SET state = 'queued', lease_until = NULL, leased_by = NULL, updated_at = ? WHERE id = ? AND state = 'leased'", now.toISOString(), run.id).run();
      summary.requeued++;
    }
  }
  if (summary.failed.length) await notify(`{{DA_NAME}}: ${summary.failed.length} scheduled run(s) were handed to your Mac ${MAX_ATTEMPTS} times and never started: ${summary.failed.slice(0, 3).map(id => id.split("|")[0]).join(", ")}.`);

  // A waiting run past its grace, a skip-policy run the Mac did not take on time, or one past MAX_WAIT_MS, would start too late.
  const waiting = (await q(db, "SELECT id, due_at, policy, grace_ms FROM clock_runs WHERE state = 'queued'").all<{ id: string; due_at: string; policy: string | null; grace_ms: number | null }>()).results ?? [];
  for (const run of waiting) {
    const reason = staleReason(run, now);
    if (!reason) continue;
    await q(db, "UPDATE clock_runs SET state = 'expired', reason = ?, updated_at = ? WHERE id = ? AND state = 'queued'", reason, now.toISOString(), run.id).run();
    summary.expired++;
  }

  // ISC-316: the Mac stopped checking in. One text when it goes quiet (retried each minute until Twilio takes it), one when it is back.
  const seenRaw = await meta(db, "worker_seen");
  if (seenRaw && now.getTime() - Date.parse(seenRaw) > WORKER_STALE_MS) {
    summary.workerStale = true;
    if ((await meta(db, "worker_down_alerted")) !== seenRaw) {
      const waitingCount = (await q(db, "SELECT COUNT(*) AS n FROM clock_runs WHERE state IN ('queued', 'leased')").first<{ n: number }>())?.n ?? 0;
      if (await notify(`{{DA_NAME}}: your Mac stopped picking up scheduled work at ${hhmm(Date.parse(seenRaw), zone)}. ${waitingCount} run(s) are waiting in the cloud and will start when it is back.`)) {
        await setMeta(db, "worker_down_alerted", seenRaw);
      }
    }
  }

  if (now.getUTCMinutes() === 0) await q(db, "DELETE FROM clock_runs WHERE state NOT IN ('queued', 'leased') AND updated_at < ?", iso(now.getTime() - RETAIN_MS)).run();
  await setMeta(db, "last_tick", now.toISOString());
  return summary;
}

export interface LeaseResult {
  runs: LeasedRun[];
  /** When the cron last completed a tick; the Mac treats a stale one as no answer (a clock that answers but does not tick). */
  last_tick: string | null;
}

/** The Mac takes up to `max` waiting runs, oldest first; `max: 0` is a heartbeat only. */
export async function leaseRuns(db: ClockDb, worker: string, max: number, now: Date, notify: Notify): Promise<LeaseResult> {
  invariant(typeof worker === "string" && worker.length > 0 && worker.length <= 128, "a lease names its worker");
  invariant(Number.isInteger(max) && max >= 0 && max <= 500, "lease max is 0..500");
  await ensureSchema(db);
  const seen = await meta(db, "worker_seen");
  await setMeta(db, "worker_seen", now.toISOString());
  // The recovery text goes once: only the lease whose conditional update clears the down marker sends it.
  if (seen) {
    const cleared = await q(db, "UPDATE clock_meta SET value = '' WHERE key = 'worker_down_alerted' AND value = ?", seen).run();
    if ((cleared.meta?.changes ?? 0) === 1) {
      const waitingCount = (await q(db, "SELECT COUNT(*) AS n FROM clock_runs WHERE state = 'queued'").first<{ n: number }>())?.n ?? 0;
      await notify(`{{DA_NAME}}: your Mac is picking up scheduled work again. Starting the ${waitingCount} run(s) that waited.`);
    }
  }
  const lastTick = (await meta(db, "last_tick")) ?? null;
  if (max === 0) return { runs: [], last_tick: lastTick };
  const candidates = (await q(db, "SELECT id, workflow, occurrence_key, due_at, attempts, policy, grace_ms FROM clock_runs WHERE state = 'queued' ORDER BY due_at LIMIT ?", max)
    .all<LeasedRun & { policy: string | null; grace_ms: number | null }>()).results ?? [];
  const leased: LeasedRun[] = [];
  for (const run of candidates) {
    const stale = staleReason(run, now);
    if (stale) {
      await q(db, "UPDATE clock_runs SET state = 'expired', reason = ?, updated_at = ? WHERE id = ? AND state = 'queued'", stale, now.toISOString(), run.id).run();
      continue;
    }
    const r = await q(db, "UPDATE clock_runs SET state = 'leased', lease_until = ?, leased_by = ?, attempts = attempts + 1, updated_at = ? WHERE id = ? AND state = 'queued'",
      iso(now.getTime() + LEASE_MS), worker, now.toISOString(), run.id).run();
    if ((r.meta?.changes ?? 0) === 1) leased.push({ id: run.id, workflow: run.workflow, occurrence_key: run.occurrence_key, due_at: run.due_at, attempts: run.attempts + 1 });
  }
  return { runs: leased, last_tick: lastTick };
}

const OUTCOME_STATE: Record<Outcome, string> = { submitted: "done", duplicate: "done", skipped: "skipped", refused: "failed" };

/** Closes a lease with what the Mac did with the run. A lease that already expired and was re-queued is left alone. */
export async function completeRun(db: ClockDb, id: string, outcome: Outcome, detail: string | undefined, now: Date): Promise<boolean> {
  invariant(outcome in OUTCOME_STATE, `"${outcome}" is not a run outcome`);
  await ensureSchema(db);
  const r = await q(db, "UPDATE clock_runs SET state = ?, reason = ?, lease_until = NULL, updated_at = ? WHERE id = ? AND state = 'leased'",
    OUTCOME_STATE[outcome], detail ? `${outcome}: ${detail.slice(0, 200)}` : outcome, now.toISOString(), id).run();
  return (r.meta?.changes ?? 0) === 1;
}

/** One read, no schema work: what the unauthenticated /health may look at. */
export async function lastTick(db: ClockDb): Promise<string | null> {
  try {
    return (await meta(db, "last_tick")) ?? null;
  } catch {
    return null; // no table yet: the clock has never ticked
  }
}

export interface ClockStatus {
  last_tick: string | null;
  worker_seen: string | null;
  zone: string;
  workflows: number;
  runs: Record<string, number>;
}

export async function clockStatus(db: ClockDb): Promise<ClockStatus> {
  await ensureSchema(db);
  const counts = (await q(db, "SELECT state, COUNT(*) AS n FROM clock_runs GROUP BY state").all<{ state: string; n: number }>()).results ?? [];
  return {
    last_tick: (await meta(db, "last_tick")) ?? null,
    worker_seen: (await meta(db, "worker_seen")) ?? null,
    zone: (await meta(db, "zone")) ?? DEFAULT_ZONE,
    workflows: (await q(db, "SELECT COUNT(*) AS n FROM clock_workflows").first<{ n: number }>())?.n ?? 0,
    runs: Object.fromEntries(counts.map(c => [c.state, c.n])),
  };
}
