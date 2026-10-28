# SummarizeMeetingCheck

Checks a SummarizeMeeting output (`Intents/SummarizeMeeting.md`) against the parts of its contract that code can judge. Whether a decision was really agreed, whether an owner or deadline was invented, and whether each item is specific to the meeting stay judged checks in the `fabric-summarizemeeting` suite.

## Usage

```bash
bun skills/Fabric/Tools/SummarizeMeetingCheck.ts <file|-> [--json]
```

| Flag | Meaning |
|------|---------|
| `<file\|->` | The saved output, or `-` for stdin |
| `--json` | Print `{ok, title, sections, problems}`; `sections` lists each section with its count of real items |
| `--help` | Print usage |

## Checks

- The first line is the title `# Meeting Summary: <the meeting>`, and it appears once.
- The sections are `## OVERVIEW`, `## KEY POINTS`, `## TASKS`, `## DECISIONS`, `## CHALLENGES`, `## TIMELINE`, `## REFERENCES` and `## NEXT STEPS`, all present, in that order, with no other heading.
- OVERVIEW is exactly one line of prose of at most 25 words, not a list item.
- Each other section holds only `- ` items, or the single line `- None recorded.` alone: KEY POINTS 1 to 20 items, every other section 1 to 10, each item at most 25 words. Words count as in `WordSummaryCheck.ts` (whitespace-separated, edge punctuation ignored, a hyphenated compound or a number is one word).
- Every TASKS item reads `Owner: action (due <deadline>)`, with `Unassigned` as the owner and `not set` as the deadline when the meeting stated none.
- Every TIMELINE item reads `<date or milestone>: <what happens>`.
- No item text appears twice, within a section or across sections.
- Outside TASKS and TIMELINE (which open on owners and dates by design), no two items in a section open with the same three words.
- No bold or italics (`**`, `__`, `*word*`, `_word_`), no sub-bullets or indented lines, no numbered list items, and no text outside the title and sections.
- A line starting `--- HARVEST`, or a `> ` warning line that names Harvest, ends the summary; the Harvest result or warning block after it is not checked.

## Exit codes

- `0` the shape holds
- `1` a rule failed; each failure prints as one `✗` line
- `2` bad usage or unreadable input
