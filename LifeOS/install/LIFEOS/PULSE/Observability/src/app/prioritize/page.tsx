"use client";

import { useState } from "react";
import { useApi, apiSend } from "@/lib/api";
import { fmtDateTime } from "@/lib/time";
import { RefreshCw, ListOrdered, ExternalLink } from "lucide-react";
import {
  PageShell,
  PageHeader,
  Panel,
  PanelHeader,
  Pill,
  EmptyState,
  dimStyle,
  type Dim,
} from "@/components/ui/chrome";

interface Evidence {
  ref: string;
  source: string;
  label: string;
  url?: string;
}

interface Recommendation {
  id: string;
  category: string;
  title: string;
  why: string;
  next_action: string;
  priority: "now" | "soon" | "later";
  confidence: 1 | 2 | 3 | 4 | 5;
  evidence?: Evidence[];
  first_seen: string;
  seen_count: number;
}

interface LatestJson {
  version: number;
  generated_at: string;
  model: string;
  vendor: string;
  lane: string;
  input_fingerprint: string;
  inputs: Record<string, number>;
  errors: Record<string, string>;
  summary: string;
  focus: string[];
  dropped: number;
  recommendations: Recommendation[];
}

interface StatusJson {
  last_check_at: string;
  last_generated_at: string | null;
  last_skip_reason: string | null;
  last_error: string | null;
  runs: number;
  skips: number;
}

interface PrioritizeResponse {
  latest: LatestJson | null;
  status: StatusJson | null;
  dismissed_count: number;
}

const priorityColors: Record<"now" | "soon" | "later", Dim> = {
  now: "err",
  soon: "warn",
  later: "ok",
};

function formatRelativeTime(iso: string): string {
  const now = new Date();
  const then = new Date(iso);
  const diffMs = now.getTime() - then.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMins < 1) return "now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${diffDays}d ago`;
}

function formatAbsoluteTime(iso: string): string {
  return fmtDateTime(iso);
}

