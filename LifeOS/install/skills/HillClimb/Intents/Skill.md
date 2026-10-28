# Skill

Climb one skill until its outputs stop drawing the complaints and misses that started the climb.

## Ideal State

- The skill's ideal state is named: its ISA if it has one, else its "done looks like" block, its standing checks (`Proof.ts` profile entries with `skill:<Name>`), and the asks it serves.
- A baseline exists from one or more of these: the skill's suite pass^k (`EvalRunner.ts`), its Errata complaint rate (`Errata.ts skills`), and its receipt verdicts. The climb records which one is the primary metric.
- The baseline came from a raw run file with a seeded train/test split, and `preflight` said the suite can see a win worth having. If it could not, the climb added cases or trials before round 1.
- A skill with no suite had one before the first experiment, built from its real misses through the Assay CreateSuite intent.
- The misses are real: Errata complaints joined to its outputs, false passes, failing suite cases, and transcripts where it went wrong. Each becomes a case through `FailureToCase.ts`.
- Candidate changes come from the varied proposers SKILL.md § Ideal State describes (`Intents/Ideate.md` produces them), fed only what that section allows.
- What was learned lands as a dated Gotcha, a new standing check, or a deterministic tool, never as a longer prompt (SKILL.md § Ideal State).
- The kept diff is committed, and Verify later reports whether the skill's complaint rate moved.

## Anti-criteria

- The skill improves only by fixing it, never by deleting, weakening or skipping a check, and a kept change never lowers the standing-check count (`--checks`).
- No content change goes in while a `stall` categorization the climb owes is unrecorded (timing in SKILL.md § Ideal State).

## Safety gates

- Structural edits (frontmatter, adding or removing intents or tools) go through `Skill("CreateSkill")`. Body edits to an intent or the Gotchas section are direct.
- After the climb, `SkillHygieneGate.ts --skill <Skill>` still exits 0.
- A skill used by other skills is an API. Run its consumers' tests before keeping a change to its output shape.

## Tool contract

```bash
bun ${LIFEOS_SKILL_DIR}/Tools/HillClimb.ts start --type skill --target <Skill> --metric "<suite> pass^k" --direction higher --why "<the pain, in the principal's words where possible>" [--budget <n experiments>]
bun skills/Assay/Tools/EvalRunner.ts -s <suite> -t 5 --json          # every round runs the whole suite; the run file lands under MEMORY/STATE/Evals-Results/<suite>/<run>/run.json
bun ${LIFEOS_SKILL_DIR}/Tools/HillClimb.ts baseline <id> --from-run <run.json> --instrument <suite.yaml> --instrument LIFEOS/TOOLS/lib/JudgePrompts.ts --ceiling 1 --min-win 0.1
bun ${LIFEOS_SKILL_DIR}/Tools/HillClimb.ts preflight <id>
bun skills/Assay/Tools/Compare.ts -s <suite> --a '<before>' --b '<after>'   # paired CI; the stricter keep test on judged suites
bun skills/Assay/Tools/FailureToCase.ts --suite <suite> --id <case> --prompt "<the ask>" --expect "<what good does>"
bun LIFEOS/ERRATA/Errata.ts skills --since <date> --json             # complaint rate
bun ${LIFEOS_SKILL_DIR}/Tools/HillClimb.ts digest <id> --train-only                         # the climb's history, safe to hand a proposer
bun ${LIFEOS_SKILL_DIR}/Tools/HillClimb.ts exp <id> --hypothesis "<train behaviours targeted → change>" --kind <knob|wording|rule|structure|delete|add|import> --origin <proposer-id> [--parent <n>] [--simpler --before <file> --after <file>] --from-run <run.json> --keep|--revert --tag required|tune --checks <n> --ref <sha>
bun ${LIFEOS_SKILL_DIR}/Tools/HillClimb.ts stall <id> --artifact <n> --grader <n> --harness <n> --structural <n> --variance <n>
bun ${LIFEOS_SKILL_DIR}/Tools/HillClimb.ts plateau <id>
bun ${LIFEOS_SKILL_DIR}/Tools/HillClimb.ts close <id> --stop plateau|target|budget|abort [--reason "<text>"]   # refused without a stop the ledger supports
```
