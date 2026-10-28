# AuditTransparencyCheck

Checks an AuditTransparency output (`Intents/AuditTransparency.md`) against the parts of its contract that code can judge. Whether the ratings are true to the input, the justification calls honest and the recommendations specific stays a judged check in the `fabric-audittransparency` suite.

## Usage

```bash
bun skills/Fabric/Tools/AuditTransparencyCheck.ts <file|-> [--json]
```

| Flag | Meaning |
|------|---------|
| `<file\|->` | The saved output, or `-` for stdin |
| `--json` | Print `{ok, verdict, opacity, recommendations, problems}` |
| `--help` | Print usage |

## Checks

- One H1 opening `# Transparency Audit: ` with nothing before it, and exactly eight H2 sections in order: SYSTEM ANALYZED, TRANSPARENCY VERDICT, STAKEHOLDER MAP, TRANSPARENCY AUDIT, OPACITY ANALYSIS, THE REVERSAL TEST, EXPLAINABILITY CHECK, RECOMMENDATIONS. No text between the title and the first section, and no asterisk outside inline code.
- SYSTEM ANALYZED is one prose paragraph of 10 to 90 words.
- TRANSPARENCY VERDICT is one line: TRANSPARENT, MOSTLY TRANSPARENT, PARTIALLY OPAQUE, SIGNIFICANTLY OPAQUE or DELIBERATELY OBSCURED, a colon, and a reason of 6 to 40 words.
- STAKEHOLDER MAP is a `| Party | Role | Information access | Power |` table of at least two rows. Role is Decision maker, Affected or Observer (two joined by `/` are allowed), access Full, Partial or None, power High, Medium or Low, and at least one Decision maker and one Affected party appear.
- TRANSPARENCY AUDIT is a `| Dimension | Rating | Evidence |` table with exactly the rows Decision, Algorithmic, Financial, Governance and Data in that order. Rating is Clear, Partial, Opaque, Unknown or Not applicable; evidence is 3 to 60 words.
- OPACITY ANALYSIS is a `| # | Opacity | Justified? | Who benefits | Who is harmed |` table of 0 to 10 rows numbered from 1. Justified is `Yes: <reason>`, `Partly: <reason>` (each reason three words or more) or `No`; both parties are named.
- The verdict agrees with the opacity rows: an empty table only under TRANSPARENT, never TRANSPARENT over a `No` row, and SIGNIFICANTLY OPAQUE or DELIBERATELY OBSCURED only with at least one `No` row.
- THE REVERSAL TEST is 1 or 2 prose paragraphs of 15 to 120 words, opening on Yes, No or Partly.
- EXPLAINABILITY CHECK holds one `Attempt:` paragraph of 25 to 120 words, then one `Result:` line opening on Yes, Partially, `No — the complexity is genuine` or `No — the complexity serves opacity` (a hyphen or en dash in place of the em dash is accepted), and nothing else.
- RECOMMENDATIONS are 1 to 8 bullets of 6 to 40 words. When the opacity table has rows, each bullet ends by citing them, such as `(#1, #3)`, every cited row exists, and every `No` or `Partly` row is cited at least once. When it has none, no bullet cites a row.

## Exit codes

- `0` the shape holds
- `1` a rule failed; each failure prints as one `✗` line
- `2` bad usage or unreadable input
