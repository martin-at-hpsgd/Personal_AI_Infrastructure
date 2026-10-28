---
version: 2.4.0
---

# Workflows — deterministic work, defined once, run locally or in the cloud

> Workflows is the one LifeOS system for work that follows known steps. A workflow is a typed graph of steps: each step is done by code, a model, a judgment-layer question, an agent, or a human, and data moves between steps only through declared, schema-checked mappings. The same definition format covers work that runs on this machine and work that runs on Cloudflare. Workflows also keeps the inventory of every piece of work LifeOS already runs, wherever it runs, and draws it on Pulse `/workflows`.
>
> State of record: `LIFEOS/WORKFLOWS/ISA.md` (maintainer-side; not in the release). This doc replaces the earlier separate cloud-execution doc: that layer is now the Workflows engine and its cloud runtime.

## Contents

1. What a workflow is
2. The parts at a glance
3. Actions and their contracts
4. Definition format v2
5. A worked example
6. Connection classes
7. Step kinds and what runs today
8. The side-effect rule
9. Triggers
10. Where a workflow runs: local and cloud
11. Format v1 and legacy pipelines
12. The CLI
13. The run ledger
14. The inventory and the Pulse pages
15. Deploying cloud Workers
16. Moving the existing cloud fleet in
17. Names that keep the old name
18. How it fits with the rest of LifeOS
19. What is built and what is next

---

## What a workflow is

Any recurring piece of work is a series of steps, and each step is done by someone or something. Seen that way, a company, or a life, is a graph of algorithms. Writing the graph down is what makes it possible to run it on time, check it, and improve it.

A workflow is one such graph, written as a YAML file. It says what starts it, what input it takes, what each step does and who does it, what each step hands the next one, and what the whole thing returns. Before anything runs, the definition is validated: the graph must be acyclic, every reference must point at a real upstream step, and every connection between steps must be type-compatible or explicitly marked as checked at runtime.

Some steps are fully deterministic, like a shell command or a small function. Others are not, like a model call or an agent session. Workflows keeps the graph deterministic even when a step is not: which steps run, in what order, and with what typed data is fixed by the definition, and every nondeterministic step must declare a JSON Schema for its output. A model can decide what a summary says, but it cannot decide what shape the next step receives.

Each step names its executor, and there are five:

| Executor | Step kinds | Meaning |
|---|---|---|
| code | `action`, `command` | A program with a typed input and output |
| model | `model`, `agent` | A model call or an agent session on a named lane, held to an output schema |
| judgment | `judgment` | A typed question to Assay's judgment layer, answered with a probability and a verdict |
| human | `human` | A decision by a person, returned as `{approved, note}` by default |
| (its own steps) | `workflow` | Another workflow, run as one step |

Over time steps should move toward code: a human step becomes a judgment, a model step becomes a rule. The executor mix shown on the Pulse page is how that drift is measured.

## Rigid moves, free work

A workflow is an SOP made executable, and an SOP has two parts that want opposite things (principal directive, 2026-10-16). Workflows gives each part what it needs.

- **The moves are rigid.** The stages work passes through, the moves allowed between them (rework back to an earlier stage included), what must be proven before work moves on, who must approve, and what may never happen. That is a state machine: the engine enforces it, and a move the definition does not allow is refused, never left to a model's judgment.
- **The work is free.** Inside each stage, the work is stated as an ideal state with exit criteria, the way an ISA states done, never as a list of steps. The agent, model, person or code doing the stage reaches it its own way, so a smarter executor makes the stage better without anyone rewriting it.

Every line of an SOP sorts three ways:

- **A move guard** stays rigid and is checked where the system can observe it: an artifact, a check result, an approval ("no invoice before the SOW is signed").
- **A stage invariant** stays rigid for the whole stage and is held by a capability or guard, not by a check at the exit ("tenant content never goes to an outside model").
- **A method** becomes an exit criterion ("first draft three subject lines, then pick one" becomes "the subject line names the sponsor's product"). The Bitter Lesson's question finds these: a smarter executor would make the line unnecessary.

A line whose purpose is authority, accountability, an external commitment or irreversibility stays rigid however capable the executor; an auditor-mandated control is a move guard that cites its authority. Of BLE's four keep-classes, safety gates are move guards, output contracts are exit criteria, and tool contracts and verified gotchas are facts handed to the work, so the machine never absorbs what should stay free.

The engine's moves are to be written to STATVS (F26 ISC-292), so a run's history rebuilds from the record and a changed SOP is replayed against recorded runs to show what it would have caught or blocked before it ships (`../Statvs/StatvsSystem.md` § A record, not a state machine). No workflow move reaches STATVS yet.

**What exists today and what does not.** The side-effect rule below, typed outputs and human steps are machine parts already. The format is still an acyclic graph whose steps finish when their output matches a schema, so it cannot yet express a rework loop or a stage's exit criteria. Both are the build in the Workflows ISA's F26.

## The parts at a glance

| Part | What it is | Where it lives |
|---|---|---|
| Action | One unit of work with a JSON Schema input and output contract | System examples: `LIFEOS/WORKFLOWS/v1/Actions/`. Personal actions: `LIFEOS/USER/CUSTOMIZATIONS/WORKFLOWS/ACTIONS/` |
| Definition | A `<name>.workflow.yaml` file in format v2 (or v1) | `LIFEOS/USER/WORKFLOWS/` |
| Engine | Parser, validator, graph runner, schema checker | `LIFEOS/WORKFLOWS/engine/` on top of the v1 engine in `LIFEOS/WORKFLOWS/v1/Workflows/` |
| CLI | `workflow` with 23 commands (§ The CLI) | `bun LIFEOS/WORKFLOWS/workflow.ts` |
| Run ledger | One JSONL line per run, keyed so an occurrence runs once | `LIFEOS/MEMORY/STATE/workflows/runs.jsonl` |
| Inventory | Every piece of work LifeOS runs, reconciled declared vs installed vs ran | `bun LIFEOS/WORKFLOWS/Workflows.ts`, Pulse `/workflows` |
| Cloud fleet | Action, pipeline and flow Workers on Cloudflare | `LIFEOS/USER/CUSTOMIZATIONS/WORKFLOWS/` (private user tree; not in the release) |

## Actions and their contracts

An action does one thing: call a model, fetch an API, parse a document, format output, write a record. It takes JSON in and returns JSON out, and it knows nothing about the workflows that use it. That independence is what lets the same action serve many workflows and run either locally or as a Cloudflare Worker.

### The package

Each action is a flat directory:

```
A_EXAMPLE_SUMMARIZE/
├── action.json    # manifest: name, description, input and output schema, requires
└── action.ts      # implementation: execute(input, ctx) → output
```

`action.json` carries the contract. Input and output are JSON Schema draft-07 documents:

```json
{
  "name": "A_EXAMPLE_SUMMARIZE",
  "version": "1.0.0",
  "description": "Summarize text content into a concise summary using LLM inference.",
  "input": {
    "type": "object",
    "required": ["content"],
    "properties": {
      "content": { "type": "string" },
      "title": { "type": "string" }
    }
  },
  "output": {
    "type": "object",
    "required": ["summary", "word_count"],
    "properties": {
      "summary": { "type": "string" },
      "word_count": { "type": "integer" }
    }
  },
  "requires": ["llm"]
}
```

Older manifests use a shorthand, `{ "content": { "type": "string", "required": true } }`. The engine normalizes it into a standard schema at the action boundary, so both forms work; new manifests use standard JSON Schema. Schemas may use local `#/definitions/...` references; external references and `$id` are not supported, and an unknown schema keyword fails instead of being ignored.

`action.ts` exports one function:

```typescript
import type { ActionContext } from "../lib/types.v2";

export default {
  async execute(input: Input, ctx: ActionContext): Promise<Output> {
    const { content, ...upstream } = input;
    // ... do the work with ctx.capabilities ...
    return { ...upstream, summary, word_count };
  },
};
```

### Capabilities (`requires`)

An action never imports its own network, model or filesystem access. It declares what it needs under `requires`, and the host injects an implementation into `ctx.capabilities`:

