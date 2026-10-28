/**
 * taint — "this session read outside content this turn."
 *
 * Framing tells the model that text is data. It does not stop the model from
 * being talked into sending, publishing, deploying, or pushing in the same
 * breath. This file is the other half: when a read from a taint SOURCE is
 * framed, a per-session mark is written; TaintGuard asks before outbound calls
 * and refuses secret operations or unattended calls; the principal's next prompt
 * clears it. That breaks the lethal trifecta (outside text + private data +
 * a way out) at the way out, without touching reads.
 *
 * Not every framed read marks. Framing is cheap and errs toward yes; marking
 * must not fire on our own infrastructure or every ship flow would stall
 * (deploy → probe the live site → push). So: named source surfaces mark;
 * network fetches mark only when the host is not one we own; unresolvable →
 * frame yes, mark no.
 *
 * State: MEMORY/STATE/taint/<session_id>.json with a TTL. A corrupt
 * file is UNKNOWN; only valid expired marks are removed. State failures block
 * outbound actions until a successful clear, without blocking ordinary work.
 *
 * Expiry rests on the kernel, not on the mark (1.2.0, LOSIntegrity follow-up):
 * a mark expires only when its own `ts` AND the inode change time (ctime) of
 * the file and of any link placed at its path are all older than the TTL. A
 * process cannot set ctime; every write, utimes, rename or link sets it to now.
 * So a tool call that rewrites a mark with a back-dated `ts`, back-dates its
 * mtime, or moves an old file into place makes the mark newer, never expired.
 * Legitimate expiry is unchanged: the hook writes the mark, nothing else touches
 * it, and six hours later both clocks agree.
 *
 * @version 1.2.0
 */

import { accessSync, constants, existsSync, lstatSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getLifeosDir } from "./paths"; // public issue #1974 @sabo961, PR #1918 @PigLardLord

/** Resolved at call time, not import time, so a test (or a hook run with a different env) can redirect state. */
export function lifeosDir(): string {
  // The resolver expands ~ / $HOME and owns the CLAUDE_CONFIG_DIR > LIFEOS_DIR precedence.
  return getLifeosDir();
}
function taintDir(): string {
  return join(lifeosDir(), "MEMORY", "STATE", "taint");
}

/** Marks older than this are ignored: a session that idles a day is not still "mid-breath". */
export const TAINT_TTL_MS = 6 * 60 * 60 * 1000;

/** Ingest surfaces whose framed reads mark the session. Owned-infra responses never do. */
export const TAINT_SOURCES: ReadonlySet<string> = new Set([
  "feed",
  "social-read",
  "email-inbox",
  "calendar-invite",
  "repo-community",
  "transcript",
  "harvest-target",
  "community-chat",
  "mcp-result",
  "web-fetch",
]);

export interface TaintMark {
  session_id: string;
  surface: string;
  tool: string;
  detail?: string;
  /** The injection shape the content matched, when it looked like an attack. Sticky until clear or TTL. */
  injection?: string;
  ts: string;
}

function markPath(sessionId: string): string {
  // Session ids are UUID-shaped; refuse anything that could walk the path.
  const safe = sessionId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80) || "unknown";
  return join(taintDir(), `${safe}.json`);
}

/**
 * When the mark at `p` last changed by the kernel's clock: the newer ctime of the path itself (a
 * symlink placed there) and of the file it names. Throws when either cannot be read.
 */
function kernelChangedMs(p: string): number {
  return Math.max(lstatSync(p).ctimeMs, statSync(p).ctimeMs);
}

/**
 * A mark's age for expiry, measured from the LATER of its self-reported `ts` and the kernel change
 * time, so neither a forged `ts` nor a forged mtime can age it out. An unparseable `ts` makes no
 * claim and the kernel time decides alone.
 */
export function markAgeMs(p: string, ts: unknown, now: number): number {
  const claimed = typeof ts === "string" ? Date.parse(ts) : Number.NaN;
  const kernel = kernelChangedMs(p);
  return now - (Number.isFinite(claimed) ? Math.max(claimed, kernel) : kernel);
}

