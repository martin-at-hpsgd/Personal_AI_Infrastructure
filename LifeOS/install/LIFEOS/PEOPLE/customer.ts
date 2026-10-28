#!/usr/bin/env bun
/**
 * People - customer.ts. Stripe and newsletter state, matched by email.
 * ISA: ISC-19, ISC-20, ISC-21.
 *
 * Bulk by construction: each backend's list is paginated ONCE into a
 * by-email index, then joined locally against the records. A few thousand people
 * against a few thousand customers is a handful of HTTP calls, not one call per person.
 *
 * A missing key is a `skipped` status with a note, never a throw. One backend
 * being unconfigured must not take the whole tick down (ISC-38 in spirit; the
 * tick itself is unit C).
 *
 * Keys come from the process environment, which Bun populates from the .env in
 * the working directory. This module never reads or prints a key.
 */

import type { CustomerState, PersonRecord, SourceStatus } from "./types";

export type CustomerLookup = {
  status: SourceStatus;
  note?: string;
  /** email -> the state that email implies. */
  byEmail: Map<string, CustomerState>;
};

const empty = (status: SourceStatus, note?: string): CustomerLookup => ({ status, note, byEmail: new Map() });

const norm = (e: string) => e.trim().toLowerCase();

async function getJson(url: string, key: string, timeoutMs: number): Promise<any> {
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) throw new Error(`${r.status} ${url.split("?")[0]}: ${(await r.text()).slice(0, 160)}`);
  return r.json();
}

// -- Stripe (ISC-19) ----------------------------------------------------------

type StripeCustomer = { id: string; email?: string | null; created?: number };
type StripeSub = { customer: string; status: string };
type StripeCharge = { customer: string | null; amount: number; paid: boolean; refunded?: boolean; created: number };

const ACTIVE_SUB = new Set(["active", "trialing", "past_due", "unpaid"]);

/**
 * Three paginated sweeps - customers, subscriptions, charges - joined locally.
 * `maxPages` bounds every loop so a pagination bug cannot spin forever.
 */
export async function fetchStripe(
  opts: { limit?: number; maxPages?: number; timeoutMs?: number } = {},
): Promise<CustomerLookup> {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return empty("skipped", "STRIPE_SECRET_KEY not in env");
  const limit = opts.limit ?? 100;
  const maxPages = opts.maxPages ?? 200;
  const timeoutMs = opts.timeoutMs ?? 30_000;

  async function page<T>(path: string, params: Record<string, string> = {}): Promise<T[]> {
    const out: T[] = [];
    let startingAfter: string | undefined;
    for (let p = 0; p < maxPages; p++) {
      const qp = new URLSearchParams({ limit: String(limit), ...params });
      if (startingAfter) qp.set("starting_after", startingAfter);
      const j = await getJson(`https://api.stripe.com/v1${path}?${qp}`, key!, timeoutMs);
      const data = (j.data ?? []) as T[];
      out.push(...data);
      if (!j.has_more || data.length === 0) break;
      startingAfter = (data[data.length - 1] as any).id;
      if (!startingAfter) break;
    }
    return out;
  }

  try {
    const [customers, subs, charges] = await Promise.all([
      page<StripeCustomer>("/customers"),
      page<StripeSub>("/subscriptions", { status: "all" }),
      page<StripeCharge>("/charges"),
    ]);

    const activeByCustomer = new Set<string>();
    for (const s of subs) if (ACTIVE_SUB.has(s.status)) activeByCustomer.add(s.customer);

    const paidByCustomer = new Map<string, { cents: number; first: number; last: number }>();
    for (const c of charges) {
      if (!c.customer || !c.paid || c.refunded) continue;
      const agg = paidByCustomer.get(c.customer) ?? { cents: 0, first: Infinity, last: 0 };
      agg.cents += c.amount;
      agg.first = Math.min(agg.first, c.created);
      agg.last = Math.max(agg.last, c.created);
      paidByCustomer.set(c.customer, agg);
    }

    const byEmail = new Map<string, CustomerState>();
    for (const c of customers) {
      if (!c.email) continue;
      const e = norm(c.email);
      const prior = byEmail.get(e)?.stripe;
      const paid = paidByCustomer.get(c.id);
      const firstSec = paid?.first !== undefined && paid.first !== Infinity ? paid.first : c.created;
      const merged = {
        active: (prior?.active ?? false) || activeByCustomer.has(c.id),
        lifetime_paid_cents: (prior?.lifetime_paid_cents ?? 0) + (paid?.cents ?? 0),
        first: minIso(prior?.first, firstSec),
        last: maxIso(prior?.last, paid?.last),
        customer_ids: [...new Set([...(prior?.customer_ids ?? []), c.id])].sort(),
      };
      byEmail.set(e, { ...(byEmail.get(e) ?? {}), stripe: merged });
    }
    return { status: "ok", byEmail };
  } catch (e) {
    return empty("failed", (e as Error).message);
  }
}

