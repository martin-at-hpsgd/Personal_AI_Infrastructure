#!/usr/bin/env bun
/**
 * People - query.ts. The answers behind `people who`, `list` and `stats`.
 * ISA: ISC-17, ISC-21, ISC-22, ISC-23, ISC-24, ISC-25, ISC-39, ISC-40.1, ISC-42.
 *
 * Tolerant by design. The store predates this subsystem: records written by
 * the ContactsDb pipeline carry no class, no provenance and a different
 * interactions shape. Every read here fills those in from what is there rather
 * than demanding the new shape, so `who` answers on day one and keeps answering
 * while the rebuild catches up. Nothing in this file writes.
 *
 * `who` returns EVERY match (ISC-42). Two humans who share a name are two
 * answers, never one rounded-off identity.
 */

import { existsSync, statSync } from "node:fs";
import { customerVerdict, type CustomerVerdict } from "./customer";
import { INTERACTION_KINDS, rollup as ledgerRollup } from "./ledger";
import { contactsPath, interactionsPath, readContacts, readInteractions, readRuns } from "./store";
import {
  effectiveClass,
  type InteractionEvent,
  type InteractionKind,
  type InteractionRollup,
  type PersonClass,
  type PersonRecord,
  type SourceName,
  type SourceStatus,
} from "./types";

/** The pre-People interactions shape, still on most live records. */
type LegacyInteractions = { sentTo?: number; receivedFrom?: number; first?: string; last?: string; subjects?: string[] };

export const STALE_HOURS = 48;
const LEDGER_DETAIL_CEILING_BYTES = 128 * 1024 * 1024;

// -- loading ------------------------------------------------------------------

/** Which version of the store is on disk (its path and modification time, `0` when absent), so a caller that caches
 *  what it loaded (Identity.ts) re-reads only when the store changes. */
export function contactsVersion(): string {
  const path = contactsPath();
  try { return `${path}|${statSync(path).mtimeMs}`; } catch { return `${path}|0`; }
}

/** Records with the fields this module needs filled in, in memory only. */
export function loadRecords(): PersonRecord[] {
  return readContacts().map((r) => ({
    ...r,
    emails: r.emails ?? [],
    phones: r.phones ?? [],
    addresses: r.addresses ?? [],
    urls: r.urls ?? [],
    sources: r.sources ?? [],
    provenance: r.provenance ?? {},
    history: r.history ?? [],
    class: r.class ?? "unknown",
  }));
}

/**
 * The rollup for one record: the ledger when it knows this person, otherwise
 * the cached field, normalizing either interactions shape.
 */
export function rollupOf(r: PersonRecord): InteractionRollup {
  const fromLedger = ledger().rollups.get(r.id);
  if (fromLedger) return fromLedger;
  const raw = r.interactions as (InteractionRollup & LegacyInteractions) | undefined;
  if (!raw) return { total: 0, automated: 0, byKind: {} };
  if (typeof raw.total === "number") return { ...raw, automated: raw.automated ?? 0, byKind: raw.byKind ?? {} };
  const total = (raw.sentTo ?? 0) + (raw.receivedFrom ?? 0);
  return {
    total,
    automated: 0,
    byKind: total ? { email: total } : {},
    ...(raw.first ? { first: raw.first } : {}),
    ...(raw.last ? { last: raw.last } : {}),
  };
}

/**
 * The ledger, read at most once per process per file version. The cached
 * `interactions` field on a record is a convenience for consumers that never
 * open the ledger; here the ledger itself is the authority, so a rollup can
 * never drift behind the events that produced it.
 */
let ledgerCache: { key: string; events: InteractionEvent[]; rollups: Map<string, InteractionRollup> } | null = null;

function ledger(): { events: InteractionEvent[]; rollups: Map<string, InteractionRollup> } {
  const path = interactionsPath();
  if (!existsSync(path)) return { events: [], rollups: new Map() };
  const st = statSync(path);
  if (st.size > LEDGER_DETAIL_CEILING_BYTES) return { events: [], rollups: new Map() };
  const key = `${path}:${st.size}:${st.mtimeMs}`;
  if (ledgerCache?.key === key) return ledgerCache;
  const events = readInteractions();
  ledgerCache = { key, events, rollups: ledgerRollup(events) };
  return ledgerCache;
}

