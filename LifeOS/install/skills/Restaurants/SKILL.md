---
metadata:
  short-description: "Recommend dining from household food and restaurant preferences; maintain favorites."
name: Restaurants
evals:
  manual:
    reason: "restaurant recommendations depend on current constraints and the household's evolving preferences"
    falsifier: "the reviewer finds the recommendation conflicts with the requested location, meal context, or recorded dietary and taste preferences"
version: 1.1.3
description: The household's food and restaurant preferences, used to recommend where and what to eat. USE WHEN where should we eat, restaurant recommendation, what do we like to eat, our favorite restaurants, pick a place for dinner, date night dinner, find a spot for a cuisine, what beer do we like, food preferences, suggest a restaurant near X, best restaurants in <city>, where to eat on our trip, add a favorite restaurant, remember this place. NOT FOR phoning to book a table, ordering delivery, business search or reviews (a scraping skill or Google Maps), groceries or recipes, business research (an OSINT skill, if installed).
---

# Restaurants

Holds the household's food, cuisine, restaurant, and drink taste profile — what they love, what they avoid, where they like to eat, what they drink — and uses it to recommend a place, suggest what to order, or recall their preferences. The data lives in `LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Restaurants/Preferences.md`, the source of truth; this file only routes and holds no taste rules.

## Ideal State

- Every recommendation is drawn from the full Preferences data file, read that turn, and never names a place that hits one of its dealbreakers.
- A pick names a clear choice with why it fits, and a place outside the file is labelled a new suggestion with only grounded facts.
- The taste profile grows only with what the principal actually said, unknowns written as `TBD`, so later picks never inherit a guess.
- Every answer, a plain lookup included, says what the file records and flags what is `TBD` or missing: a short drink list or cuisine ranking is reported as short, and a place's cuisine, address, or menu is never invented to fill a gap.

## Intent Routing

| Intent | Trigger | File |
|--------|---------|------|
| **Recommend** | "where should we eat", "recommend a restaurant", "pick a place", "find a spot for a cuisine", "date night dinner", "what should we order" | `Intents/Recommend.md` |
| **AddPreference** | "add a favorite", "remember this place", "we love X now", "log this restaurant", "update our food prefs" | `Intents/AddPreference.md` |

For a plain "what do they like?" lookup, read the Preferences data file and answer — no intent needed.

| File | Read when |
|------|-----------|
| `Setup.md` | first-time install: creating the Preferences data file and its sections |

## Data & Config

All taste data lives under the USER tree, not in this skill: `LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Restaurants/Preferences.md` (taste profile, ranked cuisines, favorite restaurants, drinks, and optionally companion restrictions). First-time setup is in [Setup.md](Setup.md). Read the file before every recommendation. When the file is missing, stop and point the user at `Setup.md`; never recommend from a default taste profile.

The file grows through **AddPreference**, or a direct edit for small fixes.

## Gotchas

- None reproduced yet.

## Examples

**Example 1: Pick a place**
```
User: "Where should we go for dinner tonight?"
→ Recommend intent
→ One clear pick (or 2-3 ranked), each with a line tying it to the taste profile, no dealbreaker hit, any location or occasion given factored in
```

**Example 2: Capture a new favorite**
```
User: "We tried a new place in town and loved it — add it"
→ AddPreference intent
→ The restaurant is a dated row in Favorite Restaurants with location, cuisine and notes, and the reply says what was added
```

**Example 3: Plain lookup**
```
User: "What beer do we like again?"
→ No intent
→ The answer comes from the file's Drinks → Beer section, with any TBD favorites said plainly
```
