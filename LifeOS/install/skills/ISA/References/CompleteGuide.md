# ISA — Ideal State Artifact

**Contents:** What It Does · The Problem · How It Works · Current Contract · The Twenty-One-Section Body (locked; spec v2.30.0, Algorithm v8.39.0) · Three-Guardrail Taxonomy (Principles vs Constraints vs Anti-criteria) · Completeness Gate (substance-scaled — HARD) · Intent Routing · Gotchas · Examples · Handing a Feature to a Fresh Context · Relationship to the Algorithm · Format spec cross-reference

## What It Does

The ISA is the single document that articulates "done" for any thing whose ideal state we are pursuing — a project, an application, a library, infrastructure, a work session, an art piece, a strategic decision. It serves five identities at once: ideal state articulation, test harness, build verification, done condition, system of record. The test-harness identity is implemented, not implied: **every ISC carries at least one executable assert** as a `## Test Strategy` row, and Assay resolves each row at the cheapest honest tier (the `bunker test` row engine, called by Development Test, executes the table) — deterministic rows (`bun-test`, `bun-property`, `bash`, `curl`) execute, `eval` rows dispatch to the Assay runner (judged, pass^k), `manual` rows report as the visible first rung of the attested → judged → deterministic ladder. Rows carry a lane (`liveness`/`integrity`/`build` in the `tier` cell) and a stage (ninth column): a criterion's asserts run first and a failing one marks its judge rows `gated`, and inference never runs on the liveness lane (ISAFormat v2.27.0). On assert-era ISAs (started ≥ 2026-08-31) `ISAGate` H8 blocks closing with a zero-assert criterion (spec v2.24.0; principal directive 2026-08-31: every ISC an assert). The Stop hook blocks the close up to three times per session; after that it returns `deferred` and stops blocking, and a close that still has hard violations is written to `MEMORY/STATE/isa-gate-deferred.jsonl` and sent to Vigil. An exception while checking a close blocks with the error in the message, under the same retry bound. This skill owns the canonical template, the intents that generate and refine ISAs, and the example library.
> The Bunker CLI is maintainer-private and not in the public release; run code rows with `bun test ./<path>` and suite rows with `bun skills/Assay/Tools/EvalRunner.ts`.

**Direction first** (SKILL.md states the rule). Criteria, probes, and gates are how we climb, and they are worth nothing on the wrong hill: a perfectly verified build of the wrong thing is the most expensive failure the system can produce. So every ISA opens with the `## Ideal State` ladder (L3 one sentence, L2 summary, L1 full articulation), and every intent in this skill either writes the ladder, confirms it with the principal (Restate), or checks the rest of the ISA against it (CheckCompleteness, and the drift check).

Every ISA shares one meta-ideal-state above its specific one: **euphoric surprise in the human using the system**. The specific ideal state varies with the work; the universal one never does. `## Vision` is where that general target takes specific shape — what euphoric surprise looks like for this particular work — so every ISA hill-climbs toward two summits at once.

## The Problem

Without a written, testable definition of finished, "done" drifts, criteria stay vague enough that anything passes, decisions get re-litigated, and work spanning sessions or agents has no shared record of what was verified. The ISA fixes "done" as a hard-to-vary explanation with atomic, probe-able criteria, a stable-ID structure that survives edits, and an audit trail of what was conjectured, refuted, and learned.

## How It Works

The ISA is a single document with a locked twenty-one-section body that opens with the Ideal State ladder. A substance-scaled completeness gate decides which sections are required for a given piece of work, and ten intents generate, deepen, refine, and score the artifact across sessions and agents. Every interviewing surface (Discuss, Interview, Refine, Scaffold's ambiguity check, Questionnaire's send-interview) runs on one shared engine: `References/Discussion.md`.

---

## Current Contract

**Essential rules for ISA authors and verifiers.**

