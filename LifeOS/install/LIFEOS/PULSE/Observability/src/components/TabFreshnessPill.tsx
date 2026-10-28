"use client";

// Universal per-tab freshness pill. Shown in the AppHeader top-right on every
// Pulse tab. Calls /api/tab-freshness?tab=<id> and renders the existing
// FreshnessIndicator. Tab id is inferred from the active pathname; the pill
// is hidden on the home / route (no specific tab active).

import { usePathname } from "next/navigation";
import { useApi } from "@/lib/api";
import { FreshnessIndicator, type FreshnessData } from "./FreshnessIndicator";

const TAB_FROM_PATH: Array<{ prefix: string; tabId: string }> = [
  { prefix: "/telos", tabId: "telos" },
  { prefix: "/work", tabId: "work" },
  { prefix: "/health", tabId: "health" },
  { prefix: "/finances", tabId: "finances" },
  { prefix: "/business", tabId: "business" },
  { prefix: "/local", tabId: "local" },
  { prefix: "/assistant", tabId: "assistant" },
  { prefix: "/agents", tabId: "agents" },
  { prefix: "/memory/knowledge", tabId: "knowledge" },
  { prefix: "/docs", tabId: "docs" },
  { prefix: "/skills", tabId: "skills" },
  { prefix: "/hooks", tabId: "hooks" },
  { prefix: "/workflows", tabId: "workflows" },
  { prefix: "/security", tabId: "security" },
  { prefix: "/performance", tabId: "performance" },
];

function activeTabId(pathname: string | null): string | null {
  if (!pathname) return null;
  for (const m of TAB_FROM_PATH) {
    if (pathname === m.prefix || pathname.startsWith(`${m.prefix}/`)) return m.tabId;
  }
  return null;
}

export function TabFreshnessPill({ className = "" }: { className?: string }) {
  const pathname = usePathname();
  const tabId = activeTabId(pathname);
  const { data: fetched, isError } = useApi<
    FreshnessData & { tabId?: string; perFile?: FreshnessData["perFile"] },
    FreshnessData
  >(tabId ? `/api/tab-freshness?tab=${encodeURIComponent(tabId)}` : null, {
    select: (payload) => ({
      dataDate: payload.dataDate ?? null,
      label: payload.label ?? "",
      daysOld: payload.daysOld ?? null,
      tier: payload.tier ?? "unknown",
      perFile: Array.isArray(payload.perFile) ? payload.perFile : [],
    }),
  });

  if (!tabId) return null;
  const data: FreshnessData | null = isError
    ? { dataDate: null, label: "freshness check failed", daysOld: null, tier: "unknown", perFile: [] }
    : fetched ?? null;
  return <FreshnessIndicator freshness={data} className={className} compact />;
}
