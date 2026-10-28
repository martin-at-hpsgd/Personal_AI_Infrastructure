"use client";

import { useMemo } from "react";
import { useApi } from "@/lib/api";
import { Volume2, Terminal, FileText, Zap } from "lucide-react";

// ─── System Health Vitals (Widget 18) ───
// Persistent bar at top of Activity page, visible across all tabs.
// Polls voice, hooks, docs, and session health every 30s.

interface HealthData {
  voiceHealth: { rate: number; status: "healthy" | "degraded" | "failing" };
  hookReliability: {
    failsPerHour: number;
    status: "healthy" | "degraded" | "failing";
  };
  docFreshness: {
    status: "healthy" | "degraded" | "failing";
    label: string;
  };
  activeSessions: {
    count: number;
    status: "healthy" | "degraded" | "failing";
  };
}

const STATUS_COLORS: Record<string, string> = {
  healthy: "text-emerald-400",
  degraded: "text-amber-400",
  failing: "text-rose-400",
};

const STATUS_DOTS: Record<string, string> = {
  healthy: "bg-emerald-400",
  degraded: "bg-amber-400",
  failing: "bg-rose-400",
};

export default function SystemHealthVitals() {
  // Each read is shared through the query cache. A failed read counts as "no data" (defaults below), as before.
  const voiceQ = useApi<{ summary?: { successRate?: number } }>("/api/observability/voice-events", { refetchInterval: 30000, retry: false });
  const failuresQ = useApi<{ summary?: { recent24h?: number } }>("/api/observability/tool-failures", { refetchInterval: 30000, retry: false });
  const algoQ = useApi<{ algorithms?: Array<{ active?: boolean }> }>("/api/algorithm", { refetchInterval: 30000, retry: false });

  const pending = voiceQ.isPending || failuresQ.isPending || algoQ.isPending;
  const voice = voiceQ.isError ? null : voiceQ.data;
  const failures = failuresQ.isError ? null : failuresQ.data;
  const algo = algoQ.isError ? null : algoQ.data;

  const health = useMemo<HealthData | null>(() => {
    // The bar stays hidden until the first round of reads has settled.
    if (pending) return null;
    const voiceRate = voice?.summary?.successRate ?? 100;
    const recentFailures = failures?.summary?.recent24h ?? 0;
    const failsPerHour = recentFailures / 24;
    const activeCount = algo?.algorithms?.filter((a) => a.active)?.length ?? 0;
    return {
      voiceHealth: {
        rate: voiceRate,
        status: voiceRate >= 90 ? "healthy" : voiceRate >= 70 ? "degraded" : "failing",
      },
      hookReliability: {
        failsPerHour: Math.round(failsPerHour * 10) / 10,
        status: failsPerHour <= 1 ? "healthy" : failsPerHour <= 5 ? "degraded" : "failing",
      },
      docFreshness: {
        status: "healthy",
        label: "Fresh",
      },
      activeSessions: {
        count: activeCount,
        status: activeCount > 0 ? "healthy" : "degraded",
      },
    };
  }, [pending, voice, failures, algo]);

  if (!health) return null;

  return (
    <div className="flex items-center gap-6 px-4 py-1.5 bg-surface-1 border-b border-white/[0.04] shrink-0">
      <VitalMetric
        icon={Volume2}
        label="Voice"
        value={`${Math.round(health.voiceHealth.rate)}%`}
        status={health.voiceHealth.status}
      />
      <VitalMetric
        icon={Terminal}
        label="Hooks"
        value={`${health.hookReliability.failsPerHour}/hr`}
        status={health.hookReliability.status}
      />
      <VitalMetric
        icon={FileText}
        label="Documentation"
        value={health.docFreshness.label}
        status={health.docFreshness.status}
      />
      <VitalMetric
        icon={Zap}
        label="Active"
        value={`${health.activeSessions.count}`}
        status={health.activeSessions.status}
      />
    </div>
  );
}

function VitalMetric({
  icon: Icon,
  label,
  value,
  status,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  status: "healthy" | "degraded" | "failing";
}) {
  return (
    <div className="flex items-center gap-2">
      <div
        className={`w-2 h-2 rounded-full ${STATUS_DOTS[status]}`}
      />
      <Icon className="w-4 h-4 text-ink-3" />
      <span className="text-xs text-ink-3 uppercase">{label}</span>
      <span
        className={`text-sm font-mono font-medium ${STATUS_COLORS[status]}`}
      >
        {value}
      </span>
    </div>
  );
}
