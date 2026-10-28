# BusinessIdeasCheck

Checks a BusinessIdeas output (`Intents/BusinessIdeas.md`) against the parts of its contract that code can judge. Whether each idea is a real business, specific to the input and faithful to it, and whether each pivot is a genuinely adjacent business with a real edge, stays a judged check in the `fabric-businessideas` suite.

## Usage

```bash
bun skills/Fabric/Tools/BusinessIdeasCheck.ts <file|-> [--extracted N] [--elaborated N] [--json]
```

| Flag | Meaning |
|------|---------|
| `<file\|->` | The saved output, or `-` for stdin |
| `--extracted N` | Require exactly N extracted ideas (the request named a count) |
| `--elaborated N` | Require exactly N elaborated ideas (default: the smaller of 10 and the extracted count) |
| `--json` | Print `{ok, none, extracted, elaborated, problems}` |
| `--help` | Print usage |

## Checks

- The output opens on `## Extracted Ideas`, followed by `## Elaborated Ideas`, once each and in that order. No other heading.
- Every item is a top-level numbered line (`1. `), numbered 1..n in order within its list. No `- ` bullets, no indented sub-items, no commentary lines, no bold or italic.
- Extracted: 1 to 40 items, each one sentence of 6 to 30 words ending in `.`, `?` or `!`, never narrating the source ("The author suggests…").
- Elaborated: exactly the smaller of 10 and the extracted count unless `--elaborated` pins it. Each item is 12 to 60 words (the pivot tag excluded), states the business in at least 6 words, then carries exactly one `Differentiator:` of at least 4 words, and ends on `Pivot from #k.` where k is an extracted idea's number. No two items pivot from the same k, and none restates its source idea word for word.
- Within each list, no item repeats another and no two open on the same first two words.
- Input with no business ideas is `## Extracted Ideas` and the single line `None found: {reason of at most 30 words}`, with no elaborated section.

Words split on whitespace; punctuation at a word's edges is ignored, and a token of pure punctuation (an em-dash) is not a word.

## Exit codes

- `0` the shape holds
- `1` a rule failed; each failure prints as one `✗` line
- `2` bad usage or unreadable input
