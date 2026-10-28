# PullRequestCheck

Checks a PullRequest description (`Intents/PullRequest.md`) against the parts of its contract that code can judge. Whether the description is true to the diff, its risks are specific and its test plan is honest stays a judged check in the `fabric-pullrequest` suite.

## Usage

```bash
bun skills/Fabric/Tools/PullRequestCheck.ts <file|-> [--json]
```

| Flag | Meaning |
|------|---------|
| `<file\|->` | The saved description, or `-` for stdin |
| `--json` | Print `{ok, title, sections, files, problems}` |
| `--help` | Print usage |

## Checks

- The first non-blank line is `# ` and a title of at most 72 characters, with no closing period, opening on an imperative verb (after an optional Conventional Commits prefix such as `feat(upload): `). Nothing comes before it, so a preamble or a code fence around the whole description fails.
- The `## ` sections are Summary, Files Changed, Code Changes, Reason for Changes, Impact of Changes, Risks and Test Plan, in that order, each present once and none empty, with an optional Additional Notes last. Any other `## ` section, a second `# ` heading, or text between the title and Summary fails. Headings inside fenced blocks are ignored.
- Every Files Changed line is a top-level bullet opening on the path in backticks and its status in parentheses (`added`, `modified`, `deleted`, or `renamed from` and the old path in backticks), then `: ` (or ` — `) and the change. At least one file is listed, and no path twice.
- Code Changes holds at least one fenced block, and every block there carries a language or `diff` tag.
- Risks has at least one `- ` bullet, and Test Plan has at least one `- [ ]` check.
- Every code fence is closed.
- No secret-shaped string (AWS access key, GitHub token, `sk-` API key, Slack token, Google API key, private key block) appears anywhere. The problem names the kind and never prints the value.

## Exit codes

- `0` the shape holds
- `1` a rule failed; each failure prints as one `✗` line
- `2` bad usage or unreadable input
