#!/usr/bin/env bun
/**
 * The thin dispatcher (ISA F8; F27 ISC-312: the one Mac clock).
 *
 *   dispatcher.ts serve                  the one long-lived launchd job: every minute, fire each due time trigger,
 *                                        start `after:` and `event` workflows, start queued runs, beat
 *   dispatcher.ts fire <name>            evaluate one workflow's time triggers now (by hand; no plist wakes it)
 *   dispatcher.ts tick                   one pass of `after:` and `event` dispatch, drain the queue, beat
 *   dispatcher.ts event <name> [--input JSON] [--id ID]   record a named event for the next tick (idempotent by --id)
 *   dispatcher.ts heartbeat-check        raise a Vigil event when the dispatcher has gone quiet
 *
 * It starts a run only by spawning `bun workflow.ts run ...` as an argv, so it
 * never imports the runner. Every spawn sets LIFEOS_NOTIFICATION_CHANNEL=headless.
 * Nothing detaches: `tick` and `fire` await the children they started; `serve` keeps its children as tracked
 * promises inside its own long-lived process, so launchd sees exactly one job (incident 2026-10-24: one launchd
 * job per workflow, ~2,750 starts an hour, made macOS's dasd write ~5 GB a minute).
 */
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { invariant } from "../../TOOLS/Invariant.ts";
import { loadDefinitionFile, type DefinitionV2, type TriggerV2 } from "./format.ts";
import { readLedger, readLedgerSlice, writeFileAtomic, type LedgerRecord } from "./ledger.ts";
import { isGloballyPaused } from "./pause.ts";
import { artifactsRoot, DEFINITION_SUFFIX, definitionsDir, ledgerPath, pathForName } from "./paths.ts";
import { activeKeysIn, appendDropped, ClaimSnapshotReader, decide, occurrenceId, readQueue, withQueueLock, writeQueue, type ClaimSnapshot, type Job, type JobTrigger } from "./queue.ts";
import {
  HEADLESS_CHANNEL, isOnceConsumed, markOnceConsumed, occurrencesBetween, planCatchUp, readScheduleState, scheduleStateDir, setLastEvaluated, type TimeTrigger,
} from "./schedule.ts";
import { readStepValues } from "./store.ts";
import { FALLBACK_AFTER_MS, LEASE_MAX, TICK_STALE_MS, configuredClock, readClockState, syncIfChanged, writeClockState, type ClockClient, type Outcome } from "./cloud-clock.ts";
import { checkHeartbeat, droppedEvent, emitOnce, refusedEvent, runEvent, writeHeartbeat } from "./vigil-emit.ts";

export interface SpawnResult {
  code: number | null;
  stdout: string;
}

export interface DispatchDeps {
  ledger: string;
  defsDir: string;
  stateDir: string;
  now: () => Date;
  /** The workflow CLI the dispatcher spawns. */
  cli: string;
  bun: string;
  /** Extra environment for spawned runs; the channel is forced to headless after it. */
  env: Record<string, string>;
  spawn: (argv: string[], env: Record<string, string>, timeoutMs: number) => Promise<SpawnResult>;
  /** Jobs this process cleared to start and has not finished; they count as running. */
  inflight: Set<string>;
  /** serve: where the last pass stopped reading the ledger, so each pass parses only what was appended since. */
  ledgerOffset?: number;
  /** The cloud clock (ISC-318); absent, the dispatcher keeps its own clock as in wave 0. Only `serve` sets it. */
  clock?: ClockClient | null;
}

