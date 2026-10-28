/**
 * STATVS core sequencer — the Durable Object that orders one shard (ISC-13, 14, 15, 48, 62, 63, 64).
 *
 * One Sequencer per shard ("main" for now). Each batch it accepts, it:
 *   1. dedupes by (chain, seq): the same identity with the same hash is a duplicate and gets its
 *      original offset back; with a different hash it is refused as a collision and counted. A
 *      chain belongs to the writer that first stored a row on it: a row on that chain from any
 *      other writer is refused "chain-writer-mismatch", so no writer can squat another's chain;
 *   2. gives every new row the next ingest offset and appends one `withheld` marker row per
 *      withholding reason the intake reported;
 *   2b. makes the batch's refusals durable in their own transaction, before anything is written to
 *      the record, idempotent by (chain, seq, reason, hash): a crash at any later step, orphan
 *      adoption included, loses none, and the resend that follows counts none twice;
 *   3. writes the batch as one gzip JSONL segment at seg/<shard>/<first offset, 16 digits>.jsonl.gz,
 *      refusing to replace an existing object (segments are the record and never change);
 *   4. appends the rows' leaf hashes to the C2SP tlog tiles and publishes a signed checkpoint
 *      (checkpoint/<shard>/<size, 16 digits> and the checkpoint/<shard>/latest pointer);
 *   5. commits identity, offsets, chain high-water marks and gap ranges to its SQLite storage in one
 *      transaction;
 *   6. indexes the rows into the month databases. An index failure leaves the record intact, and
 *      every later batch, a batch of nothing but duplicates included, catches the index up from
 *      the segments, so a retry after an index outage repairs it.
 *
 * The record is written before the sequencer's own state, so a crash between the two leaves an
 * orphan segment at the next offset; the next batch adopts it (verifying every row) instead of
 * colliding with it. Batches are serialized by a promise chain, because a Durable Object may
 * interleave requests while it awaits R2.
 *
 * Pure: WebCrypto, CompressionStream and the DO storage API only, so it runs in the Worker and
 * in Bun tests with an in-memory storage shim.
 *
 * @version 0.1.0
 */
import { canonicalJson, SHA256_HEX, utf8 } from "../../lib/canonical";
import { signCheckpoint } from "../../lib/checkpoint";
import { appendLeaves, emptyRoot, hashLeaf, toHex, type TileStore } from "../../lib/merkle";
import { mask } from "../../lib/mask";
import { withheldMarker, WITHHOLD_REASONS, type WithholdReason } from "../../lib/provenance";
import { finalizeRow, leafInput, verifyRowHash, type CoreRow, type Ingested } from "../../lib/row";
import { clearIndexText, clearRow, deleteBody, ERASURE_WRITER, holds, overwriteSegment, parseEraseRequest, tombstoneFields, type EraseRequest } from "./erasure";
import { indexDatabases, setIndexSubject, writeIndex } from "./index-store";
import { indexSubject } from "../../lib/subject";

class InvariantViolation extends Error {
  constructor(message: string) { super(`INVARIANT VIOLATION: ${message}`); this.name = "InvariantViolation"; }
}
function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new InvariantViolation(message);
}

// ── R2 shape ──

export interface R2ObjectLike { key: string; size?: number }
export interface R2BodyLike extends R2ObjectLike { arrayBuffer(): Promise<ArrayBuffer>; text(): Promise<string> }
export interface R2Like {
  get(key: string): Promise<R2BodyLike | null>;
  head(key: string): Promise<R2ObjectLike | null>;
  put(key: string, value: Uint8Array | string, options?: { onlyIf?: Headers | Record<string, unknown>; httpMetadata?: Record<string, string> }): Promise<R2ObjectLike | null>;
  list(options?: { prefix?: string; cursor?: string; limit?: number }): Promise<{ objects: R2ObjectLike[]; truncated: boolean; cursor?: string }>;
  /** Called only by erasure.ts (ISC-67). */
  delete?(key: string): Promise<void>;
}

// ── DO storage shape ──

export interface SqlCursorLike { toArray(): Record<string, unknown>[] }
export interface DOStorageLike {
  sql: { exec(query: string, ...bindings: unknown[]): SqlCursorLike };
  transactionSync<T>(fn: () => T): T;
}
export interface DOStateLike { storage: DOStorageLike }
export type SequencerEnv = { RECORD: R2Like; STATVS_SIGNING_KEY?: string; STATVS_MASK_KEY?: string } & Record<string, unknown>;

