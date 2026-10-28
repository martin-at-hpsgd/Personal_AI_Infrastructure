# Run

A definition run locally through the `workflow` CLI.

## Ideal State

- Before the real run, the definition validated and a `--dry-run` with the intended input checked it against the `input` schema and printed the plan.
- The principal knew before the run what would execute: `model` and `agent` steps cost money on the OpenAI lanes, a `judgment` step asks Assay's judgment layer, a `workflow` step runs the child as its own run, and a `human` step parks the run on disk (status `waiting`) and texts a 👍/👎 approval, resuming when it is answered.
- A run that belongs to a specific occurrence (a date, an event id) carries `--occurrence <key>`, so a retry of it is refused rather than run twice.
- The report gives the result value, the exit code and the ledger line the run wrote, as the Output format below specifies.
- A `runs_on: cloud` definition is reported to the principal plainly as refused locally, before any step starts, and the run stops there.

## Anti-criteria

- No real run with side effects before the principal's yes (§ Safety gates has the rule).
- A definition is never rewritten to dodge the `runs_on: cloud` refusal.

## Safety gates

- **Get the go-ahead for side effects.** If any step declares `write`, `outbound`, `money` or `deploy`, or is a `model` or `agent` step, name it to the principal and wait for a yes before the real run. Read-only and `none` steps can run without asking.

## Tool contract

1. **Validate first.** `bun LIFEOS/WORKFLOWS/workflow.ts validate <name>`. A run of an invalid definition is refused anyway; validating shows why.
2. **Dry run.** `bun LIFEOS/WORKFLOWS/workflow.ts run <name> --input '<JSON>' --dry-run`. It checks the input against the definition's `input` schema and prints the plan. It runs nothing and writes nothing to the ledger.
3. **Run.** `bun LIFEOS/WORKFLOWS/workflow.ts run <name> --input '<JSON>' --json`. Pass `--occurrence <key>` when the run belongs to a specific occurrence; a repeated key is refused, which is what makes a retry safe. Without it, every invocation is unique.

- Inputs are JSON. Build them with a `bun -e` snippet or a heredoc rather than hand-escaping a long string.
- Test runs against a scratch definitions home and ledger use `LIFEOS_WORKFLOWS_DIR` and `LIFEOS_WORKFLOWS_LEDGER`, so they leave the real ledger alone.

## Output format

The result value, the exit code (0 success, 1 invalid or failed, 2 usage), and the ledger line the run wrote: `LIFEOS/MEMORY/STATE/workflows/runs.jsonl`, one JSONL line per run. A parked run writes its line only when it resumes and ends; `workflow runs --active` lists it meanwhile. On failure, quote the failing step and the stderr tail the CLI printed.

## References

- To see what has run, use `Inspect.md`.
