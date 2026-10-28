#!/usr/bin/env bun
/**
 * @version 0.1.0
 *
 * People - store.ts. The ONLY module that reads or writes the three store files.
 * ISA: LIFEOS/PEOPLE/ISA.md (maintainer-side state of record, not in the release) (ISC-1, ISC-5, ISC-37, ISC-41).
 *
 *   contacts.jsonl       one PersonRecord per line    - writeContacts()
 *   interactions.jsonl   append-only InteractionEvent - appendInteractions()
 *   runs.jsonl           one TickRun per tick         - appendRun()
 *
 * One writer function per file. Every writer asserts record shape with invariant()
 * BEFORE touching disk, writes to a sibling tmp file, chmods it 0600 and renames
 * it over the target, so a reader never sees a half-written store and the files
 * are never group- or world-readable.
 *
 * The rename makes each write atomic; it does not make a read-modify-write
 * atomic. The hourly tick and a human's `people add` or `people sync` can run at
 * the same time, and two overlapping read-modify-writes silently drop one side's
 * change. So every RMW of the store runs inside withStoreLock(): one
 * cross-process lock for the whole store (re-entrant inside a process), held
 * only across the synchronous read, transform and write, never across a network
 * sweep. Tmp files are unique per writer, so two processes never share one.
 *
 * Location: PEOPLE_DIR when set (tests point it at a scratch dir), else
 * lifeosUserDir()/CONTACTS. No home-path literal anywhere in this file.
 */

import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { invariant } from "../TOOLS/Invariant";
import { lifeosUserDir } from "../TOOLS/LifeosConfig";
import { withTelosLock } from "../TOOLS/TelosLock";
import {
  IDENTITY_FIELDS,
  type InteractionEvent,
  type InteractionKind,
  type PersonClass,
  type PersonRecord,
  type Source,
  SOURCE_STATUSES,
  type SourceStatus,
  type TickRun,
} from "./types";

// -- paths --------------------------------------------------------------------

/** Resolved per call, never module-cached: tests set PEOPLE_DIR between cases. */
export function peopleDir(): string {
  return process.env.PEOPLE_DIR || join(lifeosUserDir(), "CONTACTS");
}
export const contactsPath = () => join(peopleDir(), "contacts.jsonl");
export const interactionsPath = () => join(peopleDir(), "interactions.jsonl");
export const runsPath = () => join(peopleDir(), "runs.jsonl");
export const cacheDir = () => join(peopleDir(), "cache");

// -- validation vocabulary ----------------------------------------------------

const CLASSES: readonly PersonClass[] = ["personal", "business", "both", "unknown"];
const SOURCES: readonly Source[] = ["addressbook", "email", "calendar", "curated", "stripe", "beehiiv", "people-cli"];
const KINDS: readonly InteractionKind[] = ["email", "calendar", "text", "call", "meeting", "note"];
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

const brief = (v: unknown) => JSON.stringify(v ?? null).slice(0, 140);

// -- reads --------------------------------------------------------------------

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  const out: T[] = [];
  const text = readFileSync(path, "utf8");
  let lineNo = 0;
  for (const line of text.split("\n")) {
    lineNo++;
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch (e) {
      // A corrupt line is an operator-visible failure, not an impossible state:
      // name the file and line so it can be fixed by hand.
      throw new Error(`${path}:${lineNo} is not valid JSON (${(e as Error).message})`);
    }
  }
  return out;
}

export const readContacts = (): PersonRecord[] => readJsonl<PersonRecord>(contactsPath());
export const readInteractions = (): InteractionEvent[] => readJsonl<InteractionEvent>(interactionsPath());
export const readRuns = (): TickRun[] => readJsonl<TickRun>(runsPath());

// -- canonical serialization (ISC-9: byte-identical reruns) -------------------

/**
 * Fixed key order so an unchanged record serializes to the same bytes on every
 * run. JSON.stringify follows insertion order, so field order is part of the
 * store's contract, not an accident of how a record was built.
 */
