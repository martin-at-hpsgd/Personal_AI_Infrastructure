# DataRefresh

Status: bun ~/.claude/skills/DataRefresh/Tools/Refresh.ts status · optional

## What it does

DataRefresh keeps data-backed websites current. You register each site as a target: where its repo lives, the commands that pull fresh source data, an optional command that updates a source-of-record dataset, a build command, the deploy command you already trust, and a live URL that proves the new data is published. One command shows which targets are stale against their refresh cadence. Another repulls, rebuilds and, only when you pass `--deploy`, deploys and checks the live site. It needs Bun, a local clone of each site repo, and whatever your own fetch and deploy scripts need.

## Fill in

Create `LIFEOS/USER/CUSTOMIZATIONS/SKILLS/DataRefresh/Registry.json`. Smallest working example:

```json
{
  "targets": [
    {
      "name": "example-site",
      "repo": "~/Projects/example-site",
      "fetch": [["bun", "scripts/fetch-data.ts"]],
      "cadenceDays": 30
    }
  ]
}
```

The repo path must exist on disk, or the tool refuses to load the registry and names the entry. To keep the registry somewhere else, set `DATAREFRESH_REGISTRY` to its path.

| Field | Required | Meaning |
|---|---|---|
| `name` | yes | Short id used on the command line, as in `refresh example-site` |
| `repo` | yes | Site repo, absolute or starting with `~/`; must exist |
| `fetch` | yes | List of argv arrays, run in the repo in order, that repull source data |
| `cadenceDays` | yes | Days between refreshes before status reports STALE |
| `build` | no | argv array that rebuilds the site payload after the pull |
| `deploy` | no | Your sanctioned deploy command as an argv array; runs only with `--deploy` |
| `dataDir` | no | Folder of pulled JSON inside the repo, default `data` |
| `timestampConvention` | no | `meta-json` (reads `_meta.fetched_at`, `_meta.fetched` or `generated` from each JSON, file time as fallback) or `mtime` |
| `verifyUrl` | no | Live JSON endpoint checked after deploy |
| `verifyField` | no | Dot-path to the freshness timestamp inside that JSON |
| `dataset` | no | Source-of-record dataset: `update` argv array, optional `cwd`, optional `summary` file the tool flags when its dates look older than the data |
| `notes` | no | Free text |

Each run appends one line to `LIFEOS/MEMORY/OBSERVABILITY/datarefresh.jsonl`; the tool creates it.

## Accounts and secrets

The skill itself needs no account and reads no `~/.claude/.env` key. Your targets may. Typical examples, named only by what your own scripts read: a hosting provider token for the deploy command (for example `CLOUDFLARE_API_TOKEN`), and any API key an upstream data source requires. Get each value from that provider's dashboard and store it in `~/.claude/.env`, never in the registry.

## Prove it works

Run a throwaway target in a temporary folder. This uses only the shipped tool.

```bash
D=$(mktemp -d); mkdir -p "$D/site/data"
echo "{\"_meta\":{\"fetched_at\":\"$(date -u +%FT%TZ)\"}}" > "$D/site/data/a.json"
echo "{\"targets\":[{\"name\":\"demo\",\"repo\":\"$D/site\",\"fetch\":[[\"true\"]],\"cadenceDays\":30}]}" > "$D/Registry.json"
DATAREFRESH_REGISTRY="$D/Registry.json" bun ~/.claude/skills/DataRefresh/Tools/Refresh.ts status; echo "exit=$?"; rm -rf "$D"
```

Success: a table row for `demo` with state `FRESH`, the line `all targets fresh`, and `exit=0`.

With no registry configured, the plain status command exits 1 with `not configured: no registry at ...`; that is the expected message on a fresh install.
