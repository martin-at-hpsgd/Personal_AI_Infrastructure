-- STATVS core control database (lifeos-statvs-core): per-writer and per-reader credentials.
-- A token is stored only as its sha256. scopes is a JSON array of:
--   "write:*", "write:<writer>", "write:<prefix>*"   which writers a token may append as;
--   "read:*"                                          everything;
--   "read:stream:<name>", "read:class:<name>"         a scoped reader (ISC-49).
-- A scoped reader sees rows whose stream is one of its streams (any stream when it names none)
-- and whose class is one of its classes; with no class scope it sees the public and system
-- classes only, so personal rows need an explicit "read:class:personal".
-- A revoked token (revoked_at set) stops working once the Worker's auth cache entry for it
-- expires, at most 30 seconds (ISC-74).
-- Rows are never deleted: revocation is a timestamp, so who held what stays on record.
-- @version 0.1.0

CREATE TABLE IF NOT EXISTS credentials (
  token_sha256 TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  scopes TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