/** null is clean; a mark is tainted; UNKNOWN preserves failed integrity checks. */
export interface UnknownTaint {
  status: "unknown";
  reason: string;
  surface?: never;
  tool?: never;
  detail?: never;
  ts?: never;
}
const failedMarks = new Map<string, string>();
const unknown = (reason: string): UnknownTaint => ({ status: "unknown", reason });

/** `now` is the clock the carried-flag expiry is judged on (a test seam); the written `ts` is always the real time. */
export function markTaint(mark: Omit<TaintMark, "ts">, now: number = Date.now()): void {
  if (!mark.session_id) return;
  const p = markPath(mark.session_id);
  try {
    mkdirSync(taintDir(), { recursive: true });
    // Persist intent first: an interrupted/failed write must not look clean in
    // the next hook process. A successful mark or explicit clear removes it.
    writeFileSync(p + ".unknown", "Taint write started; integrity requires a successful clear.");
    // A later clean read must not wash out an earlier injection flag.
    let injection = mark.injection;
    if (!injection) {
      // An expired mark's flag is not carried: the TTL bounds the flag, not just the read. Expiry is
      // judged by markAgeMs, so a back-dated `ts` cannot drop the flag (1.2.0).
      try {
        const prev = JSON.parse(readFileSync(p, "utf8"));
        if (typeof prev?.injection === "string" && markAgeMs(p, prev?.ts, now) <= TAINT_TTL_MS) injection = prev.injection;
      } catch { /* no prior mark */ }
    }
    const full: TaintMark = { ...mark, ...(injection ? { injection } : {}), ts: new Date().toISOString() };
    writeFileSync(p, JSON.stringify(full));
    unlinkSync(p + ".unknown");
    failedMarks.delete(p);
  } catch (err) {
    failedMarks.set(p, "taint mark could not be persisted");
    throw new Error("Taint integrity failure: could not persist session mark", { cause: err });
  }
}

/** A missing mark is trustworthy only if storage can accept a future mark. */
function storageWritable(): boolean {
  let dir = taintDir();
  for (;;) {
    try { accessSync(dir, constants.W_OK | constants.X_OK); return true; }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") return false;
      try { lstatSync(dir); return false; }
      catch (statError) { if ((statError as NodeJS.ErrnoException).code !== "ENOENT") return false; }
      const parent = dirname(dir);
      if (parent === dir) return false;
      dir = parent;
    }
  }
}

/** Missing state is clean only on ENOENT; all other errors remain UNKNOWN. */
export function readTaint(sessionId: string, now: number = Date.now()): TaintMark | UnknownTaint | null {
  if (!sessionId) return null;
  const p = markPath(sessionId);
  if (failedMarks.has(p)) return unknown(failedMarks.get(p)!);
  try {
    try {
      readFileSync(p + ".unknown", "utf8");
      return unknown("a taint write did not complete");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") return unknown("taint intent could not be read");
      try { lstatSync(p + ".unknown"); return unknown("taint intent is a dangling link"); }
      catch (statError) {
        if ((statError as NodeJS.ErrnoException).code !== "ENOENT") return unknown("taint intent metadata could not be read");
      }
    }
    let raw: string;
    try { raw = readFileSync(p, "utf8"); }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        // A dangling link is corrupt state, not an absent mark.
        try { lstatSync(p); return unknown("taint state is a dangling link"); }
        catch (statError) {
          if ((statError as NodeJS.ErrnoException).code === "ENOENT") return storageWritable() ? null : unknown("taint storage is not writable");
          return unknown("taint state metadata could not be read");
        }
      }
      return unknown("taint state could not be read");
    }
    const m = JSON.parse(raw) as Partial<TaintMark> | null;
    if (!m || typeof m !== "object" || m.session_id !== sessionId ||
        typeof m.surface !== "string" || typeof m.tool !== "string" || typeof m.ts !== "string" ||
        (m.detail !== undefined && typeof m.detail !== "string") ||
        (m.injection !== undefined && typeof m.injection !== "string")) return unknown("invalid taint state");
    const claimedAge = now - Date.parse(m.ts);
    if (!Number.isFinite(claimedAge) || claimedAge < 0) return unknown("invalid taint timestamp");
    // The mark's own ts never expires it alone: the kernel change time must agree (1.2.0).
    if (markAgeMs(p, m.ts, now) > TAINT_TTL_MS) {
      unlinkSync(p);
      return null;
    }
    return m as TaintMark;
  } catch {
    return unknown("taint state is corrupt or inaccessible");
  }
}

