---
name: Superior
version: 1.0.2
evals:
  manual:
    reason: "whether the superior approach beats the one already planned is a judgment about the specific task"
    falsifier: "the reviewer finds the superior approach is the original plan restated with stronger adjectives, a gap closes with no executable change and no named real limit, the pass ran on the literal ask without stating an inferred scope and why, the inferred scope jumps to a whole system the ask does not point at, the scope map covers less than the inferred scope, or an ask with an unclear intended scope ran without the scope interview"
metadata:
  short-description: "Ask how a far smarter, fully informed, unconstrained mind would do this task, then close the gap between its approach and ours."
description: "Thinking skill for big problems that swaps the solver: reads the scope it was given, infers the scope the asker most likely means, maps that, then asks how a vastly smarter, fully informed intelligence with none of our habits or invented limits would do it, and turns every gap between its approach and ours into a change we can make. Built for large scope (how a whole system is implemented, an architecture, a strategy); when the intended scope is unclear or too small, a short interview settles it first. USE WHEN superior, how would a smarter intelligence do this, what would a genius or superintelligence do, if you knew everything, are we thinking too small, best possible approach, how should this whole system be built, analyze how this big thing is implemented. NOT FOR constraint teardown (FirstPrinciples), many options (BeCreative), attacking a plan (RedTeam)."
---

# Superior

Every approach we take is shaped by the mind taking it: what it happens to know, what it has seen done before, what it assumes is expensive or impossible, how much effort it expects to spend. Superior holds the task fixed and replaces that mind. It asks how an intelligence far beyond ours would do this exact task — one that knows everything relevant including the current frontier, carries no habits or inherited conventions, invents no constraints, reasons cleanly from first principles, and cares only about the real goal behind the request. Then it measures the distance between that approach and the one we were about to take, and closes as much of it as reality allows.

Superior is built for big problems: how a whole system is implemented, an architecture, a strategy, a multi-part build. On a one-function question the superior mind and ours give the same answer, so the pass earns nothing. The value appears at scale, where habits and invented limits compound across many decisions.

FirstPrinciples changes what we believe about the problem. Superior changes who is solving it. They pair well: Superior often surfaces a constraint we invented, and FirstPrinciples is the tool for proving it was invented.

## Ideal State

- The pass runs at the proper scope of § Scope Comes First and states it in one line with its reason; an ask too small to earn anything is widened by a scope interview or by stating the inferred scope, never run on the small scope as given. A scope the caller fixed runs as given, with no interview.
- The superior approach comes from the mind defined in § The Superior Mind, written before our current plan is reread (or by a blind agent when anchoring is likely), and is concrete enough to execute.
- Every difference between that approach and ours ends as an executable change or a named real limit, and no constraint the principal actually set is dropped.

## Intent Routing

| Intent | Trigger | File |
|----------|---------|------|
| **Elevate** | any Superior request; invoked as a thinking skill on a hard task | `Intents/Elevate.md` |

## The Superior Mind

The lens is defined by what that mind has and lacks, never by adjectives like "more careful" or "more thorough":

- **It knows the field.** The best existing methods, the frontier work, the tools and prior art we have not heard of, how experts in adjacent fields solve the same shape of problem.
- **It sees the goal, not the ticket.** It may reframe the task, solve a bigger version that makes this one trivial, or show that the task should not exist.
- **It invents no limits.** Time, cost, tooling and "how it's done here" are questioned unless they are physics or a constraint the principal actually set. Real constraints it respects completely.
- **It reaches for leverage.** It looks for the one move that makes most of the work unnecessary before doing the work.
- **It is not anchored.** It never saw our first idea, so it is not improving our plan; it is producing its own.

## Scope Comes First

The pass begins from the scope it was given (the named file, feature, system or question) and works out what the asker most likely means by it. The literal ask is evidence, not the boundary: "how is the login implemented" usually means the auth flow end to end, not the one handler that was opened, and almost never means the whole product.

Abstract up to the proper scope, and no further. The proper scope is the smallest unit that contains the real goal: the level where the decision the asker cares about actually lives, reasoned from what was named, the surrounding conversation, the project, and what the answer will be used for. "The whole system" is the scope only when the ask points there. The result is stated before mapping, in one line: `Scope: <inferred scope>, from <what was asked>, because <reason>.`

When the inference is not confident, Elevate's scope interview settles it. Its questions find the right level: what this belongs to, what decision the answer feeds, and how far to reach (this piece, the feature, the subsystem). A scope the caller already fixed is the scope.

## Data & Config

User customizations, when present, live at `<configRoot>/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Superior/` (configRoot is `$CLAUDE_CONFIG_DIR` when set, else `~/.claude`). Any PREFERENCES.md, configurations, or resources there override the defaults; when the directory does not exist, proceed with skill defaults.

## Gotchas

- **Scope is inferred, never defaulted (principal, 2026-10-09).** There are two failures. Run on the literal file or function named, and the superior approach matches ours with an empty gap table. Jump to "the whole system" by default, and the pass maps something nobody asked about. The first version of this rule made the second mistake. Reason from the ask to the level where the real goal lives, and say why in the scope line.
- **Anchoring is the main failure (design-time, 2026-10-07).** Run inline after a plan already exists, the "superior" answer comes back as that plan with adjectives. Full mode exists for this: the agent sees the goal and the real constraints, never our draft.
- **Full mode audits the facts in the brief, not just the plan (2026-10-07, first real run).** Asked how to reach a target figure, the blind agent first checked the baseline it was handed and found it overstated, because the tool reporting it had been built that same day. Hand it the sources behind every figure, not only the figures, so it can do that.

## Examples

**Example 1: Hard design work**
```
User: "Design the sync layer for the notes app. Run Superior on it."
→ Elevate, full mode: scope map of the app, server API and clients first; a fresh agent gets the map, goal and constraints, never our draft design
→ It returns a CRDT-based local-first design; we had planned server-authoritative REST with conflict prompts
→ Gap table: knowledge (CRDT libraries are mature), convention (server-as-truth), invented constraint ("offline is an edge case")
→ Changed plan adopts local-first; the one real limit (existing server API) is kept as a migration path
```

**Example 2: Ask too small to run**
```
User: "Superior on this retry helper."
→ The helper alone is too small, and it has callers in two places, so two scopes are plausible
→ Elevate asks: "I'd read this as the job runner's retry path; is that right, or is it the HTTP client?"
→ Principal: "Job runner; jobs keep double-firing."
→ Scope: the job runner's retry and dispatch path, not the whole runner; the map shows retries in three layers; the superior approach is idempotent jobs, which makes the helper unnecessary
```

**Example 3: Inline lens during a max-effort run**
```
A depth turn ("think deeply") on a strategy question; Superior runs beside FirstPrinciples
→ Elevate, light mode: one inline pass, stated before the current plan is reread
→ Superior approach dissolves half the task by reframing who the audience is
→ Two gaps adopted, one blocked by a principal-set budget, recorded in the ISA Decisions
```
