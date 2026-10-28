# AuditConsentCheck

Checks an AuditConsent output (`Intents/AuditConsent.md`) against the parts of its contract that code can judge. Whether the evidence is tied to the input, the channel rule was applied correctly, and the verdict is even-handed stays a judged check in the `fabric-auditconsent` suite.

## Usage

```bash
bun skills/Fabric/Tools/AuditConsentCheck.ts <file|-> [--json]
```

| Flag | Meaning |
|------|---------|
| `<file\|->` | The saved output, or `-` for stdin |
| `--json` | Print `{ok, noClaim, audits, problems}`, each audit as `{title, channel, verdict}` |
| `--help` | Print usage |

## Checks

- The output is either the single line `**No consent claim:** {what the input is}` and nothing else, or one or more `## Audit: {claim}` blocks with no text before the first.
- Each block opens on a `**Consent claim:**` line; `**Source:**` and `**Answer:**` lines may follow it, and nothing else comes before the first `###` section.
- The sections run in order: Power map, Consent channel, Five consent tests, Verdict, What would make this genuine, Minimum viable consent. A `None` channel ends the audit with only Power map, Consent channel and What would make this genuine.
- The power map table has the header `| Dimension | Requester: … | Consenter: … | Asymmetry |`, a separator row, and exactly the rows Economic, Information, Social, Structural, each asymmetry one of Low, Medium, High, Extreme and each party position filled.
- The channel line is `**Channel:** {Words | Conduct | Agreement | Prior permission | None}: {detail}`.
- The tests table has the header `| Test | Status | Evidence |` and exactly the rows Information, Alternatives, Capacity, No manipulation, Revocability, each status Pass, Partial or Fail with evidence filled.
- The verdict line is `**Verdict:** {GENUINE | PRESSURED BUT FUNCTIONAL | MANUFACTURED | COERCED | ILLUSORY}: {reason}`.
- The verdict agrees with the tables: GENUINE needs every test passing and no High or Extreme asymmetry; every test passing with every asymmetry Low must be GENUINE; PRESSURED BUT FUNCTIONAL cannot have a failed Alternatives test; ILLUSORY needs a failed Alternatives test; COERCED needs a failed Alternatives or Revocability test; MANUFACTURED, COERCED and ILLUSORY cannot sit on five passes.
- What would make this genuine has at least one bullet, and Minimum viable consent is filled; `None needed.` is allowed in either only on a GENUINE verdict.
- No cell, bullet or line is a template placeholder (`{…}`, `[position]`, `[details]`).

## Exit codes

- `0` the shape and verdict consistency hold
- `1` a rule failed; each failure prints as one `✗` line
- `2` bad usage or unreadable input
