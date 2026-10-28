# Restaurants

Status: test -f ~/.claude/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Restaurants/Preferences.md && echo ok · optional

## What it does

Restaurants keeps your household's food and drink taste profile in one file and uses it to answer "where should we eat tonight?" with a pick that already knows what you love and what you refuse. It recommends a place or a dish, recalls your preferences on request, and records new favorites as you find them. For a city where you have no recorded favorite, it looks up candidates and their current hours through the Research skill. It needs that one file and nothing else.

## Fill in

Create `LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Restaurants/Preferences.md`. Smallest working example:

```markdown
---
version: 1.0.0
---

# Food & restaurant preferences

## Taste Profile

- Favorite cuisine: Thai
- Heat tolerance: medium; likes a kick but not numbing
- Dealbreakers: heavy cream sauces, soggy fried food
- Dietary constraints: none
- Price comfort: mid-range, splurge for occasions

## Favorite Cuisines

1. Thai
2. Italian

## Favorite Restaurants

| Name | Location | Cuisine | Notes | Added |
|------|----------|---------|-------|-------|
| Example Noodle House | Springfield | Thai | Good for a quick weeknight dinner | 2026-01-15 |

## Drinks

### Beer

- Profile: malty and mellow, not bitter
- Favorites: TBD

### Wine

- Favorites: TBD

## Open Items / To Confirm

- Wine list to be filled in
```

| Section | Meaning |
|---|---|
| `Taste Profile` | The rules a recommendation must respect: favorite cuisine, heat, dealbreakers, diet, price |
| `Favorite Cuisines` | Ranked, best first; used when the top cuisine does not fit |
| `Favorite Restaurants` | One row per place; dated when added; a city named in a request surfaces its favorite first |
| `Drinks` | Beer and wine profiles and favorites |
| `Companion Restrictions` | Optional, and not part of the smallest example. A table of `Person` and `Allowed places` columns, for a person who can only eat at certain places; when they come along the pick comes only from their list. Leave it out if you do not need it |
| `Open Items / To Confirm` | Things mentioned but not pinned down; removed when answered |

Keep these section names; the intents look for them by name. Write `TBD` for anything unknown. You can also tell the assistant "add a favorite" and it appends to the right section for you.

## Accounts and secrets

None. Travel recommendations use the Research skill with whatever search accounts your LifeOS already has; no extra key in `~/.claude/.env` is needed here.

## Prove it works

```bash
test -f ~/.claude/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Restaurants/Preferences.md && rg -c '^## ' ~/.claude/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Restaurants/Preferences.md
```

Success: it prints a number of at least `5`, the count of top-level sections in your file. Then ask the assistant: "Where should we eat tonight?" Success is one clear pick, or two or three ranked options, each with a line tying it back to your taste profile. If the file is missing, the assistant stops and points you at this file instead of guessing.
