#!/usr/bin/env bun
/**
 * @version 1.1.0
 */
// Tracks invoices we send until they are paid, so the principal hears when money lands and is
// reminded when it has not.
//
//   InvoiceWatch.ts add <in_…> --follow-up YYYY-MM-DD [--note "<text>"] [--account <alias>]
//   InvoiceWatch.ts list [--json]
//   InvoiceWatch.ts gate        # agent-job preScript: findings lines, then {"wakeAgent": bool}
//
// Ledger: {lifeosUserDir}/FINANCES/invoices-out.json. Status is read live from Stripe on every gate
// run; the ledger only remembers what the principal has already been told, so each event is said once:
// paid (once), the follow-up date (once), then a weekly nudge while the invoice stays open past due.
// --account is an alias from the skill's Config.md: the Accounts table's Env var column names its key; with no
// table row, omitted or "main" is STRIPE_SECRET_KEY and any other alias is STRIPE_SECRET_KEY_<ALIAS> (upper-cased).
// StripeAccounts.ts holds the rule, shared with StripeRead.ts.
// Stripe keys come from the environment (the job runner loads ~/.claude/.env; by hand use --env-file).

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { invariant } from "./Invariant";
import { lifeosUserDir } from "./LifeosConfig";
import { resolveStripeKeyName } from "./StripeAccounts";

export type Tracked = {
  id: string;
  number: string;
  account: string; // "main" or an alias from Config.md
  customer: string;
  contact: string;
  amount: number; // cents
  currency: string;
  issued: string; // YYYY-MM-DD
  due: string | null;
  followUp: string;
  note?: string;
  status: string; // last seen Stripe status
  told: { paid?: string; followUp?: string; lastNudge?: string };
};

const LEDGER = join(lifeosUserDir(), "FINANCES", "invoices-out.json");
const WEEK_DAYS = 7;

