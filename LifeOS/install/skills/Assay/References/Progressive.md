# Progressive verification

## Outcome

Each criterion gets evidence of the right kind at the right time. Ordinary checks are fast and token-free; scheduled integrity and explicit build checks spend only on the judgments the criterion needs. Reuse ISAFormat's lanes, stages and cadence; never add a parallel scheduler.

| Occasion | Evidence | Execution |
|---|---|---|
| Development loop, critical checks, fleet ticks | Small deterministic behavioral asserts, including known-bad fixtures | Row engine: `bunker test`; liveness only, inference disabled |
| Slower or scaled testing | Integration, property and load asserts | Row engine: `bunker test --deep --asserts`; inference disabled in every child |
| Scheduled semantic integrity | Calibrated rubric on the remaining quality criterion | ISA `integrity@6h` or another justified cadence; existing monitor owns timing |
| Explicit change verification | Relevant asserts and selected judge stages | Row engine: `bunker test --deep --stage 2` |
| Candidate selection | Flipped tournament and independent acceptance checks | Build-lane `pairwise`, later stage; explicit row-engine `bunker test --deep` |
> The Bunker CLI is maintainer-private and not in the public release; run code rows with `bun test ./<path>` and suite rows with `bun skills/Assay/Tools/EvalRunner.ts`.

Assay resolves each criterion's row at the cheapest honest tier (code assert, then the judgment layer, then a model judge, then the principal). The `bunker test` commands here are the row engine that executes those rows; Development Test and the deploy probes call it, and it is not the eval system itself.

Stage is dependency order, not intelligence. A higher stage runs only when every lower prerequisite for that criterion passed on the same evidence.

## Escalation inside a judged assert

Escalation is one step, from the judgment layer's engine to the model judge. A judged assert asks the engine first: an `llm-assert` as a noul, an anchored `llm-rubric` as a score. A confident answer from a caller in enforce mode resolves the assert, except for a small holdout (`GLANCE_ENFORCE_HOLDOUT` in `Tools/Judge.ts`) that still runs the model judge so agreement stays measured. The middle band escalates to the model judge as UNKNOWN (recorded as `UNKNOWN` for a noul, `below threshold` for a score). A shadow caller or question, an engine error, or an unanchored rubric escalates too, with its own reason recorded in `jev.escalate_reason` (the stored field keeps the name of the engine retired 2026-10-10).

Nothing climbs beyond the model judge, which runs at the suite's calibrated level (else 'high'). The one exception is a format repair: a cheap judge that returns an unparseable verdict gets one retry at 'high'. There is no retry-until-pass. A quality failure stays a failure, and a stronger judge is chosen only when calibration shows the cheaper level is inadequate. Uncalibrated runs stay provisional.

## Skills

The `bunker test --skill <Name>` row engine adapts `evals:` declarations to the same runner. Deterministic commands run from the installation root at stage 1. Named suites run at build stage 2, after commands pass. Manual exceptions remain observations owed. A suite-only skill cannot report a successful fast test with zero executed checks.

Slow commands may declare `lane: integrity` or `lane: build` and a positive `stage`. For workflow-specific prerequisites, cadences or tournaments, use the owning ISA's Test Strategy. Skill-wide evidence covers only the behaviors its cases exercise.

```bash
bunker test --skill Assay
bunker test --skill Assay --deep --asserts
bunker test --isa ISA.md --deep --stage 2
```

> The Bunker CLI used in this table and in the examples above is maintainer-only and not in the public release. On a public install, run code rows with `bun test ./<path>` and suite rows with `bun skills/Assay/Tools/EvalRunner.ts`. The miss, label and attest commands and `glance` rows have no public runner, so use a suite with a judged assert.

## Actual harness context

Tool-free EvalRunner measures answers. Suites needing skills, identity, tools or session state declare `requires_context: [skill, identity]`. Plain EvalRunner refuses those suites before inference. `Tools/Agentic.ts` exports `runAgenticSuite(name, adapter, requiredContext, overrides, deps)`: the same grader with a fresh scratch workspace per trial and persisted actual-model, context-hash and final-state evidence.

The adapter invokes the production harness and reports what it actually loaded. It owns sandboxing, tool permissions and cleanup outside the supplied workspace. Fixtures are synthetic; real-world mutations are excluded. Durable evidence lives outside the temporary workspace. A fabricated receipt is not evidence. With/without comparisons differ only in the named skill; shared context must load in both arms. `../Intents/RunAgentic.md` records the standalone-plugin limitations.

## Evidence and timing

Rerun affected checks after changes to skills, suite inputs, execution code or models. New ordinary suite runs bind content hashes into `EvalState.md`; older runs read `unbound historical result`, changed bindings read `stale`, and the latest unavailable attempt remains visible beside the last valid score. Overrides and injected adapters are separate experiments, not certification of the default suite. Status refreshes never regrade.

Deeper evidence is due on a relevant change, explicit request or declared cadence. Missing evidence stays open without forcing a model call on every ISA edit. Uptime remains Bunker's responsibility, and synchronization never reruns judges.
