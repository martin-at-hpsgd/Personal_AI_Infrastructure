# CreateQuestions

**Contents:** Ideal State · Anti-criteria · Inputs · Safety gates · Tool contract · Output format

Takes one fuzzy task, an eval or a working process, and produces the pipeline that should run it: what code decides, which values Clairic extracts, which typed questions Clef-omni is asked, what an LLM writes, how the answers combine, where the thresholds sit, what happens in the uncertain band, and how the system later earns enforce. It uses only the tiers the task needs, measured live against cases someone else wrote and labelled and against an LLM-only baseline, ending with numbers and a shadow registry row, or with the finding that the LLM call alone is the better pipeline.

## Ideal State

- The brief existed before the case author and the designer started: every item under Inputs is in it or covered by a one-line stated assumption, the decision and the raw record are known unless the principal said `proceed`, and the label policy for every category the brief leaves on the line was settled by the principal and written into the brief.
- `validate` exits 0 on the system file, which carries a fit verdict, its reason, and the tiers the system uses in `fit.tiers` (code, extract, decide, write). Each need sits in the tier `References/QuestionDesign.md` § Extract field, code fact or question puts it in, and a tier the task does not need is absent.
- A `not-glance` verdict ends the run: the file has no stages, and the answer names the right tool (code, a model judge, a reasoning model, or the principal) and why. None of the items below apply to it.
- A `partial` verdict (`References/QuestionDesign.md` § Does the judgment layer fit) designs the part that fits and names what the rest needs.
- Every question states its purpose (the mistake it catches) and the fields it reads; every threshold names the error it favors and why, traced to the decision's costs; every policy rule has a reason.
- The cases were written and labelled by an agent other than the designer, before the designer saw them, and `cases` passes: at least 60 cases, at least 12 on each outcome of every decision, a dev and a holdout split with each twin pair inside one split, twins that differ only on the deciding fact, and at least three injection cases aimed at the costly error, asserted by `cases … --require-tag injection:3` together with the twins check.
- A second-opinion review of the validated design, against the brief and the doctrine's review checklist (`References/QuestionDesign.md` § Review checklist), existed before the first measurement, and the design measured at `dev-r0` already carries every finding the designer adopted. Each finding is recorded as adopted, rebutted, or deferred in the task ISA's Decisions, or in `provenance.notes` when there is no ISA.
- Every question change between `dev-r0` and the final system came from a dev report alone, names the dev cases behind it, and raised the dev number; a change that did not was reverted, and a round with no dev gain was the last round.
- A holdout report (`report.json`, `report.md`) exists for the final system. Each decision reaches balanced accuracy of at least the caller's enforce bar, 0.85 unless the owning ISA sets another, with the escalation rate under `max_rate`. Otherwise the report names each failing question, and every round's numbers are kept.
- The report states the composed decision's margin over the baseline question, both over all scored cases and judged-only (`baseline.judged`); the judged-only margin decides. A system that does not beat its baseline on the judged-only holdout margin ships as the baseline question alone, or the design says why not.
- The holdout report also carries the LLM-only baseline (`run --baseline llm`): one LLM call per case answering every decision and every extract field. A tier stays only when the pipeline is within the bar of the LLM-only baseline on every decision and extract field, at lower latency or tokens; otherwise the design ships as the LLM-only call and says why.
- Every extract field's holdout accuracy is in the report, scored against the cases' `expected_fields`.
- Every question survived ablation or its `purpose` gives the rare case it exists for; no pair correlates at 0.9 or more without a stated reason; every injection case ends at the safe outcome, or its failure is named.
- The calibration plan names a ground truth that is not the consumer's own action, and a join key.
- The `registry-row` output is saved beside the system: shadow, every threshold uncalibrated, the budget sized from declared volume and measured tokens per case. Nothing is registered, wired into the consumer, or promoted.

## Anti-criteria

- The designer never receives the case file or any path to it, sees no case before the first measurement (from round 1 on it sees dev reports only), and never sees anything from holdout.
- The holdout split never runs more than once, and only on the final system: a rerun after a change needs fresh holdout cases from the case author first.
- No more than two iteration rounds after the first measurement, and no third round bought with the holdout when the holdout number still misses the bar.
- No real personal data and no secret value appears in a case, a fixture, or a report, and no secret-shaped string reaches the engine.
- No engine call outside the tool: no loop awaits `judge`, and nothing calls the engine client directly.
- This run never registers the caller, wires the system into its consumer, or moves it toward enforce; those belong to the consumer's own build.
- A `--split all` smoke run is never a number anyone iterates on.

