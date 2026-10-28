/**
 * The model estate as one read: every model, every place it is used, each use's status,
 * each source's coverage, and each product judged by what is deployed as well as what the
 * repo says. Read-only over the Atlas store. Feeds `atlas models` and the Pulse Models tab.
 */

import type { Store } from "./Store";

export type UseStatus = "tracks" | "pinned" | "stale" | "auto-moving";
const RANK: Record<UseStatus, number> = { tracks: 0, pinned: 1, "auto-moving": 2, stale: 3 };
const worst = (xs: UseStatus[]): UseStatus | null => (xs.length ? xs.reduce((a, b) => (RANK[a] >= RANK[b] ? a : b)) : null);

export type ConsumerUse = {
  consumer: string; kind: string; name: string; scope: string;
  status: UseStatus; source: string; via: string[]; lanes: string[];
  current_id?: string; unregistered?: boolean; ahead?: boolean; files?: string[]; observed: string;
};
export type ModelRow = { key: string; id: string; vendor: string; class: string; lanes: string[]; registry: string; consumers: ConsumerUse[] };
export type ProductRow = { repo: string; project: string | null; repo_status: UseStatus | null; deployed: Array<{ worker: string; status: UseStatus | null }>; effective: UseStatus | null };
/** A worker that bundled a copy of the model registry: one fact, the lanes its copy is behind on. */
export type SnapshotRow = { worker: string; deployed: string | null; lanes: number; behind: Array<{ lane: string; id: string; current: string }> };
export type ModelsView = { models: ModelRow[]; coverage: Record<string, { coverage: string; detail: string; at: string }>; products: ProductRow[]; counts: Record<UseStatus, number>; snapshots: SnapshotRow[] };

const parse = (s: unknown): Record<string, any> => { try { return JSON.parse(String(s ?? "{}")); } catch { return {}; } };

const SCOPE_OF_KIND: Record<string, string> = { worker: "deployed", workflow: "workflow", tool: "tool" };

export function modelsView(store: Store, opts: { scope?: string; status?: UseStatus } = {}): ModelsView {
  const db = store.db;
  const models = db.prepare("SELECT canonical_key, display_name, attrs FROM asset WHERE kind = 'model' AND status != 'expired' ORDER BY canonical_key").all() as Array<{ canonical_key: string; display_name: string; attrs: string }>;
  const uses = db.prepare(`
    SELECT m.canonical_key AS model, c.canonical_key AS consumer, c.kind, c.display_name AS name, c.attrs AS cattrs, e.attrs AS eattrs, e.status AS observed
    FROM edge e JOIN asset c ON c.id = e.src JOIN asset m ON m.id = e.dst
    WHERE e.kind = 'USES' AND m.kind = 'model'`).all() as Array<Record<string, string>>;

  const byModel = new Map<string, ConsumerUse[]>();
  const counts: Record<UseStatus, number> = { tracks: 0, pinned: 0, stale: 0, "auto-moving": 0 };
  for (const u of uses) {
    const ea = parse(u.eattrs);
    const ca = parse(u.cattrs);
    const scope = String(ca.scope ?? SCOPE_OF_KIND[u.kind] ?? "other");
    const row: ConsumerUse = {
      consumer: u.consumer, kind: u.kind, name: u.name, scope, status: ea.status, source: ea.source, via: ea.via ?? [], lanes: ea.lanes ?? [],
      ...(ea.current_id ? { current_id: ea.current_id } : {}), ...(ea.unregistered ? { unregistered: true } : {}),
      ...(ea.ahead ? { ahead: true } : {}), ...(ea.files?.length ? { files: ea.files } : {}), observed: u.observed,
    };
    if (opts.scope && scope !== opts.scope) continue;
    if (opts.status && row.status !== opts.status) continue;
    if (u.observed === "active" && row.status in counts) counts[row.status]++;
    (byModel.get(u.model) ?? byModel.set(u.model, []).get(u.model)!).push(row);
  }

  const out: ModelRow[] = [];
  for (const m of models) {
    const a = parse(m.attrs);
    const consumers = (byModel.get(m.canonical_key) ?? []).sort((x, y) => RANK[y.status] - RANK[x.status] || x.consumer.localeCompare(y.consumer));
    if ((opts.scope || opts.status) && consumers.length === 0) continue;
    out.push({ key: m.canonical_key, id: a.id ?? m.display_name, vendor: a.vendor ?? "unknown", class: a.class ?? "", lanes: a.lanes ?? [], registry: a.registry ?? "other", consumers });
  }

  const coverage: ModelsView["coverage"] = {};
  for (const s of db.prepare("SELECT display_name, attrs FROM asset WHERE kind = 'model-source' ORDER BY display_name").all() as Array<{ display_name: string; attrs: string }>) {
    const a = parse(s.attrs);
    coverage[s.display_name] = { coverage: a.coverage ?? "unreadable", detail: a.detail ?? "", at: a.at ?? "" };
  }

  const snapshots = (db.prepare("SELECT attrs FROM asset WHERE kind = 'registry-snapshot' AND status = 'active'").all() as Array<{ attrs: string }>)
    .map((r) => parse(r.attrs) as SnapshotRow)
    .sort((a, b) => b.behind.length - a.behind.length || a.worker.localeCompare(b.worker));

  return { models: out, coverage, products: productRollup(uses), counts, snapshots };
}