async function defaultSpawn(argv: string[], env: Record<string, string>, timeoutMs: number): Promise<SpawnResult> {
  const proc = Bun.spawn(argv, { env, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  try {
    const [stdout] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    return { code: await proc.exited, stdout };
  } finally {
    clearTimeout(timer);
  }
}

export function defaultDeps(overrides: Partial<DispatchDeps> = {}): DispatchDeps {
  const ledger = overrides.ledger ?? ledgerPath();
  return {
    ledger,
    defsDir: definitionsDir(),
    stateDir: join(dirname(ledger), "dispatcher"),
    now: () => new Date(),
    cli: join(import.meta.dir, "..", "workflow.ts"),
    bun: process.execPath,
    env: {},
    spawn: defaultSpawn,
    inflight: new Set<string>(),
    ...overrides,
  };
}

/** The environment every spawned run gets. The channel cannot be overridden (ISC-119). */
export function childEnv(deps: DispatchDeps): Record<string, string> {
  return {
    ...(process.env as Record<string, string>), ...deps.env,
    LIFEOS_WORKFLOWS_DIR: deps.defsDir, LIFEOS_WORKFLOWS_LEDGER: deps.ledger,
    LIFEOS_NOTIFICATION_CHANNEL: HEADLESS_CHANNEL,
  };
}

/** The exact argv a job spawns: the workflow CLI's `run`, never an import. */
export function runArgv(deps: DispatchDeps, job: Job): string[] {
  return [deps.bun, deps.cli, "run", job.workflow, "--json", "--trigger", job.trigger, "--occurrence", job.occurrence_key, ...(job.input !== undefined ? ["--input", JSON.stringify(job.input)] : [])];
}

/* ── Definitions ────────────────────────────────────────────────────────── */

interface Loaded {
  def: DefinitionV2;
  path: string;
}

export function loadDefinitions(defsDir: string): Map<string, Loaded> {
  const out = new Map<string, Loaded>();
  if (!existsSync(defsDir)) return out;
  for (const file of readdirSync(defsDir).filter(f => f.endsWith(DEFINITION_SUFFIX))) {
    const path = join(defsDir, file);
    try {
      const { def } = loadDefinitionFile(path);
      out.set(def.name, { def, path });
    } catch {
      /* an invalid definition never dispatches; `workflow validate` reports it */
    }
  }
  return out;
}

const enabled = (t: { enabled?: boolean }) => t.enabled !== false;

/* ── Submit, drain ──────────────────────────────────────────────────────── */

const flightKey = (workflow: string, key: string) => `${workflow}\u0000${key}`;

/** Running occurrences of a workflow: live claims, jobs this process started, and jobs cleared to start. */
function activeCount(deps: DispatchDeps, workflow: string, claimed: Set<string>, queue: Job[]): number {
  const keys = new Set(claimed);
  for (const k of deps.inflight) {
    const [wf, key] = k.split("\u0000");
    if (wf === workflow) keys.add(key);
  }
  for (const j of queue) if (j.workflow === workflow && j.state === "ready") keys.add(j.occurrence_key);
  return keys.size;
}

export type SubmitResult = "start" | "queue" | "drop" | "duplicate" | "unknown-workflow";

/**
 * Decides one arriving occurrence against max_concurrent_runs and queue_size (ISC-26, ISC-124).
 * Claims and the ledger are parsed before the queue lock; under it each is
 * read once more, and only what changed since is opened or parsed.
 */
export async function submit(deps: DispatchDeps, defs: Map<string, Loaded>, job: Omit<Job, "id" | "enqueued_at" | "state">, opts: { skipWhenFull?: string } = {}): Promise<SubmitResult> {
  const entry = defs.get(job.workflow);
  if (!entry || !enabled(entry.def)) return "unknown-workflow";
  const now = deps.now();
  const reader = new ClaimSnapshotReader(deps.ledger);
  reader.read();
  return withQueueLock(deps.stateDir, () => {
    const queue = readQueue(deps.stateDir);
    const snapshot = reader.read();
    const claimed = activeKeysIn(snapshot, job.workflow, now);
    const known = queue.some(j => j.workflow === job.workflow && j.occurrence_key === job.occurrence_key)
      || deps.inflight.has(flightKey(job.workflow, job.occurrence_key))
      || snapshot.finished.has(occurrenceId(job.workflow, job.occurrence_key))
      || claimed.has(job.occurrence_key);
    if (known) return "duplicate";
    const decision = decide({
      running: activeCount(deps, job.workflow, claimed, queue),
      queued: queue.filter(j => j.workflow === job.workflow && j.state === "waiting").length,
      max_concurrent_runs: entry.def.max_concurrent_runs,
      queue_size: entry.def.queue_size,
    });
    if (decision === "drop" && opts.skipWhenFull) {
      // A missed_run: skip schedule whose previous run is still going: the per-workflow timers never started an overlapping
      // run either (launchd does not), so this is the recorded skip it always was, not a dropped run with an alert.
      mkdirSync(opts.skipWhenFull, { recursive: true });
      appendFileSync(join(opts.skipWhenFull, "skipped.jsonl"), `${JSON.stringify({ schema: 1, workflow: job.workflow, trigger: "schedule", occurrence_key: job.occurrence_key, at: now.toISOString(), reason: "still_running", recorded_at: now.toISOString() })}\n`);
      return "drop";
    }
    if (decision === "drop") {
      appendDropped(deps.ledger, { workflow: job.workflow, occurrence_key: job.occurrence_key, trigger: job.trigger, data_class: entry.def.data_class, runs_on: entry.def.runs_on, at: now, reason: "max_concurrent_runs full and queue at queue_size" });
      emitOnce(droppedEvent(job.workflow, job.occurrence_key, entry.def.alert, job.trigger, now));
      return "drop";
    }
    writeQueue(deps.stateDir, [...queue, { ...job, id: randomUUID(), enqueued_at: now.toISOString(), state: decision === "start" ? "ready" : "waiting" }]);
    return decision;
  });
}

function parseReport(stdout: string): { run_id?: string; refused?: string; error?: string } {
  const text = stdout.trim();
  for (const candidate of [text, text.split("\n").filter(Boolean).pop() ?? ""]) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      /* try the next shape */
    }
  }
  return {};
}

