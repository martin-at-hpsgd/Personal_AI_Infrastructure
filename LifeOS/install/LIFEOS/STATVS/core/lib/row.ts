/**
 * STATVS core — the row contract every lane shares (schema v4), plus the reader that
 * parses every schema version ever written into one shape.
 *
 * A CoreRow is identified by (chain, seq): the writer chain and the sequence number its
 * origin assigned, gapless from 1, so a missing number is a visible gap (ISC-15). `data` is
 * the masked payload inline; when its canonical JSON passes 4096 bytes it is stored once
 * by sha256 as a body and the row carries `body` (= data_hash) instead.
 *
 * A v3 row commits to its content only through two hashes: `data_hash` for the payload and
 * `content_hash` for the text fields (app, kind, severity, title, session, ref). `hash` is
 * sha256 of the canonical JSON of the row without `hash`, the payload and the text fields,
 * and the Merkle leaf is built the same way, so the erasure route can clear the payload or
 * the text fields of a row and every hash and checkpoint still verifies (ISC-66, ISC-163).
 * Each group is cleared whole. A v2 row's hash covered everything but `hash`; v2 rows were
 * written before 2026-10-17 and still read and verify as written.
 *
 * A v4 row is a v3 row that also names the RES it is about (CENSVS ISA F4): `subject` ("<kind>:<key>", kind from
 * GENERA) and, when it changes that RES, `op` (create, set, move, link, unlink, observe, retire). The subject is in the
 * text group, so `content_hash` commits to it and the erasure route clears it with the title: a subject is meant to
 * carry no personal content, but a key guard is a filter and can miss a spelling, and a permanent record must be able
 * to take back what slipped through. `op` stays in the committed row, covered by `hash` and the Merkle leaf: it is one
 * word from a closed list and carries nothing personal, so an erased v4 row keeps its op and loses its subject. finalizeRow writes v4 only for a row that carries a subject, and v3 for every other row, so
 * a row with no subject hashes exactly as it did before v4 and a resend of it is still a duplicate. Ingest fields (shard,
 * offset, ingested_at) are added by the sequencer and are never part of any hash.
 *
 * A row shipped from the local v1 record keeps that record's identity: its chain is the
 * local segment it was written to and its seq is that segment's seq. The local layout is
 * <class>/<UTC date>/<writer-slug>.jsonl (customer rows add <app>/), so the chain uses
 * the writer slug, the app only for customer segments ("-" otherwise), and the segment's
 * date, taken from its path. The row's `ts` can be earlier than the write (a
 * caller-stated time, or a spooled row drained after midnight), and a seal row is written
 * into the previous day's segment, so keying on `ts` would split one gapless segment
 * across chains and report false gaps.
 *
 * Pure: WebCrypto only, no node:fs, so the Worker bundle can import it.
 *
 * @version 0.1.0
 */

import type { StatvsRow } from "../../lib/types";
import { canonicalJson, sha256Hex, SHA256_HEX, utf8 } from "./canonical.ts";
import { isOp, parseSubject, type Op } from "./subject.ts";

class InvariantViolation extends Error {
  constructor(message: string) { super(`INVARIANT VIOLATION: ${message}`); this.name = "InvariantViolation"; }
}
function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new InvariantViolation(message);
}

// ── Types ──

/** The newest schema written: v4 for a row that names a subject, v3 for every other row (see finalizeRow). */
export const SCHEMA_VERSION = 4 as const;
/** Canonical JSON longer than this many bytes is stored as a body, not inline (ISC-16). */
export const bodyThreshold = 4096;

export type TsBasis = "stated" | "inferred";
export const TS_BASES: readonly TsBasis[] = ["stated", "inferred"] as const;

export interface RowSource {
  id?: string;
  hash?: string;
  imported_from?: string;
  imported_at?: string;
}

