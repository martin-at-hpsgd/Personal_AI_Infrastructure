#!/usr/bin/env bun
/**
 * @version 1.1.0
 * StripeRead.ts — read-only Stripe lookups as one bare command, so they run the same from a terminal and from an
 * unattended session. A checked-in GET-only tool is easier to allow than ad-hoc inline scripts that load secrets.
 *
 * Usage:
 *   bun ~/.claude/LIFEOS/TOOLS/StripeRead.ts promos [--all]            promotion codes with their coupon terms (active only unless --all)
 *   bun ~/.claude/LIFEOS/TOOLS/StripeRead.ts coupons
 *   bun ~/.claude/LIFEOS/TOOLS/StripeRead.ts products
 *   bun ~/.claude/LIFEOS/TOOLS/StripeRead.ts prices
 *   bun ~/.claude/LIFEOS/TOOLS/StripeRead.ts subs [--status active|all|…]
 *   bun ~/.claude/LIFEOS/TOOLS/StripeRead.ts customer <email>
 *   bun ~/.claude/LIFEOS/TOOLS/StripeRead.ts balance
 *   bun ~/.claude/LIFEOS/TOOLS/StripeRead.ts get <v1 path> [key=value …]   any other GET, e.g. get charges limit=10
 *   --account <name>      use the Env var the Stripe Config.md Accounts table lists for that alias, else STRIPE_SECRET_KEY_<NAME> (name upper-cased), instead of the main STRIPE_SECRET_KEY
 *
 * Every request is a GET; the tool has no write path. Output is JSON on stdout.
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { invariant } from "./Invariant";
import { getClaudeDir } from "./Paths";
import { resolveStripeKeyName } from "./StripeAccounts";

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const has = (name: string) => argv.includes(name);
const positional = argv.filter((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1].startsWith("--") && argv[i - 1] !== "--all"));

function loadKey(name: string): string {
  if (process.env[name]) return process.env[name]!;
  const envPath = join(getClaudeDir(), ".env");
  if (existsSync(envPath)) {
    const m = readFileSync(envPath, "utf-8").match(new RegExp(`^${name}=(.+)$`, "m"));
    if (m) return m[1].trim().replace(/^["']|["']$/g, "");
  }
  console.error(`[StripeRead] ${name} not found`);
  process.exit(1);
}

/** Env key for an account: the Stripe Config.md `## Accounts` table first, else no `--account` is STRIPE_SECRET_KEY and a name is STRIPE_SECRET_KEY_<NAME>. */
function stripeKeyName(account: string | undefined): string {
  try { return resolveStripeKeyName(account); } catch {
    console.error(`[StripeRead] --account needs a name of letters, digits and underscores (got "${account}")`);
    process.exit(1);
  }
}

const KEY = loadKey(stripeKeyName(flag("--account")));

async function get(path: string, params: Record<string, string> = {}): Promise<any> {
  invariant(/^[a-z_\/0-9A-Z-]+$/.test(path) && !path.includes(".."), `bad Stripe path: ${path}`);
  const url = `https://api.stripe.com/v1/${path.replace(/^\/+|^v1\//g, "")}?${new URLSearchParams(params)}`;
  const res = await fetch(url, { method: "GET", headers: { Authorization: `Bearer ${KEY}` }, signal: AbortSignal.timeout(30_000) });
  const body = await res.json();
  if (!res.ok) { console.error(`[StripeRead] ${res.status} ${body?.error?.message ?? ""}`); process.exit(1); }
  return body;
}

async function all(path: string, params: Record<string, string> = {}, cap = 1000): Promise<any[]> {
  const out: any[] = [];
  let after: string | undefined;
  while (out.length < cap) {
    const page = await get(path, { limit: "100", ...params, ...(after ? { starting_after: after } : {}) });
    out.push(...page.data);
    if (!page.has_more || !page.data.length) break;
    after = page.data[page.data.length - 1].id;
  }
  return out;
}

const couponTerms = (c: any) => c && {
  id: c.id, name: c.name, off: c.percent_off ? `${c.percent_off}%` : c.amount_off ? `${c.amount_off / 100} ${c.currency}` : null,
  duration: c.duration, months: c.duration_in_months ?? undefined, valid: c.valid, products: c.applies_to?.products,
};
const day = (t?: number | null) => (t ? new Date(t * 1000).toISOString().slice(0, 10) : undefined);

const cmd = positional[0];
let result: unknown;
switch (cmd) {
  case "promos": {
    const rows = await all("promotion_codes", { ...(has("--all") ? {} : { active: "true" }), "expand[]": "data.promotion.coupon" });
    const coupons = new Map<string, any>();
    result = [];
    for (const p of rows) {
      let c = p.coupon ?? p.promotion?.coupon;
      if (typeof c === "string") {
        if (!coupons.has(c)) coupons.set(c, await get(`coupons/${c}`).catch(() => null));
        c = coupons.get(c);
      }
      (result as any[]).push({ code: p.code, active: p.active, coupon: couponTerms(c), redeemed: p.times_redeemed, max: p.max_redemptions, expires: day(p.expires_at), firstTimeOnly: p.restrictions?.first_time_transaction || undefined });
    }
    break;
  }
  case "coupons": result = (await all("coupons")).map((c) => ({ ...couponTerms(c), redeemed: c.times_redeemed })); break;
  case "products": result = (await all("products", { active: "true" })).map((p) => ({ id: p.id, name: p.name, default_price: p.default_price })); break;
  case "prices": result = (await all("prices", { active: "true" })).map((p) => ({ id: p.id, product: p.product, amount: p.unit_amount / 100, currency: p.currency, interval: p.recurring?.interval })); break;
  case "subs": {
    const status = flag("--status") ?? "active";
    result = (await all("subscriptions", { status })).map((s) => ({ id: s.id, customer: s.customer, status: s.status, items: s.items.data.map((i: any) => ({ price: i.price?.id, product: i.price?.product, qty: i.quantity })) }));
    break;
  }
  case "customer": {
    invariant(positional[1], "customer needs an email");
    result = (await get("customers", { email: positional[1], limit: "10" })).data.map((c: any) => ({ id: c.id, email: c.email, name: c.name, created: day(c.created) }));
    break;
  }
  case "balance": result = await get("balance"); break;
  case "get": {
    invariant(positional[1], "get needs a v1 path, e.g. get charges limit=10");
    result = await get(positional[1], Object.fromEntries(positional.slice(2).map((kv) => kv.split("=", 2) as [string, string])));
    break;
  }
  default:
    console.error("usage: StripeRead.ts promos [--all] | coupons | products | prices | subs [--status s] | customer <email> | balance | get <path> [k=v…]  [--account <alias>]");
    process.exit(2);
}
console.log(JSON.stringify(result, null, 1));
