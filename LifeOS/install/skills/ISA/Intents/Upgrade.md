# Upgrade

One ISA, a list, or every ISA on the install, checked against the current ISA template, brought up to it, and labelled with the template version it now meets.

## Ideal State

- Before anything is written, the run reports where each named ISA stands: the maintainer-side `IsaUpgrade.ts check` output (or, where that tool is absent, a by-hand reading) with the count behind the template and the finding codes (`section-missing`, `ladder-missing`, `criterion-no-row`, `order`, `retired-section`, `no-criteria`, `harness-shape`, `stamp-unearned`).
- Every finding a script can fix is fixed by the maintainer-side `IsaUpgrade.ts fix --write` where it is installed: invalid Test Strategy rows typed, `## Changelog` renamed `## Learning`, sections put in template order, and, when asked, a labelled `manual` row for each criterion with none.
- Every finding that needs judgment is fixed from the ISA's own content: the Ideal State ladder (L3 one sentence written from the summit; L2 one sentence and exactly four bullets on project, system and Features ISAs; L1 on project and system ISAs), `## Harness` on project ISAs for software a person drives (a draft yaml block built from commands the repo really has, or `None — <reason>`), and real assert rows where a criterion is literal and the command was run and passed.
- Every ISA that ends conforming carries the label `IsaCheck.ts stamp` writes: `isa_format: <template>` and `checkup: <date> upgraded <n>→0` (or `current 0→0` when it already conformed), so Pulse and the next run can see what version it meets and when it was checked.
- The report names the before and after counts, how many ISAs were stamped, and every ISA left behind with its remaining codes and the reason (a peer's uncommitted edit, a stub with no recorded work, a judgment fix not yet made).

## Anti-criteria

- No `isa_format` or `checkup` key written by hand or by any tool except `IsaCheck.ts stamp`, and none on an ISA that does not conform.
- No criterion id or text, phase, or progress changed, and no content lost, by the format upgrade (adding criteria to an ISA that has none is the one exception, and it carries a dated comment and the matching `progress:`).
- No write to an ISA with uncommitted changes, an untracked ISA, or an ISA under a backup directory.
- No probe row that cannot fail, and no assert row whose command was not run.
- No ladder, Harness command or criterion invented from outside the ISA and its repo.

## Inputs

- The ISAs: a path, several paths, or `--estate` for every system, project and task ISA the install knows.
- Whether rowless criteria get `manual` rows now (`--rows manual`). Closed history takes them; a live project ISA gets real asserts first and manual rows only where nothing executable exists.

## Safety gates

- **Dry run first.** `fix` without `--write` prints what it would change; read it before writing an estate.
- **Shared trees.** The tool refuses dirty and untracked files on its own. Commit each repo's ISAs with explicit paths (`LIFEOS/TOOLS/CommitOwn.ts` in the private trees, `git commit --only` elsewhere), never `git add -A`.
- **The format-upgrade tool is maintainer-side.** `LIFEOS/TOOLS/IsaUpgrade.ts` does not ship with the public install. Where it is absent, this intent runs without it: read each ISA against `LIFEOS/DOCUMENTATION/ISA/ISAFormat.md`, use `IsaCheck.ts conform` for the template check where that tool is present, and report the findings (section missing, ladder missing, criterion with no row, order, retired section) as a list. Nothing is rewritten in bulk; any fix is a hand edit that follows the judgment-fix rules here, and the stamp still comes only from `IsaCheck.ts stamp`.
- **Closed ISAs stay closed.** An Edit or Write tool call on a `phase: complete` ISA makes the ISA sync hook reopen it. the maintainer-side `IsaUpgrade.ts` writes straight to disk for that reason; a judgment fix on a closed ISA does the same with a `bun -e` read-insert-write (function replacer or `split(a).join(b)`, never a replacement string containing `$`).

## Tool contract

Run from the config root. The `IsaUpgrade.ts` commands below exist only on the maintainer's install; on an install without `LIFEOS/TOOLS/IsaUpgrade.ts` see the safety gate above and check by reading.

```bash
bun LIFEOS/TOOLS/IsaUpgrade.ts check <isa...> | --estate [--json]   # maintainer-side, not in the public release
#   read-only: conform per ISA, tallied by finding code. Exit 0 all conform, 1 some behind, 2 usage
bun LIFEOS/TOOLS/IsaUpgrade.ts fix <isa...> | --estate [--write] [--rows manual] [--stamp] [--json]   # maintainer-side, not in the public release
#   mechanical fixes only; dry run without --write; --stamp needs --write and stamps every ISA that ends conforming
#   per ISA: outcome (written | would-write | skipped | refused | unchanged | latest), before→after, left: <codes>
bun skills/Development/Tools/IsaCheck.ts conform <isa> [--json]       # the template check itself
bun skills/Development/Tools/IsaCheck.ts stamp <isa> --verdict upgraded --before <n> --after 0
#   the one writer of isa_format and checkup; writes isa_format only when conform is clean
bun LIFEOS/TOOLS/IsaLadder.ts check <isa>     # ladder shape; floor warnings are advisory
bun LIFEOS/TOOLS/IsaLadder.ts migrate <isa>   # folds a bare `## Goal` / `## Articulation` into the ladder (a model writes L3/L2)
```

### Intent-to-Flag Mapping

| The ask | Flags |
|---|---|
| "is this ISA current", "check format" | `check <isa>` |
| "are all our ISAs on the latest format" | `check --estate` |
| "upgrade this ISA" | `fix <isa> --write`, the judgment fixes, then `IsaCheck.ts stamp` |
| "upgrade them all and label them" | `fix --estate --write --rows manual --stamp`, then the judgment fixes on what is left, then stamp those |

## Gotchas

- **`conform` decides, never the stamp.** An ISA claiming `isa_format: 2.30.0` that no longer meets the template shows `stamp-unearned`; it clears on its own once the other findings are fixed (2026-10-13 estate upgrade).
- **`## Harness` is required on every non-task ISA by `conform`,** including LifeOS system ISAs and libraries; those take `None — <reason>`. Task ISAs never need it.
- **A project root reached through a symlink breaks the `HEAD` comparison.** Resolve it with `realpathSync` before comparing against `HEAD`, or `git show` comes back empty and every file looks changed (2026-10-13; the install-specific path layout is in USER `CUSTOMIZATIONS/SKILLS/ISA/History.md`).
- **Subagents cannot write ISAs the main session owns** (`SubagentShipGuard`): delegates build candidates in a scratch folder and the main session checks and installs them.

## Output format

A table of scopes (system, project, task) with ISAs before and after behind, the number stamped, then one line per ISA still behind: path, remaining codes, reason.

## Examples

```
User: "are all our ISAs on the latest format?"
→ check --estate → "1185 of 1227 conform to 2.30.0; 42 behind: 30 section-missing, 19 criterion-no-row …"
```

```
User: "upgrade them all and label them"
→ fix --estate (dry run) → fix --estate --write --rows manual --stamp
→ ladders, Harness and rows on what is left → IsaCheck.ts stamp each → commits per repo
```

## References

- `LIFEOS/DOCUMENTATION/ISA/ISAFormat.md` — the template; § Field Rules for `isa_format` and `checkup`, § `## Harness`, § The Ideal State ladder.
- `skills/Development/Intents/Checkup.md` — the full app health check, which also ends with the stamp.
