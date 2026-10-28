# CreateJudge Intent

Author a model-graded assertion — reluctantly, well, and with a plan to retire it.

## Ideal State

- A judged check exists only where the author tried and failed to express the property deterministically; every checkable part (banned phrasings, structure, length, required content) is already a code assert.
- It sits where its state lives: state that already exists takes a `glance` row with a question file beside the ISA; output generated fresh on each trial takes an assert in a suite (CreateSuite).
- It asks one question in the shape its answer drives: a noul for an `if`, a choice for a `switch` over an unordered set, a score for a sort or threshold on an ordered ladder.
- A score's ladder is anchored with a written description for every level from 1 to `scale`.
- Its content is derived from the owning ISA (Vision, Principles, Articulation) and stamped with `derived_from: <isa-path>#<section>`; `reference:` carries the text it grades against.
- It is calibrated against principal labels before its verdicts count; until then it runs at 'high' and its verdicts are provisional.

## Anti-criteria

- A judge where a deterministic assert could answer.
- One rubric grading several dimensions at once, or a ladder whose levels mix dimensions.
- A rubric with any level unanchored (it never reaches the judgment layer and counts as residue with reason `unanchored`).
- Rubric text that restates the judge mechanics, or wording crafted to get around the UNKNOWN escape hatch.
- A judge that is also the generator.
- A threshold written into a question file.
- A judge written against an ISA that has no Vision, Principles, or Articulation to derive from.

## Inputs

The owning ISA supplies the content; a judge is only as good as the ideal state behind it, so its content is derived, never invented. **Vision** (what euphoric surprise looks like for this work) gives the top anchor; **Principles** give the dimensions worth judging and the preference lists for a pairwise question; **Articulation** (the full prose of the ideal state) gives the reference text and the middle anchors. An ISA with no Vision, Principles, or Articulation to derive from is not ready for a judge; write the articulation first.

## Tool contract

Tier first. Most of "great" hides checkable parts: banned phrasings (`not-icontains`), structure (`regex`, `is-json`), length bounds, required content (`contains-all`). Judge only the residue; every judged clause is debt the Calibrate intent exists to pay down.

Shape second, by the table in SKILL.md § Choosing a check. An `llm-assert` holds one literal statement per line; a `kind: choice` question file lists its options; a `kind: score` file's criteria run low to high.

Split before you scale: many small questions, one property each. Reach for a multi-level anchored rubric or a tournament only when the property will not split into nouls, choices, or short ladders. A question file looks like this (the threshold never goes here; it lives in the registry):

```json
{ "id": "harness-docs", "claim": "A README documents the harness.", "kind": "noul",
  "instructions": "Does the supplied README explain what the harness does and give a concrete command for using it? Answer no if either part is absent.",
  "state": { "producer": "README.md" }, "caller": "bunker-glance" }
```

When a question answers wrong, or a criterion needed a question it lacked, the fix is `bunker miss` (Calibrate § Tool contract, The miss loop), never a longer rubric.
> The Bunker CLI is maintainer-private and not in the public release; run code rows with `bun test ./<path>` and suite rows with `bun skills/Assay/Tools/EvalRunner.ts`.

A derived rubric, stamped with where it came from:

```yaml
- type: llm-rubric
  value: "How much of the argument does the image recover?"
  reference: "<the argument summary, from ## Articulation>"
  derived_from: "~/Projects/x/ISA.md#Articulation"
  anchors: { "1": "...", "2": "...", "3": "...", "4": "...", "5": "..." }
```

`reference:` is the text the judge grades against (the prompt carries it as a REFERENCE block, and the judge is told to grade against it rather than its own reading of the topic). `derived_from: <isa-path>#<section>` is the lineage: the runner keeps it in run.json and `Calibrate.ts --residue` flags any judged assert without one. A skill suite's judged asserts come from its intents' Ideal State the same way: `Tools/IntentRubric.ts` stamps each with `derived_from: <intent path>#IS-n` (CreateSuite).

Anchors: `anchors` with a written description for each level from 1 to `scale` (default 5) turns a vague 1–5 into something a cheap judge scores reliably, and it is what lets judgment-layer answer the rubric as a score. Take the rungs from the criterion's own words. A short ladder is `scale: 3` with three anchors; at the default threshold it passes only on the top rung.

```yaml
- type: llm-rubric
  weight: 2
  value: "How well does the output lead with the answer?"
  anchors:
    "1": "buries the answer after preamble or narration"
    "2": "answer present but only after the second paragraph"
    "3": "answer present in the first paragraph but not the first sentence"
    "4": "answer in the first sentence, hedged or qualified"
    "5": "first sentence IS the answer"
```

Picking between candidates is a choice, so prefer pairwise: a judge asked "which of two outputs is better" is far more reliable than one scoring in isolation. Two candidates and a metric delta → the Compare intent; three or more candidates and one winner → `Tools/Tournament.ts` (a flipped bracket with a shuffled rerun; a `pairwise` Test Strategy row is its harness shape). The question a tournament asks comes from the ISA's Principles, the same way anchors do.

After authoring, the Calibrate intent earns it (the earned bar is the `Tools/Calibrate.ts` row in SKILL.md § The canonical path). Diagnose disagreements as criterion ambiguity, judge error, or a label needing principal review; preserve the intended standard and check revisions against held-out labels.

## Gotchas

- The judge system prompts already carry three mechanics (`LIFEOS/TOOLS/lib/JudgePrompts.ts`, shared by the text and vision judges): the judge quotes the deciding phrases (or names the deciding visual elements) BEFORE choosing a level, chooses the LOWER level when torn between two, and grades against the `reference:` when one is given. Write anchors that make those quotes findable; never restate the mechanics inside a rubric.
- One dimension per judge (Anthropic: isolated judges hallucinate less than one judge grading everything). Tone and accuracy are two asserts, not one rubric.
- The judge is never the generator: the runner defaults judge and agent to different levels and warns when they collide; keep it that way.
- Assertion judges use the output plus its supplied reference. A response-interpretation criterion can be established by a short answer; a criterion that an external write occurred needs execution evidence. Keep those properties separate in the assertion.
- The judge system prompts force reason-then-score with a fenced JSON verdict and an UNKNOWN escape hatch; a judge that can't verify must say UNKNOWN, never guess.
- Threshold default for llm-rubric is 0.6 (minimum integer score 4/5); set `threshold` per-assert when the bar differs.
