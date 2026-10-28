# Checkup — why is it red, is the ISA still the truth, and what does production say?

A full health check of an app against its ISA. Checkup joins what the repo knows (the ISA, the code, the rows) with what the world reports (the live monitor, Vigil events, Errata complaints, open Achilles findings), says why every red criterion is red, and repairs the ISA side until the ISA tells the truth again. Test runs the criteria and reports; Checkup is the run that acts on the answer.

## Ideal State

- The report rests on a `Tools/Checkup.ts` bundle gathered before any repair, and names every source the bundle lists under `unavailable` as unchecked, never as clean.
- The criteria results come from Test's tool contract (`Intents/Test.md`), run at the depth the Inputs table gives for the principal's words; Checkup never re-implements a criterion check.
- Every criterion that is red (failing live in the Bunker monitor, failing under Test, or open on a deployed app) carries exactly one cause from Output format § Causes, with the evidence that decided it.
- Each cause has its repair in the ISA: a broken row is fixed and re-run, a criterion with no executable eval gets one at the cheapest honest Assay tier and is run, a criterion that passes but was never ticked is ticked with an evidence stub, and an obsolete criterion is tombstoned with a Decisions row saying why.
- Every recent signal (Vigil event, Errata complaint, open Achilles finding) that no criterion covers becomes a new criterion with a Test Strategy row, or is dispositioned in the report as noise or out of scope with a reason.
- A complaint about something a passing criterion claims works is treated as a missed check: the criterion's row is tightened or a new row added until it fails on the defect the principal saw, and `bun LIFEOS/TOOLS/IsaLadder.ts drift <isa>` ran.
- The ISA meets the current standard after the run: `IsaCheck.ts bar` and `ISAGate.ts` show no finding the run could fix within its scope, and the remaining count is in the report.
- Criteria whose code is wrong (cause `code`) are listed in the report as Modify work, each with its failing evidence; they are fixed in the same run only when the principal asked for fixes.
- Checkup's last step, after the verdict and the red counts exist, is `bun "$ROOT/skills/Development/Tools/IsaCheck.ts" stamp <isa> --verdict <verdict> --before <n> --after <m>`. It writes the `checkup:` frontmatter key, so the next Checkup, Pulse and the principal can see when the app was last examined, and it earns `isa_format` only when conform is clean. A run that stops early writes no stamp.

## Anti-criteria

- No criterion turns green because its wording or its row was softened; a row change that makes a red criterion pass must still fail on the defect it was written to catch, shown by a negative control or `bunker verify-probe` where one exists.
- Checkup never writes production, deploys, or edits application code unless the principal asked for fixes, and then the code changes go through Modify.
- An L3 or L2 change never lands without the principal's yes (`Skill("ISA","restate")`).
- A signal is never matched to the app on name alone and acted on unread: `Checkup.ts` matches by name, so each matched signal is read before it becomes a criterion.
- "Audit", "review" or "assess" in the principal's words means a report with no ISA writes (constitutional rule 5).
> The Bunker CLI is maintainer-private and not in the public release; run code rows with `bun test ./<path>` and suite rows with `bun skills/Assay/Tools/EvalRunner.ts`.

## Inputs

| The principal says | Depth |
|---|---|
| "audit the ISA", "review", "assess" | Report only: gather, Test default depth, causes, proposed repairs. No writes. |
| "checkup", "health check", "get everything in sync" (default) | Gather, Test default depth, causes, ISA repairs, new criteria from signals. |
| "full checkup", "and run the evals" | As default, with Test's judged rows and `Skill("ISA","rate")` on the result. |
| "... and fix it" | As default, then the `code` list goes to `Intents/Modify.md` in the same run. |

The signal window defaults to 14 days; the principal's own window ("since the launch", "this month") overrides it.

## Safety gates

