---
name: discuss
description: The standing alignment conversation for an ISA — draws a half-formed idea into shape (discover), realigns an existing ISA whose direction wobbled (align), or fills thin sections (deepen), in quick, full or deep sessions with a recommended answer on every question. Routes to the ISA skill's Discuss intent. USE WHEN /discuss, discuss this idea, are we aligned, talk it through, discovery interview, figure out the shape, realign the ISA, brainstorm before scaffolding an ISA. NOT FOR a one-question direction check (use ISA Restate).
argument-hint: <topic | isa-path-or-slug> [discover|align|deepen] [quick|full|deep]
version: 2.0.0
---

# discuss — ISA Discuss intent

Invoke the ISA skill's **Discuss** intent on `$ARGUMENTS`:

```
Skill("ISA", "discuss $ARGUMENTS")
```

If `$ARGUMENTS` is empty, run `bun LIFEOS/TOOLS/IsaAlign.ts status` on the ISA of the work in flight and discuss what it names; with no ISA in flight, ask what idea, plan or decision to discuss.

Discuss reads the ISA's state (`IsaAlign.ts status`) to pick its entry state and depth when they are not given, shows the ladder as it stands, asks the frontier with my recommended answer first and at least one challenge question, checkpoints every round into the ISA's `## Articulation Log` (`IsaAlign.ts checkpoint`), folds the answers into the ladder and criteria the same turn, and says back what moved. `discover` hands off to Scaffold. Full contract: `~/.claude/skills/ISA/Intents/Discuss.md`.
