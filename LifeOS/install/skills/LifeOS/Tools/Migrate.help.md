# Migrate

Brings an older install's USER tree to the shape the current release reads. It finds the version the install came from and runs every migration in the ledger (`Tools/lib/migrations.ts`) newer than that version, in order, each exactly once. Applied ids are recorded in `<USER>/CONFIG/migrations.json`.

Every file a migration replaces or moves is first copied to `<USER>/../.lifeos-migration-backups/<run>/<path>`, and the copy is read back before the original is touched. Without `--apply` it is a dry run: it prints what each migration would do and writes nothing.

## Usage

    bun Tools/Migrate.ts                              # dry run: what would change
    bun Tools/Migrate.ts --apply                      # run the pending migrations
    bun Tools/Migrate.ts --from 7.40.4 --apply        # migrate as if coming from 7.40.4 (after ImportPrevious)
    bun Tools/Migrate.ts --mark-from 7.40.4 --apply   # record the pre-upgrade version (InstallAll does this)

## Flags

| Flag | Meaning |
|---|---|
| `--apply` (or `--yes`) | Write. Without it nothing changes. |
| `--from <version>` | The version the USER data came from. Overrides the recorded and installed versions. |
| `--mark-from <version>` | Record `pendingFrom` in migrations.json and stop; an earlier recorded version wins. |
| `--config-root <dir>` | The install (default `$CLAUDE_CONFIG_DIR`, else `~/.claude`). |
| `--user-dir <dir>` | The USER tree (default `<config-root>/LIFEOS/USER`). |
| `--templates <dir>` | The shipped USER template tree (default `pulse_templates_dir`, else the payload's `install/USER`). |
| `--allow-dev` | Allow writes on a LifeOS source tree (sandbox only). |

## From-version, first match wins

1. `--from`
2. `pendingFrom` in migrations.json
3. `<config-root>/LIFEOS/VERSION`
4. `0.0.0` (an install older than the marker: every migration is a candidate)

## Ledger

| Id | Introduced | What it does |
|---|---|---|
| `8.28.0-telos-consolidate` | 8.28.0 | Folds the v7-era split TELOS files (MISSION.md, GOALS.md, …) that carry the user's own content into one `TELOS.md` under the shipped headings, replaces a sample TELOS.md, merges into a TELOS.md the user wrote, and moves the consumed split files into the backup. |

## Output

One JSON object: `ok`, `dryRun`, `from` (`version`, `source`), `backupDir`, `record`, and per migration `status` (`applied`, `would-apply`, `noop`, `already-applied`, `not-needed`, `failed`, `not-run`), `notes` and `actions`. Exit 0 when every migration that ran succeeded; 1 on a failure; 2 on an invariant violation.

A migration that finds nothing to do is reported `noop` and not recorded, so a later `--from <old version> --apply` after importing old data still runs it.
