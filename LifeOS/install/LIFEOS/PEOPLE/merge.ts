#!/usr/bin/env bun
/**
 * People - merge.ts. Rebuilds the store from its sources without losing
 * anything a human put there.
 * ISA: ISC-6, ISC-7, ISC-7.1, ISC-9, ISC-32, ISC-34, ISC-42.
 *
 * Three rules decide everything here:
 *
 * 1. Records fold ONLY on a shared email, a shared phone, or a curated same_as
 *    edge. Never on a name. The exact-name fold ContactsDb used is retired: two
 *    humans with one name are two records (ISC-32, ISC-42).
 *
 * 2. Fields merge last-write-wins by provenance timestamp, and the losing value
 *    is kept in `history` with where it came from, so a bad merge is reversible
 *    (ISC-6, ISC-7, ISC-7.1). Array fields (emails, phones, urls, addresses)
 *    union rather than replace: a second source knowing one more address is
 *    added information, not a competing answer. Removing a value is therefore
 *    an explicit act, never a side effect of a sync.
 *
 * 3. Local-only truth survives a rebuild untouched: class_override, same_as,
 *    relationship, tags, summary, customer state and the provenance/history
 *    already on the record (ISC-34). When a fold makes two records disagree
 *    about one of the four curated fields, the newer value wins and the loser
 *    goes to `history` under the same rule identity fields use - never dropped.
 *
 * Idempotence (ISC-9) falls out of those rules plus one discipline: no timestamp
 * is written unless the value it describes actually changed. `updated` keeps its
 * previous value when the rest of the record is byte-identical.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { invariant } from "../TOOLS/Invariant";
import { deriveClass } from "./class";
import { aggregate, bestName, isHuman, normEmail, readGmailCache, rollup, type Agg, type MsgMeta } from "./ledger";
import { cacheDir, canonicalRecord, readContacts, readInteractions, withStoreLock, writeContacts } from "./store";
import {
  IDENTITY_FIELDS,
  type FieldProvenance,
  type IdentityFields,
  type InteractionEvent,
  type PersonRecord,
  type PostalAddress,
  type RetainedValue,
  type Source,
} from "./types";

// -- inputs -------------------------------------------------------------------

/** One row of `ContactsCli.swift audit`. Extra keys are ignored; missing ones tolerated. */
export type AppleCard = {
  id: string;
  name?: string;
  givenName?: string;
  familyName?: string;
  nickname?: string;
  org?: string;
  type?: string; // "person" | "org"
  isOrganization?: boolean;
  emails?: string[];
  phones?: string[];
  urls?: string[];
  addresses?: PostalAddress[];
  hasImage?: boolean;
};

export type AppleAudit = { generatedAt?: string; contacts?: AppleCard[] };

export type MergeInputs = {
  audit?: AppleAudit | AppleCard[] | null;
  metas?: MsgMeta[];
  prev?: PersonRecord[];
  events?: InteractionEvent[];
  curated?: { name: string; relationship: string; email: string }[];
  /** Injected in tests so a run has one fixed clock. */
  now?: string;
};

const SOURCE_ORDER: readonly Source[] = ["addressbook", "email", "calendar", "curated", "stripe", "beehiiv", "people-cli"];

const ARRAY_FIELDS = new Set<keyof IdentityFields>(["emails", "phones", "urls", "addresses"]);

// -- fold keys ----------------------------------------------------------------

/**
 * The fold key for a phone number. Fewer than 7 digits is an extension or a
 * fragment, never strong enough to fuse two humans, and keys as null.
 *
 * The key keeps the country context rather than truncating to a suffix. A
 * last-10-digits key collides across countries - `+1 202 555 0100` and
 * `+44 20 2555 0100` both end `2025550100` - and a collision here fuses two
 * unrelated humans into one record, which is the worst outcome this system has
 * (audit finding, 2026-09-11). So:
 *
 *   - a number written internationally (leading `+`) or carrying 11+ digits
 *     keys as its FULL digit string, country code included;
 *   - a bare 10-digit number is domestic and keys as `1` + its digits, so
 *     `(202) 555-0100` still folds with `+1 202 555 0100` and never with the
 *     UK number above;
 *   - 7 to 9 digits is a local number with no country context and keys as
 *     itself, unchanged.
 */
