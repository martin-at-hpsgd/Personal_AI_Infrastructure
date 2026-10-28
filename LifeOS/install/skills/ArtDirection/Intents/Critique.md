# Critique

Scores one artifact with two vendors' vision judges against the anchored rubric and returns ranked defects and a verdict.

## Ideal State

- A current `Critique.json` exists plus immutable round history, with both vendors' per-sample evidence, every rubric axis, ranked located defects, medians, and an honest pass/fail/unavailable verdict.
- The brief follows `../References/Rubric.md`.
- The verdict is pass only when both vendor medians reach bar minus 0.5, the pooled median reaches the bar, and no UNKNOWN or critical defect remains.
- Each run's defects are written into the artifact's `assay-receipt/1`, bound to the artifact's sha256.

## Anti-criteria

- Matching the brief alone never earns craft points.
- Contact strips never stand in for motion evidence: they support progression only, and missing motion evidence stays explicitly outstanding.
- A vendor with every sample unavailable yields `unavailable`, never described as a quality failure.

## Gotchas

- Video requires ffprobe/ffmpeg. Sampling skips the first and last 2%; one sample is the midpoint. `sharp` is optional: without it, no contact strip is built and motion review is an explicit outstanding item. Sparse strips cannot prove easing or audio sync; a panel pass is not complete motion verification.
- Each sample/vendor gets at most two attempts, and an UNKNOWN score blocks pass.
- Defects merge by normalized equality or containment of at least 12 characters; counts track distinct sample/vendor pairs within each merged group.
- `Critique.json` is the latest report; `Critique/round-N.json` preserves rounds. Round numbering counts existing round files, so retain contiguous history; collisions are refused, not overwritten.
- Identity-named headshot paths require explicit `--allow-identity`; the inference-disabled guard aborts even injected judge requests.

## Tool contract

```text
bun skills/ArtDirection/Tools/Critique.ts --video <mp4> | --image <png> [--images <glob>] --brief <Brief.json> [--bar 8.5] [--samples 12] [--concurrency N] [--vendors openai,anthropic] [--sample-seed <n>] [--sample-span <s>] [--out <dir>] [--json] [--allow-identity]
bun skills/ArtDirection/Tools/Critique.ts --video <mp4> --layout-qa --hits <hits.md> [--vendors openai,anthropic] [--max-frames 40] [--concurrency N] [--out <dir>] [--json]
```

`--layout-qa` is a separate mode with no brief: it cuts a full-resolution PNG 0.4 s after each hits.md time (the end of the reveal; times read by the column header, as EvalRound does), thinned evenly to `--max-frames` (default 40), and asks each approved vendor four yes/no questions per frame with a short where: text overlapping or touching another element; a line, curve or arrow not starting or ending on what it connects; something meant to be centred or aligned sitting off; anything cut off by the frame or a mask. It writes `LayoutQA.json` (`layout-qa/1`): per frame `{t, hit, file, answers per vendor}`, `findings` (every vendor in a two-vendor panel said yes to the same question on the same frame) and `flags` (one vendor yes). Exit 1 on any finding, 2 when there is none but a frame lacks a vendor's answer, 0 otherwise. Only the install's `art_judges`; a one-vendor panel is flagged `vendor_missing` and cannot produce a finding.

The pipe denotes alternatives, not a shell pipeline; exactly one media mode. Quote image globs. `--images` may also stand alone, using the first sorted match as the artifact; video cannot combine with images. The bar defaults to the brief, samples to 12, output to the artifact directory. `--vendors` names the panel from the install's `art_judges` (USER `Config.md`; any other vendor is refused); omitted, it is every approved vendor this machine can reach, and a one-vendor panel is flagged `vendor_missing`. `--sample-seed` (video only) jitters each sample time inside its slot so builders cannot know the frames in advance; the same seed repeats the same times, and the seed is recorded as `sampleSeed`. `--sample-span <s>` (video only) computes the times from that span instead of the file's own duration, each clamped to one frame before the end, so films of slightly different lengths in one round are sampled at the same times; it is recorded as `sampleSpan` (null without it, when times are exactly as before). The `assay-receipt/1` write appends to Proof's receipt when one is fresh, at tier `judge`, and an unearned finding is a flag that never blocks by itself. The critique counts as earned only when the `art-direction-critique` calibration reads earned against the principal's labels. The 8.5 working bar stays the ArtDirection rule that Deliver enforces. Exit codes are 0 pass, 1 fail/error, 2 unavailable. Motion is null on stills. `--json` adds the full report after the summary.
