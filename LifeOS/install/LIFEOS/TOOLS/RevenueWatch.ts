#!/usr/bin/env bun
/**
 * @version 1.2.1
 * 1.2.0: real MRR, net of live discounts (comps, coupons), is the headline; list MRR is kept
 *   beside it, because list prices overstate what is actually billed. An item is also capped at
 *   its share of the subscription's latest invoice, since a one-off comp leaves no live discount
 *   on the subscription.
 * 1.1.0: pace events at most once a week (no flapping on small churn); items with no
 * usable price are counted; failed renewals labelled as a current count.
 * RevenueWatch.ts — qualified recurring revenue against the product-MRR goal.
 *
 * Reads every active subscription in each configured Stripe account (GET only),
 * puts each recurring item in a moat line from the USER config, and writes a
 * snapshot: qualified MRR by line, unclassified MRR on its own, the gap to the
 * target, the monthly growth needed, pace against a straight line from the first
 * snapshot, and the last 7 days of failed renewals, cancellations and disputes.
 * Lines with no billing source report `no source`, never zero.
 *
 * Vigil hears about a new dispute (high) and a pace flip (medium). Event text
 * carries counts and states only, never dollar amounts.
 *
 * Usage:
 *   bun RevenueWatch.ts            pull, write the snapshot, emit Vigil events
 *   bun RevenueWatch.ts --print    pull and print; writes nothing
 *   bun RevenueWatch.ts --json     same as the default, report as JSON on stdout
 *
 * Config:   LIFEOS/USER/CONFIG/revenue-lines.json
 * Snapshot: LIFEOS/USER/FINANCES/revenue-watch.json
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { invariant } from "./Invariant";
import { getClaudeDir, lifeosPath } from "./Paths";
import { emitVigilEvent, vigilEvent } from "./lib/VigilOptional";

export type Rule = { product?: string; account?: string; metadata_source?: string; line: string };
export type Config = {
  target: { mrr_usd: number; by: string };
  qualified_lines: string[];
  sourceless_lines: string[];
  accounts: Array<{ name: string; env: string }>;
  rules: Rule[];
};
export type Product = { id: string; name: string; metadata?: Record<string, string> };
/** A discount as it bears on recurring revenue. `end` is unix seconds, null for none. */
export type Disc = { percent_off: number | null; amount_off: number | null; duration: string; end: number | null };
export type Item = { account: string; product: string; unit_amount: number | null; quantity: number; interval: string | null; interval_count: number; discounts?: Disc[];
  /** This item's share of the subscription's latest invoice total, in cents; undefined when unknown. */
  last_charged?: number;
  /** The price's ISO currency as Stripe gives it (lowercase); undefined is read as usd. */
  currency?: string };
export type LineTotal = { mrr_usd: number; list_mrr_usd: number; subscriptions: number } | "no source";
export type Snapshot = {
  updated: string;
  target: { mrr_usd: number; by: string };
  /** Real MRR: what active subscriptions charge after live discounts. The headline. */
  qualified_mrr_usd: number;
  /** List MRR: what the price sheet says the same subscriptions are worth. */
  list_qualified_mrr_usd: number;
  unclassified_mrr_usd: number;
  excluded_mrr_usd: number;
  items_skipped_no_price: number;
  /** Items priced in a currency other than USD: left out of every USD figure, never converted. */
  items_skipped_non_usd: number;
  discounts_unreadable: number;
  lines: Record<string, LineTotal>;
  unclassified_products: Array<{ id: string; name: string; mrr_usd: number; subscriptions: number }>;
  gap_usd: number;
  months_left: number;
  needed_monthly_growth_usd: number;
  baseline: { ts: string; qualified_mrr_usd: number; basis?: "real" };
  /** `baseline` on the first snapshot, when there is no line to be behind yet. */
  pace: "baseline" | "on-track" | "off-track";
  /** When Vigil last heard about pace; flips inside a week of it stay quiet. */
  last_pace_event?: string;
  failed_renewals: number;
  cancellations_7d: number;
  disputes_7d: number;
  dispute_ids_7d: string[];
  accounts: Record<string, "ok" | string>;
};
/** GET-only Stripe reader: (account, path, params) → parsed JSON. */
export type Get = (account: string, path: string, params?: Record<string, string>) => Promise<any>;

const DAY = 86_400_000, MONTH_DAYS = 30.44;
const INTERVAL_MONTHS: Record<string, number> = { month: 1, year: 12, week: 7 / MONTH_DAYS, day: 1 / MONTH_DAYS };
const round2 = (n: number) => Math.round(n * 100) / 100;

