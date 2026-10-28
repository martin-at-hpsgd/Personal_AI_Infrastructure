# BuildPlaylist

A playlist assembled from the user's music corpus, optionally seasoned with fresh recommendations.

## Ideal State

- The playlist's tracks and artists are selected from the corpus first, and ⭐ favorites are preferred unless the user asked for range.
- The playlist fits its frame: mood/use, length, the listening setup when one applies, and favorites-only (⭐) or include recommended (👂). A frame the request did not give was defaulted from Config.md `## Playlist defaults` (or, when absent, 12 tracks, no setup, favorites-only unless range was asked for), the defaults are stated in one line above the list, and the playlist is built without a question round.
- Fresh recommendations, when added, are a few (from Recommend logic), and every entry is marked as corpus or new.
- The tracks are ordered for flow. The default arc opens quiet, builds through mid-energy, and lands where the mood wants; a named arc for that use in Config.md `## Playlist defaults` replaces it.
- When the frame names a listening setup (from the request or Config.md `Setup:`) and Config.md has a `Setup, <name>:` line for it, the selection favors what that line says; with no such line the setup does not change the selection.
- The user receives the playlist in the Output format below, ready to paste into whichever service they use, with the offer to ship it.

## Anti-criteria

- Never pads the playlist: a tight 12-track set beats a bloated 40.
- Never presents a fresh recommendation as a corpus entry; corpus vs new is always flagged.
- Never creates a Spotify playlist from this intent; that account action routes to the `Spotify` skill.

## Output format

A clean numbered list: Track — Artist — Album, with a one-line note on the arc. Mark ⭐/👂/NEW.

## Inputs

The frame: mood/use (focus, a drive, a workout, dinner, a party), length, listening setup (optional), favorites-only (⭐) or include recommended (👂).

## Tool contract

A Spotify playlist is an account action for the `Spotify` skill. No other streaming service has an integration here, so for those the pasted list is the deliverable.
