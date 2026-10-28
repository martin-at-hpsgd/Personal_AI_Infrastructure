/**
 * HistoryFacts.ts — what one STATVS row means for per-person history, and how facts combine (conversation-memory ISA
 * ISC-2, ISC-10). Pure: no files, no database, no People store.
 *
 * The per-person history projection (History.ts, plain-text shards) and its STATVS view (STATVS/views/people-history.ts, a JSON
 * fold) both apply rows through `applyFact` against their own `HistoryStore`, so the two can be compared: the view is
 * the record's answer, the projection is the fast one, and `Statvs.ts compare people-history` proves they agree.
 *
 * Rows read: `lib:relay` texts that carry `person` (and send.ts group sends), `group_members`; `tool:gmail` mail; and
 * `tool:people-backfill` rows (Backfill.ts). The combining rules give the same result in any row order, so an
 * incremental follow and a rebuild agree:
 *   - a live fact claims its keys, and any backfilled fact holding one of them is dropped, whichever came first;
 *   - a group line is in the history of every member of its group, members are every id a `group_members` row lists
 *     plus every speaker of a line (a skipped duplicate line's speaker included), and a member added later gets every
 *     earlier line.
 */
import { createHash } from "node:crypto";
import type { StatvsRow } from "../STATVS/index.ts";

export const HISTORY_WRITERS = ["lib:relay", "tool:gmail", "tool:people-backfill"] as const;
export const HISTORY_STREAMS = ["relay", "mail"] as const;
export const UNKNOWN = "unknown";

export type FromRole = "contact" | "principal" | "da" | "unknown";
/** One person's view of a fact: one row of the projection's `events` table. */
export interface EventRow {
  person_id: string; ts: string; channel: "text" | "email"; thread: "1:1" | "group" | "email"; group_id: string | null;
  direction: "in" | "out"; from_role: FromRole; from_id: string | null; addressed: "to" | "cc" | "bcc" | null;
  text: string | null; subject: string | null; backfill: 0 | 1; row_id: string;
  /** The hash of text and subject, where a store keeps the hash instead of the words (the view's JSON state). */
  content?: string;
}

interface Base { rowId: string; ts: string; backfill: boolean; keys: string[] }
/** A 1:1 text or a mail: in the history of each of `to`. */
export interface DirectFact extends Base {
  kind: "direct"; channel: "text" | "email"; thread: "1:1" | "email"; direction: "in" | "out";
  to: Array<{ person: string; addressed: "to" | "cc" | "bcc" | null }>; from_role: FromRole; from_id: string | null;
  text: string | null; subject: string | null;
}
/** A group line: in the history of every member of its group. */
export interface LineFact extends Base {
  kind: "line"; group: string; direction: "in" | "out"; from_role: FromRole; from_id: string | null; text: string | null;
}
export interface MembersFact { kind: "members"; group: string; ids: string[] }
export type Fact = DirectFact | LineFact | MembersFact;

type Data = Record<string, unknown>;
const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
const isGroupThread = (t: string | undefined): boolean => !!t && t.includes(";+;");
/** Every time in one form, so string order is time order. */
export function isoOf(...candidates: unknown[]): string {
  for (const c of candidates) { const t = typeof c === "string" ? Date.parse(c) : NaN; if (Number.isFinite(t)) return new Date(t).toISOString(); }
  return new Date(0).toISOString();
}
const segmentFile = (writer: string) => `${writer.replace(/[^A-Za-z0-9_.-]/g, "_")}.jsonl`;
/** The segment file names of the writers the history reads. */
export const HISTORY_FILES: readonly string[] = HISTORY_WRITERS.map(segmentFile);

