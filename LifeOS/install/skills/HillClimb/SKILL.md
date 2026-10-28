---
name: HillClimb
metadata:
  short-description: "Improves a LifeOS target by experiment: varied proposers, keep-or-revert on held-out measurement until plateau, each catch landed as a standing check."
version: 1.4.0
description: "Improves anything in LifeOS (a skill, workflow, eval, ISA, prompt, rule or code metric) by experiment: finds its real misses in Errata, Assay and its ISA, draws changes from varied proposers, keeps only what held-out measurement supports until plateau, lands each catch as a standing check, then verifies complaints fell. With no target it climbs the steepest hill. USE WHEN hill climb, hillclimb, climb this, improve X, make X better, optimize, reduce latency, improve a metric, experiment, iterate, hypothesis, evolve ideas, ideate, experiment ideas, this keeps failing fix it for good, what hurts most, what should we improve, turn this miss into a check, did that fix work, before and after, iterate with me, multiple passes, revisit, rework. NOT FOR filing a complaint (Errata), writing or calibrating one eval suite (Assay), editing an ISA (ISA), skill scaffolding or description tuning (CreateSkill), mining outside content (Upgrade), one-pass brainstorming (BeCreative), diagnosis without an experiment (Science)."
evals:
  deterministic:
    - command: "bun skills/HillClimb/Tools/HillClimb.ts survey --json"
      falsifier: "the live survey returns no hills or omits an unreadable source from unavailable"
---

# HillClimb

**Contents:** Ideal State · Intent Routing · The loop (every workflow runs it) · Targets at a glance · Data & Config · Safety gates · Gotchas · Examples

The climber for the one loop LifeOS runs (`LIFEOS/DOCUMENTATION/LifeOs/HillClimbing.md`), and LifeOS's one place to improve something by experiment: collect ideas, vary and combine them, test them, and feed the results back as raw material for the next ideas. The instruments already exist: Errata is the pain signal, Assay the altimeter, its judgment layer and labels the fast sense, the ISA the hill, Upgrades the queue. HillClimb points them at one named thing and climbs it. The experiment discipline inside each climb comes from Anthropic's eval hill-climbing guide (Claude Code's bundled `/claude-api hillclimb`), enforced here in code against our own instruments.

## Ideal State

- Before anything changed, the target's ideal state was located (its ISA criteria, its standing checks, or the ask it serves), and a baseline was measured by an existing instrument and recorded in the climb ledger with how it was measured.
- The misses behind the climb are real: Errata complaints, false passes, failing cases, broken-rule exemplars. None are invented.
- A climb the principal asked for runs in one go from baseline through experiments to its stop: a stated target, a budget stated when the climb opened (`start --budget <n experiments>`, optionally `--budget-reads <n candidate reads>`), after which `exp` and `screen` refuse, or, with neither given, a plateau that `plateau` confirms. `plateau` counts experiments in a single-proposer climb and generations once the climb runs Ideate's population. While the reverts since the last keep span fewer than three kinds of change, `plateau` answers `widen` and the climb tries other kinds rather than stopping. It never halts after the baseline to ask for a budget; it stops early only at a safety gate, at a stop its intent names (IsaClimb's restate, Prompt's suite review, Eval's restart decision), or at an abort: continuing would cross an ethical line, the climb has failed with no path to recovery, or its resources are better spent elsewhere.
- Across a climb, proposals come from varied minds: proposers that differ in background, vendor and reach (careful to dreamy), drawn in code, whose changes span the kinds the ledger records (knob, wording, rule, structure, delete, add, import). Each experiment row carries its kind, origin and parent, so the close can say which kinds and which proposers earned keeps. A recombination names the earlier experiments it draws on.
- Each change rests on behaviours named on train cases, with how many cases show each, and its size is free: one word or a new stage. A kept change with several parts credits a part with the gain only after a variant without that part was measured; until then the gain is reported as unattributed.
- No proposer's context ever held test, screen or holdout cases or their scores. Proposers read train case transcripts from the run file under `MEMORY/STATE/Evals-Results/<suite>/<run>/` and the climb's history through `digest <id> --train-only`; the session that decides keeps sees scores only, and the target under test never sees the suite's expected outputs or rubric.
- Only held-out measurement keeps a change, and the keep rule lives in code: the test score clears the noise floor, at a significance corrected for every candidate read on test since the last keep, the instrument and served model are unchanged, and standing checks did not drop. A tie inside the noise is kept only when it removes material (`--simpler`). A judge's opinion of a proposal decides at most which proposals get measured, never which are kept. Every experiment, kept or reverted, is in the ledger, and a revert that gained on train stays in the climb's archive as material for recombination.
- When many candidates compete, a screen split cuts them down so test reads stay few; the ledger counts every test read, and a declared holdout is scored once, at close, beside the test delta.
- When `plateau` asks for it (two reverts in a row, or in population mode the run of generations without a keep that `plateau` counts), a `stall` categorization (artifact, grader, harness, structural, variance) is recorded before any further content change, and each category goes to the system that fixes it.
- Every kept win is landed as a standing check (a suite case, a judgment-layer question, a `bunker miss`, a sharper criterion, a fixed tool or a Gotcha) so the same miss cannot recur. What a climb learned is never landed as a longer prompt.
- A climb closes with baseline, best and delta plus the diff that produced them, the holdout delta when one was declared, the test-read count and the keep rate by kind and origin. `close --stop` records why it stopped (plateau, target, budget, abort, or reviewed for a Loop) and refuses a close with no reason or one the ledger contradicts: plateau needs `plateau` to answer plateaued, budget a spent budget, target a keep, abort a `--reason`, reviewed a climb with no `exp` rows and a `--reason` carrying the measured delta. It lists every baseline a `baseline --force --reason` replaced, with that reason; it files an Upgrades record naming the climb, and is marked verified only when Errata shows its complaint rate fell.
- With no target, the survey ranks real hills from Errata, Assay and Upgrades and reports any unreadable source as unavailable, never as zero pain.
- A Loop run puts the principal's review between full Algorithm passes in place of the code keep rule, opens and closes in the same climb ledger, and still ends on a measured delta against baseline.
> The Bunker CLI is maintainer-private and not in the public release; run code rows with `bun test ./<path>` and suite rows with `bun skills/Assay/Tools/EvalRunner.ts`.

