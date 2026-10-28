# ExtractIdeasCheck

Checks an ExtractIdeas output (`Intents/ExtractIdeas.md`) against the parts of its contract that code can judge. Whether each bullet is a real idea the source advances, stated faithfully and specifically, and whether the list is complete, stay judged checks in the `fabric-extractideas` suite.

## Usage

```bash
bun skills/Fabric/Tools/ExtractIdeasCheck.ts <file|-> [--count N] [--json]
```

| Flag | Meaning |
|------|---------|
| `<file\|->` | The saved output, or `-` for stdin |
| `--count N` | The request named a count ("the 10 most important"); require exactly N bullets |
| `--json` | Print `{ok, none, ideas, problems}` |
| `--help` | Print usage |

## Checks

- The first non-blank line is `## Ideas`, and there is no other heading.
- Every line after it is a top-level `- ` bullet, or the single `None found: {reason}` line (reason of 1 to 30 words). A numbered item, a `*` or `+` bullet, an indented sub-bullet, or any other line fails.
- Each bullet holds 4 to 15 words and ends on `.`, `?` or `!` (a closing quote or parenthesis after it is allowed). Words split on whitespace; punctuation at a word's edges is ignored, a token of pure punctuation (an em-dash) is not a word, and a hyphenated compound or a number is one word.
- No bullet narrates the source in place of the idea ("The author argues…", "This video explains…", "In the article, the speaker notes…").
- No bullet repeats another word for word, and no two bullets open on the same first two words (case ignored).
- No bold or italic markup anywhere.
- `None found:` never sits beside bullets, and appears at most once; an output with neither bullets nor the none line fails.
- With `--count N`, the list holds exactly N bullets.

## Exit codes

- `0` the shape holds
- `1` a rule failed; each failure prints as one `✗` line
- `2` bad usage or unreadable input
