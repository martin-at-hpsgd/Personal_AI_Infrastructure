---
intent: TestIdea
mode: single-run
---

# TestIdea

Tests any idea, strategy, investment, brand, or concept against all 11 persistent world models (6 months to 50 years) to assess its viability across time horizons, returning a verdict and probability-weighted scenarios per horizon at the Fast, Standard or Deep tier. Ported from the retired WorldThreatModel skill on 2026-10-10 with nothing dropped.

## Ideal State

- A tested idea gets a verdict at every one of the 11 horizons, stated as scenarios with probability ranges, never as predictions, and weighted toward long-term structural analysis over short-term calls.
- The run uses the tier asked for (Standard when none is named) and names that tier. "fast" or "quick" selects Fast; "deep", "thorough" or "comprehensive" selects Deep. Fast is ~2 min (single agent synthesizes across all models, for a quick gut-check or casual exploration); Standard is ~10 min (11 parallel agents + RedTeam + FirstPrinciples, for most use cases, a good depth/speed balance); Deep is up to 1 hr (11 parallel agents + per-horizon Research + RedTeam + Council + FirstPrinciples, for high-stakes decisions and major investments).
- The idea was decomposed before it met the world models: stated in 1-2 sentences, with the core assumptions it relies on (market conditions, technology state, cultural norms, regulatory environment, competitive landscape) and its success dependencies (what must remain true for this to work) identified.
- On Standard and Deep tiers, FirstPrinciples classified the assumptions as hard constraints (physics, demographics, math), soft constraints (policy, regulation, cultural norms), or assumptions (unvalidated beliefs the idea depends on); on Deep it ran the full deconstruct, challenge, reconstruct cycle on the idea.
- The idea was analyzed against all 11 model files, and the output shows for each horizon a verdict (🟢/🟡/🔴) and when the idea breaks or thrives. Fast tier gives a verdict plus 2-3 bullet points per horizon and an Executive Verdict, in the abbreviated format from OutputFormat.md (`References/WorldModelOutputFormat.md`).
- Standard tier output, in the full format from OutputFormat.md, gives for each horizon a Verdict, Key Factors, Analysis and Assumptions Tested, drawn from that horizon's ONE world model document with each assumption tested against that horizon's conditions; RedTeam's adversarial findings from attacking the idea across all horizons appear per horizon, and a Cross-Horizon Synthesis section is present.
- Deep tier output adds to Standard: per-horizon notes from a quick Research check on any new developments that affect this specific idea, longer per-horizon analysis from deeper prompts, adversarial findings across all horizons from a full ParallelAnalysis pass on the per-horizon results, and a Council Deliberation section from a Council debate on the idea's long-term viability, with all findings synthesized in the complete format from OutputFormat.md (all sections).
- Named alternative-future scenario files under `WorldModels/Scenarios/` in the user zone, when the user has written any, are consumed by TestIdea when the user names one or the idea depends on it; a dedicated TestScenario intent is planned, not yet built.

## Anti-criteria

- Never tests the idea against an incomplete set of world models: when any of the 11 model files is missing, the user is told to run UpdateModels first.
- A failed parallel agent or skill invocation never stops the run or vanishes from the output: remaining agents continue and the missing horizon is noted in the output; a skipped section (e.g. Council) is noted in the footer.
- Models stale by more than 90 days never go out without a prominent warning in the header and a recommendation to update.

## Safety gates

- All 11 model files must be present in `<configRoot>/LIFEOS/MEMORY/RESEARCH/WorldModels/` (configRoot is `$CLAUDE_CONFIG_DIR` when set, else `~/.claude`); if any is missing, say "World models incomplete. Run 'update world models' first."
- Models older than 30 days: warn and proceed.

## Tool contract

### Integration Points

| Skill | Tier | Purpose |
|-------|------|---------|
| **FirstPrinciples** | Standard, Deep | Decompose idea assumptions before testing |
| **RedTeam** | Standard, Deep | Adversarial attack on idea across horizons |
| **Council** | Deep only | Multi-perspective debate on viability |
| **Research** | Deep only | Quick refresh of horizon-relevant current events |

Standard tier invocations (Deep runs the same parallel analysis with deeper prompts):

- Up to 11 parallel agents (Agent tool, `run_in_background: true`), one per horizon.
- After all agents return, the **RedTeam skill** with the prompt "Attack this idea across all time horizons. Here are the per-horizon analyses: {results}" — inside this skill that is `Intents/ParallelAnalysis.md` run on the per-horizon results.

Deep tier invocations:

- **RedTeam**: a full ParallelAnalysis pass (`Intents/ParallelAnalysis.md`) on the per-horizon results, attackers scaled to the claims and split across vendors.
- **Council** with the prompt "Debate the viability of {idea} across time horizons from 6 months to 50 years. Consider: {per-horizon results}"

## Output format

Use the template in `OutputFormat.md` (now `References/WorldModelOutputFormat.md` in this skill). Ensure:
- Each horizon is clearly separated with its own section header
- Verdicts use consistent emoji indicators
- Confidence levels reflect model confidence × analysis certainty
- Adversarial findings attribute to specific horizon contexts

## Examples

```
User: "threat model my bet on AI-first content creation"
→ Analyzes across 11 time horizons (6mo to 50yr)
→ Identifies structural risks at each horizon
→ Returns probability-weighted scenario matrix
```

```
User: "stress test a paid-newsletter business model against the future, deep"
→ TestIdea at the Deep tier
→ Per-horizon verdicts with RedTeam findings, Cross-Horizon Synthesis and a Council Deliberation section
```

## References

- `References/WorldModelOutputFormat.md` — the result template and the Tier-Specific Inclusion table.
- `Intents/ViewModels.md` — check model freshness before testing.
