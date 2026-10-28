# Manage

Everyday Spotify operations on the principal's account (follow, build, search, library, playback), each one `Tools/Spotify.ts` call.

## Ideal State

- "Add this playlist to my Spotify" for a playlist the principal does not own is a follow (`follow-playlist --id <ID>`, ID taken from `open.spotify.com/playlist/<ID>`), and the playlist then appears in `playlists`.
- A playlist built from scratch exists from `create-playlist`, and holds the `spotify:track:...` URI that `search --type track` returned for each requested track, added with `add-tracks`.
- A requested track or playlist that `search` does not find, or matches ambiguously, is reported back by name with the candidates, and nothing is added for it, so a playlist built from a list holds only recordings that matched.

## Anti-criteria

- Never passes a display name where a command keys off an ID or URI; names are resolved via `search`/`playlists` first.
- Never runs a playback command without an active device, checked with `devices`: playback fails with no active device, the API cannot reliably cold-start one, and on a Free account playback commands fail with a Premium error.

## Tool contract

Assumes auth is done (`Intents/Authorize.md`). Every operation is one CLI call:

```bash
bun ~/.claude/skills/Spotify/Tools/Spotify.ts <command> [flags]
```

`--json` for raw API output. Full flag reference: `Tools/Spotify.help.md` or `--help`.

### Build a playlist

- `create-playlist --name "<name>" [--description "<d>"]` → returns the new ID.
- `search --query "<artist> <title>" --type track` → the `spotify:track:...` URI.
- `add-tracks --id <ID> --uris <uri,uri,...>` (comma-separated; batching is automatic).

### Search

`search --query "<q>" [--type track|album|playlist|artist] [--limit N]` — returns names + IDs/URIs used by every other command.

### Now playing / library

`now-playing` · `recent` · `queue` · `playlists` · `playlist-tracks --id <ID>` · `saved-tracks`

### Playback (Premium + active device)

- `devices` first — playback fails with no active device.
- `play [--uri <trackUri> | --context <albumOrPlaylistUri>] [--device <id>]` · `pause` · `next` · `prev`
- `add-to-queue --uri <trackUri>` · `volume --percent <0-100>`
