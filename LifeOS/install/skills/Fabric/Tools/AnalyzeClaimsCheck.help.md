# AnalyzeClaimsCheck

Checks an AnalyzeClaims output (`Intents/AnalyzeClaims.md`) against the parts of its contract that code can judge. Whether the evidence is real, the claims keep their stated scope and the grades are right stays a judged check in the `fabric-analyzeclaims` suite.

## Usage

```bash
bun skills/Fabric/Tools/AnalyzeClaimsCheck.ts <file|-> [--source <input-file>] [--json]
```

| Flag | Meaning |
|------|---------|
| `<file\|->` | The saved output, or `-` for stdin |
| `--source <input-file>` | The analyzed input; every fallacy quote, and every quoted passage of three or more words in a `From the text:` item, must appear in it |
| `--json` | Print `{ok, noClaims, claims, overall, problems}` |
| `--help` | Print usage |

## Checks

- The output is either the single line `**No truth claims:** <what the input is>` and nothing else, or the four sections `## Argument summary`, `## Truth claims`, `## Overall score`, `## Overall analysis`, each once and in that order, with nothing before the first.
- The Argument summary is one paragraph of at most 30 words; the Overall analysis is one paragraph of at most 40 words. Words split on whitespace, and a token of pure punctuation is not a word.
- Claims open on `### Claim N: <claim>`, numbered from 1 with no gaps, each of at most 16 words.
- Each claim has `**Support evidence:**`, `**Refutation evidence:**` and `**Logical fallacies:**`, each followed by bullets, then `**Rating:**` and `**Labels:**`. Any other line inside a claim fails.
- Each evidence bullet is `None known` (alone), starts `From the text:`, or names a source in parentheses that carries a year (`(Publisher, 2022)`).
- Each fallacy bullet is `None` (alone) or `Name: "exact words"`, with straight or curly quotes.
- The rating reads `<letter> (<word>): <reason>`, the letter one of A, B, C, D, F paired with its word exactly (A True, B Likely true, C Mixed, D Likely false, F False), and the reason at least three words.
- Labels are a non-empty comma-separated list.
- Overall score lists `Lowest claim score`, `Highest claim score` and `Average claim score` once each, in that order, as `- **<name>:** <letter>`, and each letter follows from the claim grades: the average maps A=4 to F=0, takes the mean and rounds half up.
- No template placeholder (`{...}`) is left in.
- With `--source`, quotes match after folding case, whitespace and curly quotes, and a quote with an ellipsis matches when each piece appears.

## Exit codes

- `0` the shape holds
- `1` a rule failed; each failure prints as one `✗` line
- `2` bad usage or unreadable input