function minIso(cur: string | undefined, sec: number | undefined): string | undefined {
  if (sec === undefined || !Number.isFinite(sec)) return cur;
  const iso = new Date(sec * 1000).toISOString();
  return cur && cur < iso ? cur : iso;
}
function maxIso(cur: string | undefined, sec: number | undefined): string | undefined {
  if (sec === undefined || !Number.isFinite(sec) || sec === 0) return cur;
  const iso = new Date(sec * 1000).toISOString();
  return cur && cur > iso ? cur : iso;
}

// -- Beehiiv (ISC-20) ---------------------------------------------------------

type BeehiivSub = { email?: string; status?: string; subscription_tier?: string; tier?: string; created?: number | string };

/** One cursor-paginated sweep of the publication's subscriptions. */
export async function fetchNewsletter(
  opts: { limit?: number; maxPages?: number; timeoutMs?: number } = {},
): Promise<CustomerLookup> {
  const key = process.env.BEEHIIV_API_KEY;
  const pub = process.env.BEEHIIV_PUB_ID ?? process.env.BEEHIIV_PUBLICATION_ID;
  if (!key) return empty("skipped", "BEEHIIV_API_KEY not in env");
  if (!pub) return empty("skipped", "BEEHIIV_PUB_ID not in env");
  const limit = opts.limit ?? 100;
  const maxPages = opts.maxPages ?? 500;
  const timeoutMs = opts.timeoutMs ?? 30_000;

  try {
    const byEmail = new Map<string, CustomerState>();
    let cursor: string | undefined;
    for (let p = 0; p < maxPages; p++) {
      const qp = new URLSearchParams({ limit: String(limit) });
      if (cursor) qp.set("cursor", cursor);
      const j = await getJson(`https://api.beehiiv.com/v2/publications/${pub}/subscriptions?${qp}`, key, timeoutMs);
      const data = (j.data ?? []) as BeehiivSub[];
      for (const s of data) {
        if (!s.email) continue;
        const e = norm(s.email);
        byEmail.set(e, {
          ...(byEmail.get(e) ?? {}),
          newsletter: {
            status: s.status ?? "unknown",
            ...(s.subscription_tier || s.tier ? { tier: s.subscription_tier ?? s.tier } : {}),
            ...(s.created ? { subscribed_at: isoFrom(s.created) } : {}),
          },
        });
      }
      if (!j.has_more || !j.next_cursor || data.length === 0) break;
      cursor = j.next_cursor;
    }
    return { status: "ok", byEmail };
  } catch (e) {
    return empty("failed", (e as Error).message);
  }
}

function isoFrom(v: number | string): string {
  if (typeof v === "number") return new Date(v * (v > 1e11 ? 1 : 1000)).toISOString();
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? new Date(0).toISOString() : d.toISOString();
}

// -- join ---------------------------------------------------------------------

/**
 * Attaches customer state to the records it matches by email, returning new
 * record objects. A record that matches nothing keeps whatever it had - absence
 * of a match is not evidence the state was revoked, and the two backends are
 * attached independently so one being skipped never erases the other.
 */
export function attachCustomerState(
  records: PersonRecord[],
  lookups: { stripe?: CustomerLookup; newsletter?: CustomerLookup },
  now = new Date().toISOString(),
): { records: PersonRecord[]; matched: { stripe: number; newsletter: number } } {
  const matched = { stripe: 0, newsletter: 0 };
  const out = records.map((r) => {
    let customer: CustomerState | undefined = r.customer;
    for (const e of r.emails) {
      const s = lookups.stripe?.status === "ok" ? lookups.stripe.byEmail.get(e)?.stripe : undefined;
      if (s) {
        customer = { ...(customer ?? {}), stripe: s };
        matched.stripe++;
        break;
      }
    }
    for (const e of r.emails) {
      const n = lookups.newsletter?.status === "ok" ? lookups.newsletter.byEmail.get(e)?.newsletter : undefined;
      if (n) {
        customer = { ...(customer ?? {}), newsletter: n };
        matched.newsletter++;
        break;
      }
    }
    if (customer === r.customer) return r;
    return { ...r, customer, updated: now };
  });
  return { records: out, matched };
}

// -- the question the CLI asks (ISC-21) ---------------------------------------

export type CustomerVerdict = "now" | "past" | "no";

/**
 * `now` when any product state is active, `past` when Stripe shows history with
 * nothing active, `no` otherwise. A lapsed newsletter subscription alone is not
 * "past customer": money is the evidence that they ever were one.
 */
export function customerVerdict(r: Pick<PersonRecord, "customer">): CustomerVerdict {
  const c = r.customer;
  if (!c) return "no";
  const newsletterActive = !!c.newsletter && /^(active|validating|paid)$/i.test(c.newsletter.status);
  if (c.stripe?.active || newsletterActive) return "now";
  if (c.stripe && (c.stripe.lifetime_paid_cents > 0 || (c.stripe.customer_ids?.length ?? 0) > 0)) return "past";
  return "no";
}
