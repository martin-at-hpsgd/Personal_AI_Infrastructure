# QuickDiagnosis

A brief, timeboxed diagnosis with competing causes and discriminating evidence, for debugging.

## Ideal State

- The diagnosis is brief and tied to an observable fixed state, stated as a one-sentence GOAL.
- At least three competing causes are named, each with an observable falsifier, and the evidence gathered discriminates among them.
- Fast-to-verify, likely causes are preferred, with the reason for the first test and its cost stated.
- The diagnosis finishes when solved, or escalates to StructuredInvestigation when information is unavailable, scope grows, or 15 minutes of QuickDiagnosis has not resolved the problem.

## Anti-criteria

- The diagnostic timebox is never extended.

## Output format

- **GOAL:** one sentence defining fixed.
- **H1, H2, H3:** cause and supporting evidence/reasoning; each includes an observable falsifier.
- **Test H-number first because:** test choice and cost rationale.
- **Observation and verdict:** CONFIRMED → fix; REFUTED → next hypothesis; INCONCLUSIVE → better test/data.

Under severe time pressure, retain the compact shape: “I think X because Y. If I'm wrong, Z would be true. Let me check Z.”
