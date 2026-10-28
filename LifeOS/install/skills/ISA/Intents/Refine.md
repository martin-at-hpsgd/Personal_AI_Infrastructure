# Refine

Brings mid-run doubt about the ideal state to the principal as a queue of `ask` fences in the ISA, and folds each answer back into the ladder and the criteria the same turn.

## Ideal State

- When a run hits a question about what done means that only the principal can settle (intent, taste, priority, a fork that changes what gets built), the question exists as an `ask` fence directly under the criterion it changes, before any work built on a guess. The fence carries my recommended pick marked `x`, `blocks` naming the criteria whose shape depends on it, `raised-by` naming what surfaced it, and `looked-up` naming what I checked first, so it reads as a decision and never a fact I could have found.
- The ask goes to the principal immediately only when the answer changes which criteria get built and either about an hour or more of work depends on it or the work is production-bound. Every other ask is queued: the reversible default is built, and unblocked criteria keep climbing.
- Queued asks reach the principal at a natural break: a milestone closing, before a deploy, before a fan-out, when no unblocked criterion is left, and at close. They come in rounds of at most three, blocking ones first (`IsaAsks.ts list --open`), each with my recommended answer first and a one-line objection to my own pick when it is low-confidence. At the terminal the round is one AskUserQuestion call.
- Each answer is recorded through `IsaAsks.ts answer` with the principal's words verbatim in `--note`, so the fence shows it answered and the Articulation Log holds the raw record.
- The same turn, the answer is folded: L1 rewritten where it changed what the thing is, L2 and L3 re-derived, criteria added, split, tightened or killed with a `refined:` row in Decisions, and `bun LIFEOS/TOOLS/IsaLadder.ts drift <isa>` run again with any `partial` or `divergent` verdict resolved. Restate runs only when L3 or L2 changed structurally.
- Asks that cluster become one conversation, not a string of single questions: when an answer would change L3 or L2, or when two or more open asks block the same Feature or criterion, the round runs as a Discuss align round (`Skill("ISA", "discuss <isa>")`, the shared engine with the ladder shown first and a challenge question). Its answers are recorded against each fence through `IsaAsks.ts answer`, the one writer for ask rounds, and are not checkpointed a second time. Unrelated local asks stay queued for the next break. `bun LIFEOS/TOOLS/IsaAlign.ts status <isa>` reports that threshold.
- At close, every ask still open is settled with `IsaAsks.ts settle`, which records the default taken as `default-unratified` in Decisions, and the closing report names those asks.

## Anti-criteria

- Never asks for a fact the code, files, deploy state, a prior ISA or a tool could answer; that is a lookup, and its result goes in `looked-up` or the work.
- Never asks the principal to do manual work (a test, a click, a check) in place of an ask; the system does the work and asks only for the decision.
- Never re-asks a question already answered or recorded in Decisions unless new evidence contradicts the answer, and the new ask names that evidence in `raised-by`.
- Never lets an unanswered ask block close or stop unblocked criteria from climbing.
- Never records a default taken without an answer as the principal's agreement.
- Never edits an earlier Articulation Log block; answers only append.
- Never asks without a recommended pick, and never asks in prose alone: the fence is the record.

## Inputs

| Input | Required | Description |
|-------|----------|-------------|
| isa_path | yes | The ISA whose asks are raised, asked or settled |
| mode | no | `raise` (write a new ask), `ask` (run a round now), `settle` (close); inferred from the moment when absent |

Invoked by the run itself whenever it is unsure what the principal wants mid-climb, at each breakpoint above, and by the principal directly ("what are the open questions", "ask me the questions", "refine the ISA").

## Tool contract

Run from `~/.claude`. Fence syntax and the lifecycle attributes: `LIFEOS/DOCUMENTATION/ISA/ISAFormat.md` § Exhibits.

```bash
bun LIFEOS/TOOLS/IsaAsks.ts list <isa> [--open] [--json]
bun LIFEOS/TOOLS/IsaAsks.ts answer <isa> --id <ask-id> --value <value>[,<value>] --note "<principal's words, verbatim>" [--source terminal|relay|pulse|voice]
bun LIFEOS/TOOLS/IsaAsks.ts settle <isa>
bun LIFEOS/TOOLS/IsaLadder.ts drift <isa>
```

`answer` refuses an unknown id or value and writes nothing. ISAGate reports open asks at close as the advisory `open-asks`; it never blocks.

### Intent-to-Flag Mapping

| The moment | Command | Effect |
|------------|---------|--------|
| "what are the open questions", a breakpoint | `list --open` | The queue, blocking asks first |
| the principal answered | `answer --id … --value … --note "…"` | Fence marked answered, Log block appended |
| "just take your defaults", run closing | `settle` | Open asks become `default-unratified` Decisions rows |
| needs machine-readable output | `--json` | JSON on stdout |

## Gotchas

- **Asks need a home to be cheap.** Before this intent existed, almost no touched ISA recorded fog and none recorded an ask, so mid-run doubt was guessed past rather than written down (analysis 2026-10-10). The cost case (2026-10-07) was a page that reached production broken while its experiential criterion stayed open and no question was asked: a rendered capture with a default is often the right ask. The install's own numbers and incident live in the USER extension `History.md`.
- **An ask is not fog.** Fog (`## Not yet specified`) is a question too dim to answer yet; an ask is a decision ready to be made. A fog line that sharpens into a decision becomes an ask.

## Output format

A round at the terminal is one AskUserQuestion call of up to three questions, recommended option first. The report after a round names each ask answered, what changed in the ladder and criteria, and the drift verdict. The closing report names every ask settled as `default-unratified`.

## References

- `../References/Discussion.md`: the shared interview engine (frontier rounds, recommendations, facts looked up rather than asked).
- `Restate.md`: runs when an answer changes L3 or L2 structurally.