/** Starts one cleared job by spawning the CLI, then emits its single Vigil event once the ledger line exists (ISC-141, 143). */
async function runJob(deps: DispatchDeps, defs: Map<string, Loaded>, job: Job): Promise<void> {
  const entry = defs.get(job.workflow)!;
  const timeout = (entry.def.deadline_ms ?? 1_800_000) + 60_000;
  const before = existsSync(deps.ledger) ? statSync(deps.ledger).size : 0;
  let result: SpawnResult;
  try {
    result = await deps.spawn(runArgv(deps, job), childEnv(deps), timeout);
  } finally {
    deps.inflight.delete(flightKey(job.workflow, job.occurrence_key));
  }
  const report = parseReport(result.stdout);
  const mine = (r: LedgerRecord) => r.workflow === job.workflow && r.occurrence_key === job.occurrence_key && r.status !== ("dropped" as string);
  const record = readLedgerSlice(deps.ledger, before).records.find(mine) ?? readLedger(deps.ledger).records.find(mine);
  const now = deps.now();
  if (record) {
    emitOnce(runEvent(record, entry.def.alert, job.trigger, now));
  } else if (report.refused !== "duplicate-occurrence") {
    emitOnce(refusedEvent(job.workflow, job.occurrence_key, report.refused ?? `exit ${result.code}, no ledger line`, entry.def.alert, job.trigger, now));
  }
}

/** Promotes waiting jobs into free slots, starts every ready job concurrently, and repeats until nothing more can start. */
export async function drain(deps: DispatchDeps, defs: Map<string, Loaded>, opts: { wait?: boolean } = {}): Promise<number> {
  // ISC-123: while the fleet is paused nothing starts; queued jobs stay queued until `workflow resume --all`.
  if (isGloballyPaused(deps.ledger)) return 0;
  let started = 0;
  for (;;) {
    // Parse the claims outside the lock only when a waiting job will need them; a lock-free queue read is a hint, never a decision.
    const reader = new ClaimSnapshotReader(deps.ledger);
    if (readQueue(deps.stateDir).some(j => j.state === "waiting")) reader.read();
    const batch = await withQueueLock(deps.stateDir, () => {
      const queue = readQueue(deps.stateDir);
      const now = deps.now();
      let snapshot: ClaimSnapshot | undefined;
      const claimedBy = new Map<string, Set<string>>();
      for (const job of queue) {
        if (job.state !== "waiting") continue;
        const entry = defs.get(job.workflow);
        if (!entry) continue;
        snapshot ??= reader.read();
        if (!claimedBy.has(job.workflow)) claimedBy.set(job.workflow, activeKeysIn(snapshot, job.workflow, now));
        if (activeCount(deps, job.workflow, claimedBy.get(job.workflow)!, queue) < entry.def.max_concurrent_runs) job.state = "ready";
      }
      const ready = queue.filter(j => j.state === "ready" && defs.has(j.workflow));
      writeQueue(deps.stateDir, queue.filter(j => !ready.includes(j)));
      for (const j of ready) deps.inflight.add(flightKey(j.workflow, j.occurrence_key));
      return ready;
    });
    if (!batch.length) return started;
    started += batch.length;
    const runs = batch.map(job => runJob(deps, defs, job).catch(e => console.error(`dispatcher: ${job.workflow} ${job.occurrence_key}: ${e instanceof Error ? e.message : String(e)}`)));
    // serve: the runs stay tracked by deps.inflight until they finish; the next pass promotes waiting jobs into freed slots.
    if (opts.wait === false) continue;
    await Promise.all(runs);
  }
}

