---
provenance: template
---

# TELOS — Your Life Operating Goals

> 🎯 SAMPLE TEMPLATES — This directory ships as a SAMPLE with placeholder entries marked `(sample)`. It shows the SHAPE of populated TELOS data so you can see what to aim for. Run `/interview` (or talk to your DA) to replace the samples with your real mission, goals, beliefs, etc. Pulse will display populated entries here once you run the interview.

TELOS is your personal "why." It describes what you're trying to do with your
life, what's getting in the way, and how you plan to handle it. LifeOS reads
it at every session start so the DA understands the context behind any work
you ask for.

## The one file that matters

**`TELOS.md` is the single source of truth.** Everything lives in that one
unified file, organized as `##` H2 sections (Mission, Goals, Problems,
Strategies, Narratives, Challenges, Beliefs, Wisdom, Books, …). The code reads
it directly — `GenerateTelosSummary.ts` parses its sections, and
`TelosFreshness.ts` tracks the `<!-- updated: YYYY-MM-DD by:who -->` markers
you can leave on each section to record when it was last reviewed.

<!-- generated/yours/legacy rows: public issue #1960, @hjbrandt -->
| File | What it is |
|------|------------|
| `TELOS.md` | **The canonical TELOS.** All sections in one file. Edit this one. |
| `PRINCIPAL_TELOS.md` | **Auto-generated summary** of `TELOS.md`. Loaded into every session via CLAUDE.md. Never edit by hand. |
| `LIFEOS_STATE.json` | **Generated** by `LIFEOS/TOOLS/UpdateLifeosState.ts` from `CURRENT_STATE/` and `IDEAL_STATE/`: one `pct` per dimension, read by the statusline and the Pulse rings. Never edit by hand; a dimension whose files are still templates reads `null` ("not captured"). |
| `SPARKS.md` | **Yours.** Things that refuel you, as bold-lead bullets under H3 categories; the /life Spark card shows one at random. A `## Sparks` section in `TELOS.md` takes precedence. |
| `BOOKS.md` | **Yours.** Plain bullets under headings work as-is; Pulse reads `USER/BOOKS.md` first (the `- title:` pseudo-YAML shape) and falls back to this file. Keep one, not both. |

## Legacy per-topic files

Older installs kept TELOS as split files (`MISSION.md`, `GOALS.md`,
`PROBLEMS.md`, `STRATEGIES.md`, `NARRATIVES.md`, `CHALLENGES.md`, `BELIEFS.md`,
`WISDOM.md`, …). A new install does not get them. On an upgrade, the
`8.28.0-telos-consolidate` migration folds any split file that holds your own
writing into `TELOS.md` and keeps the original in a backup. The tools still read
a split file that is left over, so nothing an older install wrote goes missing.
Do not re-split a unified `TELOS.md` back into per-topic files.

## Subdirectories

| Dir | Purpose |
|-----|---------|
| `CURRENT_STATE/` | **Yours.** Where you are right now across the dimensions of your life — health, finances, relationships, work, learning. The DA uses this as the starting point for any "how do I get from here to there" question. Ships as scaffolds marked `provenance: template` in the frontmatter; a file still carrying that marker counts as "not captured" (no number anywhere in Pulse). `/interview` clears that state when it reviews the file (it stamps `last_updated_by`); if you fill one in by hand, delete the `provenance: template` line. |
| `IDEAL_STATE/` | **Yours.** Where you want to be — the vision you're aiming at across the same dimensions. Same `provenance: template` rule as `CURRENT_STATE/`. |
| `Backups/` | Versioned snapshots of your TELOS files. Tools that bulk-edit TELOS write a backup here before changing anything. Empty until something is backed up. |

## How to fill it in

**Easiest:** run `/interview` after install. It walks you through each section
in order, asks the right questions, and writes your answers to `TELOS.md` —
replacing every `(sample)` entry with content that's actually yours.

**By hand:** open `TELOS.md`. The bootstrap content shows the shape — delete
the placeholders and write your real answers under each `##` section. Keep
entries short and high-signal; the DA reads this at session start.

**From existing data:** if you already have goals/missions in Obsidian,
Notion, journal entries, or a Telos repo, run the **Migrate** skill before
`/interview` to import what you have. The interview will then fill gaps
instead of asking you to re-type things.

## Regenerate the summary

Whenever you edit `TELOS.md`, regenerate the summary so session-start context
stays in sync:

```bash
bun ~/.claude/LIFEOS/TOOLS/GenerateTelosSummary.ts
```

(`/interview` calls this automatically when it finishes a phase.)

## Privacy

This directory ships only as a bootstrap scaffold of samples. Anything you
write here stays on your machine and never reaches a public LifeOS release.
The release builder strips `LIFEOS/USER/**` and overlays a fresh sample
scaffold for each new installer.
