---
last_updated: 2026-10-17T22:00:00Z
last_updated_by: da
convention: lifeos-freshness-v1
version: 1.4.0
---

# Atlas — the LifeOS Asset Graph

> **Atlas is a graph-based current-state asset management system.** It maintains the current state of everything in the ecosystem as a queryable graph: Cloudflare workers, domains, DNS records, repos, projects, scanner targets, launchd services, machines, gear — one local SQLite graph, reconciled from sources of authority, surfaced as the ATLAS tab in Pulse. It is the current-state half of the LifeOS thesis made concrete: before you can climb toward an ideal state you need an accurate picture of the state you're in.

**Current-state split:** Atlas is the state of owned assets, Conduit (`../Conduit/ConduitSystem.md`) is the principal's observed activity, and Vigil (`../Vigil/VigilSystem.md`) carries events.

**Moving into CENSVS (2026-10-17).** Atlas is migrating into CENSVS (`../Censvs/CensvsSystem.md`, AD-12) as its observed estate kinds: domains, DNS records, services, stores, repos, machines, credentials, ingest surfaces, capabilities, controls, accounts and projects. Atlas is not the authority for any of them. Each asset's truth is the outside source a collector reads (Cloudflare, GitHub, the host, the curated files), and its history moves into the STATVS record as `observe` rows that a collector writes only when an asset appears, changes or expires, plus one row per sync run with its completeness. Atlas keeps its two jobs, collecting and answering graph queries (`owns`, `blast`, `exposed`, `reach`); its `lifecycle_event` table becomes those rows. How each Atlas asset kind maps to a RES kind, and which ones are not nouns at all, is `ATLAS_KIND_MAP` in `LIFEOS/CENSVS/genera.ts`. Credential, ingest, capability and control rows stay on this machine and never ship to the cloud until they can be sealed.

Modeled on CNCF Cartography's design (sync-and-expire collectors, per-source observations, first/last-seen stamps on every fact), rebuilt LifeOS-native: TypeScript, bun:sqlite, no server daemon, no Neo4j. Design hardened by a 2026-07-21 cross-vendor audit (see the maintainer-side `LIFEOS/ATLAS/ISA.md` Decisions — per-instance state, not in the public release payload).

## Where things live

| Piece | Path |
|---|---|
| CLI + store + collectors | `LIFEOS/ATLAS/` (`Atlas.ts`, `Store.ts`, `collectors/*.ts`) |
| ISA (persistent state-of-record) | `LIFEOS/ATLAS/ISA.md` (maintainer-side; not in the public release payload) |
| Database (SQLite, WAL) | `~/.local/state/lifeos/atlas/atlas.db` — **outside both git repos, by design** |
| Redacted Pulse snapshot | `~/.local/state/lifeos/atlas/snapshot.json` |
| Event hints | `~/.local/state/lifeos/atlas/events.jsonl` |
| Hint hook | `hooks/AtlasEventCapture.hook.ts` (PostToolUse: Bash, Write, Edit, MultiEdit) |
| Background service | `com.lifeos.atlas` — launchd (macOS, 15-min tick + WatchPaths on events file) or a systemd --user timer plus a path unit on the events file (Linux, 15-min `OnUnitActiveSec`; the path unit is the WatchPaths equivalent and fires `atlas tick` as soon as `events.jsonl` changes); installed by `LIFEOS/ATLAS/InstallAtlas.ts` |
| Pulse | module `PULSE/modules/atlas.ts` → `GET /api/atlas`, `GET/POST /api/atlas/insights` → page `/atlas` (tier1 nav): live d3-force graph + Insights + Browse + Gaps + Models tabs |
| Insights cache | `MEMORY/STATE/atlas-insights.json` (Inference narrative, keyed by metric content hash) |
| Tests | `LIFEOS/ATLAS/tests/store.test.ts` (not in the public release) (sweep invariants) |

## Architecture

**One writer class, one reader artifact.** Collectors are the only thing that writes graph facts. Pulse reads the exported snapshot, never the live DB. `atlas sql` opens read-only. This keeps the WAL single-writer model honest with zero daemon.

**Observations, not assertions.** Every asset carries per-collector `source_observation` rows — the same domain can be observed by `cloudflare`, `projects`, and `infra-inventory` at once, on ONE asset (canonical keys like `domain:example.com`, `cloudflare:worker:mysite`, `github:repo:owner/name`). An asset's lifecycle derives from ALL observations: active while any collector still sees it; stale, then expired, only when everyone has stopped. One source going quiet expires that source's observation, never the asset.