/* ── after: and event: dispatch (ISC-25) ────────────────────────────────── */

interface DispatcherState {
  seen: string[];
}

const statePathOf = (deps: DispatchDeps) => join(deps.stateDir, "cursor.json");
const SEEN_CAP = 5_000;

/** The upstream run's output as the downstream's typed input: the value its single terminal step stored, when the store keeps it. */
export function upstreamInput(deps: DispatchDeps, defs: Map<string, Loaded>, record: LedgerRecord): unknown {
  const upstream = defs.get(record.workflow)?.def;
  if (!upstream) return undefined;
  const needed = new Set(Object.values(upstream.steps).flatMap(s => s.needs));
  const terminal = Object.keys(upstream.steps).filter(id => !needed.has(id));
  if (terminal.length !== 1) return undefined;
  const value = readStepValues(artifactsRoot(deps.ledger), record.run_id, terminal[0])?.output;
  return value === null ? undefined : value;
}

const afterMatches = (t: Extract<TriggerV2, { type: "after" }>, status: string) => (t.status === "completed" ? status === "succeeded" || status === "failed" : t.status === status);

export interface TickSummary {
  dispatched: Array<{ workflow: string; occurrence_key: string; trigger: JobTrigger; result: SubmitResult }>;
  started: number;
  seeded: boolean;
  /** true when the global pause held this tick back. */
  paused?: boolean;
}

