/**
 * RES ids: minting, aliases, and the small fold of the RES rows they are derived
 * from (CENSVS ISA F6, ISC-35).
 *
 * There is no private id ledger and no lock here. The next minted number for a
 * kind is read from the record: the highest minted key any `create` row of that
 * kind ever named, plus one. An id is never reissued, because mint() refuses any
 * id a create row has already named, retired ones included. Two processes that
 * mint at the same instant can pick the same number; res.ts create() closes that
 * gap after its append by checking that its own row is the first create for the
 * id, and the loser is told to mint again. The record keeps both rows, and every
 * fold takes the first create and flags the second.
 *
 * Key schemes (GENERA declares which a kind uses):
 *  - natural kinds take the caller's readable key, whitespace runs turned into
 *    "-" (`proposal:IS-0012`, `app:vector`); with no key given, a counter key, but
 *    only when the kind's grammar takes every counter key (takesCounterKeys): an
 *    id-shaped grammar such as `ref`, `release` or `achilles` needs its natural key;
 *  - opaque (personal) kinds never take a readable key. Given a natural id from
 *    the kind's own store, the key is the kind's first letter plus 16 hex of a
 *    keyed HMAC-SHA256 of it (ISC-62), the scheme the resolver uses for people
 *    (`person:p<16 hex>`); with none, a counter key. The HMAC key is derived
 *    (HKDF-SHA256, info `censvs-<kind>-key`) from the STATVS mask key the
 *    shipper uses: STATVS_MASK_KEY, else the sealed core secrets. An unsalted
 *    hash would let anyone holding a candidate email confirm a subject that is
 *    permanent in the cloud, so with no key no keyed id is minted at all;
 *  - a counter key is `n` plus at least six hex digits (`n00002a`), so it can
 *    never collide with a hashed key, whose letter is never `n`.
 *
 * Aliases: a legacy id (an `ACH-` number, `ab:…`, `gear:…`) is written on the RES's
 * create or set row and resolves to exactly one RES. An alias claimed by two RES,
 * or equal to an issued id, resolves to nothing and is reported as a conflict;
 * res.ts refuses to write either case, so it only arises from rows written
 * around this library.
 *
 * The fold reads the `res` and `observe` streams by default. A caller that
 * writes RES rows on another stream adds it with addFoldStream() so mint and
 * aliases see those rows too; the `things` view (LIFEOS/STATVS/views/things.ts)
 * is the global fold over every stream.
 *
 * The fold is bounded (ISC-63), because it runs on the prompt path
 * (SatisfactionCapture → addUpgrade → the Upgrades dual-write). It parses only
 * the lines of its own streams, found by their exact `"stream":"<name>"` bytes
 * before any JSON is parsed (rows are written by JSON.stringify, so those bytes
 * are always there), plus redaction tombstones. It reads only the bytes past a
 * checkpoint kept beside the STATVS views (`statvs-views/censvs-ids*.checkpoint.json`,
 * the views engine's checkpoint shape, so a redaction's invalidateViewsFor
 * drops it too). A checkpoint is trusted only for the same record directory,
 * the same streams, segments whose first line is unchanged and offsets that end
 * a line; anything else, or a tombstone in the tail, refolds from the start.
 *
 * Concept: LIFEOS/DOCUMENTATION/Censvs/CensvsSystem.md * @version 1.1.0
 */
