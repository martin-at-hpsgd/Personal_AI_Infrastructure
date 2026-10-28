# Science Templates

Full records are each intent's Output format: Goal in [DefineGoal](Intents/DefineGoal.md); Hypothesis, Experiment and Results in [StructuredInvestigation](Intents/StructuredInvestigation.md). A measured climb keeps its hypotheses and results as rows in the HillClimb ledger instead. This file holds what they share: identity, status values and the compact form. Fill fields with actual findings.

| Record | Identity | Status |
|--------|----------|--------|
| Goal | Name, Created | ACTIVE / ACHIEVED / ABANDONED |
| Hypothesis | Name, H-number; claim as if–then–because | UNTESTED / TESTING / CONFIRMED / REFUTED / INCONCLUSIVE |
| Experiment | Name, EXP-number, tested H-number | DESIGNED / RUNNING / COMPLETE / ABORTED |
| Results | Experiment name, EXP-number, H-number, Date | Summary: the verdict in one sentence |

Compact records retain:
- **Goal:** name, Success, Metric, Deadline, NOT doing.
- **Hypothesis:** H-number/name, Claim, Because, Wrong if, Test cost.
- **Experiment:** name, Testing H-number, Method, Measuring, Success if, Failure if.
- **Results:** experiment, Tested H-number, Verdict, Key Metric vs Target, Learning, Next.
