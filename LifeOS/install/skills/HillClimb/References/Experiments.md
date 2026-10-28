# Experiments inside a climb

What a well-framed experiment looks like when a climb tests candidate changes, and what each kind of result means for the climb's next move. HillClimb's Ideal State holds the climb-level rules (train-only proposers, held-out keeps, landing every win); this file describes the experiment inside them. `Tools/HillClimb.ts` enforces the parts that guard against fooling ourselves; the last table names which.

## A well-framed experiment

- **The hypotheses are plural and falsifiable.** Each one names the train behaviour it changes, the result it predicts on the instrument, and the result that would show it wrong. Rewording one idea is still one hypothesis.
- **The null is always in the set.** The null says the baseline is already as good as this instrument can show. Every change has to beat it past the noise floor on held-out cases, and a climb that finds nothing reports "no movement, and why" as its result.
- **At least one hypothesis challenges the frame.** It questions the metric, the instrument, the case mix or the target's structure, not only its knobs and wording. Frame-level changes are the `structure`, `delete` and `import` kinds in the ledger.
- **Judgment orders what is measured first, never what is kept.** As rounds accumulate, the keep rate by kind and by origin (`status`) replaces the guesses.
- **The measurement is the smallest one that tells the hypotheses apart.** Its outcomes differ under the competing hypotheses and could refute the favourite. "Smallest" describes the measurement, never the change: a change may be one word or a new stage.
- **The stop is decided before the run.** The budget is stated when the climb opens (`start --budget <n experiments>`, optionally `--budget-reads <n candidate reads>`), and the baseline fixes the instrument, the served model, the split seed, the noise floor and, through `preflight`, the smallest win worth having. None of these move after the data is seen; a baseline replaced with `--force --reason` before any experiment stays in the ledger with that reason, and once experiments exist a new baseline means a new climb. A suite too small to see that win is fixed with more cases or trials before round 1, not by loosening the bar.
- **Parallel arms are independent.** Each runs in its own scratch copy against the same frozen train set and is recorded in the one ledger, so their results compare.
- **Product experiments count too.** A live A/B on a product number (a signup rate, a retention figure) is a metric climb: `baseline --value --source "<the experiment>"` with `--noise` taken from the A/A spread or the CI half-width. Allocation and duration belong to the product.
- **A diagnosis with no instrument is not a climb.** A research question or a diagnosis without a number goes to Science (QuickDiagnosis, StructuredInvestigation), and HillClimb takes it back once there is something to measure. Ideation on a problem with no metric does stay here: Ideate runs it under `start --metric "judge composite"`.

## Reading a result honestly

- **Inconclusive is a result.** A refused keep is recorded as a revert with its note, and the evidence is never pushed into a win (the refusals are listed in SKILL.md Gotchas).
- **Reaching the target is reported apart from which changes held.** A change can hold and the climb still miss its target: cutting abandonment from 40% to 36% supports the change and misses a below-25% target. Partial improvement is never reported as reaching the target.
- **Per-case flips outrank the aggregate.** An overall score above target does not override a failed standing check or a failed criterion. A combined variant's win does not say which part caused it; credit a part only after a variant without it has been measured.
- **Findings on train are material, not wins.** A pattern seen on train or a near-miss in the archive feeds the next round's proposers. It is reported as a win only after a held-out measurement keeps it.
- **A jump that looks too good gets read.** Reading the flipped outputs means checking that each flip moved toward or away from gold for a real reason, on train-half flips, before `--spot-checked` is passed.

## The next move after a result

| What the results say | Move | In HillClimb |
|---|---|---|
| A change held on held-out cases | continue from the new incumbent | `exp --keep`, then the next ideate round reads `digest --train-only` |
| The reverts since the last keep span fewer than three kinds | widen | `plateau` answers `widen`; proposals shift to kinds not yet tried |
| Two reverts in a row, or the instrument cannot see a modest win | restate | `stall` with its category; `preflight` and more cases for grader or variance; a `structural` frame problem goes to Science StructuredInvestigation or DefineGoal |
| The target is reached, the budget is spent, or `plateau` confirms a plateau | stop | land each win as a standing check, then `close --stop target`, `--stop budget` or `--stop plateau`; `close` refuses a reason the ledger contradicts |
| Continuing would cross an ethical line, the climb failed with no path to recovery, or its resources are better spent elsewhere | abort | land what held, then `close --stop abort --reason "<why>"` |
| A change held and shipped | watch it | the standing check fails on regression; `verify` re-reads Errata later, and `worse` opens a new climb |

## What the tool enforces

The keep refusals themselves are listed once, in SKILL.md Gotchas.

| Guard | Where it lives |
|---|---|
| Criteria fixed before evidence | `baseline` refuses a second baseline without `--force`, refuses `--force` without `--reason` and once any experiment exists, and appends each replaced baseline with its reason to `baseline_history`, which `close` copies into its result; instrument and served model are recorded and a change to either refuses the keep |
| A budget stated up front and enforced | `start --budget <n>` caps the experiments recorded and `--budget-reads <n>` the candidate reads of test and screen (baseline and close reads never count); once either is spent `exp` and `screen` refuse before anything is read, and `status`, `plateau` and `exp` print the budget |
| The stop is named and true | `close` refuses without `--stop plateau\|target\|budget\|abort`: plateau needs `plateau` to answer plateaued (widen is refused), budget a set and spent budget, target at least one keep, abort a `--reason`; the result records the stop and the budget |
| No peeking at held-out data | proposers read `digest --train-only` (no test, screen or holdout field); every test, screen and holdout read is logged in `reads.jsonl` and counted in `status` |
| Many comparisons on one test set | a keep's significance is Bonferroni-corrected over the candidates read on test since the last keep (`exp` prints them as `comparisons`); `screen` cuts many candidates before any test read; a declared holdout is read once, at `close`, beside the test delta |
| Paired comparison against the incumbent | a `--from-run` keep compares per case with the incumbent run (exact McNemar on 0/1 cases, paired 95% CI otherwise) |
| Inconclusive stays inconclusive | a gain inside the noise floor is refused unless `--simpler` and `--after` has fewer lines than `--before` |
| Null and negative results stay visible | every experiment is a ledger row; a revert that gained on train is archived (`archive <id>`) |
| Diminishing returns stop the climb | `plateau` over its window, counted in generations once the climb runs a population; `widen` while the reverts span fewer than three kinds |
| Proposals come from the drawn roster | `Population.ts roster --climb` records each generation's roster; `generation` refuses an origin off it or a missing band or vendor unless `--off-roster` gives a reason; `exp --generation` takes only an origin on that roster and the measured proposal's own |
| No held-out number reaches a proposal | `generation` refuses a proposal with a key at any depth naming test, val, validation, screen, holdout, held out, ci95 or p value; measurement words alone (value, score, delta, threshold) pass |
| Kinds stay seven | `generation` refuses a kind outside the seven; the proposer's own word is kept as `kind_as_proposed` (`exp --kind-as-proposed`, refused without `--kind` or when the word is one of the seven) |
| Measure only what a whole generation proposed | `Population.ts generation` persists a generation before any of it is measured and `--validate` records proposals that fail to build; `exp --generation` is refused unless that persisted generation holds the proposal; `exp --train` without `--value` (or `--screened`) records a screen-out as `screened`, with no value and no test read; `generation --void --reason` withdraws a generation only while no experiment row and no screen or test read names it (`screen --generation` records it on the read) |

Not yet in code, read 2026-10-11: nothing refuses a single `exp` row that repeats an earlier hypothesis; `Population.ts generation` answers `collapsed` only when most of a generation rephrases earlier ones.
