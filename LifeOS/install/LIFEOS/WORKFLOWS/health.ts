/**
 * ISC-100: the one health derivation for a typed workflow. Pure and dependency-free, so the Pulse
 * page can import it in the browser; Inventory.ts re-exports it as the canonical function.
 * A workflow is in exactly one state; "needs attention" beats every other.
 */

export type DefHealth = "attention" | "running" | "disabled" | "failing" | "healthy" | "quiet";

export const DEF_HEALTH_META: Record<DefHealth, { label: string; color: string; order: number }> = {
  attention: { label: "Needs attention", color: "var(--err)", order: 0 },
  failing: { label: "Failing", color: "var(--err)", order: 1 },
  running: { label: "Running", color: "var(--accent, #3b82f6)", order: 2 },
  quiet: { label: "No recent runs", color: "var(--ink-3)", order: 3 },
  healthy: { label: "Healthy", color: "var(--ok)", order: 4 },
  disabled: { label: "Disabled", color: "var(--ink-3)", order: 5 },
};

export interface HealthInput {
  valid: boolean;
  /** False for a paused or disabled workflow. */
  enabled: boolean;
  running: boolean;
  lastStatus: "ok" | "error" | "unknown" | null;
  lastRunAt: string | null;
  /** Unacknowledged findings of high or medium severity on this workflow. */
  openFindings: number;
}

export const RECENT_MS = 7 * 24 * 3_600_000;

/** Exactly one state. Needs attention (invalid definition or an open finding) beats every other state. */
export function deriveHealth(h: HealthInput, now: number): DefHealth {
  if (!h.valid || h.openFindings > 0) return "attention";
  if (h.running) return "running";
  if (!h.enabled) return "disabled";
  if (h.lastStatus === "error") return "failing";
  const at = h.lastRunAt ? Date.parse(h.lastRunAt) : Number.NaN;
  if (h.lastStatus === "ok" && Number.isFinite(at) && now - at <= RECENT_MS) return "healthy";
  return "quiet";
}
