# CheckOpportunities

Checks the speaking opportunities list against the skill's code-checkable anti-criteria. Every entry outside an Archive section must carry a close date (a `Deadline`, `CFP Deadline` or `Closes` field; "Rolling" counts), a URL or contact, and a pay tier (`Pay Tier` or `Pay` field). An entry whose deadline date has passed is flagged unless it records a submission (the word "Submitted") or sits under Archive. A deadline with no four-digit year ("March 31") is never reported as passed, since it cannot be placed on a calendar. Topic fit is a judgment and is not checked here.

## Usage

```bash
bun skills/Speaking/Tools/CheckOpportunities.ts [listPath] [--json] [--today YYYY-MM-DD]
```

| Flag | Effect |
|------|--------|
| `listPath` | The list to check. Default `<configRoot>/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Speaking/Opportunities.md`, where configRoot is `$CLAUDE_CONFIG_DIR` or `~/.claude`. |
| `--json` | Print `{ path, findings: [{ entry, section, problem }] }` instead of one line per finding. |
| `--today` | The date the past-deadline check compares against. Default today. |

## Exit codes

- `0` clean
- `1` one or more findings
- `2` the list could not be read

## List shape it reads

Entries are `### ` headings; the `## ` heading above an entry is its section, and a section whose name contains "Archive" is skipped. Fields are bold labels in a table row (`| **Deadline** | April 15, 2026 |`) or a bullet (`- **Deadline:** April 15, 2026`).
