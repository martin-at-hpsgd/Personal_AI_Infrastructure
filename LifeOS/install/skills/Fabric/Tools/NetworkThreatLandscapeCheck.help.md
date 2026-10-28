# NetworkThreatLandscapeCheck

Checks a NetworkThreatLandscape output (`Intents/NetworkThreatLandscape.md`) against the parts of its contract that code can judge. Whether the findings are true to the scan (open versus filtered, version-backed CVEs) and specific to it stays a judged check in the `fabric-networkthreatlandscape` suite.

## Usage

```bash
bun skills/Fabric/Tools/NetworkThreatLandscapeCheck.ts <file|-> [--source <input-file>] [--json]
```

| Flag | Meaning |
|------|---------|
| `<file\|->` | The saved output, or `-` for stdin |
| `--source <input-file>` | The scan or statistics the report was built from; every Evidence quote must appear in it (whitespace-normalized) |
| `--json` | Print `{ok, kind, counts, problems}` |
| `--help` | Print usage |

## Checks

- A no-data output is exactly one line opening `No port or service data: `, and nothing else.
- A report opens on `# Network Threat Landscape: {scope}`, then holds exactly the sections `## Description`, `## Risk`, `## Recommendations`, `## One-Sentence Summary`, `## Trends` and `## Evidence`, once each and in that order, with no other heading and no text outside them.
- Description is prose (no bullets) of at most 120 words.
- Each Risk bullet reads `- {Critical|High|Medium|Low}: {port}/{tcp|udp|sctp} {service}: {risk}` (several ports may share a line, as `139,445/tcp`), and the entries run from most to least severe.
- Recommendations hold 3 to 15 bullets and Trends 3 to 20; within each, no two bullets open on the same two words.
- One-Sentence Summary is one line, one sentence, of 1 to 24 words.
- Evidence holds 3 to 20 bullets of the form ``- `{exact text}`: {finding}``, no quote repeated, or the single line `- No scan data was supplied.` for a bare exposure or question. With `--source`, every quote must be in the source.
- No bullet in Risk, Recommendations or Trends repeats another.
- No bold or italic markup outside inline code, no numbered list, and no code fence.

Words split on whitespace; punctuation at a word's edges is ignored, and a hyphenated compound or a number is one word.

## Exit codes

- `0` the shape holds
- `1` a rule failed; each failure prints as one `✗` line
- `2` bad usage or unreadable input
