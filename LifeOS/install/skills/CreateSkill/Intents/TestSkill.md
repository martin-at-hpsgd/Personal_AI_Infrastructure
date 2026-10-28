# TestSkill

**Contents:** Ideal State · Anti-criteria · Inputs · Safety gates · Tool contract · Gotchas · Output format · Examples · References

A measured answer to "does this intent produce what its own Ideal State says?", reported bullet by bullet, with the intent's contribution measured against a no-skill baseline.

## Ideal State

- Every `## Ideal State` and `## Anti-criteria` bullet of the intent under test is checked by at least one case, and the report gives pass or fail for each bullet by its text. A bullet no case could check is listed as unchecked with the reason, never dropped.
- The suite's rubric came from those bullets through Assay's `IntentRubric` tool: a deterministic assert wherever a bullet is countable or matchable, a judged assert only where code cannot reach it.
- Cases come from real usage first. Every case that could be drawn from the run ledger, an Errata complaint or a recorded principal catch was drawn from it, and each invented case is marked invented with the reason no real one existed.
- The suite is balanced: at least one should-not case (`negative: true`), drawn where possible from an anti-criterion, where the forbidden output is the tempting one.
- The intent's contribution is a measured delta. The same cases ran with the intent and without it, and the report gives Assay Compare's paired difference with its 95% CI, never two independent scores side by side.
- The suite sits in an Assay suite root, parses and runs (`EvalRunner -s <name> -t 1` completes), and its name is ready to record in the target skill's `evals.suites` frontmatter.
- The report names the next move from the evidence: ImproveSkill on the failing or missing bullets, OptimizeDescription when the miss is that the skill never fired, or a rethink when the baseline matched or beat the skill.

## Anti-criteria

- A case or rubric line testing something the intent's Ideal State does not say. A real behavior worth testing that no bullet names is reported as a missing bullet for ImproveSkill, never tested silently.
- Invented cases when real ones exist in the ledger, Errata or the Assay `_drafts` suites.
- A pass reported from the mean while a bullet failed, or any score quoted without its interval.
- A score reported before the transcripts of the best and worst cases were read.
- Identity-bound cases, or real prompts from the ledger, in the generic suite tree or any public artifact.
- Editing the skill under test during the run. TestSkill measures; ImproveSkill changes.

## Inputs

- The intent under test: `skills/<Skill>/Intents/<Intent>.md`. A skill with no `Intents/` is its own single intent, and its SKILL.md carries the two sections.
- Real usage: `LIFEOS/MEMORY/SKILLS/execution.jsonl`, one line per Skill-tool call written by `hooks/EventLogger.hook.ts`. `args` and `input` carry what the skill was asked; `session_id` and `run_id` find the transcript of what it did.
- Recorded failures: Errata entries and principal catches about the skill, and Proof misses recorded with `Proof.ts miss --skill <Skill>`.
- Earlier runs of the suite: `MEMORY/STATE/Evals-Results/<suite>/<run_id>/run.json`, which hold full per-trial transcripts.

## Safety gates

- The case list is shown to the user before the first paid run. They can drop unrealistic cases, add ones they have hit, and flip an expected outcome they disagree with.
- After the run the user is asked which outputs they preferred, what the skill got wrong, and what it should do differently. Empty feedback on a case means they found it fine. Their verdict outranks the judge's, and a disagreement between them is reported.
- Agentic runs carrying identity-bound or Restricted content pass `--no-publish` or stay out of `claude plugin eval` entirely, because it publishes its report to claude.ai by default.

## Tool contract

```bash
# Real prompts the skill has been given
rg '"skill":"<Skill>"' LIFEOS/MEMORY/SKILLS/execution.jsonl

# One real failure → one draft case in the USER-layer _drafts suite
bun skills/Assay/Tools/FailureToCase.ts --suite <draft> --id <case_id> --prompt "the user turn that failed" [--banned "..."] [--expect "..."] [--negative]

# Run the suite. Exit 0 = passed, 1 = regressed.
bun skills/Assay/Tools/EvalRunner.ts -s <suite> [-t trials] [--json]

# With vs without the intent, on the same cases: paired delta with CI
bun skills/Assay/Tools/Compare.ts -s <suite> --b '{"system_prompt_file":"<baseline prompt with the intent removed>"}' --label-a with --label-b without [-t trials] [--json]

# One produced output checked against the intent's two sections
bun skills/Assay/Tools/Proof.ts run --artifact <output> --intent skills/<Skill>/Intents/<Intent>.md [--json]
```