/** What a row means for the history, or null when it means nothing to it. */
export function factOf(row: StatvsRow): Fact | null {
  if (!row || typeof row !== "object" || !(HISTORY_WRITERS as readonly string[]).includes(row.writer)) return null;
  if (!(HISTORY_STREAMS as readonly string[]).includes(row.stream)) return null;
  const d = (row.data ?? null) as Data | null;
  if (!d || typeof d !== "object") return null;
  const event = str(d.event);
  const backfill = d.backfill === true;
  const ts = isoOf(d.ts, row.ts);
  if (event === "group_members") {
    const group = str(d.thread);
    const ids = (Array.isArray(d.members) ? d.members : []).map(str).filter((x): x is string => !!x && x !== UNKNOWN);
    return group && ids.length ? { kind: "members", group, ids } : null;
  }
  if (event === "email_out") {
    const to = (Array.isArray(d.recipients) ? d.recipients as Array<{ field?: unknown; person?: unknown }> : [])
      .map(r => ({ person: str(r.person), addressed: r.field === "to" || r.field === "cc" || r.field === "bcc" ? r.field : null }))
      .filter((r): r is { person: string; addressed: "to" | "cc" | "bcc" | null } => !!r.person && r.person !== UNKNOWN);
    const key = `mail:${str(d.message_id) ?? row.id}`;
    return { kind: "direct", rowId: row.id, ts, backfill, keys: [key], channel: "email", thread: "email", direction: "out", to, from_role: "da", from_id: null, text: null, subject: str(d.subject) ?? "" };
  }
  if (event !== "text_in" && event !== "text_out" && event !== "voice_out" && event !== "text") return null;
  const inbound = event === "text_in" || (event === "text" && d.direction === "in");
  const thread = str(d.thread);
  const group = backfill ? (d.group === true ? thread : undefined) : isGroupThread(thread) ? thread : undefined;
  // A live row from before rows carried a person names no one (the backfill holds that fact); a send.ts group send
  // names its group by thread and no single person.
  if (!backfill && !("person" in d) && !(group && d.via === "send")) return null;
  const person = str(d.person);
  const turn = str(d.turn), message = str(d.message);
  const keys = backfill
    ? (Array.isArray(d.keys) ? d.keys.filter((k): k is string => typeof k === "string") : [])
    : inbound ? (turn ? [`in:${turn}`] : []) : [turn ? `outturn:${turn}` : "", message ? `msg:${message}` : ""].filter(Boolean);
  const text = str(d.text) ?? null;
  if (group) {
    const from_role: FromRole = !inbound ? "da" : d.role === "principal" ? "principal" : person && person !== UNKNOWN ? "contact" : "unknown";
    return { kind: "line", rowId: row.id, ts, backfill, keys, group, direction: inbound ? "in" : "out", from_role, from_id: inbound && person && person !== UNKNOWN ? person : null, text };
  }
  if (!person || person === UNKNOWN) return null;
  return {
    kind: "direct", rowId: row.id, ts, backfill, keys, channel: "text", thread: "1:1", direction: inbound ? "in" : "out",
    to: [{ person, addressed: null }], from_role: inbound ? "contact" : "da", from_id: inbound ? person : null, text, subject: null,
  };
}

// ── combining ───────────────────────────────────────────────────────────────────────────────────────────────────

/** The operations a history store offers; the plain-text shards and the JSON view each implement them. */
export interface HistoryStore {
  /** True when a live fact already holds one of these keys. */
  isLive(keys: string[]): boolean;
  /** Record a live fact's keys, dropping every backfilled fact that holds one. */
  markLive(keys: string[]): void;
  /** Remember which keys a backfilled fact holds, so a live copy can replace it. */
  addBackfillKeys(rowId: string, keys: string[]): void;
  addMember(group: string, id: string): void;
  addLine(f: LineFact): void;
  addDirect(f: DirectFact): void;
}

export function applyFact(store: HistoryStore, f: Fact | null): void {
  if (!f) return;
  if (f.kind === "members") { for (const id of f.ids) store.addMember(f.group, id); return; }
  // A speaker is a member whether or not this copy of the line is kept, so membership is the same in any order.
  if (f.kind === "line" && f.from_id) store.addMember(f.group, f.from_id);
  if (!f.backfill) { if (f.keys.length) store.markLive(f.keys); }
  else if (f.keys.length && store.isLive(f.keys)) return;
  else store.addBackfillKeys(f.rowId, f.keys);
  if (f.kind === "line") store.addLine(f); else store.addDirect(f);
}

/** The events a direct fact puts in each recipient's history: one per person, addressed as they first appear (To
 *  before Cc before Bcc), so a person on two lines of one mail holds it once. */
