# ExplanatorySelection

A ranked portfolio of only those candidates that give a comparatively hard-to-vary causal explanation of the target phenomenon.

## Ideal State

- Only candidates that give a comparatively hard-to-vary causal explanation of the target phenomenon advance.
- Every candidate carries the full eight-part survivor artifact in Output format, with the target defined independently of the candidate vocabulary.
- Every candidate's reported stress-test outcomes cover all five tests in HardToVary.md § Stress Tests: parameter substitution, component ablation, rival equivalence, cross-state comparison, and causal-core compression.
- The portfolio ranks explanatory quality separately from empirical support and rhetorical appeal.

## Anti-criteria

- Never advances a candidate that only restates labels.
- Never advances a candidate that explains only report/access/attention/integration when the target differs.
- Never advances a candidate that invokes an unfalsifiable intrinsic property, declares an identity without causal consequences, or retains fit by arbitrary post-hoc variation.

## Output format

For every candidate, provide:

1. **Target:** phenomenon and observations, defined independently of the candidate vocabulary.
2. **Causal core:** a short causal chain from physical mechanism to target outcome.
3. **Necessary roles:** every core component, relation, or parameter and its explanatory job.
4. **Counterfactuals:** component-ablation and parameter-substitution effects.
5. **Rival comparison:** a simpler or serious rival and a target observation it does not explain.
6. **Risky prediction:** a discriminating outcome that could demote or falsify the candidate.
7. **Cross-context behavior:** predictions across relevant states, perturbations, development, failure, or recovery.
8. **Remaining residue:** what is still unexplained.

Return a ranked survivor portfolio with causal core, hard-to-vary score, stress-test outcomes, rival comparison, risky prediction, cross-context predictions, and remaining residue.
