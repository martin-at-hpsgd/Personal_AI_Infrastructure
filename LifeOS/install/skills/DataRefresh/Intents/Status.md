# Status

Report data freshness across every registered data-backed property.

## Ideal State

- The principal sees, in one table, every registered target with its last-pull date, age vs cadence, and STALE/FRESH state.
- Live-site freshness is in the table when asked ("check the live sites too" → `--live`).
- The table comes with a one-line read of what is stale and what refreshing it would take.
- When anything is STALE, the Refresh intent is offered.

## Anti-criteria

- Refresh is never run unbidden; refresh (and especially deploy) is its own election.

## Output format

- Present the table as-is; it is already aligned.

## Tool contract

```bash
bun ~/.claude/skills/DataRefresh/Tools/Refresh.ts status [target] [--live]
```

Exit 0 = all fresh · exit 2 = at least one STALE/UNKNOWN · exit 1 = registry error or no target by that name.
