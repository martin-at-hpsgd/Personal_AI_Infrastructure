/**
 * Vigil events for triggered runs (ISA F14: ISC-141, 142, 143) and the
 * dispatcher heartbeat (ISC-122).
 *
 * The dispatcher or the scheduled entrypoint calls this AFTER the run's ledger
 * line exists, so the event describes a finished run. One event per run
 * (idempotent on the run id), severity from the definition's `alert` when the
 * run failed, and only identifiers and short digests in the payload: never a
 * step input or output value, and never an error string, which can quote one.
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { invariant } from "../../TOOLS/Invariant.ts";
import type { Alert } from "./format.ts";
import type { LedgerRecord } from "./ledger.ts";

/**
 * Vigil is a private subsystem that does not ship in the public release, so it is
 * loaded here only when present. Without it, events are built but never emitted
 * and the heartbeat is neither written nor checked. The event type mirrors
 * LIFEOS/VIGIL/Schema.ts VigilEvent so this file needs no Vigil types.
 */
export type VigilEvent = {
  id: string; source: string; ts: string;
  kind: "health" | "security" | "money" | "customer" | "news" | "life" | "ai" | "infra" | "notification" | "other";
  severity: "info" | "low" | "medium" | "high" | "critical";
  title: string; summary: string; ref: string | null; url: string | null;
  privacy_class: "public" | "personal" | "customer"; dedup_key: string;
  meta?: Record<string, string | number | boolean | null | Record<string, { read: boolean; age_minutes: number | null }>>;
};
type VigilApi = {
  emit: (event: VigilEvent) => VigilEvent;
  statePath: (...parts: string[]) => string;
  readJson: <T>(path: string, fallback: T) => T;
  writeJson: (path: string, value: unknown) => void;
};
const vigilEmitFile = join(import.meta.dir, "..", "..", "VIGIL", "Emit.ts");
const vigilStateFile = join(import.meta.dir, "..", "..", "VIGIL", "State.ts");
const vigil: VigilApi | undefined = existsSync(vigilEmitFile) && existsSync(vigilStateFile)
  ? { ...(await import(vigilEmitFile)), ...(await import(vigilStateFile)) } as VigilApi
  : undefined;

/** Emits one event to Vigil when it is installed; a no-op on an install without it. */
export function emitToVigil(event: VigilEvent): void {
  vigil?.emit(event);
}

export const SOURCE = "workflows";
export const HEARTBEAT_SOURCE = "workflows-dispatcher";
/** A dispatcher that has not ticked for this long is quiet. It ticks every minute. */
export const HEARTBEAT_STALE_MS = 5 * 60_000;

/** Vigil's schema refuses 40+ hex characters, so a digest travels as its first 16. */
export function shortDigest(digest: string | null | undefined): string | null {
  if (!digest) return null;
  const m = digest.match(/^(sha256:)?([0-9a-f]{16})/);
  return m ? `sha256:${m[2]}…` : null;
}

/** Quiet and succeeded runs are informational; a failed run carries the definition's `alert` (ISC-142). */
export function severityFor(status: string, alert: Alert): VigilEvent["severity"] {
  if (status === "succeeded") return "info";
  return alert === "critical" ? "critical" : alert === "high" ? "high" : "medium";
}

type Meta = NonNullable<VigilEvent["meta"]>;

function base(o: { title: string; summary: string; severity: VigilEvent["severity"]; ref: string | null; dedup: string; privacy: VigilEvent["privacy_class"]; meta: Meta; now: Date }): VigilEvent {
  invariant(o.dedup.length > 0, "A Vigil event needs a dedup key");
  return {
    id: randomUUID(), source: SOURCE, ts: o.now.toISOString(), kind: "infra", severity: o.severity,
    title: o.title.slice(0, 140), summary: o.summary.slice(0, 1000), ref: o.ref, url: null,
    privacy_class: o.privacy, dedup_key: o.dedup, meta: o.meta,
  };
}

const privacyOf = (dataClass: string): VigilEvent["privacy_class"] => (dataClass === "public" ? "public" : "personal");

