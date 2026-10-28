# Revenue

Query Stripe revenue data: current balance, MRR and ARR, and a monthly revenue breakdown.

## Ideal State

- The answer shows the current balance, both available and pending, per currency.
- MRR and ARR come from every active subscription (all pages), with each item normalized to a monthly amount by its interval (day, week, month or year), interval count and quantity and totalled separately for each currency, and both lines are labelled as active subscriptions only, since churned and canceled subscriptions are excluded from them, and as list price before discounts, since coupons and promotion codes on a subscription or its items are not subtracted. The count of active subscriptions carrying a discount appears beside them, so the size of the overstatement is visible.
- The last 3 months of revenue appear as four columns, gross, refunds/disputes, Stripe fees, and net (net = gross − refunds/disputes − fees), computed from every balance-transaction type in each month's window except balance movements that are not revenue (payouts, transfers, top-ups and anticipation repayments), so a payout to the bank never changes net. Each month shows one row per currency.

## Anti-criteria

- Never adds amounts in different currencies into one figure, and never prints a non-USD amount with a dollar sign: every total is kept and formatted in its own currency.
- Never sums only `type: 'charge'` balance transactions and labels the result net: that is net of fees only and silently ignores money returned to customers through refunds and disputes.
- Never adds payouts, transfers or top-ups into net: they move money between the Stripe balance and a bank, they are not revenue.
- Never presents the MRR or ARR line without saying it covers active subscriptions only and is list price before discounts.
- Never hardcodes a Stripe API key: the key is loaded from `~/.claude/.env` through `bun --env-file`, and the env var matches the account meant.

## Tool contract

The balance alone is the read-only CLI: `bun ~/.claude/LIFEOS/TOOLS/StripeRead.ts balance`. MRR and the monthly columns are computed, so the full report is this body inside the SKILL.md § Tool contract preamble:

```js
// Every amount is in the minor unit of its own currency, so totals are kept per
// currency and formatted in that currency; they are never added across currencies.
const money = (minor, cur) => {
  const nf = new Intl.NumberFormat('en-US', { style: 'currency', currency: cur.toUpperCase() });
  return nf.format(minor / 10 ** nf.resolvedOptions().maximumFractionDigits);
};
const add = (map, cur, key, v) => {
  const row = map.get(cur) ?? { mrr: 0, gross: 0, refundsDisputes: 0, fees: 0, net: 0 };
  row[key] += v;
  map.set(cur, row);
};

// Current balance
const balance = await stripe.balance.retrieve();
console.log('=== Current Balance ===');
for (const b of balance.available) {
  console.log(\`Available: \${money(b.amount, b.currency)}\`);
}
for (const b of balance.pending) {
  console.log(\`Pending: \${money(b.amount, b.currency)}\`);
}

// MRR from active subscriptions (paginated), per currency
const subs = await fetchAll(p => stripe.subscriptions.list(p), { status: 'active' });
const mrr = new Map();
const PER_MONTH = { day: 365 / 12, week: 52 / 12, month: 1, year: 1 / 12 };
let discounted = 0;
for (const sub of subs) {
  // List price only: subscription- and item-level discounts are counted, not subtracted.
  if ((sub.discounts?.length ?? 0) > 0 || sub.discount || sub.items.data.some(i => (i.discounts?.length ?? 0) > 0)) discounted++;
  for (const item of sub.items.data) {
    const amt = item.price.unit_amount || 0;
    const interval = item.price.recurring?.interval || 'month';
    const intervalCount = item.price.recurring?.interval_count || 1;
    const qty = item.quantity || 1;
    add(mrr, item.price.currency, 'mrr', (amt * qty * PER_MONTH[interval]) / intervalCount);
  }
}
for (const [cur, { mrr: m }] of mrr) {
  console.log(\`\nMRR \${cur.toUpperCase()} (active only, list price before discounts): \${money(Math.round(m), cur)}\`);
  console.log(\`ARR \${cur.toUpperCase()} (active only, list price before discounts): \${money(Math.round(m * 12), cur)}\`);
}
console.log(\`Active subscriptions: \${subs.length} (\${discounted} with a discount, overstated above)\`);

// Last 3 months revenue from balance transactions (paginated).
// Net = gross charges minus refunds/disputes minus Stripe fees.
const now = new Date();
console.log('\nMonth        Cur  Gross         Refunds/Disputes   Fees          Net');
for (let i = 2; i >= 0; i--) {
  const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
  const start = Math.floor(d.getTime() / 1000);
  const end = Math.floor(new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime() / 1000);
  const label = d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
  // No type filter → charges, refunds, disputes, adjustments and payouts all returned; payouts and transfers are skipped below.
  const txns = await fetchAll(p => stripe.balanceTransactions.list(p), { created: { gte: start, lt: end } });
  const byCur = new Map();
  for (const t of txns) {
    // Balance movements that are not revenue: skipped from every column.
    if (/^(payout|transfer|topup|anticipation)/.test(t.type)) continue;
    // amount, fee and net are all in the transaction's own balance currency.
    add(byCur, t.currency, 'fees', t.fee);
    add(byCur, t.currency, 'net', t.net);
    if (t.type === 'charge' || t.type === 'payment') add(byCur, t.currency, 'gross', t.amount);
    else if (t.type === 'refund' || t.type === 'payment_refund' || t.type === 'adjustment' || t.type.includes('dispute')) add(byCur, t.currency, 'refundsDisputes', t.amount);
  }
  if (byCur.size === 0) console.log(\`\${label.padEnd(12)} (no revenue transactions)\`);
  for (const [cur, r] of byCur) {
    const f = (c) => money(c, cur);
    console.log(\`\${label.padEnd(12)} \${cur.toUpperCase().padEnd(4)} \${f(r.gross).padEnd(13)} \${f(r.refundsDisputes).padEnd(18)} \${f(r.fees).padEnd(13)} \${f(r.net)}\`);
  }
}
```
