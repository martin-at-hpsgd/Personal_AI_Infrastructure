#!/usr/bin/env bun
/**
 * @version 0.1.0
 *
 * People — sync.ts. The two operations a human commands against Apple Contacts:
 * `people add` (create a card and the local record in one motion) and
 * `people sync apple` (pull every card in and rebuild the store).
 * ISA: LIFEOS/PEOPLE/ISA.md (maintainer-side state of record, not in the release) (ISC-10, ISC-11, ISC-12).
 *
 * Both live here rather than in the CLI file so a test can call them without
 * executing the CLI's top-level dispatch, and so the CLI stays argument parsing
 * and nothing else.
 *
 * The write half is deliberately absent. Nothing here imports a card-write
 * function or holds the adapter's origin token; the one place that does is the
 * CLI, so the capability to write Contacts belongs to a typed command and not to
 * anything that can import this module (ISC-33, asserted structurally in
 * tests/apple.test.ts, which fails the day a sync or merge module names one of
 * those symbols). What this file owns is everything around that call — the
 * identity the command builds, and the local record it produces afterwards.
 *
 * Shape note: `apple.ts` speaks the store's identity shape (`id` already carries
 * the "ab:" prefix, `hasPhoto`, `isOrganization`), while `merge.ts` reads the raw
 * audit-dump shape (bare identifier, `hasImage`, `type`). `toMergeCards` is the
 * one translation between them, so neither side has to know about the other.
 */

import { deriveClass } from "./class";
import { readAllCards, type AppleCard } from "./apple";
import { runMerge, type AppleAudit, type AppleCard as MergeCard } from "./merge";
import { readContacts, withStoreLock, writeCacheJson, writeContacts } from "./store";
import {
  IDENTITY_FIELDS,
  type FieldProvenance,
  type IdentityFields,
  type PersonRecord,
  type PostalAddress,
} from "./types";

/** Where the merge pass expects the cached address-book dump to be. */
export const AUDIT_CACHE = "addressbook.json";

// ── translation ───────────────────────────────────────────────────────────────

/** Adapter cards → the audit-dump rows `merge.ts` reads. Pure; no I/O. */
export function toMergeCards(cards: AppleCard[]): MergeCard[] {
  return cards.map((c) => ({
    // merge.ts re-applies the "ab:" prefix, so hand it the bare identifier.
    id: c.id.startsWith("ab:") ? c.id.slice(3) : c.id,
    name: c.name,
    ...(c.givenName ? { givenName: c.givenName } : {}),
    ...(c.familyName ? { familyName: c.familyName } : {}),
    ...(c.nickname ? { nickname: c.nickname } : {}),
    ...(c.org ? { org: c.org } : {}),
    type: c.isOrganization ? ("org" as const) : ("person" as const),
    ...(c.isOrganization ? { isOrganization: true } : {}),
    emails: c.emails,
    phones: c.phones,
    urls: c.urls,
    addresses: c.addresses,
    ...(c.hasPhoto === undefined ? {} : { hasImage: c.hasPhoto }),
  }));
}

// ── sync apple (ISC-10, ISC-12) ───────────────────────────────────────────────

/**
 * Reads every card and caches the dump for the merge pass. Split out from
 * `syncApple` so the tick can refresh the cache as its own source and leave the
 * rebuild to the merge source at the end of the run.
 */
export async function cacheAppleAudit(
  now = new Date().toISOString(),
  expired: () => boolean = () => false,
): Promise<{ cards: number }> {
  const cards = await readAllCards();
  // The tick passes its slot's expiry: a read that outlived its budget was
  // already recorded as failed, so it must not publish a cache the merge reads.
  if (expired()) return { cards: cards.length };
  const audit: AppleAudit & { total: number } = {
    generatedAt: now,
    total: cards.length,
    contacts: toMergeCards(cards),
  };
  writeCacheJson(AUDIT_CACHE, audit);
  return { cards: cards.length };
}

/** `people sync apple`: pull every card in, then rebuild the store from it. */
export async function syncApple(now = new Date().toISOString()): Promise<{ cards: number; records: number }> {
  const { cards } = await cacheAppleAudit(now);
  const { records } = runMerge();
  return { cards, records };
}

// ── add (ISC-11) ──────────────────────────────────────────────────────────────

/** The pipe-separated `--address` form: street|city|state|postalCode|country. */
export function parseAddress(spec: string): PostalAddress {
  const [street, city, state, postalCode, country] = spec.split("|").map((p) => p.trim());
  const out: PostalAddress = {};
  if (street) out.street = street;
  if (city) out.city = city;
  if (state) out.state = state;
  if (postalCode) out.postalCode = postalCode;
  if (country) out.country = country;
  return out;
}

/** Same shape of key the merge pass folds addresses on, so a fold here agrees with it. */
const addressKey = (a: PostalAddress) =>
  [a.label, a.street, a.city, a.state, a.postalCode, a.country].map((x) => (x ?? "").trim().toLowerCase()).join("|");

function dedupeAddresses(addresses: PostalAddress[]): PostalAddress[] {
  const seen = new Map<string, PostalAddress>();
  for (const a of addresses) if (!seen.has(addressKey(a))) seen.set(addressKey(a), a);
  return [...seen.values()];
}

export type AddInput = {
  name?: string;
  org?: string;
  givenName?: string;
  familyName?: string;
  nickname?: string;
  emails?: string[];
  phones?: string[];
  urls?: string[];
  addresses?: PostalAddress[];
};

