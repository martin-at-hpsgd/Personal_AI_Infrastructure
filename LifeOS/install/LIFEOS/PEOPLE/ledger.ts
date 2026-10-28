#!/usr/bin/env bun
import { PRIVATE_SKILL_NAMES } from "../TOOLS/CodeDataBoundary.ts";
/**
 * @version 0.1.0
 *
 * People - ledger.ts. Typed interaction events from Gmail and Calendar.
 * ISA: ISC-15, ISC-16, ISC-17, ISC-18, ISC-40, ISC-40.1.
 *
 * Two halves, deliberately split so the logic is testable without a network:
 *   - the sweeps (syncGmail, ingestCalendar) talk to Google and cache raw rows
 *   - the builders (emailEventsFrom, calendarEventsFrom, rollup) are pure
 *     functions over those rows plus the person records
 *
 * The Gmail metadata cache and its checkpoint are the ones the ContactsDb
 * pipeline already built, in the same directory, with the same shape. Two
 * header fields were added (Auto-Submitted, Precedence) for the automated flag;
 * rows written before that read back with those fields absent and fall back to
 * the older listUnsub signal.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { invariant } from "../TOOLS/Invariant";
import { loadGoogleCreds } from "../TOOLS/GoogleCreds";
import {
  appendInteractions,
  readInteractions,
  readCacheJson,
  readCacheJsonl,
  writeCacheJson,
  writeCacheJsonl,
} from "./store";
import type { InteractionEvent, InteractionKind, InteractionRollup, PersonRecord } from "./types";

// -- shared helpers -----------------------------------------------------------

export const normEmail = (e: string) => e.trim().toLowerCase();
const nowIso = () => new Date().toISOString();

const META_CACHE = "gmail-meta.jsonl";
const GMAIL_STATE = "state.json";

/** One Gmail message's metadata. Superset of the shape ContactsDb already caches. */
export type MsgMeta = {
  id: string;
  internalDate: number;
  labelIds: string[];
  from: string;
  to: string;
  cc: string;
  subject: string;
  listId: boolean;
  listUnsub: boolean;
  /** Added for ISC-40; absent on rows cached before this module existed. */
  autoSubmitted?: boolean;
  precedence?: string;
};

/**
 * Local-part class includes '=' - ESP bounce/VERP encodings (unsub=x=1@esp.com)
 * otherwise truncate to a 1-char local and masquerade as distinct correspondents.
 */
const ADDR_RE = /(?:"?([^"<>]*)"?\s*)?<?([A-Za-z0-9._%+=\-']+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,})>?/g;

export function parseAddrs(v: string): { name: string; email: string }[] {
  const out: { name: string; email: string }[] = [];
  for (const m of (v ?? "").matchAll(ADDR_RE)) out.push({ name: (m[1] ?? "").trim(), email: normEmail(m[2]) });
  return out;
}

// -- the automated flag (ISC-40) ----------------------------------------------

/**
 * Automated when the message carries any of the three standard bulk markers:
 * List-Unsubscribe (or List-Id), Auto-Submitted other than "no", or a
 * Precedence of bulk/list/junk. Header-derived only - the sender's address is
 * not evidence, because a human at a company can send from a list-ish address.
 */
export function isAutomatedMessage(m: MsgMeta): boolean {
  if (m.listUnsub || m.listId) return true;
  if (m.autoSubmitted) return true;
  const p = (m.precedence ?? "").trim().toLowerCase();
  return p === "bulk" || p === "list" || p === "junk";
}

// -- Gmail sweep (ported from ContactsDb sync-gmail) --------------------------

// Credential resolution lives in TOOLS/GoogleCreds.ts — one resolver for every
// consumer. This function used to carry a two-step subset (env → credentials.json)
// that skipped the LIFEOS_CONFIG.toml step gmail.ts had, so it resolved to a path
// that exists nowhere and Gmail ingest was dark 2026-09-11 → 2026-09-22.

