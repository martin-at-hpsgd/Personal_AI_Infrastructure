---
provenance: template
---

# Conduit — local activity capture

The Pulse `/conduit` page reads the files the Conduit capture job writes
here. A fresh install shows zero tracked minutes until the job has run.

## Layout

```
CONDUIT/
├── config.json       # created on first run with safe defaults
├── events/           # raw spans per day, pruned after retentionDays
├── daily/            # one rolled-up record per day
└── insights/         # the hourly content-type read, one file per day
```

## Setup

```sh
bun ~/.claude/LIFEOS/PULSE/Conduit/InstallConduit.ts          # the capture poll (launchd)
bun ~/.claude/LIFEOS/PULSE/Conduit/InstallConduitInsight.ts   # optional hourly insight
```

## config.json

```json
{
  "enabled": true,
  "pollIntervalSec": 120,
  "sources": { "appFocus": true, "git": true, "claudeSession": true, "github": false },
  "repos": ["~/Projects/<your-repo>"],
  "githubUser": "<your-github-login>",
  "retentionDays": 30
}
```

Every field is optional; a missing or malformed value falls back to the
default above. Capture stores time spans and metadata, never keystrokes or
content.

## Privacy

This is a record of what you did on your computer and when. It stays
local and never ships in a release.
