# SyncCheck

Verify the live site data is in sync with its upstream source-of-record datasets.

## Ideal State

- The report gives, per upstream dataset, the generation timestamps (site vs upstream), the shared-series count, any series whose upstream coverage extends past the site's, and a fresh/stale verdict.
- Each non-fresh upstream is reported by name, with `comparedSeries` saying how many series the verdict rests on.
- When an upstream is STALE, the report says which series lag and by how much.
- A "nothing to sync-check against" result is reported as a finding: the payload stopped shipping its `historicalSourceUrls`.

## Anti-criteria

- No sync-check without `--fresh`: a freshness check through a stale cache is self-defeating.
- No refreshing the dataset or redeploying the site from this skill; it is read-only.
- No upstream called fresh unless its index was reached and compared `fresh`.

## Tool contract

```bash
bun ~/.claude/skills/USStats/Tools/UsStats.ts sync-check --fresh [--json]
```

Under `--fresh` the tool never serves the cache: an unreachable or failing site endpoint is an error (exit 1).

Exit 0 only when every upstream index was reached and compared `fresh`. Exit 1 when any upstream is `STALE`, `unreachable`, `unknown` (no shared series with a parsable coverage year, so nothing was compared), or the site is older than the upstream index, and when the payload has no source URLs at all.

## Gotchas

- `sync-check` derives upstream URLs from the payload (`historicalSourceUrls` → GitHub raw `index.json`). If the payload stops shipping those fields it reports "nothing to sync-check against" rather than guessing.
