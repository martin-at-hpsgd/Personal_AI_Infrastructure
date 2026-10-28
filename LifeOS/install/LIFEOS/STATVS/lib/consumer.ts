/**
 * Consumer cursors (migration design §3 Lane A item 5, ISC-197).
 *
 * A consumer is a named reader of the record that remembers how far it got: Vigil's tick
 * (`vigil-tick`), the cloud forwarder (`cloud-forward`), the pull (`cloud-pull`). Its position
 * is stored under `<statvsStateDir()>/consumers/<name>.json` as
 *   { floor, offsets: { <segment rel>: byte offset }, tails: { <segment rel>: hash of the row ending there } }.
 *
 * Read and commit are separate. `readSince` returns rows and never moves the cursor; every row
 * carries its own `pos`, the cursor position just after it, so a sender commits the `pos` of its
 * last acknowledged row and a crash or a failed batch between read and commit loses nothing.
 *
 * The rules:
 *  - Segments dated before `floor` are not read unless the position still names them. On commit,
 *    one dated before the new floor (yesterday, UTC) that is sealed and read to its end drops out,
 *    so the stored position stays about two days of writers however long the record grows.
 *  - On every read the tail hash is checked. A redaction rewrites a segment shorter (data → null)
 *    but keeps every row's `hash`, so the reader re-seeks to just after the row with the stored
 *    tail hash. A segment whose tail cannot be found resets to one hour back and is reported.
 *  - A missing or unparseable consumer file baselines at the end of the record (or, with
 *    `baselineDays`, that many days back) and is persisted at once; it never reads from the
 *    record's start. The result says `baselined: true` so the caller can write its baseline row.
 *  - A stored position in the future (a floor after today, or an offset past a segment's end with
 *    no tail to re-seek to) resets to one hour back, as Vigil's tick does today.
 *
 * @version 1.0.0
 */
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { invariant } from "../../TOOLS/Invariant";
import { tailState } from "../../TOOLS/lib/LedgerCore";
import { listSegments, statvsDir, statvsStateDir, utcDate, type Segment } from "./record";
import type { PrivacyClass, Severity, StatvsRow } from "./types";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const NAME = /^[A-Za-z0-9_.-]+$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const RANK: Record<string, number> = { info: 0, low: 1, medium: 2, high: 3, critical: 4 };
/** How far back the tail check looks for the line ending at a stored offset. Rows over 64 KB keep their payload in objects/. */
const TAIL_WINDOW = 256 * 1024;

export interface ConsumerPos {
  /** Segments dated before this (UTC YYYY-MM-DD) are not read unless `offsets` names them. */
  floor: string;
  /** segment rel → byte offset read up to (always the end of a complete line). */
  offsets: Record<string, number>;
  /** segment rel → hash of the row that ends at its offset. */
  tails: Record<string, string>;
}

export type ConsumerRow = StatvsRow & { pos: ConsumerPos };

export interface ReadOptions {
  streams?: string[];
  classes?: PrivacyClass[];
  /** Read no segment dated before this (UTC YYYY-MM-DD), whatever the position says. */
  fromDate?: string;
  /** true: only rows that carry a severity. A level: only rows at or above it. */
  severity?: boolean | Severity;
  /** With no stored position, start this many days back instead of at the end of the record. */
  baselineDays?: number;
  /** At most this many rows; `next` then stops just after the last one returned. */
  limit?: number;
  /** The clock, for tests. */
  now?: number;
}

export interface ReadResult {
  rows: ConsumerRow[];
  /** The position after everything this read covered; commit it when every row is handled. */
  next: ConsumerPos;
  /** The consumer file was missing or unparseable and a fresh position was written. */
  baselined?: true;
  /** The stored position was in the future and was reset to one hour back. */
  reset?: true;
  /** Segments whose tail had to be re-sought or reset, and unreadable lines. */
  problems?: string[];
}

export function consumersDir(): string {
  return join(statvsStateDir(), "consumers");
}
export function consumerPath(name: string): string {
  invariant(NAME.test(name), `consumer name must match ${NAME.source}: ${name}`);
  return join(consumersDir(), `${name}.json`);
}

