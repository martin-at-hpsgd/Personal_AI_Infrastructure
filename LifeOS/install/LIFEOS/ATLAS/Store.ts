/**
 * Atlas Store — SQLite system of record for the LifeOS asset graph.
 *
 * Design (2026-07-21 cross-vendor audit):
 * - bun:sqlite, WAL, STRICT tables. No daemon; Pulse reads a redacted snapshot, never the live DB.
 * - Facts come only from collectors (source_observation per collector — never a singular source field).
 * - Sweep invariants: only a successful, enumeration-complete FULL run may mark a collector's
 *   observations unfresh; targeted runs are structurally incapable of expiring anything.
 * - No secret values, ever. Credential-class assets carry references only.
 *
 * DB lives OUTSIDE both git repos (~/.local/state/lifeos/atlas/).
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { invariant } from "../TOOLS/Invariant";

export const ATLAS_DIR = process.env.ATLAS_DIR ?? join(homedir(), ".local/state/lifeos/atlas");
export const DB_PATH = join(ATLAS_DIR, "atlas.db");
export const SNAPSHOT_PATH = join(ATLAS_DIR, "snapshot.json");
export const EVENTS_PATH = join(ATLAS_DIR, "events.jsonl");

/** Days without any fresh observation before an asset/edge transitions. */
const STALE_AFTER_DAYS = 2;
const EXPIRE_AFTER_DAYS = 14;

/**
 * An asset's attrs are the per-key merge of every collector's own observation of it, so no
 * collector can erase facts another one owns by running later. When two collectors set the
 * same key, the one named here for the asset's kind wins; otherwise the latest sighting does.
 * Credentials: the secrets collector reads the registry and the tier detector, so its
 * priority, vendor and classification outrank the Cloudflare collector's binding-derived
 * guess ("deployed only, not in the env file"), which is only true when secrets never saw it.
 */
const ATTR_AUTHORITY: Record<string, string> = { credential: "secrets" };

// ── Collector contract ────────────────────────────────────────────────

export interface AssetObs {
  kind: string;
  /** Canonical, provider-scoped key, e.g. "cloudflare:worker:mysite", "domain:example.com". */
  key: string;
  name: string;
  attrs?: Record<string, unknown>;
}

export interface EdgeObs {
  kind: string;
  srcKey: string;
  dstKey: string;
  /** Kinds used to auto-create shell assets when the endpoint isn't otherwise observed. */
  srcKind?: string;
  dstKind?: string;
  attrs?: Record<string, unknown>;
}

export interface CollectResult {
  /** True ONLY when enumeration finished with no errors/truncation. Gates sweeping. */
  complete: boolean;
  assets: AssetObs[];
  edges: EdgeObs[];
}

export interface Collector {
  name: string;
  collect(scope?: string): Promise<CollectResult>;
}

/**
 * Edge kinds that propagate operational failure (used by blast-radius).
 * HOLDS belongs here: an asset holding a credential breaks when that credential rotates,
 * so `blast credential:X` correctly returns everything that needs the new value.
 */
export const OPERATIONAL_EDGE_KINDS = ["SERVES", "ROUTE", "CALLS", "DEPENDS_ON", "RUNS_ON", "OWNS", "DEPLOYED_FROM", "HOLDS"];

