# Query

An answer to "what happened" read from the record: the rows that bear on the question, in time order, summarized in plain words.

## Ideal State

- The answer cites the rows it rests on (stream, writer, `ts`, `id`) and gives times in the principal's current zone as 24-hour HH:mm.
- When the question names a window, system or session, the search is restricted to it, and the answer says what window was searched.
- Where the record is silent, the answer says the event is unknown to the record, never that it did not happen, and names an independent witness to check (git, deploy logs, the transcript).

## Anti-criteria

- Never answers from a system's private log, STATE file or memory while presenting it as the record.
- Never dumps raw JSONL at the principal; rows are summarized, with ids available.
- Never reads a `customer` class directory for a question that is not about that app.

## Tool contract

```bash
bun LIFEOS/STATVS/Statvs.ts tail [--stream S] [--n 20]
rg -n '<term>' LIFEOS/MEMORY/STATVS/<class>/<YYYY-MM-DD>/ -g '*.jsonl'
```

### Intent-to-Flag Mapping

| User says | Flag | Effect |
|-----------|------|--------|
| "on the work stream" / "deploys" | `--stream <name>` | one stream only |
| "the last N" | `--n N` | how many rows |
| "in this session" | `rg '"session":"<id>"'` | rows from one Claude Code session |

## Output format

One or two sentences answering the question, then a short time-ordered list of the rows behind it (HH:mm · writer · what happened).