**The ideal state, stated first:** Every ISA opens with `## Ideal State`, and L3 (one sentence) says what "done" looks like with enough specificity that done and not-done are distinguishable. L3 is the spine against which all criteria and tests hang. Every level states the summit, the euphoric-surprise version of done for everyone the work touches, never the floor of what must not break; parity and safety live in criteria and anti-criteria (ISAFormat § *What the ladder captures: the summit*). L3 is required on every ISA; L2 (one sentence and exactly four bullets) on project, system, and `## Features` ISAs; L1 (the full articulation) on project and system ISAs, where a task ISA lets `## Vision` carry it. The three levels must agree with each other and with the criteria. When the principal has stated the goal in words, the verbatim quote lives in frontmatter `principal_stated_goal:` only; L3 is the derived one-sentence destination and must honor it.

**The direction checks:** Restate shows the principal L3 and L2 before building a new project or a changed direction (and not otherwise), and any correction goes to the Articulation Log as a `restate` block. The drift check (`bun LIFEOS/TOOLS/IsaLadder.ts drift <isa>`) has a fresh model read only the criteria and write its own one-sentence ideal state, which a judge compares to L3 (aligned, partial, or divergent). It flags and never blocks. The shape check is `bun LIFEOS/TOOLS/IsaLadder.ts check <isa>` (ISAGate H10 `ladder`).

**Criterion and falsifier:** Every criterion (`## Criteria` or `## Features`) must name its falsifier — the observable evidence that would prove it false. Without a falsifier, there is no criterion, only aspiration. At least one `## Test Strategy` row per criterion, deterministic or judged.

**Test Strategy contract:** The table rows are `isc | type | check | threshold | tool | anchors_to` (optional: `severity`, `tier`=`liveness|integrity|build`, `stage`). Valid types: `bun-test`, `bun-property`, `bash`, `curl`, `eval` (judged), `pairwise` (tournament), `manual` (prose falsifier). Every row must name which column is which; dropping a column silently (e.g. omitting `threshold`) shifts anchors and breaks parsing. Write an empty cell instead. The gotcha about non-ASCII or extra words: if a cell carries non-ASCII chars or multiple words where the parser expects a single token (e.g. a two-word tool name), that row drops silently without warning.

**Test Strategy vocabulary** (defined in ISAFormat § *Verifier classes, lanes, and stages*): every criterion carries at least one row; the `tier` cell names a **lane** — `liveness` (is it up, deterministic only), `integrity` (is it right, may dispatch a judge), `build` (was it built to the ISA, row-engine `bunker test --deep` only); the optional `stage` column orders rows so a failing lower stage gates the rows above it. `eval` is the parent word for every check (assert or judge); an `eval` row rides the integrity or build lane and defaults to stage 2, a `pairwise` row dispatches to the tournament judge, and `manual` is the first rung of the attested → judged → deterministic ladder, listed by id as a named exception.

**Progressive execution:** Assay resolves each row at the cheapest honest tier, and the `bunker test` row engine (called by Development Test) runs fast asserts; `--deep --asserts` includes slower deterministic checks without inference; `--deep --stage N` caps dependency stages. Partial runs prove only their selected checks. Choose lane by cadence and stage by prerequisites, not a fixed model ladder. See `Assay/References/Progressive.md` and ISAFormat's verifier contract.

**Anti-criteria rule:** Derived from Out of Scope, Constraints, Principles, and regression-prevention concerns. How prose-guardrails become testable. At least one required on every real build (`Anti:` prefix in `## Criteria` or dedicated `## Anti-criteria` section). Missing anti-criteria are a hard CheckCompleteness failure.

**Evidence on close:** `## Verification` holds one-line stubs (commit hash, test name, probe ref), never retained evidence paragraphs. The moment a criterion passes, its stub collapses to a single line pointing at proof in git/CI.

**Closure:** At `phase: complete`, the fog section (`## Not yet specified`) must be empty — every entry graduated to a criterion or killed via a Decisions row. All fog-graduated criteria must have Test Strategy rows. All real builds require anti-criteria.

## The Twenty-One-Section Body (locked; spec v2.30.0, Algorithm v8.39.0)

