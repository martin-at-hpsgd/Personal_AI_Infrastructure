# SummarizeDebateCheck

Checks a SummarizeDebate output (`Intents/SummarizeDebate.md`) against the parts of its contract that code can judge. Whether each argument sits under the side that made it, whether the primary disagreement is the real crux, whether the mind-changing evidence cuts against each side's reasons, and whether Common ground holds every concession stay judged checks in the `fabric-summarizedebate` suite.

## Usage

```bash
bun skills/Fabric/Tools/SummarizeDebateCheck.ts <file|-> [--json]
```

| Flag | Meaning |
|------|---------|
| `<file\|->` | The saved output, or `-` for stdin |
| `--json` | Print `{ok, notDebate, sides, problems}` |
| `--help` | Print usage |

## Checks

- A `Not a debate: …` answer is that single line and nothing else.
- At most one line before the first section, and only a `Source: …` line.
- The `##` sections, in order: Summary, Primary disagreement, `<Side>'s arguments` for each side, `What would change <Side>'s mind` for each side, Common ground, Argument strength, Prediction, Follow-up. No other heading level appears.
- Two to four sides, no side named twice, and the mind-changing sections name the same sides in the same order as the arguments sections (straight or curly apostrophes, case ignored).
- Summary is one sentence of at most 25 words; Primary disagreement is one sentence of at most 24 words. Words split on whitespace with edge punctuation ignored, as in `WordSummaryCheck`; common abbreviations (Dr., Mr., U.S.) do not end a sentence.
- Each side section holds one to ten `- ` bullets of at most 15 words, with no repeated bullet and no two bullets opening on the same two words.
- Every mind-changing bullet ends in `(stated)` or `(inferred)`, which is not counted as words; stated items come before inferred ones, and a side has at most three inferred items.
- Common ground is the single line `None stated.` or one to five `- ` bullets of at most 20 words with no repeated bullet; its bullets may open on the same words, since each names who conceded.
- Argument strength holds one `- <Side>: N/10. reason` line per side in side order, N a whole number from 1 to 10 with a reason of at least three words, then `- Winner: <Side or Draw>. reason` (a comma after the name, as in "Winner: Side A, narrowly.", is accepted).
- Prediction is prose (no bullets) and names at least one side, by its full name or its last word (a surname such as "Grant"), or says neither or both.
- Follow-up opens on one sentence, then one to five `- ` bullets and nothing else.
- No bold, no italics, and no numbered list lines anywhere.
- A `--- HARVEST ---` result block and everything after it is ignored, since the harvest side effect appends it.

## Exit codes

- `0` the shape holds
- `1` a rule failed; each failure prints as one `✗` line
- `2` bad usage or unreadable input
