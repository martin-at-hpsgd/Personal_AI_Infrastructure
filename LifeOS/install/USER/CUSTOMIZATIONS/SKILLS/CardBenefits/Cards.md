---
provenance: template
version: 1.0.0
---

# Cards

Card inventory and the full perk/credit list per card. Read fresh by **ShowBenefits** on every question; refreshed by **RefreshPerks**. Every perk row carries `last-verified` (YYYY-MM-DD). Mark anything you have not confirmed against the issuer as `UNVERIFIED`. The skill treats `last-verified` older than 90 days as stale.

## Inventory

| Card | Issuer | Product variant | Annual fee (USD) | Points program | Opened | Account label (see FINANCES/ACCOUNTS.md) | last-verified |
|------|--------|-----------------|------------------|----------------|--------|------------------------------------------|---------------|
| Example Travel Card | Acme Bank | personal | 395 | Acme Points | 2021-03 | acme-travel | 2026-01-15 |

## Perks and credits by card

One `### <Card name>` section per card. Columns: perk or credit, amount, cadence (annual, semiannual, monthly, one-time), terms, where you activate or book it, and the date you last verified it.

### Example Travel Card

| Perk / credit | Amount | Cadence | Terms | Activation surface | last-verified |
|---------------|--------|---------|-------|--------------------|---------------|
| Travel credit | $300 | annual | Any travel purchase, posts automatically | none | 2026-01-15 |
| Rideshare credit | $10 | monthly | Requires enrollment | Acme app > Benefits | UNVERIFIED |

## Open questions

Questions about which product variant a card is go here until resolved.

- none yet
