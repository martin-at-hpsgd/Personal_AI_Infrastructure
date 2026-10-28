# Verify

Check whether a landed climb actually made things better where it counts. For a skill, that means the principal complains about it less. An Upgrades record is marked verified only on that evidence.

## Ideal State

- For a skill climb, Errata's before and after complaint rate around the climb's close date is reported, with the windows and output counts behind it. The verdict is `improved`, `no-change`, `worse` or `insufficient-data`.
- For a rule climb, the rule's break count in the v4 report after the change is compared with the one before.
- For eval, ISA and metric climbs, the climb's own measurement is re-run on today's tree and compared with the closed result. A regression is a new hill.
- `improved` marks the climb verified and its Upgrades record verified. `worse` opens a new climb on the same target with the regression as its first miss. `insufficient-data` says how many more outputs it needs.
- Applied Upgrades from other producers that the survey flagged as never verified get the same treatment when they name a skill.

## Anti-criteria

- Windows shorter than the climb's natural cadence read `insufficient-data`. Say so; never round it up to a verdict.

## Safety gates

- A climb or an Upgrades record is verified only by an `improved` verdict from the records, the evidence that the target got better where it counts. A passing suite on its own is the climb's result, not its verification.

## Tool contract

```bash
bun ${LIFEOS_SKILL_DIR}/Tools/HillClimb.ts list
bun ${LIFEOS_SKILL_DIR}/Tools/HillClimb.ts verify <id> [--days 14] [--dry-run]
bun LIFEOS/ERRATA/Errata.ts impact --skill <Skill> --since <YYYY-MM-DD> [--days 14] --json
bun LIFEOS/ERRATA/Errata.ts impact --landed [--days 14] --json
bun LIFEOS/TOOLS/Upgrades.ts verify <upgrade-id> --note "<before → after>"
```

### Intent-to-Flag Mapping

| User says | Flag |
|---|---|
| (default) | `--days 14` windows either side of the close |
| "just look", "don't mark anything" | `--dry-run` |
| "after a month" | `--days 30` |
