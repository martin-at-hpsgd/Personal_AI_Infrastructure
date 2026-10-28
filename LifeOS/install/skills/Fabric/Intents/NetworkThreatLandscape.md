# NetworkThreatLandscape

**Contents:** Ideal State · Anti-criteria · Evals · Inputs · Tool contract · Output format · References

A threat-report section on a network's open ports and services, built from a port scan or port and service statistics: what is exposed, what each exposure risks, what to do about it, and the patterns across the scan, ready to drop into a formal security report.

Our ideal-state port of Fabric's `create_network_threat_landscape`. The upstream pattern stays in `Patterns/` for reference; this intent replaces it whenever a request asks for that pattern, so the old prompt never runs.

## Ideal State

- The report delivers what the principal wants from this input, inferred before writing and never asked for. Pasted scan output (nmap, masscan, a scanner export), port and service statistics (the upstream pattern's two bullet lists), or a file or URL holding either means a landscape of exactly that scan, built from it alone and read in full. A bare exposure or question ("exposed RDP and SMB", "what does an open 6379 risk") means a general landscape for that exposure from well-established security knowledge, titled as general, with no hosts, counts or versions made up. "This" or nothing means the scan or exposure under discussion in the conversation. Input with no port or service data in it (a phishing report, a policy, a vendor pitch) means the single line `No port or service data: {what the input is instead}`. A typed hint ("just the recommendations", "internet-facing only", "for the board") overrides the default read and narrows or reframes the report to what it names.
- The title names the scope that was read (`# Network Threat Landscape: 6 hosts on 192.0.2.0/24`, `# Network Threat Landscape: Internet-exposed Redis (general)`), so a wrong read is visible at a glance.
- The Description says in a few sentences, at most 120 words, what is open: how many ports, services and hosts, which kinds of service dominate (remote administration, file sharing, databases, web), and anything unusual for the network the input describes.
- Every Risk entry names a port, protocol and service from the input, carries a severity of Critical, High, Medium or Low, and says what an attacker could do through that exposure and why it matters here. The entries run from most to least severe. Severity follows the service and what the input says about it, so cleartext remote login, exposed file sharing and unauthenticated databases rank above a current web server.
- Only open ports count as exposure. A port the scan marks filtered, closed or open|filtered is never reported as open; it may be mentioned as what it is.
- A version-specific weakness or CVE appears only when the input shows a version string the weakness applies to. Without a version, the risk is the service's own exposure and no CVE is cited.
- When the input does not say whether hosts are internet-facing or internal, the Risk says which it assumed rather than writing as if it knew.
- Each Recommendation is an action an engineer could take tomorrow, naming the port, service or host it applies to ("Disable telnet on 192.0.2.5 and manage the switch over SSH"; "Restrict 3389/tcp to the VPN address range"). There are 3 to 15, as many as the findings support, ordered by the risk they remove.
- The One-Sentence Summary gives the report's main point in plain, conversational words, under 25 words, with no jargon or marketing language.
- Each Trend is a pattern across more than one port, host or count in the input ("Four of the six hosts expose a remote administration service"), stated with the numbers the input gives. There are 3 to 20, as many as the data supports.
- Each Evidence item quotes, character for character, a line or fragment of the input that a finding rests on, and says in a few words which finding it supports. There are 3 to 20. For a bare exposure or question there is no input to quote, and the section is the single bullet `- No scan data was supplied.`
- Every section is specific to this input: a risk, recommendation or trend that would read the same under any other scan fails.
- Words are plain and exact, the vocabulary a network security engineer uses with a colleague.
- `bun skills/Fabric/Tools/NetworkThreatLandscapeCheck.ts` passed on the exact output before it was delivered. Where no shell is available, the sections, counts and formats are checked by hand and nothing about the check appears in the output.

## Anti-criteria

- Never a host, port, service, version, count or CVE that the input does not contain, and never a general landscape presented as an observed scan.
- Never a filtered or closed port treated as open.
- Never generic advice ("implement a firewall, patch regularly, train staff") in place of actions tied to the ports found.
- Never padding to reach a count, never two items that say the same thing in different words, and never two Recommendations or two Trends that open on the same words.
- Never an Evidence quote that is reworded, merged from two lines, or absent from the input.
- Never bold or italic text, numbered lists, a code fence around the report, preamble, caveats or notes outside the sections.
- Never a scan or report analyzed from a fetched page summary or a truncated excerpt instead of its full text.
- Never the old Fabric pattern text run as the prompt for this request.

## Evals

- suite: fabric-networkthreatlandscape — code checks on the section order, the Risk line format, the no-data line and the no-bold rule; judged checks on open versus filtered ports, version-backed CVEs, recommendations tied to the ports found, trends with real counts, and faithful evidence.
- compiled: Assay checks every output against the Ideal State and Anti-criteria above.

## Inputs

- The scan: pasted scanner output or port and service statistics, a file path, a URL, a bare exposure or question, or "this"/nothing for the conversation's scan. A URL or video is read in full (`Intents/ExecutePattern.md` § Tool contract covers fetching YouTube and URLs).
- An optional hint narrowing or reframing the report.

## Tool contract

Run from `~/.claude`. Save the draft, and the scan when it was pasted, then check and deliver only on exit 0:

```bash
bun skills/Fabric/Tools/NetworkThreatLandscapeCheck.ts <file|-> [--source <scan-file>] [--json]
#   exit 0: shape holds; exit 1: prints each failed rule; exit 2: bad usage or unreadable input
```

### Intent-to-Flag Mapping

| Situation | Flag |
|-----------|------|
| The report quotes a scan (any input but a bare exposure or question) | `--source <scan-file>`, so every Evidence quote is checked against the input verbatim |
| A bare exposure or question, or the no-data line | no `--source` |
| A caller wants the result as data | `--json` |

A hint-narrowed report (only some sections asked for) skips the check, since its shape is the hint's.

## Output format

Plain Markdown, delivered unfenced. Bullets only, never numbered lists, and no bold or italics anywhere, so the section pastes into a formal report as is.

```markdown
# Network Threat Landscape: {scope read from the input}

## Description

{a few sentences, at most 120 words}

## Risk

- {Critical|High|Medium|Low}: {port}/{tcp|udp} {service}: {what an attacker could do through it and why it matters here}

## Recommendations

- {an action naming the port, service or host it applies to}

## One-Sentence Summary

{one sentence under 25 words}

## Trends

- {a pattern across the input, with its numbers}

## Evidence

- `{exact text from the input}`: {the finding it supports}
```

Several ports for one service share a Risk line (`139,445/tcp SMB`). Input with no port or service data is the single line `No port or service data: {what the input is instead}`.

## References

- Upstream: `Patterns/create_network_threat_landscape/system.md` (Description, Risk, Recommendations, One-Sentence-Summary, Trends and Quotes sections from two bullet lists of port-scan statistics, with fixed minimum counts and a Quotes section drawn from its own generated text).
- `Tools/NetworkThreatLandscapeCheck.help.md`: the checker's rules and exit codes.
