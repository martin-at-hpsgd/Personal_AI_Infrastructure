# Workflow

Climb one workflow, either a Workflows v2 definition or a skill's intent file, until it does its job more reliably and faster.

## Ideal State

- The workflow's ideal state is named: its declared output schema and what its consumers need from it, or the done-bar in the workflow file.
- A baseline exists from its run history. For a v2 definition that is success rate, failure reasons and duration from the run ledger. For a skill intent it is the skill's suite cases that exercise it, or its run lines joined to complaints.
- The misses are the failed runs, the schema mismatches, and the complaints about its outputs, each with its reason.
- Each experiment changed the definition or file and was re-run on the same inputs, so its number compares with the baseline's. A kept change beat the baseline and validates clean.
- A step whose output was judged by a model and could be checked by code now is checked by code.
- Each failure the climb fixed is guarded by a standing check (a schema, a code step, or a Test Strategy row) that fails if it returns.

## Anti-criteria

- No kept change leaves `workflow.ts validate` unclean.

## Safety gates

- Never run a workflow with live side effects (sends, deploys, purchases) as an experiment. Use `--dry-run` or a synthesized input, and say which.

## Tool contract

```bash
bun LIFEOS/WORKFLOWS/workflow.ts validate <name> --json     # must stay clean after every kept change
bun LIFEOS/WORKFLOWS/workflow.ts graph <name> --json        # runtime vs checked connections; a runtime edge is a typing hill
bun LIFEOS/WORKFLOWS/workflow.ts run <name> --input '<json>' --dry-run --json
bun LIFEOS/WORKFLOWS/Workflows.ts show <name>               # declared vs installed vs ran
# run ledger: LIFEOS/MEMORY/STATE/workflows/runs.jsonl
bun ${LIFEOS_SKILL_DIR}/Tools/HillClimb.ts start --type workflow --target <name> --metric "success rate" --direction higher --why "<why>"
```

## Gotchas

- A scheduled workflow's change applies to the next real run, so the before and after for its success rate comes from Verify, not from the session.
