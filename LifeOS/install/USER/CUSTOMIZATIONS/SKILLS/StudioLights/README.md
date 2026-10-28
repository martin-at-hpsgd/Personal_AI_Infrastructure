---
provenance: template
version: 1.0.0
---

# StudioLights — USER data

`Tools/Lights.ts` reads both JSON files from this directory. The tool exits with
an error if `devices.json` is missing; `scenes.json` is created on the first
`scene save` if absent. `Config.md` is optional free-form notes (rig layout,
what each scene is for, which Shortcuts call which scene); the tool never reads
it. The skill's Setup.md walks first-time setup.

## devices.json (required)

Your fixtures as amaran Desktop knows them. The shipped file holds two
placeholder lights whose node ids match nothing real; replace them.

```json
{
  "allGroup": "<optional: node id of a group holding every light>",
  "devices": {
    "<light name>": { "node_id": "<fixture node id>", "model": "<model>", "supportsCct": true }
  }
}
```

- `allGroup` — optional. Node id of an amaran Desktop group containing every fixture; with it, `wake all` and `sleep all` send one group command, without it they switch each light in turn.
- `devices.<name>` — the name you will say ("key", "fill", "back", "left screen"). Fuzzy substring match works, so keep names distinct.
- `node_id` — the fixture's node id in amaran Desktop.
- `model` — display only.
- `supportsCct` — `false` for daylight-only fixtures that report `cct: 0`; the tool then skips color-temperature writes for that light.

Finding node ids: open amaran Desktop and sign in, then run
`bun ~/.claude/skills/StudioLights/Tools/Lights.ts devices`. It lists every
light and group with its node id, guesses `supportsCct`, and prints a
`devices.json` to start from. It changes nothing and runs before this file
exists.

## scenes.json (optional, tool-managed)

Named scenes, one object per scene, one entry per light name from
`devices.json`. `intensity` is 0-100 percent, `cct` is kelvin (ignored on
fixtures with `supportsCct: false`), `sleep: true` turns the light off.

The shipped example holds `recording`, `normal`, `full`, and `off` with
placeholder levels. Tune live with `set <light> --intensity N`, then run
`scene save <name>` to overwrite a scene with the current state. The
`Control` intent maps "recording", "normal", "full", and "off" to these
names, so keep them. Add scenes with any other name the same way
(`scene save evening`) and call them with "apply scene evening". If you
rename a light in `devices.json`, rename it in every scene too.
