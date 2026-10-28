---
provenance: template
version: 1.0.0
---

# Coffee Reference — your taste corpus

Ground truth for the coffee skill. It reads this file before recommending, discovering or logging a coffee, and never guesses from memory. Replace the example profile and rows with your own, by hand or by telling your assistant "log this coffee".

## Schema

Every entry carries a **Source** tag:

| Tag | Meaning |
|-----|---------|
| ⭐ | A confirmed favorite: you actually love it. |
| 👂 | A candidate: recommended, or fits the profile, not yet confirmed. |

Fields: **Roaster · Coffee · Roast · Profile** (flavor and feel) · **Source** · **Notes**. `Coffee` is `—` for a roaster-level entry.

## Taste Profile

In your own words: (example) *bright and juicy, tastes like fruit tea, clean finish, nothing heavy or smoky.*

The screening rules, in priority order. Mark the ones that can never bend as **hard**.

- **Brew method (hard):** pour-over and espresso. No cold brew.
- **Roast (hard):** light to light-medium. Dark roasts are out.
- **Core flavors:** florals, citrus, red berries, black tea.
- **Body:** light to medium; clarity over weight.
- **Rejects (hard):** smoky, ashy or heavily roasty cups.

## Roasters

### Batch 1 — Starting roasters (captured 2026-01-01)

| # | Roaster | Coffee | Roast | Profile | Source | Notes |
|---|---------|--------|-------|---------|--------|-------|
| 1 | Example Roasters | — | Light | Clean, fruit-forward single origins | ⭐ | Local shop, rotating menu. |

## Coffees

### Batch 1 — First coffees (captured 2026-01-01)

| # | Roaster | Coffee | Roast | Profile | Source | Notes |
|---|---------|--------|-------|---------|--------|-------|
| 1 | Example Roasters | Lantern Washed | Light | Jasmine, lemon, black tea | ⭐ | Also called "the lantern one". |
| 2 | Acme Coffee Co. | Ridge Natural | Light-medium | Strawberry, cocoa nib | 👂 | A friend's pick. |

## Counts

- Coffees: 2 (⭐ 1, 👂 1)
- Roasters: 1 (⭐ 1, 👂 0)
