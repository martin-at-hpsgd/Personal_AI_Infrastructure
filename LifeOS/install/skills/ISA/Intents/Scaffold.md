# Scaffold Intent

**Contents:** Ideal State · Anti-criteria · Inputs · Safety gates · Output format · Tool contract · Gotchas · References

A populated ISA at the canonical location, new or extended in place, carrying the sections the work's substance requires (effort tiers were retired 2026-07-11; substance is judged from the work, never declared as a label).

## Ideal State

- The deliverable is one populated ISA file at the canonical location: `<project-root>/ISA.md` when `project` is supplied, otherwise `~/.claude/LIFEOS/MEMORY/WORK/{slug}/ISA.md`; the intent returns its absolute path, which the Algorithm consumes at run start.
- An ISA that already exists at the target is extended in place (read-extended, not overwritten, and never a second ISA beside it): new work lands as the next `### F<n>` block, or as new flat criteria, with the next unused global ISC IDs; no existing criterion is renumbered, and existing Decisions, Learning, Verification and Articulation Log entries are unchanged.
- The `## Ideal State` ladder (L3, L2, L1) is the first section in the file and every later section answers to it; section headers and their order match `~/.claude/skills/ISA/Examples/canonical-isa.md`.
- The ladder levels the substance requires agree exactly: L1 written from the source of intent (the Articulation Log when one exists, the extraction record and prompt otherwise), L2 derived from L1 and L3 from L2, nothing in a higher level promising what L1 does not describe, and every level written from the summit. After an extension the ladder is re-derived the same way and covers the new work.
- When goal-signal detection fires and the minimum-content rule passes, frontmatter `principal_stated_goal` holds the byte-for-byte literal (with its `_source`, `_signal` and `_locked` fields) before any derived section is produced, and L3 says the same thing at the destination level without narrowing or contradicting it.
- On new-product / new-surface substantial work, and whenever the ask names a product or URL at any substance, a candidate manifest exists at `<slug>/extraction.md` with a generated `## Extraction` tally in the ISA, and every candidate row has exactly one disposition: `ISC-n`, `fog`, `oos` or `killed`.
- When what done means is materially ambiguous, the one question message reached the principal before any section beyond the Ideal State ladder was scaffolded (trivial fast-path work prepends the flag form instead).
- On every scaffold, frontmatter `context_sufficient` and `interview_invoked` record the outcome of the ambiguity check (`true`/`false` when no ambiguity was found).
- The ISA carries the sections its substance requires (Trivial, Substantial or Deepest, per Sections by substance under Output format), a `<project>/ISA.md` target carries full substantial-grade sections regardless of how small the current task is, and on Deepest work empty sections never appear.
- Every criterion satisfies the Splitting Test (one binary tool probe per criterion) and leaves scaffold with at least one Test Strategy row whose type follows Row classification, `manual` naming the falsifier when nothing executable exists yet.
- The ISA has at least one anti-criterion, and when the goal is experiential (art, design, content, anything that has to "land") at least one `Antecedent:` criterion.
- On substantial work, meaning any ISA that carries `## Features`, the absence review's answers existed as dispositioned `absence` rows in `extraction.md` before the anti-criteria were written, and frontmatter records `absence_review: <reviewer>@<ISO>` or `absence_review: skipped — <reason>` plus a Decisions row.
- On substantial+ work the scaffold is declared complete only after CheckCompleteness finds no required section missing (a trivial minimal ISA logs its shape check inline).
- On substantial and project ISAs the drift check at scaffold close targets `aligned`, and when the project is new, its direction changed, or an extension changed what L3 or L2 say, the principal saw L3 and L2 verbatim through Restate and gave a yes or a correction before building.
- Surface named in the ladder or Vision whose shape is genuinely unknown at scaffold time is written into `## Not yet specified` as precisely stated fog, never as speculative ISCs.

## Anti-criteria

- A well-scaffolded ISA for the wrong destination: the failure this intent exists to prevent.
- The `principal_stated_goal` literal is never copied into the body, and no derived section is produced before the literal is preserved.
- Never anchors against useless text: a candidate literal under 6 tokens OR with no propositional content is not preserved; `principal_stated_goal: null` is set and the candidate logged to a Decisions row.
- No silent drops: no extraction candidate or absence-review answer is left without a disposition, and no criterion is ever split or padded to hit a number.
- Never emits a `## Changelog` section or the retired `name | satisfies` pointer table.
- No criterion leaves scaffold with no Test Strategy row, and a scaffold never claims a judge is calibrated.
- No floor language ("intact", "parity", "keeps working") in the ladder, and Scaffold never writes into the `## Articulation Log` itself.
- A substance mismatch between the caller's steer and the request is never silent.
- An extension never starts a second ISA for the same work and never renumbers an existing criterion.

## Inputs