export class AddRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AddRefused";
  }
}

/** Normalizes CLI input into the identity shape both Apple and the store take. */
export function buildIdentity(input: AddInput): IdentityFields {
  const emails = [...new Set((input.emails ?? []).map((e) => e.trim().toLowerCase()).filter(Boolean))];
  const org = input.org?.trim();
  const name = input.name?.trim() || org || [input.givenName, input.familyName].filter(Boolean).join(" ").trim();
  if (!name) throw new AddRefused("add needs --name or --org (or --given/--family)");
  const fields: IdentityFields = {
    name,
    emails,
    phones: [...new Set((input.phones ?? []).map((p) => p.trim()).filter(Boolean))],
    addresses: (input.addresses ?? []).filter((a) => Object.keys(a).length > 0),
    urls: [...new Set((input.urls ?? []).map((u) => u.trim()).filter(Boolean))],
  };
  if (input.givenName?.trim()) fields.givenName = input.givenName.trim();
  if (input.familyName?.trim()) fields.familyName = input.familyName.trim();
  if (input.nickname?.trim()) fields.nickname = input.nickname.trim();
  if (org) {
    fields.org = org;
    // An --org with no human name is a company card; Contacts stores those with
    // the organization flag set, and the class rule reads that flag (ISC-8).
    if (!input.name?.trim() && !input.givenName?.trim() && !input.familyName?.trim()) fields.isOrganization = true;
  }
  return fields;
}

/** The record `people add` writes, built from the command's own fields only. */
export function recordFor(id: string, fields: IdentityFields, now: string): PersonRecord {
  const provenance: PersonRecord["provenance"] = {};
  const stamp: FieldProvenance = { source: "people-cli", at: now };
  for (const f of IDENTITY_FIELDS) {
    const v = fields[f];
    if (v === undefined || v === "" || (Array.isArray(v) && v.length === 0)) continue;
    provenance[f] = stamp;
  }
  const draft: PersonRecord = {
    ...fields,
    id,
    sources: ["people-cli"],
    provenance,
    history: [],
    class: "unknown",
    updated: now,
  };
  draft.class = deriveClass(draft);
  return draft;
}

/**
 * Folds the new card into the store. A record already holding one of these
 * emails is the SAME human newly given a card, so it is absorbed rather than
 * duplicated — otherwise the store would carry two rows for one person and the
 * store's own uniqueness assert would refuse the write (ISC-5, ISC-32).
 */
export function upsertAdded(records: PersonRecord[], added: PersonRecord): PersonRecord[] {
  const mine = new Set(added.emails);
  const matches = records.filter((r) => r.id === added.id || r.emails.some((e) => mine.has(e)));
  const out = records.filter((r) => !matches.includes(r));
  if (matches.length === 0) return [...out, added];
  // Several existing rows can share the new card's addresses (an email-derived
  // record per address). They are one human by the fold rule, so they collapse
  // into one row rather than leaving the store with a duplicate email.
  const absorbed = matches.reduce((a, b) => ({
    ...b,
    ...a,
    emails: [...new Set([...a.emails, ...b.emails])],
    phones: [...new Set([...(a.phones ?? []), ...(b.phones ?? [])])],
    urls: [...new Set([...(a.urls ?? []), ...(b.urls ?? [])])],
    addresses: dedupeAddresses([...(a.addresses ?? []), ...(b.addresses ?? [])]),
    sources: [...new Set([...(a.sources ?? []), ...(b.sources ?? [])])],
    provenance: { ...b.provenance, ...a.provenance },
    history: [...(a.history ?? []), ...(b.history ?? [])],
  }));
  const merged: PersonRecord = {
    ...absorbed,
    ...added,
    // Union the identity arrays: the card is added information about someone we
    // already knew, never a replacement for what the store already held.
    emails: [...new Set([...absorbed.emails, ...added.emails])].sort(),
    phones: [...new Set([...absorbed.phones, ...added.phones])].sort(),
    urls: [...new Set([...(absorbed.urls ?? []), ...added.urls])].sort(),
    addresses: dedupeAddresses([...(absorbed.addresses ?? []), ...added.addresses]),
    sources: [...new Set([...absorbed.sources, "people-cli" as const])],
    provenance: { ...absorbed.provenance, ...added.provenance },
    history: absorbed.history ?? [],
    // Local-only truth survives (ISC-34).
    ...(absorbed.class_override ? { class_override: absorbed.class_override } : {}),
    ...(absorbed.same_as ? { same_as: absorbed.same_as } : {}),
    ...(absorbed.relationship ? { relationship: absorbed.relationship } : {}),
    ...(absorbed.tags ? { tags: absorbed.tags } : {}),
    ...(absorbed.customer ? { customer: absorbed.customer } : {}),
    ...(absorbed.interactions ? { interactions: absorbed.interactions } : {}),
    ...(absorbed.summary ? { summary: absorbed.summary, summary_updated: absorbed.summary_updated } : {}),
  };
  merged.class = deriveClass(merged);
  return [...out, merged];
}

/**
 * The local half of `people add`, run after the card exists. The card is created
 * first on purpose: if Contacts refuses, nothing local has changed, whereas a
 * local record claiming an Apple id that does not exist is the one state this
 * subsystem cannot repair by re-running.
 */
export function applyAddedRecord(id: string, fields: IdentityFields, now = new Date().toISOString()): PersonRecord {
  const record = recordFor(id, fields, now);
  withStoreLock(() => writeContacts(upsertAdded(readContacts(), record)));
  return record;
}
