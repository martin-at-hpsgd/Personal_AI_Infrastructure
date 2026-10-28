# AnalyzeIncidentCheck

Checks an AnalyzeIncident output (`Intents/AnalyzeIncident.md`) against the parts of its contract that code can judge. Whether each fact is in the source, whether the date is the attack and not the disclosure, and whether each technique fits the reported behavior stay judged checks in the `fabric-analyzeincident` suite.

## Usage

```bash
bun skills/Fabric/Tools/AnalyzeIncidentCheck.ts <file|-> [--json]
```

| Flag | Meaning |
|------|---------|
| `<file\|->` | The saved output, or `-` for stdin |
| `--json` | Print `{ok, noIncident, incidents, problems}` |
| `--help` | Print usage |

## Checks

- The output is either one `**No incident reported:** …` line with text after it, or one or more blocks, each opening on `## Incident: {target}, {attack type}`, with nothing before the first heading.
- Each block has a non-empty `**Summary:**` line before `### Reported facts`, then `### Analysis`, in that order. The Summary is one sentence of at most 60 words; a period inside an abbreviation or initialism (U.S., Inc.) does not end a sentence.
- Business impact is one sentence.
- Reported facts holds the thirteen fields once each and in order (Attack date, Attack type, Vulnerable component, Attacker, Attacker origin, Target, Target country, Target size, Industry, CVEs, Accounts compromised, Business impact, Root cause), each a single non-empty line; absent facts read `Not stated`.
- Attack date is a real calendar date as `YYYY-MM-DD`, `YYYY-MM` or `YYYY`, a forward `<date> to <date>` range, `Not stated`, or `Not stated (disclosed YYYY-MM-DD)`. A 2026-02-30 fails.
- CVEs is `Not stated`, `None` (optionally followed by the source's words in parentheses, for a source that says no CVE was involved), or a comma-separated list of `CVE-YYYY-NNNN` IDs with no repeats.
- Analysis holds ATT&CK techniques, Atomic Red Team tests, Remediation, Action plan and Lessons learned once each and in order.
- Each technique is a sub-bullet `- T#### Name: reported behavior` (Enterprise and Mobile `T1###` with an optional `.###` sub-technique, or ICS `T08##`), no ID twice; or the field reads `Not enough detail in the source` with no sub-bullets.
- Each Atomic Red Team entry is `- T####: what it would show` and names a technique from the ATT&CK list; or the field reads `Not enough detail in the source` or `None`.
- Action plan has at least two numbered steps, numbered 1, 2, 3 … in order.
- An optional `**Sources:**` line may close a block; nothing follows it inside that block.
- No template placeholder (`{…}`, `YYYY`, `NNNN`) is left anywhere.

The checker validates ID syntax, not that a technique ID exists in the current ATT&CK release or carries the right name; that is a judged check.

## Exit codes

- `0` the shape holds
- `1` a rule failed; each failure prints as one `✗` line
- `2` bad usage or unreadable input
