/**
 * @version 1.1.0
 * handoff-state.ts — what the hand-off gate (ProofGate, PreToolUse) tells the output recorder (OutputRecord, PostToolUse), (maintainer-side; not in the public release)
 * and the loud half of "fail open, loudly" (assay-everywhere ISC-13, ISC-32).
 *
 * Pending approvals: the gate saves one small file per allowed call, keyed by the call's tool_use_id (or, when the
 * harness sends none, by session + tool + input), holding what it approved: the path, channel, the sha256 it approved,
 * the receipt it found, the decision and its reason. The recorder consumes it after the tool succeeded, hashes the bytes
 * that landed, and compares. A denied call leaves nothing behind, because the tool never ran. Files are 0600, expire
 * after six hours, and hold paths but never content. They DO hold paths (the file being approved, a copy's destination), so
 * they are local 0600 scratch in ~/.local/state, outside the USER data repo and never committed. Output-ledger lines
 * (OutputLedger.ts) hold a redacted target class, sha256, byte count and kind, never a path or content.
 *
 * Scan state (the OutputRecord backstop): one small 0600 file per session in the same directory, holding the time of the (maintainer-side; not in the public release)
 * last delivery-root scan and path -> mtime for files already accounted for. First scan only establishes the stamp.
 *
 * Events: `writeStatvsEvent` is the hooks' one door to STATVS `writeEvent` (ISAGate and VigilTaskSummary use it too).
 * `emitLoud` turns a gate error, a post-state mismatch or an unproofed landing into one event through it. Event text is
 * built from kind, extension, sha256 prefix (12 hex) and counts only (`describeFile`), never a basename, a path fragment
 * or a raw error string; `scrub` is the backstop that removes path-shaped, address-shaped and filename-shaped words,
 * including paths with spaces. It never throws.
 */
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { invariant } from "../../LIFEOS/TOOLS/Invariant";
import type { OutputDecision, OutputKind } from "../../LIFEOS/TOOLS/lib/OutputLedger.ts";

export type Channel = "open" | "downloads" | "desktop" | "artifact";

export type PendingItem = {
  /** The file whose receipt the gate read: the source of a copy, the target of a write, an artifact, an opened file. */
  path: string;
  channel: Channel;
  kind: OutputKind;
  /** Bash copy only: the destination operand and the source operand (a file or a directory) this file came from. */
  dest?: string;
  src_root?: string;
  /** The sha256 the gate approved (null when the gate made no claim about bytes: a kind Proof cannot measure). */
  approved_sha: string | null;
  /** The store key of the receipt the gate found, when one matched the approved sha. */
  receipt_id: string | null;
  decision: OutputDecision;
  reason: string;
};

export type Pending = { v: 1; ts: string; tool: string; errored?: string; items: PendingItem[] };

const KEY = /^[0-9a-f]{32}$/;
const EXPIRY_MS = 6 * 60 * 60 * 1000;

export function pendingDir(): string {
  // Outside the USER data repo on purpose: pending approvals are six-hour scratch, never history worth committing.
  if (process.env.LIFEOS_PROOFGATE_STATE) return process.env.LIFEOS_PROOFGATE_STATE;
  // Under `bun test` with no override the state is a per-process temp dir, so a hook test can never write the real one.
  if (process.env.NODE_ENV === "test") return join(tmpdir(), `lifeos-proofgate-test-${process.pid}`);
  return join(homedir(), ".local", "state", "lifeos", "proofgate");
}

export type CallId = { session_id?: unknown; tool_use_id?: unknown; tool_name?: unknown; tool_input?: unknown };

/** One key for the pre and post side of the same tool call. */
export function pendingKey(input: CallId): string {
  const id = typeof input.tool_use_id === "string" && input.tool_use_id ? input.tool_use_id : `${String(input.tool_name)}|${JSON.stringify(input.tool_input ?? null)}`;
  return createHash("sha256").update(`${String(input.session_id ?? "")}|${id}`).digest("hex").slice(0, 32);
}

