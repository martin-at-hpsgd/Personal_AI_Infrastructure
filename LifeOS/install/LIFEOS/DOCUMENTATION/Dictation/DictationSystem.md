---
version: 2.0.2
last_updated: 2026-10-13
last_updated_by: da
convention: lifeos-freshness-v1
status: live
---

# Dictation — push-to-talk for your dictation app

> A foot pedal and a keyboard shortcut drive your dictation app in two modes. Tap to start and tap to stop for long, hands-free talking. Hold to talk, and letting go stops the dictation and presses Enter once the app has pasted the text.

Dictation is how the principal talks to their DA. It is a few small pieces spread across three apps, and several of them exist only to work around how dictation apps, Stream Deck and macOS handle keys. None of those workarounds would be obvious on a new machine, so this doc records each one and why it exists, and `bun LIFEOS/DICTATION/Dictation.ts setup` rebuilds the whole thing. Criteria and build state live in the feature's ISA (maintainer-side; it does not ship).

**Which dictation app is yours is USER data.** `LIFEOS/USER/CUSTOMIZATIONS/DICTATION/App.ts` names it: its label, bundle id, Homebrew cask, the engine word the pedal code uses for it, the history table auto-Enter reads, where its microphone is chosen, and a probe for whether it records from the preroll bridge. The same folder's `README.md` covers that app's specifics. This doc and `Dictation.ts` name no vendor, except in the legacy identifiers below that are kept so old installs can be found and cleaned up. The pedal repo (`dictation-pedal`), its Stream Deck plugin id, the Hammerspoon module and the log file keep the name of the first app it drove, because renaming them would break a pedal mapping that already works.

## What it does

| Input | Tap (shorter than 0.4 s) | Hold (0.4 s or longer) |
|---|---|---|
| Stream Deck foot pedal | Starts dictation, or stops it if one is running | Starts on press, stops on release, then presses Enter once the text is pasted |
| Right Ctrl+J | Same as the pedal | Same as the pedal |

A tap never sends Enter. A hold sends Enter only when the app records the dictation as pasted, so a dismissed or silent hold sends nothing.

The far-left pedal (F18, handled by a function in your own `~/.hammerspoon/init.lua`) opens a new DA session and then, one second after the DA launch alias + Enter, calls `DictationToggle()` from the Hammerspoon module. That is one tap, so dictation is already running when the session comes up; stop it with a tap of the dictate pedal or Right Ctrl+J and the text pastes into the new session without an Enter.

## The pieces

| Piece | Where it lives | Job |
|---|---|---|
| Dictation app | named in `LIFEOS/USER/CUSTOMIZATIONS/DICTATION/App.ts` | Records, transcribes and pastes. |
| Engine file | `~/Library/Application Support/DictationPedal/engine`, one word | Tells the pedal code and the preroll helper which app to drive and how (`src/engine.ts` in the repo maps each word to a start and stop). Read on every press, so a change needs no restart. |
| `dictation-pedal` repo | a public GitHub repo, cloned locally; the URL and clone path come from `LIFEOS/USER/CUSTOMIZATIONS/DICTATION/config.json` | Holds all the code below. |
| Stream Deck plugin | `com.lifeos.dictationpedal`, installed into `~/Library/Application Support/com.elgato.StreamDeck/Plugins/` | Turns pedal presses into start and stop signals. Its one action is "Dictate (tap or hold)" in the LifeOS category. |
| Hammerspoon module | `keyboard/dictation_keys.lua` in the repo, symlinked to `~/.hammerspoon/dictation_keys.lua`, loaded from `~/.hammerspoon/init.lua` by `require` or `pcall(require, …)` | Catches the physical Right Ctrl+J and hands press and release to the keyboard listener. |
| Keyboard listener | `src/keyboard.ts` in the repo, started and watched by the Hammerspoon module | Runs the same tap-or-hold logic as the plugin (`src/dictate.ts`) for the keyboard. |
| Auto-Enter | `src/dictate.ts`, reading the app's history table | Waits for the app to finish a held dictation, then presses Enter. |
| Preroll bridge | `DictationPreroll.app` from the repo's `preroll/` | Records the mic from the instant of the press so the first word is never lost. |
| Setup and check | `LIFEOS/DICTATION/Dictation.ts` | Builds the pieces on a new Mac and names whichever one is broken. |

