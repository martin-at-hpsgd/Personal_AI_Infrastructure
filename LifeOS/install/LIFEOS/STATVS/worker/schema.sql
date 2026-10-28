-- STATVS cloud tier D1 schema: Vigil's former store, the same database (vigil-db) and tables, shared with lifeos-vigil until it is retired. Safe to re-apply: every statement is idempotent, and the two backfills reset the tally to direct counts. @version 0.4.0
CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, source TEXT NOT NULL, ts TEXT NOT NULL, kind TEXT NOT NULL, severity TEXT NOT NULL, title TEXT NOT NULL, summary TEXT NOT NULL, ref TEXT, url TEXT, privacy_class TEXT NOT NULL, dedup_key TEXT NOT NULL, meta TEXT, emitter TEXT);
CREATE UNIQUE INDEX IF NOT EXISTS events_dedup_key ON events(dedup_key);
CREATE INDEX IF NOT EXISTS events_ts ON events(ts);
CREATE TABLE IF NOT EXISTS emitters (name TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, privacy_ceiling TEXT NOT NULL DEFAULT 'personal');
-- Running tally, so /stats never counts the whole events table (ISC-126). Triggers keep it exact inside each insert's and delete's own transaction.
CREATE TABLE IF NOT EXISTS event_totals (id INTEGER PRIMARY KEY CHECK (id = 1), n INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS event_counts (hour TEXT NOT NULL, source TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (hour, source));
CREATE TRIGGER IF NOT EXISTS events_tally_insert AFTER INSERT ON events BEGIN INSERT INTO event_counts (hour, source, n) VALUES (substr(NEW.ts, 1, 13), NEW.source, 1) ON CONFLICT (hour, source) DO UPDATE SET n = n + 1; UPDATE event_totals SET n = n + 1 WHERE id = 1; END;
CREATE TRIGGER IF NOT EXISTS events_tally_delete AFTER DELETE ON events BEGIN UPDATE event_counts SET n = n - 1 WHERE hour = substr(OLD.ts, 1, 13) AND source = OLD.source; UPDATE event_totals SET n = n - 1 WHERE id = 1; END;
-- Backfills run after the triggers exist and overwrite, so a row inserted mid-migration is never counted twice or missed.
INSERT INTO event_totals (id, n) SELECT 1, COUNT(*) FROM events WHERE 1 ON CONFLICT (id) DO UPDATE SET n = excluded.n;
INSERT INTO event_counts (hour, source, n) SELECT substr(ts, 1, 13), source, COUNT(*) FROM events WHERE 1 GROUP BY 1, 2 ON CONFLICT (hour, source) DO UPDATE SET n = excluded.n;
