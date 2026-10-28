# ImproveSkill

**Contents:** Ideal State · Anti-criteria · Inputs · Safety gates · Tool contract · Gotchas · Examples · References

A skill changed so its intent meets its Ideal State, starting from the bullet that was missed and proven by a before-and-after measurement on the same cases.

## Ideal State

- Every change traces to a named `## Ideal State` or `## Anti-criteria` bullet: one that failed in TestSkill, in a Proof receipt or in a principal catch, or one that was missing and is now written. The report maps each edit to its bullet.
- A miss sharpened the bullet before the skill changed. The sharpened bullet says what the miss showed, specifically enough that the same output would now fail it, and the suite's rubric was rebuilt from it. A behavior the principal wanted that no bullet named became a new bullet first.
- The improvement is measured. The same suite, on the same rubric, ran before and after the change, and the report gives both results with Assay Compare's paired delta. A change that did not move its bullet was reverted or reported as not helping, never kept on faith.
- When it takes more than one attempt, the work ran as a HillClimb climb: a baseline, keep-or-revert experiments recorded in its ledger, and a plateau call before stopping.
- The fix generalizes. It addresses the pattern behind the failing case, and held-out cases that were not used to make the change still pass.
- The failure that prompted the change is recorded as a dated gotcha with its provenance, in the `## Gotchas` of the intent it belongs to, or in SKILL.md's `## Gotchas` when it spans intents.
- Work every test agent reinvented on its own, such as the same helper script or the same multi-step lookup, is bundled once as a deterministic tool in the skill's `Tools/`.
- Every edited intent and SKILL.md is written to the intent standard, `bun LIFEOS/TOOLS/IntentLint.ts skills/<Skill>` reports zero errors, and the skill's existing tests pass as they did before.

## Anti-criteria

- Softening a bullet toward what the skill already does, or deleting a bullet because it failed. A bullet moves toward what the principal wants, never toward the output.
- Overfitting: a narrow rule that makes the test cases pass and breaks on novel inputs.
- Louder instructions. More MUST, ALWAYS and NEVER in place of a reason rarely fixes anything.
- Choreography. Numbered thinking steps added to fix a miss are scaffolding a smarter model makes unnecessary. A miss is fixed with a sharper outcome, a gotcha with provenance, a tool contract, an output format, or a bundled tool.
- Bloat: steps the agent skips or rushes, instructions that change nothing whether followed or ignored, defensive lines for edge cases that never occur, and statements of what the model already does.
- Reorganizing files in place of fixing weak content.
- Removing a safety gate, tool contract, output-format contract or verified gotcha while trimming.
- Comparing an old score on the old rubric with a new score on the new rubric and calling the difference an improvement.

## Inputs

- The TestSkill report for the intent: per-bullet results, the user's verdict, and the run's transcripts at `MEMORY/STATE/Evals-Results/<suite>/<run_id>/run.json`.
- Principal feedback in the conversation, Errata entries about the skill, Proof receipts, and standing checks added with `Proof.ts miss --skill <Skill>`.
- Transcripts of real runs, found from `LIFEOS/MEMORY/SKILLS/execution.jsonl` by `session_id` and `run_id`. They show where the agent wasted time or went wrong.
- The target skill's SKILL.md and the intent files the feedback touches.

## Safety gates

- A structural change, meaning adding, removing or renaming an intent, tool or reference, or editing frontmatter, goes through `Intents/UpdateSkill.md`. A description change goes through `Intents/OptimizeDescription.md` and its user review, never a hand edit here.
- A Gotchas entry needs provenance: a dated incident, a failing test or a reproduction. Without one it is methodology and does not go in.

## Tool contract