export function phoneKey(phone: string): string | null {
  const raw = (phone ?? "").trim();
  const digits = raw.replace(/\D+/g, "");
  if (digits.length < 7) return null;
  if (raw.startsWith("+") || digits.length >= 11) return digits;
  if (digits.length === 10) return `1${digits}`;
  return digits;
}

/**
 * Two records may fold on a shared phone only when their names agree: equal
 * after normalization, one containing the other, or (for people, not org
 * cards) a shared last token. Branches of one company share a switchboard and
 * a household shares a landline; neither is one entity (ISA absence-1,
 * live finding 2026-09-11: 18 org cards fused on a main number).
 */
export function namesCompatible(a: string, b: string, orgCard = false): boolean {
  const norm = (x: string) => (x ?? "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  const na = norm(a), nb = norm(b);
  if (!na || !nb) return false;
  if (na === nb || na.includes(nb) || nb.includes(na)) return true;
  if (orgCard) return false;
  const la = na.split(" ").pop(), lb = nb.split(" ").pop();
  return Boolean(la && lb && la.length > 2 && la === lb);
}

/** A phone key held by this many or more distinct records is a shared line and never folds. */
export const SHARED_LINE_THRESHOLD = 3;

class UnionFind {
  private parent = new Map<string, string>();
  find(x: string): string {
    let p = this.parent.get(x);
    if (p === undefined) {
      this.parent.set(x, x);
      return x;
    }
    if (p !== x) {
      p = this.find(p);
      this.parent.set(x, p);
    }
    return p;
  }
  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return;
    // Smaller id becomes the root so grouping is deterministic across runs.
    if (ra < rb) this.parent.set(rb, ra);
    else this.parent.set(ra, rb);
  }
}

// -- field merge --------------------------------------------------------------

type Draft = PersonRecord;

function newDraft(id: string, now: string): Draft {
  return {
    id,
    name: "",
    emails: [],
    phones: [],
    addresses: [],
    urls: [],
    sources: [],
    provenance: {},
    history: [],
    class: "unknown",
    updated: now,
  };
}

const historyKey = (h: RetainedValue) => `${h.field}|${JSON.stringify(h.value)}|${h.source}`;

function retain(d: Draft, field: string, value: unknown, source: Source, at: string, replacedAt: string): void {
  const entry: RetainedValue = { field, value, source, at, replacedAt };
  const k = historyKey(entry);
  if (d.history.some((h) => historyKey(h) === k)) return; // a rerun must not grow history
  d.history.push(entry);
}

const isEmpty = (v: unknown) => v === undefined || v === null || v === "";

function mergeScalar(d: Draft, field: keyof IdentityFields, value: unknown, source: Source, at: string): void {
  if (isEmpty(value)) return;
  const cur = (d as any)[field];
  const prov = d.provenance[field];
  if (isEmpty(cur)) {
    (d as any)[field] = value;
    d.provenance[field] = { source, at };
    return;
  }
  if (cur === value) return; // identical: touch nothing, so reruns do not churn
  if (!prov || at > prov.at) {
    retain(d, field, cur, prov?.source ?? source, prov?.at ?? at, at);
    (d as any)[field] = value;
    d.provenance[field] = { source, at };
  } else {
    retain(d, field, value, source, at, prov.at);
  }
}

const addrKey = (a: PostalAddress) =>
  [a.label, a.street, a.city, a.state, a.postalCode, a.country].map((x) => (x ?? "").trim().toLowerCase()).join("|");