let cachedToken: { token: string; expires: number } | null = null;
async function accessToken(): Promise<string> {
  if (cachedToken && cachedToken.expires > Date.now() + 60_000) return cachedToken.token;
  const creds = loadGoogleCreds();
  const body = new URLSearchParams({
    client_id: creds.client_id,
    client_secret: creds.client_secret,
    refresh_token: creds.refresh_token,
    grant_type: "refresh_token",
  });
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(30_000),
  });
  if (!r.ok) throw new Error(`token refresh failed ${r.status}`);
  const j = (await r.json()) as { access_token: string; expires_in: number };
  cachedToken = { token: j.access_token, expires: Date.now() + j.expires_in * 1000 };
  return cachedToken.token;
}

// Metadata gets cost 5 quota units against a 15,000/min per-user limit; ~35 req/s
// stays safely under it.
let rateWindow: number[] = [];
async function throttle(): Promise<void> {
  const nowMs = Date.now();
  rateWindow = rateWindow.filter((t) => nowMs - t < 1000);
  if (rateWindow.length >= 35) {
    await new Promise((res) => setTimeout(res, 1050 - (nowMs - rateWindow[0])));
    return throttle();
  }
  rateWindow.push(Date.now());
}

async function gmail(path: string, attempt = 0): Promise<any> {
  await throttle();
  const t = await accessToken();
  const r = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me${path}`, {
    headers: { Authorization: `Bearer ${t}` },
    signal: AbortSignal.timeout(60_000),
  });
  if (!r.ok) {
    const body = await r.text();
    // Gmail signals per-minute quota as 403 rateLimitExceeded, not only 429.
    const rateLimited = r.status === 429 || (r.status === 403 && /rate|quota/i.test(body));
    if ((rateLimited || r.status >= 500) && attempt < 8) {
      await new Promise((res) => setTimeout(res, rateLimited ? 15_000 + 5_000 * attempt : 1000 * 2 ** attempt));
      return gmail(path, attempt + 1);
    }
    throw new Error(`${r.status} ${path}: ${body.slice(0, 200)}`);
  }
  return r.json();
}

async function listIds(q: string): Promise<string[]> {
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const qp = new URLSearchParams({ q, maxResults: "500" });
    if (pageToken) qp.set("pageToken", pageToken);
    const res = await gmail(`/messages?${qp}`);
    for (const m of res.messages ?? []) ids.push(m.id);
    pageToken = res.nextPageToken;
  } while (pageToken);
  return ids;
}

const META_HEADERS = ["From", "To", "Cc", "Subject", "List-Id", "List-Unsubscribe", "Auto-Submitted", "Precedence"];

async function fetchMeta(id: string): Promise<MsgMeta> {
  const qp = new URLSearchParams({ format: "metadata" });
  for (const h of META_HEADERS) qp.append("metadataHeaders", h);
  const m = await gmail(`/messages/${id}?${qp}`);
  const headers = m.payload?.headers ?? [];
  const h = (n: string) => headers.find((x: any) => x.name.toLowerCase() === n.toLowerCase())?.value ?? "";
  const auto = h("Auto-Submitted").trim().toLowerCase();
  return {
    id,
    internalDate: Number(m.internalDate ?? 0),
    labelIds: m.labelIds ?? [],
    from: h("From"),
    to: h("To"),
    cc: h("Cc"),
    subject: h("Subject").slice(0, 140),
    listId: !!h("List-Id"),
    listUnsub: !!h("List-Unsubscribe"),
    autoSubmitted: auto !== "" && auto !== "no",
    precedence: h("Precedence").slice(0, 40),
  };
}

async function pooled<T, R>(items: T[], width: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  }
  await Promise.all(Array.from({ length: width }, worker));
  return out;
}

/** Sweeps Gmail metadata since the checkpoint into the cache. Network; never called by a test. */
export async function syncGmail(
  windowDays = 730,
  expired: () => boolean = () => false,
): Promise<{ fetched: number; total: number }> {
  const cached = readCacheJsonl<MsgMeta>(META_CACHE);
  const have = new Set(cached.map((m) => m.id));
  const state = readCacheJson<{ lastInternalDate?: number }>(GMAIL_STATE, {});
  const sinceMs = state.lastInternalDate
    ? state.lastInternalDate - 86_400_000 // 1-day overlap; id-dedup absorbs it
    : Date.now() - windowDays * 86_400_000;
  const d = new Date(sinceMs);
  const q = `after:${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
  const ids = (await listIds(q)).filter((id) => !have.has(id));
  let maxDate = state.lastInternalDate ?? 0;
  const rows = [...cached];
  const CHUNK = 2000;
  for (let c = 0; c < ids.length; c += CHUNK) {
    const metas = await pooled(ids.slice(c, c + CHUNK), 12, fetchMeta);
    // A sweep that outlived its tick slot was already recorded as failed: it
    // stops before publishing another chunk or moving the checkpoint.
    if (expired()) return { fetched: rows.length - cached.length, total: rows.length };
    invariant(new Set(metas.map((m) => m.id)).size === metas.length, "duplicate ids in fetched batch");
    rows.push(...metas);
    for (const m of metas) maxDate = Math.max(maxDate, m.internalDate);
    writeCacheJsonl(META_CACHE, rows);
  }
  if (ids.length > 0) writeCacheJson(GMAIL_STATE, { lastInternalDate: maxDate, updated: nowIso() });
  return { fetched: ids.length, total: rows.length };
}

export const readGmailCache = (): MsgMeta[] => readCacheJsonl<MsgMeta>(META_CACHE);

// -- aggregation for the merge pass (ported from ContactsDb) ------------------

export type Agg = {
  email: string;
  names: Record<string, number>;
  sentTo: number;
  receivedFrom: number;
  first: number;
  last: number;
  subjects: string[];
  automatedSignals: number;
};

const AUTOMATED_LOCAL =
  /^(no-?reply|do-?not-?reply|noreply|notifications?|notify|alerts?|updates?|news(letter)?s?|mailer(-daemon)?|bounce[s]?|receipts?|billing|invoice\+?.*|statements?|support|help|hello|hi|team|info|contact|marketing|sales|digest|automated?|robot|bot|system|admin|postmaster|feedback|survey|confirm(ation)?s?|reservations?|orders?|shipping|tracking|security|account[s]?|password|verification|donotreply)$/i;

const AUTOMATED_SUBSTR =
  /(no-?reply|do-?not-?reply|notification|newsletter|mailer-|-mailer|bounce|unsubscribe|-alerts?|alerts?-|receipts?|invoice|billing|marketing@|autoreply)/i;

export function isAutomatedAddr(email: string): boolean {
  const local = email.split("@")[0].replace(/\+.*$/, "");
  return AUTOMATED_LOCAL.test(local) || AUTOMATED_SUBSTR.test(local);
}

/** The authenticated account's own addresses: senders of its SENT messages. */
export function selfAddrs(metas: MsgMeta[]): Set<string> {
  const counts = new Map<string, number>();
  for (const m of metas) {
    if (!m.labelIds.includes("SENT")) continue;
    for (const a of parseAddrs(m.from)) counts.set(a.email, (counts.get(a.email) ?? 0) + 1);
  }
  return new Set([...counts.entries()].filter(([, c]) => c >= 2).map(([e]) => e));
}

export function aggregate(metas: MsgMeta[]): Map<string, Agg> {
  const self = selfAddrs(metas);
  const aggs = new Map<string, Agg>();
  const touch = (email: string): Agg => {
    let a = aggs.get(email);
    if (!a) {
      a = { email, names: {}, sentTo: 0, receivedFrom: 0, first: Infinity, last: 0, subjects: [], automatedSignals: 0 };
      aggs.set(email, a);
    }
    return a;
  };
  for (const m of metas) {
    const sent = m.labelIds.includes("SENT");
    const parties = sent ? [...parseAddrs(m.to), ...parseAddrs(m.cc)] : parseAddrs(m.from);
    for (const p of parties) {
      if (self.has(p.email)) continue;
      const a = touch(p.email);
      if (p.name) a.names[p.name] = (a.names[p.name] ?? 0) + 1;
      if (sent) a.sentTo++;
      else {
        a.receivedFrom++;
        if (isAutomatedMessage(m)) a.automatedSignals++;
      }
      a.first = Math.min(a.first, m.internalDate);
      a.last = Math.max(a.last, m.internalDate);
      if (m.subject && a.subjects.length < 24 && !a.subjects.includes(m.subject)) a.subjects.push(m.subject);
    }
  }
  return aggs;
}

// Hard-automation locals exclude even when the account "sent" to them - replies
// to notification threads are not relationships.
const HARD_AUTOMATED = /(no-?reply|donotreply|notification|bounce|mailer-?daemon|unsubscribe|postmaster)/i;

/** Whether an email-only aggregate deserves a record of its own. */
export function isHuman(a: Agg): boolean {
  if (HARD_AUTOMATED.test(a.email)) return false; // full address: tokens appear in domains too
  if (a.sentTo > 0) return true; // the account wrote to them - always real
  if (isAutomatedAddr(a.email)) return false;
  // ESP sending subdomains are bulk senders when never written to.
  if (/^(mail|e|em|email|news|reply|msg|m|go|links?)\./i.test(a.email.split("@")[1] ?? "")) return false;
  if (a.receivedFrom > 0 && a.automatedSignals / a.receivedFrom > 0.5) return false;
  return a.receivedFrom >= 3;
}

export function bestName(a: Agg): string {
  const entries = Object.entries(a.names).sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1));
  return entries[0]?.[0] ?? a.email;
}

