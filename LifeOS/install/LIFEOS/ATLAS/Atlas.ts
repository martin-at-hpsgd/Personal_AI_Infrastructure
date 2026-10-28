#!/usr/bin/env bun
/**
 * atlas — the LifeOS asset graph CLI.
 *
 *   atlas sync [collector ...] [--targeted <scope>]   reconcile (default: all collectors)
 *   atlas tick                                        events-then-hourly entry for launchd
 *   atlas status                                      per-collector runs + asset/edge counts
 *   atlas owns <key>                                  what deleting <key> orphans (OWNS closure)
 *   atlas blast <key>                                 what operationally relies on <key>
 *   atlas exposed <key>                               which credentials <key> would leak if compromised
 *   atlas stale                                       assets no longer observed
 *   atlas unregistered                                active domains missing security-plane coverage
 *   atlas injection                                   ingestion surfaces by trust class + control coverage
 *   atlas reach <key>                                 what an injection at <key> could ultimately drive
 *   atlas models [--json] [--scope <s>] [--stale]      every model, where it is used, each use's status, source coverage
 *   atlas sql "<select>"                              read-only SQL passthrough
 *   atlas export                                      write the redacted Pulse snapshot
 *
 * Atlas is DERIVED EVIDENCE. For destructive ops the provider's authority API remains
 * the authority; `atlas owns` runs alongside it, never instead of it (Algorithm criterion 16).
 */

import { existsSync, readFileSync, renameSync } from "node:fs";
// ported from public PR #1740, @elhoim
import { atomicWriteText } from "../PULSE/lib/atomic-write";
import { EVENTS_PATH, SNAPSHOT_PATH, Store, type Collector } from "./Store";
import { logObserve, runCollector } from "./Observe";
import { cloudflare } from "./collectors/Cloudflare";
import { github } from "./collectors/Github";
import { projects } from "./collectors/Projects";
import { infraInventory } from "./collectors/InfraInventory";
import { launchd } from "./collectors/Launchd";
import { systemd } from "./collectors/Systemd";
import { gear } from "./collectors/Gear";
import { secrets } from "./collectors/Secrets";
import { injection } from "./collectors/Injection";
import { docker } from "./collectors/Docker";
import { modelCollectors } from "./collectors/Models";
import { modelsView, renderModels, type UseStatus } from "./ModelsView";
import { atlasModelsEvent, emitSafe } from "../TOOLS/ModelEstateVigil";

// The two service collectors are platform-exclusive: exactly one is ever registered,
// so a macOS install's collector set is byte-for-byte what it was before systemd
// existed, and `atlas sync systemd` there fails loud as an unknown collector rather
// than quietly reporting an incomplete run for a backend the machine cannot have.
// ported from public PR #1743, @schmetti-dev
const SERVICE_COLLECTOR = process.platform === "linux" ? systemd : launchd;

// Docker registers only when the CLI is on PATH: a machine without docker gets
// no docker rows at all rather than a permanently PARTIAL sync, and
// `atlas sync docker` there fails loud as an unknown collector — the same
// shape as the platform-exclusive service collectors above.
// ported from public PR #2046, @asdf8675309
const OPTIONAL_COLLECTORS: Collector[] = Bun.which("docker") ? [docker] : [];

const COLLECTORS: Record<string, Collector> = Object.fromEntries(
  [cloudflare, github, projects, infraInventory, SERVICE_COLLECTOR, gear, secrets, injection, ...modelCollectors, ...OPTIONAL_COLLECTORS].map((c) => [c.name, c]),
);

const FULL_SYNC_INTERVAL_MS = 60 * 60 * 1000;

async function runSync(names: string[], scope: string): Promise<number> {
  const store = new Store();
  let failures = 0;
  try {
    for (const name of names) {
      const collector = COLLECTORS[name];
      if (!collector) {
        console.error(`unknown collector: ${name} (have: ${Object.keys(COLLECTORS).join(", ")})`);
        failures++;
        continue;
      }
      // Collect and apply; a failed collector writes NOTHING, so prior graph state stays intact. Once the run has
      // applied, the CENSVS observe step (F10) can never fail it: an observe failure is a STATVS event (ISC-65).
      const run = await runCollector(store, collector, scope, {
        onApplied: ({ runId, swept, result }) => console.log(
          `✓ ${name}: ${result.assets.length} assets, ${result.edges.length} edges ` +
          `(run ${runId}, ${result.complete ? "complete" : "PARTIAL"}${swept ? ", swept" : ""})`,
        ),
      });
      if (!run.ok) {
        failures++;
        console.error(`✗ ${name}: ${run.error}`);
        continue;
      }
      logObserve(name, run.observe);
    }
    atomicWriteText(SNAPSHOT_PATH, JSON.stringify(store.exportSnapshot()));
    // Every run that included the model collectors leaves one Vigil line, quiet runs included (Model Estate ISC-47).
    const modelRuns = names.filter((n) => n.startsWith("models-"));
    if (modelRuns.length) emitSafe(atlasModelsEvent(modelsView(store), modelRuns, `${scope}:${new Date().toISOString().slice(0, 13)}:${modelRuns.join(",")}`));
  } finally {
    store.close();
  }
  return failures;
}

