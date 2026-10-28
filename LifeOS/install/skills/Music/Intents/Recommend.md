# Intent: Recommend

Suggest new music that fits the user's taste, grounded in the corpus.

## Ideal State

- Every recommendation is anchored to the pole(s) relevant to the request and to a specific artist or track the user already has, both taken from the corpus's poles and rows.
- Recommendations follow the bias the corpus Taste Profile states, and still offer range across the poles unless the request narrows them.
- Recommendations are split into two buckets, safe fits and stretches, and each rec gives one line of why tied to a specific corpus anchor.
- Where a recommended track exists in several versions (studio, live, remaster) and the Taste Profile states a recording or production preference, the recommendation names the version that best fits it.
- Every recommended artist or track exists as named and is credited to the right artist, confirmed by a fetched source or a Spotify search hit; one that could not be confirmed is marked unverified, never stated as fact.
- The answer offers to add the keepers to the corpus via AddMusic, tagged 👂 until they confirm.

## Anti-criteria

- Never recommends an artist/track already in the corpus, unless suggesting a *different* track by an artist they like, and then it is flagged as the same artist.
- No overselling: confidence is stated honestly as "safe fit" vs "stretch".

## Output format

Two buckets:

   - **Safe fits** — clearly in their lane, high confidence they'll like them.
   - **Stretches** — adjacent, a bit of a reach, flagged as such.

For each rec, give **one line of why** tied to a specific corpus anchor ("like <anchor>'s <quality you named>, but <what is different>").

## Tool contract

Existence check, when the Spotify skill is installed (otherwise a fetched web source): `bun skills/Spotify/Tools/Spotify.ts search --query "<artist> <track>" --type track` (or `--type artist` / `--type album`). Search needs the Spotify app keys (`SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`) but no user sign-in or refresh token.