// -- email -> person index ----------------------------------------------------

export function emailIndex(records: PersonRecord[]): Map<string, string> {
  const idx = new Map<string, string>();
  for (const r of records) for (const e of r.emails) if (!idx.has(e)) idx.set(e, r.id);
  return idx;
}

// -- pure event builders ------------------------------------------------------

/** One `email` event per (message, known person). Automated flag is header-derived (ISC-15, ISC-40). */
export function emailEventsFrom(metas: MsgMeta[], records: PersonRecord[]): InteractionEvent[] {
  const idx = emailIndex(records);
  const self = selfAddrs(metas);
  const out: InteractionEvent[] = [];
  const seen = new Set<string>();
  for (const m of metas) {
    const sent = m.labelIds.includes("SENT");
    const parties = sent ? [...parseAddrs(m.to), ...parseAddrs(m.cc)] : parseAddrs(m.from);
    const automated = isAutomatedMessage(m);
    for (const p of parties) {
      if (self.has(p.email)) continue;
      const person = idx.get(p.email);
      if (!person) continue;
      const key = `${person} ${m.id}`;
      if (seen.has(key)) continue; // one event per message per person, not per address
      seen.add(key);
      out.push({
        person,
        kind: "email",
        at: new Date(m.internalDate).toISOString(),
        source: "email",
        ref: m.id,
        direction: sent ? "out" : "in",
        automated,
        ...(m.subject ? { subject: m.subject } : {}),
      });
    }
  }
  return out;
}

