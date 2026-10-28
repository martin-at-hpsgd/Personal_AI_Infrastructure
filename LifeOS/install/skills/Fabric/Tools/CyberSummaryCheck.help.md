# CyberSummaryCheck

Checks a CyberSummary output (`Intents/CyberSummary.md`) against the parts of its contract that code can judge. Whether each item is correctly classified, specific and faithful to its source stays a judged check in the `fabric-cybersummary` suite.

## Usage

```bash
bun skills/Fabric/Tools/CyberSummaryCheck.ts <file|-> [--json]
```

| Flag | Meaning |
|------|---------|
| `<file\|->` | The saved output, or `-` for stdin |
| `--json` | Print `{ok, title, sections, problems}`; `sections` lists each section with its count of real items |
| `--help` | Print usage |

## Checks

- The first line is the title `# Cyber Summary: <what was summarized>`, and it appears once.
- The sections are `## SUMMARY`, `## ADVISORIES`, `## INCIDENTS`, `## MALWARE` and `## VULNERABILITIES`, all present, in that order, with no other heading.
- SUMMARY is exactly one line holding one sentence of at most 25 words, not a list item.
- Each of the other four holds only `- ` items: 1 to 10 of them, each at most 25 words, or the single line `- None reported.` alone. Words count as in `WordSummaryCheck.ts` (whitespace-separated, edge punctuation ignored, a hyphenated compound, a CVE ID or a number is one word).
- No item text appears twice, within a section or across sections.
- No bold or italics (`**`, `__`, `*word*`, `_word_`), no sub-bullets or indented lines, and no text outside the title and sections.

## Exit codes

- `0` the shape holds
- `1` a rule failed; each failure prints as one `✗` line
- `2` bad usage or unreadable input
