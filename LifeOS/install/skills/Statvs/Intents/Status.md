# Status

A health report on the record itself: is the chain intact, is anything being refused or spooled, how much state can be rebuilt, and how far the migration has come.

## Ideal State

- The report opens with the `verify` verdict (ok, or each problem with its segment), because every other number means nothing on a broken chain.
- It gives the counters (`refused`, `spooled`, `quarantined`, `drained`) and says that each is a running total, plus any spool that has not drained.
- It gives the drill's loss count and explains it as unclaimed STATE files by directory, alongside each registered view's `equal` and `unmaterialized` flags.
- It says which systems sit at which of the five migration steps, read from the ISA's Decisions and features when the ISA is present, and says so when it is absent.

## Anti-criteria

- Never calls the record healthy on a passing `drill` alone: `verify` ran and passed.
- Never reports the drill loss as lost data, and never reports `refused` as today's count.
- Never runs `drill` without `--no-record` unless the principal asked for the result to be recorded.

## Tool contract

Run from the config root (`$CLAUDE_CONFIG_DIR`, else `~/.claude`).

```bash
bun LIFEOS/STATVS/Statvs.ts verify --json           # {"ok":true,"problems":[]} or the failing segments
bun LIFEOS/STATVS/Statvs.ts counters                 # {"refused":N,"spooled":N,"quarantined":N,"drained":N}
bun LIFEOS/STATVS/Statvs.ts views                    # name [group] streams class -> output path
bun LIFEOS/STATVS/Statvs.ts drill --json --no-record # loss, per-view equal/unmaterialized, unclaimed_by_dir
```

### Intent-to-Flag Mapping

| User says | Flag | Effect |
|-----------|------|--------|
| "check each privacy class" | `verify --classes` | verdict per class directory |
| "record today's drill" | `drill` (no `--no-record`) | writes the drill row to the `statvs` stream |
| "check the backup too" | `restore-drill --json` | decrypts the backup to a temp folder and verifies it |

## Output format

One opening line with the verify verdict, then a small table of counters, views and drill loss, then one line per system in migration with its step.
