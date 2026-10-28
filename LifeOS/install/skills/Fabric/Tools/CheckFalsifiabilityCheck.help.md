# CheckFalsifiabilityCheck

Checks a CheckFalsifiability output (`Intents/CheckFalsifiability.md`) against the parts of its contract that code can judge. Whether each verdict is fair, whether a trap is really in the text, and whether a test or rewrite is specific stay judged checks in the `fabric-checkfalsifiability` suite.

## Usage

```bash
bun skills/Fabric/Tools/CheckFalsifiabilityCheck.ts <file|-> [--json]
```

| Flag | Meaning |
|------|---------|
| `<file\|->` | The saved output, or `-` for stdin |
| `--json` | Print `{ok, claims, rating, problems}` |
| `--help` | Print usage |

## Checks

- One H1 opening `# Falsifiability Check: `, first in the file, and nothing between it and the first section.
- Exactly seven H2 sections in this order: CLAIMS IDENTIFIED, FALSIFIABILITY ANALYSIS, KAFKA TRAP CHECK, OVERALL FALSIFIABILITY RATING, RISK ASSESSMENT, PROPOSED TESTS, RECOMMENDATIONS.
- CLAIMS IDENTIFIED is a numbered list of 1 to 12 claims, numbered from 1 with no gaps, each at least three words.
- FALSIFIABILITY ANALYSIS has one `### Claim N:` block per listed claim, in order, each holding exactly four field bullets: `Falsifiable` (Yes, No, Partially, Moving goalposts), `What would disprove it`, `Definitional precision` (Precise, Vague, Shifting) and `Escape hatches`, none empty. A field written upstream-style in bold (`- **Falsifiable?** Yes`) reads the same. A Yes claim's disprover is at least five words and never "Nothing specified".
- KAFKA TRAP CHECK is exactly four checkbox lines in order: Denial proves guilt, Questioning proves ignorance, Only agreement is valid, Doubt is moral failure. A checked box (`[x]`) carries the line that sets the trap after a colon.
- OVERALL FALSIFIABILITY RATING is one line opening on one of the five ratings, followed by a reason of at least five words. FULLY FALSIFIABLE requires every claim Yes; COMPLETELY UNFALSIFIABLE requires no claim Yes; an all-Yes audit is never rated UNFALSIFIABLE, and an audit with no Yes claim is never rated FULLY or MOSTLY FALSIFIABLE.
- RISK ASSESSMENT is not empty.
- PROPOSED TESTS has one `### Test for Claim N` block for every claim that is not Yes, citing only listed claims and none twice, each with the four fields `Test`, `Confirms if`, `Refutes if` and `Claimant would accept`. When every claim is Yes it is the single line `No tests needed: …`.
- RECOMMENDATIONS has one `- Claim N: "…"` bullet with a quoted rewrite of at least four words for every claim that is not Yes, and nothing else. When every claim is Yes it is the single line `No rewrites needed: …`.

## Exit codes

- `0` the shape holds
- `1` a rule failed; each failure prints as one `✗` line
- `2` bad usage or unreadable input
