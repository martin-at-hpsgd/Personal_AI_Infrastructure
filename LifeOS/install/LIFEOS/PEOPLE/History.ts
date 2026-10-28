/**
 * History.ts — one person's whole history with the DA, merged across channels, from a maintained per-person
 * projection of STATVS kept as plain text (conversation-memory ISA ISC-2, ISC-4, ISC-10; read by `people history`).
 *
 * The projection is a rebuildable view of the record, private under the USER tree beside the other STATVS views:
 *
 *   <views dir>/people/history/
 *     cursor.json                          {"v":1,"segments":{"personal/<day>/<writer>.jsonl":{"offset":…,"row":…}}}
 *     people/<person>/events/<YYYY>.jsonl  one JSON line per event, sorted by (ts, row), each with "v":1
 *     groups/<group>/members.json          {"v":1,"group":…,"members":[…]}
 *     groups/<group>/lines.jsonl           every line of the group, so a member who joins later gets the earlier ones
 *     live-keys.jsonl, backfill-keys.jsonl which live fact replaced which backfilled one
 *
 * `<person>` is the recordable People id (an address-keyed id is already its hash) with `:` and anything else outside
 * [A-Za-z0-9._-] percent-encoded, so no address ever names a directory. Nothing reads the record per lookup: `follow`
 * applies only rows after the cursor (it stats the recent segments of the three writers the history reads) and runs
 * before each history call. A year file is appended to while events arrive in time order; an earlier-dated event (a
 * backfill) or a replaced one rewrites that one file atomically, so every file stays sorted. `rebuild` regenerates the
 * whole tree from STATVS alone into a side tree, resumable through its own cursor, and swaps it in.
 *
 * What a row means and how facts combine is HistoryFacts.ts, shared with the STATVS view `people-history`, whose
 * `compare` proves these files hold what the record says. Erasure through the STATVS route is not followed yet: after
 * one, run `people history --rebuild`.
 */
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { statvsDir, viewsDir, type StatvsRow } from "../STATVS/index.ts";
import { invariant } from "../TOOLS/Invariant.ts";
import { withKernelLock } from "../TOOLS/lib/LedgerCore.ts";
import { getDAName, getPrincipalName } from "../../hooks/lib/identity.ts";
import { applyFact, digestOf, directEvents, factOf, HISTORY_FILES, lineEvent, type DirectFact, type EventRow, type HistoryStore, type LineFact } from "./HistoryFacts.ts";
import { canonicalId, recordableId, recordableIdsOf, resolveIn, scrubContact, UNKNOWN_ID, type Index } from "./Identity.ts";
import { stamp } from "./texts.ts";

export const FORMAT = 1;
/** Read at most this much of a segment per pass, so a long catch-up saves its place as it goes and can resume. */
const CHUNK = 4 << 20;

export const historyRoot = (): string => process.env.PEOPLE_HISTORY_DIR || join(viewsDir(), "people", "history");
/** A directory name for an id: percent-encoded outside [A-Za-z0-9._-], reversible. */
export const dirOf = (id: string): string => id.replace(/[^A-Za-z0-9._-]/g, c => [...Buffer.from(c, "utf8")].map(b => `%${b.toString(16).toUpperCase().padStart(2, "0")}`).join(""));
export const idOfDir = (dir: string): string => decodeURIComponent(dir);

// ── plain-text lines ────────────────────────────────────────────────────────────────────────────────────────────

/** One event as its shard line: fixed key order, empty fields left out, so equal events are equal bytes. */
function lineOf(e: EventRow): string {
  const o: Record<string, unknown> = { v: FORMAT, ts: e.ts, row: e.row_id, channel: e.channel, thread: e.thread };
  if (e.group_id) o.group = e.group_id;
  o.direction = e.direction;
  o.from = e.from_role;
  if (e.from_id) o.from_id = e.from_id;
  if (e.addressed) o.as = e.addressed;
  if (e.text !== null) o.text = e.text;
  if (e.subject !== null) o.subject = e.subject;
  if (e.backfill) o.backfill = true;
  return JSON.stringify(o);
}