## Why it is built this way

### Each app gets the start and stop it accepts

Dictation apps disagree about outside control. Some take a posted keyboard shortcut; others read their shortcuts straight from the keyboard hardware and ignore posted keys, but accept a URL that starts or stops dictation. `src/engine.ts` holds one entry per app with whichever it takes, and `src/dictate.ts` calls it the same way for both. Each start and stop is awaited, so a quick stop cannot overtake its start.

### The hold is a start and a stop

A press sends a start. A release after `HOLD_MS` (400 ms) sends a stop. A release before that sends nothing, which is what makes a short press a toggle.

Nothing is tracked. Whether a press starts or stops a dictation is read from CoreAudio at the moment of the press: if the app's input is running, the press is a stop, and its release does nothing. So the pedal cannot drift out of sync when the app stops on its own. The cost is one quirk: stopping a toggle-mode dictation needs a short tap, because a long press starts a new dictation on release.

### Posted events carry a mark

Every keystroke the plugin and the listener post (the Enter after a hold, a shortcut for apps that take one, and the key-ups below) has `kCGEventSourceUserData` set to `0x7479706c` (ASCII "typl"). The Hammerspoon module lets any event with that mark through untouched and handles only unmarked, physical ones, so it never swallows keystrokes the system itself generates.

### The keyboard listener stays running

The start has to go out before J begins auto-repeating, about 225 ms after the press. Starting a fresh `bun` process for each press lost that race about half the time. So the Hammerspoon module starts `src/keyboard.ts` once and sends it one line per event (`down`, or `up <heldMs>`) over a Unix socket. A watchdog in the module restarts the listener, and re-enables its own event tap, every 60 seconds if either has stopped.

### The preroll bridge: your first word gets through