export async function tick(deps: DispatchDeps = defaultDeps(), opts: { schedules?: boolean; wait?: boolean } = {}): Promise<TickSummary> {
  mkdirSync(deps.stateDir, { recursive: true });
  const defs = loadDefinitions(deps.defsDir);
  const dispatched: TickSummary["dispatched"] = [];
  const say = (where: string, e: unknown) => console.error(`dispatcher: ${where}: ${e instanceof Error ? e.message : String(e)}`);
  // ISC-123: a paused fleet starts nothing. The after: cursor and the event inbox are left untouched, so both are picked up on resume.
  if (isGloballyPaused(deps.ledger)) {
    // Paused still checks in with the cloud clock, so a pause never reads there as a dead Mac.
    if (opts.schedules && deps.clock) await deps.clock.lease(0).catch(e => say("clock heartbeat", e));
    writeHeartbeat(deps.now());
    return { dispatched, started: 0, seeded: false, paused: true };
  }

  // ISC-312: the one Mac clock, first in the pass so nothing earlier can starve it. Every enabled local workflow's time
  // triggers are evaluated with fire's catch-up rules; a cloud workflow is scheduled by its own runner, never here.
  if (opts.schedules) {
    // ISC-318/319: while the cloud clock answers it is the only clock; the Mac fires its own triggers only after
    // FALLBACK_AFTER_MS without an answer, starting from the last answer.
    const clock = deps.clock ? await cloudSchedules(deps, defs, dispatched, say) : { local: true, since: undefined };
    for (const [name, { def }] of clock.local ? defs : []) {
      if (def.runs_on !== "local" || !enabled(def) || !def.triggers.some(t => enabled(t) && (t.type === "schedule" || t.type === "interval" || t.type === "once"))) continue;
      try {
        const fired = await fireDue(name, defs, deps, { since: clock.since });
        for (const [i, key] of fired.ran.entries()) dispatched.push({ workflow: name, occurrence_key: key, trigger: "schedule", result: fired.results[i]! });
      } catch (e) {
        say(`schedule ${name}`, e);
      }
    }
    try {
      reportUnloadable(deps, defs);
    } catch (e) {
      say("definition check", e);
    }
  }

  let first = false;
  try {
    // A long-lived serve reads only the lines appended since its last pass; re-parsing the 16 MB tail every minute held
    // about 1 GB resident (measured 2026-10-24). tick and a first pass read the tail, as before.
    const slice = readLedgerSlice(deps.ledger, deps.ledgerOffset);
    if (deps.ledgerOffset !== undefined || opts.schedules) deps.ledgerOffset = slice.end;
    const records = slice.records.filter(r => (r.status as string) !== "dropped");
    const path = statePathOf(deps);
    first = !existsSync(path);
    const seen = new Set<string>(first ? records.map(r => r.run_id) : (JSON.parse(readFileSync(path, "utf8")) as DispatcherState).seen);
    if (!first) {
      for (const record of records) {
        if (seen.has(record.run_id)) continue;
        seen.add(record.run_id);
        // One bad record is reported and passed, so it cannot stop the records after it or retry every minute.
        try {
          for (const { def } of defs.values()) {
            if (!enabled(def)) continue;
            for (const t of def.triggers) {
              if (t.type !== "after" || !enabled(t) || t.workflow !== record.workflow || !afterMatches(t, record.status)) continue;
              const job = { workflow: def.name, occurrence_key: `after:${record.workflow}:${record.run_id}`, trigger: "after" as const, input: upstreamInput(deps, defs, record) };
              dispatched.push({ workflow: def.name, occurrence_key: job.occurrence_key, trigger: "after", result: await submit(deps, defs, job) });
            }
          }
        } catch (e) {
          say(`after: ${record.workflow} ${record.run_id}`, e);
          try { emitOnce(refusedEvent(record.workflow, `after-dispatch:${record.run_id}`, `its after: links could not be dispatched (${e instanceof Error ? e.message : String(e)})`, "normal", "after", deps.now())); } catch { /* the log line above stands */ }
        }
      }
    }
    writeFileAtomic(path, `${JSON.stringify({ seen: [...seen].slice(-SEEN_CAP) } satisfies DispatcherState)}\n`);
  } catch (e) {
    say("after: dispatch", e);
  }

  const inbox = join(deps.stateDir, "events");
  if (existsSync(inbox)) {
    for (const file of readdirSync(inbox).filter(f => f.endsWith(".json")).sort()) {
      try {
        const from = join(inbox, file);
        let event: { id: string; name: string; input?: unknown };
        try {
          event = JSON.parse(readFileSync(from, "utf8"));
        } catch {
          continue;
        }
        for (const { def } of defs.values()) {
          if (!enabled(def)) continue;
          for (const t of def.triggers) {
            if (t.type !== "event" || !enabled(t) || t.name !== event.name) continue;
            const job = { workflow: def.name, occurrence_key: `event:${event.name}:${event.id}`, trigger: "event" as const, input: event.input };
            dispatched.push({ workflow: def.name, occurrence_key: job.occurrence_key, trigger: "event", result: await submit(deps, defs, job) });
          }
        }
        mkdirSync(join(inbox, "done"), { recursive: true });
        renameSync(from, join(inbox, "done", file));
      } catch (e) {
        say(`event ${file}`, e);
      }
    }
  }

  const started = await drain(deps, defs, { wait: opts.wait });
  // The beat comes after the pass, so a dispatcher whose passes keep failing goes stale instead of looking alive.
  writeHeartbeat(deps.now());
  return { dispatched, started, seeded: first };
}

const SUBMIT_OUTCOME: Record<SubmitResult, Outcome> = { start: "submitted", queue: "submitted", duplicate: "duplicate", drop: "skipped", "unknown-workflow": "refused" };

/**
 * One pass against the cloud clock: sync the schedule set when it changed, lease what the cloud queued, hand each run to
 * the local queue and report the outcome. Returns `local: true` (with the floor to start from) only when the cloud has
 * not answered for FALLBACK_AFTER_MS.
 */
