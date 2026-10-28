# Podcast

An audio file published as a fully published episode on the principal's Omny Studio program, with the program's configured settings (every configured playlist, Public, the configured EpisodeType and intro/outro and auto-level options, program-default artwork).

## Ideal State

- The episode meets every condition of "published" listed under Output format, and `OmnyPublish.ts` verified them and exited 0.
- The audio is the user's own episode, from a local file: their editor's export or their own recording.
- A live episode's description summarizes the episode in 1–2 house-style sentences passed with `--description`.

## Anti-criteria

- Never republishes someone else's audio or video; the source must be the user's own.
- A live publish never goes out with a description that reads wrong, such as a sponsor link standing in for the summary.

## Safety gates

**Review the description before a live publish** — it is the episode's summary on every podcast app. Pass `--description` with 1–2 house-style sentences (look at recent episodes).

## Tool contract

```bash
# One command: audio file → fully published episode
bun ~/.claude/skills/Broadcast/Tools/OmnyPublish.ts --audio /path/to/episode.mp3 --title "T" --description "D"

# Preview the exact API sequence without creating anything
bun ~/.claude/skills/Broadcast/Tools/OmnyPublish.ts --dry-run --audio /path/to/episode.mp3 --title "T" --description "D"

# Land as Draft instead of publishing, for a manual review in Omny first
bun ~/.claude/skills/Broadcast/Tools/OmnyPublish.ts --audio /path/to/episode.mp3 --title "T" --description "D" --draft
```

Env: `OMNYSTUDIO_API_KEY` (in `~/.claude/.env`). `--youtube` runs only where the install carries its own lane for it; elsewhere it exits 1 and says so. Program, playlists and episode settings come from Config.md (`Setup.md`). Exit codes: 0 published+verified, 1 error, 2 duplicate title, 3 settings mismatch after publish, 4 blocked by the send gate.

Feed check (IDs from `LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Broadcast/Config.md`): `curl -s "https://www.omnycontent.com/d/playlist/{omny_rss_container_id}/{omny_program_id}/{main omny_playlist_id}/podcast.rss" | grep "<title>Episode Title"`

## Gotchas

- **Omny Studio API mechanics (live-probed; the Management API has no public docs).** Create is `POST /v1/programs/{programId}/clips` — `POST /v1/clips` 405s. Only `Title` sticks at create; everything else is a follow-up `PATCH /v1/clips/{id}`. Descriptions set via `DescriptionHtml` — plain `Description` is silently ignored. **`PublishState` is silently ignored unless `Visibility` is in the same PATCH body** — send `{"PublishState":"Published","Visibility":"Public"}` together. Audio upload (`PUT /v1/clips/{id}/audio`) and publishing are both async: poll `State=Ready` before settings, then `PublishState=Published` after the publish PATCH. 429s carry `X-RateLimit-Reset` (seconds). All of this is encoded in `Tools/OmnyPublish.ts`.

## Output format

What "published" means (the tool verifies all of these):

PublishState=Published, Visibility=Public, exactly the `omny_playlist_ids` from Config.md (main RSS first), EpisodeType, IncludeIntroOutro and AutoLevelAudio equal to `omny_episode_type`, `omny_include_intro_outro` and `omny_auto_level_audio` (defaults Full, true, false), non-empty description. With intro/outro on, PublishedDurationSeconds runs longer than the raw audio by the program's intro and outro, which confirms the option took.
