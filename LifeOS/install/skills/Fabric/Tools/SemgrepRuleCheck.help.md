# SemgrepRuleCheck

Checks a SemgrepRule output (`Intents/SemgrepRule.md`) against the parts of its contract that code can judge, then runs Semgrep itself on the rule and on its test code. Whether the rule catches the general case without overfitting stays a judged check in the `fabric-semgreprule` suite.

## Usage

```bash
bun skills/Fabric/Tools/SemgrepRuleCheck.ts <file|-> [--json] [--no-semgrep]
```

| Flag | Meaning |
|------|---------|
| `<file\|->` | The saved output, or `-` for stdin |
| `--json` | Print `{ok, rules, tests, semgrep, problems}` |
| `--no-semgrep` | Structural checks only; skip `semgrep --validate` and `semgrep --test` |
| `--help` | Print usage |

## Checks

- The output is fenced code blocks and blank lines only: no prose, heading or note outside the fences, and every fence closed.
- Exactly one ```` ```yaml ```` block holds a `rules:` list. It parses with `Bun.YAML.parse`, and the list is not empty.
- Each rule has a plain, unique `id`; a `message` long enough to say why it matched and how to fix it; a `severity` Semgrep accepts (`INFO`, `WARNING`, `ERROR`, or `LOW`, `MEDIUM`, `HIGH`, `CRITICAL`); a non-empty `languages` list; and exactly one of `pattern`, `patterns`, `pattern-either`, `pattern-regex` at the top level, or `mode: taint` with `pattern-sources` and `pattern-sinks`.
- No rule carries `r2c-internal-project-depends-on`: open-source Semgrep validates it and then returns zero findings, silently (Semgrep 1.157.0, 2026-10-25).
- Every other code block is test code with Semgrep's annotations, and every rule has at least one line marked `ruleid: <id>` (must match) and one marked `ok: <id>` (must not). Annotations naming an unknown id fail. The block's fence language, or else the rule's first language, picks the test file's extension.
- `semgrep --validate --config <rule>` exits 0.
- `semgrep --test --json --config <rule> <test files>` reports every check passed: each `ruleid:` line matched and no unmarked line matched.

## Exit codes

- `0` every check holds
- `1` a check failed; each failure prints as one `✗` line
- `2` bad usage, unreadable input, or `semgrep` not on PATH without `--no-semgrep`

A full run spawns Semgrep twice and takes about four seconds.
