# Calibrate

Records the principal's own verdict on one artifact as an appended calibration label.

## Ideal State

- An appended label preserves the principal's own verdict and note against the exact artifact, with hash, mtime, date, and the adjacent critique median when available (a null median when the adjacent critique JSON is missing or malformed).
- The verdict is an integer 1–10 from the principal, and the note keeps the principal's own words.
- The label appends to `~/.claude/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/ArtDirection/labels.jsonl` and existing labels remain intact.

## Anti-criteria

- Never fabricates a numeric verdict: if only qualitative feedback exists, a numeric verdict is requested instead.
- This tool never trains judges or alters the rubric automatically.

## Tool contract

```text
bun skills/ArtDirection/Tools/Calibrate.ts --artifact <file> --verdict <1-10> --note "<text>"
```

Success prints the label as JSON; errors exit 1.
