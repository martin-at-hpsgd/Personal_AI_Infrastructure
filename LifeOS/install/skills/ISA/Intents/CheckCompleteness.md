# CheckCompleteness Intent

**Contents:** Ideal State · Anti-criteria · Inputs · Safety gates · Output format · Gotchas

The model-run completeness gate for one ISA, scaled to the work's substance, with a structured gap report.

## Ideal State

- The `## Ideal State` ladder is checked before any other section, and a broken ladder makes the rest of the report provisional.
- Every section the work's substance requires is classified `present`, `missing` or `empty` against the substance gate under Output format, and a project ISA (`<project>/ISA.md`) is scored at substantial or above regardless of how small the current task is, with any override reported in the output.
- Flat `## Criteria` and `## Features` blocks each satisfy the criteria requirement (ISAFormat: one or the other, never both), so a substantial ISA that uses one and omits the other has no gap for the omitted one.
- A missing `## Learning` is a gap only when the ISA records changed understanding (a refuted conjecture or a reversed Decisions row) with no C/R/L entry for it; an ISA whose understanding never changed passes without one.
- Every criterion in `## Criteria`, `## Features` (or legacy `## Claims`) is audited for granularity, coverage, backlog, anti-criteria, assert coverage, antecedent, ID stability, no changelog section, evidence collapsed on close, and anchoring, and ISAs whose frontmatter carries a `principal_stated_goal` key also get the goal-signal mismatch and artifact-presence checks.
- The report is the structured YAML under Output format: every gap names its section, its severity from the severity table at the ISA's substance, and its reason, and `status: pass` is set only when zero hard severity gaps remain.
- The drift check (`bun LIFEOS/TOOLS/IsaLadder.ts drift <isa>`) is recommended on every project ISA and after any large criteria change, and a `partial` or `divergent` verdict is reported as a direction gap.
- Run pre-close, the report's hard gaps mean `status: fail`, and the Algorithm fills them before declaring done.

## Anti-criteria

- Never grades the v6.x ceremony frontmatter keys or the retired `effort:` / `effort_source:` / `mode:` keys: their presence is never a failure, their values are never validated, and the deleted checks are never inverted.
- Never retroactively blocks an older ISA on ladder shape: the deterministic ladder checks (1 and 2) are hard only on ladder-era ISAs (started on or after 2026-09-29) and advisory on older ISAs, which were migrated by sweep.
- Never turns an advisory row into a gate: the alignment and Discussion provenance rows, the drift check and the Remaining Work backlog never block, and section length is never graded.
- Never reports a (model-run) row as mechanically enforced: only the subset `ISAGate.ts` implements blocks the `phase: complete` write, and every other hard row depends on this check actually being run.

## Inputs

- Algorithm after scaffold: confirm the scaffolded ISA meets the gate for the work's substance.
- Algorithm before close: confirm the ISA is still complete after any structural changes.
- User directly: `Skill("ISA", "check completeness of <isa-path>")`
- Internal call from Scaffold or Interview intents.

| Input | Required | Description |
|-------|----------|-------------|
| isa_path | yes | Path to the ISA to score |
| substance | no | The bar to score against (`trivial` / `substantial` / `deepest`); default judged from the ISA's Ideal State/Vision scope and blast radius |
| strict | no | Default true. If false, downgrade hard fails to soft warnings. |

## Safety gates

- **Frontmatter missing or malformed:** abort with explicit error. `phase:` and `progress:` are non-negotiable; `slug`/`task` may be derived (directory name / H1).

## Output format

```yaml
status: pass | fail
substance: substantial
ladder:
  present_and_first: true      # `## Ideal State` exists and is body section 1
  L3: ok                       # present, exactly one sentence, 60 words or fewer
  L2: ok                       # one lead sentence and exactly four bullets (project, system, Features ISAs)
  L1: ok                       # present (project and system ISAs)
  levels_agree: true           # L3 derivable from L2, L2 from L1, nothing promised that L1 does not describe
  criteria_agree: true         # the criteria jointly describe the ladder, no more, no less (judged; advisory)
  drift_check_recommended: true  # run `bun LIFEOS/TOOLS/IsaLadder.ts drift <isa>` on project ISAs and after large criteria changes
required_sections:
  Ideal State: present
  Problem: present
  Vision: present
  Out of Scope: missing
  Principles: present
  Constraints: present
  Dependencies: absent     # conditional — required only when cross-ISA links exist
  Criteria or Features: present  # flat `## Criteria` (legacy `## Claims` / `## ISC Criteria`) or `## Features` blocks, never both — either satisfies
  Bridge Criteria: absent  # conditional — required only when cross-ISA links exist
  Test Strategy: present
  Decisions: present
  Learning: absent         # the C/R/L trail (formerly named Changelog); conditional — written only when understanding changed
  Verification: empty    # `## Verification` or `## Log`; acceptable until criteria start closing
