#!/usr/bin/env bun
/**
 * @version 1.0.4
 * StripeMrrSnapshot.ts — pull live MRR from Stripe and write the local snapshot
 * that StateEvidence's money domain reads (StateEvidence itself is local-files-
 * only by design, so the network leg lives here).
 *
 * MRR = sum over ACTIVE subscriptions of item unit_amount × quantity,
 * normalized to monthly by the price's recurring interval. The account set by
 * STRIPE_SECRET_KEY is used; any other Stripe account is out of scope.
 *
 * Usage:
 *   bun ~/.claude/LIFEOS/TOOLS/StripeMrrSnapshot.ts          # pull + write snapshot
 *   bun ~/.claude/LIFEOS/TOOLS/StripeMrrSnapshot.ts --print  # pull + print, no write
 *
 * Output: LIFEOS/USER/FINANCES/stripe-mrr.json
 * Runs daily in the state-evidence workflow step, just before
 * InterviewDue --refresh, and on demand. Failure leaves the previous snapshot in place — StateEvidence
 * liveness marks it stale rather than mistaking it for a live signal.
 */

import { existsSync, readFileSync, writeFileSync, renameSync } from "fs";
import { join } from "path";
import { homedir } from "node:os";
import { invariant } from "./Invariant";
import { getClaudeDir, getLifeosDir } from "./Paths"; // public issue #1974 @sabo961, PR #1918 @PigLardLord

const HOME = process.env.HOME ?? homedir();
const LIFEOS_DIR = getLifeosDir();
const OUT = join(LIFEOS_DIR, "USER", "FINANCES", "stripe-mrr.json");
const PRINT_ONLY = process.argv.includes("--print");

function loadKey(): string {
  if (process.env.STRIPE_SECRET_KEY) return process.env.STRIPE_SECRET_KEY;
  const envPath = join(getClaudeDir(), ".env");
  if (existsSync(envPath)) {
    const m = readFileSync(envPath, "utf-8").match(/^STRIPE_SECRET_KEY=(.+)$/m);
    if (m) return m[1].trim().replace(/^["']|["']$/g, "");
  }
  console.error("[StripeMrrSnapshot] STRIPE_SECRET_KEY not found");
  process.exit(1);
}

const KEY = loadKey();

// Per-unit months for each Stripe recurring interval.
const INTERVAL_MONTHS: Record<string, number> = { month: 1, year: 12, week: 7 / 30.44, day: 1 / 30.44 };

interface SubItem {
  quantity?: number;
  price?: { unit_amount?: number | null; recurring?: { interval?: string; interval_count?: number } | null; currency?: string };
}
interface Sub { id: string; items: { data: SubItem[]; has_more?: boolean }; status: string }

async function listActiveSubs(): Promise<Sub[]> {
  const subs: Sub[] = [];
  let starting_after: string | undefined;
  for (;;) {
    const params = new URLSearchParams({ status: "active", limit: "100" });
    if (starting_after) params.set("starting_after", starting_after);
    const res = await fetch(`https://api.stripe.com/v1/subscriptions?${params}`, {
      headers: { Authorization: `Bearer ${KEY}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`stripe ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const page = (await res.json()) as { data: Sub[]; has_more: boolean };
    subs.push(...page.data);
    if (!page.has_more || page.data.length === 0) break;
    starting_after = page.data[page.data.length - 1].id;
  }
  return subs;
}

async function main(): Promise<void> {
  const subs = await listActiveSubs();
  let mrrCents = 0;
  let items = 0;
  let skipped = 0;
  let skippedCurrency = 0;
  for (const s of subs) {
    for (const it of s.items?.data ?? []) {
      const amt = it.price?.unit_amount;
      const rec = it.price?.recurring;
      const months = rec?.interval ? INTERVAL_MONTHS[rec.interval] * (rec.interval_count || 1) : null;
      if (typeof amt !== "number" || !months) { skipped++; continue; }
      // The snapshot is USD. Summing another currency's minor units as dollars would be a wrong number, so those
      // items are left out and counted, never converted by guess.
      if ((it.price?.currency ?? "usd").toLowerCase() !== "usd") { skippedCurrency++; continue; }
      mrrCents += (amt * (it.quantity ?? 1)) / months;
      items++;
    }
  }
  const mrr = Math.round(mrrCents) / 100;
  const snapshot = {
    updated: new Date().toISOString(),
    mrr_usd: mrr,
    active_subscriptions: subs.length,
    active_items: items,
    items_skipped_no_price: skipped,
    items_skipped_non_usd: skippedCurrency,
    source: "stripe REST /v1/subscriptions?status=active",
  };
  console.log(JSON.stringify(snapshot, null, 2));
  if (PRINT_ONLY) return;
  invariant(Number.isFinite(mrr) && mrr >= 0, "StripeMrrSnapshot: MRR must be a finite non-negative number");
  invariant(subs.length > 0 || items === 0, "StripeMrrSnapshot: item count without subscriptions is impossible");
  const tmp = OUT + ".tmp";
  writeFileSync(tmp, JSON.stringify(snapshot, null, 2) + "\n");
  renameSync(tmp, OUT);
  console.error(`[StripeMrrSnapshot] wrote ${OUT.replace(HOME, "~")}`);
}

main().catch((err) => {
  console.error(`[StripeMrrSnapshot] FAILED (previous snapshot left in place): ${err}`);
  process.exit(1);
});
