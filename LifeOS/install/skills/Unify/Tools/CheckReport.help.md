# CheckReport

Checks a saved Unify Harmonize report against the parts of its output contract that code can judge. Whether a finding is real stays a human judgment.

## Usage

```bash
bun skills/Unify/Tools/CheckReport.ts <report.md> [--max-recs N] [--json]
```

| Flag | Meaning |
|------|---------|
| `<report.md>` | The saved report, usually `~/Downloads/Unify-<scope>-<YYYYMMDD>.md` |
| `--max-recs N` | Most recommendation rows allowed (default 8: the intent's "about seven") |
| `--json` | Print `{ok, problems, recommendations, harmonyRows, stragglerRows}` |
| `--help` | Print usage |

## Checks

- The eight parts appear in order: verdict, summit, inputs, harmony map, stragglers, unifying principle, recommendations, lens trail. A part is found on a markdown heading, a bold lead, or a numbered bold lead.
- Every harmony-map row names one of the seven relationships (reinforcing, productive tension, drift, duplication, straggler, conflict, gap) and has a non-empty Evidence (both sides) cell.
- Every stragglers row opens on a `path:line`. A stragglers part with no table passes, as an honest "none found".
- Recommendations number at most `--max-recs`, and each row fills its Resolves, Lands in and Proof cells.

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | Pass |
| 1 | Contract broken; each problem printed |
| 2 | Usage error or report not found |