export function directEvents(f: DirectFact): EventRow[] {
  const seen = new Set<string>();
  return f.to.filter(t => !seen.has(t.person) && !!seen.add(t.person)).map(t => ({
    person_id: t.person, ts: f.ts, channel: f.channel, thread: f.thread, group_id: null, direction: f.direction, from_role: f.from_role,
    from_id: f.from_id, addressed: t.addressed, text: f.text, subject: f.subject, backfill: f.backfill ? 1 : 0, row_id: f.rowId,
  }));
}

/** The event a group line puts in one member's history. */
export function lineEvent(f: Pick<LineFact, "rowId" | "ts" | "group" | "direction" | "from_role" | "from_id" | "text" | "backfill">, member: string): EventRow {
  return {
    person_id: member, ts: f.ts, channel: "text", thread: "group", group_id: f.group, direction: f.direction, from_role: f.from_role,
    from_id: f.from_id, addressed: null, text: f.text, subject: null, backfill: f.backfill ? 1 : 0, row_id: f.rowId,
  };
}

// ── the record's answer: a JSON store, for the STATVS view ──────────────────────────────────────────────────────

/** A group line as the JSON state keeps it: the hash of its words, never the words. */
type LineRec = Pick<LineFact, "ts" | "group" | "direction" | "from_role" | "from_id" | "backfill"> & { content: string };
export interface MemoryState {
  v: 1;
  live: Record<string, 1>;
  backfillKeys: Record<string, string[]>;
  members: Record<string, Record<string, 1>>;
  lines: Record<string, LineRec>;
  directs: Record<string, EventRow[]>;
}

export const emptyMemory = (): MemoryState => ({ v: 1, live: {}, backfillKeys: {}, members: {}, lines: {}, directs: {} });

/** A HistoryStore over plain JSON state, updated in place. */
export function memoryStore(s: MemoryState): HistoryStore {
  const drop = (rowId: string) => { delete s.lines[rowId]; delete s.directs[rowId]; };
  return {
    isLive: (keys) => keys.some(k => s.live[k] === 1),
    markLive: (keys) => {
      for (const k of keys) {
        s.live[k] = 1;
        for (const rowId of s.backfillKeys[k] ?? []) drop(rowId);
        delete s.backfillKeys[k];
      }
    },
    addBackfillKeys: (rowId, keys) => { for (const k of keys) (s.backfillKeys[k] ??= []).push(rowId); },
    addMember: (group, id) => { (s.members[group] ??= {})[id] = 1; },
    addLine: (f) => { s.lines[f.rowId] ??= { ts: f.ts, group: f.group, direction: f.direction, from_role: f.from_role, from_id: f.from_id, backfill: f.backfill, content: contentHash(f.text, null) }; },
    addDirect: (f) => { s.directs[f.rowId] ??= directEvents(f).map(e => ({ ...e, text: null, subject: null, content: contentHash(e.text, e.subject) })); },
  };
}

const short = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);
/** One hash over an event's words: what the digest compares, and all the JSON state keeps of them. */
export const contentHash = (text: string | null, subject: string | null): string => short(`${text ?? ""}\u0000${subject ?? ""}`);

/** Every event the JSON state holds: each direct fact's, and each group line once per member. */
export function memoryEvents(s: MemoryState): EventRow[] {
  const out: EventRow[] = Object.values(s.directs).flat();
  for (const [rowId, l] of Object.entries(s.lines)) for (const m of Object.keys(s.members[l.group] ?? {})) out.push({ ...lineEvent({ ...l, rowId, text: null }, m), content: l.content });
  return out;
}


/** Per person: how many events they have and one hash over all of them. Identical for two stores that hold the same
 *  events, whatever order they were applied in. */
export function digestOf(events: Iterable<EventRow>): { v: 1; people: Record<string, { n: number; hash: string }> } {
  const by = new Map<string, string[]>();
  for (const e of events) {
    const line = [e.row_id, e.ts, e.thread, e.group_id ?? "", e.direction, e.from_role, e.from_id ?? "", e.addressed ?? "", e.backfill, e.content ?? contentHash(e.text, e.subject)].join("|");
    (by.get(e.person_id) ?? by.set(e.person_id, []).get(e.person_id)!).push(line);
  }
  const people: Record<string, { n: number; hash: string }> = {};
  for (const id of [...by.keys()].sort()) { const lines = by.get(id)!.sort(); people[id] = { n: lines.length, hash: short(lines.join("\n")) }; }
  return { v: 1, people };
}
