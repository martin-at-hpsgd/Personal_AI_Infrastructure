#!/usr/bin/env bun
/**
 * STATVS core rebuild — rebuilds the month index from the R2 segments alone (ISC-8, ISC-75).
 *
 * Reads every segment of a shard in offset order, checks each row's hash, checks offsets run
 * from 0 with no gap, folds the Merkle root over the rows' leaves and requires it to equal the
 * latest signed checkpoint, then writes the index into empty SQLite databases (one per month)
 * with the same entry builder and insert statement the live sequencer uses. The index folds by
 * ingest offset, so two rebuilds of the same record produce identical bytes. A month with rollover
 * parts ("YYYY-MM/2", ...) fills each part up to the same cap the live index keeps, 80% of D1's
 * 10 GB (ISC-61), measured as it writes.
 *
 * Each entry's subject is the one a v4 row names, else the one lib/subject.ts deriveSubject() reads from an older row
 * (CENSVS ISA F4, ISC-24), through the same indexEntry() the live index uses, so derived subjects rebuild exactly as the
 * live index and tools/backfill-subject.ts wrote them. Nothing is written to the record.
 *
 * Library: rebuildIndex({ record, shard, verifierKeys, months, open }); months are the index
 * database keys, "YYYY-MM" for a month's first part and "YYYY-MM/<n>" for its rollover parts. `record` is anything
 * R2-shaped (the Worker binding, the test fake, or dirRecord() over a local mirror).
 *
 * CLI: bun LIFEOS/STATVS/core/tools/rebuild.ts --record-dir <mirror> --out <dir> \
 *        --verifier <key> --months 2026-08,2026-09,2026-09/2 [--shard main]
 * writes <out>/index-YYYY-MM.sqlite (index-YYYY-MM_<n>.sqlite for a part; refuses a non-empty
 * --out) and prints a JSON summary.
 *
 * @version 0.1.0
 */
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { sha256Hex } from "../lib/canonical";
import { verifyCheckpoint } from "../lib/checkpoint";
import { bytesEqual, emptyRoot, hashLeaf, hashNode, toHex } from "../lib/merkle";
import { leafInput, verifyRowHash, type Ingested } from "../lib/row";
import { chunkReserve, entryBinds, IndexFullError, indexEntry, INDEX_CHUNK, INDEX_DB_CAP_BYTES, INSERT_SQL, monthsOf, parseDbKey, partWithRoom } from "../worker/src/index-store";
import { ERASURE_WRITER } from "../worker/src/erasure";
import { bodyKey, checkpointKey, coreOf, originFor, readSegment, segmentKey, segmentPrefix, type R2Like } from "../worker/src/sequencer";
import { invariant } from "../../../TOOLS/Invariant";

export const INDEX_SCHEMA = readFileSync(join(import.meta.dir, "../worker/schema/index.sql"), "utf8");

/** RFC 6962 root over a stream of leaf hashes, holding only the right-edge frontier. */
export class MerkleFrontier {
  private stack: { height: number; hash: Uint8Array }[] = [];
  size = 0;
  async push(leaf: Uint8Array): Promise<void> {
    let node = { height: 0, hash: leaf };
    while (this.stack.length > 0 && this.stack[this.stack.length - 1]!.height === node.height) {
      const left = this.stack.pop()!;
      node = { height: node.height + 1, hash: await hashNode(left.hash, node.hash) };
    }
    this.stack.push(node);
    this.size++;
  }
  async root(): Promise<Uint8Array> {
    if (this.stack.length === 0) return emptyRoot();
    let h = this.stack[this.stack.length - 1]!.hash;
    for (let i = this.stack.length - 2; i >= 0; i--) h = await hashNode(this.stack[i]!.hash, h);
    return h;
  }
}

export interface RebuildOptions {
  record: R2Like;
  shard: string;
  verifierKeys: string[];
  /** The configured index database keys, as the live Worker has them ("YYYY-MM", "YYYY-MM/<n>"). */
  months: string[];
  /** An empty database for a key; the rebuild creates the schema in it. */
  open: (key: string) => Database;
  /** Size a part may reach before rows roll to the next part (default INDEX_DB_CAP_BYTES). */
  capBytes?: number;
  /** Check that every referenced body is present (default true). */
  checkBodies?: boolean;
}

