# Workflows v2 authoring format

**Contents:** File · Top-level fields · Step kinds · References · Side effects and the human gate · Triggers · Minimal valid definition · Human-gated deploy · Scheduled definition

Working reference for writing a `<name>.workflow.yaml` definition. The authoritative spec is `LIFEOS/DOCUMENTATION/Workflows/WorkflowsSystem.md`; when this file and the CLI disagree, `bun LIFEOS/WORKFLOWS/workflow.ts validate` is right.

## File

- One definition per file, `<name>.workflow.yaml`, in the definitions home (`LIFEOS/USER/WORKFLOWS/`, override with `LIFEOS_WORKFLOWS_DIR`).
- The file stem must equal `name:`. Names are kebab-case: lowercase letters, digits, hyphens.
- No shell interpolation and no templating anywhere. Values move between steps only through `$ref`.

## Top-level fields

| Field | Rule |
|-------|------|
| `version` | `2`. Required. |
| `name` | Kebab-case, equals the file stem. Required. |
| `runs_on` | `local` or `cloud`. A local run executes every step kind; `cloud` runs only on its Worker after `workflow deploy`, and a local `run` refuses it. |
| `description` | One sentence on what the workflow produces. |
| `triggers` | List. Defaults to a single `manual` trigger when omitted. |
| `input` | JSON Schema for the run input. |
| `steps` | Map of step id to step. Required, at least one. |
| `result` | Mapping built from `$ref`s: what the run returns. |
| `output` | JSON Schema for `result`. Needed when another workflow links to this one with an `after` trigger. |

## Step kinds

Every step has `kind`. Steps run in dependency order, set by `needs: [stepId, ...]`.

| kind | Required fields | Notes |
|------|-----------------|-------|
| `command` | `argv` (list of strings), `side_effects` | No shell. Receives the `with` object as JSON on stdin and must print exactly one JSON value on stdout every run (empty or plain-text stdout fails the step). `output` is the JSON Schema for that value: optional to validate, but declare it so the printed value is checked, and it is needed when a later step or the workflow `result` reads a field. `side_effects` is required: `[none]` when it touches nothing. |
| `action` | `uses` (registered action id) | Typed action with its own contract. Only ids that exist in the actions directories validate (system: `LIFEOS/WORKFLOWS/v1/Actions/`, personal: `USER/CUSTOMIZATIONS/WORKFLOWS/ACTIONS/`); never invent one such as `send-message` or `sms.send`. With no matching action, write a `command` step (sending, notifying, fetching) with its `side_effects`. |
| `model` | `lane`, `prompt`, `output` | `lane` is one of `openaiLow`, `openaiMedium`, `sol`, `astra`. |
| `agent` | `lane`, `prompt`, `output` | Same lanes as `model`. Tool-using. |
| `judgment` | `question`, `output` | A typed judgment-layer question. |
| `human` | `prompt` | Default output is `{approved, note}`. The run parks on disk and texts a 👍/👎 approval; it resumes when answered. |
| `workflow` | `workflow` (name) | Runs another definition as a step. |

Optional on any step: `with` (input mapping), `when: {ref, equals}`, `side_effects` (required on `command`), `recipient`, `timeout_ms`, `retries`, `retry_delay_ms`, `on_error`.

`output` on a step is a JSON Schema object: `{ type: object, required: [x], properties: { x: { type: string } } }`.

## References

- `{ $ref: input.field }` reads the run input.
- `{ $ref: steps.<id>.output.<field> }` reads an upstream step, which must be in the referencing step's `needs`.
- `with:` maps each key to a literal or a `$ref`. There is no string interpolation.
- A first step with no `needs` and no `with` receives the whole run input as its stdin JSON. Use `with` when a step needs only part of the input or an upstream value.

## Side effects and the human gate

`side_effects` is a list drawn from `none`, `read`, `write`, `outbound`, `money`, `deploy`.

- Every `command` step declares `side_effects`. A command line the validator recognises as a deploy, send or payment (any `deploy` subcommand or deploy script, a git push, `gmail.ts send`, Relay `send.ts`, `YouTubeUpload` upload or publish, `dd-cli order`, `SubmitOrder.ts`) must list the matching effect.
- A step with `money`, `deploy` or `outbound` needs a human approval among its ancestors, reached through `needs`: a `human` step whose answer requires a boolean `approved`, as the default output does.
- `outbound` with `recipient: principal` (a message to the principal only) is exempt.
- At run time the gated step runs only when every such approval answered `approved: true`. A decline without a `when` stops the run with the step refused; with `when: { ref: steps.<human>.output.approved, equals: true }` the step is skipped and the run ends cleanly. Write the `when`.

## Triggers

| type | Fields |
|------|--------|
| `manual` | none |
| `schedule` | `cron` (five fields), `timezone` (IANA name), `missed_run` |
| `once` | `at` (ISO 8601 with offset, for example `2026-10-01T09:00:00-07:00`), `missed_run` |
| `interval` | `minutes` (1 to 525600), `missed_run` |
| `event` | `name` |
| `after` | `workflow` (upstream name), `status` (`succeeded` default, `failed` or `completed`) |

`missed_run` is `skip` (default) or `once`.

An `after` trigger requires the upstream workflow to exist. On `succeeded`, the upstream `output` schema is checked against this workflow's `input` schema: connections come back as `checked`, `runtime` or `mismatch`, and `mismatch` fails validation. `failed` and `completed` links are `runtime`.

## Minimal valid definition

```yaml
version: 2
name: example-check
runs_on: local
description: Report whether the check passed.
triggers:
  - type: manual
steps:
  check:
    kind: command
    side_effects: [none]
    argv: [bun, -e, "process.stdout.write(JSON.stringify({ ok: true }))"]
    output: { type: object, required: [ok], properties: { ok: { type: boolean } } }
result: { $ref: steps.check.output }
```

## Human-gated deploy

```yaml
version: 2
name: example-deploy
runs_on: local
triggers:
  - type: manual
steps:
  build:
    kind: command
    side_effects: [none]
    argv: [bun, -e, "process.stdout.write(JSON.stringify({ built: true }))"]
    output: { type: object, required: [built], properties: { built: { type: boolean } } }
  approve:
    kind: human
    needs: [build]
    prompt: Approve the deploy.
  deploy:
    kind: command
    needs: [approve]
    when: { ref: steps.approve.output.approved, equals: true }
    side_effects: [deploy]
    argv: [bun, -e, "process.stdout.write(JSON.stringify({ deployed: true }))"]
    output: { type: object, required: [deployed], properties: { deployed: { type: boolean } } }
result: { $ref: steps.deploy.output }
```

## Scheduled definition

```yaml
version: 2
name: example-nightly
runs_on: local
triggers:
  - type: schedule
    cron: "0 2 * * *"
    timezone: Europe/London
    missed_run: skip
steps:
  tick:
    kind: command
    side_effects: [none]
    argv: [bun, -e, "process.stdout.write(JSON.stringify({ ok: true }))"]
    output: { type: object, required: [ok], properties: { ok: { type: boolean } } }
result: { $ref: steps.tick.output }
```