export const configPath = () => process.env.REVENUE_LINES_CONFIG ?? lifeosPath("USER", "CONFIG", "revenue-lines.json");
export const snapshotPath = () => process.env.REVENUE_WATCH_SNAPSHOT ?? lifeosPath("USER", "FINANCES", "revenue-watch.json");

export function monthly(item: Item): number | null {
  if (item.unit_amount === null || !item.interval || !INTERVAL_MONTHS[item.interval]) return null;
  return (item.unit_amount * item.quantity) / (INTERVAL_MONTHS[item.interval]! * (item.interval_count || 1)) / 100;
}

/** What the item actually charges per month after its live discounts; null when it has no usable price. */
export function realMonthly(item: Item, now: Date): number | null {
  const list = monthly(item);
  if (list === null) return null;
  const months = INTERVAL_MONTHS[item.interval!]! * (item.interval_count || 1);
  let m = list;
  for (const d of item.discounts ?? []) {
    if (d.duration === "once") continue; // first invoice only, not recurring revenue
    if (d.end !== null && d.end * 1000 <= now.getTime()) continue;
    if (d.percent_off) m *= 1 - d.percent_off / 100;
    if (d.amount_off) m -= d.amount_off / 100 / months;
  }
  // What the last cycle actually charged caps it: a comped year shows as zero until it renews.
  if (typeof item.last_charged === "number") m = Math.min(m, item.last_charged / 100 / months);
  return Math.max(0, m);
}

/** A Stripe discount object, coupon embedded or under source, as a Disc; null when its coupon is not readable. */
export function toDisc(d: any): Disc | null {
  if (!d || typeof d !== "object") return null;
  const c = typeof d.coupon === "object" && d.coupon ? d.coupon : typeof d.source?.coupon === "object" && d.source.coupon ? d.source.coupon : null;
  if (!c) return null;
  return { percent_off: c.percent_off ?? null, amount_off: c.amount_off ?? null, duration: c.duration ?? "forever", end: typeof d.end === "number" ? d.end : null };
}

export function lineFor(item: Item, product: Product | undefined, rules: Rule[]): string | null {
  for (const r of rules) {
    if (r.product && r.product !== item.product) continue;
    if (r.account && r.account !== item.account) continue;
    if (r.metadata_source && product?.metadata?.source !== r.metadata_source) continue;
    return r.line;
  }
  return null;
}

/** Every page of a Stripe list, no cap. */
export async function listAll(get: Get, account: string, path: string, params: Record<string, string> = {}): Promise<any[]> {
  const out: any[] = [];
  let after: string | undefined;
  for (;;) {
    const page = await get(account, path, { limit: "100", ...params, ...(after ? { starting_after: after } : {}) });
    out.push(...(page.data ?? []));
    if (!page.has_more || !page.data?.length) break;
    after = page.data[page.data.length - 1].id;
  }
  return out;
}

