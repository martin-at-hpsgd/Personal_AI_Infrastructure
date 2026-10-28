# Status

Show current state.

## Ideal State

- The user sees the current snapshot at a glance: each dimension's latest value, how old it is, and any note.
- Stale and never-logged dimensions are flagged in one closing line as the prompt to update, since prompting an update is half the point.
- A history question ("how has my mood been this week") is answered from a direct read of `LIFEOS/USER/STATE/log.jsonl`, summarized.

## Anti-criteria

- The stale and never-logged flag is never a lecture: one line.
- No correlation analysis beyond a quick read of the log; that belongs to a future Correlate intent.

## Tool contract

```bash
bun ~/.claude/LIFEOS/TOOLS/State.ts current          # human view
bun ~/.claude/LIFEOS/TOOLS/State.ts current --json   # for computation
```

## Output format

Render the tool output as a short table or bullet list, with the freshness tier the tool computes per dimension (SKILL.md § Gotchas).
