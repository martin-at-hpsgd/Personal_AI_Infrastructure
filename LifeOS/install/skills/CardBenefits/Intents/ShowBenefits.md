# ShowBenefits

Answer perk/credit/which-card questions from the skill's data files.

## Ideal State

- The answer is grounded entirely in `~/.claude/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/CardBenefits/Cards.md`, read fresh this invocation, and scoped to what was asked (one card or one spend category).
- A "what am I leaving on the table" or unused-credits question routes to CreditSweep, which reads confirmed usage from `Credits.md`, the usage source of truth; any usage notes in Cards.md are point-in-time snapshots, never the current status.

## Anti-criteria

- Never answers perks from memory.
- Never states an UNVERIFIED or stale (>90 days) perk as fact.
