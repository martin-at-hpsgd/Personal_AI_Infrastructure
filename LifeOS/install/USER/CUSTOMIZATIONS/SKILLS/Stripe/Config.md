---
provenance: template
version: 1.0.0
---

# Stripe — Config

Account-specific facts the Stripe intents read at runtime. Secrets are env-var
NAMES only; the values live in `~/.claude/.env`. Never paste a key here.

## SDK

- `STRIPE_SDK_DIR`: ~/Tools/stripe-sdk — a directory where the `stripe` npm package (v20+) is installed. The skill reads it from here (no export needed) and runs its write scripts from that folder so the import resolves. Create it with `mkdir -p ~/Tools/stripe-sdk && cd ~/Tools/stripe-sdk && bun add stripe`.
- `STRIPE_API_VERSION`: 2026-02-25.clover — passed to every SDK call; match the version your installed `stripe` package was built for.
- `TIMEZONE`: America/New_York — day boundaries for daily revenue and attribution reports.

## Accounts

One row per Stripe account. The alias is what you pass as `--account <alias>`
to `StripeRead.ts` and `InvoiceWatch.ts`; the env var is always
`STRIPE_SECRET_KEY_<ALIAS in capitals>`, and the main account is the one with
no alias. Get keys from Stripe Dashboard → Developers → API keys. A restricted
key (`rk_live_*`) allows read scopes only unless you grant write scopes.

| Alias | Env var | Key type | Role |
|---|---|---|---|
| (main) | `STRIPE_SECRET_KEY` | sk_live | Default account for every intent |
| shop | `STRIPE_SECRET_KEY_SHOP` | rk_live (restricted, read scopes) | Optional second account; delete this row if you have one account |
| test | `STRIPE_SECRET_KEY_TEST` | sk_test | Optional test mode of the main account, used as `--account test` |

A test-mode key is one more row with its own alias: `test` for the main account,
`shop_test` (env `STRIPE_SECRET_KEY_SHOP_TEST`) for the second one.

## Products

Every product the workflows may be asked about. `prod_*` IDs come from
Dashboard → Product catalog; price IDs are stored as env vars (Dashboard →
Product → Pricing). The revenue intents need every product listed here,
including retired ones, so historical numbers attribute correctly.

| Product | Account | Domain | Product ID | Price ID env vars | Amounts |
|---|---|---|---|---|---|
| Example Pro | (main) | example.com | prod_0000000000000000 | `EXAMPLEPRO_PRICE_ID_1` | $10/mo |
| Example Workshop | shop | shop.example.com | prod_0000000000000001 | `EXAMPLEWORKSHOP_PRICE_ID_1` | $100 one-time |

## Invoicing practice (optional)

Your own conventions for invoices you send by hand. The Manage intent follows
whatever is written here; leave it empty to use the defaults.

- Line wording: describe the work in the words the client's accounts-payable team uses, for example "Consulting, March engagement".
- Cover email goes from your business mailbox with a copy to you.
- Follow-up date: seven days after sending.

## Admin dashboard (optional)

If you run an admin dashboard that caches Stripe endpoints
(`/api/stripe/overview`, `/products`, `/subscriptions`, `/revenue`, `/payments`),
point the workflows at it. Leave both blank to skip the cached path.

- `ADMIN_DASHBOARD_URL`: https://admin.example.com
- `ADMIN_DASHBOARD_SOURCE`: ~/Projects/your-admin-dashboard — local source checkout, for reading endpoint code