function mergeArray(d: Draft, field: keyof IdentityFields, values: unknown[], source: Source, at: string): void {
  if (!Array.isArray(values) || values.length === 0) {
    if (!d.provenance[field] && ((d as any)[field] ?? []).length > 0) d.provenance[field] = { source, at };
    return;
  }
  const cur = ((d as any)[field] ?? []) as unknown[];
  const key = field === "addresses" ? (v: unknown) => addrKey(v as PostalAddress) : (v: unknown) => String(v);
  const seen = new Map<string, unknown>();
  for (const v of [...cur, ...values]) {
    if (isEmpty(v)) continue;
    const k = key(v);
    if (!seen.has(k)) seen.set(k, v);
  }
  const next = [...seen.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([, v]) => v);
  const changed = next.length !== cur.length || next.some((v, i) => key(v) !== key(cur[i]));
  (d as any)[field] = next;
  if (changed || !d.provenance[field]) d.provenance[field] = { source, at };
}

function mergeField(d: Draft, field: keyof IdentityFields, value: unknown, source: Source, at: string): void {
  if (ARRAY_FIELDS.has(field)) mergeArray(d, field, (value ?? []) as unknown[], source, at);
  else mergeScalar(d, field, value, source, at);
}

// -- curated fields -----------------------------------------------------------

/**
 * Fields a human (or a product backend) set that are not identity, so they
 * carry no entry in `provenance`. They still take part in a fold, and two
 * records folding into one can disagree about them.
 */
export type CuratedField = "class_override" | "relationship" | "summary" | "customer";

/** Per-group provenance for the curated fields, held beside the draft. */
type CuratedProv = Map<CuratedField, FieldProvenance>;

const sameCurated = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * Merges one curated field the same way an identity field merges: newer wins by
 * timestamp, and the value that loses is kept in `history` with where it came
 * from and when it was replaced (ISC-7.1 shape).
 *
 * Before 2026-09-11 these four fields were first-truthy-wins and the conflicting
 * value was dropped with no record of it (audit finding). On a fold that
 * silently destroyed a hand-written annotation - exactly the loss the identity
 * merge was built to make impossible.
 *
 * Returns true when `value` became the draft's value.
 */
function mergeCurated(
  d: Draft,
  prov: CuratedProv,
  field: CuratedField,
  value: unknown,
  source: Source,
  at: string,
): boolean {
  if (isEmpty(value)) return false;
  const cur = (d as any)[field];
  if (isEmpty(cur)) {
    (d as any)[field] = value;
    prov.set(field, { source, at });
    return true;
  }
  if (sameCurated(cur, value)) return false; // identical: no conflict, no history
  const held = prov.get(field);
  if (!held || at > held.at) {
    retain(d, field, cur, held?.source ?? source, held?.at ?? at, at);
    (d as any)[field] = value;
    prov.set(field, { source, at });
    return true;
  }
  retain(d, field, value, source, at, held.at);
  return false;
}

/**
 * Honest source for a curated value read off an existing record. The three hand
 * fields are curated by definition; `customer` comes from whichever product
 * backend wrote it.
 */
function curatedSource(field: CuratedField, r: PersonRecord): Source {
  if (field !== "customer") return "curated";
  if (r.customer?.stripe) return "stripe";
  if (r.customer?.newsletter) return "beehiiv";
  return "curated";
}

function addSource(d: Draft, s: Source): void {
  if (!d.sources.includes(s)) {
    d.sources.push(s);
    d.sources.sort((a, b) => SOURCE_ORDER.indexOf(a) - SOURCE_ORDER.indexOf(b));
  }
}