/** The last n non-automated events for one person, newest first. */
export function recentFor(personId: string, n = 3): InteractionEvent[] {
  return ledger()
    .events.filter((e) => e.person === personId && !e.automated)
    .sort((a, b) => (a.at < b.at ? 1 : -1))
    .slice(0, n);
}

// -- who (ISC-22, ISC-42) -----------------------------------------------------

export type WhoAnswer = {
  id: string;
  name: string;
  class: PersonClass;
  derivedClass: PersonClass;
  overridden: boolean;
  org?: string;
  relationship?: string;
  emails: string[];
  phones: string[];
  interactions: InteractionRollup;
  customer: CustomerVerdict;
  customerDetail?: PersonRecord["customer"];
  recent: { kind: InteractionKind; at: string; subject?: string }[];
  summary?: string;
  sources: string[];
  updated: string;
};

export function answerFor(r: PersonRecord): WhoAnswer {
  const roll = rollupOf(r);
  return {
    id: r.id,
    name: r.name,
    class: effectiveClass(r),
    derivedClass: r.class,
    overridden: r.class_override !== undefined,
    ...(r.org ? { org: r.org } : {}),
    ...(r.relationship ? { relationship: r.relationship } : {}),
    emails: r.emails,
    phones: r.phones ?? [],
    interactions: roll,
    customer: customerVerdict(r),
    ...(r.customer ? { customerDetail: r.customer } : {}),
    recent: recentFor(r.id).map((e) => ({ kind: e.kind, at: e.at, ...(e.subject ? { subject: e.subject } : {}) })),
    ...(r.summary ? { summary: r.summary } : {}),
    sources: r.sources ?? [],
    updated: r.updated,
  };
}

/**
 * Exact email, then exact name, then fragment across name, nickname, org and
 * emails. Every stage returns ALL of its matches; a later stage runs only when
 * an earlier one found nothing.
 */
export function findPeople(needle: string, records = loadRecords()): PersonRecord[] {
  const q = needle.trim().toLowerCase();
  if (!q) return [];
  const byEmail = records.filter((r) => r.emails.includes(q));
  if (byEmail.length) return byEmail;
  const byName = records.filter((r) => (r.name ?? "").toLowerCase() === q);
  if (byName.length) return byName;
  const frag = records.filter((r) =>
    (r.name ?? "").toLowerCase().includes(q) ||
    (r.nickname ?? "").toLowerCase().includes(q) ||
    (r.org ?? "").toLowerCase().includes(q) ||
    r.emails.some((e) => e.includes(q)),
  );
  return frag.sort((a, b) => rollupOf(b).total - rollupOf(a).total || (a.name < b.name ? -1 : 1));
}

export const who = (needle: string, records = loadRecords()): WhoAnswer[] =>
  findPeople(needle, records).map(answerFor);

// -- list (ISC-23) ------------------------------------------------------------

export function listPeople(opts: { class?: PersonClass; limit?: number } = {}, records = loadRecords()): PersonRecord[] {
  let out = records;
  if (opts.class) out = out.filter((r) => effectiveClass(r) === opts.class);
  out = [...out].sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
  return opts.limit ? out.slice(0, opts.limit) : out;
}

// -- stats (ISC-24, ISC-39) ---------------------------------------------------

export type SourceFreshness = {
  source: SourceName;
  lastOk?: string;
  ageHours?: number;
  stale: boolean;
  lastStatus?: SourceStatus;
};

export type Stats = {
  people: number;
  personal: number;
  business: number;
  both: number;
  unknown: number;
  customersNow: number;
  customersPast: number;
  interactions: { total: number; automated: number; byKind: Partial<Record<InteractionKind, number>> };
  sources: SourceFreshness[];
  store: string;
};

/** Per-source freshness from runs.jsonl. Never-run and older than 48h both read STALE. */
export function sourceFreshness(now = Date.now(), runs = readRuns()): SourceFreshness[] {
  const names: SourceName[] = ["apple", "gmail", "calendar", "stripe", "beehiiv", "merge"];
  return names.map((source) => {
    let lastOk: string | undefined;
    let lastStatus: SourceStatus | undefined;
    for (const run of runs) {
      const s = run.sources?.[source];
      if (!s) continue;
      lastStatus = s.status;
      if (s.status === "ok" && (!lastOk || run.at > lastOk)) lastOk = run.at;
    }
    if (!lastOk) return { source, stale: true, ...(lastStatus ? { lastStatus } : {}) };
    const ageHours = (now - Date.parse(lastOk)) / 3_600_000;
    return { source, lastOk, ageHours: Math.round(ageHours * 10) / 10, stale: ageHours > STALE_HOURS, ...(lastStatus ? { lastStatus } : {}) };
  });
}

