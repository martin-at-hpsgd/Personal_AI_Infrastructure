# CrimeStats Data Sources

**Contents:** Tier 0: Authoritative Source (Configured City's Police Data Portal) · Tier 1: Primary Sources (Free, Reliable) · Tier 2: Official Sources (Authoritative, Less Accessible) · Tier 3: Supplementary Sources · Tier 4: Comparison/Context Sources · National Averages (FBI, latest annual)

> **City-specific values are in Config.md**, not here. This file documents the generic
> source contracts and URL patterns; concrete portal URLs, agency IDs, and the resolved
> per-city URLs for the default city live in
> `~/.claude/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/CrimeStats/Config.md` (setup: `Setup.md`).
> Placeholders below: `{city}`, `{state}`, `{STATE}`, `{City}`, `{agencyId}`, `{portal}`,
> `{apiBase}`.

## Tier 0: Authoritative Source (Configured City's Police Data Portal)

Many US police departments publish their own incident data, and for recent periods it is
usually the most granular source available. Departments use different systems, so Config.md
names the portal and its type: `police_portal` is the public page and `police_portal_type`
selects one of the access patterns below. Every type covers the configured city only. When the
type is `map_only` or `none`, or a call fails, the intents fall back to Tier 1 and say so.

| `police_portal_type` | What the department runs | Access |
|----------------------|--------------------------|--------|
| `citizenrims` | A CitizenRIMS crime-reporting portal | JSON API with an anonymous token (below) |
| `socrata` | A city open-data portal on Socrata | SODA API over a published incident dataset (below) |
| `arcgis` | An ArcGIS Hub or feature service | ArcGIS REST `query` endpoint (below) |
| `map_only` | Only an interactive crime map (a hosted crime-map vendor or the PD's own page) | Interceptor, date-filtered by hand; no API |
| `none` | No public incident data | Skip Tier 0 |

Find the type by opening the PD's crime-data or transparency page and watching the network tab:
requests to a `citizenrims` host, `/resource/<id>.json` paths, or `/FeatureServer/<n>/query`
paths identify the first three. These are common vendors, not a complete list: a department on
another system with a public API gets its own type the same way (a short section below with its
Config.md keys, auth and one query, and a `police_portal_type` value naming it).

### `citizenrims`: CitizenRIMS API

- **Config.md keys:** `police_portal`, `citizenrims_api_base` (`{apiBase}`), `citizenrims_agency_id` (`{agencyId}`)
- **Auth:** anonymous token, no credentials. This API is unofficial: the department's portal front end uses it, but the vendor does not publish it as a public API. Check the portal's terms of use before relying on it, and fall back to the other tiers if they do not allow it
- **Data:** felony cases only (SKILL.md Gotchas), near real-time; also monthly statistics
- **Dates:** `toDateString()` form with the right weekday, generated, never typed: `bun -e 'console.log(new Date("2026-03-24T12:00:00").toDateString())'` prints `Tue Mar 24 2026`

```
POST {apiBase}/api/v1/auth/citizen   (headers: Content-Type: application/json, Content-Length: 0; response .token)
GET  {apiBase}/api/v1/Case?agencyId={agencyId}&primaryAgencyId={agencyId}
       &startDate=Wed%20Jan%2001%202025&endDate=Tue%20Mar%2024%202026
       &circleLatitude=0&circleLongitude=0&circleRadius=0
       &types=ARSON,ASSAULT,ATTBURG,ATTRAPE,BURGLARY,HOMICIDE,LARCENY,MANSLAU,RAPE,ROBBERY,STOLVEH
```

The same date pair works on `GET /api/v1/CrimeStatistics?agencyId={agencyId}&primaryAgencyId={agencyId}` (monthly counts per offense). Case rows carry `caseNumber`, `reportDate`, `occurrence1Date`, `occurrence1Time`, `offenseDescription1`, `crimeType`, `blockNumber`, `street`, `beat` and `disposition`.

### `socrata`: city open-data portal (SODA API)

- **Config.md keys:** `socrata_domain` (the portal host), `socrata_dataset_id` (the incident dataset's four-by-four id, from its page URL), `socrata_date_field` (the column holding the report or occurrence date)
- **Auth:** none for public datasets; an app token only raises rate limits
- **Data:** whatever the department publishes, often every reported offense rather than felonies only; read the dataset's column list before mapping fields

```
GET https://{socrata_domain}/resource/{socrata_dataset_id}.json
  ?$where={socrata_date_field} >= '2026-01-01T00:00:00'
  &$order={socrata_date_field} DESC
  &$limit=1000
```

### `arcgis`: ArcGIS feature service

- **Config.md keys:** `arcgis_query_url` (the layer URL ending in `/FeatureServer/<n>` or `/MapServer/<n>`), `arcgis_date_field`
- **Auth:** none for public layers
- **Data:** incident points with the department's own offense codes; field names vary by layer

```
GET {arcgis_query_url}/query
  ?where={arcgis_date_field} >= timestamp '2026-01-01 00:00:00'
  &outFields=*&orderByFields={arcgis_date_field} DESC
  &resultRecordCount=1000&f=json
```

---

## Tier 1: Primary Sources (Free, Reliable)

### AreaVibes
- **URL pattern:** `https://www.areavibes.com/{city}-{state}/crime/`
- **Default-city URL:** see Config.md
- **Data:** FBI-sourced crime rates, YoY trends, national comparison percentages
- **Coverage:** Most US cities with population > 10,000
- **Update frequency:** Annual (follows FBI UCR release cycle)
- **Scraping:** WebFetch works reliably, no bot protection
- **Key metrics:** Total crime, property crime, violent crime, murder, robbery, assault, burglary, theft, vehicle theft — all per 100K with % vs national average

### CrimeGrade
- **URL pattern:** `https://crimegrade.org/property-crime-{city}-{state}/`
- **Also:** `crimegrade.org/safest-places-in-{city}-{state}/`, `crimegrade.org/robbery-{city}-{state}/`
- **Default-city URLs:** see Config.md
- **Data:** Neighborhood-level crime grades (A-F), crime type breakdowns
- **Coverage:** Most US cities and ZIP codes
- **Scraping:** WebFetch works, may need to parse HTML

### SpotCrime
- **URL pattern:** `https://spotcrime.com/{STATE}/{City}`
- **Default-city URL:** see Config.md
- **Data:** Recent individual incidents with type, date, location
- **Coverage:** Cities with participating police agencies
- **Update frequency:** Near real-time (days)
- **Best for:** IncidentReport intent — recent specific events

### HomeSnacks
- **URL pattern:** `https://www.homesnacks.com/{state}/{city}-crime/`
- **Default-city URL:** see Config.md
- **Data:** Rankings, safety scores, crime rate summaries
- **Scraping:** WebFetch works reliably

## Tier 2: Official Sources (Authoritative, Less Accessible)

### FBI Crime Data Explorer
- **URL:** `https://cde.ucr.cjis.gov/`
- **API:** `https://api.usa.gov/crime/fbi/sapi/` (requires API key from api.data.gov)
- **Data:** Official UCR/NIBRS data by agency, city, state
- **Coverage:** Agencies reporting to FBI. NIBRS participation varies widely by state, so a missing agency or year often means it did not report, not that nothing happened.
- **Update frequency:** Monthly agency data; annual national estimates five to eight months after the year ends (SKILL.md Gotchas)
- **Gotcha:** Client-rendered Angular app — can't scrape directly. Use the API or download bulk CSV.
- **API key:** Free from https://api.data.gov/signup/ — store in `~/.claude/.env` as `FBI_CRIME_API_KEY`

### State DOJ Open-Data Portal
- **Data:** State-specific crime data by agency, county, city (where the state publishes it)
- **Coverage:** Law enforcement agencies in the configured city's state
- **Where:** the configured state's portal is Config.md `state_doj_portal`. For any other state, search "<state> attorney general crime statistics open data" or "<state> criminal justice statistics center"; most states publish annual agency-level tables, and some publish none.
- **Access:** these explorers are usually client-rendered apps. Use the downloadable CSV datasets, not page scraping (SKILL.md Gotchas).

### City PD Crime Map
- **URL:** the configured city's police-department crime-reports/statistics page (Config.md `pd_crime_map`)
- **Data:** Interactive crime map with date/location filters
- **Coverage:** The configured city only
- **Gotcha:** Interactive map — may need the Interceptor skill for date-filtered queries

## Tier 3: Supplementary Sources

### DoorProfit Crime Map
- **URL pattern:** `https://www.doorprofit.com/crime-map/city/{City}-{STATE}/` (optionally `/zipcode/{zip}/`)
- **Default-city URLs:** see Config.md
- **Data:** Interactive crime map, heat maps

### NeighborhoodScout
- **URL pattern:** `https://www.neighborhoodscout.com/{state}/{city}/crime`
- **Default-city URL:** see Config.md
- **Data:** Per-capita rates, neighborhood breakdown, safety rankings
- **Gotcha:** Paywalled beyond basic data. Use for top-level rates only.

### Patch (Local News)
- **URL pattern:** `https://patch.com/{state-name}/{city}/police-fire`
- **Default-city URL:** see Config.md
- **Data:** Police blotter, arrest reports, crime news
- **Best for:** IncidentReport intent — narrative context for incidents

### City PD Facebook
- **URL:** the configured city's police-department Facebook page (Config.md `pd_facebook`)
- **Data:** Real-time crime alerts, arrest announcements, community updates
- **Gotcha:** WebFetch cannot read Facebook reliably, so check the page manually, or use the department's own press-release or RSS page when it has one. Automated access to Facebook (an Apify actor, for example) is a third-party route: check Meta's terms before relying on it, and check manually if they do not allow it

## Tier 4: Comparison/Context Sources

### Hoodscore
- **URL pattern:** `https://www.hoodscore.com/safety/{state-name}/{city}.html`
- **Default-city URL:** see Config.md
- **Data:** Safety scores and breakdowns

### CityRating
- **URL pattern:** `https://www.cityrating.com/crime-statistics/{state-name}/{city}.html`
- **Default-city URL:** see Config.md
- **Data:** Historical crime statistics with multi-year tables

### Police Scorecard
- **URL pattern:** `https://policescorecard.org/{state}/police-department/{city}`
- **Default-city URL:** see Config.md
- **Data:** Police department performance metrics, use of force, accountability

## National Averages (FBI, latest annual)

The one home for the national baseline: every intent that shows a national column reads it from here. When the FBI publishes a newer year, replace the table and its data year together. If the release date below is more than 12 months old, check the FBI Crime Data Explorer (Tier 2) for a newer annual release before using these figures; when one exists, use its rates, name its year, and update this table.

**Data year:** 2025 · **Source:** FBI, "UCR Summary of Reported Crimes in the Nation, 2025" (released August 2026), estimated rates per 100,000 inhabitants

| Category | Rate per 100K |
|----------|--------------|
| Total crime (violent + property) | 1,862.4 |
| Property crime | 1,534.8 |
| Violent crime | 327.6 |
| Burglary | 193.6 |
| Larceny-theft | 1,144.1 |
| Robbery | 49.4 |
| Motor vehicle theft | 197.0 |
| Aggravated assault | 238.0 |
| Murder | 4.1 |

*Third-party sites such as AreaVibes compute "% vs national" against their own baseline year; when that differs from the year above, say which one a figure uses.*
