# ReportFindingCheck

Checks a ReportFinding output (`Intents/ReportFinding.md`) against the parts of its contract that code can judge. Whether the finding is accurate, specific to its input and free of invented facts stays a judged check in the `fabric-reportfinding` suite.

## Usage

```bash
bun skills/Fabric/Tools/ReportFindingCheck.ts <file|-> [--extra Name[,Name]] [--json]
```

| Flag | Meaning |
|------|---------|
| `<file\|->` | The saved output, or `-` for stdin |
| `--extra Name[,Name]` | Extra H2 sections the request asked for (for example `Trends,Quotes`), allowed after the five required ones |
| `--json` | Print `{ok, title, severity, sections, problems}` |
| `--help` | Print usage |

## Checks

- The first line is the one H1, `# {finding title}`, never empty and never the literal word "Title". Nothing comes before it, and nothing sits between it and the first section.
- The H2 sections are exactly `Description`, `Risk`, `Recommendations`, `References`, `One-Sentence Summary`, in that order, each once. Any further H2 fails unless it was passed with `--extra`.
- Description holds at least one line of prose, not bullets only.
- Risk opens on `Severity: Critical|High|Medium|Low|Informational`, then holds prose. A CVSS vector on that line (`CVSS:3.1/AV:N/AC:L/...`) must carry all eight base metrics with valid values.
- Recommendations holds at least two top-level bullets, and no two open on the same two words.
- References holds 1 to 5 bullets and nothing else; each is a named markdown link whose URL parses (WHATWG `URL`) as http or https with a dotted host, and no URL repeats.
- One-Sentence Summary is one sentence, not a bullet, ending in `.`, `!` or `?`, of at most 24 words.
- No bold (`**`, `__`), no italics (`*word*`, `_word_`), no numbered list items, and no code fence wrapping the whole output. Inline code, link targets and URLs are ignored for the emphasis check, and headings or list markers inside a fenced evidence block are not read as structure.

## Exit codes

- `0` the shape holds
- `1` a rule failed; each failure prints as one `✗` line
- `2` bad usage or unreadable input
