# Subscriptions

Query and display Stripe subscription data.

## Ideal State

- A summary table gives the total active, canceled and trialing subscription counts, each read over every page of the subscription list.
- Active subscriptions are broken down by product and plan tier, with the price per interval and the subscriber count per plan (item quantities summed), ordered by subscriber count.
- Each plan is labelled with its product name from the full product list, falling back to the product ID when no name is found.

## Anti-criteria

- Never drops canceled subscriptions from the summary counts.
- Never hardcodes a Stripe API key: the key is loaded from `~/.claude/.env` through `bun --env-file`, and the env var matches the account meant.

## Tool contract

The read-only CLI gives one status at a time (`StripeRead.ts subs --status active`, then `canceled`, then `trialing`), capped at 1,000 rows each. The plan breakdown with prices and names from the full product list is this body inside the SKILL.md § Tool contract preamble:

```js
const products = await fetchAll(p => stripe.products.list(p));
const productMap = new Map(products.map(p => [p.id, p.name]));

const [active, canceled, trialing] = await Promise.all([
  fetchAll(p => stripe.subscriptions.list(p), { status: 'active' }),
  fetchAll(p => stripe.subscriptions.list(p), { status: 'canceled' }),
  fetchAll(p => stripe.subscriptions.list(p), { status: 'trialing' }),
]);

console.log('=== Subscription Summary ===');
console.log('Active:', active.length);
console.log('Canceled:', canceled.length);
console.log('Trialing:', trialing.length);

// Breakdown by product/price
const breakdown = new Map();
for (const sub of active) {
  for (const item of sub.items.data) {
    const price = item.price;
    const prodId = typeof price.product === 'string' ? price.product : '';
    const key = price.id;
    if (!breakdown.has(key)) {
      breakdown.set(key, {
        product: productMap.get(prodId) || prodId,
        nickname: price.nickname || 'Default',
        interval: price.recurring?.interval || 'one-time',
        amount: (price.unit_amount || 0) / 100,
        count: 0,
      });
    }
    breakdown.get(key).count += item.quantity || 1;
  }
}

console.log('\n=== By Plan ===');
for (const [_, entry] of [...breakdown.entries()].sort((a, b) => b[1].count - a[1].count)) {
  console.log(\`\${entry.product} | \${entry.nickname} | \$\${entry.amount}/\${entry.interval} | \${entry.count} active\`);
}
```
