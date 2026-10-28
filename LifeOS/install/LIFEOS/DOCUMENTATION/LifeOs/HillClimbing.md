---
last_updated: 2026-10-16T00:00:00.000Z
last_updated_by: da
convention: lifeos-freshness-v1
version: 1.4.2
---

# Hill Climbing — the one loop LifeOS runs

LifeOS does one job: it finds where you are, writes down where you want to be, and moves you from one to the other, checking every step. This doc is the single full statement of that loop and of the parts that run it. The thesis (`LifeOsThesis.md`) says why LifeOS exists. The Algorithm doc (`../Algorithm/AlgorithmSystem.md`) says how one run climbs. This doc says how the whole system climbs, and how it gets better at climbing. The HillClimb skill (`skills/HillClimb/`) is the front door that runs this loop on a named target, or on the steepest hill a survey of the records finds.

## 1. Current state to ideal state

Every piece of work is the same move: a current state, an ideal state, and the gap between them. A one-line answer, a week-long build and a life goal differ in depth only. The reply closes a small gap in one step. The build closes a larger one over many runs. TELOS holds the gaps that take years.

Because the shape never changes, one set of machinery serves all of it. Nothing in this doc is specific to code, writing or video. The largest of these hills, the principal's whole life and work, has its own section: § 13, One hill at every level.

## 2. The ISA is the hill

The ideal state has to be written down, or nobody can tell whether a step went up or down. The Ideal State Artifact (ISA) writes it down as Ideal State Criteria: short statements that are each true or false, each with the test that would prove it false.

The ISA is both the hill and the survey of it. The criteria say what the top looks like. The Test Strategy rows say how each criterion is measured. A run that is not inside an ISA still has an ideal state: the ask itself, for a one-off, or the standing checks a skill has collected over time.

Direction comes before altitude. A fully verified build of the wrong thing is the most expensive failure the system can produce, so every ISA opens with its ideal-state ladder (one sentence, then a summary, then the full picture), and the principal confirms the top two rungs before a new project or a changed direction is built (an existing ISA whose direction holds needs no re-confirmation).

## 3. Assay is the altimeter, and the ISA carries the eval

Assay is the eval system. It answers one question about any output: how close is this to the ideal state it was made for? It is the only one: every eval and every judge in LifeOS runs through it, and a capability it lacks is added to it rather than built beside it (`LIFEOS/DOCUMENTATION/Assay/AssaySystem.md` § One eval system).

The eval lives in the ISA. Every criterion maps by id to its own eval, sized to it. A literal criterion gets one assert in its Test Strategy row. A criterion that needs reading or taste gets a staged eval in the ISA's `## Evals` section: code first, then judgment-layer questions, then an anchored rubric or a tournament against the last output the principal accepted. Checks every output of a type needs (a video, a web app) come from shared libraries the ISA inherits. A skill run is held to its intent's Ideal State and Anti-criteria the same way, because an intent is a small ISA.

Building the eval and running it are two speeds. `assay compile` writes the missing evals from the criteria with the top model, in seconds, once per change to a criterion. Running them is fast: code in milliseconds, one judgment-layer batch in about a fifth of a second, and a judge or tournament only for what will not split or where the stakes call for it, chosen in code by `planDepth`. Literal checks gate judged ones, and an earlier stage gates a later one.

Every run of Assay writes one receipt bound to the exact bytes it checked (by sha256), to the ideal state it measured against, to the version of the checks and evaluators, and to where the output was going. "Pass" means an ideal-state check passed; a receipt where nothing passed reads `admitted-flagged` or `unmeasured`, never pass. `manual` is a label owed, never coverage.

Assay checks the output, never the path that produced it. A skill that took an unusual route to a good result passes; a skill that followed every step to a bad result fails.

## 4. The judgment layer is Assay's fast tier

The judgment layer answers a typed question (yes or no, a position on a ladder, one of a set) with a probability in about a third of a second. It starts with no authority: in shadow it reports what it would have decided without acting. A question earns the right to decide only once its answers agree with the principal's labels often enough. `decide()` is the only place a probability meets a threshold, and the registry refuses an enforce row that has not earned it.

