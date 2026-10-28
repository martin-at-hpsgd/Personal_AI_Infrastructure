---
name: CrimeStats
metadata:
  short-description: "Pull and compare US city crime rates, incidents, and trends from public sources. Use OSINT for people investigations."
version: 1.1.2
evals:
  manual:
    reason: "Crime statistics are source- and period-dependent public data; a static fixture cannot establish current source selection or geographic normalization."
    falsifier: "A result uses the wrong jurisdiction or period, miscalculates the stated rate, or cannot link each reported figure to its source."
description: "Pulls US city crime statistics from public sources (FBI crime data, city police data portals, state open-data portals, rate aggregators): rates per 100K, year-over-year trends, recent incidents and city comparisons, defaulting to a configured home city. USE WHEN crime stats, crime rate, crime trends, violent crime, property crime, recent incidents, neighborhood safety, compare cities, is my city safe. NOT FOR people investigations."
---

# CrimeStats

**Contents:** Ideal State · Anti-criteria · Intent Routing · Data & Config · Data Storage · Gotchas · Examples

Pulls and analyzes US city crime statistics from public data sources — rates per 100K, year-over-year trends, recent incidents, and regional comparisons — for the configured default city or any named one. Crime stats live across a dozen sites that disagree with each other, FBI UCR data lags, incident feeds are partial, and a city name can be ambiguous across states, so the skill knows which source to trust for which question: the configured city's police portal (Config.md) for local incident data, AreaVibes, CrimeGrade and HomeSnacks for rate snapshots, CityRating and FBI UCR for multi-year trends, SpotCrime and Patch for recent incidents, and the state DOJ open-data CSVs for agency-level data.

## Ideal State

- The numbers are for the city the user meant: the named city verified by its state (and county and ZIP for the configured city), or the configured default city when none was named.
- Every reported figure names its source and data year, and the answer flags the caveat that shapes it (source baselines that disagree, FBI lag, felony-only portal counts, partial incident feeds, small-city rate swings).
- Rate answers carry, when available, the total, property, violent, burglary, robbery and vehicle theft rates per 100,000, the YoY change as a percentage, and the percentage above or below the national average, with absolute numbers alongside for small cities.
- Each pull is saved as dated JSON under the Data Storage path, so a later run can compare against it.

## Anti-criteria

- Never reports or stores the names of people arrested, accused or involved in an incident: figures, offenses, dates and block-level locations only.

## Intent Routing

| Intent | Trigger | File |
|----------|---------|------|
| **QuickStats** | "crime stats", "how safe is", "crime rate for" | `Intents/QuickStats.md` |
| **TrendAnalysis** | "crime trends", "getting worse", "increasing crime" | `Intents/TrendAnalysis.md` |
| **IncidentReport** | "recent incidents", "what happened", "police reports this week" | `Intents/IncidentReport.md` |
| **CompareRegion** | "compare", "vs", "safer than", "how does X compare" | `Intents/CompareRegion.md` |

| File | Read when |
|------|-----------|
| `DataSources.md` | choosing or calling a source: URL patterns, the police-portal access patterns by type (CitizenRIMS, Socrata, ArcGIS, map-only), FBI and state DOJ access, the dated national averages |
| `Setup.md` | first-time setup: filling Config.md, finding the police portal type, the optional FBI API key, a proof command |

## Data & Config

All city-specific values (default city, county, state, ZIP, neighboring cities, the local police portal URL, and the concrete per-city source URLs) live in the principal's own config, not in this skill. First-time setup and a proof command: [Setup.md](Setup.md).

`<configRoot>/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/CrimeStats/Config.md`
configRoot is `$CLAUDE_CONFIG_DIR` when set, else `~/.claude`.

**Default city:** when no city is specified, use `default_city` (with its state, ZIP, and population) from Config.md. If Config.md is absent or `default_city` is `unset`, ask which city and state to use, and point at `Setup.md` so the answer can become the default; never guess a city. Load Config.md for the local police portal, neighboring cities, and city-resolved source URLs whenever an intent needs them. Skill files stay generic and describe the procedure against "the configured city."

**Neighboring cities for comparison:** the `neighboring_cities` list in Config.md (or, for any other target city, geographically adjacent cities of similar size).

## Data Storage

Historical data persists at: `~/.claude/LIFEOS/MEMORY/DATA/CrimeStats/`. The directory does not exist on a fresh install, so every intent runs `mkdir -p ~/.claude/LIFEOS/MEMORY/DATA/CrimeStats` before its first write.

File naming: `YYYY-MM-DD_{city}_{state}_{intent}.json`

Example: `2026-03-22_springfield_xx_quickstats.json`

## Gotchas

- **Police-portal counts are not FBI counts.** Each portal publishes whatever offenses the department chooses (CitizenRIMS, for example, lists felonies only), so read a dataset's offense list before comparing its totals with FBI UCR figures, which include all reported offenses.
- **Portal date parameters are vendor-specific.** CitizenRIMS wants JS `toDateString()` form with the correct weekday (`"Tue Mar 24 2026"`) and returns 500 on a wrong one; generate the string, never type it (`DataSources.md` Tier 0). Socrata and ArcGIS take ISO timestamps.
- **FBI annual data lags the calendar year by five to eight months.** The national estimates arrive as a First Look around May and the full Reported Crimes in the Nation report around August of the following year; agency-level monthly data has been on the Crime Data Explorer since August 2025. Check the CDE for the latest year before saying a year of FBI data does not exist, and name the data year with every figure.
- **AreaVibes vs NeighborhoodScout vs CrimeGrade use different baselines.** Rates can differ 10-40% across sources. Always cite the source.
- **SpotCrime incident data is not comprehensive.** It only shows reported incidents from participating agencies. Absence of data != absence of crime.
- **Same-name-different-state confusion is common.** Many US cities share a name across states. Always verify you're pulling the configured city in its state (county + ZIP in Config.md), not a same-named city elsewhere.
- **Crime mapping sites are often paywalled or bot-protected.** NeighborhoodScout limits free access. Fall back to AreaVibes or CrimeGrade.
- **State DOJ open-data portals have agency-level data** where the state publishes it, but the explorers are client-rendered apps — use the downloadable CSV datasets, not web scraping.
- **Per-capita rates swing wildly for small cities.** Below roughly 100,000 residents (check `population` in Config.md or the census figure for a named city) a handful of incidents moves the rate noticeably. Always show absolute numbers alongside per-100K rates.

## Examples

**Example 1: Quick city snapshot**
```
User: "What are the crime stats for my city?"  (or a named city + state)
-> QuickStats intent (default city from Config.md if none named)
-> Rates per 100K, % vs national and YoY change for each category, a safety grade and a one-line takeaway, sources cited
```

**Example 2: Trend analysis**
```
User: "Is violent crime going up here?"
-> TrendAnalysis intent
-> YoY table against neighboring cities, the state and the nation, plus a multi-year table when the data exists and 3-5 key findings
```

**Example 3: Recent incidents**
```
User: "What crimes were reported in my city this week?"
-> IncidentReport intent
-> Incident list with dates, locations, types, a count summary and any patterns
```

**Example 4: Regional comparison**
```
User: "How does my city compare to the neighboring one for crime?"
-> CompareRegion intent (neighbors from Config.md)
-> Side-by-side table of every metric with the national baseline, YoY trends, victimization risk, and the safest city named
```