function eventOf(line: string, person: string): EventRow | null {
  let o: Record<string, unknown>;
  try { o = JSON.parse(line); } catch { return null; }
  if (!o || o.v !== FORMAT || typeof o.ts !== "string" || typeof o.row !== "string") return null;
  return {
    person_id: person, ts: o.ts, channel: o.channel as EventRow["channel"], thread: o.thread as EventRow["thread"], group_id: typeof o.group === "string" ? o.group : null,
    direction: o.direction as EventRow["direction"], from_role: o.from as EventRow["from_role"], from_id: typeof o.from_id === "string" ? o.from_id : null,
    addressed: (o.as as EventRow["addressed"]) ?? null, text: typeof o.text === "string" ? o.text : null, subject: typeof o.subject === "string" ? o.subject : null,
    backfill: o.backfill === true ? 1 : 0, row_id: o.row,
  };
}

const order = (a: { ts: string; row_id: string }, b: { ts: string; row_id: string }) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.row_id < b.row_id ? -1 : a.row_id > b.row_id ? 1 : 0);
const readLines = (path: string): string[] => { try { return readFileSync(path, "utf8").split("\n").filter(Boolean); } catch { return []; } };

/** Write a file whole: a temp file beside it, then a rename, so a reader never sees half of it. */
function writeAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, path);
}
function appendText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, text, { flag: "a", mode: 0o600 });
}
/** The last line of a file, read from its end. */
function lastLine(path: string): string | null {
  let size: number;
  try { size = statSync(path).size; } catch { return null; }
  if (!size) return null;
  const len = Math.min(size, 64 << 10);
  const buf = readRange(path, size - len, len).toString("utf8").replace(/\n+$/, "");
  return buf.slice(buf.lastIndexOf("\n") + 1) || null;
}
function readRange(path: string, offset: number, len: number): Buffer {
  const buf = Buffer.alloc(len);
  const fd = openSync(path, "r");
  try { readSync(fd, buf, 0, len, offset); } finally { closeSync(fd); }
  return buf;
}

// ── the store ───────────────────────────────────────────────────────────────────────────────────────────────────

interface IndexEntry { key: string; row: string; ts: string; people?: string[]; group?: string }

/**
 * The projection under one root. Changes collect in memory while rows are applied and land on disk at `flush`: each
 * touched year file is appended to, or rewritten sorted when an earlier event or a removal reaches it. Applying a row
 * twice changes nothing (events are unique by row), so a pass cut short and re-run from the cursor is safe.
 */
export class HistoryShards {
  private members = new Map<string, Set<string>>();
  private membersDirty = new Set<string>();
  private groupLines = new Map<string, EventRow[]>();
  private groupLinesNew = new Map<string, EventRow[]>();
  private groupLinesDropped = new Map<string, Set<string>>();
  private inserts = new Map<string, EventRow[]>(); // "<person>/<year>" → events
  private removals = new Map<string, Set<string>>(); // "<person>/<year>" → row ids
  private liveKeys: Set<string> | null = null;
  private liveNew: string[] = [];
  private backfillIndex: IndexEntry[] | null = null;
  private backfillDirty = false;

  constructor(readonly root: string = historyRoot()) {}

  private personDir = (id: string) => join(this.root, "people", dirOf(id));
  private groupDir = (g: string) => join(this.root, "groups", dirOf(g));
  private yearFile = (id: string, year: string) => join(this.personDir(id), "events", `${year}.jsonl`);

