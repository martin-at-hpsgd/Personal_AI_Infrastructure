/**
 * STATVS core index store — routes index rows to the D1 databases for their event month and
 * merges one query across every month database as if they were one (ISC-61).
 *
 * Each configured month has one or more D1 bindings: IDX_YYYY_MM is its first part and
 * IDX_YYYY_MM_<n> (n >= 2) are rollover parts, keyed here as "YYYY-MM" and "YYYY-MM/<n>". A row
 * goes to its UTC month of `ts`; a month with no database goes to the nearest configured month
 * (ties go to the earlier one) and the entry records its own month in `routed_from`. Within a
 * month a row goes to the first part still under INDEX_DB_CAP_BYTES, 80% of D1's 10 GB cap; a
 * part is measured before every chunk written to it, and when every part of a month is at the
 * cap the write fails loudly (the record is intact and the index catches up once a part is
 * added). A query reads every part of every month its window routes to.
 *
 * Results merge by ingest offset by default: views fold by ingest offset (ISC-75), so a page
 * from three databases equals the page one database holding every row would return. Time
 * queries can merge by when a row happened instead (ISC-54), ties by ingest offset, with a
 * cursor of "<ts_ms>:<offset>". A row that rollover left in two parts is returned once.
 *
 * Each entry carries its row's class (the third field of its chain), so a reader can be scoped
 * by stream and by class (ISC-49), and the RES the row is about (CENSVS ISA F4): the subject a v4 row
 * names, else the one lib/subject.ts deriveSubject() reads from an older row, so GET /rows?subject=
 * returns a RES's rows in ingest order. A derived subject lives only here, in this rebuildable view.
 *
 * Pure: no node: imports. The same entry builder and insert statement serve the live
 * sequencer and the rebuild tool, so a rebuilt index is the live index byte for byte (ISC-8).
 *
 * @version 0.1.0
 */
import type { Ingested } from "../../lib/row";
import { indexSubject } from "../../lib/subject";

class InvariantViolation extends Error {
  constructor(message: string) { super(`INVARIANT VIOLATION: ${message}`); this.name = "InvariantViolation"; }
}
function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new InvariantViolation(message);
}

// ── D1 shape ──

export type D1Result<T> = { results: T[]; meta?: { changes?: number; duration?: number; size_after?: number } };
export interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<D1Result<T>>;
  run(): Promise<D1Result<never>>;
}
export interface D1Like {
  prepare(sql: string): D1Statement;
  batch?(statements: D1Statement[]): Promise<unknown[]>;
}

/** D1 caps a database at 10 GB; no index database is written past 80% of it (ISC-61). */
export const D1_MAX_BYTES = 10_000_000_000;
export const INDEX_DB_CAP_BYTES = Math.floor(D1_MAX_BYTES * 0.8);

// ── Months and parts ──

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const BINDING = /^IDX_(\d{4})_(0[1-9]|1[0-2])(?:_([1-9]\d*))?$/;
const KEY = /^(\d{4}-(?:0[1-9]|1[0-2]))(?:\/([1-9]\d*))?$/;
const CLASS = /^[a-z][a-z0-9_-]{0,31}$/;

/** "YYYY-MM" of a time, in UTC. */
export function monthOfMs(ms: number): string {
  return new Date(ms).toISOString().slice(0, 7);
}

function monthNumber(month: string): number {
  return Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1;
}

/** The month and part of an index database key ("YYYY-MM" is part 1, "YYYY-MM/<n>" part n). */
export function parseDbKey(key: string): { month: string; part: number } {
  const m = KEY.exec(key);
  invariant(m, `not an index database key: ${key}`);
  return { month: m[1]!, part: m[2] ? Number(m[2]) : 1 };
}

/** The key of a month's part. */
export const dbKey = (month: string, part: number) => (part === 1 ? month : `${month}/${part}`);

