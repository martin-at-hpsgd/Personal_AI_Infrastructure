# Spotify.ts — help

Deterministic CLI wrapping the Spotify Web API directly. No MCP, no server process, no session state — every invocation refreshes its own access token from `SPOTIFY_REFRESH_TOKEN` in `~/.claude/.env`.

## Setup (one-time)

1. Spotify app with redirect URI `http://127.0.0.1:8888/callback` (byte-for-byte) at developer.spotify.com/dashboard.
2. `bun Spotify.ts auth --client-id <id> --client-secret <secret>` — opens the browser for consent, then persists `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `SPOTIFY_REFRESH_TOKEN` to `~/.claude/.env`. If the id/secret are already in `.env`, plain `bun Spotify.ts auth` works.

## Commands

Run `bun Spotify.ts --help` for the full list with flags. Read ops: `search`, `now-playing`, `recent`, `queue`, `devices`, `playlists`, `playlist-tracks`, `saved-tracks`. Write ops: `create-playlist`, `add-tracks`, `follow-playlist`. Playback (Premium + active device): `play`, `pause`, `next`, `prev`, `add-to-queue`, `volume`.

`--json` on any command returns raw API JSON for scripting.

## Behavior notes

- `search` works without user authorization (falls back to client-credentials); everything else needs the refresh token.
- `add-tracks` batches URIs 100 at a time automatically.
- Rotated refresh tokens are persisted back to `.env` automatically.
- Exit codes: 0 success · 1 user error (bad flags, missing auth) · 2 API/system error.
