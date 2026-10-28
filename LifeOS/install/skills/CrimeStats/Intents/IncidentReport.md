# IncidentReport

Pull recent reported crime incidents for a specific city, of every type or the one the user names, plus notable events.

## Ideal State

- The incident list covers the requested city and time range (default: the configured default city and the last 7 days), filtered to the crime type the user asked about when one was named, with date, type, location (street/block) and details for each incident.
- For the configured city, incidents come first from its own police data portal through the access pattern its `police_portal_type` names (`DataSources.md` Tier 0), with SpotCrime adding incidents the portal omits and Patch adding narrative context. For any other city, for portal type `map_only` or `none`, or when the portal call fails, SpotCrime and Patch carry the list, and the report says which sources it used.
- The configured city's police crime-map page and its recent press releases or alerts are checked when available.
- The summary counts total incidents, burglaries, robberies, other property crime and violent crime, and lists notable events (arrests, series patterns, community impact).
- When patterns appear in the incidents (geographic clustering, time-of-day, repeat locations, series activity with similar MO), a Patterns section names them.
- The report is saved as JSON at the incidents path in the Tool contract.

## Anti-criteria

- Never treats SpotCrime's missing data as no crime: it only shows reported incidents from participating agencies, and absence of data != absence of crime (SKILL.md Gotchas).
- Never pulls a same-named city in another state: the configured city is verified by its state, county and ZIP in Config.md (SKILL.md Gotchas).

## Tool contract

### Source 1: the city's police data portal (configured city only)
Call the portal the way `DataSources.md` Tier 0 documents for Config.md's `police_portal_type`, filtered to the requested date range and, when one was named, crime type. Skip this source for `map_only` and `none`.

Use the type's own date format and offense filter from that section (for `citizenrims`, the generated `toDateString()` dates and the `types` list). Extract per incident: case or report number, report and occurrence date and time, offense, block and street, and disposition where the portal gives one. A portal that publishes a subset of offenses (CitizenRIMS lists felonies only) will lack the rest, which is expected (SKILL.md Gotchas).

### Source 2: SpotCrime (incident-level data)
```
WebFetch: https://spotcrime.com/{STATE}/{City}
```
Extract: incident type, date, location (street/block), brief description.

When the user named a crime type, keep only incidents of that type; otherwise keep every type SpotCrime lists.

### Source 3: Patch (narrative context)
```
WebFetch: https://patch.com/{state-name}/{city}/police-fire
```
Extract: recent police/fire articles, arrest reports, crime stories.

### Source 4: Local PD (if available)
Query the configured city's police portal / crime-map page (`pd_crime_map` in Config.md):
```
WebFetch: {pd_crime_map}   # concrete URL for the default city is in Config.md
```
Check for recent press releases or alerts. The police department's Facebook page (`pd_facebook` in Config.md) carries real-time alerts, but WebFetch cannot read Facebook reliably: check it manually, or use the department's own press-release or RSS page. Automated Facebook access is a third-party route; follow the `DataSources.md` City PD Facebook entry before using one.

Save to `~/.claude/LIFEOS/MEMORY/DATA/CrimeStats/$(date +%Y-%m-%d)_{city}_{state}_incidents.json`, running `mkdir -p ~/.claude/LIFEOS/MEMORY/DATA/CrimeStats` first.

## Output format

```
## {City}, {State} — Recent Incidents ({time_range})

### Incidents by Type

| Date | Type | Location | Details |
|------|------|----------|---------|
| MM/DD | Vehicle theft | 100 block Main St | Parked overnight, no suspect |
| MM/DD | Assault | Oak Ave & 5th | Suspect arrested on scene |
| ... | ... | ... | ... |

### Summary

- **Total incidents:** {N}
- **Burglaries:** {N}
- **Robberies:** {N}
- **Other property crime:** {N}
- **Violent crime:** {N}

### Notable Events

{List any incidents with arrests, series patterns, or community impact}
```

## Gotchas

- Patch coverage varies by city — some cities have minimal crime reporting
- Incident locations are often approximate (block level, not exact address)
- Time ranges beyond 30 days may have sparse data on SpotCrime