  private membersOf(group: string): Set<string> {
    let m = this.members.get(group);
    if (!m) {
      m = new Set<string>();
      try { const o = JSON.parse(readFileSync(join(this.groupDir(group), "members.json"), "utf8")); if (o?.v === FORMAT && Array.isArray(o.members)) for (const x of o.members) if (typeof x === "string") m.add(x); } catch { /* a new group */ }
      this.members.set(group, m);
    }
    return m;
  }
  private linesOf(group: string): EventRow[] {
    let l = this.groupLines.get(group);
    if (!l) { l = readLines(join(this.groupDir(group), "lines.jsonl")).map(x => eventOf(x, "")).filter((e): e is EventRow => !!e); this.groupLines.set(group, l); }
    return l;
  }
  private live(): Set<string> {
    if (!this.liveKeys) {
      this.liveKeys = new Set();
      for (const l of readLines(join(this.root, "live-keys.jsonl"))) { try { const o = JSON.parse(l); if (o?.v === FORMAT && typeof o.key === "string") this.liveKeys.add(o.key); } catch { /* skip */ } }
    }
    return this.liveKeys;
  }
  private index(): IndexEntry[] {
    if (!this.backfillIndex) {
      this.backfillIndex = [];
      for (const l of readLines(join(this.root, "backfill-keys.jsonl"))) { try { const o = JSON.parse(l); if (o?.v === FORMAT && typeof o.key === "string" && typeof o.row === "string") this.backfillIndex.push(o); } catch { /* skip */ } }
    }
    return this.backfillIndex;
  }
  /** Note which backfilled fact holds a key, once: a pass re-run from the cursor adds nothing. */
  private indexOnce(entry: IndexEntry): void {
    if (this.index().some(e => e.key === entry.key && e.row === entry.row)) return;
    this.index().push(entry);
    this.backfillDirty = true;
  }
  private put(e: EventRow): void {
    const k = `${e.person_id}\u0000${e.ts.slice(0, 4)}`;
    (this.inserts.get(k) ?? this.inserts.set(k, []).get(k)!).push(e);
  }
  private remove(person: string, ts: string, row: string): void {
    const k = `${person}\u0000${ts.slice(0, 4)}`;
    (this.removals.get(k) ?? this.removals.set(k, new Set()).get(k)!).add(row);
    const pending = this.inserts.get(k);
    if (pending) this.inserts.set(k, pending.filter(e => e.row_id !== row));
  }

  /** The HistoryFacts operations over these files. */
  store(): HistoryStore {
    return {
      isLive: (keys) => keys.some(k => this.live().has(k)),
      markLive: (keys) => {
        const live = this.live();
        for (const k of keys) if (!live.has(k)) { live.add(k); this.liveNew.push(k); }
        const claimed = new Set(keys);
        const hits = this.index().filter(e => claimed.has(e.key));
        if (!hits.length) return;
        const rows = new Set(hits.map(h => h.row));
        for (const h of hits) {
          if (h.group) {
            for (const m of this.membersOf(h.group)) this.remove(m, h.ts, h.row);
            (this.groupLinesDropped.get(h.group) ?? this.groupLinesDropped.set(h.group, new Set()).get(h.group)!).add(h.row);
            this.groupLines.set(h.group, this.linesOf(h.group).filter(l => l.row_id !== h.row));
            const fresh = this.groupLinesNew.get(h.group);
            if (fresh) this.groupLinesNew.set(h.group, fresh.filter(l => l.row_id !== h.row));
          }
          for (const p of h.people ?? []) this.remove(p, h.ts, h.row);
        }
        this.backfillIndex = this.index().filter(e => !rows.has(e.row));
        this.backfillDirty = true;
      },
      addBackfillKeys: () => { /* recorded by addLine/addDirect, which know who holds the fact */ },
      addMember: (group, id) => {
        const m = this.membersOf(group);
        if (m.has(id)) return;
        m.add(id);
        this.membersDirty.add(group);
        for (const l of this.linesOf(group)) this.put({ ...l, person_id: id });
      },
      addLine: (f: LineFact) => {
        const lines = this.linesOf(f.group);
        if (lines.some(l => l.row_id === f.rowId)) return;
        const e = lineEvent(f, "");
        lines.push(e);
        (this.groupLinesNew.get(f.group) ?? this.groupLinesNew.set(f.group, []).get(f.group)!).push(e);
        for (const m of this.membersOf(f.group)) this.put({ ...e, person_id: m });
        if (f.backfill) for (const key of f.keys) this.indexOnce({ key, row: f.rowId, ts: f.ts, group: f.group });
      },
      addDirect: (f: DirectFact) => {
        const events = directEvents(f);
        for (const e of events) this.put(e);
        if (f.backfill) for (const key of f.keys) this.indexOnce({ key, row: f.rowId, ts: f.ts, people: events.map(e => e.person_id) });
      },
    };
  }

