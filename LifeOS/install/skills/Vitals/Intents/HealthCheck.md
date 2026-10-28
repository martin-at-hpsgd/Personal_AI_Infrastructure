# HealthCheck

Quick pass: how is the machine running right now? One screen, verdict first.

## Ideal State

- The report fits on one screen and the operator can absorb it in ten seconds.
- It opens with an overall verdict: 🟢 healthy / 🟡 something's working hard / 🔴 degraded.
- Per-subsystem lines follow (CPU load, memory, thermal, disk, top processes), with anything abnormal called out against the thresholds in `../Interpretation.md`.
- Normal-but-scary-looking readings (high "used" memory, kernel_task) are explicitly de-flagged in the report.
- If anything looks off, the report offers to run the FindCulprit intent.

## Anti-criteria

- Normal-but-scary-looking readings are never reported as problems.
- When anything looks off, the report is never padded with the investigation; that belongs to FindCulprit.

## Tool contract

```bash
bun ~/.claude/skills/Vitals/Tools/Vitals.ts check          # human-readable
bun ~/.claude/skills/Vitals/Tools/Vitals.ts check --json   # structured
bun ~/.claude/skills/Vitals/Tools/Vitals.ts check --top 15 # longer process lists
```

Runs in under a second, no sudo.
