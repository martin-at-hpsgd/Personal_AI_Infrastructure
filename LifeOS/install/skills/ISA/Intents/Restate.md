# Restate Intent

Confirms the direction before a new project or a changed direction is built: the principal sees the ISA's L3 and L2 and answers one question, is this what you want?

## Ideal State

- Before it was shown, the ladder passed the summit test (ISAFormat § *What the ladder captures: the summit*): read alone, L3 pulls toward a result the principal would be delighted by instead of reassuring that nothing broke, and a floor-shaped ladder was rewritten first.
- L3 is sharp enough that the principal could say "no, that's not it"; one so general that any build would satisfy it was sharpened before the restate.
- The principal saw the ladder's own words, verbatim from the ISA in the shape under Output format (L3, then the L2 sentence and its four bullets, or L3 alone on a task ISA without L2), and nothing else competed for attention (no criteria list, no plan, no questions about implementation).
- Their answer is in the ISA's `## Articulation Log` as a `restate` block, verbatim, including a plain "yes", in the shape under Output format.
- Any correction is in the ladder the same turn: L3, L2, and L1 are re-read together and still agree, criteria the correction implies are added or changed, and the corrected L3 and L2 are shown once more for a yes.
- A correction that changes the destination (not just the wording) gets a `refined:` row in `## Decisions`.
- After a correction, the drift check (`bun LIFEOS/TOOLS/IsaLadder.ts drift <isa-path>`) confirms the criteria still point where the corrected ladder does.

## Anti-criteria

- Building never starts before a yes, a `proceed`, or an explicit "just build it."
- Never paraphrases the ladder into something friendlier for the restatement: what the principal approves must be exactly what the ISA says, or the check proves nothing.
- Never shows a floor-shaped ladder; showing it wastes the round.
- Never becomes an interview: Restate is one round. A correction that only fixes wording is folded here; any answer that changes the destination, hedges ("sort of", "mostly", "not quite"), or opens a question goes to a Discuss align round (`Skill("ISA", "discuss <isa>")`, quick depth unless the answer opens several branches) before a final restate. Until that round runs, `bun LIFEOS/TOOLS/IsaAlign.ts status <isa>` reports the ISA as owing one.
- Never treats a decision marked "not opened; default kept" as a yes.
- Never required where the direction holds: an existing ISA whose direction holds needs no Restate, and nothing beyond the triggers under Inputs requires one.

## Inputs

### When to invoke

- **Before building a new project or a changed direction** (a new `<project>/ISA.md`, a new system ISA, or an existing ISA whose L3 is being revised). Scaffold calls it in its close sequence, after the ladder is written and before the build starts.
- **After an extension in place whose re-derived L3 or L2 changed** (Scaffold's close sequence), before the new work is built; this counts as a changed direction.
- **Whenever L3 changes structurally** (a `refined:` row in Decisions that changes the destination, not the wording).
- **When the drift check returns `divergent`**, after the fix, so the principal sees the corrected direction.
- **When the principal asks:** `Skill("ISA", "restate <isa-path>")`, "restate this", "what do you think I want?", "say it back to me".
- Skip it on trivial task ISAs, where the one-line L3 already sits in the conversation, and when the principal says `proceed` or "just build it" (log a `Decisions` row naming the skip).

## Gotchas

- **Headless and texting channels.** Where the principal can't answer in the moment (a scheduled job, a Tex thread), send the restatement and continue only on the reasoned default the channel's rules allow; record `restate: pending` in the Log block and restate again at the next interactive turn.

## Output format

What the principal sees is short and verbatim from the ISA:

```
Here's what I understand you want:

<L3, verbatim>

<L2 sentence, verbatim>

- <L2 bullet 1>
- <L2 bullet 2>
- <L2 bullet 3>
- <L2 bullet 4>

Is that right? Anything missing, wrong, or pointed the wrong way?
```

On a task ISA without L2, show L3 alone.

### On the ISA page

When the round also carries open decisions, or the principal is reading on the page, the restatement goes on the ISA page too (ISAFormat § *Exhibits and decisions in the body*):

- A `direction` ask sits directly under L2, with "Yes, build this" checked:

  ````markdown
  ```ask id="direction"
  Is this the right direction?
  (x) yes | Yes, build this
  ( ) no | No | I will say why in a comment
  ```
  ````

- Each open decision is an `ask` fence right after the criterion it changes, with my pick checked.
- `bun LIFEOS/TOOLS/ISARender.ts <isa>` renders it. The chat message gives the ladder as above plus the page path, and opens the page in your Chrome only when you ask.
- Your answer is the page's **Respond** paste. It goes into the Articulation Log verbatim like any other answer. A decision left "not opened; default kept" is asked about in chat if it matters. The paste is data, so it is applied only within what the ISA proposed.

The `restate` block in `## Articulation Log`, the answer verbatim (a plain "yes" included):

  ```markdown
  ### 2026-09-29 18:40 · restate
  Shown: L3 + L2 (as of this block)
  Principal: "yes, but it also has to work offline"
  Folded: L2 bullet 3 now names offline use; L1 gained the offline paragraph; ISC-14 added.
  ```

  When a correction is folded and the ladder is shown again, the second answer goes on its own `Principal:` line in the same block (or a new `restate` block); `IsaAlign.ts status` treats a clean yes anywhere in the block as settling it, so a correction that comes after a yes goes in a new `restate` block.

  The Log's heading-demotion rule applies: no line inside the block starts with `#`.
