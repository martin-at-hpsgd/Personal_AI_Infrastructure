# StructuredInvestigation

An auditable, multi-hypothesis investigation record for complex problems, at working grade or, when the stakes call for it, research grade.

## Ideal State

- The investigation is auditable, and its goal, baseline, competing explanations, tests, results, and decision agree.
- At least three hypotheses are distinguishable by observable outcomes; important problems use five to ten.
- When the question asks how likely something is, each hypothesis carries its own probability or range for every horizon asked (this winter, over 20 years), the evidence that moves it, and the observation that would falsify it; a single blended number with no per-hypothesis split fails.
- Evidence for and against each hypothesis is weighed by its quality and recency, and where sources agree or conflict is stated.
- Findings the investigation did not set out to test are labelled exploratory and as needing replication, apart from the planned verdicts.
- The Investigation Record carries every section in the Output format table, and an **Investigation Summary: problem name** documents the outcome.
- A research-grade investigation (one spanning days or weeks, reviewed by several people, shared externally, needing statistical rigor, or settling a macro product or architecture decision) also carries: the goal and analysis plan pre-registered with the timestamp at which they were locked (DefineGoal), the analysis plan naming its statistical tests, missing-data handling and multiple-comparison correction so that a verdict drawn from several hypotheses or metrics on one dataset is judged at the corrected threshold, five or more hypotheses, ethical constraints noted, and a recorded reviewer and verdict at each of the five Review checkpoints under Safety gates.
- When the question becomes "make this measured number better", the goal and hypotheses go to HillClimb, which runs the experiments.

## Anti-criteria

- Never stops on favorable interim results.
- A verdict is never recorded where evidence cannot support one; those stay INCONCLUSIVE.
- Criteria are never changed after evidence collection begins, and raw data is never modified.
- The investigation never continues past an abort condition: an ethical concern, clear failure with no recovery path, a time or resource limit from the Goal Definition's Constraints reached or resources better spent elsewhere, or the goal met early under precommitted stopping rules. Every stop or pivot records the evidence and the reason in the Iteration section.
- A research-grade conclusion is never reported while a Review checkpoint has neither a recorded verdict nor the principal's waiver.

## Safety gates

### Review checkpoints (research grade)

A research-grade investigation is reviewed at five boundaries, each by someone who did not do the work being reviewed, and each row records who reviewed and the verdict. Council, a cross-vendor reviewer or the principal can fill a row; a role the run cannot reach is the principal's call to fill or waive, and the record says which.

| Boundary | Review | Reviewer role |
|----------|--------|---------------|
| Protocol design | Methodology approval | Domain expert |
| Pre-registration | Goal lock (DefineGoal) | The principal or the decision's owner |
| Experiment design | Validity check | Statistician or methods reviewer |
| Analysis | Results verification | Independent analyst |
| Conclusions | Interpretation review | Diverse perspectives (Council or cross-vendor) |

## Output format

| Section | Required content |
|---------|------------------|
| Goal Definition | Outcome; Success Criteria checkboxes; Constraints (time/resources/quality); Anti-Goals |
| Current State Observation | Facts with evidence/sources, unknowns and useful missing information, previous attempts/outcomes, baseline metrics |
| Hypotheses | Named H1–H3 minimum; Claim, Rationale, Evidence For, Evidence Against, Falsification Test, Cost to Test, Confidence; test cheap, likely, informative hypotheses first |
| Experiment Design | Per hypothesis: Method, Measuring (primary/secondary), CONFIRMED/REFUTED/INCONCLUSIVE criteria, Duration, Resources |
| Experiment Execution | Per experiment: Started timestamp, Status (Running/Complete), Raw Observations, Anomalies |
| Results | Per experiment table: Metric / Expected / Actual / Delta; Qualitative Observations; Data Quality Notes |
| Analysis | Goal Comparison table: Success Criterion / Required / Achieved / Status; Hypothesis Status with evidence; Key Learnings, Surprises, New Questions, Implications |
| Iteration | Stops and pivots with their evidence and reason (abort conditions included); achieved → document/finish; promising → deeper test; all refuted → new hypotheses; insufficient data → further experiments; changed frame → new goal (DefineGoal); a measured target to improve → HillClimb |
| Review (research grade) | Pre-registration timestamp; for each of the five Review checkpoints, the reviewer and verdict or the principal's waiver; ethical constraints |

### Documentation Artifact

Produce **Investigation Summary: problem name** with Date, Duration, Goal, Key Finding (one sentence), Hypotheses Tested with verdicts, Resolution, and Learnings for Future.

## References

- [Methodology.md](../Methodology.md) governs execution, including precommitted outcomes, collection limits and parallel experiments; [Protocol.md](../Protocol.md) covers specialist handoffs.
- [DefineGoal](DefineGoal.md) writes the pre-registered goal a research-grade investigation starts from.
- Measured experiments on a target: `skills/HillClimb/References/Experiments.md`.
