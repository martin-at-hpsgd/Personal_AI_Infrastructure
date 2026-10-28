# GoldenRulesCheck

Checks a GoldenRules output (`Intents/GoldenRules.md`) against the parts of its contract that code can judge. Whether the rules are specific to the input, faithful to the source, ranked well and checkable in practice stays a judged check in the `fabric-goldenrules` suite.

## Usage

```bash
bun skills/Fabric/Tools/GoldenRulesCheck.ts <file|-> [--source] [--json]
```

| Flag | Meaning |
|------|---------|
| `<file\|->` | The saved output, or `-` for stdin |
| `--source` | The input was a source (pasted artifact, URL, file, directory): every rule needs a Basis line |
| `--json` | Print `{ok, rules, checklist, none, problems}` |
| `--help` | Print usage |

## Checks

- Exactly one H1, first in the file, opening `# Golden Rules: ` and naming the subject.
- H2 sections only from `Critical Rules`, `Important Rules`, `Guidelines`, `Quick Reference`, `Checklist`, in that order. `Critical Rules`, `Quick Reference` and `Checklist` are required; a tier heading with no rules fails, and so does any text between a tier heading and its first rule (tier boilerplate) or between the title and the first section. No heading deeper than H3. Lines inside fenced code blocks are never read as headings or fields.
- Each rule is `### {n}. {Rule name}`, a name of 2 to 10 words, numbered 1 to N once across the whole document, with no repeated name. 1 to 5 Critical rules and at most 15 in all.
- Each rule carries `**Rule**:`, `**Why**:`, `**Do**:`, `**Don't**:` and `**Test**:` in that order, none empty, with `**Basis**:` between Why and Do. With `--source` the Basis is required on every rule; without it, a Basis that is present still has to be well formed. A Basis opens `Stated in` or `Observed in`.
- A Rule is at most two sentences and 40 words; a Why is at most two sentences. Do and Don't are not identical.
- The Quick Reference table has the header `| # | Category | Rule | Priority |`, a separator row, and one row per rule in order: the row number matches, the category is non-empty, the rule cell is 1 to 12 words, and the priority is `Critical`, `Important` or `Guideline` matching the rule's tier.
- The Checklist holds 1 to 15 `- [ ] ` boxes and nothing else. Each box has at least three words and ends by citing the rules it checks, such as `(#1, #3)`; every cited number is a rule, and every Critical rule is cited at least once.
- The no-rules form is the title and the single line `No golden rules found in {the source}.`, with nothing else.

## Exit codes

- `0` the shape holds
- `1` a rule failed; each failure prints as one `✗` line
- `2` bad usage (an unknown flag, no arguments) or unreadable input