  /** Write every collected change. Year files stay sorted by (ts, row) and unique by row. */
  flush(): void {
    const keys = new Set([...this.inserts.keys(), ...this.removals.keys()]);
    for (const k of keys) {
      const [person, year] = k.split("\u0000") as [string, string];
      const path = this.yearFile(person, year);
      const add = this.inserts.get(k) ?? [];
      const drop = this.removals.get(k) ?? new Set<string>();
      const fresh = [...new Map(add.map(e => [e.row_id, e])).values()].sort(order);
      const last = lastLine(path);
      const tail = last ? eventOf(last, person) : null;
      if (!drop.size && fresh.length && (!tail || order(tail, fresh[0]!) < 0)) { appendText(path, fresh.map(lineOf).join("\n") + "\n"); continue; }
      const existing = readLines(path).map(l => eventOf(l, person)).filter((e): e is EventRow => !!e && !drop.has(e.row_id));
      const byRow = new Map(existing.map(e => [e.row_id, e]));
      for (const e of fresh) if (!byRow.has(e.row_id)) byRow.set(e.row_id, e);
      const all = [...byRow.values()].sort(order);
      invariant(all.every((e, i) => i === 0 || order(all[i - 1]!, e) < 0) && all.every(e => e.person_id === person), "a year file holds one person's events, sorted and unique by row");
      if (all.length) writeAtomic(path, all.map(lineOf).join("\n") + "\n"); else rmSync(path, { force: true });
    }
    for (const g of this.membersDirty) writeAtomic(join(this.groupDir(g), "members.json"), JSON.stringify({ v: FORMAT, group: g, members: [...this.membersOf(g)].sort() }) + "\n");
    const groups = new Set([...this.groupLinesNew.keys(), ...this.groupLinesDropped.keys()]);
    for (const g of groups) {
      const path = join(this.groupDir(g), "lines.jsonl");
      if (this.groupLinesDropped.get(g)?.size) writeAtomic(path, this.linesOf(g).sort(order).map(lineOf).join("\n") + (this.linesOf(g).length ? "\n" : ""));
      else { const fresh = this.groupLinesNew.get(g) ?? []; if (fresh.length) appendText(path, fresh.map(lineOf).join("\n") + "\n"); }
    }
    if (this.liveNew.length) appendText(join(this.root, "live-keys.jsonl"), this.liveNew.map(key => JSON.stringify({ v: FORMAT, key })).join("\n") + "\n");
    if (this.backfillDirty) writeAtomic(join(this.root, "backfill-keys.jsonl"), this.index().map(e => JSON.stringify({ v: FORMAT, ...e })).join("\n") + (this.index().length ? "\n" : ""));
    this.inserts.clear(); this.removals.clear(); this.membersDirty.clear(); this.groupLinesNew.clear(); this.groupLinesDropped.clear();
    this.liveNew = []; this.backfillDirty = false;
  }

  /** Apply rows and write the result. For tests and the backfill's dry run. */
  applyRows(rows: Iterable<StatvsRow>): number {
    const store = this.store();
    let n = 0;
    for (const r of rows) { const f = factOf(r); if (f) { applyFact(store, f); n++; } }
    this.flush();
    return n;
  }

