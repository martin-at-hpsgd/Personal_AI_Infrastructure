# ExtractInsightsCheck

Checks an ExtractInsights output (`Intents/ExtractInsights.md`) against the parts of its contract that code can judge. Whether each bullet is a real, surprising insight faithful to its source stays a judged check in the `fabric-extractinsights` suite.

## Usage

```bash
bun skills/Fabric/Tools/ExtractInsightsCheck.ts <file|-> [--count N] [--json]
```

| Flag | Meaning |
|------|---------|
| `<file\|->` | The saved output, or `-` for stdin |
| `--count N` | The number of insights the request asked for (default 10) |
| `--json` | Print `{ok, count, bullets, thin, problems}` |
| `--help` | Print usage |

## Checks

- The first line is one H1 heading opening on `INSIGHTS:` and naming the read (`# INSIGHTS: A Library's Case Against Late Fees`). No other heading appears.
- Every insight is a top-level hyphen bullet (`- `). A numbered item, a sub-bullet, or a `*` or `+` marker fails, and so does a bullet opening on bold.
- Exactly N bullets, unless the output closes on the one thin-source line `Only K of N: {why}`, in which case K equals the number of bullets given, N equals the `--count`, and K is less than N.
- Each bullet holds exactly eight words. Words split on whitespace; punctuation at a word's edges is ignored, a token of pure punctuation (an em-dash) is not a word, and a hyphenated compound, a contraction or a number is one word.
- No two bullets open on the same word (case-insensitive), and no bullet repeats another.
- Nothing else: no preamble, note or commentary before, between or after the bullets.

## Exit codes

- `0` the shape holds
- `1` a rule failed; each failure prints as one `✗` line
- `2` bad usage or unreadable input