import { createHash, createHmac, hkdfSync } from "node:crypto";
import { closeSync, fstatSync, openSync, readFileSync, readSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { listSegments, statvsDir } from "../STATVS/lib/record";
import { checkpointRel, viewsDir, writeWithin } from "../STATVS/lib/views";
import type { StatvsRow } from "../STATVS/lib/types";
import { invariant } from "../TOOLS/Invariant";
import { lifeosPath } from "../TOOLS/Paths";
import { withKernelLock } from "../TOOLS/lib/LedgerCore";
import { GENERA, OPS, canonicalState, isKind, keyGrammar, looksPersonal, parseSubject, retireState, validSubject } from "./genera";
import type { Authority, KindClass } from "./genera";
import type { Link } from "./sources/common";

/** The stream res.ts writes to unless a caller names another. */
export const RES_STREAM = "res";
/** Streams the fold reads by default: the writer's own and Atlas's observations. */
export const DEFAULT_FOLD_STREAMS: readonly string[] = [RES_STREAM, "observe"];

/** A counter key: `n` then six or more lowercase hex digits. */
export const COUNTER_KEY_RE = /^n([0-9a-f]{6,12})$/;
const ALIAS_MAX = 256;
const ALIAS_RE = /^\S+$/;

/** A row as res.ts writes it; `subject` and `op` are optional envelope fields from F3 on. */
export type ResRow = StatvsRow & { subject?: string; op?: string };

/** One RES as the record's own rows build it. */
export interface FoldedRes {
  id: string;
  kind: string;
  title: string;
  state?: string;
  parent?: string;
  links: Link[];
  class: KindClass;
  authority: Authority;
  data: Record<string, unknown>;
  aliases: string[];
  /** Row id of the first create (or first observe) that brought it into the record. */
  origin: string;
  created: string;
  updated: string;
  /** Row ids of every row this fold applied to the RES, in fold order. */
  rows: string[];
  /** Rows the fold read but did not apply, each as "<row id>: <why>". */
  flags: string[];
}

export interface ResFold {
  res: Record<string, FoldedRes>;
  /** Every id a create or observe row ever named, retired ones included. Never shrinks. */
  issued: Record<string, true>;
  /** alias → ids that claim it. */
  aliases: Record<string, string[]>;
  /** kind → highest counter number minted for it. */
  counters: Record<string, number>;
}

export function emptyFold(): ResFold {
  return { res: {}, issued: {}, aliases: {}, counters: {} };
}

const CLASS_RANK: Record<string, number> = { public: 0, system: 1, personal: 2 };

/** The row's payload: inline data, or the content-addressed object it points at. */
export function rowPayload(row: StatvsRow, dir = statvsDir()): unknown {
  if (row.data !== null && row.data !== undefined) return row.data;
  if (typeof row.obj !== "string" || !/^[a-f0-9]{64}$/.test(row.obj)) return null;
  try {
    return JSON.parse(readFileSync(join(dir, "objects", row.obj.slice(0, 2), `${row.obj}.json`), "utf8"));
  } catch {
    return null;
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function claimAlias(f: ResFold, alias: string, id: string): void {
  const owners = (f.aliases[alias] ??= []);
  if (!owners.includes(id)) owners.push(id);
}

function noteCounter(f: ResFold, kind: string, key: string): void {
  const m = COUNTER_KEY_RE.exec(key);
  if (!m) return;
  const n = parseInt(m[1]!, 16);
  if (n > (f.counters[kind] ?? 0)) f.counters[kind] = n;
}

function mergeData(target: Record<string, unknown>, patch: unknown): void {
  if (!isObj(patch)) return;
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete target[k];
    else target[k] = v;
  }
}

/** Fields of `patch` the writer may not set under the kind's fieldOwners, or []. */
export function unownedFields(kind: string, writer: string, patch: unknown): string[] {
  const owners = isKind(kind) ? GENERA[kind].fieldOwners : undefined;
  if (!owners || !isObj(patch)) return [];
  return Object.keys(patch).filter((f) => Object.hasOwn(owners, f) && !owners[f]!.some((p) => writer.startsWith(p)));
}

/**
 * Apply one row to the fold. Rows without a registered subject or a known op are
 * ignored. The first create of an id wins; a later create is flagged. A set that
 * names a field another writer owns is flagged and that field is not applied.
 */
export function foldResRow(f: ResFold, row: ResRow, dir?: string): ResFold {
  const subject = row.subject;
  const op = row.op;
  if (typeof subject !== "string" || typeof op !== "string" || !(OPS as readonly string[]).includes(op)) return f;
  const p = parseSubject(subject);
  if (!p || !isKind(p.kind)) return f;
  const def = GENERA[p.kind];
  const body = rowPayload(row, dir);
  const d = isObj(body) ? body : {};
  const cur = f.res[subject];
  const flag = (why: string) => {
    if (cur) cur.flags.push(`${row.id}: ${why}`);
  };
  const touch = (r: FoldedRes) => {
    r.updated = row.ts;
    r.rows.push(row.id);
  };

  if (op === "create" || (op === "observe" && !cur)) {
    if (cur) {
      flag(`second ${op} of an existing RES, ignored`);
      return f;
    }
    const state = typeof d.state === "string" ? canonicalState(p.kind, d.state) ?? undefined : undefined;
    const cls = typeof d.class === "string" && (CLASS_RANK[d.class] ?? -1) >= CLASS_RANK[def.class]! ? (d.class as KindClass) : def.class;
    const r: FoldedRes = {
      id: subject,
      kind: p.kind,
      title: typeof d.title === "string" && d.title ? d.title : subject,
      ...(state ? { state } : op === "create" ? { state: def.states[0]! } : {}),
      ...(typeof d.parent === "string" ? { parent: d.parent } : {}),
      links: Array.isArray(d.links) ? (d.links as Link[]).filter((l) => isObj(l) && typeof l.rel === "string" && typeof l.to === "string") : [],
      class: cls,
      authority: def.authority,
      data: {},
      aliases: [],
      origin: row.id,
      created: row.ts,
      updated: row.ts,
      rows: [row.id],
      flags: [],
    };
    mergeData(r.data, d.data);
    for (const a of Array.isArray(d.aliases) ? d.aliases : []) {
      if (typeof a === "string" && !r.aliases.includes(a)) {
        r.aliases.push(a);
        claimAlias(f, a, subject);
      }
    }
    f.res[subject] = r;
    f.issued[subject] = true;
    noteCounter(f, p.kind, p.key);
    return f;
  }

  let target = cur;
  if (!target) {
    // A link or unlink about a git or observed RES the record never observed: the relation is the record's own fact.
    if (def.authority === "record" || (op !== "link" && op !== "unlink")) return f;
    target = f.res[subject] = {
      id: subject, kind: p.kind, title: subject, links: [], class: def.class, authority: def.authority,
      data: {}, aliases: [], origin: row.id, created: row.ts, updated: row.ts, rows: [], flags: [],
    };
  }
  applyChange(f, target, row, op, d, p.kind);
  touch(target);
  return f;
}

function applyChange(f: ResFold, cur: FoldedRes, row: ResRow, op: string, d: Record<string, unknown>, kind: string): void {
  const subject = cur.id;
  const p = { kind };
  const flag = (why: string) => cur.flags.push(`${row.id}: ${why}`);
  const unset = (fields: unknown) => {
    for (const k of Array.isArray(fields) ? fields : []) if (typeof k === "string") delete cur.data[k];
  };
  switch (op) {
    case "set": {
      const blocked = unownedFields(p.kind, row.writer, d.data);
      for (const field of blocked) flag(`set of ${field} by ${row.writer}, which does not own it`);
      const patch = isObj(d.data) ? Object.fromEntries(Object.entries(d.data).filter(([k]) => !blocked.includes(k))) : undefined;
      mergeData(cur.data, patch);
      unset(Array.isArray(d.unset) ? d.unset.filter((k) => !unownedFields(p.kind, row.writer, { [String(k)]: 1 }).length) : []);
      if (typeof d.title === "string" && d.title) cur.title = d.title;
      if (typeof d.parent === "string") cur.parent = d.parent;
      if (typeof d.class === "string") {
        if ((CLASS_RANK[d.class] ?? -1) >= CLASS_RANK[cur.class]!) cur.class = d.class as KindClass;
        else flag(`class lowered from ${cur.class} to ${d.class}, ignored`);
      }
      for (const a of Array.isArray(d.aliases) ? d.aliases : []) {
        if (typeof a === "string" && !cur.aliases.includes(a)) {
          cur.aliases.push(a);
          claimAlias(f, a, subject);
        }
      }
      break;
    }
    case "move":
    case "retire": {
      if (op === "move" && d.verdict !== undefined && d.verdict !== "allowed") return; // a refusal the writer recorded
      const to = typeof d.to === "string" ? canonicalState(p.kind, d.to) : op === "retire" ? retireState(p.kind) : null;
      if (!to) {
        flag(`${op} to an undeclared state, ignored`);
        return;
      }
      cur.state = to;
      break;
    }
    case "observe": {
      if (typeof d.state === "string") {
        const s = canonicalState(p.kind, d.state);
        if (s) cur.state = s;
        else flag(`observed undeclared state ${d.state}, ignored`);
      }
      if (typeof d.title === "string" && d.title) cur.title = d.title;
      mergeData(cur.data, d.data);
      unset(d.unset);
      break;
    }
    case "link": {
      if (typeof d.rel === "string" && typeof d.to === "string" && !cur.links.some((l) => l.rel === d.rel && l.to === d.to)) {
        cur.links.push({ rel: d.rel, to: d.to });
      }
      break;
    }
    case "unlink": {
      cur.links = cur.links.filter((l) => !(l.rel === d.rel && l.to === d.to));
      break;
    }
  }
}

// ── the record fold, bounded: own streams only, past a checkpoint (ISC-63) ───

interface Cache {
  dir: string;
  streams: string;
  offsets: Record<string, number>;
  /** Segment → 16 hex of sha256 of its first line, for every segment read past offset 0. */
  heads: Record<string, string>;
  fold: ResFold;
  /** Tail bytes read since the checkpoint on disk was last written. */
  unsaved: number;
  /** Rows folded since the checkpoint on disk was last written. */
  unsavedRows: number;
}
let cache: Cache | null = null;
const extraStreams = new Set<string>();

/** Classes the fold reads: RES rows are never customer-class (res.ts refuses them). */
const FOLD_CLASSES = ["public", "system", "personal"] as const;
/** The bytes that mark a redaction tombstone line (stream `statvs`, kind `redact`). */
const TOMBSTONE_NEEDLE = Buffer.from('"kind":"redact"');
/** Write the checkpoint once this many tail bytes have been read past it, even with no new RES row. */
const PERSIST_BYTES = 256 * 1024;
const HEAD_READ = 8192;
const CP_LOCK = { deadlineMs: 100, retryMs: 5 };

/** What the last recordFold() call read: lines parsed, bytes read, and where its fold started. */
export interface FoldReadStats {
  parsed: number;
  bytes: number;
  segments: number;
  source: "memory" | "checkpoint" | "full";
  /** Why the checkpoint was not used, when it was not. */
  reason?: string;
  persisted: boolean;
}
let lastStats: FoldReadStats = { parsed: 0, bytes: 0, segments: 0, source: "memory", persisted: false };
export function foldReadStats(): FoldReadStats {
  return { ...lastStats };
}

/** Add a stream the fold reads (a caller that writes RES rows somewhere other than `res`). */
export function addFoldStream(stream: string): void {
  if (DEFAULT_FOLD_STREAMS.includes(stream) || extraStreams.has(stream)) return;
  extraStreams.add(stream);
  cache = null;
}

/** Forget the in-memory fold, as a fresh process would start; the checkpoint on disk stays. */
export function resetResFold(): void {
  cache = null;
  extraStreams.clear();
}

export function foldStreams(): string[] {
  return [...DEFAULT_FOLD_STREAMS, ...[...extraStreams].sort()];
}

/** The checkpoint's view name: one per stream set, so a caller with extra streams never reads another's fold. */
export function foldCheckpointName(streams: readonly string[] = foldStreams()): string {
  const key = streams.join(",");
  if (key === DEFAULT_FOLD_STREAMS.join(",")) return "censvs-ids";
  return `censvs-ids-${createHash("sha256").update(key).digest("hex").slice(0, 8)}`;
}

const headHash = (b: Buffer) => createHash("sha256").update(b).digest("hex").slice(0, 16);

function readAt(fd: number, pos: number, len: number): Buffer {
  const buf = Buffer.allocUnsafe(len);
  let got = 0;
  while (got < len) {
    const n = readSync(fd, buf, got, len - got, pos + got);
    if (n <= 0) break;
    got += n;
  }
  return buf.subarray(0, got);
}

/** The first line of a segment (without its newline), or null while it has none. */
function firstLine(fd: number, size: number): Buffer | null {
  for (let len = Math.min(HEAD_READ, size); len > 0; len = Math.min(len * 4, size)) {
    const b = readAt(fd, 0, len);
    const nl = b.indexOf(10);
    if (nl >= 0) return b.subarray(0, nl);
    if (len >= size) return null;
  }
  return null;
}

interface TailRead {
  rows: ResRow[];
  tombstones: string[];
  offsets: Record<string, number>;
  heads: Record<string, string>;
  parsed: number;
  bytes: number;
  segments: number;
  /** Set when a segment no longer matches `since`: the caller refolds from the start. A tombstone in a tail also refolds, so no checkpoint keeps content a redaction scrubbed. */
  invalid?: string;
}

/**
 * Read the rows of `streams` (and the redaction tombstones) past `since`. Lines are picked by
 * their exact stream bytes before JSON.parse, so no other row is ever parsed. A segment that
 * no longer lines up with `since` (gone, shorter, a different first line, an offset mid-line)
 * makes the read invalid.
 */
function readTail(dir: string, streams: readonly string[], since: Record<string, number>, heads: Record<string, string>): TailRead {
  const out: TailRead = { rows: [], tombstones: [], offsets: {}, heads: {}, parsed: 0, bytes: 0, segments: 0 };
  const needles = streams.map((s) => Buffer.from(`"stream":${JSON.stringify(s)}`));
  const segs = listSegments(dir, [...FOLD_CLASSES]);
  const present = new Set(segs.map((s) => s.rel));
  for (const rel of Object.keys(since)) if ((since[rel] ?? 0) > 0 && !present.has(rel)) return { ...out, invalid: `segment ${rel} is gone` };
  for (const seg of segs) {
    const start = since[seg.rel] ?? 0;
    let fd: number;
    try { fd = openSync(seg.abs, "r"); } catch { if (start > 0) return { ...out, invalid: `segment ${seg.rel} is unreadable` }; continue; }
    try {
      const size = fstatSync(fd).size;
      if (start > size) return { ...out, invalid: `offset ${start} is past the end of ${seg.rel}` };
      if (start > 0) {
        const head = firstLine(fd, size);
        if (!head || heads[seg.rel] !== headHash(head)) return { ...out, invalid: `segment ${seg.rel} was rewritten` };
        out.heads[seg.rel] = heads[seg.rel]!;
        if (readAt(fd, start - 1, 1)[0] !== 10) return { ...out, invalid: `offset ${start} lands mid-line in ${seg.rel}` };
      }
      if (start === size) { out.offsets[seg.rel] = start; continue; }
      const buf = readAt(fd, start, size - start);
      out.bytes += buf.length;
      out.segments++;
      const lastNl = buf.lastIndexOf(10);
      out.offsets[seg.rel] = start + lastNl + 1;
      if (start === 0 && lastNl >= 0) out.heads[seg.rel] = headHash(buf.subarray(0, buf.indexOf(10)));
      if (lastNl < 0) continue;
      // Line starts of every line that holds one of the needles, in file order.
      const starts = new Set<number>();
      for (const n of [...needles, TOMBSTONE_NEEDLE]) {
        for (let at = buf.indexOf(n); at >= 0 && at < lastNl; at = buf.indexOf(n, at + n.length)) starts.add(buf.lastIndexOf(10, at) + 1);
      }
      for (const s of [...starts].sort((a, b) => a - b)) {
        const e = buf.indexOf(10, s);
        let row: ResRow;
        try { row = JSON.parse(buf.subarray(s, e).toString("utf8")) as ResRow; } catch { continue; } // malformed: scan() reports it
        out.parsed++;
        if (!row || typeof row !== "object" || typeof row.hlc !== "string") continue;
        if (row.stream === "statvs" && row.kind === "redact") {
          const t = (row.data as { target?: unknown } | null)?.target;
          if (typeof t === "string") out.tombstones.push(t);
          continue;
        }
        if (streams.includes(row.stream)) out.rows.push(row);
      }
    } finally {
      closeSync(fd);
    }
  }
  out.rows.sort((a, b) => (a.hlc < b.hlc ? -1 : a.hlc > b.hlc ? 1 : a.writer < b.writer ? -1 : a.writer > b.writer ? 1 : 0));
  return out;
}

interface FoldCheckpoint {
  v: 1;
  view: string;
  path: string;
  record: string;
  streams: string;
  offsets: Record<string, number>;
  heads: Record<string, string>;
  state: ResFold;
  updated: string;
}

function isRecordOf(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The checkpoint for this record and stream set, or why it cannot be used. */
function loadCheckpoint(dir: string, streams: string, name: string): FoldCheckpoint | string {
  let raw: string;
  try { raw = readFileSync(join(viewsDir(), checkpointRel(name)), "utf8"); } catch { return "no checkpoint"; }
  let cp: Partial<FoldCheckpoint>;
  try { cp = JSON.parse(raw) as Partial<FoldCheckpoint>; } catch { return "checkpoint unreadable"; }
  if (!cp || cp.v !== 1 || cp.view !== name) return "checkpoint version or name mismatch";
  if (cp.record !== dir) return "checkpoint is for another record";
  if (cp.streams !== streams) return "checkpoint is for other streams";
  if (!isRecordOf(cp.offsets) || !isRecordOf(cp.heads) || !isRecordOf(cp.state)) return "checkpoint shape is wrong";
  for (const [rel, off] of Object.entries(cp.offsets)) {
    if (typeof off !== "number" || !Number.isInteger(off) || off < 0 || rel.split("/").some((s) => s === ".." || s === "")) return `bad offset for ${rel}`;
    if (off > 0 && typeof cp.heads[rel] !== "string") return `no first-line hash for ${rel}`;
  }
  const s = cp.state as Partial<ResFold>;
  if (!isRecordOf(s.res) || !isRecordOf(s.issued) || !isRecordOf(s.aliases) || !isRecordOf(s.counters)) return "checkpoint fold shape is wrong";
  return cp as FoldCheckpoint;
}

/** Write the checkpoint, best effort: a held lock or an unwritable views dir leaves the in-memory fold standing. */
function persist(c: Cache, name: string): boolean {
  invariant(isAbsolute(c.dir), "the fold checkpoint names its record by absolute path");
  invariant(Object.values(c.offsets).every((o) => Number.isInteger(o) && o >= 0), "fold checkpoint offsets are non-negative integers");
  invariant(Object.entries(c.offsets).every(([rel, o]) => o === 0 || typeof c.heads[rel] === "string"), "every segment read past 0 has its first-line hash");
  invariant(isRecordOf(c.fold.res) && isRecordOf(c.fold.issued) && isRecordOf(c.fold.aliases) && isRecordOf(c.fold.counters), "the fold checkpoint holds a whole fold");
  const cp: FoldCheckpoint = {
    v: 1, view: name, path: `statvs-views/${name}.json`, record: c.dir, streams: c.streams,
    offsets: c.offsets, heads: c.heads, state: c.fold, updated: new Date().toISOString(),
  };
  try {
    const root = viewsDir();
    const r = withKernelLock(join(root, checkpointRel(name)) + ".lock", () => writeWithin(root, checkpointRel(name), JSON.stringify(cp)), CP_LOCK);
    if (r.ok) { c.unsaved = 0; c.unsavedRows = 0; }
    return r.ok;
  } catch {
    return false;
  }
}

/**
 * Fold rows into the cache. A redacted row is still folded: the record scrubbed its payload in
 * place, and its id stays issued, because an id is never reissued.
 */
function foldRows(c: Cache, rows: ResRow[]): number {
  for (const row of rows) foldResRow(c.fold, row, c.dir);
  return rows.length;
}

/**
 * The fold of the RES rows in the local record. A process keeps it in memory and reads only
 * the bytes appended since; a fresh process starts from the checkpoint on disk. Only lines of
 * the fold's own streams are parsed. A different STATVS_DIR starts over.
 */
export function recordFold(opts: { dir?: string } = {}): ResFold {
  const dir = resolve(opts.dir ?? statvsDir());
  const streams = foldStreams();
  const key = streams.join(",");
  const name = foldCheckpointName(streams);
  let source: FoldReadStats["source"] = "memory";
  let reason: string | undefined;
  if (!cache || cache.dir !== dir || cache.streams !== key) {
    const cp = loadCheckpoint(dir, key, name);
    if (typeof cp === "string") {
      cache = null;
      reason = cp;
    } else {
      cache = { dir, streams: key, offsets: { ...cp.offsets }, heads: { ...cp.heads }, fold: cp.state, unsaved: 0, unsavedRows: 0 };
      source = "checkpoint";
    }
  }
  let tail = cache ? readTail(dir, streams, cache.offsets, cache.heads) : null;
  if (tail && (tail.invalid || tail.tombstones.length > 0)) {
    reason = tail.invalid ?? "a redaction landed since the checkpoint";
    cache = null;
    tail = null;
  }
  let parsed = tail?.parsed ?? 0;
  let bytes = tail?.bytes ?? 0;
  let segments = tail?.segments ?? 0;
  let dirty = false;
  if (!cache || !tail) {
    const all = readTail(dir, streams, {}, {});
    cache = { dir, streams: key, offsets: all.offsets, heads: all.heads, fold: emptyFold(), unsaved: 0, unsavedRows: 0 };
    foldRows(cache, all.rows);
    parsed += all.parsed;
    bytes += all.bytes;
    segments += all.segments;
    source = "full";
    dirty = true;
  } else {
    const n = foldRows(cache, tail.rows);
    cache.offsets = { ...cache.offsets, ...tail.offsets };
    cache.heads = { ...cache.heads, ...tail.heads };
    cache.unsaved += tail.bytes;
    cache.unsavedRows += n;
    dirty = cache.unsavedRows > 0 || cache.unsaved >= PERSIST_BYTES;
  }
  const persisted = dirty ? persist(cache, name) : false;
  lastStats = { parsed, bytes, segments, source, ...(reason ? { reason } : {}), persisted };
  return cache.fold;
}

// ── aliases ──────────────────────────────────────────────────────────────────

/** Why an alias may not be given to `id`, or null. */
export function aliasProblem(alias: unknown, id: string, f: ResFold): string | null {
  if (typeof alias !== "string" || !alias || alias.length > ALIAS_MAX || !ALIAS_RE.test(alias)) {
    return `alias must be a non-empty string of at most ${ALIAS_MAX} characters with no whitespace`;
  }
  if (looksPersonal(alias)) return `alias ${JSON.stringify(alias)} carries personal-looking content`;
  if (alias === id || Object.hasOwn(f.issued, alias)) return `alias ${alias} is an issued RES id`;
  const owners = f.aliases[alias] ?? [];
  const other = owners.find((o) => o !== id);
  if (other) return `alias ${alias} already resolves to ${other}`;
  return null;
}

/** The one RES id an id or alias names, or null (unknown, or an alias claimed by more than one RES). */
export function resolveId(idOrAlias: string, f: ResFold = recordFold()): string | null {
  if (Object.hasOwn(f.res, idOrAlias)) return idOrAlias;
  const owners = f.aliases[idOrAlias] ?? [];
  return owners.length === 1 && !Object.hasOwn(f.issued, idOrAlias) ? owners[0]! : null;
}

/** Aliases claimed by more than one RES, or equal to an issued id: alias → ids. */
export function aliasConflicts(f: ResFold = recordFold()): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [a, owners] of Object.entries(f.aliases)) if (owners.length > 1 || Object.hasOwn(f.issued, a)) out[a] = [...owners];
  return out;
}

// ── mint ─────────────────────────────────────────────────────────────────────

export type MintResult = { ok: true; id: string } | { ok: false; refused: string; id?: string };

/** The next counter key for a kind, from the fold. */
export function nextCounterKey(kind: string, f: ResFold): string {
  const n = (f.counters[kind] ?? 0) + 1;
  return "n" + n.toString(16).padStart(6, "0");
}

/** Counter keys at the edges of COUNTER_KEY_RE: shortest and longest, all digits, all letters, mixed. */
const COUNTER_SAMPLES = ["n000001", "nabcdef", "n0a1b2c", "n" + "f".repeat(12), "n" + "0".repeat(11) + "9"];

/**
 * True when a kind can take counter keys: opaque kinds always, a natural kind only when its key
 * grammar accepts every counter key. `ref`, `release`, `criterion` and the other id-shaped
 * grammars do not, so those kinds take only the natural key their own store issues.
 */
export function takesCounterKeys(kind: string): boolean {
  if (!isKind(kind)) return false;
  const g = keyGrammar(kind);
  return g === null || COUNTER_SAMPLES.every((k) => g.test(k));
}

// ── keyed opaque keys (ISC-62) ────────────────────────────────────────────────

/** Where the shipper's mask key is sealed when STATVS_MASK_KEY is not set (core/tools/ship.ts reads the same file). */
const SEALED_CORE_SECRETS = () => lifeosPath("USER", "STATVS", "core-secrets.json.age");
let sealedMaskKey: string | null | undefined;
const derivedKeys = new Map<string, Buffer>();

/**
 * The STATVS mask key, or null: STATVS_MASK_KEY, else the sealed core secrets. Under `bun test`
 * the sealed file is never opened, so a test without STATVS_MASK_KEY has no key.
 */
function maskKey(): string | null {
  const env = process.env.STATVS_MASK_KEY;
  if (env) return env;
  if (process.env.NODE_ENV === "test") return null;
  if (sealedMaskKey === undefined) sealedMaskKey = readSealedMaskKey();
  return sealedMaskKey;
}

/**
 * The mask key from the sealed core secrets, read once by a child bun through Secrets.ts openSealedFile (the
 * shipper's own path). A child, not a require: Secrets.ts holds a top-level await, which a require cannot load
 * and the workflow runner's bundler refuses. The key comes back on a pipe; argv carries only the two file paths.
 * Only a keyed mint pays for this, and only once per process.
 */
function readSealedMaskKey(): string | null {
  try {
    const script = [
      `const { openSealedFile } = await import(${JSON.stringify(lifeosPath("TOOLS", "Secrets.ts"))});`,
      `const s = JSON.parse(new TextDecoder().decode(openSealedFile(${JSON.stringify(SEALED_CORE_SECRETS())})));`,
      `process.stdout.write(typeof s.STATVS_MASK_KEY === "string" ? s.STATVS_MASK_KEY : "");`,
    ].join("\n");
    const r = Bun.spawnSync([process.execPath, "-e", script], { stdout: "pipe", stderr: "ignore", timeout: 15_000 });
    const key = r.exitCode === 0 ? r.stdout.toString() : "";
    return key.length > 0 ? key : null;
  } catch {
    return null; // no identity, no file, no age: no key
  }
}

/** True when a keyed opaque key can be minted on this machine right now. */
export function opaqueKeyAvailable(): boolean {
  return maskKey() !== null;
}

/** The HMAC key for a kind's opaque keys: HKDF-SHA256 of the mask key, info `censvs-<kind>-key`. Never stored. */
function kindKey(kind: string): Buffer | null {
  const mk = maskKey();
  if (!mk) return null;
  const id = `${kind}\0${createHash("sha256").update(mk).digest("hex")}`;
  let k = derivedKeys.get(id);
  if (!k) {
    k = Buffer.from(hkdfSync("sha256", Buffer.from(mk, "utf8"), Buffer.alloc(0), Buffer.from(`censvs-${kind}-key`, "utf8"), 32));
    derivedKeys.set(id, k);
  }
  return k;
}

/**
 * An opaque key derived from a natural id in the kind's own store: the kind's first letter, then
 * 16 hex of HMAC-SHA256(kindKey, natural), with a digit forced so it always matches OPAQUE_KEY_RE.
 * Null when no mask key is available: the unsalted hash is never a fallback.
 */
export function hashedKey(kind: string, natural: string): string | null {
  const k = kindKey(kind);
  if (!k) return null;
  const hex = createHmac("sha256", k).update(natural).digest("hex").slice(0, 16);
  return kind[0]! + (/\d/.test(hex) ? hex : `${hex.slice(0, 15)}0`);
}

/**
 * A new RES id of `kind`, or a refusal. Writes nothing; res.create() records it.
 *
 *  - natural kind, `natural` given → `<kind>:<natural>` (whitespace runs become "-");
 *  - opaque kind, `natural` given → `<kind>:<letter><16 hex of a keyed HMAC of natural>` (refused with no mask key);
 *  - no `natural` → `<kind>:n<next counter in hex>`, the counter read from the record, for a
 *    kind that takesCounterKeys(); any other kind is refused and must pass its natural key.
 *
 * Refused: an unregistered kind, an id that fails validSubject (personal-looking
 * or credential-shaped keys among them), an id any create or observe row already
 * named (it is returned as `id` so the caller can use it), or one that is an alias.
 */
export function mint(kind: string, natural?: string, opts: { fold?: ResFold } = {}): MintResult {
  if (!isKind(kind)) return { ok: false, refused: `unknown kind "${kind}": not registered in GENERA` };
  const f = opts.fold ?? recordFold();
  let key: string;
  if (natural === undefined) {
    if (!takesCounterKeys(kind)) return { ok: false, refused: `kind "${kind}" has no counter keys: its ${GENERA[kind].grammar} key grammar needs the natural key its own store issues` };
    key = nextCounterKey(kind, f);
  } else {
    if (typeof natural !== "string" || !natural.trim()) return { ok: false, refused: "natural key must be a non-empty string" };
    if (GENERA[kind].key === "opaque") {
      const k = hashedKey(kind, natural);
      if (k === null) return { ok: false, refused: `no ${kind} key: the STATVS mask key is unavailable, so a keyed ${kind} id cannot be minted (never an unsalted hash)` };
      key = k;
    } else key = natural.trim().replace(/\s+/g, "-");
  }
  const id = `${kind}:${key}`;
  const bad = validSubject(id);
  if (bad) return { ok: false, refused: bad };
  if (Object.hasOwn(f.issued, id)) return { ok: false, refused: `${id} was already issued; ids are never reissued`, id };
  const owners = f.aliases[id];
  if (owners?.length) return { ok: false, refused: `${id} is an alias of ${owners.join(", ")}` };
  return { ok: true, id };
}