## Inputs

Before dispatching anyone, the orchestrator needs:

- the decision: what action code takes, which outcomes it chooses between, and what happens today
- the cost of each kind of mistake, in the principal's words
- the raw record the consuming code has at decision time: its fields and what each holds, including context code can look up
- the values the task needs out of that record (amounts, dates, names, lists, estimates) and, when the task produces text, what is written and for whom
- the expected volume per day and roughly how often each outcome occurs
- the escalation target that exists (a model judge, a reasoning model, a person, or none) and its capacity
- where a correct outcome could later be observed, independent of the system's own action
- the label policy for every category the brief leaves on the line: look-alikes the brief's own lists could put on either side (impersonation of a category that wakes, an alert that says no action is needed, a note to self), each settled by the principal

The last item is the one a brief most often misses. The case author and the designer read the same brief independently, so wherever it is ambiguous they resolve it differently, and the holdout number then measures their disagreement instead of the engine. In a pilot, most holdout errors were categories of this kind: phishing posing as a money, legal or security matter, a routine deposit alert, and a no-action sign-in notice. The designer woke them to protect the costly error, and the case author skipped them as bulk mail.

When a few of these are missing but the rest are workable, state the assumption in one line (`⚠️ Picking X over Y because R; redirect if wrong.`) and proceed. When the decision or the raw record is unknown, the design would be structurally wrong, so ask at most three questions and wait, unless the principal says `proceed`.

## Safety gates

- Thresholds in the system file are provisional. The registry is where thresholds live once a system is registered, and registering is a separate, explicit step taken when the consumer is wired, together with the caller's row in `LIFEOS/DOCUMENTATION/Router/RouterSystem.md` § Data class per caller.

## Tool contract

**A run is a Workflow at the tier its parts set** (Router ISA F8, Algorithm § Routing; OPERATIONAL_PREFERENCES § Workflows is the opt-in): the parts this intent runs at the same time become lanes of a script written for that run, the dependent steps stay in order, and the main session stays the only writer of the deliverable.

### Roles

| Role | Runs on | Sees | Never sees | Produces |
|---|---|---|---|---|
| Orchestrator | the session running this intent | everything | nothing is withheld | the brief, the projection, every run, the dispositions |
| Case author | `Agent(subagent_type:"Opus")`, fresh context | the brief, and `References/QuestionDesign.md` § Cases | the design, in any draft | `cases.raw.jsonl` |
| Designer | `Agent(subagent_type:"Opus", effort:"xhigh")`, a fresh brief per round | the brief, all of `References/QuestionDesign.md`, the types in `LIFEOS/ASSAY/QuestionSystem.ts`, dev reports from round 0 on | the case files, anything from holdout | `system.json` |
| Second opinion | `Agent(subagent_type:"Fable")`, read-only | the brief, `References/QuestionDesign.md`, `system.json` | the case files | ranked findings with evidence |
| Projector | the orchestrator, or an execution worker | `cases.raw.jsonl`, `system.json` | nothing is withheld | `project.ts`, `cases.jsonl` |

The case author and the designer start from the same brief and can run in parallel. The case author writes each case as the raw record the consumer would see, with the expected outcome per decision, the expected value of every value the brief names (`expected_fields`), the split, `twin_of` for look-alikes, tags, and a note saying why the case exists.

The designer may use any thinking skill through the Skill tool and records which ran and what each changed in `provenance.notes`.

### Designer brief

The orchestrator hands each designer, in a fresh context, exactly this and nothing else:

- the brief from Inputs, with the assumptions stated
- the doctrine path: `skills/Assay/References/QuestionDesign.md`, all of it
- the types path: `LIFEOS/ASSAY/QuestionSystem.ts`
- the output path: `<dir>/system.json`, the only file the designer writes
- the case-isolation rule: the designer never opens, requests or infers the case files, and from round 1 on sees dev reports only, never anything from holdout
- the report to return: the system path, the fit verdict, which thinking skills ran and what each changed, and anything the brief could not resolve

The projector turns each raw case into the system's declared `state` fields and deterministic `facts`, exactly as each field's `source` and each fact's `computed_by` describe. That script is the first draft of the consumer's own state builder. It is rerun whenever an iteration changes the declared state or facts. The designer never runs it, because it would show the designer the cases.

### Tools

The tool is `bun LIFEOS/ASSAY/QuestionSystem.ts`, with four commands.

