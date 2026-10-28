# Discussion — the shared interview primitive

The one interview engine behind the ISA skill's interviewing surfaces: **Discuss** (the standing alignment conversation: discover, align, deepen), **Interview** (deepening an existing ISA section by section), **Refine** (mid-run asks, asked in rounds of at most three at a breakpoint), Scaffold's ambiguity check, and Questionnaire's send-interview. Callers supply the topic, the artifact being filled, and the checkpoint file; this reference owns the mechanics so they are never duplicated.

**The point:** the ideal state lives in the principal's head, and articulation requires conversation. A discussion is done when shared understanding is reached — every branch of the design tree visited, nothing left silently assumed — and the artifact holds what was extracted. The point of the extraction is direction, the rule SKILL.md states. A round that costs the principal a minute and moves the ladder is the cheapest correction the system can make; a build of the wrong thing is the most expensive.

## Show the ladder first

When an ISA already exists (Discuss `align` and `deepen`, Interview, Refine), the round opens on where the ISA stands: L3 verbatim, then the L2 sentence and its bullets when they exist, then one line naming what is uncertain and why it surfaced (a restate correction, open asks, a drift verdict, fog, the principal's own words). The principal answers against the written ideal state, never against my memory of it. In `discover` there is no ladder yet; open on one line saying what I understand so far.

## The design tree and frontier rounds

Model the topic as a **design tree**: every decision branches into the decisions that hang off it. The **frontier** is every question whose prerequisites are already settled — the questions askable *now* without guessing at answers not yet heard.

- **Ask the whole frontier each round.** Use AskUserQuestion (up to 4 questions per call; chain calls in the same round when the frontier is larger). Number questions across the round.
- **Lead every question with a recommendation.** Present your recommended answer as the first option, marked "(Recommended)", with the real alternatives beside it — the principal confirms or overrides in one step. Fall back to free text only when the answer space genuinely won't bound into options.
- **On a low-confidence or high-stakes recommendation,** add a one-line strongest-objection to your own recommendation.
- A question whose answer depends on another question still open this round belongs to a **later** round. After each round, recompute the frontier — settled decisions unblock what depended on them.
- **In `align`, the frontier is the uncertainty only.** Ask about what surfaced the round and what hangs off it; leave the settled parts of the ladder alone unless an answer reopens them.

## The challenge question

Every round carries at least one question that pushes on the weakest point instead of filling a gap: the assumption the ladder leans on hardest with the least evidence, the strongest alternative direction stated as a real option, or the person the ladder forgets. Agreement is cheap; the challenge is what stops a discussion from ratifying the first framing. Name it as a challenge in the question text so the principal knows it is a test, and still lead with my recommended answer. When the principal holds the line, record it as a decision with the reason; the challenge did its job.

## Facts are the system's job; decisions are the principal's

Never ask the principal anything discoverable. When a frontier question needs a fact from the environment (code, files, deploy state, prior ISAs), look it up — Grep/Read inline, or dispatch a subagent for anything heavy — and don't block on it: only the questions downstream of a running lookup wait; ask the rest of the frontier now. Decisions, tastes, and intent go to the principal, always.

## Depth

The depth scales the session to the uncertainty, so a round is cheap enough to run every time one is owed.

| Depth | Shape | Default for |
|---|---|---|
| `quick` | One round asking the whole current frontier at once (usually four questions or fewer), folded, then the say-back | `align` |
| `full` | Rounds until a stop condition below fires | `discover`, `deepen` |
| `deep` | Sessions across days with a **coverage map**: the domain's components listed in the log block's first round (for a product its surfaces, for a program its workstreams, for a campaign its arcs), each marked open, partial or settled as rounds touch it; each session resumes at the open frontier and the map's open rows | ideal states too large for one sitting |

A `quick` round that opens more questions than it settles escalates to `full` with the principal's yes, never silently.

## No question cap

Stop conditions, in order of precedence:

1. The principal says stop ("that's enough", "proceed", "just build it").
2. The frontier is empty — every branch visited (in `deep`, every coverage-map row settled).
3. Two consecutive low-signal answers ("I don't know" / "skip") — log what's unresolved as open flags and close.

A count is never a stop condition. A well-formed topic may need three questions; a fog-bound one may need thirty.

## Checkpoint every round

Immediately after each round, write to the caller's checkpoint target — **canonically the target ISA's `## Articulation Log`**. Discuss writes through `bun LIFEOS/TOOLS/IsaAlign.ts checkpoint <isa> --topic "<topic>" --mode <mode> --text "<round>"`, Refine through `IsaAsks.ts answer`, and Interview, Restate and Questionnaire append by hand under the same rules: one dated `### YYYY-MM-DD HH:MM · <source>` block per session, Q&A pairs appended within it (each with the recommendation the principal was answering and their words verbatim), settled decisions promoted, needs-external-input items recorded as open flags. The principal should feel the artifact filling as they answer; the checkpoint survives context degradation on long sessions.

Two disciplines bind the log (full doctrine: `ISAFormat.md` § The Ideal State ladder): **append-only** — never edit an earlier block, reversals just append; and **no embedded headings** — no line inside a block starts with `#` (demote or blockquote headings in pasted content; an unquoted `### Criteria` forges a criteria section on a criteria-less ISA). Both writer tools enforce both.

## Fold every round, then say it back

The same turn as the checkpoint, the round's verdicts reach the ISA body: L1 is rewritten where an answer changed what the thing is, L2 and L3 are re-derived from it so the three levels still agree, criteria are added, split, tightened or killed (a destination change gets a `refined:` row in `## Decisions`), dim items go to `## Not yet specified`, and a negotiated term goes to `## Language`. Then the **say-back**: one line to the principal naming what moved ("L2 bullet 3 now covers offline use; ISC-14 added; ISC-9 killed"). When L3 or L2 changed, the session closes in the Restate shape (L3 and L2 verbatim, "is that right?"), and the drift check runs once the criteria settle.

## Sharpen the language as you go

- When the principal uses a term that conflicts with the ISA's `## Language`, call it out immediately and ask which meaning wins.
- When a term is fuzzy or overloaded, propose a precise canonical term.
- When concept boundaries are in play, invent a concrete edge-case scenario that forces precision.
- When the principal states how something works, check whether the record agrees; surface contradictions.

A term whose meaning had to be negotiated mid-discussion has caused a confusion by construction — it qualifies for `## Language` under the admission rule. Write it there when the caller's artifact is an ISA.

## Aspirational answers

Draw out the summit first, then make it concrete. Ask what the finished thing is like at its best for each person it touches, the version the principal would be delighted by, before asking what must not break; the ladder records the summit and the floor becomes criteria (ISAFormat § *What the ladder captures: the summit*).

When an answer is aspirational rather than concrete, push once for the concrete: "what would prove that?" If it can't be named, record an open flag, never a settled decision.

---

_The frontier-round mechanic is adapted from Matt Pocock's MIT-licensed skills repository._
