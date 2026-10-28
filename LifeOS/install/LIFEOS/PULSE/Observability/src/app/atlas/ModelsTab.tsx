"use client";

import { useMemo, useState } from "react";
import { Cpu, AlertTriangle, RefreshCw, Eye } from "lucide-react";
import { Panel, PanelHeader, StatTile, Pill, EmptyState, type Dim } from "@/components/ui/chrome";

/**
 * Models — every model we run, every place it is used, and whether each use is current.
 * Reads the same Atlas snapshot as the other tabs: `model` assets, `USES` edges (their attrs
 * carry the status) and `model-source` assets (each source's coverage). Holds no data.
 */

type Status = "tracks" | "pinned" | "auto-moving" | "stale";
interface SnapAsset { id: number; kind: string; canonical_key: string; display_name: string; status: string; attrs?: string }
interface SnapEdge { kind: string; src: number; dst: number; status: string; attrs?: string | null }

const DIM: Record<Status, Dim> = { tracks: "ok", pinned: "neutral", "auto-moving": "warn", stale: "err" };
const RANK: Record<Status, number> = { tracks: 0, pinned: 1, "auto-moving": 2, stale: 3 };
const COVERAGE_DIM: Record<string, Dim> = { scanned: "ok", degraded: "warn", unreadable: "err" };

const parse = (s: unknown): Record<string, any> => { try { return JSON.parse(String(s ?? "{}")); } catch { return {}; } };

interface Use { consumer: SnapAsset; status: Status; scope: string; current_id?: string; via: string[]; observed: string }
interface ModelRow { asset: SnapAsset; attrs: Record<string, any>; uses: Use[]; worst: Status | null }

