---
name: CreateSkill
metadata:
  short-description: "Create, edit, validate, test, and improve LifeOS skills, intents, tools, and descriptions. Use CreateCLI for standalone TypeScript CLIs."
evals:
  deterministic:
    - command: "bun LIFEOS/TOOLS/SkillHygieneGate.ts --skill CreateSkill"
      falsifier: "the hygiene gate exits nonzero for a forbidden skill-body token"
    - command: "bun LIFEOS/TOOLS/IntentLint.ts skills/CreateSkill --strict"
      falsifier: "the lint exits nonzero when SKILL.md or any intent here breaks the intent standard"
  manual:
    reason: "a maintainer judges whether generated skill instructions are useful and correctly scoped"
    falsifier: "the maintainer rejects the reviewed generated skill artifact"
version: 1.2.4
description: "Mandatory orchestrator for all LifeOS skill work: scaffold, edit, validate, canonicalize, test, and improve any skill; handrolling skill files is forbidden. USE WHEN create skill, new skill, make a skill, build a skill, set up a skill, private skill, make a X skill, add an intent, add a tool, edit/change/update/rename a skill, skill frontmatter, validate skill, check skill, canonicalize, scaffold skill, test skill, improve skill, optimize description, skill not triggering, overtriggering. NOT FOR TypeScript CLI generation (CreateCLI)."
---

# CreateSkill

**Contents:** Ideal State · Intent Routing · Data & Config · Gotchas · Examples

CreateSkill is the one door for skill work in LifeOS: it creates, edits, validates, canonicalizes, tests, improves and retires skills, and every skill it touches leaves written to the intent standard in `~/.claude/LIFEOS/DOCUMENTATION/Skills/SkillSystem.md` § Intent anatomy. An intent is a small ISA. It opens with `## Ideal State` (testable outcomes of the deliverable) and `## Anti-criteria` (what must never happen), then carries only Inputs, Safety gates, Tool contract, Gotchas, Output format, Examples and References. Choreography of the model's reasoning is cut, never relocated; the four keep-classes (safety gate, verified gotcha with provenance, tool contract, output-format contract) are the only legitimate how (`LIFEOS/RULES/Philosophy.md` § Ideal-State Prompting, `skills/Prompting/Standards.md`). This skill (`CreateSkill/SKILL.md` and its intents) is written to the standard it teaches and is the exemplar to copy.

Shared facts the intents rely on:

- Intents and skills are born from the template through `Tools/Scaffold.ts`, never `touch` or a hand-typed skeleton.
- The checks are code first: `LIFEOS/TOOLS/IntentLint.ts` (the standard), `LIFEOS/TOOLS/IntentPreserve.ts` (nothing load-bearing lost), `LIFEOS/TOOLS/SkillHygieneGate.ts` (publishable-clean), `LIFEOS/TOOLS/SkillCoverage.ts` (does this skill already exist). Judgment covers only what code cannot decide.
- An intent's Ideal State and Anti-criteria are also its grading criteria: Assay checks a run against them (`Proof.ts run --intent`) and builds a skill suite's rubric from them. Lanes and when suites run follow the one progressive contract, `skills/Assay/References/Progressive.md`.

## Ideal State

- Every skill CreateSkill touches opens with a purpose paragraph, a skill-level `## Ideal State` and an `## Intent Routing` section that reaches every intent and reference file in one hop, and every file over 100 lines with two or more H2s, outside directories routed as `Dir/`, carries its contents line.
- Every intent it writes or edits states done as testable Ideal State and Anti-criteria bullets and keeps only the four kinds of how, so a smarter model loses nothing by reading it.
- Nothing load-bearing is lost on the way: IntentLint, IntentPreserve, SkillHygieneGate and the skill's own tests pass, and the report shows each result.

## Intent Routing

### Structure

| Intent | Trigger | File |
|--------|---------|------|
| **CreateSkill** | "create a new skill" | `Intents/CreateSkill.md` |
| **ValidateSkill** | "validate skill", "check skill" | `Intents/ValidateSkill.md` |
| **UpdateSkill** | "update skill", "add intent" | `Intents/UpdateSkill.md` |
| **CanonicalizeSkill** | "canonicalize", "fix skill structure" | `Intents/CanonicalizeSkill.md` |
| **Retire** | "retire skill", "absorb skill", "delete a skill", "this skill is dead" | `Intents/Retire.md` |

