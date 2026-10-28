# Manage

**Contents:** Ideal State · Anti-criteria · Safety gates · Tool contract

Write operations, and the lookups that come before them: promotion codes and coupons; create products, prices, invoices, refunds, coupons and payment links; change a price; cancel subscriptions.

## Ideal State

- The requested write took effect in Stripe and its result was reported back: the created object's ID with its name, amount or percent off, the canceled subscription's status, or the payment link URL.
- A cancellation takes effect when the user said: "at period end" leaves the subscription active with `cancel_at_period_end` set and reports the date access ends; an immediate cancel happens only when the user asked for one. The approval question names which of the two will run.
- A promotion-code or coupon lookup reads the account the user named and lists each code with its coupon terms (percent or amount off, duration), redemptions against any limit, expiry and the products it applies to, and says whether one fits the group or product asked about. It creates nothing.
- A price change leaves the product selling at the new amount: a new price on the same product, made the product's default, with the old price archived, and the report gives the new price ID and names every payment link or page outside Stripe, such as the website, that still shows the old amount.
- A created invoice is payable and belongs to the right organization: its hosted page reads the right amount and payee, and Stripe itself has emailed no one.
- The user has seen the invoice amount, the line text and the cover email before anything leaves.
- A sent invoice is registered with `InvoiceWatch.ts add` the moment its cover email is sent, so the invoice watcher tracks it.

## Anti-criteria

- Never ends a paid subscription immediately with `stripe.subscriptions.cancel` when the user asked for it to end at period end.
- Never calls `sendInvoice`: the hosted link goes out in a cover email the user approves, not from Stripe.
- Never edits a sent amount silently: an amount change after finalizing means void (`stripe.invoices.voidInvoice`) and re-create.
- Never picks the billing contact from a guess based on the org name alone, and never calls a number a quoted price when no price was looked up.

## Safety gates

All write operations require user confirmation via AskUserQuestion before execution. Present what will be done and get explicit approval.

**Invoicing a contact for a fee or expenses** (the user says "invoice X for Y"):
- Find the billing contact from the email thread and the user's contacts: the event organizer or the company's accounts-payable address, never a guess from the org name alone.
- Price from the real source document when one exists (a receipt, contract or booking confirmation). When asked for a different figure than was actually paid, estimate it, say it is an estimate, and keep it at or below the documented amount. The user may set the amount; their number wins.
- Word the line as what the counterparty asked to be billed for, so their accounts-payable team can pay it. Config.md § Invoicing practice holds the user's own conventions; follow them when present.
- Finalize, then open the hosted URL in a browser and confirm amount, payee and due date on the rendered page before drafting the email.
- Show the user the invoice line and the full cover email; send only on their go-ahead, from the mailbox they use for business, with a copy to them.
- The moment the cover email is sent, register the invoice for tracking: `bun --env-file ~/.claude/.env ~/.claude/LIFEOS/TOOLS/InvoiceWatch.ts add <in_…> --follow-up <send date + 7 days> --note "<what it is, who it went to>"`, adding `--account <alias>` for an additional account. A daily run of `InvoiceWatch.ts gate` then reports when it is paid, on the follow-up date if it is not, and weekly once it is past due. An invoice that is sent but not registered is not tracked by anything.

## Tool contract

Lookups use the read-only CLI and need no approval. Each write below is a body inside the SKILL.md § Tool contract preamble, with the key line set to the account meant.

### Promotion Codes and Coupons

```bash
bun ~/.claude/LIFEOS/TOOLS/StripeRead.ts promos [--all] [--account <alias>]   # codes with coupon terms; active only unless --all
bun ~/.claude/LIFEOS/TOOLS/StripeRead.ts coupons [--account <alias>]
```

### Create Product

```js
const product = await stripe.products.create({
  name: 'PRODUCT_NAME',
  description: 'DESCRIPTION',
});
console.log('Created:', product.id, product.name);
```

### Create Price

A one-time price omits `recurring`.

```js
const price = await stripe.prices.create({
  product: 'PRODUCT_ID',
  unit_amount: AMOUNT_IN_CENTS,
  currency: 'usd',
  recurring: { interval: 'month' },  // or 'year'
});
console.log('Created price:', price.id, '\$' + (price.unit_amount / 100) + '/' + price.recurring?.interval);
```

### Change a Price

Stripe prices cannot be edited. Create the new price as above, then:

```js
await stripe.products.update('PRODUCT_ID', { default_price: 'NEW_PRICE_ID' });
const old = await stripe.prices.update('OLD_PRICE_ID', { active: false });
console.log('Default now NEW_PRICE_ID; archived:', old.id, old.active);
```

Payment links still on the old price: `bun ~/.claude/LIFEOS/TOOLS/StripeRead.ts get payment_links active=true`, then `get payment_links/<plink_id>/line_items` for each.

### Cancel Subscription

At period end (the subscription stays active until then):

```js
const sub = await stripe.subscriptions.update('SUBSCRIPTION_ID', { cancel_at_period_end: true });
console.log('Cancels at period end:', sub.id, 'Status:', sub.status, 'Ends:', new Date((sub.cancel_at ?? sub.items.data[0]?.current_period_end) * 1000).toISOString().slice(0, 10));
```

Immediately, only when the user asked for it:

```js
const sub = await stripe.subscriptions.cancel('SUBSCRIPTION_ID');
console.log('Canceled:', sub.id, 'Status:', sub.status);
```

### Create Refund

```js
const refund = await stripe.refunds.create({ charge: 'CHARGE_ID' });
console.log('Refunded:', refund.id, '\$' + (refund.amount / 100));
```

### Create Coupon

```js
const coupon = await stripe.coupons.create({
  percent_off: PERCENT,
  duration: 'once',  // or 'repeating', 'forever'
  name: 'COUPON_NAME',
});
console.log('Created coupon:', coupon.id, coupon.percent_off + '% off');
```

### Create Invoice

Order: create the invoice, then attach the item with `invoice: <id>`. An item created first stays pending and the new invoice comes out $0, because current API versions exclude pending items by default. Finalize with `auto_advance: false`.

```js
const email = 'CONTACT_EMAIL';
const customer = (await stripe.customers.list({ email, limit: 1 })).data[0]
  ?? await stripe.customers.create({ name: 'ORG_NAME', email, metadata: { contact: 'CONTACT_NAME' } });
const invoice = await stripe.invoices.create({
  customer: customer.id, currency: 'usd', collection_method: 'send_invoice',
  days_until_due: 14, auto_advance: false, description: 'MEMO',
});
await stripe.invoiceItems.create({ customer: customer.id, invoice: invoice.id, currency: 'usd',
  amount: AMOUNT_IN_CENTS, description: 'LINE_DESCRIPTION' });
const fin = await stripe.invoices.finalizeInvoice(invoice.id, { auto_advance: false });
console.log(JSON.stringify({ id: fin.id, number: fin.number, status: fin.status, total: fin.total, livemode: fin.livemode, url: fin.hosted_invoice_url }));
```

### Create Payment Link

```js
const link = await stripe.paymentLinks.create({
  line_items: [{ price: 'PRICE_ID', quantity: 1 }],
});
console.log('Payment link:', link.url);
```