function compareKeys(a: string, b: string): number {
  const x = parseDbKey(a), y = parseDbKey(b);
  return x.month !== y.month ? (x.month < y.month ? -1 : 1) : x.part - y.part;
}

/** The configured month databases in env, keyed "YYYY-MM" or "YYYY-MM/<n>", from its IDX_* bindings, in month then part order. */
export function indexDatabases(env: Record<string, unknown>): Map<string, D1Like> {
  const out = new Map<string, D1Like>();
  for (const [key, value] of Object.entries(env)) {
    const m = BINDING.exec(key);
    if (!m || !value || typeof (value as D1Like).prepare !== "function") continue;
    const part = m[3] ? Number(m[3]) : 1;
    if (part === 1 && m[3]) continue; // IDX_YYYY_MM_1 is not a name; part 1 is IDX_YYYY_MM
    out.set(dbKey(`${m[1]}-${m[2]}`, part), value as D1Like);
  }
  return new Map([...out.entries()].sort(([a], [b]) => compareKeys(a, b)));
}

/** The distinct months among database keys, sorted. */
export function monthsOf(keys: Iterable<string>): string[] {
  return [...new Set([...keys].map((k) => parseDbKey(k).month))].sort();
}

/** The keys of one month's parts, in part order. */
function partsOf(keys: readonly string[], month: string): string[] {
  return keys.filter((k) => parseDbKey(k).month === month).sort(compareKeys);
}

/** The configured month a row of `month` is indexed in: itself when configured, else the nearest (ties to the earlier). */
export function routeMonth(month: string, configured: readonly string[]): string {
  invariant(MONTH.test(month), `not a month: ${month}`);
  invariant(configured.length > 0, "no index month is configured");
  if (configured.includes(month)) return month;
  const n = monthNumber(month);
  let best = configured[0]!;
  let bestDist = Math.abs(monthNumber(best) - n);
  for (const c of configured) {
    const d = Math.abs(monthNumber(c) - n);
    if (d < bestDist || (d === bestDist && c < best)) { best = c; bestDist = d; }
  }
  return best;
}

/** The class of a chain (writer|app|class|day), or null when the chain is not in that shape. */
export function chainClass(chain: string): string | null {
  const parts = chain.split("|");
  return parts.length === 4 && CLASS.test(parts[2]!) ? parts[2]! : null;
}

// ── Entries ──

/** One index row: the queryable envelope of an ingested row plus where it lives. */
export interface IndexEntry {
  shard: string;
  ingest_offset: number;
  chain: string;
  seq: number;
  ts: string;
  ts_ms: number;
  ts_basis: string;
  writer: string;
  stream: string;
  class: string | null;
  app: string | null;
  kind: string | null;
  severity: string | null;
  title: string | null;
  session: string | null;
  ref: string | null;
  body: string | null;
  hash: string;
  ingested_at: string;
  segment: string;
  month: string;
  routed_from: string | null;
  /** The RES the row is about: the subject it names (v4) or the one derived from it. */
  subject: string | null;
  /** The op a v4 row names; null otherwise. */
  op: string | null;
}

/** Column order of the rows table; INSERT_SQL binds in this order. */
export const INDEX_COLUMNS = [
  "shard", "ingest_offset", "chain", "seq", "ts", "ts_ms", "ts_basis", "writer", "stream", "class", "app", "kind", "severity",
  "title", "session", "ref", "body", "hash", "ingested_at", "segment", "month", "routed_from", "subject", "op",
] as const satisfies readonly (keyof IndexEntry)[];

export const INSERT_SQL = `INSERT OR IGNORE INTO rows (${INDEX_COLUMNS.join(", ")}) VALUES (${INDEX_COLUMNS.map(() => "?").join(", ")})`;