export interface CoreRow {
  /** 4 for a row written now that names a subject, 3 for every other; 2 for a row stored before schema v3, read as written. */
  v: 2 | 3 | 4;
  chain: string;
  seq: number;
  /** ISO time the thing happened. */
  ts: string;
  ts_basis: TsBasis;
  writer: string;
  stream: string;
  /** v4: the RES this row is about, "<kind>:<key>". In the text group: content_hash commits to it and erasure clears it. */
  subject?: string;
  /** v4: how the row changes its subject. Only with a subject. */
  op?: Op;
  app?: string;
  kind?: string;
  severity?: string;
  title?: string;
  session?: string;
  ref?: string;
  /** Masked inline JSON; absent when body is set. */
  data?: unknown;
  /** sha256 hex of the stored body; equals data_hash. */
  body?: string;
  /** sha256 hex of the canonical masked data. */
  data_hash: string;
  /** v3: sha256 hex of the canonical JSON of the text fields present (app, kind, severity, title, session, ref). */
  content_hash?: string;
  /** JSON paths that were masked. */
  masked?: string[];
  flags?: string[];
  src?: RowSource;
  /** sha256 hex of the canonical JSON of the row without hash. */
  hash: string;
}

export type Ingested = CoreRow & { shard: string; offset: number; ingested_at: string };

/** What a caller supplies to finalizeRow: everything but v and the hashes; data_hash only when data is not inline. */
export type RowFields = Omit<CoreRow, "v" | "data_hash" | "content_hash" | "hash"> & { data_hash?: string };

/** One shape for every schema version: a v2, v3 or v4 row as written, or a v1 row read through fromV1. v2 and v3 rows carry no subject. */
export interface NormalizedRow extends Omit<CoreRow, "v"> {
  v: 1 | 2 | 3 | 4;
  /** The v1 row id, or chain#seq for v2 and later. */
  id: string;
  /** v1 only: the privacy class, hybrid logical clock and chain predecessor of the local row. */
  class?: string;
  hlc?: string;
  prev?: string;
  /** Present once the row has been ingested. */
  shard?: string;
  offset?: number;
  ingested_at?: string;
}

export type ParseResult = { ok: true; row: NormalizedRow } | { ok: false; reason: string };

/** Field order a v2 row is written in. */
const KEY_ORDER = ["v", "chain", "seq", "ts", "ts_basis", "writer", "stream", "subject", "op", "app", "kind", "severity", "title", "session", "ref", "data", "body", "data_hash", "content_hash", "masked", "flags", "src", "hash"] as const;
const INGEST_KEYS = ["shard", "offset", "ingested_at"] as const;
/**
 * The text fields: optional on every row, and from v3 on the group content_hash commits to and the erasure route may
 * clear. `subject` is one of them (CENSVS ISA ISC-60); only a v4 row carries it, so v3 hashes are unchanged.
 */
export const TEXT_FIELDS = ["app", "kind", "severity", "title", "session", "ref", "subject"] as const;
const OPTIONAL_STRINGS = ["app", "kind", "severity", "title", "session", "ref"] as const;
const HLC = /^(\d{13})\.(\d{4})$/;

// ── Build and verify ──

function isTime(ts: unknown): ts is string {
  return typeof ts === "string" && ts.length > 0 && Number.isFinite(Date.parse(ts));
}

/** A row without its ingest fields and, from v3 on, without the content its hashes commit to. */
function committed(row: Record<string, unknown>): Record<string, unknown> {
  const rest: Record<string, unknown> = { ...row };
  for (const k of INGEST_KEYS) delete rest[k];
  if (rest.v === 3 || rest.v === 4) { delete rest.data; for (const k of TEXT_FIELDS) delete rest[k]; }
  return rest;
}

/** The canonical JSON a row's hash is taken over: the committed row without `hash`. */
function hashInput(row: Record<string, unknown>): string {
  const rest = committed(row);
  delete rest.hash;
  return canonicalJson(rest);
}

/** The bytes a row's Merkle leaf is taken over: the committed row, hash included, so erasure never moves a leaf. */
export function leafInput(row: CoreRow | Ingested | Record<string, unknown>): Uint8Array {
  return utf8(canonicalJson(committed(row as Record<string, unknown>)));
}

/** sha256 of the canonical JSON of the text fields a row carries (an empty object when it carries none). */
export async function contentHash(row: Partial<Record<(typeof TEXT_FIELDS)[number], unknown>>): Promise<string> {
  const text: Record<string, unknown> = {};
  for (const k of TEXT_FIELDS) if (row[k] !== undefined) text[k] = row[k];
  return sha256Hex(canonicalJson(text));
}

