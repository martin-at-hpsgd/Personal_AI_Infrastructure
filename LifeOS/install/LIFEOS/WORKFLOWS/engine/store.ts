/**
 * The per-run payload store and the definition snapshots.
 *
 * The ledger holds identity, status and digests, never a value (ISC-43). The
 * values a step received and returned go here instead, one JSON file per step
 * under `<root>/<run_id>/<step>.json`, and only for the data classes the
 * store accepts: `public` and `internal`. `confidential` and `restricted`
 * runs leave nothing behind. Directories older than the retention window
 * (14 days by default) are pruned. The page's Activity tab reads this store.
 *
 * Definition snapshots keep the exact bytes of the definition a run used,
 * under their sha256, so `show-run` can print what ran after the file changed.
 *
 * Every write asserts its invariants, resolves its target with realpathSync
 * before the boundary check, and goes through a temp file and a rename.
 */
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, sep } from "node:path";
import { invariant } from "../../TOOLS/Invariant.ts";
import { DATA_CLASSES, type DataClass } from "./format.ts";
import { ensureInside, readLedger, writeFileAtomic, type LedgerRecord } from "./ledger.ts";

/** The only data classes whose step values may be stored. */
export const STORABLE_CLASSES: readonly DataClass[] = ["public", "internal"];
export const DEFAULT_RETENTION_DAYS = 14;
const DAY_MS = 86_400_000;
const RUN_ID_RE = /^[A-Za-z0-9-]{8,}$/;
const STEP_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export interface StepValues {
  input?: unknown;
  output?: unknown;
  /** Tail of a failed command step's stderr in an unattended run (ISC-282); never written to the ledger. */
  stderr?: string;
}

export interface StoreResult {
  stored: boolean;
  reason?: string;
  path?: string;
}

/** The file name a step id is stored under: the id itself when it is a plain name, otherwise a hash of it. */
export function stepKey(stepId: string): string {
  return STEP_ID_RE.test(stepId) ? stepId : `x-${createHash("sha256").update(stepId).digest("hex").slice(0, 24)}`;
}

export function isStorable(dataClass: string): boolean {
  return (STORABLE_CLASSES as readonly string[]).includes(dataClass);
}

/** The one place a value file is written; refuses anything but a storable class even when called directly. */
function writeStepFile(root: string, runId: string, stepId: string, dataClass: DataClass, values: StepValues): string {
  invariant((DATA_CLASSES as readonly string[]).includes(dataClass), `Unknown data class "${dataClass}"`);
  invariant(isStorable(dataClass), `Step values are never stored for the "${dataClass}" data class`);
  invariant(RUN_ID_RE.test(runId), `Run id "${runId}" is not a store key`);
  invariant(stepId.length > 0, "A stored step needs an id");
  const dir = join(root, runId);
  const path = join(dir, `${stepKey(stepId)}.json`);
  ensureInside(root, dir, "Artifact store");
  mkdirSync(dir, { recursive: true });
  invariant(realpathSync(dir).startsWith(realpathSync(root) + sep), `Artifact directory resolves outside the store: ${dir}`);
  ensureInside(dir, path, "Artifact store run directory");
  invariant(values.stderr === undefined || typeof values.stderr === "string", "A stored stderr tail must be text");
  const text = JSON.stringify({ schema: 1, run_id: runId, step: stepId, data_class: dataClass, input: values.input ?? null, output: values.output ?? null, ...(values.stderr ? { stderr: values.stderr } : {}) });
  invariant(text !== undefined, "Step values could not be serialized");
  writeFileAtomic(path, text);
  return path;
}

/** Stores one step's input and output for a run, when its data class allows it. */
export function storeStepValues(root: string, runId: string, stepId: string, dataClass: DataClass, values: StepValues): StoreResult {
  if (!isStorable(dataClass)) return { stored: false, reason: `data class "${dataClass}" is never stored` };
  return { stored: true, path: writeStepFile(root, runId, stepId, dataClass, values) };
}

export function readStepValues(root: string, runId: string, stepId: string): (StepValues & { data_class: DataClass }) | null {
  if (!RUN_ID_RE.test(runId) || stepId.length === 0) return null;
  const path = join(root, runId, `${stepKey(stepId)}.json`);
  if (!existsSync(path)) return null;
  const real = realpathSync(root);
  const target = realpathSync(path);
  if (!target.startsWith(real + sep)) return null;
  const parsed = JSON.parse(readFileSync(target, "utf8"));
  return { input: parsed.input, output: parsed.output, data_class: parsed.data_class, ...(typeof parsed.stderr === "string" ? { stderr: parsed.stderr } : {}) };
}

/**
 * Removes run directories whose newest change is older than the window. Symlinks
 * are never followed or removed through; a directory that resolves outside the
 * store is left alone. Returns the run ids removed.
 */
export function pruneStore(root: string, now: number = Date.now(), retentionDays: number = DEFAULT_RETENTION_DAYS): string[] {
  invariant(Number.isFinite(retentionDays) && retentionDays > 0, "Retention must be a positive number of days");
  if (!existsSync(root)) return [];
  const real = realpathSync(root);
  const removed: string[] = [];
  for (const name of readdirSync(root)) {
    if (!RUN_ID_RE.test(name)) continue;
    const path = join(root, name);
    const info = lstatSync(path);
    if (info.isSymbolicLink() || !info.isDirectory()) continue;
    const target = realpathSync(path);
    if (!target.startsWith(real + sep)) continue;
    if (now - statSync(target).mtimeMs <= retentionDays * DAY_MS) continue;
    rmSync(target, { recursive: true, force: true });
    removed.push(name);
  }
  return removed;
}

/* ── Definition snapshots ───────────────────────────────────────────────── */

const HASH_RE = /^[0-9a-f]{64}$/;

export function snapshotFile(root: string, hash: string): string {
  invariant(HASH_RE.test(hash), `"${hash}" is not a sha256 definition hash`);
  return join(root, `${hash}.workflow.yaml`);
}

/** Keeps the definition bytes under their hash. Idempotent; refuses text that does not hash to `hash`. */
export function saveDefinitionSnapshot(root: string, hash: string, text: string): string {
  const path = snapshotFile(root, hash);
  invariant(createHash("sha256").update(text).digest("hex") === hash, "Definition snapshot text does not match its hash");
  ensureInside(root, path, "Definition snapshot");
  if (!existsSync(path)) writeFileAtomic(path, text);
  return path;
}

export function readDefinitionSnapshot(root: string, hash: string): string | null {
  if (!HASH_RE.test(hash)) return null;
  const path = snapshotFile(root, hash);
  if (!existsSync(path)) return null;
  const text = readFileSync(path, "utf8");
  return createHash("sha256").update(text).digest("hex") === hash ? text : null;
}

export interface ShownRun {
  record: LedgerRecord;
  definition: string | null;
}

/**
 * What `workflow show-run <run-id>` prints: the ledger line and the exact
 * definition bytes that ran, from the snapshot, not from the file that may
 * have changed since. `definition` is null when the snapshot is gone.
 */
export function showRun(ledger: string, snapshots: string, runId: string): ShownRun | null {
  const record = readLedger(ledger).records.find(r => r.run_id === runId);
  if (!record) return null;
  return { record, definition: readDefinitionSnapshot(snapshots, record.definition_hash) };
}
