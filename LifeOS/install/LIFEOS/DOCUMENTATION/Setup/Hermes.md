---
version: 1.0.1
---

# Hermes (a second front door, with a heartbeat)

Status: `bun LIFEOS/HERMES/Mount.ts --check` · optional

## What it does

Hermes is a separate open-source agent that runs beside LifeOS. LifeOS mounts it: Hermes supplies the engine and chat channels, and LifeOS supplies the identity, rules, skills and knowledge, so you can talk to the same DA from a messaging channel instead of the terminal. A guard plugin blocks credential files and secret-bearing commands in code, so a successful prompt injection cannot read credential files or run secret-bearing commands. The identity, knowledge, mail and calendar context the agent is given remain reachable to it. The design is in `LIFEOS/DOCUMENTATION/Hermes/HermesSidecar.md`.

The mount can also run a heartbeat: a cheap script every ten minutes that checks your calendar, important mail, a due-items queue and (optionally) incoming texts, and wakes the agent only when something needs you. A quiet window costs no model calls. The sidecar is not required by anything else in LifeOS; skip this guide unless you want a second front door.

## Fill in

Two files under `LIFEOS/USER/CONFIG/`, both already in place from the templates.

`hermes-trusted-domains.json` lists hosts the guard may talk to without treating the session as tainted. It starts empty, which means loopback only (`localhost`, `127.0.0.1`, `[::1]`). List only hosts you own or run yourself, never a third-party site:

```json
{ "domains": ["pulse.example.com"] }
```

Re-mount after editing it: `bun LIFEOS/HERMES/Mount.ts`.

`heartbeat.json` holds everything personal about the heartbeat. Every key is optional; a missing key falls back to the code's default.

| Key | Meaning |
|---|---|
| `quietHours` | `{ "start": "23:30", "end": "07:00" }` in 24-hour local time. Findings inside the window wait for the morning brief instead of pinging you. |
| `calendar.lookaheadMinutes` | How far ahead to look for upcoming events. Default 90. |
| `mail.vipSenders` | Lowercase fragments matched against the From header. |
| `mail.importantPatterns` | Case-insensitive regexes matched against the subject. |
| `mail.maxAgeHours` | Ignore unread mail older than this. Default 24. |
| `location.enabled` | Leave `false` unless you feed it a phone location. |
| `artistScan` | Tour-date watch for starred artists in your music reference file. `discoveryWeekday` of `""` turns the weekly sweep off. |
| `meetingPrep`, `imessage.enabled` | Not in the template. `meetingPrep` sets meeting-prep timing and people; `imessage.enabled` turns on the optional text-message leg. |

Two heartbeat legs need tools that are not part of this release, and they skip silently when the tool is missing: the calendar leg needs the private calendar skill, and the mail leg needs the `gws` command-line tool. The heartbeat still runs without them.

## Accounts and secrets

The Hermes agent itself is outside LifeOS and is not included in this release. You install it from its own project; the sidecar code that mounts it (`LIFEOS/HERMES/`, including the Python guard plugin) does ship. The vendor's installer is a script you download and read before running:

```bash
curl -fsSL https://hermes-agent.nousresearch.com/install.sh -o install.sh
# read it, then:
bash install.sh --non-interactive --skip-setup --skip-browser --commit <the commit you reviewed>
hermes auth add openai-codex --type oauth --no-browser
```

The last command signs Hermes in with its own OpenAI login. Never import another tool's tokens; refresh tokens are single use and two clients would break each other. Hermes keeps its own credentials in its home folder (`~/.hermes`), not in LifeOS. Chat channels you add to Hermes (iMessage, Telegram and so on) take their own keys in that home folder's `.env`, per Hermes' own instructions.

Then mount LifeOS into it. This renders the identity file, installs and enables the guard, patches Hermes' config, and creates a scratch folder (`~/HermesWorkspace`) that is the only place its file tools may write:

```bash
bun LIFEOS/HERMES/Mount.ts
```

Start Hermes through a small launcher, never by bare `hermes`, so the guard check always runs first. Save this as an executable script on your `PATH` and name it after your DA:

```bash
#!/usr/bin/env bash
set -euo pipefail
LIFEOS_ROOT="${LIFEOS_ROOT:-$HOME/.claude}"
[ -f "$HOME/.hermes/plugins/lifeos/policy.json" ] || { echo "guard not installed: run bun $LIFEOS_ROOT/LIFEOS/HERMES/Mount.ts" >&2; exit 1; }
cd "$LIFEOS_ROOT"
exec hermes "$@"
```

The heartbeat scripts `LIFEOS/HERMES/Heartbeat/Tick.ts` and `ArtistScan.ts` ship, but nothing schedules them for you. Create the timed jobs yourself, either with `hermes cron` or as LifeOS workflows (`LIFEOS/DOCUMENTATION/Workflows/WorkflowsSystem.md`). Each script ends its output with `{"wakeAgent": false}` to skip the model or `{"wakeAgent": true}` with findings above it.

Re-run `Mount.ts` whenever you change your identity, TELOS or the system prompt.

## Prove it works

```bash
bun LIFEOS/HERMES/Mount.ts --check
bun LIFEOS/HERMES/Health.ts --assert-live --strict
```

The first changes nothing. It prints the identity file's size and `current` or `STALE`, and the same for Hermes' config, and exits 0 only when both are current. It exits 1 with `no Hermes install` if Hermes is not installed yet, and 1 with `STALE` if you edited a source file since the last mount (run `Mount.ts` again). Run it right after mounting and it exits 0.

The second is the live check on the running gateway: exit 0 only when it is up, 1 when it is down, flapping, degraded or absent. Leave it out if you use Hermes only as a terminal agent without a chat channel. `bun LIFEOS/HERMES/Health.ts` on its own prints the plain status and exits 0 for `up` or `absent`.

Then check the guard with the shipped test, which needs only Python 3 and not Hermes: `python3 LIFEOS/HERMES/plugin/test_guard.py` should end with `all <number> cases pass`. For a live check, ask Hermes to read a credential file using the file tool explicitly. It should answer with the guard's block message, and the attempt appears in `~/.hermes/plugins/lifeos/blocked.jsonl`. A model politely refusing proves nothing; the block message does.