  // ── following the record ──

  private cursorPath = () => join(this.root, "cursor.json");
  readCursor(): Record<string, { offset: number; row: string | null }> {
    try {
      const o = JSON.parse(readFileSync(this.cursorPath(), "utf8"));
      invariant(o?.v === FORMAT, `history cursor format ${o?.v} is not ${FORMAT}; run \`people history --rebuild\``);
      return o.segments ?? {};
    } catch (e) {
      if ((e as { code?: string }).code === "ENOENT") return {};
      throw e;
    }
  }
  private writeCursor(segments: Record<string, { offset: number; row: string | null }>): void {
    invariant(Object.entries(segments).every(([k, c]) => /^personal\/\d{4}-\d{2}-\d{2}\/[A-Za-z0-9_.-]+\.jsonl$/.test(k) && Number.isInteger(c.offset) && c.offset >= 0), "the cursor names record segments and byte offsets only");
    const sorted = Object.fromEntries(Object.keys(segments).sort().map(k => [k, segments[k]!]));
    writeAtomic(this.cursorPath(), JSON.stringify({ v: FORMAT, segments: sorted }, null, 1) + "\n");
  }

  /**
   * Apply every history row written since the cursor and move the cursor, under the projection's lock. Only the
   * three writers' segments from the day before the newest day already applied are looked at (a row lands in the
   * segment of the day it was written), so the cost follows what is new, never the size of the record. `all` walks
   * every day: a rebuild.
   */
  follow(recordDir: string = statvsDir(), opts: { all?: boolean } = {}): { rows: number; segments: number } {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const r = withKernelLock(join(this.root, ".lock"), () => this.followLocked(recordDir, opts), { deadlineMs: 15_000, retryMs: 10 });
    if (!r.ok) throw new Error(`history projection is busy: ${r.message}`);
    return r.value;
  }

  private followLocked(recordDir: string, opts: { all?: boolean }): { rows: number; segments: number } {
    const root = join(recordDir, "personal");
    let dates: string[];
    try { dates = readdirSync(root).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort(); } catch { return { rows: 0, segments: 0 }; }
    const cursor = this.readCursor();
    const days = Object.keys(cursor).map(k => k.split("/")[1]!).sort();
    const newest = opts.all ? undefined : days[days.length - 1];
    const from = newest ? new Date(Date.parse(`${newest}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10) : "";
    const store = this.store();
    let rows = 0, segments = 0;
    for (const date of dates) {
      if (date < from) continue;
      for (const file of HISTORY_FILES) {
        const rel = `personal/${date}/${file}`;
        const abs = join(root, date, file);
        let size: number;
        try { size = statSync(abs).size; } catch { continue; }
        let offset = cursor[rel]?.offset ?? 0;
        invariant(offset <= size, `record segment ${rel} is shorter than the history already applied from it; run \`people history --rebuild\``);
        if (offset === size) continue;
        segments++;
        while (offset < size) {
          const buf = readRange(abs, offset, Math.min(CHUNK, size - offset));
          const end = buf.lastIndexOf(0x0a);
          if (end < 0) break; // a line still being written
          let lastRow: string | null = cursor[rel]?.row ?? null;
          for (const line of buf.subarray(0, end).toString("utf8").split("\n")) {
            if (!line) continue;
            let row: StatvsRow;
            try { row = JSON.parse(line) as StatvsRow; } catch { continue; } // a torn line is the record's to report
            if (typeof row?.id === "string") lastRow = row.id;
            const f = factOf(row);
            if (f) { applyFact(store, f); rows++; }
          }
          offset += end + 1;
          this.flush();
          cursor[rel] = { offset, row: lastRow };
          this.writeCursor(cursor);
        }
      }
    }
    return { rows, segments };
  }

  // ── reading ──

  /** The years one id has shards for, oldest first. */
  years(id: string): string[] {
    try { return readdirSync(join(this.personDir(id), "events")).filter(f => /^\d{4}\.jsonl$/.test(f)).map(f => f.slice(0, 4)).sort(); } catch { return []; }
  }

  /** One id's events from the given years' shards. With `tail`, only the last `tail` lines of the file are read. */
  read(id: string, year: string, tail?: number): EventRow[] {
    const path = this.yearFile(id, year);
    if (tail === undefined) return readLines(path).map(l => eventOf(l, id)).filter((e): e is EventRow => !!e);
    let size: number;
    try { size = statSync(path).size; } catch { return []; }
    let start = size, lines: string[] = [];
    while (start > 0 && lines.length <= tail) {
      start = Math.max(0, start - (64 << 10));
      lines = readRange(path, start, size - start).toString("utf8").split("\n").filter(Boolean);
    }
    if (start > 0) lines = lines.slice(1); // the first may be cut
    return lines.slice(-tail).map(l => eventOf(l, id)).filter((e): e is EventRow => !!e);
  }

  /** Every person id that has shards. */
  people(): string[] {
    try { return readdirSync(join(this.root, "people")).map(idOfDir).sort(); } catch { return []; }
  }

  /** The same per-person digest the STATVS view renders, over every shard. */
  digest(): ReturnType<typeof digestOf> {
    const events: EventRow[] = [];
    for (const id of this.people()) for (const y of this.years(id)) events.push(...this.read(id, y));
    return digestOf(events);
  }
}