At delivery, a "no" from an unearned question is a flag: shown, recorded, never blocking. A confident "no" from an earned question fails like a code check, and the judge it replaces then sees only a random holdout and the answers the judgment layer was unsure of.

## 5. Labels teach the instruments

An instrument never checked against reality drifts. Labels are the reality. Any verdict the principal gives counts once it is joined by sha256 to the receipt it judged: a rejection, an approval, an attestation, a pick between two candidates, a thumbs-up or thumbs-down on a flag. The join turns that verdict into right or wrong for each check that ran on those bytes, keyed to the judgment-layer question when it made the call.

All labels go to one store. Two kinds of signal never count toward earning: proxy labels (a flag dismissed to get something out the door) and agreement between models, which shows they are alike, not that they are right. Old receipts did not record which question made each call, so earning comes from new work, and the principal is asked first about the cases where the judgment layer and the judge disagree.

## 6. Errata is the pain signal

Errata records every moment the principal was unhappy with something the system made, word for word. It stores complaints and nothing else.

It still sees everything, by joining. Every delivered output leaves a small output line (what, where, which run, which receipt, no content). A complaint in the same turn points at those lines. The chain complaint → output → receipt → run → skill answers the questions that matter: which skills get complained about per output delivered, and how often a receipt said pass while the principal still caught a problem.

That second number, the false pass, is the most useful signal in the system. It names a check that is missing or wrong.

## 7. Upgrades is the action queue

Errata clusters and false passes become items in the Upgrades queue. An upgrade is a concrete change: a new check, a sharper criterion, a fixed tool. When it lands, the complaint rate for that skill is measured before and after, so an upgrade that did nothing is visible.

## 8. The miss loop tightens the hill

Every catch becomes one more standing check, never a longer prompt. When the principal catches something Assay missed, the fix is a check that would have caught it, attached to the skill that produced it. When a check is dismissed again and again and no complaint ever matches it, the check is retired. A check proposed by a scheduled or self-initiated loop, and any retirement, is a recommendation until the principal says yes; a fix the principal asked for lands.

This is how the criteria get sharper without anyone writing rules by hand. The hill's shape is learned from real misses.

A miss is fixed on evidence, never on a guess. STATVS, the record of everything that happened, lets a miss be rebuilt from the record and what its rows point to, then replayed with the fix in place. A guard fix counts when the replayed call now comes out differently; a prompt or behavior fix counts only on a controlled replay with a pass rate, and until that exists its proof is owed (`../Statvs/StatvsSystem.md` § A record, not a state machine).

## 9. Gates are few and only read

There are four places an output crosses into the world: handing it to the principal, sending or publishing it, deploying it, and closing an ISA. A gate sits at each one.

Gates never run judges. A gate looks up the receipt for the exact bytes crossing and applies one rule:

- No receipt, a receipt for different bytes, a failed code check or an earned "no" stops the output.
- An unearned flag lets it through, and the flag is shown and recorded.
- If evaluation was unavailable, that is said out loud and recorded. It is never read as a pass.

Sends are stricter. The check lives inside each send tool, so it holds for scheduled jobs and other agents too, and the tool re-runs the code checks on the exact bytes it is about to transmit rather than trusting a stored receipt. A gate error blocks the send, because a blocked send costs a retry and a wrong send cannot be taken back. Only the principal's own prompt can release a blocked send, and every release is logged and audited.

The agent runs as the same user as everything it is checked by, so no gate is a wall. Each one is a deterrent plus a detector: an independent reconciler compares what the gates saw with what actually happened (files written, pushes, deploys, sends), and an output that slipped around a gate shows up as a gap.

## 10. Euphoric surprise is the top of every hill

Above each ISA's specific ideal state sits the same one: euphoric surprise, the moment the principal says "this is brilliant". Criteria can all pass while the work still misses that. The principal's reaction is the final instrument, which is why reactions become labels and labels calibrate everything below them.

## 11. The Bitter Lesson, applied

Models keep getting better, so the system writes down what done looks like and leaves the how to the model. The only instructions that stay mandatory are the four keep-classes: safety gates, verified gotchas, tool contracts and output-format contracts.