| Capability | Provides | Local host | Cloud host |
|---|---|---|---|
| `llm` | A model call returning text and optional parsed JSON | LifeOS's `Inference` tool, at the level the action asks for | The fleet's shared provider clients |
| `fetch` | HTTP requests | `fetch` | Worker `fetch` and service bindings |
| `shell` | A shell command | A subprocess | Sandbox Workers only |
| `readFile` / `writeFile` | File access | The local filesystem | Not available in a V8 Worker |
| `kv` | Key-value storage | Declared, not yet provided locally | KV bindings |

Declaring everything keeps an action portable. The same `action.json` tells the local runner what to inject and tells a Worker factory which bindings and secrets the Worker needs.

### The passthrough pattern

Many fleet actions keep the fields they did not use: `const { content, ...upstream } = input; return { ...upstream, ...ownFields }`. Under the old pipe model, where each action's whole output became the next action's input, this is how context such as a title or URL survived several hops. In format v2 data moves by explicit mapping, so a step can take exactly the fields it needs from any upstream step, and passthrough is no longer required. Existing actions keep it so un-migrated callers keep working.

### Naming and categories

Actions are named `A_` plus two to four words in upper snake case, verb first: `A_EXTRACT_TEXT`, `A_RATE_ARTICLE`, `A_SEND_DIGEST`. Deployed as a Worker, `A_RATE_ARTICLE` becomes `wf-a-rate-article` (see § Names that keep the old name).

| Category | Runtime | Typical `requires` | Use |
|---|---|---|---|
| V8 isolate | Standard Worker, near-zero cold start | `llm`, `fetch` | Model calls, API calls, parsing, formatting, routing |
| Sandbox | Container-backed Worker | `shell` | CLI tools, filesystem work, heavier extraction |

Default to a V8 isolate; use a Sandbox only when the action needs binaries or a filesystem.

### Rules for a good action

1. One job. If the name needs "and" for two unrelated things, split it.
2. Declare every capability and secret. Never assume one exists.
3. Validate input at once and fail with a clear message.
4. Be idempotent where possible. A step with `retries` must be safe to repeat.
5. Keep the contract additive once other workflows use it: no new required fields, and leave `additionalProperties` open. A contract that tightens breaks callers that have not changed.

### Running and creating actions locally

```bash
cd ~/.claude/LIFEOS/WORKFLOWS/v1/Actions
bun lib/runner.v2.ts list
bun lib/runner.v2.ts run A_EXAMPLE_FORMAT --input '{"summary":"A synthetic example."}'
```

To create one, make `LIFEOS/USER/CUSTOMIZATIONS/WORKFLOWS/ACTIONS/A_YOUR_ACTION/` with an `action.json` and an `action.ts`, then run it as above. A personal action with the same name as a system action overrides it. To use it in a workflow, add a step with `uses: A_YOUR_ACTION`. To run it on Cloudflare as well, add a Worker directory (see § Deploying cloud Workers).

## Definition format v2

A definition is one YAML file, `LIFEOS/USER/WORKFLOWS/<name>.workflow.yaml`. The file name and the `name:` field must match. YAML anchors and aliases, duplicate keys, and unknown keys at any level are rejected. The parser and validator are `LIFEOS/WORKFLOWS/engine/format.ts`.

### Top-level fields

| Field | Required | Meaning |
|---|---|---|
| `version` | yes | `2`. A `1` is handed to the v1 loader (see § Format v1 and legacy pipelines). |
| `name` | yes | Lowercase letters, digits and hyphens, at most 64 characters, starting with a letter or digit. Must equal the file stem. |
| `runs_on` | yes | `local` or `cloud`. |
| `description` | no | One or two sentences on what the workflow is for. |
| `sop` | no | The SOP document this workflow carries out. A workflow is the executable form of an SOP. |
| `domains` | no | The knowledge domains its steps read. No duplicates. |
| `destination` | no | Where the result goes, in words. Shown on the card. |
| `data_class` | no | `public`, `internal` (default), `confidential` or `restricted`. Recorded on every run. |
| `triggers` | no | A non-empty list of triggers (§ Triggers). Default: one `manual` trigger. |
| `defaults` | no | Default step policy: `timeout_ms`, `retries`, `retry_delay_ms`, `on_error`. |
| `concurrency` | no | How many steps of one run may execute at once, 1 to 64. Default 1. |
| `serves` | no | The ideal-state id (`IS-NNNN`) or list of ids this workflow moves; read by the ideal-state pursuit graph. |
| `deadline_ms` | no | A run still going after this many milliseconds ends `timed_out`; at most 24 hours. |
| `max_concurrent_runs` | no | Runs of this workflow allowed at once, 1 to 10. Default 1. |
| `queue_size` | no | Runs allowed to wait for a slot, 0 to 10000. Default 0. |
| `enabled` | no | `false` pauses the whole workflow. Absent means enabled. |
| `alert` | no | `critical`, `high` or `normal` (default): the severity of the Vigil event a failed run raises. |
| `budget_usd_month` | no | Monthly spend ceiling in US dollars. |
| `secrets` | no | Secret names (never values) the workflow needs. A local workflow is invalid while one is absent from the local env. |
| `evaluate` | no | `{criteria, lane, sample_rate, min_runs?}`: a sample of runs is scored against a criteria file. |
| `feeds` | no | Hand-offs to other workflows, as `{workflow, via}`. Description only; nothing runs on it. |
| `input` | no | JSON Schema for the run's input. |
| `output` | no | JSON Schema for the run's result. |
| `result` | no | The mapping that builds the result from step outputs. Without it, the result is the outputs of the terminal steps. |
| `steps` | yes | A map of step id to step. At least one. |

`output` is a schema and `result` is a mapping. Format v1 used `output` for the mapping; v2 renamed it so the word can mean the declared type, the same way it does on a step.

### Fields every step may carry

| Field | Meaning |
|---|---|
| `kind` | `action`, `command`, `model`, `agent`, `judgment`, `human` or `workflow`. Defaults to `action` when `uses` is present. |
| `description` | What the step does, in words. |
| `needs` | Step ids that must finish first. Steps with no path between them may run in parallel. A join lists every prerequisite. |
| `with` | The step's input, as a mapping. Default: the workflow's whole input, never the previous step's output. |
| `when` | `{ ref: <reference>, equals: <JSON literal> }`. When false, the step is skipped. |
| `side_effects` | Any of `none`, `read`, `write`, `outbound`, `money`, `deploy`. `none` cannot combine with others. See § The side-effect rule. |
| `recipient` | Only on an `outbound` step. `principal` marks a send to the principal's own pinned destination. |
| `timeout_ms` | Per-attempt timeout, up to 24 hours. |
| `retries` | 0 (default) to 10. Only for steps that are safe to repeat. Schema failures are never retried. |
| `retry_delay_ms` | Fixed delay between attempts. Default 0. |
| `on_error` | `stop` (default): pending steps skip, running ones finish. `continue`: independent branches finish, and the run still fails. |
| `retry_backoff`, `retry_delay_max_ms` | `fixed` (default) or `exponential`; `retry_delay_max_ms` caps an exponential wait and is valid only with `exponential`. |
| `idempotent` | `true` marks a step safe to repeat. A step with `retries` and an `outbound`, `money` or `deploy` effect must declare it. |
| `domains` | Knowledge domains this step reads. |
| `resources` | What the step needs: `d1:<name>`, `queue:<name>`, `do:<class>`, `r2:<bucket>` or a secret name. A cloud-only resource fails validation on a `runs_on: local` workflow. |
| `authority` | One host authority name, or a list, that stands in for a human ancestor. It counts only when the definition is parsed for a host that registers every name (the embedded runner). |

### Fields by kind

