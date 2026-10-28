# CheckAgreementCheck

Checks a CheckAgreement output (`Intents/CheckAgreement.md`) against the parts of its contract that code can judge. Whether each item is faithful to the document, whether the severities are right and whether the Responses ask for the right changes stay judged checks in the `fabric-checkagreement` suite.

## Usage

```bash
bun skills/Fabric/Tools/CheckAgreementCheck.ts <file|-> [--json]
```

| Flag | Meaning |
|------|---------|
| `<file\|->` | The saved output, or `-` for stdin |
| `--json` | Print `{ok, notAgreement, counts, problems}` |
| `--help` | Print usage |

## Checks

- A single `**Not an agreement:** …` line passes on its own; any other content beside it fails.
- At most one line before the sections, and only a `**Source:**` line.
- Exactly the sections `## Document summary`, `## Callouts`, `## Issues`, `## Responses`, in that order, with `### Critical`, `### Important`, `### Other` in that order inside Issues and nowhere else. Any other heading fails.
- The Document summary is one line holding one sentence of at most 30 words. Words split on whitespace; punctuation at a word's edges is ignored, and a hyphenated compound or a number is one word.
- Every item in Callouts, the severity groups and Responses is a numbered line `N. **label:** text`, numbered from 1 in each list. A bullet or a stray line fails.
- Callouts holds 1 to 10 items, each at most 20 words after its label.
- Each severity group is a numbered list or the single line `None.`; Issues holds at most 10 items in all, and no label is flagged twice.
- Responses holds exactly one item per Critical and Important issue, Critical first, in issue order, each labelled `Critical K, <issue label>` or `Important K, <issue label>` with the issue's label repeated exactly. With no Critical or Important issues, Responses is the single line `None needed.`
- No list repeats a label, and no two items in one list open on the same two words.
- No legal-advice disclaimer ("not legal advice", "consult a lawyer").

## Exit codes

- `0` the shape holds
- `1` a rule failed; each failure prints as one `✗` line
- `2` bad usage or unreadable input
