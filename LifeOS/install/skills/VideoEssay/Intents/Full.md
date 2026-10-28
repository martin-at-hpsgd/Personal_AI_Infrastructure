# Full

Raw content → reviewed essay → script → verified video.

## Ideal State

- The rendered narration is exactly the approved `Essay.md` argument, and the essay, script and video each meet the Ideal State in their own intent file (`Argue`, `Script`, `Produce`).
- The essay was shown to the user before any render, unless the ask skipped the checkpoint; no other stage stopped to ask.
- The user reads the essay and finds it sharper than their own notes, then watches the render muted and cannot say a template made it.
- The final message carries everything listed under Output format, every open item included.
- The render passed the Assay video eval set (`video-eval`) as `Intents/Produce.md` states it.

## Anti-criteria

- A failing gate is never skipped; it is fixed.
- The checkpoint is never dropped unless the user says so in the ask.

## Evals

- compiled: the Assay video eval set (`video-eval`, `skills/Assay/Tools/VideoEval.ts`), run by `Run.ts`'s `eval` stage on every render, plus the checks Assay compiles from the Ideal State and Anti-criteria above.

## Output format

The final message names the thesis in one line, the essay path, the writing-audit line when an optional audit ran (`Intents/Argue.md`), the verify summary (checks green, WER, loudness), the eval set verdict with its flags, the frames read, the staged paths in `~/Downloads/`, and every open item: attribution uncertainties, pronunciation by ear, PII findings, publish decision.
