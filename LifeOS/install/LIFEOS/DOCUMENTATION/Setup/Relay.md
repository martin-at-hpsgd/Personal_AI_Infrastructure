---
version: 1.0.5
---

# Relay (texting your DA over iMessage)

Status: `bun LIFEOS/RELAY/bridge/Install.ts --status` · optional

## What it does

Tex is how you talk to your DA by text. You send an iMessage to your DA's line from your own phone and the real DA answers, with the same identity, skills and memory it has in the terminal. It shows it saw your message, reports progress on long jobs, takes a thumbs-up or thumbs-down as yes or no, and understands voice notes and photos. It also texts you when something needs you right away. The full feature list is in `LIFEOS/DOCUMENTATION/Tex/TexSystem.md`.

Relay is the small background program that carries it. It holds the iMessage connection, starts a guarded DA session for each text, and sends the reply. Only the numbers you list in its config can drive it. A text from you runs under the same permission rules as the terminal, and a guard hook asks in the thread before deleting, deploying, spending or messaging other people.

You need this only if you want to text your DA. Nothing else in LifeOS depends on it, except that other systems (Location pairing, urgent alerts) use it to reach your phone when it is set up.

## Fill in

Two files under `LIFEOS/USER/RELAY/`. The folder `state/` must be mode 0700 and the config file mode 0600.

`tool-map.json` is already in place from the template as `[]`. It is optional. Each row is a shortcut line you want your text sessions to know about, for example a private calendar tool. A row only counts if the file named in `path` exists:

```json
[{ "path": "skills/SkillName/Tools/ToolName.ts", "text": "label = bun ~/.claude/skills/SkillName/Tools/ToolName.ts <arguments>" }]
```

`state/bridge-config.json` is the one you must create by hand. No tool in the release writes it for the first time; `Countersign.ts` later edits it but needs it to exist. The smallest working file is:

```json
{ "allowFrom": ["+15555550100"], "chatFrom": [] }
```

| Field | Meaning |
|---|---|
| `allowFrom` | Your own phone number in international format. Required, at least one. Only these numbers reach the DA. |
| `chatFrom` | Numbers that may chat with the DA but never reach tools or your data. Leave it `[]` at first. |
| `ownChannels` | Optional, `{ "numbers": [], "emails": [], "discordUserIds": [] }`. When absent, `allowFrom` is used. |
| `replyTimeoutMs` | How long one reply may take. Default 900000; the bridge refuses anything under 600000. |
| `interimAfterMs` | How long before the "still working" line. Default 120000. |
| `unlockIdleMs`, `challengeTtlMs`, `confirmTtlMs` | Texting lock timings. Defaults are 2 hours, 15 minutes and 10 minutes. |

Once `allowFrom` is right, pin it. `bun LIFEOS/RELAY/bridge/PinAllowlist.ts` applies nothing itself: it prints one `sudo` command that copies your `allowFrom` into a root-owned file. Run that printed line yourself (it asks for your password), then restart the bridge. Its startup log line should then read `allowFromPin: "pinned"`. From then on the pin is the whole principal allowlist for texts and calls, and no text session can change it. To change the list later, edit `allowFrom` and run both steps again.

Then set the countersign, a phrase you text to unlock sensitive actions. It is read from standard input, and only a salted hash is stored. Type it at the prompt rather than on the command line, so it never lands in shell history or a chat:

```bash
stty -echo; bun LIFEOS/RELAY/bridge/Countersign.ts set; stty echo
```

Type the phrase (nothing shows on screen), press Return, then Ctrl-D. If you interrupt it and the terminal stops showing what you type, run `stty echo`. Never pass the phrase inline, as in `printf '%s' 'phrase' | …`: the whole command line, phrase included, goes into shell history.

## Accounts and secrets

Relay needs services that live outside LifeOS and are not part of this release:

- A Photon Spectrum project. This hosted service provides the iMessage line the bridge connects to. You create the account and project with the vendor, and it gives you a project id and secret. The bridge talks to it through the `spectrum-ts` package, which `bun install` fetches in the next step. The release ships only the bridge code, not the service.
- An iPhone with iMessage, to text from.
- A Mac to run the bridge. The installer uses launchd, so it is macOS only.

Put these in `~/.claude/.env` (names only; never paste values into any other file):

| Name | Needed for |
|---|---|
| `PHOTON_PROJECT_ID`, `PHOTON_PROJECT_SECRET` | The iMessage connection. Required. |
| `FISH_API_KEY` | Sending voice notes back, in the DA's Fish voice. Optional. |
| `NTFY_TOPIC` | Optional phone push topic. Leave it unset unless you use one. |

Check that a name is set without printing it: `bun LIFEOS/TOOLS/Secrets.ts has PHOTON_PROJECT_ID PHOTON_PROJECT_SECRET`.

Install the bridge's one dependency, then the service. The guard hook `hooks/TextingGuard.hook.ts` must be registered under PreToolUse in `settings.json`; the bridge checks this before it answers and logs `guard_not_ready` and refuses to reply if it is missing.

```bash
cd LIFEOS/RELAY/bridge && bun install
bun ./Install.ts     # writes the launchd job com.lifeos.relay and starts it (run from the bridge dir)
```

### Phone line and Linq texting (optional)

The Cloudflare Worker in `LIFEOS/RELAY/worker/` carries voice calls to your DA and the Linq texting line. Skip this unless you want calls. Deploy it with `bun LIFEOS/RELAY/worker/deploy.ts deploy`, then put its https URL in `LIFEOS/USER/RELAY/tex-worker.json` as `{"url": "https://<your worker host>"}`; `LinqSetup.ts` reads it and refuses an empty or non-https value. Set the spoken call passphrase with `bun LIFEOS/RELAY/worker/deploy.ts passphrase`, which asks at a hidden prompt and writes only a salted hash to `LIFEOS/USER/RELAY/call-passphrase.json`.

## Prove it works

```bash
bun LIFEOS/RELAY/bridge/Install.ts --status
bun -e 'import { readRelayStatus } from "./LIFEOS/TOOLS/RelayStatus.ts"; const s = await readRelayStatus(); console.log(s.service, "config ok:", s.configOk, "senders:", s.senders); process.exit(s.service === "up" && s.configOk ? 0 : 1)'
```

The first prints the launchd state and exits 1 with `not loaded` when the service is not running. The second prints `up config ok: true senders: 1` and exits 0 when the service is running and the config parses; it prints counts only, never a number or hash. Run the second from the LifeOS root.

Then the real test: text your DA's line from your phone. You should see a 👀 reaction within seconds and a reply. For a one-way test from the Mac, `bun LIFEOS/RELAY/bridge/send.ts "<your number>" "test"` sends a real text to that number.

`LIFEOS/TOOLS/RelayStatus.ts` is a library, not a command, so running it directly prints nothing. The maintainer's private Relay skill, which wraps status, probes and unlocking for the maintainer, is not part of this release. Without it you operate Relay with the commands above, `bun LIFEOS/RELAY/bridge/Probe.ts <scenario>` for guard scenarios, and `launchctl kickstart -k gui/$(id -u)/com.lifeos.relay` to restart it. The Photon service itself is outside LifeOS and is not included.
