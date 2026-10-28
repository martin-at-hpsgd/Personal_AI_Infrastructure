---
provenance: template
version: 1.2.0
---

# RELAY — the text bridge to your own phone

Relay answers your iMessages with the real DA and texts you when something needs you now. It is optional. If you do not want to text your DA, skip this whole page: nothing else in LifeOS needs Relay, and the bridge stays off until you install its service.

Two things live here:

- `ISA.md`: the design of record for the bridge, in ideal-state form. Read it to understand what the bridge does and refuses to do.
- `state/`: the bridge's runtime files. `state/README.md` lists each file. The directory is 0700 and every file in it is 0600.

The bridge code is in `LIFEOS/RELAY/bridge/`. Every command below uses only files that ship with LifeOS.

## What you need

- A Mac that stays on, with iMessage signed in.
- An account with Photon, the iMessage provider behind the bridge's `spectrum-ts` SDK. Sign up at https://photon.codes/spectrum, open a project, and connect the iMessage line you will text.
- A phone that sends iMessage from your own number.

## Set it up

### 1. Add the provider secrets

Add these to `~/.claude/.env`:

- `PHOTON_PROJECT_ID`: the project id from the Photon dashboard. Required; the bridge will not start without it.
- `PHOTON_PROJECT_SECRET`: the project secret from the same page. Required.
- `NTFY_TOPIC`: optional, and unused unless you turn on tap approval (`approve` below).

Run one bridge per provider project. A second bridge on the same project is refused at start.

### 2. Write the bridge config

Create `state/` at mode 0700 and `state/bridge-config.json` at mode 0600. `state/bridge-config.example.json` is a placeholder copy with every optional key; copy it to `bridge-config.json` and replace the made-up values. Nothing reads the example. The smallest working config:

```json
{
  "allowFrom": ["+15555550100"],
  "ownChannels": { "numbers": ["+15555550100"], "emails": [], "discordUserIds": [] }
}
```

| Field | Required | Meaning |
|-------|----------|---------|
| `allowFrom` | yes | Senders the bridge admits, E.164 phone numbers. At least one. Everyone else is dropped before any model runs. |
| `ownChannels.numbers` | yes | Your own line, exactly one number. Sends to you go here. It never falls back to `allowFrom`, which lists who may text in, not whose line this is. |
| `ownChannels.emails` | no | iMessage email handles that are also you. |
| `ownChannels.discordUserIds` | no | Discord user ids that are also you. |
| `countersignSalt`, `countersignSha256` | yes | Written by `Countersign.ts set` in step 3. Never edit them by hand. |
| `chatFrom` | no | Senders, E.164, who may hold a text conversation with the DA but never unlock the line or authorize any action. Default `[]`. These are other people, so answering them must be billed to a metered API key (for example `ANTHROPIC_API_KEY`), never to your personal subscription. The contact chat calls `LIFEOS/TOOLS/Inference.ts`; check which vendor and billing that resolves to before you list anyone here. |
| `prodProjectId` | no | The provider project id your production bridge runs on. When `PHOTON_PROJECT_ID` equals it and the Hermes sidecar's iMessage plugin is enabled, the bridge refuses to start, so two bridges never share one line. |
| `approve` | no | Tap approval through an ntfy server, off by default: `enabled` (default `false`), `server` (default `ntfy.sh`), `approveTopic`, `waitMs` (default 240000), `pollMs` (default 3000). A topic name is not authentication. Point `server` at an ntfy instance you host or one with access control, and protect the topic, before you turn it on. |
| `contactChannels` | no | Written by the bridge at each start from your People contacts, so the texting guard can tell contacts from strangers. Never edit it by hand. |
| `unlockIdleMs` | no | How long an unlocked line stays open without activity. Default 7200000 (two hours). |
| `challengeTtlMs` | no | How long a held action waits for the countersign. Default 900000 (15 minutes). |
| `confirmTtlMs` | no | How long a destructive action waits for your yes. Default 600000 (10 minutes). |
| `replyTimeoutMs` | no | How long one texted task may run before it is stopped. Default 900000 (15 minutes); the bridge refuses less than 600000. |
| `interimAfterMs` | no | How long a task runs before you get a progress line. Default 120000 (two minutes). |

### 3. Set the countersign

The countersign is the phrase you text to unlock writes. Write it into a file only you can read, and feed that file on stdin so it never lands in shell history or a command line. This adds `countersignSalt` and `countersignSha256` to `bridge-config.json`:

```bash
bun ~/.claude/LIFEOS/RELAY/bridge/Countersign.ts set < ~/countersign.txt
```

Delete the phrase file afterwards. `Countersign.ts check` with the same stdin form exits 0 when a phrase matches.

### 4. Install the service

This installs the bridge as the launchd service `com.lifeos.relay`. It is safe to repeat:

```bash
bun ~/.claude/LIFEOS/RELAY/bridge/Install.ts
```

`Install.ts --uninstall` removes the service. The bridge creates every other file under `state/` itself.

## Prove it works

```bash
bun ~/.claude/LIFEOS/RELAY/bridge/Install.ts --status
```

Success prints the launchd record for `com.lifeos.relay` with `state = running` and exits 0. `com.lifeos.relay not loaded` with exit 1 means step 4 has not run. Then text your DA from the number in `ownChannels.numbers`; a reply means the line works. If nothing comes back, read the end of `state/bridge.log` with the command in `state/README.md`.
