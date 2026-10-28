# StoryFilm

Status: bun ~/.claude/skills/StoryFilm/Tools/Setup.ts --check >/dev/null 2>&1 && echo ok · required

## What it does

StoryFilm turns one story markdown file into a narrated, animated film: one painting per paragraph, a spoken reading with word timings, and a rendered, verified video. The paintings come from Google's image model, the voice from Fish Audio, and the video is rendered and checked on your machine. All of that needs two paid accounts, two keys and a few command-line programs before the first run.

## Fill in

Three small pieces. All are optional because the skill has defaults, but you will want the first one.

**1. The story file.** Any markdown file. Frontmatter is read when present, and a line of `* * *` starts a new scene. A made-up example:

```markdown
---
title: The Lantern Keeper
author: A. Example
audio_voice: fish:EXAMPLEvoiceid000000
---

The keeper climbed the stairs every evening, counting them as he went.

* * *

By morning the lamp had burned down to a thread of blue.
```

| Field | Meaning |
|---|---|
| `title`, `author` | Used on the title cards. |
| `audio_voice` | A Fish voice: `fish:<reference id>` from your Fish Audio library, a role (`main`, `presenter`, `principal`), or the `voice_id` of a `[da.voices.*]` profile in your LifeOS config that has a `fish_reference_id`. Leave it out and the skill uses the assistant's main voice from your LifeOS config; if neither exists, narration stops with "no voice". Any other id stops with an error naming where to add one. |

**2. Config.json** (optional) at `LIFEOS/USER/CUSTOMIZATIONS/SKILLS/StoryFilm/Config.json` under your config root (`$CLAUDE_CONFIG_DIR`, else `~/.claude`):

```json
{
  "runsRoot": "~/StoryFilms",
  "fonts": { "serif": "~/Fonts/ExampleSerif-Regular.otf", "serifItalic": "~/Fonts/ExampleSerif-Italic.otf" },
  "provingRun": "the-lantern-keeper"
}
```

| Field | Meaning |
|---|---|
| `runsRoot` | Where each film's working folder goes. Default `~/StoryFilms`; `LIFEOS_STORYFILM_DIR` overrides it. It must not sit under `~/.claude` or the user-data repo. |
| `fonts.serif`, `fonts.serifItalic` | Paths to font files you are licensed to embed, for the captions and cards. Without them the default serif is used: Source Serif 4 (SIL Open Font License), installed by `Setup.ts`. Its Latin subset covers English; configure a fuller face for other scripts. |
| `provingRun` | The run slug the skill ISA's proving-run checks target. `Setup.ts --proving-run` prints it and exits 1 naming this file and key when it is unset. Only needed if you run those checks. |

**3. PREFERENCES.md** (optional) beside Config.json: your casting and register taste, read by the Storyboard intent. `## Casting` says how to describe people where the story is silent, `## Register` names one tone for every shot, `## Style precedent` records a style that worked. With no file, the story decides.

## Accounts and secrets

Add two keys to `~/.claude/.env` (a third, `FISH_PRINCIPAL_VOICE_ID`, only for the `principal` role), one `NAME=value` line each, then seal the file the way your install requires:

- `FISH_API_KEY`: open a Fish Audio account at <https://fish.audio> and create an API key in its developer settings. Narration calls its text-to-speech endpoint with word timestamps. To narrate in a voice clone of your own, also set `FISH_PRINCIPAL_VOICE_ID` to that voice's id and use `audio_voice: principal`.
- `GOOGLE_API_KEY`: open a Google AI (Gemini API) account. Paintings come from its image model at 16:9, 2K.

Programs on your PATH: `ffmpeg` and `ffprobe` (required), and `whisper` and `tesseract` (they feed the verification step, which reports a failure if they are missing). Chrome, the HyperFrames renderer and GSAP are fetched on the first render, which is the one step that reaches the network for tooling.

Check that the keys are present without printing them:

```bash
bun ~/.claude/LIFEOS/TOOLS/Secrets.ts has FISH_API_KEY GOOGLE_API_KEY
```

## Prove it works

```bash
bun ~/.claude/skills/StoryFilm/Tools/Setup.ts --check
```

It provisions nothing and fails on anything missing. Success is a list of check marks ending with `ffmpeg ok`, `ffprobe ok`, `whisper ok` and `tesseract ok`, with a `serif:` line saying `(default: Source Serif 4)` or `(configured)`. On a working install it prints:

```
✓ deps ok
✓ serif: normal + italic (default: Source Serif 4)
✓ hyperframes 0.8.71 (provisioned on first render)
✓ ffmpeg ok
✓ ffprobe ok
✓ whisper ok
✓ tesseract ok
```

A line that says `MISSING` names the program to install. To prove the story file reads, run `bun ~/.claude/skills/StoryFilm/Tools/Intake.ts --story <your-story.md>`: it creates a run folder under `runsRoot` and prints the beat and scene counts, with no paid call. Then ask your assistant "film this story".
