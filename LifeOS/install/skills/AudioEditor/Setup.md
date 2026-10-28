# AudioEditor

Status: command -v ffmpeg ffprobe insanely-fast-whisper · required

## What it does

AudioEditor cleans spoken recordings. Whisper transcribes the audio with word-level timestamps, Claude marks each segment to keep or cut (filler words, false starts, stutters, dead air), and `ffmpeg` makes the cuts with crossfades. Separate tools find and repair noise-gate ticks, soften loud breaths, and lock loudness to -14 LUFS. An optional cloud pass (Cleanvoice) removes mouth sounds. The edit pipeline runs on your machine plus your Claude subscription; the cloud pass uploads your audio.

## Fill in

No config file. Install the local tools:

```bash
brew install ffmpeg
pipx install insanely-fast-whisper
```

`ffmpeg` and `ffprobe` (installed together) run every cut and measurement. `Transcribe.ts` uses `insanely-fast-whisper` when it is on your PATH and falls back to the standard `whisper` command (`pip install openai-whisper`). If neither exists it stops with `No whisper variant found`. Analyze calls Claude through `LIFEOS/TOOLS/Inference.ts`, so the `claude` command must be logged in.

Optional: a `PREFERENCES.md` at `LIFEOS/USER/CUSTOMIZATIONS/SKILLS/AudioEditor/` overrides the defaults. The installer puts a starter there; if it is missing, `bun ~/.claude/skills/LifeOS/Tools/ScaffoldUser.ts --apply` copies any missing starter file into place and never overwrites one you have edited. Its keys, each optional:

- `Default cleaning mode`: standard or aggressive for a plain "clean this" request (default standard).
- `Polish`: whether the Cleanvoice pass runs unasked (default only when requested).
- `Delivery loudness`: the LoudnessLock target when none is named (default -14 LUFS / -1 dBTP).
- `Output format`: the file type cleaned audio is written as (default the tool's own).

## Accounts and secrets

Only the optional cloud polish step (`Polish.ts`, or `--polish` on the pipeline) needs an account. Open a Cleanvoice account (cleanvoice.ai), copy the API key from the dashboard settings, and add one line to `~/.claude/.env`:

```
CLEANVOICE_API_KEY=<your Cleanvoice API key>
```

Without it, `Polish.ts` prints `CLEANVOICE_API_KEY not found` and exits; everything else still works. After editing `.env`, run `bun ~/.claude/LIFEOS/TOOLS/Secrets.ts seal`.

## Prove it works

```bash
command -v ffmpeg ffprobe insanely-fast-whisper
D=$(mktemp -d) && ffmpeg -hide_banner -loglevel error -f lavfi -i "sine=frequency=440:duration=2" "$D/tone.wav" && bun ~/.claude/skills/AudioEditor/Tools/GateScan.ts "$D/tone.wav"; rm -rf "$D"
bun ~/.claude/LIFEOS/TOOLS/Secrets.ts has CLEANVOICE_API_KEY
```

Success: the first command prints a path for each tool. The second builds a two-second test tone, scans it, and prints `STEPS (audible gate ticks): 0` with exit code 0 (a scan that finds ticks exits 1). The third prints `yes` only if you set up the optional cloud polish.