| Kind | Fields | Rules |
|---|---|---|
| `action` | `uses` | The contract comes from the action's `action.json`. |
| `command` | `argv`, `env`, `input`, `output` | `argv` is a non-empty list of strings, run without a shell. No string form exists. A command step must always declare `side_effects` (`[none]` for a pure one). `env` is a list of variable names copied from the parent environment, or a map of literal non-secret values. The process receives only `PATH`, `HOME` and what `env` declares, so a step cannot read a credential it did not name. |
| `model` | `lane`, `prompt` or `prompt_file`, `input`, `output` | `lane` must be one of `openaiLow`, `openaiMedium`, `sol` or `astra` (`LANES` in `engine/format.ts`), each only while `models.ts` carries it. `output` is required. `prompt_file` is a markdown file relative to the definitions home. |
| `agent` | `lane`, `prompt` or `prompt_file`, `tools`, `sandbox`, `input`, `output` | Same rules as `model`. `tools` is an allowlist; `sandbox` is `read-only` (default) or `workspace-write`. |
| `judgment` | `question`, `caller`, `fallback`, `input`, `output` | `output` is required. `caller` names the judgment-layer caller that owns the question; `fallback` is the answer a downstream `when:` reads while that caller is in shadow mode. |
| `human` | `prompt` or `prompt_file`, `input`, `output` | `output` defaults to `{approved: boolean, note?: string}`. |
| `workflow` | `workflow` | The name of another definition. Its `input` and `output` schemas are the step's contract. A workflow cannot run itself. |

### Mappings and references

A mapping is any JSON value. Wherever an object is exactly `{ $ref: <path> }`, the engine substitutes the referenced value with its type intact. There is no string interpolation, no expression language and no shell syntax.

| Reference | Resolves to |
|---|---|
| `input` | The whole workflow input |
| `input.content` | One field of it |
| `steps.extract.output` | The whole output of step `extract` |
| `steps.extract.output.content` | One field of it |
| `trigger.<field>` | One field of the run's trigger context: `type`, `occurrence_key` and `run_id` for every trigger; `scheduled_for` for `schedule`, `once` and `interval`; `upstream_run_id` for `after`. Validation fails when the workflow has a live trigger that does not provide the field. |

A reference to a step is valid only when that step is an ancestor through `needs`. A missing path fails the step instead of passing `undefined`. A step whose dependency failed or was skipped is skipped too, and a `result` that references a skipped step fails the run. Leave `result` out when the terminal work is intentionally optional.

### What validation checks

Every check runs before any step starts:

- Structure: required fields, known keys only, valid names, file name matches `name`.
- Graph: no cycles, no dangling `needs`, references only to ancestors, policy values in range. The v2 graph is compiled to v1 form and judged by the same engine that runs it.
- Kinds: model, agent and judgment steps declare an output schema; model and agent steps name an allowed lane.
- Triggers: valid cron and IANA timezone, ISO times with offsets, intervals in range, no `after:` pointing at itself.
- The side-effect rule, including the command-step lint.
- Literals and names: no secret-shaped literal (a provider key, private-key armor, a long hex or base64 token) in `with`, `argv` or `prompt`; `secrets` entries are upper-case names, never values; a field declared `format: artifact-ref` has type string.
- Lookups: a judgment step's `caller` is registered with Assay's judgment layer; `prompt_file` and `evaluate.criteria` are relative `.md` files that exist inside the definitions home; a workflow's `domains` equal the union of its steps' `domains` once any step declares one. An `sop` that resolves to no SOP file or id is a warning on the card, not a rejection.
- Types: every connection is classed `checked`, `runtime` or `mismatch`, and a mismatch fails validation. Literal inputs are checked against the target schema. `after:` links are checked against the upstream workflow's output.

Validation reads action manifests but never imports an implementation, spawns a process, or calls the network.

## A worked example

This is the proof workflow, `wf-proof-typed-handoff.workflow.yaml`. Two command steps pass typed data from one to the next.

```yaml
version: 2
name: wf-proof-typed-handoff
description: Two local command steps hand typed data from one to the next.
runs_on: local
destination: the run report and the run ledger
triggers:
  - type: manual
output:
  type: object
  required: [text]
  properties:
    text: { type: string }
  additionalProperties: false
steps:
  greet:
    kind: command
    side_effects: [none]
    description: Print the greeting as typed JSON.
    argv: [bun, -e, "process.stdout.write(JSON.stringify({ text: 'hello workflows' }))"]
    output:
      type: object
      required: [text]
      properties:
        text: { type: string }
      additionalProperties: false
  shout:
    kind: command
    side_effects: [none]
    description: Receive the greeting's typed text and return it upper-cased.
    needs: [greet]
    with:
      text: { $ref: steps.greet.output.text }
    argv: [bun, -e, "const input = await Bun.stdin.json(); process.stdout.write(JSON.stringify({ text: input.text.toUpperCase() }))"]
    input:
      type: object
      required: [text]
      properties:
        text: { type: string }
      additionalProperties: false
    output:
      type: object
      required: [text]
      properties:
        text: { type: string }
      additionalProperties: false
result: { $ref: steps.shout.output }
```

Reading it top to bottom:

1. `runs_on: local` and one `manual` trigger: it runs on this machine when someone asks.
2. The run's `output` schema promises an object with a string `text`.
3. `greet` is a command step. It declares `side_effects: [none]`, which every command step must do. Its `argv` runs without a shell. It prints one JSON value on stdout, which is checked against its `output` schema.
4. `shout` waits for `greet` (`needs`), takes `text` from `greet`'s output (`with`), and receives it as JSON on stdin. Its input and output are both typed.
5. `result` makes `shout`'s output the run's result, which is checked against the top-level `output` schema.

`workflow graph wf-proof-typed-handoff --json` reports three connections. `input → greet` is `runtime`, because the workflow declares no input schema. `steps.greet.output.text → shout.text` is `checked`: both sides are typed strings. `steps.shout.output → output` is `checked` too. Running it prints `{"text": "HELLO WORKFLOWS"}` and appends one line to the run ledger.

## Connection classes

Every place a value moves from one side to another, a workflow input into a step, a step output into another step, a step output into the result, or one workflow's result into another's input, gets one of three classes.

| Class | Meaning | Outcome |
|---|---|---|
| `checked` | Both sides are typed, no incompatibility can be proven, and every required target field is promised by the source | Safe by construction |
| `runtime` | A side is untyped, or the source does not promise a required field | Allowed. The value is validated against the schema when the step runs |
| `mismatch` | The types provably disagree | Validation fails, naming both sides |

The goal is to drive `runtime` connections toward `checked` by giving actions and steps real contracts. `graph --json` lists every connection with its class and reason.

## Step kinds and what runs today

| Kind | Parses and validates | Runs locally | Runs in a cloud runner (`wf-*`) | Runs embedded in a host app |
|---|---|---|---|---|
| `action` | yes | yes, through the local action registry | through service bindings | yes, as the host's own function |
| `command` | yes | yes | no; commands are a local capability | no |
| `model` | yes | yes | no | yes, through the host's model client |
| `agent` | yes | yes | no | no |
| `judgment` | yes | yes | no | yes, through the host's judgment client |
| `human` | yes | yes | no | yes, parked in the host's store |
| `workflow` | yes | yes | no | no |

**Embedded runner (F24).** A host app runs many definitions inside its own Worker with `createEmbeddedRunner` (`LIFEOS/WORKFLOWS/cloud/embedded.ts`). Actions are the host's own functions with JSON Schema contracts. The host supplies the store (occurrence claims, run records, parked runs updated by compare-and-swap), a required Vigil hook that is called before each record is kept, and an authority check for steps that carry `authority:` in place of a human ancestor. The host bundles the runner from engine source at build time with `embedded-build.ts`, and its provenance file lets the host refuse a stale engine.

A definition with a step the runner cannot execute (a `command` step in a cloud runner, for example) still validates and graphs; `run` refuses it before any step starts and names the step. How each kind runs locally: a `model` step runs at its lane's rung through `Inference.ts` on the subscriptions, never an API key, with the step's output schema carried in the instructions, and a reply that does not conform fails the step. An `agent` step ends through a `submit_result` tool whose input schema is the step's output schema, with one repair attempt; its tools are an allowlist and its sandbox defaults to read-only. A `judgment` step asks the judgment layer and exposes the verdict to a downstream `when:`; while its caller is in shadow mode the declared `fallback` stands in. A `human` step waits durably for a decision from Pulse or the principal's messaging line. A `workflow` step runs the named definition as a child run with its own ledger line, and a workflow cannot call back into its own chain. A run started by anything but a manual trigger asks for the flex tier, which only a pay-per-token client honours, and each model or agent step records its lane, the model that answered, its tokens and its cost in the ledger; a lane that reports no token counts leaves them out, never zero.

