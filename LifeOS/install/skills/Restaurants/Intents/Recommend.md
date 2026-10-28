# Recommend

A pick of where to eat or what to order, grounded in the household's actual tastes.

## Ideal State

- Every time, the recommendation is consistent with the full Preferences data file as it stands for this request, not just the headlines in SKILL.md: no pick or why-it-fits line contradicts anything in the file's body.
- The pick reflects the location, occasion, and cuisine the request gives. When the request names no place, the place is the principal's current location from the install's location service (here `bun LIFEOS/LOCATION/Location.ts now --json`), home only when that fix is stale or missing, and the answer says which it used; a current location with no favorite in the file follows the travel rule below. When a key constraint that would change the answer is missing, the answer carries the one-line assumption flag and still gives the best pick.
- The taste rules apply in the priority order the Preferences file states: its top cuisine when cuisine is open, then its heat and flavor rules, its dealbreakers screened out, its ranked cuisines in order when the first doesn't fit, then the occasion and location given.
- Heat follows the file: where it says spicy is a plus, the pick leans into heat and is never hedged to mild; where it says mild, the reverse.
- Options that hit a dealbreaker named in the file are rejected regardless of cuisine.
- When the request names a city that has a favorite in the Preferences file, that favorite is surfaced first.
- If the file has an optional Companion Restrictions section and the request names a companion listed there, the pick comes only from that list.
- For travel, or any city with no favorite in the Preferences file, the candidate restaurants and their current facts (whether it is open, its days and hours, and how to book) came from the Research skill in Quick mode, with the taste rules and the neighborhood they're staying in named in the brief, and every place in the answer is one the Research result grounds.
- The answer gives a clear pick, or 2-3 ranked options if genuinely close, each with one line of why it fits their taste tied back to the rules, and a place not in the Preferences data file is labelled a new suggestion, not a known favorite.

## Anti-criteria

- Raw WebSearch is never the look-up for travel candidates or their current facts.
- Never fabricates specifics about a place that cannot be grounded.
- Never stalls on a missing constraint instead of giving the best pick and letting them redirect.

## Output format

The missing-constraint flag is exactly one line: `⚠️ Assuming <X>; tell me the city/occasion if that's wrong.`

Each option's why-it-fits line ties back to the rules ("your top cuisine at the heat level you like").

## Inputs

Read `LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Restaurants/Preferences.md`, the whole file. When it is missing, say so, point the user at `skills/Restaurants/Setup.md`, and stop; recommend nothing from a default profile.

## Tool contract

Travel candidates and their current facts come from `Skill("Research")` in Quick mode, with the brief described in Ideal State. Raw WebSearch is not the look-up: its single summary can be stale or wrong.
