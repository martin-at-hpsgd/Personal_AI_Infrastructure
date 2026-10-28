/**
 * @version 1.2.3
 * work-events — append-only event log + derived snapshot for work.json.
 *
 * Write path (writers): diff → appendWorkEvents() → foldToSnapshot() under lock.
 * Read path (readers):  readLiveRegistry() = snapshot + suffix replay. Never writes.
 * Compaction: a compacted log moves to work-events-archive/ instead of being erased.
 *
 * STATVS dual-write (STATVS ISA F4, ISC-35/ISC-83): after the log append succeeds,
 * each valid event is also appended to STATVS as one row in stream `work`
 * (writer `lib:work-events`, class `system`, kind `event`, data = the event).
 * The first write to a record seeds it with the current registry (a `seed` reset
 * row, then one `seed-row` per session) so the `work` view
 * (LIFEOS/STATVS/views/work.ts) starts from live state. The seed runs once per
 * record, under a lock, recorded by `<statvsStateDir>/work-seeded.json`.
 * The dual-write never throws out of appendWorkEvents and never changes its return
 * value or the log write; its failures go to work-anomalies.jsonl. It runs only
 * against the live log, or wherever STATVS_DIR points, and never under `bun test`
 * without STATVS_DIR, so tests cannot touch the live record. The STATVS engine is
 * loaded lazily on the first dual-write, so hooks that only read pay nothing.
 *
 * Invariants (tested in hooks/work-events.test.ts):
 *   - File order is authoritative. The reducer never sorts by timestamp.
 *   - Replay is idempotent: re-applying a suffix converges to the same state,
 *     which is what makes the compaction crash window (snapshot written, log
 *     not yet archived) safe.
 *   - A torn trailing line (crash mid-append) is skipped silently; a corrupt
 *     MIDDLE line is skipped and reported to work-anomalies.jsonl.
 *   - Events without a non-empty slug are rejected at append time.
 *
 * Concurrency primitives (first-principles checked 2026-06-10):
 *   - One appendFileSync call per event batch → O_APPEND offset placement is
 *     atomic per write() on local filesystems; no interleaved lines.
 *   - mkdir lock with mtime-based stale takeover; a skipped fold is safe
 *     because readers replay the suffix themselves.
 *   - Snapshot replace stays tmp+rename (atomic on same filesystem).
 */

import {
  appendFileSync,
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import { dirname, join, resolve } from 'path';
import { invariant, InvariantViolation } from '../../LIFEOS/TOOLS/Invariant';
import { lifeosPath } from './paths';

export interface WorkEvent {
  v: 1;
  ts: string;
  slug: string;
  op: 'upsert' | 'delete';
  /** Changed/added fields for upsert. Values may legitimately be null. */
  fields?: Record<string, unknown>;
  /** Field names removed from the row (kept separate so null stays a value). */
  unset?: string[];
  /** sessionUUID when the row carries one — identity for forensics. */
  uuid?: string;
  /** Writer tag, e.g. 'ISASync', 'SessionCleanup'. (Legacy events carry 'AlgoPhase' — tool retired 2026-07-14.) */
  src: string;
}

export interface Registry {
  sessions: Record<string, any>;
}

export interface Snapshot extends Registry {
  _events_offset?: number;
  _folded_at?: string;
}

export function workEventsPath(): string {
  return lifeosPath('MEMORY', 'STATE', 'work-events.jsonl');
}
export function workSnapshotPath(): string {
  return lifeosPath('MEMORY', 'STATE', 'work.json');
}
/** Compacted logs land here, one file per compaction, so the event history survives (AD-2). */
export function workEventsArchiveDir(logPath = workEventsPath()): string {
  return join(dirname(logPath), 'work-events-archive');
}
function lockPath(logPath: string): string {
  return logPath + '.lock';
}
function anomalyPath(): string {
  return lifeosPath('MEMORY', 'OBSERVABILITY', 'work-anomalies.jsonl');
}

const LOCK_STALE_MS = 10_000;
/** Compact when the log grows past this many bytes. */
export const COMPACT_THRESHOLD_BYTES = 1_048_576;

// ── Pure core ──────────────────────────────────────────────────────────────

/**
 * Fold events onto a base registry, in the order given (file order).
 * Pure: returns a new object; never mutates `base`; never consults clocks.
 */
export function foldEvents(base: Registry, events: WorkEvent[]): Registry {
  const sessions: Record<string, any> = {};
  for (const [slug, row] of Object.entries(base.sessions || {})) {
    sessions[slug] = { ...(row as Record<string, unknown>) };
  }
  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue;
    if (typeof ev.slug !== 'string' || ev.slug.length === 0) continue;
    if (ev.op === 'delete') {
      delete sessions[ev.slug];
      continue;
    }
    if (ev.op === 'upsert') {
      const row = sessions[ev.slug] ?? {};
      if (ev.fields) Object.assign(row, ev.fields);
      if (Array.isArray(ev.unset)) for (const k of ev.unset) delete row[k];
      sessions[ev.slug] = row;
    }
  }
  return { sessions };
}

