---
provenance: template
version: 1.0.0
---

# Food & restaurant preferences

> Source of truth for the restaurants skill. The Recommend intent reads this whole file
> before every recommendation; the AddPreference intent appends to it. No tool parses it. Keep the section names below; the intents
> look for them by name. Write `TBD` for anything you do not know rather than guessing.

## Taste Profile

The rules a recommendation must respect. Write them as short declarative lines.

- Favorite cuisine: TBD
- Heat tolerance: TBD (for example high / medium / low)
- Dealbreakers: TBD (for example loud rooms or long waits)
- Dietary constraints: none
- Price comfort: TBD

## Favorite Cuisines

Ranked, best first.

1. TBD

## Favorite Restaurants

One row per place. Date every addition.

| Name | Location | Cuisine | Notes | Added |
|------|----------|---------|-------|-------|
| TBD | TBD | TBD | (no favorites recorded yet) | |

## Drinks

### Beer

- Profile: TBD (for example dark and roasty)
- Favorites: TBD

### Wine

- Favorites: TBD

## Companion Restrictions

Optional. Delete this section if you do not need it. If a person can only eat at certain
places, add a row here; when they are coming along, Recommend picks only from their list.

| Person | Allowed places |
|--------|----------------|

## Open Items / To Confirm

Things mentioned but not pinned down yet. AddPreference removes a line here when the
answer arrives.

- Fill in the Taste Profile