### Effectiveness

| Intent | Trigger | File |
|--------|---------|------|
| **TestSkill** | "test skill", "does this skill work", "skill not working" | `Intents/TestSkill.md` |
| **ImproveSkill** | "improve skill", "skill quality", "fix skill instructions" | `Intents/ImproveSkill.md` |
| **OptimizeDescription** | "optimize description", "skill not triggering", "trigger accuracy" | `Intents/OptimizeDescription.md` |

### References

| File | Read when |
|------|-----------|
| `References/Conventions.md` | naming, public/private boundary, folder structure, SKILL.md shape, skill types, writing guidance, evals contract, versioning |
| `References/IntentTemplate.md` | the templates `Tools/Scaffold.ts` fills, and the standard bullets for common intent shapes |

## Data & Config

User customizations live at `<configRoot>/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/CreateSkill/` (`configRoot` is `$CLAUDE_CONFIG_DIR` when set, else `~/.claude`). When that directory exists, its PREFERENCES.md, configurations and resources apply and override the defaults here, including install-specific commands and paths for versioning; when it is absent, the defaults stand.

## Gotchas

- **No hook enforces "no handrolling" any more.** `SkillCreationGuard` (retired 2026-10-24) used to block a `Write` that created a new `skills/<Name>/SKILL.md` without a `CreateSkill` call in the session transcript, and it never saw Edit, MultiEdit, Bash creation (`cat >`, heredoc, `tee`), or new intents and tools. Today `/ic` catches a hand-rolled skill after the fact, and the rest is on you.
- **Reading these intents and working from them without the `Skill("CreateSkill")` call is handrolling.** `skills/CLAUDE.md` requires invoking the skill. The skill that mandates Gotchas sections went without one until 2026-06-13; the standard applies to this skill too.
- **A new SKILL.md reaches the AlgorithmNudge skill index without a writer bump.** The hook's fallback (`checkAndBumpSkillGenerationIfChanged` in `hooks/AlgorithmNudge.hook.ts`) walks `skills/*/SKILL.md` mtimes on each run and bumps the generation itself, so nothing here calls `bumpSkillGeneration()` (read 2026-10-09; this replaces the old note asking for the call to be wired).
- **`bun test <bare relative path>` drops every child process's stdout and stderr** (Bun 1.3.6). Always prefix: `bun test ./skills/<Skill>`.
- **Parallel rewrites inside one skill break its cross-file pointers.** In a skill-quality pilot, parallel rewrite units in one skill broke each other's cross-file § pointers and left sibling templates inconsistent. Rewrite SKILL.md first, then the intents, then make one pass over the whole skill for cross-file consistency.

## Examples

**Example 1: Create a new skill from scratch**
```
User: "Create a skill for managing my recipes"
→ CreateSkill intent
→ SkillCoverage record (ROUTE / ABSORB / NET-NEW), then Scaffold.ts writes SKILL.md and intents from the template
→ Intents filled with Ideal State and Anti-criteria; IntentLint --strict and SkillHygieneGate both exit 0
→ Announcement offers TestSkill against a no-skill baseline
```

**Example 2: Fix an existing skill that's not routing properly**
```
User: "The research skill isn't triggering - validate it"
→ ValidateSkill intent
→ IntentLint, SkillHygieneGate and the structural checks report exit codes; judgment covers only what they cannot decide
→ COMPLIANT / NON-COMPLIANT verdict with file:line evidence, OptimizeDescription suggested for the trigger
```

**Example 3: Bring a legacy step-by-step skill to the standard**
```
User: "Canonicalize my legacy Recipes skill"
→ CanonicalizeSkill intent
→ Each Step 1..N intent becomes Ideal State + Anti-criteria + keep-class sections, voice block removed
→ IntentLint zero errors, IntentPreserve zero missing tokens, skill tests pass as before
```
