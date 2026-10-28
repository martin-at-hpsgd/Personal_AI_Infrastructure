# Produce

The deterministic tail: the bible and shots beside the narration, then render → verification → review sheets → critique → delivery.

## Ideal State

- The run lives in the runs root (skill config `runsRoot`, never inside a git repo).
- `Bible/` holds a style plate and one reference sheet per bible entry, all painted from the same plate. The people are the people the story describes, at the age the story gives them.
- `Shots/` holds one painting per beat, 16:9, painted with the style plate and its reference sheets attached, hash-cached so an edited prompt repaints one beat.
- `Shots/contact-sheet.png` was compared with the bible sheets before the render, and no character's face on it differs from that character's sheet.
- `Narration/` holds per-beat chunks with word timings in the story's voice, one loudness-locked `narration.wav`, and `timeline.json` with offsets measured from the real chunk lengths, a short gap between beats and a longer breath at scene breaks.
- Narration ran beside the bible and the shots, never after them: it needs only `Beats.json`, so the voice was being synthesized while the paintings were being made. The render started only after both sides passed their checks, and a failure on either side stopped the run before the render, named in the output, with the other side's finished work kept in the cache.
- `Out/film.mp4` exists at 1080p30: title card, each painting moving under its beat (push, pull, pan, tilt, or a breathing hold), dissolves inside a scene, black at scene breaks, a caption line of the sentence being spoken with the spoken word brightened, an end card.
- `Out/verify.json` is green with `"complete": true` (every check present, taken on this exact film; a partial `--check` run never turns it green, and a film built with `--no-captions` reports the caption check as skipped). Every check is green: format, duration against the timeline, a non-degenerate frame for every beat, every beat visibly moving, whisper transcript on sampled beats within 8% WER, loudness at −16 LUFS ± 2, typed cards at both ends, and at three word midpoints the lit caption word (read by OCR) is the word whisper hears.
- `Out/review/contact-sheet.png` (a frame every 10 s) and `motion-strip.png` (6 frames per beat, one row per beat) exist and were looked at by me: a flat row on the strip is a still shot, a broken row is a clipped dissolve, and a face that changes between rows is a bible problem.
- `Out/Critique.json` is a passing ArtDirection critique of the exact `Out/film.mp4` bytes delivered. Its bar is the principal's euphoric-surprise test: the film feels made, not assembled; the characters are the same people first frame to last; nothing on screen fights the voice.
- The film plus sheets are in the downloads folder, landed by `Run.ts --deliver` only after that critique and a Proof receipt passed.
- The verify stage also ran the Assay video eval set (`video-eval`) on `Out/film.mp4`, beside `Verify.ts` and minus the checks `## Evals` switches off with their reasons: no check failed, no code check went unmeasured, and the report is at `Out/film.mp4.eval/video-eval.json`.

## Anti-criteria

- Nothing uploads or publishes; everything stops at review.
- No run dir under the config tree or the user-data repo, and no runs root inside a git repo.
- No `--force` on a large story without saying the cost first: it repaints every shot and re-synthesizes every beat.
- Nothing reaches the principal as a first draft: no film or sheets are copied to the downloads folder without a passing, fresh critique and a Proof receipt.
- A partial `--check` run never turns `Out/verify.json` green.
- The dimmed upcoming caption words are never brightened to silence `hyperframes check` contrast warnings.

## Evals

- compiled: the Assay video eval set (`video-eval`, `skills/Assay/Tools/VideoEval.ts`), run in `Run.ts`'s verify stage on every film, plus the checks Assay compiles from the Ideal State and Anti-criteria above.
  - disabled: duration, voice-identity, voice-wer, voice-pace, script-length, visual-variety, detail, card-corners — each reads a VideoEssay run's `Script.json`, narration timeline, voice records or capture list, which a StoryFilm run does not keep, so on its film they cannot measure.
  - disabled: type-rendered — the eval reaches the composition behind a video only through a VideoEssay run's `Out/render.json`, so on a StoryFilm film it cannot find the composition to read; `type-config` and `visual-judge-typography` still hold the type.
  - disabled: watermark-brand, watermark-badge, watermark-zone — a StoryFilm frame is the whole painting, with no channel mark and no DA badge corner.
  - disabled: format-4k, encode — StoryFilm masters at 1080p30 (Ideal State above, held by `Verify.ts` format) through the seam's default encode; the 4K x264 CRF ≤ 12 bar is the VideoEssay YouTube master's.
  - disabled: voice-dead-air — on a film with no VideoEssay timeline the narration span is the whole film, so the silent title and end cards and the longer breath at each scene break that this intent asks for read as dead air.

## Tool contract

```bash
bun ~/.claude/skills/StoryFilm/Tools/Run.ts --run <slug> [--from stage] [--to stage] [--force] [--no-captions] [--concurrency N] [--workers N] [--end-line "text"]
```

