/**
 * STATVS core — the shipper: sends this machine's local record (the v1 outbox that append()
 * writes) to the cloud core, row by row, without ever losing or doubling one.
 *
 * Each run reads the local segments with record.ts scan(), checks every unsent row against the
 * local hash chain (its own hash, its data_hash, its link to the row before it, its object's
 * sha256), converts it with row.ts fromV1, applies provenance (a customer row becomes a
 * content-free `withheld` marker at the same chain and seq, so the chain stays gapless), masks
 * secrets field by field in title, ref and data, moves payloads over 4096 bytes to bodies,
 * uploads those bodies first (PUT /bodies/:sha256), then POSTs the rows in batches (at most 500
 * rows and under 1 MB).
 *
 * A shipped row's writer is <local writer>@<machine> and its chain is the intake's one format,
 * writerSlug(writer)|<app>|<class>|<day>, so the machine rides in the writer and its slug. Two
 * machines run the same fixed writers (the turn-record hook) on the same day, so without the
 * machine their rows would share chain and seq and collide. The machine id is stored in the
 * cursor and in <stateDir>/ship/machine-id;
 * when both are lost it is re-derived from the hardware id and the record path under the mask
 * key, so a rebuilt state dir resends under the same chains and gets duplicates back. A
 * customer segment's app is an HMAC token in the chain, never its name, so a withheld marker
 * names no customer.
 *
 * A row the shipper cannot vouch for is held, never sent and never skipped: a broken local
 * hash chain, a data or object hash that does not match, or a payload whose object is missing
 * or unreadable with no redaction tombstone naming the row. Its segment stops at that row
 * until the cause is fixed (an object restored ships on the next run) or the operator accepts
 * it (acceptHeld: a lost payload ships as metadata flagged body-missing, a failed check ships
 * as a content-free `integrity-failed` marker). A redacted row whose object was deleted with
 * its tombstone ships as scrubbed: its data_hash stands for the payload.
 *
 * A row of a Claude Code session ships only once the whole session's provenance is decided, before
 * any row of it is sent: every pending row of the run is read first, and a session is withheld
 * when its ~/.claude/projects folder, any cwd on its transcript lines, or any of its rows names a
 * consulting project. A session is kept only when its transcript is found and none of them does.
 * A session with no transcript yet waits: its segment stops at its first row, unsent, and the
 * next run decides again. The intake's own whole-session check is the second line within one batch (decideBatch,
 * in memory per request); the memory between batches is this cursor's withheld_sessions, not the intake's.
 *
 * The cursor (<stateDir>/ship/<url hash>.json) holds, per segment, the byte offset read up to
 * and the highest seq the server has answered. It moves for rows answered stored or duplicate,
 * and past a refusal only when the refusal is final: a provenance withhold. Every other refusal
 * (an unmasked secret, a missing body, a bad hash, a collision) means the shipper or the core
 * has a bug a code fix can cure, so the row's segment stops there, unmoved, and the next run
 * resends it (ISC-161). Every refusal is logged with its reason (ship/refused.jsonl, no
 * content) and counted, and a run that stopped a segment reports it in `stopped`. A
 * network error or a bad answer stops the run and leaves the cursor at the last answered row,
 * so the next run resends from there; resends are safe because the server is idempotent per
 * chain and seq. Every conversion is deterministic (the HMAC mask, the marker's time is the
 * row's own), so a resent row hashes the same and comes back duplicate, never a collision.
 *
 * A row that names its RES (subject, op; CENSVS ISA F4) ships them as written, as a v4 row; every other row ships as
 * v3, exactly as before v4. A v4 row ships only after the core says on GET /health that it reads schema 4 or later
 * (CENSVS ISA ISC-64): a core rolled back to v0.6 reports no schema, so the segment holds at its first v4 row, unsent
 * and never dropped, and the run reports it in `schemaHeld`. /health is asked once per run, and only when a v4 row
 * is about to be queued. A row of a stream whose definition says `ship: false` never leaves the machine: it ships
 * as a content-free `local-only` marker at the same chain and seq (its source id and stream name, nothing else), so
 * the cloud chain stays gapless, and it is counted as withheld.
 *
 * append() is untouched: hooks keep writing the local record, which is the offline spool. The
 * shipper takes no record lock, so a stalled network never adds wait to an append (ISC-73).
 *
 * Bun-side (node:fs); the pure libs it uses are the ones the Worker imports.
 *
 * @version 0.1.0
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { invariant, InvariantViolation } from "../../../TOOLS/Invariant";
import { getClaudeDir } from "../../../TOOLS/Paths";
import { canonicalJson as v1Canonical, rowHash as v1RowHash, sha256 as v1Sha256 } from "../../../TOOLS/lib/LedgerCore";
import { listSegments, scan, statvsDir, statvsStateDir, utcDate, type Segment } from "../../lib/record";
import type { StatvsRow } from "../../lib/types";
import { sha256Hex, toHex, utf8, SHA256_HEX } from "./canonical";
import { mask, type MaskKey } from "./mask";
import { decide, isConsultingCwd, isConsultingFolder, withheldMarker, type ProvenanceConfig, type WithholdReason } from "./provenance";
import { externalizeBody, finalizeRow, fromV1, segmentChain, writerSlug, type CoreRow, type RowFields } from "./row";
import { streamDef } from "../../streams";

// ── Types ──

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ShipOptions {
  /** Base URL of the core Worker (https, or http on localhost). Required unless dryRun. */
  url?: string;
  /** Bearer token; sent only in the Authorization header. Required unless dryRun. */
  token?: string;
  /** HMAC key for mask tokens (STATVS_MASK_KEY). */
  maskKey: MaskKey;
  /** Our own secret values, masked by exact match before anything leaves (ISC-164); tools/ship.ts reads them from the sealed env. */
  ownSecrets?: readonly string[];
  /** Parsed provenance config (USER/STATVS/provenance.json). */
  provenance: ProvenanceConfig;
  /** The local record (default statvsDir()). */
  dir?: string;
  /** The STATVS state dir the cursor lives under (default statvsStateDir()). */
  stateDir?: string;
  fetch?: FetchLike;
  /** Rows per POST, at most 500. */
  batchRows?: number;
  /** Serialized bytes per POST, at most 1,000,000. */
  batchBytes?: number;
  /**
   * The most rows one run POSTs (the next run picks up the rest); a positive integer. A withheld or integrity-failed
   * marker counts as the one row it stands for. Bodies are uploaded only for rows in a batch, at most one per row, so a
   * run also uploads at most maxRows bodies. A batch is cut short to fit, so the cursor ends exactly on the last answered row.
   */
  maxRows?: number;
  /** Per-request timeout. */
  timeoutMs?: number;
  /** Read and convert, send nothing, write no cursor. */
  dryRun?: boolean;
  /** This machine's id in every chain (STATVS_MACHINE_ID); default the stored or derived one. Must match the cursor's. */
  machine?: string;
  /** Ship held rows as accepted: a lost payload as body-missing metadata, a failed check as an integrity-failed marker. */
  acceptHeld?: boolean;
  /** The hardware id a machine id is derived from (default: read from the OS); tests inject a synthetic one. */
  hardwareId?: () => string | null;
  /** Claude Code's transcript folders, one per encoded cwd (default ~/.claude/projects): the authority on a session's provenance. */
  projectsDir?: string;
  now?: () => number;
  log?: (line: string) => void;
  /** Whether rows of a stream may leave the machine (default: its StreamDef unless it says ship: false); tests inject one. */
  shipStream?: (stream: string) => boolean;
}

/** A stream ships unless its definition says `ship: false` (an unregistered stream ships, as it always has). */
export function streamShips(stream: string): boolean {
  return (streamDef(stream) as { ship?: unknown } | null)?.ship !== false;
}

/**
 * Why a row is held. The first three are a payload that may come back; the next five are failed integrity checks;
 * row_too_large is a row whose request alone, {rows: [row]}, is over the intake's MAX_BATCH_BYTES, so no request can carry it.
 */
export type HoldReason =
  | "object_missing" | "object_unreadable" | "scrubbed_no_tombstone"
  | "row_hash" | "data_hash" | "object_hash" | "chain_break" | "wrong_segment"
  | "row_too_large";
export const PAYLOAD_HOLDS: readonly HoldReason[] = ["object_missing", "object_unreadable", "scrubbed_no_tombstone"] as const;
export const INTEGRITY_HOLDS: readonly HoldReason[] = ["row_hash", "data_hash", "object_hash", "chain_break", "wrong_segment"] as const;
/** Holds that ship as a content-free marker once accepted: every failed check, and a row no request can carry. */
const MARKER_HOLDS: readonly HoldReason[] = [...INTEGRITY_HOLDS, "row_too_large"];
const HOLD_REASONS: readonly HoldReason[] = [...PAYLOAD_HOLDS, ...MARKER_HOLDS];
/** Refusals the core makes about the content itself; the shipper moves past them. Any other refusal is a bug to fix (ISC-161). */
export const FINAL_REFUSALS: readonly string[] = ["withheld"];

export interface Hold {
  /** Local segment path (stays on this machine). */
  segment: string;
  seq: number;
  src_id: string;
  reason: HoldReason;
  /** Shipped anyway under acceptHeld. */
  accepted?: boolean;
  /**
   * An accepted row resent after a crash whose defect is gone (its object restored, its chain repaired). The accept
   * binds, so the row resent as the accepted bytes and the restored payload did not ship: an operator recovers it by
   * hand from the local record. Logged to ship/held.jsonl and the run log every time it happens.
   */
  restored?: boolean;
}

