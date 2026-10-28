---
version: 1.0.0
---

# Overage lane

Status: `bun LIFEOS/TOOLS/Overage.ts status` · optional

## What it does

The two top lanes, Astra (OpenAI) and Fable (Anthropic), normally run on your subscriptions. When a plan window caps out, that work stops. The overage lane is an emergency road around the cap: you can arm a pay-per-token continuation, and every billed call is recorded in dollars against a monthly ceiling.

It is built to be hard to turn on by accident:

- It is off by default. Arming belongs to one session, records a reason and expires on its own (four hours unless you say otherwise).
- Only an interactive session can arm it. Scheduled and headless jobs are refused.
- One monthly ceiling covers both vendors. At the ceiling the lane refuses even while armed.
- It is for a capped window, never a cheaper way to do routine work.

You can skip this system entirely. With no keys and no arm, nothing ever bills the API.

## Fill in

`LIFEOS/USER/CONFIG/overage.json` has one setting:

```json
{ "ceilingUsd": 0 }
```

`ceilingUsd` is the monthly ceiling in US dollars across both vendors. `0` or a missing file uses the built-in default of 1000. That default is high for most people, so set your own number, for example `{ "ceilingUsd": 100 }`.

## Accounts and secrets

Each lane bills a different vendor and needs its own pay-per-token API key in `~/.claude/.env`:

| Lane | Key name | Where to create it |
|---|---|---|
| Astra (OpenAI) | `OPENAI_API_KEY_OPTIN` | platform.openai.com/api-keys |
| Fable (Anthropic) | `ANTHROPIC_API_KEY` | platform.claude.com/settings/keys |

A lane with no key refuses by name and never falls back to the subscription. After you add a key, run `bun LIFEOS/TOOLS/Secrets.ts seal`, and check it without printing it:

```bash
bun LIFEOS/TOOLS/Secrets.ts has OPENAI_API_KEY_OPTIN ANTHROPIC_API_KEY   # one "yes" or "no" per key
```

Arming is a decision you make per session, not a setting. When a window has capped and you want the lane, tell your assistant to arm it, or run the command yourself in an interactive session:

```bash
bun LIFEOS/TOOLS/Overage.ts arm --session <id> --reason "<why>" [--minutes 240]
bun LIFEOS/TOOLS/Overage.ts disarm
```

## Prove it works

```bash
bun LIFEOS/TOOLS/Overage.ts status                       # armed or disarmed, spend against the ceiling, billed calls
bun LIFEOS/TOOLS/Overage.ts check --session <id>         # exit 0 only when a call may bill
```

A healthy fresh install prints `emergency API lane: disarmed` and a line like `$0.00 of $1,000 · $1,000 left`. `check` exits 1 with `REFUSED: the emergency API lane is not armed` until you arm it; that refusal is the correct state. The same numbers show on Pulse `/usage` and on the status line's money row.

The only check that bills is a live call after arming, and it is the smallest one the tool can make:

```bash
bun LIFEOS/TOOLS/ApiLane.ts astra --prompt "reply OK" --probe
```

Disarm when you are done.
