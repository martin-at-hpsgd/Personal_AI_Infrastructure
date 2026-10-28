# EvalRound

One command for one image eval round. Every independent call runs in parallel, and a 4-candidate round is budgeted at 2 minutes or less.

```bash
bun ~/.claude/skills/Art/Tools/EvalRound.ts \
  --candidates a-thumb.png,b-thumb.png,c-thumb.png \
  --reference "<the 2–4 sentence argument summary from Essay Step 2>" \
  --brief <Brief.json> \
  --question "Which image would make a stranger feel this essay's argument: <one sentence>?" \
  --out <round dir> \
  [--incumbent <last round's winner>] [--generator nano-banana-pro] [--timeout 105] [--concurrency 16] [--critique-repeats 3] \
  [--min-width 1200] [--word-ratio 0.6] [--allow-identity] [--json]
```

`--candidates` also takes a quoted glob in place of the list: `--candidates "$HOME/Downloads/post-v2-*-thumb.png"`.

## What it runs

1. **Normalize alpha.** Transparent candidates are flattened onto the page ground (`thumbnailGround` in the Art USER `ArtConfig.json`, else `#F5F5F0`) with `magick -background <ground> -alpha remove -alpha off` into `<out>/judged/` before any stage sees them. Opaque candidates pass through untouched; the round record names both original and judged files.
2. **Assert gate.** `Assay/Tools/ImageAsserts.ts check` runs on every candidate at once. A candidate that fails never reaches a judge.
3. **Meaning ladder.** One `Assay/Tools/VisionJudge.ts ladder` call runs per survivor. It describes the image blind, grades that description on the four rungs, and returns the description too.
4. **Cross-vendor critique.** One `ArtDirection/Tools/Critique.ts --image` call runs per survivor, with three independent copies by default (`--critique-repeats 3`) so each vendor median has three samples. Each writes `<out>/critique/<name>/Critique.json`, paired to the judged file’s exact mtime for `Deliver.ts`.
5. **Flipped tournament.** One `Assay/Tools/Tournament.ts --json` call runs over the survivors, with the incumbent seeded first.

Stages 2–4 start together, so the tournament does not wait for the ladder. Each stage is its own subprocess with a hard deadline (`--timeout`, default 105s). A stage that times out or fails is reported as UNKNOWN for that candidate, and the round still finishes.

## Winner rule

A candidate is eligible only when it passes the assert gate, reaches ladder rung 3 or higher, and has no critical critique defect. Eligible candidates are ranked by these criteria in order:

1. Critique verdict is pass.
2. Critique median.
3. Stable tournament winner.
4. Tournament pair wins across both brackets.
5. Ladder rung.

On a full tie, the incumbent keeps its place. When nothing is eligible, `carryForward` names the closest candidate so the next round can use it as `--incumbent`.

## Output

- The table lists each candidate's assert result, rung, critique verdict with its median and per-vendor medians, and tournament wins.
- Under the table are each candidate's blind description, its top defects, the winner and the reason it won, and the elapsed seconds.
- `--json` prints the full record instead of the table.
- Every round writes `<out>/EvalRound.json` plus a timestamped copy.
- The record includes the tournament pair log, so a round can be audited later.

## Delivery

When the winner passes the critique, the output prints the Deliver command with that winner's own report:
`bun ArtDirection/Tools/Deliver.ts --artifact <winner> --critique <out>/critique/<name>/Critique.json --to <dir>`.

## Exit codes

- `0`: the winner clears the bar (critique pass and rung 3 or higher).
- `1`: no candidate clears the bar.
- `2`: survivors existed, but no judge produced a result.

## Film rounds (`--video`)

One command scores a whole round of HyperFrames films against the incumbent. It replaces the hand-rolled per-folder `score.ts`.

```bash
bun ~/.claude/skills/Art/Tools/EvalRound.ts --video \
  --candidates <dir> [<dir> ...] --incumbent <dir> --brief <Brief.json> --out <dir> \
  [--grid beat|eighth|words|none] [--bpm 120] [--words <vo-words.json>] [--tolerance-frames 2] [--k 3] [--seed n] [--vendors openai,anthropic] \
  [--fps 30] [--duration <s>] [--concurrency 8] [--hf-concurrency 1] [--timeout 300] [--critique-timeout 900] [--no-layout-qa] [--json]
```

Each film directory holds `master.mp4`, `index.html`, `hits.md` and, optionally, `proof.json`. Nothing is written into a film directory; `--out` may not sit inside one.

