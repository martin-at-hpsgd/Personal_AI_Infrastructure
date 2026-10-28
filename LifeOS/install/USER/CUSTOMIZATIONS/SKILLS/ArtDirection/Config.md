---
provenance: template
version: 1.0.0
---

# ArtDirection — Config

Read by `skills/ArtDirection/Tools/Critique.ts` (`artJudges()`), which parses the `art_judges` line below. A missing file or key stops a critique with an error naming this file and the key.

## Judging panel

The vendors allowed to judge art, comma-separated, in any order. Valid names: `openai`, `anthropic`, `google`. A name left out is refused by `--vendors`, never seated by default, and never probed for reachability. Two vendors give the strongest evidence; one still runs but the report is flagged `vendor_missing`.

art_judges: openai, anthropic

Note here why you left any vendor out, so the choice survives later edits (for example: "google left out after its scores stopped moving with fixes, 2026-01-15").

## Calibration labels

Read by `skills/ArtDirection/Tools/Calibrate.ts` (`keeperVerdict()`). An integer 1-10: a human verdict at or above it is recorded as a pass on the one label store, and below it as a fail. A missing key stops a calibration with an error naming this file and the key.

keeper_verdict: 7

Set it to the lowest score you would still keep. The critique panel's delivery bar (an 8.5 median) is separate and does not read this key.