const RECORD_KEY_ORDER: (keyof PersonRecord)[] = [
  "id", "name", "givenName", "familyName", "nickname", "org", "isOrganization",
  "emails", "phones", "addresses", "urls", "hasPhoto",
  "sources", "provenance", "history",
  "class", "class_override", "same_as", "relationship", "tags",
  "customer", "interactions", "summary", "summary_updated", "updated",
];

export function canonicalRecord(r: PersonRecord): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of RECORD_KEY_ORDER) {
    const v = r[k];
    if (v === undefined) continue;
    if (k === "provenance") {
      const p: Record<string, unknown> = {};
      for (const f of IDENTITY_FIELDS) {
        const entry = r.provenance?.[f];
        if (entry) p[f] = { source: entry.source, at: entry.at };
      }
      out[k] = p;
      continue;
    }
    out[k] = v;
  }
  return out;
}

const EVENT_KEY_ORDER: (keyof InteractionEvent)[] = ["person", "kind", "at", "source", "ref", "direction", "automated", "subject"];

function canonicalEvent(e: InteractionEvent): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of EVENT_KEY_ORDER) if (e[k] !== undefined) out[k] = e[k];
  return out;
}

// -- the store lock ------------------------------------------------------------

/**
 * Runs `fn` holding the one cross-process lock for the whole store. `fn` must be
 * synchronous and do its whole read, transform and write inside, so nothing in
 * this process interleaves either. Nested calls in one process are no-ops, so a
 * locked caller may call writeContacts() or appendInteractions(). A busy lock is
 * waited on for a minute, then fails loud having written nothing.
 */
export function withStoreLock<T>(fn: () => T): T {
  mkdirSync(peopleDir(), { recursive: true });
  return withTelosLock(contactsPath(), () => fn(), { timeoutMs: 60_000, staleMs: 600_000 });
}