```bash
# Standard and hygiene, after every edit
bun LIFEOS/TOOLS/IntentLint.ts skills/<Skill>            # zero errors required
bun LIFEOS/TOOLS/SkillHygieneGate.ts --skill <Skill>     # no new violations
bun test ./skills/<Skill>                                # same pass set as before; keep the ./ prefix

# Before and after on the same rubric: the old intent text is the A arm
git show HEAD:skills/<Skill>/Intents/<Intent>.md > <scratch>/before.md
bun skills/Assay/Tools/Compare.ts -s <suite> --a '{"system_prompt_file":"<scratch>/before.md"}' --b '{"system_prompt_file":"<abs path to edited intent>"}' --label-a before --label-b after [-t trials] [--json]

# A climb that needs several experiments
bun skills/HillClimb/Tools/HillClimb.ts start --type intent --target skills/<Skill>/Intents/<Intent>.md --metric pass_to_k --direction higher --why "<the bullet that failed>" --skill <Skill>
bun skills/HillClimb/Tools/HillClimb.ts baseline <id> --from-run <run.json> --field pass_to_k
bun skills/HillClimb/Tools/HillClimb.ts exp <id> --hypothesis "<what this change should fix>" --from-run <run.json> (--keep|--revert)
bun skills/HillClimb/Tools/HillClimb.ts plateau <id>
bun skills/HillClimb/Tools/HillClimb.ts close <id>
```

- The suite's rubric is rebuilt from the sharpened bullets with Assay's `skills/Assay/Tools/IntentRubric.ts` (read its `--help` for flags).
- After the change, re-run `Intents/TestSkill.md` into a new run so rounds can be compared, and run `Intents/OptimizeDescription.md` if the description changed.

## Gotchas

- `bun test <bare relative path>` (Bun 1.3.6) silently drops every child process's stdout and stderr, so spawn-based tests fail with empty output. Always prefix `./`.
- Two runs on either side of a rubric change are not comparable (Assay RunEval). Sharpening a bullet changes the rubric, so the "before" arm runs the old intent against the new rubric.
- HillClimb keeps only gains above the noise floor on an unchanged instrument and exits 1 when it refuses (`HillClimb.ts --help`, v1.1.0). That refusal is the measurement working, not a tool error.

## Examples

Typical misses and where the fix lands:

| Miss | Usual cause | Fix |
|---|---|---|
| "Output was wrong" | the bullet was vague or missing | sharpen or add the bullet, then meet it |
| "Took too long" | steps that do not change the output | cut them |
| "Missed edge case" | no bullet or gotcha covers it | add the bullet, or a dated gotcha |
| "Too rigid" | over-specified how | replace the procedure with the outcome and its reason |
| "Agents all wrote the same helper script" | missing bundled tool | add the script to `Tools/` |
| "Didn't trigger" | description too narrow | OptimizeDescription |

Sharpening a bullet. The principal rejected a 900-word summary. The bullet "The summary is concise" passed it, so the bullet was the defect. Sharpened: "The summary leads with the verdict and is at most 1,000 characters." Now code checks the length and one judged question checks the lead, and the intent changes until both pass.

Explain the why instead of shouting. Bad:

```
ALWAYS use exactly 3 bullet points. NEVER exceed 50 words per bullet.
MUST include a header. MUST NOT use passive voice.
```

Good:

```
Use bullet points to make key findings scannable — readers are busy executives
who need to absorb the main message in under 30 seconds. Keep bullets concise
(aim for one clear idea each) and lead with the most important finding.
```

The bad version produces compliant, lifeless output. The good one serves the reader and adapts to different content.

Generalize instead of overfitting:

- Bad: `"When the input contains a CSV with columns named 'Revenue' and 'Cost', always calculate margin as (Revenue-Cost)/Revenue"`
- Good: `"When performing financial calculations, identify the relevant columns by semantic meaning (revenue, cost, margin) rather than exact names, since naming conventions vary"`

## References

- The standard and its keep-classes: `LIFEOS/DOCUMENTATION/Skills/SkillSystem.md` § Intent anatomy, `skills/Prompting/Standards.md`, `LIFEOS/RULES/Philosophy.md` § Ideal-State Prompting. The test for any line: would a smarter model make it unnecessary?
- Auditing a whole instruction set for over-prompting: the BitterLessonEngineering skill.
- The climb loop: `LIFEOS/DOCUMENTATION/LifeOs/HillClimbing.md`, `skills/HillClimb/Tools/HillClimb.ts --help`.
- Measuring: `Intents/TestSkill.md`; Assay `skills/Assay/Intents/Compare.md` and `RunEval.md`.