/**
 * Parse raw log text into events. A final unterminated line is treated as a
 * torn tail and skipped silently; any other unparseable line is an anomaly.
 */
export function parseEventLines(
  raw: string,
  onAnomaly?: (line: string, index: number) => void,
): WorkEvent[] {
  const out: WorkEvent[] = [];
  const lines = raw.split('\n');
  const lastIdx = lines.length - 1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || !line.trim()) continue;
    try {
      const ev = JSON.parse(line);
      if (ev && typeof ev === 'object') out.push(ev as WorkEvent);
    } catch {
      const isTornTail = i === lastIdx && !raw.endsWith('\n');
      if (!isTornTail) onAnomaly?.(line, i);
    }
  }
  return out;
}

/**
 * Field-level diff: what events turn `prev` into `next`?
 * Compares per-row, per-field (JSON-encoded equality).
 */
export function diffRegistry(prev: Registry, next: Registry, src: string): WorkEvent[] {
  const events: WorkEvent[] = [];
  const ts = new Date().toISOString();
  const prevSessions = prev.sessions || {};
  const nextSessions = next.sessions || {};

  for (const [slug, nextRow] of Object.entries(nextSessions) as [string, Record<string, unknown>][]) {
    const prevRow = (prevSessions[slug] ?? {}) as Record<string, unknown>;
    const fields: Record<string, unknown> = {};
    const unset: string[] = [];
    for (const [k, v] of Object.entries(nextRow)) {
      if (JSON.stringify(prevRow[k]) !== JSON.stringify(v)) fields[k] = v;
    }
    for (const k of Object.keys(prevRow)) {
      if (!(k in nextRow)) unset.push(k);
    }
    // Empty-row creation still needs an event (fc counterexample, seed
    // 1619301911: prev={}, next={"s-alpha":{}} produced zero events).
    const isNewRow = !(slug in prevSessions);
    if (!isNewRow && Object.keys(fields).length === 0 && unset.length === 0) continue;
    const ev: WorkEvent = { v: 1, ts, slug, op: 'upsert', src };
    if (Object.keys(fields).length) ev.fields = fields;
    if (unset.length) ev.unset = unset;
    const uuid = nextRow['sessionUUID'];
    if (typeof uuid === 'string' && uuid) ev.uuid = uuid;
    events.push(ev);
  }
  for (const slug of Object.keys(prevSessions)) {
    if (!(slug in nextSessions)) events.push({ v: 1, ts, slug, op: 'delete', src });
  }
  return events;
}

// ── IO layer ───────────────────────────────────────────────────────────────

function reportAnomaly(line: string, index: number, logPath: string): void {
  try {
    appendFileSync(
      anomalyPath(),
      JSON.stringify({
        ts: new Date().toISOString(),
        type: 'work-events.corrupt-line',
        log: logPath,
        index,
        line: line.slice(0, 200),
      }) + '\n',
    );
  } catch {
    /* observability must never break the write path */
  }
}

/**
 * Run `action` under the log's append lock (`<log>.append.lock`), the lock every STATVS-on appender holds and
 * compaction takes around the archive rename. Returns false, without running `action`, when the lock cannot be had.
 * An error thrown by `action` propagates.
 */
function withAppendLock(logPath: string, action: () => void, deadlineMs = 2000): boolean {
  let ran = false;
  try {
    const core = require('../../LIFEOS/TOOLS/lib/LedgerCore') as LedgerCoreApi;
    const r = core.withKernelLock(`${logPath}.append.lock`, () => {
      ran = true;
      action();
    }, { deadlineMs, retryMs: 2 });
    return r.ok;
  } catch (e) {
    if (ran) throw e;
    return false;
  }
}

