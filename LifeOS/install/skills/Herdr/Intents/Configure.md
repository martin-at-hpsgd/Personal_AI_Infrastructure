# Configure

Explain or change how herdr behaves on this machine.

## Ideal State

- A config question is answered from the live files: the answer cites the live file that causes the behavior.
- A change lands in the file that owns it; a change to the key mirror touches the terminal layer, the herdr layer and Helm.md § Herdr inside Helm together, so they do not drift.
- The running server has picked up the change, and the behavior is confirmed in a real herdr pane: a keybinding pressed in a herdr pane, or the principal's confirmation.
- `Tools/Freshness.ts` still reports `config_keys` fresh after the change.

## Anti-criteria

- `herdr config reset-keys` is never run without an explicit yes; it would erase the Helm key mirror.
- The configured `prefix` and the Helm key mirror (this install's values: `ThisInstall.md` in the skill's customization directory) are not changed unless the principal asks to change them.
- `hooks/herdr-agent-state.sh` (not in the public release) is never hand-edited; it is reinstalled with `herdr integration install`.
- A keybinding is never called verified because the file read back changed; reading the file back proves only that the file changed.

## Inputs

A key or UI behavior inside herdr is decided by up to four layers, from where the key enters to where it is handled:

| Layer | File | Owns |
|-------|------|------|
| Terminal | `LIFEOS/DOCUMENTATION/Terminal/kitty/kitty.conf` | Whether the key reaches herdr at all (the `in_herdr` conditional maps and the empty maps above them) |
| Wrapper | the `herdr` function in the shell rc file | Setting and clearing `in_herdr`, hiding the Helm tab bar |
| Herdr | `~/.config/herdr/config.toml` | What herdr does with the key; theme, sidebar, toasts, sound |
| Hooks | `hooks/lib/herdr-tabs.ts`, `hooks/herdr-agent-state.sh` (not in the public release) | Tab and workspace names, the sidebar tokens (`isa`, `phase`, `model`, `ctx`, `doing`, `session`), agent state |

`LIFEOS/DOCUMENTATION/Terminal/Helm.md` § Herdr inside Helm explains why each layer exists. `hooks/herdr-agent-state.sh` (not in the public release) is installed and versioned by herdr.

## Tool contract

- `herdr --default-config` lists every key this binary accepts, with defaults, as comments. It is the authority on key names.
- The config reference JSON from the docs index gives types, allowed values and prose per key.
- `herdr server reload-config` applies the server's `config.toml` without restarting it. Theme, sidebar layout and other presentation keys come from the client's own config, so they reach the screen only when the client reloads (`reload_config`, default `prefix+shift+r`) or reattaches. Before editing presentation keys, find the client whose screen you are changing: a `herdr remote-client-bridge` process under an `sshd-session` means the client runs on another machine, and the edit belongs in that machine's `config.toml`.
- `herdr config reset-keys` backs up the config and removes every custom keybinding, the Helm key mirror included.
- `herdr integration status|install|uninstall` manages the agent-state hooks. Installing one writes into that agent's own config directory.
- Sidebar state colours are theme tokens: `red` is blocked, `yellow` is working, `teal` is done-unseen. This mapping is unverified, so confirm it by eye after applying a theme change. The `goto` action (default `prefix+g`) is the jump-to-any-workspace-tab-or-agent picker.
