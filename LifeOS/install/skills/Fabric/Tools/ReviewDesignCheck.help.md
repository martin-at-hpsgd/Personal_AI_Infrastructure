# ReviewDesignCheck

Checks a ReviewDesign output (`Intents/ReviewDesign.md`) against the parts of its contract that code can judge. Whether the findings are specific to the design, invent nothing, and carry fixes worth acting on stays a judged check in the `fabric-reviewdesign` suite.

## Usage

```bash
bun skills/Fabric/Tools/ReviewDesignCheck.ts <file|-> [--source <design-file>] [--json]
```

| Flag | Meaning |
|------|---------|
| `<file\|->` | The saved output, or `-` for stdin |
| `--source <file>` | The supplied design text; every quoted evidence string must appear in it (case, whitespace and curly quotes ignored) |
| `--json` | Print `{ok, noDesign, reviews, problems}` |
| `--help` | Print usage |

## Checks

- An input with no design is the single line `No design: {what the input is instead}` and nothing else.
- Otherwise each review opens on `# Design review: {system}`, with nothing before the first one and no other top-level heading.
- The first line under the heading is `Verdict: {Sound | Sound with changes | Needs rework}.` followed by a reason. Only `Source:` and `Answer:` lines (at most one each) may sit between it and the first section.
- The H2 sections appear once each, in this order and with these exact words: Architecture and components, External integrations, Security, Performance, scalability and resilience, Data management, Maintainability and growth, Document readability, Assumptions, Strengths, Most critical changes. The review ends on its conclusion. No other section, no sub-headings, no sub-bullets, no empty section.
- Most critical changes holds one to five lines `{n}. {Area}: {change}`, numbered from 1, each naming one of the seven areas; the first names an area that holds a finding at the review's worst severity.
- Strengths are `- ` bullets. Assumptions open on `Stated:` or `Assumed:`.
- An area bullet is either `- {Critical | High | Medium | Low}: {finding}. Evidence: {evidence}. Fix: {fix}`, worst first, or a lone `- No issues: …` or `- Not applicable: …`. Evidence opens on a quotation, `Not stated`, or `Common practice`.
- The verdict follows the worst finding: Critical means `Needs rework`, High or Medium means `Sound with changes`, Low or none means `Sound`.
- No bold or italics outside code (`**x**`, `__x__`, `*x*`, `_x_`); underscores inside a word such as `invoice_id` are not italics.

## Exit codes

- `0` the shape holds
- `1` a rule failed; each failure prints as one `✗` line
- `2` bad usage or unreadable input
