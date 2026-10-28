# STATVS core: deploying schema v4

Schema v4 lets a row name the RES it is about (`subject`, `op`; CENSVS ISA F4). This is the order the main session runs to put it live (ISC-27). Every command runs from `~/.claude`. No step rewrites a stored row: R2 segments stay byte for byte as they are, and old rows get their subject only in the index, which is a rebuildable view.

## Why this order

1. **Migrate before deploying.** The v4 Worker inserts into the `subject` and `op` columns, so a database without them fails the index write. The record stays intact and the index only lags, but there is no reason to cause that. The v0.6 Worker names its insert columns, so it keeps working on a migrated database.
2. **Deploy, then backfill.** Rows the v0.6 Worker indexes between the migration and the deploy get no subject. The backfill fills them along with every older row.
3. **The shipper is already local code.** It asks the core's `GET /health` for its `schema` before it queues the first v4 row of a run (CENSVS ISC-64). Until the Worker is v4, `/health` reports no schema, so the shipper holds that segment at its first v4 row, sends nothing after it, and reports it under `schemaHeld`. The next run asks again and sends the held rows once the core reports schema 4, so nothing is lost while it waits.

## Steps

1. **Suites are green.**
   The STATVS core test suites pass with no failures.

2. **Witness before.** The live tree verifies and extends the last witnessed checkpoint (ISC-26, before). It records nothing.
   `bun LIFEOS/STATVS/core/tools/witness.ts --verify-only`

3. **Migrate every month index database.** The databases are the `index` entries in `LIFEOS/USER/STATVS/core-worker.json`, six as of 2026-10-18 (2026-07 to 2026-12). For each entry's `id`:
   `bun LIFEOS/TOOLS/CfEnv.ts d1 migrations apply <id> --dir LIFEOS/STATVS/core/worker/schema/migrations`
   The migration is `0004_subject.sql`: two `ALTER TABLE rows ADD COLUMN` statements and one `CREATE INDEX IF NOT EXISTS`. Never run it on a database created from `index.sql` 0.2.0 or later; that schema already has the columns, and the ALTER fails with "duplicate column", which changes nothing.
   Check each database:
   `bun LIFEOS/TOOLS/CfEnv.ts d1 query <id> --sql "SELECT name FROM pragma_table_info('rows') WHERE name IN ('subject','op') UNION ALL SELECT name FROM sqlite_master WHERE name = 'rows_subject'"`
   It should return `subject`, `op` and `rows_subject`.

4. **Deploy the Worker.** The release record (`worker/CHANGELOG.md`, `worker/package.json`) was prepared with the code, so `CfEnv.ts deploy` finds the release recorded.
   `cd LIFEOS/STATVS/core/worker && bun run deploy`
   Then probe it: `GET /health` reports the new version. CfEnv prints the previous version id. Keep it for rollback.

5. **Backfill: dry run first.** This step reads and writes nothing. It prints, per database, the rows with no subject, how many get one, and the count per kind (`isa`, `app`, `session`).
   `bun LIFEOS/STATVS/core/tools/backfill-subject.ts --all`
   The dry run is the first live call of its D1 adapter (`cfD1`, which runs `d1 query` through CfEnv). Make sure the counts look sane: `work` rows become `isa:<slug>`, `turn` rows `session:<id>`, and `deploy`, `release` and `app-*` rows `app:<app>`.

6. **Backfill: apply.**
   `bun LIFEOS/STATVS/core/tools/backfill-subject.ts --all --apply`
   The only write is `UPDATE rows SET subject = ? WHERE shard = ? AND ingest_offset = ? AND subject IS NULL`. Running it again is safe. Run the dry run once more afterwards: `derived` is 0 for every database. The rows still scanned are the ones that derive no subject, such as `work` seed rows.

7. **Live probe (ISC-27).** This needs the local lane's `append()` with `subject`. Write one row, ship it, then read it back by subject:
   `bun -e 'import { append } from "./LIFEOS/STATVS/index"; console.log(JSON.stringify(append({ writer: "probe:censvs", stream: "statvs", kind: "probe", subject: "system:censvs", op: "observe", data: { probe: "schema v4", at: new Date().toISOString() } })))'`
   `bun LIFEOS/STATVS/core/tools/ship.ts`
   `bun LIFEOS/STATVS/core/tools/rows-by-subject.ts system:censvs`
   The probe row should come back with `v4`, op `observe`. Also check one backfilled RES: `bun LIFEOS/STATVS/core/tools/rows-by-subject.ts isa:censvs --limit 5`.

8. **Witness after.** The tree still verifies, and its consistency proof extends the size from step 2 (ISC-26, after).
   `bun LIFEOS/STATVS/core/tools/witness.ts --verify-only`
   The daily `statvs-witness` workflow records it as usual.

## Rollback

- **The Worker.** Redeploy the previous version id that step 4 printed: `bun LIFEOS/TOOLS/CfEnv.ts workers deployments create --worker lifeos-statvs-core` with that version. The v0.6 Worker runs fine on migrated databases.
- **The schema.** Leave it. The added columns and index are harmless to v0.6, and nothing is ever dropped.
- **What a rollback costs.** The v0.6 intake reads no v4 rows and its `/health` reports no schema. The shipper holds them unsent (`schemaHeld`), as it does before the deploy, and sends them after a later v4 deploy. v4 rows already stored stay readable through `GET /rows`, which returns segment rows as written. But the v0.6 `rebuild.ts` does not verify v4 rows, so rebuild with the v4 tool.