## Intent Routing

| Intent | Target | Trigger | File |
|---|---|---|---|
| **Survey** | nothing given | "hill climb", "what hurts most", "what should we improve" | `Intents/Survey.md` |
| **Skill** | a skill | "hill climb the X skill", "make X better", "X keeps getting it wrong" | `Intents/Skill.md` |
| **Workflow** | a Workflows v2 definition or a skill intent | "improve the X workflow", "this workflow keeps failing" | `Intents/Workflow.md` |
| **Eval** | a suite, judge, judgment-layer question or standing check | "improve the eval", "this judge is wrong", "fix the failing suite", "retire dead checks" | `Intents/Eval.md` |
| **IsaClimb** | an ISA | "hill climb this ISA", "sharpen the criteria", "the ISA is drifting" | `Intents/IsaClimb.md` |
| **Prompt** | a prompt, agent file, system-prompt section or doctrine rule | "optimize this prompt", "improve the agent", "this rule keeps getting broken" | `Intents/Prompt.md` |
| **Metric** | code with a measurable number | "reduce latency", "shrink the bundle", "optimize this metric" | `Intents/Metric.md` |
| **Miss** | one caught miss | "turn this miss into a check", "never let this happen again" | `Intents/Miss.md` |
| **Verify** | a closed climb or an applied upgrade | "did that fix work", "before and after", "verify the climbs" | `Intents/Verify.md` |
| **Loop** | any target the principal wants to review between passes | "iterate on this with me", "multiple passes", "revisit", "rework" | `Intents/Loop.md` |
| **Ideate** | the candidate changes for any climb's experiments | "ideate", "id8", "breakthrough ideas", "explore", "get creative on this climb", "evolve experiments", "evolve ideas", "experiment ideas", "generate hypotheses", "design an experiment", "iterate on an experiment" | `Intents/Ideate.md` |

### References

| File | Read when |
|---|---|
| `References/Instruments.md` | Choosing which system supplies a climb's hill, top, altimeter, judge check, experiment rules or record |
| `References/CritiqueClimb.md` | The climb is measured by ArtDirection critique readings (a film or image) |
| `References/Experiments.md` | Framing hypotheses, designing a measurement, or reading results |
| `Setup.md` | First-time setup: the optional USER `PREFERENCES.md` and `History.md`, and proving the install |

## The loop (every workflow runs it)

These are the loop's verbs, and order matters only where evidence depends on it: a baseline before any experiment, a whole generation persisted before any of it is screened or measured, and every win landed before `close`. The intent's own tool contract has the full flags.

