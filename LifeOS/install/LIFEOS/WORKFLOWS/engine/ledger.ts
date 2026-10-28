/**
 * The run ledger: one JSONL line per run, appended once when the run ends.
 *
 * A line carries identity and status only — run id, workflow, definition hash,
 * trigger, occurrence key, data class, per-step status and timing, and sha256
 * digests of outputs. It never carries an input or output value: payloads go
 * to the per-run store (store.ts) for the data classes allowed there, and the
 * ledger can be read by the inventory, the page and Vigil without becoming a
 * second copy of the data.
 *
 * Dedup: an occurrence (workflow + occurrence key) runs at most once. Before
 * any step runs, the runner refuses a key already in the ledger, then claims
 * the key with an exclusive-create marker file so two processes racing on the
 * same occurrence cannot both start. Once the run's ledger line is written the
 * line is the dedup record, so `appendRecord` removes the marker: finished
 * markers would otherwise pile up and every claim reader would pay for them. A
 * failed occurrence is retried under a new key, never silently re-run. The
 * marker carries the run's deadline, so a run that died before writing its line
 * still holds its marker, which names the run and its deadline.
 *
 * Writes: a ledger line is one O_APPEND write (atomic for a single short line;
 * rewriting a multi-million-line file through temp+rename on every run would
 * be neither cheap nor race-free). Every other file this module writes (the
 * evidence index) goes through temp file + rename.
 *
 * RES dual-write (CENSVS ISA F9, ISC-43): each run is also a `run:<id>` RES in
 * the STATVS record, written through LIFEOS/CENSVS/res.ts beside the ledger. A
 * successful claim creates it in state `running` with parent `workflow:<name>`;
 * the ledger line sets its step summary (`data.steps`, step id → status) and
 * moves it to the run's status, or creates it there when no start row exists
 * (a run pulled from the cloud). Only the live ledger dual-writes, unless
 * LIFEOS_RUN_RES=1; LIFEOS_RUN_RES=0 turns it off. The ledger line is written
 * first and a RES failure is reported on stderr, never thrown, so the record
 * can never fail a run.
 */
import { appendFileSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join, resolve, sep } from "node:path";
import { invariant } from "../../TOOLS/Invariant.ts";
import { DATA_CLASSES, type DataClass, type TriggerV2 } from "./format.ts";

export const LEDGER_SCHEMA = 1;
/** The ledger is read from its tail; older lines stay on disk but are not scanned. */
const MAX_READ_BYTES = 16 * 1024 * 1024;

export type StepStatus = "succeeded" | "failed" | "skipped";
export const STEP_STATUSES: readonly StepStatus[] = ["succeeded", "failed", "skipped"];
export type RunStatus = "succeeded" | "failed" | "abandoned" | "timed_out" | "stopped" | "dropped";
export const RUN_STATUSES: readonly RunStatus[] = ["succeeded", "failed", "abandoned", "timed_out", "stopped", "dropped"];
/** Every key a ledger step may carry: identity, status, timing, digest, error, model cost. Never a value. */
export const LEDGER_STEP_KEYS: readonly string[] = ["status", "attempts", "started_at", "duration_ms", "output_digest", "error", "error_digest", "timed_out", "lane", "model", "tier", "tokens_in", "tokens_out", "cost_usd"];

export interface LedgerStep {
  status: StepStatus;
  attempts: number;
  /** When the step's first attempt began (ISO); null for a step that never ran. */
  started_at?: string | null;
  /** Milliseconds from the first attempt's start to the last attempt's end; 0 for a step that never ran. */
  duration_ms?: number;
  /** sha256 of the step's canonical JSON output, when it produced one. */
  output_digest?: string;
  /** One line, at most 300 characters; never an output value. */
  error?: string;
  /** Hex prefix of the sha256 of the raw error message, for a record whose `error` is a category only (the embedded runner). */
  error_digest?: string;
  timed_out?: boolean;
  /** Model spend, on the step that incurred it (ISC-128). Set for model, agent and metered steps only. */
  lane?: string;
  model?: string;
  tier?: string;
  tokens_in?: number;
  tokens_out?: number;
  cost_usd?: number;
}

