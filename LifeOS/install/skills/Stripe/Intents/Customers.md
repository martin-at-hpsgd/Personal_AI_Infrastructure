# Customers

Query Stripe customer data: the total customer count, the recent customer list, and search by email or name.

## Ideal State

- The answer states the total customer count, counted over every page of the customer list (paginated 100 at a time until `has_more` is false), not just the first page.
- The recent customer list shows each customer's name (falling back to email, then ID), email, and creation date.
- A search by email or name returns each matching customer's name, email and customer ID.

## Anti-criteria

- Never hardcodes a Stripe API key: the key is loaded from `~/.claude/.env` through `bun --env-file`, and the env var matches the account meant.

## Tool contract

One customer by email is the read-only CLI: `bun ~/.claude/LIFEOS/TOOLS/StripeRead.ts customer <email>`. The full count and recent list need every page, which the CLI can't express, so they run as this body inside the SKILL.md § Tool contract preamble:

```js
// Count all customers
const customers = await fetchAll(p => stripe.customers.list(p));
console.log('Total customers:', customers.length);

// Recent customers
const recent = customers.slice(0, 10);
console.log('\n=== Recent Customers ===');
for (const c of recent) {
  const created = new Date(c.created * 1000).toLocaleDateString();
  console.log(\`\${c.name || c.email || c.id} | \${c.email || 'no email'} | Created: \${created}\`);
}
```

### Search Customers

Search by name or a partial email, as a body inside the same preamble:

```js
const result = await stripe.customers.search({ query: 'email:\"SEARCH_TERM\"' });
for (const c of result.data) {
  console.log(\`\${c.name || 'N/A'} | \${c.email} | \${c.id}\`);
}
```

Replace `SEARCH_TERM` with the email to search for; for a name, the query field is `name:` instead of `email:`.