- `IsaCheck.ts write-probes` runs before any row touches production (Test's gate); a row it flags runs against local or staging only.
- The main session is the ISA's only writer. Lanes read and return causes and proposed edits; they never write ISA.md.
- A peer session's uncommitted edits in the ISA are left alone and reported.

## Tool contract

```bash
ROOT="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
bun "$ROOT/skills/Development/Tools/Checkup.ts" <repo> [--isa <path>] [--since 14d] [--name <alias>]... [--json]
#   one read-only bundle: ISA standard (IsaCheck bar, write-probes, ISAGate), code (git, Inventory sync),
#   production (Bunker monitor state: status and failing ISCs), signals (Vigil, Errata, open Achilles)
#   --name adds an alias when the app is adopted or logged under another name; exit 0 gathered, 2 bad input
bun "$ROOT/LIFEOS/PULSE/Bunker/bin/bunker.ts" verify-probe <isa> <isc>   # maintainer-side row engine, not in the public release: negative control for a repaired row
bun "$ROOT/LIFEOS/TOOLS/IsaLadder.ts" drift <isa>                         # when a complaint contradicts a passing criterion
bun "$ROOT/skills/Development/Tools/IsaCheck.ts" conform <isa> [--json]   # does the ISA use the latest template; names what is missing
bun "$ROOT/skills/Development/Tools/IsaCheck.ts" stamp <isa> --verdict <verdict> --before <n> --after <m>
#   the last step: writes frontmatter checkup:, and isa_format only when conform is clean; exit 0 written, 2 bad input
```

Criteria results: the commands in `Intents/Test.md` § Tool contract, at the depth above.

Execution follows SKILL.md § Execution. The tier comes from the red criteria and uncovered signals in scope, grouped by Feature, never from the ISA's size: a few red criteria in one Feature is tier 1 or 2, red spread across many Features is tier 3 or 4.

## Gotchas

- **The live red lives in the Bunker monitor state, not the ledger.** `bunker ledger --isa` returned nothing for two registered apps while `monitor-state.json` held 24 and 2 failing ISCs (2026-10-10). `Checkup.ts` reads the monitor state.
- **Errata entries can carry a `## Delivered conversation context` block inside the complaint and request fields**, so a whole-record match pulled 41 unrelated entries for one app; matching only the text before that block left 12 real ones (2026-10-10).
- **A recorded pass belongs to one revision of the whole criteria set.** `criteriaRevision()` in `LIFEOS/TOOLS/ISAGate.ts` hashes every Criteria, Features and Test Strategy line, so any edit anywhere in those sections resets every criterion to "no recorded result". On one large app, 264 recorded passes went to 0 when a peer session added ISC-353, twelve seconds after a full run (2026-10-10). Read `unrecorded` against the revision the run used, and check `git log -- ISA.md` for edits since the run before calling anything open.
- **The ISA page colours open anti-criteria red; ordinary open criteria stay grey** (`LIFEOS/TOOLS/ISARender/template.css`, `.isc.anti.pending`). Red on the page usually means an open anti-criterion, not a failing one.
- **A generic app name pulls strangers.** Name matching is whole-word, but a common word used as an app name can still match unrelated entries; read before acting.
- **Large ISAs have more standard findings than one run can fix** (one large app: 902 `bar` findings, 519 unnamed surfaces, 2026-10-10). Red on production comes first, then uncovered signals, then standard findings; the rest is counted in the report, not dropped silently.

## Output format

1. **Verdict.** `healthy`, `drifting` (green but the ISA misses what the signals show) or `red`, with red criteria before and after.
2. **Evidence.** One line per source with its count, and every unavailable source named as unchecked.
3. **Red criteria.** A table: criterion, cause, the evidence that decided it, what was done.
4. **Signals.** Each matched signal: the criterion it became, the criterion that already covers it, or why it was set aside.
5. **ISA standard.** Findings fixed and findings left, by kind.
6. **Modify work.** The `code` list, or what Modify changed when fixes were asked for.

### Causes

| Cause | What is true | Repair |
|---|---|---|
| `code` | The criterion is right and the app fails it | Listed as Modify work |
| `row` | The probe is wrong: moved file, stale URL, flaky, asserts the old behavior | Fix the row, re-run, prove it still catches the defect |
| `no-eval` | Only a `manual` row, or none: it was never measured | Write the cheapest honest row and run it |
| `unrecorded` | It passes now; the ISA never ticked it | Tick with an evidence stub |
| `environment` | The verifier could not run: auth expired, rate limit, service down | Skip, name the fix; never a pass or a fail |
| `obsolete` | The behavior was removed or replaced on purpose | Tombstone with a Decisions row |

## Examples

User: "Why are all these ISCs red on <app>?" → Checkup → the 24 monitor failures each carry a cause; rows fixed and re-run, `unrecorded` ones ticked, `code` ones listed for Modify, and the verdict shows red before and after.

User: "Audit the <app> ISA" → Checkup, report only → the same report with proposed repairs and no ISA edits.

User: "Health check <app> and fix it" → Checkup, then Modify on the `code` list in the same run.
