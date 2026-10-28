---
metadata:
  short-description: "Use the user's written music taste to recommend tracks, discover artists, build playlists, and maintain the taste corpus. Use Spotify for account actions."
name: Music
evals:
  manual:
    reason: "music recommendation and playlist fit require a listener's judgment against the current taste corpus"
    falsifier: "the reviewer finds that a recommendation conflicts with the stated taste constraints or the requested playlist does not meet its brief"
version: 1.1.1
description: Learns the user's music taste as a written corpus and uses it to build playlists, recommend tracks, and discover adjacent artists. USE WHEN my music, my music taste, what do I like, build me a playlist, make a playlist, playlist for focus or a drive, recommend music, songs like, what should I listen to, new bands, discover new artists, find bands like the ones I have, expand my taste, add to my music, add this band, my favorite bands, music reference, update my music list. NOT FOR song generation, audio editing (AudioEditor), video audio, audio or studio gear.
---

# Music

Holds the user's music taste as a durable corpus (favorite tracks, artists, and genres, each tagged favorite or recommended) and uses it to build playlists, recommend tracks that fit, discover new artists next to the ones they already love, and grow the list as they feed in more. It reasons from the corpus, not from memory.

## Ideal State

- Every playlist, recommendation and discovery starts from a fresh read of the corpus, and nothing already in it is presented as new.
- Every suggestion is tied to a named corpus anchor and labeled honestly: ⭐, 👂 or NEW, safe fit or stretch.
- Every artist, track or album offered as new exists as named and is credited to the right artist, confirmed by a fetched source or a Spotify search hit; one that could not be confirmed is marked unverified, never stated as fact.
- New music lands in the corpus as an appended batch with a source tag, and the user's existing rows and hand-edits are never rewritten.
- Suggestions follow the bias stated in the corpus Taste Profile, and the set still covers whichever poles of the user's taste the request names.

## Intent Routing

| Intent | Trigger | File |
|----------|---------|------|
| **BuildPlaylist** | "build me a playlist", "make a playlist", "playlist for <mood>" | `Intents/BuildPlaylist.md` |
| **Recommend** | "recommend music", "what should I listen to", "songs like X" | `Intents/Recommend.md` |
| **DiscoverArtists** | "new bands", "discover new artists", "bands like the ones I have", "expand my taste" | `Intents/DiscoverArtists.md` |
| **AddMusic** | "add to my music", "add this band", "log this album", "update my music list" | `Intents/AddMusic.md` |

| File | Read when |
|------|-----------|
| `Setup.md` | first-time setup: the config file, the corpus format and playlist defaults, and a read-only proof |

## Data & Config

Read `<configRoot>/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Music/Config.md` first (`configRoot` is `$CLAUDE_CONFIG_DIR` when set, else `~/.claude`). It names the corpus and holds the playlist defaults; when it is absent, the corpus is `<configRoot>/LIFEOS/USER/MUSIC/MusicReference.md` and the defaults in `Intents/BuildPlaylist.md` stand. First-time setup: [Setup.md](Setup.md).

**The corpus** (Config.md `Corpus:` line):

- Human-editable markdown in the USER zone, never in this skill body. The user adds entries by hand or via AddMusic.
- It opens with a `## Taste Profile`: the poles of the user's taste with anchor artists for each, and any stated bias (vocals, production, eras, things to avoid). That section is ground truth, never memory.
- Two source tags: **⭐ favorite** (they love it) vs **👂 recommended** (someone said to listen; on probation).
- Grows in batches: each new dump becomes a new `### Batch N` section under `## Tracks` or `## Artists / Bands`, with Artist as the second column, and a `## Counts` block closes the file.
- A ⭐ row is more than a label: if the Hermes heartbeat artist scan (`LIFEOS/HERMES/Heartbeat/ArtistScan.ts`) runs, every ⭐ row's Artist cell becomes a live tour-date search. Star only what the user loves.

No account or key is needed for the skill itself. Existence checks and playlist creation use the Spotify skill when it is installed (search needs its app keys, playlists also need its user sign-in); without it, suggestions are checked against a fetched web source and playlists are delivered as a pasteable list.

## Gotchas

- DiscoverArtists is roster-driven (start from what they have); Recommend is request-driven (start from a mood/ask). Don't collapse them.

## Examples

**Example 1: Build a playlist**
```
User: "build me a focus playlist for deep work"
→ BuildPlaylist
→ A tight numbered list (Track — Artist — Album) of ⭐ corpus tracks ordered for flow, to paste into any service, or a Spotify playlist via the Spotify skill
```

**Example 2: Discover new artists**
```
User: "what new bands would I like?"
→ DiscoverArtists
→ Adjacent artists not in the corpus, grouped as "Because you have <Anchor> → <New artist>, <New artist>" with safe-fit/stretch tags
```

**Example 3: Grow the corpus**
```
User: "add these to my music: <three artists and an album>"
→ AddMusic
→ A new ### Batch section with schema rows and source tags, and updated counts
```