| Input | Required | Description |
|-------|----------|-------------|
| prompt | yes | The user's request — verbatim or distilled |
| substance | no | Optional depth steer from the caller ("trivial" / "substantial" / "deepest", or plain language like "go heavy"); default is judged from the prompt |
| project | no | If task targets a known project from PROJECTS.md, the project ISA path is used; otherwise a task ISA at `~/.claude/LIFEOS/MEMORY/WORK/{slug}/ISA.md` |

## Safety gates

- **Substance mismatch:** caller steers "trivial" but the request is clearly deep multi-component work (or the reverse). Surface the mismatch; the principal's explicit call outranks judgment, but the break is never silent (Algorithm criterion 15).
- **Missing required section:** CheckCompleteness blocks the return until filled.

## Output format

A markdown file at the location the first Ideal State bullet names (slug = `YYYYMMDD-HHMMSS_kebab-task-description`).

### Frontmatter template

```yaml
---
name: "Short Session Name"   # 2–5 words; the session's name on every surface
task: "8 word task description"
slug: YYYYMMDD-HHMMSS_kebab-description
project: <name>            # only when targeting a known project
phase: scoping
progress: 0/<criterion-count>
started: <ISO-8601>
updated: <ISO-8601>
# R1 — only when goal-signal detection fired + min-content rule passed
principal_stated_goal: "verbatim quote"
principal_stated_goal_source: prompt
principal_stated_goal_signal: 2
principal_stated_goal_locked: <ISO-8601>
# R3 — outcome of the ambiguity check; the only two keys v7 ISAs carry for it
context_sufficient: true
interview_invoked: false
---
```

### Sections by substance

The section list per substance (Trivial, Substantial, Deepest) is the table in `../References/CompleteGuide.md` § Completeness Gate, which the `scaffold` bundle loads; a `<project>/ISA.md` target takes the full substantial-grade set regardless of task size.

**The ladder.** `## Ideal State` is body section 1, written in this order: `### L3 · One sentence` (the whole ideal state in one sentence, 60 words or fewer, ideally 15 to 35; the destination, not a task list), `### L2 · Summary` (one sentence plus exactly four bullets, the four aspects that matter most), `### L1 · Full articulation` (the complete describe-it-in-text prose). Which levels each ISA carries: `../References/CompleteGuide.md` § Current Contract. When the target ISA already carries an `## Articulation Log` (Discuss ran first), it and any existing ladder outrank the prompt as the statement of intent, and ambiguity resolves against the ladder (L3 first) before questions fire. Write every level from the summit (ISAFormat § *What the ladder captures: the summit*): as ambitious as the principal would be delighted by, one L2 bullet per person or group the work touches where that fits. The criteria carry both sides: summit criteria that measure each person's gain, and floor criteria and anti-criteria that guard what must not be lost. A drift check that reads `partial` because the criteria are all floor means summit criteria are missing.

**The harness (project ISAs for software a person drives).** Write `## Harness` right after `## Test Strategy`: one fenced yaml block of the commands that start the app, confirm it is ready, check it is worth driving, drive it the way a person does, keep the proof and stop it (ISAFormat § `## Harness` has the fields and rules). Interview the repo for these, not the principal: its own dev command, port, readiness signal, existing test harness and sign-in path; ask only for what the code cannot show. Add an `F0` criterion that the harness runs end to end (launch, ready, doctor, one feature driven through its `Reach:` entry, evidence captured, teardown, evidence still present) with its own Test Strategy row. Never put a credential value in the block. Task ISAs, libraries with no surface a person uses, and non-software work skip it.

**Criteria layout — pick one:**
- **Flat `## Criteria`** when the work has no distinct features (trivial/small; most task ISAs). Criterion IDs `ISC-N` (or short `C1`); anti-criteria carry the `Anti:` prefix inline or live in `## Anti-criteria`.
- **`## Features` blocks** when the work has distinct features (most project ISAs). Each feature is `### F<n> · <name>` + a one-line `Why:` (its ideal-state — why it exists) + its ISCs nested underneath. `F0 · Cross-cutting` holds spanning criteria (security, deploy, data-integrity). ISCs carry **global, stable IDs** (`ISC-N` across the whole ISA, never per-feature) so Test Strategy resolves. Write a real `Why:` — one that says what the feature name and its criteria don't. On an ISA with `## Harness`, every user-facing block also gets a `Reach:` line under `Why:` (how a person gets there, `<route or command> → <stable handle>`, entries split by ` ; `); `F0` never has one.

Example feature block:
```markdown
### F1 · Billing
Why: a visitor becomes a paying subscriber and can self-serve cancel, without support.
Reach: /pricing → button "Start trial" ; /account/billing → button "Manage plan"

- [ ] ISC-12: Checkout creates a Stripe session with server-side pricing.
- [ ] ISC-13: Anti: the webhook is idempotent on event.id.
```

