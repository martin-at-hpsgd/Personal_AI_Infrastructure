---
metadata:
  short-description: "Search Spotify, manage playlists and library, queue tracks, and control playback. Use a music-taste skill for recommendations and a song-generation skill to create songs."
name: Spotify
evals:
  manual:
    reason: "Spotify actions change the principal's account and playback state, so live writes are not a routine verifier"
    falsifier: "the provider state after an approved action differs from the requested playlist, library, queue, device, or playback change"
version: 1.0.8
description: Acts on the principal's Spotify account via a deterministic CLI (Tools/Spotify.ts): search, playlists, now-playing, library, and playback across devices. USE WHEN spotify, play on spotify, add to my spotify, follow this playlist, save playlist, create a spotify playlist, add tracks, what's playing, my playlists, queue this, skip track, set volume, spotify search, control spotify, my spotify library. NOT FOR music taste or recommendations, generating songs, editing audio (AudioEditor).
---

# Spotify

Acts on the principal's real Spotify account through `Tools/Spotify.ts` — a deterministic CLI that calls the Spotify Web API directly. No MCP, no server process, no session registration: any session can invoke it via Bash immediately.

```bash
bun ~/.claude/skills/Spotify/Tools/Spotify.ts <command> [flags]   # --help for the full list
```

## Ideal State

- Every requested account change (follow, playlist build, library read, queue, playback) is one `Tools/Spotify.ts` call keyed by IDs or URIs, and the account state afterwards matches the request.
- Auth is set up once and never repeated by hand: tokens refresh per invocation, and a dead token or redirect mismatch is traced to its real fix (re-run `auth`, or fix the dashboard URI).
- Playback is attempted only on a Premium account with an active device, so a Free account still gets search, playlists and library.

## Intent Routing

| Intent | Trigger | File |
|--------|---------|------|
| **Authorize** | "set up spotify", "authorize spotify", "connect spotify", auth broken | `Intents/Authorize.md` |
| **Manage** | play / search / playlists / queue / library ops | `Intents/Manage.md` |

| File | Read when |
|------|-----------|
| `Setup.md` | first-time install: the developer app, the three `.env` keys, the proof command |
| `Tools/` | `Spotify.help.md` is the full flag reference (same as `--help`); `EnvText.ts` is the pure env-file helper `Spotify.ts` writes tokens with |

## Data & Config

This skill reads no files under `LIFEOS/USER/`. Credentials are env-only: `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET` and `SPOTIFY_REFRESH_TOKEN` in `~/.claude/.env` (names only here, never values). First-time setup, the Spotify developer app and the proof command are in [Setup.md](Setup.md). Tokens auto-refresh per invocation; a missing refresh token means run `Intents/Authorize.md`. With the credentials missing, the tool exits 1 and points at Setup.md.

## Gotchas

- **`search` works before user auth** (client-credentials fallback); every other command needs the refresh token.
- **401 on every call** → the refresh token died (password change, revoked access); re-run `auth` (`Intents/Authorize.md`). The tool persists rotated refresh tokens automatically.
- **`/me/playlists` returns `tracks: null` on playlist rows (observed)** — never assume `tracks.total` exists; the CLI omits the count when absent.

## Examples

- "Add this playlist link to my Spotify" → Manage → the playlist is followed with `follow-playlist --id <ID>` (ID from the URL) and shows in `playlists`.
- "Make me a focus-music playlist and fill it" → Manage → a new playlist from `create-playlist`, holding the tracks `search` resolved, added with `add-tracks`.
- "What's playing?" → Manage → the `now-playing` result.
- "Skip this / turn it down" → Manage → `next` / `volume --percent 30` on the active Premium device.
