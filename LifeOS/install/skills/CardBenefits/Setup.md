# CardBenefits

Status: test -f ~/.claude/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/CardBenefits/Cards.md && echo ok · optional

## What it does

This skill keeps your credit cards, their perks and annual credits, and your points and miles balances in four Markdown files you own. From those files it answers "which card should I use for this?", sweeps for credits you have not used before they expire, records new balances you report, refreshes perk lists against the issuers' own pages, and plans redemptions through transfer partners. It never logs into a bank, never moves money and never books anything itself; a separate booking skill, if you install one, can carry out a plan after your yes, and otherwise you execute every transfer and booking yourself.

## Fill in

Create the directory `~/.claude/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/CardBenefits/` with four files. A release ships starter copies with headers and one invented example row each; replace the examples with your own cards. Every value below is made up.

**`Cards.md`**: one inventory row per card, then one perk table per card. Every perk row carries a `last-verified` date; anything you have not confirmed against the issuer is marked `UNVERIFIED`.

```markdown
# Cards

## Inventory

| Card | Issuer | Product variant | Annual fee (USD) | Points program | Opened | Account label | last-verified |
|------|--------|-----------------|------------------|----------------|--------|---------------|---------------|
| Example Travel Card | Acme Bank | personal | 395 | Acme Points | 2021-03 | acme-travel | 2026-01-15 |

## Perks and credits by card

### Example Travel Card

| Perk / credit | Amount | Cadence | Terms | Activation surface | last-verified |
|---------------|--------|---------|-------|--------------------|---------------|
| Travel credit | $300 | annual | Any travel purchase, posts automatically | none | 2026-01-15 |
| Rideshare credit | $10 | monthly | Requires enrollment | Acme app > Benefits | UNVERIFIED |
```

**`Points.md`**: balances, valuation heuristics, transfer partners and standing preferences. Record your default travel party here; PlanRedemption plans for it unless you say otherwise.

```markdown
# Points

## Balances

| Program | Balance | As of | Source |
|---------|---------|-------|--------|
| Acme Points | 85,000 | 2026-01-15 | principal |

## Redemption valuations

| Program | Portal (¢/pt) | Transfer sweet spot (¢/pt) | Notes |
|---------|---------------|----------------------------|-------|
| Acme Points | 1.25 | 1.8 | Heuristic only |

## Transfer partners

| Program | Partner | Ratio | Transfer time | Notes |
|---------|---------|-------|---------------|-------|
| Acme Points | Example Air | 1:1 | instant | |

## Standing preferences

- Default travel party: 2 seats, 1 room.
```

**`Credits.md`**: every annual, semiannual and monthly credit from `Cards.md`, one row each, with a `status` you update as you use it (`unused`, `partial`, `used`, `needs-registration`, `expired`).

```markdown
| Card | Credit | Amount (USD) | Cadence | Resets / deadline | Registration required | status | Last used | Notes |
|------|--------|--------------|---------|-------------------|-----------------------|--------|-----------|-------|
| Example Travel Card | Rideshare credit | 10 | monthly | 1st of month | yes | needs-registration | | |
```

**`Playbook.md`**: your cross-card strategy. Start with the category matrix; the assistant can draft the rest from `Cards.md` when you ask.

```markdown
## Category → card matrix

| Spend category | Best card | Earn rate | Runner-up | Why |
|----------------|-----------|-----------|-----------|-----|
| Flights | Example Travel Card | 3x | none | Only card with trip-delay insurance |
```

Account numbers never go in these files. If you keep an accounts register at `LIFEOS/USER/FINANCES/ACCOUNTS.md`, put its label for the card in the `Account label` column.

## Accounts and secrets

None. Balances come from you or a statement you point at, and perk refreshes use the assistant's web research. No key in `~/.claude/.env` is needed.

## Prove it works

```bash
d=~/.claude/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/CardBenefits; for f in Cards Points Credits Playbook; do test -f "$d/$f.md" && echo "$f ok" || echo "$f MISSING"; done; grep -c 'last-verified' "$d/Cards.md"
```

Success: four `ok` lines, then a number of at least `2` (the inventory header and at least one perk table). Then ask the assistant: "Which of my cards should I use for a flight?" Success is a one-line answer naming a card from your `Cards.md` with the reason, and any perk older than 90 days or marked `UNVERIFIED` flagged inline.