Stages: `lint`, then `bible → shots` side by side with `narrate`, then `build → verify → sheet` once both sides pass. `verify` also runs the Assay video eval set on the film beside `Verify.ts` (`bun ~/.claude/skills/VideoEssay/Tools/Run.ts eval --video <run>/Out/film.mp4 --intent ~/.claude/skills/StoryFilm/Intents/Produce.md`), and a blocking result fails the stage. `--from`/`--to` bound a range in the order `lint → bible → shots → narrate → build → verify → sheet`; a narrate-only range (`--from narrate --to narrate`) runs before `Storyboard.json` exists. Every stage is hash-cached; re-running after an edit re-does only what changed. Narration holds `Narration/.narrate.lock` from synthesis through its own verification, so a second narrator on the same run waits for the first; without `--force` it then reuses every chunk the first finished, and with `--force` it re-takes every beat. Every line a stage prints carries a `[stage] ` prefix, so the two legs' output can be told apart.

The order to the principal (principal directive, 2026-09-17: nothing this skill produces reaches the principal as a first draft):

1. A direction council through `Skill("ArtDirection")` before new or large work.
2. Render without `--deliver`.
3. Critique `Out/film.mp4` into `Out/Critique.json` with the cross-vendor panel (`skills/ArtDirection/Tools/Critique.ts`), which scores it against the rubric and names defects; iterate on those defects until the bar, or report the shortfall.
4. Deliver. Stages are hash-cached, so this re-renders nothing:

```bash
bun ~/.claude/skills/StoryFilm/Tools/Run.ts --run <slug> --from sheet --deliver [--critique <path/to/Critique.json>]
```

`--deliver` hands `Out/film.mp4` to `skills/ArtDirection/Tools/Deliver.ts`, which lands the film and `Out/review/` in `<downloads>/<slug>/` only with a passing, fresh critique of those exact bytes (`Out/Critique.json` by default) and a passing Proof receipt, and exits 1 otherwise. Record the principal's verdict with `skills/ArtDirection/Tools/Calibrate.ts`.

Individual tools for a single stage:

| Tool | Contract |
|------|----------|
| `Tools/Characters.ts --run <slug> [--force] [--only <id>] [--verify]` | style plate, then every character/place/object sheet against it |
| `Tools/Shots.ts --run <slug> [--force] [--only <beat>] [--concurrency N] [--verify] [--sheet]` | one painting per beat with refs attached; `--sheet` tiles them |
| `Tools/Narrate.ts --run <slug> [--force] [--verify] [--voice <id>]` | per-beat Fish Audio Drama 3 with word timestamps, hash-cached, `timeline.json` |
| `Tools/Build.ts --run <slug> [--no-captions] [--stage-only] [--workers N] [--end-line text]` | writes `Out/composition/` and renders `Out/film.mp4` through the HyperFrames seam (`--workers`: seam Chrome workers, default 1) |
| `Tools/Verify.ts --run <slug> [--check format\|duration\|frames\|motion\|speech\|loudness\|cards\|caption\|sheet]` | reads the film back; `Out/verify.json`; `sheet` writes the review pass |

The film renders through the shared seam `LIFEOS/TOOLS/HyperFrames` only (its README is the contract). `FilmTimeline.ts` turns the timeline into a frame-exact plan (windows, dissolves, caption and word timing, cards), `FilmComposition.ts` writes the project, `FilmRuntime.ts` + `Motion.ts` are bundled into the page to build the one paused GSAP timeline, and `SerifFont.ts` supplies the embedded serif. `node_modules/` is gitignored.

What the principal says, mapped to commands:

| Principal says | Command |
|---|---|
| "the sheets are wrong for X" | edit the bible desc → `Characters.ts --run <slug> --only <id>` → `Shots.ts --run <slug>` (shots carrying that ref repaint because their reference bytes changed) |
| "repaint beat 12" | edit the prompt → `Shots.ts --run <slug> --only b12` → `Run.ts --from build` |
| "re-narrate", "the voice is wrong" | `Narrate.ts --run <slug> --force [--voice <id>]` → `Run.ts --from build` |
| "render without captions" | `Run.ts --from build --no-captions` (the caption check is then reported as skipped) |
| "faster" / "the machine is busy" | `--concurrency 2` |
| "show me the shots" | `Shots.ts --run <slug> --sheet` and look at `Shots/contact-sheet.png` |

## Gotchas

- **The image model leaves a bare-paper margin around every painting no matter what the prompt says (2026-09-17, every shot of the proving run).** Prompting did nothing; `Paint.ts cropPaper` trims it at staging (bright flat rows and columns from each edge, at most 18% per side, then the largest 16:9 inside). Black letterbox bars are a different failure the crop does not catch: one flashback shot came back with them; a prompt that names the ceiling and the floor fixed it. Look at `Shots/contact-sheet.png` before rendering.
- **The last word of every Fish chunk can carry the chunk's trailing silence.** `alignmentToWords` clamps it; the caption highlight would otherwise sit on the last word for a second after the voice stopped.
- **Beat offsets come from ffprobe on the chunk wavs, never from the alignment's last character.** `Narrate.ts --verify` catches drift.
- **HyperFrames joins every local script into one, at the place of the first (2026-09-24, port).** A `<script src>` in `<head>` pulled the runtime ahead of the elements and the timeline never advanced; every script sits after the composition root.
- **Chrome will not load a font collection (.ttc) through @font-face**, and HyperFrames fetches any family without a face from Google Fonts (the seam refuses). `SerifFont.ts` extracts single faces; name a collection face as `path.ttc#<index>`.
- **`hyperframes check` reports contrast warnings on the dimmed upcoming words (0.42 alpha) by design.** They are warnings, not failures; do not brighten the words to silence them.
