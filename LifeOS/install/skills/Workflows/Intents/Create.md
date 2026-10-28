# Create

A plain-English request ("I want a new workflow that does X") turned into a validated definition that shows on the Workflows page.

## Ideal State

- The definition conforms to `Format.md`, and any part of the request Format.md does not cover follows `LIFEOS/DOCUMENTATION/Workflows/WorkflowsSystem.md`.
- The definition has a free kebab-case name that says what it does and was scaffolded by `workflow new` in the definitions home, never created by hand elsewhere; when a similar workflow already existed, the principal was told and asked whether to extend it or add a new one.
- `workflow validate` passes with exit 0, `workflow list` shows it as valid, and the principal can read its graph in four lines: the steps in order, where a human decides, what the result is.
- Every money, deploy or third-party outbound step sits behind a `human` approval and carries `when: { ref: steps.<human>.output.approved, equals: true }` so a decline skips it (the rule: SKILL.md § Quick Reference).
- The report says what the definition does, where the file is, the validator verdict, the graph summary, and what does not run locally (`runs_on: cloud`).
- A definition with a `schedule`, `interval` or `once` trigger is picked up by the dispatcher (SKILL.md § Gotchas, the dispatcher rule), and the report says it will fire only after the dispatcher was shown loaded and `workflow next <name> --json` showed the next fire; until then it says the dispatcher is not confirmed.

## Anti-criteria

- The principal never learns from a later failure that a green validate did not mean it runs.
- Never deletes a `human` gate, drops a `side_effects` entry, or loosens an output schema to get past the validator; the design changes instead.

## Safety gates

- Every `command` step declares `side_effects` honestly, and the human-gate rule above holds; what `validate` refuses and why a missing `when` ends the run failed is SKILL.md § Quick Reference.

## Tool contract

1. **Check the name is free.** `bun LIFEOS/WORKFLOWS/workflow.ts list --json`. Pick a kebab-case name that says what it does.
2. **Scaffold.** `bun LIFEOS/WORKFLOWS/workflow.ts new <name>` writes a valid template into the definitions home and refuses to overwrite. Edit that file.
3. **Author the steps.**
   - Deterministic work is a `command` step (argv list, JSON on stdin and stdout) or an `action` step that uses an existing action. Look in `LIFEOS/TOOLS/` and the skill `Tools/` directories for an existing CLI before writing new code.
   - Judgment or writing is a `model`, `agent` or `judgment` step with an `output` schema.
   - Wire steps with `needs` and `{ $ref: ... }`. Finish with a `result` mapping.
4. **Validate and fix until clean.** `bun LIFEOS/WORKFLOWS/workflow.ts validate <name>`. Exit 1 prints every problem; fix all of them and rerun.
5. **Show the graph.** `bun LIFEOS/WORKFLOWS/workflow.ts graph <name>`.
6. **Confirm it is visible.** `bun LIFEOS/WORKFLOWS/workflow.ts list --json` lists it as valid. The Pulse `/workflows` page and `GET /api/workflows` read the same definitions home.
7. **Check the dispatcher** for a `schedule`, `interval` or `once` trigger: `Schedule.md` § Tool contract, step 5.

When `validate` or `new` refuses:

- The validator names the step and field. Read the message, fix that field, rerun. Two failed rounds on the same error means the design is wrong: re-read the format section for that kind.
- `new` refuses an existing name. Choose another name or edit the existing file on purpose.

## Output format

The name, the file path, the validator verdict, the graph summary, and anything that cannot run yet. Skip the YAML unless asked.
