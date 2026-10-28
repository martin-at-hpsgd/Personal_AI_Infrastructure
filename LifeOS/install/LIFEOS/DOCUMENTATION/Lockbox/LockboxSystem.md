---
last_updated: 2026-09-15T21:00:00Z
last_updated_by: da
convention: lifeos-freshness-v1
version: 0.2.4
status: designed, not built (ISA at marking; M1 not started)
---

# Lockbox — the one door into LifeOS

> A secure MCP server on the principal's machine that exposes the whole harness,
> every skill and the assistant itself, to any client that is not the principal at the
> terminal, and controls what each client may touch. Relay, the Hermes sidecar,
> Pulse's voice and text modules, scheduled jobs, and any outside agent are all
> clients of Lockbox. The terminal is the one path that never goes through it.
> ISA (state of record): `LIFEOS/LOCKBOX/ISA.md` (maintainer-side; the ISA does not ship). Named for what it is: the
> locked box every skill sits behind, with one keyed door per client. (Called Janus until 2026-09-15.)
>
> **Not yet on the LifeOS docs site or the Core Components card.** Documented ahead
> of the build; the site and the card follow the first milestone.

## Why a door instead of a bridge per channel

Every way into LifeOS that was not the terminal grew its own copy of "spawn the DA
safely and decide what it may do." The iMessage bridge had one. Pulse's Siri and
iMessage modules had another. The Hermes sidecar had a third, in Python, over a
read-only mount. Each copy drifted, each needed its own review, and each
channel's failure was a channel-specific bug. The worst of them was structural:
trying to decide whether an arbitrary shell string is safe, which cannot be made
sound and which spent a week refusing legitimate reads on the principal's own
phone.

Lockbox inverts that. The security model exists once. A channel is a client with
a key; a foreign agent is a client with a key; the difference between them is a
scope in a file the principal edits from the terminal. Fixing the spawn recipe or
a guard rule fixes every channel at once. Adding a channel is adding a row.

## The shape

```
                          clients (each holds one key, one scope)
                          ───────────────────────────────────────
  Relay (iMessage)  ─┐
  Hermes, local     ─┤  loopback                ┌────────────────────────────┐
  Pulse Siri/text   ─┼──────────────────────────►│  Lockbox  (bun, launchd)      │
  scheduled jobs    ─┘                           │  stateless MCP over HTTP    │
                                                 │                            │
  outside agents  ── Cloudflare Tunnel ── Access ►│  key → client row → scope   │
                                                 │  da.ask   read tools   public tools
                                                 └─────┬─────────┬──────────┬─┘
                                                       │         │          │
                                             claude --print   skill CLIs   published copies
                                             (guard armed,    (arg arrays, (outside the
                                              locked/unlocked) no shell)    USER tree)
```

Lockbox binds to loopback only. Remote clients reach it the way the voice line is
already reached: a Cloudflare Tunnel from this machine, fronted by Cloudflare
Access with a service token bound to exactly one Lockbox key. Nothing on the
machine listens on a public port.

The protocol is stateless MCP (the 2026-07-28 spec): one self-contained HTTP
request per call, no server session. What state Lockbox does hold (per-sender lock
state, pending confirms, one-shot approvals, continuation tokens) is its own,
serialized through one writer, keyed to the client and sender that created it.

## Scopes

Three ceilings, declared in a 0600 file under `LIFEOS/USER/LOCKBOX/`, never
granted by a request and never widened by a model.

| scope | may call | `da.ask` spawns | who gets it |
|---|---|---|---|
| `public` | tools marked public: content already published outside the USER tree | never | any vendor whose terms claim a training license over what it sees |
| `read` | curated read tools returning typed summaries (subjects, senders, times, names, counts), never raw bodies | the DA **locked**, reply held to the same content class | a foreign agent the principal trusts with their calendar, not their mail bodies |
| `full` | everything | the DA as the sender's real state: **locked** until the countersign or the terminal Unlock tool, then the terminal with every hook | the principal's own channels: Relay, Hermes on this machine |

A full-scope client's locked tier is not read scope. Locked keeps Relay's exact
read-only CLI grammar for the principal's own line; read scope is narrower on
purpose, because a foreign agent's reply channel is where data would leave.

