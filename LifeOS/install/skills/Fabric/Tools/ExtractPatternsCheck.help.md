# ExtractPatternsCheck

Checks an ExtractPatterns output (`Intents/ExtractPatterns.md`) against the parts of its contract that code can judge. Whether each pattern truly recurs, whether its count matches the input, and whether the advice follows from the patterns stay judged checks in the `fabric-extractpatterns` suite.

## Usage

```bash
bun skills/Fabric/Tools/ExtractPatternsCheck.ts <file|-> [--count N] [--json]
```

| Flag | Meaning |
|------|---------|
| `<file\|->` | The saved output, or `-` for stdin |
| `--count N` | The pattern count the request asked for; requires exactly N patterns |
| `--json` | Print `{ok, none, patterns, problems}` |
| `--help` | Print usage |

## Checks

- The first line is a `# Patterns: ` title naming the source and the read.
- Either the none-found form (the title, `## Patterns`, and one `None found: …` line of at least three words, nothing else) or exactly five H2 sections in order: `## Patterns`, `## Meta`, `## Analysis`, `## Best N`, `## Advice for Builders`.
- Patterns: 1 to 50 `- ` bullets of 3 to 16 words, no two the same, no two opening on the same two words.
- Meta: one bullet per pattern, each at most 20 words and carrying a count in digits.
- Analysis: one line, not a list item, of 8 to 30 words.
- Best N: N is 5, or the pattern count when there are fewer than five; exactly N bullets of 8 to 30 words.
- Advice for Builders: 1 to 15 bullets of 4 to 15 words.
- No numbered lists, no nested bullets, no other heading levels, no text outside a section.

Words split on whitespace; punctuation at a word's edges is ignored, a token of pure punctuation (an em-dash) is not a word, and a hyphenated compound or a number is one word.

## Exit codes

- `0` the shape holds
- `1` a rule failed; each failure prints as one `✗` line
- `2` bad usage or unreadable input
