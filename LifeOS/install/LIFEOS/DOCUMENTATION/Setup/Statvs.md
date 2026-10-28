---
version: 1.0.0
---

# STATVS (the one record of what happened)

Status: `bun LIFEOS/STATVS/Statvs.ts verify` · optional

## What it does

STATVS is the record of what happened across LifeOS and the apps it runs. Every hook, tool and job appends a row once; nothing rewrites a row; every other piece of state is a view built from the rows. The design is in `LIFEOS/DOCUMENTATION/Statvs/StatvsSystem.md`.

The local engine works with no setup. Rows go into daily segment files under `LIFEOS/MEMORY/STATVS/`, and `Statvs.ts verify` checks their hash chains. The cloud record is optional. It is a copy on your own Cloudflare account that a phone, Pulse or a second machine can query, plus a daily witness that keeps each signed checkpoint outside Cloudflare, in your private USER git repository. Set up the cloud record only when you want that.

There are two Workers. The core Worker in `LIFEOS/STATVS/core/worker` is the permanent record: R2 segments, a signed checkpoint log and one index database per month. The intake Worker in `LIFEOS/STATVS/worker` is Vigil's former store under its new name, with its own D1 database and a list of emitters allowed to read events. You can deploy either one without the other.

## Fill in

Every file lives in `LIFEOS/USER/STATVS/`. With none of them present, the local engine runs and nothing goes to the cloud.

| File | What it holds | Needed for |
|---|---|---|
| `worker.json` | The D1 database (`d1.name`, `d1.id`) and `readers`, the emitter names allowed to read `GET /events`. `[]` allows none | Deploying the intake Worker |
| `core-worker.json` | `r2.name`, the `control` database, and one `index` entry per month (`month`, `name`, `id`). A full month database gets a second entry for the same month with `"part": 2` | Deploying the core Worker |
| `provenance.json` | Customer-exclusion rules: working folders (`consulting.cwd_patterns`) and tenant names whose rows are withheld whole | Deploying the core Worker, and every run of the shipper |
| `cutover.json` | `{ "dual_write": false }`. `true` makes the event writer also append to the record while a private log is being moved in | Only during a migration of one of your own logs |
| `core-secrets.json.age` | Sealed JSON with `STATVS_CORE_URL`, `STATVS_CORE_TOKEN`, `STATVS_CORE_READ_TOKEN` and `STATVS_MASK_KEY` | Shipping rows and running the witness |
| `core-verifier.txt` | The core Worker's checkpoint verifier key, one line | The witness |
| `witness/checkpoints.jsonl` | Checkpoints the witness has verified | Written by the witness; do not create it |
| `adapters/` | Your own Vigil adapter modules (see `skills/Vigil/Setup.md`) | Optional |

The installer copies `worker.json`, `core-worker.json`, `provenance.json` and `cutover.json` as starter files. If one is missing, `bun skills/LifeOS/Tools/ScaffoldUser.ts --apply` copies it and never overwrites a file you have edited.

The starter `worker.json` and `core-worker.json` hold placeholder database ids, and both deploys refuse a placeholder and name the file to fix. The starter `provenance.json` withholds nothing. Before you ship any row, list your customer or consulting working folders in `consulting.cwd_patterns` (a pattern starting with `~/` matches any home folder; `*` stays inside one folder name and `**` crosses folders). Rows a pattern matches never leave the machine.

## Accounts and secrets

None for the local engine.

The cloud record needs a Cloudflare account. Put `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in `~/.claude/.env` and seal it:

```bash
bun LIFEOS/TOOLS/Secrets.ts seal
bun LIFEOS/TOOLS/Secrets.ts has CLOUDFLARE_ACCOUNT_ID CLOUDFLARE_API_TOKEN   # prints "KEY yes" or "no" for each
```

Every Cloudflare call goes through `LIFEOS/TOOLS/CfEnv.ts`, which injects those two keys into that one command and reviews the Worker's code before a deploy. The core's folder must be inside a git repository with its changes committed, and a reviewer key for the other model vendor must be in `.env`, the same conditions as `skills/Vigil/Setup.md`.

Setting up the core, in order, from `~/.claude`:

1. Create the R2 bucket named in `core-worker.json` (`r2.name`) with the Cloudflare skill.
2. Create the control database and one index database for the current month with `bun LIFEOS/TOOLS/CfEnv.ts d1 create --name <name>`. Put each printed id into `core-worker.json`.
3. Apply `LIFEOS/STATVS/core/worker/schema/control.sql` to the control database and `schema/index.sql` to every index database, each with `bun LIFEOS/TOOLS/CfEnv.ts d1 query <id> --sql "$(cat <file>)"`.
4. Set the two Worker secrets `STATVS_SIGNING_KEY` (an Ed25519 signer key in signed-note form; `generateKeys` in `LIFEOS/STATVS/core/lib/checkpoint.ts` makes one with its verifier key) and `STATVS_MASK_KEY` (a random key for mask tokens). Keep the verifier key line for step 7.
5. Deploy: `cd LIFEOS/STATVS/core/worker && bun run deploy`. The deploy reads `core-worker.json` and `provenance.json` and stops on a placeholder.
6. Add a write token and a read token to the control database's `credentials` table. Store only each token's SHA-256 in `token_sha256`, with a `name`, a `scopes` JSON array (`["write:*"]` for the shipper, `["read:*"]` for the witness) and `created_at`.
7. Write `core-verifier.txt` (the verifier key from step 4, or `GET /key` with the read token) and seal the four secret values into `core-secrets.json.age` with `sealBytes` from `LIFEOS/TOOLS/Secrets.ts`, so only this Mac's Keychain identity can open it. No command writes this file for you.

The intake Worker (`worker.json`) follows the same pattern as the Vigil store in `skills/Vigil/Setup.md`: create `vigil-db`, apply `LIFEOS/STATVS/worker/schema.sql`, register an emitter token as a SHA-256, then deploy from `LIFEOS/STATVS/worker`.

Rows are plain text on your own account. Secret values are masked before a row leaves the machine, and rows that provenance matches are withheld. Nothing in the record is removed by age.

## Prove it works

Local engine:

```bash
bun LIFEOS/STATVS/Statvs.ts verify      # prints "STATVS verify: ok" when every segment's hash chain checks out
bun LIFEOS/STATVS/Statvs.ts counters    # running totals since the counters file was made, refusals included
```

Cloud record, after step 7:

```bash
bun LIFEOS/STATVS/core/tools/ship.ts --dry-run    # reads the sealed secrets and provenance.json, sends nothing, prints pending, withheld and held counts
bun LIFEOS/STATVS/core/tools/ship.ts              # sends the pending rows
bun LIFEOS/STATVS/core/tools/witness.ts --verify-only   # verifies the live checkpoint and records nothing
```

`ship.ts` exits 0 when every pending row is stored, 1 when it stopped, 3 when some rows are held for a code fix, and 2 when the sealed secrets, the mask key or `provenance.json` cannot be read. `witness.ts` exits 1 on a bad signature, a smaller tree than the last witnessed one, or a failed consistency proof. To keep the cloud record current, schedule both as Workflows (`LIFEOS/DOCUMENTATION/Workflows/WorkflowsSystem.md`): the shipper every ten minutes and the witness once a day. Neither is shipped as a starter file.
