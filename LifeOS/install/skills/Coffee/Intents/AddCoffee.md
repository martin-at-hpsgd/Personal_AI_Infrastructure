# AddCoffee

Captures a new coffee or roaster into the taste corpus; this is how the skill grows.

## Ideal State

- The addition lands in the right section of the taste corpus named in Config.md: a specific coffee (roaster + blend/single-origin name) in the Coffees section, a roaster with no specific coffee in the Roasters section.
- The new row carries Roaster · Coffee · Roast · Profile (flavor/feel) · Notes exactly as the user gave them, with `TBD` for anything unknown, and matches the existing table format exactly, under the latest `### Batch N` or a new `### Batch N (captured YYYY-MM-DD)` when the existing batch is a different theme.
- The Source tag is ⭐ favorite only when the user says they love it / it's a favorite, and 👂 candidate for "someone recommended," "want to try," "fits my taste," or anything unconfirmed.
- An add that confirms an existing 👂 candidate (they now love a coffee already tagged 👂) flips that row's 👂 → ⭐ and dates it, and the corpus gains no duplicate row.
- The **## Counts** block at the bottom of the corpus reflects the change (total coffees / roasters, ⭐ vs 👂).
- The user is told exactly what was added or changed, in one or two lines.

## Anti-criteria

- Never invents tasting notes, roast level, or origin the user didn't state.
- Never tags ⭐ on an ambiguous add without asking once which it is: "Favorite (⭐) or one to try (👂)?"
- Never adds a second row for a coffee already in the corpus as a 👂 candidate.