function validPos(p: unknown): p is ConsumerPos {
  if (!p || typeof p !== "object" || Array.isArray(p)) return false;
  const v = p as ConsumerPos;
  if (typeof v.floor !== "string" || !DATE.test(v.floor)) return false;
  if (!v.offsets || typeof v.offsets !== "object" || Array.isArray(v.offsets)) return false;
  if (!v.tails || typeof v.tails !== "object" || Array.isArray(v.tails)) return false;
  for (const [k, o] of Object.entries(v.offsets)) if (!k || !Number.isInteger(o) || o < 0) return false;
  for (const t of Object.values(v.tails)) if (typeof t !== "string" || t.length === 0) return false;
  return true;
}

/** The stored position, or null when the file is missing or unparseable. */
export function loadPos(name: string): ConsumerPos | null {
  let raw: string;
  try { raw = readFileSync(consumerPath(name), "utf8"); } catch { return null; }
  try {
    const p = JSON.parse(raw) as unknown;
    return validPos(p) ? p : null;
  } catch { return null; }
}

function writePos(name: string, pos: ConsumerPos): void {
  invariant(validPos(pos), `a consumer position has a floor date, whole non-negative offsets and string tails (${name})`);
  for (const rel of Object.keys(pos.tails)) invariant((pos.offsets[rel] ?? 0) > 0, `a tail hash belongs to a segment read past its start: ${rel}`);
  mkdirSync(consumersDir(), { recursive: true });
  const path = consumerPath(name);
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  writeFileSync(tmp, JSON.stringify(pos) + "\n", { mode: 0o600 });
  renameSync(tmp, path);
}

// ── Segment reading ──

function readRange(path: string, start: number, end?: number): Buffer {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const stop = Math.min(end ?? size, size);
    if (start >= stop) return Buffer.alloc(0);
    const buf = Buffer.allocUnsafe(stop - start);
    let got = 0;
    while (got < buf.length) {
      const n = readSync(fd, buf, got, buf.length - got, start + got);
      if (n <= 0) break;
      got += n;
    }
    return buf.subarray(0, got);
  } finally { closeSync(fd); }
}

function fileSize(path: string): number {
  try {
    const fd = openSync(path, "r");
    try { return fstatSync(fd).size; } finally { closeSync(fd); }
  } catch { return -1; }
}

interface Line { row: StatvsRow | null; end: number; n: number }

/** Complete lines of a segment from `start`, each with the byte offset just after it. */
function linesFrom(path: string, start: number): Line[] {
  const buf = readRange(path, start);
  const out: Line[] = [];
  let at = 0, n = 0;
  for (;;) {
    const nl = buf.indexOf(10, at);
    if (nl < 0) break;
    n++;
    const text = buf.subarray(at, nl).toString("utf8");
    let row: StatvsRow | null = null;
    if (text.length > 0) {
      try {
        const r = JSON.parse(text) as StatvsRow;
        row = r && typeof r === "object" && typeof r.hlc === "string" && typeof r.hash === "string" ? r : null;
      } catch { row = null; }
    }
    out.push({ row, end: start + nl + 1, n });
    at = nl + 1;
  }
  return out;
}

/** The hash of the row whose line ends exactly at `offset`, or null when no row line ends there. */
function hashEndingAt(path: string, offset: number): string | null {
  if (offset <= 0) return null;
  const from = Math.max(0, offset - TAIL_WINDOW);
  const buf = readRange(path, from, offset);
  if (buf.length !== offset - from || buf[buf.length - 1] !== 10) return null;
  const prevNl = buf.lastIndexOf(10, buf.length - 2);
  if (prevNl < 0 && from > 0) return null; // a line longer than the window: treat as not found
  try {
    const r = JSON.parse(buf.subarray(prevNl + 1, buf.length - 1).toString("utf8")) as StatvsRow;
    return typeof r?.hash === "string" ? r.hash : null;
  } catch { return null; }
}

/** The offset just after the row with this hash, or null. */
function seekHash(path: string, hash: string): number | null {
  for (const l of linesFrom(path, 0)) if (l.row && l.row.hash === hash) return l.end;
  return null;
}

const hlcMs = (hlc: string): number => Number(hlc.slice(0, 13));

