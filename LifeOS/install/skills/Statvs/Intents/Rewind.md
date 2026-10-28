# Rewind

A past Claude Code turn rebuilt from the record as a fixture and replayed through today's guards, with a plain verdict on whether the miss now comes out differently.

## Ideal State

- The fixture exists and passed `--check` before any replay ran, and the report names its session and turn (or the Errata id it was found from).
- Every condition the turn row did not record and the replay depended on is stated with `--assume key=value`, and the report lists those assumptions.
- The replay verdict says whether the miss flipped (a call that ran then is refused now, or the reverse) and names the proof tier: a guard flip is proven by `Assay.ts replay`; a prompt or behavior fix is owed until behavior replay exists, and the report says so.
- When the turn cannot be rebuilt because something was never recorded, the report names the missing field and files it as a criterion on the STATVS ISA, or says where it should be filed when the ISA is absent.

## Anti-criteria

- Never presents a rebuilt turn as a recording of the model's answer; it reproduces the conditions, not the sampled output.
- Never claims a prompt or doctrine fix is proven by a guard replay.
- Never replays with `--no-record` when the result is meant as proof of a fix.

## Tool contract

```bash
bun LIFEOS/STATVS/Rewind.ts input <session> <promptIndex> [--assume key=value ...] [--source why] [--check] [--json]
bun LIFEOS/STATVS/Rewind.ts input <session> --errata <id> [--assume key=value ...] [--check] [--json]
bun LIFEOS/ASSAY/Assay.ts replay <fixture> [--json] [--no-record]
```

### Intent-to-Flag Mapping

| User says | Flag | Effect |
|-----------|------|--------|
| "the turn behind that complaint" | `--errata <id>` | finds the turn from the Errata entry |
| "assume the desk was idle" | `--assume <key>=<value>` | states a condition the row lacks, recorded in the fixture |
| "just look, don't log it" | `replay --no-record` | no result row |

## Output format

First line: flipped or not flipped, and the proof tier. Then the fixture path, the assumptions, and each replayed call with then-versus-now.
