---
provenance: template
---

# Bunker — application harness data

The Pulse `/bunker` page reads what the Bunker monitor writes here. A fresh
install has no apps registered, so the page shows no bays.

## Layout

```
PULSE/Bunker/
├── snapshot.json        # full health snapshot, written every 15 minutes by the monitor
├── monitor-state.json   # the monitor's own bookkeeping
├── shots/               # screenshots of each app, captured locally
└── codesweep/<app>/     # white-box security sweep state per app
```

None of these are hand-written. They appear once the launchd monitor
(`com.lifeos.bunkermonitor`) has completed a sweep.

## Registering an app

Bunker discovers apps from a `bunker.config.ts` at the root of each project.
It names the app, its type and
platform, and the path to its ISA (for example `name: "my-app"`,
`type: "web-static"`, `isa: "./ISA.md"`). The Bunker docs in
`~/.claude/LIFEOS/DOCUMENTATION/Bunker/BunkerSystem.md` list every field.

## Privacy

The snapshot names your apps, domains and their security findings. It stays
in your private USER tree and never ships in a release.