export type RebuildResult =
  | { ok: true; size: number; root: string; segments: number; perMonth: Record<string, number> }
  | { ok: false; reason: string };

async function listKeys(record: R2Like, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await record.list({ prefix, cursor, limit: 1000 });
    for (const o of page.objects) keys.push(o.key);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return keys.sort();
}

/** Verify the shard end to end and rebuild its index into fresh databases. */
export async function rebuildIndex(opts: RebuildOptions): Promise<RebuildResult> {
  invariant(opts.months.length > 0, "rebuild needs the configured index months");
  const latest = await opts.record.get(checkpointKey(opts.shard, "latest"));
  if (!latest) return { ok: false, reason: "no checkpoint" };
  const cp = await verifyCheckpoint(await latest.text(), opts.verifierKeys, originFor(opts.shard));
  if (!cp.ok) return { ok: false, reason: `checkpoint: ${cp.reason}` };

  const frontier = new MerkleFrontier();
  const all: { row: Ingested; segment: string }[] = [];
  const keys = await listKeys(opts.record, segmentPrefix(opts.shard));
  for (const key of keys) {
    if (key !== segmentKey(opts.shard, frontier.size)) return { ok: false, reason: `segment ${key} is not at the next offset ${frontier.size}` };
    let rows: Ingested[];
    try { rows = await readSegment(opts.record, key); } catch (e) { return { ok: false, reason: `segment ${key}: ${(e as Error).message}` }; }
    if (rows.length === 0) return { ok: false, reason: `segment ${key} is empty` };
    for (const row of rows) {
      if (row.offset !== frontier.size || row.shard !== opts.shard) return { ok: false, reason: `segment ${key}: row at offset ${row.offset} out of place` };
      if (!(await verifyRowHash(row))) return { ok: false, reason: `segment ${key}: row ${row.chain}#${row.seq} fails its hash` };
      await frontier.push(await hashLeaf(leafInput(coreOf(row))));
      all.push({ row, segment: key });
    }
  }
  if (frontier.size !== cp.checkpoint.size) return { ok: false, reason: `segments hold ${frontier.size} rows, the checkpoint says ${cp.checkpoint.size}` };
  if (opts.checkBodies !== false) {
    // A body the erasure route deleted is named by its tombstone, which may come later in the record than the row.
    const erased = new Set<string>();
    for (const { row } of all) {
      const body = row.writer === ERASURE_WRITER ? (row.data as { removed?: { body?: unknown } } | undefined)?.removed?.body : undefined;
      if (typeof body === "string") erased.add(body);
    }
    for (const { row } of all) {
      if (row.body === undefined || erased.has(row.body)) continue;
      // The signed root covers the body's hash, not its bytes, so the bytes are checked against that hash here.
      const body = await opts.record.get(bodyKey(row.body));
      if (!body) return { ok: false, reason: `body ${row.body} of ${row.chain}#${row.seq} is missing` };
      if ((await sha256Hex(new Uint8Array(await body.arrayBuffer()))) !== row.body) return { ok: false, reason: `body ${row.body} of ${row.chain}#${row.seq} does not match its hash` };
    }
  }
  const root = await frontier.root();
  if (!bytesEqual(root, cp.checkpoint.root)) return { ok: false, reason: "Merkle root of the segments does not match the checkpoint" };

  const cap = opts.capBytes ?? INDEX_DB_CAP_BYTES;
  invariant(cap > 0 && cap <= INDEX_DB_CAP_BYTES, `the index cap must be positive and at most ${INDEX_DB_CAP_BYTES} bytes`);
  const months = monthsOf(opts.months);
  const dbs = new Map<string, Database>();
  for (const key of [...opts.months].sort((a, b) => { const x = parseDbKey(a), y = parseDbKey(b); return x.month !== y.month ? (x.month < y.month ? -1 : 1) : x.part - y.part; })) {
    const db = opts.open(key);
    const existing = db.query("SELECT COUNT(*) AS n FROM sqlite_master").get() as { n: number };
    invariant(existing.n === 0, `the database for ${key} is not empty; a rebuild writes only into empty databases`);
    db.exec(INDEX_SCHEMA);
    dbs.set(key, db);
  }
  const perMonth: Record<string, number> = {};
  for (const key of dbs.keys()) perMonth[key] = 0;
  const sizeOf = (db: Database) => (db.query("SELECT page_count * page_size AS n FROM pragma_page_count(), pragma_page_size()").get() as { n: number }).n;
  // One segment at a time, chunked within it exactly as the live writer chunked its batch (one batch is one segment), so
  // rollover lands where it did live.
  const bySegment = new Map<string, { row: Ingested; segment: string }[]>();
  for (const x of all) { const list = bySegment.get(x.segment) ?? []; list.push(x); bySegment.set(x.segment, list); }
  for (const [, segRows] of bySegment) {
    const byMonth = new Map<string, ReturnType<typeof indexEntry>[]>();
    for (const { row, segment } of segRows) {
      const e = indexEntry(row, segment, months);
      const list = byMonth.get(e.month) ?? [];
      list.push(e);
      byMonth.set(e.month, list);
    }
    for (const [month, entries] of byMonth) {
      const parts = [...dbs.keys()].filter((k) => parseDbKey(k).month === month);
      let p = 0;
      for (let i = 0; i < entries.length; i += INDEX_CHUNK) {
        const chunk = entries.slice(i, i + INDEX_CHUNK);
        // The same reservation the live writer makes: measured size plus this chunk's room must stay within the cap.
        try { p = await partWithRoom(parts, p, month, chunkReserve(chunk), cap, (k) => sizeOf(dbs.get(k)!)); } catch (e) {
          if (e instanceof IndexFullError) return { ok: false, reason: e.message };
          throw e;
        }
        const key = parts[p]!;
        const db = dbs.get(key)!;
        const insert = db.query(INSERT_SQL);
        db.transaction(() => { for (const e of chunk) insert.run(...(entryBinds(e) as never[])); })();
        perMonth[key]! += chunk.length;
      }
    }
  }
  return { ok: true, size: frontier.size, root: toHex(root), segments: keys.length, perMonth };
}

