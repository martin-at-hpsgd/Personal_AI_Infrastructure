# Vigil

**Contents:** What it does · Fill in · Accounts and secrets · Prove it works

Status: bun ~/.claude/LIFEOS/VIGIL/Vigil.ts heartbeat · optional

**macOS only.** The five-minute tick is a launchd agent (`InstallVigil.ts` writes `~/Library/LaunchAgents/com.lifeos.vigil.plist`), and texts go through Relay, which runs on a Mac with Messages. The engine's code runs elsewhere, but nothing schedules the tick there.

## What it does

Vigil is the one event log your LifeOS writes to when something happens, plus a five-minute reader that decides whether you need to hear about it. Subsystems and scheduled jobs post events in one schema to a local outbox. Every five minutes the tick collects events from its adapters, routes each new event by severity (a text to your phone, a line in the morning digest, or the dashboard only), and keeps a heartbeat so a dead reader never looks like a quiet day.

You extend it with three kinds of your own pieces, and this guide gives a made-up example of each:

- A **routing policy** (`policy.json`) that says which severities text you, how many texts a day you allow, and how often each source is expected to report.
- An **adapter**: a small module the tick reads every five minutes, which turns a change in some ledger or status file into an event.
- A **monitor workflow**: a scheduled job that checks something and posts an event with `Vigil.ts emit`. Most new monitors should be workflows; write an adapter only when the thing you watch already keeps its own state file.

The engine ships in `LIFEOS/VIGIL/`. Your policy, monitors and editor profile live under `LIFEOS/USER/`, which never ships.

## Fill in

Everything is optional: with no files at all, Vigil runs on the defaults in `LIFEOS/VIGIL/Policy.ts` and works from the local outbox alone.