The loop follows the same rule. Skills do not fill in paperwork to be covered, because the gates and hooks record what happened. Checks are compiled from the ask, not hand-written per skill. The system gets better by adding checks that caught real misses, never by adding procedure.

**Experiments come from a varied population, and only measurement keeps one** (2026-10-11). A climb draws its candidate changes from proposers of different backgrounds and creativity (careful, wandering, dreamy) across more than one vendor, and the roster is drawn by code, not chosen by a model. Changes of any size and kind are allowed (a knob, a rewording, a new stage, a deletion), so long as each rests on named misses in the training cases. The tools keep it honest: proposers see training data only, every look at test data is counted and corrected for how many candidates were tried, a keep compares per case against the incumbent, a tie that makes things simpler is kept, near-misses are archived for recombining, and a climb that has tried only one kind of change is told to widen rather than allowed to call a plateau. This is the path-to-ASI loop (create, mix, test, feed back) run inside one skill; it absorbed BeCreative's EvolveIdeas and Science's experiment intents. On its first replay, against the deeds judge, 91% of proposals were structural, against 37% before.

## 12. One climb, end to end

A sponsored essay, start to finish:

1. **Ask.** The brief arrives. Assay compiles checks from it right away (word count, required points, voice), cached on the brief's hash.
2. **Produce.** The draft is written against the essay's ISA.
3. **Proof.** Code checks run first, then one judgment-layer batch. Two unearned flags come back: the opening buries the point, and one claim has no source.
4. **Fix.** Both are fixed, and the proof re-runs clean.
5. **Deliver.** The draft goes to the principal. The gate finds a fresh receipt for those exact bytes and lets it through. An output line is written.
6. **React.** The principal says the second section drags. That becomes a label, and Errata ties it to the output.
7. **Learn.** The miss becomes a standing check for the essay skill ("does each section advance the argument?"). After enough labels, the "buries the point" question has earned the right to decide on its own.

The next essay starts on a sharper hill.

## 13. One hill at every level

Sections 2 to 12 show the loop on one output. The same loop runs at every level of LifeOS, and each level climbs toward the one above it:

| Level | The ideal state lives in | Climbed by | Measured and watched by |
|---|---|---|---|
| Life | TELOS: goals and ideal-state rows | Projects, Workflows, nudges to the principal | `ideal-reconcile`, Vigil |
| Project | The project's ISA | The Development skill and Algorithm runs | Assay rows via `bunker test`, Bunker's post-deploy probes, Vigil |
| Task | The task's ISA | One Algorithm run | Assay, the ISA gates |
| Output | The ask, or the skill's standing checks | The skill that made it | Assay's receipt, judgment layer |
> The Bunker CLI is maintainer-private and not in the public release; run code rows with `bun test ./<path>` and suite rows with `bun skills/Assay/Tools/EvalRunner.ts`.

The machinery is the same at every level: write the ideal state down, measure the gap, move, check. What differs is depth and clock speed. An output climbs in seconds, a project over weeks, a life over years. A step at one level is only worth taking if it moves the level above. A passing output that serves no task, or a finished project that serves no TELOS target, is a well-verified climb of the wrong hill.

The top level is the one the principal actually lives on, and it is the DA's standing assignment. This is the assistant from *The Real Internet of Things*: it knows what the principal is working toward, and it keeps working toward it between conversations, not only when asked. The rest of this section is about that top level, because it is the one with no prompt to start it.

**A target is pursued when three links exist.**

- **A sensor.** Something measures the target on a schedule, so the system can tell whether it is moving. A target with no sensor can be talked about but never steered.
- **A mechanism.** Something moves it: a Workflow that does recurring work, an ISA for a build, or a well-timed prompt to the principal.
- **A drop condition.** The pursuit ends when the target is reached, shown to be impossible, or withdrawn. Without one, the same target gets reconsidered forever.

**Who can move the target decides what help looks like.**

