# AnalyzeThreatReportCheck

Checks an AnalyzeThreatReport output (`Intents/AnalyzeThreatReport.md`) against the parts of its contract code can judge, per mode. Whether each item is faithful to the report, specific and non-generic stays a judged check in the `fabric-analyzethreatreport` suite.

## Usage

```bash
bun skills/Fabric/Tools/AnalyzeThreatReportCheck.ts <file|-> [--mode full|trends|cmds] [--json]
```

| Flag | Meaning |
|------|---------|
| `<file\|->` | The saved output, or `-` for stdin |
| `--mode` | `full` (default), `trends`, or `cmds` — the mode the output was written for |
| `--json` | Print `{ok, mode, title, sections, problems}` |
| `--help` | Print usage |

## Checks

All modes:

- The title line matches the mode (`# Threat Report Analysis:`, `# Threat Report Trends:`, or `# Threat Report Commands:`) and comes first.
- No bold or italics anywhere. Backtick code spans are allowed, so commands keep their formatting.
- No numbered list items; lists use `- ` bullets.
- The whole output is not wrapped in a code fence.
- No heading or text appears outside the title and the `##` sections.

Full mode:

- The sections are SUMMARY, TRENDS, STATISTICS, QUOTES, REFERENCES and RECOMMENDATIONS, in that order.
- SUMMARY is exactly one line, one sentence, at most 25 words.
- Every other section holds 1 to 50 `- ` items, or the single line `- None found.` A section may not mix `- None found.` with real items.
- No item repeats another item, within or across sections.

Trends mode:

- One TRENDS section, 1 to 50 `- ` items or `- None found.`

Commands mode:

- One or more `##` group sections, each with at least one `- ` item.
- At least one command line (a backtick code span or an indented line) is present.

## Exit codes

- `0` the shape holds
- `1` a rule failed; each failure prints as one `✗` line
- `2` bad usage or unreadable input
