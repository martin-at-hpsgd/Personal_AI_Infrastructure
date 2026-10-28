# Interview Intent

Adaptive question-and-answer that fills in or deepens an ISA's prose sections, starting with the `## Ideal State` ladder.

## Ideal State

- The `## Ideal State` ladder is the first section interviewed and the last one re-read: L1 is settled first, then L3 and L2 are checked against L1 rather than invented fresh.
- L1 covers every component of the thing's surface; a component the prose never mentioned was asked about (the writer's-blindness probe) before the interview ended.
- Questions are asked only where a section is thin or missing (or only in the named `section` when one is supplied), most foundational first: the ladder, then Problem, Vision, Out of Scope, Principles, Constraints, Criteria, Test Strategy and Features.
- The questions run through the Discussion primitive (`../References/Discussion.md`): frontier rounds that batch only questions whose prerequisites are settled, a recommended answer leading every question, and facts looked up rather than asked.
- After every answer the ISA is edited immediately with two writes: the round appended to this session's dated `### YYYY-MM-DD HH:MM · interview — <scope>` block in `## Articulation Log`, and the settled answer folded into its target section, with L1 rewritten and L2 and L3 re-derived when the answers change what the thing IS, so the user feels the document filling up as they answer.
- Every criterion the interview touches leaves with a Test Strategy row: a runnable probe (`bun-test`/`bash`/`curl`), a judged `eval` suite, or a `manual` check naming the falsifier.
- The interview ends when the sections the work's substance requires are populated to non-thin depth and the ladder's levels agree with each other and with the criteria, when the user says "that's enough" / "skip the rest" / "done.", or when two answers in a row are "I don't know" or "skip".
- A final CheckCompleteness pass (`Intents/CheckCompleteness.md`) ran after the interview and its remaining gaps are surfaced without blocking.
- The questioning is conversational, not formal (no "Question 1 of 8."), uses the user's own words from earlier answers, and drops to the substantial-grade core (Ideal State, Problem, Criteria, Test Strategy) with the rest flagged "fill in later" when the user is rushed.

## Anti-criteria

- Never asks a question whose prerequisite is still open, and never batches outside a frontier round.
- Never lets a contradiction with the existing ISA pass silently: new answers are the canonical source, and the contradiction is logged in Decisions with a `refined:` prefix.
- Never blocks on the final CheckCompleteness gaps; the user can iterate later.
- No line inside an Articulation Log block starts with `#`.

## Inputs

### When to invoke

- From Scaffold's ambiguity check (Scaffold § Ambiguity check) when the goal is materially ambiguous on substantial work. Max 3 targeted questions, `proceed` override available, partial-fill written back to ISA per question.
- From Discuss in `deepen` mode, when the ladder holds but sections are thin: the same engine, walking the thin sections in the order above.
- After Scaffold on deepest-grade work, when CheckCompleteness reports thin sections; a `deepen` verdict from `bun LIFEOS/TOOLS/IsaAlign.ts status <isa>` (thick fog) runs Discuss `deepen`, which walks the thin sections in this intent's order.
- After any Scaffold if CheckCompleteness reports gaps.
- User directly: `Skill("ISA", "interview me on <isa-path>")`
- User directly with a specific section: `Skill("ISA", "interview me on the Vision section of <isa-path>")`

| Input | Required | Description |
|-------|----------|-------------|
| isa_path | yes | Path to the ISA to deepen |
| section | no | If supplied, only interview that section; otherwise walk all thin sections |

## Gotchas

- **User abandons mid-interview:** the partial population is still valuable. Save what you have, leave a Decisions entry: "interview paused at <section> — N questions answered, M skipped."
- **User answers are aspirational rather than concrete:** push gently — "what would a test that proves that look like?" If the user can't articulate, the ISC is not yet hard-to-vary; flag in Decisions.

## Output format

The deliverable is the edited ISA itself, plus one dated block in `## Articulation Log` per session:

```markdown
### YYYY-MM-DD HH:MM · interview — <scope>
```

The closing message names the sections filled and lists the CheckCompleteness gaps that remain, each with its section.
