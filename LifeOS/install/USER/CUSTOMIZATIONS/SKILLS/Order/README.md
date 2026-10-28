---
provenance: template
version: 1.0.0
---

# Order templates

- `Config.md`: copy to `LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Order/Config.md` and replace the example values with your own: home address id, default card, per-order ceiling, food preferences file and intent template.

The DoorDash token is never stored in these files. `dd-cli login` writes it to the macOS Keychain. Optionally set `BROWSER` to a capture script so the sign-in link does not open your own browser.
