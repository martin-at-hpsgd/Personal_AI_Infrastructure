---
provenance: template
version: 1.1.1
---

# MUSIC — your music taste corpus

One file lives here: `MusicReference.md`. The music skill reads it before it recommends tracks, builds playlists, or looks for adjacent artists. If you run the Hermes heartbeat's artist scan, it reads the starred rows too.

## What goes in it

- **Taste Profile**: the poles of your taste, two or three anchor artists for each, and a `Bias:` line for anything every suggestion should honor.
- **Tracks** and **Artists / Bands**: tables grouped into `### Batch N` sections, one row per item, columns `| # | Artist | Track | Album | Type | Source | Notes |`. Keep Artist in the second column; the artist scan and the skill's AddMusic intent both rely on it.
- **Playlists you already have** and what each is for, so new ones do not duplicate them.
- **Counts**: totals the skill updates when it appends a batch.

Replace the example rows in `MusicReference.md`, or tell your DA about a band and let it file the row. Star (⭐) only what you love; with the artist scan running, every starred artist becomes a tour-date search. Streaming-account credentials (the Spotify skill reads `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `SPOTIFY_REFRESH_TOKEN`) live in `~/.claude/.env`, never here; the Spotify skill's `Setup.md` says how to get each one.
