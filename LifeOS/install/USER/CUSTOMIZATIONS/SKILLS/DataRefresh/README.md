---
provenance: template
version: 1.0.0
---

# DataRefresh registry

`DataRefresh/Tools/Refresh.ts` reads `Registry.json` from THIS directory (note the name: `DataRefresh`, no underscore), or from `$DATAREFRESH_REGISTRY` when that env var is set. The registry lists every data-backed public site the skill keeps fresh.

## Starting from the template

`Registry.json` here starts with an empty `targets` array, so the tool reports `not configured: ... has no targets yet` (exit 1) until you add one. The `_example` key shows a full target; move it into `targets` after replacing every value and cloning its repo. The tool ignores `_example`. `Registry.example.json` holds the same target in the older layout. A target's `repo` path must exist on disk or the registry fails to load.

## Target fields

| Field | Required | Meaning |
|-------|----------|---------|
| `name` | yes | Short id used on the command line (`refresh <name>`) |
| `repo` | yes | Site repo, `~/`-relative or absolute; must exist |
| `fetch` | yes | List of argv arrays run in the repo, in order, to repull source data |
| `build` | no | argv array to rebuild the site after the pull |
| `deploy` | no | The repo's sanctioned deploy command; only run with `--deploy` |
| `dataDir` | no | Directory of pulled JSON, default `data` |
| `timestampConvention` | no | `meta-json` (reads `_meta.fetched_at` / `_meta.fetched` / `generated` from each JSON, mtime fallback) or `mtime` |
| `cadenceDays` | yes | Days between refreshes before status reports STALE |
| `verifyUrl` | no | Live JSON endpoint probed after deploy |
| `verifyField` | no | Dot-path to the freshness timestamp in that JSON |
| `dataset` | no | Source-of-record dataset updater: `update` argv array, optional `cwd`, optional `summary` file the tool flags for hand-editing |
| `notes` | no | Free text |

Run log: `~/.claude/LIFEOS/MEMORY/OBSERVABILITY/datarefresh.jsonl`.
