---
provenance: template
version: 1.1.0
last_updated: 2026-01-01
---

# Music Reference — your taste corpus

> Ground truth for the music skill. It reads this file before recommending,
> building playlists, or discovering adjacent artists; it never guesses from
> memory. Edit it by hand or through the skill's AddMusic intent. Every name
> below is made up: replace the poles, anchors and rows with your own.

## Taste Profile

The poles of your taste, each with two or three anchor artists, then any bias
you want every suggestion to honor.

- **Late-night jazz trio** — The Example Trio, Quiet Harbor Quartet.
- **Bright synth-pop** — Acme Neon, The Paper Satellites.
- **Bias:** live-sounding recordings; no autotune.

## Legend

Source tags are read by machines as well as you:

- A row tagged with the star emoji is a confirmed favorite. If you run the
  Hermes heartbeat's artist scan (`LIFEOS/HERMES/Heartbeat/ArtistScan.ts`), every
  starred table row's second column (Artist) becomes a live tour-date search, so
  keep Artist in the second column and star only artists you want show alerts for.
- A row tagged 👂 is a candidate: recommended or found by the skill, not yet confirmed.

New music is appended as a new `### Batch N` section under Tracks (rows with a
specific song) or Artists / Bands (artist-level rows, Track and Album `—`).
Columns: `| # | Artist | Track | Album | Type | Source | Notes |`. `Type` is a
short genre or feel label; `Source` carries the tag plus where it came from.

## Playlists

- (optional: names or links of playlists you already keep, and what each is for)

## Tracks

### Batch 1 — Starter examples (captured 2026-01-01)

| # | Artist | Track | Album | Type | Source | Notes |
|---|--------|-------|-------|------|--------|-------|
| 1 | The Example Trio | Lamplight | After Hours | Jazz trio | 👂 example row | Replace with a track you love and star it. |
| 2 | Acme Neon | Static Bloom | Glass Weather | Synth-pop | 👂 example row | Replace or delete. |

## Artists / Bands

### Batch 2 — Starter examples (captured 2026-01-01)

| # | Artist | Track | Album | Type | Source | Notes |
|---|--------|-------|-------|------|--------|-------|
| 1 | Quiet Harbor Quartet | — | — | Jazz quartet | 👂 example row | Replace with an artist you love and star it. |

## Counts

- Tracks: 2 (batch 1)
- Artists/Bands: 1 (batch 2)
- Favorites (⭐): 0 · Recommended (👂): 3