// ── Store ─────────────────────────────────────────────────────────────

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sync_run (
  id INTEGER PRIMARY KEY,
  collector TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'full',
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  complete INTEGER NOT NULL DEFAULT 0,
  stats TEXT
) STRICT;
CREATE TABLE IF NOT EXISTS asset (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  canonical_key TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  first_observed_at TEXT NOT NULL,
  last_observed_at TEXT NOT NULL,
  attrs TEXT NOT NULL DEFAULT '{}'
) STRICT;
CREATE INDEX IF NOT EXISTS idx_asset_kind ON asset(kind);
CREATE TABLE IF NOT EXISTS source_observation (
  asset_id INTEGER NOT NULL REFERENCES asset(id) ON DELETE CASCADE,
  collector TEXT NOT NULL,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  last_run_id INTEGER NOT NULL,
  fresh INTEGER NOT NULL DEFAULT 1,
  attrs TEXT NOT NULL DEFAULT '{}',
  claimed INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (asset_id, collector)
) STRICT;
CREATE TABLE IF NOT EXISTS edge (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  src INTEGER NOT NULL REFERENCES asset(id) ON DELETE CASCADE,
  dst INTEGER NOT NULL REFERENCES asset(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'active',
  first_observed_at TEXT NOT NULL,
  last_observed_at TEXT NOT NULL,
  attrs TEXT NOT NULL DEFAULT '{}',
  UNIQUE (kind, src, dst)
) STRICT;
CREATE TABLE IF NOT EXISTS edge_observation (
  edge_id INTEGER NOT NULL REFERENCES edge(id) ON DELETE CASCADE,
  collector TEXT NOT NULL,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  last_run_id INTEGER NOT NULL,
  fresh INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (edge_id, collector)
) STRICT;
CREATE TABLE IF NOT EXISTS lifecycle_event (
  id INTEGER PRIMARY KEY,
  asset_id INTEGER,
  event TEXT NOT NULL,
  at TEXT NOT NULL,
  detail TEXT
) STRICT;
`;

export class Store {
  db: Database;

  constructor(path: string = DB_PATH, opts: { readonly?: boolean } = {}) {
    mkdirSync(ATLAS_DIR, { recursive: true });
    this.db = new Database(path, opts.readonly ? { readonly: true } : { create: true });
    if (!opts.readonly) {
      // busy_timeout first: every later statement here, the journal-mode switch
      // included, then waits out another opener instead of failing "database is locked".
      this.db.exec("PRAGMA busy_timeout = 10000;");
      this.db.exec("PRAGMA journal_mode = WAL;");
      this.db.exec("PRAGMA foreign_keys = ON;");
      this.db.exec(SCHEMA);
      this.migrate();
    }
  }

  /**
   * Column migrations for databases created before a column existed. A
   * current database returns after one unlocked read. Otherwise the check is
   * repeated, with its ALTER, inside one IMMEDIATE transaction, which takes the
   * write lock before the check, so two processes opening an old database at
   * once serialize: the second sees the column the first added and skips.
   */
  private migrate(): void {
    const hasColumn = (table: string, column: string): boolean =>
      (this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((c) => c.name === column);
    if (hasColumn("source_observation", "claimed")) return;
    this.db.transaction(() => {
      // `claimed`: the collector emitted the asset itself, so `attrs` is its claim even when
      // empty. Edge-endpoint sightings and rows written before the column existed stay 0.
      if (!hasColumn("source_observation", "claimed")) {
        this.db.exec("ALTER TABLE source_observation ADD COLUMN claimed INTEGER NOT NULL DEFAULT 0");
      }
      invariant(hasColumn("source_observation", "claimed"), "source_observation.claimed exists after migration");
    }).immediate();
  }

  close() {
    this.db.close();
  }

  /** Apply one collector run in a single transaction. Sweeps only when eligible. */
  applyRun(collector: string, scope: string, result: CollectResult): { runId: number; swept: boolean } {
    const now = new Date().toISOString();
    const status = result.complete ? "success" : "partial";
    const insertRun = this.db.prepare(
      "INSERT INTO sync_run (collector, scope, started_at, finished_at, status, complete, stats) VALUES (?,?,?,?,?,?,?)",
    );
    const upsertAsset = this.db.prepare(`
      INSERT INTO asset (kind, canonical_key, display_name, first_observed_at, last_observed_at, status, attrs)
      VALUES ($kind, $key, $name, $now, $now, 'active', $attrs)
      ON CONFLICT(canonical_key) DO UPDATE SET
        display_name = $name, last_observed_at = $now, status = 'active'
      RETURNING id, kind`);
    const upsertObs = this.db.prepare(`
      INSERT INTO source_observation (asset_id, collector, first_seen, last_seen, last_run_id, fresh, attrs, claimed)
      VALUES ($aid, $collector, $now, $now, $run, 1, $attrs, 1)
      ON CONFLICT(asset_id, collector) DO UPDATE SET
        last_seen = $now, last_run_id = $run, fresh = 1, attrs = $attrs, claimed = 1`);
    // An edge endpoint is a sighting, not an attrs claim: it refreshes the observation and
    // leaves the attrs the collector gave the asset untouched. (Writing '{}' here erased
    // every asset's own attrs whenever the same run also drew an edge to it.)
    const touchObs = this.db.prepare(`
      INSERT INTO source_observation (asset_id, collector, first_seen, last_seen, last_run_id, fresh, attrs)
      VALUES ($aid, $collector, $now, $now, $run, 1, '{}')
      ON CONFLICT(asset_id, collector) DO UPDATE SET
        last_seen = $now, last_run_id = $run, fresh = 1`);
    const obsFor = this.db.prepare(
      "SELECT collector, fresh, attrs, claimed FROM source_observation WHERE asset_id = ? ORDER BY fresh, last_seen, collector",
    );
    const setAttrs = this.db.prepare("UPDATE asset SET attrs = ? WHERE id = ?");
    const kindById = this.db.prepare("SELECT kind FROM asset WHERE id = ?");
    const upsertEdge = this.db.prepare(`
      INSERT INTO edge (kind, src, dst, first_observed_at, last_observed_at, status, attrs)
      VALUES ($kind, $src, $dst, $now, $now, 'active', $attrs)
      ON CONFLICT(kind, src, dst) DO UPDATE SET
        last_observed_at = $now, status = 'active', attrs = $attrs
      RETURNING id`);
    const upsertEdgeObs = this.db.prepare(`
      INSERT INTO edge_observation (edge_id, collector, first_seen, last_seen, last_run_id, fresh)
      VALUES ($eid, $collector, $now, $now, $run, 1)
      ON CONFLICT(edge_id, collector) DO UPDATE SET
        last_seen = $now, last_run_id = $run, fresh = 1`);

    let runId = 0;
    let swept = false;

    const tx = this.db.transaction(() => {
      runId = Number(
        insertRun.run(collector, scope, now, now, status, result.complete ? 1 : 0,
          JSON.stringify({ assets: result.assets.length, edges: result.edges.length })).lastInsertRowid,
      );

      const idFor = new Map<string, number>();
      const kindOf = new Map<number, string>();
      const ensureAsset = (kind: string, key: string, name: string, attrs: Record<string, unknown> = {}): number => {
        const cached = idFor.get(key);
        if (cached) return cached;
        const row = upsertAsset.get({ $kind: kind, $key: key, $name: name, $now: now, $attrs: JSON.stringify(attrs) }) as { id: number; kind: string };
        idFor.set(key, row.id);
        kindOf.set(row.id, row.kind);
        return row.id;
      };

      // A collector may emit one asset more than once in a run (a richer pass, then a generic
      // one). Its observation is the per-key merge of those emissions, later ones winning.
      const ownAttrs = new Map<number, Record<string, unknown>>();
      for (const a of result.assets) {
        const aid = ensureAsset(a.kind, a.key, a.name, a.attrs ?? {});
        const merged = { ...(ownAttrs.get(aid) ?? {}), ...(a.attrs ?? {}) };
        ownAttrs.set(aid, merged);
        upsertObs.run({ $aid: aid, $collector: collector, $now: now, $run: runId, $attrs: JSON.stringify(merged) });
      }
      for (const e of result.edges) {
        const src = ensureAsset(e.srcKind ?? "unknown", e.srcKey, e.srcKey.split(":").pop() ?? e.srcKey);
        const dst = ensureAsset(e.dstKind ?? "unknown", e.dstKey, e.dstKey.split(":").pop() ?? e.dstKey);
        // A shell endpoint is still an observation by this collector.
        touchObs.run({ $aid: src, $collector: collector, $now: now, $run: runId });
        touchObs.run({ $aid: dst, $collector: collector, $now: now, $run: runId });
        const row = upsertEdge.get({ $kind: e.kind, $src: src, $dst: dst, $now: now, $attrs: JSON.stringify(e.attrs ?? {}) }) as { id: number };
        upsertEdgeObs.run({ $eid: row.id, $collector: collector, $now: now, $run: runId });
      }

      // SWEEP GATE — the only path that can un-fresh observations. The assets it un-freshes
      // get their attrs recomputed below, so a withdrawn claim leaves the asset in this run.
      if (result.complete && scope === "full") {
        const sweptIds = this.db.prepare(
          "SELECT asset_id FROM source_observation WHERE collector = ? AND last_run_id != ? AND fresh = 1",
        ).all(collector, runId) as Array<{ asset_id: number }>;
        this.db.prepare("UPDATE source_observation SET fresh = 0 WHERE collector = ? AND last_run_id != ?").run(collector, runId);
        this.db.prepare("UPDATE edge_observation SET fresh = 0 WHERE collector = ? AND last_run_id != ?").run(collector, runId);
        for (const { asset_id } of sweptIds) {
          if (kindOf.has(asset_id)) continue;
          const row = kindById.get(asset_id) as { kind: string } | null;
          invariant(row !== null, `atlas: swept observation points at missing asset ${asset_id}`);
          kindOf.set(asset_id, row.kind);
        }
        swept = true;
      }

      // Canonical attrs: per-key fold of the observations, the latest fresh one last and the
      // kind's authority (ATTR_AUTHORITY) after it, so a targeted run by one collector cannot
      // wipe facts another collector owns. Only FRESH observations count while any exists: a
      // stale one is a claim its collector has withdrawn, and folding it in kept a credential's
      // CRITICAL priority alive after it left the env registry. With no fresh observation at
      // all the asset is itself going stale, and its last known attrs (the stale fold) stand.
      for (const [id, kind] of kindOf) {
        const obs = obsFor.all(id) as Array<{ collector: string; fresh: number; attrs: string; claimed: number }>;
        const parsed = obs.map((o) => {
          const v = JSON.parse(o.attrs) as unknown;
          invariant(v !== null && typeof v === "object" && !Array.isArray(v),
            `atlas: observation attrs for asset ${id} by ${o.collector} are not an object`);
          return { collector: o.collector, fresh: o.fresh, claimed: o.claimed === 1, attrs: v as Record<string, unknown> };
        });
        // No collector has ever claimed attrs (only edge-endpoint sightings, or databases
        // written before observations carried them): keep the row as it is. An emitted asset
        // with empty attrs IS a claim, so a collector that stops claiming a fact clears it.
        if (!parsed.some((o) => o.claimed || Object.keys(o.attrs).length > 0)) continue;
        const counted = parsed.some((o) => o.fresh === 1) ? parsed.filter((o) => o.fresh === 1) : parsed;
        const auth = ATTR_AUTHORITY[kind];
        const folded: Record<string, unknown> = {};
        for (const o of [...counted.filter((o) => o.collector !== auth), ...counted.filter((o) => o.collector === auth)]) {
          Object.assign(folded, o.attrs);
        }
        setAttrs.run(JSON.stringify(folded), id);
      }

      this.deriveStatuses(now);
    });
    tx();
    return { runId, swept };
  }

  /** Canonical lifecycle derives from ALL observations: active if ANY fresh; stale/expired by age. */
  private deriveStatuses(now: string) {
    const staleCutoff = new Date(Date.now() - STALE_AFTER_DAYS * 864e5).toISOString();
    const expireCutoff = new Date(Date.now() - EXPIRE_AFTER_DAYS * 864e5).toISOString();
    const transitions = this.db.prepare(`
      SELECT a.id, a.status AS old, a.display_name,
        CASE
          WHEN EXISTS (SELECT 1 FROM source_observation o WHERE o.asset_id = a.id AND o.fresh = 1) THEN 'active'
          WHEN a.last_observed_at < ? THEN 'expired'
          WHEN a.last_observed_at < ? THEN 'stale'
          ELSE a.status
        END AS new
      FROM asset a`).all(expireCutoff, staleCutoff) as Array<{ id: number; old: string; display_name: string; new: string }>;
    const setStatus = this.db.prepare("UPDATE asset SET status = ? WHERE id = ?");
    const logEvent = this.db.prepare("INSERT INTO lifecycle_event (asset_id, event, at, detail) VALUES (?,?,?,?)");
    for (const t of transitions) {
      if (t.old !== t.new) {
        setStatus.run(t.new, t.id);
        logEvent.run(t.id, `${t.old}->${t.new}`, now, t.display_name);
      }
    }
    this.db.exec(`
      UPDATE edge SET status = CASE
        WHEN EXISTS (SELECT 1 FROM edge_observation o WHERE o.edge_id = edge.id AND o.fresh = 1) THEN 'active'
        ELSE 'stale' END`);
  }

  // ── Queries ─────────────────────────────────────────────────────────

  assetByKey(key: string) {
    return this.db.prepare("SELECT * FROM asset WHERE canonical_key = ?").get(key) as Record<string, unknown> | null;
  }

  /** Everything reachable from `key` via outbound OWNS edges (what deleting it orphans/destroys). */
  owns(key: string) {
    return this.db.prepare(`
      WITH RECURSIVE reach(id) AS (
        SELECT id FROM asset WHERE canonical_key = ?
        UNION
        SELECT e.dst FROM edge e JOIN reach r ON e.src = r.id WHERE e.kind = 'OWNS' AND e.status = 'active'
      )
      SELECT a.kind, a.canonical_key, a.display_name, a.status FROM asset a
      JOIN reach r ON a.id = r.id WHERE a.canonical_key != ?`).all(key, key) as Array<Record<string, unknown>>;
  }

  /** Inbound blast radius: what operationally relies on `key`, directly or transitively. */
  blast(key: string) {
    const kinds = OPERATIONAL_EDGE_KINDS.map(() => "?").join(",");
    return this.db.prepare(`
      WITH RECURSIVE reach(id) AS (
        SELECT id FROM asset WHERE canonical_key = ?
        UNION
        SELECT e.src FROM edge e JOIN reach r ON e.dst = r.id
        WHERE e.kind IN (${kinds}) AND e.status = 'active'
      )
      SELECT a.kind, a.canonical_key, a.display_name, a.status FROM asset a
      JOIN reach r ON a.id = r.id WHERE a.canonical_key != ?`)
      .all(key, ...OPERATIONAL_EDGE_KINDS, key) as Array<Record<string, unknown>>;
  }

  /**
   * Credential exposure: which credentials `key` holds, directly or through what it owns.
   * The incident-response direction — "this asset is compromised, what did it leak?" — as
   * opposed to blast(), which answers "what breaks if I rotate this?". Traversal follows
   * OWNS (a compromised host owns its services) and HOLDS (the thing that stores a secret).
   */
  exposed(key: string) {
    return this.db.prepare(`
      WITH RECURSIVE reach(id) AS (
        SELECT id FROM asset WHERE canonical_key = ?
        UNION
        SELECT e.dst FROM edge e JOIN reach r ON e.src = r.id
        WHERE e.kind IN ('OWNS','HOLDS') AND e.status = 'active'
      )
      SELECT a.kind, a.canonical_key, a.display_name, a.status, a.attrs FROM asset a
      JOIN reach r ON a.id = r.id
      WHERE a.canonical_key != ? AND a.kind = 'credential'`).all(key, key) as Array<Record<string, unknown>>;
  }

  stale() {
    return this.db.prepare(
      "SELECT kind, canonical_key, display_name, status, last_observed_at FROM asset WHERE status != 'active' ORDER BY last_observed_at",
    ).all() as Array<Record<string, unknown>>;
  }

  /** Domains something actively SERVES but no security-plane target MONITORS (Bunker registration gap). */
  unregistered() {
    return this.db.prepare(`
      SELECT a.kind, a.canonical_key, a.display_name,
        (SELECT s.display_name FROM edge e2 JOIN asset s ON e2.src = s.id
         WHERE e2.dst = a.id AND e2.kind = 'SERVES' AND e2.status = 'active' LIMIT 1) AS served_by
      FROM asset a
      WHERE a.kind = 'domain' AND a.status = 'active'
        AND a.canonical_key NOT LIKE '%.workers.dev'
        AND EXISTS (
          SELECT 1 FROM edge e WHERE e.dst = a.id AND e.kind = 'SERVES' AND e.status = 'active')
        AND NOT EXISTS (
          SELECT 1 FROM edge e JOIN asset t ON e.src = t.id
          WHERE e.dst = a.id AND e.kind = 'MONITORS' AND t.kind = 'target' AND e.status = 'active')
      ORDER BY a.canonical_key`).all() as Array<Record<string, unknown>>;
  }

  /**
   * Injection census: every ingestion surface with the controls standing between
   * it and agent context.
   *
   * Ranking is by RESIDUAL exposure, not by reach. Reach is uniform — every
   * surface flows into one context that holds every capability — so sorting by
   * what a surface can touch would put all of them at the top and tell you
   * nothing. What actually varies is trust class, whether the content persists
   * past the session, and whether anything BLOCKS as opposed to merely advising.
   */
  injectionSurfaces() {
    return this.db.prepare(`
      SELECT a.canonical_key, a.display_name, a.status,
        json_extract(a.attrs,'$.trust')         AS trust,
        json_extract(a.attrs,'$.channel')       AS channel,
        json_extract(a.attrs,'$.persists')      AS persists,
        json_extract(a.attrs,'$.authenticated') AS authenticated,
        json_extract(a.attrs,'$.notes')         AS notes,
        (SELECT COUNT(*) FROM edge e JOIN asset c ON c.id = e.dst
         WHERE e.src = a.id AND e.kind = 'GUARDED_BY' AND e.status = 'active'
           AND json_extract(c.attrs,'$.mode') = 'blocking')            AS blocking,
        (SELECT COUNT(*) FROM edge e JOIN asset c ON c.id = e.dst
         WHERE e.src = a.id AND e.kind = 'GUARDED_BY' AND e.status = 'active'
           AND json_extract(c.attrs,'$.mode') != 'blocking')           AS advisory,
        (SELECT COUNT(*) FROM edge e JOIN asset c ON c.id = e.dst
         WHERE e.src = a.id AND e.kind = 'GUARDED_BY' AND e.status = 'active'
           AND json_extract(c.attrs,'$.fail_open') = 1)                AS fail_open,
        (SELECT group_concat(c.canonical_key, ', ') FROM edge e JOIN asset c ON c.id = e.dst
         WHERE e.src = a.id AND e.kind = 'GUARDED_BY' AND e.status = 'active') AS controls
      FROM asset a
      WHERE a.kind = 'ingest' AND a.status = 'active'
      ORDER BY
        CASE json_extract(a.attrs,'$.trust') WHEN 'untrusted' THEN 0 WHEN 'semi' THEN 1 ELSE 2 END,
        blocking ASC,
        json_extract(a.attrs,'$.persists') DESC,
        a.canonical_key`).all() as Array<Record<string, unknown>>;
  }

  /** Capabilities agent context grants, with the controls gating each one. */
  injectionCapabilities() {
    return this.db.prepare(`
      SELECT a.canonical_key, a.display_name,
        json_extract(a.attrs,'$.blast')      AS blast,
        json_extract(a.attrs,'$.reversible') AS reversible,
        (SELECT COUNT(*) FROM edge e JOIN asset c ON c.id = e.dst
         WHERE e.src = a.id AND e.kind = 'GUARDED_BY' AND e.status = 'active'
           -- A fail-open human gate is a prompt rule nothing in code enforces, so it is not a gate.
           AND (json_extract(c.attrs,'$.mode') = 'blocking'
                OR (json_extract(c.attrs,'$.mode') = 'human-gate'
                    AND COALESCE(json_extract(c.attrs,'$.fail_open'), 0) = 0))) AS gated,
        (SELECT group_concat(c.canonical_key, ', ') FROM edge e JOIN asset c ON c.id = e.dst
         WHERE e.src = a.id AND e.kind = 'GUARDED_BY' AND e.status = 'active') AS controls
      FROM asset a
      WHERE a.kind = 'capability' AND a.status = 'active'
      ORDER BY gated ASC, json_extract(a.attrs,'$.reversible') ASC, a.canonical_key`)
      .all() as Array<Record<string, unknown>>;
  }

  /**
   * What an injection at `key` could ultimately drive: outbound closure over
   * FLOWS_INTO then GRANTS. The answer for any surface wired into agent context
   * is "everything the deputy can do" — which is the point of running it.
   */
  injectionReach(key: string) {
    return this.db.prepare(`
      WITH RECURSIVE reach(id) AS (
        SELECT id FROM asset WHERE canonical_key = ?
        UNION
        SELECT e.dst FROM edge e JOIN reach r ON e.src = r.id
        WHERE e.kind IN ('FLOWS_INTO','GRANTS','OWNS','HOLDS') AND e.status = 'active'
      )
      SELECT a.kind, a.canonical_key, a.display_name, a.attrs FROM asset a
      JOIN reach r ON a.id = r.id
      WHERE a.canonical_key != ?
      ORDER BY CASE a.kind WHEN 'capability' THEN 0 WHEN 'credential' THEN 1 ELSE 2 END, a.canonical_key`)
      .all(key, key) as Array<Record<string, unknown>>;
  }

  status() {
    const collectors = this.db.prepare(`
      SELECT collector, MAX(finished_at) AS last_run,
        SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS successes, COUNT(*) AS runs
      FROM sync_run GROUP BY collector ORDER BY collector`).all();
    const assets = this.db.prepare(
      "SELECT kind, status, COUNT(*) AS n FROM asset GROUP BY kind, status ORDER BY kind",
    ).all();
    const totals = this.db.prepare(
      "SELECT (SELECT COUNT(*) FROM asset) AS assets, (SELECT COUNT(*) FROM edge WHERE status='active') AS edges",
    ).get();
    return { collectors, assets, totals };
  }

  /** Deterministic structural metrics — the factual half of the Insights tab (no inference). */
  insights() {
    const one = (sql: string, ...args: unknown[]) =>
      (this.db.prepare(sql).get(...(args as never[])) as Record<string, number>) ?? {};
    const all = (sql: string) => this.db.prepare(sql).all() as Array<Record<string, unknown>>;

    return {
      census: all("SELECT kind, COUNT(*) AS n FROM asset WHERE status='active' GROUP BY kind ORDER BY n DESC"),
      edge_census: all("SELECT kind, COUNT(*) AS n FROM edge WHERE status='active' GROUP BY kind ORDER BY n DESC"),
      // Operation: workers with NO invocation path at all — not served (custom domain
      // or workers.dev), not routed, not called by another worker, no cron, no queue.
      // This is the real "dead deploy" signal; a missing custom-domain alone is NOT.
      unwired_workers: one(`
        SELECT COUNT(*) AS n FROM asset a
        WHERE a.kind='worker' AND a.status='active'
          AND json_extract(a.attrs,'$.workers_dev') IS NOT 1
          AND json_extract(a.attrs,'$.cron') IS NOT 1
          AND json_extract(a.attrs,'$.queue_consumer') IS NOT 1
          AND NOT EXISTS (SELECT 1 FROM edge e WHERE e.src=a.id AND e.kind IN ('SERVES','ROUTE') AND e.status='active')
          AND NOT EXISTS (SELECT 1 FROM edge e WHERE e.dst=a.id AND e.kind='CALLS' AND e.status='active')`).n,
      // How workers are actually wired — the honest breakdown.
      worker_wiring: {
        total: one("SELECT COUNT(*) AS n FROM asset WHERE kind='worker' AND status='active'").n,
        served: one("SELECT COUNT(DISTINCT src) AS n FROM edge e JOIN asset a ON e.src=a.id WHERE a.kind='worker' AND e.kind IN ('SERVES','ROUTE') AND e.status='active'").n,
        workers_dev: one("SELECT COUNT(*) AS n FROM asset WHERE kind='worker' AND status='active' AND json_extract(attrs,'$.workers_dev')=1").n,
        cron: one("SELECT COUNT(*) AS n FROM asset WHERE kind='worker' AND status='active' AND json_extract(attrs,'$.cron')=1").n,
        service_binding_target: one("SELECT COUNT(DISTINCT dst) AS n FROM edge WHERE kind='CALLS' AND status='active'").n,
      },
      // Operation: live projects with no repo edge — provenance gap.
      projects_no_repo: one(
        "SELECT COUNT(*) AS n FROM asset a WHERE a.kind='project' AND a.status='active' AND NOT EXISTS (SELECT 1 FROM edge e WHERE e.src=a.id AND e.kind='DEPLOYED_FROM')",
      ).n,
      // Interconnection: zones ranked by what they own — the blast-radius map.
      blast_zones: all(
        "SELECT s.display_name AS zone, COUNT(*) AS owns FROM edge e JOIN asset s ON e.src=s.id WHERE e.kind='OWNS' AND s.kind='domain' AND e.status='active' GROUP BY s.id ORDER BY owns DESC LIMIT 8",
      ),
      // Data-store sprawl.
      data_stores: all(
        "SELECT kind, COUNT(*) AS n FROM asset WHERE kind IN ('d1_database','r2_bucket','kv_namespace') AND status='active' GROUP BY kind",
      ),
      // Security: domains served but with no curated auth-boundary target (see unregistered() semantics).
      auth_curation_gaps: this.unregistered().length,
      // Security: multi-tenant/auth-bearing targets present, for context on what SHOULD be curated.
      curated_targets: one("SELECT COUNT(*) AS n FROM asset WHERE kind='target' AND status='active'").n,
      // Security: trust boundaries. `ungoverned` is the headline — an untrusted
      // surface with no control of any kind between it and agent context.
      // `advisory_only` is the second tier: something is watching, nothing stops it.
      injection: (() => {
        const s = this.injectionSurfaces();
        const untrusted = s.filter((r) => r.trust === "untrusted");
        return {
          surfaces: s.length,
          untrusted: untrusted.length,
          persistent: s.filter((r) => r.persists === 1 || r.persists === true).length,
          ungoverned: untrusted.filter((r) => Number(r.blocking) + Number(r.advisory) === 0).length,
          advisory_only: untrusted.filter((r) => Number(r.blocking) === 0 && Number(r.advisory) > 0).length,
          // The compounding class: attacker text that survives the session and
          // re-enters context later, with nothing blocking it on the way in.
          persistent_ungoverned: untrusted.filter(
            (r) => (r.persists === 1 || r.persists === true) && Number(r.blocking) === 0,
          ).map((r) => r.canonical_key),
          capabilities: one("SELECT COUNT(*) AS n FROM asset WHERE kind='capability' AND status='active'").n,
          irreversible_capabilities: this.injectionCapabilities().filter((c) => c.reversible === 0 || c.reversible === false).length,
        };
      })(),
      stale: one("SELECT COUNT(*) AS n FROM asset WHERE status!='active'").n,
      totals: this.status().totals,
    };
  }

  /** Redacted snapshot for Pulse — credential-class assets are summarized, attrs stripped. */
  exportSnapshot(): Record<string, unknown> {
    const assets = (this.db.prepare(
      "SELECT id, kind, canonical_key, display_name, status, first_observed_at, last_observed_at, attrs FROM asset",
    ).all() as Array<Record<string, unknown>>).map((a) => ({
      ...a,
      attrs: a.kind === "credential" ? "{}" : a.attrs,
    }));
    // USES edges keep their attrs for the Pulse Models tab: status, lanes, source, model ids, and the
    // where-used labels in `files` (repo-relative paths, or the Raycast leg's synced command titles).
    // No credential value reaches them; they are as private as the asset display names beside them.
    const edges = this.db.prepare("SELECT kind, src, dst, status, CASE WHEN kind = 'USES' THEN attrs END AS attrs FROM edge").all();
    const observations = this.db.prepare(
      "SELECT asset_id, collector, fresh, last_seen FROM source_observation",
    ).all();
    const lifecycle = this.db.prepare(
      "SELECT asset_id, event, at, detail FROM lifecycle_event ORDER BY id DESC LIMIT 50",
    ).all();
    const unregistered = this.unregistered();
    return { assets, edges, observations, lifecycle, unregistered, status: this.status(), generated_at: new Date().toISOString() };
  }
}