| File | What it holds | Needed for |
|---|---|---|
| `LIFEOS/USER/VIGIL/policy.json` | Routing policy; every key optional; a missing key, or a severity missing from `routes`, takes the default | Changing routes, limits, caps |
| `LIFEOS/USER/VIGIL/editor-profile.md` | What the optional model editor knows about you | Only when `editor_enabled` is `true` |
| `LIFEOS/USER/VIGIL/worker.json` | The D1 database the optional store Worker binds to | Only to deploy `LIFEOS/VIGIL/worker` |
| `LIFEOS/USER/VIGIL/editor-feedback.jsonl` | Your `good`, `noise` or `missed` labels on the editor's picks, written by `Vigil.ts feedback`; the editor's prompt reads the latest ones | Created on your first label; only matters with the editor on |
| `LIFEOS/USER/VIGIL/shadow-feedback.jsonl` | Your labels on shadow pairs (a scheduled job's own text beside what Vigil would have done), written by `Vigil.ts feedback` | Created on your first label; used to decide when to switch `decider_mode` to `enforce` |

`LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Vigil/Config.md` is a pointer only: its `policy`, `editor_profile` and `worker` keys name the three files above, so nothing is kept twice. Edit the files it names, never the pointer.

The installer puts all three starter files plus a README in `LIFEOS/USER/VIGIL/`. If a file is missing, `bun ~/.claude/skills/LifeOS/Tools/ScaffoldUser.ts --apply` copies any missing starter file into place and never overwrites one you have edited. `LIFEOS/USER` resolves under `$CLAUDE_CONFIG_DIR` when set, else `~/.claude`.

### Example 1: a starter routing policy

This is the shipped starter `LIFEOS/USER/VIGIL/policy.json`, for a made-up install that watches one service called `example-service`:

```json
{
  "routes": { "critical": "text", "high": "text", "medium": "digest", "low": "pulse", "info": "pulse" },
  "text_ceiling_per_24h": 4,
  "text_ceiling_exempt": ["heartbeat:"],
  "digest_hour_local": 8,
  "text_trusted_sources": ["services", "errata", "socrates", "achilles", "example-service"],
  "source_severity_ceiling": { "example-feed": "medium" },
  "source_text_cap_per_24h": { "example-service": 2 },
  "source_cadence_minutes": { "services": 5, "example-service": 15 },
  "editor_enabled": false,
  "decider_mode": "shadow"
}
```

| Key | Meaning in this example |
|---|---|
| `routes` | Critical and high text you; medium goes to the digest (no text); low and info show on the dashboard only |
| `text_ceiling_per_24h` | At most four texts in any 24 hours from ordinary events; more are held for the digest, never sent late. Critical events are never held by this ceiling, and neither is anything matching `text_ceiling_exempt`; both still count toward the four |
| `text_ceiling_exempt` | Events whose ref or title contains `heartbeat:` skip that ceiling, so "a watcher died" is never stuck behind routine texts |
| `digest_hour_local` | Reserved for a scheduled digest; nothing in the engine reads it yet, so setting it changes nothing. See "The digest" below |
| `text_trusted_sources` | Only these sources may reach a text at all; an event from any other source that would have texted goes to the dashboard instead |
| `source_severity_ceiling` | `example-feed` can never rise above medium, however it labels itself |
| `source_text_cap_per_24h` | `example-service` may text at most twice a day (critical is exempt) |
| `source_cadence_minutes` | The dashboard marks `example-service` quiet when nothing arrives for twice this long. Nothing is texted for a quiet source, so a monitor that should prove it is alive also emits an `info` event when its check passes |
| `editor_enabled` | The model editor stays off, so no event is ever sent to a model |
| `decider_mode` | `shadow` records what Vigil would do with your scheduled jobs' own texts without changing them; `enforce` makes Vigil the one that sends them |

### The digest

Vigil sends no digest message on its own. Each tick writes every event routed to `digest`, and every text a ceiling or hold kept back, to `digest.jsonl` in Vigil's state directory as soon as it routes them. The dashboard shows them, and `bun ~/.claude/LIFEOS/VIGIL/Vigil.ts queue` lists the top three from the last 24 hours, ranked by severity and then recency, with repeats dropped and watch events folded into one line (`--max` raises the count to 10). For a morning summary, schedule that command as a workflow at the hour you want. This one runs at 08:03 in the zone you name; save it as `LIFEOS/USER/WORKFLOWS/vigil-morning-summary.workflow.yaml` and install it the same way as Example 2:

```yaml
version: 2
name: vigil-morning-summary
description: "Morning summary: what Vigil routed to the digest or held in the last 24 hours, ranked."
runs_on: local
destination: "the workflow run ledger"
triggers:
  - type: manual
  - type: schedule
    cron: "3 8 * * *"
    timezone: America/New_York
    missed_run: skip
steps:
  queue:
    kind: command
    description: "Write the ranked held and digest queue for the last 24 hours to morning-summary.txt in Vigil's state directory."
    side_effects: [ read, write ]
    env: [ VIGIL_STATE_DIR, CLAUDE_CONFIG_DIR ]
    timeout_ms: 60000
    argv:
      - sh
      - -c
      - 'f="${VIGIL_STATE_DIR:-$HOME/.local/state/lifeos/vigil}/morning-summary.txt"; bun "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/LIFEOS/VIGIL/Vigil.ts" queue --max 10 > "$f" && printf "{\"path\":\"%s\"}\n" "$f"'
    output: { type: object, required: [ path ], properties: { path: { type: string } } }
result: { $ref: steps.queue.output }
```

Each run rewrites `morning-summary.txt` in Vigil's state directory; the workflow ledger keeps only a hash of a run's output, so the file is where the list lives. To have it reach you, add a step after `queue` that sends that file wherever you read things.

### Example 2: a monitor workflow

A heartbeat watch on a made-up service. Save it as `LIFEOS/USER/WORKFLOWS/watch-example-service.workflow.yaml`, then check it with `bun ~/.claude/LIFEOS/WORKFLOWS/workflow.ts validate watch-example-service` and put it on its schedule with `bun ~/.claude/LIFEOS/WORKFLOWS/engine/schedule-install.ts install watch-example-service`.

```yaml
version: 2
name: watch-example-service
description: "Heartbeat watch: probe example-service's health URL every 15 minutes and post a high Vigil event when it fails."
runs_on: local
destination: "the Vigil outbox, source example-service"
triggers:
  - type: manual
  - type: schedule
    cron: "7-59/15 * * * *"
    timezone: UTC
    missed_run: skip
steps:
  probe:
    kind: command
    description: "curl the health URL; on failure emit one high event, with the hour in --ref so each hour of an outage is one story."
    side_effects: [ read, write ]
    env: [ VIGIL_STATE_DIR, LIFEOS_NOTIFICATION_CHANNEL, CLAUDE_CONFIG_DIR ]
    timeout_ms: 60000
    argv:
      - sh
      - -c
      - 'curl -fsS -m 10 https://status.example.com/health >/dev/null && echo "{\"ok\":true}" || { bun "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/LIFEOS/VIGIL/Vigil.ts" emit --source example-service --kind infra --severity high --title "example-service health check failed" --summary "The health check did not return 2xx at $(date -u +%H:%M) UTC." --ref "health:$(date -u +%Y%m%d%H)" >&2 && echo "{\"ok\":false}"; }'
    output: { type: object, required: [ ok ], properties: { ok: { type: boolean } } }
result: { $ref: steps.probe.output }
```

The runner reads the step's stdout as one JSON value, so the step prints nothing else there: `emit` prints a confirmation line, which the example sends to stderr with `>&2`, and the `&&` keeps emit's exit status, so a failed emit fails the step instead of reporting `{"ok":false}`. Run it once by hand with `bun ~/.claude/LIFEOS/WORKFLOWS/workflow.ts run watch-example-service` before you schedule it.

Because the policy above lists `example-service` as text-trusted and its event is `high`, a failed check becomes a text. `emit` itself never de-duplicates: every failed check appends an event. What keeps a long outage quiet is downstream. The event's dedup key is `<source>:<ref>:<severity>` (here `example-service:health:<hour>:high`), so the store keeps one row per hour; the tick holds a second text about the same story within 72 hours, so the three later checks in that hour are held; and each new hour, a new story, is still bounded by `source_text_cap_per_24h` (two a day here) and the daily text ceiling. Keep event titles and summaries to what happened: the emitter refuses anything shaped like a credential and a few health and money values, but nothing else, so keeping personal details out of titles and summaries is up to you.

### Example 3: an adapter

Use an adapter when the thing you watch already writes its own status file. This made-up one (source `example-service`, the same service as the examples above) reads `~/.local/state/example-service/status.json` (`{ "ok": true, "checked_at": "<ISO time>" }`), which a health job of your own keeps current, and reports only flips. Save it as `LIFEOS/USER/VIGIL/adapters/example-service.ts`, the folder for your own adapters:

```ts
/** example-service health flips, read from the status file its own health job writes. @version 0.1.0 */
import { homedir } from "node:os"; import { join } from "node:path";
import type { VigilEvent } from "../../../VIGIL/Schema"; import type { Kit } from "../../../VIGIL/adapters/kit";

let clock: Kit["clock"], event: Kit["event"], jsonFile: Kit["jsonFile"], need: Kit["need"], withCursor: Kit["withCursor"];
/** The engine passes its helpers in through read(kit), so this file has no runtime import into the engine. Tests call bind first. */
export function bind(kit: Kit): void { ({ clock, event, jsonFile, need, withCursor } = kit); }

export type Snapshot = { ok: boolean; checked_at: string };

/** Events come only from a change between two reads; the first read is a baseline and says nothing. */
export function diff(prev: Snapshot | undefined, next: Snapshot): VigilEvent[] {
  if (!prev || prev.ok === next.ok) return [];
  return next.ok
    ? [event("example-service", "health", "up", "info", "example-service is healthy again", `Health check passed at ${clock(next.checked_at)}.`, "infra", null, next.checked_at)]
    : [event("example-service", "health", "down", "high", "example-service is down", `Health check failed at ${clock(next.checked_at)}.`, "infra", null, next.checked_at)];
}

/** A reshaped status file, or one that disappears after a good read, is an error, never an empty read, so a blind adapter shows up in Vigil's reader health. A file that has never existed reads as not installed. */
export async function live(): Promise<Snapshot> {
  const s = jsonFile<{ ok?: unknown; checked_at?: unknown }>(join(homedir(), ".local/state/example-service/status.json"));
  need(typeof s.ok === "boolean" && typeof s.checked_at === "string", "example-service status ok and checked_at");
  return { ok: s.ok, checked_at: s.checked_at };
}

export const read = (kit: Kit) => { bind(kit); return withCursor("example-service", live, diff); };
```

That is all the registration it needs: the registry (`LIFEOS/VIGIL/adapters/index.ts`) is every file that exports `read` in the engine's folder and in `LIFEOS/USER/VIGIL/adapters/`, so saving the file registers it and deleting it unregisters it. A name in both folders stops discovery with an error rather than picking one. A file you want to keep but not run gets `@vigil-adapter retired` in its header comment, and a second file that posts under the same source gets `@vigil-adapter part-of <name>`. Use the adapter's file name as its event source (here `example-service`) and add that name to `text_trusted_sources` if its high events should text you. An adapter whose source has never existed on your machine reads as not installed: no events, no failed read, and no "Vigil is blind" alarm, until the source appears and its first read succeeds. Your adapter takes engine helpers from the kit the engine passes to `read` (`LIFEOS/VIGIL/adapters/kit.ts` lists them; `event`, `jsonFile`, `need` and `withCursor` are documented in `LIFEOS/VIGIL/adapters/common.ts`), never by a relative import: `LIFEOS/USER` is a symlink, and a relative import resolves from its real folder outside the engine. `import type` lines are fine, since they are erased before the file runs. A LifeOS update replaces the engine's folder and never touches `LIFEOS/USER`.

## Accounts and secrets

None for a local-only setup: the outbox, the tick and the dashboard need no account.

- **Texts to your phone** go through Relay, a texting bridge; set it up from the Relay skill's Setup.md where that skill is installed. Until it is in place, Vigil has no way to text you, so set `high` (and `critical`) to `digest` in `routes`.
- **Slack direct message** (optional second channel): put your Slack member id in `dm_mirror_user_id` in `policy.json` and the bot token in `~/.claude/.env` under `VIGIL_SLACK_BOT_TOKEN` (or the name you set in `dm_mirror_token_env`). `dm_mirror_on` picks what is mirrored: `text` (every text Vigil sends you) and `workrepo` (every issue it files).
- **The model editor** (optional, `editor_enabled: true`) calls OpenAI through LifeOS's Inference tool, so it needs the OpenAI key your install already uses for that lane.
- **The store** (optional): a Cloudflare account, with `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in `~/.claude/.env`. Every Cloudflare call goes through `LIFEOS/TOOLS/CfEnv.ts`, which injects those two keys into that one command and, on a deploy, first runs an independent code review of the Worker and stops on a blocker. With `VIGIL_URL` unset, Vigil works from the local outbox.

  Check these before step 4, since the deploy refuses to start without them:

  - `LIFEOS/VIGIL/worker` is inside a git repository. The review (`LIFEOS/TOOLS/Review.ts`) reads the diff from git, and with no repository it cannot run, so the deploy stops.
  - Everything under `LIFEOS/VIGIL/worker` is committed. The deploy ships committed code only, so uncommitted files in that folder stop it before any review runs. Commit them first; `--allow-dirty "<reason>"` lifts that one block and the review still runs.
  - The reviewer is reachable. The review calls a model from the vendor that did not write the code, through LifeOS's Inference tool: OpenAI for code written with Claude or not yet committed, Anthropic for code only OpenAI wrote. That vendor's key must be in `~/.claude/.env`. An unreachable reviewer stops the deploy.
  - The override exists and records why. `--waive-blockers "<reason>"` (run the deploy script's own command with it: `cd LIFEOS/VIGIL/worker && bun ../../TOOLS/CfEnv.ts deploy --waive-blockers "<reason>"`) lets reviewer blockers or a reviewer outage through and deploys unreviewed. It never lifts the uncommitted-files block, and the next deploy reviews the waived span again.

  Run from `~/.claude`:

  ```bash
  # 1. Create the database, then put the id it prints into LIFEOS/USER/VIGIL/worker.json as d1.id.
  bun LIFEOS/TOOLS/CfEnv.ts d1 create --name vigil-db
  # 2. Apply the schema (safe to re-run). <id> is the database id from step 1.
  bun LIFEOS/TOOLS/CfEnv.ts d1 query <id> --sql "$(cat LIFEOS/VIGIL/worker/schema.sql)"
  # 3. Make a bearer token for this Mac and register only its SHA-256 hex digest.
  TOKEN=$(openssl rand -hex 32)
  HASH=$(printf %s "$TOKEN" | shasum -a 256 | cut -d' ' -f1)
  bun LIFEOS/TOOLS/CfEnv.ts d1 query <id> --sql "INSERT INTO emitters (name, token_hash) VALUES ('this-mac', '$HASH')"
  # 4. Deploy the Worker. The code review runs first; any of the checks above failing stops the deploy.
  (cd LIFEOS/VIGIL/worker && bun install && bun run deploy)
  ```

  Then put the Worker's URL (`https://lifeos-vigil.<your-subdomain>.workers.dev`, printed by the deploy) and `$TOKEN` in `~/.claude/.env` as `VIGIL_URL` and `VIGIL_TOKEN`. Never put the token itself in the database or a URL.

## Prove it works

Install the tick with `bun ~/.claude/LIFEOS/VIGIL/InstallVigil.ts`, wait six minutes, then run:

```bash
bun ~/.claude/LIFEOS/VIGIL/Vigil.ts heartbeat && bun ~/.claude/LIFEOS/VIGIL/Vigil.ts status
```

Success: `heartbeat` exits 0, which means the last tick ran within ten minutes, and `status` prints JSON whose `last_tick.ts` is from the last few minutes, with one cursor per adapter present on your machine. To check your policy file is the one in force, run `bun -e 'const { loadPolicy } = await import(process.env.HOME + "/.claude/LIFEOS/VIGIL/Policy.ts"); console.log(JSON.stringify(loadPolicy().text_ceiling_per_24h))'`; it prints the ceiling you set (`4` for the starter policy). The very first tick routes nothing and prints `{"baseline":true,...}`: it records the backlog as already seen, so setting Vigil up never sends a burst of old texts.