function sweep(dir: string, now: number): void {
  try {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      const p = join(dir, f);
      try { if (now - statSync(p).mtimeMs > EXPIRY_MS) rmSync(p, { force: true }); } catch { /* raced with another session */ }
    }
  } catch { /* no dir yet */ }
}

export function savePending(key: string, pending: Pending, dir = pendingDir(), now = Date.now()): void {
  invariant(KEY.test(key), "pending key is 32 hex characters");
  invariant(pending.v === 1 && Number.isFinite(Date.parse(pending.ts)), "pending record is versioned and timestamped");
  invariant(pending.errored !== undefined || pending.items.length > 0, "a pending record carries an approval or an error");
  invariant(pending.items.every((i) => i.path.length > 0 && (i.approved_sha === null || /^[0-9a-f]{64}$/.test(i.approved_sha))), "pending items carry a path and a null or sha256 approval");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  sweep(dir, now);
  const p = join(dir, `${key}.json`);
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(pending), { mode: 0o600 });
  renameSync(tmp, p);
}

/** Read and remove the pending record for a call. Null when there is none or it does not parse. */
export function takePending(key: string, dir = pendingDir()): Pending | null {
  if (!KEY.test(key)) return null;
  const p = join(dir, `${key}.json`);
  if (!existsSync(p)) return null;
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as Pending;
    return raw && raw.v === 1 && Array.isArray(raw.items) ? raw : null;
  } catch { return null; }
  finally { try { rmSync(p, { force: true }); } catch { /* already gone */ } }
}

// ── Events (STATVS) ──────────────────────────────────────────────────────────

/** An emitter. It may return a write result: `{ ok: false }` (STATVS writeEvent's refusal) counts as not written. */
export type VigilEmit = (event: Record<string, unknown>) => unknown | Promise<unknown>;

/** What the hooks' event writer did with one event: written (or spooled), or the reason it was not. */
export type HookEventWrite = { ok: true; event_id: string } | { ok: false; reason: string };

/** STATVS's public API, by a computed path, so a payload without LIFEOS/STATVS still loads every hook that imports this file. */
export const statvsIndexPath = (): string => join(import.meta.dir, "../../LIFEOS/STATVS/index.ts");

type WriteEvent = (input: Record<string, unknown>) => { ok: boolean; event_id: string; refused?: string };

/**
 * Write one event through STATVS `writeEvent` (STATVS migration design §2.1, §3 Lane E2): in p1 that is Vigil's legacy
 * outbox, plus the record while USER/STATVS/cutover.json has dual_write true. Synchronous, and it reports instead of
 * throwing: `{ ok: false, reason }` for a refusal or for an install without STATVS. Only a load failure of an installed
 * STATVS or an InvariantViolation from the writer escapes, and every caller already swallows those. Callers write after
 * their gate has decided, so the record never changes an allow or a deny (STATVS ISC-58).
 */
export function writeStatvsEvent(event: Record<string, unknown>, indexPath = statvsIndexPath()): HookEventWrite {
  if (!existsSync(indexPath)) return { ok: false, reason: "STATVS is not installed" };
  const { writeEvent } = require(indexPath) as { writeEvent: WriteEvent };
  const r = writeEvent(event);
  return r.ok ? { ok: true, event_id: r.event_id } : { ok: false, reason: r.refused || "refused" };
}

/**
 * The real emitter: STATVS writeEvent. A refusal or a missing STATVS returns `{ ok: false }`, so emitLoud writes the local
 * fallback line and reports false: a monitoring gap is never a quiet no-op.
 */
export const defaultEmit: VigilEmit = (event) => writeStatvsEvent(event);

/** The reason an emitter's result says the event was not written, or null when it was (any result but `{ ok: false }`). */
function notWritten(result: unknown): string | null {
  if (!result || typeof result !== "object" || (result as { ok?: unknown }).ok !== false) return null;
  const r = result as { reason?: unknown; refused?: unknown };
  return String(r.reason ?? r.refused ?? "not written");
}

