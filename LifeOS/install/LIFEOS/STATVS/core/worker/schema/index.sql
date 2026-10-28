-- STATVS core index: D1 databases split by event month, all with this schema. A month's first
-- database is bound as IDX_YYYY_MM and its rollover parts as IDX_YYYY_MM_<n>; no part is written
-- past 80% of D1's 10 GB cap (ISC-61).
-- The index is a rebuildable view of the R2 segments (core/tools/rebuild.ts): it holds each
-- row's queryable envelope plus its ingest offset and segment key, never the payload, and
-- GET /rows reads full rows back from the segments. A row whose month has no database goes
-- to the nearest configured one and records its own month in routed_from. class is the third
-- field of the row's chain, so reads can be scoped by stream and class (ISC-49).
-- Writes are INSERT OR IGNORE keyed on (shard, ingest_offset), so re-indexing is idempotent.
-- subject is the RES a row is about (schema v4, CENSVS ISA F4): the subject a v4 row names, else the one
-- core/lib/subject.ts derives from an older row; op is the op a v4 row names. Both columns come last so a
-- database created from this file and one migrated by migrations/0004_subject.sql have the same layout.
-- @version 0.2.0

CREATE TABLE IF NOT EXISTS rows (
  shard TEXT NOT NULL,
  ingest_offset INTEGER NOT NULL,
  chain TEXT NOT NULL,
  seq INTEGER NOT NULL,
  ts TEXT NOT NULL,
  ts_ms INTEGER NOT NULL,
  ts_basis TEXT NOT NULL,
  writer TEXT NOT NULL,
  stream TEXT NOT NULL,
  class TEXT,
  app TEXT,
  kind TEXT,
  severity TEXT,
  title TEXT,
  session TEXT,
  ref TEXT,
  body TEXT,
  hash TEXT NOT NULL,
  ingested_at TEXT NOT NULL,
  segment TEXT NOT NULL,
  month TEXT NOT NULL,
  routed_from TEXT,
  subject TEXT,
  op TEXT,
  PRIMARY KEY (shard, ingest_offset)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS rows_ts ON rows (shard, ts_ms, ingest_offset);
CREATE INDEX IF NOT EXISTS rows_stream ON rows (shard, stream, ingest_offset);
CREATE INDEX IF NOT EXISTS rows_class ON rows (shard, class, ingest_offset);
CREATE INDEX IF NOT EXISTS rows_writer ON rows (shard, writer, ingest_offset);
CREATE INDEX IF NOT EXISTS rows_session ON rows (shard, session, ingest_offset);
CREATE INDEX IF NOT EXISTS rows_chain ON rows (chain, seq);
CREATE INDEX IF NOT EXISTS rows_body ON rows (body) WHERE body IS NOT NULL;
CREATE INDEX IF NOT EXISTS rows_subject ON rows (shard, subject, ingest_offset);