/** The index entry for an ingested row stored in `segment`, routed among the configured months. */
export function indexEntry(row: Ingested, segment: string, configured: readonly string[]): IndexEntry {
  const tsMs = Date.parse(row.ts);
  invariant(Number.isFinite(tsMs), `row ${row.chain}#${row.seq} has an unparseable ts`);
  const own = monthOfMs(tsMs);
  const month = routeMonth(own, configured);
  return {
    shard: row.shard,
    ingest_offset: row.offset,
    chain: row.chain,
    seq: row.seq,
    ts: row.ts,
    ts_ms: tsMs,
    ts_basis: row.ts_basis,
    writer: row.writer,
    stream: row.stream,
    class: chainClass(row.chain),
    app: row.app ?? null,
    kind: row.kind ?? null,
    severity: row.severity ?? null,
    title: row.title ?? null,
    session: row.session ?? null,
    ref: row.ref ?? null,
    body: row.body ?? null,
    hash: row.hash,
    ingested_at: row.ingested_at,
    segment,
    month,
    routed_from: month === own ? null : own,
    subject: indexSubject(row),
    op: row.op ?? null,
  };
}

/** The bind values of an entry, in INDEX_COLUMNS order. */
export function entryBinds(e: IndexEntry): (string | number | null)[] {
  return INDEX_COLUMNS.map((c) => e[c]);
}

const BATCH = 50;

/**
 * The size in bytes of a database, from D1's own meta.size_after, else SQLite's page count.
 * Null when neither is available: a write never goes into a database it cannot measure.
 */
export async function databaseSize(db: D1Like): Promise<number | null> {
  try {
    const r = await db.prepare("SELECT 1").run();
    if (typeof r.meta?.size_after === "number") return r.meta.size_after;
  } catch { /* fall through to the pragma */ }
  try {
    const r = await db.prepare("SELECT page_count * page_size AS n FROM pragma_page_count(), pragma_page_size()").first<{ n: number }>();
    if (r && typeof r.n === "number") return r.n;
  } catch { /* unmeasurable */ }
  return null;
}

/** An error the sequencer treats as index lag: the record is intact and the index catches up later. */
export class IndexFullError extends Error {}

/** Entries written to a part per measurement; the live writer and the rebuild both write in chunks of this size. */
export const INDEX_CHUNK = BATCH;

/** Room a chunk needs: its bound values, tripled for the row and its index entries. */
export function chunkReserve(chunk: readonly IndexEntry[]): number {
  return chunk.reduce((n, e) => n + JSON.stringify(entryBinds(e)).length, 0) * 3;
}

/**
 * The first part, from index `from` on, whose measured size plus `reserve` stays within `cap`. A part that cannot be
 * measured is refused, never assumed empty, and no part with room throws: the write stops loudly rather than pass the cap.
 * Shared by writeIndex and the rebuild so both reserve capacity the same way.
 */
export async function partWithRoom(parts: readonly string[], from: number, month: string, reserve: number, cap: number, sizeOf: (key: string) => number | null | Promise<number | null>): Promise<number> {
  let p = from;
  invariant(p >= 0 && p < parts.length, `no index part ${p + 1} for ${month}`);
  let size = await sizeOf(parts[p]!);
  while (size === null || size + reserve > cap) {
    if (size === null) throw new IndexFullError(`index database ${parts[p]} cannot be measured; refusing to write into it`);
    if (++p >= parts.length) throw new IndexFullError(`every index database for ${month} is at ${cap} bytes; add a part (IDX_${month.replace("-", "_")}_${parts.length + 1})`);
    size = await sizeOf(parts[p]!);
  }
  return p;
}

export interface WriteIndexOptions {
  /** Size a part may reach before rows roll to the next part (default INDEX_DB_CAP_BYTES). */
  capBytes?: number;
}

/**
 * Write index entries for ingested rows, each into the first part of its month database still under
 * the cap. Idempotent within a part (INSERT OR IGNORE); a retry after rollover may leave a row in two
 * parts, which queries return once. Returns the entries written per database key.
 */
