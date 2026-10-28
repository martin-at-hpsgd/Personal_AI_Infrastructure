import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { getLifeosDir } from "./paths";
import { redactSecretValues } from "./egress-shapes";
import { invariant, InvariantViolation } from "../../LIFEOS/TOOLS/Invariant";

function cachePath(root: string, session: string): string {
  return join(root, `response-${createHash("sha256").update(session).digest("hex")}.json`);
}
const defaultRoot = () => join(getLifeosDir(), "MEMORY", "STATE");

const SESSION_FILE = /^response-[0-9a-f]{64}\.json$/;
const PRUNE_MARKER = ".response-cache-pruned";
const PRUNE_AFTER_MS = 7 * 24 * 60 * 60_000;
const PRUNE_EVERY_MS = 60 * 60_000;

/** One session file per session, forever, grew to ~1,100 files. Delete sibling
 *  session files older than 7 days, at most one directory scan an hour (the
 *  marker's mtime records the last scan). Never the current session's file.
 *  Housekeeping only: a failed scan leaves the files for the next one. */
function pruneStaleResponses(root: string, keep: string, now: number): void {
  const marker = join(root, PRUNE_MARKER);
  try {
    const since = now - statSync(marker).mtimeMs;
    if (since >= 0 && since < PRUNE_EVERY_MS) return;
  } catch { /* no marker yet: scan */ }
  try {
    writeFileSync(marker, "", { mode: 0o600 });
    utimesSync(marker, now / 1000, now / 1000);
    for (const name of readdirSync(root)) {
      if (!SESSION_FILE.test(name) || name === keep) continue;
      const file = join(root, name);
      try {
        const entry = lstatSync(file);
        if (!entry.isFile() || now - entry.mtimeMs <= PRUNE_AFTER_MS) continue;
        invariant(name !== keep && SESSION_FILE.test(name), "Response-cache prune deletes only stale sibling session files");
        unlinkSync(file);
      } catch (err) {
        // ENOENT (a concurrent prune got it first) or an unreadable entry: skip it.
        if (err instanceof InvariantViolation) throw err;
      }
    }
  } catch (err) {
    if (err instanceof InvariantViolation) throw err;
  }
}

/** Keep the legacy rating cache; formatting feedback needs the full, owned answer.
 * Both files hold the answer with secret-shaped values redacted (formatting
 * feedback reads structure, never a credential) and are written 0600
 * (GHSA-8qfr-7fpx-68x9, @godagoo). */
export function cacheResponse(session: string, answer: string, root = defaultRoot(), now = Date.now()): void {
  invariant(typeof answer === "string" && Number.isFinite(now), "Valid response cache payload");
  const clean = redactSecretValues(answer);
  mkdirSync(root, { recursive: true });
  const last = join(root, "last-response.txt");
  writeFileSync(last, clean.slice(0, 2000), { encoding: "utf8", mode: 0o600 });
  chmodSync(last, 0o600);
  if (session) {
    const file = cachePath(root, session);
    writeFileSync(file, JSON.stringify({ session, answer: clean, at: now }), { mode: 0o600 });
    chmodSync(file, 0o600);
    pruneStaleResponses(root, basename(file), now);
  }
}

export function readSessionResponse(session: string, root = defaultRoot(), now = Date.now()): string | null {
  if (!session) return null;
  try {
    const value = JSON.parse(readFileSync(cachePath(root, session), "utf8"));
    return value.session === session && typeof value.answer === "string" &&
      typeof value.at === "number" && now >= value.at && now - value.at <= 30 * 60_000
      ? value.answer : null;
  } catch { return null; }
}