/** Does this payload's canonical JSON pass the body threshold? */
export function needsBody(data: unknown): boolean {
  return utf8(canonicalJson(data)).length > bodyThreshold;
}

/**
 * Move inline data to a body when it passes the threshold. Returns the fields to finalize
 * and, when moved, the body to PUT (its sha256 and canonical text). Fields under the
 * threshold come back unchanged.
 */
export async function externalizeBody(fields: RowFields): Promise<{ fields: RowFields; body?: { sha256: string; text: string } }> {
  if (fields.data === undefined || !needsBody(fields.data)) return { fields };
  const text = canonicalJson(fields.data);
  const sha = await sha256Hex(text);
  const { data: _d, ...rest } = fields;
  return { fields: { ...rest, body: sha, data_hash: sha }, body: { sha256: sha, text } };
}

/** Compute data_hash and hash and return the row in its written field order. */
export async function finalizeRow(fields: RowFields): Promise<CoreRow> {
  invariant(typeof fields.chain === "string" && fields.chain.length > 0, "a row needs a chain");
  invariant(Number.isInteger(fields.seq) && fields.seq >= 1, `seq must be a positive integer (got ${String(fields.seq)})`);
  invariant(isTime(fields.ts), `ts must be a parseable time (got ${String(fields.ts)})`);
  invariant(TS_BASES.includes(fields.ts_basis), `ts_basis must be stated or inferred (got ${String(fields.ts_basis)})`);
  invariant(typeof fields.writer === "string" && fields.writer.length > 0, "a row needs a writer");
  invariant(typeof fields.stream === "string" && fields.stream.length > 0, "a row needs a stream");
  invariant(fields.data === undefined || fields.body === undefined, "a row holds data inline or a body, never both");
  invariant(fields.subject === undefined || parseSubject(fields.subject) !== null, `subject must be <kind>:<key> (got ${String(fields.subject).slice(0, 80)})`);
  invariant(fields.op === undefined || isOp(fields.op), `op must be one of create, set, move, link, unlink, observe, retire (got ${String(fields.op)})`);
  invariant(fields.op === undefined || fields.subject !== undefined, "an op changes a subject, so a row with an op needs one");
  let dataHash: string;
  if (fields.data !== undefined) {
    dataHash = await sha256Hex(canonicalJson(fields.data));
  } else {
    invariant(typeof fields.data_hash === "string" && SHA256_HEX.test(fields.data_hash), "a row without inline data needs its data_hash");
    dataHash = fields.data_hash;
  }
  if (fields.body !== undefined) {
    invariant(SHA256_HEX.test(fields.body), "body must be a sha256 hex");
    invariant(fields.body === dataHash, "a body is stored by the sha256 of its bytes, so body must equal data_hash");
  }
  const src: Record<string, unknown> | undefined = fields.src
    ? Object.fromEntries(Object.entries(fields.src).filter(([, v]) => v !== undefined))
    : undefined;
  // v4 only when the row names a subject: a row without one stays v3, byte for byte what it was before v4.
  const v = fields.subject !== undefined ? 4 : 3;
  const draft: Record<string, unknown> = { ...fields, v, data_hash: dataHash, content_hash: await contentHash(fields) };
  if (src && Object.keys(src).length > 0) draft.src = src; else delete draft.src;
  if (!fields.masked || fields.masked.length === 0) delete draft.masked;
  if (!fields.flags || fields.flags.length === 0) delete draft.flags;
  const row: Record<string, unknown> = {};
  for (const k of KEY_ORDER) if (k !== "hash" && draft[k] !== undefined) row[k] = draft[k];
  row.hash = await sha256Hex(hashInput(row));
  return row as unknown as CoreRow;
}

/**
 * Does the row's hash match, and does the content it carries match the hashes that commit to it? Ingest fields are
 * ignored. A v3 row whose payload or text fields were cleared by the erasure route still verifies.
 */
