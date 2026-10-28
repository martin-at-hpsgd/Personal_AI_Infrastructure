# TrendAnalysis

Year-over-year crime trend analysis with comparison to neighboring cities and statewide trends.

## Ideal State

- The year-over-year table covers total, property, violent, burglary and robbery change for the target city, 2-3 neighboring cities (the `neighboring_cities` in Config.md for the default city, geographically adjacent cities of similar size otherwise), the state and the nation.
- The analysis reports statewide and county trend direction and notable crime events or enforcement changes, sourced from state DOJ reports and news.
- The directional analysis states the trend vs neighbors, the trend vs the state, the highest-rate or fastest-rising category, and contributing factors (police staffing, policy or reporting changes, economic conditions), each tied to a cited source.
- When multi-year data is available, a 3-5 year per-100K trend table is included.
- The answer ends with 3-5 key-finding bullets: overall trend direction and magnitude, how the target city compares to neighbors, the highest-rate category, any counter-trend behavior, and data limitations and what's not yet available.
- The analysis, with all extracted data points, is saved as JSON at the trends path in the Tool contract.

## Anti-criteria

- Never says a year of FBI data is missing, or reports an older year as the latest, without first checking the Crime Data Explorer: annual national data lands five to eight months after the year ends (SKILL.md Gotchas).
- Never pulls a same-named city in another state: the configured city is verified by its state, county and ZIP in Config.md (SKILL.md Gotchas).

## Tool contract

### Primary: AreaVibes (target + neighbors)
Fetch crime pages for all cities in parallel:
```
WebFetch: https://www.areavibes.com/{city}-{state}/crime/
```
Extract YoY change data for each city.

### Secondary: CityRating (multi-year historical)
```
WebFetch: https://www.cityrating.com/crime-statistics/{state-name}/{city}.html
```
Extract multi-year crime rate tables if available. When `FBI_CRIME_API_KEY` is set, the FBI Crime Data Explorer API adds official multi-year agency data (DataSources.md Tier 2).

### Tertiary: Research agents for context
Spawn a research agent for statewide trend direction (state DOJ reports, news), county-level trends (the configured city's county, from Config.md), and notable crime events or enforcement changes.

Save to `~/.claude/LIFEOS/MEMORY/DATA/CrimeStats/$(date +%Y-%m-%d)_{city}_{state}_trends.json`, running `mkdir -p ~/.claude/LIFEOS/MEMORY/DATA/CrimeStats` first.

## Output format

```
## {City}, {State} — Crime Trend Analysis

### Year-over-Year Change

| Category | {City} | {Neighbor1} | {Neighbor2} | State | National |
|----------|--------|-------------|-------------|-------|----------|
| Total crime | +X% | +X% | +X% | +X% | +X% |
| Property crime | +X% | +X% | +X% | +X% | +X% |
| Violent crime | +X% | +X% | +X% | +X% | +X% |
| Burglary | +X% | +X% | +X% | +X% | +X% |
| Robbery | +X% | +X% | +X% | +X% | +X% |

### Directional Analysis

- **Trend vs neighbors:** {Is city moving with or against neighbors?}
- **Trend vs state:** {Is city moving with or against state trend?}
- **Most concerning category:** {Which crime type shows worst trajectory?}
- **Contributing factors:** {Police staffing, policy or reporting changes, economic conditions, each with its source}
```

If multi-year data available, include a 3-5 year trend:

```
### Multi-Year Trend (per 100K)

| Year | Total | Property | Violent | Burglary | Robbery |
|------|-------|----------|---------|----------|---------|
| 2020 | X | X | X | X | X |
| 2021 | X | X | X | X | X |
| 2022 | X | X | X | X | X |
| 2023 | X | X | X | X | X |
| 2024 | X | X | X | X | X |
```