export default function PrioritizePage() {
  const [refreshing, setRefreshing] = useState(false);
  // After a manual refresh, poll every 10s for up to 3 minutes.
  const [pollUntil, setPollUntil] = useState(0);
  const { data: apiData, error: apiError, refetch } = useApi<PrioritizeResponse>("/api/prioritize", {
    refetchInterval: () => (Date.now() < pollUntil ? 10000 : false),
  });
  const data = apiData ?? null;
  const error = apiError ? String(apiError) : null;

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await apiSend("/api/prioritize/run", "POST");
      setPollUntil(Date.now() + 180000);
    } catch {
      // the run did not start (e.g. 503 when the Prioritize skill is not installed), so there is nothing to poll for
    } finally {
      setRefreshing(false);
    }
  };

  const handleDismiss = async (id: string) => {
    await apiSend("/api/prioritize/dismiss", "POST", { id });
    // Refetch to update the UI
    await refetch();
  };

  if (error) {
    return (
      <PageShell>
        <div className="text-warn text-sm">
          Couldn&apos;t reach Prioritize API: {error}
        </div>
      </PageShell>
    );
  }

  if (!data) {
    return (
      <PageShell>
        <div className="text-ink-3 text-sm">Loading…</div>
      </PageShell>
    );
  }

  const { latest, status } = data;

  const subtitle =
    latest && status
      ? `${formatRelativeTime(latest.generated_at)} · ${formatAbsoluteTime(latest.generated_at)} · ${latest.model} · ${Object.values(latest.inputs).reduce((a, b) => a + b, 0)} inputs`
      : "No data yet";

  const groupedByCategory: Record<string, Recommendation[]> =
    latest?.recommendations.reduce(
      (acc, rec) => {
        if (!acc[rec.category]) acc[rec.category] = [];
        acc[rec.category].push(rec);
        return acc;
      },
      {} as Record<string, Recommendation[]>
    ) || {};

  // Order categories: work, lifeos, research, project, telos, content, then unknown
  const categoryOrder = [
    "work",
    "lifeos",
    "research",
    "project",
    "telos",
    "content",
  ];
  const orderedCategories = [
    ...categoryOrder.filter((c) => c in groupedByCategory),
    ...Object.keys(groupedByCategory).filter(
      (c) => !categoryOrder.includes(c)
    ),
  ];

  return (
    <PageShell className="max-w-[1200px]">
      <div className="flex items-start justify-between">
        <PageHeader
          icon={ListOrdered}
          title="Prioritize"
          subtitle={subtitle}
        />
        <button
          onClick={handleRefresh}
          disabled={refreshing}
          className="mt-6 px-3 py-1.5 text-xs font-medium rounded-md transition-colors flex items-center gap-1.5"
          style={dimStyle("ok", true)}
        >
          <RefreshCw size={12} className={refreshing ? "animate-spin" : ""} />
          {refreshing ? "Refreshing…" : "Refresh now"}
        </button>
      </div>

      {/* Error lines */}
      {latest?.errors && Object.keys(latest.errors).length > 0 && (
        <div className="text-warn text-sm space-y-1">
          {Object.entries(latest.errors).map(([source, msg]) => (
            <div key={source}>
              {source}: {msg}
            </div>
          ))}
        </div>
      )}

      {status?.last_error && (
        <div className="text-warn text-sm">{status.last_error}</div>
      )}

      {/* Status line */}
      {(status?.last_skip_reason || (status?.last_generated_at === null && status?.last_check_at)) && (
        <div className="text-ink-2 text-xs">
          {status.last_skip_reason ? (
            <>Checked {formatAbsoluteTime(status.last_check_at)} · {status.last_skip_reason}</>
          ) : status.last_generated_at ? (
            <>Checked {formatAbsoluteTime(status.last_check_at)} · generated {formatAbsoluteTime(status.last_generated_at)}</>
          ) : null}
        </div>
      )}

      {/* Focus panel */}
      {latest?.summary && (
        <section>
          <Panel className="space-y-3">
            <div className="text-ink-1 text-sm leading-relaxed">
              {latest.summary}
            </div>

            {latest.focus.length > 0 && (
              <div className="space-y-3 mt-4 pt-4 border-t border-line-1">
                <div className="text-xs font-semibold text-ink-2 uppercase tracking-wide">
                  Focus ({latest.focus.length})
                </div>
                {latest.recommendations
                  .filter((r) => latest.focus.includes(r.id))
                  .slice(0, 3)
                  .map((rec) => (
                    <Panel
                      key={rec.id}
                      className="space-y-2"
                      style={{
                        borderLeftWidth: "3px",
                        borderLeftColor: `var(--${priorityColors[rec.priority]})`,
                      }}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex-1">
                          <div className="font-medium text-sm text-ink-1">
                            {rec.title}
                          </div>
                          <div className="text-xs text-ink-3 mt-1">
                            {rec.priority} · {rec.confidence}/5
                          </div>
                        </div>
                      </div>
                      <div className="text-xs text-ink-2 leading-relaxed">
                        {rec.why}
                      </div>
                      <div className="text-xs text-ink-3">
                        Next: {rec.next_action}
                      </div>
                    </Panel>
                  ))}
              </div>
            )}
          </Panel>
        </section>
      )}

      {!latest && (
        <EmptyState
          icon={ListOrdered}
          title="No recommendations yet"
          hint="The job runs every 2 hours."
        />
      )}

      {/* Category panels */}
      {latest &&
        orderedCategories.map((category) => {
          const categoryLabel: Record<string, string> = {
            work: "Work queue",
            lifeos: "LifeOS",
            research: "Research",
            project: "New projects",
            telos: "TELOS updates",
            content: "Content ideas",
          };

          return (
            <section key={category} className="flex flex-col gap-3">
              <PanelHeader
                title={categoryLabel[category] || category.replace(/[-_]/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase())}
                meta={
                  <Pill dim="ok">
                    {groupedByCategory[category].length}
                  </Pill>
                }
              />
              <div className="grid gap-3">
                {groupedByCategory[category].map((rec) => (
                  <Panel key={rec.id} className="space-y-2">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1">
                        <div className="font-medium text-sm text-ink-1">
                          {rec.title}
                        </div>
                        <div className="flex items-center gap-2 flex-wrap mt-1">
                          <Pill dim={priorityColors[rec.priority]}>
                            {rec.priority}
                          </Pill>
                          <span className="text-xs text-ink-3">
                            {rec.confidence}/5
                          </span>
                          <span className="text-xs text-ink-3 whitespace-nowrap">
                            first seen {formatRelativeTime(rec.first_seen)}
                          </span>
                        </div>
                      </div>
                    </div>

                    <div className="text-xs text-ink-2 leading-relaxed">
                      {rec.why}
                    </div>

                    <div className="text-xs text-ink-3 font-medium">
                      Next: {rec.next_action}
                    </div>

                    {rec.evidence && rec.evidence.length > 0 && (
                      <div className="flex flex-wrap gap-1.5 pt-2">
                        {rec.evidence.map((ev, i) => (
                          <a
                            key={i}
                            href={ev.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            title={ev.label}
                            className="inline-flex items-center gap-1 max-w-[26rem] px-2 py-0.5 text-[11px] rounded-md bg-surface-3 border border-line-1 text-ink-2 hover:text-ink-1 transition-colors"
                          >
                            <span className="mono text-ink-3 shrink-0">{ev.ref}</span>
                            <span className="truncate">{ev.label}</span>
                            {ev.url && <ExternalLink size={10} className="shrink-0" />}
                          </a>
                        ))}
                      </div>
                    )}

                    <div className="flex gap-2 pt-2">
                      <button
                        onClick={() => handleDismiss(rec.id)}
                        className="px-2 py-1 text-xs rounded-md transition-colors"
                        style={dimStyle("warn", true)}
                      >
                        Dismiss
                      </button>
                    </div>
                  </Panel>
                ))}
              </div>
            </section>
          );
        })}
    </PageShell>
  );
}
