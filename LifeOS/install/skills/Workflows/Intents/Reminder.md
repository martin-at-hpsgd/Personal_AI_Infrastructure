# Reminder

Turn "remind me to X on <date>", "follow up on", "check back on" into a one-shot workflow that texts the principal at that time.

## Ideal State

- A definition `followup-<slug>` in the definitions home with a `manual` trigger and a `once` trigger at the requested time: an ISO `at` with the offset, for that date, of the zone the principal named or else `principalTimezone()` (the current-location zone, home only as the fallback; `Schedule.md` § Tool contract, step 1 reads it), so daylight saving and travel both change it; 09:00 local when only a day was given, `missed_run: once`.
- One `command` step that delivers the reminder text with `recipient: principal` and `side_effects: [ write, outbound ]`. Where Vigil (the optional monitoring layer) is installed, the step hands the text to Vigil with `--class prep` and a dedup `--key followup:<slug>:due` (why `prep`: SKILL.md § Gotchas); without Vigil, the step calls whatever notifier the install has (a text or email command).
- The reminder text lives in a file under the principal's CUSTOMIZATIONS tree, written for a text message: what to do and the first concrete step, under 400 characters.
- `workflow validate` exits 0, `workflow next` shows the intended local time, `launchctl list | grep com.lifeos.workflows-dispatcher` shows the dispatcher loaded, and where Vigil is installed its `workflows-dispatcher` heartbeat row is not stale.
- After it fires, the text is confirmed sent, not assumed. With Vigil, `bun LIFEOS/VIGIL/Vigil.ts list --source vigil --json` shows a `Vigil notification sent` row whose `meta.key` is `followup:<slug>:due`.
- The principal hears the date and time it fires and the workflow name, in one line.

## Anti-criteria

- A reminder, a follow-up or any scheduled or recurring work is never only a work-repo issue or task-list row: either may link to the workflow but never replaces it.
- Never a live `workflow run` of a reminder: it texts now; the run is `--dry-run` only.
- A reminder never uses `--class ops`: an ops text can be held (and a held text is never sent later) or reworded.
- The principal is never reported reminded on assumption: a `Vigil notification held` or `failed` row for its key means the principal was not reminded, and that is said.

## Tool contract

```bash
bun LIFEOS/WORKFLOWS/workflow.ts new followup-<slug>          # then replace the template body
bun LIFEOS/WORKFLOWS/workflow.ts validate followup-<slug>
bun LIFEOS/WORKFLOWS/workflow.ts next followup-<slug>
bun LIFEOS/WORKFLOWS/workflow.ts run followup-<slug> --dry-run # never a live run: it texts now
bun LIFEOS/WORKFLOWS/engine/schedule-install.ts install followup-<slug>   # checks the schedule compiles and the dispatcher is loaded
launchctl list | grep com.lifeos.workflows-dispatcher
```

Step shape for a Vigil install (without Vigil, replace `argv` with the install's own notifier command):

```yaml
  remind:
    kind: command
    side_effects: [ write, outbound ]
    recipient: principal
    env: [ VIGIL_STATE_DIR, LIFEOS_NOTIFICATION_CHANNEL ]
    timeout_ms: 60000
    argv: [ bun, "<configRoot>/LIFEOS/VIGIL/Vigil.ts", emit, --text-file, "<reminder text file>", --source, followups, --key, "followup:<slug>:due", --class, prep ]
    output: { type: object, required: [ outcome ], properties: { outcome: { type: string } } }
```

A command step must print one JSON value on stdout; `Vigil.ts emit --text-file` prints its outcome as JSON, which `output` describes. A notifier that prints plain text needs a wrapper that prints one JSON object.

A reminder written earlier with `--severity high --class ops` should move to `--class prep` before it fires.

Where the install has `LIFEOS/TOOLS/FollowUpCheck.ts` (not in the public release), a follow-up that waits on a mail reply instead runs it on a `schedule` trigger (see any existing mail-reply `followup-<slug>` definition in the definitions home for its stdin fields); without it, use a `schedule` trigger that calls the install's own mail-check command. Remove the workflow (`workflow remove`) when the thing it watches closes.
