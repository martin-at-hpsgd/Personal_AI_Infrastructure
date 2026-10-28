---
version: 1.0.1
---

# Voice

Status: `bun LIFEOS/TOOLS/Doctor.ts` (the `voice` row) · optional

## What it does

Your DA can speak its notifications and spoken closers through the Pulse voice server. Fish Audio is the one voice engine: a voice speaks when it has a Fish model.

Voice is optional. With no voice key the install is complete and quiet: notifications show on screen, no turn reports a voice error, and Doctor shows voice as `off`.

## Fill in

| Where | What |
|---|---|
| `~/.claude/.env` | `FISH_API_KEY`, from fish.audio (API keys page). |
| `CONFIG/LIFEOS_CONFIG.toml` `[da.voices.main]` | `fish_reference_id`: the Fish voice model id (the id in the voice's fish.audio URL). `fish_speed` (0.5–2.0) is optional. `voice_id` is an optional marker Fish resolvers use to recognize the voice. |

A config with `fish_reference_id` and no `voice_id` is valid:

```toml
[da.voices.main]
fish_reference_id = "your-fish-model-id"
voice_name = "Main"
```

## Accounts and secrets

Voice needs a Fish Audio account. Store a key without pasting it into a chat or a file by hand. This reads the value with echo off, writes `.env` at mode 0600 and reseals:

```bash
bun LIFEOS/TOOLS/Secrets.ts set FISH_API_KEY
bun LIFEOS/TOOLS/Secrets.ts has FISH_API_KEY   # "FISH_API_KEY yes"; an empty value reads "no"
```

Voice ids are not secrets and live in `LIFEOS_CONFIG.toml`. A clone of your own voice keeps its id in `.env` (`FISH_PRINCIPAL_VOICE_ID`), never under `USER/`.

## Prove it works

```bash
bun LIFEOS/TOOLS/Doctor.ts             # voice: live with a key, off without one
bun LIFEOS/TOOLS/Doctor.ts --network   # one short Fish synthesis on the notification path
curl -s localhost:31337/voice/health   # voice_system: "Fish" or "off"
```

To silence voice for good without a key, `bun LIFEOS/TOOLS/Doctor.ts decline voice`.
