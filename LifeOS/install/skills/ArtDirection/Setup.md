# ArtDirection

Status: command -v codex >/dev/null && test -f ~/.codex/auth.json && echo ok · required

## What it does

ArtDirection is the quality gate for artistic work: images, films, slides and site captures. It scores an artifact against a written rubric with two vision judges from different vendors (OpenAI and Anthropic), lists the defects in rank order, and refuses to hand the file over until the scores clear the bar. It also records your own scores as calibration labels. Which vendors may judge comes from one config key, `art_judges`.

## Fill in

Nothing in the skill needs editing. Your settings live in `LIFEOS/USER/CUSTOMIZATIONS/SKILLS/ArtDirection/` (the installer seeds them from the shipped templates):

| File | Key or section | What it does |
|---|---|---|
| `Config.md` | `art_judges: openai, anthropic` | The vendors allowed to judge art, comma-separated, from `openai`, `anthropic` and `google`. `--vendors` refuses any other, and the default panel is the reachable ones in this list. Required: a critique stops with an error naming the file and key when it is missing. |
| `Config.md` | `keeper_verdict: 7` | The lowest 1-10 human calibration score you would still keep. `Tools/Calibrate.ts` records a verdict at or above it as a pass on the one label store and below it as a fail. Required for calibration: `Calibrate.ts` stops with an error naming the file and key when it is missing. The critique panel's 8.5 delivery bar is separate. |
| `PREFERENCES.md` | everything after the first `---` rule line below the frontmatter | Install-specific judging rules (who may appear and how, house taste). `Critique.ts` appends them to `References/Rubric.md` in every judge prompt, and the critique's `check_set.version` hashes the two together. Optional. |

Each critique reads a `Brief.json` that you write per artifact; `skills/ArtDirection/References/BriefExample.json` is a filled example and `References/Rubric.md` is the schema.

Your calibration labels are appended to `labels.jsonl` in that same folder; the tool creates it on first use.

For films, `Critique.ts` samples frames with `ffmpeg` and `ffprobe` (install them with `brew install ffmpeg`). Still images need neither.

## Accounts and secrets

| Name | Needed for | Account to open |
|---|---|---|
| the `codex` command, logged in to ChatGPT (`codex login`, which writes `~/.codex/auth.json`) | the OpenAI vision judge, run as `codex exec -i` through the signed-in `codex` CLI; no OpenAI API key is read | A ChatGPT subscription |
| the `claude` command, logged in | the Anthropic vision judge | A Claude subscription; the judge calls the Claude CLI through `LIFEOS/TOOLS/Inference.ts` |

If you leave `--vendors` off, the panel is every vendor this machine can reach: OpenAI when `codex` is installed and logged in, Anthropic when the `claude` binary resolves. One reachable vendor still runs, but the report is flagged `vendor_missing` and a pass is weaker evidence. A vendor left out of `art_judges` is never seated.

## Prove it works

```bash
test -f ~/.codex/auth.json && echo codex-login yes
command -v codex claude ffmpeg ffprobe
bun ~/.claude/skills/ArtDirection/Tools/Critique.ts
bun ~/.claude/skills/ArtDirection/Tools/Deliver.ts
```

Success: the first command prints `codex-login yes`, and the second prints a path for `codex` and `claude` (plus `ffmpeg` and `ffprobe` if you will critique films). The last two run with no arguments, so they judge nothing and cost nothing: each prints its one-line usage (`Critique: Use --video <mp4> ... OR --image <png> ... --brief <Brief.json>` and `Use --artifact <file|deck.key> ... --to <dir>`). To see a real verdict, run `Critique.ts --image <png> --brief <Brief.json>` on an image you made; that makes judge calls to both vendors.
