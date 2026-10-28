# StudioLights

**Contents:** What it does · Fill in · Accounts and secrets · Prove it works

Status: test -f ~/.claude/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/StudioLights/devices.json && echo ok · optional

## What it does

Controls Aputure and amaran studio lights from the terminal or by voice. It talks to the amaran Desktop app on your Mac over a local WebSocket (`ws://127.0.0.1:33782/ws`), so the app has to be installed and signed in to a Sidus account; the tool launches it if it is closed. You get named scenes (recording, normal, full, off, or any you save), per-light brightness and color temperature, and a read-back after every write, so a command only reports done when the light itself confirms the new state. It needs no API key.

**How it is usually run.** You ask the assistant ("lights for recording", "dim the key light to 30%") and the Control intent runs `Tools/Lights.ts`. You can also run the tool directly, or put a scene behind a macOS Shortcut so Siri or a keyboard shortcut can trigger it (worked example below).

**Needs.** A Mac in Bluetooth range of the lights, amaran Desktop, Bun, and nothing else in LifeOS. No other skill, cloud service or scheduled workflow is involved. House lights belong to a home-control skill, if one is installed, not this one.

## Fill in

Your files live in `~/.claude/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/StudioLights/`. The tool refuses to run until `devices.json` exists there. `scenes.json` holds your scenes. `Config.md` is optional notes for you and the assistant; the tool never reads it.

### 1. Start from the starter files

A LifeOS install puts a made-up starter set in that folder: `devices.json` with two lights named `key` and `fill`, `scenes.json` with the four scenes `recording`, `normal`, `full` and `off`, a `Config.md`, and a `README.md`. If the folder is missing, copy the set from the shipped templates:

```sh
ls ~/.claude/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/StudioLights/   # the installer put the starter files here
bun ~/.claude/skills/LifeOS/Tools/ScaffoldUser.ts --apply       # only if any are missing; never overwrites
```

The node IDs in the starter `devices.json` are placeholders that match no real light, so step 2 replaces them.

### 2. List your lights and write `devices.json`

Open amaran Desktop, sign in, and check your lights appear in its window. Then run:

```sh
bun ~/.claude/skills/StudioLights/Tools/Lights.ts devices
```

It asks amaran Desktop for its lights and groups and changes nothing. It runs before `devices.json` exists. Output for a made-up two-light room:

```
Lights:
  10000-AAAAAA             Example Key Light        daylight-only
  10000-BBBBBB             Example Bi-Color Light   has cct
Groups (a group holding every light can be allGroup):
  0123456789abcdef0123456789abcdef   Studio

A devices.json to start from (rename each key to the name you will say; allGroup is the one group above):
{
  "allGroup": "0123456789abcdef0123456789abcdef",
  "devices": {
    "example key light": { "node_id": "10000-AAAAAA", "model": "Example Key Light", "supportsCct": false },
    "example bi color light": { "node_id": "10000-BBBBBB", "model": "Example Bi-Color Light", "supportsCct": true }
  }
}
```

Copy the printed JSON over the starter `devices.json` and rename each key to the short name you will say. For the room above that gives:

```json
{
  "allGroup": "0123456789abcdef0123456789abcdef",
  "devices": {
    "key": { "node_id": "10000-AAAAAA", "model": "Example Key Light", "supportsCct": false },
    "fill": { "node_id": "10000-BBBBBB", "model": "Example Bi-Color Light", "supportsCct": true }
  }
}
```

| Field | Meaning |
|-------|---------|
| `allGroup` | Optional. The node ID of an amaran Desktop group that holds every light, from the Groups list. With it, `wake all` and `sleep all` send one group command; without it they switch each light in turn |
| `devices.<name>` | The name you will say ("key", "fill", "back", "left screen"). Fuzzy substring match works, so keep names distinct |
| `node_id` | The light's node ID, from the Lights list |
| `model` | Display only |
| `supportsCct` | `false` for daylight-only lights; the tool then skips color-temperature writes for them. `devices` guesses it from what each light reports |

If the Groups list has several entries, add `allGroup` by hand only for a group that holds every light, or leave it out. `devices --json` prints the raw lists amaran Desktop returned.

### 3. Set your scenes

Every scene name in `scenes.json` is yours to choose. The assistant also maps four everyday phrases to scenes by name: "recording", "normal", "full" ("everything on") and "off" ("kill the lights"). Keep scenes with those four names and those phrases work. Any other name works when you say "apply scene <name>". The starter `scenes.json` already has all four:

