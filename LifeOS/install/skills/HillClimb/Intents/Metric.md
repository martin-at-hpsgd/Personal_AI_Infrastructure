# Metric

Climb code toward a number: latency, bundle size, memory, test time, a Lighthouse score.

## Ideal State

- One measure command prints the number, and the climb records its direction and, when given, a target value.
- The measure is stable. The baseline is the median of three or more runs, and the spread is recorded, so a keep must beat the best by more than the spread.
- Guard rails hold on every kept change: the target's tests pass, typecheck passes, and the owning ISA's liveness rows stay green.
- The new number is guarded by a standing check, either a budget assert in the target's tests or a row in its ISA's Test Strategy. It fails if the metric slips back past the new value plus its spread.
- The improvement reproduces by re-running the measure command on the committed tree.
- When the number is API spend, the metric is cost per completed task with quality held within noise.

## Anti-criteria

- No kept change trips a guard rail. An experiment that fails the target's tests, typecheck or the owning ISA's liveness rows is reverted whatever its number.
- Only the declared files change. A measure that improves because a test or check was skipped is a revert.

## Safety gates

- A measure command that hits the network or a live service is run against a local or staging target, never production.

## Tool contract

```bash
bun ${LIFEOS_SKILL_DIR}/Tools/HillClimb.ts start --type metric --target "<what>" --metric "<name>" --direction lower|higher --why "<why>"
<measure command>                                     # run 3+ times; record the median
bun ${LIFEOS_SKILL_DIR}/Tools/HillClimb.ts baseline <id> --value <median> --source "<measure command>, median of N" --noise <spread> --noise-source "spread of N unchanged runs" --instrument <measure script or config file> [--ceiling <target>]
bun ${LIFEOS_SKILL_DIR}/Tools/HillClimb.ts exp <id> --hypothesis "<change>" --kind <knob|wording|rule|structure|delete|add|import> --origin <proposer-id> --value <median> --keep|--revert --ref <sha>
bun ${LIFEOS_SKILL_DIR}/Tools/HillClimb.ts plateau <id> --window 3
```

`--instrument` is required for any keep: `exp --keep` refuses when the baseline recorded no instrument (`HillClimb.ts` keep gate). Name the file that defines the measure (the benchmark script, the measure config, or a file holding the measure command), so a changed measure is caught as a new series.

### Intent-to-Flag Mapping

| User says | Meaning |
|---|---|
| "until it's under X", "target X" | stop at the target value |
| "20 tries" | `start --budget 20`: `exp` refuses once 20 rows are recorded, then `close --stop budget` |
| "spend an hour" | the tool counts experiments, not minutes: estimate how many fit in the hour and pass that to `start --budget` |
| (stopping) | `close <id> --stop plateau\|target\|budget\|abort [--reason "<text>"]`; target needs a keep, plateau a plateaued verdict |
| (nothing) | stop when `plateau` confirms one; `widen` means try other kinds of change first |

## References

### Cost as the target

A cost climb has measured caching health and the walk across model and effort before it spends rounds on prompt wording, and its report gives each lever's measured share of the saving (Anthropic's cost hill-climbing guide, bundled with `/claude-api cost-optimize` and `/claude-api hillclimb`, ranks the levers: caching, a prompt audit, model and effort, then a prompt climb on the chosen model). The router's lanes (`LIFEOS/ROUTER/Router.ts lanes`) and `LIFEOS/TOOLS/models.ts` are where model choices land.
