# Loop — supervised iteration

Supervised iteration on one target: full Algorithm passes, each building on the last, with the principal reviewing and redirecting between passes.

## Ideal State

- The loop is opened in the HillClimb ledger with its target, metric and direction, and its baseline is recorded before the first pass, so it closes into an Upgrades record and can be verified later like every other climb.
- Each pass is a full Algorithm cycle on the target, and the principal reviews it and keeps, redirects or reverts it before the next pass begins.
- Every rejected approach is recorded with the reason it was dropped, as a `refuted by` entry in the ISA's `## Learning` trail (the C/R/L format, ISAFormat.md; the ISA has no `## Dead Ends` section), and a resume reads that trail and never retries the same change; a pass that recombines parts of dropped approaches names them. The ISA is the pass record: its frontmatter `phase:` is the only phase record, and its `iteration` field counts passes.
- The run ends on a measured outcome against baseline, in either direction: the final pass cites how far the target moved from where it started, or the run says plainly "no movement, here's why" and stops.
- The loop stops at its iteration cap, at its goal, or when the principal stops it.

## Anti-criteria

- A loop with no measured delta against baseline is never reported as an improvement.
- A pass starts before the principal has reviewed the one before it. A Loop runs only while the principal is reviewing its passes; unattended iteration belongs to HillClimb's measured climbs (Skill, Prompt, Metric, Eval and the rest), whose keep rule lives in code.
- A `mode:` field is written to the ISA.

## Inputs

| Argument | Required | Default | Description |
|----------|----------|---------|-------------|
| `--target PATH` | yes | | What to improve (file, directory, skill) |
| `--goal TEXT` | | inferred | What "better" means for this target |
| `--iterations N` | | 3 | Maximum number of Algorithm cycles |
| `--resume` | | | Resume a previous loop |
| `--status` | | | Show iteration history |

## Safety gates

- **Doctrine hold, held diff included (SKILL.md § Safety gates).** A change to the system prompt, the Algorithm, CLAUDE.md, the operational-rules file, the identity files, hooks or skills is shown to the principal as a diff and held for their yes before it is applied. A loop the principal asked for may edit its named `--target` directly, but not those files unless the target is one of them, and then only as a held diff.

## Tool contract

Open: `bun skills/HillClimb/Tools/HillClimb.ts start --type <skill|workflow|eval|isa|prompt|rule|metric> --target <what> --metric <name> --direction higher|lower --why "<text>"`, then `baseline <id> --value <n> --source "<how measured>"`.

Close: `bun skills/HillClimb/Tools/HillClimb.ts close <id> --stop reviewed --reason "<measured delta against baseline>; <goal met | iteration cap reached | principal stopped>" --upgrade <upgrade-id>`; `verify <id>` later checks that complaints fell. Passes go in the ISA, not `exp` rows: the code keep rule refuses a keep with no measured noise floor. `--stop reviewed` is the Loop's stop: `close` accepts it only on a climb with no `exp` rows and a `--reason`, and the measured delta goes in that reason and the ISA. Use `--stop abort` only when the loop is abandoned.

## Gotchas

- **`/loop` is not this intent.** It is Claude Code's built-in command for running a prompt on a recurring interval. Reach this intent through HillClimb.

## Examples

"Loop on the Research skill until its output quality improves, five passes": a skill climb opened in the ledger, five reviewed passes, closed with the delta and an Upgrades record.

"Iterate on prompts/summarize.md with me, more concise, less filler": a prompt climb, each pass shown before the next, stopped when the principal says it is there.
