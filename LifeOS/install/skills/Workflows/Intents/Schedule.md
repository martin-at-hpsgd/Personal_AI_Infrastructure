# Schedule

A time trigger put on a workflow ("schedule this", "run it every night", "once, next Tuesday") with its clock installed.

## Ideal State

- The trigger type fits the request as `Format.md` § Triggers maps it. A clock-time `schedule` or `once` trigger carries the zone the principal named, else `principalTimezone()` (`LIFEOS/TOOLS/lib/Timezone.ts`: the current-location zone, with the configured home zone only as the fallback), so "at 9" means 9 where the principal is. The report names the zone used, and says so when it differs from the home zone, because a stored schedule keeps the zone it was written with.
- The definition's `triggers` keep the `manual` trigger unless the principal said otherwise.
- `workflow validate` exits 0, and the principal has the next few fire times from `workflow next` in 24-hour format with the timezone.
- The schedule is reported live only after the dispatcher was shown alive and the next fire was shown (SKILL.md § Gotchas, the dispatcher rule): the definition validates with the trigger enabled, `launchctl list | grep com.lifeos.workflows-dispatcher` shows the dispatcher loaded, `bun LIFEOS/VIGIL/Vigil.ts heartbeat --json` shows its `workflows-dispatcher` row not stale where Vigil is installed, and `workflow next <name> --json` shows the next fire. A dispatcher that is not loaded or whose heartbeat is stale means nothing will fire it, and that is said and fixed first.
- A scheduled definition with `money`, `deploy` or non-principal `outbound` steps has a `human` approval ancestor, and the principal knows each run parks until answered.

## Anti-criteria

- Never a guessed timezone.
- Never a flag assumed from memory: exact usage comes from `help --json`.
- No pause before the principal says so.

## Safety gates

- **Side effects still need a human gate.** The validator enforces the `human` approval ancestor above. Scheduled monitoring that only alerts the principal uses `recipient: principal`.
- **Pause.** `bun LIFEOS/WORKFLOWS/workflow.ts pause <name>` sets `enabled: false`, and the dispatcher skips it from then on (the command reports `the dispatcher skips it`); `resume <name>` reverses it. `pause --all` stops the whole fleet. Pause only after the principal says so, and confirm from the command's own report.

## Tool contract

1. **Pick the trigger type** from `Format.md` § Triggers:
   - Recurring at clock times: `schedule` with a five-field `cron` and an IANA `timezone`. Unless the principal named a zone, read it with `bun -e 'import { principalTimezone } from "./LIFEOS/TOOLS/lib/Timezone.ts"; console.log(principalTimezone())'` from the config root; never copy it from the identity file.
   - Every N minutes: `interval` with `minutes`.
   - One future time: `once` with an ISO `at` whose offset is that zone's offset on that date.
   - `missed_run: skip` unless the principal wants one catch-up run after sleep, then `once`.
2. **Edit the definition's `triggers` list** in the definitions home, or write it with `workflow schedule <name> --cron EXPR --tz TZ | --every N | --at ISO | --in DURATION | --remove TRIGGER`, which writes the trigger and reports `scheduled by com.lifeos.workflows-dispatcher`.
3. **Validate.** `bun LIFEOS/WORKFLOWS/workflow.ts validate <name>`. A bad cron, a timezone that is not IANA, or an `at` without an offset fails here.
4. **Show the fire times.** `bun LIFEOS/WORKFLOWS/workflow.ts next <name>`; add `--at <ISO>` to check a specific window, such as a daylight-saving change.
5. **Check the dispatcher is alive.** No workflow has its own launchd job. If the trigger went in through `workflow schedule`, read its report line (`scheduled by com.lifeos.workflows-dispatcher`, or `the dispatcher skips it` for a paused definition). After a hand edit, run `bun LIFEOS/WORKFLOWS/engine/schedule-install.ts install <name>`: it only checks that the schedule compiles, removes any leftover per-workflow job, and makes sure the dispatcher is installed and loaded. Then confirm with `launchctl list | grep com.lifeos.workflows-dispatcher`, `bun LIFEOS/VIGIL/Vigil.ts heartbeat --json` (the `workflows-dispatcher` row not stale), and `workflow next <name> --json`.

### What exists today

One launchd job, `com.lifeos.workflows-dispatcher`, runs `engine/dispatcher.ts serve` under KeepAlive. Each minute it evaluates every local `schedule`, `interval` and `once` trigger, and it starts `after:` and `event` workflows. Cloud workflows are scheduled by their own runner, never by the Mac. Check `help --json` for exact usage of every flag above.
