# Detect — Heuristic AI-Pattern Audit + Statistical Signals

Flag the AI tells in a piece of text and explain each one, and measure the keyless statistical signals underneath the prose. No edits, no API calls, no cost.

## Ideal State

- Every flag quotes the offending text, so the writer can find it.
- Every flag names its pattern category and severity tier as `~/.claude/LIFEOS/DOCUMENTATION/Writing/AIWritingPatterns.md` defines them (its P0/P1/P2 severity tiers, word-replacement tables, pattern categories and context tolerance matrix), never a category or tier recalled from memory.
- Every flag is marked **clear problem** or **judgment call**, because some AI-associated patterns are effective writing.
- The context profile is stated up front (blog, LinkedIn, newsletter, documentation, fiction), because tolerance differs by venue; the same em-dash density that's fine in an essay is a flag in a LinkedIn post.
- On any sample past ~100 words, the statistical pass ran and its signals appear with their tier labels, as features feeding the assessment.
- When the text has 5+ flagged vocabulary hits across multiple categories, 3+ distinct pattern categories triggered, and uniform sentence and paragraph length, the report says so and recommends stating the core point in one sentence and rebuilding, because patching a text in the rebuild state produces cleaner AI writing, not human writing.

## Anti-criteria

- Nothing in the text under review is rewritten.
- No report demands that all AI-associated patterns be fixed; that is worse than useless, because it trains the writer to ignore the tool.
- No statistical signal is presented as a standalone verdict, and no numbers are reported under ~100 words, where the tool flags itself unreliable.

## Output format

```
**Profile:** [detected profile] | **Severity pass:** [P0+P1 / full]

**P0 — Credibility killers:**
- "[offending text]" — [category] — MUST FIX

**P1 — Obvious AI smell:**
- "[offending text]" — [category] — [clear problem / judgment call]

**P2 — Stylistic polish:**
- "[offending text]" — [category] — [clear problem / fine in context]

**Assessment:**
[clean / minor issues / needs rewrite] — [one or two sentences on which flags are real vs intentional]
```

## Tool contract

Run the deterministic signals alongside the pattern audit:

```bash
bun ~/.claude/LIFEOS/TOOLS/StatSignals.ts --file <path>   # or --text / stdin; --json for machine output
```

It measures n-gram entropy, type-token ratio, and repetition (the tier the research rates real-but-imperfect) plus burstiness, paragraph uniformity, and function-word ratio (weak alone — the GPTZero-class folklore tier). Every value carries its tier; nothing emits a verdict, because paraphrase degrades every keyless statistic (arXiv:2310.15264). These catch the *structural* tells the word list cannot see — a text can clear every pattern below and still show flat rhythm and low entropy. For the model-based zero-shot detectors (DetectGPT, Binoculars) that need reference-LM logprobs, `--explain` states why they're absent — the empirical seat is the Score intent.

## References

- `~/.claude/LIFEOS/DOCUMENTATION/Writing/AIWritingPatterns.md` — the pattern catalog the audit is made against. Auditing from memory produces a shallower, less consistent report.
