---
last_updated: 2026-10-14T01:44:00.000Z
last_updated_by: da
convention: lifeos-freshness-v1
version: 1.4.16
---

# Hermes Sidecar — talk to your LifeOS as an agent

> **What it is.** An optional second front door onto a LifeOS install. Hermes
> runs beside LifeOS and mounts it: same constitution, same identity, same
> skills, same understanding of what is sensitive — reachable from a terminal
> today and, once the injection defense lands, from a messaging channel.
>
> **What it is not.** A second assistant with its own memory and its own
> opinions. There is one brain. The sidecar is another way into it.

## Why a sidecar rather than a bot

Every channel bot ever written re-implements the assistant badly: its own
prompt, its own memory, its own drift. The sidecar inverts that. Hermes supplies
the *engine and the channels*; LifeOS supplies the *identity, the rules, and the
knowledge*. When Hermes rots or something better appears, the mount moves and
nothing about who the assistant is has to be rewritten.

## The load-bearing idea: secrets get used, never seen

A full mount looks alarming until you notice what LifeOS skills actually are.
They are CLI-first — the real work is a `bun .../Tools/X.ts` subprocess that
reads its own credentials in its own memory and prints a result.

So the agent invokes the tool and receives the *answer*. The token does its job
without ever entering the model's context. That single property is what makes it
safe to hand an agent the whole tree: **a successful prompt injection finds
nothing to exfiltrate, because the secrets were never in the conversation.**

Everything below is machinery around that idea.

## Architecture

```
LifeOS install (read by the sidecar)               Hermes install
├── LIFEOS/HERMES/           ← sidecar code        $HERMES_HOME (default ~/.hermes)
│   ├── Policy.ts            deny-set definition   ├── SOUL.md        ← generated
│   ├── RenderSoul.ts        constitution+identity ├── config.yaml    ← patched
│   ├── Mount.ts             installer/sync        ├── .env           ← sandbox root
│   └── plugin/              the guard             ├── cron/          ← read by Pulse
├── LIFEOS/USER/             ← content, never code └── plugins/lifeos/← installed
└── skills/                  ← read, not write-gated   ├── guard.py
                                                       └── policy.json ← generated
$HERMES_WORKSPACE (default ~/HermesWorkspace)   ← where Hermes' file tools may write
~/.local/bin/<da-name>                          ← launcher: cd to LifeOS root, exec hermes
```

Three paths, three jobs, and keeping them straight is most of understanding the
mount: the **LifeOS tree** is the input the sidecar reads, **`$HERMES_HOME`** holds
generated state and the guard, and **`$HERMES_WORKSPACE`** is the scratch space
Hermes' file tools are confined to. Shell and code tools are not confined (see
§ Write sandbox below).
Both Hermes paths are overridable by environment variable; `Mount.ts` honours
whatever is set, so a non-default install needs no edits.

**`HERMES_HOME` selects the profile, and the mount takes over whichever one it
is pointed at.** If a Hermes agent already lives in the default `~/.hermes`
(one you run for something other than LifeOS), do not mount into it: set
`HERMES_HOME` to a standalone directory for the sidecar and run `Mount.ts` and
the launcher with that variable set, and the two agents never see each other's
`SOUL.md`, `config.yaml`, cron jobs, or memory. The mount refuses to overwrite a
`SOUL.md` it did not write (the file lacks the LifeOS header line) unless you
pass `--force`; `--check` reports such a profile as `FOREIGN`. Adopting an
existing agent as the DA — carrying its skills and memory across rather than
starting beside it — is not a supported path yet. (public issue #1962,
@theNetworkChuck)

**Code and content never mix.** Everything under `LIFEOS/HERMES/` is
install-generic: no identity, no home paths, no instance literals — it ships
publicly as-is. Everything personal is *read* from `LIFEOS/USER/` at render time
and *written* into `$HERMES_HOME`, which lives outside the LifeOS repo entirely.
Nothing generated is ever committed back.

## The four controls

Reading is not the security boundary — the principal *wants* the agent to read
everything. The boundary is what can leave, and what can be reached.

