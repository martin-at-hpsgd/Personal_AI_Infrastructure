# CausalLoop

A causal loop diagram (CLD) that explains repeated behavior through named feedback loops, plus an analysis of how a proposed intervention plays out.

## Ideal State

- The CLD answers one specific, stated question with 5–15 quantities that can rise or fall, preferring 5–7 when they explain the behavior, and retains consequential soft variables such as trust or morale.
- Every causal arrow has a one-sentence mechanism, a polarity, and any delay significant relative to the system's rhythm.
- Every named loop closes back to its start and has a verified R/B classification: an even number of negative arrows (including zero) means R, an odd number means B.
- Each reinforcing loop names what it amplifies and its limit; each balancing loop names its goal and what sets that goal.
- Current and emerging loop dominance, and the effects of delays, are stated.
- The intervention analysis traces the affected variable through first-order arrows, second-order loop changes, and the equilibrium after delays, including effects on untargeted variables, and accounts for balancing pushback.
- The Recommended line names one feasible leverage point in this CLD: the variable, arrow, loop or boundary to change.

## Anti-criteria

- Intermediate causes are never collapsed: no A→C→B chain is drawn as a direct A→B link.
- When balancing pushback is absent, no loop is invented to supply it; the model boundary is rechecked instead.
- The diagram never merely charts the event chain of one outage; it must explain repeated behavior over time.

## Output format

### Diagram contract

- Arrows use (+) for same-direction effects and (−) for opposite-direction effects.
- Delays use double lines ═══ or `||`.
- Use named R/B loops; horizontal layouts with oval feedback paths are preferred.
- Mark exogenous variables distinctly, without incoming arrows.
- Use stock-and-flow notation when the qualitative CLD underdetermines behavior; see `../Foundation.md`.

### Output

```
🔄 CAUSAL LOOP DIAGRAM: [topic]

QUESTION: [what this CLD answers]

VARIABLES:
- [var1], [var2], [var3], ...

ARROWS (source → target, polarity, delay?):
- [A] →(+) [B]
- [B] →(−) [C] (delay)
- ...

LOOPS:
- R1 "Success-to-success": A → B → C → A (reinforcing)
  Dynamic: amplifies early wins, accelerates until limit
- B1 "Coordination tax": A → D → E → A (balancing)
  Dynamic: opposes growth, scales with team size

DOMINANT LOOP: [which is driving behavior now]
EMERGING DOMINANT LOOP: [which will dominate as system grows]

INTERVENTION ANALYSIS:
- Proposed: [X]
- Intended effect: [Y]
- Unintended: [which loop pushes back]
- Recommended: [attack the balancing loop directly, or accept tradeoff]
```

## Tool contract

To render a CLD as an actual diagram:

```bash
# Use Art skill with Mermaid or diagram rendering
Skill("Art", "Mermaid flowchart showing causal loop diagram with R1 and B1 loops, variables: [list], arrows with polarity: [list]")
```