/** Folds an existing record in as a source, provenance and all. */
function applyRecord(d: Draft, r: PersonRecord): void {
  for (const f of IDENTITY_FIELDS) {
    const v = (r as any)[f];
    if (v === undefined) continue;
    const prov: FieldProvenance = r.provenance?.[f] ?? { source: r.sources?.[0] ?? "curated", at: r.updated };
    mergeField(d, f, v, prov.source, prov.at);
  }
  for (const s of r.sources ?? []) addSource(d, s);
  for (const h of r.history ?? []) {
    const k = historyKey(h);
    if (!d.history.some((x) => historyKey(x) === k)) d.history.push(h);
  }
}

// -- source candidates --------------------------------------------------------

type Candidate = {
  id: string;
  source: Source;
  at: string;
  fields: Partial<IdentityFields>;
  tags?: string[];
  relationship?: string;
};

function cardCandidates(audit: AppleAudit | AppleCard[] | null | undefined): Candidate[] {
  if (!audit) return [];
  const cards = Array.isArray(audit) ? audit : (audit.contacts ?? []);
  const at = (!Array.isArray(audit) && audit.generatedAt) || undefined;
  const out: Candidate[] = [];
  for (const c of cards) {
    if (!c?.id) continue;
    const emails = [...new Set((c.emails ?? []).map(normEmail).filter(Boolean))];
    const isOrg = c.isOrganization === true || c.type === "org";
    const name = (c.name ?? "").trim() || (c.org ?? "").trim() || emails[0] || "(unnamed)";
    out.push({
      id: `ab:${c.id}`,
      source: "addressbook",
      // Contacts exposes no per-card modification date through the audit, so the
      // audit's own timestamp is the best available "as of". A stable fallback
      // keeps a card's provenance from churning when the dump lacks one.
      at: at ?? "1970-01-01T00:00:00.000Z",
      fields: {
        name,
        ...(c.givenName ? { givenName: c.givenName } : {}),
        ...(c.familyName ? { familyName: c.familyName } : {}),
        ...(c.nickname ? { nickname: c.nickname } : {}),
        ...(c.org ? { org: c.org } : {}),
        ...(isOrg ? { isOrganization: true } : {}),
        emails,
        phones: [...new Set((c.phones ?? []).filter(Boolean))],
        urls: [...new Set((c.urls ?? []).filter(Boolean))],
        addresses: c.addresses ?? [],
        ...(c.hasImage === undefined ? {} : { hasPhoto: c.hasImage }),
      },
      ...(isOrg ? { tags: ["organization"] } : {}),
    });
  }
  return out;
}

/**
 * Email-derived candidates. An address already on a card contributes only the
 * `email` source marker; an address belonging to nobody becomes a record of its
 * own when the traffic looks human.
 */
function emailCandidates(aggs: Map<string, Agg>, knownEmails: Set<string>): Candidate[] {
  const out: Candidate[] = [];
  for (const a of [...aggs.values()].sort((x, y) => (x.email < y.email ? -1 : 1))) {
    const at = new Date(a.last || 0).toISOString();
    if (knownEmails.has(a.email)) {
      out.push({ id: `email:${a.email}`, source: "email", at, fields: { emails: [a.email] } });
      continue;
    }
    if (!isHuman(a)) continue;
    out.push({ id: `email:${a.email}`, source: "email", at, fields: { name: bestName(a), emails: [a.email] } });
  }
  return out;
}

export function parseCurated(md: string): { name: string; relationship: string; email: string }[] {
  const out: { name: string; relationship: string; email: string }[] = [];
  const re = /^-\s+\*\*(.+?)\*\*\s*(?:\[(.+?)\])?\s*-\s*(\S+@\S+?)(?:\s*\|.*)?$/gm;
  for (const m of md.matchAll(re)) {
    out.push({ name: m[1].trim(), relationship: (m[2] ?? "").trim(), email: normEmail(m[3]) });
  }
  return out;
}

// -- the merge ----------------------------------------------------------------