export function ModelsTab({ assets, edges }: { assets: SnapAsset[]; edges: SnapEdge[] }) {
  const [open, setOpen] = useState<number | null>(null);
  const [only, setOnly] = useState<Status | null>(null);

  const { rows, sources, counts, snapshots } = useMemo(() => {
    const byId = new Map(assets.map((a) => [a.id, a]));
    const uses = new Map<number, Use[]>();
    const counts: Record<Status, number> = { tracks: 0, pinned: 0, "auto-moving": 0, stale: 0 };
    for (const e of edges) {
      if (e.kind !== "USES") continue;
      const consumer = byId.get(e.src);
      const model = byId.get(e.dst);
      if (!consumer || !model || model.kind !== "model") continue;
      const a = parse(e.attrs);
      const status = (a.status ?? "pinned") as Status;
      const scope = String(parse(consumer.attrs).scope ?? { worker: "deployed", workflow: "workflow", tool: "tool" }[consumer.kind] ?? "other");
      if (e.status === "active") counts[status]++;
      (uses.get(model.id) ?? uses.set(model.id, []).get(model.id)!).push({ consumer, status, scope, current_id: a.current_id, via: a.via ?? [], observed: e.status });
    }
    const rows: ModelRow[] = assets
      .filter((a) => a.kind === "model")
      .map((a) => {
        const u = (uses.get(a.id) ?? []).sort((x, y) => RANK[y.status] - RANK[x.status] || x.consumer.display_name.localeCompare(y.consumer.display_name));
        const worst = u.length ? u.reduce<Status>((w, x) => (RANK[x.status] > RANK[w] ? x.status : w), "tracks") : null;
        return { asset: a, attrs: parse(a.attrs), uses: u, worst };
      })
      .filter((r) => r.uses.length > 0 || r.attrs.registry === "current")
      .sort((x, y) => RANK[y.worst ?? "tracks"] - RANK[x.worst ?? "tracks"] || y.uses.length - x.uses.length);
    const sources = assets.filter((a) => a.kind === "model-source").map((a) => {
      const s = parse(a.attrs);
      return { name: a.display_name, coverage: String(s.coverage ?? "unreadable"), detail: String(s.detail ?? "") };
    });
    const snapshots = assets
      .filter((a) => a.kind === "registry-snapshot" && a.status === "active")
      .map((a) => parse(a.attrs) as { worker: string; deployed: string | null; behind: Array<{ lane: string }> })
      .filter((s) => (s.behind ?? []).length > 0)
      .sort((a, b) => b.behind.length - a.behind.length || a.worker.localeCompare(b.worker));
    return { rows, sources, counts, snapshots };
  }, [assets, edges]);

  if (sources.length === 0) {
    return <EmptyState icon={Cpu} title="No model sources yet" hint="Run `atlas sync models`." />;
  }

  const shown = only ? rows.filter((r) => r.uses.some((u) => u.status === only)) : rows;
  const unreadable = sources.filter((s) => s.coverage !== "scanned").length;

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Models" value={String(rows.filter((r) => r.uses.length).length)} icon={Cpu} sub="in use somewhere" />
        <StatTile label="On a lane" value={String(counts.tracks)} icon={RefreshCw} sub="move with the registry" />
        <StatTile label="Behind" value={String(counts.stale)} icon={AlertTriangle} sub="registry has moved past" />
        <StatTile label="Read gaps" value={`${unreadable}/${sources.length}`} icon={Eye} sub="sources not fully read" />
      </div>

      <Panel>
        <PanelHeader title="Coverage" meta="unread sources keep their last edges" />
        <div className="text-sm">
          {sources.map((s) => (
            <div key={s.name} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-line-1 py-1.5">
              <Pill dim={COVERAGE_DIM[s.coverage] ?? "neutral"}>{s.coverage}</Pill>
              <span className="text-ink-1 font-mono text-xs">{s.name}</span>
              <span className="text-ink-3 text-xs break-words min-w-0 flex-1">{s.detail}</span>
            </div>
          ))}
        </div>
      </Panel>

      {snapshots.length > 0 && (
        <Panel>
          <PanelHeader title={`Old registry copies — ${snapshots.length}`} meta="a redeploy refreshes the copy" />
          <div className="text-sm">
            {snapshots.map((s) => (
              <div key={s.worker} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-line-1 py-1.5">
                <span className="text-ink-1 font-mono text-xs">{s.worker}</span>
                <span className="text-ink-3 text-xs">deployed {(s.deployed ?? "?").slice(0, 10)}</span>
                <span className="text-ink-3 text-xs break-words min-w-0 flex-1">behind on {s.behind.map((b) => b.lane).join(", ")}</span>
              </div>
            ))}
          </div>
        </Panel>
      )}

      <Panel>
        <PanelHeader title="Models" meta="click one to see where it runs" />
        <div className="flex flex-wrap gap-2 pb-3">
          {(["stale", "auto-moving", "pinned", "tracks"] as Status[]).map((s) => (
            <button key={s} type="button" onClick={() => setOnly(only === s ? null : s)} className="cursor-pointer">
              <Pill dim={DIM[s]} className={only && only !== s ? "opacity-40" : ""}>{s} · {counts[s]}</Pill>
            </button>
          ))}
        </div>
        <div className="text-sm">
          {shown.map((r) => {
            const by = (s: Status) => r.uses.filter((u) => u.status === s && u.observed === "active").length;
            const isOpen = open === r.asset.id;
            return (
              <div key={r.asset.id} className="border-b border-line-1">
                <button type="button" onClick={() => setOpen(isOpen ? null : r.asset.id)} className="w-full text-left py-1.5 cursor-pointer flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="text-ink-1 font-mono text-xs break-all">{r.attrs.id ?? r.asset.display_name}</span>
                  <span className="text-ink-3 text-xs">{r.attrs.vendor}{r.attrs.lanes?.length ? ` · ${r.attrs.lanes.join(", ")}` : ""} · {r.attrs.registry}</span>
                  <span className="flex gap-1 ml-auto">
                    {(["stale", "auto-moving", "pinned", "tracks"] as Status[]).map((s) => by(s) > 0 && <Pill key={s} dim={DIM[s]}>{by(s)} {s}</Pill>)}
                  </span>
                </button>
                {isOpen && (
                  <div className="pb-2 pl-3">
                    {r.uses.length === 0 && <div className="text-ink-3 text-xs py-1">in the registry, used nowhere we can see</div>}
                    {r.uses.map((u) => (
                      <div key={u.consumer.id} className="flex flex-wrap items-baseline gap-x-2 py-0.5 text-xs">
                        <Pill dim={DIM[u.status]}>{u.status}</Pill>
                        <span className="text-ink-3 w-16 shrink-0">{u.scope}</span>
                        <span className="text-ink-1 font-mono break-all min-w-0">{u.consumer.display_name}</span>
                        {u.current_id && <span className="text-ink-3">→ {u.current_id}</span>}
                        {u.observed !== "active" && <span className="text-ink-3">(not seen last run)</span>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </Panel>
    </div>
  );
}
