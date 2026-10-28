# ExtractRecommendationsCheck

Checks an ExtractRecommendations output (`Intents/ExtractRecommendations.md`) against the parts of its contract that code can judge. Whether each line is really a recommendation, faithful to the source, tagged honestly and specific to the input, stays a judged check in the `fabric-extractrecommendations` suite.

## Usage

```bash
bun skills/Fabric/Tools/ExtractRecommendationsCheck.ts <file|-> [--json]
```

| Flag | Meaning |
|------|---------|
| `<file\|->` | The saved output, or `-` for stdin |
| `--json` | Print `{ok, recommendations, none, problems}`; each recommendation is `{text, implied}` |
| `--help` | Print usage |

## Checks

- The output opens on one `# Recommendations: ` title and carries no other heading.
- With no recommendations, the title is followed by the single line `No recommendations found in {the source}.` and nothing else.
- Otherwise the title is followed by a bulleted list (`- `), unindented and never numbered, with no other text.
- There are 1 to 20 bullets. Each holds 3 to 16 words, not counting a trailing `(implied)` tag (words split on whitespace; edge punctuation ignored, a hyphenated compound or a number is one word), and no two bullets are the same (case, spacing, a trailing period and the tag ignored).
- The tag is exactly `(implied)` at the end of the line. A variant (`(inferred)`, `[implied]`, `(Implied)` mid-line, `(implicit)`) fails.
- No untagged (stated) bullet follows a tagged (implied) one.
- No bold (`**`, `__`) or italics (`*x*`, `_x_`) anywhere. A `snake_case` word is not italics.

## Exit codes

- `0` the shape holds
- `1` a rule failed; each failure prints as one `✗` line
- `2` bad usage or unreadable input
