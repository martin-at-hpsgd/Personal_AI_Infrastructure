# Control

Studio lights set to the scene or per-light levels the user asked for, confirmed by the state the lights report back.

## Ideal State

- The lights end at what the user asked for, a scene or a per-light change, and each light state in the report is the state that light read back (`(reported by light)`), never the request.
- On a non-zero exit, the report names which lights failed.
- A new scene or new levels carry the user's own numbers, set live to their taste, and are persisted under the name they chose with `scene save <name>`.

## Anti-criteria

- Never assume a write landed.
- Never report done after a non-zero exit: a timeout, a non-zero device code, a `MISMATCH` read-back, a light that `status` cannot read, or a refused partial `scene save`.
- Never pick new scene levels on the user's behalf; the numbers are their call.
- Never edit the scenes file directly except for bulk changes the user has dictated. The file lives in the USER tree; the Lights.ts header and Setup.md give its path.

## Output format

One line per light, as the light reports it: `lamp: 30% 5600K (reported by light)`. Done is reported only on exit 0; otherwise the report names the lights that failed.

## Tool contract

### Intent-to-Flag Mapping

| The user says | Command |
|-------------|---------|
| "lights recording", "recording", "lights for recording" | `bun ~/.claude/skills/StudioLights/Tools/Lights.ts scene recording` |
| "lights normal", "normal", "back to normal" | `... scene normal` |
| "full", "everything on", "max lights" | `... scene full` |
| "lights off", "kill the lights" | `... scene off` (or `... sleep all`) |
| "apply scene <name>", "lights <name>", "<name> lights" for any other saved scene | `... scene <name>` (`... scenes` lists the saved names) |
| "dim/set <light> to N%" | `... set <light> --intensity N` |
| "warmer/cooler", "set <light> to K kelvin" | `... set <light> --cct K` (no-op on a light marked `"supportsCct": false`) |
| "what are the lights at" | `... status` |
| "save this as <scene>" | `... scene save <scene>` |
| "list scenes" | `... scenes` |
| "find my lights", "what node IDs do my lights have" (first-time setup) | `... devices` (read-only; works before `devices.json` exists) |

Light names are the keys of the user's `devices.json` (`... status` prints them) plus `all`; fuzzy substring match works.
