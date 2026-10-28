/**
 * TelosLock — one shared per-file lock for every writer of a TELOS file.
 *
 * Why: several writers (the Pulse file editor, UpdateTelos region and entry
 * writes, TelosFreshness stamps, MigrateApprove appends, the ideal-state loop)
 * each read a TELOS file, compare or transform it, and write it back. Without
 * coordination one writer can land between another's read and write, and the
 * later write silently drops the earlier one's change. A re-hash before the
 * write only shrinks that window; it cannot close it. Holding one lock across
 * the read, the compare and the write closes it.
 *
 * Contract:
 *   - The lock is a sibling file `.<name>.lock` beside the file's REAL path, so
 *     every process reaching the file (through the ~/.claude/LIFEOS/USER symlink
 *     or the real ~/.config path, from launchd or a terminal) agrees on one lock.
 *   - Acquisition is `open(O_CREAT|O_EXCL)`; the file holds pid, host, time and
 *     a random token.
 *   - A writer that cannot get the lock within `timeoutMs` throws
 *     TelosLockTimeout and writes nothing.
 *   - A lock whose holder pid is dead (same host) or whose age exceeds `staleMs`
 *     is cleared under a second exclusive "break" file, and only when the lock
 *     still carries the token that was judged stale, so two clearers can never
 *     remove a fresh lock between them. A lock or break file with no readable
 *     record (its writer died between create and write, or the disk was full)
 *     is judged by its mtime against the same `staleMs`, and is deleted only if
 *     it is still unreadable and still that old once renamed aside, so a live
 *     writer's just-created empty file is never removed.
 *   - Release removes the lock only while it still carries our token.
 *   - Re-entrant inside one process: a nested lock on a file this process
 *     already holds is a no-op, so a locked caller may call another locked
 *     helper on the same file without deadlocking itself.
 *
 * Writers call `assertHeld()` (through invariant) right before their write, so
 * a lock that was cleared out from under a stalled holder fails loud instead of
 * writing.
 *
 * @version 1.0.0
 */

import { randomBytes } from "node:crypto";
import { closeSync, existsSync, linkSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, join } from "node:path";
import { invariant } from "./Invariant";

/** Default wait for a busy lock before failing loud. */
export const DEFAULT_TIMEOUT_MS = 10_000;
/** A lock older than this is treated as abandoned even when its pid is alive. Critical sections take milliseconds. */
export const DEFAULT_STALE_MS = 120_000;
const POLL_MS = 25;

export interface TelosLockOptions {
  /** How long to wait for a busy lock before throwing TelosLockTimeout. */
  timeoutMs?: number;
  /** Age past which a held lock counts as abandoned. */
  staleMs?: number;
}

interface LockRecord {
  pid: number;
  host: string;
  acquired: number;
  token: string;
}

/** Thrown when the lock stays busy past the timeout. Nothing was written. */
export class TelosLockTimeout extends Error {
  readonly file: string;
  readonly holder: LockRecord | null;
  constructor(file: string, holder: LockRecord | null, waitedMs: number) {
    const who = holder ? `pid ${holder.pid} on ${holder.host} since ${new Date(holder.acquired).toISOString()}` : "an unknown holder";
    super(`TELOS file ${file} is locked by ${who}; waited ${waitedMs} ms and wrote nothing. Retry once that writer finishes.`);
    this.name = "TelosLockTimeout";
    this.file = file;
    this.holder = holder;
  }
}

export interface TelosLockHandle {
  /** The real path of the locked file. */
  readonly file: string;
  /** The lock file beside it. */
  readonly lockPath: string;
  /** True while the lock file on disk still carries this holder's token. */
  held(): boolean;
}

/** Locks held by this process, by real file path, with a nesting depth. */
const heldHere = new Map<string, { token: string; lockPath: string; depth: number }>();

/** The real path of `file`, or of its parent joined with its name when the file does not exist yet. */
export function telosRealPath(file: string): string {
  if (existsSync(file)) return realpathSync(file);
  return join(realpathSync(dirname(file)), basename(file));
}

