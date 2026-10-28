---
provenance: template
version: 1.0.0
---

# StudioLights notes

Notes for you and the assistant about your rig. `Tools/Lights.ts` never reads
this file; it reads `devices.json` and `scenes.json` in this folder.

## Rig

- key: Example Key Light, front left, daylight-only (`supportsCct: false`)
- fill: Example Bi-Color Light, front right

## Scenes

- recording: talking-head video. Tune live, then `scene save recording`.
- normal: desk work.

## Callers

Anything that calls a scene by name breaks silently when the scene is renamed.

- Shortcut "Studio Recording" (Mac only) runs `scene recording`.