```json
{
  "recording": {
    "key": { "intensity": 30, "sleep": false },
    "fill": { "intensity": 40, "cct": 5000, "sleep": false }
  },
  "normal": {
    "key": { "intensity": 70, "sleep": false },
    "fill": { "intensity": 70, "cct": 5000, "sleep": false }
  },
  "full": {
    "key": { "intensity": 100, "sleep": false },
    "fill": { "intensity": 100, "cct": 5000, "sleep": false }
  },
  "off": {
    "key": { "sleep": true },
    "fill": { "sleep": true }
  }
}
```

| Field | Meaning |
|-------|---------|
| scene name | Any name you like. `recording`, `normal`, `full` and `off` are the four the everyday phrases expect |
| light name | A key from `devices.json`. If you renamed your lights in step 2, rename them here too |
| `intensity` | Brightness, 0 to 100 percent |
| `cct` | Color temperature in kelvin; ignored on lights with `supportsCct: false` |
| `sleep` | `true` turns the light off, `false` wakes it |

The levels above are placeholders. Your own come from your room. Set lights live, look at the camera, and save what you see under the scene's name:

```sh
bun ~/.claude/skills/StudioLights/Tools/Lights.ts set key --intensity 30
bun ~/.claude/skills/StudioLights/Tools/Lights.ts set fill --intensity 45 --cct 4800
bun ~/.claude/skills/StudioLights/Tools/Lights.ts scene save recording
```

`scene save` overwrites that scene with the levels every light reports right now. It refuses to save if any light cannot be read.

### Worked example: a scene with your own name

Say you want a dim, warm "evening" look. Set it live and save it:

```sh
bun ~/.claude/skills/StudioLights/Tools/Lights.ts set key --intensity 15
bun ~/.claude/skills/StudioLights/Tools/Lights.ts set fill --intensity 20 --cct 3200
bun ~/.claude/skills/StudioLights/Tools/Lights.ts scene save evening
```

`scenes.json` now has an `evening` entry beside the other four. Call it by asking the assistant "apply scene evening" or "lights evening", or run `Lights.ts scene evening` directly. To call it by voice, give it a Shortcut as in the next example.

### Worked example: a voice trigger for a scene

A scene you use every day is worth a Siri phrase. In the Shortcuts app on the Mac, make a new shortcut named "Studio Recording" with one **Run Shell Script** action:

```sh
"$HOME/.bun/bin/bun" "$HOME/.claude/skills/StudioLights/Tools/Lights.ts" scene recording
```

Say "Studio Recording" to Siri on the Mac and the scene applies. Make one shortcut per scene you want by voice. The Run Shell Script action exists only on macOS, so these shortcuts do not run on an iPhone. A shortcut calls the scene by name, so renaming the scene in `scenes.json` breaks it silently; note each one in `Config.md`.

### `Config.md`

Optional notes the assistant can read when you ask about your rig. Smallest useful example:

```markdown
---
version: 1.0.0
---

# StudioLights notes

- key: Example Key Light, front left, daylight-only
- fill: Example Bi-Color Light, front right
- "recording" is for talking-head video; "normal" is for desk work; "evening" is dim and warm.
- Shortcut "Studio Recording" runs `scene recording`. Rename the scene and the Shortcut breaks.
```

## Accounts and secrets

- A free Sidus account, used to sign in to amaran Desktop once. No env key and no value goes in `~/.claude/.env`.
- The amaran Desktop app from Aputure, installed on the Mac that is in Bluetooth range of the lights.

## Prove it works

1. `bun ~/.claude/skills/StudioLights/Tools/Lights.ts --help` prints the usage for every command (`devices`, `status`, `set`, `wake`, `sleep`, `scene`, `scene save`, `scenes`) and exits 0. It needs no config and touches no light.
2. `bun ~/.claude/skills/StudioLights/Tools/Lights.ts devices` lists the lights and groups amaran Desktop knows and exits 0, without changing any light. "amaran Desktop reports no lights" means the app is signed out or the lights are out of range.
3. `bun ~/.claude/skills/StudioLights/Tools/Lights.ts scenes` reads your files without opening amaran Desktop or touching a light. It lists each saved scene (for example `recording: key=30%, fill=40%`), or says there are none yet, and exits 0. An error naming `devices.json` means the file is missing or in the wrong folder.
4. `bun ~/.claude/skills/StudioLights/Tools/Lights.ts status` reads every light without changing it. It lists each light from your `devices.json` with its brightness (for example `key  Example Key Light  30%`) and exits 0. A light it cannot read prints `UNREADABLE` and the command exits non-zero; with the starter placeholder IDs every light does, until step 2 of Fill in is done.