/** Consume hint events (from the PostToolUse hook) → targeted syncs. Hints never write facts. */
async function processEvents(): Promise<boolean> {
  if (!existsSync(EVENTS_PATH)) return false;
  const claimed = `${EVENTS_PATH}.processing`;
  renameSync(EVENTS_PATH, claimed); // atomic claim; new hints start a fresh file
  const lines = readFileSync(claimed, "utf8").split("\n").filter(Boolean);
  const sources = new Set<string>();
  for (const line of lines) {
    try {
      const evt = JSON.parse(line) as { source?: string };
      if (evt.source && COLLECTORS[evt.source]) sources.add(evt.source);
    } catch { /* malformed hint = ignored; reconciliation heals */ }
  }
  if (sources.size === 0) return false;
  console.log(`events: ${lines.length} hints → targeted sync of [${[...sources].join(", ")}]`);
  // Targeted scope: full re-collect of the hinted source, but scope != 'full' so it can never sweep.
  await runSync([...sources], "targeted:events");
  return true;
}

function lastFullSyncAt(store: Store): number {
  const row = store.db
    .prepare("SELECT MAX(finished_at) AS t FROM sync_run WHERE scope = 'full' AND status = 'success'")
    .get() as { t: string | null };
  return row.t ? Date.parse(row.t) : 0;
}

const [cmd, ...rest] = process.argv.slice(2);

