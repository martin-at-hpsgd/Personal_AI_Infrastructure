# Aphorisms

Status: test -f ~/.claude/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Aphorisms/aphorisms.md && echo ok · optional

## What it does

Keeps your quote collection as one markdown file, finds quotes that fit a piece of writing, adds and researches quotes, and records each use so the same quote is not suggested again soon. It works out of the box on a small starter collection; your own collection and preferences make it yours.

## Fill in

Two files under `LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Aphorisms/` in your config root (`$CLAUDE_CONFIG_DIR`, else `~/.claude`).

**1. `aphorisms.md`**, your collection. Copy `skills/Aphorisms/Database/aphorisms.md` there to start. Once it exists every intent reads and writes it instead of the starter, and `Tools/Aphorisms.ts path` prints it.

**2. `PREFERENCES.md`**, four sections, all optional:

| Section | Meaning |
|---|---|
| `## Default use` | What the quotes are usually for and who reads them, e.g. "an opening quote for each edition of Alex Example's weekly newsletter; readers are engineers". |
| `## Philosophy themes` | What a good quote embodies, used for the Philosophical Alignment score, plus an optional list of content themes for FindAphorism's analysis. |
| `## Key thinkers` | A table of `Thinker`, `Focus`, `Priority sources`. Each thinker gets a section in `aphorisms.md`, and ResearchThinker starts from those sources. |
| `## Approved categories` | One `- Category Name` bullet per theme category you approved beyond SKILL.md § Taxonomy, e.g. `- Wisdom & Truth-Seeking`. `Aphorisms.ts check` accepts these as Theme Index headings. |

The installer puts a filled example at `LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Aphorisms/PREFERENCES.md`; if it is missing, `bun ~/.claude/skills/LifeOS/Tools/ScaffoldUser.ts --apply` copies any missing starter file into place and never overwrites one you have edited.

## Accounts and secrets

None. Research uses the Research skill; edition URLs are read by `Tools/Aphorisms.ts fetch`.

## Prove it works

```bash
bun ~/.claude/skills/Aphorisms/Tools/Aphorisms.ts path    # prints your aphorisms.md
bun ~/.claude/skills/Aphorisms/Tools/Aphorisms.ts check   # OK on a well-formed collection
```
