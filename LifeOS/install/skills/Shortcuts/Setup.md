# Shortcuts

**Contents:** What it does · Fill in · Accounts and secrets · Prove it works

Status: `bun ~/.claude/skills/Shortcuts/Tools/Shortcuts.ts list` · optional

## What it does

Shortcuts turns things only macOS Shortcuts.app can do (Apple Home accessories, native system actions, app intents) into commands you can run from the terminal. You build each shortcut once in Shortcuts.app, by hand or through the ComputerUse skill, under an exact name. From then on `Tools/Shortcuts.ts run "<name>"` runs it with no clicking, pipes any input to it, and prints what its last action returns.

It needs macOS with Shortcuts.app (the `shortcuts` command lives at `/usr/bin/shortcuts`). Building through ComputerUse also needs that skill set up. The signed-plist import path, for shortcuts whose body is one shell command, clicks the import dialog with the Interceptor skill's `interceptor macos` command, so that path needs Interceptor installed (or you click "Add Shortcut" yourself). Building by hand needs nothing else.

## Fill in

Nothing is required. The skill keeps no per-user data: each shortcut's exact name is set by whatever calls it. The Home skill, for example, builds thermostat names from its own `Config.md`.

Worked example of adding your own piece, on made-up names. Say you want a terminal command that reports your thermostats and a home-control skill's `Config.md` says `thermostat_shortcut_prefix: Casa`:

1. In Shortcuts.app, make a new shortcut named exactly `Casa Thermostat Status`.
2. Add Home actions that read each thermostat's current temperature and mode, combine them into one line of text, and end with **Show Result** so the text comes back on stdout.
3. Close the editor so it saves.
4. Check it: `bun ~/.claude/skills/Shortcuts/Tools/Shortcuts.ts run "Casa Thermostat Status"` prints something like `Zone 1 21 heating, Zone 2 20 idle`.

A shortcut that takes input (for example `Casa Set Zone 1 Temp`, given a number) must use **Shortcut Input** as its first action, never "Ask Each Time", so `--input "21"` reaches it without a dialog. `Intents/BuildShortcut.md` covers the rest, including the signed-plist import for shortcuts whose body is one shell command.

## Accounts and secrets

None. Shortcuts that control Apple Home accessories run under the iCloud account that owns the Home; sign in to that account on this Mac. No keys go in `~/.claude/.env`.

## Prove it works

Both are read-only:

```bash
bun ~/.claude/skills/Shortcuts/Tools/Shortcuts.ts --help
bun ~/.claude/skills/Shortcuts/Tools/Shortcuts.ts list
```

The first exits 0 and prints the usage line. The second prints a JSON array of every shortcut name on this Mac (an empty `[]` on a Mac with none); on a machine without Shortcuts it exits 1 with ``error: `shortcuts list` failed — is this macOS?``. After you build one, `bun ~/.claude/skills/Shortcuts/Tools/Shortcuts.ts exists "Casa Thermostat Status"` exits 0 when that exact name is registered and 1 when it is not.
