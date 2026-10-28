# Status

A one-screen report on whether the Hermes sidecar is healthy and whether it is actually running LifeOS.

## Ideal State

- The report answers two questions, is the sidecar healthy and is it actually running LifeOS, each with evidence from the tool output.
- It states the process state (`up`/`degraded`/`flapping`/`down`/`absent`) and any named problems; an absent install is reported as `absent` plainly, as a valid state.
- It gives the soul verdict: of the sessions in the last 24h, how many loaded the LifeOS constitution vs started `[BLOCKED:`, and any nonzero blocked count is the lead finding.
- It states mount drift as `current` or `stale`, and stale names re-running `Mount.ts` as the next action.
- It lists the 7-day failure classes with counts, one line each, and ends on one concrete next action; when everything is green it says so and stops.

## Anti-criteria

- A nonzero soul-blocked count is never a footnote.
- The soul-loaded check never comes from an ad-hoc `system_prompt LIKE '[BLOCKED:%'` query; it comes from `Observe.ts status`.
- An absent install is never reported as an error.
- Nothing in the sidecar is mutated: no config writes, no restarts, no cron edits.

## Output format

One screen.

## Tool contract

```bash
bun ~/.claude/LIFEOS/HERMES/Observe.ts status --json   # health + soul-loading + 7d failure classes
bun ~/.claude/LIFEOS/HERMES/Mount.ts --check           # identity/config drift (report-only)
```

`Health.ts` detail (per-channel state, restarter-loop detection) is already inside `Observe.ts status`; run `bun ~/.claude/LIFEOS/HERMES/Health.ts --json` directly only when the channel detail matters.
