# Ambiguity Questions

How Scaffold asks when its ambiguity check (`Intents/Scaffold.md` § Ambiguity check) finds that what done means is materially ambiguous, and how it re-checks when late information arrives. The rule itself and the frontmatter it writes stay in the intent; ask mechanics shared with every interviewing surface live in `Discussion.md`.

## Provenance escalation

**Provenance escalation:** the 3-question ceiling holds only when done is discoverable from the record. Exemplar-anchored new-product work is discoverable: the Extraction Pass runs first and the principal ratifies the articulated state (forks plus the lowest-confidence and most-surprising dispositions as the default view, full manifest linked; owed questions fire once as a batch). When the ideal state lives only in the principal's head with no exemplar and no record (generative, experiential, strategic work), extraction would be banned inference, and the three-question ceiling is the wrong tool: run Discuss in `discover` mode (`Intents/Discuss.md`, full depth, uncapped frontier rounds) before Scaffold writes more than the ladder. The only alternative is the principal's `proceed`, recorded as a Decisions row with the named defaults Scaffold then builds on.

**When the answers open more questions than they close,** the three-question message stops and a Discuss round takes over: `align` when the ladder exists, `discover` when it does not.

## The one message

The one message, sent before any section beyond the Ideal State ladder is scaffolded (ask mechanics: `../References/Discussion.md`, recommended answers lead and facts are looked up rather than asked):

```
I have N questions before I scaffold this. The goal is clear on X but underdetermined on Y. Say `proceed` to scaffold on reasoned defaults; otherwise answer one at a time:

1. <Q1 — aimed at the thinnest section>
2. <Q2>
3. <Q3>
```

At most 3 questions per fire, aimed at the thinnest sections, one per turn; each answer is written into the ISA before the next is asked. Stop early after two contentless answers in a row or when the principal says done.

## The proceed override

**`proceed` semantics:** the literal override is `proceed`, whole-response match only, trim + lowercase: `response.trim().toLowerCase() === 'proceed'`. Substring matches ("I want to proceed with X") are not the override and route to question 1's answer.

When the principal invokes `proceed` after seeing the questions:
1. Append a Decisions row: `YYYY-MM-DD HH:MM: ambiguity check fired, principal invoked proceed — reasoned defaults: <named defaults>`
2. Set frontmatter `context_sufficient: false`.
3. Verification surfaces the accepted defaults in `## Verification`/`## Log` as a known risk rather than a surprise.

## Re-check later

**Re-check later:** when late-surfacing information (a premortem result, a mid-build discovery) would have changed the ladder, Vision, or Out of Scope had it been known at scaffold time, re-run the rule, re-derive the ladder (L1 first, then L2 and L3, so the levels still agree), and log a Decisions row naming the shift. When the shift changes the destination rather than the wording, it goes to a Discuss align round before the changed part is built. Never blocks a phase transition.