Dictation apps take half a second or more to open the microphone after a start (measured 2026-09-28: about 0.5 s normally, up to 1.5 s right after a previous dictation), and anything said before that is not recorded. So the app does not record from the microphone directly. `DictationPreroll.app` (the repo's `preroll/`, Go with its real-time audio callbacks in C) runs at login and listens on `~/Library/Application Support/DictationPedal/preroll.sock`:

1. A start press sends `arm`. The helper opens the Mac's default input (the real mic) at once, about 30 ms after the press, into a ring buffer.
2. The app's microphone is set to **Dictation Preroll**, an aggregate device the helper creates around BlackHole 2ch. When the app starts reading it, the helper plays the ring into BlackHole from the first sample, so the app hears the dictation from the press, a second or two behind real time.
3. Before any stop (a hold's release, or a press while the app records), `drain` waits until everything through the release plus 100 ms has been played. While behind, the helper skips runs of silence (quieter than the room's noise floor + 12 dB, at most -35 dBFS), so pauses let it catch up and the stop waits less.
4. When the app stops reading for 1.5 s, the helper closes the mic. An arm the app never reads is dropped after 6 s. The app started any other way gets the live mic.

Why each odd piece exists:

- **An aggregate, not BlackHole itself.** Some dictation apps hide every input labeled "(Virtual)", and BlackHole is one. An aggregate of it is not.
- **Playback waits for a steady read.** Dictation apps open and close their input several times before they really record. Playback starts only after 120 ms of continuous reading and pauses whenever the app lets go, so those flickers never eat the start of the dictation.
- **The mic is the default input.** The helper refuses to capture from BlackHole or the aggregate, which would feed its own output back to itself.
- **The cost:** text arrives after release by roughly the time the app took to start (minus the silence skipped). A press within a fraction of a second of a stop can still be ignored while the app finishes the last dictation; the log says `<app> never started, nothing to stop`.

### Auto-Enter waits for the app's own history

The app writes one row per dictation to a table in its local SQLite database (`App.ts` names the file, table and columns). After a hold ends, `src/dictate.ts` polls that table read-only every 100 ms for up to 20 seconds, looking only at the newest row stamped between the press and just after the release. That window ties each Enter to the dictation its own hold started, so a later dictation finishing cannot trigger it. A status meaning "pasted" waits 150 ms and presses Return; a status meaning "still working" keeps waiting; anything else, a timeout, or a changed schema means no Enter, and the log says why. Which status words mean what is per app, in `src/dictate.ts`.

### Dictation leaves audio alone

The pedal and Right Ctrl+J neither mute nor pause anything; nothing in the repo reads or changes audio state except the preroll helper's own capture. A CoreAudio mute was tried and retired in 2026-09 because switching a process tap on or off made every audio app reinitialise. It ran as `TypelessMute.app` with a LaunchAgent `com.lifeos.typelessmute`; the repo's `install.ts` removes it from any Mac that still has it, and `Dictation.ts check` fails if any of it is left.

### The plugin restarts itself when a pedal reconnects

A pedal on a flaky USB path (a monitor's built-in hub, for example) can drop off and come back. Stream Deck reconnects the device but does not reattach the action to the running plugin, so presses stop arriving and the log shows nothing. The plugin logs `pedal device <id> disconnected`, and on the matching reconnect it exits; Stream Deck relaunches it within about 3 seconds, and the fresh plugin gets the action (`pedal action shown on device <id>`).

A pedal can also come back without its serial number: System Information → USB shows it with "Serial Number: Not Provided". Stream Deck keys profiles by serial, so it treats that pedal as a new device and gives it an empty profile, and the Dictate action is gone from it. Unplug the pedal and plug it back in, ideally straight into the Mac. Stream Deck then sees the real serial and the original profile again.

### The plugin binary is signed

`install.ts` compiles the plugin into one binary with `bun build --compile`. macOS kills an unsigned compiled binary on launch, so the installer signs it ad hoc with `codesign --force -s -`. `Dictation.ts check` runs `codesign -v` on it.

## Permissions

| App | Permission | Why |
|---|---|---|
| Stream Deck | Accessibility | The plugin runs under Stream Deck, and macOS drops keystrokes (the Enter) posted by an app without Accessibility. |
| Hammerspoon | Accessibility | Its event tap needs it to see and swallow Right Ctrl+J, and the listener it starts posts keystrokes. |
| DictationPreroll | Microphone | It records the mic from the press; macOS asks the first time. It is signed with the Apple Development certificate so the grant survives rebuilds. |
| The dictation app | Microphone, Accessibility | Asked for during its own onboarding; it needs them to record and paste. |

The Accessibility grants are in System Settings → Privacy & Security → Accessibility. A script cannot read these grants, so `Dictation.ts check` lists them as a reminder.

## Logs

Every press is logged to `~/Library/Logs/DictationPedal.log`, one line each, with the source (`pedal` or `keyboard`) and the engine word:

| Line | Meaning |
|---|---|
| `pedal down: <engine> toggle (start), tapped 0.3ms after the press` | A press sent the start (or stop), this long after the press reached our code. For the keyboard it counts from the physical key event. |
| `keyboard <engine> mic live 512.0ms after the tap` | The app opened the mic this long after a start. Read-only CoreAudio check; stops log nothing. |
| `keyboard <engine> mic not live 3s after the tap` | The app did not open the mic after a start. |
| `pedal up after 180ms: tap, nothing on release` | A tap. Nothing sent on release. |
| `keyboard up after 2026ms: hold ends, toggle` | A hold ended and sent the stop. |
| `keyboard pasted: enter` | The app recorded the dictation as pasted, and Enter was pressed. |
| `keyboard no completed dictation: no enter` | The dictation was dismissed, empty, failed, or took longer than 20 seconds. |
| `paste check error: ...` | The app's history database could not be read before the deadline. |
| `pedal action shown on device <id>` | Stream Deck is showing the Dictate action on that pedal, so presses will arrive. |
| `pedal device <id> disconnected` / `reconnected: restarting plugin` | The pedal dropped off USB and came back; the plugin restarts itself so presses arrive again. |
| `registered`, `socket closed` | The plugin connected to or disconnected from Stream Deck. |
| `keyboard listener started` | Hammerspoon started the keyboard listener. |
| `preroll capturing 30.1ms after arm` | The helper had real mic audio this long after the press. |
| `keyboard drained 900ms before the stop` | The stop waited this long for the app to hear everything. |
| `keyboard up after 2475ms: <app> never started, nothing to stop` | The app ignored the start (usually a press right after a stop); no stop was sent, so no stray dictation starts. |

The helper's own lines say `app` for whichever dictation app it is playing to (`preroll app reading …`). The Hammerspoon console shows `dictation_keys: listener exited <code>` when the listener stops.

## Tuning

All of these are constants in the `dictation-pedal` repo.

| Constant | File | Default | Effect |
|---|---|---|---|
| `HOLD_MS` | `src/dictate.ts` | 400 | The press length that counts as a hold. |
| `ENTER_AFTER_HOLD` | `src/dictate.ts` | true | Set false to stop auto-Enter after a hold. |
| `PASTE_TIMEOUT_MS` | `src/dictate.ts` | 20000 | How long auto-Enter waits for the app to finish. |

After changing any of them, run `bun LIFEOS/DICTATION/Dictation.ts setup`, which rebuilds the plugin because its source is newer than the installed binary, then restart Stream Deck and reload Hammerspoon. The reload restarts the keyboard listener, which otherwise keeps running the old code.

The Hammerspoon module also names two paths: `BUN` (`/opt/homebrew/bin/bun`) and `SCRIPT`, the listener inside the clone at `~/Projects/dictation-pedal`. `Dictation.ts check` verifies both exist on its "keyboard adapter" line. On a Mac where bun lives elsewhere, or where the clone is somewhere else, edit those two lines.

## Fresh machine

1. Write `LIFEOS/USER/CUSTOMIZATIONS/DICTATION/App.ts` for your dictation app (copy an existing one; `Dictation.ts` reports exactly which field is missing).
2. Install the apps and bun: `brew install --cask <your app's cask> hammerspoon elgato-stream-deck` and `brew install oven-sh/bun/bun`. On Apple silicon, Homebrew's bun lands at `/opt/homebrew/bin/bun`, the path the Hammerspoon module expects; anywhere else, edit `BUN` as described under Tuning.
3. Open the dictation app, sign in, and finish its onboarding, granting it the Microphone and Accessibility.
4. Put the clone URL in `LIFEOS/USER/CUSTOMIZATIONS/DICTATION/config.json` as `repoUrl` (and `repoDir` if the clone should not go to `~/Projects/dictation-pedal`).
5. Preview with `bun LIFEOS/DICTATION/Dictation.ts setup --dry-run`, then run `bun LIFEOS/DICTATION/Dictation.ts setup`.
6. Do the steps setup prints at the end, which it cannot do itself:
   - Grant Accessibility to Stream Deck and Hammerspoon.
   - Restart Stream Deck so it loads the plugin.
   - Drag "Dictate (tap or hold)" from the LifeOS category onto the pedal.
   - Reload Hammerspoon (menu bar icon → Reload Config).
7. Preroll bridge: `brew install --cask blackhole-2ch`, then `sudo killall coreaudiod` so macOS loads it (or restart). Run the repo's `bun install.ts` again, which starts DictationPreroll and creates the "Dictation Preroll" input. Pick **Dictation Preroll** as the app's microphone (where, is `micSetting` in `App.ts`), and allow DictationPreroll the microphone when macOS asks.
8. Run `bun LIFEOS/DICTATION/Dictation.ts check`. Every line should read `ok` or `info`. A `warn` (for example, the preroll bridge not installed) is a gap to read, not a failure; only a `fail` line makes it exit 1.
9. Try both gestures on both inputs, and watch `~/Library/Logs/DictationPedal.log` while you do.

### What setup does

Setup plans every step first and writes nothing if any step is blocked. Running it again on a working machine changes nothing.

| Step | Writes when | Never |
|---|---|---|
| Apps | never; blocks with the `brew` command if one is missing, or with a pointer to `App.ts` if no app is named | installs apps itself |
| Repo | the clone is missing (clones it), or the clone is clean and strictly behind upstream (fast-forwards) | touches a clone with local changes or local commits |
| Plugin | the plugin is missing, unsigned, has a different manifest, or is older than its source (runs the repo's `install.ts`) | rebuilds a current plugin |
| Hammerspoon module | the link is missing or points elsewhere | replaces a regular file in its place |
| Hammerspoon require | `init.lua` has no uncommented `require("dictation_keys")` or `pcall(require, "dictation_keys")` | adds a second one |
| Retired mute app | its LaunchAgent, app bundle or socket is still present (stops and deletes them) | touches anything outside the home folder |
| Engine | the engine file is missing or names a different app than `App.ts` | writes outside the home folder, or touches the app's own settings |

The pedal mapping lives in Stream Deck's own profile files, which Stream Deck overwrites while it runs, so setup leaves it to the drag. The app's microphone choice is likewise left to its own settings screen.

### What check verifies

One line per piece: the dictation app named in `App.ts` and the two helper apps (found by bundle identifier), the clone, the installed plugin and its signature, whether the plugin is older than its source, the engine file, the Hammerspoon link and require line, the two paths the module launches, no leftover of the retired mute app, the preroll bridge (fails when the app records from Dictation Preroll but the helper is not running, because every dictation would be silent), a Stream Deck profile slot holding the Dictate action, and a readable history table with the columns auto-Enter needs. It also prints the last log line and the Accessibility reminder. It exits 1 and names every failed piece.

## Troubleshooting

Start with `bun LIFEOS/DICTATION/Dictation.ts check`. Most rows below map to one of its lines.

| Symptom | Likely cause | Fix |
|---|---|---|
| Check fails on "dictation app" | No `App.ts` in the USER zone | Write one (Fresh machine, step 1). |
| The pedal does nothing and the log shows no `pedal` lines | Stream Deck has not loaded the plugin, or the pedal slot holds a different action | Check the "stream deck plugin" and "stream deck action" lines. Restart Stream Deck, then drag "Dictate (tap or hold)" onto the pedal. |
| The log shows `pedal down: … toggle` but the app does not react | The app is not running or not signed in, or the engine file names another app | Open the app. Check the "engine" line and run setup if it fails. |
| Right Ctrl+J types a j, or does nothing | Hammerspoon is not running, lacks Accessibility, or is not loading the module | Check the "hammerspoon module", "hammerspoon require" and "keyboard adapter" lines. Grant Accessibility, then Reload Config. |
| The first keyboard press after a reload does not start dictation | The listener was still starting | Wait a second after a reload. The watchdog restarts a dead listener within 60 seconds. |
| A hold ends but no Enter is sent | The log says `no completed dictation: no enter`: the dictation was dismissed, empty, failed, or took longer than 20 seconds | Check the "app history" line. For long holds, raise `PASTE_TIMEOUT_MS`. |
| The log shows `paste check error` | The app's history database is missing or unreadable | Check the "app history" line. Open the app once so it creates the database. |
| Dictations come out empty | The app records from Dictation Preroll but the helper is down | Check the "preroll bridge" line; run the repo's `bun install.ts`, or pick the real mic in the app. |
| The pedal stops working after a USB drop, and the log shows no `reconnected` line | The pedal came back with "Serial Number: Not Provided", so Stream Deck gave it an empty profile | Unplug the pedal and plug it back in, ideally straight into the Mac rather than a monitor or hub. |
| Check fails on "retired mute app" | An earlier install of the retired mute is still on this Mac | Run setup; it stops and removes it. |
| Stopping a toggle dictation starts a new one | The stop press lasted `HOLD_MS` or longer | Tap shorter, or raise `HOLD_MS`. |
| Nothing changes after updating the repo | The plugin binary was built from the old source, or the keyboard listener is still running old code | Check the "plugin freshness" line. Run setup, restart Stream Deck, and reload Hammerspoon. |
| Check fails on "keyboard adapter" | bun is not at the path the module names, or the clone is not where the module expects it | Install bun with Homebrew, or edit `BUN` and `SCRIPT` at the top of `dictation_keys.lua`. |
| Check fails on "stream deck action" after new hardware or a new profile | The new profile has no Dictate action | Drag "Dictate (tap or hold)" onto the pedal. |