gaps:
  - section: Out of Scope
    severity: hard
    reason: required for substantial work, missing entirely
isc_quality:
  total: 24
  coverage_gaps: 0             # ladder/Vision subsystems with no container criterion
  granularity_violations: 0
  anti_criteria_count: 2
  antecedent_present: true
  test_strategy_orphans: 0     # zero-assert criteria: leaf ISCs with no Test Strategy row of any type
  manual_only_claims: []       # criteria whose only rows are `manual` — the visible exception ledger (advisory)
  id_stability_violations: 0
```

`strict: false` downgrades hard severity to warnings (used during interview when the user is mid-stream).

### The gate for the work's substance

The required sections per substance (Trivial, Substantial, Deepest) are the table in `../References/CompleteGuide.md` § Completeness Gate, which the `check` bundle loads; grade against that one table.

- **Project ISA scored at trivial:** override to substantial (CompleteGuide § Completeness Gate, *Project ISA override*). Report the override in the output.

Each required section is classified:

| Classification | Test |
|----------------|------|
| `present` | Section header exists and body has content — length is not graded; a one-sentence section can be exactly right |
| `missing` | Section header doesn't exist |
| `empty` | Section header exists, body is whitespace only — only acceptable for `Verification`/`Log` before criteria start closing |

### The ladder, checked first

Read `## Ideal State` before any other section and check, in order: (1) it is present and is body section 1; (2) it holds `### L3 · One sentence`, `### L2 · Summary`, `### L1 · Full articulation` in that order, with L3 exactly one sentence of 60 words or fewer, L2 one lead sentence plus exactly four bullets, and L1 present, at the depth the ISA requires (L3 on every ISA; L2 on project, system, and `## Features` ISAs; L1 on project and system ISAs, where a task ISA lets `## Vision` carry it); (3) the levels agree with each other, L3 derivable from L2 and L2 from L1, with nothing in a higher level that L1 does not describe and nothing central in L1 missing from L2; (4) the ladder and the criteria describe the same thing, so the criteria jointly cover what L3 and L1 promise and add nothing they do not. No leftover `## Goal` or standalone `## Articulation` may remain.

Checks 1 and 2 match `bun LIFEOS/TOOLS/IsaLadder.ts check <isa>` and ISAGate H10 `ladder`; they are hard on ladder-era ISAs (started on or after 2026-09-29) and advisory on older ISAs, which were migrated by sweep and are never retroactively blocked. Checks 3 and 4 are judgment. A fifth judgment check: every level of the ladder is written from the summit, not the floor (ISAFormat § *What the ladder captures: the summit*), and the criteria include summit criteria that measure the gain for the people the ladder names, beside the floor criteria. `IsaLadder.ts check` warns on floor words in L3 and L2; a ladder that is all floor is reported as a direction gap.

Recommend the drift check (`bun LIFEOS/TOOLS/IsaLadder.ts drift <isa>`) on every project ISA and after any large criteria change: a fresh model reads only the criteria and writes its own L3, and a `partial` or `divergent` verdict against the stated L3 is reported as a direction gap. `## Articulation Log` is never required; when present, verify the append-only shape (dated `###` session blocks, no other line-start `#` inside blocks), and check that any `restate` block's correction has been folded into the ladder.

**Provenance check (advisory):** at any substance, when the ISA's ideal state is resident only in the principal's head (generative, experiential, strategic, or new-product work with no authoritative record to read), a Discuss round in `discover` mode is owed before building (Algorithm criterion 6). Also report `bun LIFEOS/TOOLS/IsaAlign.ts status <isa>`: a `DISCUSS` verdict is a gap naming the mode, depth and reasons. The check never blocks; a Discuss block in the Log or a logged principal override (`proceed` / "just build it", recorded as a Decisions row) satisfies it.

### Criterion audit

Walk every criterion in `## Criteria` or `## Features` (or legacy `## Claims`; short IDs `C1`/`A3` and `ISC-N` both count, and a dedicated `## Anti-criteria` (legacy `## Anti-claims`) section counts toward the anti-criterion check):