/** Raw gcal `list` items in, one `calendar` event per matching attendee out (ISC-16). */
export function calendarEventsFrom(items: any[], records: PersonRecord[]): InteractionEvent[] {
  const idx = emailIndex(records);
  const out: InteractionEvent[] = [];
  const seen = new Set<string>();
  for (const ev of items ?? []) {
    const id = typeof ev?.id === "string" ? ev.id : "";
    if (!id) continue;
    const start = ev?.start?.dateTime ?? ev?.start?.date ?? "";
    if (!start) continue;
    const at = new Date(start).toISOString();
    if (Number.isNaN(Date.parse(at))) continue;
    for (const a of ev?.attendees ?? []) {
      if (a?.self === true) continue;
      const email = typeof a?.email === "string" ? normEmail(a.email) : "";
      if (!email) continue;
      const person = idx.get(email);
      if (!person) continue;
      const key = `${person} ${id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        person,
        kind: "calendar",
        at,
        source: "calendar",
        ref: id,
        direction: "both",
        ...(typeof ev?.summary === "string" && ev.summary ? { subject: String(ev.summary).slice(0, 140) } : {}),
      });
    }
  }
  return out;
}

/** Per-person totals. Automated mail is counted apart, never in `total` (ISC-17, ISC-40.1). */
export function rollup(events: InteractionEvent[]): Map<string, InteractionRollup> {
  const out = new Map<string, InteractionRollup>();
  for (const e of events) {
    let r = out.get(e.person);
    if (!r) {
      r = { total: 0, automated: 0, byKind: {} };
      out.set(e.person, r);
    }
    if (e.automated) {
      r.automated++;
    } else {
      r.total++;
      r.byKind[e.kind] = (r.byKind[e.kind] ?? 0) + 1;
    }
    if (!r.first || e.at < r.first) r.first = e.at;
    if (!r.last || e.at > r.last) r.last = e.at;
  }
  return out;
}

export const INTERACTION_KINDS: readonly InteractionKind[] = ["email", "calendar", "text", "call", "meeting", "note"];

// -- ingest entry points ------------------------------------------------------

/** Reads the cached Gmail metadata and writes the events it implies. */
export function ingestGmail(records: PersonRecord[]): { added: number; total: number } {
  return appendInteractions(emailEventsFrom(readGmailCache(), records));
}

const GCAL = join(import.meta.dir, "..", "..", "skills", PRIVATE_SKILL_NAMES.calendar, "Tools", "gcal.ts");

/** Whether this install has the calendar tool. A public install does not: the tick reports that as skipped, not failed. */
export function calendarToolPresent(path: string = GCAL): boolean {
  return existsSync(path);
}

/** Shells out to the calendar tool for a window of events, then builds the events. */
export async function ingestCalendar(
  records: PersonRecord[],
  opts: { backDays?: number; forwardDays?: number; max?: number; timeoutMs?: number } = {},
): Promise<{ added: number; total: number }> {
  // The calendar tool is a private skill; a public install has no file here. The tick checks
  // calendarToolPresent() first and records a skip; a direct caller gets this error, never a spawn of a missing path.
  if (!calendarToolPresent()) throw new Error("calendar tool absent on this install (private skill); calendar ingestion skipped");
  const backDays = opts.backDays ?? 365;
  const forwardDays = opts.forwardDays ?? 30;
  const from = new Date(Date.now() - backDays * 86_400_000).toISOString();
  const to = new Date(Date.now() + forwardDays * 86_400_000).toISOString();
  const proc = Bun.spawn(
    ["bun", GCAL, "list", "--from", from, "--to", to, "--max", String(opts.max ?? 2500)],
    { stdout: "pipe", stderr: "pipe" },
  );
  const timer = setTimeout(() => proc.kill(), opts.timeoutMs ?? 120_000);
  let stdout = "";
  try {
    stdout = await new Response(proc.stdout).text();
    const code = await proc.exited;
    if (code !== 0) {
      const err = await new Response(proc.stderr).text();
      throw new Error(`gcal list exited ${code}: ${err.slice(0, 200)}`);
    }
  } finally {
    clearTimeout(timer);
  }
  const parsed = JSON.parse(stdout) as { items?: any[] };
  return appendInteractions(calendarEventsFrom(parsed.items ?? [], records));
}
