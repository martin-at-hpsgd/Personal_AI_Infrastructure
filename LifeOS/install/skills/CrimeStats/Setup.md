# CrimeStats

Status: test -f ~/.claude/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/CrimeStats/Config.md && echo ok · optional

## What it does

This skill answers "how safe is this city?" with sourced numbers: crime rates per 100,000 against the national average, year-over-year trends against neighboring cities and the state, recent incidents, and side-by-side comparisons. It works for any named US city with no setup. Config.md adds a default city, so "my city" needs no name, plus that city's neighbors, its police department's own incident data, and its state's open-data portal. Every pull is saved as dated JSON under `~/.claude/LIFEOS/MEMORY/DATA/CrimeStats/` so later runs can compare.

## Fill in

Edit `~/.claude/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/CrimeStats/Config.md`. A release ships it as a starter table with every value `unset`; replace the values you have and leave the rest `unset`. If the file is missing, copy the starter from the release template or write the table below. The skill reads the file as prose and tables, so key names matter and layout does not.

Saved pulls go to `~/.claude/LIFEOS/MEMORY/DATA/CrimeStats/`, which a fresh install does not have; each intent runs `mkdir -p` on it before its first write, so there is nothing to create by hand.

Smallest working example (made-up city):

```markdown
# CrimeStats config

| Key | Value |
|-----|-------|
| `default_city` | Springfield |
| `state` | XX |
| `county` | Example County |
| `zip` | 00000 |
| `population` | 62000 |
| `neighboring_cities` | Shelbyville, Capital City, Ogdenville |
| `police_portal` | `https://data.springfield.example.gov` |
| `police_portal_type` | `socrata` |
| `socrata_domain` | `data.springfield.example.gov` |
| `socrata_dataset_id` | `abcd-1234` |
| `socrata_date_field` | `report_date` |
| `state_doj_portal` | `https://justice.example.gov/crime-data` |
```

| Key | Meaning |
|---|---|
| `default_city`, `state`, `county`, `zip` | The city used when a request names none. State, county and ZIP keep a same-named city in another state from being pulled |
| `population` | Latest census estimate; small cities get absolute counts next to every rate |
| `neighboring_cities` | Two or three adjacent cities of similar size for trend and comparison tables |
| `police_portal`, `police_portal_type` | The department's own incident data and how to read it. `DataSources.md` Tier 0 lists the types (`citizenrims`, `socrata`, `arcgis`, `map_only`, `none`) and the extra keys each needs |
| `pd_crime_map`, `pd_facebook` | Optional pages checked for recent alerts |
| `state_doj_portal` | Optional state open-data page for agency-level tables |

**Finding your police portal type.** Open your police department's crime-data or transparency page with the browser's network tab open. Requests to a `citizenrims` host mean `citizenrims`; a `/resource/<id>.json` path means `socrata`; a `/FeatureServer/<n>/query` path means `arcgis`. A crime map with no data feed is `map_only`. If you cannot tell, use `none`; the skill then relies on the public aggregators and says so.

**Resolved source URLs** for the default city (AreaVibes, CrimeGrade, SpotCrime and the rest) are optional. The skill builds them from the patterns in `DataSources.md` when they are absent.

## Accounts and secrets

None are required. One optional key: `FBI_CRIME_API_KEY` in `~/.claude/.env` lets TrendAnalysis pull official multi-year agency data from the FBI Crime Data Explorer API. It is free at https://api.data.gov/signup/. Without it, trends come from the public aggregator sites.

## Prove it works

Read-only: this reads your Config.md and changes nothing.

```bash
c=~/.claude/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/CrimeStats/Config.md; test -f "$c" && grep -E '^\| `(default_city|state|police_portal_type)` \|' "$c"
```

With the example above, it prints:

```
| `default_city` | Springfield |
| `state` | XX |
| `police_portal_type` | `socrata` |
```

A row reading `unset` means the starter has not been edited yet; no output means the file is missing.

Optional, still read-only: confirm the primary rate source answers from your machine. This fetches one public page and saves nothing; put your own city and state slug in place of `denver-co`.

```bash
curl -sS -o /dev/null -w '%{http_code}\n' -A 'LifeOS-CrimeStats-setup-check' https://www.areavibes.com/denver-co/crime/
```

Success: `200`. A `404` means the slug is wrong for that site; the skill then falls back to CrimeGrade and HomeSnacks. A `403` means the site blocks scripted clients; the skill does not disguise its requests, so it falls back the same way.

**First real run (writes).** Ask the assistant: "What are the crime stats for my city?" Success is a table of rates per 100,000 for your configured city with a national-average column, each figure citing its source and data year, and a new dated `_quickstats.json` file under `~/.claude/LIFEOS/MEMORY/DATA/CrimeStats/`.
