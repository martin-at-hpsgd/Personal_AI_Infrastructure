# EthicalFrameworkCheck

Checks an EthicalFramework output (`Intents/EthicalFramework.md`) against the parts of its contract that code can judge. Whether the quotations appear in the text, whether protections are kept apart from violations, and whether each finding is sound stay judged checks in the `fabric-ethicalframework` suite.

## Usage

```bash
bun skills/Fabric/Tools/EthicalFrameworkCheck.ts <file|-> [--json]
```

| Flag | Meaning |
|------|---------|
| `<file\|->` | The saved output, or `-` for stdin |
| `--json` | Print `{ok, noPrescriptive, problems}` |
| `--help` | Print usage |

## Checks

- A text that prescribes nothing is the single line `**No prescriptive content:** {what the text is}`, with nothing else.
- Otherwise the output opens on `## Document analyzed` with no preamble, and holds the nine sections exactly once and in order: Document analyzed, Explicit ethical claims, Implicit ethical framework, Internal consistency, Minimal ethics evaluation, Hidden coercion, Overall assessment, Key concerns, Recommendations. No other H2 is allowed and no section is empty.
- Document analyzed has a description of the text, and at most one non-empty `**Source:**` and one non-empty `**Answer:**` line.
- Explicit ethical claims are bullets (or the line `None stated.`). Without a `**Source:**` line, meaning a text was supplied, every bullet opens on a quotation.
- Implicit ethical framework holds the six parts as H3s in order (Moral patients, Harm, Consent, Authority, Coercion, Value hierarchy), none empty.
- Internal consistency has its four verdicts in order, each `Holds` or `Fails` with a reason, and a `**Contradictions:**` line. A failed "Principles compatible" or "Applies to itself" with `None found` fails, and so do contradictions listed while all four checks hold.
- Minimal ethics evaluation has its five verdicts in order, each on its fixed values (`Yes`/`No`/`Unclear`, `Yes`/`Partially`/`No`, `Yes`/`Limited`/`No`, `Yes`/`No`) with a reason after `:` or a dash.
- Hidden coercion is `None found.` or a table with the header `| Coercion point | Justification given | Victim identified |`, a separator row, and rows of three non-empty cells whose last cell opens on `Yes` or `No`.
- Overall assessment has Framework type (one of the six, with `Mixed (…)` naming what it mixes), Coherence and Minimal ethics compliance on their fixed values. `Highly coherent` with contradictions listed fails; `Compliant` fails when a coercion row has no victim identified or the framework creates unwilling victims.
- Key concerns are `None found.` or a numbered list counting from 1; Recommendations are `None needed.` or bullets.
- No template placeholder (`{…}`, `Holds | Fails`, `Yes | No`) is left in the output.

## Exit codes

- `0` the shape holds
- `1` a rule failed; each failure prints as one `✗` line
- `2` bad usage or unreadable input
