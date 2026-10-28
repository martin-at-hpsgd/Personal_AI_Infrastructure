# Eval

Climb an instrument: a suite, a judge, a judgment-layer question or a standing check. A climb on anything else is only as good as the instrument that measures it.

## Ideal State

- The instrument's ideal state is named: the criterion it measures (from the owning ISA or skill) and the principal's labels on it.
- The baseline is the instrument's own quality, not its pass rate. That means agreement and kappa against principal labels (`Calibrate.ts`), whether it catches its adversarial fixture, its judged residue, and, for a standing check, how often it was dismissed with no matching complaint.
- The misses are the cases where the instrument and the principal disagreed, the false passes Errata found, and the cases it cannot tell apart.
- A kept change sharpened the instrument (for example anchored rubric levels, a mixed rubric split into small typed questions, a case from a real miss, a judged check moved down to code, or a change to the instrument's structure) and raised agreement or lowered residue without losing the adversarial catch.
- A check that never catches anything is retired through `Proof.ts retire` with its reason, and the retirement is reported as its own result.
- Each disagreement the climb resolved is now a labelled case in the instrument, so the standing check that caught nothing before catches it now.
- A grader climb holds out labels the same way a target climb holds out cases: calibrate on half the principal labels and report agreement on the other half.
- A grader fix re-grades every stored output from the earlier rounds, and the climb reports whether the ranking of variants changed. If it flipped, the earlier rounds were tuned to the wrong signal, and the principal decides whether to restart from baseline.
- A failing regression suite was either fixed at the thing it guards or shown to be wrong by principal labels.

## Anti-criteria

- Agreement between models is not a label. Only the principal's labels earn an instrument (`LIFEOS/TOOLS/lib/LabelStore.ts`).
- The instrument improves only by fixing it, never by deleting, weakening or skipping a check, and a retirement is never reported as a score gain.
- A failing regression suite never passes because its threshold moved.

## Safety gates

- A judge, rubric or anchor edit breaks score comparability. Report the before and after as two series and recalibrate.

## Tool contract

```bash
bun skills/Assay/Tools/SuiteManager.ts show <suite> --json
bun skills/Assay/Tools/SuiteManager.ts validate <suite>
bun skills/Assay/Tools/Calibrate.ts -s <suite> --json [--append-log]
bun skills/Assay/Tools/Calibrate.ts --residue
bun skills/Assay/Tools/EvalRunner.ts -s <suite> -t 5 --json
bun LIFEOS/PULSE/Bunker/bin/bunker.ts miss <isa> <isc> --kind noul|choice|score --id <id> --question "<text>"  # maintainer-side: the Bunker harness does not ship
bun LIFEOS/TOOLS/LabelBatch.ts next --n 10               # get principal labels when there are too few to earn
bun LIFEOS/ASSAY/Assay.ts report --caller <name>
bun LIFEOS/ERRATA/Errata.ts misses --json                 # false passes and retire candidates
bun ${LIFEOS_SKILL_DIR}/Tools/HillClimb.ts start --type eval --target <suite-or-check> --metric "agreement" --direction higher --why "<why>"
```

## References

- Designing a new multi-question judgment system belongs to `Skill("Assay")` CreateQuestions. Writing a new suite from scratch belongs to `Skill("Assay")` CreateSuite. This workflow climbs ones that exist.
