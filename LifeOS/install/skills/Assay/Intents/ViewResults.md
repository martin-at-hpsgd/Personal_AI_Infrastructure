# ViewResults Intent

Inspect eval results, trends, saturation, and shrinkage.

## Ideal State

- Every score trend is read per judge: a trend spanning a judge, rubric or anchor change is flagged as two series (`latest.json` carries `judge_level` and `ts`), never averaged across.
- Capability suites at pass^k 100% for 3+ runs are named as saturated and ready to graduate (Anthropic lifecycle), with a harder suite as the next step.
- Judged residue per suite is reported and expected to fall over time; a flat high residue is called out as disagreement mining not happening (Calibrate intent).
- Every conclusion cites the transcripts it rests on, and no conclusion rests on the number alone: the transcript is the finding.

## Anti-criteria

- Averaging scores across a judge change.
- Reporting a trend without having read the transcripts behind it.
- Graduating a capability suite that has not held saturation.

## Tool contract

```bash
bun ${LIFEOS_SKILL_DIR}/Tools/SuiteManager.ts list [--json]     # every suite + last result + residue
bun ${LIFEOS_SKILL_DIR}/Tools/SuiteManager.ts saturation        # capability suites ready to graduate
bun ${LIFEOS_SKILL_DIR}/Tools/SuiteManager.ts graduate <suite>  # capability → regression (USER suites)
bun ${LIFEOS_SKILL_DIR}/Tools/Calibrate.ts --residue            # judged-residue shrinkage report
```

Raw records: `MEMORY/STATE/Evals-Results/<suite>/latest.json` (headline + stats + judge metadata), `<run_id>/run.json` (full per-trial transcripts and assert results), `compare_*.json` (paired comparisons).
