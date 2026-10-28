# Rebuild

A view rebuilt from the record, compared against its live file, or the whole set drilled, with the result explained.

## Ideal State

- `rebuild` writes to a scratch `--out` directory unless the principal asked to replace the live view, and the report says which.
- `compare` reports equal or the first differences, and for a multi-day check (`--days N`) says how many consecutive days compared equal.
- `drill` reports loss, per-view `equal` and `unmaterialized`, and the largest `unclaimed_by_dir` entries, each explained as migration distance, not lost data.
- `backup` and `restore-drill` report what was encrypted or verified and whether every restored file is the live file or a prefix of it.

## Anti-criteria

- Never overwrites a live view the principal did not name.
- Never treats a `compare` mismatch on an `unmaterialized` view as a data fault.
- Never runs `prune` on a stream whose retention is `forever`; every production stream is `forever`.

## Tool contract

```bash
bun LIFEOS/STATVS/Statvs.ts views [--json]
bun LIFEOS/STATVS/Statvs.ts rebuild <view> [--out DIR] [--json]
bun LIFEOS/STATVS/Statvs.ts compare <view> [--json] [--record]
bun LIFEOS/STATVS/Statvs.ts compare <view> --days N [--since ISO] [--json]
bun LIFEOS/STATVS/Statvs.ts drill [--json] [--no-record]
bun LIFEOS/STATVS/Statvs.ts backup [--json]
bun LIFEOS/STATVS/Statvs.ts restore-drill [--offsite] [--json]
```

### Intent-to-Flag Mapping

| User says | Flag | Effect |
|-----------|------|--------|
| "just check it" | `--out <scratch>` / `--no-record` | nothing live changes, no row written |
| "record it" | `compare --record` / `drill` | writes the result row to the `statvs` stream |
| "has it matched all week" | `compare <view> --days 7` | the dual-write readiness check |
| "test the offsite copy" | `restore-drill --offsite` | verifies the remote backup too |

## Output format

The command run, its verdict in one line, then the numbers that matter in a short table.
