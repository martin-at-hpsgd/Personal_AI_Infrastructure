-- STATVS core index, schema v4 (CENSVS ISA F4, ISC-21): the subject and op columns and their index.
-- Run once on every month index database that was created before v4, before the v4 Worker is deployed.
-- A definition change only: no stored row is rewritten, and old rows' subjects are filled in afterwards
-- by core/tools/backfill-subject.ts, which sets only the subject column. A database created from
-- index.sql at v4 or later already has these columns; do not run this on it.

ALTER TABLE rows ADD COLUMN subject TEXT;
ALTER TABLE rows ADD COLUMN op TEXT;
CREATE INDEX IF NOT EXISTS rows_subject ON rows (shard, subject, ingest_offset);