export async function verifyRowHash(row: CoreRow | Ingested): Promise<boolean> {
  const r = row as unknown as Record<string, unknown>;
  if (typeof r.hash !== "string" || typeof r.data_hash !== "string") return false;
  if (r.data !== undefined && r.body !== undefined) return false;
  if (r.body !== undefined && r.body !== r.data_hash) return false;
  if (r.data !== undefined && (await sha256Hex(canonicalJson(r.data))) !== r.data_hash) return false;
  if (r.v === 3 || r.v === 4) {
    if (typeof r.content_hash !== "string") return false;
    if (TEXT_FIELDS.some((k) => r[k] !== undefined) && (await contentHash(r)) !== r.content_hash) return false;
  } else if (r.content_hash !== undefined) return false;
  return (await sha256Hex(hashInput(r))) === r.hash;
}

// ── v1 rows ──

/**
 * A writer name: letters, digits, ".", ":" and "-", then an optional "@machine" (the shipper's machine id). Every
 * writer in the local record fits it (63 of 63 on 2026-10-17), and intake refuses any other.
 */
export const WRITER_RE = /^[A-Za-z0-9.:-]+(?:@[a-z0-9][a-z0-9_.-]{0,63})?$/;

/**
 * The writer slug a chain and a local segment file are named by: ":" becomes "_" and "@" becomes "~". On a writer
 * that fits WRITER_RE no two writers share a slug (no "_" before the "~", no ":" after it), so no writer can take
 * another's chain by a name that slugs the same. For a local writer, which has no "@", it is the slug
 * lib/record.ts names segment files by.
 */
export function writerSlug(writer: string): string {
  return writer.replace(/[^A-Za-z0-9_.-]/g, (c) => (c === "@" ? "~" : "_"));
}

/** UTC write date of a v1 row, from its hybrid logical clock. */
function hlcDay(hlc: string): string {
  const m = HLC.exec(hlc);
  invariant(m, `malformed hlc: ${hlc}`);
  return new Date(Number(m[1])).toISOString().slice(0, 10);
}

const SEGMENT = /^(?:(public|system|personal)|customer\/([^/]+))\/(\d{4}-\d{2}-\d{2})\/([A-Za-z0-9_.-]+)\.jsonl$/;

/** The chain a local segment path (relative to the record dir, "/"-separated) names, or null when it is not a segment path. */
export function segmentChain(rel: string): string | null {
  const m = SEGMENT.exec(rel);
  if (!m) return null;
  const [, cls, app, day, slug] = m;
  return cls ? `${slug}|-|${cls}|${day}` : `${slug}|${app}|customer|${day}`;
}

/**
 * The chain of a v1 row: its local segment identity, writer-slug|app-or-"-"|class|day.
 * Pass the segment path the row was read from whenever it is known: that is the exact
 * identity. Without it the day is the row's hlc write date, which is right for every row
 * but a seal (written into the previous day's segment after midnight) and an append that
 * landed in a not-yet-sealed previous-day segment just after midnight.
 */
export function chainKey(v1: Pick<StatvsRow, "writer" | "app" | "class" | "hlc">, segment?: string): string {
  const slug = writerSlug(v1.writer);
  if (segment !== undefined) {
    const chain = segmentChain(segment);
    invariant(chain, `not a segment path: ${segment}`);
    const [segSlug, segApp, segClass] = chain.split("|");
    invariant(segSlug === slug && segClass === v1.class && (segClass !== "customer" || segApp === v1.app), `row ${slug}/${v1.class} does not belong to segment ${segment}`);
    return chain;
  }
  const app = v1.class === "customer" ? (v1.app ?? "-") : "-";
  return `${slug}|${app}|${v1.class}|${hlcDay(v1.hlc)}`;
}

/**
 * The v2 fields of a row from the local v1 record (pass its segment path when known; see
 * chainKey). data passes through unmasked for the caller to mask; a v1 row whose payload
 * lives in objects/ gets body = its obj hash, and a row whose data was scrubbed (data
 * null) keeps its data_hash with no inline data.
 */
