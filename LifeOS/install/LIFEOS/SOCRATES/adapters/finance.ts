import { PRIVATE_SKILL_NAMES } from "../../TOOLS/CodeDataBoundary.ts";
import { existsSync } from "node:fs";
/**
 * finance adapter — burn from the expenses ledger CLI, MRR from Stripe,
 * Accounting questions remain unknown when no accounting integration is configured.
 *
 * refs: burn | mrr | accounting books (legacy registry key)
 * No amounts are secrets, but no credential ever enters an answer; the Stripe
 * key is read from env at call time and never stored or logged.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import type { Adapter } from "./types";
import type { AnswerInput } from "../Store";
import type { Question } from "../Registry";

const VERSION = "finance/1.0.0";
const CLAUDE = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");

async function monthlyBurn(): Promise<{ burn: number; entries: number; pending: number } | null> {
  // The expenses tool is a private skill; on an install without it the question is
  // unanswerable by name, never a spawn of a missing path (7.52.0 in-family audit).
  const tool = join(CLAUDE, `skills/${PRIVATE_SKILL_NAMES.cfo}/Tools/Cfo.ts`);
  if (!existsSync(tool)) return null;
  const p = Bun.spawnSync(["bun", tool, "monthly", "--json"], {
    stdout: "pipe", stderr: "pipe",
  });
  if (p.exitCode !== 0) return null;
  try {
    const j = JSON.parse(p.stdout.toString());
    if (typeof j.known_total !== "number") return null;
    return { burn: j.known_total, entries: Number(j.known_count ?? 0), pending: Number(j.pending_count ?? 0) };
  } catch {
    return null;
  }
}

async function stripeMrr(): Promise<number | null> {
  const key = process.env.STRIPE_SECRET_KEY ?? process.env.STRIPE_API_KEY;
  if (!key) return null;
  // Sum active subscription items across pages (amount × quantity, monthly-normalized).
  let mrrCents = 0;
  let startingAfter: string | undefined;
  for (let page = 0; page < 10; page++) {
    const url = new URL("https://api.stripe.com/v1/subscriptions");
    url.searchParams.set("status", "active");
    url.searchParams.set("limit", "100");
    if (startingAfter) url.searchParams.set("starting_after", startingAfter);
    const r = await fetch(url, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) return null;
    const body = (await r.json()) as { data: Array<{ id: string; items: { data: Array<{ quantity: number; price: { unit_amount: number | null; recurring: { interval: string; interval_count: number } | null } }> } }>; has_more: boolean };
    for (const sub of body.data) {
      for (const item of sub.items.data) {
        const price = item.price;
        if (!price.recurring || price.unit_amount == null) continue;
        const perMonth =
          price.recurring.interval === "month" ? price.unit_amount / price.recurring.interval_count :
          price.recurring.interval === "year" ? price.unit_amount / (12 * price.recurring.interval_count) :
          price.recurring.interval === "week" ? (price.unit_amount * 52) / (12 * price.recurring.interval_count) : 0;
        mrrCents += perMonth * (item.quantity ?? 1);
      }
    }
    if (!body.has_more) break;
    startingAfter = body.data[body.data.length - 1]?.id;
  }
  return Math.round(mrrCents / 100);
}

export const finance: Adapter = {
  name: "finance",
  version: VERSION,

  async answers(questions: Question[]): Promise<AnswerInput[]> {
    const out: AnswerInput[] = [];
    for (const q of questions) {
      const ref = q.answerer?.ref ?? "burn";
      if (ref === "burn") {
        const b = await monthlyBurn();
        out.push({
          question_id: q.id,
          verdict: b === null ? "unknown" : q.expect?.lte !== undefined ? (b.burn <= q.expect.lte ? "pass" : "fail") : "pass",
          value: b?.burn ?? null,
          evidence: b === null ? "expenses CLI unavailable or unparseable" : `monthly burn from ${b.entries} priced entries (${b.pending} unpriced pending)`,
          computed_from: {
            // Nothing was read when the ledger CLI is absent (in-family audit, round 13, 7.52.0 cut).
            touched: b === null ? [] : ["expenses ledger (FINANCES/expenses.json via CLI)"],
            untouched: b && b.pending > 0
              ? [`${b.pending} unpriced ledger entries`, "bank statements (ledger is curated, not synced)", "accounting books"]
              : ["bank statements (ledger is curated, not synced)", "accounting books"],
          },
          closer_version: VERSION,
        });
      } else if (ref === "mrr") {
        const mrr = await stripeMrr();
        out.push({
          question_id: q.id,
          verdict: mrr === null ? "unknown" : q.expect?.gte !== undefined ? (mrr >= q.expect.gte ? "pass" : "fail") : "pass",
          value: mrr,
          evidence: mrr === null ? "Stripe key absent or API unreachable" : `active-subscription MRR (USD, monthly-normalized)`,
          computed_from: {
            touched: ["stripe:/v1/subscriptions (active)"],
            untouched: ["one-time product revenue", "advertising revenue", "accounting revenue"],
          },
          closer_version: VERSION,
        });
      } else if (ref === "\u0071bo-books") {
        out.push({
          question_id: q.id, verdict: "unknown",
          evidence: "No accounting integration configured on this install; accounting answers are unavailable",
          computed_from: { touched: [], untouched: ["accounting:P&L", "accounting:cashflow", "accounting:balance-sheet"] },
          closer_version: VERSION,
        });
      } else {
        out.push({
          question_id: q.id, verdict: "unknown", evidence: `unrecognized ref '${ref}'`,
          computed_from: { touched: [], untouched: ["finance"] }, closer_version: VERSION,
        });
      }
    }
    return out;
  },
};