async function cloudSchedules(deps: DispatchDeps, defs: Map<string, Loaded>, dispatched: TickSummary["dispatched"], say: (where: string, e: unknown) => void): Promise<{ local: boolean; since?: Date }> {
  const client = deps.clock!;
  const now = deps.now();
  const state = readClockState(deps.stateDir);
  try {
    const dir = scheduleStateDir(deps.ledger);
    await syncIfChanged(client, [...defs.values()].map(l => l.def), state, now, {
      since: name => readScheduleState(dir, name).last_evaluated,
      keep: unloadableNames(deps, defs),
    });
    const { runs, last_tick } = await client.lease(LEASE_MAX);
    for (const run of runs) {
      const def = defs.get(run.workflow)?.def;
      const kind = run.occurrence_key.slice(0, run.occurrence_key.indexOf(":"));
      const triggers = (def?.triggers ?? []).filter(t => enabled(t) && t.type === kind) as TimeTrigger[];
      // The Mac is the authority on which once triggers already ran: the cloud cannot know what this Mac fired before it
      // was connected, and the ledger's duplicate check reads only its recent tail (2026-10-24: an Oct 21 reminder re-ran).
      const onceAt = kind === "once" ? run.occurrence_key.slice("once:".length) : undefined;
      let result: SubmitResult;
      try {
        result = onceAt !== undefined && isOnceConsumed(dir, run.workflow, onceAt)
          ? "duplicate"
          : await submit(deps, defs, { workflow: run.workflow, occurrence_key: run.occurrence_key, trigger: "schedule" }, triggers.some(t => t.missed_run === "once") ? {} : { skipWhenFull: dir });
      } catch (e) {
        say(`clock run ${run.id}`, e);
        continue; // the lease lapses and the cloud offers it again
      }
      // Consumed once submitted, so a later fallback cannot fire it again.
      if (onceAt !== undefined) markOnceConsumed(dir, run.workflow, onceAt);
      dispatched.push({ workflow: run.workflow, occurrence_key: run.occurrence_key, trigger: "schedule", result });
      // One failed report must not strand the runs after it; an unreported lease lapses and comes back as a duplicate.
      try {
        await client.complete(run.id, SUBMIT_OUTCOME[result], result === "unknown-workflow" ? "not an enabled workflow on this Mac" : result);
      } catch (e) {
        say(`clock complete ${run.id}`, e);
      }
    }
    // A clock that answers but whose cron has stopped is no clock: count it as no answer, so the fallback can take over.
    if (!last_tick || now.getTime() - Date.parse(last_tick) > TICK_STALE_MS) throw new Error(`the cloud clock answers but last ticked ${last_tick ?? "never"}`);
    const recovered = state.fallback_since !== undefined;
    writeClockState(deps.stateDir, { ...state, last_ok: now.toISOString(), fallback_since: undefined });
    if (recovered) console.error("dispatcher: the cloud clock answered again; the Mac clock stands down");
    return { local: false };
  } catch (e) {
    say("cloud clock", e);
    const lastOk = state.last_ok ? new Date(state.last_ok) : undefined;
    if (lastOk && now.getTime() - lastOk.getTime() < FALLBACK_AFTER_MS) return { local: false };
    if (!state.fallback_since) {
      writeClockState(deps.stateDir, { ...state, fallback_since: now.toISOString() });
      try { emitOnce(refusedEvent("workflows-dispatcher", `clock-fallback:${now.toISOString().slice(0, 13)}`, "the cloud clock has not answered for 10 minutes; the Mac is running its own clock until it does", "high", "schedule", now)); } catch { /* the log line stands */ }
    }
    return { local: true, since: lastOk };
  }
}

/** Definition files present but not loadable this pass, by name. */
function unloadableNames(deps: DispatchDeps, defs: Map<string, Loaded>): string[] {
  if (!existsSync(deps.defsDir)) return [];
  const loaded = new Set([...defs.values()].map(l => l.path));
  return readdirSync(deps.defsDir).filter(f => f.endsWith(DEFINITION_SUFFIX) && !loaded.has(join(deps.defsDir, f))).map(f => f.slice(0, -DEFINITION_SUFFIX.length));
}

/** A definition file that does not load is never scheduled; it gets one refused event an hour instead of silence. */
function reportUnloadable(deps: DispatchDeps, defs: Map<string, Loaded>): void {
  if (!existsSync(deps.defsDir)) return;
  const loaded = new Set([...defs.values()].map(l => l.path));
  const now = deps.now();
  for (const file of readdirSync(deps.defsDir).filter(f => f.endsWith(DEFINITION_SUFFIX))) {
    if (loaded.has(join(deps.defsDir, file))) continue;
    const name = file.slice(0, -DEFINITION_SUFFIX.length);
    emitOnce(refusedEvent(name, `load:${now.toISOString().slice(0, 13)}`, "its definition does not load, so nothing schedules it; run workflow validate", "normal", "schedule", now));
  }
}

