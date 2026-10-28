---
version: 1.0.0
---

# Helm setup

The reference terminal LifeOS was built in. Full documentation: [Terminal/Helm.md](../Terminal/Helm.md).

## What it does

Helm is kitty with the LifeOS config layer, and herdr inside it as the workspace layer. The installer's `helm` component sets it up by default: the kitty config link, a `Helm.app` wrapper, the `helm` command, a herdr config template, the shell layer in `~/.zshrc` (launch aliases, the herdr wrapper, the splash) and, when Hammerspoon is installed, system-wide LifeOS hotkeys. LifeOS runs in any terminal; Helm is how it looks and works in the reference install, with live session state in the herdr sidebar and the kitty tabs.

## Fill in

Nothing under `LIFEOS/USER/` is required. Three files outside LifeOS are yours after the installer creates them:

| File | Created by | What you might change |
|---|---|---|
| `~/.config/herdr/config.toml` | copied from `LIFEOS/DOCUMENTATION/Terminal/herdr/config.toml` when absent | Key chords (change the matching passthrough map in `kitty.conf` too), sidebar width, colours |
| `~/.zshrc` | one guarded `source` line for `Terminal/zsh/lifeos.zsh` | Define your own alias or function before that line to override one |
| `~/.hammerspoon/init.lua` | one `pcall(require, "lifeos")` line | `LIFEOS_LAUNCH = "k"` before the require changes what a new session types |

To install or repair by hand:

```bash
bash ~/.claude/LIFEOS/DOCUMENTATION/Terminal/install.sh
```

Install herdr yourself from https://herdr.dev (0.9 or newer), then run the script again so it links the herdr plugin. For the hotkeys, `brew install --cask hammerspoon`, grant it Accessibility, then run the script again.

## Accounts and secrets

No account and no secret. The shell layer never sources `~/.claude/.env`; keep secrets out of your rc file, because anything sourced there reaches every process the shell starts.

## Prove it works

```bash
helm doctor
```

Every line reads `✓` or `note:`; a `✗` line names the missing piece and the fix. Then open `Helm.app`, run `herdr`, and press `cmd+t`: a new herdr session opens, and its sidebar row fills in with the session name once LifeOS starts in it.
