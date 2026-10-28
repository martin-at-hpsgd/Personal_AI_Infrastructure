# UpdateSubstrateMetrics.ts

Fetches the latest value of every configured metric (FRED, EIA weekly gas price, Treasury FiscalData debt to the penny) and rewrites the local US-Common-Metrics dataset. Used by the UpdateData intent.

```bash
bun ~/.claude/skills/USStats/Tools/UpdateSubstrateMetrics.ts             # fetch and write
bun ~/.claude/skills/USStats/Tools/UpdateSubstrateMetrics.ts --dry-run   # fetch, write nothing
```

| Flag | Effect |
|------|--------|
| `--dry-run` | fetch every metric, print the byte counts and a CSV sample, write nothing |
| `-h`, `--help` | usage |

Environment: `FRED_API_KEY` (required), `EIA_API_KEY` (gas price; skipped with a warning when absent), `USMETRICS_DATA_DIR` (dataset directory; default `~/.claude/LIFEOS/USER/DATA/US-Common-Metrics`).

Files in the dataset directory:

| File | What the updater does |
|------|-----------------------|
| `US-Common-Metrics.md` | must exist (seed it from `seed_source` in `<configRoot>/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/USStats/Config.md`); rewrites the `**Last Updated:**` line, the Quick Reference Dashboard, and each metric row's Value and Updated cells, and collapses rows an older run widened |
| `us-metrics-current.csv` | overwritten with `metric_id,metric_name,value,formatted_value,period,updated,source` |
| `us-metrics-historical.csv` | appended (`fetch_timestamp,metric_id,value,period`); created with that header when missing |

Exit codes: 0 written (or dry run), 1 missing `FRED_API_KEY`, missing directory, unseeded directory (no `US-Common-Metrics.md`), or zero metrics fetched. A failed metric is named in the `Failed:` line and the rest are written.
