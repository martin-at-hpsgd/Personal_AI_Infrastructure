# FindLeverage

A leverage point analysis that picks the highest feasible Meadows-level intervention and predicts its effects.

## Ideal State

- The output states the system, its actual goal inferred from resource allocation, metrics, and rewards, and the desired behavior.
- It compares 3–6 concrete interventions across leverage levels, each placed on the canonical Meadows numbering.
- The selection is the highest feasible leverage within the system's real constraints (time, cost, ownership, and political ones where an organization is involved; the principal's attention and the harness's own rules in a solo AI harness), explains why higher levels are infeasible, and optionally bundles a tactical measure to buy time.
- The selection predicts changed variables, strengthened/weakened loops, activated archetypes, and actor adaptation.
- The chosen intervention's **CausalLoop** trace exists before it is committed, and at levels 1–5 it is never skipped.
- Success is measurable over a stated reevaluation interval.

## Anti-criteria

- Difficulty alone never implies leverage; an infeasible paradigm change has no effective leverage.
- No culture intervention is offered without a concrete first move.

## Output format

Use the canonical numbering: 12 parameters; 11 buffers; 10 material stock-and-flow structure; 9 delays; 8 balancing feedback strength; 7 reinforcing feedback gain; 6 information flows; 5 rules/incentives; 4 self-organization; 3 goals; 2 paradigms; 1 transcending paradigms. Lower numbers indicate higher theoretical leverage. Consult `../LeveragePoints.md` for exceptions and gates.

```
🎯 LEVERAGE POINT ANALYSIS: [system]

SYSTEM GOAL (implicit): [...]
DESIRED BEHAVIOR: [...]

CANDIDATE INTERVENTIONS:
- [A]: Level [N]
- [B]: Level [N]
- [C]: Level [N]

HIGHEST FEASIBLE LEVERAGE: [Chosen intervention]
- Meadows level: [N]
- Why feasible: [context]
- Why highest: [why the higher levels are not feasible right now]

BUNDLED LOW-LEVEL TACTICAL INTERVENTION: [if any, to buy time]

EXPECTED EFFECTS:
- First-order: [...]
- Second-order: [...]
- Third-order: [...]

RESISTANCE TO EXPECT:
- Policy resistance from: [who, why]
- Paradigm clash: [if Level 2 or 3, what belief is threatened]

MEASURE OF SUCCESS: [how you'll know the leverage worked]
TIMELINE: [when you'll re-evaluate]
```