**Sync-and-expire with hard gates (the Cartography pattern, plus audit teeth).** Each run stamps what it saw. Sweeping — marking observations unfresh — happens ONLY on a successful, enumeration-complete, `full`-scope run, and only within that collector's own observations. A partial page, an API error, a rate limit → `PARTIAL` run, no sweep, prior state intact. Targeted runs are structurally incapable of expiring anything.

**Two-tier updates: reconciliation is truth, hints are latency.**
- *Reconciliation:* `atlas tick` runs a full sync when the last one is >1h old (launchd fires every 15 min).
- *Hints:* the `AtlasEventCapture` hook watches mutating tool calls (wrangler deploys, `gh repo` mutations, edits to PROJECTS.md/GEAR.md/infra-inventory.ts, launchctl ops) and appends `{ts, source}` hints. The launchd WatchPaths fires, `atlas tick` consumes the hints, and runs a *targeted* re-collect of just those sources. **Hints never write facts** — the collector re-pulls truth from the authority. A missed hint costs nothing; the hourly cycle heals.

**No secrets, ever (anti-criterion A1).** No token, key, or cookie value is stored, logged, or exported. Credential-class assets, when added, carry references only, and the snapshot strips their attrs at export. Even value-free, the graph is a map of the estate — hence local-only, outside git, behind FDE.

## Collectors (v1)

