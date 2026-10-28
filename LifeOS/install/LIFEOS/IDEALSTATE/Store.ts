/**
 * Store — paths and JSON helpers for the ideal-state loop.
 *
 * The loop's own writes all land in one state directory (measurement history,
 * the latest reconcile report, the recommendations file). Reconcile and
 * recommend never write anywhere else except the Vigil outbox; ideal-state
 * files change only through `accept`, which runs on the principal's yes.
 *
 * Every read-modify-write of a state file or an ideal-state file holds the
 * shared per-file lock (TOOLS/TelosLock.ts) from the read through the write, so a
 * second writer waits instead of landing between them, and a writer that cannot
 * get its lock in time throws TelosLockTimeout having written nothing. A writer
 * that needs several files takes all their locks up front in lockOrder (sorted
 * real paths), so two such writers can never hold one lock each and wait on the
 * other.
 *
 * Overrides (tests, other installs): IDEALSTATE_STATE_DIR, IDEALSTATE_USER_DIR.
 *
 * @version 1.1.0
 *
 * 1.1.0: withLocks, lockOrder, updateState and writeFileLocked; writeState holds
 * its file's lock (review round 3).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { invariant } from "../TOOLS/Invariant";
import { lifeosPath } from "../TOOLS/Paths";
import { telosRealPath, withTelosLock, type TelosLockOptions } from "../TOOLS/TelosLock";

export type { TelosLockOptions } from "../TOOLS/TelosLock";

export function stateDir(): string {
  return process.env.IDEALSTATE_STATE_DIR ?? join(homedir(), ".local", "state", "lifeos", "ideal-state");
}
export function userDir(): string {
  return process.env.IDEALSTATE_USER_DIR ?? lifeosPath("USER");
}
export const idealDir = (): string => join(userDir(), "TELOS", "IDEAL_STATE");
export const statePath = (name: string): string => join(stateDir(), name);

export function readJson<T>(path: string, fallback: T): T {
  try { return JSON.parse(readFileSync(path, "utf8")) as T; } catch { return fallback; }
}

/**
 * The lock paths for `paths`, deduplicated by real path and sorted. Every writer
 * that holds more than one lock takes them in this order, which is what keeps two
 * multi-file writers from deadlocking. A path whose directory does not exist yet
 * has it created, because the lock file lives beside the real path.
 */
export function lockOrder(paths: string[]): string[] {
  const real = new Set<string>();
  for (const p of paths) {
    mkdirSync(dirname(p), { recursive: true });
    real.add(telosRealPath(p));
  }
  return [...real].sort();
}

/**
 * Runs `fn` holding the lock on every path in `paths`, taken in lockOrder. A lock
 * this process already holds is re-entered, never taken twice. When one lock stays
 * busy past the timeout this throws TelosLockTimeout, releases what it took, and
 * `fn` never runs.
 */
export function withLocks<T>(paths: string[], fn: () => T, opts: TelosLockOptions = {}): T {
  const order = lockOrder(paths);
  const take = (i: number): T => (i === order.length ? fn() : withTelosLock(order[i]!, () => take(i + 1), opts));
  return take(0);
}

/**
 * Atomically replaces `path` (tmp file, then rename onto its real path) while
 * holding its lock, and asserts the lock is still ours right before the rename.
 * Called inside a withLocks region it re-enters the held lock.
 */
export function writeFileLocked(path: string, content: string, opts: TelosLockOptions = {}): void {
  mkdirSync(dirname(path), { recursive: true });
  withTelosLock(path, (lock) => {
    const tmp = `${lock.file}.tmp-${process.pid}`;
    writeFileSync(tmp, content);
    invariant(lock.held(), `the lock on ${lock.file} was lost before the write`);
    renameSync(tmp, lock.file);
  }, opts);
}

/** Writes only inside the state directory, atomically, under the file's lock. */
export function writeState(name: string, value: unknown, opts: TelosLockOptions = {}): void {
  const path = statePath(name);
  invariant(path.startsWith(stateDir()), `ideal-state write stays in the state dir: ${path}`);
  invariant(value !== undefined, `ideal-state write has a value: ${name}`);
  writeFileLocked(path, JSON.stringify(value, null, 2) + "\n", opts);
}

/**
 * Read-modify-write of one state file under its lock: reads it (or `fallback`),
 * passes it to `fn`, and writes what `fn` returns. `fn` returning null writes
 * nothing. Returns the value now on disk.
 */
export function updateState<T>(name: string, fallback: T, fn: (current: T) => T | null, opts: TelosLockOptions = {}): T {
  const path = statePath(name);
  return withLocks([path], () => {
    const current = readJson<T>(path, fallback);
    const next = fn(current);
    if (next === null) return current;
    writeState(name, next, opts);
    return next;
  }, opts);
}

export function appendState(name: string, line: unknown): void {
  const path = statePath(name);
  invariant(path.startsWith(stateDir()), `ideal-state append stays in the state dir: ${path}`);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(line) + "\n");
}

export function readLines<T>(name: string): T[] {
  const path = statePath(name);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l) as T]; } catch { return []; } });
}
