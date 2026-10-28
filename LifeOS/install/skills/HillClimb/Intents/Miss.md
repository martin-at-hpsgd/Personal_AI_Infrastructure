# Miss

Turn one caught miss into a standing check that would have caught it, so it cannot happen again. This is the fast path of the loop, usually minutes.

## Ideal State

- The miss is pinned down: the output it was in (an Errata entry and its output ids, or the artifact path), what was asked, and what was wrong, in the principal's words where they exist.
- A check exists at the lowest tier that can honestly catch it. Code is used when the defect is literal or countable, a judgment-layer question when it needs reading, and a judge case only when neither works.
- The check is attached where the miss came from: the skill's Proof profile, the owning ISA criterion (`bunker miss`), or the skill's suite.
- The check is shown to fail on the missed output and pass on a corrected one.
- When the miss came from a false pass, the receipt that passed it is named, so Errata's false-pass rate for that check can move.
> The Bunker CLI is maintainer-private and not in the public release; run code rows with `bun test ./<path>` and suite rows with `bun skills/Assay/Tools/EvalRunner.ts`.

## Anti-criteria

- The principal's words are quoted, never paraphrased. Errata holds them verbatim for a reason.
- A check that would not have caught the miss is never reported as done.

## Safety gates

- A new judgment-layer question starts in shadow. It flags and never blocks until principal labels earn it.

## Tool contract

```bash
bun LIFEOS/ERRATA/Errata.ts show <erratum-id>
bun LIFEOS/ERRATA/Errata.ts misses --json
bun skills/Assay/Tools/Proof.ts receipt --artifact <file>
bun skills/Assay/Tools/Proof.ts run --artifact <file> --skill <Skill> --json        # must now fail on the missed output
bun LIFEOS/PULSE/Bunker/bin/bunker.ts miss <isa> <isc> --kind noul|choice|score --id <id> --question "<text>"  # maintainer-side: the Bunker harness does not ship
bun skills/Assay/Tools/FailureToCase.ts --suite <suite> --id <case> --prompt "<ask>" --banned "<the bad phrase>" --expect "<what good does>"
```

The climb ledger is optional for a single miss. When the same kind of miss repeats, open a Skill or Eval climb instead, because a pattern is a hill.
