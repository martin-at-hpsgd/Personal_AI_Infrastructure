---
provenance: template
version: 1.0.0
---

# Aphorisms Preferences

Read by the Aphorisms skill (`skills/Aphorisms/SKILL.md` § Data & Config) before every intent. Your collection lives beside this file as `aphorisms.md`; copy `skills/Aphorisms/Database/aphorisms.md` there to start. Setup guide: `skills/Aphorisms/Setup.md`.

## Default use

What you mostly ask for. Example: an opening quote for each edition of Alex Example's weekly newsletter, 3-5 candidates matched to that edition's themes, avoiding recently used ones. The usual request form: "Edition themes: ...; avoid quotes already used". The readers: engineers.

Without content themes listed under Philosophy themes, FindAphorism names the themes each edition carries.

## Philosophy themes

What the quotes should embody (used for the Philosophical Alignment score). Example: curiosity, craftsmanship, resilience.

## Key thinkers

Each gets its own section in `aphorisms.md`; AddAphorism files their quotes there, and ResearchThinker starts from these sources.

| Thinker | Focus | Priority sources |
|---|---|---|
| Example Thinker A (1900-1980) | Curiosity, clear thinking | Their best-known book; collected lectures |
| Example Thinker B (1950-present) | Craft, persistence | Essays; interviews |

Research notes: anything about a thinker's style that changes how quotes are picked.
