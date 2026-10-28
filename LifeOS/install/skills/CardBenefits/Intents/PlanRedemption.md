# PlanRedemption

Turn a points balance into concrete trip (or other redemption) options.

## Ideal State

- 2-4 concrete options, each with: routing/hotel, points cost per program, cash-equivalent value (¢/point vs the heuristics in `~/.claude/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/CardBenefits/Points.md`), transfer path (which program → which partner), and the exact next step the principal would take to book.
- The options span at least two value tiers (a sweet-spot play and a simple portal play) so effort can be traded for value.
- `Points.md` was read first; if balances were UNKNOWN or stale, current numbers were asked for before planning (one question, `proceed` override accepted, then the plan is in "per 100K points" terms).
- Live award availability and transfer ratios were verified live (an installed booking skill's live search first, else web research through the Research skill) before any specific flight/hotel is presented as bookable.
- Every plan says points transfers are irreversible, next to the transfer step.
- Any durable preference learned (region, cabin, hotel taste) is recorded in `Points.md` § Standing preferences.

## Anti-criteria

- Nothing is transferred or booked from this intent. A booking goes to the installed booking skill, which acts only on the principal's yes; with none installed, the principal books.
- Never presents a specific flight/hotel as bookable from the tables in `Points.md` alone; they are heuristics, not fact.

## Inputs

- Default party: the standing travel party recorded in `Points.md` § Standing preferences (seats and rooms) unless the request says otherwise. When none is recorded, ask once and record the answer there.
