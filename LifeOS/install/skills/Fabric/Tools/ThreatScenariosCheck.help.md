# ThreatScenariosCheck

Checks a ThreatScenarios output (`Intents/ThreatScenarios.md`) against the parts of its contract that code can judge. Whether the ranking is realistic, the named fear is weighed honestly and the controls are specific stays a judged check in the `fabric-threatscenarios` suite.

## Usage

```bash
bun skills/Fabric/Tools/ThreatScenariosCheck.ts <file|-> [--json]
```

| Flag | Meaning |
|------|---------|
| `<file\|->` | The saved output, or `-` for stdin |
| `--json` | Print `{ok, scenarios, controls, problems}` |
| `--help` | Print usage |

## Checks

- One H1 title opening `# Threat Scenarios: ` as the first line, then nothing until the first section.
- Exactly five H2 sections, in order: THREAT SCENARIOS, THREAT MODEL ANALYSIS, RECOMMENDED CONTROLS, NARRATIVE ANALYSIS, CONCLUSION.
- THREAT SCENARIOS holds only a table with the header `| Rank | Scenario | Likelihood | Impact | Call |`, a separator row, and 4 to 15 rows. Ranks run 1, 2, 3 in order. Likelihood and impact are each Low, Medium or High. Each scenario is 5 to 25 words. The call is Defend, Watch, or `Accept: <reason>` with a reason of at least three words.
- Rows are ordered by likelihood times impact (Low 1, Medium 2, High 3), highest first; ties may sit in either order.
- THREAT MODEL ANALYSIS holds 3 to 10 bullets, none over 20 words.
- RECOMMENDED CONTROLS holds at most 10 bullets, each 4 to 30 words and ending with the ranks it addresses, such as `(#1, #3)`. Every cited rank exists, no control cites an Accept row, and every Defend row is cited at least once.
- NARRATIVE ANALYSIS is 1 to 3 prose paragraphs, with no bullets, lists or tables.
- CONCLUSION is one sentence on one line, 12 to 35 words.
- No asterisk anywhere outside inline code, so there is no bold or italics; a wildcard such as `` `s3:*` `` is allowed.

Words split on whitespace; punctuation at a word's edges is ignored, a token of pure punctuation (an em-dash) is not a word, and a hyphenated compound or a number is one word.

## Exit codes

- `0` the shape holds
- `1` a rule failed; each failure prints as one `✗` line
- `2` bad usage or unreadable input