/** An R2-shaped, read-only view of a local directory mirror of the bucket. */
export function dirRecord(dir: string): R2Like {
  const read = (key: string) => {
    const p = join(dir, ...key.split("/"));
    return existsSync(p) && statSync(p).isFile() ? p : null;
  };
  const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
  return {
    async get(key) {
      const p = read(key);
      if (!p) return null;
      const bytes = readFileSync(p);
      return { key, size: bytes.length, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) as ArrayBuffer, text: async () => bytes.toString("utf8") };
    },
    async head(key) { const p = read(key); return p ? { key, size: statSync(p).size } : null; },
    async put() { throw new Error("dirRecord is read-only"); },
    async list(o = {}) {
      const keys = existsSync(dir) ? walk(dir).map((p) => relative(dir, p).split(sep).join("/")).filter((k) => k.startsWith(o.prefix ?? "")).sort() : [];
      return { objects: keys.map((key) => ({ key })), truncated: false };
    },
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const flag = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
  const recordDir = flag("record-dir"), out = flag("out"), verifier = flag("verifier"), months = flag("months")?.split(",").filter(Boolean);
  if (!recordDir || !out || !verifier || !months?.length) {
    console.error("usage: rebuild.ts --record-dir <mirror> --out <dir> --verifier <key> --months YYYY-MM[,YYYY-MM...] [--shard main]");
    process.exit(2);
  }
  mkdirSync(out, { recursive: true });
  if (readdirSync(out).length > 0) { console.error(`${out} is not empty; a rebuild writes only into empty databases`); process.exit(2); }
  const result = await rebuildIndex({ record: dirRecord(recordDir), shard: flag("shard") ?? "main", verifierKeys: [verifier], months, open: (k) => new Database(join(out, `index-${k.replace("/", "_")}.sqlite`)) });
  console.log(JSON.stringify(result));
  process.exit(result.ok ? 0 : 1);
}
