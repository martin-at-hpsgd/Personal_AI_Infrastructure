# AddMusic

Append new music to the reference corpus.

## Ideal State

- The reference file was read before anything was written, and the new items are appended as new `### Batch N — <short label> (captured YYYY-MM-DD)` section(s), numbered after the current highest batch, under the right heading: items with a specific song under `## Tracks`, artist/band-only items under `## Artists / Bands`. A heading the file lacks is created just above the Counts block.
- Every new row uses the column header of the most recent batch under that heading, or `| # | Artist | Track | Album | Type | Source | Notes |` when there is none, with Artist always the second column. Track and Album are `—` for artist-level entries, Type is a short genre or feel inferred from knowledge (e.g. "Dream pop"), and Notes says why it is here when the user gave a reason.
- Every new row carries a source tag: ⭐ favorite only where the user says they love it or it's a favorite; 👂 recommended where it's "someone said to listen" / "should check out" / unconfirmed; an ambiguous item was asked about once, or defaulted to 👂 and flagged.
- The `## Counts` block at the bottom is updated, or created when missing (tracks, artists, ⭐ vs 👂), and `last_updated` in the frontmatter is bumped, or added when the file has frontmatter without it.
- The user gets a confirmation naming what was added, the batch number, and the new totals.
- When a screenshot is the source, it was transcribed carefully and every row that could not be read is flagged.

## Anti-criteria

- Never rewrites existing rows.
- Never loses the user's hand-edits: only append, don't reflow.
- Never stars an item the user did not call a favorite: a ⭐ row's artist becomes a live tour-date search when the artist scan runs.

## Inputs

The user hands over a new batch of tracks, artists, a playlist screenshot, or a single album/band to log.