/** A product is as current as the worse of its repo and every worker deployed from it:
 *  a repo bumped but never deployed still runs the old model. Pure over the use rows. */
function productRollup(uses: Array<Record<string, string>>): ProductRow[] {
  const statusOf = new Map<string, UseStatus[]>();
  const repoAttrs = new Map<string, Record<string, any>>();
  for (const u of uses) {
    if (u.observed !== "active") continue;
    const s = parse(u.eattrs).status as UseStatus;
    (statusOf.get(u.consumer) ?? statusOf.set(u.consumer, []).get(u.consumer)!).push(s);
    if (u.consumer.startsWith("code:repo:")) repoAttrs.set(u.consumer, parse(u.cattrs));
  }
  return [...repoAttrs.entries()].map(([repo, a]) => {
    const repoStatus = worst(statusOf.get(repo) ?? []);
    const workers = a.worker ? [String(a.worker)] : [];
    const deployed = workers.map((w) => ({ worker: w, status: worst(statusOf.get(`cloudflare:worker:${w}`) ?? []) }));
    const effective = worst([repoStatus, ...deployed.map((d) => d.status)].filter((x): x is UseStatus => !!x));
    return { repo, project: a.project ?? null, repo_status: repoStatus, deployed, effective };
  }).sort((x, y) => (RANK[y.effective ?? "tracks"] - RANK[x.effective ?? "tracks"]) || x.repo.localeCompare(y.repo));
}

/** Plain-text rendering for a terminal. */
export function renderModels(v: ModelsView): string {
  const lines: string[] = [];
  const mark: Record<UseStatus, string> = { tracks: "✓", pinned: "·", "auto-moving": "↻", stale: "✗" };
  for (const m of v.models) {
    if (!m.consumers.length && m.registry !== "current") continue;
    lines.push(`${m.id}  [${m.vendor}${m.lanes.length ? ` · ${m.lanes.join(", ")}` : ""} · ${m.registry}]  ${m.consumers.length} use(s)`);
    for (const c of m.consumers.slice(0, 12)) {
      lines.push(`  ${mark[c.status] ?? "?"} ${c.status.padEnd(11)} ${c.scope.padEnd(8)} ${c.name}${c.current_id ? `  → ${c.current_id}` : ""}${c.observed !== "active" ? "  (not seen last run)" : ""}`);
    }
    if (m.consumers.length > 12) lines.push(`  … ${m.consumers.length - 12} more`);
  }
  lines.push("", "Products (repo vs deployed):");
  for (const p of v.products) {
    lines.push(`  ${String(p.effective ?? "—").padEnd(11)} ${p.repo.replace("code:repo:", "")}  repo=${p.repo_status ?? "—"}${p.deployed.map((d) => ` ${d.worker}=${d.status ?? "no model seen"}`).join("")}`);
  }
  const old = v.snapshots.filter((s) => s.behind.length);
  if (v.snapshots.length) {
    lines.push("", `Workers carrying a bundled copy of the registry: ${v.snapshots.length}, ${old.length} of them behind (a redeploy refreshes the copy; the bundle cannot show which lanes the worker calls):`);
    for (const s of old) lines.push(`  ${s.worker}  deployed ${(s.deployed ?? "?").slice(0, 10)}  behind on ${s.behind.map((b) => b.lane).join(", ")}`);
  }
  lines.push("", "Coverage:");
  for (const [s, c] of Object.entries(v.coverage)) lines.push(`  ${c.coverage.padEnd(10)} ${s}  ${c.detail}`);
  lines.push("", `Uses: ${v.counts.tracks} tracking, ${v.counts.pinned} pinned, ${v.counts["auto-moving"]} auto-moving, ${v.counts.stale} stale.`);
  return lines.join("\n");
}
