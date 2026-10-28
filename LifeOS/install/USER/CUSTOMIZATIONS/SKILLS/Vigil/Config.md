---
provenance: template
version: 1.0.0
policy: LIFEOS/USER/VIGIL/policy.json
editor_profile: LIFEOS/USER/VIGIL/editor-profile.md
worker: LIFEOS/USER/VIGIL/worker.json
---

# Vigil — User Config

Vigil's install-specific values already have a canonical home, `LIFEOS/USER/VIGIL/`, which the engine (`LIFEOS/VIGIL/Policy.ts`) reads at run time. This file only points there, so nothing is kept twice. Paths resolve under your config root (`$CLAUDE_CONFIG_DIR` when set, else `~/.claude`).

| Key | Meaning | Default when the file is missing |
|---|---|---|
| `policy` | Routing policy: severity routes, `decider_mode`, the 24-hour text ceiling, per-source ceilings, caps and cadences, text-trusted sources such as `example-service` | The defaults in `LIFEOS/VIGIL/Policy.ts`, key by key |
| `editor_profile` | What the optional model editor knows about you, for example "Alex Example runs ExampleNet and wants texts only for outages" | Unused while `editor_enabled` is `false` |
| `worker` | The D1 database the optional store Worker binds to, for example `{ "d1": { "id": "<database id>" } }` | Unused; Vigil works from the local outbox |

Edit the files these keys name, never this pointer. `skills/Vigil/Setup.md` § Fill in documents every key inside them.
