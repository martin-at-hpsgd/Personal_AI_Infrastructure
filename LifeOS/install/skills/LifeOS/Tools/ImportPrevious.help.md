# ImportPrevious

Copies USER data from an earlier LifeOS install, or a backup of one, into this install's USER tree. It fills missing files only, never overwrites, and lists every conflict with both sizes so the agent can offer the principal a choice. Run it after Setup has linked the USER tree, and before the Interview.

```
bun Tools/ImportPrevious.ts --from <dir>                   # dry run: what would be copied, nothing written
bun Tools/ImportPrevious.ts --from <dir> --apply           # copy the missing files
bun Tools/ImportPrevious.ts --from <dir> --apply --json    # the same, report as JSON
```

| Flag | Meaning |
|---|---|
| `--from <dir>` | Required. The earlier install or backup: an old harness root (`~/.claude` or a copy), an old data home (`~/.config/LIFEOS` or a copy), or a USER tree itself. |
| `--config-root <dir>` | The new install (default `$CLAUDE_CONFIG_DIR`, else `~/.claude`). Its `LIFEOS/USER` must already exist. |
| `--apply` | Write. Without it the run is a dry run. |
| `--dry-run` | Explicit dry run (the default). Contradicts `--apply`. |
| `--json` | Print the report as JSON instead of a summary. |
| `--allow-dev` | Write into a maintainer dev install. Sandbox use only. |

**Source shapes recognised:** `config-root` (an old root whose `LIFEOS/USER` is a real directory, `in-tree`, or a link into a data home, `linked` as in v7.40.4; a real `LIFEOS/MEMORY` beside it lands in `USER/MEMORY`), `pai-config-root` (the same under `PAI/`), `data-home` (a directory holding `USER/`), and `user-tree` (a USER tree, including a `USER.pre-link-backup-<stamp>` directory). A `linked` root whose link target is gone fails with the target named, so the agent can ask for the data-home backup instead.

**Never imported, counted by category in `skipped`:** `transcripts` (`projects/`, `transcripts/`), `harness-state` (todos, shell snapshots, plugins and the like at an old harness root), `caches`, `dependencies` (`node_modules`), `vcs` (`.git`), `runtime-state` (`MEMORY/STATE`, lock, pid and socket files), `os-junk`, `symlinks`, `special-files`, and `shadowed` (a path an earlier source already supplied: the USER tree wins over a separate legacy `MEMORY` directory). An unreadable source directory is a failure; the rest of the import goes on.

**Secrets:** no value is ever printed; only key names appear. The old `.env` is copied only when this install has none, at mode 0600. Otherwise `env.keysMissing` names the keys the old file has and this one lacks, and the agent runs `bun LIFEOS/TOOLS/Secrets.ts set <KEY>` for each. Files named like `.env` inside the USER tree are written at 0600 too.

**Report fields:** `ok`, `dryRun`, `from` (`shape`, `layout`, `userTree`, `memoryTree`, `version`), `to`, `counts` (`copied`, `identical`, `conflicts`, `skipped`, `failed`), `copied` (first 500 paths; `copiedTruncated` counts the rest), `conflicts` (`path`, `kind` content/type/symlink, `fromBytes`, `toBytes`, `destIsTemplate`), `skipped`, `failures`, `env` (`found`, `action`, `keysMissing`, `instructions`), `otherCandidates` (earlier pre-link backups worth a second run), `privateSkillsNotImported` (old `_NAME` skills this install lacks), `next`, `error`.

`destIsTemplate: true` means this install's file is still the untouched shipped template, so taking the old file loses nothing. Copied files keep their old modification times, so freshness checks still see old claims as old. `next` always ends with the Interview's ContextCheckin, so the principal reviews what came over.

**Exit:** 0 ok · 1 not ok (unrecognised source, missing USER tree, a failed copy) · 2 refused (dev install) · 64 usage error.
