---
provenance: template
version: 1.0.0
---

# ComputerUse — Config

Configure Astra's computer-use constraints. The real file never ships in a release; this template shows the shape. Copy to `LIFEOS/USER/CUSTOMIZATIONS/SKILLS/ComputerUse/Config.md` and edit. Lists are comma-separated.

```
# Apps that must not be RUNNING at all during an Astra run (credential stores).
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

# Seconds Astra has to bring the target app to the front before the run aborts.
grace_seconds: 20
```