- **Granularity** — every ISC names a single binary tool probe (or has one inferable from its phrasing). Compound "and/with" criteria fail.
- **Coverage** — assessed against the extraction record (`extraction.md` + `## Extraction`, `ISAFormat.md` § Extraction) when one exists, not against the ladder or Vision alone: both are prompt-derived, so anchoring coverage there made the prompt the ceiling (re-anchored 2026-08-17). Every candidate has exactly one disposition; every subsystem in the record has a container criterion decomposed until each leaf is one binary tool probe; never split to hit a number. The deterministic extraction checks (manifest presence for URL-bearing goals, tally/manifest integrity, comparator role, milestone format, close-state recording) belong to `ISAGate.ts` on the write path; this intent judges what a gate can't: whether the enumeration is truthful and the surface complete. The ladder (L1 and the L2 bullets), where present, is a coverage source alongside the record: every subsystem its prose names needs a container criterion, a fog entry, or an Out of Scope line. A subsystem with no container criterion is a coverage gap unless held as fog in `## Not yet specified` pre-close. At `phase: complete`, a non-empty `## Not yet specified` section is a hard fail; milestone-scoped fog may persist across milestone closes. Speculative ISCs written at scaffold to cover fog-shaped surface are themselves a quality failure (they have no honest probe), and density is reported in total dispositions, never ISC count.
- **Backlog (advisory, never a gate)** — unchecked ISCs ∪ unchecked `## Remaining Work`, computable from the artifact alone. `## Remaining Work` holds concrete work that was never an ISC of this run (follow-ups, handoffs); recording an item there is a complete disposition, requiring no card. It is never required and never blocks, and its items never count toward Coverage. Report the backlog size; never fail on it. Unchecked ISCs stay in `## Criteria` (ID stability forbids moving them into Remaining Work).
- **Anti-criteria (hard on substantial+)** — at least one anti-criterion exists (`Anti:` prefix inline, an `A`-prefixed short ID, or a `## Anti-criteria` section entry). `ISAGate.ts` treats a missing anti-criterion as advisory only (`no-anti-claim`) and never blocks on it, so this model-run check is the only thing that catches it.
- **Assert coverage (hard at every substance on assert-era ISAs, started ≥ 2026-08-31; substantial+ before that)** — every leaf criterion has at least one `## Test Strategy` row: a runnable probe, an `eval` row, or a `manual` row naming the falsifier. A criterion with zero rows fails. Criteria whose only rows are `manual` pass the hard check and are listed by id as the exception ledger (advisory). This mirrors `ISAGate` H8 exactly; it runs earlier.
- **Antecedent** — when the goal is experiential, at least one ISC has the `Antecedent:` prefix.
- **ID stability** — every ISC has a unique sequential ID. No collisions, no gaps from renumbering. Tombstones (e.g., `ISC-7: [DROPPED — see Decisions 2026-04-15]`) are valid.
- **No changelog section (Algorithm v8.7.1 criterion 12)** — the ISA contains no iter-by-iter narrative changelog; `git log -- <isa-path>` is the change record and the C/R/L trail lives in `## Learning`. A section literally named `## Changelog` that holds the C/R/L trail is accepted as an alias for `## Learning`, a soft warn only ("rename `## Changelog` → `## Learning` on next touch"); it is a hard fail only if it holds iter-by-iter narrative entries rather than the C/R/L trail.
- **Evidence collapsed on close** — every `## Verification` entry for a closed (`[x]`) ISC is a one-line provenance stub (commit hash, test name, or probe ref). An entry that carries a quoted paragraph instead is a soft fail (collapse it).
- **Anchoring** — when frontmatter `principal_stated_goal:` is set, every ISC has an `anchors_to` value in Test Strategy (either `literal` or `derived: <sub-criterion>`). Orphan ISCs (no traceable anchor) are a hard failure.

### Goal-literal checks

Both fire only when the ISA frontmatter contains a `principal_stated_goal` key (any value, including empty string or `null`); ISAs scaffolded before the key existed are not subject to them. When the key is present, read `../References/GoalLiteralChecks.md` and run the **goal-signal mismatch** and **artifact presence** checks it defines; their severities are in the Severity table below.

Of the ambiguity-check keys, only `context_sufficient` and `interview_invoked` are graded on v7.0.0+ ISAs; the deleted v6.5.0–v6.7.0 density/divergence/acknowledgment keys and the retired `effort:` / `effort_source:` / `mode:` keys (2026-07-11) are inert and never written on new ISAs.

### Severity table

**Who checks each row.** `LIFEOS/TOOLS/ISAGate.ts` mechanically blocks the `phase: complete` write only for: ladder shape (via `IsaLadder`), zero criteria, duplicate criterion IDs, non-`M/N` progress, fog at complete, missing `anchors_to` when a goal is stated, exemplar/extraction manifest and tally, close-state recording, leaf criteria with no Test Strategy row (assert-era ISAs), and checked-without-row. Rows marked **(model-run)** below have no ISAGate code: this intent judges them, `hard` there means the report fails, and nothing blocks the close if the check is not run. Anti-criteria, granularity and runnable-probe coverage are advisory in ISAGate and model-run here.

