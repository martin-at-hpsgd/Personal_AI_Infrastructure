# Status

What is going on right now, answered from the Vigil log.

## Ideal State

- The answer comes from the log: one answer, newest first, that opens with the tick's health, then names the high and critical events in the window the principal named, each with source, severity and age, and counts the rest by source and severity. With no window named, the window is what `list --limit 200 --json` returns, and the answer says how far back that reaches.
- A stale tick is the first line, in plain words, before any event, because a quiet log and a dead reader look identical otherwise.
- Events from source `vigil` (heartbeats, notification records) are folded into the health line, not listed as news.
- A question about the store itself (how many rows in the Vigil D1 database, is the store up) is answered from the store's own count with the time that count was taken and whether the store was reachable, never from the local outbox count `status` prints.

## Anti-criteria

- Any event listed before the health line, or a stale tick reported after the events.
- An event's title paraphrased into something stronger or weaker than the emitter wrote.

## Output format

- A last tick older than ten minutes is stale: the health line gives its age and says the reader may be down.

## Tool contract

```bash
bun ~/.claude/LIFEOS/VIGIL/Vigil.ts status                 # outbox, unsent, cursor ages, last tick
bun ~/.claude/LIFEOS/VIGIL/Vigil.ts heartbeat              # exit 0 fresh, 1 stale or never run
bun ~/.claude/LIFEOS/VIGIL/Vigil.ts list --limit 20        # newest first
bun ~/.claude/LIFEOS/VIGIL/Vigil.ts list --limit 200 --json
cat "${VIGIL_STATE_DIR:-$HOME/.local/state/lifeos/vigil}/cursors/store.json"   # the store's /stats as of the last tick: rows, reachable, checked_at, rows_1h, rows_24h, by_source_24h
```

Which command answers which ask:

| Principal says | Command |
|---|---|
| "anything I should know", "what's going on" | `status` then `list --limit 200 --json`, filtered in code by ts to the window |
| "is the tick alive", "is vigil running" | `heartbeat`; report the exit code in words |
| "everything from today", "show me all of it", "the last few hours" | `list --limit 200 --json`, then summarize by source and severity |
| "just the security stuff", "only critical" | `list --limit 200 --json` filtered in code by kind or severity |
| "how many rows in the D1 database", "is the store up" | `cursors/store.json`; give `rows` with `checked_at` |
