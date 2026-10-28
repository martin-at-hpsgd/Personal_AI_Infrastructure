# Critique climbs (film and image)

A film or image climb is measured by ArtDirection critique readings, not a suite run. This file holds the `HillClimb.ts` contract for that climb type.

## Paired keeps from critique readings

- **A film or image climb keeps on paired readings, never on one median.** Baseline with `baseline <id> --from-critique <Critique.json>...` (k readings of one film), then `exp <id> --from-critique <candidate readings> --parent-critique <incumbent readings> --keep|--revert`. Each arm's readings average per sample, samples pair by index and per vendor, and a keep needs the paired 95% CI lower bound above zero. It refuses sample times more than 0.05 s apart, readings of two different renders in one arm, a parent that is not the incumbent film, a changed judge model, and `--value` on such a climb.