export function stats(records = loadRecords(), now = Date.now()): Stats {
  const counts: Record<PersonClass, number> = { personal: 0, business: 0, both: 0, unknown: 0 };
  let customersNow = 0;
  let customersPast = 0;
  const byKind: Partial<Record<InteractionKind, number>> = {};
  let total = 0;
  let automated = 0;
  for (const r of records) {
    counts[effectiveClass(r)]++;
    const v = customerVerdict(r);
    if (v === "now") customersNow++;
    else if (v === "past") customersPast++;
    const roll = rollupOf(r);
    total += roll.total;
    automated += roll.automated;
    for (const k of INTERACTION_KINDS) {
      const n = roll.byKind[k];
      if (n) byKind[k] = (byKind[k] ?? 0) + n;
    }
  }
  return {
    people: records.length,
    personal: counts.personal,
    business: counts.business,
    both: counts.both,
    unknown: counts.unknown,
    customersNow,
    customersPast,
    interactions: { total, automated, byKind },
    sources: sourceFreshness(now),
    store: contactsPath(),
  };
}

// -- plain-text rendering -----------------------------------------------------

const dateOnly = (iso?: string) => (iso ? iso.slice(0, 10) : "");

export function renderWho(a: WhoAnswer): string {
  const lines: string[] = [];
  const head = [a.name, a.org ? `- ${a.org}` : "", a.relationship ? `[${a.relationship}]` : ""].filter(Boolean).join(" ");
  lines.push(head);
  lines.push(`  class: ${a.class}${a.overridden ? ` (override; derived ${a.derivedClass})` : ""}`);
  if (a.emails.length) lines.push(`  email: ${a.emails.join(", ")}`);
  if (a.phones.length) lines.push(`  phone: ${a.phones.join(", ")}`);
  const kinds = INTERACTION_KINDS.filter((k) => a.interactions.byKind[k]).map((k) => `${k} ${a.interactions.byKind[k]}`);
  const span = a.interactions.first || a.interactions.last
    ? ` (${dateOnly(a.interactions.first)} to ${dateOnly(a.interactions.last)})`
    : "";
  lines.push(
    `  interactions: ${a.interactions.total}${kinds.length ? ` [${kinds.join(", ")}]` : ""}` +
      `${a.interactions.automated ? `, ${a.interactions.automated} automated` : ""}${span}`,
  );
  lines.push(`  customer: ${a.customer}`);
  for (const e of a.recent) lines.push(`  last: ${dateOnly(e.at)} ${e.kind}${e.subject ? ` - ${e.subject}` : ""}`);
  if (a.summary) lines.push(`\n${a.summary}`);
  lines.push(`  sources: ${a.sources.join(", ") || "none"} | id ${a.id}`);
  return lines.join("\n");
}

export function renderStats(s: Stats): string {
  const kinds = INTERACTION_KINDS.filter((k) => s.interactions.byKind[k]).map((k) => `  ${k}: ${s.interactions.byKind[k]}`);
  const sources = s.sources.map(
    (f) =>
      `  ${f.source}: ${f.lastOk ? `${f.ageHours}h ago` : "never"}${f.lastStatus ? ` (${f.lastStatus})` : ""}${f.stale ? "  STALE" : ""}`,
  );
  return [
    `people: ${s.people}`,
    `  personal: ${s.personal}`,
    `  business: ${s.business}`,
    `  both: ${s.both}`,
    `  unknown: ${s.unknown}`,
    `customers now: ${s.customersNow}`,
    `customers past: ${s.customersPast}`,
    `interactions: ${s.interactions.total} (${s.interactions.automated} automated)`,
    ...kinds,
    "sources:",
    ...sources,
  ].join("\n");
}

export function renderList(records: PersonRecord[]): string {
  return records
    .map((r) => `${r.name}${r.org ? ` - ${r.org}` : ""}  [${effectiveClass(r)}]  ${r.emails.join(", ")}`)
    .join("\n");
}