## The side-effect rule

Anything that reaches outside needs a human decision upstream. The validator enforces it, not a convention:

- A step declaring `money` or `deploy` fails validation unless a `human` step is among its ancestors.
- A step declaring `outbound` fails the same way, with one exemption: `recipient: principal`, a send to the principal's own pinned destination such as an alert or a pager. Scheduled monitoring can then notify its owner without a human in the loop, while a send to anyone else still needs one.

The rule lives in the format, so the CLI, the page and any future authoring surface all get it from the same validator.

A command step's `argv` is also checked against known send, deploy and payment shapes (`git push`, `gh release` or merge, a `deploy` script or subcommand, Cloudflare deploy and secret changes, package publish, `gmail.ts send`, Relay send, an HTTP write by `curl`, `dd-cli order`, and similar; `EFFECT_SIGNATURES` in `engine/format.ts`). A step that runs one must declare the matching effect, or validation fails with `undeclared-side-effect`. This is a lint, not an authorization: a program hidden behind a variable or a downloaded script is taken at its declared word.

## Triggers

| Type | Fields | Meaning |
|---|---|---|
| `manual` | `body` (optional) | Run on request. A cloud runner's `POST /run` takes `{"input": {...}}` JSON; with `body: url` it also takes a bare http(s) URL as the whole body and runs it as `{"url": ...}`, for plain webhook callers such as another app's Summarize button. |
| `schedule` | `cron`, `timezone`, `missed_run` | Five-field cron in an IANA timezone, or `timezone: principal` for wherever the principal is now (the location service, read at every wake; local runs only). A principal-zone schedule wakes at its cron minute every quarter hour and the dispatcher decides in the zone of the moment, so `0 8 * * *` is 08:00 local on a trip. Daylight-saving transitions are handled by the cron library. |
| `once` | `at`, `missed_run` | One ISO time with an offset, like `2026-10-01T09:00:00-07:00`. |
| `interval` | `minutes`, `missed_run` | Every N minutes, 1 to 525,600. |
| `event` | `name` | Run when a named event is dispatched. |
| `after` | `workflow`, `status` | Run when another workflow finishes with `succeeded` (default), `failed` or `completed`. |
| `queue` | `queue`, `batch_size` | Cloud only: a Cloudflare queue delivers batches of messages. On a `runs_on: local` workflow it fails validation. |

`missed_run` is `skip` (default) or `once`: after a machine sleeps through several occurrences, `once` asks for exactly one catch-up run. Every trigger also takes `enabled: false` to pause it without deleting it, and `schedule`, `once` and `interval` take `grace_minutes`: a missed occurrence older than that is skipped and recorded, never run. An `interval` job wakes on launchd's own phase (loaded at :39 means it wakes at :39), so a wake within one period of the previous recorded wake counts as on time and is not treated as a missed run; a longer gap is a real miss and `missed_run` decides.

An `after:` link on `succeeded` is typed. The upstream workflow's `output` schema must fit this workflow's `input` schema, or validation fails naming both. A `failed` or `completed` link carries no typed output and is classed `runtime`.

Triggers are parsed, validated, and reported by `workflow next`, which says when each time trigger would next fire. Every local time trigger is evaluated by one launchd job, `com.lifeos.workflows-dispatcher`, which runs `dispatcher.ts serve` under `KeepAlive`: each minute it fires every due `schedule`, `interval` and `once` occurrence with the catch-up, grace and once rules above, starts `after:` and `event` workflows with the upstream output as typed input, queues a trigger that arrives while its workflow is running, and keeps the runs it starts as its own children. No workflow has a launchd job of its own (ISA ISC-311). `bun LIFEOS/WORKFLOWS/engine/schedule-install.ts install <name>` checks that the workflow's schedule compiles on this host (every command resolves on the job's `PATH`; the calendar is read in the system zone behind `/etc/localtime`, never the installing shell's `TZ`), removes any leftover `com.lifeos.wf.<name>` job, and installs the dispatcher if it is missing or out of date. The dispatcher plist carries the install-root variables (`CLAUDE_CONFIG_DIR`, `LIFEOS_DIR`) of the process that installed it when they differ from the default root, so its runs find their own tree. `schedule-install.ts drift` lists any leftover per-workflow job, and `drift --fix` removes it. `dispatcher.ts fire <name>` evaluates one workflow's triggers by hand.

## Where a workflow runs: local and cloud

### Direction: Cloudflare is the control plane, the Mac is a worker (2026-10-24)

Workflows is execution infrastructure, so a reboot, a sleeping lid or a CPU spike on one Mac must never lose or silently skip work. The target design (ISA F27) splits responsibilities this way:

| Concern | Owner |
|---|---|
| Every schedule, interval and one-off time | Cloudflare (cron triggers); the Mac keeps no timers of its own |
| Each run's state, checkpoints, retries and timeouts | Cloudflare (a durable Workflows instance per run) |
| The record of every run, Mac steps included | Cloudflare (STATVS); the local ledger becomes a view |
| Steps that need nothing from the Mac | Cloudflare |
| Steps that need the Mac | The Mac's one long-lived worker, which leases them from a cloud queue |

A step says what it needs from the Mac from a closed list of five needs, each written with the prefix `mac.`: `files`, `app:<name>`, `lan` (the home network), `subscription:<lane>` and `browser`. A step that names none runs on Cloudflare, so placement follows from the steps and is never chosen by habit. When the Mac is away or busy, its steps wait in the queue up to their `max_wait` and then fail with a Vigil event. Every step carries an idempotency key, so a step delivered twice does its effect once. State that only lives in Mac files moves to Cloudflare first, because a file location is not a reason to need the Mac.

Until that lands, the description below is how the system runs today. The first move (ISA ISC-312) landed on 2026-10-24: every local time trigger is evaluated by the one dispatcher job, and the per-workflow `com.lifeos.wf.<name>` launchd jobs are gone. Those jobs caused the 2026-10-24 disk incident: 178 timers started a process about every 1.3 seconds, each start rewrote macOS's background-items store, and `dasd` answered each change by writing to a temporary database, about 5 GB a minute.

The second move, the cloud clock (ISA ISC-316, ISC-318, ISC-319), moves time off the Mac before any work moves:

- The `wf-clock` Worker holds every enabled local workflow's time triggers and a run queue in the Workflows D1 database. Each minute it computes what is due with `engine/clock.ts`, the same code the Mac used, so occurrence keys match.
- At most one run waits per workflow. A newer occurrence supersedes an older one that is still waiting, an occurrence past its `grace_minutes` expires, and every skip is a row with a reason.
- Each dispatcher pass sends the time triggers when they change, leases what is queued, and hands each run to the local queue through `submit`. A lease not closed in 5 minutes goes back to the queue, and one leased 5 times fails with a text.
- When the Mac stops checking in for 10 minutes, the Worker texts the principal through Twilio, since Relay runs on the Mac. It texts again when the Mac is back.
- When the cloud does not answer for 10 minutes, the dispatcher runs its own clock from the last answer and raises a high Vigil event. The ledger's occurrence keys stop the two clocks from running one recent occurrence twice.
- The Mac decides which `once` triggers already ran, because the cloud cannot know what the Mac fired before it was connected and the ledger's duplicate check reads only its recent tail. A `once` the Mac has marked consumed is refused when the cloud offers it, and one the Mac runs is marked consumed as soon as it is submitted (2026-10-24: an Oct 21 reminder ran a second time on the first cloud tick).

`bun LIFEOS/WORKFLOWS/clock/deploy.ts build|deploy|secrets|connect <url>` builds and ships the Worker, sets its secrets (the bearer token lives in the login Keychain under `lifeos-workflows-clock`), and points the dispatcher at it through `USER/CONFIG/workflows-clock.json`. Until that file exists, the dispatcher keeps its own clock. The Worker went live and this Mac connected on 2026-10-24, so this Mac's time triggers now come from the cloud and the local clock is the fallback.

### Today

