# RhetoricalLensCheck

Checks a RhetoricalLens output (`Intents/RhetoricalLens.md`) against the parts of its contract that code can judge. Whether the analysis is about how the text persuades rather than what it says, and whether each finding is specific to the text, stays a judged check in the `fabric-rhetoricallens` suite.

## Usage

```bash
bun skills/Fabric/Tools/RhetoricalLensCheck.ts <file|-> [--source <text-file>] [--max-words N] [--sections <list>] [--json]
```

| Flag | Meaning |
|------|---------|
| `<file\|->` | The saved output, or `-` for stdin |
| `--source <text-file>` | The text that was analyzed; every quotation must appear in it, the output carries no `**Source:**` line, and the analysis fits the word budget the text sets |
| `--max-words N` | Cap the analysis at N words; used for a bare named text or genre (800), and overrides the budget from `--source` |
| `--sections <list>` | Comma list of the sections a hint asked for: `ethos`, `pathos`, `logos`, `kairos`, `audience`, `techniques` (full names work too); the output must hold exactly those, in canonical order |
| `--json` | Print `{ok, sections, techniques, quotes, words, budget, problems}` |
| `--help` | Print usage |

## Checks

- Exactly one H1, opening `# Rhetorical Lens: ` and naming the text, with nothing before it.
- Between the title and the first section, only a `**Source:**` line and then an `**Answer:**` line, each at most once. With `--source`, a `**Source:**` line fails, because it is for analyses with no supplied text.
- The sections are exactly Ethos, Pathos, Logos, Kairos, Audience construction and Notable techniques in that order (case-insensitive), or the `--sections` subset in that order, and none is empty.
- When there is no `**Source:**` line (a text was supplied), Ethos, Pathos, Logos, Audience construction and Notable techniques each hold at least one double-quoted quotation, straight or curly. Kairos is about context and may quote nothing.
- With `--source`, every quotation appears in the source text. Matching ignores case, punctuation and apostrophes, and a quotation split by an ellipsis or a `[bracketed]` insertion matches when each fragment appears.
- Notable techniques holds only bullets (indented continuation lines are allowed), 1 to 10 of them, each opening on the technique's name and a colon, bold (`- **Anaphora:** …`) or plain, and, when a text was supplied, each pointing to a quotation.
- With `--source`, the analysis (headings excluded) fits the budget its length sets: 250 words for a text under 50 words, 600 under 300, 1000 under 1500, and 1500 beyond that. `--max-words N` sets the cap directly.

## Exit codes

- `0` the shape holds
- `1` a rule failed; each failure prints as one `✗` line
- `2` bad usage or unreadable input
