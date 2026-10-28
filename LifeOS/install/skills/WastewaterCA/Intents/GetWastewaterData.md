# GetWastewaterData

A multi-pathogen wastewater panel for California and the configured region: every pathogen the CDPH data carries, each with its latest sample, two-week level, 12-month position, trend and sample count.

## Ideal State

- The panel comes from a CDPH pull made in this run and covers every `pcr_target` with samples in the past year (SARS-CoV-2, Influenza A and its H1, H3 and H5 subtypes, Influenza B, RSV, Mpox, Norovirus GII, Candida auris and any target CDPH adds).
- Each row names its latest sample date, its geography, its two-week level with units, where that level sits in the 12-month range, its trend against the two weeks before, and the samples behind it.
- A row whose latest sample is more than three weeks older than the panel's newest is marked stale, so a target CDPH stopped reporting never reads as current.
- When a real local view is wanted, CDC NWSS site levels (`Wastewater.ts covid`) and the CHHS Respiratory Virus Dashboard clinical rows for the configured `rpho region` are layered on top of the CDPH panel.

## Anti-criteria

- Never averages concentrations across different units; each target keeps one unit.
- Never presents a statewide row as a regional one, or the reverse.

## Tool contract

Run from `~/.claude`. Both commands are read-only.

```bash
bun skills/WastewaterCA/Tools/Wastewater.ts panel               # configured region
bun skills/WastewaterCA/Tools/Wastewater.ts panel --statewide   # all California plants
```

### Intent-to-Flag Mapping

| Ask | Flags |
|---|---|
| wastewater panel, default | `panel` then `panel --statewide` |
| raw numbers for further work | add `--json` |
| what the query is, without running it | add `--dry-run` |

### Clinical layer (optional)

The CHHS Respiratory Virus Dashboard carries test positivity, ED visits and admission levels per public-health region, which wastewater cannot see:

```bash
curl -sL "https://data.chhs.ca.gov/dataset/6724b36f-b89e-4fa7-9cbb-290526894511/resource/00a147ba-0410-4699-9e34-fd18bbb7017d/download/rv-dashboard.csv"
```

Filter `RPHO_REGION` to the `rpho region` that `Wastewater.ts config` prints and `AGE_GRP == 'All Ages'`. Key fields: `WEEKENDING`, `COV_TP`, `FLU_TP` and `RSV_TP` (test positivity %) with their `*_TP_LEVEL` categories, `*_ED_VISITS`, `*_ADM_LEVEL`. Follow redirects (`-L`): the URL answers 302 to storage.

## Gotchas

- **CDPH mixes units.** Most plants report copies/g dry sludge and a few report copies/L wastewater; averaging them together produced meaningless levels. The tool keeps the unit with the most samples per target.
- **The CHHS SQL endpoint refuses most functions.** `coalesce` and similar return HTTP 403 "Not authorized to call function"; write null checks out by hand.
- **The full CDPH CSV is about 380 MB.** Query it through `datastore_search_sql` (what the tool does) rather than downloading it.
- **No-API source, checked and skipped:** WastewaterSCAN has no public API, and its plants largely feed CDC NWSS anyway.

## Output format

A header line names the sources used (CDPH, plus CDC NWSS or the CHHS dashboard when layered) and the fetch date. Then one table, one row per pathogen:

| Column | Content |
|--------|---------|
| Pathogen | the friendly name for each `pcr_target` |
| Data date | latest `sample_collect_date`, YYYY-MM-DD, marked stale when three weeks behind the newest row |
| Geography | the configured region by name, or "California statewide" |
| Level | two-week level with units, and its third of the 12-month range |
| Trend | change against the prior two weeks with a direction word (rising, falling, stable) |
| Samples | samples behind the level |

Below the table, one or two sentences on what changed and whether it matters for the trip or event asked about.

## Inputs

- **Source:** California Department of Public Health via the CHHS Open Data Portal, https://data.chhs.ca.gov/dataset/wastewater-surveillance-data-california. Updated daily; all California treatment plants reporting to CDPH.
- **Targets:** `pcr_target` codes include `sars-cov-2`, `fluav`, `fluav h1`, `fluav h3`, `fluav h5`, `flubv`, `rsv`, `hmpxv clade ii`, `nov gii`, `caur`; CDC's equivalent field is `pathogen_target`.
- **Region:** `- counties:` in Config.md, matched by FIPS code against `county_names` (see `Setup.md`).