export function mergeAll(inputs: MergeInputs = {}): PersonRecord[] {
  const now = inputs.now ?? new Date().toISOString();
  const prev = inputs.prev ?? readContacts();
  const metas = inputs.metas ?? [];
  const aggs = aggregate(metas);

  const cards = cardCandidates(inputs.audit);
  const knownEmails = new Set<string>();
  for (const c of cards) for (const e of c.fields.emails ?? []) knownEmails.add(e);
  for (const p of prev) for (const e of p.emails ?? []) knownEmails.add(e);

  const curated = (inputs.curated ?? []).map((c) => ({
    id: `email:${c.email}`,
    source: "curated" as Source,
    at: now,
    fields: { name: c.name, emails: [c.email] },
    relationship: c.relationship || undefined,
  }));

  const candidates: Candidate[] = [...cards, ...emailCandidates(aggs, knownEmails), ...curated];

  // -- fold (ISC-32): email, phone and curated same_as edges only -------------
  const uf = new UnionFind();
  const byEmail = new Map<string, string>();
  const byPhone = new Map<string, string>();

  // Shared lines: a phone key held by SHARED_LINE_THRESHOLD+ distinct ids is a
  // switchboard or a household landline, never a fold key.
  const phoneOwners = new Map<string, Set<string>>();
  const noteOwner = (id: string, phones: string[]) => {
    for (const p of phones) {
      const k = phoneKey(p);
      if (!k) continue;
      let set = phoneOwners.get(k);
      if (!set) phoneOwners.set(k, (set = new Set()));
      set.add(id);
    }
  };
  for (const c of candidates) noteOwner(c.id, c.fields.phones ?? []);
  for (const p of prev) noteOwner(p.id, p.phones ?? []);
  const nameOf = new Map<string, { name: string; org: boolean }>();
  for (const c of candidates) nameOf.set(c.id, { name: c.fields.name ?? "", org: c.fields.isOrganization === true });
  for (const p of prev) if (!nameOf.has(p.id)) nameOf.set(p.id, { name: p.name ?? "", org: p.isOrganization === true });

  const claim = (id: string, emails: string[] = [], phones: string[] = []) => {
    uf.find(id);
    for (const e of emails) {
      const owner = byEmail.get(e);
      if (owner) uf.union(id, owner);
      else byEmail.set(e, id);
    }
    for (const p of phones) {
      const k = phoneKey(p);
      if (!k) continue;
      if ((phoneOwners.get(k)?.size ?? 0) >= SHARED_LINE_THRESHOLD) continue;
      const owner = byPhone.get(k);
      if (!owner) {
        byPhone.set(k, id);
        continue;
      }
      const a = nameOf.get(id), b = nameOf.get(owner);
      if (a && b && namesCompatible(a.name, b.name, a.org || b.org)) uf.union(id, owner);
    }
  };

  for (const c of candidates) claim(c.id, c.fields.emails ?? [], c.fields.phones ?? []);
  for (const p of [...prev].sort((a, b) => (a.id < b.id ? -1 : 1))) claim(p.id, p.emails ?? [], p.phones ?? []);
  // Curated "these ids are one human" edges are the third and only other fold key.
  for (const p of prev) for (const other of p.same_as ?? []) uf.union(p.id, other);

  // -- group ------------------------------------------------------------------
  const groups = new Map<string, { ids: string[]; prev: PersonRecord[]; cands: Candidate[] }>();
  const bucket = (id: string) => {
    const root = uf.find(id);
    let g = groups.get(root);
    if (!g) {
      g = { ids: [], prev: [], cands: [] };
      groups.set(root, g);
    }
    if (!g.ids.includes(id)) g.ids.push(id);
    return g;
  };
  for (const p of [...prev].sort((a, b) => (a.id < b.id ? -1 : 1))) bucket(p.id).prev.push(p);
  for (const c of candidates) bucket(c.id).cands.push(c);

  // -- build ------------------------------------------------------------------
  const events = inputs.events ?? readInteractions();
  const rolls = rollup(events);

  const out: PersonRecord[] = [];
  for (const g of groups.values()) {
    const ids = [...g.ids].sort();
    const id = ids.find((x) => x.startsWith("ab:")) ?? ids[0];
    const d = newDraft(id, now);
    // Provenance for the four curated fields. Held beside the draft rather than
    // on it: PersonRecord has no place to serialize it, and it is only needed
    // for the duration of this group's merge.
    const curatedProv: CuratedProv = new Map();

    for (const p of g.prev) applyRecord(d, p);
    for (const c of [...g.cands].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
      for (const f of IDENTITY_FIELDS) {
        if (!(f in c.fields)) continue;
        mergeField(d, f, (c.fields as any)[f], c.source, c.at);
      }
      addSource(d, c.source);
      if (c.tags) d.tags = [...new Set([...(d.tags ?? []), ...c.tags])].sort();
      mergeCurated(d, curatedProv, "relationship", c.relationship, c.source, c.at);
    }

    // -- local-only truth, carried verbatim (ISC-34) --------------------------
    // `g.prev` arrives sorted by id (the bucket pass iterates a sorted copy), so
    // equal timestamps break the same way on every run and the merge stays
    // idempotent. The four curated fields go through mergeCurated: newer wins,
    // the loser lands in history rather than vanishing.
    const primary = g.prev.find((p) => p.id === id) ?? g.prev[0];
    for (const p of g.prev) {
      mergeCurated(d, curatedProv, "class_override", p.class_override, curatedSource("class_override", p), p.updated);
      mergeCurated(d, curatedProv, "relationship", p.relationship, curatedSource("relationship", p), p.updated);
      // Summary carries its own timestamp; it is the honest clock for this field.
      const summaryAt = p.summary_updated ?? p.updated;
      if (mergeCurated(d, curatedProv, "summary", p.summary, curatedSource("summary", p), summaryAt)) {
        d.summary_updated = p.summary_updated;
      }
      mergeCurated(d, curatedProv, "customer", p.customer, curatedSource("customer", p), p.updated);
      if (p.tags?.length) d.tags = [...new Set([...(d.tags ?? []), ...p.tags])].sort();
      if (p.same_as?.length) d.same_as = [...new Set([...(d.same_as ?? []), ...p.same_as])].sort();
    }

    if (!d.name) d.name = d.emails[0] ?? id;

    const roll = ids.map((x) => rolls.get(x)).find(Boolean) ?? rolls.get(id);
    if (roll) d.interactions = roll;
    else if (primary?.interactions) d.interactions = primary.interactions;

    d.class = deriveClass(d);

    // -- no churn without a change (ISC-9) -----------------------------------
    if (primary) {
      const before = { ...canonicalRecord(primary), updated: "" };
      const after = { ...canonicalRecord(d), updated: "" };
      if (JSON.stringify(before) === JSON.stringify(after)) d.updated = primary.updated;
    }
    out.push(d);
  }

  invariant(
    out.length >= 0 && new Set(out.map((r) => r.id)).size === out.length,
    "merge produced duplicate record ids",
  );
  return out.sort((a, b) => (a.id < b.id ? -1 : 1));
}

// -- disk entry point ---------------------------------------------------------

function readAudit(): AppleAudit | AppleCard[] | null {
  const path = join(cacheDir(), "addressbook.json");
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

/** Reads every source from disk, merges, and writes through the one writer. */
export function runMerge(opts: { curatedPath?: string } = {}): { records: number } {
  const curated =
    opts.curatedPath && existsSync(opts.curatedPath)
      ? parseCurated(readFileSync(opts.curatedPath, "utf8"))
      : undefined;
  // mergeAll reads the current store (local overrides, interactions), so the
  // read and the write hold the store lock together.
  return withStoreLock(() => {
    const records = mergeAll({ audit: readAudit(), metas: readGmailCache(), curated });
    writeContacts(records);
    return { records: records.length };
  });
}
