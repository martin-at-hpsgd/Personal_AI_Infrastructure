# CodeRulesCheck

Checks a CodeRules output (`Intents/CodeRules.md`) against the parts of its contract that code can judge. Whether each rule is faithful to the source, concrete enough to verify, specific to the input and something a capable coding model would not already do stays a judged check in the `fabric-coderules` suite.

## Usage

```bash
bun skills/Fabric/Tools/CodeRulesCheck.ts <file|-> [--json]
```

| Flag | Meaning |
|------|---------|
| `<file\|->` | The saved output, or `-` for stdin |
| `--json` | Print `{ok, rules, none, problems}`; `rules` is the list of rule texts |
| `--help` | Print usage |

## Checks

- The output is the bare list, ready to paste into a rules file: no title and no heading of any level.
- With no coding practice in the input, the output is the single line `No code rules found in {the source}.` and nothing else.
- Otherwise the output is a bulleted list (`- `), unindented and never numbered, with no other text and no fenced code block.
- There are 1 to 25 rules, and no two are the same (case, spacing and a trailing period ignored).
- Each rule holds 3 to 30 words. Words split on whitespace with edge punctuation ignored; a backticked span counts as one word.
- Each rule is one sentence ending in a period: outside backticks, no `.`, `!` or `?` followed by a space and a capital letter.
- Backticks on each rule are balanced.
- No rule opens on third-person or softening framing: "The AI", "The assistant", "The agent", "The model", "AI", "You should", "You must", "Developers should", "Please", "Try to", "Make sure", "Remember to", "Rule 1:".
- No bold (`**`, `__`) or italics (`*x*`, `_x_`) outside backticks. A `snake_case` word or a backticked `__init__.py` is not emphasis.

## Exit codes

- `0` the shape holds
- `1` a rule failed; each failure prints as one `✗` line
- `2` bad usage or unreadable input