/** The offset just after the last row written before `cutMs`, with its hash (one hour back, a baseline at a time). */
function positionAt(path: string, cutMs: number): { offset: number; tail?: string } {
  let offset = 0;
  let tail: string | undefined;
  for (const l of linesFrom(path, 0)) {
    if (l.row && hlcMs(l.row.hlc) >= cutMs) break;
    offset = l.end;
    tail = l.row?.hash;
  }
  return tail ? { offset, tail } : { offset };
}

function isSeal(r: StatvsRow | null): boolean {
  return !!r && r.stream === "statvs" && r.kind === "seal";
}

/** A segment whose last line is its seal row and whose bytes all lie before `offset`. */
function sealedAndRead(path: string, offset: number): boolean {
  const size = fileSize(path);
  if (size < 0 || offset !== size) return false;
  try {
    const st = tailState(path);
    if (st.torn.length > 0 || st.line === null) return false;
    return isSeal(JSON.parse(st.line) as StatvsRow);
  } catch { return false; }
}

// ── Positions ──

function segmentsFor(dir: string, opts: ReadOptions, pos: ConsumerPos): Segment[] {
  return listSegments(dir, opts.classes).filter((s) => {
    if (opts.fromDate && s.date < opts.fromDate) return false;
    return s.date >= pos.floor || Object.hasOwn(pos.offsets, s.rel);
  });
}

/** A position at `cutMs` across every segment dated on or after `floor`. */
function positionAtTime(dir: string, opts: ReadOptions, floor: string, cutMs: number): ConsumerPos {
  const pos: ConsumerPos = { floor, offsets: {}, tails: {} };
  for (const s of listSegments(dir, opts.classes)) {
    if (s.date < floor || (opts.fromDate && s.date < opts.fromDate)) continue;
    const p = positionAt(s.abs, cutMs);
    pos.offsets[s.rel] = p.offset;
    if (p.tail) pos.tails[s.rel] = p.tail;
  }
  return pos;
}

function wanted(row: StatvsRow, opts: ReadOptions): boolean {
  if (opts.streams && !opts.streams.includes(row.stream)) return false;
  if (opts.severity !== undefined && opts.severity !== false) {
    if (typeof row.severity !== "string") return false;
    if (typeof opts.severity === "string" && (RANK[row.severity] ?? -1) < (RANK[opts.severity] ?? 0)) return false;
  }
  return true;
}

const copyPos = (p: ConsumerPos): ConsumerPos => ({ floor: p.floor, offsets: { ...p.offsets }, tails: { ...p.tails } });

/**
 * Rows written since the consumer's stored position, sorted like scan() by (hlc, writer).
 * Never moves the cursor except to persist a baseline for a missing or unparseable file.
 */
export function readSince(name: string, opts: ReadOptions = {}): ReadResult {
  const dir = statvsDir();
  const now = opts.now ?? Date.now();
  const today = utcDate(now);
  const yesterday = utcDate(now - DAY_MS);
  const problems: string[] = [];

  const stored = loadPos(name);
  if (!stored) {
    if (opts.baselineDays !== undefined) {
      invariant(Number.isInteger(opts.baselineDays) && opts.baselineDays >= 0, "baselineDays is a whole number of days");
      const startMs = now - opts.baselineDays * DAY_MS;
      const start = positionAtTime(dir, opts, utcDate(startMs), startMs);
      writePos(name, start);
      const r = readFrom(dir, opts, start, problems);
      return { ...r, baselined: true, ...(problems.length ? { problems } : {}) };
    }
    const end = positionAtTime(dir, opts, yesterday, Number.POSITIVE_INFINITY);
    writePos(name, end);
    return { rows: [], next: end, baselined: true };
  }

  let base = stored;
  let reset: true | undefined;
  if (stored.floor > today) {
    base = positionAtTime(dir, opts, yesterday, now - HOUR_MS);
    reset = true;
    problems.push(`consumer ${name}: floor ${stored.floor} is in the future; reset to one hour back`);
  }
  const r = readFrom(dir, opts, base, problems);
  return { ...r, ...(reset ? { reset } : {}), ...(problems.length ? { problems } : {}) };
}