| Collector | Source of authority | Produces |
|---|---|---|
| `cloudflare` | CF API (token from `~/.claude/.env`, header auth only) | domains (zones + hostnames + workers.dev hosts), dns_records, workers (with `cron`/`workers_dev`/`queue_consumer` attrs), kv/r2/d1; edges: OWNS, SERVES (custom domain + workers.dev), ROUTE (zone routes), CALLS (service bindings, worker→worker) |
| `github` | `gh repo list` | repos (visibility, archived, pushed_at) |
| `projects` | `USER/PROJECTS.md` main table | projects; SERVES → domains, DEPLOYED_FROM → repos |
| `infra-inventory` | `CUSTOMIZATIONS/WORKFLOWS/Shared/infra-inventory.ts` (observed, never replaced) | targets, security-plane system node; MONITORS → domains, REGISTERED_IN |
| `launchd` | `~/Library/LaunchAgents/com.{lifeos,pai}.*` (plutil always `-o -`) | services, this machine; RUNS_ON edges |
| `systemd` | `~/.config/systemd/user/com.{lifeos,pai}.*.{service,timer}` (Linux sibling of `launchd` — unit files parsed directly, no subprocess) | services, this machine; RUNS_ON edges |
| `gear` | `USER/GEAR.md` tables | devices with category/role |
| `injection` | `collectors/injection-surfaces.ts` (structural, ships) + optional private overlay `USER/SECURITY/injection-surfaces.ts` | ingest (trust/channel/persists), capability (blast/reversible), control (layer/mode/fail-open), the `system:agent-context` node; edges: FLOWS_INTO, GRANTS, GUARDED_BY |
| `secrets` | the incident-response credential registry (`GenerateRegistry.ts --json`) + tier shapes (`DetectCriticalKeys.ts --format json`), both maintainer-side; not in the public release payload, so a public install shows no credential rows | credentials (priority/cadence/vendor/dependencies attrs), orphaned credentials; HOLDS edges from this machine and from the config repo when the env file is tracked in it |
| `docker` | local Docker daemon (`docker ps -aq` + one batched `docker inspect`; registered only when the `docker` CLI is on PATH — elsewhere `atlas sync docker` fails as an unknown collector, like `systemd` on macOS; degrades to PARTIAL when the daemon is stopped) | containers — all states, not just running — with image/state/ports/networks/mounts/restart-policy/compose-project attrs; RUNS_ON edges to this machine (ported from public PR #2046, @asdf8675309) |
| `models-lifeos`, `models-projects`, `models-workflows`, `models-cloudflare`, `models-codex`, `models-raycast`, `models-claude-code` (`collectors/Models.ts`; one collector per source so each sweeps on its own) | `~/.claude` code, config and agent frontmatter; every repo `PROJECTS.md` lists; workflow definitions; deployed Workers (plain-text vars and the deployed bundle); codex config; Raycast AI (its model choice is in an encrypted store, reported unreadable); the carrier and alias pins in `settings.json` | `USES` edges from each consumer to a `model:<vendor>:<id>` asset, each labelled by `LIFEOS/TOOLS/ModelEstate.ts` as tracks, pinned, stale or auto-moving; one `model-source:<name>` asset per run carrying that source's coverage (scanned, degraded or unreadable). Only model ids are stored |

`launchd` and `systemd` are platform-exclusive: `Atlas.ts` registers exactly one of them by `process.platform`, so a macOS install's collector set is unchanged and `atlas sync systemd` there fails as an unknown collector rather than reporting a permanently incomplete run.

Worker credentials come from the `cloudflare` collector, not `secrets` — each script's `/settings` response lists its `secret_text` binding NAMES, and the provider is the authority. Source-grepping a worker repo finds a small fraction, because most worker secrets are pushed with `wrangler secret put` and appear in no file.

v2 candidates (ISA § Not yet specified): UniFi/network devices, smart home, expenses/accounts, cloud observation feeder (D1 staging → local pull), credentials that live only at a vendor (OAuth grants, dashboard-issued tokens) — currently invisible to every collector.

## CLI

```
bun ~/.claude/LIFEOS/ATLAS/Atlas.ts <cmd>

sync [collector ...]        full reconcile (all collectors default)
sync X --targeted <scope>   scoped upsert-only run (never sweeps)
tick                        events-then-hourly entry (what launchd runs)
status                      per-collector runs + counts
owns <key>                  OWNS closure — what deleting <key> orphans
blast <key>                 inbound operational closure — what relies on <key>
exposed <key>               credentials <key> would leak if compromised (priority-ordered)
injection                   ingestion surfaces by trust class, with control coverage
reach <key>                 what an injection at <key> could ultimately drive
stale                       assets no collector sees anymore
unregistered                domains something SERVES but no curated target MONITORS
models [--json] [--scope <s>] [--stale]   every model, where it is used, each use's status, source coverage
insights                    deterministic metric tiles (what the Pulse Insights tab renders)
sql "SELECT ..."            read-only SQL passthrough
export                      rewrite the redacted Pulse snapshot
```

**Credentials in the graph (2026-07-24).** Credentials are assets (`kind: credential`); whatever stores one gets a `HOLDS` edge to it. Because `HOLDS` is an operational edge kind, one relationship answers both directions: `atlas exposed <asset>` walks outbound (OWNS+HOLDS) for the incident-response question — *this got compromised, what did it leak* — while `atlas blast credential:X` walks inbound for the rotation question — *what breaks when I rotate this*. Exposure output is priority-ordered, compromise-tier first, and a credential the registry never classified still carries its tier when the shapes match, so the most dangerous entries can't sort to the bottom.

Values never enter the graph. Collectors read names only, and `exportSnapshot()` blanks credential attrs before anything reaches Pulse.

The join earned itself immediately: the first env↔graph reconciliation surfaced dozens of credentials living only in Cloudflare Worker secrets that no inventory had ever seen, and multiplied the estate-wide compromise-tier count several times over.

**Trust boundaries in the graph (2026-08-19).** Infrastructure is only half the estate. The other half is every place where text somebody else wrote reaches the agent, and everything the agent can do once persuaded — prompt injection is a confused-deputy problem, so both halves have to be in the same graph or neither question is answerable.

Three asset kinds carry it. `ingest` is an entry point, with a trust class (`untrusted` / `semi` / `principal`), a channel, and — the property that matters most — whether content from it *persists* past the session. `capability` is a consequential action class with a blast domain and whether it can be undone. `control` is an enforcement point with its layer and, crucially, its **mode**: blocking, advisory, or human-gate, plus whether it fails open.

They wire through one node:

```
ingest --FLOWS_INTO--> system:agent-context --GRANTS--> capability
    \                                                      /
     `------------------ GUARDED_BY --> control <---------'
```

That single context node is the design, not a shortcut. Every untrusted surface converges on one context holding every capability, so the graph states the confused-deputy shape structurally instead of asserting it in prose.

**Which makes reach the wrong ranking.** `atlas reach ingest:feed` returns every capability, and so does every other wired surface. Sorting by reach puts everything at the top and says nothing. What actually varies is the control band — governed (something blocks), advisory-only (something watches), ungoverned (nothing) — and persistence. A poisoned page ruins one turn; a poisoned surface that writes into memory, an archive, a ledger, or a log re-enters context on every later recall with its provenance gone. `atlas injection` ranks by those two and names the ungoverned surfaces rather than counting them, because a number invites a lower number and a list invites a fix.

The registry splits along the release boundary: structural surfaces ship in `collectors/injection-surfaces.ts` (no identity, no hostnames), instance specifics live in a private overlay. The overlay may add a surface or amend one by id, and cannot delete a bundled one — "we removed the row" must never be how a real exposure leaves the census. A malformed overlay throws; a missing one degrades silently, which is the normal case on a public install.

Planning against the output belongs to the `ThreatModel` skill's `InjectionSurfaceMap` intent; the private controls register carries the live findings.

**Destructive-op doctrine:** `atlas owns`/`atlas blast` are DERIVED EVIDENCE for Algorithm criterion 16 — run them for the blast-radius preview, then confirm against the provider's authority API before any delete. Atlas never replaces the authority; the CLI prints this reminder on every owns/blast call.

## What it catches

- **Registration gaps:** `atlas unregistered` lists serving-but-uncurated domains: apps with traffic but no auth-boundary assertions in the hourly scanner.
- **Blast radius:** `atlas owns domain:example.com` lists the DNS records and hostnames a zone deletion would orphan — the exact query whose absence caused the 2026-07-17 DNS-deletion incident.
- **Drift:** an asset that stops being observed goes stale visibly (Pulse GAPS tab + lifecycle events) instead of silently vanishing.

## Pulse surfaces

- **Graph** — live `d3-force` simulation (the SVG is d3-owned, the shell is React): drag a node to pull it and pin it (double-click releases), scroll to zoom, drag the background to pan, hover to isolate a node's neighborhood. Node size encodes degree; color encodes kind; a kind-filter drives what's shown.
- **Insights** — deterministic metric tiles (`atlas insights`) PLUS an Inference-generated narrative across three axes: *running the system*, *security*, *how things interconnect*. The narrative is produced by shelling `Inference.ts --level high` over the metrics, cached to `MEMORY/STATE/atlas-insights.json` keyed by a metric content hash. When a sync changes the graph the hash moves, the cache goes `stale`, and the next view regenerates; a Regenerate button forces it. Same async pattern as the Algorithm tab's summary. This is the "run inference on updates" surface.
- **Browse** — every asset by kind with its per-source observations. **Gaps** — auth-curation gaps + stale + lifecycle events.

## Absence-metric rule (learned 2026-07-22)

**A metric that claims a thing is unused/orphaned/dead must be built on COMPLETE edge coverage — absence of one edge type is never absence of use.** The first insights pass called the overwhelming majority of workers "orphaned" because the collector only captured worker *custom domains*; it was blind to workers.dev origins, zone routes, service bindings, and cron triggers. The true unwired count was a small handful. Two guards now stand: (1) the Cloudflare collector captures all six invocation mechanisms before any orphan query runs; (2) the `unwired_workers` metric requires a worker to have NONE of {SERVES, ROUTE, CALLS-target, cron, workers.dev, queue}; (3) the insights narrative prompt forbids calling anything "unused/dead/orphaned" unless `unwired_workers` or a stale count backs it. When adding a new asset type, enumerate every way it can be connected before writing an absence query over it.

**The same rule, inverted, governs the injection census: presence of a control is never evidence of coverage.** A surface with a `GUARDED_BY` edge is only as protected as that control's *mode*, which is why mode and fail-open are stored on the control and why the census reports blocking and advisory counts separately instead of a single "controlled" boolean. An advisory control is a detector, and a detector catches what an adversary who has not read it would write. Never let a row that says "guarded" stand in for a surface that is actually stopped. Equally: a surface absent from the registry is *unenumerated*, never safe — the census must say so rather than implying its list is the world.

## Lineage

Cartography (Lyft → CNCF Sandbox 2024) proved the model: typed nodes/edges, intel modules, sync-and-expire, drift detection. Atlas keeps the model and swaps the substrate — SQLite for Neo4j (the 2026-07-21 audit's concurrency finding: embedded columnar graph engines are single-write-process; SQLite WAL matches the multi-process no-daemon topology), TS collectors for Python modules, recursive CTEs for Cypher.
