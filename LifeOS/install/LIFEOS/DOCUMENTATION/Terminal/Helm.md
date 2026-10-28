---
version: 1.7.1
---

# Helm — the LifeOS Terminal (Optional)

## Overview

**This entire page is optional.** LifeOS runs in any terminal. But if you want the reference setup — the exact terminal LifeOS was built in — it has a name: **Helm**, a configuration layer on kitty (not a fork; upstream kitty installs via brew, unmodified) with [herdr](https://herdr.dev) running inside it as the workspace layer.

The split is simple. Herdr owns sessions, tabs, panes and agent state. Kitty supplies the window, the Tokyo Night Storm theme, the fonts, the keyboard protocol that carries `cmd` chords to herdr, and the remote-control socket that lets LifeOS hooks paint live session state.

Since 1.6.0 Helm no longer carries a mux of its own. Helm Deck, kitty session files, the left-sidebar tab bar, split-left and split-up, and pane title bars were removed, because herdr does each of those jobs. What is left of kitty's tabs and splits is the plain fallback for a window where herdr is not running.

Helm ships inside LifeOS. There is nothing to clone and nothing else to track: the whole thing lives next to this page.

```
LIFEOS/DOCUMENTATION/Terminal/
├── install.sh                      # one-command install (kitty, config link, Helm.app, helm on PATH, herdr config, shell layer, Hammerspoon)
├── bin/helm                        # the `helm` command — doctor, update
├── assets/helm.icns                # Helm.app icon, built from helm.svg (16 and 32px are hand-placed: helm-16.svg, helm-32.svg)
├── herdr/config.toml               # herdr config template — key mirror, sidebar rows, state colours (copied once, then yours)
├── herdr/select-above/             # herdr plugin — closing a session focuses the one above (bun)
├── zsh/lifeos.zsh                  # shell layer — LifeOS aliases, the herdr wrapper, ha, the splash (sourced from ~/.zshrc)
├── hammerspoon/lifeos.lua          # optional macOS hotkeys — new session, voice mute, voice mode
└── kitty/
    ├── kitty.conf                  # main config — theme, fonts, herdr passthrough maps, socket
    ├── TabBar.ts                   # hides the kitty tab bar while herdr runs, shows it after (bun)
    ├── tab_bar.py                  # top tab bar for non-herdr windows — tabs share the width evenly
    ├── tokyo-night-storm.conf      # standalone theme file
    ├── cairn_clear_watcher.py      # clears the green "done" tab stamp on view
    └── splash.zsh                  # branded boot card (source from ~/.zshrc)
```

## Install

**Preferred** — one command. Installs kitty and a Nerd Font if they're missing, moves an existing `~/.config/kitty` *directory* aside with a timestamped backup (if it's already a symlink, only the link is repointed and it tells you where it used to point), links the terminal config in, builds a `Helm.app` wrapper for Spotlight and the Dock, and puts `helm` on your PATH:

```bash
bash ~/.claude/LIFEOS/DOCUMENTATION/Terminal/install.sh
```

Because the installer *links* rather than copies, updating LifeOS updates Helm — no separate update step. Run `helm doctor` any time to check the install. The installer is macOS-first: on Linux it expects you to have installed kitty yourself, then does everything else.

The LifeOS installer runs this script for you as its `helm` component, part of the default install; run it by hand only to repair or re-link.

Beyond the kitty layer, the script sets up the rest of the reference experience:

| Piece | What the script does | Yours to edit? |
|---|---|---|
| herdr config | Copies `herdr/config.toml` to `~/.config/herdr/config.toml` only when you have none. An existing config is never touched. | Yes, it is a copy |
| Shell layer | Adds one guarded `source` line for `zsh/lifeos.zsh` to `~/.zshrc`: the `lifeos`/`k`/`kr` launchers, `kd`/`km`/`ku` jumps, the `herdr` wrapper, `h`, `ha`, and the splash. It never overrides an alias or function you defined before that line. | Define your own first to keep it |
| Hammerspoon | When Hammerspoon is installed, links `hammerspoon/lifeos.lua` into `~/.hammerspoon/` and adds `pcall(require, "lifeos")` to `init.lua`. Without Hammerspoon it prints the one-line install. | Put your own hotkeys in `init.lua` |

