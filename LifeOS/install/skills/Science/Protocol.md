# The Science Protocol

Skills implement Science independently; compliance is documentation, not runtime coupling. Science orchestrates diagnosis and investigation of cross-domain and novel problems without an existing skill pattern; specialist skills execute domain work and Science coordinates their results. Experiment comparisons that improve a measured target belong to HillClimb.

## Interface

A compliant intent provides a goal with success criteria, measurable indicators, constraints, and optional anti-goals; observations; at least three hypotheses; experiments; measurements; analysis against the goal; and a next action. A skill that follows the protocol says so in its body; there is no frontmatter marker for it.

## Handoff Boundaries

| Specialist | Science supplies | Specialist returns |
|------------|------------------|--------------------|
| Development | Hypothesis, success criteria | Test results, coverage |
| Assay | Measurements, baseline comparison | Scores, statistical analysis |
| Research | Questions, scope | Findings, evidence quality |
| Council | Options, judgment criteria | Synthesis, convergence |
| Worktree | Variant names, comparison criteria | Diff analysis, recommendations |

For prompts, invoke Assay → Compare directly; do not build ad-hoc evaluation. Compare supplies a paired-difference confidence interval and a meaningful-difference threshold stated before the run. It does not do position swapping, multi-judge panels or p-values, so a design that needs them says how it gets them. HillClimb carries the invocation contract (`skills/HillClimb/Intents/Prompt.md`) and records Compare's CI as the climb's noise floor.

A HillClimb climb whose `stall` is categorized `structural` comes to `Science/Intents/StructuredInvestigation.md` (or DefineGoal when the goal itself is wrong): examine the use case and measurement frame, then return a new hypothesis, direction, or evidence to continue the climb.

## Scale

| Scale | Formality |
|-------|-----------|
| Micro: seconds–minutes | Implicit |
| Meso: hours–days | Explicit when stuck |
| Macro: weeks–months | Formal documentation |
| Meta: months–years | Constitutional; skill versioning |
