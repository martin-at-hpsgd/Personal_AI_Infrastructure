# Trace

One Hermes task reconstructed end-to-end from its trace: the ask, every wall it hit, where it died, and the fix.

## Ideal State

- The reconstruction is a narrative grounded in the trace output, opening with the ask: the user message that started the task, quoted.
- When the session ran `[BLOCKED:` (no LifeOS constitution), the soul state leads the report.
- Every wall (each `GUARD-BLOCK`, `PENDING-APPROVAL`, `TOOL-ERROR`, handoff error) appears in order with what the agent was attempting, and each is named as by-design policy or false positive.
- It names where the task died: the specific call after which it stopped progressing, or the statement that it completed and the failure is elsewhere (e.g. the reply's handoff).
- It ends on one concrete fix, honest about ownership (Policy.ts/re-mount, soul sources/re-mount, approval allowlist, or upstream Hermes).

## Anti-criteria

- Never infers what "probably" happened past the end of the recorded timeline; if the records end without an answer, the report says where visibility ran out.
- Success is never judged from the execution status (`completed`, `cron_complete`); it is judged from the trace.
- Nothing in the sidecar is mutated: no config writes, no restarts, no cron edits.

## Output format

Sections in order: the ask, soul state, the walls, where it died, the fix.

## Tool contract

```bash
# 1. Find the session (skip if the user gave an id)
bun ~/.claude/LIFEOS/HERMES/Observe.ts sessions --days 2 --limit 20            # all recent
bun ~/.claude/LIFEOS/HERMES/Observe.ts sessions --source photon --days 7      # a specific platform
# 2. Trace it
bun ~/.claude/LIFEOS/HERMES/Observe.ts trace <session-id>                      # excerpted timeline
bun ~/.claude/LIFEOS/HERMES/Observe.ts trace <session-id> --full --json        # full content when excerpts hide the answer
bun ~/.claude/LIFEOS/HERMES/Observe.ts trace --last [--source X]               # most recent session
```

### Intent-to-Flag Mapping

| User says | Flags |
|-----------|-------|
| "my iMessage/text task" | `sessions --source photon` (iMessage rides the photon platform) |
| "the cron job", a job name | `sessions --source cron`, match on title |
| "just now", "the last one" | `trace --last` |
| "show me everything it did" | `trace <id> --full` |

## Gotchas

- Messaging platforms reuse long-lived sessions per chat — the user's task may be recent *messages inside an old session*, not a new session. When the platform session list looks stale, trace the platform session anyway and read its tail.
