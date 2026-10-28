# Stripe

**Contents:** What it does · Fill in · Accounts and secrets · Prove it works

Status: `bun LIFEOS/TOOLS/StripeRead.ts balance` · optional

## What it does

Runs Stripe billing work from the terminal: lists products and prices, counts subscribers, calculates MRR and revenue trends, looks up customers and payments, and, only after you approve each one, creates products, prices, coupons, invoices and payment links, refunds charges and cancels subscriptions. Reads go through a read-only command (`StripeRead.ts`) that has no write path. Writes use the official `stripe` npm package. It works with one Stripe account or several, each chosen by an alias. Invoices you send by hand can be tracked until paid with `InvoiceWatch.ts`. If you run an admin dashboard that caches Stripe data, the skill can read it for fast overview answers; this is optional.

## Fill in

One file: `LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Stripe/Config.md`. The skill stops and points here when it is missing or `STRIPE_SDK_DIR` is unset.

Smallest working example:

```markdown
# Stripe — Config

## SDK

- `STRIPE_SDK_DIR`: ~/Tools/stripe-sdk
- `STRIPE_API_VERSION`: 2026-02-25.clover
- `TIMEZONE`: America/New_York

## Accounts

| Alias | Env var | Key type | Role |
|---|---|---|---|
| (main) | `STRIPE_SECRET_KEY` | sk_live | Default account |
| shop | `STRIPE_SECRET_KEY_SHOP` | rk_live (restricted) | Optional second account |
| test | `STRIPE_SECRET_KEY_TEST` | sk_test | Optional test mode of the main account |

## Products

| Product | Account | Domain | Product ID | Price ID env vars | Amounts |
|---|---|---|---|---|---|
| Example Pro | (main) | example.com | prod_0000000000000000 | `EXAMPLEPRO_PRICE_ID_1` | $10/mo |
```

| Field | Meaning |
|-------|---------|
| `STRIPE_SDK_DIR` | A folder where the `stripe` package is installed. Create it with `mkdir -p ~/Tools/stripe-sdk && cd ~/Tools/stripe-sdk && bun add stripe`. The skill reads it from this file; you do not export it |
| `STRIPE_API_VERSION` | The Stripe API version every SDK call passes. Use the version your installed `stripe` package was built for (Stripe's changelog lists it per release) |
| `TIMEZONE` | Time zone for day boundaries in daily revenue and attribution reports |
| Alias | The name you pass as `--account <alias>` to `StripeRead.ts` and `InvoiceWatch.ts`. The main account has no alias |
| Env var | `STRIPE_SECRET_KEY` for the main account, `STRIPE_SECRET_KEY_<ALIAS in capitals>` for every other one |
| Products table | Every product you may ask about, retired ones included, so history attributes correctly |

Optional sections in the same file, worked examples:

```markdown
## Invoicing practice

- Line wording: the words the client's accounts-payable team uses, for example "Consulting, March engagement".
- Cover email goes from the business mailbox with a copy to me.
- Follow-up date: seven days after sending.

## Admin dashboard

- `ADMIN_DASHBOARD_URL`: https://admin.example.com
- `ADMIN_DASHBOARD_SOURCE`: ~/Projects/your-admin-dashboard
- Cached endpoints: `/api/stripe/overview` (customers, active subscriptions, MRR), `/api/stripe/revenue` (12 months)
```

`## Invoicing practice` holds your own conventions for invoices you send by hand; the Manage intent follows it. `## Admin dashboard` points overview questions at a dashboard of yours that caches Stripe endpoints; without it every answer comes from the SDK.

To hear when a hand-sent invoice is paid, reaches its follow-up date or sits overdue, run `InvoiceWatch.ts gate` as a daily Workflow. `gate` prints one line per piece of news, then `{"wakeAgent": true|false}`, and records each piece as told, so the step that runs it must pass the lines on. Worked example, saved as `LIFEOS/USER/WORKFLOWS/invoice-watch.workflow.yaml`; it hands the news to Vigil as one text:

```yaml
version: 2
name: invoice-watch
description: "Tell me when a hand-sent invoice is paid, reaches its follow-up date, or sits overdue."
runs_on: local
triggers:
  - type: schedule
    cron: "0 9 * * *"
    timezone: America/New_York
  - type: manual
steps:
  run:
    kind: command
    side_effects: [ read, write, outbound ]
    recipient: principal
    description: "Check every tracked invoice in Stripe and hand any news to Vigil as one text."
    argv:
      - sh
      - -c
      - |
        out=$(bun --env-file "$HOME/.claude/.env" "$HOME/.claude/LIFEOS/TOOLS/InvoiceWatch.ts" gate) || exit 1
        f=$(mktemp); trap 'rm -f "$f"' EXIT
        printf '%s\n' "$out" | grep -v '"wakeAgent"' > "$f" || true
        if [ -s "$f" ]; then
          bun "$HOME/.claude/LIFEOS/VIGIL/Vigil.ts" emit --text-file "$f" --source invoice-watch --class decision
        else
          echo "nothing new"
        fi
    timeout_ms: 120000
```

Validate it with `bun ~/.claude/LIFEOS/WORKFLOWS/workflow.ts validate invoice-watch` (it prints `valid: invoice-watch`), then install it with `bun ~/.claude/LIFEOS/WORKFLOWS/engine/schedule-install.ts install invoice-watch`. On a day with news the run prints `{"event_id": …, "class": "decision", …, "outcome": "queued", …}` and Vigil texts you on its next tick; a quiet day prints `nothing new`. If you do not run Vigil, replace the `emit` line with your own notifier that reads the file. `gate` marks news as told before this step hands it on, so a failed hand-off fails the run (see `bun ~/.claude/LIFEOS/WORKFLOWS/workflow.ts runs invoice-watch`) and that piece of news is not repeated.

## Accounts and secrets

- A Stripe account. In the Dashboard open Developers, then API keys, and create a secret key (`sk_live_...`) or a restricted key (`rk_live_...`) with the scopes you want. A restricted key with read scopes only is the safe choice for a second account.
- Env keys for `~/.claude/.env` (names only, values from the Dashboard): `STRIPE_SECRET_KEY` for the main account and `STRIPE_SECRET_KEY_<ALIAS>` for each additional one. A test-mode key (`sk_test_...`) is one more account: give it its own row with an alias such as `test` (`STRIPE_SECRET_KEY_TEST`, used as `--account test`), or `shop_test` for a second account's test mode.
- Price IDs, if your workflows need them, are stored as env vars with the names listed in your Products table. Copy them from Dashboard, Product catalog, Pricing.

## Prove it works

Run these from `~/.claude`. Every command below reads only; `StripeRead.ts` has no write path.

1. `bun LIFEOS/TOOLS/StripeRead.ts balance` prints your account balance as JSON, starting with `"object": "balance"`. For an additional account add `--account shop`. A missing key prints `[StripeRead] STRIPE_SECRET_KEY_SHOP not found` and exits 1.
2. `bun LIFEOS/TOOLS/StripeRead.ts products` lists your active products; check each one appears in your Config.md Products table.
3. `bun LIFEOS/TOOLS/InvoiceWatch.ts list` prints the invoices you have registered for tracking, or `no tracked invoices` on a fresh install.
4. `ls ~/Tools/stripe-sdk/node_modules/stripe/package.json`, with the `STRIPE_SDK_DIR` folder from your Config.md in place of `~/Tools/stripe-sdk`, prints that path back and proves the SDK the write scripts import is installed.
