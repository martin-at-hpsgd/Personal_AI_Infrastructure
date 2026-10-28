# Loop

Runs the full quality loop: brief, direction, production by the domain skill, critique rounds to the bar, then gated hand-over.

## Ideal State

- The deliverable is a professional artifact with a written `Brief.json`, a resolved visual direction, and current passing evidence.
- The brief follows `../References/Rubric.md` and its filled example.
- The direction is a `Direction.md` synthesis from the Direction council, written before production.
- The artifact has a cross-vendor report from `Critique.md`, and each revision addresses ranked defects and has a new round preserving the prior report.
- The current artifact meets the overall bar (working bar 8.5) and both vendor floors (bar minus 0.5) with no UNKNOWN scores or critical defects.
- No run exceeds four critique rounds; this intent enforces the cap, since no CLI flag does.
- Hand-over uses `Deliver.md` only after a pass and completion of applicable domain verification.

## Anti-criteria

- A round-cap hit is never delivered as done; it is reported with the shortfall (which defects remain, what the last median was).
- An unavailable vendor is never quietly replaced by a single-vendor pass; it is reported as unavailable.
- Outstanding modality checks, including motion review when only sparse frames exist, are never left implicit, even if the panel passes.
- No score is inferred from an adjective.

## Tool contract

Production belongs to the appropriate image, motion, story-film, video-essay, web-design, or slide-production capability; the council contract is `Direction.md` and the score-recording one `Calibrate.md`, both in this directory. For still images, a round's critique runs through Art's `skills/Art/Tools/EvalRound.ts`, which runs it in parallel with the ladder and the tournament. For films, `skills/Art/Tools/EvalRound.ts --video` is the round runner: code gates on every film at once, k readings per film on one shared sample seed, and a keep only when the paired 95% CI lower bound against the incumbent is above zero.
