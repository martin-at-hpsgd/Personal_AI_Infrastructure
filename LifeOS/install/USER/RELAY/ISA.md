---
provenance: template
version: 2.0.1
checkup: 2026-10-13 upgraded 1→0
isa_format: 2.30.0
---

# Relay Ideal State

Relay is the bridge that lets the principal text their DA over iMessage and lets LifeOS text the principal back. This template describes the bridge that `LIFEOS/USER/RELAY/README.md` § Set it up installs; edit it as your own setup changes. It names no number, phrase or account: those live only in `state/bridge-config.json` and `~/.claude/.env`.

## Ideal State

### L3 · One sentence

Relay is an always-on bridge on the principal's Mac that carries iMessage texts between the principal's own line and the DA through the Photon provider, admits only the senders the principal listed, holds writes until the principal unlocks the line with a countersign or approves the exact action, and never texts anyone but the principal.

### L2 · Summary

Relay at its ideal state is a private text line between the principal and their DA that behaves like the terminal and cannot be used by anyone else.

- The bridge runs as a launchd service on a Mac with iMessage signed in and holds the iMessage stream through the Photon provider's `spectrum-ts` SDK.
- Only senders in the config's allowlist reach the DA; everyone else is dropped before any model runs.
- Writes and destructive actions wait until the principal unlocks the line with a countersign, stored only as a salted hash, or approves that exact action in the thread.
- Every text Relay sends goes to the principal's own line, and nothing it prints or logs shows a number, the hash or the phrase.

### L1 · Full articulation

Relay is one bun process on the principal's Mac. It starts as the `com.lifeos.relay` launchd service, connects to the Photon provider with the project credentials in `~/.claude/.env`, and holds the iMessage stream for the line the principal connected there. For each text that arrives it spawns the real DA, with the same skills and tools as the terminal, and sends the answer back as a text.

Admission comes first. The bridge reads `state/bridge-config.json`, which lists the senders it admits (`allowFrom`) and the principal's own line (`ownChannels`). A text from anyone else is dropped before any model runs. The config is written by hand once, at mode 0600, and the bridge refuses to start with no admitted sender.

The line starts locked. Reads work while it is locked; writes and destructive actions are held until the principal texts the countersign or approves the exact action in the thread with a yes or a 👍. The countersign is set from the terminal through stdin with `Countersign.ts set`, so it never appears in shell history or a transcript, and it is stored only as a salted hash. An unlocked line relocks when idle.

Relay talks only to the principal. The Send path reads the single number in `ownChannels.numbers` at run time and refuses any other destination. Status, logs and tools report senders as a count and a lock state, never as digits, and never print the hash or the phrase.

## Criteria

- [ ] ISC-1: The `com.lifeos.relay` service is loaded and running, and `Install.ts --status` exits 0.
- [ ] ISC-2: `state/bridge-config.json` exists at mode 0600 in a 0700 directory and names at least one admitted sender and exactly one own-line number.
- [ ] ISC-3: The countersign is set and stored as a salted hash: the config holds both `countersignSalt` and `countersignSha256`.
- [ ] ISC-4: The line is locked by default: a write texted from the own line before the countersign is held, not run.
- [ ] ISC-5: Every live probe scenario passes, run in the documented order with `cleanup` last.
- [ ] ISC-6: A text sent through the bridge's `send.ts` lands on the principal's own line.

## Test Strategy

| isc | type | check | threshold | tool | anchors_to |
|---|---|---|---|---|---|
| ISC-1 | bash | the service is loaded and running | exit 0, contains `state = running` | `bun ~/.claude/LIFEOS/RELAY/bridge/Install.ts --status` | goal |
| ISC-2 | bash | the config file and its directory have owner-only modes | `600` then `700` | `stat -f '%Lp' ~/.claude/LIFEOS/USER/RELAY/state/bridge-config.json ~/.claude/LIFEOS/USER/RELAY/state` | goal |
| ISC-3 | bash | the config holds a salted countersign hash, printing neither | exit 0 | `bun -e 'const c=JSON.parse(require("fs").readFileSync(require("os").homedir()+"/.claude/LIFEOS/USER/RELAY/state/bridge-config.json","utf8"));process.exit(c.countersignSalt&&c.countersignSha256?0:1)'` | goal |
| ISC-4 | manual | a write texted before the countersign is held and the reply asks for the countersign | held | a live text from the own line; the `principal-write` probe scenario covers the same path without a phone | goal |
| ISC-5 | manual | each scenario listed in `LIFEOS/RELAY/bridge/Probe.ts` passes | all pass, exit 0 each | `bun ~/.claude/LIFEOS/RELAY/bridge/Probe.ts <scenario>`, run from the terminal with `cleanup` last; it spawns real sessions, so it is never unattended | goal |
| ISC-6 | manual | a test text arrives on the principal's phone | text received | `bun ~/.claude/LIFEOS/RELAY/bridge/send.ts <own line> "test"`; no probe may send one unattended | goal |

## Harness

```yaml
# draft: not yet run end to end (added 2026-10-13, 2.30.0 upgrade)
surface: cli
targets:
  local: com.lifeos.relay, the launchd service on this Mac
doctor: bun ~/.claude/LIFEOS/RELAY/bridge/Install.ts --status
drive: pty
identity: none (the line admits only the senders listed in state/bridge-config.json; no number or phrase is recorded here)
isolation: serial
evidence: ./.harness/evidence
```

## Decisions

- Template: the bridge texts only the principal; texting anyone else belongs to the communication skill, with its own checks.
