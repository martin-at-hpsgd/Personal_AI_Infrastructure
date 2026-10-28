# Wastewater.ts - Help Documentation

Reads California wastewater surveillance straight from two public open-data APIs and prints a summary. It writes nothing, keeps no local copy of the data, and needs no account or key.

## Usage

```bash
bun skills/WastewaterCA/Tools/Wastewater.ts covid  [--pathogen covid|flu|rsv] [--statewide] [--json] [--dry-run]
bun skills/WastewaterCA/Tools/Wastewater.ts panel  [--statewide] [--json] [--dry-run]
bun skills/WastewaterCA/Tools/Wastewater.ts config [--json]
bun skills/WastewaterCA/Tools/Wastewater.ts --help
```

Run it from `~/.claude`.

## Commands

| Command | Source | Prints |
|---|---|---|
| `covid` | CDC NWSS Wastewater Viral Activity Level, `data.cdc.gov` dataset `atcp-73re`, weekly on Fridays | the latest reporting week, sites reporting, the median site WVAL, CDC's own category count per site (Very Low to Very High), the week-over-week direction and six weeks of median WVAL |
| `panel` | CDPH sample-level data on the CHHS Open Data Portal, resource `2742b824-3736-4292-90a9-7fad98e94c06`, queried through `datastore_search_sql` | one row per `pcr_target` in the past year: latest sample date, two-week level with units, position in the 12-month range of weekly means (low, middle or top third), change against the two weeks before, sample count |
| `config` | the Config.md this run resolves to | region name, source file, counties with FIPS codes; no network |

`--pathogen` on `covid` picks SARS-CoV-2 (`covid`, the default), Influenza A (`flu`) or RSV (`rsv`), the three CDC computes WVAL for.

## Region

The region comes from `LIFEOS/USER/CUSTOMIZATIONS/SKILLS/<this skill's folder name>/Config.md`, or the file named by `WASTEWATER_CONFIG`. Two lines matter:

```markdown
- region: Sacramento area
- counties: Sacramento 06067; Yolo 06113; Placer 06061
```

`covid` matches each county name inside CDC's `counties_served`; `panel` matches each FIPS code inside CDPH's `county_names`. With no Config.md, both run statewide. `--statewide` ignores the counties for one run.

## Flags

| Flag | Effect |
|---|---|
| `--json` | machine-readable output on stdout |
| `--dry-run` | print the request URL and exit 0 without calling the network |
| `--statewide` | ignore the configured counties |
| `--pathogen <covid\|flu\|rsv>` | `covid` only: which CDC WVAL pathogen |

## Exit codes

| Code | Meaning |
|---|---|
| 0 | ok |
| 1 | network or data error, or no WVAL rows for the region in the past ten weeks |
| 2 | bad arguments, or a Config.md county without a valid `06xxx` FIPS code, or `WASTEWATER_CONFIG` naming a missing file |

## Notes

- WVAL is a unitless CDC index, not a concentration. CDC sets the category cut-offs per pathogen; the tool reports CDC's category per site and never applies thresholds of its own.
- CDPH concentrations come in more than one unit (copies/g dry sludge, copies/L wastewater). The panel keeps the unit with the most samples for each target, so units never average together.
- Rows flagged `qc_ignore` or `analysis_ignore` are left out.
- The CHHS portal refuses most SQL functions (`coalesce` among them) with HTTP 403; the error text names the function.
