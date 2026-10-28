# Recommend

Suggests a coffee (a specific blend, roast, or what to order) grounded in the user's actual taste.

## Ideal State

- Every pick is screened against the full taste corpus named in Config.md, its Taste Profile rules and every row, never a summary of it.
- Every pick passes the Taste Profile rules in the priority order the profile gives, with each rule the profile marks as hard (a roast range, a rejected flavor, a brew method) screened out first.
- A confirmed ⭐ comes first when the user is buying from a roaster that has one or when the ask is open, then fitting 👂 candidates, then new suggestions.
- The reply gives a clear pick (or 2–3 ranked if genuinely close), each with one line of why it fits, tied back to the profile's rules.
- An open request still gets a recommendation from the corpus and the taste rules, saying so; when a key constraint (where they're buying, beans vs a drink, a "like X" reference) would change the answer and isn't given, the reply carries the one-line `⚠️ Assuming <X>` flag.
- A pick not in the corpus is called a new suggestion, not a known favorite; a relevant brew method points to the gear notes named in Config.md.
- The reply offers to log a pick they confirm they love via **AddCoffee** as ⭐, and untried new suggestions as 👂.

## Anti-criteria

- Never stalls the recommendation waiting for a missing constraint.
- Never fabricates tasting notes it can't ground for a coffee not in the corpus.
- Never recommends a coffee that breaks a hard rule in the Taste Profile, whatever its other merits.
- Never recommends a coffee the user cannot brew the way they brew (SKILL.md § Gotchas).

## Output format

The missing-constraint flag is one line: `⚠️ Assuming <X>; tell me where you're buying if that's wrong.` The why-it-fits line ties back to the profile's own terms ("<roast>, <core notes>, <acidity> — your lane").

## Inputs

What the request may constrain:

- **Where they're buying** — a roaster in the corpus, a cafe or grocery brand, an online roaster, or open.
- **Form** — beans to brew at home, or a drink to order.
- **A reference** — "like X" anchored to a coffee they named.