const day = (d: Date) => d.toISOString().slice(0, 10);
const money = (t: Pick<Tracked, "amount" | "currency">) =>
  `${t.currency.toUpperCase()} ${(t.amount / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);

export function readLedger(path = LEDGER): Tracked[] {
  if (!existsSync(path)) return [];
  return JSON.parse(readFileSync(path, "utf8")) as Tracked[];
}

export function writeLedger(rows: Tracked[], path = LEDGER): void {
  const ids = new Set<string>();
  for (const r of rows) {
    invariant(/^in_[A-Za-z0-9]+$/.test(r.id), `bad invoice id ${r.id}`);
    invariant(!ids.has(r.id), `duplicate invoice ${r.id}`);
    invariant(Number.isInteger(r.amount) && r.amount > 0, `bad amount on ${r.id}`);
    invariant(/^\d{4}-\d{2}-\d{2}$/.test(r.followUp), `bad follow-up date on ${r.id}`);
    ids.add(r.id);
  }
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(rows, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, path);
}

/** Env key name for an account alias: the Config.md Accounts table first, else "main" is STRIPE_SECRET_KEY and any other alias is STRIPE_SECRET_KEY_<ALIAS>. */
export function stripeKeyName(account: string): string {
  return resolveStripeKeyName(account);
}

function stripeKey(account: string): string {
  const name = stripeKeyName(account);
  const k = process.env[name];
  if (!k) throw new Error(`${name} (account "${account}") is not in the environment (run with --env-file ~/.claude/.env)`);
  return k;
}

async function fetchInvoice(id: string, account: string): Promise<any> {
  const r = await fetch(`https://api.stripe.com/v1/invoices/${encodeURIComponent(id)}?expand[]=customer`, {
    headers: { Authorization: `Bearer ${stripeKey(account)}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!r.ok) throw new Error(`Stripe ${r.status} for ${id}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

/** Pure decision: what, if anything, to tell the principal about one invoice today. */
export function decide(t: Tracked, status: string, today: string): { message: string; mark: Partial<Tracked["told"]> } | null {
  if (status === "paid") {
    if (t.told.paid) return null;
    return { message: `PAID: ${t.customer} paid invoice ${t.number} (${money(t)}).`, mark: { paid: today } };
  }
  if (status === "void" || status === "uncollectible") return null;
  if (today >= t.followUp && !t.told.followUp) {
    const due = t.due ? `, due ${t.due}` : "";
    return { message: `FOLLOW-UP: ${t.customer} has not paid invoice ${t.number} (${money(t)}${due}), sent to ${t.contact} on ${t.issued}. Draft a nudge for the principal to approve.`, mark: { followUp: today, lastNudge: today } };
  }
  if (t.due && today > t.due && t.told.followUp && (!t.told.lastNudge || daysBetween(t.told.lastNudge, today) >= WEEK_DAYS)) {
    return { message: `OVERDUE: invoice ${t.number} to ${t.customer} (${money(t)}) is ${daysBetween(t.due, today)} days past due and still open.`, mark: { lastNudge: today } };
  }
  return null;
}

async function add(argv: string[]): Promise<void> {
  const id = argv[0];
  const get = (f: string) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
  const followUp = get("--follow-up");
  const account = get("--account") ?? "main";
  if (!id || !followUp) throw new Error("usage: InvoiceWatch.ts add <in_…> --follow-up YYYY-MM-DD [--note text] [--account <alias>]");
  const inv = await fetchInvoice(id, account);
  const rows = readLedger().filter((r) => r.id !== id);
  rows.push({
    id, number: inv.number, account,
    customer: inv.customer?.name ?? inv.customer_name ?? "unknown",
    contact: inv.customer?.email ?? inv.customer_email ?? "",
    amount: inv.total, currency: inv.currency,
    issued: day(new Date((inv.status_transitions?.finalized_at ?? inv.created) * 1000)),
    due: inv.due_date ? day(new Date(inv.due_date * 1000)) : null,
    followUp, note: get("--note"), status: inv.status, told: {},
  });
  writeLedger(rows);
  console.log(`tracking ${inv.number} · ${inv.customer?.name} · ${money({ amount: inv.total, currency: inv.currency })} · ${inv.status} · follow up ${followUp}`);
}

async function gate(): Promise<void> {
  const rows = readLedger();
  const today = day(new Date());
  const findings: string[] = [];
  for (const t of rows) {
    if (t.told.paid) continue;
    let status: string;
    try { status = (await fetchInvoice(t.id, t.account)).status; }
    catch (e) { findings.push(`CHECK_FAILED: ${t.number}: ${String(e).slice(0, 160)}`); continue; }
    t.status = status;
    const d = decide(t, status, today);
    if (d) { findings.push(d.message); t.told = { ...t.told, ...d.mark }; }
  }
  if (rows.length) writeLedger(rows);
  for (const f of findings) console.log(f);
  console.log(JSON.stringify({ wakeAgent: findings.length > 0 }));
}

async function list(json: boolean): Promise<void> {
  const rows = readLedger();
  if (json) { console.log(JSON.stringify(rows, null, 2)); return; }
  if (!rows.length) { console.log("no tracked invoices"); return; }
  for (const t of rows) console.log(`${t.number.padEnd(16)} ${t.customer.padEnd(26)} ${money(t).padStart(14)}  ${t.status.padEnd(6)} due ${t.due ?? "-"}  follow-up ${t.followUp}${t.told.paid ? `  paid-told ${t.told.paid}` : ""}`);
}

if (import.meta.main) {
  const [cmd, ...rest] = process.argv.slice(2);
  try {
    if (cmd === "add") await add(rest);
    else if (cmd === "list") await list(rest.includes("--json"));
    else if (cmd === "gate") await gate();
    else { console.error("usage: InvoiceWatch.ts add|list|gate"); process.exit(2); }
  } catch (e) { console.error(String(e instanceof Error ? e.message : e)); process.exit(1); }
}
