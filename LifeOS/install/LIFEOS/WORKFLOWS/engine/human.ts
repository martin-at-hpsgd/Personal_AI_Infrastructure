/**
 * Durable human steps (ISC-31 core, ISC-131). A run that reaches a `human`
 * step with no answer parks: the steps that finished, their outputs and the
 * run's identity go to one state file on disk, and no ledger line is written.
 * An answer is a file too, so a run waiting across a machine restart resumes
 * from disk alone, and resume replays finished steps from the saved outputs
 * instead of running them again.
 *
 * Layout, beside the ledger:
 *   waiting/<run_id>.json              the parked run (0600)
 *   waiting/<run_id>.resuming          the one resume in flight ({pid}, 0600)
 *   answers/<run_id>/<step_id>.json    {approved, note, answered_at} (0600)
 */
import { closeSync, existsSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { invariant } from "../../TOOLS/Invariant.ts";
import { ensureInside, writeFileAtomic } from "./ledger.ts";
import { ledgerPath } from "./paths.ts";

export interface HumanAnswer {
  approved: boolean;
  note?: string;
}

export interface CompletedStep {
  output: unknown;
  attempts: number;
  started_at: string | null;
  duration_ms: number;
  /** A model or agent step's spend, carried so the run's one ledger line counts it after resume. */
  cost?: { lane: string; model: string; service_tier: "flex" | "default"; input_tokens: number | null; output_tokens: number | null; cost_usd: number | null };
}

export interface WaitingRun {
  schema: 1;
  run_id: string;
  workflow: string;
  definition_path: string;
  definition_hash: string;
  occurrence_key: string;
  trigger: string;
  started_at: string;
  input: unknown;
  parent_run_id?: string;
  completed: Record<string, CompletedStep>;
  waiting_on: string[];
  prompts: Record<string, string>;
  parked_at: string;
}

const RUN_ID_RE = /^[A-Za-z0-9-]{8,}$/;
const STEP_ID_RE = /^[A-Za-z_$][A-Za-z0-9_$-]*$/;

/** Thrown by a human step with no answer yet; the runner turns it into a parked run. */
export class AwaitingHuman extends Error {
  constructor(readonly stepId: string, readonly prompt: string) {
    super(`Step "${stepId}" is waiting for a human decision.`);
    this.name = "AwaitingHuman";
  }
}

export const waitingDir = (ledger: string = ledgerPath()): string => join(dirname(ledger), "waiting");
export const answersDir = (ledger: string = ledgerPath()): string => join(dirname(ledger), "answers");

function waitingFile(ledger: string, runId: string): string {
  invariant(RUN_ID_RE.test(runId), `Not a run id: ${runId}`);
  return join(waitingDir(ledger), `${runId}.json`);
}

function answerFile(ledger: string, runId: string, stepId: string): string {
  invariant(RUN_ID_RE.test(runId), `Not a run id: ${runId}`);
  invariant(STEP_ID_RE.test(stepId), `Not a step id: ${stepId}`);
  return join(answersDir(ledger), runId, `${stepId}.json`);
}

export function parkRun(ledger: string, state: WaitingRun): string {
  invariant(state.schema === 1, "A parked run needs schema 1");
  invariant(state.waiting_on.length > 0, "A parked run must be waiting on at least one human step");
  for (const id of state.waiting_on) invariant(!Object.hasOwn(state.completed, id), `Step "${id}" cannot be both waiting and completed`);
  const path = waitingFile(ledger, state.run_id);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  ensureInside(waitingDir(ledger), path, "Parked run");
  writeFileAtomic(path, JSON.stringify(state), 0o600);
  return path;
}

export function readWaiting(ledger: string, runId: string): WaitingRun | null {
  const path = waitingFile(ledger, runId);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as WaitingRun;
}

export function listWaiting(ledger: string = ledgerPath()): WaitingRun[] {
  const dir = waitingDir(ledger);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(f => f.endsWith(".json")).map(f => JSON.parse(readFileSync(join(dir, f), "utf8")) as WaitingRun);
}

export function clearWaiting(ledger: string, runId: string): void {
  const path = waitingFile(ledger, runId);
  if (existsSync(path)) unlinkSync(path);
}

/** True when a process with this pid is still running (EPERM still means it exists). */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Takes the one resume of a parked run: an exclusive marker beside its state
 * file, so a Pulse answer, a Relay tapback and the restart sweep racing on the
 * same run cannot each replay it and run a gated step twice. Returns the
 * release function, or null when another live process holds the resume. A
 * marker left by a process that died is taken over once.
 */
export function claimResume(ledger: string, runId: string): (() => void) | null {
  const path = waitingFile(ledger, runId).replace(/\.json$/, ".resuming");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  ensureInside(waitingDir(ledger), path, "Resume marker");
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd: number;
    try {
      fd = openSync(path, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let holder: number | undefined;
      try {
        holder = (JSON.parse(readFileSync(path, "utf8")) as { pid?: number }).pid;
      } catch {
        /* a marker mid-write or already released counts as held this time */
      }
      if (attempt > 0 || typeof holder !== "number" || processAlive(holder)) return null;
      try {
        unlinkSync(path);
      } catch {
        /* another resumer removed the dead marker first; the retry decides */
      }
      continue;
    }
    try {
      writeSync(fd, JSON.stringify({ pid: process.pid }));
    } finally {
      closeSync(fd);
    }
    return () => {
      if (existsSync(path)) unlinkSync(path);
    };
  }
  return null;
}

export function readAnswer(ledger: string, runId: string, stepId: string): HumanAnswer | null {
  const path = answerFile(ledger, runId, stepId);
  if (!existsSync(path)) return null;
  const parsed = JSON.parse(readFileSync(path, "utf8")) as HumanAnswer;
  invariant(typeof parsed.approved === "boolean", `Answer for ${runId}/${stepId} has no boolean approved`);
  return parsed.note === undefined ? { approved: parsed.approved } : { approved: parsed.approved, note: parsed.note };
}

/**
 * Records the principal's decision for one waiting human step (the door Pulse and
 * Relay call). Refuses a run that is not parked on that step and a second
 * answer to the same step; the answer is written atomically. Call
 * `resumeRun` (runner.ts) afterwards to continue the run.
 */
export function answerHumanStep(runId: string, stepId: string, answer: HumanAnswer, opts: { ledger?: string; now?: () => Date } = {}): string {
  const ledger = opts.ledger ?? ledgerPath();
  invariant(typeof answer?.approved === "boolean", "A human answer needs a boolean approved");
  invariant(answer.note === undefined || typeof answer.note === "string", "A human answer note must be a string");
  const waiting = readWaiting(ledger, runId);
  invariant(waiting !== null, `Run ${runId} is not waiting on a human step`);
  invariant(waiting.waiting_on.includes(stepId), `Run ${runId} is not waiting on step "${stepId}"`);
  const path = answerFile(ledger, runId, stepId);
  invariant(!existsSync(path), `Step "${stepId}" of run ${runId} is already answered`);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  ensureInside(answersDir(ledger), path, "Human answer");
  const at = (opts.now ?? (() => new Date()))().toISOString();
  // Written whole to a temp file, then hard-linked into place: link refuses an existing
  // target, so of two answers racing past the check above exactly one lands.
  const tmp = join(dirname(path), `.${randomUUID()}.tmp`);
  writeFileSync(tmp, JSON.stringify({ approved: answer.approved, ...(answer.note !== undefined ? { note: answer.note } : {}), answered_at: at }), { mode: 0o600 });
  try {
    linkSync(tmp, path);
  } catch (error) {
    invariant((error as NodeJS.ErrnoException).code !== "EEXIST", `Step "${stepId}" of run ${runId} is already answered`);
    throw error;
  } finally {
    unlinkSync(tmp);
  }
  return path;
}
