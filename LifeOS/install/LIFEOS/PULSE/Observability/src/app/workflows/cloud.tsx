"use client";

import { useState } from "react";
import { ArrowLeft, Box, ChevronRight, Cloud, GitBranch, ShieldAlert, ShieldCheck, Timer } from "lucide-react";
import Link from "next/link";
import EmptyStateGuide from "@/components/EmptyStateGuide";
import { Panel, PanelHeader, Pill, StatTile, type Dim } from "@/components/ui/chrome";
import { ApiError, useApi } from "@/lib/api";
import { fmtDateParts } from "@/lib/time";

// Workflows → Cloud tab, lower band: the Cloudflare Worker source browser that
// used to be its own "Cloud Workflows" page. Reads /api/wiki/workers for
// the list and /api/wiki/workers/<name> for one worker's wrangler + source. The
// inventory's cloud records (health, schedule, findings) sit above it on the tab.

interface CloudWorker {
  name: string;
  type: "action" | "pipeline" | "flow";
  cfName: string | null;
  lastModified: string;
}

interface CloudWorkerDetail {
  name: string;
  type: "action" | "pipeline" | "flow";
  wrangler: string | null;
  source: string | null;
  lastModified: string;
}

interface WorkerList {
  workers: CloudWorker[];
  total: number;
  actions: number;
  pipelines: number;
  flows: number;
}

const TYPE_CONFIG = {
  action: { icon: Box, color: "var(--creative)", label: "Action", dim: "creative" },
  pipeline: { icon: GitBranch, color: "var(--freedom)", label: "Pipeline", dim: "freedom" },
  flow: { icon: Timer, color: "var(--rhythms)", label: "Flow", dim: "rhythms" },
} as const;

type WorkerType = keyof typeof TYPE_CONFIG;
const WORKER_TYPES: readonly WorkerType[] = ["action", "pipeline", "flow"];

export const WORKER_PARAM = "name";

// ── Security scan status strip (compact; links to the full Security view) ──
// The security scan runs on the cloud workers, so its health shows here; full detail lives on /security.
interface ScanSummary {
  scan: { timestamp: string | null; targetsScanned: number; findingCounts: { critical: number; high: number } } | null;
}

function relTimeShort(iso: string | null | undefined): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  return hrs < 24 ? `${hrs}h ago` : `${Math.round(hrs / 24)}d ago`;
}

/** The sentence the worker browser has always shown for a failed read. */
const failureText = (e: unknown): string => (e instanceof ApiError ? `the API answered HTTP ${e.status}` : e instanceof Error ? e.message : String(e));

export function SecurityScanStrip() {
  const { data } = useApi<ScanSummary>("/api/security/attack-surface", { refetchInterval: 60_000 });
  const scan = data?.scan;
  // "Clean" is an assurance: it needs a scan that reported counts. While loading, on a failed read, or before the
  // first scan, the strip says there is no scan data instead of claiming a clean surface.
  const counts = scan?.findingCounts;
  const known = counts != null && typeof counts.critical === "number" && typeof counts.high === "number";
  const crit = counts?.critical ?? 0;
  const high = counts?.high ?? 0;
  const clean = known && crit === 0 && high === 0;
  const Icon = clean ? ShieldCheck : ShieldAlert;
  const tone: Dim = !known ? "neutral" : clean ? "ok" : "err";

  return (
    <Link href="/security" className="block group">
      <Panel className="p-3 transition-colors hover:bg-[var(--surface-2)]">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <Icon className={`w-4 h-4 ${!known ? "text-ink-3" : clean ? "text-ok" : "text-err"}`} />
            <span className="text-sm font-medium text-ink-1">Attack Surface Scan</span>
            <Pill dim={tone}>{!known ? "no scan data" : clean ? "clean" : `${crit} critical · ${high} high`}</Pill>
          </div>
          <div className="flex items-center gap-4 text-xs text-ink-2">
            <span className="mono">{scan?.targetsScanned ?? "—"} targets</span>
            <span>hourly · {relTimeShort(scan?.timestamp)}</span>
            <span className="flex items-center gap-0.5 text-ink-3 group-hover:text-ink-1">details <ChevronRight className="w-3.5 h-3.5" /></span>
          </div>
        </div>
      </Panel>
    </Link>
  );
}

