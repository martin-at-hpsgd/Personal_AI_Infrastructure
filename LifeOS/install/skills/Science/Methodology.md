# Science Methodology

Shared execution contract for [StructuredInvestigation](Intents/StructuredInvestigation.md) and [QuickDiagnosis](Intents/QuickDiagnosis.md). Measured experiments that improve a target follow HillClimb (`skills/HillClimb/References/Experiments.md`), whose tool enforces these invariants in code:

- Lock criteria before evidence collection. Do not change parameters mid-experiment unless aborting; record deviations and validity impact.
- Preserve original data unmodified. Derived metrics must remain reproducible from it.
- Monitor anomalies without stopping on favorable interim aggregates outside precommitted stopping rules. Check whether measurement itself changes the outcome.
- Parallel experiments require independence, available resources, and comparable results.

## Tool Routing

| Context | Tools |
|---------|-------|
| Observation | Research, Council, code search, metrics/analytics, user interviews when applicable |
| Code experiments | TDD, feature flags; a measured code number is a HillClimb Metric climb |
| UI/UX experiments | Interceptor skill, design variants; a judged film or image is a HillClimb critique climb |
| Business experiments | A/B tests, small launches, pilots; a measured product number is a HillClimb metric climb |
| Idea experiments | Small audience tests, draft/feedback loops; with the principal reviewing between passes, HillClimb Loop |