/** Newest modification time among the engine sources this process imported. */
function engineMtime(): number {
  let newest = 0;
  for (const f of readdirSync(import.meta.dir)) if (f.endsWith(".ts") && !f.endsWith(".test.ts")) newest = Math.max(newest, statSync(join(import.meta.dir, f)).mtimeMs);
  return newest;
}

/**
 * The one long-lived Workflows job on the Mac (ISC-312). Each pass runs just after a minute boundary, so a cron minute
 * fires on time; a pass that throws is logged and the loop goes on. When the engine source changes it returns, and
 * launchd (KeepAlive) starts the new code; runs in flight survive, since the plist sets AbandonProcessGroup.
 */
export async function serve(deps: DispatchDeps = defaultDeps(), opts: { passes?: number; sleep?: (ms: number) => Promise<void>; codeVersion?: () => number } = {}): Promise<number> {
  const sleep = opts.sleep ?? ((ms: number) => Bun.sleep(ms));
  const version = opts.codeVersion ?? engineMtime;
  const startedWith = version();
  let passes = 0;
  for (;;) {
    try {
      await tick(deps, { schedules: true, wait: false });
    } catch (e) {
      console.error(`dispatcher: pass failed: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
    }
    passes++;
    if (opts.passes !== undefined && passes >= opts.passes) return passes;
    if (version() !== startedWith) {
      console.error("dispatcher: engine source changed; exiting so launchd starts the new code");
      return passes;
    }
    const now = deps.now().getTime();
    await sleep(60_000 - (now % 60_000) + 1_000);
  }
}

/** A caller-chosen event id: one path segment, so it can name the inbox file. */
const EVENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/**
 * Records a named event for the next tick to dispatch (ISC-71's door).
 *
 * With an `id` the call is idempotent by that id (STATVS migration design Lane G): the event is written
 * once, and a second call with the same id, waiting in the inbox or already dispatched into `done/`,
 * writes nothing and returns the id. Vigil hands off with id = the answered row id, so a re-run tick
 * cannot start a second run. Without an id a fresh UUID is used, as before. The legacy call shape
 * `emitEvent(name, input, deps)` still works.
 */
export function emitEvent(name: string, input: unknown, idOrDeps?: string | DispatchDeps, maybeDeps?: DispatchDeps): string {
  invariant(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(name), `"${name}" is not an event name`);
  const given = typeof idOrDeps === "string" ? idOrDeps : undefined;
  const deps = (typeof idOrDeps === "object" && idOrDeps ? idOrDeps : maybeDeps) ?? defaultDeps();
  if (given !== undefined) invariant(EVENT_ID_RE.test(given), `"${given}" is not an event id`);
  const id = given ?? randomUUID();
  const dir = join(deps.stateDir, "events");
  if (given !== undefined && (existsSync(join(dir, `${id}.json`)) || existsSync(join(dir, "done", `${id}.json`)))) return id;
  mkdirSync(dir, { recursive: true });
  writeFileAtomic(join(dir, `${id}.json`), `${JSON.stringify({ id, name, ...(input !== undefined ? { input } : {}), at: deps.now().toISOString() })}\n`);
  return id;
}

/* ── The scheduled entrypoint (ISC-27, 116, 117) ────────────────────────── */

export interface FireSummary {
  workflow: string;
  ran: string[];
  skipped: Array<{ key: string; reason: string }>;
  results: SubmitResult[];
}

export async function fire(name: string, deps: DispatchDeps = defaultDeps()): Promise<FireSummary> {
  const defs = loadDefinitions(deps.defsDir);
  const summary = await fireDue(name, defs, deps);
  await drain(deps, defs);
  return summary;
}

/** Evaluates one workflow's time triggers against now and submits the occurrence due, without starting it (ISC-27, 116, 117). */
export async function fireDue(name: string, defs: Map<string, Loaded>, deps: DispatchDeps, opts: { since?: Date } = {}): Promise<FireSummary> {
  const now = deps.now();
  const summary: FireSummary = { workflow: name, ran: [], skipped: [], results: [] };
  const entry = defs.get(name);
  if (!entry || !enabled(entry.def)) {
    // A plist for a workflow that is gone or paused still gets its one Vigil line.
    emitOnce(refusedEvent(name, `fire:${now.toISOString().slice(0, 13)}`, entry ? "workflow disabled" : "definition not found", entry?.def.alert ?? "normal", "schedule", now));
    return summary;
  }
  // ISC-123: paused means paused. Nothing is submitted, no once trigger is consumed and last_evaluated does not move, so catch-up (bounded by grace_minutes) sees the missed slots on resume.
  if (isGloballyPaused(deps.ledger)) {
    emitOnce(refusedEvent(name, `fire:paused:${now.toISOString().slice(0, 13)}`, "fleet paused", entry.def.alert, "schedule", now));
    summary.skipped.push({ key: `fire:${now.toISOString()}`, reason: "paused" });
    return summary;
  }
  const dir = scheduleStateDir(deps.ledger);
  const state = readScheduleState(dir, name);
  // A fallback after the cloud clock went quiet starts from the cloud's last answer: the cloud ran everything before it.
  const recorded = state.last_evaluated ? new Date(state.last_evaluated) : undefined;
  const floor = opts.since && (!recorded || opts.since > recorded) ? opts.since : recorded;
  const since = floor ?? new Date(now.getTime() - 300_000);
  let moved = false;
  for (const t of entry.def.triggers) {
    if (!enabled(t) || (t.type !== "schedule" && t.type !== "interval" && t.type !== "once")) continue;
    const trigger: TimeTrigger = t;
    if (t.type === "once" && isOnceConsumed(dir, name, t.at)) continue;
    const occurrences = occurrencesBetween(trigger, t.type === "once" ? new Date(0) : since, now);
    if (!occurrences.length) continue;
    moved = true;
    // Only a recorded previous wake proves the cadence; the 5-minute default window is not one (ISC-27, interval cadence).
    const plan = planCatchUp(trigger, occurrences, now, floor);
    for (const s of plan.skipped) {
      summary.skipped.push({ key: s.key, reason: s.reason });
      mkdirSync(dir, { recursive: true });
      appendFileSync(join(dir, "skipped.jsonl"), `${JSON.stringify({ schema: 1, workflow: name, trigger: t.type, occurrence_key: s.key, at: s.at, reason: s.reason, recorded_at: now.toISOString() })}\n`);
    }
    // A once trigger is consumed the moment it is decided, before anything runs, so a crash cannot fire it twice.
    if (t.type === "once") markOnceConsumed(dir, name, t.at);
    if (!plan.run) continue;
    summary.ran.push(plan.run.key);
    summary.results.push(await submit(deps, defs, { workflow: name, occurrence_key: plan.run.key, trigger: "schedule" }, trigger.missed_run === "once" ? {} : { skipWhenFull: dir }));
    moved = true;
  }
  // Written when an occurrence was decided, or hourly: a minute-by-minute write for every workflow was ~240k writes a day,
  // and the next pass reaches the same answer from the older value, since nothing fell between them.
  if (moved || !state.last_evaluated || now.getTime() - Date.parse(state.last_evaluated) >= 3_600_000) setLastEvaluated(dir, name, now);
  return summary;
}

/* ── CLI ────────────────────────────────────────────────────────────────── */

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const out = (value: unknown) => console.log(JSON.stringify(value));
  switch (command) {
    case "fire": {
      if (!rest[0]) throw new Error("usage: dispatcher.ts fire <workflow-name>");
      out(await fire(rest[0]));
      return 0;
    }
    case "tick":
      out(await tick());
      return 0;
    case "serve":
      await serve(defaultDeps({ clock: configuredClock() }));
      return 0;
    case "event": {
      if (!rest[0]) throw new Error("usage: dispatcher.ts event <name> [--input JSON] [--id ID]");
      const at = rest.indexOf("--input"), idAt = rest.indexOf("--id");
      out({ ok: true, id: emitEvent(rest[0], at >= 0 ? JSON.parse(rest[at + 1]) : undefined, idAt >= 0 ? rest[idAt + 1] : undefined) });
      return 0;
    }
    case "heartbeat-check": {
      const event = checkHeartbeat();
      out({ ok: event === null, raised: event?.dedup_key ?? null });
      return event === null ? 0 : 1;
    }
    default:
      console.error("usage: dispatcher.ts serve | fire <name> | tick | event <name> [--input JSON] | heartbeat-check");
      return 2;
  }
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