function readFrom(dir: string, opts: ReadOptions, stored: ConsumerPos, problems: string[]): { rows: ConsumerRow[]; next: ConsumerPos } {
  const now = opts.now ?? Date.now();
  const start = copyPos(stored);
  type Item = { rel: string; row: StatvsRow; end: number };
  const items: Item[] = [];

  for (const seg of segmentsFor(dir, opts, stored)) {
    const size = fileSize(seg.abs);
    if (size < 0) continue;
    let offset = start.offsets[seg.rel] ?? 0;
    const tail = start.tails[seg.rel];
    if (offset > 0) {
      const ok = tail !== undefined && offset <= size && hashEndingAt(seg.abs, offset) === tail;
      if (!ok) {
        const found = tail !== undefined ? seekHash(seg.abs, tail) : null;
        if (found !== null) {
          if (found !== offset) problems.push(`${seg.rel}: re-sought tail ${tail!.slice(0, 12)} from ${offset} to ${found}`);
          offset = found;
        } else {
          const p = positionAt(seg.abs, now - HOUR_MS);
          problems.push(`${seg.rel}: tail not found at ${offset}${offset > size ? " (past the end)" : ""}; reset to one hour back`);
          offset = p.offset;
          if (p.tail) start.tails[seg.rel] = p.tail; else delete start.tails[seg.rel];
        }
      }
    }
    start.offsets[seg.rel] = offset;
    if (offset === 0) delete start.tails[seg.rel];
    for (const l of linesFrom(seg.abs, offset)) {
      if (!l.row) { problems.push(`${seg.rel}: unreadable line ${l.n} after offset ${offset}`); continue; }
      items.push({ rel: seg.rel, row: l.row, end: l.end });
    }
  }
  items.sort((a, b) => (a.row.hlc < b.row.hlc ? -1 : a.row.hlc > b.row.hlc ? 1 : a.row.writer < b.row.writer ? -1 : a.row.writer > b.row.writer ? 1 : 0));

  const rows: ConsumerRow[] = [];
  const cur = copyPos(start);
  const limit = opts.limit ?? Number.POSITIVE_INFINITY;
  let next: ConsumerPos | null = null;
  for (const it of items) {
    cur.offsets[it.rel] = it.end;
    cur.tails[it.rel] = it.row.hash;
    if (!wanted(it.row, opts)) continue;
    rows.push({ ...it.row, pos: copyPos(cur) });
    if (rows.length >= limit) { next = copyPos(cur); break; }
  }
  return { rows, next: next ?? cur };
}

/**
 * Store a position (a row's `pos`, or a read's `next`). The floor moves to yesterday (UTC), and a
 * segment dated before it that is sealed and read to its end, or gone, drops out of the position.
 */
export function commit(name: string, pos: ConsumerPos, opts: { now?: number } = {}): ConsumerPos {
  invariant(validPos(pos), `commit takes a consumer position (${name})`);
  const dir = statvsDir();
  const now = opts.now ?? Date.now();
  const yesterday = utcDate(now - DAY_MS);
  const floor = pos.floor > yesterday ? pos.floor : yesterday;
  invariant(DATE.test(floor) && floor >= pos.floor, "the committed floor is a date and never moves back");
  const out: ConsumerPos = { floor, offsets: {}, tails: {} };
  const dates = new Map(listSegments(dir).map((s) => [s.rel, s]));
  for (const [rel, offset] of Object.entries(pos.offsets)) {
    const seg = dates.get(rel);
    if (!seg) {
      // Gone (pruned): nothing left to read. Keep it only while it could still be today's segment.
      const date = /(\d{4}-\d{2}-\d{2})\/[^/]+\.jsonl$/.exec(rel)?.[1];
      if (!date || date < floor) continue;
    } else if (seg.date < floor && sealedAndRead(seg.abs, offset)) continue;
    out.offsets[rel] = offset;
    const t = pos.tails[rel];
    if (t !== undefined && offset > 0) out.tails[rel] = t;
  }
  writePos(name, out);
  return out;
}

/** Forget a consumer: its next read baselines. */
export function resetConsumer(name: string): void {
  const path = consumerPath(name);
  if (!existsSync(path)) return;
  invariant(path.startsWith(consumersDir()), "a consumer file lives in the consumers dir");
  unlinkSync(path);
}
