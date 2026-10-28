# Ideate

**Contents:** Ideal State · Anti-criteria · Inputs · Tool contract · Gotchas · Output format · References

The candidate changes a climb measures next: generations of proposals from a code-drawn population of proposers that differ in background, creativity band and vendor, built from train material, near-misses and far domains, recombined and mutated with lineage, so the climb's own measurement decides which survive.

## Ideal State

- Each generation's proposers differ in background, creativity band and vendor: careful (contemplate), loose (daydream) and far-reaching (dream), every band present and the bands crossed with more than one trusted vendor, so no band's keep rate is one vendor's. The roster, each slot's far domains and starting operator, and which train misses a dream slot sees were drawn by `Population.ts roster --climb` and recorded with its seed, the inputs it drew from and the generation it is for.
- Each generation's proposals came from that generation's roster: every origin is a slot's `persona/band/vendor`, and the proposers cover every band and vendor the roster has. `Population.ts generation` refuses a generation with no recorded roster, an origin off it, or a missing band or vendor, unless `--off-roster "<reason>"` records why; `HillClimb.ts exp --generation` then takes only an origin on that roster, and only the measured proposal's own.
- Each generation's raw material spans at least three domains, at least one far from the target's home field, and a mechanism borrowed from a far domain says where the analogy breaks.
- Proposers worked from train material only: train-miss transcripts, `digest <id> --train-only`, `archive <id>` and their far domains (SKILL.md § Ideal State, the train-only bullet).
- When the install's USER `PREFERENCES.md` (SKILL.md § Data & Config) says the DA ideates first, then before any roster runs the DA has read the train misses itself and persisted its own generation (`generation --off-roster` naming it as the DA's), so ideas start from someone who read the cases, never only from a population brief (principal, 2026-10-12). With no such preference, the roster's first generation stands as the first.
- Before a generation runs, train can see what the keep split rewards: per decision, the incumbent's train and keep-split baselines put the gap in the same place, and the train cases look like the keep split's (same kinds of repo, every outcome class with enough cases that one flip is inside the noise). When they do not, the next move is more train cases shaped like the keep split, not another generation. In a 2026-10-12 climb, train was mostly the cases the rules were fitted to, scoring high on one class while the keep split sat far lower on it, and dozens of experiments barely moved train whatever they did on the keep split.
- Before any proposer ran, the target supplied what turns a proposal into a candidate: the edit grammar a proposal is written in, worked examples of proposals in that grammar that its validator accepts, an apply step that builds the candidate from a proposal, and the validator that says whether it built. Every proposer saw the worked examples, every proposal, a dream slot's included, comes back as a change in that grammar however far it reaches, and a proposal that fails to build is recorded as failed (`generation --validate`), never counted as a candidate.
- No proposer's work disappears without a record. `Population.ts generation` repairs nothing: it refuses the whole file, exits 2 and persists nothing when the file is not a JSON array or any proposal lacks a hypothesis or an origin, carries a kind outside the seven, or holds a held-out key. So a proposer's reply that is not well-formed is mapped into the proposal shape or re-requested from that slot before `generation` runs, and a reply that can be neither is reported with its slot.
- A generation spans kinds of change (knob, wording, rule, structure, delete, add, import), includes structural proposals and ones that break a stated constraint of the current design, and every proposal's size is its own: one word or a new stage. A proposer's own word for a kind outside the seven is kept as `kind_as_proposed` beside the nearest of the seven; the list stays seven, and `generation` refuses an unmapped kind.
- A generation that turns out to be broken before anything was read from it (its validator or apply step was wrong) is withdrawn with `generation <id> --void <g> --reason "<text>"`, which keeps the file renamed with its reason and frees the number. Once any experiment row or screen or test read names that generation, `--void` is refused and the generation stays in the record.
- Generations after the first recombine and mutate what came before: pairs from `Population.ts pairs` across the archive's near-misses and earlier keeps, with a cross-origin share, operators drawn in code, and a wildcard slot with a domain the climb has not drawn before. Each measured proposal's `exp` row carries `--kind`, `--origin` (the slot's persona, band and vendor) and a `--parent` for every experiment it draws on.
- The climb's measured score is the fitness. When proposals outnumber the measurement budget, a screen orders them (the screen split through `HillClimb.ts screen`, or judges on two vendors) and `Population.ts allot` decides what is measured, with a random share for proposals the screen ranked low. A proposal that fails the train gate is recorded as screened out (`exp --train <n>` with no `--value`), never given an invented held-out number. Judge scores are the fitness only when the target has no measurement at all: then feasibility, novelty, impact and elegance (0-100) are scored by judges on two vendors, their spread is reported as information, and each generation retires at least half its candidates.
- Every top candidate the report names has survived an adversarial attack on its feasibility (`Skill("RedTeam")`, or an attacker on the vendor that did not propose it), and its strongest objection is in the report. In a measured climb the attack informs the report and what gets measured, never the keep.
- Every generation was persisted with `Population.ts generation <id>` in the climb directory before any of it was screened or measured. A `collapsed` verdict (most proposals rephrase earlier ones) ends ideation; a `narrow` verdict (fewer than three kinds) widens the next roster. The climb itself stops on a plateau `HillClimb.ts plateau` confirms (it counts generations, not reverts, once the climb runs a population), a reached target, a spent `start --budget`, or an abort, and `close --stop plateau|target|budget|abort` records which; `close` refuses a reason the ledger contradicts, so ideation that ended on `collapsed` closes as a confirmed plateau or as `--stop abort --reason "collapsed: …"`.
- A population larger than one agent can finish runs as a Workflow, one lane per roster slot fanned in to `generation`, then screen, `allot` and `exp`. In a 2026-10-11 replay, a multi-proposer, multi-generation population did not fit one time-boxed agent.
- The report follows the Output format, and what the generations taught comes from `HillClimb.ts status <id>` keep rates by kind and by origin.

## Anti-criteria

- A proposer's context holds a test, screen or holdout case, its score, or a scorer that prints one (a 2026-10-11 climb: proposer sweeps picked weights against test; SKILL.md Gotchas).
- A judge's opinion keeps or kills a proposal the climb could measure. Judges order what gets measured and never decide the whole budget.
- A model is asked to pick at random (which proposers, domains, pairs, operators, cases or proposals). A model asked to pick randomly picks the typical choice, and a comparator shuffle such as `sort(() => Math.random() - 0.5)` is biased; every draw comes from `Population.ts`, whose Fisher–Yates uniformity is tested.
- A proposer is told how large its change may be or how many changes it may make.
- Any part of a generation is screened, allotted or measured before the whole generation exists and is persisted.
- A proposal the target's validator rejected is measured, or dropped from the record.
- Ideate produces a new causal explanation of a phenomenon (Novelty) or a one-pass brainstorm (BeCreative).

## Inputs

- An open climb with a baseline (`HillClimb.ts start` and `baseline`). Ideation on a problem with no metric still opens a climb (`start --metric "judge composite"`), so its generations, draws and lineage live in the same ledger; a diagnosis or research question with no instrument goes to Science instead.
- A budget stated when the climb opens: `start --budget <n experiments>` and, optionally, `--budget-reads <n candidate reads of test and screen>`; the tool counts these, so a budget given in minutes or generations is turned into an experiment count at `start`. With none, a measured climb runs to `plateau`, and a run with no measurement takes 2-4 generations.
- Optional: a roster size and preset (`explore`, `dream`, `directed`, `surgical`; every preset still draws all three bands), a measurement budget, or a supplied seed pool.

## Tool contract

```bash
bun ${LIFEOS_SKILL_DIR}/Tools/HillClimb.ts start --type <type> --target <what> --metric <name> --direction higher|lower --why "<text>" --budget <n experiments> [--budget-reads <n>]
bun ${LIFEOS_SKILL_DIR}/Tools/Population.ts roster --climb <id> --n 6 [--preset explore|dream|directed|surgical] [--cases @train-misses.json] [--vendors openai,anthropic] [--single-vendor "<reason>"]   # slots with origin persona/band/vendor, seed, generation, far domains, operators
bun ${LIFEOS_SKILL_DIR}/Tools/HillClimb.ts digest <id> --train-only        # proposer-safe history
bun ${LIFEOS_SKILL_DIR}/Tools/HillClimb.ts archive <id>                    # near-misses with their variants, for recombination
bun ${LIFEOS_SKILL_DIR}/Tools/Population.ts pairs --from @archive-rows.json --k 4 [--cross-origin 0.2]
bun ${LIFEOS_SKILL_DIR}/Tools/Population.ts pick --from @slot-proposals.json --k 3 --below 0.1   # Verbalized Sampling tail: each proposal states p
bun LIFEOS/TOOLS/Inference.ts --vendor <slot.vendor> --no-fallback --level high "<slot brief>" "<train material>"   # a slot run outside a subagent
bun ${LIFEOS_SKILL_DIR}/Tools/Population.ts generation <id> --proposals @gen.json [--roster-seed <seed>] [--off-roster "<reason>"] --validate "<target validator>"   # persist; checked against its roster; failed builds recorded; exit 1 = narrow or collapsed, 2 = refused
bun ${LIFEOS_SKILL_DIR}/Tools/Population.ts generation <id> --void <g> --reason "<text>"   # withdraw a generation nothing was read from
bun ${LIFEOS_SKILL_DIR}/Tools/HillClimb.ts screen <id> --from-run <run.json> --hypothesis "<text>" --generation <g> [--proposal <id>]   # when the baseline declared a screen split; the read names its generation
bun ${LIFEOS_SKILL_DIR}/Tools/Population.ts allot --proposals @gen.json --budget <k> --judged <id,...> [--random-share 0.25]
bun ${LIFEOS_SKILL_DIR}/Tools/HillClimb.ts exp <id> --hypothesis "<text>" --kind <kind> --origin "<persona>/<band>/<vendor>" --parent <n> --generation <g> --train <n>   # screened out (lost on train, failed to build): no --value
bun ${LIFEOS_SKILL_DIR}/Tools/HillClimb.ts exp <id> --hypothesis "<text>" --kind <kind> [--kind-as-proposed "<proposer's word>"] [--origin "<persona>/<band>/<vendor>"] --parent <n> --generation <g> [--proposal <id>] ... --keep|--revert   # refused unless gen-<g>.json holds it and the origin is on its roster
bun ${LIFEOS_SKILL_DIR}/Tools/HillClimb.ts status <id>                     # keep rate by kind and origin, test reads, budget
bun ${LIFEOS_SKILL_DIR}/Tools/HillClimb.ts plateau <id>                    # plateaued, widen or climbing, and the budget
bun ${LIFEOS_SKILL_DIR}/Tools/HillClimb.ts close <id> --stop plateau|target|budget|abort [--reason "<text>"] [--holdout-run <run.json>]
```

`Skill("Research")` gathers raw material when the train misses are thin; `Skill("RedTeam")` attacks the survivors' feasibility; `Skill("IterativeDepth")` supplies the contemplate band's lenses. Generation proposal files hold `{id, hypothesis, kind, kind_as_proposed, origin, parents, p}` and nothing measured: `generation` refuses a key at any depth whose words name held-out data (test, val, validation, screen, holdout, held out, ci95, p value), while measurement words alone (value, score, delta, threshold) pass, so a target whose own grammar uses them is fine. Full flags: `Tools/Population.help.md`.

### Intent-to-Flag Mapping

| Ideal State need | Command and flags |
|---|---|
| a budget the tool enforces | `HillClimb.ts start --budget --budget-reads` |
| varied proposers across bands and vendors, drawn in code | `Population.ts roster --n --preset --vendors --climb` (`--single-vendor` only with a reason) |
| proposals come from that generation's roster | `Population.ts generation --roster-seed` (`--off-roster` only with a reason); `HillClimb.ts exp --generation --origin` |
| a proposer's own word for a kind | proposal field `kind_as_proposed`; `HillClimb.ts exp --kind-as-proposed` beside `--kind` |
| a broken generation withdrawn before anything was read | `Population.ts generation --void --reason`; `HillClimb.ts screen --generation` ties a screen read to it |
| a dream slot sees a random share of train misses | `roster --cases` |
| a wildcard with a domain not drawn before | `roster --climb` (reads `ideate/draws.jsonl`) |
| recombination pairs with a cross-origin share | `Population.ts pairs --from --k --cross-origin` |
| Verbalized Sampling tail drawn by code | `Population.ts pick --below` |
| generation persisted before measurement; collapse and narrow verdicts | `Population.ts generation <id> --proposals --threshold` |
| nothing measured that its persisted generation does not hold | `HillClimb.ts exp --generation --proposal` |
| a proposal that fails to build is recorded, never counted | `Population.ts generation --validate` |
| judges order measurement, a random share is unjudged | `Population.ts allot --judged --random-share` |
| a train-gate screen-out recorded without a held-out number | `HillClimb.ts exp --train` (no `--value`) or `exp --screened` |
| stagnation counted in generations | `HillClimb.ts plateau` (population mode once an `exp` names a generation) |
| lineage on every measured proposal | `HillClimb.ts exp --kind --origin --parent` |
| what the generations taught | `HillClimb.ts status <id>` |
| the stop named and checked against the ledger | `HillClimb.ts close --stop --reason` |

## Gotchas

- **No lane exposes a temperature** (SKILL.md Gotchas, checked 2026-10-11). How dreamy a slot is comes from its persona, what it reads, how far it is invited to reach, its far domains and its Verbalized Sampling tail cutoff, all set in `Population.ts` `BAND_SPEC`.
- **BeCreative's "Verbalized Sampling adds nothing with one correct answer" does not rule out a climb.** A climb has one metric but many valid changes, so tail sampling applies to the proposals; it never applies to the keep (2026-10-11 analysis, pass-2).
- **The comparator-shuffle rule comes from BeCreative's retired evolve-ideas intent**, which drew its randomness that way (2026-10-11 analysis, pass-2); `Population.test.ts` holds the uniformity test.
- **A roster replays only from the same seed and the same inputs.** Changing `--n`, `--preset`, `--vendors`, `--cases` or the climb's earlier draws changes the roster under the same seed (2026-10-11 replay), so `draws.jsonl` keeps the inputs beside the seed.
- **Most proposals failed to build when the target had no edit grammar.** In a 2026-10-11 replay, most proposals could not be applied, and a dream slot fed only the goal and far domains returned prose rather than a change. The edit grammar, apply step and validator come before the roster runs.

## Output format

Persist generations under the climb's `ideate/` directory (`draws.jsonl`, `gen-NNN.json`, any `gen-NNN.void-<reason>.json`, and `final.md` holding the report), and return:

```markdown
# Ideate: [Target]

**Generations:** N (stopped because: the `close --stop` reason, plateau | target | budget | abort, and `collapsed` when ideation ended on it) | **Voided:** V | **Proposed:** X | **Failed to build:** F | **Measured:** M | **Kept:** K | **Archived:** A

## Top Candidates
### 1. [Name]: measured delta [d] (CI [lo, hi])   ← or, with no measurement: composite [score] (judge spread [n])
[The change in 2-3 sentences]
**Lineage:** [kind · origin persona/band/vendor · parents · far domain · operator]
**Strongest objection:** [one sentence, from the feasibility attack]

## Wildcard
[The strange proposal worth a second look, and why]

## What the generations taught
[Keep rate by kind and by origin from `status`, and which domains and operators produced the keeps]
```

## References

- `References/Experiments.md`: framing a hypothesis, reading a result, the next move.
- SKILL.md § Ideal State and § Safety gates: the train-only rule, the keep rule and the doctrine hold every Ideate run inherits.
