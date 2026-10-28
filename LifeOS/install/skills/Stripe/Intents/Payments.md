# Payments

Query recent Stripe payments and charges.

## Ideal State

- The result is a table of recent successful payments, drawn from the latest 20 charges, with amount and currency, customer, date, and description for each.
- Each payment's customer name and email come from the Stripe customer, falling back to the charge's billing details, and a missing name shows as `Unknown`.

## Anti-criteria

- Never presents a charge whose status is not `succeeded` as a payment.
- Never hardcodes a Stripe API key: the key is loaded from `~/.claude/.env` through `bun --env-file`, and the env var matches the account meant.

## Tool contract

The read-only CLI reaches the same charges: `bun ~/.claude/LIFEOS/TOOLS/StripeRead.ts get charges limit=20`. The formatted table with expanded customers is this body inside the SKILL.md § Tool contract preamble:

```js
const charges = await stripe.charges.list({ limit: 20, expand: ['data.customer'] });
console.log('=== Recent Payments ===\n');
for (const c of charges.data) {
  if (c.status !== 'succeeded') continue;
  const customer = c.customer;
  const name = (typeof customer === 'object' && customer?.name) || c.billing_details?.name || 'Unknown';
  const email = (typeof customer === 'object' && customer?.email) || c.billing_details?.email || '';
  const date = new Date(c.created * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const amount = (c.amount / 100).toFixed(2);
  console.log(\`\$\${amount} \${c.currency.toUpperCase()} | \${name} (\${email}) | \${date} | \${c.description || ''}\`);
}
```