**1. Read guard (`pre_tool_call`).** A plugin hook vetoes any tool call whose
path or command touches credential material: env files, token stores, SSH/AWS/
GPG directories, key material by extension, harness config, security state. It
fires before every tool, built-ins included, and returns a block the model
cannot route around. Everything else in the tree is open, which is the point.

Three bypasses it handles explicitly, because each defeats a naive matcher:

| Bypass | Handling |
|---|---|
| Symlinks (`LIFEOS/USER` is one) | matches the literal path *and* the resolved realpath |
| Case (macOS is case-insensitive) | all matching lowercased |
| Traversal / relative paths | resolved to absolute before matching |

It also covers `execute_code`, not just `terminal` — a two-line Python snippet
reads any file the process can reach, and a guard watching only the shell has a
documented hole.

**2. Write sandbox (file tools only).** `HERMES_WRITE_SAFE_ROOT` hard-blocks writes
by Hermes' file tools outside the workspace and Hermes' own state. It does not bind
`terminal` or `execute_code`: Hermes never routes those through its write-safety
module (see `Policy.ts`), so a shell command or code snippet can write anywhere
your user can, minus the deny globs in `Policy.ts`. The LifeOS tree is not
read-only at the filesystem level; treat a mounted sidecar as having your user's
write access. (GHSA-3h35-j277-wm7q, @Piroshki)

**3. Typed write API** *(planned; designed as Lockbox, 2026-09-15)*. Persistence goes
through a typed API that gates every write the way a terminal session is gated.
The agent never writes files; it calls an API bound by the same rules. The design
now lives in Lockbox (`LIFEOS/DOCUMENTATION/Lockbox/LockboxSystem.md`), the one MCP
door into LifeOS: when its first milestone lands, the sidecar becomes a Lockbox
client with a full-scope key and the mount-and-guard model below retires. Until
then the sidecar is read-plus-CLI only.

<!-- public issue #1725, @rpriven -->
**4. Provenance tainting** *(built)*. Content arriving from an untrusted source
— an inbound message, a fetched page — is wrapped and marked by the
`transform_tool_result` hook, and the taint is sticky for the session. What
shipped is stricter than the spec above: a tainted session doesn't prompt for
approval on a privileged call, it refuses in code. A cron turn has no human to
approve anything, so an approval prompt would resolve to nobody. This is what
stops "agent reads a malicious page" from becoming a compromise.

### Honest limits

- Controls 1, 2, and 4 are real enforcement — control 4 lives in `plugin/guard.py`
  and is registered in `plugin/__init__.py` alongside the read guard. Control 3
  is not built yet; its design is Lockbox, and Lockbox M1 has not started.
- Build status is not the same as gateway posture. **The gateway stays off until
  the tainting control has been exercised against a live inbound channel**, which
  is a separate bar from the code existing.
- Hermes' own docs are explicit that deny rules are "not a sandbox against a
  deliberately adversarial process." True isolation is a separate OS user or a
  container — which costs the seamless mount. Worth re-asking the day the
  sidecar answers messages unattended.
- Plugins are **opt-in**. An installed-but-disabled guard looks present in every
  listing while enforcing nothing, so enabling is part of installing.

### Which surface for what