| Gap | Trivial | Substantial | Deepest |
|-----|---------|-------------|---------|
| Ideal State ladder missing, not first, or malformed (L3 absent or not one sentence; L2 without exactly four bullets or L1 absent where required; leftover `## Goal` or standalone `## Articulation`) — hard on ladder-era ISAs, advisory on older | hard | hard | hard |
| Criteria missing (neither flat `## Criteria` nor `## Features` blocks) | hard | hard | hard |
| Problem missing (model-run) | — | hard | hard |
| Test Strategy missing | hard (assert-era) | hard | hard |
| Harness missing on a project ISA for software a person drives, or a user-facing feature block without `Reach:` once it exists (warning on project ISAs that predate v2.30.0, until Build or Checkup next touches them) | — | hard | hard |
| Harness never proven: no `F0` criterion with a Test Strategy row for one full harness pass (ISAFormat § `## Harness`) | — | warning | hard |
| Vision missing (model-run) | — | hard | hard |
| Out of Scope missing (model-run) | — | hard | hard |
| Constraints missing (model-run) | — | hard | hard |
| Principles missing (model-run) | — | — | hard |
| Decisions missing (model-run) | — | — | hard |
| Learning missing although the ISA records changed understanding (a refuted conjecture or reversed Decisions row; Learning is written only when understanding changed) (model-run) | — | — | hard |
| Narrative `## Changelog` present: iter-by-iter entries rather than the C/R/L trail (git is the changelog; convert to `## Learning`) (model-run) | hard | hard | hard |
| `## Changelog` holding the C/R/L trail, an alias for `## Learning` (rename on next touch) (model-run) | soft | soft | soft |
| Verification entry retains an evidence paragraph instead of a one-line stub | soft | soft | soft |
| `IsaAlign.ts status` says DISCUSS (a corrected restate never re-aligned, asks clustering, thick fog) and no Discuss block or `proceed` row followed | advisory | advisory | advisory |
| Discussion not run before building on a head-resident ideal state (provenance test; owed by criterion 6, and a logged principal `proceed` Decisions row satisfies) | advisory | advisory | advisory |
| Anti-criterion count = 0 (≥1 required) (model-run) | soft | hard | hard |
| Leaf criterion with zero Test Strategy rows (any type; `manual` satisfies) | hard (assert-era) | hard | hard |
| Antecedent missing (experiential) (model-run) | hard | hard | hard |
| ID-stability violation (model-run) | hard | hard | hard |
| Ladder levels disagree with each other (L3 not derivable from L2, L2 not from L1, or a higher level promises what L1 does not describe) (model-run) | — | hard | hard |
| Ladder and criteria disagree, or the drift check returns `partial` or `divergent` (judged; flags, never blocks) | soft | soft | soft |
| Coverage gap (ladder/Vision subsystem with no container criterion, fog entry, or Out of Scope line) (model-run) | — | hard | hard |
| Articulation Log block contains embedded line-start `#` headings (parser-forgery risk) (model-run) | hard | hard | hard |
| Non-empty `## Not yet specified` at `phase: complete` | hard | hard | hard |
| Granularity violation (model-run) | hard | hard | hard |
| Anchoring violation (orphan criterion, v6.4.0+ ISAs only; ISAGate `anchors-missing` blocks the close) | hard | hard | hard |
| Goal-signal mismatch (recorded signal vs recorded literal, v6.4.0+ ISAs only) (model-run) | hard | hard | hard |
| Artifact-presence violation (v6.4.0+ ISAs only) (model-run) | — | — | hard |
| Exemplar named in goal, no extraction manifest + comparator role, no exemplar Decisions row (2026-08-17+ ISAs; enforced by ISAGate on the write path) | hard | hard | hard |
| `## Extraction` tally disagrees with `extraction.md` manifest, or manifest missing/malformed (enforced by ISAGate) | hard | hard | hard |
| Extraction present but enumeration untruthful or surface visibly incomplete (judgment — this intent, not the gate) | — | hard | hard |
| `context_sufficient` missing (v7.0.0+ scaffolds only; ISAs carrying legacy v6.x ceremony keys predate v7 and are exempt; trivial inline ISAs exempt) (model-run) | — | hard | hard |

## Gotchas

- **Criterion-body parsing fails:** treat as zero criteria and surface the parse error.
- Kept inline: the ladder checks, the criterion audit, the Severity table and the YAML report shape, which every check run grades against.
