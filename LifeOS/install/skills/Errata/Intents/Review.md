# Review

Show recent errata so the principal can see what the ledger holds.

## Ideal State

- A short table of the last entries (default 20) is shown: id, when, system, kind, status, the first line of the complaint, and whether it is enriched.
- Filters the principal names map straight to flags, per the table under Tool contract.

## Anti-criteria

- Never drops or reinterprets a filter the principal named.

## Tool contract

```bash
bun ~/.claude/LIFEOS/ERRATA/Errata.ts list [--limit 20] [--system <name>] [--kind <kind>] [--status <status>] [--since <ISO>] [--unenriched] [--json]
bun ~/.claude/LIFEOS/ERRATA/Errata.ts show <id>
bun ~/.claude/LIFEOS/ERRATA/Errata.ts stats --json
```

| Principal says | Flag |
|---|---|
| "the bugs", "just bugs" | `--kind bug` |
| "about my project" | `--system <project-name>` |
| "the ones nobody looked at" | `--status new` or `--unenriched` |
| "this week" | `--since <ISO of 7 days ago>` |
