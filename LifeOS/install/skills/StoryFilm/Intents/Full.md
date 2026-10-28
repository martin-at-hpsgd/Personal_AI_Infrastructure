# Full

A story file in; a verified film out. Intake, then the Storyboard beside the narration, then Produce.

## Ideal State

- Intake runs only on a story whose last edit had the WriteStory `Revise` sweep (`AntiCliche.md` category 7: rhythm tells and narrator's asides), or after the principal was told it had not and declined that pass.
- `Beats.json` holds one beat per paragraph, verbatim, with scene indices from the story's `* * *` breaks, and title, author and voice from the frontmatter; read back, its beat count and scene count match the story as a reader would count them.
- `Storyboard.json` meets the Storyboard intent's Ideal State and `StoryboardLint.ts` exits 0 before any painting; when the principal asked for the checkpoint, the storyboard was shown and they gave a go.
- Narration was under way from the moment `Beats.json` existed. It ran beside the storyboard, its fresh-context review and the checkpoint, and then beside the bible and the shots, so time spent on the storyboard or waiting on the principal's go cost no narration time. The render waited for both the narration and every shot.
- The run meets the Produce intent's Ideal State for this story, in the runs root (skill config `runsRoot`, never inside a git repo): `Out/verify.json` green, the review sheets viewed by me, the critique passed, and the film plus sheets in the downloads folder.
- The report names beats and scenes, the runtime, shots painted vs cached, each verify check with its numbers, what I saw on the contact sheet and motion strip, and the downloads paths, with any check that did not pass named first.
- The film passed the Assay video eval set (`video-eval`) in Produce's verify stage, and the report names its verdict and any judged flags.

## Anti-criteria

- A story with no `audio_voice` and no stated preference never triggers a question: it gets the DA voice with a one-line ambiguity flag.
- Intake never starts on a story that has not had the `Revise` sweep since its last edit without first saying so and offering that pass.
- Nothing reaches the principal as a first draft: no film or sheets are copied to the downloads folder without a passing, fresh critique and a Proof receipt.
- Nothing uploads or publishes; everything stops at review.

## Evals

- compiled: the Assay video eval set (`video-eval`, `skills/Assay/Tools/VideoEval.ts`) as `Intents/Produce.md` declares it, run in `Run.ts`'s verify stage, plus the checks Assay compiles from the Ideal State and Anti-criteria above.

## Inputs

Needed before anything is built: the story file's path (a markdown file with paragraphs; `* * *` lines are scene breaks), and the run slug (defaults to the file's basename). Wanted, with reasoned defaults if absent: the voice (the story's `audio_voice` frontmatter; else the DA's main voice), captions (on), and whether the principal wants to see the storyboard before forty paintings are made (the default is a checkpoint; "straight through" skips it).

## Gotchas

The film reads the story verbatim, so any AI tell in the text is spoken aloud and lands harder than it does on a page, and a re-narration after a prose fix costs a full re-render (a first film once went out with narrator's asides in the read).

A story whose paragraphs are very long (over ~150 words) still gets one painting per paragraph; that is the format, not a defect.

## Tool contract

Intake stage:

```bash
bun ~/.claude/skills/StoryFilm/Tools/Setup.ts --check
bun ~/.claude/skills/StoryFilm/Tools/Intake.ts --story <path.md> [--run <slug>]
```

`Setup.ts [--check]` covers the painter dependency, the HyperFrames seam (pinned CLI, Chrome, GSAP), the serif, ffmpeg/whisper/tesseract. `Intake.ts` creates the run: `Beats.json` + `run.json`.

Narration, started in the background as soon as Intake has written `Beats.json` (it needs no `Storyboard.json`):

```bash
bun ~/.claude/skills/StoryFilm/Tools/Run.ts --run <slug> --from narrate --to narrate
```

Run.ts's own narrate leg later waits on `Narration/.narrate.lock` while this pass is still going, then reuses every beat it finished; run Produce without `--force`, or the leg re-takes every beat.

Produce stage (`Intents/Produce.md`, whose Tool contract carries the render → critique → `--deliver` order):

```bash
bun ~/.claude/skills/StoryFilm/Tools/Run.ts --run <slug> [--no-captions] [--concurrency 4]
```

What the principal says, mapped to flags:

| Principal says | Flag |
|---|---|
| "no captions", "just the pictures and the voice" | `--no-captions` |
| "use the DA voice", "read it in your voice" | `Narrate.ts --voice <DA voice id>` before Run, or omit `audio_voice` |
| "repaint everything" | `--force` (repaints and re-synthesizes; expensive) |
| "just re-render" | `--from build` |
| "check it again" | `--from verify` |
| "straight through", "no review" | skip the storyboard checkpoint |

