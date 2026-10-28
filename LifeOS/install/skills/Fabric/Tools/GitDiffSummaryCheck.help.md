# GitDiffSummaryCheck

Checks a GitDiffSummary commit message (`Intents/GitDiffSummary.md`) against the parts of its contract that code can judge. Whether the type fits the diff, and whether each bullet is true and specific to it, stays a judged check in the `fabric-gitdiffsummary` suite.

## Usage

```bash
bun skills/Fabric/Tools/GitDiffSummaryCheck.ts <file|-> [--json]
```

| Flag | Meaning |
|------|---------|
| `<file\|->` | The saved message, or `-` for stdin |
| `--json` | Print `{ok, header, bullets, breakingFooter, problems}` |
| `--help` | Print usage |

## Checks

- Line 1 parses as a Conventional Commits header, `type(scope)!: subject`, with the scope and `!` optional and the type one of `build`, `chore`, `ci`, `docs`, `feat`, `fix`, `perf`, `refactor`, `revert`, `style`, `test`.
- The whole subject line is at most 72 characters, has no closing period, and its first word is imperative. A first word in past tense (ending in "ed", common exceptions such as "embed" allowed), third person ("adds", "fixes") or gerund ("adding") fails.
- A blank line follows the subject, then the line `CHANGES:`, then 1 to 8 `- ` bullets. Each bullet holds 4 to 12 words and opens on an imperative verb by the same test. Words split on whitespace; a backticked identifier is one word, and a token of pure punctuation (an em-dash) is not a word. Duplicate bullets fail.
- No line starts with `#`: git strips such lines as comments when a message is edited in the commit editor, so a `## CHANGES` heading would vanish.
- No code fence, bold, sub-bullet or URL, and nothing before the subject.
- After the bullets, the only line allowed is one `BREAKING CHANGE: ` footer (`BREAKING-CHANGE:` also accepted), and it is present exactly when the subject carries `!`.
- A trailing Harvest block, from a `--- HARVEST ---` line (or a bare `---` rule whose remainder mentions Harvest) onward, is ignored, so a message can be checked with or without it. A trailing blockquote (`> …`) that mentions Harvest is read as the same block, since a Harvest warning is sometimes written that way.

## Exit codes

- `0` the shape holds
- `1` a rule failed; each failure prints as one `✗` line
- `2` bad usage or unreadable input