export interface ShipResult {
  ok: boolean;
  /** Why nothing was attempted (missing credentials), or why the run stopped. */
  error?: string;
  /** Rows read from the local record that the server had not answered yet. */
  pending: number;
  sent: number;
  stored: number;
  duplicate: number;
  refused: number;
  withheld: number;
  masked: number;
  bodies: number;
  segments: number;
  /** Rows held this run (each stops its segment); with acceptHeld, rows shipped as accepted. */
  held: number;
  holds: Hold[];
  accepted: number;
  /** Segments stopped at a row whose session's provenance could not be decided yet (no transcript found). */
  waiting: number;
  /** Segments stopped at a row the core refused for a curable reason; each is resent on the next run (ISC-161). */
  stopped: { segment: string; seq: number; reason: string }[];
  /** The machine id every writer this run ships carries after its "@". */
  machine?: string;
  checkpoint?: { size: number; root: string };
  /** In a dry run, the first few converted rows, for inspection. */
  sample?: CoreRow[];
  /**
   * Segments held at their first v4 row because the core did not report schema v4 support (ISC-64): `core` is the
   * schema its /health reported (null when it reported none or could not be read). Nothing after it is sent; the next
   * run against a v4 core sends it. Present only when a row was held.
   */
  schemaHeld?: { segment: string; seq: number; core: number | null; reason: string }[];
}

/** The lowest core schema that reads rows naming a RES (subject, op). */
export const V4_SCHEMA = 4;

interface SegCursor {
  /** Byte offset read up to (end of a complete line); a hint, re-read from 0 when it no longer lines up. */
  offset: number;
  /** Highest seq the server has answered for this segment. */
  seq: number;
  /** The answered row at `seq` was the segment's seal: nothing more is ever written to it. */
  sealed?: boolean;
  /** The local hash of the answered row at `seq`, which the next row's prev must name. Always sha256 hex. */
  hash?: string;
  /**
   * The answered row at `seq` was an accepted integrity hold: its hash vouches for nothing, so none is kept and the
   * next row is checked on its own, never by its link to it (the same rule the run that accepted it used).
   */
  unlinked?: true;
}

/**
 * One held row. An accepted entry carries `row`, the exact bytes of the row its accept sends, and `row_sha`, their sha256,
 * both written before the send: every resend replays those bytes, whatever has been repaired in the local row since, so a
 * run that died after the upload is answered duplicate, never collision. `withheld` and `masked` describe those bytes.
 * An accepted entry without bytes was never sent (its run stopped on an undecided session first) or predates the bytes.
 */
interface HeldEntry { seq: number; reason: HoldReason; since: string; accepted?: true; row?: string; row_sha?: string; withheld?: true; masked?: true }

interface ShipCursor {
  v: 1;
  /** The machine id the chains this cursor tracks were shipped under. */
  machine?: string;
  /** Segments dated before this (UTC YYYY-MM-DD) are done and not read again. */
  floor: string;
  segments: Record<string, SegCursor>;
  /**
   * Sessions the record withholds, so later runs decide them the same way: a date string for a session withheld
   * whole, or {at, fromMs} for a session withheld from the moment it entered a consulting project (option A), so its
   * earlier rows still ship in later or bounded runs.
   */
  withheld_sessions: Record<string, WithheldSession>;
  /**
   * Held rows, per segment and then per seq, so a hold is logged once, not every run, and one row's hold never
   * overwrites another's. `accepted` is written before an accepted row is sent: a run that dies after the upload
   * resends that same row on the next run, acceptHeld or not, and the server answers it duplicate. Every accepted row
   * of a segment keeps its own entry, so each one resends its accepted bytes. An entry is cleared once its row is answered.
   */
  held: Record<string, Record<string, HeldEntry>>;
  /** When each session with no transcript was first seen waiting (ms), so its 24-hour wait is time observed, not row age. */
  waiting_since: Record<string, number>;
  counts: { stored: number; duplicate: number; refused: number; withheld: number };
}

/** One converted row, ready to send. */
interface Prepared {
  rel: string;
  seq: number;
  /** The local row's hash, kept in the cursor once answered; absent for an accepted integrity hold, whose hash means nothing. */
  v1Hash?: string;
  /** An accepted integrity hold: the next row is not checked by its link to this one. */
  unlinked: boolean;
  row: CoreRow;
  body?: { sha256: string; text: string };
  withheld: boolean;
  masked: boolean;
  sealed: boolean;
  /** Shipped as an accepted hold (acceptHeld). */
  accepted?: boolean;
  /** The segment byte offset to commit once this row and every earlier one is answered (set on a segment's last row). */
  end?: number;
  srcId: string;
  /** The row's exact bytes when they were fixed earlier (an accepted row replayed from the cursor); else JSON.stringify(row). */
  json?: string;
}

/** The exact bytes a prepared row goes out as inside the request body. */
const rowText = (p: Prepared): string => p.json ?? JSON.stringify(p.row);

interface Answer { chain: string; seq: number; status: "stored" | "duplicate" | "refused"; offset?: number; reason?: string }

export const MAX_BATCH_ROWS = 500;
export const MAX_BATCH_BYTES = 1_000_000;
const DEFAULT_BATCH_BYTES = 900_000;
const DAY_MS = 86_400_000;
const WITHHELD_SESSION_DAYS = 30;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

// ── Paths and the cursor ──

/** The cursor file for one core URL, so pointing the shipper at a new core never skips rows. */
export async function cursorPath(stateDir: string, url: string): Promise<string> {
  return join(stateDir, "ship", `${(await sha256Hex(normalizeUrl(url))).slice(0, 12)}.json`);
}

function emptyCursor(): ShipCursor {
  return { v: 1, floor: "", segments: {}, withheld_sessions: {}, held: {}, waiting_since: {}, counts: { stored: 0, duplicate: 0, refused: 0, withheld: 0 } };
}

export function readCursor(path: string): ShipCursor {
  try {
    const c = JSON.parse(readFileSync(path, "utf8")) as Partial<ShipCursor>;
    if (c.v !== 1 || typeof c.segments !== "object" || !c.segments) return emptyCursor();
    return {
      v: 1,
      ...(typeof c.machine === "string" && MACHINE_RE.test(c.machine) ? { machine: c.machine } : {}),
      floor: typeof c.floor === "string" && (c.floor === "" || DATE.test(c.floor)) ? c.floor : "",
      segments: cleanSegments(c.segments),
      withheld_sessions: cleanWithheld(c.withheld_sessions),
      held: cleanHeld(c.held, c.segments),
      waiting_since: cleanWaiting(c.waiting_since),
      counts: { ...emptyCursor().counts, ...(c.counts ?? {}) },
    };
  } catch {
    return emptyCursor();
  }
}

/**
 * Held entries read from disk, per segment and seq, keeping only well-formed ones past the answered seq. A cursor
 * written before holds were kept per row has one entry per segment ({seq, reason, …}); it is read as that one row's.
 */
function cleanHeld(raw: unknown, segments: unknown): Record<string, Record<string, HeldEntry>> {
  const out: Record<string, Record<string, HeldEntry>> = {};
  if (!raw || typeof raw !== "object") return out;
  const answered = (rel: string): number => {
    const seg = segments && typeof segments === "object" ? (segments as Record<string, { seq?: unknown } | undefined>)[rel] : undefined;
    return seg && Number.isInteger(seg.seq) ? (seg.seq as number) : 0;
  };
  for (const [rel, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== "object") continue;
    const legacy = Number.isInteger((v as { seq?: unknown }).seq);
    for (const e of legacy ? [v] : Object.values(v as Record<string, unknown>)) {
      const h = e as Partial<HeldEntry> | null;
      if (!h || typeof h !== "object" || !Number.isInteger(h.seq) || h.seq! <= answered(rel) || !HOLD_REASONS.includes(h.reason!)) continue;
      // An accepted row's bytes are kept only when they still hash to their sha256; bytes that do not are dropped, and the
      // entry is read as one that never had them.
      const bytes = h.accepted === true && typeof h.row === "string" && typeof h.row_sha === "string" && v1Sha256(h.row) === h.row_sha && isRowJson(h.row);
      (out[rel] ??= {})[String(h.seq)] = {
        seq: h.seq!, reason: h.reason!, since: typeof h.since === "string" ? h.since : "",
        ...(h.accepted === true ? { accepted: true as const } : {}),
        ...(bytes ? { row: h.row!, row_sha: h.row_sha!, ...(h.withheld === true ? { withheld: true as const } : {}), ...(h.masked === true ? { masked: true as const } : {}) } : {}),
      };
    }
  }
  return out;
}

/** The waiting map as read from disk: a malformed entry is dropped, which only restarts that session's wait. */
function cleanWaiting(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) if (typeof v === "number" && Number.isFinite(v) && v > 0) out[k] = v;
  return out;
}

/** Bytes that parse as one JSON object: what an accepted row's kept bytes must be. */
function isRowJson(text: string): boolean {
  try { const v = JSON.parse(text) as unknown; return !!v && typeof v === "object" && !Array.isArray(v); } catch { return false; }
}

/**
 * Segment entries read from disk, keeping only well-formed ones: a malformed offset or seq drops the entry (the segment
 * is re-read and the server answers its rows duplicate), and a hash that is not sha256 hex is dropped from its entry.
 */
function cleanSegments(raw: unknown): Record<string, SegCursor> {
  const out: Record<string, SegCursor> = {};
  for (const [rel, v] of Object.entries(raw as Record<string, Partial<SegCursor>>)) {
    if (!v || typeof v !== "object" || !Number.isInteger(v.offset) || v.offset! < 0 || !Number.isInteger(v.seq) || v.seq! < 0) continue;
    const unlinked = v.unlinked === true;
    out[rel] = {
      offset: v.offset!, seq: v.seq!,
      ...(v.sealed === true ? { sealed: true } : {}),
      ...(!unlinked && typeof v.hash === "string" && SHA256_HEX.test(v.hash) ? { hash: v.hash } : {}),
      ...(unlinked ? { unlinked: true as const } : {}),
    };
  }
  return out;
}

