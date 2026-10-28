# SummarizeCheck

Checks a Summarize output (`Intents/Summarize.md`) against the parts of its contract that code can judge. Whether the summary is faithful to its source, takes the right read and keeps takeaways distinct from points stays a judged check in the `fabric-summarize` suite.

## Usage

```bash
bun skills/Fabric/Tools/SummarizeCheck.ts <file|-> [--json]
```

| Flag | Meaning |
|------|---------|
| `<file\|->` | The saved output, or `-` for stdin |
| `--json` | Print `{ok, title, mainPoints, takeaways, problems}` |
| `--help` | Print usage |

## Checks

- The output opens on a `# Summary: <what was summarized>` title, with no other text before the sections.
- Exactly three `##` sections, in order: ONE SENTENCE SUMMARY, MAIN POINTS, TAKEAWAYS (a trailing colon on a heading is tolerated). No other heading appears.
- ONE SENTENCE SUMMARY is one line holding one sentence of at most 20 words, not a list item, and it does not open by describing the input ("This article discusses", "The author talks about", "In this video").
- MAIN POINTS holds 1 to 10 numbered items (`1. text`) of at most 16 words each; TAKEAWAYS holds 1 to 5 of at most 25 words each. Each list is numbered from 1 with no gaps, and a bullet or any other line inside a list fails.
- No item repeats another item or the one-sentence summary, and no two numbered items open on the same two words.
- No bold anywhere.
- Words split on whitespace; punctuation at a word's edges is ignored, a token of pure punctuation (an em-dash) is not a word, and a hyphenated compound or a number is one word.
- Everything from a `--- HARVEST ---` line on is the Harvest block and is not checked.

## Exit codes

- `0` the shape holds
- `1` a rule failed; each failure prints as one `✗` line
- `2` bad usage or unreadable input
