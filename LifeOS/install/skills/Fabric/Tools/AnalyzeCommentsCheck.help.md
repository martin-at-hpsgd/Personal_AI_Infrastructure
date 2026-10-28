# AnalyzeCommentsCheck

Checks an AnalyzeComments output (`Intents/AnalyzeComments.md`) against the parts of its contract that code can judge. Whether each point and count matches what the commenters actually said stays a judged check in the `fabric-analyzecomments` suite.

## Usage

```bash
bun skills/Fabric/Tools/AnalyzeCommentsCheck.ts <file|-> [--source <comments-file>] [--json]
```

| Flag | Meaning |
|------|---------|
| `<file\|->` | The saved output, or `-` for stdin |
| `--source <comments-file>` | The analyzed comments; every quoted comment must appear in them |
| `--json` | Print `{ok, noComments, verdict, counts, positives, negatives, problems}` |
| `--help` | Print usage |

## Checks

- Input with no comments is the single line `**No comments:** …` and nothing else.
- Otherwise the output opens on one `**Comments read:** …` line, then `## Comments sentiment`, `## Positives`, `## Negatives` and `## Summary`, once each and in that order, with no other section.
- The sentiment section is one line: `**<VERDICT>**: <p> positive, <n> negative, <m> neutral of <total> comments. <reason>`. The verdict is one of HATED, DISLIKED, NEUTRAL, LIKED, LOVED; p + n + m equals the total; LIKED and LOVED need more positive than negative comments, DISLIKED and HATED more negative than positive; the reason has at least three words.
- Each point reads `- <point> (<k> of <total>): "<exact words>"`, with the point at most 15 words, k from 1 to the total, the total equal to the verdict line's, and a non-empty quote. A list holds at most five points, ranked from the highest count to the lowest, with no point repeated. A list with no points is the single bullet `- None`.
- With `--source`, every quote appears in the comments (case, curly quotes, dash style and spacing are normalized; an ellipsis may join two pieces that each appear).
- The Summary is one line of prose of at most 20 words.
- No template placeholder (`{…}`, `HATED|DISLIKED`) is left in.

Words split on whitespace; punctuation at a word's edges is ignored, and a hyphenated compound or a number is one word.

## Exit codes

- `0` the shape holds
- `1` a rule failed; each failure prints as one `✗` line
- `2` bad usage or unreadable input
