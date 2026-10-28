---
metadata:
  short-description: "Control Aputure/amaran studio lights, brightness, color temperature, and saved recording scenes. Use Home for house lights."
name: StudioLights
evals:
  manual:
    reason: "lighting scenes require connected physical fixtures and a visual safety check"
    falsifier: "a fixture reports a different brightness or color temperature than requested, a saved scene cannot be restored, or the observed lighting is unsafe for the stated use"
version: 1.1.2
description: Controls Aputure and amaran studio lights via the amaran Desktop WebSocket API: named scenes, per-light brightness and color temp, save the current state. USE WHEN lights recording, lights normal, recording lights, set lights for recording, studio lights, light scene, dim the key light, set the lights, lights too bright, save this lighting, green screen lights. NOT FOR house/Hue lights or thermostat (a home-control skill), studio audio, or video editing.
---

# StudioLights

Deterministic control of a studio lighting rig through amaran Desktop's local WebSocket API (`ws://127.0.0.1:33782/ws`, protocol v2 — the same local API the official Bitfocus Companion module uses). The tool auto-launches amaran Desktop if it isn't running.

## Ideal State

- Every lighting change runs through `Tools/Lights.ts` against the rig the USER tree's `devices.json` and `scenes.json` define; no fixture, name or level is assumed from this skill.
- Done is said only when the lights themselves read back the requested state.
- A saved scene restores exactly the levels saved under its name, whether "recording", "normal" or any later caller asks for it.

## Intent Routing

| Intent | Trigger | File |
|----------|---------|------|
| **Control** | "recording", "set the lights", "light scene", "dim X", "save this lighting" | `Intents/Control.md` |

| File | Read when |
|------|-----------|
| `Setup.md` | first-time setup: amaran Desktop, finding node IDs, and writing `devices.json` and `scenes.json` |

## Data & Config

The rig lives in the USER tree, never in this skill: `LIFEOS/USER/CUSTOMIZATIONS/SKILLS/StudioLights/devices.json` holds each fixture's name, node ID, model and whether it has color temperature, and `scenes.json` holds the saved scenes. Free-form notes about the rig (where each light stands, what each scene is for, which Shortcut or macro calls a scene by name) go in `Config.md` in the same folder; the tool never reads it. First-time setup, including how to find node IDs and a worked example of a voice trigger, is in [Setup.md](Setup.md).

`Tools/Lights.ts` exits with an error pointing at Setup.md when `devices.json` is missing; `Lights.ts devices` lists the node IDs to put in it and runs before the file exists. The tool finds that folder from its own skill folder's name, so the skill folder and its USER folder must share a name.

## Gotchas

- amaran Desktop must be running, because it is the bridge between the Mac and the lights' Bluetooth mesh. `Lights.ts` launches it and waits up to 30s. If it opens signed out, it reports no lights; sign in once in its window.
- Daylight-only lights report `cct: 0` and ignore color-temperature writes. Mark them `"supportsCct": false` in `devices.json` and the tool skips CCT for them; `Lights.ts devices` guesses this for you.
- The API's intensity unit is 0–1000, ten per percent. The tool takes 0–100 and converts.
- Each light accepts one command per 200ms. The tool spaces writes 220ms apart, so a scene takes about half a second per light. Do not run writes in parallel.
- Each request carries a token in the same AES-GCM format the official Bitfocus Companion module sends; `Lights.ts` builds it for every request.
- amaran Desktop is the only automation path; the phone apps for these lights offer none.
- Anything that calls a scene by name (a Shortcut, a macro, another skill) breaks silently when the scene is renamed in `scenes.json`, so update the caller when you rename. A Shortcuts "Run Shell Script" action works on a Mac only.

## Examples

**Example 1: Recording**
```
User: "recording" / "set lights for recording"
→ Control intent
→ bun Tools/Lights.ts scene recording
→ Lights move to the levels saved in the recording scene
```

**Example 2: Back to normal**
```
User: "lights back to normal"
→ Control intent
→ bun Tools/Lights.ts scene normal
→ Each light reports back at the normal scene's levels
```

**Example 3: Tune and persist**
```
User: "key light to 30%" ... "perfect, save this as recording"
→ Control intent
→ bun Tools/Lights.ts set key --intensity 30
→ bun Tools/Lights.ts scene save recording
→ The recording scene now holds the levels the user tuned
```
