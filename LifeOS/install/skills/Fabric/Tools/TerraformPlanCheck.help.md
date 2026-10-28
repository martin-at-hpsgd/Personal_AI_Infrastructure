# TerraformPlanCheck

Checks a TerraformPlan review (`Intents/TerraformPlan.md`) against the parts of its contract that code can judge. Whether each finding is right, ranked well and specific to the plan stays a judged check in the `fabric-terraformplan` suite.

## Usage

```bash
bun skills/Fabric/Tools/TerraformPlanCheck.ts <review|-> [--plan <plan.txt|plan.json>] [--json]
```

| Flag | Meaning |
|------|---------|
| `<review\|->` | The saved review, or `-` for stdin |
| `--plan F` | The plan the review is of: `terraform plan` text (ANSI colour and leading CI-log timestamps are stripped) or `terraform show -json` output, parsed with `JSON.parse` |
| `--json` | Print `{ok, kind, counts, problems}` |
| `--help` | Print usage |

## Checks on the review alone

- The single line `**Not a Terraform plan:** {what it is}` passes on its own.
- Otherwise the review opens on `## Terraform plan review: {…}` and holds one `**Summary:**`, one `**Plan:**` and one `**Verdict:**` line, then `### Main points` and `### Takeaways` in that order, and nothing else: any other line (a note, a warning, a paragraph) fails.
- The Summary is one sentence of at most 25 words.
- The Plan line is `{a} to add, {c} to change, {d} to destroy`, optionally with `{i} to import, ` first and ` (N replacement[s])` last, or `Not available ({reason})`.
- The Verdict opens on `Safe to apply`, `Apply with care` or `Do not apply as is`, then a period and a sentence of why. A review with any destroy (in its counts or as a **Destroy**/**Replace** point) cannot be `Safe to apply`.
- Main points: at most 10, numbered from 1, each one line of at most 30 words, opening on a bold kind (**Destroy**, **Replace**, **Security**, **Cost**, **Compliance**, **Drift**, **Change**) and naming a resource address or module path in backticks.
- Takeaways: at most 5, numbered from 1, each at most 30 words.
- No item is repeated across the two lists.
- Only a plan with zero changes may leave out Main points and Takeaways.

## Checks against the plan (`--plan`)

- The Plan line's import, add, change and destroy counts equal the plan's own `Plan:` line (text) or the counts of each resource change's actions (JSON, a replacement counting once under add and once under destroy), and its replacement count equals the plan's.
- A text plan with neither a `Plan:` line nor `No changes.` is treated as cut off, and the Plan line must read `Not available (…)`; the intent puts the visible counts in the reason (`Not available (plan output is truncated; visible so far: 1 to add, 2 to change, 1 to destroy)`).
- Every resource the plan destroys or replaces is named in a main point, by its address, its address without an index, or a module path that contains it.
- Every backticked resource address anywhere in the review exists in the plan.
- No clear-text value of a password, secret, token or key attribute in the plan appears in the review.

## Exit codes

- `0` the shape holds (and, with `--plan`, agrees with the plan)
- `1` a rule failed; each failure prints as one `✗` line
- `2` bad usage, an unknown flag, or an unreadable review or plan (including a JSON plan with no `resource_changes`)
