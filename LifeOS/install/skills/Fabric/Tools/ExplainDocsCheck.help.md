# ExplainDocsCheck

Checks an ExplainDocs output (`Intents/ExplainDocs.md`) against the parts of its contract that code can judge. Whether each command works and each option is real for a bare tool stays a judged check in the `fabric-explaindocs` suite.

## Usage

```bash
bun skills/Fabric/Tools/ExplainDocsCheck.ts <file|-> [--source <input-file>] [--tool <name>] [--json]
```

| Flag | Meaning |
|------|---------|
| `<file\|->` | The saved output, or `-` for stdin |
| `--source <input-file>` | The documentation the guide was built from: every long flag (`--name`) in the use cases and options must appear in it |
| `--tool <name>` | Every use-case command must contain this name as a word |
| `--json` | Print `{ok, noTool, title, sections, useCases, options, problems}` |
| `--help` | Print usage |

## Checks

- A whole output of the single line `**No tool to explain:** {what the input is}` passes, and any other line beside it fails.
- Otherwise exactly one bold title line comes before the first section.
- The four sections appear as H2 headings written exactly `## OVERVIEW`, `## HOW TO USE IT`, `## COMMON USE CASES`, `## MOST IMPORTANT AND USED OPTIONS AND FEATURES`, each once, in that order, each with a body. Any other H1 or H2 fails; `###` inside a section is allowed. Headings inside code fences are ignored.
- OVERVIEW has a `What It Does:` line and a `Why People Use It:` line, each 8 to 35 words.
- HOW TO USE IT has a `Most Common Syntax:` line and shows the syntax in a code block or inline code.
- COMMON USE CASES holds 3 to 10 entries, every list item written `- For {job}: \`command\``, with no `<file>` or `{name}` placeholder left in the command (shell `${VAR}`, redirects and find's `{}` are fine). Text in the section that is not an entry fails.
- MOST IMPORTANT AND USED OPTIONS AND FEATURES holds 3 to 15 entries, each opening on `` `flag` `` or `**feature**` then a colon, with at most 60 words of description. Indented sub-bullets belong to the entry above.
- No free-standing `Note:`, `Warning:` or `Disclaimer:` line and no closing offer ("let me know if", "hope this helps") anywhere outside code fences.

## Exit codes

- `0` the shape holds
- `1` a rule failed; each failure prints as one `✗` line
- `2` bad usage or unreadable input
