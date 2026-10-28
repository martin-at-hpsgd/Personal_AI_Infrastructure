# AddPreference

A new favorite recorded in the household taste profile, where every later recommendation can draw on it.

## Ideal State

- The new item sits in the matching existing section of the Preferences data file: a restaurant as a Favorite Restaurants table row (name, location, cuisine, notes), a cuisine preference in the Favorite Cuisines list or the Taste Profile rules, a beer under Drinks → Beer, a wine under Drinks → Wine, and a dish or general taste note in Taste Profile.
- The entry records only what the principal actually said, with every unknown detail written as `TBD`, and is factual and consistent with the existing format.
- A new restaurant row is dated in its Added column as a bare `YYYY-MM-DD`.
- When the item resolves an existing open item (for example an unnamed spot or the wine list), that line in "Open Items / To Confirm" is updated or removed.
- The principal is told exactly what was added or changed, in one or two lines.

## Anti-criteria

- Never invents cuisine, address, vintage, or menu details, and never guesses where a detail is unknown.
- Never writes real restaurant names, locations, or personal notes into the skill body; they belong in the Preferences data file under the USER tree.

## Inputs

A new favorite — restaurant, cuisine, dish, beer, or wine — from what the principal said, written into `LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Restaurants/Preferences.md`.
