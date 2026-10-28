# AddTarget

Adds a configured calibration target for an intent whose outputs are not an eval suite, such as an image intent.

## Ideal State

- `target.json` exists at `LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Calibrate/Targets/<name>/target.json`, and its pool is the principal's real published outputs whenever they exist.
- `pool --target <name>` reports a pool large enough for several sessions (aim for 100+ distinct artifacts).
- The page question is the one the principal would actually ask themselves about this intent's output.
- `rescore` has a brief whose judge is the one the intent really uses, and the brief the owning intent writes carries the same `"calibration": "<name>"` field, so its live judge reads the taste too.

## Anti-criteria

- Candidates and rejected rounds never stand in for the real published outputs as the pool.
- A session never shows five near-identical candidates of one piece.

## Output format

For real published outputs, use a `frontmatter` pool over the published documents with `"selection": "newest"`. Create `LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Calibrate/Targets/<name>/target.json` (name: lowercase, digits, dashes):

```json
{
  "name": "<name>",
  "title": "Shown as the page heading",
  "question": "The one question the principal answers per artifact",
  "skill": "<owning skill>",
  "workflow": "<owning workflow>",
  "pools": [
    { "kind": "evalround", "glob": "<dir>/**/EvalRound.json" },
    { "kind": "files", "glob": "<dir>/*-candidate-*.png", "groupPattern": "^(.*?)-candidate" }
  ],
  "brief": "Brief.json"
}
```

- `evalround` and `files` pools are for intents with no published outputs yet (Ideal State: the real published outputs whenever they exist). A `frontmatter` pool needs `imageField` and `localRoot`; `where`, `urlPrefix`, `dateField` and `titleField` are optional (`Tools/Calibrate.help.md`).
- `evalround` pools carry the judge's scores, so the first report has numbers without spending a call. `files` pools have none until `rescore`.
- `groupPattern` groups variants of one piece so a session never shows five near-identical candidates.
- `Brief.json` is an ArtDirection brief with `"calibration": "<name>"`.
- When `LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Calibrate/PREFERENCES.md` exists, the page question and the brief follow what it says the principal scores first.

## Tool contract

```bash
bun skills/Calibrate/Tools/Calibrate.ts pool --target <name>
```
