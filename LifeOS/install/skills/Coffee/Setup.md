# Coffee

Status: test -f ~/.claude/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Coffee/Config.md && echo ok · optional

## What it does

The coffee skill keeps your coffee taste as a written corpus and your brewing gear as notes, then uses both to recommend a coffee, find new ones that fit, answer brew questions, and log what you drink. Every pick is screened against the rules you wrote in the corpus, so it never guesses your taste from memory. It is instructions only: no code, no account and no key.

## Fill in

Three pieces, all plain markdown under your config root (`$CLAUDE_CONFIG_DIR`, else `~/.claude`).

**1. Config.md** at `LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Coffee/Config.md`. Smallest working example:

```markdown
# Coffee Config

## Files

Corpus: `LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Coffee/CoffeeReference.md`
Gear: `LIFEOS/USER/GEAR.md` § `## Coffee`
```

| Field | Meaning |
|---|---|
| `Corpus:` | Path to your taste corpus, relative to the config root. |
| `Gear:` | The file and section holding your grinders, brewers and brew defaults. |

**2. The taste corpus** at the `Corpus:` path. It needs a `## Taste Profile` section in your own words plus the screening rules, with the unbendable ones marked **hard**, and coffee rows tagged ⭐ (favorite) or 👂 (candidate). A made-up example:

```markdown
## Taste Profile

In your own words: *bright and juicy, tastes like fruit tea, nothing smoky.*

- **Brew method (hard):** pour-over and espresso.
- **Roast (hard):** light to light-medium.
- **Core flavors:** florals, citrus, red berries.
- **Rejects (hard):** smoky or ashy cups.

## Coffees

### Batch 1 — First coffees (captured 2026-01-01)

| # | Roaster | Coffee | Roast | Profile | Source | Notes |
|---|---------|--------|-------|---------|--------|-------|
| 1 | Example Roasters | Lantern Washed | Light | Jasmine, lemon, black tea | ⭐ | |
```

**3. Gear notes** in the `## Coffee` section of `LIFEOS/USER/GEAR.md` (or wherever `Gear:` points). A made-up example:

```markdown
## Coffee

| Gear | Type | Notes |
|------|------|-------|
| Acme Conical Grinder | Hand grinder, conical burr | Setting 14 for pour-over |
| Example V-Cone | Pour-over | 1:17, 94 °C water, 3:30 total |
```

## Accounts and secrets

None. The skill reads and writes only the two markdown files above and needs no `~/.claude/.env` keys. Discovering coffees fetches roaster pages on the open web.

## Prove it works

```bash
grep -nE '^(Corpus|Gear):' ~/.claude/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Coffee/Config.md
grep -nE '^## Taste Profile|^\| 1 ' ~/.claude/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Coffee/CoffeeReference.md
grep -n -A5 '^## Coffee' ~/.claude/LIFEOS/USER/GEAR.md
```

Success: the first command prints your `Corpus:` and `Gear:` lines, the second prints the `## Taste Profile` heading and at least one coffee row (adjust the path if your `Corpus:` line points elsewhere), and the third prints the `## Coffee` heading of your gear file and the five lines under it (adjust it if your `Gear:` line points elsewhere). If the third prints nothing, the skill has no gear to brew for: add the section from step 3. On the unedited starter files the three print:

```
12:Corpus: `LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Coffee/CoffeeReference.md`
13:Gear: `LIFEOS/USER/GEAR.md` § `## Coffee`
21:## Taste Profile
39:| 1 | Example Roasters | — | Light | Clean, fruit-forward single origins | ⭐ | Local shop, rotating menu. |
47:| 1 | Example Roasters | Lantern Washed | Light | Jasmine, lemon, black tea | ⭐ | Also called "the lantern one". |
74:## Coffee
75-
76-_TODO: grinders, brewers, kettle, scale — if coffee is your thing. The coffee skill reads this table: one row per piece, with grind settings and brew defaults in Notes._
77-
78-| Gear | Type | Notes |
79-|------|------|-------|
```

Then ask your assistant "what coffee should I order?". Success is a ranked pick with one line each on why it fits your profile, and nothing that breaks a rule you marked hard.