/** The event for one finished run. Values come only from the ledger record's identifiers and digests. */
export function runEvent(record: LedgerRecord, alert: Alert, trigger: string, now: Date = new Date()): VigilEvent {
  const failed = record.status !== "succeeded";
  return base({
    title: `${record.workflow}: ${record.status}`,
    summary: `Run ${record.run_id} of ${record.workflow} ${record.status} (${trigger} trigger)${failed ? `; alert level ${alert}` : ""}.`,
    severity: severityFor(record.status, alert),
    ref: record.run_id,
    dedup: `workflows:run:${record.run_id}`,
    privacy: privacyOf(record.data_class),
    now,
    meta: {
      run_id: record.run_id, workflow: record.workflow, status: record.status, trigger,
      occurrence_key: record.occurrence_key, definition_hash: shortDigest(record.definition_hash), output_digest: shortDigest(record.output_digest),
      alert,
    },
  });
}

/** A trigger fired but no run happened (invalid, not runnable, bad input): still exactly one event, so it is not silent. */
export function refusedEvent(workflow: string, occurrenceKey: string, reason: string, alert: Alert, trigger: string, now: Date = new Date()): VigilEvent {
  return base({
    title: `${workflow}: refused`, summary: `A ${trigger} trigger for ${workflow} did not start a run (${reason}); alert level ${alert}.`,
    severity: severityFor("failed", alert), ref: null, dedup: `workflows:refused:${workflow}:${occurrenceKey}`, privacy: "personal", now,
    meta: { workflow, status: "refused", trigger, occurrence_key: occurrenceKey, reason, alert },
  });
}

/** An occurrence found the workflow full and its queue at size (ISC-124). */
export function droppedEvent(workflow: string, occurrenceKey: string, alert: Alert, trigger: string, now: Date = new Date()): VigilEvent {
  return base({
    title: `${workflow}: dropped`, summary: `An occurrence of ${workflow} was dropped: max_concurrent_runs is full and the queue is at queue_size (${trigger} trigger); alert level ${alert}.`,
    severity: severityFor("failed", alert), ref: null, dedup: `workflows:dropped:${workflow}:${occurrenceKey}`, privacy: "personal", now,
    meta: { workflow, status: "dropped", trigger, occurrence_key: occurrenceKey, alert },
  });
}

export function outboxHas(dedupKey: string): boolean {
  if (!vigil) return false;
  const path = vigil.statePath("outbox.jsonl");
  if (!existsSync(path)) return false;
  return readFileSync(path, "utf8").split("\n").some(line => line.includes(`"dedup_key":${JSON.stringify(dedupKey)}`));
}

/** Emits once per dedup key. Returns the event, or null when this key was already emitted. */
export function emitOnce(event: VigilEvent): VigilEvent | null {
  if (!vigil || outboxHas(event.dedup_key)) return null;
  return vigil.emit(event);
}

/* ── Failure streaks (2026-09-30) ───────────────────────────────────────── */
// A single failed run is medium (the digest). A workflow that keeps failing is high (a text), once per
// streak: once every cloud runner failed for a long stretch and nothing reached the principal, because
// cloud runs never produced a Vigil event and "workflows" was not a text-trusted source.

const FAILING: ReadonlySet<string> = new Set(["failed", "abandoned", "timed_out"]);
/** Neither a failure nor a recovery: the run never tried the work. */
const NEUTRAL: ReadonlySet<string> = new Set(["stopped", "dropped"]);
/** A streak alerts at this many consecutive failures, */
export const STREAK_MIN_FAILURES = 3;
/** or sooner once it has gone this long without a success (a daily job fails once a day). */
export const STREAK_MIN_AGE_MS = 2 * 60 * 60_000;

export interface FailureStreak { workflow: string; failures: number; first_run_id: string; first_at: string; last_at: string }

/** The current failure streak of every workflow whose most recent attempted runs all failed. */
export function failureStreaks(records: Array<Pick<LedgerRecord, "workflow" | "run_id" | "status" | "started_at">>): FailureStreak[] {
  const byWorkflow = new Map<string, typeof records>();
  for (const r of records) byWorkflow.set(r.workflow, [...(byWorkflow.get(r.workflow) ?? []), r]);
  const out: FailureStreak[] = [];
  for (const [workflow, runs] of byWorkflow) {
    const sorted = runs.filter(r => !NEUTRAL.has(r.status)).sort((a, b) => a.started_at.localeCompare(b.started_at));
    let i = sorted.length;
    while (i > 0 && FAILING.has(sorted[i - 1].status)) i--;
    const streak = sorted.slice(i);
    if (streak.length === 0) continue;
    out.push({ workflow, failures: streak.length, first_run_id: streak[0].run_id, first_at: streak[0].started_at, last_at: streak[streak.length - 1].started_at });
  }
  return out;
}

