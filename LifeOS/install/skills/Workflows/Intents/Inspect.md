# Inspect

Answers "what workflows do I have", "did it run", "why did it fail" and "what is this one" from the workflow CLI and the run ledger.

## Ideal State

- The answer to the question asked comes first (yes it ran, at this time, with this status), followed by the evidence: the command and the line it printed.
- Questions about definitions are answered from `workflow list`, `graph`, `validate` and `next`; questions about runs from `workflow runs`, with in-flight runs and parked human approvals from `runs --active`, since they have no ledger line until they end.
- A failure whose stderr has left the terminal is reproduced with `run`, not read from the ledger.
- "Is any job missing or orphaned" and "what needs attention" are answered from the inventory, `bun LIFEOS/WORKFLOWS/Workflows.ts`, not from the definitions.

## Anti-criteria

- Never reports a failure cause as read from the run ledger: stderr from a failed command step is never written there.

## Tool contract

### Definitions

- All definitions and their validity: `bun LIFEOS/WORKFLOWS/workflow.ts list --json`.
- One definition's steps, executors and connection classes: `bun LIFEOS/WORKFLOWS/workflow.ts graph <name> --json`.
- Whether it is well-formed: `bun LIFEOS/WORKFLOWS/workflow.ts validate <name>`.
- When its time triggers fire next: `bun LIFEOS/WORKFLOWS/workflow.ts next <name>`.

### Runs

Every run writes one JSONL line to `LIFEOS/MEMORY/STATE/workflows/runs.jsonl`: `workflow`, `occurrence_key`, `status`, `started_at`, `finished_at`, and per-step `status` and `attempts` under `steps`. Read recent runs with `bun LIFEOS/WORKFLOWS/workflow.ts runs <name> --limit 5 --json`; in-flight runs with `runs --active`. Stderr from a failed command step is shown by the CLI at run time only.

## Output format

Lead with the answer to the question asked (yes it ran, at this time, with this status), then the evidence: the command and the line it printed.

## References

### The inventory and the page

The inventory of everything LifeOS runs, reconciled as declared versus installed versus ran, is a different tool: `bun LIFEOS/WORKFLOWS/Workflows.ts summary|attention|list|show <id>|json`. Definitions in the home also appear on the Pulse `/workflows` page and at `GET /api/workflows`.