/** Append events (single write call). Slug-less events are dropped. */
export function appendWorkEvents(events: WorkEvent[], logPath = workEventsPath()): number {
  const valid = events.filter(
    (e) => e && typeof e.slug === 'string' && e.slug.length > 0 && (e.op === 'upsert' || e.op === 'delete'),
  );
  if (valid.length === 0) return 0;
  mkdirSync(dirname(logPath), { recursive: true });
  const body = valid.map((e) => JSON.stringify(e)).join('\n') + '\n';
  if (!statvsEnabledFor(logPath)) {
    // Same lock compaction takes around its rename, so an append never lands in a file that is being archived.
    // Best effort: the append itself must never fail, so an unobtainable lock falls back to the bare append.
    if (!withAppendLock(logPath, () => appendFileSync(logPath, body))) appendFileSync(logPath, body);
    return valid.length;
  }
  // With STATVS on, the log append and the STATVS rows happen under one kernel lock, so
  // every writer's events land in the same order in both stores, and the seed (taken
  // under the same lock, before this call's own events) reads exactly the events whose
  // rows are already in the record. A dead holder releases the lock at once; a live one
  // holds it for a few milliseconds. If the lock cannot be had, the log append still
  // happens (it must never fail) and the ordering gap is recorded as an anomaly.
  let ran = false;
  try {
    const core = require('../../LIFEOS/TOOLS/lib/LedgerCore') as LedgerCoreApi;
    const r = core.withKernelLock(`${logPath}.append.lock`, () => {
      ran = true;
      const api = statvsSafe(logPath);
      if (api) seedSafe(api, logPath);
      appendFileSync(logPath, body);
      if (api) dualWriteToStatvs(api, valid, logPath);
    }, { deadlineMs: 2000, retryMs: 2 });
    if (r.ok) return valid.length;
    statvsAnomaly('work-events.statvs-unordered', `append lock: ${r.message}`, logPath);
  } catch (e) {
    if (ran) throw e; // the log append itself failed: same behaviour as before STATVS
    statvsAnomaly('work-events.statvs-unordered', (e as Error)?.message ?? String(e), logPath);
  }
  appendFileSync(logPath, body);
  const api = statvsSafe(logPath);
  if (api) dualWriteToStatvs(api, valid, logPath);
  return valid.length;
}

// ── STATVS dual-write (ISC-35, ISC-83) ─────────────────────────────────────

type StatvsApi = typeof import('../../LIFEOS/STATVS/lib/record');
type LedgerCoreApi = typeof import('../../LIFEOS/TOOLS/lib/LedgerCore');
/** The subset of the STATVS API the dual-write uses; tests may replace it. */
export type StatvsWriter = Pick<StatvsApi, 'append' | 'statvsDir' | 'statvsStateDir'>;

const STATVS_WRITER = 'lib:work-events';
/** Work rows carry the principal's own task and criteria text, so they are personal: they never sit in a file that may leave the machine. */
const WORK_CLASS = 'personal';
let statvsOverride: StatvsWriter | null = null;
let statvsLoaded: StatvsWriter | null = null;

/** Test seam: replace the STATVS engine (ISC-83 forces it to throw). Pass null to restore. */
export function setStatvsForTest(api: StatvsWriter | null): void {
  statvsOverride = api;
}

function statvs(): StatvsWriter {
  if (statvsOverride) return statvsOverride;
  // Lazy, and the record engine only: index.ts also pulls in views and the drill, which a
  // hook never needs. Most hooks only read work.json and never load it at all.
  return (statvsLoaded ??= require('../../LIFEOS/STATVS/lib/record') as StatvsApi);
}

/** The engine, or null after recording why it would not load. Never throws. */
function statvsSafe(logPath: string): StatvsWriter | null {
  try {
    return statvs();
  } catch (e) {
    statvsAnomaly('work-events.statvs-error', (e as Error)?.message ?? String(e), logPath);
    return null;
  }
}

function seedSafe(api: StatvsWriter, logPath: string): void {
  try {
    seedIfNeeded(api, logPath);
  } catch (e) {
    const type = e instanceof InvariantViolation ? 'work-events.statvs-invariant' : 'work-events.statvs-error';
    statvsAnomaly(type, (e as Error)?.message ?? String(e), logPath);
  }
}

/**
 * Whether this append may reach STATVS: the live log, or a record STATVS_DIR names explicitly.
 * Keyed on the path alone, never on who is writing: an append that lands in the live log is
 * mirrored into the live record even under a test runner, so the record never falls behind
 * the log it must equal (ISC-36). A temp log without STATVS_DIR never reaches a record.
 */
