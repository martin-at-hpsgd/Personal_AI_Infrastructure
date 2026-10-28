# Spotify

Status: `bun ~/.claude/skills/Spotify/Tools/Spotify.ts playlists --limit 1` · optional

## What it does

Spotify lets you search Spotify, build and follow playlists, read your library and queue, and control playback on your devices from one command-line tool, `Tools/Spotify.ts`. It calls the Spotify Web API directly. It needs a free Spotify developer app (for a client id and secret) and your Spotify account. Playback commands (`play`, `pause`, `next`, `volume`) also need Spotify Premium and an open Spotify app on some device. Search, playlists and library work on a free account.

## Fill in

Nothing under `LIFEOS/USER/`. This skill keeps no config file and no personal data in its folder. Everything it needs is three keys in `~/.claude/.env`, covered in the next section.

## Accounts and secrets

1. A Spotify account (Premium for playback control).
2. A Spotify developer app: open `https://developer.spotify.com/dashboard`, choose **Create app**, name it anything. Under **Edit Settings, Redirect URIs** add exactly `http://127.0.0.1:8888/callback` (`127.0.0.1`, not `localhost`; port `8888`). Copy the **Client ID** and **Client Secret**.
3. Add the keys to `~/.claude/.env`. Names only, you supply the values:

| Key | Where the value comes from |
|-----|----------------------------|
| `SPOTIFY_CLIENT_ID` | Developer dashboard, your app, Settings |
| `SPOTIFY_CLIENT_SECRET` | Same page, **Show Client Secret** |
| `SPOTIFY_REFRESH_TOKEN` | Written for you by the `auth` command below |

Smallest working `.env` before the first auth (the third line is added by `auth`):

```bash
SPOTIFY_CLIENT_ID=your-client-id
SPOTIFY_CLIENT_SECRET=your-client-secret
```

Then run the one-time consent flow. It opens your browser, you click **Agree**, and the tool stores `SPOTIFY_REFRESH_TOKEN` in `~/.claude/.env` and prints the account it authorized:

```bash
bun ~/.claude/skills/Spotify/Tools/Spotify.ts auth
```

Check that a key exists without printing it: `bun ~/.claude/LIFEOS/TOOLS/Secrets.ts has SPOTIFY_CLIENT_ID SPOTIFY_CLIENT_SECRET SPOTIFY_REFRESH_TOKEN`. After editing `.env` run `bun ~/.claude/LIFEOS/TOOLS/Secrets.ts seal`.

## Prove it works

```bash
bun ~/.claude/skills/Spotify/Tools/Spotify.ts --help
bun ~/.claude/skills/Spotify/Tools/Spotify.ts playlists --limit 1
```

The first prints the command list with no credentials needed. The second prints one line per playlist, ending in the playlist id (or nothing if your account has no playlists) and exits 0. If it prints `Error: SPOTIFY_CLIENT_ID missing`, redo the keys step. A `401` means the refresh token is dead; run `auth` again. A `redirect_uri` error at consent means the dashboard URI is not byte-for-byte `http://127.0.0.1:8888/callback`.
