# CreditSweep

Surface every unused, unregistered, or expiring credit across all cards.

## Ideal State

- A short table from `~/.claude/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/CardBenefits/Credits.md` lists (1) credits expiring within 45 days, (2) unregistered perks (one-click activations), and (3) untouched credits with >50% of the year gone.
- Each credit in the table carries its dollar amount and the exact activation/booking surface.
- Total dollars-at-risk is stated up top.
- Cadenced credits (monthly/semiannual) are judged against today's date, not "this year."

## Anti-criteria

- Never infers usage from silence: the `status` column in `Credits.md` changes only as the principal confirms usage.
- Never counts a registration-required perk (for example a monthly Example Grocer delivery credit) as captured before it is registered; it counts as $0 captured and keeps being flagged.