/** Open the projection and bring it up to the record. */
export function openHistory(root = historyRoot(), recordDir = statvsDir()): HistoryShards {
  const p = new HistoryShards(root);
  p.follow(recordDir);
  return p;
}

/**
 * Regenerate the projection from STATVS alone. It builds into `<root>.rebuild`, which an interrupted rebuild resumes
 * from its own cursor, and only a finished one replaces the live tree.
 */
export function rebuildHistory(root = historyRoot(), recordDir = statvsDir()): { rows: number; segments: number } {
  const side = `${root}.rebuild`;
  const r = new HistoryShards(side).follow(recordDir, { all: true });
  const old = `${root}.old`;
  rmSync(old, { recursive: true, force: true });
  if (existsSync(root)) renameSync(root, old);
  renameSync(side, root);
  rmSync(old, { recursive: true, force: true });
  return r;
}

// ── the query ───────────────────────────────────────────────────────────────────────────────────────────────────

export interface HistoryItem {
  ts: string;
  channel: "text" | "email";
  thread: "1:1" | "group" | "email";
  group?: string;
  from: { role: "person" | "member" | "principal" | "da" | "unknown"; name: string };
  /** On a group line: whether this person wrote it or was present for it. On mail: how they were addressed. */
  as?: "wrote" | "present" | "to" | "cc" | "bcc";
  text?: string;
  subject?: string;
  backfill?: true;
}

export interface HistoryQuery {
  /** Only items at or after this ISO time; reads every year file from that year on. */
  since?: string;
  /** Without `since`: the newest this many items, tail-read from the newest year file(s). */
  limit?: number;
  /** Every year. */
  all?: boolean;
}

/** The name a recorded person id stands for in the directory. */
function namer(ix: Index): (recorded: string | null) => string {
  const byRecorded = new Map<string, string>();
  for (const id of ix.byId.keys()) byRecorded.set(recordableId(id), id);
  return (recorded) => {
    if (!recorded || recorded === UNKNOWN_ID) return "unknown sender";
    const id = byRecorded.get(recorded);
    return (id && scrubContact(ix.byId.get(canonicalId(id, ix))?.name ?? "")) || "an unnamed contact";
  };
}