A definition says `runs_on: local` or `runs_on: cloud`. The step graph and the contracts are the same either way; what differs is the host that supplies each step's implementation.

#### Local

`workflow run` loads the definition, reads each used action's contract, validates the definition and the input, claims an occurrence key in the ledger, and then runs the graph:

- **Action steps** run through the local action registry, with the action's own `action.json` contract checked on the way in and out.
- **Command steps** run with `Bun.spawn` and the exact argv. The step's input is written to stdin as JSON; the step must print one JSON value on stdout, which is parsed and checked against the step's output schema. Stdout above 16 MB kills the process and fails the step (write large payloads to a file and return its path). A command step with no timeout gets ten minutes. On failure, the tail of stderr is shown to the caller and never written to the ledger. A failed command step in an unattended run, which has no caller to read it, keeps that tail with the step's values in the artifact store; a confidential run stores nothing.

- **Model, agent, judgment, human and workflow steps** run as described under § Step kinds and what runs today.

A local run refuses a `runs_on: cloud` definition and any action whose package it cannot find, all before a step starts.

#### Cloud

The cloud side is a fleet of Cloudflare Workers, built from three shapes that compose upward:

| Shape | Prefix | What it does |
|---|---|---|
| Action Worker | `A_` | One action behind an authenticated HTTP endpoint |
| Pipeline Worker | `P_` | Calls action Workers in order, feeding each one's output to the next |
| Flow Worker | `F_` | Owns a source, a schedule and a destination: fetches items on a cron, deduplicates them, calls a pipeline or actions, writes results |

A flow is a workflow whose orchestration is hand-coded in a Worker. The migration below turns each flow's orchestration into a Workflows definition while the action Workers underneath keep doing the work.

How the fleet runs today:

- **Scheduling** is a Workflows cloud runner per scheduled workflow, named `wf-<workflow-id>` (for example `wf-poll-feeds`), which fires on its definition's schedule. The feed processor stays queue-triggered.
- **Composition** is service bindings: one Worker calls another directly inside Cloudflare's network, with no public hop.
- **Auth**: every action, pipeline and flow Worker checks a bearer `AUTH_TOKEN`. `GET /health` is public and returns no secrets or internal state. Flows typically also expose an authenticated `POST /trigger` for a manual run.
- **Shared modules** in the fleet's `Shared/` directory give every Worker the same auth check, action-Worker factory (request parsing, auth, errors, a stable `{success, action, output}` envelope), and model provider clients.
- **Queues** split a large job into a producer flow (cron: poll sources, dedupe, `sendBatch` at most 100 messages) and a consumer flow (queue handler: process one batch, `ack` or `retry` per message). Each side gets its own subrequest budget. Dedupe happens on both sides.
- **Loop gate** is a pattern for flows that need a result to pass a bar: the flow re-calls its pipeline until an exit condition on the output holds, always with a `maxIterations` cap. Pipelines never loop themselves.
- **Shared resources**: D1 databases, KV namespaces, R2 buckets and queues are bound into Workers by binding name. Several are shared with production applications outside the fleet, so they are treated as other systems' contracts.
- **Cost**: frequent crons multiply model calls. A five-minute flow with 30 items a run is about 8,640 model calls a day. Longer intervals, dedupe, quality filtering and cheaper lanes are the levers.

The typed engine has a cloud adapter already. `cloudActionRegistry()` maps each step's `uses` to a service binding with optional schemas, and `createWorkflowWorker()` wraps a parsed definition in a Worker with an authenticated `POST /run` (`{input}` for manual work, `{event, input}` for events) and a scheduled handler that, run every minute by the Worker's own cron, fires only on the minutes the definition's cron matches in its timezone. `bun Workflows/verify-cloud.ts <workerd>` in `LIFEOS/WORKFLOWS/v1/` bundles it and runs a synthetic service-binding and timezone probe inside Cloudflare's runtime with the network disabled. One production pipeline already runs a typed v1 definition inside its Worker, from a bundled copy of the engine in the fleet's `Shared/WorkflowRuntime/`.

For `runs_on: cloud` the pieces are built: a runner Worker per workflow from the current engine source (`cloud/build.ts`, deployed only through `workflow deploy`), secret-name checks at save time, resource declarations (`resources:` on a step) that make validation refuse `runs_on: local` for a workflow whose steps or actions need a cloud-only resource, and the ledger path: a Workflows cloud runner is built per scheduled workflow, and the `pull-cloud-runs` workflow pulls cloud run records into the local ledger every 15 minutes. A cloud runner runs `action` steps only.

### The security scanner plane

One flow in the fleet is the infrastructure security scanner: an hourly, server-side, outside-in scan of the whole deployed estate (auth boundaries, exposed secrets, header, DNS and TLS hygiene). It is the Security plane of the Bunker application harness, the same system rather than a separate one, and a new public deployment registers in both. Operational detail lives in the private user tree, not in this doc.

## Format v1 and legacy pipelines

Every v1 definition keeps working unchanged. A `version: 1` document is parsed by the v1 loader itself, so it gets exactly the v1 verdict, and is then lifted into the v2 shape: every step becomes an `action` step, the one `trigger` becomes a one-item `triggers` list, `runs_on` is `local`, `data_class` is `internal`, and v1's `output` mapping becomes `result`.

v1 fields are a subset of v2: `version`, `name`, `description`, `trigger` (`manual`, `event` with `name`, or `schedule` with `cron` and `timezone`), `input`, `defaults`, `concurrency`, `steps` (each with `uses`, `needs`, `with`, `when` and the policy keys), and `output`. The v1 README is `LIFEOS/WORKFLOWS/v1/Workflows/README.md`, with examples in `LIFEOS/WORKFLOWS/v1/Workflows/Examples/`.

Older still is the legacy pipeline, a plain ordered list of actions where each action's whole output becomes the next one's input:

```yaml
name: P_EXAMPLE_FORMAT
description: Format a summary.
actions:
  - A_EXAMPLE_FORMAT
```

Legacy pipelines still run through `bun lib/pipeline-runner.ts run <P_NAME>` in `LIFEOS/WORKFLOWS/v1/Actions/`. A personal pipeline in `LIFEOS/USER/CUSTOMIZATIONS/WORKFLOWS/PIPELINES/` overrides a system one of the same name, and a broken override is never silently replaced by the system file.

## The CLI

`bun LIFEOS/WORKFLOWS/workflow.ts` is the agent-first front door. Every command takes `--json`. Exit codes are `0` success, `1` invalid or failed, `2` usage. `help --json` prints the catalog below, which is the source of truth.

