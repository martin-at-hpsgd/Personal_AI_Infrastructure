# Rewrite

A minimal-diff rewrite of someone's text with its confirmed AI-isms fixed, plus the audit that justifies each edit. This is the skill's default intent.

## Ideal State

- **Context profile:** auto-detected from content cues (see AIWritingPatterns.md context profiles) and named in the report.
- **Audit:** every AI-ism identified, citing the specific text, under the tolerance matrix for the detected profile.
- **Rewrite:** a clean version with all AI-isms removed. Preserve structure, intent, and all specific details. Match voice to WRITINGSTYLE.md (or DA_IDENTITY.md § Writing Style for DA content). **Minimal-diff contract** (full text: `AIWritingPatterns.md` § Rewrite contract): edit only the sentences with confirmed findings, using the smallest repair; copy every other sentence byte-for-byte in its original order; with no findings, return the source unchanged and say so.
- Facts, numbers, dates, names, quotes, negations, and force-bearing "never / must / all / only" survive the rewrite unchanged.
- **Diff summary:** the major edits, listed briefly.
- **Second-pass audit:** the rewrite was re-read for surviving issues (recycled transitions, lingering inflation, copula avoidance, filler phrases); survivors are fixed inline and noted, or the audit says it is clean.
- When the findings are too pervasive for sentence-level repair to reach the bar, the report recommends a full rewrite (core point stated in one sentence, then rebuilt) instead of patching.

## Anti-criteria

- A catalog match alone never authorizes an edit: literal, domain-valid, quoted, and attributed uses are protected.
- Nothing is added that the source did not have.
- Never over-correct into staccato anti-slop prose. Long-form prose in the principal's voice runs `WriteAsPrincipal`, not bare Rewrite (`References/CompleteGuide.md` § Gotchas).
- A sentence with no confirmed finding is never reworded, reordered or dropped.

## Output format

```
**Profile:** [detected profile] | **Severity pass:** [P0+P1 / full]

**Issues found:**
- [P0] "[offending text]" — [category]
- [P1] "[offending text]" — [category]
- ...

**Rewritten version:**
[full rewritten content]

**What changed:**
- [brief summary of major edits]

**Second-pass audit:**
[any surviving issues fixed, or "Clean — no surviving AI patterns."]
```

## References

- `References/CompleteGuide.md` § References — the patterns catalog and voice files the audit reads, loaded with this intent by the `rewrite` bundle.
- `Intents/Detect.md` — the flag-only counterpart; `Intents/ScoreAI.md` reports a Pangram score for a text on request; the score is information, never a target for the rewrite.
