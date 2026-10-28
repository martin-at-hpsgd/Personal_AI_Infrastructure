---
version: 1.0.0
---

# Dictation (a foot pedal and hotkey for talking to your DA)

Status: `bun LIFEOS/DICTATION/Dictation.ts check` · optional

## What it does

Dictation lets you talk to your DA instead of typing. A Stream Deck foot pedal and the keyboard shortcut Right Ctrl+J both drive your dictation app in two modes. A quick tap starts dictation and another tap stops it, for long hands-free talking. Holding the key or pedal dictates while it is down; letting go stops, waits for the app to paste your words, and presses Enter once. A tap never sends Enter, and a dismissed or silent hold sends nothing.

An optional helper called the preroll bridge records your microphone from the instant you press, so the half second a dictation app takes to open the mic never swallows your first word. The pieces and the reasons behind them are in `LIFEOS/DOCUMENTATION/Dictation/DictationSystem.md`. You need all of this only if you dictate to your DA by pedal or hotkey; nothing else depends on it.

## Fill in

Two files under `LIFEOS/USER/CUSTOMIZATIONS/DICTATION/`, both in place from the templates.

`App.ts` names your dictation app. Every value in the template is a placeholder, so `check` reports the app as missing until you replace them. The fields:

| Field | Meaning |
|---|---|
| `label` | The app's name as macOS shows it, which is its folder name in Applications. |
| `bundleId` | Its bundle identifier. `osascript -e 'id of app "<label>"'` prints it. |
| `cask` | The Homebrew cask that installs it. |
| `engine` | The one word the pedal repo uses for this app. The repo's README lists the supported apps and their words. |
| `history` | The app's local database: `db` (relative to `~/Library/Application Support`), `table`, and the status and timestamp `columns`. Auto-Enter reads this to know a dictation was pasted. |
| `onboarding`, `micSetting` | What you do by hand in the app first, and where you pick its microphone. |

The app must be one the `dictation-pedal` repo has an engine for. Any other app needs an engine entry added to the repo first. `Dictation.ts` reports exactly which field is missing or malformed.

`config.json` holds `repoUrl`, the clone address of the `dictation-pedal` repo, and optionally `repoDir`, where the clone goes (default `~/Projects/dictation-pedal`). The template already carries the repo's address.

## Accounts and secrets

No API key is involved. What you need is outside LifeOS, and none of it ships in this release:

- A dictation app the pedal repo supports, with its own account and sign-in. Open it once, sign in, and grant it Microphone and Accessibility.
- Stream Deck (the Elgato app) and a pedal or key to put the action on.
- Hammerspoon, for the Right Ctrl+J shortcut.
- The `dictation-pedal` repo, which holds the Stream Deck plugin, the Hammerspoon module, the keyboard listener and the preroll helper. It is a public GitHub repo, and `Dictation.ts setup` clones it for you.
- For the preroll bridge: the BlackHole 2ch audio driver, and the Go toolchain to build the helper.

Install the apps with Homebrew: `brew install --cask <your app's cask> hammerspoon elgato-stream-deck`, and `brew install oven-sh/bun/bun`. On Apple silicon, Homebrew puts bun at `/opt/homebrew/bin/bun`, which the Hammerspoon module expects; elsewhere, edit the `BUN` line at the top of `dictation_keys.lua`.

Preview what setup will do, then run it. Setup writes nothing if any step is blocked:

```bash
bun LIFEOS/DICTATION/Dictation.ts setup --dry-run
bun LIFEOS/DICTATION/Dictation.ts setup
```

Setup clones or updates the repo, builds and signs the plugin, links the Hammerspoon module, and sets the engine file. It cannot do the by-hand steps, which it prints at the end: grant Accessibility to Stream Deck and Hammerspoon (System Settings, Privacy & Security, Accessibility), restart Stream Deck, drag "Dictate (tap or hold)" from the LifeOS category onto your pedal, and reload Hammerspoon (menu bar icon, Reload Config).

For the preroll bridge, run `brew install --cask blackhole-2ch`, then `sudo killall coreaudiod` so macOS loads it. Run the repo's `bun install.ts` again to build and start the helper. Pick **Dictation Preroll** as the app's microphone, where `micSetting` in `App.ts` says, and allow it the microphone when macOS asks.

## Prove it works

```bash
bun LIFEOS/DICTATION/Dictation.ts check
```

It prints one line per piece (the app, Hammerspoon, Stream Deck, the repo clone, the plugin and its signature, the engine, the Hammerspoon link, the keyboard listener paths, the preroll bridge, the pedal action, the app's history table) and ends with `check passed` and exit 0 when every line reads `ok` or `info`. A failed line names the piece and exits 1. It cannot see the Accessibility grants, so it prints a reminder for those.

Then try it. Tap Right Ctrl+J, say a sentence, tap again: the text should paste. Hold Right Ctrl+J, speak, let go: the text pastes and Enter is pressed. Repeat on the pedal. Every press is logged in `~/Library/Logs/DictationPedal.log`.