| Command | What it does | Runs steps |
|---|---|---|
| `help` | Print the command catalog, including the template list | no |
| `new <name> [--template KIND] [--after UPSTREAM]` | Write a valid v2 definition (the echo template, or a catalog template) to the definitions home; refuses to overwrite | no |
| `list` | List every definition with its validity, where it runs, its triggers and step count | no |
| `validate <name\|path>` | Structure, graph, step kinds, lanes, side-effect rule, triggers, connection types, after links; `--json` carries `issues` as `{path, code, message}` | no |
| `graph <name\|path>` | Steps with executors, and every connection with its class | no |
| `next <name\|path> [--at ISO]` | When each time trigger would next fire | no |
| `run <name\|path> [--input JSON] [--dry-run] [--occurrence KEY] [--trigger KIND]` | Run locally; one ledger line per run; a repeated occurrence key is refused; `--trigger` records what started it (the dispatcher passes it); refused while the fleet is paused | yes |
| `pause (<name> \| --all)` | Set `enabled: false` so the dispatcher stops starting it; `--all` is the global pause: nothing new starts until `resume --all` | no |
| `resume (<name> \| --all)` | Set `enabled: true` so the dispatcher starts it on schedule again; `--all` lifts the global pause | no |
| `link <upstream> <downstream> [--status S]` | Add an `after:` trigger to the downstream; refuses a type mismatch and names both schemas | no |
| `schedule <name> [--cron EXPR --tz TZ] [--every N] [--at ISO] [--in DURATION] [--remove TRIGGER]` | Add, replace or remove a time trigger; writes triggers only, and nothing when the result is invalid | no |
| `set <name> runs_on <local\|cloud>` | Move between local and cloud; refuses when a cloud-only resource or trigger forbids the target | no |
| `rename <old> <new>` | Rename the file and `name`, and repoint every `after:` trigger and `workflow` step that named it | no |
| `runs [<name>] [--active] [--status S] [--since T] [--limit N]` | Ledger runs filtered by `--status` and `--since`; with `--active`, in-flight runs and queued occurrences | no |
| `stop <run-id>` | Stop an in-flight local run: ledger status `stopped`, unfinished steps `skipped` | no |
| `test <name>` | Run against the sidecar `<name>.fixtures.yaml`; outbound, money, deploy, model, agent and human steps are stubbed; exit 0 only when every fixture matches | yes |
| `emit <event> [--input JSON]` | Record a named event file for the dispatcher to hand to every enabled workflow with a matching `event:` trigger | no |
| `deploy <name> [--confirm <name>] [--allow-dirty <reason>] [--waive-blockers <reason>]` | Deploy a cloud workflow's runner through the gated script `cloud/deploy.ts` and nothing else: read-only preflight first (action Workers, state namespace, secret names), refused on any failure before a build or an upload; then build, then the fleet's sanctioned deploy path. Needs `--confirm <name>` and env `WORKFLOWS_DEPLOY_APPROVED=<name>`. `--allow-dirty <reason>` (uncommitted files only) and `--waive-blockers <reason>` (model blockers or a reviewer outage) pass the matching code-review waiver to the Cloudflare deploy helper, which records it; an empty reason is refused before any build, and `--accept` is retired | no |
| `show <name>` | Print the definition's text and content hash; an editor passes the hash back as `--base-hash` so a stale copy is refused | no |
| `step <add\|set\|remove\|connect\|disconnect> <name> <id\|from> [<to>] [--kind K] [--fields JSON] [--needs a,b] [--base-hash H]` | Edit steps: add one (`--kind`, `--fields JSON`, `--needs a,b`), set or clear fields, remove one nothing depends on, or make one step run after another; validates first, refuses cycles and stale copies; the Canvas tab's editor calls the same functions | no |
| `put <name> --file PATH\|- [--base-hash H]` | Replace the whole text after validating it; the name cannot change; rechecks its schedule when triggers or `enabled` changed | no |
| `remove <name> [--base-hash H]` | Delete a definition only when no other definition names it in an `after:` trigger or a workflow step; removes any leftover per-workflow launchd job first; the page's Undo of New calls the same function | no |
| `contracts [<name>]` | List each action the v2 definitions use with its input and output contract specificity; exit 1 when any contract is no narrower than `{type: object}` | no |

`run --dry-run` validates the definition and the input and prints the plan. It starts nothing and writes nothing.

Every command that changes a definition (`new`, `pause`, `resume`, `link`, `schedule`, `set`, `rename`) goes through `engine/definitions.ts`, the one writer. It edits the parsed YAML so comments survive, validates the result, and writes only a valid one, through a temp file and a rename, after resolving symlinks against the definitions home. The Pulse page calls the same module. `check`: `bun LIFEOS/WORKFLOWS/engine/doc-cli-check.ts` fails when the table above and `help --json` differ.

Saving a `runs_on: cloud` definition (`set <name> runs_on cloud`, `new`, or any edit) checks the runner's secret names when Cloudflare credentials are present and refuses on a missing name; with no credentials the save goes through and records "unverified: no Cloudflare credentials" as a warning. Names only, never values. `rename` also appends `{from, to, at}` to `renames.jsonl` beside the ledger, so the inventory shows the old runs under the new name while the ledger itself stays append-only. On a first `deploy` the secrets cannot exist before the runner does, so they are reported as pending, not refused. On an install with Vigil (NOT in the public release payload), `bun LIFEOS/VIGIL/Vigil.ts heartbeat --json` lists every heartbeat, including `workflows-dispatcher` with its last beat and a stale flag (older than five minutes).

`new --template` takes one of `scheduled`, `event`, `after-chain` (needs `--after <upstream>`), `human-approval` or `model-typed`; each validates as written. `test` reads fixtures from `<name>.fixtures.yaml` beside the definition (a `fixtures:` list of `name`, `input`, `steps` stub values by step id, and an `expect` block with `status`, `output`, `steps`, `error_contains`) and runs against a throwaway ledger. `emit` writes `events/<time>-<id>.event.json` beside the ledger; the dispatcher consumes it.

| Environment variable | Overrides |
|---|---|
| `LIFEOS_WORKFLOWS_DIR` | The definitions home (default `LIFEOS/USER/WORKFLOWS`) |
| `LIFEOS_WORKFLOWS_LEDGER` | The run ledger file (default `LIFEOS/MEMORY/STATE/workflows/runs.jsonl`) |

```bash
bun LIFEOS/WORKFLOWS/workflow.ts new daily-digest
bun LIFEOS/WORKFLOWS/workflow.ts validate daily-digest
bun LIFEOS/WORKFLOWS/workflow.ts graph daily-digest --json
bun LIFEOS/WORKFLOWS/workflow.ts run daily-digest --input '{"text":"hello"}' --dry-run
bun LIFEOS/WORKFLOWS/workflow.ts run daily-digest --input '{"text":"hello"}' --json
```

Lower-level tools remain for the engine underneath. In `LIFEOS/WORKFLOWS/v1/`, `bun Workflows/cli.ts validate|graph|run|next|tick|event <file>` works on v1 files (`tick` matches a schedule against a given minute, `event` dispatches a named event). In `LIFEOS/WORKFLOWS/v1/Actions/`, `lib/runner.v2.ts` runs single actions and `lib/pipeline-runner.ts` runs legacy pipelines. The cloud fleet has its own CLI for calling deployed action Workers by registered name (see § Names that keep the old name).

## The run ledger

Every real run appends exactly one JSON line to `LIFEOS/MEMORY/STATE/workflows/runs.jsonl` when it ends. A line holds identity and status, never data:

| Field | Meaning |
|---|---|
| `schema` | Ledger schema version, `1` |
| `run_id` | A fresh UUID |
| `workflow`, `definition_path`, `definition_hash` | Which definition ran, and the sha256 of its bytes |
| `trigger` | The trigger type that started it |
| `occurrence_key` | The dedupe key for this occurrence |
| `data_class` | From the definition |
| `runs_on` | Where it ran |
| `started_at`, `finished_at` | ISO times |
| `status` | `succeeded`, `failed`, `abandoned`, `timed_out`, `stopped` or `dropped` |
| `steps` | Per step: status (`succeeded`, `failed`, `skipped`), attempts, start time and duration, sha256 digest of the output, a one-line error of at most 300 characters, `timed_out`, and on a model or agent step its lane, model, tier, and the tokens and dollar cost when known (a lane that reports no token counts omits them) |
| `output_digest` | sha256 of the run's result, or null |

Output values never enter the ledger, only their digests. The inventory, the page and Vigil can read it without it becoming a second copy of what the steps produced.

An occurrence runs at most once. Before any step starts, the runner refuses an occurrence key already in the ledger and then claims the key with an exclusive-create marker file in `claims/` next to the ledger, so two processes racing on the same occurrence cannot both start. A refused duplicate writes nothing. A manual run gets a fresh key per invocation; pass `--occurrence KEY` to make a run idempotent. A failed occurrence is retried under a new key, never silently re-run. Every write asserts its invariants first, and both the ledger and the claims directory are checked through `realpath` to stay inside their directory.

## The inventory and the Pulse pages

**Nothing runs outside Workflows.** Every scheduled, recurring or event-started job LifeOS owns is a typed definition in `LIFEOS/USER/WORKFLOWS/`, with no exceptions and no grandfathering. Launchd jobs, agent jobs and Pulse crons that still run are migration debt, never a place to build: a fix or feature for one of them moves it into a definition first. The `outside-workflows` finding below names each one, `/ic` blocks on it, and the agent-job installer refuses new jobs. The one exemption is the dispatcher (`com.lifeos.workflows-dispatcher`), which is the Workflows clock. Always-on services (the Pulse server, the Relay bridge, menu-bar apps, tunnels) have no schedule to move, so they stay registered services in `Services.ts` and are listed as low-severity findings (decided 2026-10-22). A job that needs its own macOS permission, such as Full Disk Access, keeps a launchd entry with no schedule of its own, named for its workflow (`com.lifeos.<name>`); the workflow starts it with `launchctl kickstart` and waits for it, and the inventory folds that entry into the workflow. The messages reader is the first case: run as a child of the dispatcher it read nothing.

