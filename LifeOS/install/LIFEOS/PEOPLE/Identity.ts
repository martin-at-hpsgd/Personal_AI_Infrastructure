/**
 * Identity.ts — who a handle belongs to, as one People person (conversation-memory ISA ISC-6..9; Relay ISA
 * ISC-423..427 reads it from here).
 *
 * Every handle (a phone in any format, an email, or a thread id like `iMessage;-;+1…`) resolves to one People id
 * through the People store and the Security Rings member lists; there is no identity table of its own. All the
 * handles of one person resolve to the same id: records linked by a curated `same_as` edge, or listed under one Ring
 * member, are one person, and that person's id is the first of their record ids in sort order. A handle no record
 * carries, or one carried by two different people, is unresolved: it is the unknown sender, never a guessed name.
 *
 * Every channel that talks to people resolves here: Relay (texts), gmail.ts (the DA's mail) and the per-person
 * history (History.ts). Nothing here throws into a caller: a store that cannot be read resolves everyone as unknown,
 * and a ring file that cannot be read puts everyone in Ring 3. Nothing here writes.
 */
import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { handlesOf, loadValidRings, normalizeHandle, OUTSIDE, ringFile, ringOfPerson, RINGS, ringsDir, type Ring, type RingPolicy } from "../RINGS/policy.ts";
import { contactsVersion, loadRecords } from "./query.ts";
import type { PersonRecord } from "./types.ts";

export const UNKNOWN_ID = "unknown";

/** One resolved person. `about` is what the principal's records say about them: relationship, Ring note, org. */
export interface Person { id: string; name: string; ring: Ring; ringName?: string; about: string[] }

export interface Directory { records: PersonRecord[]; rings: RingPolicy[] }

// ── handles ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** The bare handle in a thread id or URI, normalized the way Security Rings matches members (E.164 or lowercase). */
export function handleOf(raw: string): string {
  const bare = raw.trim().replace(/^[A-Za-z]+;-;/, "").replace(/^(tel|sms|imessage|mailto):/i, "").trim();
  return bare ? normalizeHandle(bare) : "";
}

// ── the directory index ─────────────────────────────────────────────────────────────────────────────────────────

export interface Index { byHandle: Map<string, PersonRecord[]>; byId: Map<string, PersonRecord>; links: Map<string, Set<string>>; rings: RingPolicy[] }

export function indexOf(dir: Directory): Index {
  const byHandle = new Map<string, PersonRecord[]>();
  const byId = new Map<string, PersonRecord>();
  const links = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    if (a === b) return;
    (links.get(a) ?? links.set(a, new Set()).get(a)!).add(b);
    (links.get(b) ?? links.set(b, new Set()).get(b)!).add(a);
  };
  for (const r of dir.records) {
    byId.set(r.id, r);
    for (const h of new Set(handlesOf(r))) (byHandle.get(h) ?? byHandle.set(h, []).get(h)!).push(r);
    for (const other of r.same_as ?? []) link(r.id, other);
  }
  for (const p of dir.rings) for (const m of p.members) for (const id of m.people.slice(1)) link(m.people[0]!, id);
  return { byHandle, byId, links, rings: dir.rings };
}

/** Every id that is the same human as `start`: same_as edges and shared Ring members, followed both ways. */
export function sameHuman(start: string, ix: Index): Set<string> {
  const ids = new Set([start]);
  const queue = [start];
  while (queue.length) for (const next of ix.links.get(queue.pop()!) ?? []) if (!ids.has(next)) { ids.add(next); queue.push(next); }
  return ids;
}

/** The canonical id of the human `id` belongs to: the first of their known record ids in sort order. */
export function canonicalId(id: string, ix: Index): string {
  return [...sameHuman(id, ix)].filter(i => ix.byId.has(i)).sort()[0] ?? id;
}

// ── scrubbing ───────────────────────────────────────────────────────────────────────────────────────────────────