Every ISA may have up to twenty-one body sections. The substance-scaled completeness gate decides which are required for a given piece of work; sections never appear empty. **Order is fixed**, and section 1, `## Ideal State`, is the one that matters most: it names the destination and every other section serves it. The retired `## Goal` lives on as L3 and the standalone `## Articulation` as L1, so one intent never lives in two places that drift apart; `## Articulation Log` stays, always last. **Vocabulary:** ISA items are Ideal State Criteria, never claims. The criteria section is headed `## Criteria` on new ISAs (`## Claims`, the v8-era spelling, and `## ISC Criteria` are legacy and still parsed); criterion IDs may be `ISC-N` or short-form (`C1`, `A3`); anti-criteria may live inline (`Anti:` prefix) or in a dedicated `## Anti-criteria` section (legacy `## Anti-claims`); the provenance section may be headed `## Verification` or `## Log`.

| # | Section | Purpose | Written At |
|---|---------|---------|------------|
| 1 | `## Ideal State` | **The section that matters most.** The destination at three depths that must agree, always first: `### L3 · One sentence` (the whole ideal state in one sentence, 60 words or fewer; the retired `## Goal` folded into this), `### L2 · Summary` (one sentence plus exactly four bullets), `### L1 · Full articulation` (the complete describe-it-in-text prose of what the thing IS at its best; the retired standalone `## Articulation` folded into this). L3 on every ISA; L2 on project, system, and `## Features` ISAs; L1 on project and system ISAs (Vision carries it on task ISAs). Rewritten freely as thinking settles; the criteria are its falsifiable decomposition; ambiguity resolves against it FIRST (L3 before L1), before re-interviewing. Full doctrine: `ISAFormat.md` § The Ideal State ladder | scoping → any point |
| 2 | `## Problem` | What is broken or missing right now that makes the ideal state worth pursuing | scoping |
| 3 | `## Vision` | What euphoric surprise looks like — experiential intent, 1–5 sentences | scoping |
| 4 | `## Out of Scope` | Anti-vision — what is *not* included in this ideal state, declared upfront in prose | scoping |
| 5 | `## Language` | The project's ubiquitous language. One block per term: meaning, an `_Avoid_:` line naming the names it displaces, and relationships. Glossary only — no implementation detail, no criteria. **A term enters only after it has actually caused a confusion.** Project ISAs; task ISAs inherit by reference | scoping → any point |
| 6 | `## Principles` | Substrate-independent truths (Deutsch reach) the work must respect | scoping |
| 7 | `## Constraints` | Immovable architectural mandates that bound the solution space | scoping |
| 8 | `## Dependencies` | Cross-ISA needs, one machine-readable `requires: <slug> — <contract>` line each — only when the ISA participates in a hierarchy | scoping |
| 9 | `## Criteria` | **Feature-less mode** — flat home for atomic criteria/ISCs when the work has no distinct features. When it does, omit this and use `## Features` blocks (§15) | scoping → climbing |
| 10 | `## Not yet specified` | Fog — in-scope questions too dim to be criteria yet, one `- fog:` line each; graduates to ISCs (or dies via Decisions) as pursuit sharpens it; empty at close — only when the work has fog | scoping → any point |
| 11 | `## Bridge Criteria` | Cross-ISA integration criteria (`Bridge:` prefix) verified across the seam as a distinct verification pass — only when the ISA has siblings | scoping → climbing |
| 12 | `## Test Strategy` | Per-ISC assert rows — `isc | type | check | threshold | tool | anchors_to` (+ optional `severity`, `tier` = lane: `liveness | integrity | build`, `stage`); ≥1 row per criterion, Assay resolves the table in stage order (the `bunker test` row engine executes it); required at every substance level on assert-era ISAs | scoping → required at close |
| 13 | `## Harness` | How an agent runs this app and uses it like a person: one fenced yaml block of commands (`launch`, `ready`, `doctor`, `drive`, `teardown`, plus `surface`, `targets`, `identity`, `seed`, `isolation`, `evidence`). A harness counts only after one full pass ran (an `F0` criterion with its own row); `teardown` stops only what `launch` started; evidence survives it. Pairs with the `Reach:` line on each user-facing feature block. Required on project ISAs for software a person drives; omitted on task ISAs and non-software work. Full shape: ISAFormat § `## Harness` | scoping → climbing |
| 14 | `## Extraction` | Generated tally of the `extraction.md` candidate manifest (per-provenance candidates → ISC/fog/OoS/killed), plus the comparator role. Never a self-report: ISAGate reads the tally table (header `provenance | candidates | isc | fog | oos | killed`) and hard-fails any row that disagrees with the manifest, a row that does not parse, a `Total` row that does not match, or a manifest provenance class missing from the table. A prose-only section beside a manifest is an advisory (`extraction-tally-missing`), not a block. Only when an Extraction Pass ran (new-product work or a named exemplar) — omitted on trivial work | scoping |
| 15 | `## Features` | **Feature mode** — it may also stand in the Criteria slot (9), before `## Test Strategy`, exactly as `Examples/canonical-isa.md` lays it out; either position is accepted. It holds the criteria as blocks: `### F<n> · <name>` + a one-line `Why:` (its ideal-state) + a one-line `Reach:` (how a person gets to it: `<route or command> → <stable handle>`, entries split by ` ; `) on user-facing blocks when the ISA has `## Harness` + its ISCs nested underneath. `F0 · Cross-cutting` for spanning criteria and never carries `Reach:`. Pointer table deleted; ISC IDs stay global/stable. Use this OR flat `## Criteria`, never both | scoping → climbing |
| 16 | `## Decisions` | Timestamped decision log including dead ends; `refined:` prefix for Ideal State (L3)/ISC restructures | any phase |
| 17 | `## Learning` | Conjecture / refuted-by / learned / criterion-now entries — the Deutsch error-correction trail, written only when understanding changed (formerly `## Changelog`; **not** a changelog — see below) | learning |
| 18 | `## Verification` | One-line provenance stub that each ISC passed — a commit hash, test name, or probe ref; collapsed on close, never a retained evidence paragraph | climbing → close |
| 19 | `## Remaining Work` | Concrete work this ISA still owes that was never an ISC of this run (follow-ups, handoffs, things noticed at close), one `- [ ] <work> — <why not an ISC / what it waits on>` line each. **Recording an item here IS a complete disposition** (no card also required). **Advisory, omit-when-empty, never gated, never counted toward coverage.** Backlog = unchecked ISCs ∪ unchecked Remaining Work. Distinct from fog (`## Not yet specified`); unchecked ISCs stay in `## Criteria` (ID-Stability forbids moving them here) | learning |
| 20 | `## Evals` | Staged evals keyed by criterion: one `### <ISC id>` heading and one fenced yaml block of ordered stages (`code`, `glance`, `eval`, `pairwise`, `manual`), cheapest first; the row points at it with `eval:#<ISC id>`. Definitions only. Full shape: ISAFormat § `## Evals` | scoping → climbing |
| 21 | `## Articulation Log` | Append-only raw record of every articulation session: one dated `### YYYY-MM-DD HH:MM · <source>` block per session (discuss, interview, questionnaire, voice ramble), full-fidelity including reversals. Never edited, only appended; always the LAST section. **No embedded line may start with `#`** — demote or blockquote headings in pasted/transcribed content (an unquoted `### Criteria` forges a criteria section on a criteria-less ISA). The persistence contract for every interviewing surface; `discussion.md` is retired for new runs | any point, append-only |

