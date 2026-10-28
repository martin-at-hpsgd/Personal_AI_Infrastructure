# CompareRegion

Compare crime rates across multiple cities in a region with national baseline.

## Ideal State

- One comparison table gives every compared city's population and its total, property, violent, burglary, robbery, vehicle theft and murder rates per 100K, with the national average from `DataSources.md` § National Averages as a baseline column, labelled with its data year.
- When only one city was named, the comparison adds 2-3 neighbors: the `neighboring_cities` from Config.md for the default city, geographically adjacent cities of similar size for any other city.
- Every city's figures come from the same sources, and the YoY trend and victimization-risk (1 in X) tables cover every compared city.
- The analysis names the safest city in the comparison, each city's highest-rate category, trend divergence, any outlier city, and any contributing context (police staffing, reporting changes, economic factors), each factor tied to a cited source; differences with no sourced explanation are left unexplained.
- When the user is evaluating safety, the answer weighs trend direction alongside current level and flags data limitations. Neighborhood-level grades (CrimeGrade and similar) come from third-party aggregators with known methodological limits, and the answer says so rather than ranking neighborhoods as safe or risky.
- The comparison, including all cities' data, is saved as JSON at the comparison path in the Tool contract.

## Anti-criteria

- Never compares cities without the national average as baseline.
- Never pulls a same-named city in another state: the configured city is verified by its state, county and ZIP in Config.md (SKILL.md Gotchas).
- Never reports a rate without citing its source; AreaVibes, NeighborhoodScout and CrimeGrade can differ 10-40% on the same city (SKILL.md Gotchas).

## Tool contract

Fetch AreaVibes crime pages for all cities in parallel:
```
WebFetch: https://www.areavibes.com/{city}-{state}/crime/
```

When AreaVibes has no page for a city, fall back to CrimeGrade, then HomeSnacks (URL patterns in `DataSources.md`).

Save to `~/.claude/LIFEOS/MEMORY/DATA/CrimeStats/$(date +%Y-%m-%d)_{primary_city}_{state}_comparison.json`, running `mkdir -p ~/.claude/LIFEOS/MEMORY/DATA/CrimeStats` first.

## Output format

`{nat}` is the matching row of `DataSources.md` § National Averages and `{year}` its data year.

```
## Regional Crime Comparison

### Rates per 100,000 Residents

| Metric | {City1} | {City2} | {City3} | {City4} | National ({year}) |
|--------|---------|---------|---------|---------|----------|
| Population | X | X | X | X | — |
| Total crime | X | X | X | X | {nat} |
| Property crime | X | X | X | X | {nat} |
| Violent crime | X | X | X | X | {nat} |
| Burglary | X | X | X | X | {nat} |
| Robbery | X | X | X | X | {nat} |
| Vehicle theft | X | X | X | X | {nat} |
| Murder | X | X | X | X | {nat} |

### Year-over-Year Trends

| Metric | {City1} | {City2} | {City3} | {City4} |
|--------|---------|---------|---------|---------|
| Total crime | +X% | +X% | +X% | +X% |
| Property crime | +X% | +X% | +X% | +X% |
| Violent crime | +X% | +X% | +X% | +X% |

### Victimization Risk

| City | Property Crime | Violent Crime |
|------|---------------|---------------|
| {City1} | 1 in X | 1 in X |
| {City2} | 1 in X | 1 in X |
| {City3} | 1 in X | 1 in X |
| {City4} | 1 in X | 1 in X |
```
