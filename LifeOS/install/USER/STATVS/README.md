---
provenance: template
version: 1.0.0
---

# STATVS: your record settings

The STATVS engine ships in `LIFEOS/STATVS/`. The engine writes to a local record on its own and needs no file from this folder. These files are for the optional cloud record on your own Cloudflare account, and they never ship.

- `worker.json`: the D1 database and the reader names for the cloud intake Worker in `LIFEOS/STATVS/worker`. Needed only to deploy that Worker.
- `core-worker.json`: the R2 bucket, the control database and one index database per month for the core Worker in `LIFEOS/STATVS/core/worker`. Needed only to deploy the core.
- `provenance.json`: which sessions and rows the core refuses to take. The shipped values withhold nothing. Add your consulting folders before you send rows to the cloud.
- `cutover.json`: `dual_write` stays `false` unless you are moving a private log into the record.
- Created when you set up the core, never templates: `core-secrets.json.age` (sealed URL and tokens), `core-verifier.txt` (the checkpoint verifier key) and `witness/checkpoints.jsonl` (checkpoints the daily witness has verified).
- `adapters/` (optional): your own Vigil adapter modules.

Setting it up: follow `LIFEOS/DOCUMENTATION/Setup/Statvs.md`.