The terminal DA and the sidecar read the same identity, TELOS, and skills, so
the difference is not what they know but what they may touch and what fires
around them. (public issue #1961, @theNetworkChuck)

| | Terminal DA (Claude Code) | Hermes sidecar |
|---|---|---|
| Where | Your terminal, on the machine | Discord, iMessage, cron — wherever Hermes is wired |
| Writes | Anywhere the permission system allows | File tools: only `$HERMES_WORKSPACE` and `$HERMES_HOME`. `terminal` and `execute_code`: anywhere your user can write, minus the `Policy.ts` deny globs |
| Hooks and gates | Every LifeOS hook fires (Algorithm, verification, ISA, memory writers) | None of them — no hook runs inside a Hermes turn; the guard plugin is the only enforcement |
| After reading untrusted text | The LifeOS hooks handle it | The turn is tainted and every privileged tool (send, write, publish, deploy) is refused for the rest of it |
| Memory | Full Cortex read and write | Read via the mounted tree; writes only through skill CLIs (the typed memory API is planned as Lockbox and is not built) |

Use the terminal for anything that changes state: building, deploying,
editing the LifeOS tree, publishing, long Algorithm runs, or work that needs
verification gates. Use the sidecar for what you would ask a person over
chat: a question about your TELOS or calendar, a reminder, a lookup that
reads the mounted tree, a scheduled nudge, drafting text you will send
yourself. If a sidecar task turns into "now change something", the honest
answer is to pick it up in the terminal — the sidecar's refusals are the
design, not a bug.

## Installing

```bash
# 1. Install Hermes (pinned, no Playwright — LifeOS uses Interceptor)
curl -fsSL https://hermes-agent.nousresearch.com/install.sh -o install.sh
# review it, then:
bash install.sh --non-interactive --skip-setup --skip-browser --commit <reviewed-sha>

# 2. Authenticate (its OWN session — never import a sibling agent's tokens)
hermes auth add openai-codex --type oauth --no-browser

# 3. Mount LifeOS
bun LIFEOS/HERMES/Mount.ts

# 4. Install the launcher (below) and start from it, never from bare `hermes`
```

`Mount.ts` is idempotent and is the only supported way to change any of this:

- renders `SOUL.md` from live LifeOS sources,
- installs *and enables* the guard plugin with a generated policy,
- patches `config.yaml` (soul cap, skills mount, approval policy),
- creates `$HERMES_WORKSPACE` and sets `HERMES_WRITE_SAFE_ROOT` to
  `$HERMES_WORKSPACE:$HERMES_HOME` in `$HERMES_HOME/.env`.

Re-run it after editing identity, TELOS, or the system prompt. `--check` reports
drift without writing; wire it into a freshness job if the install should never
serve a stale identity.

**`Mount.ts` is the only writer of `config.yaml`, and the deny list is reconciled
rather than seeded.** Both were learned on 2026-07-31. Mount used to skip the
approvals block whenever one already existed, so a hand-edited list could never be
corrected and `--check` still called the install clean — which is how `*.claude*`
sat in a live deny list while `Policy.ts` was the stated source of truth. It also
finished by shelling out to `hermes plugins enable lifeos`, and that command rewrites
the file from a stock template: a full config came back as a short file of defaults,
losing the model and agent blocks, the skills mount, the approvals list, and the
enabled chat platforms. Every mount discarded its own work and took
the chat channels with it. The plugin is now enabled by editing `plugins.enabled`
in the config Mount already owns. Don't reintroduce the shell-out, and don't
hand-edit the deny list — change `Policy.ts` and re-mount.

**Deny globs match paths, not substrings.** `*.env*` also matches `os.environ` and
`process.env`, which is not a hypothetical: many of the guard's first blocks
were ordinary code touching no file, and a mail-monitor cron died on it. A glob
that fires on normal work teaches everyone to route around the guard, so the env
rules are path-anchored (`*/.env*`, `* .env*`, and the quoted forms). The same
mistake in the other direction is worse: `*.claude*` denied every command naming
the LifeOS tree, which is every skill CLI, since all of them live under it. The
mount's whole premise is invoking those tools. What that glob was actually
protecting — harness config and security state — is now named directly
(`*.claude/settings*`, `*LIFEOS/USER/SECURITY*`).

### The launcher

Hermes must run **from the LifeOS root**, or it loads no project context and the
mount is half-blind. That is what the launcher is for — a small script on
`PATH`, named after the DA, that refuses to start if the guard is missing:

```bash
#!/usr/bin/env bash
set -euo pipefail
LIFEOS_ROOT="${LIFEOS_ROOT:-$HOME/.claude}"
[ -d "$LIFEOS_ROOT" ] || { echo "no LifeOS install at $LIFEOS_ROOT" >&2; exit 1; }
[ -f "$HOME/.hermes/plugins/lifeos/policy.json" ] || {
  echo "sidecar guard not installed — run: bun $LIFEOS_ROOT/LIFEOS/HERMES/Mount.ts" >&2; exit 1; }
cd "$LIFEOS_ROOT"
exec hermes "$@"
```

The guard check is the load-bearing line. Running stock `hermes` from the LifeOS
root gives a full read mount with **no** credential guard in front of it, and
nothing about the session would look wrong. Launch through the script, always.

Working from the LifeOS root does not fence anything. The guard blocks credential
material at the tool boundary and the write-sandbox confines Hermes' file tools,
but `terminal` and `execute_code` can still write into the tree.

### Authentication

Use a **fresh device-code login**, never an import of another tool's tokens.
OAuth refresh tokens are single-use, so a shared token means the two clients
race and one of them breaks. Hermes' own installer recommends the same.

### Skills are the default path

Mounting the skills directory puts them on disk; it does not make the agent use
them. Both halves are required, and both are Mount's job (principal directive,
2026-08-01: Hermes routes requests through LifeOS — same skills, same
capabilities as the terminal):

