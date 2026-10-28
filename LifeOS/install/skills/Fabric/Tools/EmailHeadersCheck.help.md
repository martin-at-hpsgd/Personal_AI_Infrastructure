# EmailHeadersCheck

Checks an EmailHeaders analysis (`Intents/EmailHeaders.md`) against the parts of its contract that code can judge. Whether each verdict came from the trusted `Authentication-Results` header, whether forwarding was read correctly, and whether the concerns are specific to the message stay judged checks in the `fabric-emailheaders` suite.

## Usage

```bash
bun skills/Fabric/Tools/EmailHeadersCheck.ts <file|-> [--json]
```

| Flag | Meaning |
|------|---------|
| `<file\|->` | The saved analysis, or `-` for stdin |
| `--json` | Print `{ok, summary, problems}`; `summary` holds the parsed results, addresses, alignment and verdict |
| `--help` | Print usage |

## Checks

- The first line is `# Email Header Analysis - <address>`, with a bare RFC 5322 address (no display name, no angle brackets, not the word "address").
- `## SUMMARY` comes before `## DETAILS`.
- The summary table opens on `| Header | Disposition |` and has exactly the rows SPF, DKIM, DMARC, ARC in that order, each holding one result word: Pass, Fail, Softfail, Neutral, None, Temperror, Permerror or Not Present (case-insensitive).
- `Header From:` is a bare address equal to the title address. `Envelope From:` is a bare address, `<>` (null sender) or `Not present`. A trailing parenthetical note is allowed on either.
- `Domains Align:` opens on Pass or Fail, and `Verdict:` opens on Authentic, Suspicious, Spoofed or Inconclusive.
- DMARC Pass is refused when Domains Align is Fail or when neither SPF nor DKIM passed.
- `## DETAILS` holds the six `###` subsections in order, each non-empty: SPF (Sender Policy Framework), DKIM (DomainKeys Identified Mail), DMARC (Domain-based Message Authentication, Reporting, and Conformance), ARC (Authenticated Received Chain), Security Concerns and Recommendations, Dig Commands.
- Dig Commands holds a fenced shell block that sets `DOMAIN` to the Header From domain and queries MX, SPF (`| grep -i spf`), the DKIM selectors `selector1`, `selector2`, `google`, `s1`, `s2`, `k1`, `k2`, the `_dmarc` TXT and NS records, and the dmarcian and Valimail checker URLs. Quotes and `${}` braces are ignored when matching, and order is free.

## Exit codes

- `0` the shape holds
- `1` a rule failed; each failure prints as one `✗` line
- `2` bad usage or unreadable input