export async function pull(get: Get, cfg: Config, now: Date) {
  const items: Item[] = [];
  const products = new Map<string, Product>();
  const accounts: Record<string, string> = {};
  let failed = 0, cancels = 0, unreadableDiscounts = 0;
  const disputes: string[] = [];
  const since = String(Math.floor((now.getTime() - 7 * DAY) / 1000));
  for (const a of cfg.accounts) {
    try {
      const subs = await listAll(get, a.name, "subscriptions", { status: "active", "expand[0]": "data.items.data.price", "expand[1]": "data.discounts", "expand[2]": "data.items.data.discounts", "expand[3]": "data.latest_invoice" });
      for (const s of subs) {
        const subDiscs = [...(s.discounts ?? []), ...(s.discount ? [s.discount] : [])];
        const inv = s.latest_invoice && typeof s.latest_invoice === "object" ? s.latest_invoice : null;
        // Split the invoice across items by list weight; skip invoices that are not a period charge.
        // An update invoice is usually a partial proration, so it only counts when it is a $0 comp.
        const periodInvoice = inv && typeof inv.total === "number" && (["subscription_create", "subscription_cycle"].includes(inv.billing_reason) || (inv.billing_reason === "subscription_update" && inv.total === 0)) ? inv : null;
        const weights = (s.items?.data ?? []).map((it: any) => (it.price?.unit_amount ?? 0) * (it.quantity ?? 1));
        const wsum = weights.reduce((a: number, b: number) => a + b, 0);
        let idx = 0;
        for (const it of s.items?.data ?? []) {
          const share = periodInvoice && wsum > 0 ? Math.max(0, periodInvoice.total) * (weights[idx]! / wsum) : undefined;
          // A subscription-wide fixed discount comes off the whole subscription once, so each item carries its list-weight share of it.
          const frac = wsum > 0 ? weights[idx]! / wsum : 1 / weights.length;
          idx++;
          const p = it.price ?? {};
          const raw = [...subDiscs, ...(it.discounts ?? [])];
          const discounts = raw.map((d, j) => {
            const x = toDisc(d);
            return x && j < subDiscs.length && x.amount_off ? { ...x, amount_off: x.amount_off * frac } : x;
          }).filter((d): d is Disc => d !== null);
          unreadableDiscounts += raw.length - discounts.length;
          items.push({ account: a.name, product: typeof p.product === "string" ? p.product : p.product?.id, unit_amount: typeof p.unit_amount === "number" ? p.unit_amount : null, quantity: it.quantity ?? 1, interval: p.recurring?.interval ?? null, interval_count: p.recurring?.interval_count ?? 1, discounts, ...(typeof p.currency === "string" ? { currency: p.currency } : {}), ...(share !== undefined ? { last_charged: share } : {}) });
        }
      }
      for (const status of ["past_due", "unpaid"]) failed += (await listAll(get, a.name, "subscriptions", { status })).length;
      accounts[a.name] = "ok";
    } catch (e) { accounts[a.name] = `subscriptions unreadable: ${e instanceof Error ? e.message.slice(0, 120) : String(e)}`; continue; }
    // Restricted keys may lack event or dispute scopes; that is recorded, not fatal.
    try { cancels += (await listAll(get, a.name, "events", { type: "customer.subscription.deleted", "created[gte]": since })).length; }
    catch (e) { accounts[a.name] = `${accounts[a.name] === "ok" ? "" : accounts[a.name] + "; "}events unreadable`; }
    try { disputes.push(...(await listAll(get, a.name, "disputes", { "created[gte]": since })).map((d) => d.id)); }
    catch (e) { accounts[a.name] = `${accounts[a.name] === "ok" ? "" : accounts[a.name] + "; "}disputes unreadable`; }
    for (const id of new Set(items.filter((i) => i.account === a.name).map((i) => i.product))) {
      if (!id || products.has(id)) continue;
      try { const p = await get(a.name, `products/${id}`); products.set(id, { id, name: p.name ?? id, metadata: p.metadata ?? {} }); }
      catch { products.set(id, { id, name: id }); }
    }
  }
  return { items, products, accounts, failed, cancels, disputes, unreadableDiscounts };
}