export function fromV1(v1: StatvsRow, segment?: string): RowFields {
  const f: RowFields = {
    chain: chainKey(v1, segment),
    seq: v1.seq,
    ts: v1.ts,
    ts_basis: "stated",
    writer: v1.writer,
    stream: v1.stream,
    src: { id: v1.id, hash: v1.hash },
  };
  for (const k of OPTIONAL_STRINGS) if (v1[k] !== undefined) f[k] = v1[k];
  // A local row that names its RES (CENSVS F3) ships it: subject and op travel as written.
  const named = v1 as StatvsRow & { subject?: unknown; op?: unknown };
  if (typeof named.subject === "string") f.subject = named.subject;
  if (typeof named.op === "string") f.op = named.op as Op;
  if (v1.obj !== undefined) {
    f.body = v1.obj;
    f.data_hash = v1.data_hash;
  } else if (v1.data === null || v1.data === undefined) {
    f.data_hash = v1.data_hash;
  } else {
    f.data = v1.data;
  }
  if (v1.flags && v1.flags.length > 0) f.flags = [...v1.flags];
  return f;
}

// ── Reader ──

function str(o: Record<string, unknown>, k: string): boolean {
  return typeof o[k] === "string" && (o[k] as string).length > 0;
}

function v1Problem(o: Record<string, unknown>): string | null {
  for (const k of ["id", "ts", "writer", "stream", "class", "prev"]) if (!str(o, k)) return `v1 row: ${k} missing`;
  if (!Number.isInteger(o.seq) || (o.seq as number) < 1) return "v1 row: seq must be a positive integer";
  if (typeof o.hlc !== "string" || !HLC.test(o.hlc)) return "v1 row: malformed hlc";
  if (typeof o.data_hash !== "string" || !SHA256_HEX.test(o.data_hash)) return "v1 row: data_hash must be sha256 hex";
  if (typeof o.hash !== "string" || !SHA256_HEX.test(o.hash)) return "v1 row: hash must be sha256 hex";
  if (o.obj !== undefined && (typeof o.obj !== "string" || !SHA256_HEX.test(o.obj))) return "v1 row: obj must be sha256 hex";
  return null;
}

function coreProblem(o: Record<string, unknown>): string | null {
  const v = `v${String(o.v)} row`;
  for (const k of ["chain", "ts", "writer", "stream"]) if (!str(o, k)) return `${v}: ${k} missing`;
  if (!Number.isInteger(o.seq) || (o.seq as number) < 1) return `${v}: seq must be a positive integer`;
  if (!isTime(o.ts)) return `${v}: ts is not a time`;
  if (!TS_BASES.includes(o.ts_basis as TsBasis)) return `${v}: ts_basis must be stated or inferred`;
  if (typeof o.data_hash !== "string" || !SHA256_HEX.test(o.data_hash)) return `${v}: data_hash must be sha256 hex`;
  if ((o.v === 3 || o.v === 4) && (typeof o.content_hash !== "string" || !SHA256_HEX.test(o.content_hash))) return `${v}: content_hash must be sha256 hex`;
  if (o.v === 4) {
    // A v4 row is written only with a subject (finalizeRow), and intake refuses one without; a stored v4 row lacks one
    // only after the erasure route cleared its text group, so here a subject, when present, must parse.
    if (o.subject !== undefined && parseSubject(o.subject) === null) return `${v}: subject must be <kind>:<key>`;
    if (o.op !== undefined && !isOp(o.op)) return `${v}: op must be one of create, set, move, link, unlink, observe, retire`;
  } else if (o.subject !== undefined || o.op !== undefined) return `${v}: subject and op are v4 fields`;
  if (o.v === 2 && o.content_hash !== undefined) return `${v}: content_hash is a v3 field`;
  if (typeof o.hash !== "string" || !SHA256_HEX.test(o.hash)) return `${v}: hash must be sha256 hex`;
  if (o.body !== undefined && (typeof o.body !== "string" || !SHA256_HEX.test(o.body))) return `${v}: body must be sha256 hex`;
  if (o.body !== undefined && o.data !== undefined) return `${v}: data and body both set`;
  for (const k of ["masked", "flags"]) if (o[k] !== undefined && !(Array.isArray(o[k]) && (o[k] as unknown[]).every((x) => typeof x === "string"))) return `${v}: ${k} must be an array of strings`;
  if (o.offset !== undefined && !(Number.isInteger(o.offset) && (o.offset as number) >= 0)) return `${v}: offset must be a non-negative integer`;
  if (o.shard !== undefined && !str(o, "shard")) return `${v}: shard must be a string`;
  return null;
}

