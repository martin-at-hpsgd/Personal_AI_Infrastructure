# WordSummaryCheck

Checks a WordSummary output (`Intents/WordSummary.md`) against the parts of its contract that code can judge. Whether each level carries the subject's essence stays a judged check in the `fabric-wordsummary` suite.

## Usage

```bash
bun skills/Fabric/Tools/WordSummaryCheck.ts <file|-> [--levels N] [--json]
```

| Flag | Meaning |
|------|---------|
| `<file\|->` | The saved output, or `-` for stdin |
| `--levels N` | The level count the request asked for (default: the first level's number) |
| `--json` | Print `{ok, levels, problems}` |
| `--help` | Print usage |

## Checks

- Exactly N levels, each opening on its number in bold (`**5.**`), counting down from N to 1 in order. A line opening on plain list syntax (`5. text`) fails, because markdown renders a list starting at 5 as 5, 6, 7.
- Level k holds exactly k words. Words split on whitespace; punctuation at a word's edges is ignored, a token of pure punctuation (an em-dash) is not a word, and a hyphenated compound or a number is one word.
- A blank line separates each level from the next.
- No level repeats the level above, and no level of two or more words is the level above with words deleted (its words appearing in order inside the line above), which is truncation rather than a reframe.
- At most one line (the heading) before the levels, nothing between them, and at most one line (the cap note) after.

## Exit codes

- `0` the shape holds
- `1` a rule failed; each failure prints as one `✗` line
- `2` bad usage or unreadable input
