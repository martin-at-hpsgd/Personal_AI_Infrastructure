# Gifts

Status: test -f ~/.claude/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Gifts/Recipients.md && echo ok · optional

## What it does

Gifts finds uncommon, well-made, currently buyable gift ideas for specific people in your life. You keep a small registry of recipients with ages and interests. For each run the assistant researches what is moving in each interest right now, sources the actual gift from makers and specialty shops rather than mass-market lists, checks that each product link is live, and saves the run so later runs never repeat an idea. It needs the Research skill and nothing else.

## Fill in

Create `LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Gifts/Recipients.md`. Smallest working example:

```markdown
---
version: 1.0.0
---

# Gift Recipients

## taylor

- Name: Taylor Example
- Age: 52 (as_of: 2026-01-01)
- Relationship: friend
- Group: friends
- Interests: sea kayaking, specialty tea
- Constraints: no alcohol; ships to the US; budget around 100
- Occasions: birthday in June
```

One `## <id>` section per person; the id is the lowercase first name. You can also just tell the assistant "add a gift recipient" and it writes the section for you.

| Field | Meaning |
|---|---|
| `Name` | Display name |
| `Relationship` | How they relate to you |
| `Group` | Tag so "gifts for <group>" runs everyone in it |
| `Age` | Number plus `as_of: YYYY-MM-DD`; the skill computes the current age at run time |
| `Interests` | Most important first |
| `Constraints` | Sizes, allergies, things they already own, content limits, shipping region, budget; write `unknown` when you do not know |
| `Occasions` | Dates or events worth remembering |

Each run writes `LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Gifts/History/<id>-<YYYY-MM-DD>.md` (a second run the same day adds `-2`, `-3`) and a copy to `~/Downloads/`. The skill creates the History folder.

## Accounts and secrets

None for this skill. Research uses whatever search accounts your LifeOS already has; no extra `~/.claude/.env` key is needed here.

## Prove it works

```bash
test -f ~/.claude/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Gifts/Recipients.md && rg -c '^## ' ~/.claude/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Gifts/Recipients.md
```

Success: it prints the number of recipients you registered (at least `1`). Then ask the assistant: "Gift ideas for taylor". Success is a ranked list of 8 to 12 ideas, each with a maker, a price, a live link marked `verified` or `unverified`, and a saved History file. If the registry is missing, the assistant stops and points you at this file instead of guessing.