**No changelog section (Algorithm v8.7.1 criterion 12).** `git log -- <isa-path>` is the authoritative change record and commit messages are its entries. The conjecture/refuted-by/learned/criterion-now trail lives in `## Learning` (the section formerly named `## Changelog`; it sits after `## Decisions` per the order table in `../References/CompleteGuide.md`, same four-piece C/R/L format), written at close only when understanding changed.

**Hold fog as fog.** Each genuinely unknown question goes into `## Not yet specified` as precisely as it can currently be stated (`- fog: <question> — <what must resolve before it sharpens>`). The graduation test: statable with a nameable falsifier → an ISC (even if blocked); statable but not yet probe-able → fog; beyond the vision → Out of Scope. Omit the section entirely when the work has no fog (most tasks).

### Splitting Test

One binary tool probe per criterion, carried by at least one Test Strategy row (`manual` when the probe is not yet executable; `eval` when the property is judged). A criterion with no row is unwritable on assert-era ISAs (ISAGate H8).

| Test | Split when... |
|------|--------------|
| "And"/"With" | Joins two verifiable things |
| Independent failure | Part A can pass while B fails |
| Scope words | "all", "every", "complete" → enumerate |
| Domain boundary | Crosses UI/API/data/logic → one per boundary |
| **No nameable probe** | You can't say which tool would verify it — split until you can; the survivor gets a row, `manual` at worst |

### Row classification

The row type is derived, never picked by taste: a check a tool can fail without a model gets an assert row; one output's quality gets an `eval` row, a ranking a `pairwise` row, a decomposable property stage-1 asserts plus a stage-2 judge, and nothing runnable yet a `manual` row naming the falsifier. Read `../References/RowClassification.md` for the three questions and the `manual`/`eval` rules whenever a criterion is not plainly deterministic.

Anti-criteria typically derive from Out of Scope and regression-prevention concerns; an antecedent names a precondition that reliably produces the target experience.

## Tool contract

- The Algorithm at run start: `Skill("ISA", "scaffold from prompt: <user message>")`
- User directly: `Skill("ISA", "scaffold from prompt: <prompt>")`

### Goal literal: detect and preserve

Run the four-signal detector on the prompt:

| # | Signal | Pattern | Examples |
|---|--------|---------|----------|
| 1 | **Named metric + threshold** | quantitative target | "get p95 latency under 200ms" · "grow signups to 10k" · "open rate above 35%" |
| 2 | **Explicit outcome assertion** | "I want X" / "achieve X" / "do this" | "I want Pulse showing all four time horizons" |
| 3 | **Completion condition** | "until X" / "such that X" | "refactor until tests pass" · "ship such that the audit returns no critical findings" |
| 4 | **Structural/design directive** | explicit verb-object on the system | "design how ISA absorbs Codex /goal semantics" · "unify three skills into one" |

**Fail-closed minimum-content rule:** if a candidate literal is under 6 tokens OR contains no propositional content ("make it good", "do better", "refactor this"), set `principal_stated_goal: null` and log the candidate to a Decisions row. Better silent than anchoring against useless text.

**Multi-literal:** with several candidates ("do X and Y by Z"), the first wins as `principal_stated_goal:`; the others demote to derived Constraints with a `derived_from: principal_stated_goal compound` annotation.

When detection fires and min-content passes, write the four frontmatter fields:

```yaml
principal_stated_goal: "the verbatim user quote, byte-for-byte"
principal_stated_goal_source: prompt   # prompt | conversation | explicit-revision
principal_stated_goal_signal: <1-4>
principal_stated_goal_locked: <ISO-8601>
```

The verbatim quote stays in `principal_stated_goal` and nowhere else. If L3 would narrow or contradict the literal, L3 is wrong. Derived content is anchored to the preserved literal via the `anchors_to` column in Test Strategy.

### Extraction Pass

The prompt is a pointer into the principal's intent, not the payload (the reference-product failure, 2026-08-17). Full artifact spec: `ISAFormat.md` § Extraction.

- **When it runs:** the full pass on new-product / new-surface substantial work. The exemplar sweep on every ask that names a product or URL, at any substance (ISAGate hard-blocks a URL-bearing goal closed without a manifest-plus-comparator-role or a Decisions row saying why none was owed). Trivial tasks and internal refactors skip the pass entirely: no manifest, no section.
- **How it runs:** read `../References/ExtractionPass.md` before the sweep: the five source classes, the exemplar comparator contract, total disposition (every candidate row gets exactly one of `ISC-n`, `fog`, `oos`, `killed`), and the milestone proposal.

### Ambiguity check

