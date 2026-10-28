# Rate Intent

A graded read on an ISA's substance, answering "how good is this ISA, and what single change would most improve it?"; CheckCompleteness stays the pass/fail gate on structure.

## Ideal State

- The scorecard answers first whether the ISA points at the right thing, read from the `## Ideal State` ladder, and its articulation and coherence scores cite the ladder lines they judged.
- Each rated ISA gets one scorecard in the YAML shape under Output format, scored 1–10 on each of the four dimensions (or only the `focus` dimension when one is given), with each score justified by named evidence from the file.
- The completeness score folds in a CheckCompleteness run (strict: false), and the gate's hard/soft findings appear as its evidence lines.
- The scorecard names the weakest point and the one change that would most improve the ISA, and ends in one verdict: BUILD-READY, DISCUSS-FIRST naming the specific Discuss/Interview scope that fixes it, or ROTTING naming the reconciliation work.
- When the criteria may have wandered from L3, the one change recommended is the drift check (`bun LIFEOS/TOOLS/IsaLadder.ts drift <isa>`).
- A sweep ("rate all project ISAs") produces one line per ISA (verdict + weakest point) and full scorecards only for the bottom three.

## Anti-criteria

- Never a bare number: every score is justified by named evidence from the file.
- Rate never blocks anything and never replaces CheckCompleteness as the close gate, whose pass/fail contract is unchanged; it informs the principal, and a DISCUSS-FIRST verdict owes a Discuss round on the scope it names (Algorithm criterion 6).
- Never rates a high-completeness, low-coherence ISA BUILD-READY: that is the dangerous quadrant, flagged DISCUSS-FIRST.
- Never rates the archive retroactively into failure: a pre-v2.28.0 ISA's missing ladder is noted, never counted as a defect on completed work.

## Inputs

### When to invoke

- User directly: `Skill("ISA", "rate <isa-path>")` / "rate this ISA" / "score this ISA" / "how good is this ISA?"
- The Algorithm, when deciding whether an ISA is strong enough to build against or needs a Discuss/Interview pass first.
- Periodic sweeps over project ISAs ("rate all project ISAs") to find the ones rotting.

The close gate stays CheckCompleteness (invoked by Scaffold's close sequence and Algorithm criterion 2).

| Input | Required | Description |
|-------|----------|-------------|
| isa_path | yes | The ISA to rate (or a list / glob for a sweep) |
| focus | no | Limit to one of the four dimensions (`completeness` / `integrity` / `articulation` / `coherence`) |

## Gotchas

- **Pre-v2.28.0 ISAs** without the ladder are scored on Vision (and their legacy goal and articulation sections, where they have them); the missing ladder is noted, never counted as a defect on completed work.

## Output format

One scorecard per ISA:

```yaml
isa: <path>
substance: substantial            # judged, or read from the work
scores:
  completeness: 7/10              # CheckCompleteness result + coverage read
  criterion_integrity: 6/10           # falsifiability, atomicity, anchoring, probe honesty
  articulation: 4/10              # daylight between the ideal state in the ladder and what a stranger could build from it
  coherence: 8/10                 # do the ladder, criteria, and Decisions tell one story?
weakest_point: "L1 names a 'dispute flow' no criterion, fog entry, or OoS line covers"
one_change: "Run Discuss on the dispute flow — 20 minutes closes the biggest gap"
verdict: BUILD-READY | DISCUSS-FIRST | ROTTING
```

### The four dimensions

1. **Completeness** — run `Intents/CheckCompleteness.md` (strict: false) and fold its result in: required sections for the substance, fog state, anti-criteria, Test Strategy coverage. The gate's hard/soft findings become evidence lines here.
2. **Criterion integrity** (`focus: integrity`) — read the criteria as an adversary: does each name a falsifier a tool can actually run, and does each carry it as a Test Strategy row (assert coverage: a criterion with no assert row is the defect; manual-only criteria are the judged residue to list, not a defect)? Are any trivially passable (the "email is delivered" fluff shape)? Compound? Split to hit a count? Anchored to the stated goal? Do closed criteria carry real provenance stubs?
3. **Articulation** — the writer's-blindness dimension. Read the ladder in `## Ideal State`, starting with L3 and going down: is L3 one sentence that names the destination, is every level written from the summit rather than the floor, so it pulls toward a result the principal would be delighted by, do the four L2 bullets cover what matters most, and could a stranger build the right thing from L1 alone? Read Vision instead of L1 where the substance doesn't require L1 (a task ISA). Check the three levels agree with each other, and that the ladder is current (does it contradict recent Decisions?). Does the Articulation Log show real extraction (multiple sessions, reversals captured, a `restate` block where the principal confirmed or corrected the direction) or was the prose never pressure-tested? A missing or malformed ladder, or levels that disagree, is scored here. Thin, stale, or absent articulation on project-grade work is the strongest DISCUSS-FIRST signal, and when the criteria may have wandered from L3, recommend the drift check (`bun LIFEOS/TOOLS/IsaLadder.ts drift <isa>`) as the one change.
4. **Coherence** — do the layers agree? L3, L2, and L1 say the same thing at three depths; every subsystem the ladder names traces to a criterion, fog entry, or OoS line; no criterion contradicts the ladder; Decisions reversals made it back into the prose; the Log's latest verdicts appear in L1. Incoherence between layers is worse than a thin layer — it means the artifact argues with itself.

### Verdicts

- **BUILD-READY** — build against it now; weaknesses noted are polish, not risk.
- **DISCUSS-FIRST** — the articulation or criterion set is too thin to build against without guessing; name the specific Discuss scope that fixes it (a Discuss align or deepen round, its depth, and the sections or criteria it covers). This verdict feeds Algorithm criterion 6: a Discuss round on that scope runs before substantial building, unless the principal says `proceed`.
- **ROTTING** — a previously good ISA that no longer matches reality (stale ladder, criteria closed against code that has since changed, Decisions contradicting prose). Name the reconciliation work.