| The target moves when | Help looks like |
|---|---|
| The system acts (infrastructure, monitoring, content plumbing) | A Workflow that does the work, watched by Vigil |
| The principal acts (health, art, relationships, practice) | Less friction and a prompt at the right moment ("when X, I do Y"), a proposed calendar block; never a nag |
| Other people act (revenue, audience, customers) | Leading indicators watched daily, and campaigns drafted for the principal's yes (outbound is always an ask) |

**Workflows are the hands, Vigil is the nervous system.** Workflows do the work and the measuring on a clock (OPERATIONAL_PREFERENCES § Workflows: anything that runs on time is a Workflow). Vigil hears every result and decides whether the principal needs to know: a target that went off pace, a pursuit that stopped running, a new target with nothing pursuing it. It speaks on a change of state, never on every run. Act on leading indicators and watch the lagging ones: revenue lags, pipeline and publishing cadence lead.

**A new target gets an answer, not a question.** When the principal adds or changes a target in conversation, the DA proposes in that same turn how to make it happen: what will measure it, what will move it, who moves it, and the first move, ready for one "y". A target added by hand is picked up by the daily loop the next morning.

**Attention is the scarce resource.** The principal's attention and their own behaviour are the two things the system cannot buy more of. Every generator of recommendations shares one budget, proposals expire when ignored, and the system never changes itself on a schedule: scheduled loops recommend, the principal's yes starts the work, and what they ask for in conversation lands.

**What runs today.** Every ideal-state row carries a stable id (`— id: IS-0007`), and every TELOS goal gets one from the loop's own registry, so the loop never edits declared TELOS content; the only TELOS bytes a loop writes are the fenced AUTOMATED regions under Current State and Ideal State, rendered projections of measured state and of the principal's own stated wants. A row says what moves it with `— pursuit: <owner>:<workflow|isa>/<name>` (owner is system, principal or others) or `— pursuit: none:<reason>`; a Workflow or ISA says what it moves with `serves: IS-0007`. `ideal-reconcile` runs daily in code: it measures every row with a `measure:` binding, marks every target and goal pursued (a linked workflow ran within twice its period, or a linked ISA is open), stalled, unpursued or declined, and tells Vigil only when one flips. `ideal-recommend` proposes new rows, measurements and pursuits, unpursued and new targets first, each keyed to a real id and waiting for a yes. The session chip shows the pursued count. A Stop hook asks the judgment layer, in shadow, whether a turn that changed an ideal-state file proposed how to pursue it. `bun LIFEOS/IDEALSTATE/IdealState.ts pursuit` shows the graph (`LIFEOS/IDEALSTATE/`).

**What is next.** The links themselves: on the first run every target read unpursued, because nothing named one yet. Each link lands as a recommendation the principal says yes to, or in conversation when a target is added.

## Related

- **Concept:** this doc. The why is in `LifeOsThesis.md`.
- **Front door:** the HillClimb skill (`skills/HillClimb/SKILL.md`): Survey ranks hills from Errata, Assay and Upgrades; one intent per target type climbs a skill, workflow, eval, ISA, prompt or rule, metric, or a single miss; Ideate draws and recombines a population of experiment ideas for any climb (`Tools/Population.ts`), and `References/Experiments.md` says what a well-framed experiment is; Loop iterates any target in full Algorithm passes with the principal reviewing each pass; Verify closes the loop on the complaint rate. Its climb ledger is `LIFEOS/MEMORY/STATE/HillClimb/`.
- **Feeds me:** `../ISA/ISASystem.md` (the hill), `../Algorithm/AlgorithmSystem.md` (one run's climb), TELOS for the long gaps.
- **I feed:** `../Assay/AssaySystem.md` (the altimeter), `../Assay/Records.md` (run lines, output lines, receipts, labels), `../Assay/AssaySystem.md` § Judgment layer (the fast sense), `../Errata/ErrataSystem.md` (the pain signal), `../Upgrades/UpgradesSystem.md` (the action queue), `../Vigil/VigilSystem.md` (gate errors and escapes), `../Bunker/BunkerSystem.md` (the row engine and post-deploy ISA probes), `../Testing/TestingDoctrine.md`.
- **Philosophy:** `../../RULES/Philosophy.md` § Verification Is the Mechanism, § Ideal-State Prompting.