/** The events of every id of one human, merged, oldest first, read from only the shards the query needs. */
export function eventsOf(ids: Set<string>, shards: HistoryShards, q: HistoryQuery = {}): EventRow[] {
  const held = [...ids].map(id => ({ id, years: shards.years(id) })).filter(h => h.years.length);
  const out: EventRow[] = [];
  if (q.all || q.since) {
    const fromYear = q.since?.slice(0, 4) ?? "";
    for (const h of held) for (const y of h.years) if (y >= fromYear) out.push(...shards.read(h.id, y));
  } else {
    // Newest first, a year at a time, until the limit is met.
    const limit = q.limit ?? 100;
    const years = [...new Set(held.flatMap(h => h.years))].sort().reverse();
    for (const y of years) {
      for (const h of held) if (h.years.includes(y)) out.push(...shards.read(h.id, y, limit));
      if (new Set(out.map(e => e.row_id)).size >= limit) break;
    }
  }
  const seen = new Set<string>();
  const merged = out.sort(order).filter(e => !seen.has(e.row_id) && !!seen.add(e.row_id)).filter(e => !q.since || e.ts >= q.since);
  return q.all || q.since ? merged : merged.slice(-(q.limit ?? 100));
}

/** One person's history, oldest first. `personId` is any of their People record ids. */
export function historyOf(personId: string, ix: Index, shards: HistoryShards, q: HistoryQuery = {}): HistoryItem[] {
  const mine = recordableIdsOf(personId, ix);
  const nameOf = namer(ix);
  const personName = scrubContact(ix.byId.get(canonicalId(personId, ix))?.name ?? "") || "an unnamed contact";
  const da = getDAName();
  return eventsOf(mine, shards, q).map(e => itemOf(e, mine, personName, nameOf, da));
}

function itemOf(e: EventRow, mine: Set<string>, personName: string, nameOf: (id: string | null) => string, da: string): HistoryItem {
  const self = !!e.from_id && mine.has(e.from_id);
  const from: HistoryItem["from"] = e.from_role === "da" ? { role: "da", name: da }
    : self ? { role: "person", name: personName }
    : e.from_role === "principal" ? { role: "principal", name: e.from_id ? nameOf(e.from_id) : getPrincipalName() }
    : e.from_role === "contact" ? { role: "member", name: nameOf(e.from_id) } : { role: "unknown", name: "unknown sender" };
  const as = e.thread === "group" ? (self ? "wrote" : "present") : e.addressed ?? undefined;
  return {
    ts: e.ts, channel: e.channel, thread: e.thread, ...(e.group_id ? { group: e.group_id } : {}), from, ...(as ? { as } : {}),
    ...(e.text !== null ? { text: e.text } : {}), ...(e.subject !== null ? { subject: e.subject } : {}), ...(e.backfill ? { backfill: true as const } : {}),
  };
}

// ── search ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** Lowercase, accents folded: "Zoë" and "zoe" match. */
export const fold = (s: string): string => s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();

/** Each query word, with the other names of anyone People knows by it: "sasa" also finds the full name and nickname. */
export function aliasTerms(query: string, ix: Index): string[][] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  const names = new Map<string, Set<string>>();
  for (const r of ix.byId.values()) {
    const all = [r.name, r.nickname, r.givenName, r.familyName].filter((x): x is string => typeof x === "string" && !!x.trim()).map(x => fold(scrubContact(x))).filter(Boolean);
    const tokens = new Set(all.flatMap(n => n.split(/\s+/)).concat(all));
    for (const t of tokens) { const set = names.get(t) ?? names.set(t, new Set()).get(t)!; for (const n of all) set.add(n); }
  }
  return words.map(w => [w, ...(names.get(w) ?? [])]);
}

/** Every item in one person's whole history whose words hold every query term (or one of its aliases), oldest first.
 *  No index: a streaming read of that person's shards. */