/**
 * Parse a row of any schema version ever written (a JSON line or an object) into one shape.
 * For a v1 row, `segment` is the local segment path it was read from (see chainKey).
 */
export function parseAnyRow(input: string | unknown, segment?: string): ParseResult {
  let o: unknown = input;
  if (typeof input === "string") {
    try { o = JSON.parse(input); } catch (e) { return { ok: false, reason: `not JSON: ${(e as Error).message}` }; }
  }
  if (!o || typeof o !== "object" || Array.isArray(o)) return { ok: false, reason: "not a row object" };
  const r = o as Record<string, unknown>;
  if (r.v === 1) {
    const p = v1Problem(r);
    if (p) return { ok: false, reason: p };
    const v1 = r as unknown as StatvsRow;
    if (segment !== undefined) {
      const chain = segmentChain(segment);
      if (!chain) return { ok: false, reason: `not a segment path: ${segment}` };
      const [s, a, c] = chain.split("|");
      if (s !== writerSlug(v1.writer) || c !== v1.class || (c === "customer" && a !== v1.app)) return { ok: false, reason: `v1 row does not belong to segment ${segment}` };
    }
    const f = fromV1(v1, segment);
    const row: NormalizedRow = { ...f, v: 1, id: v1.id, data_hash: v1.data_hash, hash: v1.hash, class: v1.class, hlc: v1.hlc, prev: v1.prev };
    if (v1.data === null && v1.obj === undefined) row.data = null;
    return { ok: true, row };
  }
  if (r.v === 2 || r.v === 3 || r.v === 4) {
    const p = coreProblem(r);
    if (p) return { ok: false, reason: p };
    const core = r as unknown as CoreRow & Partial<Ingested>;
    return { ok: true, row: { ...core, id: `${core.chain}#${core.seq}` } };
  }
  return { ok: false, reason: `unknown schema version: ${String(r.v)}` };
}

// ── Gaps ──

/** The sequence numbers missing from a chain, from 1 up to the highest seen (or `upTo`, when the chain's length is known). */
export function gaps(seqs: Iterable<number>, upTo?: number): number[] {
  const seen = new Set<number>();
  let max = 0;
  for (const s of seqs) if (Number.isInteger(s) && s >= 1) { seen.add(s); if (s > max) max = s; }
  const end = upTo !== undefined && upTo > max ? upTo : max;
  const missing: number[] = [];
  for (let i = 1; i <= end; i++) if (!seen.has(i)) missing.push(i);
  return missing;
}

/** Missing seqs per chain, for chains with any. */
export function gapsByChain(rows: Iterable<{ chain: string; seq: number }>): Record<string, number[]> {
  const by = new Map<string, number[]>();
  for (const r of rows) {
    const list = by.get(r.chain) ?? [];
    list.push(r.seq);
    by.set(r.chain, list);
  }
  const out: Record<string, number[]> = {};
  for (const [chain, seqs] of by) {
    const missing = gaps(seqs);
    if (missing.length > 0) out[chain] = missing;
  }
  return out;
}

// ── Display order ──

type Sortable = { ts: string; ts_basis?: TsBasis; offset?: number; chain?: string; seq?: number };

/** Order by when a row happened; ties by ingest offset, then chain and seq. Unparseable times sort last. */
export function compareByTs(a: Sortable, b: Sortable): number {
  const ta = Date.parse(a.ts), tb = Date.parse(b.ts);
  const fa = Number.isFinite(ta), fb = Number.isFinite(tb);
  if (fa !== fb) return fa ? -1 : 1;
  if (fa && ta !== tb) return ta - tb;
  const oa = a.offset ?? Number.MAX_SAFE_INTEGER, ob = b.offset ?? Number.MAX_SAFE_INTEGER;
  if (oa !== ob) return oa - ob;
  const ca = a.chain ?? "", cb = b.chain ?? "";
  if (ca !== cb) return ca < cb ? -1 : 1;
  return (a.seq ?? 0) - (b.seq ?? 0);
}

/** A new array in display order (by ts); each row is returned as is, ts_basis included. */
export function sortForDisplay<T extends Sortable>(rows: readonly T[]): T[] {
  return [...rows].sort(compareByTs);
}
