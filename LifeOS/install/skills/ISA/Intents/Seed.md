# Seed Intent

**Contents:** Ideal State · Anti-criteria · Inputs · Safety gates · Output format · Tool contract

Bootstrap a draft project ISA from an existing repository's README, code structure, recent commits and any pre-existing PRD-shaped artifacts, for a project that predates the ISA framework, without inventing fiction.

## Ideal State

- A draft project ISA exists at `<project_path>/ISA.md` (or, with `dry_run`, is emitted to stdout instead), drafted from the repository, and the status report names the sources consulted, the sections drafted and skipped, the ISC count and `review_required: true`.
- The `## Ideal State` ladder is the first section in the file, above Problem: L1 from the README and repository signals, L2 (one sentence plus exactly four bullets) derived from L1, L3 (one sentence, 60 words or fewer) derived from L2, so the levels agree, written at the summit the sources point toward and marked for review.
- Problem, Vision, Out of Scope and Constraints are lifted or inferred from the README, PRD-shaped artifacts and config files; a section the sources do not support is a stub with a TODO comment, and a ladder too thin for four honest L2 aspects carries a `<!-- TODO -->` naming the gap.
- Criteria are ported from existing test names and acceptance files as atomic ISCs under the Splitting Test, or, when there is no test suite or acceptance file, are 6–10 conservative ISCs with a Decisions entry saying they were seeded from the README; at least one anti-criterion derives from Out of Scope.
- Every ISC has a Test Strategy row: runnable where the probe is obvious, an `eval` row with a `suite:` placeholder where the property is judged, and a `manual` row naming the falsifier in prose everywhere else.
- Features are proposed from the top-level directory structure and recent commits as `### F<n> · <name>` blocks with a one-line `Why:` and their matching ISCs nested underneath.
- Principles, Learning and Verification are left out as author-driven. Decisions is drafted and carries the seed's own notes: cited source artifacts, the README-seeded ISCs entry, a note where the sources say nothing about ambition, and the final note pointing to Interview.

## Anti-criteria

- Never overwrites: when `<project_path>/ISA.md` exists, the run aborts with `status: exists`.
- Never invents fiction: nothing in the draft, the ladder included, says what the sources do not; if the README is empty, the Vision section is empty.
- A seeded draft pointed at the wrong destination is worse than none; its ladder is never treated as confirmed direction.
- No `# TODO` marker in place of a Test Strategy row, and no ISC with zero rows.
- Does not run CheckCompleteness, score AI-generated content, or commit.
- No retired `satisfies:` pointer table, and no `(after: ISC-N)` edge where the ordering is not real.

## Inputs

| Input | Required | Description |
|-------|----------|-------------|
| project_path | yes | Repository root (where the new `ISA.md` will be written) |
| name | no | Project name; defaults to basename of project_path |
| depth | no | Default: the substantial-grade project-ISA minimum. Ask for a fully-fleshed deepest-grade bootstrap explicitly when wanted. |
| dry_run | no | Default false. If true, emit the proposed ISA to stdout instead of writing. |

## Safety gates

- **Pre-existing ISA:** If `<project_path>/ISA.md` exists, abort and emit `status: exists`. Seed never overwrites — the user uses Interview or Scaffold to deepen an existing project ISA.
- **No README:** abort with error. Seed needs at least one prose source. The user can manually create a stub README or run Scaffold from a prompt instead.
- **Does not treat its own ladder as confirmed.** The seeded L3 and L2 are a guess at the destination from the repository. Before building a new or changed direction on the ISA, the principal sees them through the Restate intent (not required otherwise), and the drift check (`bun LIFEOS/TOOLS/IsaLadder.ts drift <path>`) tests the criteria against L3.

## Output format

A new file at `<project_path>/ISA.md` populated with draft content sourced from the repository, plus this status report:

```yaml
status: created | dry_run | exists
path: <project_path>/ISA.md
sources_consulted:
  - README.md
  - package.json
  - tsconfig.json
  - last 30 git commits
  - existing PRD.md / SPEC.md / acceptance.yaml (if found)
sections_drafted: [Ideal State, Problem, Vision, Out of Scope, Constraints, Criteria, Test Strategy, Features, Decisions]
sections_skipped: [Principles, Learning, Verification]   # left for user to author
isc_count: 18
review_required: true
```

