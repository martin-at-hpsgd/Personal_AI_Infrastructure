---
provenance: template
version: 1.0.0
---

# Music Config

Read by the music skill before every request. Your taste lives in the corpus, never here. Setup guide: `skills/Music/Setup.md`.

## Files

Corpus: `LIFEOS/USER/MUSIC/MusicReference.md`

Path is relative to the config root (`$CLAUDE_CONFIG_DIR`, else `~/.claude`).

## Playlist defaults

Optional. Delete any line to keep the skill's default.

- Length: 20 tracks.
- Setup: speakers.
- Setup, speakers: room-filling mixes with a wide stereo image.
- Setup, earbuds: tracks that keep their low end at modest volume.
- Pool: favorites and recommended (⭐ and 👂).
- Arc, default: start warm, peak two-thirds in, wind down.
- Arc, dinner: instrumental first, vocals once people are seated, nothing louder than conversation.
