# Prompt

Climb a prompt, an agent file, a system-prompt section, or a doctrine rule that keeps getting broken.

## Ideal State

### Prompt or agent file

- The prompt's purpose is stated as testable outcomes, not as steps.
- A suite exists with cases drawn from real uses and misses, each with binary asserts, plus an adversarial fixture. It is presented to the principal before the first experiment, because the cases define the hill.
- The baseline is pass^k over five or more trials, read from the raw run file. For a judged suite, `Compare.ts` paired CI is recorded as the noise floor.
- If the prompt will serve more than one model, the winner is re-run on each before it is kept, and the per-model numbers are reported.
- Each real miss is now a suite case, a standing check that fails if the miss returns.
- Shorter is a win when the score holds: of two candidates whose scores tie within the noise, the kept prompt is the shorter one, recorded with `exp --simpler`.

### Doctrine rule (a hill from the Errata v4 broken-rules table)

- The rule's text and its past failures are in hand: `Errata.ts v4 rules show <rule-id>`, and the failures covering it in `LIFEOS/USER/ERRATA/v4/coverage.jsonl` joined to `v4/exchanges.jsonl` by id.
- The climb's default fix is a check that enforces the rule. That can be a deterministic hook, a judgment-layer question, or a gate, as HillClimbing.md § 8 says. Rewording the rule is the fallback.
- The baseline and experiments measure the candidate check against the rule's past failures (recall) and an equal sample of non-failures (false alarms). The check is designed through `Skill("Assay")` CreateQuestions when it needs judgment.
- The proposed change is shown to the principal as a diff with its recall and false-alarm numbers, and held for a yes. Verify later reads the rule's break count in the next v4 report.

## Anti-criteria

- The prompt improves only by fixing it, never by deleting, weakening or skipping a check, and it never gets shorter by losing a check.
- A rewording earns a measured round when the suite can see it: some suite case exercises the reworded behaviour and `preflight`'s smallest worthwhile win is within reach. Otherwise the climb adds that case first; no judge vetoes the rewording before measurement.

## Safety gates

- The system prompt, the Algorithm, CLAUDE.md, the operational-rules file and the identity files are doctrine, under the doctrine hold in SKILL.md § Safety gates.
- A system-prompt edit is behavior-defining: after a kept change, run `bun LIFEOS/TOOLS/ConfigEvalOnChange.ts`.

## Tool contract

```bash
bun skills/Assay/Tools/EvalRunner.ts -s <suite> -t 5 --json
bun skills/Assay/Tools/Compare.ts -s <suite> --a '{"system_prompt_file":"v1.md"}' --b '{"system_prompt_file":"v2.md"}'
bun ${LIFEOS_SKILL_DIR}/Tools/HillClimb.ts baseline <id> --from-run <run.json> --instrument <suite.yaml> --ceiling 1
bun ${LIFEOS_SKILL_DIR}/Tools/HillClimb.ts exp <id> --from-run <run.json> --hypothesis "<train behaviours targeted → change>" --kind <knob|wording|rule|structure|delete|add|import> --origin <proposer-id> [--parent <n>] [--simpler --before <file> --after <file>] --keep|--revert
bun LIFEOS/ERRATA/Errata.ts v4 rules show <rule-id>
bun LIFEOS/ERRATA/Errata.ts v4 report
bun ${LIFEOS_SKILL_DIR}/Tools/HillClimb.ts start --type prompt|rule --target <path-or-rule-id> --metric "<metric>" --direction higher --why "<why>"
```

## Gotchas

- Suites testing plumbing set a minimal `system_prompt`. Under the live DA prompt, format rules can make a correct answer look wrong (Assay Gotchas).
