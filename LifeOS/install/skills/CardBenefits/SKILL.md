---
name: CardBenefits
metadata:
  short-description: "Track credit-card perks, annual credits, points and miles; pick the right card for a purchase and plan travel redemptions from your own card data."
version: 1.1.1
evals:
  manual:
    reason: "Benefit eligibility and balances are account-specific and a safe verifier cannot exercise a live card account from a fixture."
    falsifier: "A recommendation applies a benefit to the wrong card or period, misstates eligibility, or fails to identify the source account and calculation."
description: Tracks the principal's credit cards, their perks and annual credits, and points and miles balances across bank, airline and hotel programs, then turns them into which-card answers, unused-credit sweeps and points redemptions through transfer partners, all from the principal's own card data files. USE WHEN credit card benefits, card perks, which card should I use, annual credits, unused credits, expiring credits, my points, my miles, airline miles, hotel points, update my points balance, redeem points, transfer partners, plan a trip with points, refresh card perks. NOT FOR spending totals, expense tracking or bookkeeping, revenue or payments data, or moving money.
---

# CardBenefits

Single source of truth for the principal's credit cards, their perks and points balances, and the planning layer that turns points into trips.

## Ideal State

- Every perk, credit or balance in an answer comes from the USER data files read in that run, and anything stale (>90 days) or marked UNVERIFIED is flagged inline instead of stated as fact.
- Each recommendation names the card, program or credit, its dollar or points value, and the exact next step the principal takes.
- The data files stay the single source of truth: balances change only on the principal's report or a statement, perks only after a web-verified refresh, credit status only on confirmed usage.
- Money never moves from this skill: transfers, bookings and activations are planned here. Where a booking skill is installed, it carries out a plan only after the principal's yes on the itemized total; otherwise the principal executes.

## Intent Routing

| Intent | Trigger | File |
|----------|---------|------|
| **ShowBenefits** | "what perks do I have", "card benefits", "which card for X" | `Intents/ShowBenefits.md` |
| **UpdatePoints** | "I have N points", "update my points", "new balance" | `Intents/UpdatePoints.md` |
| **PlanRedemption** | "plan a trip with points", "use my points for", "what can N points get" | `Intents/PlanRedemption.md` |
| **RefreshPerks** | "refresh perks", "did the benefits change", "verify card benefits" | `Intents/RefreshPerks.md` |
| **CreditSweep** | "unused credits", "credits on the table", "expiring credits", "monthly credit check" | `Intents/CreditSweep.md` |

| File | Read when |
|------|-----------|
| `Setup.md` | first-time setup of the four data files, with an invented worked example of each and a proof command |

## Data & Config

This skill is procedure only. All personal financial data (card inventory, balances, credits, cross-card strategy, standing travel preferences) lives in the USER tree at `<configRoot>/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/CardBenefits/` and is read by path on every invocation (configRoot is `$CLAUDE_CONFIG_DIR` when set, else `~/.claude`). First-time setup, a worked example of each file and a proof command: [Setup.md](Setup.md). When `Cards.md` is missing, stop and point the principal at `Setup.md`; never answer perks from model memory.

**Data files:**
- `Cards.md` — card inventory (issuer, product variant, annual fee, points program) plus the full perk and credit list per card, each with a last-verified date
- `Points.md` — current points balances, redemption valuations, transfer partners, standing travel preferences (including the default travel party)
- `Playbook.md` — cross-card strategy: category→card matrix, stacking plays, lounge and status map, combined transfer matrix, sweet spots tied to current balances
- `Credits.md` — unified credit ledger and deadline calendar across all cards

Account numbers never go in these files. Reference an account by its label in `LIFEOS/USER/FINANCES/ACCOUNTS.md` when you keep one.

## Gotchas

- **Perk lists rot.** Issuers overhaul premium cards every few years: fee increases, new monthly or semiannual "coupon-book" credits, retired perks. That is why a perk whose `last-verified` in `Cards.md` is stale (>90 days) or marked `UNVERIFIED` gets RefreshPerks first or an inline flag.
- **Points balances are principal-reported, never scraped.** Issuers offer no API for consumer reward balances. If a balance in `Points.md` is old, say so and ask; a stale number is never presented as current.
- **Product variants share a name.** Two editions of one card (for example a business and a personal edition) can carry different perk sets, and statements and account nicknames may show only the short name. `Cards.md` records which product each card is, resolved from the issuer's dashboard or the product named on a statement; quote the perk set Cards.md names, never one inferred from a label.
- **Annual fees on a held card can differ from the marketing page.** Grandfathered pricing exists, so the fee charged comes from a statement.

## Examples

**Example 1: Vacation planning**
```
User: "We have 120K bank points — what could a trip to Lisbon look like?"
→ UpdatePoints (record the 120K balance on its program), then PlanRedemption
→ Reads Points.md valuations + transfer partners (airline and hotel partners reachable from that program)
→ Returns 2-3 concrete routings with points cost, cash equivalent, and next steps
```

**Example 2: Which card**
```
User: "Which card should I use for this flight?"
→ ShowBenefits
→ Compares the airfare earn rate and travel protections of each card in Cards.md (for example the Acme Sky Card earning more on airfare but carrying no trip insurance, against the Example Travel Card that includes it)
→ One-line answer with why
```

**Example 3: Credit sweep**
```
User: "What credits am I leaving on the table this year?"
→ CreditSweep
→ Reads `Credits.md`, flags unused/expiring/unregistered credits against today's date, dollars-at-risk up top
```
