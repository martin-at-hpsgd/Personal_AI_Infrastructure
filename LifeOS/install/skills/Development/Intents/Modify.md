# Modify — change an app that already has an ISA

Changes, fixes or removes behavior in an app whose ISA already describes it. The ISA changes first, then the code follows.

## Ideal State

- The change is in the ISA before the code: new behavior has new criteria with rows, changed behavior has its criteria edited, and removed behavior has its criteria removed with a Decisions line saying why. Nothing leaves the ISA silently.
- A bug fix leaves a criterion behind: the fix added or tightened the criterion whose eval would have caught the bug, and that eval was seen failing before the fix made it pass.
- A change asked to behave the way the app already behaves elsewhere ("the same way it works for all other accounts") runs through the path that behavior already uses; a new branch special-cased for one instance is a miss (ERR-20261010-042100-5009).
- Direction is checked only when it moves: if the change alters L3 or L2, the principal confirmed the new ladder (`Skill("ISA", "restate <isa>")`) before code; otherwise no restate runs.
- New and edited criteria are atomic, one row each (`IsaCheck.ts bar` reports no finding on a new or edited criterion), and each carries its eval at the cheapest honest Assay tier (SKILL.md purpose paragraph).
- Changed criteria pass and nothing else broke: Test with `--feature F<n>` passes on each affected Feature, then the fast tier passes across the whole ISA.
- The run ended with the independent code review on each deployable repo it touched, its blockers fixed inside the run (SKILL.md § Safety gates).
- A run whose work ships leaves the repo's release record current before the deploy: `ReleaseRecord.ts prepare --isc "<criteria shipped>"` wrote the version bump and a plain-words CHANGELOG entry naming the criteria that changed with the code, and `ReleaseRecord.ts check` passes, because `CfEnv.ts deploy` refuses unrecorded code and a release whose ISA did not change with it (OPERATIONAL_PREFERENCES § Versioning; ISASystem.md § Code sync).
- Anything new the change adds that the principal will see or use has a reference they approved before code (SKILL.md § Acceptance), linked from the ISA; when their intent changed, the reference they approved changed first.
- Acceptance (SKILL.md § Acceptance) passed on what the change touches that the principal will see or use.
- The ISA records the run: criteria ticked with evidence, judgment calls in Decisions.

## Anti-criteria

- No code change to non-trivial behavior before its criteria change in the ISA; only a trivial change (a typo, a value, an obvious one-liner) is made with no ISA edit.
- Never delete or rewrite criteria, Decisions or the ladder that the principal or earlier runs wrote, except as the change requires and with a Decisions line.
- Never ships outside the project's gated deploy command (SKILL.md § Safety gates).
- Never clears its own review with `--allow-dirty`, `--waive-blockers` or `--past-round-cap` (SKILL.md § Safety gates).

## Tool contract

```bash
ROOT="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
bun "$ROOT/skills/Development/Tools/IsaCheck.ts" bar <repo>/ISA.md       # edited criteria still atomic, one row each
bun "$ROOT/skills/Development/Tools/IsaCheck.ts" acceptance <repo>/ISA.md --since <run start date>   # before the report, for work the principal will see or use
bun "$ROOT/LIFEOS/TOOLS/ReleaseRecord.ts" prepare <repo> --notes "<what shipped, in plain words>"   # before the deploy: version bump + CHANGELOG entry
bun "$ROOT/LIFEOS/TOOLS/ReleaseRecord.ts" check <repo>          # the same check CfEnv runs before every deploy
```

Then `Intents/Test.md` with `--feature F<n>` for each affected Feature, then the fast pass.
