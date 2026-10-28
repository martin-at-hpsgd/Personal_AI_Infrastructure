# Emit

Post one event to the Vigil outbox and report whether it will route.

## Ideal State

- One line is appended to the local outbox that the next tick will route, carrying a source the policy knows, a severity the principal would agree with, a title under 140 characters, and no Restricted Data.
- The report says "emitted" only alongside a fresh heartbeat (`Vigil.ts heartbeat` exits 0 after the emit); when it exits 1 the report says the tick is stale and nothing will route the line until it is back.
- For a `high` or `critical` event, the report names the routing decision after the next tick: texted, held with its reason, failed, or sent to the dashboard or digest.
- A job that has words for the principal hands them to Vigil with `emit --text-file`, never by calling Relay itself; the report gives the `outcome` and `reason` from the JSON line it prints (`sent`, `held`, `failed`, `queued`, `claimed`, `not-sent-shadow`), and `queued` means the next tick decides.

## Anti-criteria

- A refused event retried with the sensitive part reworded; a refusal is reported with the refusal reason.
- Treating the `emit` exit code as proof the event will route; it proves only that the line was written.
- Implying that `critical` from an ad hoc source will text the principal; a source not listed as text-trusted caps at the dashboard regardless of severity.
- A summary event that bundles several unrelated things; one event per fact.

## Safety gates

- `summary` carries what happened and where to look, never the value: no amounts, readings, names, email text, or credentials. The emitter refuses credential shapes and raw health or money values; a refusal is the right outcome, so report it.
- A job text's words go only to the local 0600 draft file (`shadow-drafts.jsonl` in the state dir); the outbox event carries a hash, never the words. Never paste the text into `--title` or `--summary` of a plain emit to get it routed.

## Tool contract

With a fresh heartbeat the next tick routes the line within about five minutes. For a `high` or `critical` event, read the route the policy gives that severity and whether the source is text-trusted (`routes` and `text_trusted_sources` in `LIFEOS/USER/VIGIL/policy.json`): an untrusted source goes to the dashboard whatever its severity. After the next tick, find the event's `id` with `Vigil.ts list --source <source> --json`, then the row in `Vigil.ts list --source vigil --json` whose `ref` is that id. `Vigil notification sent` means it texted; `held` (its summary carries the reason: quiet hours, the 72h story hold, the daily budget) or `failed` means it did not. No row means it went to the dashboard or digest. Say which.

```bash
bun ~/.claude/LIFEOS/VIGIL/Vigil.ts emit \
  --source <emitter name> \
  --kind <health|security|money|customer|news|life|ai|infra|notification|other> \
  --severity <info|low|medium|high|critical> \
  --title "<what happened, under 140 chars>" \
  --summary "<one or two sentences, coarse, no values>" \
  [--ref <id in the emitter's own store>] [--url <link back>] [--privacy <public|personal|customer>]
bun ~/.claude/LIFEOS/VIGIL/Vigil.ts forward     # ship unsent lines when a store is configured
bun ~/.claude/LIFEOS/VIGIL/Vigil.ts heartbeat   # exit 0: the tick is fresh; exit 1: stale, nothing routes
bun ~/.claude/LIFEOS/VIGIL/Vigil.ts list --source vigil --json   # after the next tick: the routing outcome rows
```

Job text (F12), the one emit form open to agent jobs (`AGENTJOB_ID` set):

```bash
bun ~/.claude/LIFEOS/VIGIL/Vigil.ts emit --text-file <path> \
  [--source <job source, default agentjob>] [--ref <job id>] \
  [--class <security|prep|decision|ops|news>] [--key <story key, no spaces>] \
  [--severity <info|low|medium|high|critical>] [--now]
# the text file is non-empty and at most 4000 characters; --source vigil is refused
# --now under decider_mode enforce sends prep, decision and high-or-above security in this process;
#   ops and news still wait for the tick (story hold, editor); under shadow nothing is sent (not-sent-shadow)
# prints one JSON line {event_id, class, mode, outcome, reason}; exits 1 when outcome is failed
```

Severity and privacy flag values:

| Situation | Severity |
|---|---|
| Something the principal must act on within the hour | `critical` |
| Something the principal would want to know today | `high` |
| Worth reading in the next digest | `medium` |
| Context, no action | `low` or `info` |

| Content | privacy_class |
|---|---|
| Public news or public infrastructure | `public` |
| The principal's own life, work, or systems | `personal` |
| Anything about a customer or a customer's app | `customer` |
