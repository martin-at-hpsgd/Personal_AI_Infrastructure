# Build — intent in, ISA criteria, then code that passes them

Turns what the principal wants into criteria in an ISA, then builds until they pass. Covers a new project, a new feature, and an existing repo that has no ISA yet.

## Ideal State

- Anything the principal will see or use has a reference they approved before code was written (SKILL.md § Acceptance), and the ISA links it.
- The ISA points at the right thing: for a new project or a changed direction, the ladder records the date the principal confirmed L3 and L2 (`Skill("ISA", "restate <isa>")`), and that date precedes the code; an existing ISA whose direction is unchanged needs no restate.
- Criteria exist in the ISA before the code that satisfies them. A new project's ISA comes from `Skill("ISA", "scaffold from prompt: <intent> — project ISA at <repo>/ISA.md")`; an existing ISA is extended in place.
- An existing repo with no ISA ends with every surface the inventory lists as a criterion, fog, out of scope, or killed with a reason, drafted through `Skill("ISA", "seed <repo>")`. Criteria read off the code are tagged `observed` until the principal ratifies them, and that first ISA's inferred L3 and L2 go through Restate as a new project's would.
- The ISA lives at `<repo>/ISA.md`; one Scaffold wrote under `LIFEOS/MEMORY/WORK/` is moved there or registered in the projects table, since the guard refuses builders aimed at a repo with neither.
- Every criterion is atomic and carries its eval at the cheapest honest Assay tier (SKILL.md purpose paragraph). `IsaCheck.ts bar` exits 0, and checking the ISA takes seconds for asserts and judgment-layer questions.
- Heard and inferred intent stay apart: anything filled in rather than heard is tagged `inferred` and listed for ratification.
- The code passes: every criterion in scope passes under Test (`Intents/Test.md`), and every new test was seen failing before the change made it pass.
- Where a second look was warranted (the ISA names one for a Feature, or the change touches auth, payments, migrations, secrets or deploy), a model that did not build it checked it.
- The run ended with the independent code review on each deployable repo it touched, its blockers fixed inside the run (SKILL.md § Safety gates).
- A run whose work ships leaves the repo's release record current before the deploy: `ReleaseRecord.ts prepare --isc "<criteria shipped>"` wrote the version bump and a plain-words CHANGELOG entry naming the criteria that changed with the code, and `ReleaseRecord.ts check` passes, because `CfEnv.ts deploy` refuses unrecorded code and a release whose ISA did not change with it (OPERATIONAL_PREFERENCES § Versioning; ISASystem.md § Code sync).
- On large or high-blast work, a model that did not write the ISA read its criteria for compound criteria, Features with no end-to-end criterion, and judged rows that would pass the wrong thing.
- Acceptance (SKILL.md § Acceptance) passed before deploy and again on the live thing after it.
- The ISA records the run: criteria ticked with one-line evidence, judgment calls in Decisions, `phase:` and `progress:` current.

## Anti-criteria

- No application code before its criteria exist, except a trivial change (a typo, a value, an obvious one-liner), which needs no ISA.
- Never asks the principal for a fact the repo, deploy state or prior ISAs could answer.
- Behavior that looks wrong in an existing repo never becomes a criterion; it goes on a suspected-defects list.
- Never starts a second ISA, or deletes a thin existing one, when one already exists for the project.
- Parallel builders never write the same files: each gets disjoint files or `isolation: worktree`, and each shared registry (package manifest, lockfile, route index, migrations) has exactly one writer.
- Build never deploys (SKILL.md § Safety gates), and no row that writes data targets production.
- Build never clears its own review with `--allow-dirty`, `--waive-blockers` or `--past-round-cap` (SKILL.md § Safety gates).

## Tool contract

```bash
ROOT="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
bun "$ROOT/skills/Development/Tools/Inventory.ts" <repo> --json          # existing repo: surface list
bun "$ROOT/skills/Development/Tools/IsaCheck.ts" bar <repo>/ISA.md       # atomic criteria, one row each
bun "$ROOT/LIFEOS/TOOLS/IsaLadder.ts" drift <repo>/ISA.md                # criteria still match L3
bun "$ROOT/skills/Development/Tools/IsaCheck.ts" acceptance <repo>/ISA.md --since <run start date>   # before the report, for work the principal will see or use
bun "$ROOT/LIFEOS/TOOLS/ReleaseRecord.ts" prepare <repo> --notes "<what shipped, in plain words>"   # before the deploy: version bump + CHANGELOG entry
bun "$ROOT/LIFEOS/TOOLS/ReleaseRecord.ts" check <repo>          # the same check CfEnv runs before every deploy
```

Then `Intents/Test.md` proves the result.

## Gotchas

- **`Skill("ISA", "seed …")` refuses when `ISA.md` already exists.** A repo with a thin ISA gets that ISA extended in place; never delete it to make Seed run.