```
open        HillClimb.ts start [--budget <n>] [--budget-reads <n>]   # type, target, metric, direction, budget
locate      the target's ISA, IsaLadder.ts
baseline    HillClimb.ts baseline --from-run [--screen-frac <f>] [--holdout-frac <f>]   # raw per-case rows, seeded train/screen/test split, noise floor; other instruments per Targets at a glance
preflight   HillClimb.ts preflight                   # noise floor below the headroom and the smallest win worth having, else add cases or trials first
misses      Errata.ts, Proof.ts, suite transcripts, FailureToCase.ts
ideate      Intents/Ideate.md, HillClimb.ts digest, HillClimb.ts archive   # candidate changes from varied proposers, fed as the Ideal State says
experiment  HillClimb.ts exp --from-run --kind <k> --origin <id> [--parent <n>] [--generation <g>] [--simpler --before <f> --after <f>] --keep|--revert
stall       HillClimb.ts stall                       # when plateau asks for it
stop        HillClimb.ts plateau                     # plateaued, widen or climbing; a spent budget, a reached target or an abort also stops, named at close
land        bunker miss, Assay suites, judgment questions, the target's Gotchas
close       HillClimb.ts close --stop plateau|target|budget|abort|reviewed [--reason "<text>"] [--holdout-run <run.json>]   # before/after report, stop reason, replaced baselines, holdout delta, the Upgrades record
```

`HillClimb.ts status <id>` shows the keep rate by kind and by origin, the test-read count and what is left of the budget at any point.

## Targets at a glance

| Type | Ideal state lives in | Altimeter | What changes |
|---|---|---|---|
| skill | its ISA or done-bar, its standing checks | Errata rate, receipts, its suite's pass^k | SKILL.md, intents, tools (through CreateSkill) |
| workflow | the definition's output schema, its run ledger | run success rate, output checks | the definition or workflow file |
| eval | the ISA criterion it measures, principal labels | agreement and kappa, adversarial catch, residue | suite cases, anchors, judgment-layer questions |
| isa | the ladder and the principal's stated goal | `IsaLadder.ts drift`, `Rate`, manual-row count | the ISA's criteria and Test Strategy |
| prompt / rule | the doctrine's intent | suite pass^k, recall on the rule's past failures | the prompt, or a check that enforces the rule |
| metric | a stated target number | the measure command | the target files |
| miss | the brief the output missed | Proof on the same artifact | a standing check |

## Data & Config

