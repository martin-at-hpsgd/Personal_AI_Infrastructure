# SecurePromptCheck

Checks a SecurePrompt output (`Intents/SecurePrompt.md`) against the parts of its contract that code can judge. Whether the system prompt fits the deployment, holds the authority order and stays useful remains a judged check in the `fabric-secureprompt` suite.

## Usage

```bash
bun skills/Fabric/Tools/SecurePromptCheck.ts <file|-> [--sections list] [--json]
```

| Flag | Meaning |
|------|---------|
| `<file\|->` | The saved output, or `-` for stdin |
| `--sections list` | Comma list of the sections the request asked for, in order: `system,developer,tests,rubric,notes` (default: all five) |
| `--json` | Print `{ok, sections, tests, rubric, problems}` |
| `--help` | Print usage |

## Checks

- One H1 naming the deployment, and nothing else before the first section.
- The asked-for sections, each once and in order: `## System Prompt`, `## Developer Prompt` (or `Optional Developer Prompt`), `## Injection Tests` (or `Prompt-Injection Tests`), `## Evaluation Rubric`, `## Notes`. Any other H2 fails.
- The system prompt is one closed ```` ```text ```` block of at least 40 words, with no `...` placeholder line, no unfilled `[insert …]`, `<your …>`, `TODO` or `TBD`, and no secret-shaped string (OpenAI-style, AWS, GitHub or Slack token, private key block).
- The developer prompt is the same kind of block, or one line starting `Not needed` that gives a reason (five words or more).
- The injection tests are a markdown table with `ID`, `Vector`, `Attack` and `Expected` columns: at least 6 rows, IDs `T1`, `T2`… unique, each vector one of `direct`, `indirect`, `extraction`, `exfiltration`, `role-play`, `obfuscation`, `multi-turn`, `tool-abuse`, `escalation`, `benign`, and at least one each of `direct`, `indirect`, `extraction` and `benign`. Attack and expected cells hold 3 words or more. A pipe inside a cell is written `\|`.
- The rubric is a markdown table with `ID`, `Criterion` and `Pass when` columns: at least 5 rows, IDs `R1`, `R2`… unique, each pass condition 3 words or more.
- Each rubric row names the tests it grades by ID (`T2`, `T1 and T4`, or a range `T1-T3`, `T1–T3`, `T1..T3`, `T1 to T3`), every named ID is a real test, and every test is named by at least one row. This runs only when both the tests and the rubric are present.
- A `Release bar:` line (bold allowed) follows the rubric table, with 5 words or more stating what must pass to ship.
- Notes is not empty, and "virtual minutes" appears nowhere.

## Exit codes

- `0` the shape holds
- `1` a rule failed; each failure prints as one `✗` line
- `2` bad usage or unreadable input