const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.\p{L}{2,}/gu;
const PHONE = /\+?\d[\d\s().-]{5,}\d/g;
/** A calendar date (ISO, optionally with a time and zone, or day.month.year): digits a note may carry that are not a
 *  number to hide. Year 1900–2099, month 01–12, day 01–31, so a phone written with dashes is not taken for one. */
const DATE = /\b(?:19|20)\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])(?:[T ][0-2]\d:[0-5]\d(?::[0-5]\d)?(?:\.\d+)?(?:Z|[+-][0-2]\d:?[0-5]\d)?)?(?!\d)|\b(?:0?[1-9]|[12]\d|3[01])\.(?:0?[1-9]|1[0-2])\.(?:19|20)\d{2}(?!\d)/g;
/** A placeholder for a protected date: control characters around letters, so the phone pattern cannot reach into it. */
const token = (i: number): string => { let s = ""; let n = i; do { s = String.fromCharCode(97 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0); return `\u0001${s}\u0002`; };
const TOKEN = /\u0001([a-z]+)\u0002/g;
const tokenIndex = (s: string): number => [...s].reduce((n, c) => n * 26 + (c.charCodeAt(0) - 96), 0) - 1;

/**
 * People text with every address and phone number taken out and every date kept: names and notes reach model
 * prompts and the record (Relay ISC-426). "Alex's assistant (added 2026-10-25)." keeps its date; "call +1 (555)
 * 555-0144 first" becomes "call first". With a `label`, each removal is replaced by it and nothing else is tidied.
 */
export function scrubContact(s: string, label = ""): string {
  const dates: string[] = [];
  const kept = s.replace(DATE, (d) => { dates.push(d); return token(dates.length - 1); });
  const stripped = kept.replace(EMAIL, label).replace(PHONE, (m) => (m.replace(/\D/g, "").length >= 7 ? label : m));
  const tidy = label ? stripped : stripped.replace(/\(\s*[,;:]?\s*\)/g, "").replace(/\s{2,}/g, " ").replace(/^[\s,;:(-]+|[\s,;:(-]+$/g, "");
  return tidy.replace(TOKEN, (_m, k: string) => dates[tokenIndex(k)] ?? "");
}

// ── resolving ───────────────────────────────────────────────────────────────────────────────────────────────────

/** The one person a handle belongs to, or undefined when no record carries it or two different people do. */
export function resolveIn(raw: string, ix: Index): Person | undefined {
  const handle = handleOf(raw);
  const hits = handle ? ix.byHandle.get(handle) ?? [] : [];
  if (!hits.length) return undefined;
  const humans = new Map<string, Set<string>>();
  for (const hit of hits) {
    const ids = sameHuman(hit.id, ix);
    const known = [...ids].filter(id => ix.byId.has(id)).sort();
    humans.set(known[0] ?? hit.id, ids);
  }
  // Two humans share this handle: naming either one would be a guess (ISC-424).
  if (humans.size !== 1) return undefined;
  const [id, ids] = [...humans][0]!;
  return personOf(id, ids, hits, ix);
}

/** The person a record id belongs to (any of their record ids), or undefined when no record carries it. */
export function personById(id: string, ix: Index): Person | undefined {
  if (!ix.byId.has(id)) return undefined;
  const canonical = canonicalId(id, ix);
  return personOf(canonical, sameHuman(canonical, ix), [ix.byId.get(canonical)!], ix);
}

function personOf(id: string, ids: Set<string>, hits: PersonRecord[], ix: Index): Person {
  const records = [...hits, ...[...ids].sort().map(i => ix.byId.get(i)).filter((r): r is PersonRecord => !!r && !hits.includes(r))];
  const memberOf = ix.rings.flatMap(p => p.members.map(m => ({ policy: p, member: m }))).find(({ member }) => member.people.some(p => ids.has(p)));
  const ring = Math.max(...hits.map(r => ringOfPerson(r.id, ix.rings))) as Ring;
  const name = [...records.map(r => r.name), memberOf?.member.name].map(n => scrubContact(n ?? "")).find(Boolean) ?? "an unnamed contact";
  const about = [...new Set([
    ...records.map(r => r.relationship ?? ""),
    memberOf?.member.note ?? "",
    ...records.filter(r => !r.isOrganization).map(r => r.org ? `works at ${r.org}` : ""),
  ].map(s => scrubContact(s)).filter(Boolean))];
  const ringName = ix.rings.find(p => p.ring === ring)?.name;
  return { id, name, ring, ...(ringName ? { ringName } : {}), about };
}

/** Resolve one handle against a directory given whole; used by tests and one-off callers. */
export const resolveHandle = (raw: string, dir: Directory): Person | undefined => resolveIn(raw, indexOf(dir));

// ── the live directory ──────────────────────────────────────────────────────────────────────────────────────────

let cache: { key: string; index: Index } | null = null;
let override: Index | null = null;

function mtime(path: string): number { try { return statSync(path).mtimeMs; } catch { return 0; } }

/** The People store and the rings, re-read only when a file changes. Under `bun test` it is empty unless a test sets
 *  one, so no test reads the live People store. */
export function liveIndex(): Index {
  if (override) return override;
  if (process.env.NODE_ENV === "test") return indexOf({ records: [], rings: [] });
  const key = [contactsVersion(), ...RINGS.map(r => mtime(ringFile(ringsDir(), r)))].join("|");
  if (cache?.key === key) return cache.index;
  let records: PersonRecord[] = [];
  let rings: RingPolicy[] = [];
  try { records = loadRecords(); } catch (e) { console.error(`[people-identity] People store unreadable: ${String(e).slice(0, 160)}`); }
  try { rings = loadValidRings(); } catch (e) { console.error(`[people-identity] rings unreadable, everyone is Ring ${OUTSIDE}: ${String(e).slice(0, 160)}`); }
  cache = { key, index: indexOf({ records, rings }) };
  return cache.index;
}

/** Tests resolve against a fixture directory; the returned function restores the previous one. */
export function setDirectoryForTest(dir: Directory): () => void {
  const prev = override;
  override = indexOf(dir);
  return () => { override = prev; };
}

/** The person a handle belongs to in the live directory, or undefined. Never throws. */
export function identify(raw: string): Person | undefined {
  try { return resolveIn(raw, liveIndex()); } catch { return undefined; }
}

// ── what reaches the record ─────────────────────────────────────────────────────────────────────────────────────

/** The id as a STATVS row may hold it (Relay ISC-427). A People id keyed by an address (`email:<addr>`) would put the
 *  address on the record, so such an id is written as a hash of itself: stable, joinable by hashing, and carrying no
 *  address. */
export function recordableId(id: string): string {
  if (!/@|\d{7,}/.test(id)) return id;
  return `sha256:${createHash("sha256").update(id).digest("hex").slice(0, 16)}`;
}

/** The recordable id for a handle: its person's, or for an email no record carries, the id People would mint for it
 *  (`email:<addr>`) hashed, so a later record for that address joins the same history. Anything else is `unknown`. */
export function recordableForHandle(raw: string, ix: Index = liveIndex()): string {
  let found: Person | undefined;
  try { found = resolveIn(raw, ix); } catch { found = undefined; }
  if (found) return recordableId(found.id);
  const h = handleOf(raw);
  return h.includes("@") ? recordableId(`email:${h}`) : UNKNOWN_ID;
}

/** Every recordable id a row about this human may carry: each of their record ids as recorded, and the
 *  `email:<addr>` id of each of their addresses, under which mail to an address no record carried yet was written. */
export function recordableIdsOf(id: string, ix: Index): Set<string> {
  const out = new Set<string>();
  for (const i of sameHuman(id, ix)) {
    out.add(recordableId(i));
    const r = ix.byId.get(i);
    for (const h of r ? handlesOf(r) : []) if (h.includes("@")) out.add(recordableId(`email:${h}`));
  }
  return out;
}