- `config.yaml` gets `skills.external_dirs` pointing at the install's `skills/`
  tree, so Hermes' own skill loader sees them.
- The soul gets a **skills-routing tier**: doctrine stating that LifeOS skills
  are the default capability path — a matching request executes that skill's
  SKILL.md intent, never a handrolled equivalent — plus a capability index,
  one line per skill, rendered live from each `SKILL.md`'s frontmatter by
  `renderSkillRouting()` in `RenderSoul.ts`.

The index is generated at mount time from the mounted tree, so adding a skill
and re-mounting is the whole update; nothing in `LIFEOS/HERMES/` names a skill.
Summaries are the description's first clause (the part before USE WHEN), because
the agent routes on what a skill does and reads the SKILL.md for triggers and
intent before executing.

### The soul cap

Hermes truncates its identity file at `context_file_max_chars` (default 20,000)
**silently**. A LifeOS constitution alone is near that, so `Mount.ts` sets an
explicit, generous cap and refuses to write a soul that exceeds it. A truncated
identity fails quietly, which is the worst way to fail.

### One renderer, not two

`LIFEOS/HERMES/RenderSoul.ts` is the canonical renderer — `Mount.ts` calls it,
and it renders the full constitution against the 100,000-char cap `Mount.ts`
writes into `config.yaml` (raised from 80k on 2026-08-01 when the skills
capability index joined the soul). The render refuses to return a soul that
still carries an unsubstituted identity placeholder (`{{DA_NAME}}`-shaped):
`assertNoPlaceholder()` throws, telling you to run the identity overlay before
mounting, so a template token never becomes the sidecar's system prompt.

Its predecessor, a standalone 19,500-char compressor that silently replaced the
full soul with a compressed one, was retired in 8.3.0 and is removed from
installs on upgrade. Re-run `Mount.ts` to regenerate the soul.

### Output format

The terminal output contract — banner, CHANGE/VERIFY sections, closer line — is
CLI presentation and is stripped by default. Rendering it into a chat bubble is
what broke earlier chat-bot attempts: identity injected as prose, then policed
with an egress regex. The *rules* carry over; the ASCII does not. Pass
`--keep-output-format` to override.

## Verifying an install

Trust these, not the config file:

```bash
python3 LIFEOS/HERMES/plugin/test_guard.py     # deny + allow cases
bun LIFEOS/HERMES/Mount.ts --check             # identity/config drift
```

Then verify end-to-end, which is the part that actually matters. A model
refusing a sensitive read proves *nothing* — it may simply be complying with the
soul, leaving the guard untested. Ask it to read a denied file **using the tool
explicitly** and confirm it reports the guard's verbatim block message, then
check the audit trail:

```bash
cat "$HERMES_HOME/plugins/lifeos/blocked.jsonl"
```

Every block is recorded there with tool, target, and reason. The plugin owns
that file because Hermes' own logger drops plugin warnings on some
configurations, and a security control with no audit trail cannot be reviewed
after the fact.

## Where it shows up in LifeOS

Separate but integrated: Hermes keeps its own install, its own process tree, and
its own vendor label — and LifeOS owns its health, reporting it wherever LifeOS
reports the health of anything else.

