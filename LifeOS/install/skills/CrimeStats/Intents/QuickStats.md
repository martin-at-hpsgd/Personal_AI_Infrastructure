# QuickStats

Single city crime snapshot — pull current rates, YoY trends, and national comparison.

## Ideal State

- The snapshot is for the city and state the user named (ZIP codes resolved to city names), or the configured default city when none was named.
- The snapshot table gives rate per 100K, % vs national and YoY change for total crime, property crime, violent crime, burglary, robbery, vehicle theft and murder, under a header naming population, data year and sources.
- The snapshot carries a safety grade, victimization risk as 1 in N, and a 1-2 sentence key takeaway on the most notable finding.
- The structured data is saved as JSON at the quickstats path in the Tool contract.
- When prior snapshots exist for this city, the answer adds a trend note comparing the current snapshot with the previous one.

## Anti-criteria

- Never pulls a same-named city in another state: the configured city is verified by its state, county and ZIP in Config.md (SKILL.md Gotchas).
- Never reports a rate without citing its source; AreaVibes, NeighborhoodScout and CrimeGrade can differ 10-40% on the same city (SKILL.md Gotchas).

## Tool contract

Fetch in parallel using WebFetch:

### Source 1: AreaVibes (primary)
```
WebFetch: https://www.areavibes.com/{city}-{state}/crime/
```
Extract: total crime rate, property crime, violent crime, burglary, robbery, vehicle theft, murder — all per 100K. Extract YoY change percentages and % vs national average.

### Source 2: CrimeGrade (secondary)
```
WebFetch: https://crimegrade.org/property-crime-{city}-{state}/
```
Extract: neighborhood grades, property crime breakdown, safety ranking.

### Source 3: HomeSnacks (tertiary)
```
WebFetch: https://www.homesnacks.com/{state}/{city}-crime/
```
Extract: safety ranking, crime score, quick facts.

Save the structured data:

```bash
mkdir -p ~/.claude/LIFEOS/MEMORY/DATA/CrimeStats
cat > ~/.claude/LIFEOS/MEMORY/DATA/CrimeStats/$(date +%Y-%m-%d)_{city}_{state}_quickstats.json << 'EOF'
{
  "city": "{city}",
  "state": "{state}",
  "date": "YYYY-MM-DD",
  "source": "areavibes",
  "data": { ... extracted metrics ... }
}
EOF
```

Check if previous snapshots exist for this city:

```bash
ls ~/.claude/LIFEOS/MEMORY/DATA/CrimeStats/*_{city}_{state}_*.json 2>/dev/null
```

## Output format

```
## {City}, {State} — Crime Snapshot

**Population:** {pop} | **Data Year:** {year} | **Sources:** AreaVibes, CrimeGrade

| Category | Rate/100K | vs National | YoY Change |
|----------|-----------|-------------|------------|
| Total crime | X | +X% | +X% |
| Property crime | X | +X% | +X% |
| Violent crime | X | +X% | +X% |
| Burglary | X | +X% | +X% |
| Robbery | X | +X% | +X% |
| Vehicle theft | X | +X% | +X% |
| Murder | X | +X% | +X% |

**Safety Grade:** {grade} | **Victimization Risk:** 1 in {N}

**Key Takeaway:** {1-2 sentence summary of most notable finding}
```