export function compute(pulled: Awaited<ReturnType<typeof pull>>, cfg: Config, prev: Snapshot | null, now: Date): Snapshot {
  const lines: Record<string, LineTotal> = {};
  for (const l of cfg.qualified_lines) lines[l] = cfg.sourceless_lines.includes(l) ? "no source" : { mrr_usd: 0, list_mrr_usd: 0, subscriptions: 0 };
  const uncl = new Map<string, { id: string; name: string; mrr_usd: number; subscriptions: number }>();
  let qualified = 0, listQualified = 0, unclassified = 0, excluded = 0, skipped = 0, nonUsd = 0;
  for (const it of pulled.items) {
    // Every figure here is USD; a price in another currency would be summed as if it were dollars.
    if (it.currency && it.currency.toLowerCase() !== "usd") { nonUsd++; continue; }
    const list = monthly(it), m = realMonthly(it, now);
    if (list === null || m === null) { skipped++; continue; }
    const line = lineFor(it, pulled.products.get(it.product), cfg.rules);
    if (line === null) {
      unclassified += m;
      const u = uncl.get(it.product) ?? { id: it.product, name: pulled.products.get(it.product)?.name ?? it.product, mrr_usd: 0, subscriptions: 0 };
      u.mrr_usd += m; u.subscriptions++; uncl.set(it.product, u);
    } else if (cfg.qualified_lines.includes(line)) {
      qualified += m; listQualified += list;
      const cur = lines[line];
      lines[line] = cur === "no source" || cur === undefined ? { mrr_usd: m, list_mrr_usd: list, subscriptions: 1 } : { mrr_usd: cur.mrr_usd + m, list_mrr_usd: cur.list_mrr_usd + list, subscriptions: cur.subscriptions + 1 };
    } else excluded += m;
  }
  for (const [k, v] of Object.entries(lines)) if (v !== "no source") lines[k] = { mrr_usd: round2(v.mrr_usd), list_mrr_usd: round2(v.list_mrr_usd), subscriptions: v.subscriptions };
  const byTs = Date.parse(`${cfg.target.by}T23:59:59Z`);
  const monthsLeft = Math.max(0, (byTs - now.getTime()) / DAY / MONTH_DAYS);
  const gap = Math.max(0, cfg.target.mrr_usd - qualified);
  // A baseline drawn on list MRR is not comparable with real MRR: start the line again.
  const prevReal = prev?.baseline?.basis === "real" ? prev : null;
  const baseline = prevReal?.baseline ?? { ts: now.toISOString(), qualified_mrr_usd: round2(qualified), basis: "real" as const };
  const bTs = Date.parse(baseline.ts);
  const f = byTs <= bTs ? 1 : Math.max(0, Math.min(1, (now.getTime() - bTs) / (byTs - bTs)));
  const expected = baseline.qualified_mrr_usd + (cfg.target.mrr_usd - baseline.qualified_mrr_usd) * f;
  return {
    updated: now.toISOString(),
    target: cfg.target,
    qualified_mrr_usd: round2(qualified),
    list_qualified_mrr_usd: round2(listQualified),
    unclassified_mrr_usd: round2(unclassified),
    excluded_mrr_usd: round2(excluded),
    items_skipped_no_price: skipped,
    items_skipped_non_usd: nonUsd,
    discounts_unreadable: pulled.unreadableDiscounts,
    lines,
    unclassified_products: [...uncl.values()].map((u) => ({ ...u, mrr_usd: round2(u.mrr_usd) })).sort((a, b) => b.mrr_usd - a.mrr_usd),
    gap_usd: round2(gap),
    months_left: Math.round(monthsLeft * 10) / 10,
    needed_monthly_growth_usd: monthsLeft > 0 ? round2(gap / monthsLeft) : round2(gap),
    baseline,
    pace: !prevReal ? "baseline" : qualified + 0.005 >= expected ? "on-track" : "off-track",
    failed_renewals: pulled.failed,
    cancellations_7d: pulled.cancels,
    disputes_7d: pulled.disputes.length,
    dispute_ids_7d: pulled.disputes,
    accounts: pulled.accounts,
    ...(prev?.last_pace_event ? { last_pace_event: prev.last_pace_event } : {}),
  };
}

/** Vigil events for what changed since the last snapshot. Counts and states only. */
export function changes(prev: Snapshot | null, next: Snapshot): Array<{ ref: string; state: string; severity: "high" | "medium"; title: string; summary: string }> {
  const out: ReturnType<typeof changes> = [];
  const seen = new Set(prev?.dispute_ids_7d ?? []);
  const fresh = next.dispute_ids_7d.filter((d) => !seen.has(d));
  if (prev && fresh.length) out.push({ ref: `disputes:${fresh.sort().join(",")}`, state: "new", severity: "high", title: fresh.length === 1 ? "A new Stripe dispute was opened" : `${fresh.length} new Stripe disputes were opened`, summary: `${next.disputes_7d} dispute(s) opened in the last 7 days. Respond in Stripe before the deadline. Details: bun LIFEOS/TOOLS/RevenueWatch.ts --print` });
  // Falling behind from the baseline is news; reaching on-track from it is not.
  const paceQuiet = next.last_pace_event && Date.parse(next.updated) - Date.parse(next.last_pace_event) < 7 * DAY;
  if (prev && !paceQuiet && prev.pace !== next.pace && !(prev.pace === "baseline" && next.pace === "on-track")) out.push({ ref: "pace", state: next.pace, severity: "medium", title: next.pace === "off-track" ? "Qualified MRR fell behind pace for the year-end target" : "Qualified MRR is back on pace for the year-end target", summary: `Qualified recurring revenue moved from ${prev.pace} to ${next.pace} against the straight line to the target date. Details: bun LIFEOS/TOOLS/RevenueWatch.ts --print` });
  return out;
}

