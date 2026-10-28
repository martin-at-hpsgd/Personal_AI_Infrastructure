# DiscoverCoffees

Starts from the user's taste profile and surfaces new coffees and roasters they don't have yet, each tied to why it fits: "based on what you like, here's what you don't know yet."

## Ideal State

- Every find is a coffee or roaster not already in the taste corpus named in Config.md, deduped hard against the set built from reading the corpus first; where a roaster is already there, the find is a different blend by them and says so.
- Every find is a blend or origin offering that exists and is on sale now, carrying a link or source fetched for this request; a pick from memory alone, or a discontinued blend, is not a find.
- Every find shares the profile DNA in the corpus's Taste Profile, anchored on the profile and not just on one favorite roaster; the profile's hard rules are non-negotiable.
- Finds come 2–4 per direction (roasters whose house style matches, origins whose typical cup matches, processing that matches), and the list stays tight: a few high-confidence finds, never a flood.
- Output is grouped by what each find resembles, one line per find in the `Because you like … [safe fit | stretch]` form below.
- Each find is tagged safe fit (clearly in the user's lane) or stretch (an adjacent reach that may push one of the profile's limits, named in the line).
- Finds are tied to the user's gear where useful: which brewer in the gear notes brings out what the find does best.
- The reply offers to log keepers via AddCoffee, tagged 👂 until the user confirms they love them.

## Anti-criteria

- Never names famous roasters by reflex without screening their current offerings against the profile; a roaster's reputation says nothing about whether it fits this palate.
- Never presents a coffee that breaks a Taste Profile hard rule as a fit, however highly it is rated.
- Never collapses into Recommend's single best pick: discovery is profile-driven and grouped by lineage.
- Never recommends a coffee the user cannot brew the way they brew (SKILL.md § Gotchas).

## Output format

One line per find, grouped by the match: `Because you like <anchor / the profile in its own words> → <roaster blend or origin> — <one line on why it fits> [safe fit | stretch]`.

## Inputs

The directions that can share the profile DNA, each screened against the profile before use:

- **Roasters whose house style matches** — blend-houses, single-origin specialists, or roasters known for a roast range, chosen for how their typical cup reads against the profile.
- **Origins whose typical cup matches** — as general coffee knowledge: Brazil and Sumatra usually read heavy-bodied, nutty or earthy and low in acidity; Colombia and Guatemala balanced, caramel or cocoa; Kenya and washed Ethiopia bright, floral and citric. Pick the origins that match the profile, and treat these as tendencies, not guarantees.
- **Processing that matches** — natural and honey processing tend toward heavier body and jammy fruit; washed tends toward a cleaner, brighter cup. Match it to what the profile asks for.
