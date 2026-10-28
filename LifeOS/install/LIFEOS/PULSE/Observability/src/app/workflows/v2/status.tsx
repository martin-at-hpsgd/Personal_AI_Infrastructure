"use client";

/** Run-status vocabulary for the Activity tab, the drawer and the Active runs list. */

import type { ActivityStatus } from "./api";

export const STATUS_META: Record<ActivityStatus, { label: string; color: string }> = {
  ok: { label: "ok", color: "var(--ok)" },
  error: { label: "failed", color: "var(--err)" },
  running: { label: "running", color: "var(--accent-soft)" },
  incomplete: { label: "no end logged", color: "var(--warn)" },
  skipped: { label: "skipped", color: "var(--ink-3)" },
  unknown: { label: "status unknown", color: "var(--ink-3)" },
};

export function StatusMark({ status }: { status: ActivityStatus }) {
  const m = STATUS_META[status];
  return (
    <span className="wf2-status" data-status={status}>
      <span className="wf2-status-dot" style={{ background: status === "unknown" || status === "skipped" ? "transparent" : m.color, borderColor: m.color }} aria-hidden />
      <span style={{ color: status === "ok" ? "var(--ink-2)" : m.color }}>{m.label}</span>
    </span>
  );
}

/** "21s", "1m 31s", "2h 04m"; "—" when the source did not record both ends. */
export function formatDuration(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}
