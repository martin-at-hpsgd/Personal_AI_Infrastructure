# CanonicalizeSkill

**Contents:** Ideal State · Anti-criteria · Safety gates · Tool contract · Gotchas · Output format · Examples · References

A legacy skill migrated to the intent standard and the canonical structure without any change to what it does.

## Ideal State

- `bun LIFEOS/TOOLS/IntentLint.ts skills/<Skill>` reports zero errors: every intent opens with `## Ideal State` and `## Anti-criteria`, SKILL.md and the intents carry no `## Voice Notification` block, no notify curl and no "Running the X intent" line remains, and a skill with no `Intents/` carries both sections in SKILL.md. Remaining warnings are listed with the reason each is kept.
- Nothing load-bearing was lost: `bun LIFEOS/TOOLS/IntentPreserve.ts --base <rev> skills/<Skill>` exits 0 against the commit before the migration, with every deliberate removal in an allow file that names its reason.
- The skill's own tests pass exactly as before: the `bun test ./skills/<Skill>` pass set was captured before the first edit and the run after it matches.
- Each Ideal State and Anti-criteria was extracted from what the old intent was trying to achieve: its steps, done sections, gotchas and output specs. A reader comparing old and new can trace every bullet to old text, and every outcome the old intent produced still has a bullet.
- An intermediate output the old steps required before the deliverable (a CSE before an essay, a storyboard before a render) is an Ideal State bullet saying it existed and was checked first, and is also in frontmatter `contract.requires` when it is a file.
- Every safety gate, verified gotcha, tool contract, path, flag and output format from the old files sits in its allowed section (`## Safety gates`, `## Gotchas`, `## Tool contract`, `## Output format`); environment facts and worked examples stay as Inputs, Examples or References. An order the tools themselves require survives as an ordered recipe under `## Tool contract`.
- `## Done looks like`, `## Done` and `## The Deliverable` became `## Ideal State`. SKILL.md opens with a skill-level `## Ideal State` (what the skill delivers across its intents) directly followed by `## Intent Routing`; outcomes that belong to one deliverable live in that intent, never both places.
- The legacy structure is canonical too: directory and file names per `References/Conventions.md` § Naming, no .md nested inside Intents/, frontmatter converted to a single-line `description` with `USE WHEN` plus `version:`, `metadata.short-description` and an `evals:` disposition, with every harness key (`context`, `background`, `allowed-tools`, `model`, `effort`, any key off the permitted list) dropped and `disallowed-tools` kept only where it holds the skill read-only (and `NOT FOR` where a neighbor shares vocabulary, in the form `References/Conventions.md` § SKILL.md shape and loading gives, with the neighbor named in the report), one `## Intent Routing` section directly after the skill-level Ideal State, routing every intent and naming every reference and root `.md` file (and every other `.md` directory as `Dir/`), every file over 100 lines with two or more H2s, outside directories routed as `Dir/`, carrying its `**Contents:**` line from `SkillContents.ts --write`, reference docs at the skill root or in `References/` and never in `Intents/`, `## Data & Config` present when the skill reads USER data or customizations, `## Gotchas` and `## Examples` present, SKILL.md under 500 lines.
- The skill's pre-migration state is recoverable from git: the base rev recorded before the first edit holds every file the migration touched, committed and clean, and the report names that rev.

## Anti-criteria

- No change to what the skill does: no tool, flag, path, safety gate, permission check or gotcha removed, and no behavior added.
- Choreography is cut, never relocated: no numbered list of thinking moves relabelled as a Tool contract, Gotchas or Output format.
- No gotcha invented to keep a procedure alive. A "gotcha" with no dated incident, failing test or reproduction is methodology and is cut.
- No over-cutting: declarative facts, domain invariants, API shapes and worked examples are not choreography and stay.
- No migration of a file that holds another session's uncommitted changes, and no peer lines swept into this work.
- No backup inside the skill directory.
- No existing content retyped by hand or by a model: it reaches the new file only through `Codemod.ts` or as verbatim line ranges in an `ApplyIntentPlan.ts` plan.

## Safety gates

