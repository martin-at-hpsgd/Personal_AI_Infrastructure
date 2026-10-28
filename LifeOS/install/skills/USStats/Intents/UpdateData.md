# UpdateData

**Contents:** Ideal State · Anti-criteria · Tool contract · Inputs · Output format · Examples

Current data fetched from all three sources (FRED, EIA, Treasury FiscalData; the count and category list are in SKILL.md's purpose paragraph) and written to the local US-Common-Metrics dataset. GetCurrentState's report does its own fetch; this dataset is where metrics outside that report are quoted from. Ported from the retired USMetrics skill on 2026-10-10 with nothing dropped.

## Ideal State

- The local dataset holds the latest FRED, EIA and Treasury FiscalData values: `US-Common-Metrics.md` shows current values in place of placeholders, `us-metrics-current.csv` has one row per fetched metric, and `us-metrics-historical.csv` ends with this update's timestamped rows.
- The update log names every failed fetch and skipped source, so the state of each metric is known from the run's output.
- Each output file matches its shape under Output format, so any reader of the dataset can parse the populated files.
- A partial update marks which metrics are stale in its output; an API failure logs which metrics failed and the others continue; a missing API key is warned about and that source skipped.
- An unseeded dataset directory is reported before any fetch, with the seeding instruction, never a raw file-not-found.

## Anti-criteria

- One API failure or missing API key never aborts the whole update: that source is logged or warned and skipped, and the other metrics continue.
- No stale metric is left unmarked after a partial update.
- Never ignores provider rate limits: delays are implemented between requests.
- Never writes to the almanac site, its upstream datasets, or any other system's copy of the metrics: this intent writes only the local dataset directory.

## Tool contract

```bash
bun ~/.claude/skills/USStats/Tools/UpdateSubstrateMetrics.ts
bun ~/.claude/skills/USStats/Tools/UpdateSubstrateMetrics.ts --dry-run   # fetch, write nothing, print sample CSV
```

It writes to the dataset directory — `$USMETRICS_DATA_DIR` if set, otherwise `~/.claude/LIFEOS/USER/DATA/US-Common-Metrics/`. The directory must hold `US-Common-Metrics.md` first: seed it from the source named by `seed_source` in `<configRoot>/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/USStats/Config.md` (copy `US-Common-Metrics.md`, `us-metrics-current.csv`, `us-metrics-historical.csv`, and `source.md` for methodology), or point `USMETRICS_DATA_DIR` at an existing checkout of that dataset. Exit 1 on a missing `FRED_API_KEY`, a missing directory, an unseeded directory, or zero metrics fetched; `Tools/UpdateSubstrateMetrics.help.md` has the rest.

### Intent-to-Flag Mapping

| User says | Flag | Effect |
|-----------|------|--------|
| "update metrics", "refresh data", "pull latest" | (none) | fetch every metric, rewrite the three dataset files |
| "what would it pull", "test the refresh" | `--dry-run` | fetch, print byte counts and a CSV sample, write nothing |
| "use my dataset checkout" | `USMETRICS_DATA_DIR=<dir>` | read and write that dataset directory instead |

## Inputs

### API Sources

| Source | API | Metrics | Auth |
|--------|-----|---------|------|
| **FRED** | api.stlouisfed.org | GDP, CPI, unemployment, rates, etc. | FRED_API_KEY |
| **EIA** | api.eia.gov | Gas prices, oil prices | EIA_API_KEY |
| **Treasury** | api.fiscaldata.treasury.gov | Federal debt, budget | None |

### Update Schedule Recommendation

| Frequency | Metrics |
|-----------|---------|
| Daily | Treasury yields, oil prices, federal debt |
| Weekly | Gas prices, jobless claims, mortgage rates |
| Monthly | CPI, employment, GDP, housing data |

### Notes

- FRED is the primary aggregator - most metrics come through FRED even if original source is BLS/BEA/etc.
- Treasury FiscalData is used directly for daily debt figures
- EIA is used directly for energy prices (more current than FRED)
- Some annual metrics (population, GINI) only update once per year
- This intent keeps its own local dataset rather than reading any other system's copy of the same pull; install-specific notes live in `<configRoot>/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/USStats/Config.md`.

## Output format

### US-Common-Metrics.md

The markdown file gets values populated in the metric tables:

```markdown
| Metric | Value | Period | Updated | Source |
|--------|-------|--------|---------|--------|
| Real GDP | $22.67T | Q3 2024 | 2024-11-27 | BEA/FRED |
| CPI YoY | 2.6% | Oct 2024 | 2024-11-13 | BLS/FRED |
```

### us-metrics-current.csv

The header `UpdateSubstrateMetrics.ts` writes (read from the tool and the live file on 2026-10-11), with text fields quoted:

```csv
metric_id,metric_name,value,formatted_value,period,updated,source
GDPC1,"Real GDP",24408.011,"$24408.01B",2026-04-01,2026-10-11,"BEA/FRED"
GDP,"Nominal GDP",32563.03,"$32563.03B",2026-04-01,2026-10-11,"BEA/FRED"
```

### us-metrics-historical.csv

Appends each update as a new row with timestamp:

```csv
fetch_timestamp,metric_id,value,period
2024-12-01T10:30:00Z,GDPC1,22670.532,2024-07-01
2024-12-01T10:30:00Z,UNRATE,4.1,2024-10-01
```

## Examples

```
User: "Pull the latest economic data"
→ UpdateData intent
→ The three dataset files refreshed, with any failed fetch or skipped source named
```