function WorkerList({ list, onPick }: { list: WorkerList; onPick: (name: string) => void }) {
  const [filter, setFilter] = useState<WorkerType | null>(null);
  const grouped: Record<WorkerType, CloudWorker[]> = {
    action: list.workers.filter((w) => w.type === "action"),
    pipeline: list.workers.filter((w) => w.type === "pipeline"),
    flow: list.workers.filter((w) => w.type === "flow"),
  };
  const counts: Record<WorkerType, number> = { action: list.actions, pipeline: list.pipelines, flow: list.flows };

  if (list.workers.length === 0) {
    return (
      <EmptyStateGuide
        section="Workflows Pipelines"
        description="Cloud-side actions and pipelines that compose into multi-step workflows — think Unix pipes for cron-driven AI work."
        hideInterview
        daPromptExample="help me set up my first Workflows action"
      />
    );
  }

  return (
    <>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <StatTile label="Total" value={list.workers.length} icon={Cloud} dim="relationships" active={filter === null} onClick={() => setFilter(null)} />
        {WORKER_TYPES.map((type) => {
          const cfg = TYPE_CONFIG[type];
          return (
            <StatTile
              key={type}
              label={`${cfg.label}s`}
              value={counts[type]}
              icon={cfg.icon}
              dim={cfg.dim as Dim}
              active={filter === type}
              onClick={() => setFilter(filter === type ? null : type)}
            />
          );
        })}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {WORKER_TYPES.filter((type) => !filter || type === filter).map((type) => {
          const cfg = TYPE_CONFIG[type];
          const Icon = cfg.icon;
          return (
            <div key={type} className="flex flex-col gap-3">
              <h3 className="text-sm font-medium uppercase tracking-wider flex items-center gap-2 text-ink-3">
                <Icon className="w-4 h-4" style={{ color: cfg.color }} />
                {cfg.label}s
                <span className="text-ink-3 text-[12px]">({grouped[type].length})</span>
              </h3>
              <div className="flex flex-col gap-2">
                {grouped[type].map((worker) => (
                  <button
                    key={worker.name}
                    type="button"
                    onClick={() => onPick(worker.name)}
                    className="flex items-center gap-2 bg-surface-2 border border-line-2 rounded-xl px-3.5 py-2.5 text-left transition-colors duration-200 hover:bg-surface-3 hover:border-line-3"
                    style={{ borderLeft: `3px solid ${cfg.color}` }}
                  >
                    <Icon className="w-3.5 h-3.5 shrink-0" style={{ color: cfg.color }} />
                    <span className="mono truncate text-ink-1 text-[13px]">{worker.name.replace(/^_(A|P|F)_/, "")}</span>
                    <Pill dim={cfg.dim as Dim} className="ml-auto">
                      {cfg.label}
                    </Pill>
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

function CodeBlock({ title, code, tall }: { title: string; code: string; tall?: boolean }) {
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-xs font-medium uppercase tracking-wider text-ink-3">{title}</h3>
      <Panel className="p-0 overflow-hidden">
        <pre
          className={`text-xs mono overflow-x-auto leading-relaxed p-4 text-ink-2${tall ? " max-h-[600px] overflow-y-auto" : ""}`}
          style={{ background: "var(--surface-1)", margin: 0 }}
        >
          <code>{code}</code>
        </pre>
      </Panel>
    </div>
  );
}

function WorkerDetail({ name, onBack }: { name: string; onBack: () => void }) {
  const { data: detail, error } = useApi<CloudWorkerDetail>(`/api/wiki/workers/${encodeURIComponent(name)}`);

  const back = (
    <button type="button" onClick={onBack} className="text-ink-2 hover:text-ink-1 transition-colors" aria-label="Back to all cloud workers">
      <ArrowLeft className="w-5 h-5" />
    </button>
  );

  if (error) {
    return (
      <div className="flex items-center gap-3 text-sm text-ink-2">
        {back}
        <span>Could not load worker <code>{name}</code>: {failureText(error)}</span>
      </div>
    );
  }
  if (!detail) return <div className="text-ink-3 text-sm">Loading {name}…</div>;

  const cfg = TYPE_CONFIG[detail.type];
  const Icon = cfg.icon;
  return (
    <div className="flex flex-col gap-4 max-w-4xl">
      <div className="flex items-center gap-3">
        {back}
        <div>
          <div className="flex items-center gap-2">
            <Icon className="w-5 h-5" style={{ color: cfg.color }} />
            <Pill dim={cfg.dim as Dim}>{cfg.label}</Pill>
          </div>
          <h3 className="text-xl font-semibold tracking-tight mt-1 text-ink-1">{detail.name}</h3>
          <p className="mt-0.5 text-ink-3 text-[13px]">
            {fmtDateParts(detail.lastModified, { month: "short", day: "numeric", year: "numeric" })}
          </p>
        </div>
      </div>
      {detail.wrangler && <CodeBlock title="wrangler.jsonc" code={detail.wrangler} />}
      {detail.source && <CodeBlock title="src/index.ts" code={detail.source} tall />}
      {!detail.wrangler && !detail.source && <p className="text-ink-2 text-sm">No readable files found in this worker.</p>}
    </div>
  );
}

/** The worker source browser. `worker` is the open worker's name (from ?name=), or null for the list. */
export function CloudWorkers({ worker, onPick }: { worker: string | null; onPick: (name: string | null) => void }) {
  const { data: list, error } = useApi<WorkerList>("/api/wiki/workers", { staleTime: 30_000 });

  return (
    <section aria-labelledby="wf-cloud-workers" className="wf-section">
      <PanelHeader
        icon={Cloud}
        title={<span id="wf-cloud-workers">Cloudflare Workers</span>}
        meta={list ? `${list.total} workers · actions, pipelines and flows` : undefined}
      />
      {worker ? (
        <WorkerDetail name={worker} onBack={() => onPick(null)} />
      ) : error ? (
        <div className="text-sm text-ink-2">Could not load the worker list: {failureText(error)}</div>
      ) : list ? (
        <WorkerList list={list} onPick={onPick} />
      ) : (
        <div className="text-ink-3 text-sm">Loading workers…</div>
      )}
    </section>
  );
}