/** A tmp name no other writer, in this process or another, can share. */
const tmpFor = (path: string) => `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;

// -- the atomic writer every public writer goes through -----------------------

function writeAtomic(path: string, body: string): void {
  mkdirSync(peopleDir(), { recursive: true });
  const tmp = tmpFor(path);
  writeFileSync(tmp, body, { mode: 0o600 });
  chmodSync(tmp, 0o600); // umask can widen the create mode; this cannot (ISC-37)
  renameSync(tmp, path);
  chmodSync(path, 0o600);
}

// -- contacts.jsonl - the one writer (ISC-5, ISC-41) --------------------------

/** Asserts every impossible state a bad merge could persist. Throws before any write. */
export function assertRecords(records: PersonRecord[]): void {
  invariant(Array.isArray(records), "writeContacts expects an array of records");
  const ids = new Set<string>();
  const emailOwner = new Map<string, string>();
  for (const r of records) {
    invariant(r && typeof r === "object", `record is not an object: ${brief(r)}`);
    invariant(typeof r.id === "string" && r.id.length > 0, `record missing id: ${brief(r)}`);
    invariant(!ids.has(r.id), `duplicate record id ${r.id}`);
    ids.add(r.id);
    invariant(Array.isArray(r.emails), `record ${r.id} has no emails array`);
    invariant(Array.isArray(r.phones), `record ${r.id} has no phones array`);
    invariant(Array.isArray(r.addresses), `record ${r.id} has no addresses array`);
    invariant(Array.isArray(r.urls), `record ${r.id} has no urls array`);
    invariant(
      (typeof r.name === "string" && r.name.length > 0) || r.emails.length > 0,
      `record ${r.id} has neither a name nor an email`,
    );
    invariant(CLASSES.includes(r.class), `record ${r.id} has class ${brief(r.class)}`);
    invariant(
      r.class_override === undefined || CLASSES.includes(r.class_override),
      `record ${r.id} has class_override ${brief(r.class_override)}`,
    );
    invariant(Array.isArray(r.sources), `record ${r.id} has no sources array`);
    for (const s of r.sources) invariant(SOURCES.includes(s), `record ${r.id} has unknown source ${brief(s)}`);
    invariant(r.provenance !== null && typeof r.provenance === "object", `record ${r.id} has no provenance map`);
    invariant(Array.isArray(r.history), `record ${r.id} has no history array`);
    invariant(typeof r.updated === "string" && ISO_RE.test(r.updated), `record ${r.id} has updated ${brief(r.updated)}`);
    for (const e of r.emails) {
      invariant(typeof e === "string" && e === e.toLowerCase(), `record ${r.id} holds unnormalized email ${brief(e)}`);
      const owner = emailOwner.get(e);
      // Two records sharing an email means the fold failed - the email IS the
      // fold key, so this is an impossible state, not a data problem.
      invariant(owner === undefined, `email ${e} is on both ${owner} and ${r.id}`);
      emailOwner.set(e, r.id);
    }
  }
}

/** THE writer of contacts.jsonl. Nothing else in LifeOS may write this file (ISC-41). */
export function writeContacts(records: PersonRecord[]): void {
  assertRecords(records);
  const sorted = [...records].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  withStoreLock(() => writeAtomic(contactsPath(), sorted.map((r) => JSON.stringify(canonicalRecord(r))).join("\n") + "\n"));
}

/**
 * Records that are one human, curated by the principal (People ISC-56): each named record gets every other named id in
 * its `same_as`, the local-only edge `people merge` folds on and Identity follows. Adds edges only, never removes one.
 * Returns how many records changed.
 */
export function linkSameAs(ids: string[]): number {
  const want = [...new Set(ids)];
  invariant(want.length >= 2, "link needs at least two distinct record ids");
  const records = readContacts();
  const byId = new Map(records.map((r) => [r.id, r]));
  for (const id of want) invariant(byId.has(id), `no record ${brief(id)}`);
  let changed = 0;
  for (const id of want) {
    const r = byId.get(id)!;
    const next = [...new Set([...(r.same_as ?? []), ...want.filter((o) => o !== id)])].sort();
    if (next.length !== (r.same_as ?? []).length) { r.same_as = next; changed++; }
  }
  if (changed > 0) writeContacts(records);
  return changed;
}

// -- interactions.jsonl - the one writer (ISC-15, ISC-18) ---------------------

/**
 * Ledger identity is (person, source, ref). One email message touches several
 * people, so a message id alone is not unique across rows; the person completes
 * the key and re-ingest of the same message adds nothing (ISC-18).
 */
export const eventKey = (e: InteractionEvent) => `${e.person} ${e.source} ${e.ref}`;

function assertEvents(events: InteractionEvent[]): void {
  invariant(Array.isArray(events), "appendInteractions expects an array of events");
  for (const e of events) {
    invariant(e !== null && typeof e === "object", `event is not an object: ${brief(e)}`);
    invariant(typeof e.person === "string" && e.person.length > 0, `event missing person: ${brief(e)}`);
    invariant(KINDS.includes(e.kind), `event has unknown kind: ${brief(e)}`);
    invariant(typeof e.at === "string" && ISO_RE.test(e.at), `event has bad timestamp: ${brief(e)}`);
    invariant(SOURCES.includes(e.source), `event has unknown source: ${brief(e)}`);
    invariant(typeof e.ref === "string" && e.ref.length > 0, `event missing ref: ${brief(e)}`);
  }
}

/**
 * THE writer of interactions.jsonl. Appends the events not already present and
 * returns how many were new. Read-modify-write keeps the whole file atomic and
 * 0600; the ledger is a few MB, so the cost is a rounding error next to the
 * network sweep that produced the events.
 */
export function appendInteractions(events: InteractionEvent[]): { added: number; total: number } {
  assertEvents(events);
  return withStoreLock(() => appendFresh(events));
}

function appendFresh(events: InteractionEvent[]): { added: number; total: number } {
  const existing = readInteractions();
  const seen = new Set(existing.map(eventKey));
  const fresh: InteractionEvent[] = [];
  for (const e of events) {
    const k = eventKey(e);
    if (seen.has(k)) continue;
    seen.add(k);
    fresh.push(e);
  }
  if (fresh.length === 0) return { added: 0, total: existing.length };
  const all = [...existing, ...fresh];
  writeAtomic(interactionsPath(), all.map((e) => JSON.stringify(canonicalEvent(e))).join("\n") + "\n");
  return { added: fresh.length, total: all.length };
}

// -- runs.jsonl - the one writer (ISC-27, ISC-39) -----------------------------

export function appendRun(run: TickRun): void {
  invariant(run !== null && typeof run === "object", `run is not an object: ${brief(run)}`);
  invariant(typeof run.at === "string" && ISO_RE.test(run.at), `run has bad timestamp: ${brief(run?.at)}`);
  invariant(run.sources !== null && typeof run.sources === "object", `run has no sources map: ${brief(run)}`);
  for (const [name, s] of Object.entries(run.sources)) {
    invariant(
      s !== null && typeof s === "object" && SOURCE_STATUSES.includes(s.status as SourceStatus),
      `run source ${name} has status ${brief(s?.status)}`,
    );
    invariant(typeof s.ms === "number" && s.ms >= 0, `run source ${name} has ms ${brief(s.ms)}`);
  }
  withStoreLock(() => {
    const existing = existsSync(runsPath()) ? readFileSync(runsPath(), "utf8") : "";
    writeAtomic(runsPath(), existing + JSON.stringify(run) + "\n");
  });
}

// -- cache (gmail metadata, checkpoints) - same dir, same 0600 ----------------

export function readCacheJsonl<T>(name: string): T[] {
  return readJsonl<T>(join(cacheDir(), name));
}

/**
 * Resolves a cache file name to a path INSIDE the cache directory, or throws.
 *
 * Two gates, because either alone fails open. First the name must be a bare
 * filename: a separator or a `..` segment is refused outright, so a caller
 * cannot spell `../contacts.jsonl` and route a cache write through to the
 * canonical store, bypassing writeContacts() and its invariants. Second, the
 * joined path's parent is compared against the cache directory AFTER
 * realpathSync() on both, because a lexical prefix check is bypassable through
 * a symlinked path component (OPERATIONAL_PREFERENCES, Code invariants).
 */
function cacheFilePath(name: string): string {
  invariant(
    typeof name === "string" && name.length > 0,
    `cache file name must be a non-empty string: ${brief(name)}`,
  );
  invariant(
    !name.includes("/") && !name.includes("\\") && !name.split(/[/\\]/).includes(".."),
    `cache file name must be a bare filename, got ${brief(name)}`,
  );
  invariant(name !== "." && name !== "..", `cache file name must be a bare filename, got ${brief(name)}`);
  mkdirSync(cacheDir(), { recursive: true });
  const root = realpathSync(cacheDir());
  const path = join(root, name);
  const parent = realpathSync(dirname(path));
  invariant(parent === root, `cache write escapes ${root}: ${brief(name)} resolves under ${brief(parent)}`);
  return path;
}

function writeCacheAtomic(name: string, body: string): void {
  const path = cacheFilePath(name);
  const tmp = tmpFor(path);
  writeFileSync(tmp, body, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  chmodSync(path, 0o600);
}

export function writeCacheJsonl(name: string, rows: unknown[]): void {
  writeCacheAtomic(name, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

export function readCacheJson<T>(name: string, fallback: T): T {
  const path = join(cacheDir(), name);
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function writeCacheJson(name: string, value: unknown): void {
  writeCacheAtomic(name, JSON.stringify(value));
}

/** File mode as an octal string ("600"), or null when the file is absent. */
export function fileMode(path: string): string | null {
  if (!existsSync(path)) return null;
  return (statSync(path).mode & 0o777).toString(8);
}