export interface LedgerRecord {
  schema: typeof LEDGER_SCHEMA;
  run_id: string;
  workflow: string;
  definition_path: string;
  definition_hash: string;
  trigger: TriggerV2["type"];
  occurrence_key: string;
  data_class: DataClass;
  runs_on: "local";
  started_at: string;
  finished_at: string;
  status: RunStatus;
  steps: Record<string, LedgerStep>;
  /** sha256 of the run's canonical JSON output; null when the run produced none. */
  output_digest: string | null;
  error?: string;
}

/** JSON with object keys sorted, so equal values always hash equal. */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.keys(value as Record<string, unknown>).sort()
    .filter(k => (value as Record<string, unknown>)[k] !== undefined)
    .map(k => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`);
  return `{${entries.join(",")}}`;
}

export function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

/** Reads every well-formed record from the ledger's tail. Malformed lines are counted, not thrown. */
export function readLedger(path: string): { records: LedgerRecord[]; malformed: number } {
  if (!existsSync(path)) return { records: [], malformed: 0 };
  const size = statSync(path).size;
  const start = Math.max(0, size - MAX_READ_BYTES);
  const buffer = Buffer.alloc(size - start);
  const fd = openSync(path, "r");
  try {
    readSync(fd, buffer, 0, buffer.length, start);
  } finally {
    closeSync(fd);
  }
  let content = buffer.toString("utf8");
  if (start > 0) content = content.slice(content.indexOf("\n") + 1);
  const records: LedgerRecord[] = [];
  let malformed = 0;
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as LedgerRecord;
      if (parsed && typeof parsed.run_id === "string" && typeof parsed.workflow === "string" && typeof parsed.occurrence_key === "string") records.push(parsed);
      else malformed++;
    } catch {
      malformed++;
    }
  }
  return { records, malformed };
}

export interface LedgerSlice {
  records: LedgerRecord[];
  /** Byte offset just past the last complete line read; pass it back as `from` to read only what was appended since. */
  end: number;
}

/**
 * Complete ledger lines from byte `from` (a line start a previous slice
 * returned) to the end of the last complete line. Without `from`, or when the
 * file is now shorter than `from` (it was replaced), it reads the same tail
 * `readLedger` reads. A line still being written is left for the next slice.
 */
export function readLedgerSlice(path: string, from?: number): LedgerSlice {
  if (!existsSync(path)) return { records: [], end: 0 };
  const size = statSync(path).size;
  const fresh = from === undefined || from > size;
  const start = fresh ? Math.max(0, size - MAX_READ_BYTES) : from;
  if (start >= size) return { records: [], end: start };
  const buffer = Buffer.alloc(size - start);
  const fd = openSync(path, "r");
  try {
    readSync(fd, buffer, 0, buffer.length, start);
  } finally {
    closeSync(fd);
  }
  const head = fresh && start > 0 ? buffer.indexOf(10) + 1 : 0;
  const last = buffer.lastIndexOf(10);
  if (head <= 0 && fresh && start > 0) return { records: [], end: start };
  if (last < head) return { records: [], end: start + head };
  const records: LedgerRecord[] = [];
  for (const line of buffer.subarray(head, last + 1).toString("utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as LedgerRecord;
      if (parsed && typeof parsed.run_id === "string" && typeof parsed.workflow === "string" && typeof parsed.occurrence_key === "string") records.push(parsed);
    } catch {
      /* a malformed line names no record; readLedger counts these */
    }
  }
  return { records, end: start + last + 1 };
}

export function hasOccurrence(path: string, workflow: string, occurrenceKey: string): boolean {
  return readLedger(path).records.some(r => r.workflow === workflow && r.occurrence_key === occurrenceKey);
}

/** Resolves a directory through symlinks and confirms `child` sits inside it (the write guard). */
export function ensureInside(dir: string, child: string, label: string): void {
  mkdirSync(dir, { recursive: true });
  const real = realpathSync(dir);
  const parent = realpathSync(dirname(child));
  invariant(parent === real || parent.startsWith(real + sep), `${label} escapes its directory: ${child}`);
}

/**
 * Writes `text` to `path` through a temp file in the same directory and a rename, so a crash never leaves half a file.
 * `mode` sets the file's permission bits from creation, so a private file is never briefly world-readable.
 */
export function writeFileAtomic(path: string, text: string | Uint8Array, mode?: number): void {
  const tmp = join(dirname(path), `.${randomUUID()}.tmp`);
  try {
    writeFileSync(tmp, text, mode === undefined ? undefined : { mode });
    renameSync(tmp, path);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      /* the temp file may never have been created */
    }
    throw error;
  }
}

/** The directory of occurrence claim markers beside a ledger. */
export function claimsDir(ledger: string): string {
  return join(dirname(ledger), "claims");
}

function claimPath(ledger: string, workflow: string, occurrenceKey: string): string {
  const id = createHash("sha256").update(`${workflow}\0${occurrenceKey}`).digest("hex").slice(0, 40);
  return join(claimsDir(ledger), `${id}.claim`);
}

/** What a claim remembers so a run that died can still be closed: enough to write a valid ledger line. */
export interface ClaimMeta {
  /** ISO time after which a run with no ledger line is treated as dead. */
  deadline_at?: string;
  definition_path?: string;
  definition_hash?: string;
  data_class?: DataClass;
  started_at?: string;
  steps?: string[];
  /** The runner's process id, so `workflow stop` can tell a live run from a dead one. */
  pid?: number;
  /** How the run started, so a run closed from its claim keeps its real trigger. */
  trigger?: string;
}

export interface Claim extends ClaimMeta {
  workflow: string;
  occurrence_key: string;
  run_id: string;
  at: string;
}

/**
 * Claims one occurrence before any step runs. Returns false when the ledger
 * already holds it or another process claimed it first; nothing is written then.
 */
export function claimOccurrence(ledger: string, workflow: string, occurrenceKey: string, runId: string, meta: ClaimMeta = {}): boolean {
  invariant(workflow.length > 0 && occurrenceKey.length > 0 && runId.length > 0, "An occurrence claim needs a workflow, a key and a run id");
  invariant(meta.deadline_at === undefined || Number.isFinite(Date.parse(meta.deadline_at)), "A claim deadline must be a timestamp");
  if (hasOccurrence(ledger, workflow, occurrenceKey)) return false;
  const path = claimPath(ledger, workflow, occurrenceKey);
  ensureInside(join(dirname(ledger), "claims"), path, "Occurrence claim");
  let fd: number;
  try {
    fd = openSync(path, "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
  try {
    const claim: Claim = { workflow, occurrence_key: occurrenceKey, run_id: runId, at: new Date().toISOString(), ...meta };
    writeSync(fd, `${JSON.stringify(claim)}\n`);
  } finally {
    closeSync(fd);
  }
  recordRunStart(ledger, workflow, runId, meta);
  return true;
}

/** The marker `workflow stop` writes and the runner polls: `claims/<run_id>.stop` beside the ledger. */
export function stopMarkerPath(ledger: string, runId: string): string {
  invariant(/^[A-Za-z0-9-]{8,}$/.test(runId), `"${runId}" is not a run id`);
  return join(dirname(ledger), "claims", `${runId}.stop`);
}

/** One claim marker, or null when it is missing, half-written or not a claim. */
export function parseClaimFile(path: string): Claim | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Claim;
    return parsed && typeof parsed.workflow === "string" && typeof parsed.occurrence_key === "string" && typeof parsed.run_id === "string" ? parsed : null;
  } catch {
    return null; // gone since the listing, or a half-written marker that is not a claim yet
  }
}

/**
 * The claim markers beside a ledger, re-read by name. A marker is written once
 * and never rewritten, so a parse taken before the queue lock still holds
 * inside it: `read` lists the directory and opens only markers it has not
 * parsed yet, and forgets markers that are gone. Keep one view for one short
 * decision; a marker removed and re-created under the same name inside that
 * window would keep its first parse.
 */
export class ClaimView {
  private readonly parsed = new Map<string, Claim>();

  constructor(private readonly ledger: string) {}

  read(): Claim[] {
    const dir = claimsDir(this.ledger);
    if (!existsSync(dir)) {
      this.parsed.clear();
      return [];
    }
    const names = new Set(readdirSync(dir).filter(f => f.endsWith(".claim")));
    for (const name of [...this.parsed.keys()]) if (!names.has(name)) this.parsed.delete(name);
    for (const name of names) {
      if (this.parsed.has(name)) continue;
      const claim = parseClaimFile(join(dir, name));
      if (claim) this.parsed.set(name, claim);
    }
    return [...this.parsed.values()];
  }
}

/** Every claim marker beside a ledger; unreadable markers are skipped. */
export function readClaims(ledger: string): Claim[] {
  return new ClaimView(ledger).read();
}

/**
 * Removes an occurrence's claim marker once `runId`'s ledger line is written.
 * A marker held by another run is left alone. A marker that cannot be removed
 * is reported and left: it is inert beside its ledger line.
 */
function releaseClaim(ledger: string, workflow: string, occurrenceKey: string, runId: string): void {
  const path = claimPath(ledger, workflow, occurrenceKey);
  const claim = parseClaimFile(path);
  if (!claim || claim.run_id !== runId) return;
  invariant(claim.workflow === workflow && claim.occurrence_key === occurrenceKey, `Claim marker ${path} names another occurrence`);
  try {
    rmSync(path, { force: true });
  } catch (error) {
    console.error(`workflows: could not remove the claim for ${workflow} ${occurrenceKey} after its ledger line: ${(error as Error).message}`);
  }
}

/**
 * Every `workflow\0occurrence_key` in the whole ledger, read in chunks. `readLedger`
 * reads only the tail; this is for the one-off claim sweep, which must see
 * occurrences older than the tail too.
 */
export function everyLedgerOccurrence(path: string): Set<string> {
  const out = new Set<string>();
  if (!existsSync(path)) return out;
  const size = statSync(path).size;
  const fd = openSync(path, "r");
  try {
    let carry = "";
    for (let pos = 0; pos < size; pos += OCCURRENCE_CHUNK_BYTES) {
      const buffer = Buffer.alloc(Math.min(OCCURRENCE_CHUNK_BYTES, size - pos));
      readSync(fd, buffer, 0, buffer.length, pos);
      const lines = (carry + buffer.toString("utf8")).split("\n");
      carry = lines.pop() ?? "";
      for (const line of lines) addOccurrence(out, line);
    }
    addOccurrence(out, carry);
  } finally {
    closeSync(fd);
  }
  return out;
}

const OCCURRENCE_CHUNK_BYTES = 16 * 1024 * 1024;

function addOccurrence(out: Set<string>, line: string): void {
  if (!line.trim()) return;
  try {
    const r = JSON.parse(line) as Partial<LedgerRecord>;
    if (typeof r.workflow === "string" && typeof r.occurrence_key === "string") out.add(`${r.workflow}\0${r.occurrence_key}`);
  } catch {
    /* a malformed line names no occurrence */
  }
}

export function assertRecord(record: LedgerRecord): void {
  invariant(record !== null && typeof record === "object", "Ledger record must be an object");
  invariant(record.schema === LEDGER_SCHEMA, "Ledger record schema version is wrong");
  invariant(typeof record.run_id === "string" && /^[A-Za-z0-9-]{8,}$/.test(record.run_id), "Ledger record needs a run id");
  invariant(typeof record.workflow === "string" && record.workflow.length > 0, "Ledger record needs a workflow");
  invariant(typeof record.occurrence_key === "string" && record.occurrence_key.length > 0, "Ledger record needs an occurrence key");
  invariant(typeof record.definition_hash === "string" && /^[0-9a-f]{64}$/.test(record.definition_hash), "Ledger record needs a sha256 definition hash");
  invariant((DATA_CLASSES as readonly string[]).includes(record.data_class), "Ledger record data_class is unknown");
  invariant((RUN_STATUSES as readonly string[]).includes(record.status), "Ledger record status is unknown");
  invariant(record.output_digest === null || (typeof record.output_digest === "string" && /^sha256:[0-9a-f]{64}$/.test(record.output_digest)), "Ledger output digest is malformed");
  invariant(record.steps !== null && typeof record.steps === "object" && Object.keys(record.steps).length > 0, "Ledger record has no steps");
  for (const [id, step] of Object.entries(record.steps)) {
    invariant(step !== null && typeof step === "object", `Ledger step "${id}" must be an object`);
    invariant((STEP_STATUSES as readonly string[]).includes(step.status), `Ledger step "${id}" status is unknown`);
    invariant(Number.isInteger(step.attempts) && step.attempts >= 0, `Ledger step "${id}" attempts must be a non-negative integer`);
    invariant(!Object.hasOwn(step, "output") && !Object.hasOwn(step, "input"), `Ledger step "${id}" must carry a digest, never an input or output value`);
    for (const key of Object.keys(step)) invariant(LEDGER_STEP_KEYS.includes(key), `Ledger step "${id}" carries an unknown field "${key}"; step fields are digest-only`);
    invariant(step.output_digest === undefined || /^sha256:[0-9a-f]{64}$/.test(step.output_digest), `Ledger step "${id}" output digest is malformed`);
    invariant(step.error_digest === undefined || /^[0-9a-f]{16,64}$/.test(step.error_digest), `Ledger step "${id}" error digest is malformed`);
    invariant(step.started_at === undefined || step.started_at === null || Number.isFinite(Date.parse(step.started_at)), `Ledger step "${id}" started_at is not a timestamp`);
    invariant(step.duration_ms === undefined || (Number.isFinite(step.duration_ms) && step.duration_ms >= 0), `Ledger step "${id}" duration_ms must be a non-negative number`);
    for (const key of ["tokens_in", "tokens_out", "cost_usd"] as const) {
      invariant(step[key] === undefined || (Number.isFinite(step[key]) && (step[key] as number) >= 0), `Ledger step "${id}" ${key} must be a non-negative number`);
    }
  }
  invariant(!Object.hasOwn(record, "output"), "Ledger record must carry a digest, never an output value");
}

/** Appends exactly one line for one finished run. A malformed record throws before anything is written. */
export function appendRecord(ledger: string, record: LedgerRecord): void {
  invariant(ledger.endsWith(".jsonl"), `Ledger path must be a .jsonl file: ${ledger}`);
  assertRecord(record);
  ensureInside(dirname(ledger), ledger, "Ledger");
  if (existsSync(ledger) && lstatSync(ledger).isSymbolicLink()) {
    const real = realpathSync(dirname(ledger));
    invariant(realpathSync(ledger).startsWith(real + sep), `Ledger file is a symlink that leaves its directory: ${ledger}`);
  }
  const line = `${JSON.stringify(record)}\n`;
  invariant(!line.slice(0, -1).includes("\n"), "Ledger line must be one line");
  appendFileSync(ledger, line);
  // Only after the line is on disk: a claim reader that misses the marker then finds the line.
  releaseClaim(ledger, record.workflow, record.occurrence_key, record.run_id);
  recordRunEnd(ledger, record);
}

/* ── RES dual-write (CENSVS ISA F9, ISC-43) ─────────────────────────────── */

/** The writer every run RES row carries. */
export const RUN_RES_WRITER = "tool:workflows";
const RUN_KEY_RE = /^[A-Za-z0-9-]{8,}$/;
const DEFAULT_LEDGER = join(resolve(import.meta.dir, "..", ".."), "MEMORY", "STATE", "workflows", "runs.jsonl");

type ResModule = typeof import("../../CENSVS/res.ts");
type GeneraModule = typeof import("../../CENSVS/genera.ts");
let resModules: { res: ResModule; genera: GeneraModule } | null = null;
/** Loaded on first use, so a ledger reader never pays for the record (and no import cycle runs through here). */
function resLib(): { res: ResModule; genera: GeneraModule } {
  resModules ??= { res: require("../../CENSVS/res.ts") as ResModule, genera: require("../../CENSVS/genera.ts") as GeneraModule };
  return resModules;
}

/**
 * The RES id of a run: `run:<run id>`, or `run:h<16 hex of sha256(run id)>` for the rare
 * run id the subject rules read as personal (six digits, a dash and four digits look like a
 * phone number). Deterministic, so the run slice computes the same id from the ledger.
 */
export function runResId(runId: string): string {
  invariant(typeof runId === "string" && RUN_KEY_RE.test(runId), `"${runId}" is not a run id`);
  const plain = `run:${runId}`;
  if (resLib().genera.validSubject(plain) === null) return plain;
  return `run:h${createHash("sha256").update(runId).digest("hex").slice(0, 16)}`;
}

/** `workflow:<name>`, or null when the name cannot be a subject. */
function workflowResId(workflow: string): string | null {
  const id = `workflow:${workflow}`;
  return resLib().genera.validSubject(id) === null ? id : null;
}

/** The live ledger dual-writes; any other ledger only with LIFEOS_RUN_RES=1. LIFEOS_RUN_RES=0 turns both off. */
function runResEnabled(ledger: string): boolean {
  const gate = process.env.LIFEOS_RUN_RES;
  if (gate === "0") return false;
  if (gate === "1") return true;
  return resolve(ledger) === DEFAULT_LEDGER;
}

/** Step id → status: the step summary a run RES carries. Never a value or digest. */
function stepSummary(steps: Record<string, LedgerStep>): Record<string, StepStatus> {
  return Object.fromEntries(Object.entries(steps).map(([id, s]) => [id, s.status]));
}

function reportRes(what: string, detail: string): void {
  console.error(`workflows: run RES ${what}: ${detail}`);
}

/** Runs one RES write; a refusal or a throw (an InvariantViolation included) is reported, never raised. */
function guarded(what: string, fn: () => { ok: boolean; refused?: string; reason?: string } | void): void {
  try {
    const r = fn();
    // A spooled write is not a failure: the record drains it on its next append.
    if (r && !r.ok && !("spooled" in r)) reportRes(what, r.refused ?? r.reason ?? "refused");
  } catch (error) {
    reportRes(what, `${(error as Error)?.name ?? "Error"}: ${(error as Error)?.message ?? String(error)}`);
  }
}

function recordRunStart(ledger: string, workflow: string, runId: string, meta: ClaimMeta): void {
  if (!runResEnabled(ledger)) return;
  guarded("start", () => {
    const { res } = resLib();
    const id = runResId(runId);
    const parent = workflowResId(workflow);
    const data: Record<string, unknown> = { run_id: runId };
    if (meta.trigger) data.trigger = meta.trigger;
    if (meta.definition_hash) data.definition_hash = meta.definition_hash;
    if (meta.started_at) data.started_at = meta.started_at;
    return res.create(id, { title: `${workflow} run`, state: "running", ...(parent ? { parent } : {}), data }, { writer: RUN_RES_WRITER });
  });
}

function recordRunEnd(ledger: string, record: LedgerRecord): void {
  if (!runResEnabled(ledger)) return;
  guarded("end", () => {
    const { res, genera } = resLib();
    const id = runResId(record.run_id);
    const parent = workflowResId(record.workflow);
    const data = {
      run_id: record.run_id,
      trigger: record.trigger,
      definition_hash: record.definition_hash,
      started_at: record.started_at,
      finished_at: record.finished_at,
      steps: stepSummary(record.steps),
    };
    // Every ledger status is a run state in GENERA; a status added to one and not the other is a bug.
    invariant(genera.canonicalState("run", record.status) === record.status, `run status ${record.status} is not a GENERA run state`);
    const opts = { writer: RUN_RES_WRITER };
    let known = res.recordFold().res[id];
    if (!known) {
      const created = res.create(id, { title: `${record.workflow} run`, state: record.status, ...(parent ? { parent } : {}), data }, opts);
      if (created.ok || "spooled" in created) return created;
      // A start row that was spooled lands when this append drains the spool, and wins; close that RES instead.
      known = res.recordFold().res[id];
      if (!known) return created;
    }
    // Set before move: a move to `dropped` retires the RES, and a retired RES takes no set.
    if (!known.state || genera.bucketOf("run", known.state) !== "gone") {
      const set = res.set(id, { data }, opts);
      if (!set.ok && !("spooled" in set)) reportRes("end", set.refused);
    }
    if (known.state === record.status) return;
    return res.move(id, record.status, opts);
  });
}

/* ── Evidence at scale (ISC-84) ─────────────────────────────────────────── */

export interface WorkflowEvidence {
  runs: number;
  last_finished_at: string;
  last_status: RunStatus;
}

interface EvidenceIndex {
  version: 1;
  /** Ledger bytes this index covers; always the end of a complete line. */
  bytes: number;
  malformed: number;
  by: Record<string, WorkflowEvidence>;
}

const INDEX_CHUNK_BYTES = 64 * 1024 * 1024;
const NEEDLE_WORKFLOW = Buffer.from('"workflow":"');
const NEEDLE_FINISHED = Buffer.from('"finished_at":"');
const STATUS_TAIL = Buffer.from(',"status":"');

/** The quoted value that starts at `valueStart`, or null when it has an escape or no closing quote before `to`. */
function valueAt(buf: Buffer, valueStart: number, to: number): { value: string; end: number } | null {
  const close = buf.indexOf(0x22, valueStart);
  if (close < 0 || close > to) return null;
  const value = buf.latin1Slice(valueStart, close);
  return value.includes("\\") ? null : { value, end: close + 1 };
}

function foldLine(index: EvidenceIndex, buf: Buffer, from: number, to: number): void {
  let workflow: string | null = null;
  let finished: string | null = null;
  let status: string | null = null;
  // Fast path for the exact shape appendRecord writes (workflow ... finished_at, status, steps);
  // any line that does not match it byte for byte falls through to a real parse.
  const w = buf.indexOf(NEEDLE_WORKFLOW, from);
  const f = buf.indexOf(NEEDLE_FINISHED, from);
  if (w >= from && w < to && f > w && f < to) {
    const wv = valueAt(buf, w + NEEDLE_WORKFLOW.length, to);
    const fv = valueAt(buf, f + NEEDLE_FINISHED.length, to);
    if (wv && fv && buf.compare(STATUS_TAIL, 0, STATUS_TAIL.length, fv.end, fv.end + STATUS_TAIL.length) === 0) {
      const sv = valueAt(buf, fv.end + STATUS_TAIL.length, to);
      if (sv && (RUN_STATUSES as readonly string[]).includes(sv.value)) {
        workflow = wv.value;
        finished = fv.value;
        status = sv.value;
      }
    }
  }
  if (workflow === null || finished === null || status === null) {
    try {
      const parsed = JSON.parse(buf.toString("utf8", from, to)) as Partial<LedgerRecord>;
      if (typeof parsed.workflow !== "string" || typeof parsed.finished_at !== "string" || typeof parsed.status !== "string") throw new Error("not a record");
      workflow = parsed.workflow;
      finished = parsed.finished_at;
      status = parsed.status;
    } catch {
      index.malformed++;
      return;
    }
  }
  if (workflow === "__proto__") return;
  const seen = Object.hasOwn(index.by, workflow) ? index.by[workflow] : undefined;
  if (!seen) index.by[workflow] = { runs: 1, last_finished_at: finished, last_status: status as RunStatus };
  else {
    seen.runs++;
    if (finished >= seen.last_finished_at) {
      seen.last_finished_at = finished;
      seen.last_status = status as RunStatus;
    }
  }
}

/** Folds the whole lines of `[offset, end)` into `index`; returns the new offset (end of the last complete line). */
function foldRange(path: string, index: EvidenceIndex, offset: number, end: number): number {
  const fd = openSync(path, "r");
  try {
    let position = offset;
    let carry: Buffer = Buffer.alloc(0);
    while (position < end) {
      const size = Math.min(INDEX_CHUNK_BYTES, end - position);
      const chunk = Buffer.alloc(size);
      readSync(fd, chunk, 0, size, position);
      position += size;
      const buf = carry.length ? Buffer.concat([carry, chunk]) : chunk;
      let lineStart = 0;
      for (let nl = buf.indexOf(0x0a, lineStart); nl >= 0; nl = buf.indexOf(0x0a, lineStart)) {
        if (nl > lineStart) foldLine(index, buf, lineStart, nl);
        lineStart = nl + 1;
      }
      carry = Buffer.from(buf.subarray(lineStart));
      if (position >= end) return position - carry.length;
    }
    return offset;
  } finally {
    closeSync(fd);
  }
}

export function evidenceIndexPath(ledger: string): string {
  return `${ledger}.index.json`;
}

/**
 * Per-workflow run count, last finish time and last status over the WHOLE
 * ledger, however long. An index beside the ledger remembers how far it has
 * read, so each call scans only the lines appended since the last call; with no
 * index (or a ledger that shrank) it scans everything once and writes one.
 * Read-only with respect to the ledger.
 */
export function ledgerEvidence(ledger: string): { by: Map<string, WorkflowEvidence>; malformed: number } {
  if (!existsSync(ledger)) return { by: new Map(), malformed: 0 };
  const size = statSync(ledger).size;
  const indexPath = evidenceIndexPath(ledger);
  let index: EvidenceIndex = { version: 1, bytes: 0, malformed: 0, by: {} };
  if (existsSync(indexPath)) {
    try {
      const saved = JSON.parse(readFileSync(indexPath, "utf8")) as EvidenceIndex;
      if (saved.version === 1 && Number.isInteger(saved.bytes) && saved.bytes >= 0 && saved.bytes <= size && saved.by && typeof saved.by === "object") index = saved;
    } catch {
      /* a damaged index is rebuilt from the ledger */
    }
  }
  if (index.bytes < size) {
    index.bytes = foldRange(ledger, index, index.bytes, size);
    invariant(index.bytes <= size && index.bytes >= 0, "Evidence index offset left the ledger");
    try {
      writeFileAtomic(indexPath, JSON.stringify(index));
    } catch {
      /* the index is a cache; a read-only directory just means the next call rescans */
    }
  }
  return { by: new Map(Object.entries(index.by)), malformed: index.malformed };
}