function writeCursor(path: string, c: ShipCursor): void {
  invariant(c.v === 1 && (c.floor === "" || DATE.test(c.floor)), "a ship cursor has version 1 and a date floor");
  invariant(typeof c.machine === "string" && MACHINE_RE.test(c.machine), "a ship cursor names the machine its chains were shipped under");
  for (const [rel, s] of Object.entries(c.segments)) {
    invariant(Number.isInteger(s.offset) && s.offset >= 0, `cursor offset for ${rel} must be a non-negative integer`);
    invariant(Number.isInteger(s.seq) && s.seq >= 0, `cursor seq for ${rel} must be a non-negative integer`);
    invariant(s.hash === undefined || SHA256_HEX.test(s.hash), `cursor hash for ${rel} must be sha256 hex`);
    invariant(!(s.unlinked && s.hash !== undefined), `cursor for ${rel} keeps no hash for an accepted integrity hold`);
  }
  for (const [rel, rows] of Object.entries(c.held)) {
    for (const [key, h] of Object.entries(rows)) {
      invariant(Number.isInteger(h.seq) && h.seq >= 1 && HOLD_REASONS.includes(h.reason), `held entry for ${rel} needs a seq and a known reason`);
      invariant(key === String(h.seq), `held entry ${rel}#${key} is filed under its own seq`);
      invariant(h.seq > (c.segments[rel]?.seq ?? 0), `held row ${rel}#${h.seq} must be past the answered seq`);
      invariant(h.row === undefined || (h.accepted === true && h.row_sha === v1Sha256(h.row) && isRowJson(h.row)), `held row ${rel}#${h.seq} keeps bytes only for an accept, with their sha256`);
      invariant(h.row !== undefined || (h.row_sha === undefined && h.withheld === undefined && h.masked === undefined), `held row ${rel}#${h.seq} describes no bytes it does not keep`);
    }
  }
  for (const [k, n] of Object.entries(c.counts)) invariant(Number.isInteger(n) && n >= 0, `ship count ${k} must stay a non-negative integer`);
  for (const [k, ms] of Object.entries(c.waiting_since)) invariant(Number.isFinite(ms) && ms > 0, `waiting_since for ${k} must be a time`);
  mkdirSync(resolve(path, ".."), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  writeFileSync(tmp, JSON.stringify(c) + "\n", { mode: 0o600 });
  renameSync(tmp, path);
}

function logRefused(path: string, entry: { chain: string; seq: number; src_id: string; reason: string }): void {
  invariant(typeof entry.reason === "string", "a refused row is logged with its reason");
  mkdirSync(resolve(path, ".."), { recursive: true });
  appendFileSync(path, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n", { mode: 0o600 });
}

/** ship/held.jsonl: one line per new hold, no content (segment, seq, row id, reason). */
function logHeld(path: string, entry: Hold): void {
  invariant(HOLD_REASONS.includes(entry.reason) && Number.isInteger(entry.seq) && entry.seq >= 1, "a held row is logged with its seq and a known reason");
  mkdirSync(resolve(path, ".."), { recursive: true });
  appendFileSync(path, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n", { mode: 0o600 });
}

// ── Machine id and chains ──

const MACHINE_RE = /^[a-z0-9][a-z0-9_.-]{0,63}$/;

async function hmacHex(key: MaskKey, message: string): Promise<string> {
  let k: CryptoKey;
  if (typeof key === "string" || key instanceof Uint8Array) {
    const bytes = typeof key === "string" ? utf8(key) : key;
    if (bytes.length === 0) throw new Error("mask key is empty");
    k = await crypto.subtle.importKey("raw", new Uint8Array(bytes) as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  } else k = key;
  return toHex(new Uint8Array(await crypto.subtle.sign("HMAC", k, new Uint8Array(utf8(message)) as BufferSource)));
}

/** A stable hardware id (macOS IOPlatformUUID, Linux machine-id), or null. Never sent: it only seeds an HMAC. */
function hardwareId(): string | null {
  try {
    if (process.platform === "darwin") {
      const out = execFileSync("/usr/sbin/ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
      const m = /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(out);
      return m ? m[1]! : null;
    }
    for (const p of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
      const v = existsSync(p) ? readFileSync(p, "utf8").trim() : "";
      if (v) return v;
    }
  } catch { /* fall through */ }
  return null;
}

/**
 * This machine's id for chains: the explicit one, else the stored one, else derived as the
 * first 12 hex of HMAC(maskKey, hardware id + record path), so losing the state dir derives
 * the same id again. A random id is the last resort when no hardware id is readable.
 */
export async function machineId(stateDir: string, dir: string, maskKey: MaskKey, opts: { explicit?: string; persist?: boolean; hardwareId?: () => string | null } = {}): Promise<string> {
  if (opts.explicit !== undefined) {
    if (!MACHINE_RE.test(opts.explicit)) throw new Error(`machine id must match ${MACHINE_RE.source}`);
    return opts.explicit;
  }
  const path = join(stateDir, "ship", "machine-id");
  try {
    const stored = readFileSync(path, "utf8").trim();
    if (MACHINE_RE.test(stored)) return stored;
  } catch { /* none yet */ }
  const hw = (opts.hardwareId ?? hardwareId)();
  const seed = hw ? `hw\0${hw}\0${resolve(dir)}` : `random\0${crypto.randomUUID()}`;
  const id = (await hmacHex(maskKey, `statvs-machine\0${seed}`)).slice(0, 12);
  if (opts.persist !== false) {
    invariant(MACHINE_RE.test(id), "a derived machine id is 12 hex");
    mkdirSync(join(stateDir, "ship"), { recursive: true });
    writeFileSync(path, id + "\n", { mode: 0o600 });
  }
  return id;
}

/** The writer a local row ships as: <local writer>@<machine>, so two machines running one hook are two writers. */
export function shipWriter(writer: string, machine: string): string {
  invariant(MACHINE_RE.test(machine), `machine id must match ${MACHINE_RE.source}`);
  return `${writer}@${machine}`;
}

/**
 * The chain a local segment ships under, in the intake's one four-part format:
 * writerSlug(<writer>@<machine>)|<app>|<class>|<day>. The segment file is named by the local
 * writer's slug, and writerSlug works character by character, so the shipped slug is that slug
 * with "@<machine>" slugged onto it. A customer segment's app is "a" + 12 hex of
 * HMAC(maskKey, app), so no chain names a customer.
 */
export async function shipChain(machine: string, rel: string, maskKey: MaskKey): Promise<string> {
  const local = segmentChain(rel);
  invariant(local, `not a segment path: ${rel}`);
  const [slug, app, cls, day] = local.split("|") as [string, string, string, string];
  const appPart = app === "-" ? "-" : `a${(await hmacHex(maskKey, `statvs-chain-app\0${app}`)).slice(0, 12)}`;
  const chain = `${writerSlug(shipWriter(slug, machine))}|${appPart}|${cls}|${day}`;
  invariant(chain.split("|").length === 4, `a shipped chain has four parts: ${chain}`);
  return chain;
}

// ── URL and HTTP ──

/** https anywhere, http only on localhost; no credentials or query in the URL. */
export function normalizeUrl(url: string): string {
  let u: URL;
  try { u = new URL(url); } catch { throw new Error(`STATVS core URL is not a URL: ${url}`); }
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) throw new Error("STATVS core URL must be https (http only on localhost)");
  if (u.username || u.password || u.search) throw new Error("STATVS core URL must carry no credentials or query; the token goes in the Authorization header");
  return u.origin + u.pathname.replace(/\/+$/, "");
}

class NetError extends Error {}

async function request(f: FetchLike, url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  let res: Response;
  try {
    res = await f(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    throw new NetError(`network: ${(e as Error)?.message ?? String(e)}`);
  }
  if (!res.ok) {
    let text = "";
    try { text = (await res.text()).slice(0, 200); } catch { /* none */ }
    throw new NetError(`HTTP ${res.status}${text ? `: ${text}` : ""}`);
  }
  return res;
}

/**
 * The schema the core reports on GET /health (no token needed), or null with why. A core older than v4 reports no
 * `schema` field: it reads as null, the same as an unreachable core, so a rollback never gets a v4 row (ISC-64).
 */
async function coreSchema(f: FetchLike, url: string, timeoutMs: number): Promise<{ schema: number | null; why: string }> {
  let res: Response;
  try { res = await request(f, `${url}/health`, { method: "GET" }, timeoutMs); }
  catch (e) { return { schema: null, why: `the core's /health could not be read (${(e as Error).message})` }; }
  let body: unknown;
  try { body = await res.json(); } catch { return { schema: null, why: "the core's /health answer is not JSON" }; }
  const s = (body as { schema?: unknown } | null)?.schema;
  if (typeof s === "number" && Number.isInteger(s) && s > 0) return { schema: s, why: `the core reports schema ${s}` };
  return { schema: null, why: "the core reports no schema (a core before v4)" };
}

// ── Reading the local record ──

/** Rows of one segment from a byte offset, through record.ts scan() (every other segment pinned at its end). */
function readSegment(dir: string, seg: Segment, from: number, all: Segment[]): { rows: StatvsRow[]; end: number; problems: string[] } {
  const since: Record<string, number> = {};
  for (const s of all) if (s.class === seg.class && s.date >= seg.date && s.rel !== seg.rel) since[s.rel] = Number.MAX_SAFE_INTEGER;
  since[seg.rel] = from;
  const r = scan({ dir, classes: [seg.class], fromDate: seg.date, since });
  const problems = (r.problems ?? []).filter((p) => p.startsWith(`${seg.rel}:`));
  return { rows: r.rows.sort((a, b) => a.seq - b.seq), end: r.offsets[seg.rel] ?? from, problems };
}

function isSeal(r: StatvsRow): boolean {
  return r.stream === "statvs" && r.kind === "seal";
}

function fileSize(p: string): number {
  try { return statSync(p).size; } catch { return -1; }
}

const NULL_HASH = v1Sha256("null");

/** A v1 row's payload object, checked against the row's data_hash as record.ts verify checks it. */
function readObject(dir: string, h: string, dataHash: string): { ok: true; data: unknown } | { ok: false; reason: "object_missing" | "object_unreadable" | "object_hash" } {
  if (!SHA256_HEX.test(h)) return { ok: false, reason: "object_hash" };
  let text: string;
  try {
    text = readFileSync(join(dir, "objects", h.slice(0, 2), `${h}.json`), "utf8");
  } catch (e) {
    return { ok: false, reason: (e as NodeJS.ErrnoException)?.code === "ENOENT" ? "object_missing" : "object_unreadable" };
  }
  if (v1Sha256(text) !== dataHash) return { ok: false, reason: "object_hash" };
  try { return { ok: true, data: JSON.parse(text) }; } catch { return { ok: false, reason: "object_unreadable" }; }
}

/** Ids of every row a redaction tombstone names (stream statvs, kind redact, data.target), read fresh. */
function tombstones(dir: string): Set<string> {
  const out = new Set<string>();
  for (const seg of listSegments(dir, ["system"])) {
    let raw: string;
    try { raw = readFileSync(seg.abs, "utf8"); } catch { continue; }
    if (!raw.includes('"kind":"redact"')) continue;
    for (const line of raw.split("\n")) {
      if (!line.includes('"kind":"redact"')) continue;
      try {
        const r = JSON.parse(line) as StatvsRow;
        const t = r?.stream === "statvs" && r.kind === "redact" && r.data && typeof r.data === "object" ? (r.data as { target?: unknown }).target : undefined;
        if (typeof t === "string") out.add(t);
      } catch { /* a malformed line is verify's to report */ }
    }
  }
  return out;
}

/** The row's own checks, as record.ts verify runs them: hash over every field but hash and data, and data against data_hash. */
function ownCheck(r: StatvsRow, seg: Segment): HoldReason | null {
  const local = segmentChain(seg.rel);
  const [slug, app, cls] = (local ?? "").split("|");
  if (!local || typeof r.writer !== "string" || writerSlug(r.writer) !== slug || r.class !== cls || (cls === "customer" && r.app !== app)) return "wrong_segment";
  const { hash: _h, data: _d, ...rest } = r as unknown as Record<string, unknown>;
  if (typeof r.hash !== "string" || r.hash !== v1RowHash(String(r.prev), rest)) return "row_hash";
  if (r.data !== null && r.data !== undefined && v1Sha256(v1Canonical(r.data)) !== r.data_hash) return "data_hash";
  return null;
}

/**
 * The first row of `rows` (sorted by seq) the shipper cannot vouch for, among those past
 * `c.seq`. A broken link between two rows holds the earlier one when it is not yet sent,
 * since a rewrite that recomputed its own hash shows only as the next row's broken prev.
 */
function firstBad(rows: StatvsRow[], seg: Segment, c: Pick<SegCursor, "seq" | "hash">, opts: { skipFirstLink?: boolean } = {}): { index: number; reason: HoldReason } | null {
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    if (!Number.isInteger(r.seq) || r.seq < 1) return { index: i, reason: "chain_break" };
    if (r.seq <= c.seq) continue;
    const before = i > 0 ? rows[i - 1]! : undefined;
    // After an accepted integrity hold, the link out of the accepted row means nothing; check the rest from there.
    if (opts.skipFirstLink && r.seq === c.seq + 1) {
      const own = ownCheck(r, seg);
      if (own) return { index: i, reason: own };
      continue;
    }
    // A seq gap (a row missing or unreadable before this one) holds this row.
    if (before ? before.seq !== r.seq - 1 : r.seq !== c.seq + 1) return { index: i, reason: "chain_break" };
    let linkOk = true;
    if (r.seq === 1) linkOk = r.prev === "genesis";
    else if (r.seq === c.seq + 1 && c.hash) linkOk = r.prev === c.hash;
    else if (before) linkOk = r.prev === before.hash;
    // else: the row before was answered by a cursor that kept no hash, and is not in this read.
    if (!linkOk) return { index: before && before.seq > c.seq ? i - 1 : i, reason: "chain_break" };
    const own = ownCheck(r, seg);
    if (own) return { index: i, reason: own };
  }
  return null;
}

/** The working directory a row reports, for the consulting-project rule. */
function rowCwd(data: unknown): string | undefined {
  if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
  const d = data as Record<string, unknown>;
  for (const k of ["cwd", "project_dir", "projectDir"]) if (typeof d[k] === "string") return d[k] as string;
  const ws = d.workspace as Record<string, unknown> | undefined;
  return ws && typeof ws.current_dir === "string" ? ws.current_dir : undefined;
}

/**
 * What the provenance rules read of a row: every envelope field it carries (not a chosen few, so a field added later is
 * read too), its payload in place of the inline data, and the cwd it reports lifted to the top.
 */
function rowProbe(v1: StatvsRow, data: unknown): Record<string, unknown> {
  const probe: Record<string, unknown> = { ...(v1 as unknown as Record<string, unknown>), data };
  const cwd = rowCwd(data);
  if (cwd) {
    if (probe.cwd !== undefined && probe.cwd !== cwd) return { ...probe, cwd, data: { payload: data, envelope_cwd: probe.cwd } };
    probe.cwd = cwd;
  }
  return probe;
}

/** A row the provenance rules withhold for its class alone: a v1 row filed as customer never ships its content. */
const CUSTOMER_CLASS = "customer";

/** Each transcript in a projects dir by session id: the folder (an encoded cwd) and the file. Read once per run. */
function transcriptIndex(projectsDir: string): Map<string, { folder: string; file: string }> {
  const out = new Map<string, { folder: string; file: string }>();
  let folders: string[];
  try { folders = readdirSync(projectsDir); } catch { return out; }
  for (const folder of folders) {
    let files: string[];
    try { files = readdirSync(join(projectsDir, folder)); } catch { continue; }
    for (const f of files) if (f.endsWith(".jsonl")) out.set(f.slice(0, -6), { folder, file: join(projectsDir, folder, f) });
  }
  return out;
}

/** Every cwd a transcript's lines report. A line is matched as text, so a torn last line still counts. */
/**
 * When a session first entered a consulting project, from its transcript: the time of the first line whose cwd is a
 * consulting path, or of the last timed line before it when that line has no timestamp (-Infinity when none does, so
 * every row is withheld). undefined when no line names one; null when the transcript cannot be read.
 */
function transcriptSwitch(file: string, config: ProvenanceConfig): number | undefined | null {
  let text: string;
  try { text = readFileSync(file, "utf8"); } catch { return null; }
  let lastMs = -Infinity;
  for (const line of text.split("\n")) {
    const ts = /"timestamp"\s*:\s*"([^"]+)"/.exec(line)?.[1];
    const ms = ts === undefined ? NaN : Date.parse(ts);
    if (Number.isFinite(ms)) lastMs = ms;
    for (const m of line.matchAll(/"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/g)) {
      let cwd: string;
      try { cwd = JSON.parse(`"${m[1]}"`) as string; } catch { cwd = m[1]!; }
      if (isConsultingCwd(cwd, config)) return lastMs;
    }
  }
  return undefined;
}

/**
 * The verdict on one session (principal directive, 2026-10-16, option A): the folder a session started in decides it. A session
 * started in a consulting project (its transcript's project folder) is withheld whole. Any other session is kept up to
 * the first sign it entered a consulting project, from a pending row of it or a transcript line's cwd, and every row
 * from that moment on is withheld, whether or not the row itself names the project. Rows before it are the
 * principal's own work and ship. A session already marked withheld stays withheld. With no consulting evidence but a
 * missing transcript or a row that could not be read, the session waits.
 */
function sessionVerdict(session: string, found: SessionEvidence, rowUnreadable: boolean, cursor: ShipCursor, transcripts: () => Map<string, { folder: string; file: string }>, config: ProvenanceConfig, waitedMs = 0): SessionVerdict {
  const sticky = cursor.withheld_sessions[session];
  if (typeof sticky === "string") return { action: "withhold", reason: "consulting_project" };
  // A switch an earlier run saw stays in force, the earlier of it and anything found now.
  const evidence: SessionEvidence = sticky && (found.fromMs === undefined || sticky.fromMs < found.fromMs) ? { fromMs: sticky.fromMs, reason: "consulting_project" } : found;
  const t = transcripts().get(session);
  if (t && isConsultingFolder(t.folder, config)) return { action: "withhold", reason: "consulting_project" };
  // A session whose transcript can never arrive would wait forever and stop its segment there (2026-10-22: a test
  // row stopped 306 turn rows for 4 days). Withholding it is the fail-closed answer, and the rows after it ship.
  if (!t && evidence.fromMs === undefined && (!CLAUDE_SESSION_RE.test(session) || waitedMs >= TRANSCRIPT_WAIT_MS)) return { action: "withhold", reason: "uninspectable" };
  // Without the transcript the starting folder is unknown, and an unreadable row could hold anything: consulting
  // evidence then withholds the session whole (fail closed), and without evidence it waits.
  const unknown = (): SessionVerdict => (evidence.fromMs !== undefined ? { action: "withhold", reason: evidence.reason ?? "consulting_project" } : { action: "wait" });
  if (rowUnreadable || !t) return unknown();
  const switched = transcriptSwitch(t.file, config);
  if (switched === null) return unknown();
  const fromMs = Math.min(evidence.fromMs ?? Infinity, switched ?? Infinity);
  if (fromMs === Infinity) return { action: "keep" };
  return { action: "keep", fromMs, reason: evidence.fromMs !== undefined && evidence.fromMs <= (switched ?? Infinity) ? evidence.reason ?? "consulting_project" : "consulting_project" };
}

/** A Claude Code session id; anything else (a bridge or test fixture name) never has a transcript under projects/. */
const CLAUDE_SESSION_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** How long a Claude Code session's rows wait for its transcript before the session counts as uninspectable. */
const TRANSCRIPT_WAIT_MS = 24 * 3_600_000;

/** What the cursor keeps about a withheld session: a date for a whole-session withhold, or when a partial one began. */
type WithheldSession = string | { at: string; fromMs: number };

/** The withheld-sessions map as read from disk: anything malformed reads as withheld whole (fail closed). */
function cleanWithheld(raw: unknown): Record<string, WithheldSession> {
  const out: Record<string, WithheldSession> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [s, d] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof d === "string") out[s] = d;
    else if (d && typeof d === "object" && typeof (d as { at?: unknown }).at === "string" && Number.isFinite((d as { fromMs?: unknown }).fromMs)) out[s] = { at: (d as { at: string }).at, fromMs: (d as { fromMs: number }).fromMs };
    else out[s] = "9999-12-31"; // never ages out
  }
  return out;
}

/** Consulting evidence found in a session's pending rows: the earliest such row's time and its reason. */
type SessionEvidence = { fromMs?: number; reason?: WithholdReason };

/** Whether a verdict withholds this row, and why: a whole-session withhold, or a kept session past its switch time. A row whose time cannot be read counts as past it. */
function withheldBy(verdict: SessionVerdict | undefined, ts: unknown): WithholdReason | undefined {
  if (verdict?.action === "withhold") return verdict.reason;
  if (verdict?.action !== "keep" || verdict.fromMs === undefined) return undefined;
  const ms = typeof ts === "string" ? Date.parse(ts) : NaN;
  return !Number.isFinite(ms) || ms >= verdict.fromMs ? verdict.reason : undefined;
}

// ── Converting a row ──

/** What the run decided about a session before shipping any row of it. */
type SessionVerdict = { action: "keep"; fromMs?: number; reason?: WithholdReason } | { action: "withhold"; reason: WithholdReason } | { action: "wait" };

interface PrepareCtx {
  /** The chain this segment ships under (shipChain). */
  chain: string;
  /** The machine every shipped writer carries. */
  machine: string;
  /** The verdict on every session a pending row of this run names. */
  sessions: Map<string, SessionVerdict>;
  /** Redaction tombstone targets, read once per run and only when a payload is missing. */
  tombstones: () => Set<string>;
}

/** A content-free stand-in for a row that failed an integrity check and was accepted: where it sat, its id and why. */
async function integrityMarker(v1: StatvsRow, seg: Segment, chain: string, machine: string, reason: HoldReason): Promise<CoreRow> {
  const slug = (segmentChain(seg.rel) ?? "unknown").split("|")[0]!;
  return finalizeRow({
    chain,
    seq: v1.seq,
    ts: typeof v1.ts === "string" && Number.isFinite(Date.parse(v1.ts)) ? v1.ts : `${seg.date}T00:00:00.000Z`,
    ts_basis: "stated",
    // A local slug turns back into its writer: local writers have no "@", so every "_" in it was a ":".
    writer: shipWriter(typeof v1.writer === "string" && writerSlug(v1.writer) === slug ? v1.writer : slug.replace(/_/g, ":"), machine),
    stream: "statvs",
    kind: "integrity-failed",
    data: { source: `statvs:${typeof v1.id === "string" && /^s[0-9a-f]{24}$/.test(v1.id) ? v1.id : "unknown"}`, reason },
  });
}

/** A content-free stand-in for a row of a stream that never leaves the machine: its id and stream, nothing else. */
async function localOnlyMarker(v1: StatvsRow, chain: string, machine: string): Promise<CoreRow> {
  return finalizeRow({
    chain,
    seq: v1.seq,
    ts: v1.ts,
    ts_basis: "stated",
    writer: shipWriter(v1.writer, machine),
    stream: "statvs",
    kind: "local-only",
    data: { source: `statvs:${v1.id}`, stream: v1.stream },
  });
}

/**
 * Convert one checked row, or say why it is held. `accepted` is the hold reason the operator
 * accepted for this row: an integrity hold becomes a marker, a payload hold ships without its
 * payload, flagged body-missing.
 */
async function prepare(v1: StatvsRow, seg: Segment, dir: string, opts: ShipOptions, ctx: PrepareCtx, accepted?: HoldReason): Promise<Prepared | { hold: HoldReason } | { wait: string }> {
  const integrity = accepted !== undefined && INTEGRITY_HOLDS.includes(accepted);
  // Only an integrity hold can carry a malformed local hash; every other row passed ownCheck, which recomputes it.
  invariant(integrity || (typeof v1.hash === "string" && SHA256_HEX.test(v1.hash)), `${seg.rel}#${v1.seq} reached prepare unchecked`);
  // A row too large to send passed every check: its marker keeps the row's hash, so the next row is checked by its link.
  const common = { rel: seg.rel, seq: v1.seq, sealed: isSeal(v1) === true, srcId: typeof v1.id === "string" ? v1.id : "unknown", unlinked: integrity, ...(integrity ? {} : { v1Hash: v1.hash }) };
  if (accepted !== undefined && MARKER_HOLDS.includes(accepted)) {
    return { ...common, row: await integrityMarker(v1, seg, ctx.chain, ctx.machine, accepted!), withheld: false, masked: false, accepted: true };
  }
  if (!(opts.shipStream ?? streamShips)(v1.stream)) {
    return { ...common, row: await localOnlyMarker(v1, ctx.chain, ctx.machine), withheld: true, masked: false, accepted: accepted !== undefined };
  }
  const verdict = v1.session ? ctx.sessions.get(v1.session) : undefined;
  invariant(!v1.session || verdict !== undefined, `session of ${seg.rel}#${v1.seq} was decided before shipping`);
  if (verdict?.action === "wait") return { wait: v1.session! };
  let data: unknown = v1.data;
  let bodyMissing = false;
  // An accepted payload hold always ships flagged body-missing, even if the payload came back since: a resend after a
  // crash must be the same row the first attempt sent, or the server would refuse it as a collision.
  if (accepted !== undefined) bodyMissing = true;
  else if (v1.obj !== undefined) {
    const o = readObject(dir, v1.obj, v1.data_hash);
    if (o.ok) data = o.data;
    else if (o.reason === "object_missing" && ctx.tombstones().has(v1.id)) data = null; // redacted: the object went with its tombstone
    else return { hold: o.reason };
  } else if ((v1.data === null || v1.data === undefined) && v1.data_hash !== NULL_HASH && !ctx.tombstones().has(v1.id)) {
    return { hold: "scrubbed_no_tombstone" };
  }
  if (bodyMissing) data = undefined;

  const base = fromV1(v1, seg.rel);
  base.chain = ctx.chain;
  base.writer = shipWriter(v1.writer, ctx.machine);
  const sessionWithhold = withheldBy(verdict, v1.ts);
  const decision = sessionWithhold !== undefined
    ? { action: "withhold" as const, reason: sessionWithhold }
    : v1.class === CUSTOMER_CLASS
      ? { action: "withhold" as const, reason: "customer_class" as const }
      : decide(rowProbe(v1, data), opts.provenance);
  if (decision.action === "withhold") {
    // A session-scoped withhold here would mean the pre-pass missed it; it ran this same rule on this same row.
    invariant(!v1.session || sessionWithhold !== undefined || !("scope" in decision) || decision.scope !== "session", `session of ${seg.rel}#${v1.seq} was kept, yet its row names a consulting project`);
    const row = await withheldMarker(`statvs:${v1.id}`, 1, decision.reason, { writer: base.writer, chain: ctx.chain, seq: base.seq, ts: v1.ts });
    return { ...common, row, withheld: true, masked: false, accepted: accepted !== undefined };
  }

  const fields: RowFields = { ...base };
  delete fields.title; delete fields.ref; delete fields.data; delete fields.body; delete fields.data_hash;
  const m = await mask({ title: v1.title, ref: v1.ref, data: bodyMissing || data === null || data === undefined ? undefined : data }, opts.maskKey, { exact: opts.ownSecrets });
  const out = m.value as { title?: string; ref?: string; data?: unknown };
  if (out.title !== undefined) fields.title = out.title;
  if (out.ref !== undefined) fields.ref = out.ref;
  if (out.data !== undefined) fields.data = out.data;
  else fields.data_hash = v1.data_hash; // redacted, null, or accepted as lost: the hash stands for it
  if (bodyMissing) fields.flags = [...(fields.flags ?? []), "body-missing"];
  if (m.masked.length > 0) fields.masked = m.masked;
  const ext = await externalizeBody(fields);
  const row = await finalizeRow(ext.fields);
  return { ...common, row, body: ext.body, withheld: false, masked: m.masked.length > 0, accepted: accepted !== undefined };
}

// ── Shipping ──

function emptyResult(): ShipResult {
  return { ok: true, pending: 0, sent: 0, stored: 0, duplicate: 0, refused: 0, withheld: 0, masked: 0, bodies: 0, segments: 0, held: 0, holds: [], accepted: 0, waiting: 0, stopped: [] };
}

/** The exact bytes of the POST /rows body for n rows whose JSON sizes sum to `sum`: {"rows":[a,b,…]}. */
export const requestBytes = (n: number, sum: number): number => 11 + sum + Math.max(0, n - 1);
/** One row's bytes inside the request body, serialized exactly as sendBatch serializes it. */
const rowJsonBytes = (row: CoreRow): number => utf8(JSON.stringify(row)).length;

/**
 * prepare(), then the size check: a row whose request alone is over the intake's limit can never be sent, so it is held
 * (row_too_large) instead of queued, where it would fail every run and jam the shipper. An accepted row that is still too
 * large ships as the row_too_large marker, the same bytes every run, so a resend after a crash stays a duplicate.
 */
async function prepareSized(v1: StatvsRow, seg: Segment, dir: string, opts: ShipOptions, ctx: PrepareCtx, accepted?: HoldReason): Promise<Prepared | { hold: HoldReason } | { wait: string }> {
  const got = await prepare(v1, seg, dir, opts, ctx, accepted);
  if ("hold" in got || "wait" in got || requestBytes(1, rowJsonBytes(got.row)) <= MAX_BATCH_BYTES) return got;
  if (accepted === undefined) return { hold: "row_too_large" };
  const marker = await prepare(v1, seg, dir, opts, ctx, "row_too_large");
  invariant(!("hold" in marker) && !("wait" in marker) && requestBytes(1, rowJsonBytes(marker.row)) <= MAX_BATCH_BYTES, `the row_too_large marker of ${seg.rel}#${v1.seq} fits a request`);
  return marker;
}

/** Send one batch: bodies first, then the rows. Returns the server's answers keyed chain#seq, or throws NetError. */
async function sendBatch(f: FetchLike, url: string, token: string, batch: Prepared[], timeoutMs: number, uploaded: Set<string>): Promise<{ answers: Map<string, Answer>; checkpoint?: { size: number; root: string }; bodies: number }> {
  const auth = { Authorization: `Bearer ${token}` };
  let bodies = 0;
  for (const p of batch) {
    if (!p.body || uploaded.has(p.body.sha256)) continue;
    await request(f, `${url}/bodies/${p.body.sha256}`, { method: "PUT", headers: { ...auth, "Content-Type": "application/json" }, body: utf8(p.body.text) as BodyInit }, timeoutMs);
    uploaded.add(p.body.sha256);
    bodies++;
  }
  // Byte for byte what JSON.stringify({ rows }) writes, with each row as its fixed bytes: an accepted row replays exactly.
  const body = `{"rows":[${batch.map(rowText).join(",")}]}`;
  // The queue is cut to fit and a row no request can carry is held, so an oversized request is an impossible state.
  invariant(utf8(body).length <= MAX_BATCH_BYTES, `a POST /rows body is at most ${MAX_BATCH_BYTES} bytes (got ${utf8(body).length})`);
  const res = await request(f, `${url}/rows`, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body }, timeoutMs);
  let json: { results?: unknown; checkpoint?: unknown };
  try { json = await res.json() as typeof json; } catch { throw new NetError("core answered with something that is not JSON"); }
  if (!Array.isArray(json.results)) throw new NetError("core answer has no results");
  const answers = new Map<string, Answer>();
  for (const a of json.results as Answer[]) {
    if (!a || typeof a.chain !== "string" || !Number.isInteger(a.seq) || !["stored", "duplicate", "refused"].includes(a.status)) throw new NetError("core answer holds a malformed result");
    answers.set(`${a.chain}#${a.seq}`, a);
  }
  for (const p of batch) if (!answers.has(`${p.row.chain}#${p.row.seq}`)) throw new NetError(`core answer is missing ${p.row.chain}#${p.row.seq}`);
  const cp = json.checkpoint as { size?: unknown; root?: unknown } | undefined;
  const checkpoint = cp && Number.isInteger(cp.size) && typeof cp.root === "string" ? { size: cp.size as number, root: cp.root } : undefined;
  return { answers, checkpoint, bodies };
}