Two constraints ride every scope because they are about where data and damage
go, not who is asking: data leaves only to the principal's own channels and
owned hosts, and secrets, hooks, settings, launchd, SSH, the Keychain, and
Lockbox's own config are unreachable through any tool. Destructive and outward
actions confirm on Lockbox's side: in the thread for a client that declares a human
sender, the ntfy tap otherwise. A client never sees the mechanism and never
supplies its own approval.

## `da.ask`

The one tool that makes Lockbox "full LifeOS as an agent without building the
agent." It carries the client, the sender, the text, and a continuation token.
Lockbox runs admission (the injection tripwire, countersign detection, a short yes
against a pending confirm), resolves the sender's lock state, and spawns
the DA headless with the one spawn recipe: billing scrubbed to the subscription,
headless channel, the configured carrier, user hooks on, no MCP servers inside
the spawn, the texting guard armed with the resolved state, taint marked before
the spawn. The reply comes back typed, free of imperatives and control
sequences, with a token bound to that client and sender.

Subscription billing holds only under the system prompt's one-beneficiary rule:
the spawn runs on the subscription only when the principal is the one human the
work serves. A client that serves anyone else (another person's agent, a
community channel) is refused at the door in M1, and runs only on API-key
billing once the non-subscription lane exists. This is an M1 constraint, not a
later item.

Everything about that recipe was learned on Relay and is inherited verbatim.
The guard hook and its core stay where they are (`hooks/TextingGuard.hook.ts`,
`hooks/lib/texting-guard-core.ts`); Lockbox is what arms them.

## What each client becomes

- **Relay** keeps the Photon stream, the send tool, iMessage formatting, and
  attachments. It maps the principal's number to its key and calls `da.ask`.
  The bridge no longer spawns anything or decides anything.
- **Hermes on this machine** drops the read-only mount and the Python guard for
  a full-scope key. It is single-sender in M1; community channels are refused at
  the door until a `conversational` scope exists.
- **Pulse's Siri and iMessage modules** call Lockbox or retire (M2).
- **The phone line** stays on its own bearer-authed route until a later milestone; voice
  has a latency budget the spawn recipe may not meet.
- **An outside agent** gets a key at the scope its vendor's terms allow. A
  vendor holding a perpetual training license over user materials is public
  scope, permanently.

When Lockbox is down, every client is down. No client keeps a second door, and the
principal is told on their own line.

## Milestones

- **M1** — the server, the access model, `da.ask`, the curated read tools,
  Relay migrated as the first client, Hermes-local as the second, the guard
  core's one versioned change (Lockbox paths sensitive, taint window at least the
  session TTL), both-lineage review. 62 criteria.
- **M2** — the tunnel and Access binding, Pulse module migration, the Hermes
  mount retired, the first public-scope remote client. 6 criteria.
- **Later** — the phone line as a client, a `conversational` scope, a non-subscription
  lane for unattended clients.

## Files

| path | what |
|---|---|
| `LIFEOS/LOCKBOX/ISA.md` + `extraction.md` | state of record (68 criteria, decisions, absence-review dispositions) and its manifest; both maintainer-side, neither ships |
| `LIFEOS/LOCKBOX/` (code, M1) | planned server, access model, spawn recipe, and read tools; not built yet, so not in the public release |
| `LIFEOS/USER/LOCKBOX/` (M1) | client rows and keys, lock and confirm state, logs; 0700/0600, gitignored |
| the Lockbox maintenance skill (M1, private) | status, add-client, revoke-client, rotate-key, probe |

## Relationship to neighbours

- **Relay** (`LIFEOS/RELAY/`, ISA `LIFEOS/USER/RELAY/ISA.md`): the first client; its security half rehomed here on 2026-09-15.
- **Hermes sidecar** (`LIFEOS/DOCUMENTATION/Hermes/HermesSidecar.md`): control 3, the typed write API that was never built, is satisfied by Lockbox; the mount-and-guard model retires in M2.
- **Pulse** (`LIFEOS/PULSE/`): hosts the Lockbox status card, never the process.
- **The texting guard** (`hooks/TextingGuard.hook.ts`): unchanged in role; Lockbox arms it on every spawn.
- **Bunker**: Lockbox registers there in M1 with its Test Strategy adopted.
