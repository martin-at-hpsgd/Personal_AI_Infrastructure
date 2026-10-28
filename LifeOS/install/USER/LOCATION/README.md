---
provenance: template
version: 1.0.0
---

# LOCATION — where you are, from your phone

This folder holds the settings for LifeOS's one answer to "where is the principal right now". The setup guide is `LIFEOS/DOCUMENTATION/Setup/Location.md`; the design is `LIFEOS/DOCUMENTATION/Location/LocationSystem.md`.

- `config.json`: the only file you write. Your Worker's `url` (once you have deployed it), your `home` point, and the two tuning numbers. The template ships a placeholder home at latitude 0, longitude 0; replace it before your first sync.
- `current.json`: written by `bun LIFEOS/LOCATION/Location.ts sync`. The newest fix, mode 0600. Do not edit it and do not commit it.
- `state.json`: written by the sync. Jump and timezone guards. Do not edit it.

Nothing here holds a bearer token. The read token lives in your login Keychain; the phone token lives only in the Overland app and, hashed, in the Worker's database.