function statvsEnabledFor(logPath: string): boolean {
  if (process.env.STATVS_DIR) return true;
  return resolve(logPath) === resolve(workEventsPath());
}

/** The marker that records this record has been seeded. Keyed by record dir, so a new STATVS_DIR seeds again. */
function seedMarkerPath(api: StatvsWriter): string {
  return join(api.statvsStateDir(), 'work-seeded.json');
}

/** Seed marker format. v2 records where the seed's reset row landed; a v1 marker (seeded under the old refusal rules, which dropped about half the sessions) seeds again. */
const SEED_MARKER_V = 2;

function isSeeded(api: StatvsWriter): boolean {
  try {
    const m = JSON.parse(readFileSync(seedMarkerPath(api), 'utf-8'));
    if (!m || m.v !== SEED_MARKER_V || m.dir !== api.statvsDir()) return false;
    // The marker lives outside the record. If the segment holding the reset row is gone
    // (a rollback of the MEMORY repo, a deleted segment), the record lost its seed: seed again.
    if (typeof m.segment === 'string') {
      invariant(!m.segment.split('/').includes('..'), 'seed segment must be a path inside the record');
      // A seed written under another class (the stream moved class) is not this stream's seed.
      if (m.segment.split('/')[0] !== WORK_CLASS) return false;
      return existsSync(join(api.statvsDir(), m.segment));
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Seed the work stream with the current registry: a `seed` reset row, then one
 * `seed-row` per session. Per-session rows keep one refused session from losing the
 * whole seed. Called under the log's append lock and BEFORE this call's own events are
 * logged, so the registry it reads holds exactly the events whose rows are already in
 * the record, and every event row lands after the seed rows.
 */
function seedIfNeeded(api: StatvsWriter, logPath: string): void {
  if (isSeeded(api)) return;
  const core = require('../../LIFEOS/TOOLS/lib/LedgerCore') as LedgerCoreApi;
  const marker = seedMarkerPath(api);
  mkdirSync(dirname(marker), { recursive: true });
  const r = core.withKernelLock(marker + '.lock', () => {
    if (isSeeded(api)) return;
    const registry = readLiveRegistry(join(dirname(logPath), 'work.json'), logPath);
    const slugs = Object.keys(registry.sessions || {});
    const reset = api.append({
      writer: STATVS_WRITER, stream: 'work', class: WORK_CLASS, kind: 'seed',
      data: { registry: { sessions: {} }, sessions: slugs.length },
    });
    const refused: string[] = [];
    let spooled = 0;
    for (const slug of slugs) {
      const res = api.append({
        writer: STATVS_WRITER, stream: 'work', class: WORK_CLASS, kind: 'seed-row',
        data: { slug, row: registry.sessions[slug] },
      });
      if (!res.ok && 'refused' in res) refused.push(slug);
      if (!res.ok && 'spooled' in res) spooled++;
    }
    const segment = reset.ok ? segmentRel(api, reset.row) : undefined;
    const body = JSON.stringify({
      v: SEED_MARKER_V,
      dir: api.statvsDir(),
      segment,
      at: new Date().toISOString(),
      reset: reset.ok ? 'ok' : 'refused' in reset ? `refused: ${reset.refused}` : 'spooled',
      sessions: slugs.length,
      refused,
      spooled,
    });
    invariant(resolve(dirname(marker)) === resolve(api.statvsStateDir()), 'seed marker must live in the STATVS state dir');
    const tmp = `${marker}.${process.pid}.tmp`;
    writeFileSync(tmp, body + '\n');
    renameSync(tmp, marker);
    if (refused.length > 0) {
      statvsAnomaly('work-events.statvs-seed-refused', `${refused.length}/${slugs.length} sessions refused`, logPath, refused.join(','));
    }
  });
  if (!r.ok) throw new Error(`work seed lock: ${r.message}`);
}

/** The record-relative segment path a row was written to (the record's own layout). */
function segmentRel(api: StatvsWriter, row: { class: string; app?: string; ts: string; hlc: string; writer: string }): string | undefined {
  const date = new Date(Number(row.hlc.slice(0, 13))).toISOString().slice(0, 10);
  const file = `${row.writer.replace(/[^A-Za-z0-9_.-]/g, '_')}.jsonl`;
  const parts = row.class === 'customer' ? ['customer', row.app ?? '', date, file] : [row.class, date, file];
  const rel = parts.join('/');
  return existsSync(join(api.statvsDir(), rel)) ? rel : undefined;
}

function statvsAnomaly(type: string, message: string, logPath: string, detail?: string): void {
  try {
    appendFileSync(
      anomalyPath(),
      JSON.stringify({ ts: new Date().toISOString(), type, log: logPath, message: message.slice(0, 300), detail: detail?.slice(0, 500) }) + '\n',
    );
  } catch {
    /* observability must never break the write path */
  }
}

/**
 * Write the events to STATVS. Never throws (ISC-83). An InvariantViolation is not
 * turned into a return value: it is reported to work-anomalies.jsonl as an
 * impossible state, because the work-event append it rides on already succeeded
 * and must not fail.
 */
function dualWriteToStatvs(api: StatvsWriter, events: WorkEvent[], logPath: string): void {
  try {
    let refused = 0;
    let firstRefusal = '';
    for (const ev of events) {
      const res = api.append({ writer: STATVS_WRITER, stream: 'work', class: WORK_CLASS, kind: 'event', data: ev });
      if (!res.ok && 'refused' in res) {
        refused++;
        firstRefusal ||= `${ev.slug}: ${res.refused}`;
      }
    }
    if (refused > 0) statvsAnomaly('work-events.statvs-refused', `${refused}/${events.length} events refused`, logPath, firstRefusal);
  } catch (e) {
    const type = e instanceof InvariantViolation ? 'work-events.statvs-invariant' : 'work-events.statvs-error';
    statvsAnomaly(type, (e as Error)?.message ?? String(e), logPath);
  }
}

function readSnapshot(snapPath: string): Snapshot {
  try {
    const data = JSON.parse(readFileSync(snapPath, 'utf-8'));
    return data && data.sessions ? data : { sessions: {} };
  } catch {
    return { sessions: {} };
  }
}

/**
 * Replay the log suffix beyond the snapshot's offset onto the snapshot.
 * If the recorded offset exceeds the log size (rotation/compaction), replay
 * from 0 — safe because the reducer is idempotent.
 */
export function replayOntoSnapshot(
  snapshot: Snapshot,
  logPath = workEventsPath(),
): { registry: Registry; offset: number } {
  let size = 0;
  try {
    size = statSync(logPath).size;
  } catch {
    return { registry: { sessions: snapshot.sessions || {} }, offset: 0 };
  }
  let offset = typeof snapshot._events_offset === 'number' ? snapshot._events_offset : 0;
  if (offset < 0 || offset > size) offset = 0;
  if (offset === size) return { registry: { sessions: snapshot.sessions || {} }, offset: size };
  let suffix = '';
  try {
    const buf = readFileSync(logPath);
    // Clamp the replay range to the size measured by stat() above (PR #1462, author tjkang):
    // appends happen outside the lock, so the file can grow between the stat and this read.
    // Replaying past the measured size while returning that smaller size as the offset would
    // double-apply the extra events on the next replay. Events in [size, buf.length) sit after
    // the returned offset, so the next fold picks them up exactly once.
    suffix = buf.subarray(offset, Math.min(size, buf.length)).toString('utf-8');
  } catch {
    return { registry: { sessions: snapshot.sessions || {} }, offset };
  }
  const events = parseEventLines(suffix, (line, idx) => reportAnomaly(line, idx, logPath));
  return { registry: foldEvents({ sessions: snapshot.sessions || {} }, events), offset: size };
}

/** Live read: snapshot + suffix replay. NEVER writes (ISC-39). */
export function readLiveRegistry(
  snapPath = workSnapshotPath(),
  logPath = workEventsPath(),
): Registry {
  const snapshot = readSnapshot(snapPath);
  return replayOntoSnapshot(snapshot, logPath).registry;
}

/** Staleness = no progress: newest of dir mtime and heartbeat-file mtime. */
function lockAgeMs(lock: string): number {
  let newest = 0;
  try {
    newest = statSync(lock).mtimeMs;
  } catch {
    return -1; // lock gone
  }
  try {
    const hb = statSync(join(lock, '.heartbeat')).mtimeMs;
    if (hb > newest) newest = hb;
  } catch {}
  return Date.now() - newest;
}

function acquireLock(lock: string): boolean {
  try {
    mkdirSync(lock);
    return true;
  } catch {
    const age = lockAgeMs(lock);
    if (age === -1 || age > LOCK_STALE_MS) {
      // Stale (no heartbeat for LOCK_STALE_MS) or vanished — take over.
      try {
        rmSync(lock, { recursive: true, force: true });
      } catch {}
      try {
        mkdirSync(lock);
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }
}

function releaseLock(lock: string): void {
  try {
    rmSync(lock, { recursive: true, force: true });
  } catch {}
}

/**
 * Fold appended events into the snapshot (tmp+rename), under the mkdir lock.
 * On contention the fold is skipped — events stay in the log and the next
 * writer (or any live reader) picks them up. Compacts the log past the
 * threshold: snapshot is rewritten at offset 0 FIRST, then the log archived;
 * a crash between the two double-applies an idempotent suffix (converges).
 */
export function foldToSnapshot(
  snapPath = workSnapshotPath(),
  logPath = workEventsPath(),
  thresholdBytes = COMPACT_THRESHOLD_BYTES,
): boolean {
  const lock = lockPath(logPath);
  if (!acquireLock(lock)) return false;
  try {
    // Heartbeat: refresh lock mtime so "stale" means "no progress for 10s",
    // not "acquired 10s ago" — protects a legitimately slow fold (large
    // suffix replay on a loaded machine) from a TOCTOU steal mid-write.
    try {
      writeFileSync(join(lock, '.heartbeat'), String(Date.now()));
    } catch {}
    const snapshot = readSnapshot(snapPath);
    const { registry, offset } = replayOntoSnapshot(snapshot, logPath);
    const compact = offset > thresholdBytes;
    const next: Snapshot = {
      sessions: registry.sessions,
      _events_offset: compact ? 0 : offset,
      _folded_at: new Date().toISOString(),
    };
    // Monotonic publish guard: if a concurrent folder (double-steal window)
    // already published a snapshot with a HIGHER offset against the same log,
    // renaming ours over it would regress state. Compaction (offset 0 +
    // truncate) is exempt — it deliberately resets the offset.
    if (!compact) {
      const current = readSnapshot(snapPath) as Snapshot;
      if (typeof current._events_offset === 'number' && current._events_offset > offset) {
        return false;
      }
    }
    mkdirSync(dirname(snapPath), { recursive: true });
    const tmp = snapPath + '.tmp';
    writeFileSync(tmp, JSON.stringify(next, null, 2));
    renameSync(tmp, snapPath);
    if (compact) {
      try {
        archiveCompactedLog(logPath, offset);
      } catch (e) {
        if (e instanceof InvariantViolation) throw e;
      }
    }
    return true;
  } catch (e) {
    if (e instanceof InvariantViolation) throw e;
    return false;
  } finally {
    releaseLock(lock);
  }
}

/**
 * Move a compacted log into the archive instead of erasing it. Appends do not take
 * the fold lock, so events written after the fold measured `foldedBytes` are
 * copied into the fresh log, where the offset-0 snapshot will replay them. Those
 * few boundary events then sit in both files; replay is idempotent. The archive and
 * the swap run under the append lock, which appenders hold, so an append cannot finish
 * into the archived file after the copy has read it.
 *
 * Crash safety: the archive is a hard link (a copy where links are unsupported) taken
 * while the live log stays in place, and the fresh log replaces it by one atomic
 * rename. A crash at any point leaves either the full old log or the fresh log at
 * `logPath`, never neither, so no event lives only in the archive; a crash before
 * the swap just replays the full log onto the offset-0 snapshot, which converges.
 */
function archiveCompactedLog(logPath: string, foldedBytes: number): void {
  const dir = workEventsArchiveDir(logPath);
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = join(dir, `work-events-${stamp}-${process.pid}.jsonl`);
  invariant(!existsSync(dest), `work-events archive already exists: ${dest}`);
  const move = (): void => {
    try {
      linkSync(logPath, dest);
    } catch {
      copyFileSync(logPath, dest);
    }
    // Always recreate the log, even empty, by rename over the old one: readers that stat it never see it missing.
    const tmp = `${logPath}.compact-${process.pid}.tmp`;
    writeFileSync(tmp, readFileSync(logPath).subarray(foldedBytes));
    renameSync(tmp, logPath);
  };
  // Appenders hold the append lock for the whole open-and-write, so under it no append can finish into the file
  // after it was archived and read. If the lock cannot be had the move still runs, unlocked, as before.
  if (!withAppendLock(logPath, move)) move();
}
