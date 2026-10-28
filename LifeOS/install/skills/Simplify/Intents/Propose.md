---
contract:
  requires:
    - id: survey
      path: LIFEOS/MEMORY/WORK/{slug}/simplify/survey.md
      fields: [PURPOSE, DEPENDENTS, FINDINGS, BASELINE]
      produce: 'Run the Simplify Survey intent on the target and write {path}.'
---

# Propose

A ranked set of simplifications built on the survey. Each one carries its evidence and its parity check, and all of them are held for the principal's yes.

## Ideal State

- The survey existed and was verified (`IntentContract.ts`) before any change was proposed, and every proposed change cites the survey finding it acts on.
- Each change names its move: **delete** (dead or cruft), **merge** (duplicates folded into one survivor), **inline** (collapse an over-abstraction), **relocate** (rarely used detail moved to an on-demand reference behind a pointer), or **tighten** (the same behaviour in less code or prose). Each also names the exact text or code it touches, its estimated size saved, and its risk.
- Each change lists what it preserves: every dependent and ISA criterion that touches the element, with how that dependent stays served afterwards. It also names the check that proves this, either a baseline command or a new probe written for an uncovered behaviour.
- Changes are ranked with the largest reduction at the lowest risk first, and grouped so that each group can land and be verified on its own.
- The proposal is written to `LIFEOS/MEMORY/WORK/{slug}/simplify/proposal.md` with non-empty `CHANGES`, `PRESERVED` and `PARITY` headings, then shown to the principal. Nothing is applied in this turn.

## Anti-criteria

- Never proposes touching an element classed as load-bearing or unknown without stating which dependent moves and how it stays served.
- Never proposes a merge that loses a distinct behaviour, option, directive, path or name from any of the originals. If the survivor cannot carry all of them, the originals stay.
- Never counts a smaller line count as the goal. A change that makes the target harder to read or understand is not a simplification.
- Never applies a change, and never treats the principal's request to "simplify" as approval of a specific change set.

## Output format

The response shows the ranked changes as a table (number, move, target, saved, risk, parity check), then lists every unknown element left untouched, then gives the proposal file path.

## Safety gates

- **Held for yes.** The proposal ends the turn. Apply runs only on the changes the principal approves, by number or as "all"; "y" approves the whole set as proposed.
- **Deletes of irreplaceable content are flagged.** A change that deletes the principal's written words, a data store, live infra, or anything not regenerable is marked P8 in the proposal. Approving the set does not cover it, and it needs its own explicit yes.