// ── Keys and encodings ──

const pad16 = (n: number) => String(n).padStart(16, "0");
export const segmentKey = (shard: string, firstOffset: number) => `seg/${shard}/${pad16(firstOffset)}.jsonl.gz`;
export const segmentPrefix = (shard: string) => `seg/${shard}/`;
export const checkpointKey = (shard: string, size: number | "latest") => `checkpoint/${shard}/${size === "latest" ? "latest" : pad16(size)}`;
export const tileKey = (shard: string, path: string) => `tlog/${shard}/${path}`;
export const bodyKey = (sha: string) => `body/${sha}`;
/** What the intake decided about a body PUT under this sha256 when it did not store it as sent (masked, withheld or refused). */
export const bodyNoteKey = (sha: string) => `bodynote/${sha}`;
export const originFor = (shard: string) => `lifeos-statvs-core/${shard}`;
const SHARD = /^[a-z][a-z0-9-]{0,31}$/;
const INGEST_KEYS = ["shard", "offset", "ingested_at"] as const;
/** The writer of withheld markers; reserved, so no credential can append as it. */
export const MARKER_WRITER = "statvs-intake";

/** The CoreRow inside an ingested row: what the row's hash and its Merkle leaf cover. */
export function coreOf(row: CoreRow | Ingested): CoreRow {
  const r: Record<string, unknown> = { ...row };
  for (const k of INGEST_KEYS) delete r[k];
  return r as unknown as CoreRow;
}

/** The Merkle leaf hash of a row: hashLeaf over its committed fields, hash included (leafInput; erasure never moves it). */
export function leafHash(row: CoreRow | Ingested): Promise<Uint8Array> {
  return hashLeaf(leafInput(coreOf(row)));
}

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzip(bytes: Uint8Array): Promise<string> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).text();
}

/** A segment's bytes: one canonical JSON line per ingested row, in offset order, gzipped. */
export async function encodeSegment(rows: readonly Ingested[]): Promise<Uint8Array> {
  return gzip(utf8(rows.map((r) => canonicalJson(r) + "\n").join("")));
}

