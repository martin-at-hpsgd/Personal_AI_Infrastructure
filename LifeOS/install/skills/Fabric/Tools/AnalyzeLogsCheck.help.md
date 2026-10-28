# AnalyzeLogsCheck

Checks an AnalyzeLogs output (`Intents/AnalyzeLogs.md`) against the parts of its contract that code can judge. Whether the diagnosis is right (the ranking, the cause, the specificity of each recommendation) stays a judged check in the `fabric-analyzelogs` suite. Run it only on outputs for an analyzed log; an answer to a bare question has no fixed shape.

## Usage

```bash
bun skills/Fabric/Tools/AnalyzeLogsCheck.ts <file|-> [--log <logfile>] [--json]
```

| Flag | Meaning |
|------|---------|
| `<file\|->` | The saved output, or `-` for stdin |
| `--log <logfile>` | The analyzed log; every Evidence quote must appear on one of its lines |
| `--json` | Print `{ok, findings, recommendations, problems}` |
| `--help` | Print usage |

## Checks

- The first non-empty line opens on `**Verdict:**` followed by text.
- The sections `## Findings`, `## Reliability and performance` and `## Recommendations` each appear once, in that order. `## Limits` is the one optional section and comes last. Any other H2 fails.
- Findings are `### 1. <title>`, `### 2. …` numbered from 1 without gaps, or the section opens on `None.`. Each finding has a `- Seen:` line with a count (`14×`, `14 times`, `once`), at least one `- Evidence:` line holding a backticked log quote, and an `- Impact:` line. `- Cause:` is optional.
- Reliability and performance is not empty.
- Recommendations are `1.`, `2.` … numbered without gaps, each naming the finding it fixes as `(finding N)` or `(findings N, M)`, and every named finding exists. When Findings is `None.`, recommendations (changes that would make the next log more useful) name no finding, and `None.` is allowed; with findings, `None.` fails.
- No line of the output carries an unmasked secret: a credential assignment (`password=`, `token=`, `api_key:` …), a bearer token, an AWS access key, an `sk-`/`pk-` style provider key, a GitHub token or a JWT. Masked values are written `[REDACTED]`.
- With `--log`, each Evidence quote, split at `[REDACTED]` and at `…` or `...`, has its pieces appear in order on a single line of the log, whitespace-normalized.

## Exit codes

- `0` the shape holds
- `1` a rule failed; each failure prints as one `✗` line
- `2` bad usage or unreadable input