export function streakIsAlarming(s: FailureStreak, now: Date): boolean {
  return s.failures >= STREAK_MIN_FAILURES || now.getTime() - Date.parse(s.first_at) >= STREAK_MIN_AGE_MS;
}

/** A watch is a polling job: its failure streak is worth the digest and a dead-watch heartbeat, never a text that spends the shared budget (watch ISA F27, ISC-123). */
export const isWatchWorkflow = (workflow: string): boolean => workflow.startsWith("watch-");

/** One high event per streak (a watch-* workflow's is medium, the digest): the dedup key is the streak's first failed run, so a recovery and a new streak alert again. */
export function streakEvent(s: FailureStreak, now: Date = new Date()): VigilEvent {
  invariant(s.failures > 0, "A failure streak has at least one failure");
  const since = s.first_at.slice(11, 16);
  return base({
    title: `${s.workflow} keeps failing`,
    summary: `${s.workflow} has failed ${s.failures} run${s.failures === 1 ? "" : "s"} in a row since ${since} UTC with no success. Check: bun LIFEOS/WORKFLOWS/Workflows.ts show ${s.workflow}`,
    severity: isWatchWorkflow(s.workflow) ? "medium" : "high", ref: s.first_run_id, dedup: `workflows:streak:${s.workflow}:${s.first_run_id}`, privacy: "personal", now,
    meta: { workflow: s.workflow, failures: s.failures, first_run_id: s.first_run_id, first_at: s.first_at, last_at: s.last_at },
  });
}

/** Emits one event for each alarming streak not already reported; returns what was emitted. */
export function emitFailureStreaks(records: Parameters<typeof failureStreaks>[0], now: Date = new Date()): VigilEvent[] {
  return failureStreaks(records).filter(s => streakIsAlarming(s, now)).map(s => emitOnce(streakEvent(s, now))).filter((e): e is VigilEvent => e !== null);
}

/* ── Dispatcher heartbeat (ISC-122) ─────────────────────────────────────── */

export interface HeartbeatFile {
  source: typeof HEARTBEAT_SOURCE;
  ts: string;
  interval_seconds: number;
}

export const heartbeatPath = (): string | null => vigil?.statePath("heartbeats", `${HEARTBEAT_SOURCE}.json`) ?? null;

export function writeHeartbeat(now: Date = new Date(), intervalSeconds = 60): void {
  const path = heartbeatPath();
  if (!vigil || !path) return;
  vigil.writeJson(path, { source: HEARTBEAT_SOURCE, ts: now.toISOString(), interval_seconds: intervalSeconds } satisfies HeartbeatFile);
}

export function heartbeatState(now: Date = new Date()): { source: string; fresh: boolean; age_seconds: number | null } {
  const path = heartbeatPath();
  const file = vigil && path ? vigil.readJson<HeartbeatFile | null>(path, null) : null;
  const at = file?.ts ? Date.parse(file.ts) : Number.NaN;
  if (!Number.isFinite(at)) return { source: HEARTBEAT_SOURCE, fresh: false, age_seconds: null };
  const age = now.getTime() - at;
  return { source: HEARTBEAT_SOURCE, fresh: age <= HEARTBEAT_STALE_MS, age_seconds: Math.round(age / 1000) };
}

/** Raises one Vigil event per stale hour when the dispatcher has gone quiet; null when it is fresh or already reported. */
export function checkHeartbeat(now: Date = new Date()): VigilEvent | null {
  if (!vigil) return null;
  const state = heartbeatState(now);
  if (state.fresh) return null;
  const hour = now.toISOString().slice(0, 13);
  return emitOnce(base({
    title: "workflows dispatcher quiet",
    summary: state.age_seconds === null ? "The workflows dispatcher has never written a heartbeat." : `The workflows dispatcher last ticked ${state.age_seconds} seconds ago.`,
    severity: "high", ref: null, dedup: `${HEARTBEAT_SOURCE}:stale:${hour}`, privacy: "personal", now,
    meta: { source: HEARTBEAT_SOURCE, age_seconds: state.age_seconds },
  }));
}
