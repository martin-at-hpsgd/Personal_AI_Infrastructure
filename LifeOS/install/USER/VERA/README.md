---
provenance: template
---

# Vera — versioned ideal-state profiles of people

The Pulse `/vera` page reads `pulse-snapshot.json` in this directory. Until
the snapshot exists the page shows "No profiles yet".

## Layout

```
VERA/
├── axes.json                   # the axes claims are rated against (view config)
├── people/<slug>/claims.jsonl  # one claim per line, per person
├── people/<slug>/Profile.md    # generated view, never hand-edited
└── pulse-snapshot.json         # redacted export the dashboard reads
```

## What it is for

Vera weighs sources: how much to trust the people whose public work you
read and cite, judged from evidence about what they published, predicted and
did. Keep profiles to public figures acting in public, and to people who have
agreed to be profiled. Record only claims backed by a source you can name,
and mark anything about someone's private life `sensitivity: personal` so it
never enters a score. Every row should survive being shown to the person it is
about. Vera does not check consent for you; that judgment stays with you.

## How it gets filled

```sh
bun ~/.claude/LIFEOS/VERA/Vera.ts init          # writes a starter axes.json
bun ~/.claude/LIFEOS/VERA/Vera.ts add ...       # record a claim about a person
bun ~/.claude/LIFEOS/VERA/Vera.ts export-pulse  # writes pulse-snapshot.json
```

`bun ~/.claude/LIFEOS/VERA/Vera.ts` with no verb prints the full usage. Scores
are never stored; they are computed from the claims at read time. Use
placeholder slugs like `person-a` while you try it out.

## Privacy

Everything here is Restricted Data about real people. It never ships in a
release. Keep this directory in your private USER-data repo, never a public one.
