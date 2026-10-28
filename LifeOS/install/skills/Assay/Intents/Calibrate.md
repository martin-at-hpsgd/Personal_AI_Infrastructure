# Calibrate Intent

Judge governance: calibrate a suite's judge against principal-labeled ground truth, mine judge↔principal disagreements into deterministic asserts (the shrinkage doctrine), and turn a judged miss into one more glance question plus a kept case.

## Ideal State

- Every suite that uses model-graded asserts has an EARNED calibration record against the judge chain that runs today: a principal-labeled set of real outputs (pass/fail per judged assertion, at least two of each) at measured agreement ≥ 85% with at least two labels per class at ≥ 50% agreement (the one definition, `LabelStore.earnedStatus`).
- Each class is checked separately, because raw agreement alone rewards a judge that always says pass on a skewed set; Cohen's kappa is reported as a diagnostic and is never part of earned.
- An image record also binds the exact local artifact bytes, resolved case and reference, and the vision/meaning-ladder pipeline; a changed image, reference, model, or prompt makes it stale.
- An earned record gives the suite the calibrated-cheap judge: with no judge keys, EvalRunner runs the judge at the level the earned record was measured at (SKILL.md § Gotchas, the judge default).
- Each disagreement is diagnosed without changing the intended standard to improve agreement: the criterion may be ambiguous, the judge may be wrong, or the label may need the principal's review. The owning ISA records the assertion, both verdicts, which side moved (criterion, judge, or label), and why in a dated `· calibration` Articulation Log block.
- A glance question that answered wrong, or a criterion that needed a question it lacked, ends as one more question plus a kept labelled case, never a longer rubric.
- The report names which labeled set was used (calibration or reserved holdout) and the provenance of its labels.
- Labels from a named rater other than the principal (for example, a collaborator's blind ratings) carry that rater's name in `label_source.labeler` and are reported as that rater's agreement. The record stays proxy: those labels never read as the principal's, never merge with assistant labels, and never make a record earned.

## Anti-criteria

- Delegated or assistant labels attributed to the principal, or assistant agreement described as independent human validation.
- A criterion, rubric or label changed to raise agreement rather than to preserve the intended standard; a label changed without the principal's review.
- Calibration files (real outputs, the principal's judgments) in the public skill tree.
- A reserved set that was inspected while tuning reported as a fresh holdout (it is regression evidence now; validating the revision independently needs freshly reserved examples).
- A threshold typed on the command line or written into a question file.

## Inputs

The calibration set:

- 10–20 real outputs for the suite's judged assertions, pulled from `MEMORY/STATE/Evals-Results/<suite>/*/run.json` transcripts (real beats synthetic; supplement with 2–3 deliberately bad outputs so the set has both labels).
- The principal's labels when supplied. If the principal delegates initial labeling, the assistant may supply a working baseline with an explicit labeler, delegation provenance, reason and review status on each entry. Keep an unmeasured working baseline in `Calibration/WorkingBaseline/`; selecting it for a calibration run uses `LIFEOS_CALIBRATION_DIR` and does not activate it for production suites.
- The set file `LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Assay/Calibration/<suite>.yaml`, shaped `{ isa: <path of the ISA that owns the criterion>, claim: <ISC-id>, entries: [...] }`. Text entries are `{output, assert, label: pass|fail, note?, moved?, why?}`. Image entries are `{image: {case_id, artifact, reference}, assert, label: pass|fail, note?, moved?, why?}`: `case_id`, local `artifact`, assertion, and effective reference must match a resolved image-suite case. The runner reads the artifact itself through ImageEvalRunner; cached blind descriptions and text substitutes cannot certify the image pipeline. `note` explains WHY and seeds the mining; `moved: claim|judge|label` and `why` are filled in after each disagreement is mined. `claim` is the legacy key name the code reads (`LIFEOS/TOOLS/lib/LabelStore.ts`); in both places it means the criterion. (A bare entries list still parses; it just cannot route its log block to an ISA.)
- On the maintainer install, a `manual` row that has collected labels through `bunker attest` already has its set: `Calibration/seeds/<isa-hash>/<isc-id>.yaml` (`Calibrate.ts --residue` lists the judge-ready ones). Copy it to `<suite>.yaml`, write the judged assert the labels describe, and calibrate that.
- Reserved labeled outputs, set aside before tuning the rubric, in a separate calibration directory under the same suite filename; `LIFEOS_CALIBRATION_DIR=<held-out-directory>` selects those labels while `-s <suite>` continues to resolve the actual suite. The tool does not enforce a train/holdout split; report which set was used and preserve that separation. Human review remains available even after the judge earns calibration.
> The Bunker CLI is maintainer-private and not in the public release; run code rows with `bun test ./<path>` and suite rows with `bun skills/Assay/Tools/EvalRunner.ts`.

Labels assess one named assertion, not the whole skill. Source-dependent assertions carry the actual source in `reference:` so the executing judge can assess grounding. Synthetic anchors establish clear starting boundaries; they do not replace representative real outputs or held-out evaluation. Repeated labels on the same artifact are not additional examples. Before activating delegated labels, inspect measured disagreements and report the label provenance alongside the result; principal review remains distinct from delegated labeling.

The shared validator rejects repeated output content for the same criterion and identical image bytes under different filenames. The same output may be assessed against different criteria; those labels still represent one output, not independent tasks. A promise such as “I did not invent details” is not grounding evidence: labels must check the actual statements against their source, and visual labels must check the relationship encoded by arrows or axes against the stated claim.

## Tool contract

```bash
bun ${LIFEOS_SKILL_DIR}/Tools/Calibrate.ts -s <suite> [--level low] [--json] [--append-log]   # run calibration; write result.json + <suite>.log.md; --append-log appends the block to the set's isa:
bun ${LIFEOS_SKILL_DIR}/Tools/Calibrate.ts --recheck [--page]                                  # re-run every STALE record over stored labels (ModelSync daily runs this; --page texts only on a drop below floor)
bun ${LIFEOS_SKILL_DIR}/Tools/Calibrate.ts --residue                                           # judged-residue shrinkage report + unlineaged judged asserts (no derived_from) + judge-ready attested seeds
bun ${LIFEOS_DIR}/TOOLS/EvalCensus.ts --calibration-coverage [--json]                        # every judged suite: earned or provisional (and why); a Socrates standing question reads this
```

### The miss loop (glance questions)

> Maintainer-only: the miss, label and attest commands below are in the maintainer install, not the public release. On a public install, calibrate through a suite with a judged assert (the suite flow above) and supply your own seed file for the set.

A glance question calibrates through labels on the exact state it judged, not through a suite. When a question answers wrong, or a criterion needed a question it did not have, the fix is one more question plus a kept case, recorded in one command:

```bash
bunker miss <isa> <isc> --kind noul|choice|score --id <id> --question <text> [--options a,b,c | --criteria low,mid,high] --state <file> pass|fail --note <why>
bunker label <isa> <isc> --question <id> --state <file> pass|fail --note <why> [--by <who>] [--offline]
bunker attest <isa> <isc> pass|fail [--note <why>]
```

`miss` adds the question to the criterion's question file (creating the file), registers it in shadow through the registry, and keeps the state as a labelled case keyed by its sha256. A noul takes neither list; a choice takes `--options`, its unordered set; a score takes `--criteria`, its ladder from low to high. `label` adds a labelled case to a question that already exists. `attest` labels a `manual` row, and those labels seed the question or judged assert that replaces it (§ Inputs, the seeds bullet). None of the three edits the ISA markdown, and no threshold is ever typed on the command line or in a question file: it lives in the registry.

A question leaves shadow only on the principal's call. `Assay.ts promote-noul --caller <name> --question <id> --seed <json>` refuses a noul without a registered label floor, a correctly answered negative, and balanced accuracy at the caller's enforce bar. `Assay.ts report --caller <name>` shows agreement against the labels first.

### Pairwise calibration

Delegated preference labels use the same per-entry `label_source` contract as rubric labels. Pairwise records and tournament output report `label_basis` and `human_validated` separately; agreement with assistant labels is not independent human validation. Provenance changes invalidate the record along with label or candidate changes.

`PairwiseCalibrate.ts --calibration <set.yaml> --json` accepts `{mode: text|image, question, examples: [{a, b, label: A|B|tie, note?}]}`. The question is the exact tournament criterion; candidates follow Tournament's file-or-text semantics. Use absolute file paths for portable local evidence. Principal labels cover at least two distinct examples of each outcome; reversed duplicates are not additional examples. Both orders run through the existing pairwise judge. Agreement of at least 85% and multiclass kappa of at least 0.4 are required. `--judge <registry name>` calibrates one named text judge (`JudgeCall.namedJudge`, no judgment-layer first pass), so judges can be compared on the same labels; `--concurrency <n>` judges that many examples at once and keeps verdicts in set order.

The record is stored beside the set as `<set.yaml>.pairwise.result.json`. `Tournament.ts --calibration <set.yaml>` checks its criterion, modality, labels, candidate bytes, implementation and configuration before reporting calibration. The candidate corpus must remain unchanged; the calibrated criterion may compare new tournament candidates. Provider-reported model IDs remain separate from configured IDs. Stable selection still does not establish absolute quality. Pairwise rechecks are explicit through this command; the rubric `Calibrate.ts --recheck` does not renew these records.

## Gotchas

- A disagreement in the REVIEW DISAGREEMENTS list that can be expressed deterministically becomes a candidate assert. Leave unresolved disagreements undecided (no `moved` value), re-run with `--append-log` for the owning ISA, and validate revisions on the reserved labeled outputs.

- A suite reads the Calibrate skill's taste profile when a Calibrate target with its name (or its `calibration:` field) has a `Taste.json`: `EvalRunner` appends the profile to every string-valued judged assert. The rubric text changes, so this suite's record goes stale until re-measured. `calibration: none` opts out.

- Image rubric provider changes follow [Vision judge providers](../References/VisionJudgeProviders.md); a public capability probe proves image support, while authorized private calibration measures grading quality.

- Passing visual anchors are cumulative: clarity never excuses contradictory arrows, axes or captions. Separate communication defects from aesthetic preferences so a plain, correct chart does not fail an unrelated novelty test.

- Agreement is measured at the level you pass (`--level low` is the starting point); calibrating at 'high' then running at 'low' proves nothing.
- Runtime uses the earned record's measured level. A failed low-tier measurement can justify comparing the next supported tier on unchanged labels; retain the losing measurement and validate the chosen tier separately.
- Only the interactive run appends to an ISA (`--append-log`). `--recheck` (ModelSync's daily leg) writes `<suite>.log.md` beside the record and never touches an ISA — an unattended job must not rewind a closed ISA's phase.
- Image calibration executes `vision-rubric` and `meaning-ladder` through their real paths, including deterministic prerequisites. Failed prerequisites cannot supply a negative judge label. Explicit `judge_model` overrides remain unsupported by the level-based rubric calibration runner.
