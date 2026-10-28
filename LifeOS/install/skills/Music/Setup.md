# Music

Status: test -f ~/.claude/LIFEOS/USER/MUSIC/MusicReference.md && echo ok · optional

## What it does

The music skill keeps your music taste as a written corpus and uses it to build playlists, recommend tracks, and find artists next to the ones you love. Every suggestion is tied to an artist already in your corpus and labeled safe fit or stretch, and nothing you already have is offered as new. It is instructions only: no code of its own, no key.

## Fill in

Two pieces of plain markdown under your config root (`$CLAUDE_CONFIG_DIR`, else `~/.claude`).

**1. The corpus** at `LIFEOS/USER/MUSIC/MusicReference.md`. A starter ships with LifeOS in exactly this shape, with made-up names to replace. It opens with a `## Taste Profile`: the poles of your taste, two or three anchor artists for each, and a `Bias:` line for anything every suggestion should honor. Below it, rows sit in `### Batch N` sections under `## Tracks` (a specific song) and `## Artists / Bands` (an artist, with Track and Album `—`), each tagged ⭐ (favorite) or 👂 (recommended), and a `## Counts` block closes the file. The skill's AddMusic intent appends new batches in the same shape. A made-up example:

```markdown
---
last_updated: 2026-01-01
---

## Taste Profile

- **Late-night jazz trio** — The Example Trio, Quiet Harbor Quartet.
- **Bright synth-pop** — Acme Neon, The Paper Satellites.
- **Bias:** live-sounding recordings; no autotune.

## Tracks

### Batch 1 — Starter favorites (captured 2026-01-01)

| # | Artist | Track | Album | Type | Source | Notes |
|---|--------|-------|-------|------|--------|-------|
| 1 | The Example Trio | Lamplight | After Hours | Jazz trio | ⭐ | The brushwork on the intro. |
| 2 | Acme Neon | Static Bloom | Glass Weather | Synth-pop | 👂 a friend's pick | |

## Artists / Bands

### Batch 2 — Bands to try (captured 2026-01-01)

| # | Artist | Track | Album | Type | Source | Notes |
|---|--------|-------|-------|------|--------|-------|
| 1 | Quiet Harbor Quartet | — | — | Jazz quartet | 👂 a friend's pick | |

## Counts

- Tracks: 2 (batch 1)
- Artists/Bands: 1 (batch 2)
- Favorites (⭐): 1 · Recommended (👂): 2
```

Keep Artist in the second column and star only what you love. If you run the Hermes heartbeat's artist scan (`LIFEOS/HERMES/Heartbeat/ArtistScan.ts`), every ⭐ row's Artist cell becomes a live tour-date search, and a star on the wrong column would search for a genre instead.

**2. Config.md** at `LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Music/Config.md`, optional. Smallest working example:

```markdown
# Music Config

## Files

Corpus: `LIFEOS/USER/MUSIC/MusicReference.md`

## Playlist defaults

- Length: 20 tracks.
- Setup: car.
- Setup, car: punchy mixes that hold up over road noise.
- Arc, dinner: instrumental first, vocals once people are seated.
```

| Field | Meaning |
|---|---|
| `Corpus:` | Path to your corpus, relative to the config root. Default `LIFEOS/USER/MUSIC/MusicReference.md`. |
| `Length:`, `Pool:` | Playlist frame used when a request does not say. Defaults: 12 tracks, favorites only. |
| `Setup:` | The listening setup to assume when a request names none. Default: none. |
| `Setup, <name>:` | What to favor when building for that setup. Without a line for a setup, the setup does not change the selection. |
| `Arc, <use>:` | The track order for a named use; `Arc, default:` replaces the built-in quiet-to-peak arc. |

## Accounts and secrets

None for the skill itself. To check that a suggested artist exists, or to turn a playlist into a real Spotify playlist, install the Spotify skill and follow its guide. Its keys live in `~/.claude/.env`. Search, used for existence checks, needs only the app keys `SPOTIFY_CLIENT_ID` and `SPOTIFY_CLIENT_SECRET`; creating a playlist also needs `SPOTIFY_REFRESH_TOKEN`, which that skill's sign-in step writes. Without the Spotify skill, suggestions are checked against a fetched web page and playlists come back as a list to paste into any service.

## Prove it works

```bash
grep -niE '^## taste profile|^## counts|^\| 1 ' ~/.claude/LIFEOS/USER/MUSIC/MusicReference.md
```

Success: it prints the `## Taste Profile` heading, at least one row starting `| 1 |`, and the `## Counts` heading. On the unedited starter that is:

```
14:## Taste Profile
48:| 1 | The Example Trio | Lamplight | After Hours | Jazz trio | 👂 example row | Replace with a track you love and star it. |
57:| 1 | Quiet Harbor Quartet | — | — | Jazz quartet | 👂 example row | Replace with an artist you love and star it. |
59:## Counts
```

Then ask your assistant "what new bands would I like?". Success is a few artists grouped under lines that start `Because you have <an artist from your corpus> →`, each tagged safe fit or stretch, with none already in your corpus.
