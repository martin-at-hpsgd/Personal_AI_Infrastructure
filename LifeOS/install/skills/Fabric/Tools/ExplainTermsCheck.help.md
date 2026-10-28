# ExplainTermsCheck

Checks an ExplainTerms output (`Intents/ExplainTerms.md`) against the parts of its contract that code can judge. Whether each definition is right and in the sense the content uses, whether each analogy maps how the term works, whether each "Why it matters" is specific to the input, and whether the right terms were picked stay judged checks in the `fabric-explainterms` suite.

## Usage

```bash
bun skills/Fabric/Tools/ExplainTermsCheck.ts <file|-> [--source <input-file>] [--count N] [--json]
```

| Flag | Meaning |
|------|---------|
| `<file\|->` | The saved output, or `-` for stdin |
| `--source <input-file>` | The input the terms came from; every term must appear in it |
| `--count N` | The exact number of terms a hint asked for ("the 3 hardest terms") |
| `--json` | Print `{ok, noTerms, heading, terms, problems}` |
| `--help` | Print usage |

## Checks

- The first line is one bold heading (`**Terms in the checkout postmortem**`).
- Every entry is a bullet at the left margin shaped `- **Term**: definition` (the colon may sit inside the bold, `- **Term:** definition`), followed by exactly two sub-bullets indented by two or more spaces or a tab: `- Analogy: …` first, then `- Why it matters: …`. A missing, repeated or out-of-order sub-bullet fails.
- A definition holds at most two sentences and 60 words; an Analogy or Why it matters holds at most two sentences and 40 words. Words split on whitespace; punctuation at a word's edges is ignored. Sentences split after `.`, `!` or `?` followed by a capital or digit, with common abbreviations (e.g., i.e., etc., vs., Dr.), single-letter initials, decimals and inline code kept whole.
- A definition does not open by restating its own term ("Jitter is…", "the term stochastic parrot…").
- No term is explained twice. A term written `Full name (ABBR)` counts as both its full name and its abbreviation, compared case-, punctuation- and hyphen-insensitively.
- A definition does not use a distinctive term (several words, an acronym, a hyphen or a digit) that is explained further down the list; that term goes first. Single everyday words are not tracked, so "key" in a definition never forces an entry named "Key" upward.
- Upstream's `-- Analogy:` lines fail: markdown folds them into the paragraph above.
- No numbered list, no template placeholder (`{…}`), and no other line.
- Input with no terms worth explaining is the single line `**No terms to explain:** …`, and nothing else.
- With `--source`, each term (either side of `Full name (ABBR)`) appears in the input, allowing a plural or singular form (`circuit breakers` matches `Circuit breaker`).
- With `--count N`, exactly N entries.

## Exit codes

- `0` the shape holds
- `1` a rule failed; each failure prints as one `✗` line
- `2` bad usage or unreadable input
