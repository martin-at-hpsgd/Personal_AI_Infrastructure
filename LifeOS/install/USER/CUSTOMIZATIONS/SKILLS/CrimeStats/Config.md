---
provenance: template
version: 1.1.0
---

# CrimeStats Config

City-specific values for the crime-statistics skill (`CrimeStats/SKILL.md` § Data & Config). Every value starts as `unset`. While `default_city` is `unset`, a request that names no city ("my city") gets a question asking which city to use instead of a guess. Fill in the rows you have and leave the rest `unset`; `CrimeStats/Setup.md` walks through it with a worked example, and `CrimeStats/DataSources.md` documents the URL pattern behind every source.

## Values

| Key | Value | Meaning | Where to get it |
|-----|-------|---------|-----------------|
| `default_city` | unset | City name used when a request names none | You |
| `state` | unset | Two-letter state code | You |
| `county` | unset | County, for county-level trend pulls | You |
| `zip` | unset | Primary ZIP, disambiguates same-name cities | You |
| `population` | unset | Latest census estimate; under about 100,000 residents per-100K rates swing hard, so absolute counts are always shown too | census.gov QuickFacts |
| `neighboring_cities` | unset | Comma-separated adjacent cities of similar size, used by TrendAnalysis and CompareRegion | A map |
| `police_portal` | unset | The city PD's public crime-data page | City PD website, crime data or transparency page |
| `police_portal_type` | unset | Which access pattern in `DataSources.md` Tier 0 applies: `citizenrims`, `socrata`, `arcgis`, `map_only` or `none` | Network tab on the portal page (`Setup.md`) |
| `citizenrims_api_base` | unset | `citizenrims` only: API origin behind the portal | Network tab |
| `citizenrims_agency_id` | unset | `citizenrims` only: numeric agency ID the portal queries with | Same network requests (`agencyId=`) |
| `socrata_domain` | unset | `socrata` only: portal host | Dataset page URL |
| `socrata_dataset_id` | unset | `socrata` only: incident dataset id (four-by-four) | Dataset page URL |
| `socrata_date_field` | unset | `socrata` only: report or occurrence date column | Dataset column list |
| `arcgis_query_url` | unset | `arcgis` only: layer URL ending in `/FeatureServer/<n>` | Network tab or the Hub dataset's API link |
| `arcgis_date_field` | unset | `arcgis` only: date field | Layer field list |
| `pd_crime_map` | unset | PD crime-map or crime-reports page | City PD website |
| `pd_facebook` | unset | PD Facebook page (read through Apify; WebFetch cannot read Facebook) | Facebook |
| `state_doj_portal` | unset | Your state's crime-statistics open-data page (CSV downloads preferred) | Search "<state> attorney general crime statistics open data" |

## Resolved source URLs for the default city

Optional. When a row is `unset`, the skill builds the URL from the pattern in `DataSources.md`. Fill one in only when the pattern gives the wrong page for your city.

| Source | URL |
|--------|-----|
| areavibes | unset |
| crimegrade | unset |
| spotcrime | unset |
| homesnacks | unset |
| doorprofit | unset |
| neighborhoodscout | unset |
| patch | unset |
| hoodscore | unset |
| cityrating | unset |
| policescorecard | unset |

## Optional env var

`FBI_CRIME_API_KEY` in `~/.claude/.env` unlocks the FBI Crime Data Explorer API for TrendAnalysis. Free at https://api.data.gov/signup/.