`## Dependencies`, `## Not yet specified`, and `## Bridge Criteria` are **conditional-required**: Dependencies/Bridge when the ISA has any `parent:`/`children:`/cross-ISA relationship, Not-yet-specified when the work genuinely has fog — omitted (like any empty section) otherwise. The full ladder (L3, L2, L1) is required on project ISAs and system ISAs, L3 and L2 on any ISA carrying `## Features`, and L3 alone on the smallest task ISAs; ladder-era ISAs (started on or after 2026-09-29) hard-block at close on a missing or malformed ladder, and older ISAs were migrated by sweep and are checked advisory-only, never retroactively blocked. `## Articulation Log` appears only once an articulation session has run and is never required. Multi-ISA trees are rare (<4% of archived ISAs) — full mechanics in `LIFEOS/DOCUMENTATION/ISA/ISAHierarchy.md`.

**The authority order:** the Log is the history of intent (every version of the creator's mind, reversals included), the ladder is the present state of intent (the verdict), and the criteria are the test of whether reality matches it. Ambiguity about intent resolves against `## Ideal State` first, L3 before L1, before re-interviewing the principal and always before guessing.

**Fog vs criterion vs out-of-scope (the graduation test):** can you state the question precisely now — not answer it, *state* it? Precisely statable with a nameable falsifier → an ISC, even if blocked. Statable but not yet probe-able → fog. Beyond the vision → Out of Scope. Corollary: **the Coverage Gate is assessed at close, not at scaffold** — never invent speculative criteria at scaffold to cover surface that is still fog (Pocock's wayfinder fog-of-war doctrine, generalized; adopted 2026-07-16); at `phase: complete` the fog section must be empty (every entry graduated or killed via a Decisions row). Domain-general: an unresolved research question, an album's track order, an unchosen venue are all fog.

**The changelog is git; evidence collapses on close:** the scaffold emits **no changelog section** — `git log -- <isa-path>` is the authoritative change record and commit messages are its entries. What persists is the living surface: `## Decisions` and the conjecture/refuted-by/learned/criterion-now trail (`## Learning`, formerly `## Changelog`, same position and four-piece C/R/L format). And `## Verification` holds **one-line provenance stubs, not evidence paragraphs** — the moment a criterion goes `[x]`, its entry shrinks to a commit hash / test name / probe ref pointing at the proof in git and CI.

---

## Three-Guardrail Taxonomy (Principles vs Constraints vs Anti-criteria)

Adjacent concepts. Distinguished by **who they bind**.

| Guardrail | Binds | Tone | Example | Lives In |
|-----------|-------|------|---------|----------|
| **Principles** | The *thinking* | Aspirational, generalizable | "User-facing systems prioritize responsiveness." | `## Principles` |
| **Constraints** | The *solution space* | Immovable, non-negotiable | "We do not roll our own cryptography — OAuth via industry-standard libraries only." | `## Constraints` |
| **Out of Scope** | The *vision* | Declared, explicit, prose | "Mobile native apps are not part of v1." | `## Out of Scope` |
| **Anti-criteria** | The *test surface* | Granular, testable, yes/no | "Anti: /admin returns 200 in v1 build." | `## Criteria` (with `Anti:` prefix) |

The first three are author-stated (declarative). Anti-criteria are derived — they are how Out of Scope, Constraints, and Principles become probe-able.

---

## Completeness Gate (substance-scaled — HARD)

Quality gates, not section counts — sections exist because content exists. Effort tiers were retired 2026-07-11; the gate scales with the substance of the work, discovered from the work itself (Algorithm §Spend):

| Substance | Required Sections |
|-----------|-------------------|
| **Trivial** (mechanical, single-probe, minutes) | Ideal State (L3 alone), Criteria, Test Strategy — a minimal direct-written ISA with one assert row per criterion; shape check logged inline |
| **Substantial** (multi-criterion build, real blast radius) | Ideal State (L3 and L2, plus L1 on project and system ISAs; Restate when the project is new or its direction changed), Problem, Vision, Out of Scope, Constraints, Criteria or Features (never both; ISAFormat § Features), Test Strategy, and Harness on a project ISA for software a person drives, with a `Reach:` line on every user-facing feature block (ISAFormat § `## Harness`) |
| **Deepest** (frontier multi-component work) | All twenty-one that apply (full Ideal State ladder required; Articulation Log once a session has run; Extraction only when an Extraction Pass ran; Dependencies/Bridge Criteria only when cross-ISA links exist; Not-yet-specified only when the work has fog; Language only when a term has actually been confused; Learning only when understanding changed) + a Discuss round whenever `IsaAlign.ts status` says one is owed (ISAFormat § The alignment loop) |

**Project ISA override:** any `<project>/ISA.md` requires full substantial-grade structure regardless of how small the current task is — including the full Ideal State ladder (pre-existing project ISAs were migrated by sweep and are advisory-only). The project file is the long-lived source of truth; one transient task must not downgrade it.

`CheckCompleteness` grades every row of this gate, including the ladder's presence, position, shape, and agreement with the criteria, and recommends the drift check on project ISAs. Enforcement is split: `LIFEOS/TOOLS/ISAGate.ts` mechanically blocks the `phase: complete` write only for its subset (ladder shape, zero criteria, fog at complete, leaf criteria with no Test Strategy row on assert-era ISAs, and the rest listed in CheckCompleteness § Severity table). Every other hard gap fails the CheckCompleteness report and blocks nothing unless that check is run.

---

## Intent Routing

The intent table lives in `SKILL.md` § Intent Routing, the one routing source. When the verb is ambiguous, default to Scaffold for new ISAs and CheckCompleteness for audits.

**Render** is tool-only: `bun LIFEOS/TOOLS/ISARender.ts <slug-or-path> [--output <path>]` — the only sanctioned ISA→HTML path (canonical LifeOS Technical template); open the result with `open -a "Google Chrome" "<file-url>"` when asked.

---

## Gotchas

Three cross-intent gotchas live in `SKILL.md` § Gotchas, which every run loads: the six-column Test Strategy table, no embedded headings in the Articulation Log, and ISA HTML only through `ISARender.ts`. The rest:

- **ID-stability: never re-number on edit.** When the Splitting Test produces a finer-grained version of `ISC-7`, preserve `ISC-7` as the parent and add `ISC-7.1`, `ISC-7.2`, etc. Even when an ISC is dropped, leave a tombstone (`- [ ] ISC-N: [DROPPED — see Decisions YYYY-MM-DD]`). Test Strategy rows, Verification stubs and Decisions entries key on stable IDs; renumbering orphans them silently.
- **The `## Learning` (C/R/L) format is non-negotiable.** Every entry needs all four pieces (`conjectured`, `refuted by`, `learned`, `criterion now`) in that order. Append refuses to write a partial C/R/L; if any of the four is missing, the entry is a Decision, not a Learning entry. The format is what makes the Deutsch error-correction trail auditable across sessions.
- **Empty sections never appear.** The twenty-one-section body is a *capacity*, not a *requirement* for every task. Sections required-but-empty for the work's substance are populated; sections not required and not yet written are simply absent from the file. CheckCompleteness distinguishes `present` / `missing` / `empty` and only `empty` is acceptable for `Verification`/`Log` before criteria start closing — section length is never graded; a one-sentence section can be exactly right.
- **Antecedents are required when the goal is experiential.** For art, design, content, and anything that has to "land," at least one ISC must use the `Antecedent:` prefix to name a precondition that reliably produces the target experience. Verifiable goals (build, deploy, schema) don't need antecedents; experiential goals always do.
- **Feature blocks hold their criteria — a feature contains its ISCs, it doesn't point at them.** When the work has distinct features, `## Features` is blocks: `### F<n> · <name>` + a one-line `Why:` (the feature's ideal-state — why it exists, what done means for it) + its ISCs nested underneath, with `F0 · Cross-cutting` for spanning criteria. The old `satisfies: [ISC-N]` pointer table is gone. ISC IDs stay **global and stable** across the whole ISA (never per-feature) so Test Strategy keeps working. Use feature blocks OR a flat `## Criteria` section, never both — trivial work stays flat. The `Why:` must say what the name and criteria don't; a restating `Why:` is noise.
- **Features are vertical slices, not horizontal layers.** Each feature block cuts end-to-end to a verifiable increment satisfying ≥1 ISC — not "the data layer" then "the API layer." A Feature you can't independently verify on its own is a horizontal slice; re-slice it vertically. It exists so every Feature produces a testable increment (Pocock's tracer-bullet / vertical-slice principle). **The one exception is the wide sweep** — a single mechanical change whose blast radius fans across the whole artifact (renaming a concept across a corpus, retyping a shared symbol, migrating a convention), where no vertical slice can land verified alone. Sequence it **expand–contract**: expand (introduce the new form beside the old, nothing breaks) → migrate in blast-radius-sized batches, each independently verifiable → contract (remove the old form once nothing references it). (Pocock's to-tickets wide-refactor rule, generalized; adopted 2026-07-16.)
- **Every criterion gets a row; the row's type follows the criterion.** Runnable falsifier → `bun-test`/`bun-property`/`bash`/`curl`; judged property (quality, behavior, regression across samples) → `eval` with a `suite:` pointing at an Assay suite; a choice between candidates (which cover, which draft) → `pairwise` with a `Tournament.ts` command; nothing executable yet → `manual` naming the falsifier in prose, as the first rung of the attested → judged → deterministic ladder (each attestation is a calibration label; the row is expected to graduate). The one shape that is never written is a criterion with no row — that is what H8 blocks. `manual` is honest and cheap; a fake probe is the failure mode the valve exists to prevent. An `eval` or `pairwise` row rides the integrity or build lane and a stage above the criterion's asserts, so the cheap check runs first and gates the judge.
- **Probe placement follows the seam rule.** Test Strategy probes attach at the boundary where the thing meets its consumer, at the highest boundary that exercises the criterion, agreed before building — never internals. Prefer existing boundaries; the fewer distinct probe boundaries, the more each proves. Full convention: `ISAFormat.md` § Probe placement.
- **A design question's cheapest probe is a throwaway prototype.** Sketch, outline, stub, or runnable code — disposable, kept out of the main line; only the decision folds back (into the ISC, a Decisions row, and at most one decision-rich fragment inlined). Full convention: `ISAFormat.md` § Prototype-as-probe.
- **Ordering edges are a trailing `(after: ID, ID)` parenthetical — and optional forever.** When criteria have real execution ordering, encode it as a trailing parenthetical on the criterion line (`- [ ] C4: migrate rows (after: C2).`); `bun LIFEOS/TOOLS/IsaFrontier.ts frontier <isa>` then computes the takeable set, and `claim`/`release` give concurrent sessions atomic per-criterion locks (central state under `MEMORY/STATE/isa-locks/`, never beside the ISA; the tool never writes the ISA file). Edges only where ordering is real — most ISAs need none, no gate requires them, and edging every criterion to look thorough is decoration the frontier then has to walk. Backticked syntax mentions and mid-line parentheticals are ignored by the parser (only the trailing form binds); dropped/tombstoned blockers count as resolved, so a killed criterion never blocks forever. The locks are optional tooling for concurrent sessions: a session sharing an ISA with other sessions may take a unit before building and release it at close; solo runs skip the protocol entirely, and nothing requires it. Full convention: `ISAFormat.md` § Dependency edges and the frontier.
- **The Log is append-only; the ladder is rewrite-freely — never confuse the disciplines.** Editing a log block destroys the layer's value as history; batching ladder rewrites into "later" leaves the verdict stale. Append raw rounds immediately; rewrite L1 (and re-derive L2 and L3) when understanding settles.
- **A verified build of the wrong thing is the costliest failure, so check direction before climbing.** When L3 and the criteria disagree, stop and resolve it before another criterion is climbed. A `partial` or `divergent` drift verdict means the criteria are building something other than the stated ideal state. The three ladder levels must also agree with each other: when one changes, re-read the others the same turn. Appending a log block to a `phase: complete` task ISA auto-reopens it to `learn` — that is intended (new articulation is rework signal); `frozen: true` opts out.
- **Prefer test-first probes (red-before-build).** Where an ISC's probe is a *runnable* test (`bun-test`/`bun-property`/`bash`/`curl`/`SELECT`), write it so it fails before EXECUTE and passes after — the probe exists and is red before the build, green after. Probes that can only be a screenshot or manual check are exempt. The rule is about when the probe is written and run, not how to do TDD (adapted from Pocock's `tdd`).