function loadKey(env: string): string | null {
  if (process.env[env]) return process.env[env]!;
  const p = join(getClaudeDir(), ".env");
  if (!existsSync(p)) return null;
  const m = readFileSync(p, "utf8").match(new RegExp(`^${env}=(.+)$`, "m"));
  return m ? m[1]!.trim().replace(/^["']|["']$/g, "") : null;
}

export function liveGet(cfg: Config): Get {
  const keys = new Map(cfg.accounts.map((a) => [a.name, loadKey(a.env)]));
  return async (account, path, params = {}) => {
    const key = keys.get(account);
    if (!key) throw new Error(`no key for account ${account}`);
    const res = await fetch(`https://api.stripe.com/v1/${path}?${new URLSearchParams(params)}`, { method: "GET", headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`stripe ${res.status} on ${path}`);
    return res.json();
  };
}

export async function run(opts: { get?: Get; now?: Date; write?: boolean; emitFn?: (e: ReturnType<typeof changes>[number], now: Date) => void | Promise<void> } = {}): Promise<{ snapshot: Snapshot; events: number }> {
  const now = opts.now ?? new Date();
  const cfg = JSON.parse(readFileSync(configPath(), "utf8")) as Config;
  const prev = existsSync(snapshotPath()) ? (JSON.parse(readFileSync(snapshotPath(), "utf8")) as Snapshot) : null;
  const pulled = await pull(opts.get ?? liveGet(cfg), cfg, now);
  // A partial read would look like lost revenue and flip pace; keep the last good snapshot instead.
  const unread = Object.entries(pulled.accounts).filter(([, s]) => s.startsWith("subscriptions unreadable"));
  if (unread.length) throw new Error(`subscriptions unreadable for ${unread.map(([a]) => a).join(", ")}`);
  const snap = compute(pulled, cfg, prev, now);
  invariant(Number.isFinite(snap.qualified_mrr_usd) && snap.qualified_mrr_usd >= 0, "qualified MRR is a finite non-negative number");
  invariant(snap.gap_usd >= 0 && snap.gap_usd <= cfg.target.mrr_usd, "gap is between zero and the target");
  if (opts.write === false) return { snapshot: snap, events: 0 };
  const evs = changes(prev, snap);
  if (evs.some((e) => e.ref === "pace")) snap.last_pace_event = now.toISOString();
  const out = snapshotPath();
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(`${out}.tmp`, JSON.stringify(snap, null, 2) + "\n");
  renameSync(`${out}.tmp`, out);
  const emitFn = opts.emitFn ?? (async (e, n) => {
    emitVigilEvent(vigilEvent("revenue", e.ref, e.state, e.severity, e.title, e.summary, "money", null, n.toISOString().slice(0, 10)));
  });
  for (const e of evs) await emitFn(e, now);
  return { snapshot: snap, events: evs.length };
}

if (import.meta.main) {
  const print = process.argv.includes("--print");
  run({ write: !print }).then(({ snapshot: s, events }) => {
    if (process.argv.includes("--json")) { console.log(JSON.stringify({ ok: true, events, ...s }, null, 2)); return; }
    const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
    console.log(`Qualified MRR ${usd(s.qualified_mrr_usd)} real (${usd(s.list_qualified_mrr_usd)} at list) of ${usd(s.target.mrr_usd)} by ${s.target.by} — ${s.pace}`);
    console.log(`Gap ${usd(s.gap_usd)} · ${s.months_left} months left · needs ${usd(s.needed_monthly_growth_usd)}/month`);
    for (const [l, v] of Object.entries(s.lines)) console.log(`  ${l.padEnd(11)} ${v === "no source" ? "no source" : `${usd(v.mrr_usd)} real, ${usd(v.list_mrr_usd)} list (${v.subscriptions} subs)`}`);
    console.log(`  unclassified ${usd(s.unclassified_mrr_usd)}: ${s.unclassified_products.map((u) => `${u.name} ${usd(u.mrr_usd)}`).join(", ") || "none"}`);
    console.log(`  excluded    ${usd(s.excluded_mrr_usd)}${s.items_skipped_no_price ? ` · ${s.items_skipped_no_price} items skipped (no usable price)` : ""}${s.items_skipped_non_usd ? ` · ${s.items_skipped_non_usd} items skipped (not USD)` : ""}${s.discounts_unreadable ? ` · ${s.discounts_unreadable} discounts unreadable` : ""}`);
    console.log(`Open now: ${s.failed_renewals} failed renewals (past-due or unpaid, all products)`);
    console.log(`Last 7 days: ${s.cancellations_7d} cancellations (all products) · ${s.disputes_7d} disputes`);
    for (const [a, st] of Object.entries(s.accounts)) if (st !== "ok") console.log(`  ${a}: ${st}`);
    if (!print) console.error(`${events} Vigil event(s)`);
  }, (e) => { console.error(`[RevenueWatch] FAILED (previous snapshot left in place): ${e instanceof Error ? e.message : e}`); process.exit(1); });
}
