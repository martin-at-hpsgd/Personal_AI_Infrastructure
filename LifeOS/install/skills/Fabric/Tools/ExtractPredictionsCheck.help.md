# ExtractPredictionsCheck

Checks an ExtractPredictions output (`Intents/ExtractPredictions.md`) against the parts of its contract that code can judge. Whether each line is really a prediction the source made, and whether its confidence and date are the ones the predictor gave, stays a judged check in the `fabric-extractpredictions` suite.

## Usage

```bash
bun skills/Fabric/Tools/ExtractPredictionsCheck.ts <file|-> [--json]
```

| Flag | Meaning |
|------|---------|
| `<file\|->` | The saved output, or `-` for stdin |
| `--json` | Print `{ok, predictions, none, problems}` |
| `--help` | Print usage |

## Checks

- The output opens on one `# Predictions: ` title and carries no other heading.
- With no predictions, the title is followed by the single line `No predictions found in {the source}.` and nothing else.
- Otherwise the title is followed by a bulleted list (`- `), unindented and never numbered, then the table, with no other text. Each bullet holds 3 to 16 words (words split on whitespace; edge punctuation ignored, a hyphenated compound or a number is one word), and no two bullets are the same.
- The table header is exactly `| Prediction | Confidence | Date | How to Verify |`, then a four-column separator row, then one row per bullet, unbroken, in bullet order. Each Prediction cell repeats its bullet (case, spacing and a trailing period ignored).
- No cell is empty. Confidence and Date are never a placeholder (`N/A`, `-`, `TBD`, `unknown`, `none`, `?`); they read `Not stated` and `No date given` when nothing was given. How to Verify holds at least four words.
- No bold (`**`, `__`) or italics (`*x*`, `_x_`) anywhere. A `snake_case` word is not italics.

## Exit codes

- `0` the shape holds
- `1` a rule failed; each failure prints as one `✗` line
- `2` bad usage or unreadable input
