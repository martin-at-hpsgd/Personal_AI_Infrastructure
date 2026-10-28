# SecureByDesignQuestionsCheck

Checks a SecureByDesignQuestions output (`Intents/SecureByDesignQuestions.md`) against the parts of its contract that code can judge. Whether the questions are specific to the input, prioritized well and not already answered by it stays a judged check in the `fabric-securebydesignquestions` suite.

## Usage

```bash
bun skills/Fabric/Tools/SecureByDesignQuestionsCheck.ts <file|-> [--json]
```

| Flag | Meaning |
|------|---------|
| `<file\|->` | The saved output, or `-` for stdin |
| `--json` | Print `{ok, overviewWords, themes, questions, problems}` |
| `--help` | Print usage |

## Checks

- The output opens on `## OVERVIEW`, then `## SECURE BY DESIGN QUESTIONS`, in that order, each once. No text before the overview and no other `#` or `##` heading anywhere.
- The overview is one plain paragraph of 15 to 35 words (no list, no heading).
- The questions section holds only `### THEME` headings in capitals (no lowercase letters, no trailing colon) and `- ` bullets under them. Commentary lines, numbered lists and sub-bullets fail.
- At least three themes, no theme repeated, and no theme without a question.
- Each bullet is one question: it ends in `?`, carries no other `?`, and holds 10 to 30 words.
- 15 to 50 questions in all, and no question repeated.

Words split on whitespace; punctuation at a word's edges is ignored, a token of pure punctuation (an em-dash) is not a word, and a hyphenated compound or a number is one word.

## Exit codes

- `0` the shape holds
- `1` a rule failed; each failure prints as one `✗` line
- `2` bad usage or unreadable input
