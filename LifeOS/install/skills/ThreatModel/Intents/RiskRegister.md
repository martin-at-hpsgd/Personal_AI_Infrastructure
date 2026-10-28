# RiskRegister

Operate the persistent risk register — add, list, update, review, close — via the deterministic CLI.

## Ideal State

- Every register change went through `Tools/RiskRegister.ts`, so the JSON store stays the system of record and `RiskRegister.md` stays a generated view.
- Every risk carries a `review_by` date and a `scope` naming whose data is at risk and who owns the mitigation; a product the business sells is the business's scope even when the operator built it.
- Every open High or Critical row carries a `--telos-ref Rn` naming its parent life risk in TELOS, so a failure here reads one level up as that `Rn` going red (`References/Continuous.md` § Two tiers).
- A review leaves each due risk checked (still valid? mitigated? accept?), its status updated and its `review_by` pushed forward, and surfaces any Critical/High with no owner or no mitigation.
- An accepted risk stays visible in the register with `--status accepted` and a rationale in `--notes`.
- The report names what changed (added/updated/closed IDs), the current Critical/High count from `stats`, and anything overdue that still needs a decision.

## Anti-criteria

- `RiskRegister.md` is never hand-edited; the next write overwrites it.
- Accepting a risk is never a delete.
- A score or level is never typed into the JSON store or the `.md` view: the CLI computes both from likelihood and impact on `add` and `update`.

## Output format

The report described in the last Ideal State bullet. Scores, levels and impact anchors follow SKILL.md § Risk Scoring; the data dir and its override are in SKILL.md § Data & Config (safety gate).

## Tool contract

```bash
T="bun ~/.claude/skills/ThreatModel/Tools/RiskRegister.ts"
$T init                    # scaffold data dir + empty register
$T stats                   # posture snapshot
$T list                    # open risks, highest score first
$T review [--scope S]      # risks overdue or missing a review date
$T render --scope business # one scope's rows as a standalone markdown register (stdout)
$T show R-001
$T export                  # regenerate the RiskRegister.md view
```

| User says | Command |
|---|---|
| "add a risk", "log this risk" | `add --title … --threat … --likelihood N --impact N [--assets a,b --data-classes x,y --owner O --mitigation M --response REF --review-by DATE --telos-ref Rn]` |
| "what are our risks", "show the register" | `list` (add `--all` to include closed, `--level Critical` to filter) |
| "run a risk review", "what's overdue" | `review [--scope S]` |
| "the business risks", "one entity's register", "export this scope" | `list --scope S` / `render --scope S` |
| "update / rescore R-001" | `update R-001 [--likelihood N --impact N --status S --add-mitigation M --owner O --review-by DATE --telos-ref Rn]` |
| "accept R-001" | `update R-001 --status accepted --notes "accepted by <owner>: <rationale>"` |
| "close / retire R-001" | `close R-001 --reason "…"` |
| "posture snapshot", "how many criticals" | `stats` |

Valid scopes are `personal` plus the entities listed in `scopes.json` in the data dir (e.g. `{ "scopes": ["personal", "acme"] }`); the shipped default is `personal` | `business`. Set it with `--scope` on `add` or `update`; it defaults to `personal`.
