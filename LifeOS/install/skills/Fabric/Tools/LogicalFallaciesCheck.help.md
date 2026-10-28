# LogicalFallaciesCheck

Checks a LogicalFallacies output (`Intents/LogicalFallacies.md`) against the parts of its contract that code can judge. Whether each listed fallacy is really committed, and whether its explanation is specific to the argument, stays a judged check in the `fabric-logicalfallacies` suite.

## Usage

```bash
bun skills/Fabric/Tools/LogicalFallaciesCheck.ts <file|-> [--source <input-file>] [--json]
```

| Flag | Meaning |
|------|---------|
| `<file\|->` | The saved output, or `-` for stdin |
| `--source <input-file>` | The input text; every quote not marked `Common form:` must appear in it |
| `--json` | Print `{ok, none, fallacies, problems}` |
| `--help` | Print usage |

## Checks

- The first line is `## Fallacies` (any case), and there is no other heading.
- Every other non-blank line is either an item, `- {Name}: {Type} — "{quote}" — {explanation}`, with em-dashes and straight or curly double quotes, or the single line `None found: {reason}`. Anything else is commentary and fails, and so does a numbered list.
- Type is one of Formal, Propositional, Quantification, Syllogistic, Informal, Improper premise, Faulty generalization, Questionable cause, Statistical, Relevance, Red herring (any case).
- An explanation holds 1 to 15 words, and a `None found:` reason 1 to 30. Words split on whitespace; edge punctuation is ignored and a lone dash is not a word.
- The output is either items or the one `None found:` line, never both and never neither.
- No item repeats another (same name and same quote).
- No bold (`**`, `__`) or italic (`*word*`, `_word_`) markup.
- With `--source`: each quote not marked `Common form:` is split on `…` or `...`, and every piece appears in the input, compared case-insensitively with whitespace collapsed and curly quotes, apostrophes and dashes straightened.

## Exit codes

- `0` the shape holds
- `1` a rule failed; each failure prints as one `✗` line
- `2` bad usage or unreadable input