| Command | What it does |
|---|---|
| `validate <system.json> [--json]` | Structural check of the file. Exits nonzero on a structural defect (unknown or unused question, a choice without a no-match option, a score under three levels, arithmetic or date comparison asked of the engine, a read outside the state schema, a duplicate id, a question with no purpose, a threshold under 0.5). Wording smells warn and never fail. |
| `cases <system.json> --cases <cases.jsonl> [--min-cases N] [--min-per-side N] [--require-tag tag:N]` | Checks the case file against the system's state and facts and against the floors, including twin pairing and, with `--require-tag`, a minimum count of cases carrying a tag. Exits nonzero when a case is malformed or a floor is missed. |
| `run <system.json> --cases <cases.jsonl> [--split dev\|holdout\|all] [--out <dir>] [--concurrency N]` | Asks every case through `judgeMany` as the shadow caller `question-design`, applies the policy, and writes `report.json` and `report.md`: per-question separation, the decision confusion matrix, the baseline margin (all-scored and judged-only), per-rule `rule_hits`, drop-one ablation, correlated pairs, decided-by counts, truncations, tokens per case, the engine model and a hash per question, and every wrong case with its answers. |
| `registry-row <system.json> [--report <report.json>]` | Prints a shadow caller row with every threshold uncalibrated, and sizes the budget from declared volume and measured tokens per case when given a report. It registers nothing. |

### Measurement sequence (tool contract)

`<dir>` is the system's directory.

1. `bun LIFEOS/ASSAY/QuestionSystem.ts validate <dir>/system.json` exits 0 before anything else runs. A `not-glance` verdict stops here.
2. The projector writes `<dir>/cases.jsonl` from `<dir>/cases.raw.jsonl` with `bun <dir>/project.ts`.
3. `bun LIFEOS/ASSAY/QuestionSystem.ts cases <dir>/system.json --cases <dir>/cases.jsonl --min-cases 60 --min-per-side 12 --require-tag injection:3` exits 0. It also runs the twins check.
4. `bun LIFEOS/ASSAY/QuestionSystem.ts run <dir>/system.json --cases <dir>/cases.jsonl --split dev --baseline llm --out <dir>/runs/dev-r0`. The dev baseline tells the designer early whether a tier is pulling its weight.
5. For each iteration round N (at most two): a fresh designer brief carrying `system.json`, `References/QuestionDesign.md` and the latest dev `report.md`; then `validate`, the projection again if state or facts changed, and `run … --split dev --out <dir>/runs/dev-r<N>`. A change stays only if the dev number improved.
6. `bun LIFEOS/ASSAY/QuestionSystem.ts run <dir>/system.json --cases <dir>/cases.jsonl --split holdout --baseline llm --out <dir>/runs/holdout`, once, on the final system.
7. `bun LIFEOS/ASSAY/QuestionSystem.ts registry-row <dir>/system.json --report <dir>/runs/holdout/report.json > <dir>/registry-row.json`

### Flags outside the sequence

| The request says | Command and flags |
|---|---|
| "machine-readable", "for a script" | `validate <system.json> --json` |
| "stricter floors" for a high-stakes decision | raise `--min-cases` and `--min-per-side` on `cases` |
| "smoke test the plumbing" | `run … --split all --out <scratch dir>` |
| rate-limit errors, "gentler" | `--concurrency 8` on `run`; leave it unset for the default pool |
| "what would it cost" | step 7; the row sizes the budget from the holdout report |

## Output format

- The system file is the design record. Each question's `purpose`, each rule's `why`, each threshold's `why`, the fit reason and `provenance.notes` carry the reasoning, so nothing depends on a separate narrative.

### Where the artifacts live

A system belongs to the thing that will consume it: beside the consuming project's ISA under `questions/<system-id>/`, or under the task's `LIFEOS/MEMORY/WORK/<slug>/questions/<system-id>/` when no project owns it yet.

```
questions/<system-id>/
  system.json          the design; the only file the designer writes
  cases.raw.jsonl      the case author's cases, in the consumer's raw shape
  project.ts           raw record → declared state and facts
  cases.jsonl          the projected cases the tool reads
  runs/dev-r0/         report.json, report.md (first measurement)
  runs/dev-r1/         after the first iteration round, when there is one
  runs/dev-r2/         after the second, when there is one
  runs/holdout/        the final number
  registry-row.json    the shadow row, saved from stdout
```

### Hand-off

The run reports: the fit verdict; the layers the system uses; per decision the holdout balanced accuracy, escalation rate, and baseline margin; the questions cut, split, or moved to code across rounds; the dispositions of the second opinion's findings; and the path to `registry-row.json`.
