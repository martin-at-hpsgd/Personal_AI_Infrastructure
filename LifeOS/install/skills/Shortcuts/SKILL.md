---
metadata:
  short-description: "Build and run macOS Shortcuts for Apple-only capabilities without APIs. Use Home for supported devices and Interceptor for browser automation."
name: Shortcuts
evals:
  deterministic:
    - command: 'bun skills/Shortcuts/Tools/Shortcuts.ts list'
      falsifier: "the command exits nonzero or prints anything but a JSON array of shortcut names"
  manual:
    reason: "Shortcuts execute native macOS actions whose authorization and effects depend on the selected shortcut"
    falsifier: "the named shortcut is unavailable, returns an error, or its observed result differs from its declared action"
version: 1.1.2
description: "Bridges macOS Shortcuts.app into LifeOS: build a Shortcut once via computer use, then call it as a CLI to reach Apple-only capabilities like HomeKit. USE WHEN build a shortcut, create a shortcut, macOS shortcut, shortcuts app, run a shortcut, automate a native mac task, HomeKit automation that needs a shortcut, thermostat shortcuts, control home from CLI, wrap an Apple-only action, no API for this app. NOT FOR web automation (Interceptor), shell-scriptable tasks (Bash), devices reachable by API (Home / Network)."
---

# Shortcuts

Turn GUI-only macOS Shortcuts into callable LifeOS automation. Shortcuts reaches Apple-only surfaces (HomeKit/Home, native system actions, app intents) that have no other automation path. Computer use is slow and pixel-fragile, while the `shortcuts` CLI is fast and deterministic but can only run shortcuts, never build them. So each capability is built once (BuildShortcut) and is plain CLI from then on (RunShortcut, through `Tools/Shortcuts.ts`). This is CLI-first doctrine applied to the no-API problem.

## Ideal State

- Each Apple-only capability is built once as a Shortcut under the exact name its consumers call, and is proven by a `run` whose output matches the spec, never by how the editor looks.
- Every later use is plain CLI through `Tools/Shortcuts.ts` or `shortcuts run`, with no pixels and no computer use.
- A failed run or missing shortcut is diagnosed against the exact registered names, so a case or whitespace mismatch is caught before anything is rebuilt.

## Intent Routing

| Intent | Trigger | File |
|--------|---------|------|
| **BuildShortcut** | "build a shortcut", "create a shortcut", "set up the X shortcut" | `Intents/BuildShortcut.md` |
| **RunShortcut** | "run the X shortcut", "invoke X", any consumer calling a built shortcut | `Intents/RunShortcut.md` |
| **ListShortcuts** | "list shortcuts", "what shortcuts exist", "does X exist" | `Intents/ListShortcuts.md` |

| File | Read when |
|------|-----------|
| `Setup.md` | first-time setup, a worked example of adding your own shortcut, and the read-only proof commands |

## Gotchas

- **Creation is GUI-only: there is no `shortcuts create`.** The `shortcuts` CLI runs, lists, and views, but cannot author. Never claim a shortcut was "built" via CLI.
- **Name matching is exact, case and spaces included.** `shortcuts run "Casa Set Zone 1 Temp"` fails silently-ish (nonzero exit) if the registered name is `casa set zone 1 temp` or has a trailing space. Confirm with `exists` after building, register the exact string a consumer expects, and on a nonzero `run` with no clear error, diff the target string against `list` before rebuilding anything.
- **Input arrives on stdin; output is whatever the last action returns.** The CLI pipes `--input` to the shortcut's stdin and captures the final action's output on stdout; without a final output action, stdout comes back empty.

## Data & Config

The skill keeps no per-user data. Shortcut names belong to the consumer that calls them: a home-control skill, for example, builds its thermostat names from `thermostat_shortcut_prefix` and `thermostat_room` lines in its own `Config.md`. There is no config file for this skill. First-time setup, a worked example and a read-only proof: [Setup.md](Setup.md).

The frontmatter `evals` check (`list`) proves this skill on its own. A consumer that depends on a particular shortcut name can check it with `Tools/Shortcuts.ts exists "<name>"`, which exits 1 when that name is not registered.

## Examples

**Example 1: Build the thermostat status shortcut**
```
User: "build the thermostat status shortcut"
→ BuildShortcut, authored through Skill("ComputerUse", "Drive") --app Shortcuts
→ "<prefix> Thermostat Status" exists, reads every thermostat through Home actions,
  and `bun Tools/Shortcuts.ts run "<prefix> Thermostat Status"` returns
  "Zone 1 21 heating, Zone 2 20 idle"
```

**Example 2: A consumer runs a built shortcut**
```
A home-control skill's thermostat script calls `shortcuts run "<prefix> Set Zone 1 Temp"`
with "21" on stdin → RunShortcut path → deterministic, no computer use
```

**Example 3: Check what's there**
```
User: "do my <prefix> shortcuts exist yet?"
→ ListShortcuts: bun Tools/Shortcuts.ts list | rg "<prefix>"
→ the matching names, or a plain "not built yet"
```