/** The lock file for `file`: a dot-file beside its real path. */
export function telosLockPath(file: string): string {
  const real = telosRealPath(file);
  return join(dirname(real), `.${basename(real)}.lock`);
}

function readRecord(path: string): LockRecord | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    const r = parsed as Record<string, unknown>;
    if (typeof r.pid !== "number" || typeof r.host !== "string" || typeof r.acquired !== "number" || typeof r.token !== "string") return null;
    return { pid: r.pid, host: r.host, acquired: r.acquired, token: r.token };
  } catch {
    return null; // missing, mid-write or garbage: the caller treats it by mtime
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists under another user.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Age in ms of the lock at `path`, from its record or, when unreadable, its mtime. Null when the file is gone. */
function lockAge(path: string, rec: LockRecord | null, now: number): number | null {
  if (rec) return now - rec.acquired;
  try {
    return now - statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

function isStale(path: string, rec: LockRecord | null, staleMs: number, now: number): boolean {
  if (rec && rec.host === hostname() && !pidAlive(rec.pid)) return true;
  const age = lockAge(path, rec, now);
  return age !== null && age > staleMs;
}

function tryCreate(path: string, rec: LockRecord): boolean {
  let fd: number;
  try {
    fd = openSync(path, "wx", 0o644);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
  try {
    writeSync(fd, JSON.stringify(rec));
  } finally {
    closeSync(fd);
  }
  return true;
}

function newRecord(): LockRecord {
  return { pid: process.pid, host: hostname(), acquired: Date.now(), token: randomBytes(16).toString("hex") };
}

/**
 * Clear the lock at `lockPath` if it is stale, under an exclusive break file.
 * The staleness verdict is re-made under the break file against the exact
 * token seen there, so a lock taken fresh by another writer is never removed.
 */
function clearIfStale(lockPath: string, staleMs: number): void {
  const breakPath = `${lockPath}.break`;
  const mine = newRecord();
  if (!tryCreate(breakPath, mine)) {
    // Another process is clearing. Its break file is abandoned only if that
    // clearer died. A break file with no readable record (the clearer died
    // between create and write, or the disk was full) is judged by its mtime,
    // the way an unreadable lock is, so it cannot wedge every later writer.
    const other = readRecord(breakPath);
    if (isStale(breakPath, other, staleMs, Date.now())) removeIfToken(breakPath, other ? { token: other.token } : { unreadableOlderThanMs: staleMs });
    return;
  }
  try {
    const rec = readRecord(lockPath);
    if (!existsSync(lockPath) || !isStale(lockPath, rec, staleMs, Date.now())) return;
    // Under the break file no other clearer runs. The holder itself may still
    // release in this instant, so removal goes through removeIfToken, which
    // never deletes a lock carrying a different token.
    removeIfToken(lockPath, rec ? { token: rec.token } : { unreadableOlderThanMs: staleMs });
  } finally {
    removeIfToken(breakPath, { token: mine.token });
  }
}

/**
 * What a file must still be, once renamed aside, for removeIfToken to delete it:
 * either it carries this exact token, or it is unreadable and older than the
 * given age (the verdict for an unreadable lock or break file).
 */
export type RemovalExpectation = { token: string } | { unreadableOlderThanMs: number };

/**
 * Remove the file at `lockPath` (a lock or a break file) only if it still
 * meets `expect`. The file is first renamed aside, which is atomic, and
 * checked there. An unreadable file is re-judged by its mtime on the aside,
 * because the path may have been replaced since the verdict by a live writer
 * that has created its file but not yet written its record (an empty, young
 * file); that file is never deleted. Anything else is linked back; link fails
 * rather than overwrite when a third writer has taken the path meanwhile, and
 * a displaced lock holder's held() check then fails loud before it writes.
 */
export function removeIfToken(lockPath: string, expect: RemovalExpectation): boolean {
  const aside = `${lockPath}.${process.pid}.${randomBytes(6).toString("hex")}.gone`;
  try {
    renameSync(lockPath, aside);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
  const seen = readRecord(aside);
  const ours = "token" in expect
    ? seen?.token === expect.token
    : seen === null && (lockAge(aside, null, Date.now()) ?? -1) > expect.unreadableOlderThanMs; // rename keeps the inode's mtime
  if (ours) {
    unlinkSync(aside);
    return true;
  }
  try {
    linkSync(aside, lockPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
  unlinkSync(aside);
  return false;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** One acquisition attempt. Returns the record written, or null when the lock is busy. */
function attempt(lockPath: string, staleMs: number): LockRecord | null {
  const rec = newRecord();
  if (tryCreate(lockPath, rec)) return rec;
  clearIfStale(lockPath, staleMs);
  return tryCreate(lockPath, rec) ? rec : null;
}

function enterHeld(real: string): TelosLockHandle | null {
  const cur = heldHere.get(real);
  if (!cur) return null;
  cur.depth += 1;
  return handleFor(real, cur.lockPath, cur.token);
}

function handleFor(real: string, lockPath: string, token: string): TelosLockHandle {
  return { file: real, lockPath, held: () => readRecord(lockPath)?.token === token };
}

function release(real: string): void {
  const cur = heldHere.get(real);
  invariant(cur, `releasing a TELOS lock this process does not hold: ${real}`);
  cur.depth -= 1;
  if (cur.depth > 0) return;
  heldHere.delete(real);
  // Remove only our own lock; if it was cleared as stale, the new holder's lock stays.
  removeIfToken(cur.lockPath, { token: cur.token });
}

function acquireSync(file: string, opts: TelosLockOptions): { real: string; handle: TelosLockHandle } {
  const real = telosRealPath(file);
  const nested = enterHeld(real);
  if (nested) return { real, handle: nested };
  const lockPath = telosLockPath(file);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
  const start = Date.now();
  for (;;) {
    const rec = attempt(lockPath, staleMs);
    if (rec) {
      heldHere.set(real, { token: rec.token, lockPath, depth: 1 });
      return { real, handle: handleFor(real, lockPath, rec.token) };
    }
    const waited = Date.now() - start;
    if (waited >= timeoutMs) throw new TelosLockTimeout(real, readRecord(lockPath), waited);
    sleepSync(Math.min(POLL_MS + Math.floor(Math.random() * POLL_MS), Math.max(1, timeoutMs - waited)));
  }
}

async function acquireAsync(file: string, opts: TelosLockOptions): Promise<{ real: string; handle: TelosLockHandle }> {
  const real = telosRealPath(file);
  const nested = enterHeld(real);
  if (nested) return { real, handle: nested };
  const lockPath = telosLockPath(file);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
  const start = Date.now();
  for (;;) {
    const rec = attempt(lockPath, staleMs);
    if (rec) {
      heldHere.set(real, { token: rec.token, lockPath, depth: 1 });
      return { real, handle: handleFor(real, lockPath, rec.token) };
    }
    const waited = Date.now() - start;
    if (waited >= timeoutMs) throw new TelosLockTimeout(real, readRecord(lockPath), waited);
    await new Promise((r) => setTimeout(r, Math.min(POLL_MS + Math.floor(Math.random() * POLL_MS), Math.max(1, timeoutMs - waited))));
  }
}

/**
 * Run `fn` while holding the lock for `file`. Blocks (sleeping) up to
 * `timeoutMs`, then throws TelosLockTimeout without calling `fn`.
 * `fn` must do its whole read, compare and write inside.
 */
export function withTelosLock<T>(file: string, fn: (lock: TelosLockHandle) => T, opts: TelosLockOptions = {}): T {
  const { real, handle } = acquireSync(file, opts);
  try {
    return fn(handle);
  } finally {
    release(real);
  }
}

/**
 * Async-waiting form for servers, which must not block the event loop while
 * another writer holds the lock. `fn` stays synchronous so nothing else in
 * this process interleaves with the read, compare and write.
 */
export async function withTelosLockAsync<T>(file: string, fn: (lock: TelosLockHandle) => T, opts: TelosLockOptions = {}): Promise<T> {
  const { real, handle } = await acquireAsync(file, opts);
  try {
    return fn(handle);
  } finally {
    release(real);
  }
}