- **The base rev is the backup, and stop without it.** Every later change is in place, so no file is edited until `git rev-parse HEAD` is recorded and `git status --short skills/<Skill>` shows the files to be migrated clean; restoring a file is then `git show <rev>:<path>`. A skill outside a git work tree gets a full copy in `~/.claude/BACKUPS/<Skill>-backup-<YYYYMMDD>/` instead, and no file is edited until that copy succeeds.
- **Shared tree.** `git status --short skills/<Skill>` before the first edit. Any file with uncommitted changes this session did not make is left alone and reported; it migrates later, once clean.
- **Renaming the skill directory is a major change.** Describe it and wait for the principal's yes before the rename.
- **Baseline before edit.** The test pass set and the IntentPreserve base rev are recorded before the first edit; a migration with no baseline cannot show parity and is not done.

## Tool contract

Run from `~/.claude`. The baseline comes before any edit; the checks come after the last one.

```bash
git status --short skills/<Skill>                   # files to migrate must be clean
git rev-parse HEAD                                  # the backup, and the --base for IntentPreserve
bun test ./skills/<Skill>                           # baseline pass set; the ./ prefix is required

bun LIFEOS/TOOLS/SkillContents.ts --write skills/<Skill>   # contents lines on files over 100 lines, after the last edit
bun LIFEOS/TOOLS/IntentLint.ts skills/<Skill>
bun LIFEOS/TOOLS/IntentPreserve.ts --base <rev> [--allow <reasons.tsv>] skills/<Skill>
#   allow file: one line per deliberate removal, <repo-relative path>\t<token>\t<reason of 8+ chars>
#   the voice curl and "Running the X intent" lines are exempt automatically
bun test ./skills/<Skill>                           # must match the baseline pass set
bun ~/.claude/LIFEOS/TOOLS/SkillHygieneGate.ts --skill <SkillName>   # --no-deny-list on an install with no deny-list (exit 2 otherwise)
```

Canonicalization at scale runs the codemod first, then a model writes one plan per intent and the applier builds the file from it, so existing text only ever moves as verbatim line ranges. The IntentPreserve `--base` is the commit before the codemod, and both tools append to the same allow file.

```bash
bun skills/CreateSkill/Tools/Codemod.ts skills/<Skill> --dry-run       # what the mechanical pass would change
bun skills/CreateSkill/Tools/Codemod.ts skills/<Skill> --allow-out <reasons.tsv>
#   removes voice sections, curl fences, Running lines and their labels; renames ## Done… to ## Ideal State
#   and ## Customization to ## Data & Config; skips any file with uncommitted changes (skipped-dirty)
bun skills/CreateSkill/Tools/ApplyIntentPlan.ts --plan <plan.json> --check                       # validate, write nothing
bun skills/CreateSkill/Tools/ApplyIntentPlan.ts --plan <plan.json> --allow-out <reasons.tsv>
bun skills/CreateSkill/Tools/ApplyIntentPlan.ts --plan <plan.json> --skill-md --allow-out <reasons.tsv>
#   plan shape: IntentPlan in ApplyIntentPlan.ts, with the sha256 of the file it was written against;
#   every non-blank line lands in a section block (moved verbatim) or a cut with a reason of 12+ chars,
#   and each token a cut removes goes to the allow file with that reason. Exit 1 = refused, nothing written.
```

Finding nested folders, and renaming to TitleCase:

```bash
# Folders 3+ levels deep: under Intents/ they are an IntentLint error (nested-intent) and are flattened;
# elsewhere (Templates/Primitives/) two levels is the target, not a rule, and they stay routed by their top-level Dir/
find ~/.claude/skills/[SkillName]/ -type d -mindepth 2 -maxdepth 3
```

Renames follow `References/Conventions.md` § Naming (`create.md` becomes `Create.md`, `sync_repo.md` becomes `SyncRepo.md`), and a rename or a flatten updates every reference to the old path in the same edit.

## Gotchas

- **`bun test <bare relative path>` drops child-process output** (Bun 1.3.6), so spawn-based tests fail with empty output. The `./` prefix is not optional.
- **IntentPreserve compares against a git rev.** Lines a peer added since that rev but never committed are not in the base and are not protected; that is why a file with foreign uncommitted changes is not migrated.

## Output format

### Where legacy content lands