The installer does not install herdr. Get it from [herdr.dev](https://herdr.dev) (0.9 or newer; the key passthrough needs 0.8, the select-above plugin 0.9.0) and run it as an unmodified binary. When herdr is already installed, the installer links the select-above plugin; if you install herdr afterwards, run the installer again. `helm doctor` reports herdr, the plugin, the herdr config, the shell layer and the Hammerspoon link.

**Manual**, if you'd rather not run a script:

```bash
# 1. Kitty + a Nerd Font.  macOS:
brew install --cask kitty font-hack-nerd-font
#    Linux: install kitty from your package manager or https://sw.kovidgoyal.net/kitty/
#    and install any Nerd Font (https://www.nerdfonts.com) for the icons.

# 2. Copy the config set into place (this overwrites — back up ~/.config/kitty first)
mkdir -p ~/.config/kitty
cp -R ~/.claude/LIFEOS/DOCUMENTATION/Terminal/kitty/ ~/.config/kitty/

# 3. Launch kitty (or reload with shift+cmd+r inside it)
```

The manual path gives you the same terminal, minus the `Helm.app` wrapper and the `helm` command. Note that the config's helper scripts reference `~/.config/kitty` by absolute path, so install there rather than at a custom `XDG_CONFIG_HOME`.

## Herdr inside Helm

[Herdr](https://herdr.dev) is a terminal workspace manager for coding agents: its own sidebar of sessions, agent-state detection, a persistent server. It is where sessions run: open kitty, run `herdr`, and work from there. Bare `herdr` launches the TUI or attaches to the server that is already running.

**Herdr is the window onto everything running (2026-10-04).** Its job in LifeOS is to show, without being asked, the live state of whatever work is in flight: a session, a workflow run, an ISA climb, a skill fanning out agents, a delegate. It is a view, never a capability. Thinking stays in the skills and agents that already do it (Council, RedTeam, the second-opinion lanes); herdr only makes their progress visible, and the panes are where the principal can step in. So the rule for any new long-running work is that it reports its state into the sidebar through the shared token path (`report-metadata`, one writer per token, below), and the sidebar shows it without knowing what kind of work it is. Visibility comes with the work, never as a per-skill feature added afterwards. Driving herdr by hand (scripting panes, chaining toasts, babysitting output) is the anti-pattern this rule exists to prevent; the agent that needs those mechanics uses them itself.

Kitty and herdr would both claim the same keys, so kitty hands them over. Two pieces make that work:

- **Passthrough maps.** Every chord herdr uses is declared in `kitty.conf` with `--when-focus-on "not var:in_herdr=1"`. While the focused kitty window carries the user var `in_herdr=1`, kitty skips its own mapping and the key reaches herdr, whose `~/.config/herdr/config.toml` binds it. Outside a herdr window the same chord runs the plain kitty action. Each passthrough chord is also declared once with an empty action (`map cmd+n`) *above* its conditional map. kitty keeps its built-in default for a key alongside a conditional map, and that default always matches, so without the empty map `cmd+n` inside herdr opens a kitty OS window (and `cmd+t`, `cmd+w`, `cmd+k`, `cmd+h` run their kitty defaults) instead of reaching herdr. The empty map is the last match inside herdr and passes the key through.

- **The `herdr` shell wrapper** (a zsh function in the shell layer, `zsh/lifeos.zsh`). When it launches a herdr client inside kitty it sets the user var on that window, hides the kitty tab bar (`TabBar.ts hide-on`), runs the real binary, then clears the var and calls `hide-off` on exit. Both calls pass the shell's pid, so with two herdr clients in one kitty instance the bar comes back only when the last one exits, and a bar you hid yourself with `ctrl+cmd+b` stays hidden. Herdr's sidebar is the session list while it runs. Subcommands like `herdr status` are not wrapped.

```zsh
herdr() {
  local ui=0
  case "$1" in
    "") ui=1 ;;
    --session|--remote|--no-session|--handoff) ui=1 ;;
    session) [[ "$2" == attach ]] && ui=1 ;;
  esac
  if (( ui )) && [[ -n "$KITTY_WINDOW_ID" ]] && command -v kitten >/dev/null; then
    local hid=0
    kitten @ set-user-vars --match "id:$KITTY_WINDOW_ID" in_herdr=1 2>/dev/null
    bun ~/.config/kitty/TabBar.ts hide-on $$ >/dev/null 2>&1 && hid=1
    command herdr "$@"; local rc=$?
    kitten @ set-user-vars --match "id:$KITTY_WINDOW_ID" in_herdr= 2>/dev/null
    (( hid )) && bun ~/.config/kitty/TabBar.ts hide-off $$ >/dev/null 2>&1
    return $rc
  fi
  command herdr "$@"
}
```

The herdr side is `herdr/config.toml`, which the installer copies into place: a `[keys]` table matching the chords below (`prefix` stays `ctrl+b`; `prefix+b` toggles herdr's sidebar), `[ui] prompt_new_tab_name = false` so `cmd+n` opens a tab immediately, and the sidebar rows and colours for the tokens LifeOS hooks report. Change a chord there and change its passthrough map in `kitty.conf` too. Needs a herdr that speaks the kitty keyboard protocol (0.8+); `cmd` chords only reach a terminal program through it.

**Sidebar names.** Herdr labels a workspace after the directory it opened in, so sessions launched from home all read `~`. The tab painter has a herdr backend (`hooks/lib/herdr-tabs.ts`): while `HERDR_ENV=1`, every title LifeOS would have put on a kitty tab goes to herdr instead, through `herdr tab rename` and `herdr workspace rename`. Herdr's agents list renders `{workspace} · {tab}`, so the title is split at the pipe: the workspace (the spaces row) takes `{glyph} {SESSION LABEL}` and the herdr tab takes the description. The spaces row is the one surface that shows more than the shared three-word label: up to five words of the session name over up to two lines (2026-09-18). A herdr row never wraps, so `spaceLabelLines` puts the first line on the workspace name and the second on a line-two workspace token, breaking where the two lines come out most even. A herdr style rule can only see the token it styles and line two has no glyph, so `lineTwoTokens` reports line two under the token named for the glyph on line one (`$name2_climb`, `$name2_cairn`, and so on; plain `$name2` when there is no known glyph) and clears the rest; `config.toml` gives each the same colour its glyph gives line one, so both lines of a title match. Spaces rows keep one blank row between them (`row_gap = 1`); herdr only offers whole rows, and zero read too cramped under two-line titles. The kitty tab, the status line and Pulse keep three words. Only a pane in the workspace's first tab names the workspace; a second session in the same workspace keeps the whole title on its own tab and never renames the row. The hidden kitty tab is left alone. Details: `../Pulse/TerminalTabs.md` § Terminal Compatibility.

**What each row says.** The two panes answer different questions, and neither may carry a fact that reads the same on every row — which is what both did until 2026-09-20, when the agents pane said `<DA> opus medium` eleven times and the spaces pane said `main up 25` eleven times. Spaces rows are the WORK: the session name over its two lines, the ISA's criterion progress, and `$project`, the codebase the session is in, cleared for a session sitting in LifeOS or at home so the row gives the space back. Herdr's built-in `branch` and `git_status` tokens are deliberately absent — every session here runs in one repo, so they said nothing about the work. Agents rows are the WORKER: herdr's display agent names the carrier family (`Opus`) while the session works alone, and the running delegates (read back from the plugin's `$agents` token) while any are running; `$model` beside it carries the effort alone so the two never print the same word, and `$workers` names the codex legs sent down with Worker.ts, each with the lane it runs on (`→ Astra · Sol ×2`). Claude Code's own agent panel shows subagents, so the agents rows carry no `$agents` line since 2026-10-11. That lane spelling comes from `agentLaneTag` in `hooks/lib/route-label.ts`, the same function the band's roster uses, so a delegate reads identically in both places and an OpenAI worker is visible wherever it is named. The statusline writes the display agent, `$model` and `$ctx`; `PromptProcessing.hook.ts` and `TabState.hook.ts` write `$since` and `$open` at turn start and end, `PreToolGuard.hook.ts` writes `$doing`, and `CodexProgress.ts` writes `$workers`; the tab painter writes the spaces tokens. One writer per token, always.

**Sidebar width.** Herdr has no key or mouse gesture that resizes the sidebar (checked against the 0.9.0 config reference); `prefix+b` only collapses and expands it. The width is `[ui] sidebar_width` and `sidebar_max_width` in `config.toml`, applied with `herdr server reload-config`, which restarts no panes. The sidebar starts at `sidebar_width` and grows to fit workspace names up to `sidebar_max_width`. Herdr's defaults are 26 and 36; a wider pair such as 33 and 48 gives two-line session titles room, and the arithmetic below uses 33. Agent rows clip at the sidebar edge, so they use a wider sidebar on their own. Spaces rows do not: `spaceLabelLines` breaks each title line at `SPACE_LINE_MAX` in `hooks/lib/herdr-tabs.ts`, which `hooks/lib/fit-name.ts` (`herdrSidebarCols`) reads from `sidebar_width` in `config.toml` minus the six columns the state icon and padding take (27 for a width of 33). Changing `sidebar_width` moves the break with it; `sidebar_max_width` does not.

**Closing a session selects the one above.** Herdr focuses the session below when the focused one closes, and has no setting to change that (0.9.0 config reference). The local plugin `herdr/select-above/` hooks `workspace.closed` and focuses the session that sat directly above; closing the top session, or one that was not focused, leaves herdr's choice alone. It covers `cmd+shift+w`, the sidebar and the CLI alike (confirmed on a real close, 2026-10-01). The close event carries the session's position and focus as they stood before the close, which is all the hook needs. `install.sh` links the plugin; by hand it is `herdr plugin link <path to herdr/select-above>`. The hook runs `bun` from the herdr server's PATH.

**Clicking links.** Herdr holds the mouse grab in every pane, and kitty's default plain-click link opener only fires when nothing has grabbed the mouse, so inside herdr a plain click on a URL did nothing (herdr's own opener is ctrl+click only). `kitty.conf` carries `mouse_map left click grabbed mouse_handle_click link`, which opens the link on a plain click while grabbed. The click still reaches herdr, so pane focus and the sidebar keep working. Cmd, shift and ctrl+shift click open links grabbed or not. If your `~/.config/kitty` is a copy rather than the installer's link, add that line and reload with shift+cmd+r.

## Keyboard shortcuts

One set of chords. Inside herdr they act on herdr; in a kitty window without herdr they run the kitty action in the last column.

### Sessions (herdr workspaces)

| Keys | Inside herdr | Outside herdr |
|------|--------------|---------------|
| `cmd+t` | New workspace | New kitty tab |
| `cmd+shift+w` | Close workspace | Close kitty OS window |
| `ctrl+h` / `ctrl+l` | Previous / next workspace | Previous / next kitty tab |
| `prefix+shift+w` | Rename workspace | — |
| `cmd+k` or `prefix+g` | Goto picker: jump to any workspace, tab or agent | `cmd+k` focuses the pane above |

### Tabs

| Keys | Inside herdr | Outside herdr |
|------|--------------|---------------|
| `cmd+n` | New herdr tab | New kitty OS window |
| `cmd+w` | Close herdr tab | Close kitty tab |
| `cmd+shift+[` / `cmd+shift+]` | Previous / next herdr tab (`ctrl+k` is also previous) | Previous / next kitty tab |
| `ctrl+shift+h` / `ctrl+shift+l` | Move tab left / right | Move kitty tab left / right |

`ctrl+j` stays unbound in herdr because dictation tools commonly claim it system-wide.

### Panes

| Keys | Inside herdr | Outside herdr |
|------|--------------|---------------|
| `cmd+shift+l` / `cmd+shift+j` | Split right / down | Kitty split right / down |
| `cmd+h` / `cmd+j` / `cmd+l` | Focus left / down / right | Focus the neighboring kitty pane |
| `prefix+k` | Focus up (`cmd+k` is the goto picker) | — |
| `ctrl+cmd+h/j/k/l` | Resize the focused pane | Resize the focused kitty pane |

### Kitty-level

These never pass through to herdr.

| Keys | Action |
|------|--------|
| `shift+cmd+r` | Reload kitty config |
| `ctrl+cmd+b` | Hide / show the kitty tab bar |
| `cmd+shift+n` | New kitty tab running your DA launch alias (`k` by default — edit to match yours) |
| `ctrl+t` | Next kitty tab |
| `shift+enter` | Literal newline (multi-line prompts) |
| `ctrl+enter` | Accept zsh autosuggestion |

## The kitty tab bar

A window where herdr is not running shows a top tab strip (`tab_bar_edge top`, `tab_bar_style custom`). `tab_bar.py` makes the tabs share the full window width evenly: few tabs get long titles, many tabs shrink, recomputed on every redraw. With LifeOS tab-title hooks active (see [Terminal Tab State](../Pulse/TerminalTabs.md)) those tabs carry live session state.

`TabBar.ts` hides and shows the bar over kitty's remote-control socket, with no config edit and no reload. It has four commands: `hide` (the `ctrl+cmd+b` toggle), `hide-on <pid>` and `hide-off <pid>` (the pair the herdr wrapper calls, which track the running herdr clients by shell pid and drop any whose shell has died), and `reset`. State persists per kitty instance in `~/.cache/kitty-tabbar-state-<KITTY_PID>.json`. It needs [bun](https://bun.sh).

Two kitty 0.48.2 quirks shape it. A bare `load-config` kills the bar, so every apply carries an explicit `tab_bar_edge` override. Setting `tab_title_max_length` in the conf breaks bar rendering on reload, so leave it out.

## Splash — the boot card

`splash.zsh` prints a Helm wordmark card once per kitty instance (sentinel on `KITTY_PID`): interactive shells only, zero subprocesses, so splits, tabs, scp, rsync, and CI shells print nothing. The shell layer sources it; without the shell layer, wire it with one line in `~/.zshrc`:

```zsh
[[ -f ~/.config/kitty/splash.zsh ]] && source ~/.config/kitty/splash.zsh
```

## Shell layer

`zsh/lifeos.zsh` is the LifeOS part of a shell rc file, kept in one sourced file so a LifeOS update reaches it. It sets `LIFEOS_DIR`, the launch aliases (`lifeos`, short `k`, `kr` to resume), jumps into the tree (`kd`, `km` for MEMORY, `ku` for USER), the `herdr` wrapper and `h`, `ha` to attach a herdr session safely from any window, and the splash. Every alias and function is guarded, so one you defined before the source line wins.

It deliberately does not load secrets. Sourcing `~/.claude/.env` from an rc file exports every key to every process the shell starts, including each agent and its subprocesses; LifeOS tools load the keys they need themselves (`LIFEOS/TOOLS/Secrets.ts`).

## Hammerspoon

[Hammerspoon](https://www.hammerspoon.org) is recommended on macOS: it gives LifeOS system-wide hotkeys no terminal can. Install it with `brew install --cask hammerspoon`, grant it Accessibility (System Settings → Privacy & Security), then run the Helm installer, which links `hammerspoon/lifeos.lua` and adds `pcall(require, "lifeos")` to your `init.lua`.

| Hotkey | What it does |
|---|---|
| `cmd+shift+k` | New LifeOS session: brings Helm forward, `cmd+t` (a herdr session when herdr has focus), types the launch command |
| `cmd+ctrl+k` | The same, then starts dictation when the [Dictation](../Dictation/DictationSystem.md) module is loaded |
| `f18` | The same as `cmd+ctrl+k`, for a foot pedal or macro key that sends F18 |
| `cmd+shift+m` | Mute or unmute the DA's voice through Pulse (`/voice/mute`), for calls and recordings |
| `cmd+shift+v` | Toggle [voice mode](../VoiceMode/VoiceMode.md) in the focused session (only while kitty is frontmost) |

Set `LIFEOS_LAUNCH = "k"` (or any command) in `init.lua` before the require to change what a new session types. The Dictation setup adds its own module (Right Ctrl+J) the same way; see [Setup/Dictation.md](../Setup/Dictation.md).

## LifeOS integration

Two lines in `kitty.conf` wire the terminal into LifeOS:

- `allow_remote_control socket-only` + `listen_on unix:/tmp/kitty` — LifeOS hooks use the socket to set tab titles and colors as runs progress (working, waiting, done), and `TabBar.ts` uses it to hide the bar. Socket-only means only processes on your machine with access to the socket can drive kitty; nothing listens on the network.
- `watcher ~/.config/kitty/cairn_clear_watcher.py` — when a run completes, hooks paint the tab green; the watcher clears that "unread" stamp the first time you focus the tab.

Both degrade gracefully: without LifeOS running, they do nothing. Inside herdr the same state goes to herdr's sidebar instead (see Sidebar names above).

## Theme

Tokyo Night Storm, with a custom blue active-tab (`#1244B3`) and purple selection. The palette is inline in `kitty.conf`; `tokyo-night-storm.conf` is the standalone copy if you want to `include` it in your own config instead. An optional background image line is commented out — point it at your own image if you want one.

## Upgrading from a Helm with Deck

If your `~/.config/kitty` is a copy rather than the installer's link, it still has the old pieces. Delete `deck.conf`, `deck/`, `sessions/` and `tab_refit_watcher.py`, and replace `kitty.conf`, `TabBar.ts` and `tab_bar.py` with the current files. Projects you kept as kitty session files become herdr workspaces.
