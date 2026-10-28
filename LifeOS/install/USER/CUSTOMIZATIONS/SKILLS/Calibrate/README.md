---
provenance: template
version: 1.0.0
---

# Calibrate data

> Calibrate keeps its targets, labels, sessions and taste profiles here (`skills/Calibrate/SKILL.md` § Data & Config). The AddTarget intent creates this directory and each target folder; nothing needs to be filled in by hand. Override the root with `LIFEOS_CALIBRATE_DIR`.

Layout once a target exists:

```
Targets/
  example-target/
    target.json      # which eval suite and outputs the target covers
    Brief.json       # what the outputs were made for
    labels.jsonl     # like/dislike verdicts with optional notes
    sessions/        # one folder per review session
    artifacts/       # the outputs shown on the review page
    Taste.json       # the distilled taste profile the judge reads
    rescore.jsonl    # judge scores before and after the taste profile
```