One rule: **could I be wrong about what done means?** It is materially ambiguous when the goal supports ≥2 interpretations leading to materially different builds, or required content can't be scaffolded without speculation. Then ask up to 3 targeted questions (substantial work) or prepend the ambiguity flag (trivial fast-path work): `⚠️ Picking X over Y because R; redirect if wrong.` Literal whole-response `proceed` accepts reasoned defaults.

When the rule finds material ambiguity, the one question message goes out before any section beyond the Ideal State ladder is scaffolded. Read `../References/AmbiguityQuestions.md` before asking: provenance escalation past the 3-question ceiling, the message template, the `proceed` match and what it records. Read it again when late-surfacing information would have changed the ladder, Vision or Out of Scope (re-check later).

Logging the outcome in ISA frontmatter:

```yaml
context_sufficient: true    # false when ambiguity was flagged or `proceed` accepted reasoned defaults
interview_invoked: false    # true when targeted questions were actually asked
```

| Path | `context_sufficient` | `interview_invoked` |
|---|---|---|
| No material ambiguity found | true | false |
| Questions asked, principal answered them | true | true |
| Questions asked, principal said `proceed` | false | true |
| Trivial-path ambiguity flag prepended | false | false |

### Absence pass

On substantial work (any ISA that carries `## Features`; the discriminator is the on-disk section, never a self-declared tier), one absence review runs before the anti-criteria are written. Its brief holds only what was written this turn: the Ideal State ladder, Problem, Vision, Constraints, Out of Scope, and the verbatim stated goal. Never the Criteria, the Test Strategy or the transcript: the reviewer's value is that it did not inherit the builder's frame. Dispatch one non-forked fresh-context reviewer (in-family at the session rung; the cross-vendor eye stays a close-time second look) with one question: *"List, ranked, at most seven failures that would make this work wrong or harmful even if every stated requirement held."* Disposition every answer as an `absence` row in `extraction.md` (ISC / fog / oos / killed); most become anti-criteria. Record `absence_review: <reviewer>@<ISO>` in frontmatter, or `absence_review: skipped — <reason>` plus a Decisions row. Trivial and flat-`## Criteria` ISAs skip this step entirely. Advisory teeth only (ISAGate A7 and one nudge row); nothing here blocks.

### Close sequence

In this order at scaffold close:

1. **CheckCompleteness** (`Intents/CheckCompleteness.md`) against the new ISA on substantial+ work; a trivial minimal ISA logs its shape check inline. Fill any missing required section before declaring the scaffold complete.
2. **Drift check:** `bun LIFEOS/TOOLS/IsaLadder.ts drift <isa-path>`. Verdicts are `aligned`, `partial`, `divergent`. On `partial` or `divergent`, do not build: either the criteria are missing or narrowing something the ladder wants, or the ladder is wrong; fix whichever is wrong and re-run. The verdict flags and never blocks, so a remaining `partial` is recorded in Decisions with the reason it stands.
3. **Restate** (`Intents/Restate.md`) when the project is new or its direction changed, an extension that changes L3 or L2 included; an existing ISA whose direction holds needs none. Show the principal L3 and L2, verbatim and nothing else, and wait for a yes or a correction. A correction is appended to the Articulation Log as a `restate` block and folded into the ladder the same turn, then the drift check runs again. Trivial ISAs skip both checks, since one sentence and a probe leave nothing to misread.
4. **Return the path:** the absolute path of the created or extended ISA file.

## Gotchas

- **Coverage gap (re-anchored 2026-08-17; fog-aware since v2.14.0):** coverage is assessed against the **extraction record**, not against the ladder or Vision alone — both are themselves prompt-derived, so anchoring coverage there made the prompt the ceiling (the reference-product failure). Every extraction candidate has exactly one disposition; every subsystem in the record has a container criterion decomposed until each leaf is one binary tool probe; never split to hit a number. A named exemplar with no manifest is the failure ISAGate now blocks deterministically. Coverage is assessed at close (milestone or phase): fog must be empty at `phase: complete`; milestone-scoped fog may persist across milestones.
- Kept inline: the frontmatter template, goal-literal detector, ambiguity rule with its frontmatter record, Splitting Test, absence pass (AlgorithmNudge and ISAGate cite it by name) and close sequence, which every scaffold run applies.

## References

`~/.claude/skills/ISA/Examples/canonical-isa.md` is the reference for section headers and tone; its `## Ideal State` ladder shows the three levels agreeing. It is the only shape template. `e1-minimal.md` (minimal task) and `e5-enterprise.md` (deepest scale) are content references only: the `eN-` files carry legacy shapes (retired frontmatter, the `satisfies:` pointer table, `## Changelog`, fewer Test Strategy rows than criteria) that this intent's Anti-criteria forbid, so never copy their structure (`../References/CompleteGuide.md` § Examples). The `eN-` filename prefixes are retired tier vocabulary kept as filenames.