LifeOS runs work in many places: launchd services, scheduled agent jobs, Pulse cron, Cloudflare Workers, crons in project repos, on-demand skill intents, and typed definitions. Each home has its own format and its own idea of running. The inventory reads all of them into one list, checks what is declared against what is installed and what actually ran, and shows the result on Pulse. It only reads; its one writer is `acknowledge`.

### The record

Every piece of work becomes one record (`LIFEOS/WORKFLOWS/types.ts`):

- **Where it lives**: its runtime (`launchd`, `agent-job`, `pulse-cron`, `cloud`, `project-cron`, `skill`, or `workflow` for a typed definition) and the file that defines it. Every Worker in the cloud fleet (action, pipeline, flow or app) is its own `cloud` record, whatever starts it.
- **What starts it**: a schedule, a daemon, or on demand, with the expected gap between runs.
- **Whether it is really there**: declared, installed (loaded, on disk, absent, deployed), and the evidence of its last run. For typed workflows the evidence comes from the run ledger: last run, status and count.
- **What it is linked to**: an `after:` link appears in both workflows' `linked` lists.
- **Its card**, the six things every workflow should say about itself:
  1. purpose: what is being done
  2. input: what it reads
  3. steps: each marked with its executor (code, judgment, model, human)
  4. SOP: the document that governs the work
  5. output: the format it produces
  6. destination: where the output goes

Native definitions rarely carry all six. Empty slots stay empty and are drawn empty, so the gaps are visible. The per-install overlay `LIFEOS/USER/CONFIG/workflows.json` fills them without touching the native definitions. A typed definition fills its own card from `description`, `input`, `steps`, `sop`, `output` and `destination`.

### Reconciliation

| Finding | Meaning |
|---|---|
| missing | Declared somewhere, not installed |
| orphan | Installed, declared nowhere |
| possible duplicate | The same work scheduled on two runtimes |
| late | Last run older than twice its expected gap |
| failing | Last run failed |
| no run record | Scheduled, but nothing records whether it ran |
| drift | An installed `com.lifeos.wf.<name>` job was compiled from a different definition hash than the file now on disk |
| no SOP | A typed workflow that names no SOP |
| outside workflows | An enabled, installed launchd job, agent job or Pulse cron, which runs outside Workflows. High for scheduled and event-started jobs, low for always-on services. `/ic outside-workflows` blocks on every high one, and acknowledgement never silences it. A registry row with nothing installed runs nothing and is not listed |

Findings present when an install adopts Workflows are recorded as acknowledged in `LIFEOS/USER/CONFIG/workflows-baseline.json`, written only by `Workflows.ts acknowledge`. `/ic` blocks on any missing or orphan finding that is not acknowledged, so a job that disappears, or a scheduler that appears outside the registries, fails the integrity check.

### Commands and pages

```bash
bun LIFEOS/WORKFLOWS/Workflows.ts summary            # counts, coverage, executor mix
bun LIFEOS/WORKFLOWS/Workflows.ts snapshot           # the dated series of daily snapshots
bun LIFEOS/WORKFLOWS/Workflows.ts attention          # findings, as plain sentences
bun LIFEOS/WORKFLOWS/Workflows.ts list --runtime workflow
bun LIFEOS/WORKFLOWS/Workflows.ts list --runtime cloud
bun LIFEOS/WORKFLOWS/Workflows.ts show <id>
bun LIFEOS/WORKFLOWS/Workflows.ts json               # the whole inventory
bun LIFEOS/WORKFLOWS/Workflows.ts acknowledge        # record current missing/orphan findings as the baseline
```

Pulse serves the same inventory at `GET /api/workflows` and draws it at `/workflows`: the work list with each row's step strip inline, an overview, the attention list, the catalog by runtime, and a card per workflow.

