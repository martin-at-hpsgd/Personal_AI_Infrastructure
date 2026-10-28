# CompareAndContrastCheck

Checks a CompareAndContrast output (`Intents/CompareAndContrast.md`) against the parts of its contract that code can judge. It parses the GitHub-flavored table cell by cell. Whether the dimensions are the ones that matter, and whether each cell is accurate, stays a judged check in the `fabric-compareandcontrast` suite.

## Usage

```bash
bun skills/Fabric/Tools/CompareAndContrastCheck.ts <file|-> [--table-only] [--json]
```

| Flag | Meaning |
|------|---------|
| `<file\|->` | The saved output, or `-` for stdin |
| `--table-only` | The request said "just the table": the two closing lines must be absent |
| `--json` | Print `{ok, items, dimensions, problems}` |
| `--help` | Print usage |

## Checks

- Exactly one H1, first in the output, reading `# Compare and Contrast: {items and read}`.
- Exactly one table, directly after the title with nothing between them. Its second line is a separator row (`|---|---|`), and every row has as many cells as the header. A backslash-escaped pipe (`\|`) stays inside its cell.
- The first header cell is non-empty (it names what the items are). There are 2 to 10 item rows and 2 to 8 dimension columns.
- Item names are distinct, dimension headers are distinct and non-empty, and no header is a filler word: Overview, Description, Summary, Notes, Other, Miscellaneous, Misc, Details, General, Comments, Info.
- No cell is empty, a placeholder (N/A, NA, TBD, TBC, ?, a dash, an ellipsis, Varies, Depends, It depends, Unknown) or a `<br>` line break, and no cell runs past 15 words. `Not stated` is the allowed stand-in when a source is silent.
- No dimension gives every item the same answer (compared case-insensitively, markdown emphasis ignored).
- After the table: a `**In common:**` line, then a `**Key difference:**` line, each at most 40 words, and nothing after them. With `--table-only`, nothing at all follows the table.

Words split on whitespace; punctuation at a word's edges is ignored, and a hyphenated compound or a number is one word.

## Exit codes

- `0` the shape holds
- `1` a rule failed; each failure prints as one `✗` line
- `2` bad usage, an unknown flag, or unreadable input