---

## Examples

The `Examples/` directory holds reference ISAs spanning scale × domain. The `eN-` filename prefixes are retired tier vocabulary kept as filenames only. The examples predate Dependencies and Bridge Criteria and show retired frontmatter keys (`effort:`, `mode:`) and legacy headings, so the twenty-one-section order and current frontmatter above win on shape. Every example opens with the Ideal State ladder: the small ones carry L3 alone, the project-scale ones carry L3, L2, and L1. Read the canonical showpiece before scaffolding a new ISA, copy its section headers, then populate. `canonical-isa.md` is the only shape template. The `eN-` files are content references for domain and scale, never templates: most carry the retired `satisfies:` pointer table beside both `## Criteria` and `## Features`, some carry `## Changelog`, and the legacy-era ones have fewer Test Strategy rows than criteria, all shapes Scaffold must not emit.

| File | Domain | Purpose |
|------|--------|---------|
| `Examples/canonical-isa.md` | Showpiece | **BeanLine** — peer-to-peer specialty-coffee marketplace, fully populated across every section with real-feeling Decisions and four-piece C/R/L Learning entries. Read this first. |
| `Examples/e1-minimal.md` | Code | Add a `--no-color` flag to a CLI tool. <90s task, L3 + 4 ISCs only. Demonstrates the fast-path floor. |
| `Examples/e2-backup-verify.md` | Code | Add SHA-256 verification to a backup CLI's `--verify` mode. Single-domain, 18 ISCs. |
| `Examples/e3-project.md` | Code | Build an arxiv metadata extractor CLI. Mid-size project, 12 ISCs, eight sections. |
| `Examples/e4-api-migration.md` | Code | Migrate a public API from REST to GraphQL with 6-month backwards-compat. Cross-cutting, 73 ISCs, every section populated. |
| `Examples/e5-desktop-app.md` | Code | **WattWatch** — open-source desktop app for personal home-energy monitoring. Single-user app pattern, 50 ISCs, populated Learning. |
| `Examples/e3-essay.md` | Art (antecedents required) | Write a 1500-word essay on a specific thesis. Experiential goal, antecedent ISCs, post-publish reception probes. |
| `Examples/e5-album.md` | Art (antecedents required) | **Mariner Frequencies** — produce a 12-track instrumental album over 6 months. Long-form experiential, multi-act Learning. |
| `Examples/e3-help-redesign.md` | Design | Redesign a CLI tool's `--help` output for first-encounter clarity. Antecedents + usability tests. |
| `Examples/e4-brand-identity.md` | Design | **Cardinal** — brand identity for a small fintech startup (logo + type + color + voice + first 5 marketing surfaces). 56 ISCs, 6 antecedents. |
| `Examples/e2-rotate-credential.md` | Ops | Rotate a production deploy credential in CI. The ISA primitive applied to ops/runbook work. 16 ISCs. |
| `Examples/e5-enterprise.md` | Enterprise | **Beacon Health Alliance** — multi-region HIPAA-compliant patient portal for a 50-hospital network. Compliance anti-criteria, multi-team parallelizable features, 68 ISCs, every section populated. The deepest-scale content reference; legacy shape (about a quarter as many Test Strategy rows as criteria), so never copy its structure. |