**The process.** `LIFEOS/HERMES/Health.ts` is the one probe. It reconciles three
sources that can disagree — what the supervisor thinks it has, what
`gateway_state.json` last claimed, and whether that pid is alive right now — into
one of `up` / `degraded` / `flapping` / `restarting` / `down` / `absent` (`restarting` is a relaunch caught mid-flight: the recorded pid is stale but the supervisor holds a live one), plus per-channel state
and a problem list. Read-only by design: it never starts, stops, or restarts
anything.

`flapping` exists as its own state because a crash-looping gateway satisfies both
the supervisor and the state file continuously while being down nearly all the
time. Uptime therefore comes from the live process, never from the state file's
write age, which a flapping gateway refreshes forever.

**Where it renders.** (The Pulse and menu-bar surfaces below run through the
private `LIFEOS/PULSE/Assistant/` module, which is NOT in the public release
payload — on a public install, `Services.ts status` and `Health.ts` are the
shipped ways to read sidecar health.)

- `bun LIFEOS/TOOLS/Services.ts status` — the gateway is a registered service
  under the `sidecar` category, like every other background service.
- Pulse `/assistant` → **Hermes (sidecar)** — status, uptime, pid, a chip per
  channel, and any problems, above the cron-job list. Served from
  `/assistant/tasks` as the `hermes` field.
- The menu bar — one Hermes row carrying the status, coloured by state. `down`
  and `flapping` also raise an actionable feed entry; `degraded` does not, since
  a channel that was never given credentials is a standing config gap rather
  than news.

**Jobs, separately.** `scheduled.ts` also exports `hermesJobs()` (from
`$HERMES_HOME/cron/jobs.json`) and `hermesTicker()` (the scheduler's own
liveness, reported apart from the job list because a healthy job list on a dead
ticker is exactly the failure that looks fine; no Pulse surface reads it yet). Only `hermesJobs()` feeds `aggregateTasks()` in
the Assistant Pulse module under `source: "hermes"` (that module is private —
NOT in the public release payload, so its path is not named here). Create and edit jobs
with `hermes cron` — Pulse reports, it does not own them. Hermes stores each
job's `schedule` as an object (`{kind, expr|minutes, display}`), not a string;
`hermesJobs()` handles both shapes because the object reaching `describeCron()`
used to throw and the catch silently degraded the whole Hermes list to empty
(found 2026-08-08).

## Heartbeat — the proactive fast loop

Heartbeat is the Hermes cron job that makes the sidecar *proactive* rather than
scheduled-reactive: a 10-minute omnibus check that costs nothing when nothing is
happening. It is the reference implementation of the **wake-gate pattern**, which
is the standard for every high-frequency LifeOS job:

> A deterministic script runs every tick and emits, as its final stdout line,
> `{"wakeAgent": false}` to skip the LLM entirely or `{"wakeAgent": true}` with
> findings above it. The Hermes scheduler honours this contract natively
> (`_parse_wake_gate` in `cron/scheduler.py`). Model spend is per-event, never
> per-cycle.

**The pieces:**

| Piece | Where | Job |
|---|---|---|
| `Tick.ts` | `LIFEOS/HERMES/Heartbeat/` | 10m deterministic check: calendar lookahead (`UPCOMING_EVENT`), one `MEETING_PREP_DUE` per meeting 2–20 minutes out with the configured people (`MeetingPrep.ts`, config `meetingPrep`), unread-mail headers vs VIP/pattern rules, time-sensitive queue, optional location, optional iMessages (`IMESSAGE`, from the Messages reader inbox via `Messages.ts`, config `imessage.enabled`) |
| `ArtistScan.ts` | `LIFEOS/HERMES/Heartbeat/` | daily favorite-artist tour diff (Ticketmaster Discovery when `TICKETMASTER_API_KEY` is set; weekly agent web-sweep fallback otherwise) + weekly taste-adjacent discovery |
| shims | `$HERMES_HOME/scripts/{heartbeat_tick,artist_scan}.sh` | 2-line bash wrappers; logic stays TypeScript in the LifeOS tree |
| config | `LIFEOS/USER/CONFIG/heartbeat.json` | everything personal: VIP senders, importance patterns, quiet hours, home-region patterns, venue allowlist — code is install-generic |
| state | `$HERMES_HOME/state/heartbeat/` | `prep-sent.json`, `meeting-prep-sent.json`, `seen-mail.json`, `queue.json`, `imessage-cursor.json`, `artist-events.json`, `ledger.jsonl` |

