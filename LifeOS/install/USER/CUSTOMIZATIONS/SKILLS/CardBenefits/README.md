---
provenance: template
version: 1.0.0
---

# CardBenefits data files

The `CardBenefits` skill is procedure only. Everything personal lives in this directory and is read by path on every invocation (`CardBenefits/SKILL.md` § Data & Config). Four files, all hand-owned by you, updated by the skill's intents as you confirm facts.

| File | What it holds | Who writes it |
|------|---------------|---------------|
| `Cards.md` | Card inventory plus the full perk/credit list per card, each perk with a `last-verified` date | You on setup; the **RefreshPerks** intent updates perks and dates |
| `Points.md` | Current points balances per program, redemption valuations, transfer partners, standing travel preferences | You report balances; the **UpdatePoints** intent overwrites the balance row (never appends) |
| `Playbook.md` | Cross-card strategy: which card for which spend category, stacking plays, lounge/status map, transfer matrix, sweet spots | You, with help from the skill when you ask for a strategy |
| `Credits.md` | Unified credit ledger and deadline calendar across every card, with a `status` column | The **CreditSweep** intent reads it and updates `status` as you confirm usage |

## Rules the skill enforces

- Perks older than 90 days on `last-verified`, or marked `UNVERIFIED`, are flagged inline rather than stated as fact.
- Balances come only from you or a statement you point at. The skill never estimates or carries a number forward.
- Account numbers never go in these files. They are owned by `LIFEOS/USER/FINANCES/ACCOUNTS.md`; reference an account by its label there.
- Transfer ratios and award sweet spots are planning heuristics. The skill verifies live pricing before you book.

## Getting started

1. Open `Cards.md` and add one section per card you hold. Pull perk lists from the issuer's benefits page and date every row.
2. Open `Points.md` and enter today's balance for each program from the issuer's app or site.
3. Copy every annual, semiannual, and monthly credit from `Cards.md` into `Credits.md` with its reset date.
4. Fill `Playbook.md` once you know your cards; the skill can draft it from `Cards.md` if you ask.

The starter files ship with one invented example row each (an "Example Travel Card" from "Acme Bank"). Delete the examples once your own rows are in. Full walkthrough and a proof command: the skill's `Setup.md`.