switch (cmd) {
  case "sync": {
    const targetedIdx = rest.indexOf("--targeted");
    const scope = targetedIdx >= 0 ? `targeted:${rest[targetedIdx + 1] ?? "manual"}` : "full";
    // `models` names the whole model-estate group (one collector per source, so each sweeps on its own).
    const names = rest.filter((a, i) => !a.startsWith("--") && (targetedIdx < 0 || i !== targetedIdx + 1))
      .flatMap((n) => (n === "models" ? modelCollectors.map((c) => c.name) : [n]));
    process.exit(await runSync(names.length ? names : Object.keys(COLLECTORS), scope));
  }
  case "tick": {
    const handled = await processEvents();
    const store = new Store();
    const due = Date.now() - lastFullSyncAt(store) > FULL_SYNC_INTERVAL_MS;
    store.close();
    if (due) process.exit(await runSync(Object.keys(COLLECTORS), "full"));
    if (!handled) console.log("tick: nothing to do");
    process.exit(0);
  }
  case "status": {
    const store = new Store();
    console.log(JSON.stringify(store.status(), null, 2));
    store.close();
    break;
  }
  case "owns":
  case "blast": {
    const key = rest[0];
    if (!key) { console.error(`usage: atlas ${cmd} <canonical-key>`); process.exit(2); }
    const store = new Store();
    const rows = cmd === "owns" ? store.owns(key) : store.blast(key);
    if (!store.assetByKey(key)) console.error(`⚠️ ${key} not in graph — check the key, or sync first`);
    console.log(JSON.stringify(rows, null, 2));
    console.log(`${rows.length} asset(s). Derived evidence only — confirm against the provider authority API before destructive ops.`);
    store.close();
    break;
  }
  case "exposed": {
    const key = rest[0];
    if (!key) { console.error("usage: atlas exposed <canonical-key>"); process.exit(2); }
    const store = new Store();
    if (!store.assetByKey(key)) console.error(`⚠️ ${key} not in graph — check the key, or sync first`);
    const rows = store.exposed(key).map((r) => {
      let attrs: Record<string, unknown> = {};
      try { attrs = JSON.parse(String(r.attrs ?? "{}")); } catch { /* keep empty */ }
      return { credential: r.display_name, priority: attrs.priority ?? "UNKNOWN", vendor: attrs.vendor ?? "—", dependencies: attrs.dependencies ?? "—" };
    });
    const order = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "DEFER", "ORPHAN", "UNKNOWN"];
    rows.sort((a, b) => order.indexOf(String(a.priority)) - order.indexOf(String(b.priority)) || String(a.credential).localeCompare(String(b.credential)));
    console.log(JSON.stringify(rows, null, 2));
    const crit = rows.filter((r) => r.priority === "CRITICAL").length;
    console.log(`${rows.length} credential(s) exposed, ${crit} compromise-tier. Rotation order is this list, top down.`);
    console.log("Contain the asset BEFORE rotating — rotating into a live foothold just hands over the new value.");
    store.close();
    break;
  }
  case "stale": {
    const store = new Store();
    console.log(JSON.stringify(store.stale(), null, 2));
    store.close();
    break;
  }
  case "unregistered": {
    const store = new Store();
    console.log(JSON.stringify(store.unregistered(), null, 2));
    store.close();
    break;
  }
  case "injection": {
    const store = new Store(undefined, { readonly: true });
    const surfaces = store.injectionSurfaces();
    if (surfaces.length === 0) {
      console.error("no ingestion surfaces in graph — run `atlas sync injection` first");
      store.close();
      process.exit(1);
    }
    const band = (r: Record<string, unknown>) =>
      Number(r.blocking) > 0 ? "governed" : Number(r.advisory) > 0 ? "advisory-only" : "UNGOVERNED";
    const rows = surfaces.map((r) => ({
      surface: r.canonical_key,
      trust: r.trust,
      channel: r.channel,
      persists: !!r.persists,
      band: band(r),
      controls: r.controls ?? "—",
      notes: r.notes,
    }));
    console.log(JSON.stringify({ surfaces: rows, capabilities: store.injectionCapabilities() }, null, 2));
    const untrusted = rows.filter((r) => r.trust === "untrusted");
    const ungoverned = untrusted.filter((r) => r.band === "UNGOVERNED");
    const durable = untrusted.filter((r) => r.persists && r.band !== "governed");
    console.log(`${rows.length} surface(s), ${untrusted.length} untrusted, ${ungoverned.length} ungoverned.`);
    console.log(`${durable.length} untrusted+persistent surface(s) with nothing blocking — injected text there outlives the session.`);
    console.log("Every surface reaches every capability; the control column is the only thing that varies. Rank remediation by it.");
    store.close();
    break;
  }
  case "reach": {
    const key = rest[0];
    if (!key) { console.error("usage: atlas reach <ingest:...|capability:...>"); process.exit(2); }
    const store = new Store(undefined, { readonly: true });
    if (!store.assetByKey(key)) console.error(`⚠️ ${key} not in graph — check the key, or sync first`);
    const rows = store.injectionReach(key);
    console.log(JSON.stringify(rows, null, 2));
    const caps = rows.filter((r) => r.kind === "capability");
    const irrev = caps.filter((r) => String(r.attrs ?? "").includes('"reversible":false')).length;
    console.log(`${caps.length} capability/ies reachable, ${irrev} of them irreversible.`);
    store.close();
    break;
  }
  case "models": {
    const flag = (f: string) => { const i = rest.indexOf(f); return i >= 0 ? rest[i + 1] : undefined; };
    const store = new Store(undefined, { readonly: true });
    const view = modelsView(store, { scope: flag("--scope"), status: rest.includes("--stale") ? "stale" : (flag("--status") as UseStatus | undefined) });
    store.close();
    if (Object.keys(view.coverage).length === 0) { console.error("no model sources in graph — run `atlas sync models` first"); process.exit(1); }
    console.log(rest.includes("--json") ? JSON.stringify(view, null, 2) : renderModels(view));
    break;
  }
  case "sql": {
    const q = rest.join(" ");
    if (!q) { console.error('usage: atlas sql "SELECT ..."'); process.exit(2); }
    const store = new Store(undefined, { readonly: true }); // structurally cannot write
    console.log(JSON.stringify(store.db.prepare(q).all(), null, 2));
    store.close();
    break;
  }
  case "insights": {
    const store = new Store(undefined, { readonly: true });
    console.log(JSON.stringify(store.insights(), null, 2));
    store.close();
    break;
  }
  case "export": {
    const store = new Store();
    atomicWriteText(SNAPSHOT_PATH, JSON.stringify(store.exportSnapshot()));
    console.log(`snapshot → ${SNAPSHOT_PATH}`);
    store.close();
    break;
  }
  default:
    console.log("atlas: sync | tick | status | models | owns <key> | blast <key> | exposed <key> | injection | reach <key> | stale | unregistered | insights | sql | export");
    process.exit(cmd ? 2 : 0);
}