- Climb ledger: `$HILLCLIMB_DIR`, else `<configRoot>/LIFEOS/MEMORY/STATE/HillClimb/<climb-id>/` (`climb.json`, `experiments.jsonl`, `reads.jsonl`, `archive/`, and `ideate/` for Ideate's draws and generations). This is HillClimb's only store. Complaints, receipts, labels, suites and upgrades stay in their own systems.
- Tools: `Tools/HillClimb.ts` (usage in its header and `help`) and `Tools/Population.ts`, the code-drawn proposer roster, pairs, tail picks, measurement allotment and generation record behind Ideate (flags in `Tools/Population.help.md`). Survey sources: `LIFEOS/ERRATA/Errata.ts`, the latest `LIFEOS/USER/ERRATA/v4/report-*.md`, `skills/Assay/Tools/SuiteManager.ts`, `LIFEOS/TOOLS/Upgrades.ts`.
- Install history: `<configRoot>/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/HillClimb/History.md`, when present, holds the full stories behind the dated gotchas below (which climb, which repos, which scores). Read it when a climb looks like one of them; the skill runs the same without it. A `PREFERENCES.md` beside it, when present, holds the install's preferences that switch on optional behaviour in `Intents/Ideate.md` (for example, the DA ideates first) with the principal's own words behind them; read it before running Ideate.

## Safety gates

- **Doctrine hold.** A change to the system prompt, the Algorithm, CLAUDE.md, the operational-rules file or the identity files is shown to the principal as a diff and held for a yes, even inside a requested climb. A self-initiated or scheduled climb or loop recommends and never changes the system on its own. A climb the principal asked for may edit its named target, and touches hooks, skills or doctrine outside that target only as a held diff. A Loop holds more: when its named `--target` is itself a hook, a skill or one of those doctrine files, each pass's change to it is shown as a diff and held for a yes (`Intents/Loop.md`). Long-running work started without the principal's ask needs their yes before it launches. Every intent defers to this gate.
- **Shared tree.** Revert an experiment by restoring only the paths it touched, after `git diff` shows only your hunks. Never `git stash` and never `git checkout .`. Commit each kept change with explicit paths, in the same command that stages it.

## Gotchas

- **The survey is a ranking, not a measurement.** Its weights put a false pass first because a false pass names a check that is missing or wrong. A hill's score says where to look, and the climb's own baseline says how bad it is.
- **Output lines started 2026-09-30, so per-skill complaint rates read zero before that date.** Until complaints join to outputs, the skill hills come mostly from suites and the Errata v4 broken-rule table, and `verify` returns `insufficient-data` on older climbs.
- **A train set unlike the keep split hides the hill.** Train-blind proposers can only climb what train shows. In a 2026-10-12 climb, train was mostly the cases the rules were fitted to (high on one class) while the keep split's fresh cases sat far lower on it, so every proposal barely moved train and moved the keep split by small amounts with no way to tell which was real. Compare the incumbent's per-decision train and keep-split baselines before ideation, and grow train toward the keep split when they disagree (`Intents/Ideate.md` § Ideal State).
- **A scripted climb needs a reader before any big keep.** A Workflow whose recorder only runs commands will revert every large win, because `exp --keep` refuses one without `--spot-checked` (the full refusal list is below): a 2026-10-11 climb lost several real gains that way and reported a false plateau. Put a spot-check agent (train-half flips only, toward or away from gold, for real reasons) between the keep decision and the recorder.
- **A scorer that prints the test score spends the test half.** In a 2026-10-11 climb, proposers were handed such a scorer and many sweeps picked weights against test. Give proposers a scorer that prints the train half alone, keep the test and validation scorer in the orchestrator's own lane, and audit the run directories for test runs inside proposer windows.
- **What `exp --keep` refuses.** A gain inside the noise floor, Bonferroni-corrected for the candidates read on test since the last keep (unless `--simpler` and the change removes material), a proposal `--generation` names that its persisted generation does not hold, a screened-out candidate, a `--generation` origin that is off that generation's roster or is not the measured proposal's own, a changed instrument (suite, judge prompt, grader), a different served model (a model named on only one side counts as different), a drop in standing checks or a keep with no `--checks` once a count stands, and a jump over three times the noise without `--spot-checked`. A run read on a `--field` other than the one the baseline scored is refused before it is measured. Once the budget is spent, `exp` refuses any row and `screen` any read (`budget spent: …`), except that a screened-out candidate, which reads nothing, still records while only reads are spent. A refused keep is recorded with `--revert`. Arguing past the tool is the failure it exists for.
- **Most of our suites are small.** Under ten cases, the split is `directional`: every case is scored, there is no held-out set, and the noise floor is wide. Preflight will usually say the suite cannot see a modest win. The fix is more cases from real misses (`FailureToCase.ts`) or more trials, before round 1.
- **No lane exposes a temperature** (checked 2026-10-11: `rg temperature` finds nothing in `LIFEOS/TOOLS/Inference.ts` or BeCreative). How dreamy a proposer is comes from its persona, how far a change it is invited to make, far-domain inputs and Verbalized Sampling's tail.
- **A film or image climb keeps on paired critique readings, never on one median.** Its baseline and `exp` flags and what the keep refuses are in `References/CritiqueClimb.md`; read it before that baseline.
- **`Compare.ts` is the stricter keep test for judged suites.** When its paired CI excludes zero, record it as `--noise <half-width> --noise-source "Compare paired CI"` at baseline, so the code gate uses it.

## Examples

```
User: "hill climb"
→ Survey: ranks hills from Errata, Assay, Upgrades and the climb ledger, then climbs the top one the principal picks

User: "the research skill keeps citing secondary sources, hill climb it"
→ Skill: baseline from its suite and complaints, cases from the real misses, candidate changes from Ideate, experiments until plateau, a standing check

User: "the classifier judge is stuck nudging weights, get creative on this climb"
→ Ideate: proposers of differing reach and vendor propose structural, deletion and import changes from train misses; the climb measures them

User: "the verification rule keeps getting broken"
→ Prompt (rule): measures a check's recall on the rule's past failures, proposes the enforcing check, verifies the break count fell

User: "did the Art climb work?"
→ Verify: before and after complaint rate from Errata, marks the upgrade verified only if it fell
```