1. **Gates, every film at once.** `ffprobe` (1920x1080, `--fps`, the incumbent's length or `--duration` within 0.5 s, exactly one audio stream), `FilmStats.ts --json` (beatsPer10s >= 3, motion >= 0.015), `TextFit.ts --project --hits`, the seam `HyperFrames.ts check`, the beat grid, and `Proof.ts run` when `proof.json` exists. A candidate with any failed or errored gate is removed before judging. The incumbent's gates are recorded but never remove it. The hyperframes-backed gates (TextFit, seam check, Proof) run one film at a time by default (`--hf-concurrency 1`): side by side, the hyperframes CLI races on its own install and browser and reports good films as errors.
   - **Gate L (layout).** `TextFit.ts --project <dir> --every 0.5 --json` measures the whole film every half second, not only the hit times. Any finding of kind `occluded` (text over any other drawing, canvas, SVG or DOM), `canvas-text`, `connector` (a `data-joins` end more than 8 px off its target), `align` (a `data-align` element more than 4 px off), `clipped` or `frame` fails it. Findings of other kinds (`covered`, `truncated`, `optout`) stay gate T's and are named in L's evidence. It runs with the other hyperframes-backed gates under `--hf-concurrency`; on a long film raise `--timeout`.
   - **Gate Q (layout QA).** After the code gates, `Critique.ts --video <master> --out <round dir>/<film>/layout-qa --layout-qa --hits hits.md` (no `--brief`: layout QA refuses it) asks both approved vendors (Anthropic and OpenAI) four plain layout questions on each hit frame. Exit 1 (both vendors saw the same defect) fails it; any other non-zero exit, including a Critique.ts with no `--layout-qa`, is an error and also removes the film. Q runs on the incumbent and on every film whose code gates passed; a film a code gate already removed is not asked, because the vision calls cost money. `--no-layout-qa` skips Q for every film; the table legend and the notes say so.
2. **Beat grid.** Hit times come from the hits table's time column, found by its header (`s (sec)`, `time`). A number in a heading or note, such as "120 BPM", is never a hit. With no table, `<time>[s] <label>` lines are read. Every hit must sit within one frame of the grid: a beat is 60/bpm, an eighth is 30/bpm. With no `--bpm` the gate is skipped.
   - **Narrated films (`--grid words --words <vo-words.json>`).** The words file is a JSON array of `{t, s}`, `s` the word start in seconds. Every hit must sit within ±2 frames (at `--fps`) of some word start; `--tolerance-frames n` changes the 2. `--bpm` is not needed. A fail names the worst rows (`row 3 at 1.92 s is 3.0 frames from "collecting" (2.02 s)`). Narrated tables such as `| # | word | s (sec) | frame | error (frames) | what changes |` or `| word | time s | frame | change |` are read by the time header, never the frame or error column.
   - **`--grid none`** skips the gate (`.` in the table).
   - `--words` and `--tolerance-frames` are refused with any other grid.
3. **Readings.** Survivors and the incumbent each get `--k` Critique readings, all in parallel, all with one round seed (`--seed`, else random and recorded). Every reading of every film also gets `--sample-span <expected duration>` (the incumbent's length, or `--duration`), so sample i lands at the same time in every film even when their lengths differ by a few frames; round.json records it as `sampleSpan`. Each reading writes to `<out>/rounds/<stamp>/<film>/reading-<i>/`, so no film's own `Critique.json` is touched. If the installed Critique.ts lacks `--sample-seed`, `--sample-span` or `--vendors`, the round says so in its notes and does not pass them.
4. **Paired verdict.** Each sample's score is averaged across the k readings per vendor and paired with the incumbent's same sample index and vendor. Samples whose times differ by more than 0.05 s refuse the comparison. The mean difference and its 95% CI come from `Assay/Tools/Stats.ts`. A candidate is kept only when the CI lower bound is above zero.

`<out>/round.json` (and a copy in the round directory) holds the ranked rows: directory, master.mp4 sha256, every gate with its status and evidence, per-vendor medians, paired mean, CI and n, and the verdict (`keep`, `revert`, `gated`, `error`, `incumbent`). The table marks gates as `PFTSBRLQ` (probe, FilmStats, TextFit, seam, beat grid, Proof, layout, layout QA).

Exit codes: `0` a candidate clears the keep rule · `1` none does · `2` error (bad arguments, no incumbent reading, or every survivor's comparison refused).
