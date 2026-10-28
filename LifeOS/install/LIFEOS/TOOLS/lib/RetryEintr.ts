// EINTR-tolerant filesystem reads (20261002-bunker-achilles-cleanup ISC-6).
//
// A projects directory that is a symlink into iCloud Drive can be interrupted: for launchd jobs,
// iCloud's file coordination interrupts open() and scandir() with EINTR, which Bun surfaces as
// a thrown error. That can make many ISAs read as "unparseable" and crash scheduled monitors. An
// interrupted call is safe to repeat, so these wrappers repeat it a few times
// with a short pause and rethrow anything else unchanged.
//
// `existsSync` swallows every error and returns false, which turns EINTR into
// "this app does not exist". `existsRetry` retries EINTR and otherwise answers
// exactly as existsSync does.

import { readdirSync, readFileSync, statSync } from "node:fs";

export const EINTR_ATTEMPTS = 6;

function isEintr(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "EINTR";
}

export function retryEintr<T>(fn: () => T, attempts: number = EINTR_ATTEMPTS): T {
  for (let i = 1; ; i++) {
    try {
      return fn();
    } catch (error) {
      if (!isEintr(error) || i >= attempts) throw error;
      Bun.sleepSync(25 * i);
    }
  }
}

export function readFileRetry(path: string): string {
  return retryEintr(() => readFileSync(path, "utf8"));
}

export function readdirRetry(path: string): string[] {
  return retryEintr(() => readdirSync(path));
}

export function existsRetry(path: string): boolean {
  try {
    retryEintr(() => statSync(path));
    return true;
  } catch (error) {
    // Same answer as existsSync for every error but a persistent EINTR, which
    // means "could not look", never "absent".
    if (isEintr(error)) throw error;
    return false;
  }
}