/** Read a segment back into its ingested rows. */
export async function readSegment(record: R2Like, key: string): Promise<Ingested[]> {
  const obj = await record.get(key);
  if (!obj) throw new Error(`segment ${key} is missing from the record`);
  const text = await gunzip(new Uint8Array(await obj.arrayBuffer()));
  return text.split("\n").filter((l) => l.length > 0).map((l) => JSON.parse(l) as Ingested);
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Write an object that must never change (ISC-64): refused when the key already holds different
 * bytes, a no-op when it holds the same bytes. The put itself is conditional (If-None-Match: *),
 * so a writer racing past the head check still cannot replace what is there.
 */
export async function writeImmutable(record: R2Like, key: string, bytes: Uint8Array, contentType = "application/octet-stream"): Promise<"stored" | "identical"> {
  const existing = await record.get(key);
  if (existing) {
    invariant(bytesEqual(new Uint8Array(await existing.arrayBuffer()), bytes), `${key} already holds different bytes; record objects are immutable`);
    return "identical";
  }
  const put = await record.put(key, bytes, { onlyIf: new Headers({ "If-None-Match": "*" }), httpMetadata: { contentType } });
  if (put) return "stored";
  const raced = await record.get(key);
  invariant(raced && bytesEqual(new Uint8Array(await raced.arrayBuffer()), bytes), `${key} was written by someone else with different bytes; record objects are immutable`);
  return "identical";
}

/** The tlog tiles of a shard, kept in R2 under tlog/<shard>/. Tiles are immutable by path. */
export function r2TileStore(record: R2Like, shard: string): TileStore {
  return {
    async get(path) {
      const obj = await record.get(tileKey(shard, path));
      return obj ? new Uint8Array(await obj.arrayBuffer()) : null;
    },
    async put(path, bytes) {
      await writeImmutable(record, tileKey(shard, path), bytes);
    },
  };
}

// ── Wire types ──

export type RowStatus = { chain: string; seq: number; status: "stored" | "duplicate" | "refused"; offset?: number; reason?: string };
export interface Refusal { chain: string; seq: number; reason: string; hash?: string }
/** The identity of one row the intake withheld: what makes a withheld event the same event when its batch is resent. */
export interface WithheldRow { chain: string; seq: number; hash?: string }
/** Withholdings of one reason; `rows` names each withheld row, and `count` is how many there are. */
export interface Withholding { source: string; count: number; reason: WithholdReason; rows: WithheldRow[] }
export interface AppendInput {
  shard: string;
  /** ISO time stamped as ingested_at on every row of the batch. */
  now: string;
  rows: CoreRow[];
  /** Rows the intake refused, recorded here so every refusal is counted in one place (ISC-48). */
  refusals?: Refusal[];
  /** Withholdings the intake made; each becomes one content-free marker row (ISC-68). */
  withheld?: Withholding[];
}
export interface AppendResult {
  results: RowStatus[];
  markers: { chain: string; seq: number; offset: number }[];
  checkpoint: { size: number; root: string };
}

// ── The Durable Object ──

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS seen (chain TEXT NOT NULL, seq INTEGER NOT NULL, hash TEXT NOT NULL, ingest_offset INTEGER NOT NULL, PRIMARY KEY (chain, seq));
CREATE TABLE IF NOT EXISTS chains (chain TEXT PRIMARY KEY, writer TEXT NOT NULL, high INTEGER NOT NULL, count INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS gaps (chain TEXT NOT NULL, lo INTEGER NOT NULL, hi INTEGER NOT NULL, PRIMARY KEY (chain, lo));
CREATE TABLE IF NOT EXISTS segments (first_offset INTEGER PRIMARY KEY, seg_key TEXT NOT NULL, count INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS checkpoints (size INTEGER PRIMARY KEY, root TEXT NOT NULL, at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS refusals (id INTEGER PRIMARY KEY AUTOINCREMENT, chain TEXT NOT NULL, seq INTEGER NOT NULL, reason TEXT NOT NULL, hash TEXT, at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS withheld_events (chain TEXT NOT NULL, seq INTEGER NOT NULL, hash TEXT NOT NULL, marker_chain TEXT NOT NULL, marker_seq INTEGER NOT NULL, marker_hash TEXT NOT NULL, PRIMARY KEY (chain, seq, hash));
CREATE TABLE IF NOT EXISTS erasures (chain TEXT NOT NULL, seq INTEGER NOT NULL, groups TEXT NOT NULL, tomb_chain TEXT NOT NULL, tomb_seq INTEGER NOT NULL, tomb_offset INTEGER NOT NULL, done INTEGER NOT NULL, PRIMARY KEY (chain, seq, groups));
`;

/** A withheld row's identity as stored: chain masked, seq an integer, hash a sha256 digest or "". */
type EventId = { chain: string; seq: number; hash: string };
/** A withheld event and the marker row that counts it. */
type MarkedEvent = { id: EventId; marker: { chain: string; seq: number; hash: string } };

const json = (value: unknown, status = 200) => Response.json(value, { status });
/** The most missing sequence numbers GET /gaps expands; the ranges are always complete. */
const MAX_MISSING = 10_000;

export class Sequencer {
  private readonly sql: DOStorageLike["sql"];
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly state: DOStateLike, private readonly env: SequencerEnv) {
    this.sql = state.storage.sql;
    this.sql.exec(SCHEMA);
    // A refusal is one fact, keyed by (chain, seq, reason, hash): a resend after a crash re-derives it and must not count
    // it twice. Older storage may hold such repeats; they fold to their first row before the key is enforced.
    if (this.sql.exec("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'refusals_natural'").toArray().length === 0) {
      state.storage.transactionSync(() => {
        this.sql.exec("DELETE FROM refusals WHERE id NOT IN (SELECT MIN(id) FROM refusals GROUP BY chain, seq, reason, IFNULL(hash, ''))");
        this.sql.exec("CREATE UNIQUE INDEX refusals_natural ON refusals (chain, seq, reason, IFNULL(hash, ''))");
      });
    }
  }

  // ── state helpers ──

  private meta(k: string): string | null {
    const r = this.sql.exec("SELECT v FROM meta WHERE k = ?", k).toArray()[0];
    return r ? String(r.v) : null;
  }
  private setMeta(k: string, v: string | number): void {
    this.sql.exec("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", k, String(v));
  }
  private size(): number { return Number(this.meta("size") ?? 0); }
  private bindShard(shard: string): void {
    invariant(SHARD.test(shard), `invalid shard name ${JSON.stringify(shard)}`);
    const bound = this.meta("shard");
    if (bound === null) this.setMeta("shard", shard);
    else invariant(bound === shard, `this sequencer orders shard ${bound}, not ${shard}`);
  }
  private seenRow(chain: string, seq: number): { hash: string; offset: number } | null {
    const r = this.sql.exec("SELECT hash, ingest_offset FROM seen WHERE chain = ? AND seq = ?", chain, seq).toArray()[0];
    return r ? { hash: String(r.hash), offset: Number(r.ingest_offset) } : null;
  }
  private chainWriter(chain: string): string | null {
    const r = this.sql.exec("SELECT writer FROM chains WHERE chain = ?", chain).toArray()[0];
    return r ? String(r.writer) : null;
  }
  private high(chain: string): number {
    const r = this.sql.exec("SELECT high FROM chains WHERE chain = ?", chain).toArray()[0];
    return r ? Number(r.high) : 0;
  }

  /** Record (chain, seq) in the chain's high-water mark and gap ranges. Caller holds the transaction. */
  private noteSeq(chain: string, seq: number, writer: string): void {
    const owner = this.chainWriter(chain);
    invariant(owner === null || owner === writer, `${chain} belongs to ${owner}, not ${writer}`);
    const high = this.high(chain);
    if (seq > high) {
      if (seq > high + 1) this.sql.exec("INSERT INTO gaps (chain, lo, hi) VALUES (?, ?, ?)", chain, high + 1, seq - 1);
      this.sql.exec("INSERT INTO chains (chain, writer, high, count) VALUES (?, ?, ?, 1) ON CONFLICT(chain) DO UPDATE SET high = excluded.high, count = count + 1", chain, writer, seq);
      return;
    }
    const range = this.sql.exec("SELECT lo, hi FROM gaps WHERE chain = ? AND lo <= ? AND hi >= ?", chain, seq, seq).toArray()[0];
    invariant(range, `${chain}#${seq} is below the high-water mark and fills no gap, yet was not seen`);
    const lo = Number(range.lo), hi = Number(range.hi);
    this.sql.exec("DELETE FROM gaps WHERE chain = ? AND lo = ?", chain, lo);
    if (lo <= seq - 1) this.sql.exec("INSERT INTO gaps (chain, lo, hi) VALUES (?, ?, ?)", chain, lo, seq - 1);
    if (seq + 1 <= hi) this.sql.exec("INSERT INTO gaps (chain, lo, hi) VALUES (?, ?, ?)", chain, seq + 1, hi);
    this.sql.exec("UPDATE chains SET count = count + 1 WHERE chain = ?", chain);
  }

  /** Commit a written segment: identities, chain state, the segment, the new size and checkpoint. Refusals are already durable. */
  private commit(shard: string, rows: readonly Ingested[], key: string, size: number, root: string, at: string): void {
    this.state.storage.transactionSync(() => {
      invariant(rows.length > 0 && rows[0]!.offset === this.size(), `segment ${key} does not start at the committed size ${this.size()}`);
      for (const r of rows) {
        invariant(r.shard === shard, `row ${r.chain}#${r.seq} belongs to shard ${r.shard}, not ${shard}`);
        invariant(this.seenRow(r.chain, r.seq) === null, `${r.chain}#${r.seq} is already committed`);
        this.sql.exec("INSERT INTO seen (chain, seq, hash, ingest_offset) VALUES (?, ?, ?, ?)", r.chain, r.seq, r.hash, r.offset);
        this.noteSeq(r.chain, r.seq, r.writer);
      }
      this.sql.exec("INSERT INTO segments (first_offset, seg_key, count) VALUES (?, ?, ?)", rows[0]!.offset, key, rows.length);
      this.sql.exec("INSERT INTO checkpoints (size, root, at) VALUES (?, ?, ?)", size, root, at);
      this.setMeta("size", size);
    });
  }

  /**
   * Every refusal field is writer-supplied and may hold the very secret its row was refused for, so only safe shapes
   * persist: the chain masked, seq an integer, the reason a short slug, and the hash only when it is a sha256 digest.
   */
  private async maskedRefusals(refusals: readonly Refusal[]): Promise<Refusal[]> {
    if (refusals.length === 0) return [];
    const key = this.env.STATVS_MASK_KEY;
    invariant(typeof key === "string" && key.length > 0, "STATVS_MASK_KEY is not configured");
    return Promise.all(refusals.map(async (f) => ({
      chain: String((await mask(String(f.chain), key)).value),
      seq: Number.isSafeInteger(f.seq) ? f.seq : -1,
      reason: typeof f.reason === "string" && /^[a-z][a-z0-9-]{0,39}$/.test(f.reason) ? f.reason : "other",
      hash: typeof f.hash === "string" && SHA256_HEX.test(f.hash) ? f.hash : undefined,
    })));
  }

  /**
   * Make a batch's refusals durable, in their own transaction, before anything of the batch is written to the record.
   * Idempotent by (chain, seq, reason, hash), so a crash at any later point loses none and a resend counts none twice.
   */
  private recordRefusals(refusals: readonly Refusal[], events: readonly MarkedEvent[], at: string): void {
    if (refusals.length === 0 && events.length === 0) return;
    this.state.storage.transactionSync(() => {
      for (const f of refusals) this.sql.exec("INSERT OR IGNORE INTO refusals (chain, seq, reason, hash, at) VALUES (?, ?, ?, ?, ?)", f.chain, f.seq, f.reason, f.hash ?? null, at);
      // Each withheld event points at the marker that counts it; a stale pointer from a batch that died before its
      // marker reached the record is replaced by this attempt's.
      for (const e of events) {
        this.sql.exec("INSERT INTO withheld_events (chain, seq, hash, marker_chain, marker_seq, marker_hash) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(chain, seq, hash) DO UPDATE SET marker_chain = excluded.marker_chain, marker_seq = excluded.marker_seq, marker_hash = excluded.marker_hash", e.id.chain, e.id.seq, e.id.hash, e.marker.chain, e.marker.seq, e.marker.hash);
      }
    });
  }

  /** A withheld row's identity in a safe shape (as maskedRefusals keeps it): chain masked, seq an integer, hash a digest or "". */
  private async eventId(r: WithheldRow): Promise<EventId> {
    const key = this.env.STATVS_MASK_KEY;
    invariant(typeof key === "string" && key.length > 0, "STATVS_MASK_KEY is not configured");
    return {
      chain: String((await mask(String(r.chain), key)).value),
      seq: Number.isSafeInteger(r.seq) ? r.seq : -1,
      hash: typeof r.hash === "string" && SHA256_HEX.test(r.hash) ? r.hash : "",
    };
  }

  /**
   * A withheld event is counted when the marker its pointer names is committed with that exact hash. The orphan
   * adoption that opens every batch has already committed any marker that reached the record, so a pointer to a marker
   * that is not committed is one whose batch died before its segment was written: that event is counted again.
   */
  private counted(id: EventId): boolean {
    const r = this.sql.exec("SELECT marker_chain, marker_seq, marker_hash FROM withheld_events WHERE chain = ? AND seq = ? AND hash = ?", id.chain, id.seq, id.hash).toArray()[0];
    if (!r) return false;
    return this.seenRow(String(r.marker_chain), Number(r.marker_seq))?.hash === String(r.marker_hash);
  }

  /** Tiles, signed checkpoint, commit: everything after a segment is safely in the record. */
  private async publish(shard: string, rows: readonly Ingested[], key: string, at: string): Promise<{ size: number; root: string }> {
    const signingKey = this.env.STATVS_SIGNING_KEY;
    invariant(typeof signingKey === "string" && signingKey.length > 0, "STATVS_SIGNING_KEY is not configured");
    const oldSize = this.size();
    const leaves = await Promise.all(rows.map(leafHash));
    const { size, root } = await appendLeaves(r2TileStore(this.env.RECORD, shard), oldSize, leaves);
    const note = await signCheckpoint({ origin: originFor(shard), size, root }, signingKey);
    await writeImmutable(this.env.RECORD, checkpointKey(shard, size), utf8(note), "text/plain; charset=utf-8");
    await this.env.RECORD.put(checkpointKey(shard, "latest"), note, { httpMetadata: { contentType: "text/plain; charset=utf-8" } });
    const rootHex = toHex(root);
    this.commit(shard, rows, key, size, rootHex, at);
    return { size, root: rootHex };
  }

  /** Adopt any segment written at the next offset by a batch that crashed before committing. */
  private async adoptOrphans(shard: string, at: string): Promise<void> {
    for (;;) {
      const size = this.size();
      const key = segmentKey(shard, size);
      if (!(await this.env.RECORD.head(key))) return;
      const rows = await readSegment(this.env.RECORD, key);
      invariant(rows.length > 0, `orphan segment ${key} is empty`);
      for (let i = 0; i < rows.length; i++) {
        invariant(rows[i]!.offset === size + i, `orphan segment ${key} row ${i} has offset ${rows[i]!.offset}`);
        invariant(await verifyRowHash(rows[i]!), `orphan segment ${key} row ${i} fails its hash`);
      }
      await this.publish(shard, rows, key, at);
    }
  }

  /** Index every committed row the month databases do not have yet, from the segments. */
  private async catchUpIndex(shard: string, fresh?: { rows: readonly Ingested[]; key: string }): Promise<void> {
    const dbs = indexDatabases(this.env);
    if (dbs.size === 0) return;
    let indexed = Number(this.meta("indexed") ?? 0);
    const size = this.size();
    while (indexed < size) {
      const seg = this.sql.exec("SELECT seg_key, count FROM segments WHERE first_offset = ?", indexed).toArray()[0];
      invariant(seg, `no segment starts at offset ${indexed}`);
      const key = String(seg.seg_key);
      const rows = fresh && fresh.key === key ? fresh.rows : await readSegment(this.env.RECORD, key);
      invariant(rows.length === Number(seg.count) && rows.every((r) => r.shard === shard), `segment ${key} does not match its commit`);
      await writeIndex(dbs, rows.map((row) => ({ row, segment: key })));
      indexed += rows.length;
      this.setMeta("indexed", indexed);
    }
  }

  /** Catch the index up; a failure other than a broken invariant is lag, logged, and retried by the next batch. */
  private async tryCatchUp(shard: string, fresh?: { rows: readonly Ingested[]; key: string }): Promise<void> {
    try {
      await this.catchUpIndex(shard, fresh);
    } catch (e) {
      if (e instanceof InvariantViolation) throw e;
      console.error(`statvs-core: index lagging at offset ${this.meta("indexed") ?? 0} of ${this.size()}: ${(e as Error).message}`);
    }
  }

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Order one batch. See the file header for the steps. */
  append(input: AppendInput): Promise<AppendResult> {
    return this.serialize(() => this.appendInOrder(input));
  }

  /**
   * The erasure route (erasure.ts): a signed tombstone first, then the cleared row in its segment, the body object and
   * the index text. A retry after a crash at any step finds the tombstone it already wrote and finishes the rest.
   */
  erase(raw: unknown, shard: string, now: string): Promise<{ status: number; body: Record<string, unknown> }> {
    return this.serialize(async () => {
      const parsed = parseEraseRequest(raw);
      if (!parsed.ok) return { status: 400, body: { error: parsed.error } };
      const req: EraseRequest = parsed.req;
      this.bindShard(shard);
      const seen = this.seenRow(req.chain, req.seq);
      if (!seen) return { status: 404, body: { error: "no such row" } };
      const seg = this.sql.exec("SELECT first_offset, seg_key FROM segments WHERE first_offset <= ? ORDER BY first_offset DESC LIMIT 1", seen.offset).toArray()[0];
      invariant(seg, `row at offset ${seen.offset} has no segment`);
      const key = String(seg.seg_key);
      const rows = await readSegment(this.env.RECORD, key);
      const i = rows.findIndex((r) => r.offset === seen.offset);
      invariant(i >= 0 && rows[i]!.chain === req.chain && rows[i]!.seq === req.seq, `segment ${key} does not hold ${req.chain}#${req.seq} at offset ${seen.offset}`);
      const target = rows[i]!;
      if (target.v !== 3 && target.v !== 4) return { status: 409, body: { error: "a v2 row's hash covers its content, so it cannot be cleared and keep its hash" } };
      const groups = req.groups.join("+");
      const prior = this.sql.exec("SELECT tomb_chain, tomb_seq, tomb_offset, done FROM erasures WHERE chain = ? AND seq = ? AND groups = ?", req.chain, req.seq, groups).toArray()[0];
      let tomb = prior ? { chain: String(prior.tomb_chain), seq: Number(prior.tomb_seq), offset: Number(prior.tomb_offset) } : null;
      if (prior && Number(prior.done) === 1) return { status: 200, body: { status: "already-erased", tombstone: tomb } };
      const bodyStored = target.body !== undefined && (await this.env.RECORD.head(bodyKey(target.body))) !== null;
      if (!tomb) {
        if (!holds(target, req.groups, bodyStored)) return { status: 409, body: { error: "nothing of those groups is left on the row" } };
        const chain = `${ERASURE_WRITER.replace(":", "_")}|-|system|${now.slice(0, 10)}`;
        const row = await finalizeRow(tombstoneFields(req, target, key, now, this.high(chain) + 1));
        const out = await this.appendInOrder({ shard, now, rows: [row], refusals: [], withheld: [] });
        const r = out.results[0]!;
        invariant(r.status === "stored" && r.offset !== undefined, `the tombstone for ${req.chain}#${req.seq} was not stored (${r.status})`);
        tomb = { chain: row.chain, seq: row.seq, offset: r.offset };
        this.sql.exec("INSERT INTO erasures (chain, seq, groups, tomb_chain, tomb_seq, tomb_offset, done) VALUES (?, ?, ?, ?, ?, ?, 0)", req.chain, req.seq, groups, tomb.chain, tomb.seq, tomb.offset);
      }
      if (holds(target, req.groups, false)) {
        rows[i] = await clearRow(target, req.groups);
        await overwriteSegment(this.env.RECORD, key, await encodeSegment(rows));
      }
      // A subject derived from what was cleared goes with it, so the live index stays equal to a rebuild (CENSVS F4).
      // Set every time a row names none (idempotent), so a retry after a crash still lands it.
      if (rows[i]!.subject === undefined) await setIndexSubject(indexDatabases(this.env), shard, seen.offset, indexSubject(rows[i]!));
      if (req.groups.includes("data") && bodyStored) await deleteBody(this.env.RECORD, bodyKey(target.body!));
      if (req.groups.includes("text")) await clearIndexText(indexDatabases(this.env), shard, seen.offset);
      this.sql.exec("UPDATE erasures SET done = 1 WHERE chain = ? AND seq = ? AND groups = ?", req.chain, req.seq, groups);
      return { status: 200, body: { status: "erased", tombstone: tomb, segment: key } };
    });
  }

  private async appendInOrder(input: AppendInput): Promise<AppendResult> {
    {
      invariant(typeof input.now === "string" && Number.isFinite(Date.parse(input.now)), "append needs an ISO now");
      invariant(Array.isArray(input.rows), "append needs rows");
      this.bindShard(input.shard);
      const shard = input.shard, at = input.now;
      await this.adoptOrphans(shard, at);

      const refusals: Refusal[] = [...(input.refusals ?? [])];
      const results: RowStatus[] = [];
      const batch = new Map<string, { hash: string; offset: number }>();
      const owners = new Map<string, string>();
      const accepted: CoreRow[] = [];
      const base = this.size();
      for (const row of input.rows) {
        invariant(await verifyRowHash(row), `${row.chain}#${row.seq} reached the sequencer with a bad hash`);
        const id = `${row.chain}\u0000${row.seq}`;
        const prior = batch.get(id) ?? this.seenRow(row.chain, row.seq);
        if (prior) {
          if (prior.hash === row.hash) results.push({ chain: row.chain, seq: row.seq, status: "duplicate", offset: prior.offset });
          else {
            results.push({ chain: row.chain, seq: row.seq, status: "refused", reason: "collision" });
            refusals.push({ chain: row.chain, seq: row.seq, reason: "collision", hash: row.hash });
          }
          continue;
        }
        const owner = owners.get(row.chain) ?? this.chainWriter(row.chain);
        if (owner !== null && owner !== row.writer) {
          results.push({ chain: row.chain, seq: row.seq, status: "refused", reason: "chain-writer-mismatch" });
          refusals.push({ chain: row.chain, seq: row.seq, reason: "chain-writer-mismatch", hash: row.hash });
          continue;
        }
        owners.set(row.chain, row.writer);
        const offset = base + accepted.length;
        batch.set(id, { hash: row.hash, offset });
        accepted.push(row);
        results.push({ chain: row.chain, seq: row.seq, status: "stored", offset });
      }

      // One marker per reason, counting only the withheld rows no committed marker counts yet: a resend of the same
      // batch, before or after a crash at any step, adds no second marker for the same withheld row.
      const markers: AppendResult["markers"] = [];
      const events: MarkedEvent[] = [];
      const inBatch = new Set<string>();
      for (const w of input.withheld ?? []) {
        invariant(WITHHOLD_REASONS.includes(w.reason), `unknown withhold reason ${String(w.reason)}`);
        invariant(Array.isArray(w.rows) && w.rows.length === w.count && w.count >= 1, `a withholding names each row it counts (${String(w.count)} counted, ${Array.isArray(w.rows) ? w.rows.length : "none"} named)`);
        const fresh: EventId[] = [];
        for (const r of w.rows) {
          const id = await this.eventId(r);
          const k = `${id.chain}\u0000${id.seq}\u0000${id.hash}`;
          if (inBatch.has(k) || this.counted(id)) continue;
          inBatch.add(k);
          fresh.push(id);
        }
        if (fresh.length === 0) continue;
        const chain = `${MARKER_WRITER}|-|system|${at.slice(0, 10)}`;
        const seq = Math.max(this.high(chain), ...accepted.filter((r) => r.chain === chain).map((r) => r.seq)) + 1;
        const marker = await withheldMarker(w.source, fresh.length, w.reason, { writer: MARKER_WRITER, chain, seq, ts: at });
        markers.push({ chain, seq, offset: base + accepted.length });
        accepted.push(marker);
        for (const id of fresh) events.push({ id, marker: { chain, seq, hash: marker.hash } });
      }

      // Refusals and withheld-event pointers first, durable on their own: no crash after this point, orphan adoption
      // included, can lose a refusal, and a pointer only counts once its marker is committed.
      this.recordRefusals(await this.maskedRefusals(refusals), events, at);
      let checkpoint: { size: number; root: string };
      if (accepted.length > 0) {
        const rows: Ingested[] = accepted.map((r, i) => ({ ...r, shard, offset: base + i, ingested_at: at }));
        const key = segmentKey(shard, base);
        invariant(typeof this.env.STATVS_SIGNING_KEY === "string" && this.env.STATVS_SIGNING_KEY.length > 0, "STATVS_SIGNING_KEY is not configured");
        await writeImmutable(this.env.RECORD, key, await encodeSegment(rows), "application/gzip");
        checkpoint = await this.publish(shard, rows, key, at);
        await this.tryCatchUp(shard, { rows, key });
      } else {
        const r = this.sql.exec("SELECT size, root FROM checkpoints ORDER BY size DESC LIMIT 1").toArray()[0];
        checkpoint = r ? { size: Number(r.size), root: String(r.root) } : { size: 0, root: toHex(await emptyRoot()) };
        await this.tryCatchUp(shard);
      }
      return { results, markers, checkpoint };
    }
  }

  /** Missing sequence numbers of a chain below its high-water mark (ISC-15). */
  gaps(chain: string): { chain: string; high: number; missing: number[]; ranges: [number, number][]; truncated?: true } {
    const ranges = this.sql.exec("SELECT lo, hi FROM gaps WHERE chain = ? ORDER BY lo", chain).toArray().map((r) => [Number(r.lo), Number(r.hi)] as [number, number]);
    const missing: number[] = [];
    let truncated = false;
    for (const [lo, hi] of ranges) for (let s = lo; s <= hi; s++) { if (missing.length >= MAX_MISSING) { truncated = true; break; } missing.push(s); }
    return truncated ? { chain, high: this.high(chain), missing, ranges, truncated: true } : { chain, high: this.high(chain), missing, ranges };
  }

  /** Refusal counts by reason (ISC-48). */
  refusals(): { total: number; by_reason: Record<string, number> } {
    const by_reason: Record<string, number> = {};
    let total = 0;
    for (const r of this.sql.exec("SELECT reason, COUNT(*) AS n FROM refusals GROUP BY reason ORDER BY reason").toArray()) {
      by_reason[String(r.reason)] = Number(r.n);
      total += Number(r.n);
    }
    return { total, by_reason };
  }

  /** The Durable Object's request surface; only the core Worker calls it. */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (request.method === "POST" && url.pathname === "/append") return json(await this.append((await request.json()) as AppendInput));
      if (request.method === "GET" && url.pathname === "/gaps") {
        const chain = url.searchParams.get("chain");
        return chain ? json(this.gaps(chain)) : json({ error: "chain is required" }, 400);
      }
      if (request.method === "GET" && url.pathname === "/refusals") return json(this.refusals());
      if (request.method === "POST" && url.pathname === "/erase") {
        const { shard, now, request: req } = (await request.json()) as { shard: string; now: string; request: unknown };
        const out = await this.erase(req, shard, now);
        return json(out.body, out.status);
      }
      if (request.method === "GET" && url.pathname === "/state") return json({ shard: this.meta("shard"), size: this.size(), indexed: Number(this.meta("indexed") ?? 0) });
      return json({ error: "not found" }, 404);
    } catch (e) {
      console.error(`statvs-core sequencer: ${(e as Error).message}`);
      return json({ error: (e as Error).message }, 500);
    }
  }
}