export function searchHistory(personId: string, query: string, ix: Index, shards: HistoryShards): HistoryItem[] {
  const terms = aliasTerms(query, ix);
  const mine = recordableIdsOf(personId, ix);
  const nameOf = namer(ix);
  const personName = scrubContact(ix.byId.get(canonicalId(personId, ix))?.name ?? "") || "an unnamed contact";
  const da = getDAName();
  return eventsOf(mine, shards, { all: true })
    .filter(e => { const hay = fold(`${e.text ?? ""} ${e.subject ?? ""}`); return terms.every(alts => alts.some(a => hay.includes(a))); })
    .map(e => itemOf(e, mine, personName, nameOf, da));
}

// ── finding the person ──────────────────────────────────────────────────────────────────────────────────────────

export type Found = { ok: true; id: string; name: string } | { ok: false; reason: "not found" | "ambiguous"; names: string[]; ids: string[] };

/** The one human a name, id, email or number names: a record id first, then a handle, then an exact name or
 *  nickname, then a fragment of one. Two different humans matching is ambiguous, never a guess. */
export function findPerson(needle: string, ix: Index): Found {
  const q = needle.trim();
  if (!q) return { ok: false, reason: "not found", names: [], ids: [] };
  const answer = (id: string): Found => { const c = canonicalId(id, ix); return { ok: true, id: c, name: scrubContact(ix.byId.get(c)?.name ?? "") || "an unnamed contact" }; };
  if (ix.byId.has(q)) return answer(q);
  if (/@|\d{7,}/.test(q.replace(/[\s().-]/g, ""))) {
    const p = resolveIn(q, ix);
    return p ? answer(p.id) : { ok: false, reason: "not found", names: [], ids: [] };
  }
  const lower = fold(q);
  const records = [...ix.byId.values()];
  const exact = records.filter(r => fold(r.name ?? "") === lower || fold(r.nickname ?? "") === lower);
  const hits = exact.length ? exact : records.filter(r => fold(r.name ?? "").includes(lower) || fold(r.nickname ?? "").includes(lower));
  const humans = new Map<string, string>();
  for (const r of hits) { const c = canonicalId(r.id, ix); if (!humans.has(c)) humans.set(c, scrubContact(ix.byId.get(c)?.name ?? r.name ?? "")); }
  if (humans.size === 1) return answer([...humans.keys()][0]!);
  return { ok: false, reason: humans.size ? "ambiguous" : "not found", names: [...humans.values()].sort(), ids: [...humans.keys()].sort() };
}

/** Of the humans a name matched, the one the DA has any history with, when exactly one: two records that share a name
 *  but were never linked are told apart by who was actually talked to, never by a guess. */
export function withHistory(found: Found, ix: Index, shards: HistoryShards): Found {
  if (found.ok || found.reason !== "ambiguous") return found;
  const talked = found.ids.filter(id => [...recordableIdsOf(id, ix)].some(r => shards.years(r).length > 0));
  if (talked.length !== 1) return found;
  const id = talked[0]!;
  return { ok: true, id, name: scrubContact(ix.byId.get(id)?.name ?? "") || "an unnamed contact" };
}

// ── rendering ───────────────────────────────────────────────────────────────────────────────────────────────────

/** One line per item, `YYYY-MM-DD HH:mm` in the principal's current zone. */
export function renderHistory(name: string, items: HistoryItem[], tz?: string): string {
  if (!items.length) return `${name}\n  no history`;
  const out = [`${name} — ${items.length} item${items.length === 1 ? "" : "s"}`];
  for (const i of items) {
    const at = tz ? stamp(i.ts, tz) : stamp(i.ts);
    const where = i.thread === "group" ? `group${i.as === "present" ? " (present)" : ""}` : i.thread;
    const body = i.channel === "email" ? `email (${i.as ?? "to"}) "${i.subject ?? ""}"` : (i.text ?? "").replace(/\s+/g, " ").trim();
    out.push(`  ${at}  ${where.padEnd(16)} ${i.from.name}: ${body}${i.backfill ? "  [backfill]" : ""}`);
  }
  return out.join("\n");
}
