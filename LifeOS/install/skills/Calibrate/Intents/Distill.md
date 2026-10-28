# Distill

Turns the principal's labels and notes into the `Taste.json` the target's judge reads from then on.

## Ideal State

- `Taste.json` states what the principal likes and dislikes in the target's artifacts, in their register, specific enough that a judge looking at one image could apply it.
- Every principle cites the label ids it comes from, so any line can be traced to what the principal actually said.
- The new profile revises the existing one rather than starting over, and a principle is dropped only when newer labels contradict it.
- The written `Taste.json` is the draft as stamped by `taste --write`, and the answer reports what was added, changed or dropped since the last profile.

## Anti-criteria

- Nothing in it is a generic art-direction truism the judge already knows.
- No principle with no evidence or with an id that is not a current label.

## Output format

Write a draft JSON file in the scratchpad, then stamp it:

```json
{
  "summary": "Two or three sentences in plain words.",
  "likes":    [{ "principle": "Concrete, visible property", "evidence": ["S20260927-201500.3", "S20260927-201500.7"] }],
  "dislikes": [{ "principle": "Concrete, visible property", "evidence": ["S20260927-201500.2"] }]
}
```

## Inputs

```bash
bun skills/Calibrate/Tools/Calibrate.ts taste-input --target <t>   # every current label, notes, overall session notes, current labels_hash
```

Look at the images themselves (the `artifact` paths), not only the notes: a dislike with no note still says something, and the pattern across silent labels is often the most useful part. Keep the principal's own words where they said something sharp.

## Tool contract

```bash
bun skills/Calibrate/Tools/Calibrate.ts taste --target <t> --write <draft.json>
```

The tool refuses a principle with no evidence or with an id that is not a current label, and stamps `target`, `updated`, `labels_hash` and `label_count` itself.
