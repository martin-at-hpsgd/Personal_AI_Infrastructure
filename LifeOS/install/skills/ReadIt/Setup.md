# ReadIt

Status: bun ~/.claude/LIFEOS/TOOLS/Secrets.ts has FISH_API_KEY · required

## What it does

ReadIt reads an article, a file, pasted text or your assistant's last answer aloud in your assistant's Fish Audio voice. The first chunk is synthesized, a detached player starts within a few seconds, and the rest is synthesized while earlier chunks play. `stop`, `pause`, `resume` and `status` act on the running read. It needs a Fish Audio account and a voice, because there is no local fallback voice.

## Fill in

**1. A voice profile** in `LIFEOS/USER/CONFIG/LIFEOS_CONFIG.toml` under your config root (`$CLAUDE_CONFIG_DIR`, else `~/.claude`). ReadIt uses `[da.voices.reader]` when it has a `fish_reference_id`, else `[da.voices.main]`, and `--voice <name>` picks any other `[da.voices.<name>]` section that has one. The file is created during the LifeOS install and must already carry `name` under `[principal]` and `[da]` and a `timezone` under `[principal]`, or the config will not load. Within the voice section the only field ReadIt needs is `fish_reference_id`. A made-up example:

```toml
[principal]
name = "Example Person"
timezone = "Europe/Berlin"

[da]
name = "Example"

[da.voices.main]
fish_reference_id = "EXAMPLEvoiceid000000"
fish_speed = 1.1
```

| Field | Meaning |
|---|---|
| `fish_reference_id` | The id of a voice in your Fish Audio library. Required. |
| `fish_speed` | Optional pace multiplier from 0.5 to 2.0, sent to Fish as prosody speed. Unset means 1.0. |

To read in a voice clone of your own, set `FISH_PRINCIPAL_VOICE_ID` in the env file to that voice's id and pass `--voice principal`.

**2. Pronunciations**, optional, in `LIFEOS/USER/PRINCIPAL/PRONUNCIATIONS.json`, applied on word boundaries to anything read. Use it for names the voice gets wrong. Without it nothing is rewritten.

## Accounts and secrets

- A Fish Audio account at <https://fish.audio>, with a voice you can use and enough credits for the text you read. Create an API key in the account's developer settings.
- Put the key in `~/.claude/.env` as `FISH_API_KEY=...` (the name only is shown here). The tool never prints it and never puts it in a URL. Where your install has `LIFEOS/TOOLS/Secrets.ts`, re-seal after editing with `bun ~/.claude/LIFEOS/TOOLS/Secrets.ts seal`.
- `ffprobe` (part of ffmpeg) must be on PATH: ReadIt measures the first chunk with it before playing. On a Mac, `brew install ffmpeg`. Without it a read stops with `ffprobe not found`.
- Playback is macOS `afplay`, so reading aloud works on a Mac only for now; other platforms stop with `playback needs macOS afplay`.
- A headless run (`LIFEOS_NOTIFICATION_CHANNEL=headless`, or no terminal) prints `skipped: headless` and exits 0 on purpose. Scheduled jobs never speak.

## Prove it works

```bash
bun ~/.claude/LIFEOS/TOOLS/Secrets.ts has FISH_API_KEY
command -v ffprobe
bun ~/.claude/skills/ReadIt/Tools/ReadIt.ts status
grep -n -A3 '^\[da.voices.main\]' ~/.claude/LIFEOS/USER/CONFIG/LIFEOS_CONFIG.toml
```

The first command prints `FISH_API_KEY yes` (and exits 0), or `no` and exits 1 if the key is missing. `command -v ffprobe` prints a path, and prints nothing if ffmpeg is not installed. `status` is read-only and prints `no reads yet` on a fresh install, or the state, title, chunk position and audio folder of the last read. The `grep` shows your `[da.voices.main]` section with a `fish_reference_id` line. Success is all four, and then a short read: ask your assistant to read a sentence aloud, or run `bun ~/.claude/skills/ReadIt/Tools/ReadIt.ts read --text "Reading works."` and hear it within a few seconds.
