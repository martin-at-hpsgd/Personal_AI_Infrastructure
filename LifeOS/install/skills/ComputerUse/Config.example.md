# ComputerUse — Config (example)

Copy to `LIFEOS/USER/CUSTOMIZATIONS/SKILLS/ComputerUse/Config.md` and edit. Lists are comma-separated. The real file never ships in a release.

```
# Apps that must not be running at all during a vision run (credential stores).
deny_running: PasswordManager, Keychain Access

# Apps that must not be running-and-visible (communications). Hidden (Cmd+H) is fine.
deny_visible: Messages, Mail, ChatApp, TeamChat, Terminal

# Browser tab hosts that block the run (suffix match on the hostname).
deny_domains: bank.example, brokerage.example

# Caps, enforced by the runner, not by the model.
step_cap: 60
wall_clock_seconds: 600
poll_ms: 1000

# Optional: Shortcut names that turn a Focus on before the run and off after.
focus_on_shortcut: CU Focus On
focus_off_shortcut: CU Focus Off

# Read by the runner; the watcher does not wait on it. The frontmost rule binds only once the
# target has been front, and a target that never comes front does not abort the run.
grace_seconds: 20
```
