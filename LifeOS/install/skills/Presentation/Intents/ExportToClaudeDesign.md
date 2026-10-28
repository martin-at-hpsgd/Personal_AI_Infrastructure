# ExportToClaudeDesign

The optional canvas/PPTX leg: re-syncs the install's deck design system into Claude Design, or remakes a finished deck as a Slides Artifact that downloads as PPTX or PDF.

## Ideal State

- When components changed, the install's deck design system in Claude Design was re-synced through the native `/design-sync` flow against the prototype package, which owns the read → plan → approve → write contract, render checks, and `@dsCard` manifest.
- When a finished deck is wanted as PPTX or PDF, it exists as a Slides Artifact made with the `Artifact` tool from the deck's own slide content and notes, and the principal has its link to review and download it.
- Any Claude Design or Slides-type capability the docs do not describe (presenter mode, speaker notes surviving PPTX export) is reported as UNCONFIRMED unless it was ground-truthed this session.

## Anti-criteria

- Never reimplement the sync.
- Never conflate the two operations: re-syncing the design system and exporting a finished deck.
- Never place a finished deck with the `DesignSync` tool: its own contract keeps it to the `/design-sync` flow and sends decks to a Slides Artifact type.
- Never promise Keynote-style presenter behavior from Claude Design; it lives in our reveal.js deck.

## Tool contract

The install's deck design system lives in Claude Design as one project, named
in the install's `DesignSystem.md` (React components, synced via `/design-sync`). Two distinct operations:

### Re-sync the design system (components changed)

Never reimplement the sync. Invoke the native `/design-sync` flow against
the prototype package (the Claude Design slides-template prototype built
2026-07-14; its path on this install is a private work directory, so resolve it
from the maintainer's notes or Config.md rather than from this file).
It owns the read → plan → approve → write contract, render checks, and
`@dsCard` manifest.

### Export a finished deck as PPTX or PDF

Remake it from the Slides Artifact type with the `Artifact` tool: `quickstart`
with intent `slides` names the type and the design systems this account has (if
it lists no Slides type, say so and stop), then publish with that type's
`type_url` and fill it with the deck's slide titles, content and notes as the
type's instructions say. A Slides artifact downloads as .pptx or PDF.

The `DesignSync` tool is not this path. Its contract limits it to `/design-sync`
keeping a component library in sync, never making a deck (review 2026-10-11).

## Gotchas

- Claude Design has no documented presenter mode (its launch post, support
  article 14604416 and tutorial describe none; recheck them before relying on this). The Keynote behavior
  lives in our reveal.js deck — never promise it from Claude Design, and
  mark any undocumented Design capability UNCONFIRMED.
- Whether PPTX export preserves speaker notes is UNCONFIRMED — say so if
  asked, or ground-truth it by exporting once and opening the file.
- `DesignSync list_projects` shows only projects writable under the current
  session credential — an empty list does not mean the project is gone
  (2026-07-14: two copies of one design-system project were created because a
  second session couldn't see the first one's project).
