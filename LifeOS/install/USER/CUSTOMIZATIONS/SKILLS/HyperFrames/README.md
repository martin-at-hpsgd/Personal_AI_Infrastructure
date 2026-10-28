---
provenance: template
version: 1.1.0
---

# HyperFrames customizations

The HyperFrames skill checks this directory before every intent (`SKILL.md`, Customization section). Put a `PREFERENCES.md` here for video presets, default quality, and animation style; the skill reads it as prose.

What the skill reads for look and feel:

- `Theme.json` (optional, this directory): a partial theme merged over the skill's neutral default by `Tools/Theme.ts`. Keys mirror `DEFAULT_THEME` (`colors`, `typography`, `motion`, `spacing`, `effects`, `borderRadius`); an unknown key, a wrong type or a named font family stops the import with the file and key. A made-up example: `{ "colors": { "accent": "#e11d48", "accentLight": "#fb7185" } }`.
- `PREFERENCES.md` (optional, this directory): presets, music placement, capture rules, and whether `Tools/WatchFilm.ts` may send private cuts to its vendor (public films only when unset).
- `LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Art/PREFERENCES.md`: the Art skill's palette and aesthetic, which `Intents/ContentToAnimation.md` loads before composing.
- `LIFEOS_HYPERFRAMES_DIR` (environment): where one-off projects live, outside every git repo. Default `~/HyperFrames/`.
- `LIFEOS_DOWNLOADS_DIR` (environment): where `ArtDirection/Tools/Deliver.ts` hands renders over. Default `~/Downloads/` when unset.
