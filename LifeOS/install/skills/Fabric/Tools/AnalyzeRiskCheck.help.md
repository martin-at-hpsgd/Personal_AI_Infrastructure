# AnalyzeRiskCheck

Checks an AnalyzeRisk output (`Intents/AnalyzeRisk.md`) against the parts of its contract that code can judge. Whether the evidence is tied to the input, whether any vendor fact was invented, and whether the controls fit the findings stay judged checks in the `fabric-analyzerisk` suite.

## Usage

```bash
bun skills/Fabric/Tools/AnalyzeRiskCheck.ts <file|-> [--json]
```

| Flag | Meaning |
|------|---------|
| `<file\|->` | The saved output, or `-` for stdin |
| `--json` | Print `{ok, noVendor, assessments, problems}` |
| `--help` | Print usage |

## Checks

- The output is either the single line `**No vendor:** {what the input is}` or one or more `## Vendor risk: {vendor} for {use}` blocks, with nothing before the first block.
- Each block opens on `**Risk:** {Low|Medium|High}: {reason}`, then `**Data:** {Public|Internal|Confidential|Restricted}: {what}`; only `**Source:**` and `**Answer:**` lines may follow before the sections.
- The sections are exactly Assumptions, Findings, Compliance, Required controls, What would change the rating, in that order.
- Every assumption opens on `**Stated:**` or `**Assumed:**`.
- Findings is a `| Area | Finding | Evidence | Effect |` table whose areas come from Data, Security, Privacy, Terms, Breach notice, each present at least once; effects are Raises, Lowers or Neutral; evidence is a quote, a public fact, or `Not stated`.
- Compliance is a `| Obligation | Why it applies | Status | Evidence |` table with statuses Met, Gap or Unknown, optionally followed by one `**Ruled out:** {why}` line, or the single line `**None apply:** {why}`. Any other line in the section fails.
- Each control is `N. **{Implementer|User|Procurement}:** {control}. Answers: {finding}`, numbered from 1; the owner may name the role in parentheses (`**User (registrar):**`).
- What would change the rating holds one to three `- {fact} → {rating}` lines, each naming a rating other than the current one.
- The rating agrees with the rest: never Low for Restricted data with a compliance Gap, never Low for Confidential or Restricted data with both a raising finding and a Gap, never High with no raising finding and no Gap, and never High for Public data on fewer than two raising findings with no Gap.
- No `{…}` template placeholder is left anywhere the checker reads.

## Exit codes

- `0` the shape holds
- `1` a rule failed; each failure prints as one `✗` line
- `2` bad usage or unreadable input
