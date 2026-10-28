# TechnicalCreativity

Diverse, non-obvious engineering solutions from two vendors, each with trade-offs and difficulty, and one justified recommendation.

## Ideal State

- The solution set merges 5 solutions from each of two vendors (OpenAI at `--level max`, Anthropic at `--level high`), with duplicates dropped and each solution labelled with the vendor that produced it.
- Solutions are mutually distinct approaches, not variations on one design.
- Every solution carries the five fields: core approach, the key non-obvious insight or cross-domain connection, trade-offs (performance, complexity, cost, maintainability), implementation difficulty 1-10 with the reason, and why it is not the default answer.
- The recommendation names one approach and justifies it against the stated constraints.
- The response follows the Output format.
- The recommended approach is one the principal would not have written on the first pass and still fully answers the brief.

## Anti-criteria

- Generation never runs on one vendor alone: a single model's "diverse" set shares that model's defaults.
- Not used for writing, naming, or marketing angles; those go to the other intents.

## Tool contract

Technical ideas are judged by whether they work, so generation goes to the strongest correctness lane, with a second vendor for contrast. Run both calls in parallel, each asking for 5 solutions with the five fields from the Ideal State:

```bash
bun ~/.claude/LIFEOS/TOOLS/Inference.ts --level max --vendor openai --timeout 300000 \
  "You generate diverse, non-obvious technical solutions and state their trade-offs honestly." \
  "<problem + hard/soft constraints + measurable success criteria + the five fields from the Ideal State>"
bun ~/.claude/LIFEOS/TOOLS/Inference.ts --level high --vendor anthropic --timeout 300000 \
  "<same system prompt>" "<same user prompt>"
```

## Output format

```markdown
## Creative Technical Solutions for: [Problem Name]

### Solution 1: [Descriptive Name] ([vendor])
**Core Approach:** [algorithm/architecture]
**Key Innovation:** [the insight or cross-domain connection]
**Trade-offs:** Performance / Complexity / Cost / Maintainability
**Implementation Difficulty:** [1-10 with explanation]
**Why Creative:** [non-obvious thinking or novel combination]

### Solution 2 … [repeat per solution]

## Recommendation
**Selected Approach:** [Name]
**Justification:** [why it best balances constraints and goals]
**Next Steps:** [1-3 action items]
```
