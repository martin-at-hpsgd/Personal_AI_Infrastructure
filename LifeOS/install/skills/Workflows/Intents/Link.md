# Link

Workflows chained: "when A finishes, run B", or "call B as a step of A".

## Ideal State

- A comparison of A's `output` schema with B's `input` schema, both taken from the current definitions of A and B, existed before the link was added.
- The link matches the need: an `after` trigger on B, written by `workflow link`, when B starts after A finishes as its own run, or a `kind: workflow` step in A when A calls B in the middle of its own steps.
- On `succeeded`, every field B requires is a required field of A's output with a compatible type; where the shapes were far apart, a small `command` step in A produces the shape B needs.
- `workflow validate` exits 0 for both A and B, and the principal is told the connection class (`checked`, `runtime` or `mismatch`) read from `workflow graph <B>`.
- The principal is told what fires; the chain is said to run by itself only after the dispatcher is shown alive (`launchctl list | grep com.lifeos.workflows-dispatcher`, plus `bun LIFEOS/VIGIL/Vigil.ts heartbeat --json` showing the `workflows-dispatcher` row not stale where Vigil is installed), and otherwise the report says the chain will not fire until the dispatcher is back.

## Anti-criteria

- The schemas change, never the validator, to make A's output fit B's input.
- No link to an upstream that does not exist or is not valid: the `after` link needs A to exist, and a broken A makes B's validation fail on the link.
- A workflow never runs itself as a step.

## Tool contract

1. **Check the upstream.** `bun LIFEOS/WORKFLOWS/workflow.ts list --json` shows every definition and whether it is valid. On `succeeded`, validation fails naming both schemas when A's `output` does not fit B's `input`.
2. **Add the link.** For an `after` link run `bun LIFEOS/WORKFLOWS/workflow.ts link <A> <B> [--status succeeded|failed|completed]`: it writes the trigger into B and refuses, naming both schemas, when A's output does not fit B's input. For a call, add the `kind: workflow` step to A.
3. **Validate both.** `bun LIFEOS/WORKFLOWS/workflow.ts validate <A>` and `validate <B>`.
4. **Read the connection class.** `bun LIFEOS/WORKFLOWS/workflow.ts graph <B>` (add `--json` for the exact fields). Each connection is `checked` (types proven fit), `runtime` (checked at run time, as with `failed` and `completed` links) or `mismatch` (fails validation).
5. **Check the dispatcher is alive.** A `workflow`-kind step runs the child as its own ledger run inside A's run. An `after` trigger is started by the dispatcher (`com.lifeos.workflows-dispatcher`, `engine/dispatcher.ts serve` under KeepAlive): it reads A's ledger line and starts B with A's output as input. `launchctl list | grep com.lifeos.workflows-dispatcher` shows whether it is loaded; where Vigil is installed, `bun LIFEOS/VIGIL/Vigil.ts heartbeat --json` shows whether its `workflows-dispatcher` row is stale.

### Two ways to link

| Need | Mechanism |
|------|-----------|
| B starts after A finishes, as its own run | An `after` trigger on B: `{ type: after, workflow: A, status: succeeded }` |
| A calls B in the middle of its own steps | A step in A with `kind: workflow` and `workflow: B` |
