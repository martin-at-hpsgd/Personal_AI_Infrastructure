---
version: 1.0.0
---

# Finances

Status: `bun LIFEOS/TOOLS/SetupInventory.ts status` · optional

## What it does

Pulse's Finances page and any money question you ask your assistant read one folder, `LIFEOS/USER/FINANCES/`: an overview, income, expenses, investments, accounts, goals, taxes, bills, vendors and an expense ledger. You type the numbers in. Nothing here connects to a bank, and nothing leaves your machine.

If you sell something through Stripe, three tools add live revenue on top. RevenueWatch measures recurring revenue (MRR) against a target you set and reports the gap. StripeMrrSnapshot writes an MRR snapshot file. InvoiceWatch follows invoices you have sent until they are paid. All three only read from Stripe.

With nothing filled in, the page shows its empty state. The command-line tool that edits the expense ledger is not part of this release, so edit `expenses.json` by hand.

## Fill in

Every file below is already in `LIFEOS/USER/FINANCES/` as a sample. Replace each `$X`, `Sample Bank` and `Sample Vendor` with your own values and keep the headings and field names; Pulse matches on them.

| File | What goes in it |
|---|---|
| `FINANCES.md` | Net worth snapshot, monthly cash flow, current focus. Pulse reads this first. |
| `INCOME.md`, `EXPENSES.md`, `INVESTMENTS.md`, `GOALS.md`, `TAXES.md` | One topic each, in plain markdown. |
| `ACCOUNTS.md` | Bank, card and brokerage accounts. Last four digits only, never full numbers. |
| `obligations.yaml`, `vendors.yaml` | Recurring bills, and the names that appear on your statements. |
| `expenses.json` | The expense ledger. The `meta.note` field in the file describes each line (vendor, cycle, amount, status). Delete the one cancelled example line once you have real ones. |

### Revenue target (Stripe only)

`LIFEOS/USER/CONFIG/revenue-lines.json` ships empty and valid, so the tool runs and reports zero. To use it, fill in:

| Field | Meaning |
|---|---|
| `target.mrr_usd`, `target.by` | The MRR you want and the date (`YYYY-MM-DD`) you want it by. |
| `qualified_lines` | Names of the revenue lines that count toward the target. |
| `sourceless_lines` | Lines you earn outside Stripe. They report `no source` instead of zero. |
| `accounts` | One row per Stripe account: `{ "name": "main", "env": "STRIPE_SECRET_KEY" }`, where `env` is the name of the key in `~/.claude/.env`. |
| `rules` | How a Stripe product lands in a line. Each rule has a `line` and one or more of `product`, `account`, `metadata_source`. The first rule that matches wins. |

Anything no rule matches is reported as unclassified, so you can see what is left to sort.

### Satellite row (optional)

`LIFEOS/USER/CONFIG/sats.json` is `{ "url": "" }`. It belongs to the status line's satellite-pass row and has nothing to do with money; it sits in this system's file list by accident. It needs a small Worker that is not part of this release, so leave the URL empty and the row stays off.

## Accounts and secrets

Only Stripe needs a key. Create a restricted key in the Stripe dashboard with read access, and put it in `~/.claude/.env` as `STRIPE_SECRET_KEY`. For a second Stripe account, use another name and point that account's `env` field at it. Check a key is present without printing it:

```bash
bun LIFEOS/TOOLS/Secrets.ts has STRIPE_SECRET_KEY
```

If you keep sealed secrets, run `bun LIFEOS/TOOLS/Secrets.ts seal` after editing `.env`. No bank login, card number or account number belongs in any of these files.

## Prove it works

Pulse reads the folder through one endpoint. With Pulse running, this should print `200`:

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:31337/api/life/finances
```

Then open the Finances page in Pulse and check that your overview numbers show, not the `$X` samples.

If you set up Stripe, pull the revenue figures. `--print` shows them and writes nothing:

```bash
bun LIFEOS/TOOLS/RevenueWatch.ts --print
```

With the shipped empty config it prints one summary line with zeroes and exits 0, which proves the file loads. With a Stripe account configured, a working key shows real totals. A missing or bad key exits 1 and names the account.

For the whole-install view, run `bun LIFEOS/TOOLS/SetupInventory.ts status`. Finances reads `optional-off` while `FINANCES.md` is still the shipped sample and `ready` once you have edited it.

The statement analyzer panel on the Finances page needs a personal tool that is not part of this release; Pulse hides the panel when it is absent.
