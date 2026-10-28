# RunEval Intent

Run a suite and read the result honestly.

## Ideal State

- The headline is pass^k with its SEM and 95% CI; regression suites are judged on pass^k, capability suites on the mean.
- Every surprising score in the report, good or bad, cites the transcripts of the extreme cases it rests on, and those transcripts were read before the score was reported.
- An erroring suite is reported as unverified, the same operational fact as a failing one.
- A judge running at 'high' on a suite expected to be cheap is reported as uncalibrated, with the Calibrate intent named as the fix.
- When the suite was generated from a skill's intents (`Tools/IntentRubric.ts`), each failed assert is reported against the Ideal State or Anti-criteria bullet it came from (its `derived_from`: `<intent path>#IS-n` or `#AC-n`), and the run's receipt names the intent as its ideal state.

## Anti-criteria

- A bare mean quoted without its interval.
- A score reported before its transcripts were read.
- A `glance` row pushed through EvalRunner.
- Two runs on either side of a judge or rubric change compared as one series.

## Tool contract

```bash
bun ${LIFEOS_SKILL_DIR}/Tools/EvalRunner.ts -s <suite> [-t trials] [--json]
# Exit 0 = passed, 1 = regressed, 2 = verifier unavailable (no run verdict; run.json kept as history; latest.json and EvalState untouched). USER-layer suites resolve before the skill's own.
bun ${LIFEOS_SKILL_DIR}/Tools/SuiteManager.ts list      # what exists + last results
```

Every run persists full per-trial transcripts to `MEMORY/STATE/Evals-Results/<suite>/<run_id>/run.json` (Anthropic gate: never trust a score until the transcripts are read).

A `glance` row is answered by `bunker test` in the Bunker runner, never here (CreateSuite § Inputs, Suite or glance row). The Bunker runner is maintainer-only; on a public install, run a judged-assert suite here instead.
> The Bunker CLI is maintainer-private and not in the public release; run code rows with `bun test ./<path>` and suite rows with `bun skills/Assay/Tools/EvalRunner.ts`.

## Output format

- Inside a suite, `llm-assert` and fully anchored `llm-rubric` asserts ask the judgment layer's engine first. Each judged result in run.json carries `jev.escalate_reason` (the stored field keeps the name of the engine retired 2026-10-10), which says whether the engine resolved it (`confident`) or why the model judge ran: `UNKNOWN` or `below threshold` (the middle band), `holdout`, `unanchored`, a shadow or unregistered caller (`caller is shadow`, `question is shadow`), or `error:<kind>` (`error:disabled` under the inference kill switch). A suite where every rubric reads `unanchored` never used the engine at all.

## Gotchas

- The agent-under-test runs single-shot, no tools, with the live system prompt + DA identity — a config edit that shifts dispositions shows up; a property requiring tool use belongs in RunAgentic.