export async function writeIndex(dbs: Map<string, D1Like>, rows: readonly { row: Ingested; segment: string }[], opts: WriteIndexOptions = {}): Promise<Record<string, number>> {
  invariant(dbs.size > 0, "no index database is configured");
  const cap = opts.capBytes ?? INDEX_DB_CAP_BYTES;
  invariant(Number.isFinite(cap) && cap > 0 && cap <= INDEX_DB_CAP_BYTES, `the index cap must be positive and at most ${INDEX_DB_CAP_BYTES} bytes`);
  const keys = [...dbs.keys()];
  const months = monthsOf(keys);
  const byMonth = new Map<string, IndexEntry[]>();
  for (const { row, segment } of rows) {
    const e = indexEntry(row, segment, months);
    const list = byMonth.get(e.month) ?? [];
    list.push(e);
    byMonth.set(e.month, list);
  }
  const counts: Record<string, number> = {};
  for (const [month, entries] of byMonth) {
    const parts = partsOf(keys, month);
    let p = 0;
    for (let i = 0; i < entries.length; i += INDEX_CHUNK) {
      p = await partWithRoom(parts, p, month, chunkReserve(entries.slice(i, i + INDEX_CHUNK)), cap, (key) => databaseSize(dbs.get(key)!));
      const key = parts[p]!;
      const db = dbs.get(key)!;
      const stmts = entries.slice(i, i + BATCH).map((e) => db.prepare(INSERT_SQL).bind(...entryBinds(e)));
      if (db.batch) await db.batch(stmts);
      else for (const s of stmts) await s.run();
      counts[key] = (counts[key] ?? 0) + stmts.length;
    }
  }
  return counts;
}

// ── Queries ──

export interface IndexQuery {
  shard: string;
  /** Inclusive lower bound on when the row happened, epoch ms. */
  fromMs?: number;
  /** Exclusive upper bound, epoch ms. */
  toMs?: number;
  /** Rows of these streams only; undefined means any stream. An empty list matches nothing. */
  streams?: readonly string[];
  /** Rows of these classes only; undefined means any class. An empty list matches nothing. */
  classes?: readonly string[];
  writer?: string;
  session?: string;
  chain?: string;
  /** Rows about this RES only ("<kind>:<key>"). */
  subject?: string;
  /** "offset" (ingest order, the default) or "ts" (when the row happened, ties by offset). */
  order?: "offset" | "ts";
  /** Offset order: only rows with a larger ingest offset (-1 for all). */
  afterOffset: number;
  /** Time order: only rows after this (ts_ms, offset) position. */
  afterTs?: { tsMs: number; offset: number };
  limit: number;
}


/**
 * The database keys a query has to read: all of them. A row whose month had no database when it was written sits in the
 * month it was routed to then, and routing under today's bindings cannot find it once its own month is added, so a
 * window query reads every database and the ts_ms filter narrows each one.
 */
export function databasesFor(_q: Pick<IndexQuery, "fromMs" | "toMs">, keys: readonly string[]): string[] {
  return [...keys];
}

function whereClause(q: IndexQuery): { sql: string; binds: unknown[] } {
  const parts = ["shard = ?"];
  const binds: unknown[] = [q.shard];
  if (q.order === "ts") {
    if (q.afterTs) { parts.push("(ts_ms > ? OR (ts_ms = ? AND ingest_offset > ?))"); binds.push(q.afterTs.tsMs, q.afterTs.tsMs, q.afterTs.offset); }
  } else { parts.push("ingest_offset > ?"); binds.push(q.afterOffset); }
  if (q.fromMs !== undefined) { parts.push("ts_ms >= ?"); binds.push(q.fromMs); }
  if (q.toMs !== undefined) { parts.push("ts_ms < ?"); binds.push(q.toMs); }
  if (q.streams !== undefined) { parts.push(`stream IN (${q.streams.map(() => "?").join(", ")})`); binds.push(...q.streams); }
  if (q.classes !== undefined) { parts.push(`class IN (${q.classes.map(() => "?").join(", ")})`); binds.push(...q.classes); }
  if (q.writer !== undefined) { parts.push("writer = ?"); binds.push(q.writer); }
  if (q.session !== undefined) { parts.push("session = ?"); binds.push(q.session); }
  if (q.chain !== undefined) { parts.push("chain = ?"); binds.push(q.chain); }
  if (q.subject !== undefined) { parts.push("subject = ?"); binds.push(q.subject); }
  return { sql: parts.join(" AND "), binds };
}

