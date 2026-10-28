# List Products

List all Stripe products with prices and subscriber counts.

## Ideal State

- The result is a clean table showing each product, its status (active or inactive), its price tiers (amount per interval, or one-time), and its subscriber count.
- Subscriber counts come from every active subscription, read over all pages, summing each item's quantity into the product its price belongs to, so an item still billed on an archived price counts toward its product.
- A summary gives the total product count with the active count, and the number of active subscriptions.

## Anti-criteria

- Never lists a product that has neither subscribers nor recurring pricing.
- Never hardcodes a Stripe API key: the key is loaded from `~/.claude/.env` through `bun --env-file`, and the env var matches the account meant.

## Tool contract

The read-only CLI lists active products and prices (`StripeRead.ts products`, `StripeRead.ts prices`), but inactive products and the per-product subscriber join need this body inside the SKILL.md § Tool contract preamble:

```js
const [products, prices, subs] = await Promise.all([
  fetchAll(p => stripe.products.list(p)),
  fetchAll(p => stripe.prices.list(p), { active: true }),
  fetchAll(p => stripe.subscriptions.list(p), { status: 'active' }),
]);

// Count subscribers per product through each item's own price, not the active
// price list: an active subscription can still bill on an archived price.
const productCounts = new Map();
for (const sub of subs) {
  for (const item of sub.items.data) {
    const pid = typeof item.price.product === 'string' ? item.price.product : item.price.product.id;
    productCounts.set(pid, (productCounts.get(pid) || 0) + (item.quantity || 1));
  }
}

// Only show products with subscribers or recurring prices
for (const product of products) {
  const productPrices = prices.filter(p => p.product === product.id);
  const subCount = productCounts.get(product.id) || 0;
  const hasRecurring = productPrices.some(p => p.recurring);
  if (subCount === 0 && !hasRecurring) continue;

  console.log(\`\n\${product.active ? 'ACTIVE' : 'INACTIVE'} | \${product.name} (\${subCount} subscribers)\`);
  if (product.description) console.log(\`   \${product.description}\`);
  for (const p of productPrices) {
    const amt = (p.unit_amount || 0) / 100;
    console.log(\`   \$\${amt}/\${p.recurring?.interval || 'one-time'} \${p.nickname ? '(' + p.nickname + ')' : ''}\`);
  }
}

console.log(\`\n--- Summary ---\`);
console.log(\`Total products: \${products.length} (\${products.filter(p => p.active).length} active)\`);
console.log(\`Active subscriptions: \${subs.length}\`);
```
