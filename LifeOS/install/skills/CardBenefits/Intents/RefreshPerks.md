# RefreshPerks

Verify current card perks/credits against issuer sources and update `~/.claude/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/CardBenefits/Cards.md`, plus the matching rows in `Credits.md`.

## Ideal State

- Every perk line in `Cards.md` for the refreshed card(s) carries a real amount, real terms, and `last-verified: <today>`.
- Every credit whose amount, cadence or action surface changed is updated in `Credits.md` too, with the same verified date, so the ledger CreditSweep reads matches `Cards.md`.
- UNVERIFIED markers are removed for whatever was confirmed.
- Anything that changed vs the old list is called out to the principal in the response.

## Anti-criteria

- A model-knowledge recall is not verification: if the web check didn't happen, the UNVERIFIED marker stays.
- Annual-fee amounts on the principal's actual accounts never come from marketing pages; they come from statements (grandfathered pricing exists).

## Inputs

- Sources: issuer benefit pages and reputable points sites (web research).
- A recent statement for the card, when the principal points at one, names the exact product variant and shows the annual fee actually charged. Record the product in the `Cards.md` inventory row.