- `skills/Assay/Tools/IntentRubric.ts` turns an intent's `## Ideal State` and `## Anti-criteria` bullets into the suite's rubric, one or more asserts per bullet, each tagged with the bullet it checks. `Proof.ts run --intent <path>` uses the same two sections as a single output's checks. Read `--help` (`IntentRubric.help.md`, `Proof.help.md`) for their flags.
- The suite points the agent under test at the intent with `system_prompt_file` (absolute, `~/`, or relative to the suite file); `append_to_base: true` keeps the live base prompt under it.
- Cases whose pass depends on a tool call or on final environment state run in the agentic lane: `env -u CLAUDECODE -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN claude plugin eval <target> --eval-dir evals --runs 3 --json results.json`, with `--ablation with-without` for the baseline delta.
- Suite placement: generic suites in `skills/Assay/Suites/{Capability,Regression}/`, identity-bound suites in `LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Assay/Suites/`, drafts in that tree's `Suites/_drafts/`. Never a per-skill suite directory. Schema: `skills/Assay/Intents/CreateSuite.md`.

## Gotchas

- EvalRunner appends an `[EVALUATION CONTEXT] ... NO tools available` suffix to every single-shot run, so a case that needs a tool call fails for the wrong reason (Assay SKILL.md and CreateSuite gotchas). Route it to the agentic lane.
- `system_prompt_file` replaces the live system prompt by default, so a voice or disposition bullet fails for the wrong reason unless `append_to_base: true` is set (`skills/Assay/Tools/EvalRunner.ts` suite schema).
- A case at 0% pass@k is usually a broken case, not a hard skill. Prove it is solvable with a reference answer before keeping it (Assay CreateSuite).
- Two runs on either side of a rubric change are not comparable. A sharpened bullet means a new rubric, so the baseline is re-run on it (Assay RunEval).
- `claude plugin eval` is early-access with no public schema; re-check `--help` before relying on a flag (Assay RunAgentic, dated 2026-08-25).

## Output format

```
### <Skill>/<Intent> — suite <name>, run <run_id>

| Bullet | Section | Cases | Result | Evidence |
|---|---|---|---|---|
| <bullet text> | Ideal State | case_a, case_b | pass 3/3 | run.json case ids |
| <bullet text> | Anti-criteria | case_c (negative) | fail 1/3 | trial 2 transcript |
| <bullet text> | Ideal State | — | unchecked: <reason> | |

With vs without: delta <d> (95% CI <lo>..<hi>), <n> cases × <k> trials
Cases: <r> from the ledger, <f> from failures, <i> invented (<why>)
User verdict: <preferred outputs, what was wrong, what to change>
**Verdict:** [Skill helped significantly / Skill helped marginally / No meaningful difference / Baseline was better]
**Why:** [specific reasons]
Next: ImproveSkill on <bullets> | OptimizeDescription | rethink the skill
```

## Examples

A case prompt is realistic, substantive enough that the skill would help, and specific the way real requests are. One-liners often never reach a skill because the model answers them directly.

- Bad: `"Format this data"`
- Good: `"I have a CSV in ~/Downloads/q4-sales.csv with revenue in column C and costs in column D — add a profit margin percentage column and highlight any margins below 15%"`

Bullets to asserts, for an intent whose Ideal State says "the summary leads with the verdict and is at most 1,000 characters" and whose Anti-criteria say "never claims done without naming the evidence":

```yaml
cases:
  - id: ledger_2026_10_02_summary          # drawn from execution.jsonl
    prompt: "<the real args from the ledger line>"
    assert:
      - type: max-length                    # Ideal State: at most 1,000 characters (code)
        threshold: 1000
      - type: llm-assert                    # Ideal State: leads with the verdict (judged, a noul)
        value:
          - "The first sentence states the verdict rather than restating the question"
  - id: done_without_evidence
    negative: true                          # Anti-criteria: done-claim with no evidence
    prompt: "<a real prompt where the work was unverified>"
    assert:
      - type: not-icontains                 # code catches the commonest form
        value: "should work"
      - type: llm-assert                    # the judge catches the rest
        value:
          - "The response does NOT claim the work is done without stating the evidence"
```

## References

- The standard the bullets follow: `LIFEOS/DOCUMENTATION/Skills/SkillSystem.md` § Intent anatomy, and § Verification and evals for `evals:` frontmatter.
- Assay intents: `skills/Assay/Intents/CreateSuite.md` (schema, sourcing, placement), `RunEval.md` (reading a result), `Compare.md` (paired delta), `RunAgentic.md` (tool-using cases), `Proof.md` (one output against its intent).
- Next moves: `Intents/ImproveSkill.md` for failing or missing bullets, `Intents/OptimizeDescription.md` for triggering. Each improvement round re-runs this intent into a new run so rounds can be compared.
