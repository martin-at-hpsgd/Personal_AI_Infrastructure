# SigmaRulesCheck

Checks a SigmaRules output (`Intents/SigmaRules.md`) against the parts of its contract that code can judge. It parses every rule's YAML with `Bun.YAML.parse` and checks the Sigma required fields. Whether a rule catches the behavior its source describes stays a judged check in the `fabric-sigmarules` suite.

## Usage

```bash
bun skills/Fabric/Tools/SigmaRulesCheck.ts <file|-> [--json]
```

| Flag | Meaning |
|------|---------|
| `<file\|->` | The saved output, or `-` for stdin |
| `--json` | Print `{ok, rules, problems}`, one entry per rule with its own problems |
| `--help` | Print usage |

## Checks

**Layout.** Each rule sits in its own section: a `#### Sigma Rule: <title>` header, one fenced `yaml` block, then a `#### End of Sigma Rule` footer. The only other content allowed is an optional closing `#### Not covered` heading followed by bullets. Any other text outside a section fails.

**Parsing.** Each block parses as one YAML mapping. No mapping may repeat a key; the parser would silently keep only the last value, which drops a selection.

**Fields.** Each rule carries `title`, `id`, `status`, `description`, `date`, `logsource`, `detection`, `falsepositives`, `level` and `tags`. Sigma itself requires only `title`, `logsource` and `detection` with a `condition`; the intent requires the rest. The value rules are:

- The header title matches the YAML `title`.
- `id` is a UUID, is unique across the rules, and is not one of the two ids in the upstream example.
- `status` is one of stable, test, experimental, deprecated or unsupported.
- `level` is one of informational, low, medium, high or critical.
- `date` is written YYYY-MM-DD.
- `author`, when present, is not a placeholder such as "Your Name".
- `logsource` names at least one of `category`, `product` or `service`.
- `falsepositives` is a non-empty list of strings.
- `tags` are lowercase `namespace.name` strings, and at least one is an ATT&CK technique (`attack.t1003.001`).

**Detection.** The `detection` block defines at least one search identifier besides `condition`. Each identifier is a mapping of fields or a list of mappings or keywords. Every field modifier is a real Sigma modifier (contains, startswith, endswith, all, re, cidr, windash, base64offset and the rest). Values are plain values or lists of them.

**Condition.** The condition names only identifiers the detection defines. A wildcard such as `selection_*` must match at least one identifier. Every identifier is used, either directly, through a wildcard, or through `them`. A condition may not use an aggregation pipe (`| count() by`), which Sigma v2 moved to correlation rules.

## Known strictness

Bun 1.3.6's parser rejects ` ... ` in the middle of an unquoted value, which YAML 1.2 allows (verified 2026-10-25 against the `yaml` package). The checker reports that as a parse failure, and the intent asks for the value to be single-quoted, which parses in both.

## Exit codes

- `0` every rule is valid
- `1` a rule failed; each failure prints as one `✗` line naming the rule's line and title
- `2` bad usage or unreadable input
