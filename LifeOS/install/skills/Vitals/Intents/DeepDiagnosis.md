# DeepDiagnosis

Full sweep when a quick check isn't enough: chronic slowness, recurring fan noise, degraded-over-time feel.

## Ideal State

- The picture is complete across every subsystem: CPU, memory, GPU, thermal, disk, startup load.
- Each reading is judged against `../Interpretation.md` thresholds.
- Findings come as a ranked list, worst first, each with its evidence.
- A remediation plan follows that the operator approves item by item.
- Startup findings distinguish failed agents (non-zero last exit) from merely numerous ones.

## Anti-criteria

- A large agent count alone is never reported as a finding.
- The sudo leg (`powermetrics`, `sfltool`) never runs without operator consent and is never required; if declined, it is skipped cleanly.
- No remediation item is executed without the operator approving that item.

## Tool contract

```bash
bun ~/.claude/skills/Vitals/Tools/Vitals.ts full --top 15   # everything, no sudo (~4s)
bun ~/.claude/skills/Vitals/Tools/Vitals.ts startup         # launchd agent audit
```

### Optional sudo leg, only after the operator consents

`powermetrics` is the only source for per-process energy impact, CPU frequency/residency, accurate GPU power, and thermal pressure detail:

```bash
sudo powermetrics -n 1 -i 2000 --samplers tasks,cpu_power,gpu_power,thermal
sudo sfltool dumpbtm    # login items + background task management inventory
```

## Gotchas

- `powermetrics` with no `-n` keeps sampling until interrupted, so always pass `-n 1` (or `-n 2` for a settle sample).
- On Apple Silicon, `cpu_power` reports per-cluster (E-core/P-core) frequency and residency. E-cores pinned at max with P-cores idle usually means background QoS work, not user-facing load.
