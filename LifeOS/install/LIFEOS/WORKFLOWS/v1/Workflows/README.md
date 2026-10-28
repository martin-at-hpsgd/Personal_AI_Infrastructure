# Arbol workflow format

A workflow declares when work starts, its steps, the data they receive, and failure policy. Actions keep their own `action.json` input/output contracts and implementations. The workflow references stable action names; local packages and cloud bindings supply the execution.

## Example

```yaml
version: 1
name: process-content
description: Extract content, rate it, and notify when it passes the filter.
trigger:
  type: event
  name: content.received
defaults:
  timeout_ms: 120000
  retries: 0
  on_error: stop
concurrency: 2
steps:
  extract:
    uses: A_EXTRACT_TRANSCRIPT
    with: { $ref: input }
  rate:
    uses: A_LABEL_AND_RATE
    needs: [extract]
    with: { $ref: steps.extract.output }
  filter:
    uses: A_QUALITY_FILTER
    needs: [rate]
    with: { $ref: steps.rate.output }
  notify:
    uses: A_NOTIFY
    needs: [filter]
    when:
      ref: steps.filter.output.passed
      equals: true
    with: { $ref: steps.filter.output }
```

This example requires its named actions registered by the host. The runnable `Examples/format-summary.yaml` uses the existing local formatting action and needs no network or model call.

## Fields

| Field | Meaning |
|---|---|
| `version` | Required format version, currently `1`. |
| `name`, `description` | Required stable workflow name and optional explanation. |
| `trigger` | `manual` (default), `event` with `name`, or `schedule` with `cron` and `timezone`. |
| `input` | Optional JSON Schema draft-07 for the workflow's input. |
| `defaults` | Default step `timeout_ms`, `retries`, `retry_delay_ms`, and `on_error`. |
| `concurrency` | Maximum simultaneous steps within one run, 1–64; default 1. |
| `steps` | Map of stable step IDs to their definitions. |
| `output` | Optional output mapping. Otherwise returns successful terminal-step outputs keyed by step ID. |

Each step requires `uses`. `needs: [step-id, ...]` lists prerequisites. Steps without dependencies may run in parallel. A join lists every prerequisite in `needs`; document order does not replace dependencies.

`with` maps the action's input. It defaults to the workflow input, never the preceding step's output. Values may be JSON literals, arrays, nested objects, or an exact reference object such as `{ $ref: input.content }` or `{ $ref: steps.extract.output.content }`. Whole-object references preserve the legacy pipe behavior. References retain their types; there is no string interpolation, JavaScript evaluation, or shell syntax. References to another step require that step to be an ancestor through `needs`. Missing paths fail explicitly.

`when: {ref: input.enabled, equals: true}` compares a referenced value with a JSON literal. A false condition skips the step. Dependents of failed or skipped steps also skip. An explicit final output referencing a skipped step fails and retains step states; omit `output` for a workflow whose terminal work is intentionally optional.

## Failure policy

Retries default to zero, with a maximum of 10. Set them only for actions that can safely repeat. `retry_delay_ms` is a fixed delay (default zero). Every attempt receives a fresh input copy. Input/output validation failures are not retried.

`on_error: stop` is the default: pending work skips, already-running work finishes. `continue` permits independent branches to finish, but the overall result still reports failure. No failed branch silently turns the run green.

`timeout_ms` is optional; absent means the host's limit applies. Timers may not exceed 24 hours. Timeout requests cooperative cancellation, marks completion unknown, prevents retries, and stops new scheduling even with `on_error: continue`. Code ignoring cancellation can still perform side effects; this runner cannot forcibly terminate arbitrary host code. The result includes `timed_out: true`.

## Commands

From the Arbol framework directory, run `bun install --frozen-lockfile` once, then:

```bash
bun Workflows/cli.ts validate Workflows/Examples/format-summary.yaml
bun Workflows/cli.ts graph Workflows/Examples/format-summary.yaml
bun Workflows/cli.ts run Workflows/Examples/format-summary.yaml --input '{"summary":"A synthetic example."}'
bun Workflows/cli.ts next Workflows/Examples/scheduled-summary.yaml
bun Workflows/cli.ts tick Workflows/Examples/scheduled-summary.yaml --input '{"summary":"Scheduled example."}'
bun Workflows/cli.ts event workflow.yaml --name content.received --input '{}'
```

The same commands are available as `lifeos.ts workflow ...` and the private Arbol CLI's `arbol workflow ...`. `validate` checks available local action manifests without importing implementations. `graph` inspects structure without needing local action packages, useful for cloud definitions. Execution returns JSON and exits nonzero on failure. A nonmatching trigger returns `matched: false` without work.

An existing host scheduler can invoke `tick` each minute; the declared cron selects matching minutes in the declared timezone. Five-field cron, timezone validation, and daylight-saving transitions use cron-parser. `--at ISO` makes matching reproducible. Nothing installs or activates a schedule automatically. Repeated ticks in the same minute can repeat work: the host owns delivery deduplication and overlapping-run control. `concurrency` controls steps within one run, not concurrent workflow runs.

## Validation

Unknown workflow fields, duplicate YAML keys, aliases, invalid policies, unknown steps, cycles, and non-ancestor references fail before action calls. With a registry, validation also checks all referenced action schemas, literal inputs, and provably incompatible mapped types/closed properties. Full schema validation checks actual inputs and outputs at runtime; complex combinator compatibility and open-schema properties cannot all be established statically.

Schemas use draft-07 with local `#/definitions/...` references; external references and `$id` are unsupported. Unknown schema keywords fail instead of being ignored. New action manifests use standard JSON Schema. Historical `{field: {type, required: true}}` shorthand is normalized at the action boundary, including fields named `format`.

## Local and cloud hosts

`localActionRegistry()` reads portable action packages. `cloudActionRegistry()` maps the same `uses` identifiers to supplied service bindings and optional input/output schemas. Cloud actions return `{success: true, output: ...}`. Credentials remain in the host and are sent as headers.

`createWorkflowWorker()` exposes authenticated `POST /run` and a scheduled handler. Its caller must supply an authorization function. HTTP payload is `{input: ...}` for manual work or `{event: "name", input: ...}` for event work. Scheduled work receives `{scheduled_at: ISO}`; source actions should fetch their data from that event. A cloud host can tick every minute and match the workflow timezone without duplicating its business schedule in provider configuration.

The cloud host bundles the parsed workflow object and the adapter together; no server-side dependency on a local machine is required. This implementation provides the tested adapter, not an automatic conversion or deployment of existing production Workers. Existing cloud Workers keep their current behavior until explicitly migrated and deployed through the project's deployment checks.

This is an in-process runner. It does not promise durable queues, interrupted-run recovery, exactly-once effects, or human approval inboxes. Hosts needing those guarantees must supply them outside the workflow engine.

## Compatibility and checks

Legacy `{name, description, actions: [...]}` pipelines still run, preserving full-output piping and final-step output. `P_EXAMPLE_SUMMARIZE_AND_FORMAT.yaml` demonstrates the new form; `P_EXAMPLE_FORMAT.yaml` exercises the legacy form. User pipeline overrides remain first, with fallback only when a file is absent; a broken override is never silently replaced by a framework file.

```bash
bun test Workflows   # source tree only; tests are not in the public release
bun run typecheck
bun Workflows/verify-cloud.ts /path/to/workerd
```

The final command bundles and runs a synthetic service-binding and timezone probe inside Cloudflare's runtime with internet access disabled. No deployed action is called.