const EXT_END = /\.[A-Za-z][A-Za-z0-9]{0,7}[.,;:'"`)\]]*$/;

/**
 * A message with every path-shaped, address-shaped and filename-shaped word replaced by "<redacted>", capped. A path that
 * contains spaces ("/tmp/my dir/jane@corp.com report.png") runs on, word by word, until a word that ends in a file
 * extension or closes a quote (at most eight words), so no directory or file word survives.
 */
export function scrub(message: string, max = 300): string {
  const words = String(message ?? "").split(/\s+/).filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    if (/[\/\\]/.test(w) || w.startsWith("~")) {
      let j = i;
      let budget = 8;
      while (j < words.length - 1 && budget-- > 0 && !EXT_END.test(words[j]!) && !/['"`)\]][.,;:]?$/.test(words[j]!)) j++;
      out.push("<redacted>");
      i = j;
      continue;
    }
    if (w.includes("@") || /[A-Za-z0-9_-]\.[A-Za-z]/.test(w) && EXT_END.test(w)) { out.push("<redacted>"); continue; }
    out.push(w);
  }
  return out.join(" ").slice(0, max);
}

/** The only description of a file an event may carry: its kind, extension, sha256 prefix. Never a name or a path. */
export function describeFile(kind: string | null | undefined, path: string, sha?: string | null): string {
  const ext = /\.[A-Za-z0-9]{1,8}$/.exec(path)?.[0]?.toLowerCase() ?? "no extension";
  return `${kind ?? "file"} (${ext}${sha && /^[0-9a-f]{12}/.test(sha) ? `, sha256 ${sha.slice(0, 12)}` : ""})`;
}

// ── Delivery-root scan state (the OutputRecord backstop) ─────────────────────── (maintainer-side; not in the public release)

export type ScanState = { v: 1; /** ms epoch the last scan started */ stamp: number; /** path -> mtime/ctime ms of files already accounted for */ seen: Record<string, number> };
const SEEN_MAX = 500;
/** Reserved keys (a leading NUL: held unit stamps, the known-subfolder cache) have their own cap, so a 2,000-subfolder cache never crowds out the file entries. */
const RESERVED_MAX = 2_100;

export function scanStatePath(session: string, dir = pendingDir()): string {
  return join(dir, `scan-${createHash("sha256").update(session).digest("hex").slice(0, 32)}.json`);
}

export function loadScanState(session: string, dir = pendingDir()): ScanState | null {
  try {
    const raw = JSON.parse(readFileSync(scanStatePath(session, dir), "utf8")) as ScanState;
    return raw && raw.v === 1 && Number.isFinite(raw.stamp) && raw.seen && typeof raw.seen === "object" ? raw : null;
  } catch { return null; }
}

export function saveScanState(session: string, state: ScanState, dir = pendingDir()): void {
  invariant(typeof session === "string" && session.length > 0, "scan state belongs to a session");
  invariant(state.v === 1 && Number.isFinite(state.stamp) && state.stamp > 0, "scan state carries a positive stamp");
  const all = Object.entries(state.seen).filter(([p, t]) => p.length > 0 && Number.isFinite(t));
  const entries = [...all.filter(([p]) => !p.startsWith("\0")).slice(-SEEN_MAX), ...all.filter(([p]) => p.startsWith("\0")).slice(-RESERVED_MAX)];
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const p = scanStatePath(session, dir);
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ v: 1, stamp: state.stamp, seen: Object.fromEntries(entries) } satisfies ScanState), { mode: 0o600 });
  renameSync(tmp, p);
}

/**
 * Claim one landing (a path at one mtime/ctime) across every session. The delivery roots are shared, so without this each
 * open session's backstop would record another session's delivery again. The first claimant writes the output line;
 * everyone else skips it. Markers older than a day are swept on the way in.
 */