| Legacy content | New home |
|---|---|
| `## Voice Notification`, notify curl, "Running the **X** intent…" line | Removed (the intent voice, `hooks/lib/intent-voice.ts` run from `hooks/EventLogger.hook.ts`, announces intents) |
| `## Done looks like` / `## Done` / `## The Deliverable` | `## Ideal State` bullets |
| What the numbered steps were for | `## Ideal State` outcomes; the steps themselves are cut |
| "Step 1: read X first" where the deliverable depends on X | Ideal State bullet that X was read or produced first; `contract.requires` when X is a file |
| "Never…", "Don't…", "Stop if…" | `## Anti-criteria`, or `## Safety gates` when it guards an action |
| Confirmations, approvals, backups, destructive-op guards | `## Safety gates` |
| Exact commands, flags, API parameters, paths, exit codes, tool-required order | `## Tool contract` |
| Dated or reproduced failures | `## Gotchas` (undated "be careful" lines are cut) |
| Templates, schemas, required report shapes | `## Output format` |
| Worked examples | `## Examples` |
| Pointers to docs and config | `## References` |
| SKILL.md-level Ideal State in a skill with intents | Stays in SKILL.md when it describes the skill as a whole; bullets about one deliverable move to that intent |
| A reference linked only from another reference | A row in SKILL.md's File / Read when table |
| Old YAML `triggers:` / `workflows:` / `intents:` arrays | Single-line `description` with `USE WHEN`; routing moves to the body table |

### Report

The report lists each file changed, the IntentLint totals before and after, the IntentPreserve exit code with every allow-file entry and its reason, the test pass set before and after, the hygiene-gate exit code, and the base rev (or the backup path for a skill outside git).

## Examples

Frontmatter, from the old format to the new:

```yaml
---
name: skill-name
description: |
  What the skill does.

triggers:
  - USE WHEN user mentions X
  - USE WHEN user wants to Y

workflows:
  - USE WHEN user wants to A: Intents/a.md
  - USE WHEN user wants to B: Intents/b.md
---
```

```yaml
---
name: SkillName
version: 1.0.0
description: What the skill does. USE WHEN user mentions X OR user wants to Y. NOT FOR Z (OtherSkill).
metadata:
  short-description: "What the skill does, in one plain sentence."
evals:
  deterministic:
    - command: "bun test ./skills/<SkillName>"
      falsifier: "a test fails when the skill breaks its contract"
---
```

Flattening: rename `Category/File.md` to `CategoryFile.md`, move it up one level, and update every reference to the old path.

```
✗ WRONG: Intents/Company/DueDiligence.md
✓ FIX: Intents/CompanyDueDiligence.md
✗ WRONG: Tools/Utils/Helper.ts
✓ FIX: Tools/Helper.ts (or delete if not needed)
```

```bash
# Before (3 levels - WRONG)
skills/Example/Intents/Company/DueDiligence.md

# After (2 levels - CORRECT)
skills/Example/Intents/CompanyDueDiligence.md
```

A legacy routing section, consolidated into the single standard table (duplicate routing tables or sections are deleted):

```markdown
| Intent | Trigger | File |
|----------|---------|------|
| **IntentOne** | "trigger phrase one" | `Intents/IntentOne.md` |
| **IntentTwo** | "trigger phrase two" | `Intents/IntentTwo.md` |
```

A skill with no known gotchas yet keeps the section with a placeholder:

```markdown
## Gotchas

_No gotchas documented yet. Add failures here as they're discovered._
```

A step-list intent, before and after:

```markdown
## Step 1: Read the post
## Step 2: Run a story explanation on it
## Step 3: Write the header image prompt from the CSE
## Step 4: Generate and check the image
```

```markdown
## Ideal State

- A story explanation of the post existed before the image prompt was written, and the prompt draws its subject from it.
- The delivered header image depicts the post's central idea, at the size and style the skill's Output format names.

## Anti-criteria

- Never writes the image prompt from an impression of the post instead of the story explanation.
```

## References

- `~/.claude/LIFEOS/DOCUMENTATION/Skills/SkillSystem.md` § Intent anatomy — the target standard.
- `References/IntentTemplate.md` — the target shape and the standard bullets for common intent shapes.
- `References/Conventions.md` — naming, folder structure, SKILL.md shape.
- `LIFEOS/RULES/Philosophy.md` § Ideal-State Prompting — the keep-classes and the provenance bar for gotchas.
