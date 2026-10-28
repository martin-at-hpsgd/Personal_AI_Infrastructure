# ExplainCodeCheck

Checks an ExplainCode output (`Intents/ExplainCode.md`) against the parts of its contract that code can judge. Whether the explanation matches what the code, configuration or tool output actually does stays a judged check in the `fabric-explaincode` suite.

## Usage

```bash
bun skills/Fabric/Tools/ExplainCodeCheck.ts <file|-> [--question] [--kind code|config|security] [--json]
```

| Flag | Meaning |
|------|---------|
| `<file\|->` | The saved output, or `-` for stdin |
| `--question` | The input asked a question (or was a bare question): `## ANSWER` must be present and first |
| `--kind K` | The input holds code, config or security tool output: `## EXPLANATION`, `## CONFIGURATION EXPLANATION` or `## SECURITY IMPLICATIONS` must be present. Repeat for a mixed input |
| `--json` | Print `{ok, sections, problems}` |
| `--help` | Print usage |

## Checks

- At least one section, and every H2 is one of the four upstream sections written exactly: `## ANSWER`, `## EXPLANATION`, `## SECURITY IMPLICATIONS`, `## CONFIGURATION EXPLANATION` (no trailing colon, upper case). No H1.
- Each section appears at most once, in that order, and has a body.
- Nothing before the first section: no title, preamble or persona line.
- No free-standing `Note:`, `Warning:` or `Disclaimer:` line, and no closing offer ("let me know if", "hope this helps").
- Headings and filler inside fenced code blocks are ignored, so quoted code and config can contain anything.
- With `--question`, `## ANSWER` is present and first; with `--kind`, the matching section is present.

## Exit codes

- `0` the shape holds
- `1` a rule failed; each failure prints as one `✗` line
- `2` bad usage or unreadable input