**Delivery discipline (the interruption ceiling).** Findings that warrant
interrupting land as a single concise iMessage from the agent turn. Everything
else appends to `ledger.jsonl`, which the 08:00 morning-brief job reads as its
"While You Slept" section — so quiet-hours findings and non-urgent items ride
the brief instead of pinging. Slower jobs feed time-sensitive items into
`queue.json` with a `dueAt`; the next tick past that time wakes the agent to
deliver them contextually.

**Location leg.** `location.enabled` ships `false`. It turns on only when a
phone-side location feed exists (an iOS Shortcut posting to
`state/heartbeat/location.json`); even then the agent only *proposes* public
daemon updates against the venue allowlist until the approval pattern graduates.

**iMessage leg.** Off unless `imessage.enabled` is set in `heartbeat.json`. The
tick never opens `chat.db`: the Messages reader (`LIFEOS/TOOLS/Messages/`, a
compiled binary run every 5 minutes by `com.lifeos.messages`, the only process
granted Full Disk Access) copies new inbound texts into a private 0600 inbox
under `~/.local/state/lifeos/messages/`. Each tick turns rows past its cursor
into one `IMESSAGE` finding each, with the few earlier lines of that
conversation as context. A first run starts at the newest row instead of
replaying the backlog. Message text goes to the model only; the ledger gets an
`IMESSAGE_SEEN` metadata line (sender, time, length), never the text.

**What Heartbeat deliberately does not do:** duplicate any launchd or
server-side monitor (Workflows security scanner, Bunker probes, backups), mutate
mail, or send anything to anyone but the principal.

**Heartbeat, the fast loop.** `LIFEOS/HERMES/Heartbeat/` holds the deterministic
pre-run scripts for wake-gated cron jobs: `Tick.ts` (every 10 minutes —
calendar lookahead and meeting prep, important-mail candidates, the time-sensitive
queue, optional location, optional iMessages) and `ArtistScan.ts` (daily tour-date diff for the music corpus's ⭐
artists — Ticketmaster Discovery when `TICKETMASTER_API_KEY` is set, Bandsintown
only once you configure a working app id (the shipped default id is known-dead),
and a SOURCE_DEGRADED wake that has the agent web-sweep instead when no API works;
home-region hits also enqueue into the time-sensitive queue). Each spends zero model tokens: it does cheap local/API
checks and emits a wake-gate JSON line as its final stdout — `{"wakeAgent": false}`
skips the LLM entirely per the Hermes scheduler contract; findings wake the agent
with the findings injected as context. The scripts ship; the wiring does not:
you create the cron jobs by hand with `hermes cron` (Mount.ts does not install
them), config is personal at `LIFEOS/USER/CONFIG/heartbeat.json` (no shipped
template — `Tick.ts` runs on safe defaults without it), and legs whose tools
are absent (the private calendar skill, the `gws` mail CLI, an empty music
corpus) skip silently. Non-interrupt findings append to the heartbeat ledger
for the morning brief.

Every Hermes read in a Pulse payload is best-effort: an absent install, an absent
cron file, or unreadable JSON degrades to empty or `absent`, so a broken sidecar
can never take down the dashboard or the menu bar.

### The core files, in Pulse

Health answers *is it running*. The **Hermes** tab on Pulse `/assistant` answers
*what is it, and change it* — every file the sidecar's behaviour depends on, read
and edited from the dashboard. Served by `LIFEOS/PULSE/modules/hermes.ts` at
`/api/hermes`.

The files are grouped by **plane**, because the three are governed differently and
a flat list would hide that:

| Plane | What | Editable |
|-------|------|----------|
| **source** | `LIFEOS_SYSTEM_PROMPT.md`, DA + principal identity and memory, TELOS, PROJECTS | Yes — this is the real lever, since SOUL.md is rendered from it |
| **runtime** | `$HERMES_HOME`: `SOUL.md`, `config.yaml`, `policy.json`, the installed guard, `cron/jobs.json`, `.env`, `auth.json` | Only the hand-maintained ones |
| **code** | `LIFEOS/HERMES/*` — RenderSoul, Mount, Policy, Health, the plugin, bunker config, ISA | Yes, gated on `assertClean()` |
> The Bunker CLI is maintainer-private and not in the public release; run code rows with `bun test ./<path>` and suite rows with `bun skills/Assay/Tools/EvalRunner.ts`.