---

## Handing a Feature to a Fresh Context

A Feature carries its own criteria, so its slice can reach a fresh context: when agents or a Workflow written for the task carry the build, the brief puts that Feature's criteria, Test Strategy rows and the ladder in front of the lane. Lane agents never write the ISA; the main session ticks criteria from evidence it has seen.

---

## Relationship to the Algorithm

The Algorithm invokes this skill at run start to scaffold or read an ISA. The skill does not run the Algorithm — it owns the artifact the Algorithm operates on.

- Scoping: `Skill("ISA", "scaffold from prompt")` → returns populated ISA at canonical location.
- Scoping / close: `Skill("ISA", "check completeness of <path>")` → pass/fail + gap report.

The Algorithm doctrine (`~/.claude/LIFEOS/ALGORITHM/LATEST` → `v{LATEST}.md`) governs invocation cadence. This skill is invocation-agnostic — it works the same whether called by the Algorithm or directly by the user.

---

## Format spec cross-reference

The full ISA format spec lives at `~/.claude/LIFEOS/DOCUMENTATION/ISA/ISAFormat.md`. This skill implements that spec; if there is ever a contradiction, the format spec wins and this skill is updated to match.

The system-architecture doc — five identities, three-guardrail taxonomy, section body, intents, two homes, subsystem relationships — lives at `~/.claude/LIFEOS/DOCUMENTATION/ISA/ISASystem.md`. Read that for the conceptual frame; read this file (and `ISAFormat.md`) for the operational contract.
