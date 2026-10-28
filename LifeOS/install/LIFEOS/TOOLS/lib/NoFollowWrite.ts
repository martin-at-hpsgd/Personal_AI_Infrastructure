/**
 * NoFollowWrite.ts — writes that never follow a planted symlink.
 *
 * A directory proven inside its root (realpath) still leaves the final component open: a symlink at the file name
 * sends `writeFileSync` / `appendFileSync` wherever it points. These helpers close that gap the same way everywhere:
 *   - a symlink, directory or other non-regular entry at the destination is refused, never followed or replaced;
 *   - a whole-file write goes to an exclusively created O_EXCL | O_NOFOLLOW temp file in the destination's own
 *     directory and is renamed over the destination (rename replaces a directory entry and never follows it);
 *   - an append opens the destination O_APPEND | O_NOFOLLOW, so a symlink there fails with ELOOP instead of writing.
 * When `root` is given, the destination's directory must resolve (realpathSync) inside the real root first.
 */
import { closeSync, constants as FS, lstatSync, openSync, realpathSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join, sep } from "node:path";

/** Thrown when a destination is a symlink, a non-regular file, or outside its root. An attack or a mistake, never an impossible state. */
export class UnsafeDestinationError extends Error {
  constructor(message: string) { super(message); this.name = "UnsafeDestinationError"; }
}

/** The destination's entry as it sits on disk (no follow), or null when absent. */
function entryAt(path: string): ReturnType<typeof lstatSync> | null {
  try { return lstatSync(path); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

/**
 * Refuse a destination that is a symlink or any other non-regular entry, and (with `root`) one whose directory does
 * not resolve inside the real root. Returns the destination rebased onto its directory's real path.
 */
export function assertSafeDestination(target: string, root?: string): string {
  const dir = dirname(target);
  const dirEntry = entryAt(dir);
  if (!dirEntry) throw new UnsafeDestinationError(`destination directory is missing: ${dir}`);
  if (dirEntry.isSymbolicLink()) throw new UnsafeDestinationError(`destination directory is a symlink: ${dir}`);
  if (!dirEntry.isDirectory()) throw new UnsafeDestinationError(`destination directory is not a directory: ${dir}`);
  const realDir = realpathSync(dir);
  if (root !== undefined) {
    const realRoot = realpathSync(root);
    if (realDir !== realRoot && !realDir.startsWith(realRoot + sep)) throw new UnsafeDestinationError(`destination ${target} resolves outside ${realRoot}`);
  }
  const real = join(realDir, basename(target));
  const leaf = entryAt(real);
  if (leaf && !leaf.isFile()) throw new UnsafeDestinationError(`destination is not a regular file (${leaf.isSymbolicLink() ? "symlink" : "other entry"}): ${target}`);
  return real;
}

/** Replace `target` with `content` through an exclusive no-follow temp file and a rename. */
export function writeFileNoFollow(target: string, content: string | Uint8Array, opts: { root?: string; mode?: number } = {}): void {
  const real = assertSafeDestination(target, opts.root);
  const tmp = join(dirname(real), `.${basename(real)}.${process.pid}.${randomUUID()}.tmp`);
  const fd = openSync(tmp, FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL | FS.O_NOFOLLOW, opts.mode ?? 0o644);
  try { writeSync(fd, content); } catch (e) { closeSync(fd); try { unlinkSync(tmp); } catch { /* already gone */ } throw e; }
  closeSync(fd);
  try { renameSync(tmp, real); } catch (e) { try { unlinkSync(tmp); } catch { /* already gone */ } throw e; }
}

/** Open `target` for appending without following a symlink at it. The caller closes the descriptor. */
export function openAppendNoFollow(target: string, opts: { root?: string; mode?: number } = {}): number {
  const real = assertSafeDestination(target, opts.root);
  return openSync(real, FS.O_WRONLY | FS.O_APPEND | FS.O_CREAT | FS.O_NOFOLLOW, opts.mode ?? 0o644);
}

/** Append `text` to `target` without following a symlink at it. */
export function appendFileNoFollow(target: string, text: string, opts: { root?: string; mode?: number } = {}): void {
  const fd = openAppendNoFollow(target, opts);
  try { writeSync(fd, text); } finally { closeSync(fd); }
}

/** True only for a regular file at that exact path: a symlink, directory or missing entry is not one. */
export function isRegularFile(target: string): boolean {
  const e = entryAt(target);
  return !!e && e.isFile();
}