Three rules make it safe to put a file editor on a dashboard:

- **Generated files are read-only.** `SOUL.md`, `policy.json`, and the installed
  plugin copies are shown in full and refuse writes with a 409 naming their
  generator, because a hand edit there survives exactly until the next mount. The
  row links to the sources to edit instead.
- **Credential material is sealed.** `.env` and `auth.json` are listed with size
  and mtime and never read into a response. Same rule the guard enforces on the
  sidecar — a dashboard is not an exemption.
- **Files are addressed by id, never by path.** A `?path=` parameter on a
  localhost server is an arbitrary-file-read primitive; every reachable file is
  named in the module's registry, so traversal has nothing to traverse.

Writes to the code plane run `assertClean()` first, so a home path or a token
typed into the editor is refused at the boundary (422) rather than found at
release time. Every save keeps the previous bytes under
`LIFEOS/MEMORY/STATE/hermes-edits/`.

The tab also carries **mount drift**: `Mount.ts --check` renders as `current` or
`stale`, with a Re-mount button that runs the real installer and prints its
output. That is what closes the loop — edit a source file, see the mount go
stale, re-mount, watch SOUL.md's digest change.

### The restarter loop

Hermes blocks in-process gateway restarts (SIGTERM would kill the command
issuing them), and its workaround submits a helper job that sleeps and then
`launchctl kickstart -k`s the gateway. `launchctl submit` defaults KeepAlive to
**true**, so that helper relaunches itself forever and kills the gateway on every
pass. Found 2026-07-30 after a long run of repeated restarts, and observed
re-submitting itself again afterwards.

`launchctl remove ai.hermes.gateway-restarter` clears it. The health probe names
that job directly whenever it is loaded, so the recurrence is visible instead of
silent. This is upstream behaviour in Hermes; LifeOS reports it rather than
patching a vendor install.

### Alerting

The sidecar is a Bunker app. `LIFEOS/HERMES/bunker.config.ts` puts it in the
registry, and the ISA's `## Test Strategy` rows are its probes, so
`com.lifeos.bunkermonitor` runs them every five minutes alongside every other
app and emails on green→red and red→green transitions. Two rows carry
`severity: critical` — the gateway being down or flapping, and the restarter
being loaded — which means either one pages as an outage rather than filing as
degraded, even while every other probe passes.

Nothing pages for `degraded` or `absent`. A channel that was never given its
credentials is a standing config gap, and an install with no sidecar is not a
fault; alerting on either would train the alert to be ignored, which costs more
than the coverage is worth. Both stay visible in Pulse and the menu bar.

```bash
bun Health.ts --assert-live          # exit 1 only on down / flapping (up, degraded, absent, restarting pass)
bun Health.ts --assert-live --strict # only `up` passes; for a post-update check
bun Health.ts --assert-no-restarter  # exit 1 while the looping job is loaded
bun test Health.test.ts              # flap-detector regression suite (maintainer tree — tests are not shipped)
```

One adjacent thing that is *not* the sidecar: `skills/LifeOS/Tools/InstallEngine.ts`
lists `hermes` (root `~/.hermes`) as a harness LifeOS can install *into*. That is
the reverse direction — LifeOS skills laid into a Hermes install — and it shares
nothing with the mount described here.

## Known behaviour worth knowing

