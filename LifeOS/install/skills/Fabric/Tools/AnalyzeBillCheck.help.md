# AnalyzeBillCheck

Checks an AnalyzeBill output (`Intents/AnalyzeBill.md`) against the parts of its contract that code can judge. Whether each covert goal is really in the provision it cites, whether the buried provisions were found, and whether the verdict is fair stay judged checks in the `fabric-analyzebill` suite.

## Usage

```bash
bun skills/Fabric/Tools/AnalyzeBillCheck.ts <file|-> [--short] [--json]
```

| Flag | Meaning |
|------|---------|
| `<file\|->` | The saved output, or `-` for stdin |
| `--short` | Apply the short form's limits: at most 3 goals per list, goals of at most 8 words, Summary and Verdict sentence of at most 16 |
| `--json` | Print `{ok, outcome, overt, covert, verdict, problems}`; `outcome` is `analysis`, `no-bill` or `unavailable` |
| `--help` | Print usage |

## Checks

- The output is either one single line, `**No bill found:** <what the input is>` or `**Bill text unavailable:** <which bill, where it was looked for>`, and nothing else, or the five sections `## Bill`, `## Summary`, `## Overt goals`, `## Covert goals`, `## Verdict`, each once and in that order, with nothing before the first.
- `## Bill` lists `Bill`, `Jurisdiction`, `Sponsors`, `Introduced` and `Status` once each, in that order, as `- **<Field>:** <value>`, none empty. `Introduced` is `YYYY-MM-DD`, `YYYY-MM`, `YYYY` or `Not stated`.
- The Summary is one prose paragraph of at most 24 words (16 with `--short`).
- Each goal bullet reads `- **<provision>:** <goal>`, the provision anchor 1 to 6 words, the goal at most 16 words (8 with `--short`), not counting the anchor. Each list holds 1 to 10 goals (1 to 3 with `--short`).
- Covert goals may instead be the single bullet `- None found`; Overt goals may not.
- The Verdict is one paragraph, `**<Mostly overt|Mixed|Mostly covert>:** <sentence>`, the sentence 3 to 30 words (16 with `--short`). When Covert goals is `None found`, the label is Mostly overt.
- No template placeholder (`{...}`) is left in.
- Words split on whitespace, and a token of pure punctuation (such as `§`) is not a word.

## Exit codes

- `0` the shape holds
- `1` a rule failed; each failure prints as one `✗` line
- `2` bad usage or unreadable input