/**
 * One page of index entries across every database, in ingest-offset order or by when the row
 * happened. `next` is the cursor of the last entry when more remain: the offset, or "<ts_ms>:<offset>".
 */
export async function queryIndex(dbs: Map<string, D1Like>, q: IndexQuery): Promise<{ entries: IndexEntry[]; next?: string }> {
  if ((q.streams !== undefined && q.streams.length === 0) || (q.classes !== undefined && q.classes.length === 0)) return { entries: [] };
  const byTs = q.order === "ts";
  const keys = databasesFor(q, [...dbs.keys()]);
  const { sql, binds } = whereClause(q);
  const orderBy = byTs ? "ts_ms, ingest_offset" : "ingest_offset";
  const pages = await Promise.all(keys.map(async (k) => {
    const res = await dbs.get(k)!.prepare(`SELECT ${INDEX_COLUMNS.join(", ")} FROM rows WHERE ${sql} ORDER BY ${orderBy} LIMIT ?`).bind(...binds, q.limit + 1).all<IndexEntry>();
    return res.results;
  }));
  const unique = new Map<number, IndexEntry>();
  for (const e of pages.flat()) if (!unique.has(e.ingest_offset)) unique.set(e.ingest_offset, e);
  const merged = [...unique.values()].sort(byTs ? (a, b) => a.ts_ms - b.ts_ms || a.ingest_offset - b.ingest_offset : (a, b) => a.ingest_offset - b.ingest_offset);
  if (merged.length > q.limit) {
    const entries = merged.slice(0, q.limit);
    const last = entries[entries.length - 1]!;
    return { entries, next: byTs ? `${last.ts_ms}:${last.ingest_offset}` : String(last.ingest_offset) };
  }
  return { entries: merged };
}

/** Is a body referenced by any indexed row a reader may see? (What a scoped reader may fetch.) Undefined means any. */
export async function bodyVisible(dbs: Map<string, D1Like>, sha: string, streams: readonly string[] | undefined, classes: readonly string[] | undefined): Promise<boolean> {
  if ((streams !== undefined && streams.length === 0) || (classes !== undefined && classes.length === 0)) return false;
  const parts = ["body = ?"];
  const binds: unknown[] = [sha];
  if (streams !== undefined) { parts.push(`stream IN (${streams.map(() => "?").join(", ")})`); binds.push(...streams); }
  if (classes !== undefined) { parts.push(`class IN (${classes.map(() => "?").join(", ")})`); binds.push(...classes); }
  for (const db of dbs.values()) {
    const hit = await db.prepare(`SELECT 1 AS hit FROM rows WHERE ${parts.join(" AND ")} LIMIT 1`).bind(...binds).first<{ hit: number }>();
    if (hit) return true;
  }
  return false;
}

/**
 * Set the subject the index holds for one row, in every index database (it lives in one; the others match nothing).
 * The erasure route calls it when clearing a row changes what deriveSubject() reads from it, so the live index keeps
 * equal to a rebuild.
 */
export async function setIndexSubject(dbs: Map<string, D1Like>, shard: string, offset: number, subject: string | null): Promise<number> {
  invariant(Number.isInteger(offset) && offset >= 0, `an index offset is a non-negative integer (got ${offset})`);
  let changed = 0;
  for (const db of dbs.values()) {
    const r = await db.prepare("UPDATE rows SET subject = ? WHERE shard = ? AND ingest_offset = ?").bind(subject, shard, offset).run();
    changed += r.meta?.changes ?? 0;
  }
  return changed;
}
