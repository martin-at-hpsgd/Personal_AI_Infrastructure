# StoicLensCheck

Checks a StoicLens output (`Intents/StoicLens.md`) against the parts of its contract that code can judge. Whether the reading traces where the text comes from rather than summarizing it, finds the unnamed sources, and attributes every view accurately stays a judged check in the `fabric-stoiclens` suite.

## Usage

```bash
bun skills/Fabric/Tools/StoicLensCheck.ts <file|-> [--source <text-file>] [--sections <list>] [--json]
```

| Flag | Meaning |
|------|---------|
| `<file\|->` | The saved output, or `-` for stdin |
| `--source <text-file>` | The text that was read; each lineage entry and the tensions section must hold a quotation found in it, and the output carries no `**Source:**` line |
| `--sections <list>` | Comma list of the sections a hint asked for: `lineage`, `tensions`, `questions`, `connections`, `seeds` (full names work too); the output must hold exactly those, in canonical order |
| `--json` | Print `{ok, nothingToTrace, sections, problems}` |
| `--help` | Print usage |

## Checks

- A text with nothing to trace is the single line `**Nothing to trace:** {what the text is}`, with something after the label and no other line.
- Otherwise the output opens on one H1, `# Stoic Lens: ` followed by what the text is.
- Between the title and the first section, only a `**Source:**` line and then an `**Answer:**` line, each at most once and never empty. With `--source`, a `**Source:**` line fails, because it is for readings with no supplied text.
- The sections are exactly Philosophical lineage, Key tensions and divergences, Unasked questions, Connections to other thinkers and Synthesis seeds in that order (case-insensitive), or the `--sections` subset in that order, and none is empty.
- Philosophical lineage holds only bullets, each opening `- **{Thinker, school or text}** (named|unnamed): ` with text after it. A bold label may hold an italic title (`**Epictetus, *Enchiridion* 1**`).
- Key tensions and divergences is prose: it fails when every line is a bullet.
- When there is no `**Source:**` line (a text was supplied), every lineage entry and the tensions section hold at least one double-quoted quotation, straight or curly. With `--source`, at least one quotation in each must appear in the source; quotations of other thinkers may sit beside it. Matching ignores case, punctuation and apostrophes, and a quotation split by an ellipsis or a `[bracketed]` insertion matches when each fragment appears.
- With `--source`, no quotation anywhere in the output is a near miss of the source: the same run of words with an inflection changed ("feel it fastest" for "feels it fastest"), or a run of four or more words with one word swapped. That is a misquote of the text, so it fails even where quotations of other thinkers are allowed.
- Unasked questions holds only bullets, each opening on its tradition or thinker in bold (`- **The Stoics:** `) and ending on a question mark, and at least one is attributed to a Stoic thinker or the Stoics.
- Connections to other thinkers holds only bullets, each opening `- **{Thinker, school or text}** ` and then `(converges)`, `(contradicts)`, `(converges and contradicts)` or `(both)`, and a colon.
- Synthesis seeds holds only bullets.
- No template placeholder (`{...}`, `named | unnamed`, `converges | contradicts`) is left in the output.

## Exit codes

- `0` the shape holds
- `1` a rule failed; each failure prints as one `✗` line
- `2` bad usage or unreadable input
