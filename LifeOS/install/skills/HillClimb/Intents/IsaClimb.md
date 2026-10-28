# IsaClimb

Climb an ISA's power as an instrument: criteria that point where the ladder points, each proven by the cheapest honest check.

## Ideal State

- The baseline records the drift verdict (`IsaLadder.ts drift`), the `Rate` score, the count of `manual` rows, the count of judged rows that could be code, and the fog still open.
- The misses are criteria a passing build could satisfy while missing the ladder, rows that cannot fail, and principal catches the criteria never named (Errata complaints joined to the ISA's outputs).
- A kept change improved drift or Rate, whatever its shape (for example rewritten or split criteria, rows moved down the ladder from human to glance to code, or a restructured feature set).
- Each principal catch the criteria had missed is now a criterion whose Test Strategy row is the standing check that would have caught it.
- Every new criterion carries a Test Strategy row, and `bunker test --isa <path>` runs green or reports honestly.
> The Bunker CLI is maintainer-private and not in the public release; run code rows with `bun test ./<path>` and suite rows with `bun skills/Assay/Tools/EvalRunner.ts`.

## Anti-criteria

- The principal's stated goal and L3 never move in this climb. If the climb shows they should move, it stops and runs `Skill("ISA", "restate")`.
- A kept change never weakens a criterion's falsifier.
- The ISA skill owns the ISA's format and articulation. Edits follow ISAFormat, and the Articulation Log is append-only.

## Safety gates

- A project ISA is read by other things (Pulse, Bunker, the monitor). After a criterion ID change, run the consumers.

## Tool contract

```bash
bun LIFEOS/TOOLS/IsaLadder.ts check <isa>
bun LIFEOS/TOOLS/IsaLadder.ts drift <isa>
Skill("ISA", "rate <isa>")
Skill("ISA", "check completeness <isa>")
bun LIFEOS/PULSE/Bunker/bin/bunker.ts test --isa <isa>  # maintainer-side: the Bunker harness does not ship
bun LIFEOS/PULSE/Bunker/bin/bunker.ts attest <isa> <isc> pass|fail --note "<why>"  # maintainer-side: the Bunker harness does not ship
bun ${LIFEOS_SKILL_DIR}/Tools/HillClimb.ts start --type isa --target <isa-path> --metric "rate score" --direction higher --why "<why>"
```
