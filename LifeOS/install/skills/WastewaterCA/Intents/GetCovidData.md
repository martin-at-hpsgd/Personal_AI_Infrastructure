# GetCovidData

The current COVID-19 wastewater picture for California and the configured region: CDC's viral activity level per site, the week-over-week direction and recent weeks, from a pull made in this run.

## Ideal State

- The status reflects a pull from CDC NWSS made in this run, never a remembered or cached figure.
- The status names the reporting week (`week_end`), the geography (the configured region by name, or California statewide), the number of sites reporting, the median site WVAL, how many sites sit at each CDC level, and the week-over-week direction with the recent weekly medians as context.
- The level shown is CDC's own `site_wval_category` for each site. WVAL is a unitless CDC index, so the answer never calls it a concentration or log10 copies/mL and never applies cut-offs of its own.
- When a region is configured, the answer gives the region and statewide side by side, so a reader can see whether the region runs ahead of or behind the state.
- Flu A or RSV asked the same way ("what's the flu activity level") runs the same command with `--pathogen flu` or `--pathogen rsv`.

## Anti-criteria

- Never presents the statewide figure as a measurement for the configured region, or the reverse.
- Never reports a week older than the latest one the pull returned as "current".

## Tool contract

Run from `~/.claude`. Both commands are read-only.

```bash
bun skills/WastewaterCA/Tools/Wastewater.ts covid               # configured region
bun skills/WastewaterCA/Tools/Wastewater.ts covid --statewide   # all California sites
```

### Intent-to-Flag Mapping

| Ask | Flags |
|---|---|
| COVID status, default | `covid` then `covid --statewide` |
| flu or RSV activity level | `covid --pathogen flu` or `covid --pathogen rsv` |
| raw numbers for further work | add `--json` |
| region outside the configured one | `covid --statewide`, then filter the `--json` sites by county, or point `WASTEWATER_CONFIG` at another Config.md |

A missing Config.md is not an error: the command runs statewide and says so. Exit 1 with "No ... WVAL rows" means the county names in Config.md match nothing in CDC's `counties_served`.

## Gotchas

- **The old CDPH statewide COVID series is archived.** The Respiratory Virus Weekly Report wastewater file (`wastewater.csv`, column `sars_conc`) stopped at 2025-08-02 and the dataset was archived on 2025-06-28. Its values were a unitless statewide summary built with the NWSS method, not log10 copies/mL, so the 2/3/5/10 cut-offs once used with it had no basis in the source (checked against the CHHS dataset description, 2026-10-11).
- **A site can serve several counties.** `counties_served` is free text and a region match is a substring match, so a plant straddling a county line counts toward the region.

## Inputs

- **Source:** CDC National Wastewater Surveillance System, Wastewater Viral Activity Level for SARS-CoV-2, Influenza A and RSV, https://data.cdc.gov/resource/atcp-73re.json (dataset page https://www.cdc.gov/nwss/). Updated weekly on Fridays for the week ending the previous Saturday.
- **Lead time:** wastewater typically leads clinical testing by 4–7 days.