/**
 * The floor after a run: the oldest date holding a segment that is not finished (answered to its
 * end and sealed), never past yesterday. Every segment at or above the old floor counts, read or
 * not, so a run cut short by maxRows never lets an unread segment fall below the floor.
 */
function nextFloor(cursor: ShipCursor, considered: Segment[], sizes: Map<string, number>, today: string): string {
  const yesterday = utcDate(Date.parse(`${today}T00:00:00Z`) - DAY_MS);
  let floor = yesterday;
  for (const s of considered) {
    const c = cursor.segments[s.rel];
    const done = c !== undefined && c.sealed === true && sizes.get(s.rel) === c.offset;
    if (!done && s.date < floor) floor = s.date;
  }
  return floor < cursor.floor ? cursor.floor : floor;
}

/**
 * Ship every local row the core has not answered yet. Never throws for network or server
 * failures: they come back as { ok: false, error } with the cursor at the last answered row.
 */
export async function ship(opts: ShipOptions): Promise<ShipResult> {
  const result = emptyResult();
  const dry = opts.dryRun === true;
  if (!dry && (!opts.url || !opts.token)) return { ...result, ok: false, error: "STATVS_CORE_URL and STATVS_CORE_TOKEN are not both set; nothing shipped" };
  const url = opts.url ? normalizeUrl(opts.url) : "";
  const f = opts.fetch ?? (globalThis.fetch as FetchLike);
  const dir = resolve(opts.dir ?? statvsDir());
  const stateDir = resolve(opts.stateDir ?? statvsStateDir());
  const batchRows = Math.min(opts.batchRows ?? MAX_BATCH_ROWS, MAX_BATCH_ROWS);
  const batchBytes = Math.min(opts.batchBytes ?? DEFAULT_BATCH_BYTES, MAX_BATCH_BYTES);
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const now = opts.now ?? Date.now;
  const log = opts.log ?? (() => {});
  const cPath = dry ? "" : await cursorPath(stateDir, url);
  const refusedPath = join(stateDir, "ship", "refused.jsonl");
  const heldPath = join(stateDir, "ship", "held.jsonl");
  const cursor = dry ? emptyCursor() : readCursor(cPath);
  const today = utcDate(now());

  // The machine every chain is named under: the cursor's, so chains never split mid-history.
  if (opts.machine !== undefined && cursor.machine !== undefined && opts.machine !== cursor.machine) {
    return { ...result, ok: false, error: `machine id ${opts.machine} differs from the ${cursor.machine} this cursor shipped under; chains would split` };
  }
  try {
    cursor.machine ??= await machineId(stateDir, dir, opts.maskKey, { explicit: opts.machine, persist: !dry, hardwareId: opts.hardwareId });
  } catch (e) {
    if (e instanceof InvariantViolation) throw e;
    return { ...result, ok: false, error: (e as Error).message };
  }
  const machine = cursor.machine;
  result.machine = machine;
  const idFile = join(stateDir, "ship", "machine-id");
  if (!dry && !existsSync(idFile)) {
    invariant(MACHINE_RE.test(machine), "the stored machine id is valid");
    mkdirSync(join(stateDir, "ship"), { recursive: true });
    writeFileSync(idFile, machine + "\n", { mode: 0o600 });
  }
  const chains = new Map<string, string>();
  const chainOf = async (rel: string): Promise<string> => {
    let ch = chains.get(rel);
    if (ch === undefined) { ch = await shipChain(machine, rel, opts.maskKey); chains.set(rel, ch); }
    return ch;
  };
  let tomb: Set<string> | null = null;
  const tombstoneSet = () => (tomb ??= tombstones(dir));
  // Asked once per run, and only when a v4 row is about to be queued: a run with no such row never calls /health.
  let schemaAnswer: Promise<{ schema: number | null; why: string }> | null = null;
  const coreTakesV4 = async (): Promise<{ ok: boolean; schema: number | null; why: string }> => {
    if (dry) return { ok: true, schema: null, why: "dry run" };
    const a = await (schemaAnswer ??= coreSchema(f, url, timeoutMs));
    return { ok: a.schema !== null && a.schema >= V4_SCHEMA, ...a };
  };

  /** Note a held row: in the result always; logged and kept in the cursor once per (segment, seq, reason). */
  const noteHold = (rel: string, v1: StatvsRow, reason: HoldReason, accepted: boolean, resumed = false, restored = false): void => {
    invariant(!restored || (accepted && resumed), "only a resent accepted row can find its defect gone");
    const hold: Hold = { segment: rel, seq: v1.seq, src_id: typeof v1.id === "string" ? v1.id : "unknown", reason, ...(accepted ? { accepted: true } : {}), ...(restored ? { restored: true } : {}) };
    result.holds.push(hold);
    if (accepted) result.accepted++; else result.held++;
    if (dry) return;
    const prev = cursor.held[rel]?.[String(v1.seq)];
    if (accepted && resumed && restored) {
      // The accept binds: the row goes out as the accepted bytes, so the payload that came back is not shipped with it.
      // It is recorded, never dropped in silence: the operator recovers it from the local record.
      logHeld(heldPath, hold);
      log(`resending accepted held row ${rel}#${v1.seq} (${reason}) as accepted, though its defect is gone since; the restored row did not ship, recover it by hand from the local record`);
    } else if (accepted && resumed) {
      log(`resending accepted held row ${rel}#${v1.seq} (${reason}); a run before this one died before its answer was kept`);
    } else if (accepted) {
      // Durable before the row is sent: if this run dies after the upload, the next one resends the same row.
      (cursor.held[rel] ??= {})[String(v1.seq)] = { seq: v1.seq, reason, since: today, accepted: true };
      writeCursor(cPath, cursor);
      logHeld(heldPath, hold);
      log(`accepted held row ${rel}#${v1.seq} (${reason})`);
    } else if (!prev || prev.reason !== reason) {
      (cursor.held[rel] ??= {})[String(v1.seq)] = { seq: v1.seq, reason, since: today };
      logHeld(heldPath, hold);
      log(reason === "row_too_large"
        ? `held ${rel}#${v1.seq}: row_too_large; the row alone is over the intake's ${MAX_BATCH_BYTES}-byte request limit, so it is never sent; accept it to ship a content-free marker in its place`
        : `held ${rel}#${v1.seq}: ${reason}; the segment waits here until it is fixed or accepted`);
    }
  };

  /**
   * Fix an accepted row's bytes in the cursor before it is sent: every later resend replays exactly these bytes. An
   * accepted row never carries a body (a lost payload ships without one, a marker has none), so the row is all of it.
   */
  const keepBytes = (rel: string, seq: number, reason: HoldReason, p: Prepared): void => {
    if (dry) return;
    invariant(p.body === undefined, `an accepted row carries no body (${rel}#${seq})`);
    const e = cursor.held[rel]?.[String(seq)];
    invariant(e?.accepted === true && e.reason === reason, `bytes are kept only for a recorded accept (${rel}#${seq})`);
    const json = rowText(p);
    cursor.held[rel]![String(seq)] = { seq, reason, since: e.since, accepted: true, row: json, row_sha: v1Sha256(json), ...(p.withheld ? { withheld: true as const } : {}), ...(p.masked ? { masked: true as const } : {}) };
    writeCursor(cPath, cursor);
  };

  /** An accepted row rebuilt from the bytes its accept fixed; the link fields come from the local row as it is now. */
  const replayOf = (h: HeldEntry, v1: StatvsRow, seg: Segment, chain: string): Prepared => {
    const row = JSON.parse(h.row!) as CoreRow;
    invariant(row.chain === chain && row.seq === v1.seq, `kept bytes of ${seg.rel}#${v1.seq} are for that row's place`);
    const unlinked = INTEGRITY_HOLDS.includes(h.reason) || !(typeof v1.hash === "string" && SHA256_HEX.test(v1.hash));
    return {
      rel: seg.rel, seq: v1.seq, sealed: isSeal(v1) === true, srcId: typeof v1.id === "string" ? v1.id : "unknown", unlinked, ...(unlinked ? {} : { v1Hash: v1.hash }),
      row, json: h.row!, withheld: h.withheld === true, masked: h.masked === true, accepted: true,
    };
  };

  // Forget withheld sessions after a month; a session does not run that long.
  const cutoff = utcDate(now() - WITHHELD_SESSION_DAYS * DAY_MS);
  for (const [s, d] of Object.entries(cursor.withheld_sessions)) if ((typeof d === "string" ? d : d.at) < cutoff) delete cursor.withheld_sessions[s];

  const all = listSegments(dir);
  const sizes = new Map<string, number>();
  const dates = new Map<string, string>();
  for (const s of all) dates.set(s.rel, s.date);
  const considered = all.filter((s) => s.date >= cursor.floor || cursor.segments[s.rel] !== undefined);
  const todo = considered
    .filter((s) => {
      const size = fileSize(s.abs);
      sizes.set(s.rel, size);
      const c = cursor.segments[s.rel];
      return size > 0 && (!c || size !== c.offset);
    })
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.rel < b.rel ? -1 : 1));

  const uploaded = new Set<string>();
  let queue: Prepared[] = [];
  let queueBytes = 0;
  const maxRows = opts.maxRows ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(maxRows) || maxRows < 1) return { ...result, ok: false, error: `maxRows must be a positive integer (got ${String(opts.maxRows)})` };
  let answered = 0;
  // Segments stopped this run at a curable refusal: nothing more of them is sent until the next run.
  const stoppedSegs = new Set<string>();

  const flush = async (): Promise<boolean> => {
    if (queue.length === 0) return true;
    const batch = queue;
    queue = [];
    queueBytes = 0;
    invariant(answered + batch.length <= maxRows, `a run sends at most maxRows rows (${answered} + ${batch.length} > ${maxRows})`);
    if (dry) {
      answered += batch.length;
      result.sample ??= [];
      for (const p of batch) if (result.sample.length < 5) result.sample.push(p.row);
      result.withheld += batch.filter((p) => p.withheld).length;
      result.masked += batch.filter((p) => p.masked).length;
      result.bodies += batch.filter((p) => p.body).length;
      return true;
    }
    result.sent += batch.length;
    let sent: Awaited<ReturnType<typeof sendBatch>>;
    try {
      sent = await sendBatch(f, url, opts.token!, batch, timeoutMs, uploaded);
    } catch (e) {
      if (!(e instanceof NetError)) throw e;
      result.ok = false;
      result.error = e.message;
      log(`ship stopped: ${e.message}; cursor stays at the last answered row`);
      return false;
    }
    result.bodies += sent.bodies;
    if (sent.checkpoint) result.checkpoint = sent.checkpoint;
    for (const p of batch) {
      const a = sent.answers.get(`${p.row.chain}#${p.row.seq}`)!;
      if (a.status === "stored") { result.stored++; cursor.counts.stored++; }
      else if (a.status === "duplicate") { result.duplicate++; cursor.counts.duplicate++; }
      else {
        const reason = a.reason ?? "no reason given";
        result.refused++;
        cursor.counts.refused++;
        logRefused(refusedPath, { chain: p.row.chain, seq: p.row.seq, src_id: p.srcId, reason });
        if (FINAL_REFUSALS.includes(reason)) log(`refused ${p.row.chain}#${p.row.seq}: ${reason}`);
        else if (!stoppedSegs.has(p.rel)) {
          stoppedSegs.add(p.rel);
          result.stopped.push({ segment: p.rel, seq: p.seq, reason });
          log(`refused ${p.row.chain}#${p.row.seq}: ${reason}; a code fix can cure that, so ${p.rel} stops here and the next run resends it`);
        }
      }
      // A segment stopped at a curable refusal keeps its cursor there: the rows after it in this batch are resent with it.
      if (stoppedSegs.has(p.rel)) continue;
      if (a.status !== "refused" && p.withheld) { result.withheld++; cursor.counts.withheld++; }
      if (p.masked) result.masked++;
      const c = cursor.segments[p.rel] ?? { offset: 0, seq: 0 };
      invariant(p.seq > c.seq, `answers for ${p.rel} arrive in seq order (${p.seq} after ${c.seq})`);
      c.seq = p.seq;
      c.sealed = p.sealed;
      if (p.unlinked) { delete c.hash; c.unlinked = true; }
      else { c.hash = p.v1Hash; delete c.unlinked; }
      if (p.end !== undefined) c.offset = p.end;
      cursor.segments[p.rel] = c;
      const held = cursor.held[p.rel];
      if (held) {
        for (const [key, h] of Object.entries(held)) if (h.seq <= c.seq) delete held[key];
        if (Object.keys(held).length === 0) delete cursor.held[p.rel];
      }
    }
    answered += batch.length;
    writeCursor(cPath, cursor);
    return true;
  };

  // Read every pending segment before anything is sent, so each session's provenance is decided
  // from all of its pending rows, in any segment and across any batch boundary.
  const reads = new Map<string, ReturnType<typeof readSegment>>();
  const rowEvidence = new Map<string, SessionEvidence>();
  // Sessions with a pending row whose payload could not be read: what it says is unknown, so the session waits.
  const unreadable = new Set<string>();
  for (const seg of todo) {
    const c = cursor.segments[seg.rel] ?? { offset: 0, seq: 0 };
    const size = sizes.get(seg.rel)!;
    let read = readSegment(dir, seg, c.offset <= size ? c.offset : 0, all);
    const first = read.rows.find((r) => r.seq > c.seq);
    // The offset no longer lines up (a redaction rewrote the segment shorter, or a torn read): re-read it whole; seq skips what is done.
    if (c.offset > 0 && (read.problems.length > 0 || (first && first.seq !== c.seq + 1) || c.offset > size)) read = readSegment(dir, seg, 0, all);
    reads.set(seg.rel, read);
    for (const r of read.rows) {
      if (r.seq <= c.seq || typeof r.session !== "string" || !r.session) continue;
      let data: unknown = r.data;
      if (r.obj !== undefined) {
        const o = readObject(dir, r.obj, r.data_hash);
        if (o.ok) data = o.data;
        else if (o.reason === "object_missing" && tombstoneSet().has(r.id)) data = null; // redacted: nothing left to read
        else { data = undefined; unreadable.add(r.session); }
      } else if ((r.data === null || r.data === undefined) && r.data_hash !== NULL_HASH && !tombstoneSet().has(r.id)) {
        unreadable.add(r.session); // scrubbed with no tombstone: its content was there and cannot be checked
      }
      // The envelope is still read: a consulting cwd or tenant in it withholds the session, which outranks waiting.
      const d = decide(rowProbe(r, data), opts.provenance);
      const prior = rowEvidence.get(r.session) ?? {};
      if (d.action === "withhold" && d.scope === "session") {
        const ms = typeof r.ts === "string" && Number.isFinite(Date.parse(r.ts)) ? Date.parse(r.ts) : -Infinity;
        if (prior.fromMs === undefined || ms < prior.fromMs) rowEvidence.set(r.session, { fromMs: ms, reason: d.reason });
        else rowEvidence.set(r.session, prior);
      } else rowEvidence.set(r.session, prior);
    }
  }
  let transcripts: Map<string, { folder: string; file: string }> | null = null;
  const projectsDir = resolve(opts.projectsDir ?? join(getClaudeDir(), "projects"));
  const transcriptsOf = () => (transcripts ??= transcriptIndex(projectsDir));
  const sessions = new Map<string, SessionVerdict>();
  for (const [session, evidence] of rowEvidence) {
    const firstSeen = cursor.waiting_since[session] ?? now();
    const v = sessionVerdict(session, evidence, unreadable.has(session), cursor, transcriptsOf, opts.provenance, now() - firstSeen);
    sessions.set(session, v);
    if (v.action === "wait") cursor.waiting_since[session] = firstSeen;
    else delete cursor.waiting_since[session];
    // Once a session has entered a consulting project, every later run withholds the rest of it. An uninspectable
    // verdict is recomputed each run instead, so a transcript that turns up later decides the session's later rows;
    // rows already sent as withheld markers stay markers in the cloud, and their full rows stay in the local record.
    const prior = cursor.withheld_sessions[session];
    if ((v.action === "withhold" && v.reason !== "uninspectable") || (v.action === "keep" && v.fromMs === -Infinity)) cursor.withheld_sessions[session] = typeof prior === "string" ? prior : today;
    else if (v.action === "keep" && v.fromMs !== undefined && typeof prior !== "string") cursor.withheld_sessions[session] = { at: prior?.at ?? today, fromMs: Math.min(v.fromMs, prior?.fromMs ?? Infinity) };
  }

  for (const seg of todo) {
    if (answered >= maxRows) break;
    const c = cursor.segments[seg.rel] ?? { offset: 0, seq: 0 };
    const read = reads.get(seg.rel)!;
    const rows = read.rows.filter((r) => r.seq > c.seq);
    if (rows.length === 0) {
      if (!dry && read.end !== c.offset && read.problems.length === 0) { c.offset = read.end; cursor.segments[seg.rel] = c; writeCursor(cPath, cursor); }
      continue;
    }
    result.segments++;
    result.pending += rows.length;
    const ctx: PrepareCtx = { chain: await chainOf(seg.rel), machine, sessions, tombstones: tombstoneSet };
    let bad = firstBad(read.rows, seg, c, { skipFirstLink: c.unlinked === true });
    for (let i = 0; i < rows.length; i++) {
      if (stoppedSegs.has(seg.rel)) break;
      const v1 = rows[i]!;
      const badHere = bad !== null && read.rows[bad.index] === v1;
      let got = badHere ? { hold: bad!.reason } : await prepareSized(v1, seg, dir, opts, ctx);
      // An accept the cursor kept for this row binds it, whatever became of the defect since: a run that died after the
      // upload resends exactly the accepted bytes, so the server answers duplicate, never collision.
      const prior = cursor.held[seg.rel]?.[String(v1.seq)];
      const bound = prior?.accepted === true ? prior.reason : undefined;
      if (bound !== undefined) {
        // A row that now converts cleanly, or is held for another reason, is no longer the defect the operator accepted.
        // An undecided session says nothing about the defect; an accepted payload hold waits on it below as before.
        const defectGone = !("wait" in got) && (!("hold" in got) || got.hold !== bound);
        // The local row as it is now, under the accept: to compare with the kept bytes, and to let an exclusion that now
        // withholds the row win. A payload accept on a row whose own hash is now malformed cannot be built under its payload
        // reason; it is built under the integrity hold it fails now, a content-free marker.
        const buildable = MARKER_HOLDS.includes(bound) || (typeof v1.hash === "string" && SHA256_HEX.test(v1.hash));
        invariant(buildable || ("hold" in got && INTEGRITY_HOLDS.includes(got.hold)), `a row with a malformed hash is held for it (${seg.rel}#${v1.seq})`);
        const fresh = await prepareSized(v1, seg, dir, opts, ctx, buildable ? bound : (got as { hold: HoldReason }).hold);
        if ("wait" in fresh) {
          result.waiting++;
          log(`waiting ${seg.rel}#${v1.seq}: its session's provenance is undecided, so the accepted row it holds waits too`);
          break;
        }
        invariant(!("hold" in fresh), `an accepted hold ships (${seg.rel}#${v1.seq})`);
        const kept = prior!.row !== undefined ? replayOf(prior!, v1, seg, ctx.chain) : undefined;
        const keptCarriesContent = kept !== undefined && !kept.withheld && kept.row.kind !== "integrity-failed";
        const verdictNow = v1.session ? ctx.sessions.get(v1.session) : undefined;
        const excludedNow = fresh.withheld || (!buildable && (withheldBy(verdictNow, v1.ts) !== undefined || v1.class === CUSTOMER_CLASS));
        let restored: boolean;
        if (kept === undefined) {
          // No bytes were kept, so none was sent (or the entry predates them): build it now and keep its bytes first.
          got = fresh;
          restored = defectGone;
          keepBytes(seg.rel, v1.seq, bound, got);
        } else if (keptCarriesContent && excludedNow) {
          // Exclusion fails closed: content the record now withholds is never resent. The content-free row goes instead; if
          // the first send landed, the core refuses it as a collision and the refusal is logged.
          got = fresh;
          restored = true;
          log(`accepted held row ${seg.rel}#${v1.seq} is now withheld by provenance; its kept bytes carry content, so a content-free row is sent in their place`);
          keepBytes(seg.rel, v1.seq, bound, got);
        } else {
          // The accept binds: the kept bytes go out exactly. A local row repaired since is recorded as restored.
          got = kept;
          restored = defectGone || rowText(fresh) !== kept.json;
        }
        noteHold(seg.rel, v1, bound, true, true, restored);
        // The rows after it are checked from here: on their own after an unlinked row, by their link to this row otherwise.
        if (got.unlinked) bad = firstBad(read.rows, seg, { seq: v1.seq }, { skipFirstLink: true });
        else if (badHere) bad = firstBad(read.rows, seg, { seq: v1.seq, hash: v1.hash }, {});
      } else if ("wait" in got) {
        // Provenance undecided: the segment stops here, unsent; acceptHeld never ships it.
        result.waiting++;
        log(`waiting ${seg.rel}#${v1.seq}: its session has no transcript under ${projectsDir} yet, or a row of it cannot be read, so its provenance is undecided`);
        break;
      }
      if ("hold" in got) {
        const reason = got.hold;
        const accept = opts.acceptHeld === true && Number.isInteger(v1.seq) && v1.seq >= 1;
        noteHold(seg.rel, v1, reason, accept);
        if (!accept) break; // the segment stops here; nothing after it is sent or skipped
        got = await prepareSized(v1, seg, dir, opts, ctx, reason);
        if ("wait" in got) { result.waiting++; break; }
        invariant(!("hold" in got), `an accepted hold ships (${seg.rel}#${v1.seq})`);
        keepBytes(seg.rel, v1.seq, reason, got); // fixed before the send: a crash after the upload replays these bytes
        if (INTEGRITY_HOLDS.includes(reason)) bad = firstBad(read.rows, seg, { seq: v1.seq }, { skipFirstLink: true });
      }
      // A row that names a RES ships as v4, which only a v4 core reads. Against an older core (a rollback) the segment
      // holds here, unsent and undropped, so the chain stays gapless and the next run against a v4 core sends it (ISC-64).
      if (got.row.v >= V4_SCHEMA) {
        const gate = await coreTakesV4();
        if (!gate.ok) {
          (result.schemaHeld ??= []).push({ segment: seg.rel, seq: v1.seq, core: gate.schema, reason: gate.why });
          log(`held ${seg.rel}#${v1.seq}: it names a RES, so it ships as v4, and ${gate.why}; the segment waits here until the core takes v4`);
          break;
        }
      }
      const p = got;
      if (i === rows.length - 1 && read.problems.length === 0) p.end = read.end;
      // The budget is the exact request body, envelope and commas included. A row over batchBytes that still fits the
      // intake's limit goes out in a request of its own; prepareSized held any row that fits no request at all.
      const bytes = utf8(rowText(p)).length;
      if (queue.length > 0 && (queue.length >= batchRows || requestBytes(queue.length + 1, queueBytes + bytes) > batchBytes)) {
        if (!(await flush())) return result;
        if (answered >= maxRows || stoppedSegs.has(seg.rel)) break;
      }
      queue.push(p);
      queueBytes += bytes;
      // The run's row budget is spent: send what is queued and stop, the cursor exactly on the last answered row.
      if (answered + queue.length >= maxRows) {
        if (!(await flush())) return result;
        break;
      }
    }
  }
  if (!(await flush())) return result;

  if (!dry) {
    cursor.floor = nextFloor(cursor, considered, sizes, today);
    for (const rel of Object.keys(cursor.segments)) {
      const date = dates.get(rel) ?? "";
      if (DATE.test(date) && date < cursor.floor) delete cursor.segments[rel];
      else if (!dates.has(rel)) delete cursor.segments[rel]; // the segment is gone from the record
    }
    for (const rel of Object.keys(cursor.held)) if (!dates.has(rel) || (dates.get(rel)! < cursor.floor)) delete cursor.held[rel];
    writeCursor(cPath, cursor);
  }
  return result;
}

/** Load the provenance config file; throws with the path when it is missing or invalid. */
export function loadProvenanceFile(path: string, parse: (raw: unknown) => ProvenanceConfig): ProvenanceConfig {
  if (!existsSync(path)) throw new Error(`provenance config not found at ${path}; the shipper will not run without customer exclusion`);
  return parse(JSON.parse(readFileSync(path, "utf8")));
}
