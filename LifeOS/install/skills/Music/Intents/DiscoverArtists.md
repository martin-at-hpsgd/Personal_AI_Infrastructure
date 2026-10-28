# DiscoverArtists

**New artists/bands** the user doesn't have yet, found by walking their existing roster, each tied to a match they already love. The expansion engine: "based on what you like, here's who you don't know yet."

## Ideal State

- Anchors are the ⭐ artists by default, or the Taste Profile anchor artists while the corpus has no ⭐ rows yet; when the user names a pole (a genre, a mood, or a pole label from the Taste Profile) they are restricted to that cluster, and anchors are clustered by scene/sound so recommendations don't repeat across similar anchors.
- Each anchor (or cluster) gets 2–4 new artists that share real lineage (same scene, label, collaborators, era, or sound), and how well known they may be follows the Taste Profile, defaulting to a mix of familiar and lesser-known names.
- Output is grouped by anchor using the `Because you have <Anchor> → ...` line, each new artist tagged honestly as safe fit (clearly in lane) or stretch (adjacent reach), with a starter track offered per new artist so they can sample fast.
- Each new artist's offered starter track is a representative recording of that artist, and when the Taste Profile states a recording or production preference, an artist whose catalog does not meet it is left out.
- The list is kept tight: each anchor (or cluster) carries only a few high-confidence finds, never more than its 2–4, rather than a flood.
- Every new artist and starter track exists as named and is credited to the right artist, confirmed by a fetched source or a Spotify search hit; one that could not be confirmed is marked unverified, never stated as fact.
- The answer offers to log keepers via AddMusic, tagged 👂 until they confirm they're favorites.

## Anti-criteria

- No artist already in the corpus is presented as new: it is dropped, or a deeper cut by that artist is suggested and said so. That covers both its tracks and its artist entries.
- Doesn't just mirror genres: each pick names the specific connection to its anchor (a shared scene, label, collaborator or era), never "also <genre>" alone.

## Output format

**Group output by anchor:** `Because you have <Anchor> → <New artist> — <one line on the lineage> [safe fit | stretch]`.

## Tool contract

Existence check, when the Spotify skill is installed (otherwise a fetched web source): `bun skills/Spotify/Tools/Spotify.ts search --query "<artist> <track>" --type track` (or `--type artist` / `--type album`). Search needs the Spotify app keys (`SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`) but no user sign-in or refresh token.