The `/workflows` UI design comes from the [Maestro](https://runmaestro.ai) project. The dashboard of scheduled workflows, the pipelines canvas with one coloured frame per pipeline, the node drawer and the floating legend all follow how Maestro Cue draws its pipelines.

The Canvas tab draws `after:` links and sub-workflow steps as edges between workflows, colours each connection by its class, and lets you add, edit and remove steps and links. The Scheduled tab lists scheduled workflows with a countdown and a pause control, and the Activity tab shows real runs and, when the value store kept them, each run's step inputs and outputs. Every edit goes through the same validator the CLI uses (`GET /api/workflows/graphs` feeds the Canvas and Scheduled tabs), so the page and the CLI can never disagree.

## Deploying cloud Workers

Cloud Workers deploy only through the fleet's gated deploy script, never a bare `cf deploy`. That script, `deploy.sh`, lives in your own `USER/CUSTOMIZATIONS/WORKFLOWS/` tree and is not in the public release payload; a public install deploys a cloud workflow with `workflow deploy <name>` (`LIFEOS/WORKFLOWS/cloud/deploy.ts`). The script runs a preflight first (typecheck, the full test suite, and a prompt-integrity check) and refuses to deploy when any of them fails. A deploy of a production Worker is a change to production, so it happens only with the principal's explicit go-ahead.

```bash
cd ~/.claude/LIFEOS/USER/CUSTOMIZATIONS/WORKFLOWS
bash deploy.sh _A_YOUR_ACTION     # one Worker, by its directory name under Workers/
bash deploy.sh --secrets          # push secrets to the Workers that need them, read from the local env file
```

The argument is the directory name under `Workers/` (`_A_YOUR_ACTION`), not the deployed Worker name. Each Worker directory holds a `cloudflare.config.ts` (name, cron triggers, service bindings, resource bindings) and `src/index.ts`; a legacy `wrangler.jsonc` is still read by the inventory.

**Order.** Deploy what is bound before what binds to it: actions, then pipelines, then flows. A service binding to a Worker that does not exist fails.

**Worker names.**

| Shape | Worker name | Example |
|---|---|---|
| Action | `wf-a-<kebab-name>` | `wf-a-your-action` |
| Pipeline | `wf-p-<kebab-name>` | `wf-p-example` |
| Flow | `wf-f-<kebab-name>` | `wf-f-example` |

**Secrets.** Secrets are Worker secrets, set by the deploy script, never `.env` files or `--var` values. Every Worker needs `AUTH_TOKEN`; model actions need their provider key; other actions need only the keys they declare. Never commit `.env` or `.dev.vars`. Generate tokens with `openssl rand -hex 32`.

**Cron syntax.** Five fields: minute, hour, day of month, month, day of week (Sunday is 0). Cloudflare crons run in UTC; a typed definition's `schedule` trigger carries its own IANA timezone instead.

| Expression | Schedule |
|---|---|
| `*/5 * * * *` | Every 5 minutes |
| `0 */6 * * *` | Every 6 hours |
| `0 9 * * 1-5` | 09:00 UTC, weekdays |
| `0 0 * * *` | 00:00 UTC daily |

**Troubleshooting.**

| Symptom | Likely cause |
|---|---|
| 404 from a Worker | The name in `cloudflare.config.ts` does not match the deployed name |
| 401 | `AUTH_TOKEN` missing or different between caller and callee |
| Service binding error | The target Worker is not deployed, or its name differs |
| Cron not firing | Bad cron syntax, or no `scheduled` handler exported |
| Flow runs, no output | Malformed pipeline output, token mismatch, or a missing provider key on an action Worker |
| Model errors | 401 bad key; 429 rate limited, back off; 529 provider overloaded, retry later |

## Moving the existing cloud fleet in

The move finished on 2026-09-30. Every flow and pipeline has a definition in `LIFEOS/USER/WORKFLOWS/`, and the section below records the method it followed.

The fleet predates the typed format, and it runs production work that other applications depend on, including a shared application database, shared KV namespaces, and a content pipeline that feeds a live site every few minutes. Moving it into Workflows follows the existing-system upgrade rule: inventory first, keep the working path until the replacement is proven, and cut over one flow at a time. The full plan is the maintainer's migration ISA (maintainer-side; not in the release). Its method:

1. **Map every dependency.** Every resource the fleet touches is listed with each consumer, how it is used, and what would break it (a rename, an interface change, a move, a schema change). The live Cloudflare account is reconciled against source, so a Worker deployed without source, or source never deployed, is named and decided before anything moves.
2. **Wrap before rewrite.** A flow's orchestration moves first: it becomes a Workflows definition whose steps call the same deployed action Workers through service bindings. The work each step does stays byte-identical; only scheduling and wiring change. Action code changes later, one action at a time, and only additively.
3. **Measure before touching.** A read-only daily snapshot records the numbers each consumer depends on: item counts by state, null rates on projected columns, failure causes, queue depth, per-cron invocations, freshness of every derived table, security finding counts. Some of these exist only if counted daily, so counting starts before any change, and at least 14 days of baseline exist before the first cutover.
4. **Probe every consumer.** Each application that reads the fleet's output has a probe that passes on the current system, and must pass before and after each cutover.
5. **Shadow against clones.** A new definition first runs against cloned databases, KV namespaces and queues, never production state, and a guard asserts that no shadow write reaches a production id.
6. **Prove parity with numbers.** A parity tool diffs a shadow window against production per item and per rate distribution and prints pass or fail against a stated threshold. A green health check is not parity.
7. **Rehearse the rollback.** Each flow's rollback is one command that re-enables the old Worker's cron and disables the new runner's, rehearsed once in shadow before the cutover.
8. **Keep contracts additive.** Typing a shared action must not break a caller that has not migrated, so shared contracts add fields and never require new ones, and they are tested against replays of real inputs before any enforcement.
9. **Cut over in waves, lowest blast radius first.** Dead code and stateless leaves, then personal flows, then pipelines, then signal fetchers, then the monitoring and security planes (dual-run so heartbeats never gap), then flows that hold a single-owner credential (exactly one refresh owner at every instant), and the production content pipeline last. Each cutover needs a baseline, a shadow parity pass, a rehearsed rollback, the principal's go-ahead, and 24 hours inside threshold with every consumer probe green.
10. **Rename last.** Names are bound in configs, extensions, CLIs, hooks and docs. Nothing with a live binding or an external client is renamed until every consumer has been updated and re-probed.

Workers that are applications rather than workflows (a website, a webhook receiver, a data-ingest endpoint) stay Workers. They are registered in the inventory as app endpoints with their consumers and are not migrated.

## Names that keep the old name

The fleet's old name, Arbol, was renamed out of the current system on 2026-09-30. An install that ran the old fleet renames its Workers in place on Cloudflare to the `wf` prefix, keeping ids, bindings and secrets. The fleet source lives in `LIFEOS/USER/CUSTOMIZATIONS/WORKFLOWS/`, and the old directory name survives only as a symlink to it until every consumer is repointed. The old-to-new name map prints with `bun ~/.config/LIFEOS/USER/Workflows/migration/name-map.ts` (maintainer-side; not in the public release).

Everything local carries the new name. A few identifiers keep the old one because an external system binds them or an old record stores them.

| Identifier | What it is | What happens to it |
|---|---|---|
| `_A_*`, `_P_*`, `_F_*` under `Workers/` | Worker source directories | They stay: the deploy script and tests resolve Workers by directory name |
| Deployed queue names, container applications, deployed secret names, D1 databases, KV namespaces, R2 buckets and the GitHub repository | Names Cloudflare or GitHub binds | Each renames when its flow migrates; until then it sits in the rename allowlist the residue check reads |
| Stored values in old records: an email brand key, a Bunker app id, an Achilles finding source and source ref | Values written before the rename | Each resolves through an alias to its `workflows` form, so old rows keep resolving |
| The old Pulse page route | A URL people may have bookmarked | It redirects to `/workflows` |
| Dated history: ledgers, changelogs, dated work records, Decisions rows | Records of what happened | Never rewritten |

The fleet CLI's registration file (name to Worker, local or cloud mode) is `~/.config/workflows/config.yaml`.

## How it fits with the rest of LifeOS

- **Services.ts** stays the launchd registry for the legacy services until each one moves into a definition (§ The inventory and the Pulse pages: nothing runs outside Workflows). Workflows reads it; local schedules need no plist of their own, since the one `com.lifeos.workflows-dispatcher` job evaluates them and `engine/schedule-install.ts` only checks the schedule and installs that job.
- **`/assistant`'s scheduled view** shares the inventory's parsers, so the two cannot disagree.
- **The ideal state.** Workflows are the hands of the life climb (`../LifeOs/HillClimbing.md` § 13): the recurring work and measurement that move a TELOS target run here, and Vigil watches them. A definition names the target it moves with a root `serves: IS-0007` (one id or a list), which the ideal-state pursuit graph reads.
- **Vigil** stays the alerting layer. Workflows is where it can read expected cadences, and the run ledger is a source it can read.
- **Assay's judgment layer** is the `judgment` executor. Steps moving from model to judgment to code show up in the executor mix.
- **Bunker** is the harness every shipped app runs in; the fleet's security scanner is its Security plane.
- **SOPs and knowledge domains.** A workflow names the SOP it carries out and the domains it reads. A context platform holding governed knowledge is reached only through its own authenticated gateway, never a direct database binding from a workflow or runner.
- **Skills.** The prose workflows inside skills stay skills. A recurring one is promoted to a typed workflow on its own merit.
- **Model lanes.** Unattended model steps run through `Inference.ts` on the subscriptions (`openaiLow` runs at the low level and every other lane at medium), and agent steps run on codex with the lane's model; a step names its lane and never a model id.

## What is built and what is next

| Area | State |
|---|---|
| Inventory of every runtime, reconciliation, `/ic` gate, Pulse `/workflows` | Built |
| Format v2: fields, step kinds, triggers, connection classes, `after:` typing, side-effect rule | Built |
| v1 compatibility (every repo v1 definition gets the same verdict) | Built |
| CLI: all 23 commands in § The CLI | Built |
| Local runner for all seven step kinds; run ledger with occurrence dedupe | Built |
| Typed definitions in the inventory, with ledger evidence and `after:` links | Built |
| Resource declarations gating `runs_on` (`resources:`, cloud-only-resource validation) | Built |
| Local scheduling by one launchd job, `com.lifeos.workflows-dispatcher` (`engine/dispatcher.ts serve`, `engine/schedule-install.ts` checks a schedule and installs that job; no per-workflow plist, ISC-311/312); `after:`/`event` dispatch (`engine/dispatcher.ts`); `timezone: principal` schedules | Built |
| Cloud clock: `wf-clock` Worker holds the time triggers and a run queue, the dispatcher leases runs from it and falls back to its own clock when the cloud is silent for 10 minutes (`clock/`, `engine/clock.ts`, `engine/cloud-clock.ts`; ISC-316, 318, 319) | Built and live 2026-10-24 |
| Cloudflare as control plane with the Mac as one leased worker (ISA F27: durable run state, STATVS as the record, `mac.*` step needs) | Next: § Direction |
| Queued triggers (`engine/queue.ts`); one catch-up (`engine/schedule.ts`) | Built |
| `human` step execution (`engine/human.ts`, `human-queue.ts`, `human-notify.ts`) | Built |
| `model`, `agent`, `judgment` and `workflow` step execution (`engine/steps/`, `engine/runner.ts`) | Built |
| Canvas: edges, connection colours, scheduled tab, activity payloads, linking through the validator | Built (Pulse `/workflows` Canvas, Scheduled and Activity tabs) |
| Cloud runner built from engine source; secret checks; cloud runs into the ledger | Built: runners named `wf-<workflow-id>`, cloud runs pulled into the ledger every 15 minutes |
| Fleet migration, flow by flow, content pipeline last | Cut over 2026-09-30: every flow and pipeline has a Workflows definition and scheduled jobs run on cloud runners. |
| One name: the fleet's Worker names and paths renamed | Done 2026-09-30; the identifiers in § Names that keep the old name remain |
