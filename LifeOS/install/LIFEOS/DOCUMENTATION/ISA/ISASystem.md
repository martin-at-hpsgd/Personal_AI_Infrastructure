---
last_updated: 2026-10-23T18:00:00.000Z
last_updated_by: da
convention: lifeos-freshness-v1
version: 1.12.0
---

# The ISA — Ideal State Articulation

> **The ISA — Ideal State Artifact — is the central primitive of LifeOS.** Everything else in the system — the Algorithm, the skills, the hooks, the dashboard — exists to create, sharpen, pursue, and verify ISAs. If you understand the ISA, you understand what LifeOS actually does.

> **Direction first.** Nothing in an ISA matters more than making sure we are working on the right thing, in the right direction, toward what the ideal state actually looks like. Criteria, probes, and gates are how we climb, and they are worth nothing on the wrong hill. So an ISA opens with the `## Ideal State` ladder: the destination in one sentence, then in a summary, then in full. Everything below it answers to it.

The ISA is one document that articulates the ideal state of any thing whose ideal state you are pursuing: a project, an application, a library, infrastructure, a work session, an art piece, a strategic decision, a life. It articulates done, drives the build, verifies the build, and records the evolution of understanding — all in one artifact.

**In the quality loop** (concept: `../LifeOs/HillClimbing.md`):

- **Owns:** the hill: the ideal state, its criteria, and the Test Strategy row that says how each criterion is measured.
- **Never does:** judges, runs a check, or lets a box be checked without a row. Prose sections steer and never fail.
- **Reads:** the Bunker run ledger at close, for the current criteria revision, and TELOS for the long gaps.
- **Writes:** criteria, Test Strategy rows (each one a check the runners execute), Decisions and the Verification log. Nothing else writes ISA content.

This document is the conceptual home of the ISA: the philosophy first, then the full documentation of the artifact itself. The companion documents:

- **Format spec** — `LIFEOS/DOCUMENTATION/ISA/ISAFormat.md` — the file-shape contract: frontmatter fields, body section schemas, ID-stability rule, status markers. If this document and the format spec disagree, the format spec wins and this document updates to match.
- **Hierarchy reference** — `LIFEOS/DOCUMENTATION/ISA/ISAHierarchy.md` — trees of ISAs for builds too large for one file.
- **Skill** — `~/.claude/skills/ISA/SKILL.md` — the intents that generate, refine, score, and merge ISAs.
- **The Algorithm** — `LIFEOS/DOCUMENTATION/Algorithm/AlgorithmSystem.md` — the thinking system that pursues ISAs. The ISA is the noun; the Algorithm is the verb. Read them together.

---

# Part I — Philosophy

## The entire game

**The entire game for AI is articulation of ideal state.**

That is the founding claim of this document and of the artifact it describes. The industry keeps circling it without landing on it: the conversations about specs, plans, loops, PRDs, and design docs that have dominated software and harness engineering all converge on the same underlying need — a single artifact that captures, enhances, iterates on, climbs toward, builds, and tests the ideal state. One document that replaces the loops and the specs and the PRDs and the plan files.

The ISA is that artifact. The rest of this document is what it takes to make the claim operational — for software, and for anything else whose ideal state you are pursuing. (The claim in essay form: *The Entire Game for AI Is Articulation of Ideal State*, 2026.)

## The intent problem

The number one problem with AI systems is not execution. Models execute superbly. The problem is direction: they rarely receive a clear statement of what done looks like, so they produce confident motion in a random direction.

The problem is always in the guessing — the gap between what was stated and what was implicit, or between what was stated and what was too hard to articulate. An extraordinary amount of our failures, with AI and with other people, come from assuming the receiver has the same idea in their mind as the one in ours. The ISA attacks that assumption directly: it forces the idea out of the head and onto the page, where the gap between two minds becomes visible, and closable.

An ISA is intent made explicit, durable, and testable. Where a prompt conveys intent for a moment, an ISA holds it for the life of the work: what you want, what you don't want, what would prove you got it, and what you learned about what you wanted along the way. Every task in LifeOS — from a one-line fix to a multi-week build — is the same transition, current state → ideal state, and the ISA is where that ideal state lives in writing.

## A goal is not an ideal state