Seed is a **draft**: the human-author pass is mandatory before the ISA is treated as authoritative. That pass is a Discuss align round on the seeded ladder during the project's first task (`Skill("ISA", "discuss <isa> align")`), since a ladder inferred from code has never been confirmed by the person who wants it; the principal's `proceed` overrides, logged in Decisions.

### Frontmatter template

```yaml
---
project: <name>
name: <name>
task: "Project ISA — <name>"
phase: scoping
progress: 0/<criterion-count>
started: <ISO-8601>
updated: <ISO-8601>
---
```

### Section sources

- **Ideal State ladder.** L1 says what the project is, why it exists and how its parts relate, in plain prose that invents nothing the sources do not say. If the project has a clear deliverable (a CLI, a website, an app), L3 names it and why it matters; otherwise L3 is built from the README headline. The ladder states what the project is for at its best for the people it serves (ISAFormat § *What the ladder captures: the summit*), never a description of today's code; where the sources say nothing about ambition, note that in Decisions and raise it at Restate.
- **Problem.** If the README has a "Why" or "Motivation" section, lift it. Otherwise, infer from the README intro what the repo solves that wasn't solved before. Keep it 1–3 sentences.
- **Vision.** Lift the README's headline pitch + any "What it feels like to use this" prose. If the README is dry, leave Vision as a stub with a comment: `<!-- TODO: author Vision — what does euphoric surprise look like for this project? -->`
- **Out of Scope.** Mine for explicit "this is NOT" / "out of scope" / "we don't" / "non-goals" in README and PRD-shaped artifacts. If nothing found, leave a stub with a TODO comment.
- **Constraints.** Inferred from package.json, tsconfig, deploy configs: runtime (Bun-only, Node-compatible), framework (Hono, Astro, VitePress), deploy target (Cloudflare Workers, GitHub Pages), dependencies (zero deps, specific dep versions).
- **Criteria.** Each `*.test.ts` test name, `acceptance.yaml` entry or pre-existing checklist item is a candidate ISC. With no test suite or acceptance file, the 6–10 conservative ISCs cover build/deploy/typecheck plus the most obvious functional outcomes from the README, marked `[ ]`, with the Decisions entry: "ISCs ISC-1..N seeded from README. To be refined by the user."
- **Test Strategy.** Runnable rows use the obvious probe (build command, type-check, deploy command, an existing test file). Everywhere a probe is not obvious the row is `eval` or `manual` — never a `# TODO` marker and never no row, because a seeded ISA is assert-era and H8 will refuse to close a criterion with zero rows.
- **Features.** One `### F<n> · <name>` block with a one-line `Why:` per top-level subdirectory of `src/` or the main project directory, cross-referenced against recent commit messages to identify active features. Matching ISCs nest directly under each block (the `satisfies:` pointer table was retired in ISAFormat v2.16.0), and real cross-Feature ordering is a trailing `(after: ISC-N)` parenthetical on the dependent criterion (ISAFormat § Dependency edges), only where the ordering is real.
- **Principles, Learning, Verification.** Author-driven, so left out (empty sections never appear). The final Decisions note reads: "Seed-generated draft. Run `Skill('ISA', 'interview me on <path>')` to fill Principles, refine Vision and the Ideal State ladder, audit Criteria."

## Tool contract

- The Algorithm at run start on a project that has no `<project>/ISA.md` and the task is non-trivial: `Skill("ISA", "seed <project-path>")`
- User directly when onboarding a project: `Skill("ISA", "seed ~/Projects/<repo>")`
- Lazy-seed migration: a project's first task triggers Seed before any other intent.
- **Repository is too large:** if `git log --oneline | wc -l` > 5000, sample the most recent 100 commits for Features inference rather than walking everything.

### Repository sources

In priority order:

1. `README.md` — primary signal for the Ideal State ladder, Vision, sometimes Problem.
2. `package.json` — name, description, dependencies (informs Constraints — runtime, frameworks).
3. `tsconfig.json` / `bun.lockb` / `cloudflare.config.ts` (or a legacy `wrangler.toml`) / `vite.config.*` — Constraints (runtime, deploy target).
4. Recent 30 git commits — informs Features (what's actively being built).
5. Pre-existing PRD-shaped artifacts: `PRD.md`, `SPEC.md`, `SPECS.md`, `acceptance.yaml`, `acceptance.ts`, `requirements.md`. These become source material; cite them in Decisions.
6. Top-level directory structure — informs Features (auth/, ui/, api/, etc. → feature units).