**Hermes scans SOUL.md for prompt injection before loading it — and doctrine
that QUOTES attack shapes gets the whole soul blocked.** `agent/prompt_builder.py`
runs `scan_for_threats(scope="context")` over every context file; a match
replaces the entire soul with a `[BLOCKED: …]` placeholder, silently, per
session. That is how most sessions over a span of weeks ran with
no constitution, no identity, and no skills routing: the Security Protocol
sentence "…telling you to ignore previous instructions…" matched the scanner's
`prompt_injection` regex. The fix (system prompt v3.7.4) was to describe the attack shape instead of quoting it; the scanner itself was left as it was. Standing
rule: any edit to a soul source re-runs Hermes' OWN scanner against the
re-rendered SOUL.md (the exact code, never a lookalike regex) before calling
the mount done — and `Observe.ts status` reports the soul-blocked count so a
regression is visible the same day. `OPERATIONAL_PREFERENCES.md` is not a soul source
(`RenderSoul.ts` reads the system prompt, DA and principal identity and memory,
PRINCIPAL_TELOS and PROJECTS); run Hermes' own scanner over it before adding it,
because a match re-blocks the whole soul.

The agent will sometimes answer a factual question about the install from
inference instead of reading the file, and be confidently wrong. Ask for
verbatim quotes when accuracy matters. This is model behaviour, not a mount
defect — but it is the reason the verification doctrine is in the soul, and it
is worth re-checking as models change.

## Installer integration

The LifeOS installer offers the sidecar as an optional step:

> *Install Hermes as well, so you can talk to your LifeOS as an agent?*

Choosing yes runs the steps above against the user's own install. Because
all generated artifacts land in `$HERMES_HOME` and all personal content is read
from that install's own `LIFEOS/USER/`, the same code produces a correctly
personalized sidecar on every machine with no per-install editing.

Declining costs nothing — LifeOS does not depend on the sidecar in any way.

## Removing it

Two orders of business before the delete, or you lose scheduled work and re-create
history:

1. **Rehome the cron jobs.** Every Hermes cron job moves to a Workflow: new timed work
   goes into a definition in `LIFEOS/USER/WORKFLOWS/` (see `../Workflows/WorkflowsSystem.md`),
   with its schedule installed by `engine/schedule-install.ts`. The agent-job runner
   below is a legacy runtime that still runs until the migration lands; it is where
   existing jobs live, not where new ones go. For reference, the legacy format describes
   each job in `LIFEOS/USER/CONFIG/agent-jobs.json` (script-only jobs carry
   `command`; agent jobs carry `prompt`, an optional wake-gate `preScript`, and a
   `deliver` leg), then `bun LIFEOS/TOOLS/InstallAgentJobs.ts` materializes one
   launchd plist per job (`com.lifeos.job.<id>`) and registers it in the services
   list. `bun LIFEOS/TOOLS/AgentJob.ts <id>` runs one on demand. The wake-gate
   contract is unchanged: a pre-script's last stdout line is `{"wakeAgent": false}`
   to skip the model. Heartbeat's `Tick.ts` / `ArtistScan.ts` keep working: the
   runner points them at the native state dir via `HEARTBEAT_STATE_DIR`. Since
   AgentJob 1.2.0 each agent job also names a vendor and lane (top-level
   `defaults: { vendor, lane, fallback }`; `anthropic` by default since 2026-10-12:
   the claude CLI on the subscription, Haiku for low and Sonnet for medium, with
   per-job overrides to `openai` or `anthropic-api`) and the mail wake-gate only
   wakes on actionable senders. Detail: `LIFEOS/DOCUMENTATION/Tools/Tools.md` § AgentJob.ts.
2. **Move the state, not just the jobs.** Copy `$HERMES_HOME/state/` into
   `LIFEOS/MEMORY/STATE/agent-jobs/` BEFORE the first native run; the
   monitors dedupe against those checkpoints and an empty state dir re-creates
   calendar events and re-sends mail from history.

Then unload the gateway (`launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/ai.hermes.gateway.plist`,
remove the plist) and park `~/.hermes` (a rename is reversible; the delete below is
not). With no Hermes home present, `Services.ts` drops the sidecar row and
`Health.ts` reports `absent`, so nothing in Pulse turns red.


```bash
hermes plugins disable lifeos
rm -rf ~/.hermes                 # the entire install, including its own credentials
rm -rf ~/HermesWorkspace         # scratch space; check it first, it is writable
rm -f ~/.local/bin/{{DA_NAME}}   # the launcher (named after your DA)
```

Nothing under the LifeOS tree is modified by the sidecar, so removal leaves no
trace in the install.