export function claimLanding(path: string, changed: number, dir = pendingDir(), now = Date.now()): boolean {
  invariant(path.length > 0 && Number.isFinite(changed), "a landing is a path at a change time");
  const claims = join(dir, "landed");
  mkdirSync(claims, { recursive: true, mode: 0o700 });
  if (Math.random() < 0.02) {
    try { for (const f of readdirSync(claims)) { const p = join(claims, f); if (now - statSync(p).mtimeMs > 86_400_000) rmSync(p, { force: true }); } } catch { /* sweep is best effort */ }
  }
  try {
    writeFileSync(join(claims, createHash("sha256").update(`${path}\0${changed}`).digest("hex").slice(0, 32)), "", { flag: "wx", mode: 0o600 });
    return true;
  } catch { return false; }
}

export type LoudEvent = { source: "hook:ProofGate" | "hook:OutputRecord" | "hook:ReplyRecord"; severity: "low" | "medium"; title: string; summary: string; dedup: string }; // maintainer-side; not in the public release

/** Where an event goes when Vigil cannot take it: one JSONL line per event, 0600, beside the other hook state. */
export function emitFallbackPath(dir = pendingDir()): string { return join(dir, "emit-fallback.jsonl"); }

function appendFallback(event: Record<string, unknown>, why: string): void {
  try {
    const dir = pendingDir();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const p = emitFallbackPath(dir);
    appendFileSync(p, JSON.stringify({ ...event, fallback_reason: scrub(why, 120) }) + "\n", { mode: 0o600 });
    chmodSync(p, 0o600);
  } catch { /* nowhere left to write: the caller still gets false */ }
}

/** Failures per dedup key per hour, so a burst reads as a count and not as one silent event. Best effort: a counter that cannot persist reads 1. */
function bumpCount(dedup: string, nowMs: number): number {
  try {
    const dir = pendingDir();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const p = join(dir, "emit-counts.json");
    const hour = Math.floor(nowMs / 3_600_000);
    let all: Record<string, number> = {};
    try { all = JSON.parse(readFileSync(p, "utf8")) as Record<string, number>; } catch { /* first count */ }
    const next: Record<string, number> = {};
    for (const [k, v] of Object.entries(all)) if (k.endsWith(`@${hour}`) && Number.isFinite(v)) next[k] = v;
    const key = `${dedup}@${hour}`;
    next[key] = (next[key] ?? 0) + 1;
    const tmp = `${p}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(next), { mode: 0o600 });
    renameSync(tmp, p);
    return next[key]!;
  } catch { return 1; }
}

/**
 * Emit one Vigil event. Never throws; returns whether the emit completed. The dedup key carries the hour and a power-of-two
 * count bucket (1, 2, 4, 8...) and the summary carries the exact count, so a burst of failures in one hour surfaces as a few
 * events with rising counts. When STATVS is missing, the emitter returns `{ ok: false }` (a refusal) or emit rejects, the
 * event is appended to a local JSONL fallback and the result is false.
 */
export async function emitLoud(e: LoudEvent, emit: VigilEmit = defaultEmit): Promise<boolean> {
  const nowMs = Date.now();
  const n = bumpCount(e.dedup, nowMs);
  const event = {
    id: randomUUID(), source: e.source, ts: new Date(nowMs).toISOString(), kind: "infra", severity: e.severity,
    title: scrub(e.title, 140), summary: scrub(`${e.summary} (${n} this hour)`, 900), ref: null, url: null, privacy_class: "personal",
    dedup_key: `${e.dedup}:${Math.floor(nowMs / 3_600_000)}:n${2 ** Math.floor(Math.log2(n))}`,
  };
  try {
    const refused = notWritten(await emit(event));
    if (refused === null) return true;
    appendFallback(event, refused);
    return false;
  } catch (err) {
    appendFallback(event, err instanceof Error ? err.message : String(err));
    return false;
  }
}
