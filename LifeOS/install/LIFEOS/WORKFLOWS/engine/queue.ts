/**
 * The dispatcher's queue (ISA F8: ISC-26, ISC-124).
 *
 * A trigger that arrives while its workflow is at `max_concurrent_runs` waits
 * in the queue, up to `queue_size`. Past that the occurrence is dropped, and a
 * drop is never silent: it gets a ledger line with status `dropped` and the
 * caller raises a Vigil event. `decide` is the pure rule; the rest is the
 * file-backed queue beside the ledger.
 */
import { randomUUID } from "node:crypto";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { invariant } from "../../TOOLS/Invariant.ts";
import { ClaimView, ensureInside, readLedgerSlice, writeFileAtomic, type Claim } from "./ledger.ts";
import { NAME_RE } from "./paths.ts";

export type Decision = "start" | "queue" | "drop";

export interface Capacity {
  /** Runs of this workflow going now, plus jobs already cleared to start. */
  running: number;
  /** Jobs of this workflow waiting for a slot. */
  queued: number;
  max_concurrent_runs: number;
  queue_size: number;
}

/** A slot is free and nobody is ahead: start. Otherwise wait if the queue has room, else drop. */
export function decide(c: Capacity): Decision {
  invariant(c.running >= 0 && c.queued >= 0 && c.max_concurrent_runs >= 1 && c.queue_size >= 0, "Capacity numbers are non-negative and at least one run is allowed");
  if (c.running < c.max_concurrent_runs && c.queued === 0) return "start";
  return c.queued < c.queue_size ? "queue" : "drop";
}

export type JobTrigger = "after" | "event" | "schedule";

export interface Job {
  id: string;
  workflow: string;
  occurrence_key: string;
  trigger: JobTrigger;
  input?: unknown;
  enqueued_at: string;
  /** ready: cleared to start now and counted as running. waiting: holds a queue place. */
  state: "ready" | "waiting";
}

export function queuePath(dir: string): string {
  return join(dir, "queue.json");
}

export function readQueue(dir: string): Job[] {
  const path = queuePath(dir);
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(parsed) ? (parsed as Job[]) : [];
  } catch {
    return [];
  }
}

export function writeQueue(dir: string, jobs: Job[]): void {
  invariant(jobs.every(j => NAME_RE.test(j.workflow) && j.occurrence_key.length > 0 && (j.state === "ready" || j.state === "waiting")), "Queued jobs name a workflow, an occurrence and a state");
  mkdirSync(dir, { recursive: true });
  writeFileAtomic(queuePath(dir), `${JSON.stringify(jobs)}\n`);
}

const LOCK_STALE_MS = 60_000;

/** Runs `fn` while holding the queue lock; a lock older than a minute belongs to a dead process and is taken over. */
export async function withQueueLock<T>(dir: string, fn: () => Promise<T> | T): Promise<T> {
  mkdirSync(dir, { recursive: true });
  const lock = join(dir, "queue.lock");
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      const fd = openSync(lock, "wx");
      writeSync(fd, `${process.pid}\n`);
      closeSync(fd);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) rmSync(lock, { force: true });
      } catch {
        /* released between the check and the stat */
      }
      invariant(Date.now() < deadline, `Could not take the queue lock at ${lock}`);
      await new Promise(r => setTimeout(r, 25));
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(lock, { force: true });
  }
}

/** Claims and ledger occurrences read together, so one queue decision reads each once. */
export interface ClaimSnapshot {
  claims: Claim[];
  /** `workflow\0occurrence_key` of every ledger line in the readable tail. */
  finished: Set<string>;
}

export const occurrenceId = (workflow: string, key: string): string => `${workflow}\0${key}`;

/**
 * Reads claim snapshots for one short decision. Call `read` once before the
 * queue lock to do the parsing there; a `read` under the lock then opens only
 * claim markers that appeared since and parses only ledger lines appended
 * since. Every read takes the claims first, then the ledger: a run appends its
 * line before it removes its claim, so an occurrence whose claim is gone by
 * the first read is already in the ledger by the second.
 */
export class ClaimSnapshotReader {
  private readonly claims: ClaimView;
  private readonly finished = new Set<string>();
  private end: number | undefined;

  constructor(private readonly ledger: string) {
    this.claims = new ClaimView(ledger);
  }

  read(): ClaimSnapshot {
    const claims = this.claims.read();
    const slice = readLedgerSlice(this.ledger, this.end);
    for (const r of slice.records) this.finished.add(occurrenceId(r.workflow, r.occurrence_key));
    this.end = slice.end;
    return { claims, finished: this.finished };
  }
}

export function readClaimSnapshot(ledger: string): ClaimSnapshot {
  return new ClaimSnapshotReader(ledger).read();
}

/** Occurrences of a workflow that hold a claim but have no ledger line yet and are still inside their deadline. */
export function activeKeysIn(snapshot: ClaimSnapshot, workflow: string, now: Date): Set<string> {
  const keys = new Set<string>();
  for (const claim of snapshot.claims) {
    if (claim.workflow !== workflow || snapshot.finished.has(occurrenceId(workflow, claim.occurrence_key))) continue;
    const deadline = claim.deadline_at ? Date.parse(claim.deadline_at) : Date.parse(claim.at) + 30 * 60_000;
    if (Number.isFinite(deadline) && deadline > now.getTime()) keys.add(claim.occurrence_key);
  }
  return keys;
}

/** `activeKeysIn` over a fresh read; for callers making one decision. */
export function activeClaimKeys(ledger: string, workflow: string, now: Date): Set<string> {
  return activeKeysIn(readClaimSnapshot(ledger), workflow, now);
}

/**
 * The ledger line for an occurrence that found the workflow full and the queue
 * at its size (ISC-124). It carries `status: "dropped"` and no steps; every
 * ledger reader takes it as a run that never started.
 */
export function appendDropped(ledger: string, args: { workflow: string; occurrence_key: string; trigger: string; data_class: string; runs_on: string; at: Date; reason: string }): string {
  invariant(ledger.endsWith(".jsonl"), `Ledger path must be a .jsonl file: ${ledger}`);
  invariant(args.workflow.length > 0 && args.occurrence_key.length > 0, "A dropped line names its workflow and occurrence");
  mkdirSync(dirname(ledger), { recursive: true });
  ensureInside(dirname(ledger), ledger, "Ledger");
  const runId = randomUUID();
  const at = args.at.toISOString();
  const record = {
    schema: 1, run_id: runId, workflow: args.workflow, definition_path: "", definition_hash: "", trigger: args.trigger,
    occurrence_key: args.occurrence_key, data_class: args.data_class, runs_on: args.runs_on, started_at: at, finished_at: at,
    status: "dropped", steps: {}, output_digest: null, error: args.reason,
  };
  const line = `${JSON.stringify(record)}\n`;
  invariant(!line.slice(0, -1).includes("\n"), "Ledger line must be one line");
  appendFileSync(ledger, line);
  return runId;
}
