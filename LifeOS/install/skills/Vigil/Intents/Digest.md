# Digest

The pending medium items: what the digest is holding and what the daily text limit held.

## Ideal State

- The report comes from the one held/deferred queue (`Vigil.ts queue`), so it shows what the morning brief will show: repeats, tests and injection notices already dropped, ranked by severity then recency.
- The report lists the medium-severity events waiting in the digest, grouped by source, each with its age; when the queue's cap of 10 hides some, the rest come from the digest file, read only.
- The report includes the count of events held by the daily text limit in the last 24 hours, naming the limit in force and its number: the interruption budget (`interruptions_per_day`) under `decider_mode: enforce`, `text_ceiling_per_24h` only under `shadow` or when the interruption ledger is unreadable (SKILL.md § Data & Config).
- The principal decides what to do with the items; the intent reads and reports.

## Anti-criteria

- The digest file renamed, moved, deleted or written to. It is the tick's, and the morning brief reads it through `queue`; moving it empties the brief.
- Held events listed one by one when the principal did not ask for them.

## Output format

- Group by source, newest first within a group. One line per event: age, severity, title.

## Tool contract

```bash
bun ~/.claude/LIFEOS/VIGIL/Vigil.ts queue --json --max 10 [--since 24h]               # ranked held and deferred items with source, severity and hold reason; watch-* items as one counted entry; --max caps at 10
cat "${VIGIL_STATE_DIR:-$HOME/.local/state/lifeos/vigil}/digest.jsonl"          # pending medium events, one JSON line each
bun ~/.claude/LIFEOS/VIGIL/Vigil.ts list --limit 200 --json                         # held notifications are source vigil, title "Vigil notification held"
```