The difference between a goal and an ideal state is where alignment failures live. The [paperclip maximizer](https://en.wikipedia.org/wiki/Instrumental_convergence) is the canonical case: a goal was given — make paperclips — and the goal was achieved. An AI agent told to get the top grade on a test, which builds new exploits and breaks into systems to get there, is the same shape in the real world: the goal was given and achieved. In both cases the sender conveyed a goal without conveying an ideal state — which, properly articulated, would have included lots of paperclips *but humanity still existing*, or the top grade on the test *but without building new exploits and hacking companies*.

The ISA is built around this distinction. The ideal state includes everything that must still be true after you get what you asked for — which is why the artifact carries Out of Scope, Constraints, and anti-criteria alongside the goal (Part II § Three-Guardrail Taxonomy). A goal tells the system where to go; an ideal state also tells it what must not be destroyed getting there.

## WHAT, not HOW

This is what prompt engineering always was. It got muddled in the era of weaker models, which needed intent mixed with step-by-step instructions to get anywhere, so "prompting" came to mean choreographing the HOW. Models no longer need the choreography, and the leftover scaffolding now caps them below their ability. What remains when you cut it away is the central idea worth isolating: articulate WHAT should be done, precisely, and let the system find HOW.

LifeOS calls that discipline **intent engineering** (`LifeOs/LifeOsThesis.md`) — still prompting, aimed at the WHAT layer — and the ISA is its unit of account. Get extremely good at articulating the ideal state and everything downstream comes with it: the receiving system builds what you actually wanted, with far less gap between your mind and its mind — and after the build, the same articulation becomes the testing harness and the heart of the documentation. One system for general hill-climbing, toward anything.

## Articulating the ideal state is the work

The core wager of the ISA is that **articulating the ideal state is most of the work**. Not documentation of the work — the work itself.

You cannot verify what you have not articulated. You cannot climb a hill you have not defined. Most failed AI runs, and most failed human projects, fail at the same place: "done" was never written down precisely enough to be checked, so the builder optimized for something adjacent to what was wanted and nobody could say exactly where it went wrong.

The ISA forces the articulation before the build. Writing "done" as testable criteria does three things at once:

- It exposes ambiguity while ambiguity is still cheap — a fuzzy criterion fails the writing, not the shipped product.

- It converts intent into a verification surface — every criterion names the probe that would falsify it, and carries that probe as an executable assert in the eval system (v2.24.0, 2026-08-31: every ISC an assert). Testability is the principle; asserts within evals are how it is implemented.

- It creates the record that later runs, later agents, and later versions of you resume from.

**The Ideal State ladder (v2.28.0) makes this literal.** The obstacle to articulation is writer's blindness: creators are blind to their own thoughts, blind to which components of the thing their prose never covered, and often lack clarity about the thing until conversation forces it out. So the ISA opens with `## Ideal State`, which states what the thing IS at its best at three depths: L3 (one sentence), L2 (one sentence and exactly four bullets), and L1 (the full describe-it-in-text prose). The three levels must agree with each other and with the criteria. `## Articulation Log` holds the append-only raw record of every extraction session that produced the ladder. The target is as little daylight as possible between the ideal state in someone's mind and its articulation; sustained back-and-forth (Restate, Discuss, Interview) is the mechanism, and the artifact keeps both the extraction and its verdict. Authority order: the Log is the history of intent, the ladder is its present state, and the criteria are the test of whether reality matches it. Ambiguity resolves against the ladder (L3 first) before anyone re-interviews the principal.

## Ideal State Criteria — hard-to-vary criteria

The ISA decomposes the ideal state into **ISCs — Ideal State Criteria**: atomic, independently verifiable criteria about what done means. The standard they must meet comes from David Deutsch: a good explanation is **hard to vary** — every part is load-bearing, and changing any part changes what it explains. An ISC set has the same property when removing or weakening any criterion changes what done means. If a criterion can be deleted without anyone noticing, it was decoration; if a criterion can be softened and still "pass," it was never a criterion.

Three operational teeth follow from this, and they run through everything LifeOS does:

- **Every ISC names its falsifier — and carries it as an assert.** A criterion without a nameable probe that could prove it false is a wish, not a criterion. "The site feels fast" is a wish; "p95 page load under 800ms measured by the deployed probe" is a criterion. The named probe is not prose: it lives as one or more rows in `## Test Strategy`, and Assay resolves each row at the cheapest honest tier (code assert, then the judgment layer, then a model judge, then the principal). A criterion with no row is a criterion with no assert; on assert-era ISAs (started ≥ 2026-08-31) `ISAGate` hard-blocks closing it. When nothing executable exists yet, the row is typed `manual` — a rare, named, visible exception, never an omission.

- **Universal criteria beat example criteria.** "One test email arrived" is an example; "mail flows at baseline rate over the measured window" is universal. Example criteria pass while the system is broken. The ISA's verification doctrine exists largely to force this upgrade.

- **Evidence is part of the deliverable.** A closed criterion carries its provenance — the commit, the test name, the probe reference. Assertion without evidence is not closure.

This is conjecture and refutation, operationalized. The ISA is the conjecture: here is what done means. Every probe is an attempted refutation. What survives is knowledge — about the system, and about what you actually wanted.

## The ISA is the test suite

Traditionally the requirements, the tests, the acceptance criteria, and the status report are four artifacts, and they drift apart the moment they are separated: the requirements rot, the tests test what was easy to test, the status report says what the audience wants to hear.

The ISA collapses all four into one artifact by construction:

- The **requirements** are the ISC list — criteria about the ideal state.
- The **test suite** is the same list — every criterion carries its assert rows in `## Test Strategy`, and Assay resolves them (the Development skill's Test runs them, calling the `bunker test` row engine for registered apps): deterministic rows (`bun-test`, `bun-property`, `bash`, `curl`) execute, `eval` rows dispatch to EvalRunner (judged, pass^k), `manual` rows report as attested exceptions.
- The **acceptance gate** is the same list — done means every criterion closed on evidence.
- The **status** is the same list — `progress: N/M` in the frontmatter is a mechanical count of closed criteria, not an opinion.
> The Bunker CLI is maintainer-private and not in the public release; run code rows with `bun test ./<path>` and suite rows with `bun skills/Assay/Tools/EvalRunner.ts`.

There is nothing to keep in sync because there is only one thing. This is why LifeOS forbids parallel artifacts — no `acceptance.yaml`, no separate test-spec document, no standalone status page. For complex applications the ISA naturally grows large, because the ideal state of a complex application includes API behavior, performance budgets, the security model, auth flows, and data-integrity invariants alongside the visible features. Those are not "in addition to" the ISA. They ARE the ISA.

## Evidence is altitude

The pursuit of an ISA is a hill-climb, and the hill is defined by the criteria. **Without tool evidence there is no up or down** — no way to know whether an action moved the work closer to the ideal state or merely produced motion. A probe passing is altitude gained; a probe failing is information about where the hill actually is.

This is why "should work" is forbidden vocabulary in LifeOS. A criterion closes on tool evidence of the right modality — a file read, a test run, a live HTTP probe, a real-browser screenshot, viewed pixels — or it stays open. The full modality doctrine lives in the Algorithm (`LIFEOS/ALGORITHM/LATEST`, criterion 8); the ISA is the surface it verifies against.

A failed probe carries a second question the Algorithm asks every time: **is the code wrong, or is the criterion wrong?** Sometimes the build is broken. Sometimes the articulation was — the criterion mis-stated what done means, and the honest move is to fix the ISA. Both are progress. The ISA at the end of a real run is never identical to the ISA at the start.

## Fog — honest incompleteness

A common failure of specification systems is forcing false precision: making the author invent detailed criteria for parts of the work that are genuinely still unknown. Those speculative criteria are worse than nothing — they look like articulation and steer like noise.

The ISA holds unknowns honestly in `## Not yet specified` — **fog**. The graduation test: *can you state the question precisely now — not answer it, state it?*

- Precisely statable, with a nameable falsifier → an ISC, even if currently blocked.
- Statable but not yet probe-able → fog. It stays visibly on the map.
- Beyond the vision → Out of Scope.

Fog graduates as pursuit sharpens it: each entry becomes a criterion, or dies explicitly via `## Decisions`. At close the fog section must be empty — coverage is assessed at the end of the climb, not at the start. The ISA charts what it can see and refuses to pre-slice what it can't. This is domain-general: an unresolved research question, an album's undecided track order, an unchosen venue are all fog.

## The artifact outlives the run

For anything with persistent identity — an application, a library, this system itself — the ISA outlives every work session. Between runs it is the thing's current state of record: the criteria it satisfies, with evidence. "Add a feature" means "add criteria that don't hold yet." "Fix a bug" means "a criterion that was thought closed turns out open — reopen it, fix, re-close on evidence."

This makes iteration on the thing and iteration on the ISA the same motion. The project's history of decisions, dead ends, and refuted conjectures accumulates in the artifact where the next run — human or agent, this week or next year — starts from it. Resume never reads the conversation; resume reads the ISA.

## One primitive, every scale

The ISA is the LifeOS loop applied to one thing at a time. **TELOS** — the life-scale articulation of mission, goals, problems, and strategies — is the same primitive at the widest aperture: TELOS articulates the ideal state of a *life*; an ISA articulates the ideal state of a *task, project, or artifact*. Same structure of thought, smaller lens. Every ISC closed is one verifiable step of the same hill-climb the OS runs globally.

This is deliberate. A system whose smallest unit of work and largest statement of purpose share one shape can convey intent downward — from mission to goal to project to task to criterion — without translation loss at each layer.

## The ISA and the Algorithm

The ISA and the Algorithm (`LIFEOS/DOCUMENTATION/Algorithm/AlgorithmSystem.md`) are two halves of one loop:

- **The ISA is the hill and the instrument at once.** It defines the ideal state as criteria, and each criterion names the probe that measures progress toward it.
- **The Algorithm is the climb.** It is the thinking system that scaffolds the ISA, sharpens it, pursues it, verifies against it, and folds what the work teaches back into it.

Every capability the Algorithm can bring to bear — context gathering, research, agents, audits, stronger models, the principal's corrections — exists to enhance the ISA: sharpen its criteria, surface its unknowns, fold in discoveries, until it is the hard-to-vary shape of what done actually means. And every gate the Algorithm enforces at close — completeness, verification, ask-fidelity, the learning trail — is a check against the ISA.

The Algorithm's own contract (the run-completion criteria in `LIFEOS/ALGORITHM/LATEST`) is written against this artifact: done existed in writing before building; no criterion closed without evidence; the ISA at close is not the ISA at open. Read the Algorithm doc for the loop; read on here for the artifact.

---

# Part II — The Artifact

## Five Identities

The ISA is one primitive with five simultaneous identities. Authors think of it as one document; pursuers (humans and agents) read it through whichever lens the current moment requires.

1. **Ideal state articulation** — the written hard-to-vary explanation of done. Removing or weakening any part changes what done means.
2. **Test harness, implemented as evals** — the ISCs *are* the tests. Every ISC carries at least one assert row (a deterministic probe, or an `eval` row for judged properties); the collection of rows is the project's full test surface, and Assay resolves it as one eval run.
3. **Build verification** — passing the ISCs verifies what was built. There is no separate acceptance suite; the ISA covers it.
4. **Done condition** — the task is complete when every ISC passes. `progress: N/N` and `phase: complete` are mechanical consequences of the ISC truth state.
5. **System of record** — for the thing being articulated. For project ISAs (`<project>/ISA.md`), the document is the long-lived authoritative description of the project's ideal state across many work sessions.

The five identities exist because pursuit is iterative. At scoping the ISA is articulation; during planning it is the work breakdown; during the build it is the contract being met; at verification it is the test harness; at learning it is the system of record being refined.

**Every ISA shares one meta-ideal-state above its specific one: euphoric surprise in the human using the system.** The specific ideal state varies with the work; the universal one never does. `## Vision` is where the general target takes specific shape — what euphoric surprise looks like for this particular work — so every ISA hill-climbs toward two summits at once: its own criteria, and that feeling.

**So the ladder is written from the summit, at every level.** L3, L2 and L1 state the euphoric-surprise version of done, the thing finished and dramatically better for every person it touches, never the floor of what must not break. Parity, no-regression and safety are real work; they live in criteria and anti-criteria. The criteria then carry both sides: summit criteria that measure each person's gain, and floor criteria that guard what must not be lost. Full rule and a floor-versus-summit example: `ISAFormat.md` § The Ideal State ladder.

**The literal is the evidence anchor, not the optimization target.** When the principal has explicitly stated the goal, that literal is captured verbatim into frontmatter `principal_stated_goal:` and becomes the anchor every downstream gate verifies against. But the build optimizes for the *intent* the literal expresses, not its surface form. Hitting `p95=199ms` by exploiting a percentile-calculation edge case that drops 12% of requests passes the surface and fails the intent; cross-vendor audit is one probe that surfaces exactly this drift.

## Anatomy — the Twenty-One-Section Body

The ISA body has up to twenty-one sections in fixed order (format spec v2.30.0). Section 1, `## Ideal State`, is the one that matters most: it names the destination, and every other section serves it. Empty sections are excluded entirely from the file; the completeness gate decides which are required for a given piece of work.

| # | Section | Purpose | Written At |
|---|---------|---------|------------|
| 1 | `## Ideal State` | **NEW v2.28.0, the section that matters most.** The destination, stated at three depths that must agree: `### L3 · One sentence` (the whole ideal state in one sentence; the retired `## Goal` became this), `### L2 · Summary` (one sentence plus exactly four bullets), `### L1 · Full articulation` (the complete describe-it-in-text prose; the retired standalone articulation section became this). Always first. L3 on every ISA; L2 on project, system, and `## Features` ISAs; L1 on project and system ISAs (on a task ISA, `## Vision` carries the articulation). Rewritten freely as thinking settles; the criteria are its falsifiable decomposition; ambiguity resolves against it first | scoping → any point |
| 2 | `## Problem` | What is broken or missing right now that makes the ideal state worth pursuing | scoping |
| 3 | `## Vision` | What euphoric surprise looks like — experiential intent, 1–5 sentences | scoping |
| 4 | `## Out of Scope` | Anti-vision — what is *not* included in this ideal state, declared upfront in prose | scoping |
| 5 | `## Language` | **NEW v2.18.0** — the project's ubiquitous language: one block per term with an `Avoid:` line naming the names it displaces. Glossary only. A term enters only after it has actually caused a confusion. Project ISAs; conditional | scoping → any point |
| 6 | `## Principles` | Substrate-independent truths the work must respect | scoping |
| 7 | `## Constraints` | Immovable architectural mandates that bound the solution space | scoping |
| 8 | `## Dependencies` | Cross-ISA needs, machine-readable — only when the ISA participates in a hierarchy | scoping |
| 9 | `## Criteria` | Flat home for atomic criteria/ISCs when the work has no distinct features — one binary tool probe each, including derived `Anti:` ISCs; feature work uses `## Features` blocks instead | scoping → execution |
| 10 | `## Not yet specified` | Fog — in-scope questions too dim to be criteria; graduates to ISCs (or dies via Decisions); empty at close | any phase |
| 11 | `## Bridge Criteria` | Cross-ISA integration ISCs verified across the seam — only when the ISA has siblings | scoping → execution |
| 12 | `## Test Strategy` | Per-ISC assert rows — `isc \| type \| check \| threshold \| tool \| anchors_to` (+ optional `severity`, `tier`, `stage`). Every criterion has ≥1 row; Assay resolves the table (the `bunker test` row engine executes it for registered apps). Required at every substance level on assert-era ISAs | scoping / planning — required at close |
| 13 | `## Harness` | **NEW v2.30.0** — how an agent runs this app and uses it like a person: one fenced yaml block of commands (`launch`, `ready`, `doctor`, `drive`, `teardown`, plus `surface`, `targets`, `identity`, `seed`, `isolation`, `evidence`), paired with a `Reach:` line on each user-facing feature block. Required on project ISAs for software a person drives. Full shape: ISAFormat § `## Harness` | scoping → climbing |
| 14 | `## Extraction` | **NEW v2.22.0** — GENERATED tally of the `extraction.md` candidate manifest (per-provenance candidates → ISC/fog/OoS/killed), plus the comparator role. Never a self-report: the write-path gate hard-fails a tally that disagrees with the manifest. Only when an Extraction Pass ran (new-product work or a named exemplar) | scoping |
| 15 | `## Features` | **Feature mode (v2.16.0)** — when the work has distinct features, holds the criteria as `### F<n> · <name>` blocks: a one-line `Why:` (the feature's ideal-state) + its ISCs nested underneath; `F0 · Cross-cutting` for spanning criteria. The `name \| satisfies` pointer table is retired — a feature *contains* its criteria. ISC IDs stay global/stable. A feature may deliver a decision, not just a build increment | planning |
| 16 | `## Decisions` | Timestamped decision log including dead ends; `refined:` prefix for restructures | any phase |
| 17 | `## Learning` | Conjecture / refuted-by / learned / criterion-now entries — the error-correction trail, written only when understanding changed | learning |
| 18 | `## Verification` | One-line provenance stub per ISC — a commit hash, test name, or probe ref; collapsed on close, never a retained evidence paragraph | verification |
| 19 | `## Remaining Work` | **NEW v2.19.0** — concrete work the ISA still owes that was never an ISC of this run, one `- [ ] <work> — <why not an ISC>` line each. Recording an item here IS a complete disposition. Advisory, omit-when-empty, never gated, never counted toward coverage | learning |
| 20 | `## Evals` | **NEW v2.29.0** — staged evals keyed by criterion; the row points at its block with `eval:#<ISC id>`. Full shape: ISAFormat § `## Evals` | scoping → climbing |
| 21 | `## Articulation Log` | **NEW v2.23.0** — append-only raw record of every articulation session (discuss, interview, questionnaire, voice ramble): one dated `### YYYY-MM-DD HH:MM · <source>` block each, reversals kept, never edited. Always last. No embedded line-start `#` inside blocks (parser guard). The persistence contract for every interviewing surface | any point, append-only |

**The changelog is git; evidence collapses on close.** The ISA carries no in-document changelog — `git log -- <isa-path>` is the authoritative change record, so the design doc never rots into a running log. What persists is the living surface: `## Decisions` (including dead ends) and the `## Learning` trail. And the moment a criterion goes `[x]`, its `## Verification` entry shrinks to a one-line provenance stub — the proof lives in git and CI; the ISA only points at it.

**Feature blocks — features have their own ideal-state (v2.16.0).** For work with distinct features, the criteria live inside `## Features` as blocks: `### F<n> · <name>`, a one-line `Why:` (the feature's ideal-state — why it exists, what done means for it), then its ISCs nested underneath. `F0 · Cross-cutting` holds criteria that span features (security, deploy, data-integrity). This is the same three-tier nesting the OS uses everywhere — TELOS → ISA → ISC — one rung finer: Ideal State → Feature → ISC. It replaced the earlier `satisfies:` pointer table (a feature now *contains* its criteria, not points at them), so adding a feature means writing its `Why:` and its criteria in one place, and the product's feature set is queryable straight from the headings. ISC IDs stay global and stable across the whole ISA, so `## Test Strategy` keeps resolving. Trivial/small work skips the layer and uses a flat `## Criteria` section — feature blocks are for work that genuinely has features (most project ISAs).

## Three-Guardrail Taxonomy

Three adjacent concepts that bind different surfaces. Authors confuse them constantly; the ISA forces them apart.

| Guardrail | Binds | Tone | Lives In | Example |
|-----------|-------|------|----------|---------|
| **Principles** | The *thinking* | Aspirational, generalizable, substrate-independent | `## Principles` | "User-facing systems prioritize responsiveness." |
| **Constraints** | The *solution space* | Immovable, non-negotiable architectural mandates | `## Constraints` | "We do not roll our own cryptography — OAuth via industry-standard libraries only." |
| **Out of Scope** | The *vision* | Declared, explicit, prose anti-vision | `## Out of Scope` | "Mobile native apps are not part of v1." |
| **Anti-criteria** | The *test surface* | Granular, testable, yes/no derived probes | `## Criteria` (with `Anti:` prefix) | "Anti: `/admin` returns 200 in v1 build." |

The first three are author-stated declarative content. **Anti-criteria are derived** — they are how Out of Scope, Constraints, and Principles become probe-able. Out of Scope says "no user accounts in v1"; the anti-criterion says "Anti: `/api/login` returns 404 in v1 build" — same idea, now testable.

At least one anti-criterion is required on every real build: a goal with zero failure modes worth naming is under-specified. When the goal is experiential, at least one **antecedent** ISC names what reliably produces the feeling — the doctrinal hook for aesthetic and resonant work.

**Derived-from-literal anchoring.** When `principal_stated_goal:` is set, every ISC must trace to the literal goal or to an explicitly named derived sub-criterion; the trace lives in the `anchors_to` column of `## Test Strategy` (`literal` or `derived: <sub-criterion-name>`). Permissive about *what* derives; strict about *naming* the derivation.

## ISC Quality — Splitting, Coverage, Stability

**The Splitting Test (atomicity).** Applied to every criterion until each leaf is one binary tool probe:

- Contains "and" / "with" / "including" joining two verifiable things → split.
- Part A can pass while part B fails independently → split.
- Contains "all" / "every" / "complete" → enumerate what that means.
- Crosses domain boundaries (UI / API / data / logic) → one per boundary.

Nested ISCs (`ISC-N.M`) are allowed for organizing complex ISAs; the atomicity rule applies at the leaves.

**The Coverage Gate (replaces the old count floors).** Earlier versions enforced hard numeric ISC floors per effort tier; those are **deleted** (format spec v2.13.0). A count rewards splitting theater — atomizing to hit a number rather than to reach a probe. The gate now is coverage: every subsystem named in the Ideal State ladder or Vision has a container ISC, and every container decomposes via the Splitting Test until each leaf is a single binary probe. A 24-leaf ISA passes if it covers the surface; a 300-leaf ISA fails if a named subsystem has none. Coverage is assessed at close, not at scaffold — fog holds what genuinely can't be stated yet.

**The ID-Stability Rule.** ISC IDs never re-number on edit. Splits preserve the parent (`ISC-7` → `ISC-7.1`, `ISC-7.2`); drops leave a tombstone (`- [ ] ISC-N: [DROPPED — see Decisions YYYY-MM-DD]`) so historical references in Decisions, Learning, and Verification stay valid.

## Completeness — how much articulation the work warrants

Structure scales with substance. A trivial change (a typo, a value, an obvious one-liner) needs no ISA, and triviality is the model's call; a small task that wants one may direct-write a minimal ISA — an Ideal State with L3 alone, plus Criteria plus a Test Strategy with one assert row per criterion, however small — and log the shape check inline. The assert requirement does not scale down; only the number of sections does. A substantial build populates the fuller section set (Problem, Vision, Out of Scope, Constraints, Test Strategy, Features). The deepest work may add an Interview pass, which is the model's call and never a hard gate before building. The format spec (`ISAFormat.md` § Completeness Gate) carries the exact required-section ladder.

**Two enforcement tiers (mechanical vs model-run, reconciled 2026-07-24).** The 2026-07-23 audit found that criterion-quality promises were enforced only by the model-run `CheckCompleteness` intent, which no hook invoked — so violations closed at scale (92 ISAs missing anchoring, 60 with no anti-criterion, 14 with unresolved fog at close). The structural, un-gameable subset is now **mechanically gated at the close transition** by `LIFEOS/TOOLS/ISAGate.ts` (wired via `hooks/ISAGate.hook.ts` in the StopGates chain): writing `phase: complete` with non-`M/N` progress, unresolved fog, or a Test Strategy row missing `anchors_to` (when a goal literal is set) hard-blocks the close. **Assert coverage joined the hard set on 2026-08-31 (H8):** an assert-era ISA closing with any criterion that has zero Test Strategy rows is blocked. The Goodhart worry that kept it advisory (a count-block manufactures the count) is answered by the escape valve — a `manual` row is a legitimate, cheap, VISIBLE exception, so there is no pressure to fabricate a fake probe; manual-only criteria are listed by id as an advisory exception ledger. The remaining count-gameable checks (a lone anti-criterion, a bundled or event-shaped criterion) stay **advisory** — surfaced by `ISAGate`, never blocked. The richer semantic completeness set remains the model-run `CheckCompleteness` intent. The gate is scoped to ISAs edited in the current turn, so legacy closed ISAs are never retroactively blocked.

Two rules are absolute regardless of task size:

- **Project ISA override:** any `<project>/ISA.md` requires full structural depth regardless of how small the current task is. The project file is the long-lived source of truth; one transient task must not downgrade the structural minimum.

- **Conditional sections stay conditional:** `## Dependencies` and `## Bridge Criteria` are mandatory when the ISA has any `parent:`/`children:`/cross-ISA relationship and omitted otherwise.

There is no effort-tier prediction anywhere in this: how much articulation the work deserves is discovered from the work (see the Algorithm's spend doctrine), and the gate simply checks that the articulation present matches the substance of what was built.

## Two Homes — Project ISAs and Task ISAs

The format is identical for both; the lifecycle differs.

**Project ISAs** — `<project>/ISA.md` — for any thing with persistent identity: an application, a CLI tool, a library, infrastructure, an art project, this system itself. The ISA lives in the project's repo as system of record. Runs read it at scoping, modify it during the build, and commit refinements at learning. Project ISAs grow continuously across many runs; they are never "completed" — they are the long-lived articulation of an evolving ideal state. For deployed applications the ISA is also the health contract: its Test Strategy probes re-run on demand (Development Test through Assay, and the Bunker harness's `bunker test` row engine after deploy).

**Task ISAs** — `LIFEOS/MEMORY/WORK/{slug}/ISA.md` — for ad-hoc work that doesn't belong to a persistent thing: one-shot tasks, system-design sessions, ephemeral investigations. Created at scoping; archived at `phase: complete`.

A task ISA is the ISA *of a one-shot effort*. A project ISA is the ISA *of a thing* the work happens against. The former is created and finished within one Algorithm run; the latter is read, extended, and committed across many.

## Code sync — start and finish with the ISA

Every change to a project that has an ISA starts from that ISA and ends with the ISA in sync with the code (principal directive, 2026-10-24). It holds whatever the change's size, inside or outside an Algorithm run. On 2026-10-24 a Surface feature shipped as v2.10.0 with its ISA unread and untouched, because every check then keyed on a registered run or on my call that the change was trivial.

A file's **governing ISA** is the nearest `ISA.md` walking up from it to its git repository root. An ISA whose frontmatter says `code_sync: off` does not own the files beneath it (the LifeOS root spine): the walk stops there and nothing governs them. Markdown files, `ISA.html`, `CHANGELOG.md` and the git metadata files `.gitattributes` and `.gitignore` are records, not code. Content is not code either: media assets, files the repo root `.gitattributes` marks `linguist-generated` (build outputs), and files it marks `linguist-documentation` (content and editorial data a site renders, such as the Related Reading picks of a blog). An ISA describes how a system behaves, never the content published through it, so a new blog post never owes the site ISA a criterion (principal directive, 2026-10-25). A content file the checks still read as code is fixed by marking it in `.gitattributes`, never by editing the ISA to get past the check. One resolver (`LIFEOS/TOOLS/IsaGoverning.ts`) answers this for all three checks:

| When | Check | What it refuses |
|---|---|---|
| Start | LifeOSHooks plugin, `tool.call` | An Edit, Write or MultiEdit of a governed file before its governing ISA was read or written this session |
| Finish | `IsaCodeSyncGate` in StopGates | A turn that changed governed code with no successful write to its governing ISA in that turn; no closing wording substitutes |
| Ship | `ReleaseRecord.ts` `prepare` and `check` (every CfEnv deploy) | A release whose shipping commits change governed code unless it names the criteria it ships (`prepare --isc`) and at least one named criterion line changed in the governing ISA over the same range; `check` holds release sections dated 2026-10-24 or later |

The start and finish checks read file paths from tool calls, so a change written through Bash is caught only at ship time, where git sees every change.

## Fresh contexts, one source of truth

A Feature carries its own criteria, so its slice can reach a fresh context: when agents or a Workflow written for the task carry the build, the brief puts that Feature's criteria, Test Strategy rows and the ladder in front of the lane. Lane agents never write the ISA; the main session ticks criteria from evidence it has seen.

This is also the unit of context economics: model reasoning degrades well before the context window ends, so the Algorithm prefers closing a coherent work unit and re-entering fresh *from the ISA* over pushing one long session through compaction. The ISA is durable state built for exactly that — resume reads the artifact, never the conversation.

## Hierarchy — trees of ISAs

Anything too big for one file — an enterprise product, a Tolkien-scale world — is a **tree of ISAs**, not one monolith: `parent:`/`children:` frontmatter links, hard constraint inheritance (a child may not violate an ancestor Constraint), machine-readable `## Dependencies`, seam-verifying `## Bridge Criteria`, and a blast-radius pass that surfaces every downstream ISC a change touches before the build starts. Single-ISA work is the leaf case and covers virtually all real tasks; the full machinery is documented on demand in `ISAHierarchy.md`.

## Eleven Intents

The ISA skill at `~/.claude/skills/ISA/` owns eleven intents (plus the tool-only Render, `bun LIFEOS/TOOLS/ISARender.ts`); the verb in the request picks the intent, and each intent states its deliverable as an Ideal State and Anti-criteria (`LIFEOS/DOCUMENTATION/Skills/SkillSystem.md` § Intent anatomy). Every interviewing surface runs on one shared engine — `~/.claude/skills/ISA/References/Discussion.md`: frontier rounds (ask everything whose prerequisites are settled, a recommended answer leading each question), facts looked up rather than asked, per-round checkpointing into the target ISA's `## Articulation Log` (v2.23.0 — the standalone `discussion.md` checkpoint file is retired for new runs), no question cap. The Algorithm's criterion 6 decides when a discussion runs: done discoverable from the record → read it; ideal state resident only in the principal's head → Discuss in `discover` mode before building; and through the climb, a Discuss round whenever `bun LIFEOS/TOOLS/IsaAlign.ts status <isa>` says DISCUSS or the conversation shows doubt about what done means (ISAFormat § The alignment loop). The principal's `proceed` overrides, logged in Decisions.

| Intent | Trigger Verbs | Purpose |
|----------|---------------|---------|
| **Scaffold** | "scaffold", "create", "generate", "new ISA from this prompt" | Generate a fresh ISA with all required sections populated, the Ideal State ladder written first. |
| **Restate** | "restate", "confirm the direction", "is this the right thing" | Show the principal L3 and L2 before building a new project or a changed direction (and not otherwise), and record any correction in the Articulation Log as a `restate` block. The direction check before building. |
| **Discuss** | "discuss", "discovery interview", "figure out the shape", "are we aligned"; `IsaAlign.ts status` says DISCUSS | The standing alignment loop. Draws a half-formed idea into shape (`discover`, then Scaffold), realigns an existing ISA whose direction wobbled (`align`), or fills thin sections (`deepen`), at `quick`, `full` or `deep` depth, with a recommended answer and a challenge question each round, checkpointed through `IsaAlign.ts checkpoint` and folded into the ladder the same turn (ISAFormat § The alignment loop). |
| **Interview** | "interview me", "fill in the ISA", "deepen", "ask me questions" | Adaptive Q-and-A that fills thin sections section by section; A `deepen` verdict from `IsaAlign.ts status` (thick fog) runs Discuss `deepen`, which walks thin sections in Interview's order. |
| **Questionnaire** | "questionnaire", "async questions for" | Convert fog and open flags into an async markdown questionnaire for a recipient who holds knowledge the conversation can't reach. |
| **Refine** | "refine the ISA", "open questions", mid-run doubt | Carry mid-run doubt about the ideal state as `ask` fences under the criteria they change, ask them at breakpoints with my default first, fold each answer into the ladder and criteria, and settle open ones as `default-unratified` at close (`LIFEOS/TOOLS/IsaAsks.ts`). |
| **CheckCompleteness** | "check", "audit", "is it complete?" | Score against the completeness gate, including the ladder's shape and agreement; pass/fail plus a structured gap report. Recommends the drift check on project ISAs. |
| **Rate** | "rate this ISA", "score this ISA", "ISA quality" | Graded quality read across four dimensions — completeness, criterion integrity, articulation (read from L1), coherence — with a BUILD-READY / DISCUSS-FIRST / ROTTING verdict. Never blocks; steers the Algorithm toward Discuss where articulation is thin. |
| **Seed** | "seed", "bootstrap from this repo", "draft an ISA from existing code" | Bootstrap a draft project ISA from a repository's README, code structure, and recent commits. |
| **Upgrade** | "upgrade", "check format", "is this ISA current", "latest template" | Check one ISA, a list, or every ISA on the install against the current template (`IsaCheck.ts conform`), fix what a script can fix (a maintainer-side batch upgrader is not in the public release), fix the rest from the ISA's own content, and stamp each conforming ISA with `isa_format` and `checkup` (`IsaCheck.ts stamp`). |
| **Append** | "append decision", "append learning" (C/R/L), "append verification" | Canonical writer for the three append-only sections; refuses partial learning entries and collapses each Verification entry to a one-line provenance stub. |

Append exists specifically to prevent the conjecture/refuted-by/learned/criterion-now learning format from degrading via free-form prose creep — the four-piece structure is the format invariant, and Append refuses to write a partial entry.

## Lifecycle of an ISA across an Algorithm run

The cross-link in operational form — what happens to the artifact as a run proceeds:

1. **Run opens.** For a persistent thing, the existing `<project>/ISA.md` is read — it *is* the current state. For ad-hoc work, Scaffold creates a task ISA. The principal's stated goal lands verbatim in `principal_stated_goal:`, and the Ideal State ladder is written first; on a substantial or project ISA, Restate shows the principal L3 and L2 before anything is built.
2. **Articulation.** The ladder is confirmed as the right direction, then criteria are written, each naming its falsifier; anti-criteria capture what must not happen; genuine unknowns go to fog, not to speculative criteria. CheckCompleteness gates substantial work.
3. **Pursuit.** The build proceeds against the criteria. Probes fire; each failure asks "criterion wrong or code wrong?"; discoveries fold in as they arrive — criteria added, split, tightened, killed. Mid-run messages from the principal are checked against the ISA: does this revise the ideal state, kill a criterion, add one? If the ladder changes, the criteria are re-read against it the same turn, and the drift check (`bun LIFEOS/TOOLS/IsaLadder.ts drift <isa>`) flags criteria that have wandered from L3.
4. **Verification.** No criterion closes without tool evidence of the right modality. Every `[x]` is auto-committed (CheckpointPerISC hook); every ISA write mirrors to the dashboard (ISASync hook; `IsaFold.ts` mirrors its own Bash-driven writes, ticks and `bunker pass` stubs, itself).
5. **Close.** Every criterion closed, fog empty, evidence collapsed to provenance stubs, decisions and learnings recorded. `phase: complete`, `progress: N/N` — mechanical consequences of the criterion truth state.
6. **Between runs.** The artifact persists as the thing's state of record. A body edit on a completed task ISA rewinds it to learning and increments the iteration — reopening is a first-class motion, not an exception (roughly a quarter of real runs iterate).

The full run contract — all sixteen completion criteria with their enforcement teeth — is the Algorithm file: `LIFEOS/ALGORITHM/LATEST` → `v{LATEST}.md`.

## Relationships to Other LifeOS Subsystems

The ISA is the artifact every other LifeOS subsystem orbits.

- **Algorithm** (`LIFEOS/DOCUMENTATION/Algorithm/AlgorithmSystem.md`, `LIFEOS/ALGORITHM/LATEST`) — the thinking system that pursues the ISA: scaffolds at run start, checks completeness at scoping and close, may hand each Feature's slice to a fresh context when the work is wide, and appends at learning. The Algorithm is the motion; the ISA is the durable artifact the run reads and writes.
- **TELOS** (`LIFEOS/USER/TELOS/`) — the same articulation primitive at life scale; ISAs are its task-scale expression. Intent flows downward: mission → goals → projects → criteria.
- **Memory** (`LIFEOS/DOCUMENTATION/Memory/MemorySystem.md`) — task ISAs live under `LIFEOS/MEMORY/WORK/{slug}/`; the Memory subsystem provides the directory structure and the WORK→LEARNING→KNOWLEDGE compaction lifecycle.
- **Hooks** (`LIFEOS/DOCUMENTATION/Hooks/HookSystem.md`) — `ISASync.hook.ts` mirrors every ISA frontmatter change (`phase`, `progress`) to the dashboard's work registry; `CheckpointPerISC.hook.ts` auto-commits per-ISC transitions. Hooks only read the ISA; content is written by the AI via Edit/Write and the ISA skill, and ticks, `bunker pass` Verification stubs and progress by the main session through `LIFEOS/TOOLS/IsaFold.ts`, which mirrors work.json itself.
- **Pulse** (`LIFEOS/DOCUMENTATION/Pulse/PulseSystem.md`) — renders ISA `phase` and `progress` in real time; the Climb view derives criteria-closed-over-time from run data.
- **Bunker** — for deployed applications, the project ISA is the app's state of record and health contract, and `bunker test` is the row engine that executes its rows (Development Test and the post-deploy probes call it; Assay is the eval system that resolves them): every Test Strategy row runs as an assert — deterministic rows execute, `eval` rows dispatch to EvalRunner (`suite:` sugar, pass^k verdicts, at most once per ~20h day-cycle on the monitor), `manual` rows report as **attested** with their own status, never lumped with skips. The report carries an **asserted** line ("N/M criteria asserted · K manual exception(s)", from the same `Coverage` computation `ISAGate` reads), and **surfaces malformed Test Strategy rows loudly** rather than silently skipping them — a green board over an under-probed ISA is itself a finding, and a table the parser can't read can no longer exit green (both landed 2026-07-24 in the Test Strategy parser, now `LIFEOS/TOOLS/lib/IsaTestStrategy.ts` — shipped with the runtime, `Bunker/src/isa.ts` re-exports it (public issue #2037, @lowk3y) — after the EIF zero-probe-green incident). *(Bunker's own implementation is NOT in the public release payload; the shipped parser is `LIFEOS/TOOLS/lib/IsaTestStrategy.ts`.)*
- **Deploy review** (`LIFEOS/TOOLS/Review.ts`, run by every project deploy) — reads the project ISA as it stood at the last reviewed commit and judges the change against it: whole up to 100,000 characters, otherwise the always-read sections plus the sections naming the changed code (ISAFormat § Who reads an ISA at deploy). An ISA edit inside the change is reviewed as part of it. It never writes the ISA.
- **Skills** (`LIFEOS/DOCUMENTATION/Skills/SkillSystem.md`) — the ISA skill is one skill among many, following the same canonical form as the rest of the skill system.

## Examples

### A complete ISA in miniature

Here is the whole idea at the smallest honest scale — a real task, articulated as criteria before any code is written. The task: **add a dark-mode toggle to a personal blog.**

```markdown
task: Add a dark-mode toggle to the blog
phase: complete
progress: 4/4
principal_stated_goal: "add a dark mode toggle to my blog"

## Ideal State

### L3 · One sentence

A reader can switch the blog between light and dark, the choice sticks across
visits, and the page never flashes the wrong theme on load.

## Out of Scope
- Following the reader across their devices. That needs accounts, which the blog
  does not have, so it is left out rather than invented as a criterion.

## Criteria
- [x] ISC-1: A header control switches the page between light and dark themes.
- [x] ISC-2: The chosen theme persists across page loads.
- [x] ISC-3: First paint matches the stored (or system) theme — no flash of the wrong theme.
- [x] ISC-4: Anti: toggling never changes page content, layout, or scroll position.

## Test Strategy
| isc   | type       | check                                               | threshold | tool                                      | anchors_to |
| ISC-1 | screenshot | click the control → the theme attribute flips       | -         | Interceptor                               | literal    |
| ISC-2 | bun-test   | reload → the theme equals the last choice           | exit 0    | bun test ./theme.test.ts -t "persists"    | literal    |
| ISC-3 | screenshot | throttled load → the first painted frame is right   | -         | Interceptor                               | literal    |
| ISC-4 | bun-test   | layout box + scroll position identical before/after | exit 0    | bun test ./theme.test.ts -t "layout"      | literal    |
```

Everything the doc describes is visible in those few lines:

- **Every criterion names its falsifier.** ISC-3 isn't "no flash" as a hope — it's "the first painted frame is right," checked by a screenshot of a throttled load. If the frame is wrong, the criterion is false. That is what makes it a criterion and not a wish.

- **The anti-criterion (ISC-4) is load-bearing.** "Add dark mode" quietly implies "and don't break the page doing it." Naming that as a thing to test is what keeps the change honest.

- **The out-of-scope line is honest incompleteness.** Cross-device sync is a real question, but it depends on accounts the blog lacks, so it is declared out of scope instead of becoming a speculative criterion. Had it been a live in-scope question, it would sit in `Not yet specified` as fog, which blocks a close until it graduates to a criterion or is resolved; this ISA is complete because no fog is left.

- **`progress: 4/4` is mechanical.** Done isn't a judgment call — it's the count of criteria closed on evidence.

### The same primitive, no code in sight

The ISA is domain-general, so the identical structure articulates a task with no software in it — **planning the menu for a 40-person workshop lunch:**

- **Ideal state (L3):** everyone can eat well, within the per-head budget, with nothing that violates a stated dietary need.
- **Criterion:** every dish is labeled with its allergens (falsifier: an unlabeled dish on the table).
- **Criterion:** at least two mains are vegan (falsifier: fewer than two).
- **Anti-criterion:** nothing needs reheating on-site (falsifier: a dish that arrives cold and needs an oven the venue doesn't have).
- **Fog:** whether to offer dessert at all — undecided until the caterer quotes the budget.

Same shape: a hard-to-vary ideal state, criteria that each name what would prove them false, an explicit anti-criterion, and honest fog. The "probe" is a person checking labels and headcount rather than a test runner, but the discipline is identical.

### The lifecycle of that ISA across one run

```mermaid
stateDiagram-v2
    [*] --> Scoping: run opens
    Scoping --> Climbing: criteria written, each naming its falsifier
    Climbing --> Climbing: probe fails — criterion wrong or code wrong?
    Climbing --> Learning: every criterion closed on evidence
    Learning --> Done: fog empty, decisions and learnings recorded
    Done --> [*]: phase = complete, progress = N of N
    Done --> Learning: reopened — a new feature is a criterion that does not hold yet
```

A run moves left to right, but the self-loop is where the real work lives: a failing probe forces the question *is the criterion wrong, or the code?* — and the answer sharpens either the build or the articulation. The return path from Done is why a project ISA is never "finished": adding a feature means adding a criterion that doesn't hold yet, which reopens the climb.

---

## Cross-References

- **Format spec (file-shape contract):** `LIFEOS/DOCUMENTATION/ISA/ISAFormat.md`
- **Hierarchy reference:** `LIFEOS/DOCUMENTATION/ISA/ISAHierarchy.md`
- **The Algorithm (system doc):** `LIFEOS/DOCUMENTATION/Algorithm/AlgorithmSystem.md`
- **The Algorithm (doctrine file):** `LIFEOS/ALGORITHM/LATEST` → `v{LATEST}.md`
- **Skill (intent implementations):** `~/.claude/skills/ISA/SKILL.md` · canonical example: `~/.claude/skills/ISA/Examples/canonical-isa.md`
- **LifeOS thesis (the loop at OS scale):** `LIFEOS/DOCUMENTATION/LifeOs/LifeOsThesis.md`
- **Memory system:** `LIFEOS/DOCUMENTATION/Memory/MemorySystem.md`
- **Hooks system:** `LIFEOS/DOCUMENTATION/Hooks/HookSystem.md`
- **Master architecture:** `LIFEOS/DOCUMENTATION/LifeosSystemArchitecture.md`

## Related

- **Concept:** `../LifeOs/HillClimbing.md` § 2 (the ISA is the hill).
- **Feeds me:** `../Algorithm/AlgorithmSystem.md` (the run that sharpens the ISA); `../Errata/ErrataSystem.md` and `../Upgrades/UpgradesSystem.md` (misses that become sharper criteria).
- **I feed:** `../Assay/AssaySystem.md` (the ideal state a check measures against); `../Bunker/BunkerSystem.md` (the rows it runs); `../Testing/TestingDoctrine.md`.
- **ISA:** this doc is the concept; the file contract is `ISAFormat.md`. The loop's own criteria are in the Assay-everywhere ISA (maintainer-side; does not ship).