/**
 * The principal's prompt: clears an ordinary mark, keeps one that carries an injection flag.
 * The principal speaking does not remove injected text from the context, so the ask before outbound
 * calls stays alive until the TTL. UNKNOWN state clears as before: the prompt is its repair.
 * Returns true when a mark was cleared.
 */
export function releaseTaint(sessionId: string, now: number = Date.now()): boolean {
  if (!sessionId) return false;
  const read = readTaint(sessionId, now);
  if (read && !("status" in read) && read.injection) return false;
  return clearTaint(sessionId);
}

export function clearTaint(sessionId: string): boolean {
  if (!sessionId) return false;
  const p = markPath(sessionId);
  let removed = false;
  try {
    for (const path of [p, p + ".unknown"]) {
      try { unlinkSync(path); removed = true; }
      catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
    }
    removed = failedMarks.delete(p) || removed;
    return removed;
  } catch {
    failedMarks.set(p, "taint state could not be cleared");
    return false;
  }
}

// ── owned hosts ─────────────────────────────────────────────────────────

const LOCAL_HOST_RE =
  /^(?:localhost|127\.(?:\d{1,3}\.){2}\d{1,3}|0\.0\.0\.0|\[::1\]|::1|10\.(?:\d{1,3}\.){2}\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|(?:[A-Za-z0-9-]+\.)+(?:lan|local|internal|home))$/i;

let ownedCache: { dir: string; set: Set<string> } | null = null;

/**
 * Domains we own: the curated infra inventory (private, may be absent on a
 * public install) plus an optional JSON list. Absent sources contribute
 * nothing — a public install treats every remote host as not-owned, which is
 * the safe direction (frame yes, and mark yes for real fetches).
 */
export function ownedDomains(): Set<string> {
  const dir = lifeosDir();
  if (ownedCache && ownedCache.dir === dir) return ownedCache.set;
  const out = new Set<string>();
  try {
    const inv = join(dir, "USER", "CUSTOMIZATIONS", "WORKFLOWS", "Shared", "infra-inventory.ts");
    if (existsSync(inv)) {
      const src = readFileSync(inv, "utf-8");
      for (const m of src.matchAll(/domain:\s*"([^"]+)"/g)) out.add(m[1]!.toLowerCase());
    }
  } catch {
    /* fail open: no owned domains from the inventory */
  }
  try {
    const extra = join(dir, "USER", "SECURITY", "owned-hosts.json");
    if (existsSync(extra)) {
      const arr = JSON.parse(readFileSync(extra, "utf-8"));
      if (Array.isArray(arr)) for (const d of arr) if (typeof d === "string") out.add(d.toLowerCase());
    }
  } catch {
    /* fail open */
  }
  ownedCache = { dir, set: out };
  return out;
}

/** True for local/LAN hosts, our own domains and their subdomains, and our workers.dev names. */
export function isOwnedHost(hostWithPort: string): boolean {
  const host = hostWithPort.split(/[$`]/, 1)[0]!.replace(/:\d+$/, "").toLowerCase();
  // A shell-expanded host with no literal prefix is unresolved, not foreign.
  if (!host) return true;
  if (LOCAL_HOST_RE.test(host)) return true;
  for (const d of ownedDomains()) {
    if (host === d || host.endsWith(`.${d}`)) return true;
  }
  return false;
}

const URL_RE = /https?:\/\/([^\s/'"`)]+)/gi;

/** True when the text names at least one URL whose host we do not own. */
export function hasNonOwnedUrl(text: string): boolean {
  for (const m of text.matchAll(URL_RE)) {
    if (!isOwnedHost(m[1] ?? "")) return true;
  }
  return false;
}

/** Test seam: forget the cached owned-domain set. */
export function resetOwnedCache(): void {
  ownedCache = null;
}
