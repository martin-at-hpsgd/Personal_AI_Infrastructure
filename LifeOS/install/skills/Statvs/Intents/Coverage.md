# Coverage

A verdict on whether a named system, app or site reports into STATVS, stream by stream, with the evidence and the gap.

## Ideal State

- The subject is resolved to a concrete system before any search: a project name or alias through the install's projects routing table, a LifeOS subsystem through its doc, and the resolution is stated in the first line.
- The verdict is per required stream: a live app needs at least `deploy` and `app-health` rows (STATVS ISA F8, ISC-49), and any stream that already carries rows about it (`review`, `event`, `move`, `work`) is listed too. Each stream gets yes, partial or no.
- Every yes cites the writer name, the stream, the row count over the window and the last row's time, from `tail` or a segment search run this turn. Every no cites the search that found nothing.
- Rows that only mention the subject (a work item whose title names the site) are reported as mentions, never as the subject reporting in.
- The gap is closed in words: which writer does not exist yet, whether the stream is registered in `streams.ts`, whether the intake (ISA F8) is built, and the Onboard step that comes next.

## Anti-criteria

- Never answers yes because the subject has its own log, a Vigil adapter, a Bunker monitor or a health page. Only rows in the record count.
- Never counts a row from another writer that merely names the subject.
- Never creates a stream, writer or row while answering; this intent is read-only.

## Tool contract

Run from the config root. The record lives under `LIFEOS/MEMORY/STATVS/<class>/<YYYY-MM-DD>/<writer>.jsonl` (customer rows under `customer/<app>/…`).

```bash
bun LIFEOS/STATVS/tools/Coverage.ts --app <app> --match '<domain|repo regex>' --streams deploy,app-health --json
#   per-stream rows, last row and writers, plus state none|partial|full; read-only, exit 2 on usage error
bun LIFEOS/STATVS/Statvs.ts tail --stream <stream> --n 200     # recent rows on one stream
rg -l '"app":"<app>"' LIFEOS/MEMORY/STATVS/                     # rows tagged with the app
rg -c '"writer":"app:<app>"' LIFEOS/MEMORY/STATVS/ -g '*.jsonl' # rows the app itself wrote
rg -n '<stream>:' LIFEOS/STATVS/streams.ts                      # is the stream registered
```

### Intent-to-Flag Mapping

| User says | Flag | Effect |
|-----------|------|--------|
| "this week" / "today" | restrict the search to `*/<date>/` directories | window of the verdict |
| "everything we run" | repeat per live row of the projects table | one verdict row per app |

## Output format

First line: the resolved subject and the overall verdict (full, partial, none). Then a table: stream · verdict · writer · rows · last row. Then one or two sentences naming the gap and the Onboard step that closes it.
