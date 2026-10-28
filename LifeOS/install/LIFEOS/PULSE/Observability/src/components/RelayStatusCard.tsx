"use client";

/**
 * Relay status card — the texting bridge on one face: bridge up or down, last inbound text, last
 * reply, guard denies over 24h, lock state, bridge count and the last self-check (Relay F26). Reads /api/relay/status (modules/relay.ts), which
 * carries no sender number and no hash. A down bridge, other than one bridge, a failed or stale self-check, or a
 * loose state-file mode reads red;
 * unanswered texts or a missing config read amber; everything else green.
 */

import { useApi } from "@/lib/api";
import { MessageSquare, ShieldCheck, Lock, LockOpen, Inbox, Reply } from "lucide-react";
import { Panel, PanelHeader, StatTile, Pill, type Dim } from "@/components/ui/chrome";

export interface RelayStatus {
  available: boolean;
  reason?: string;
  checked_at?: string;
  service: "up" | "down";
  pid?: number;
  startedAgo: string;
  lastInbound: string;
  lastReply: string;
  unansweredInbound: number;
  senders: number;
  lockState: string[];
  configOk: boolean;
  countersignSalted: boolean;
  tapEnabled: boolean;
  deniesLast24h: number;
  deniesByKind: Record<string, number>;
  looseModes: string[];
  /** Relay F26: bridge processes running, and the bridge's own last self-check. */
  bridges?: number;
  selfCheck?: "ok" | "failed" | "pending" | "stale";
  selfCheckAgo?: string;
  selfCheckProblems?: string[];
}

/** The card's grade: red when the bridge is down or a state file is world-readable, amber when attention is due. */
export function relayGrade(s: Pick<RelayStatus, "service" | "looseModes" | "unansweredInbound" | "configOk" | "bridges" | "selfCheck">): { dim: Dim; label: string } {
  if (s.service === "down" || s.looseModes.length > 0) return { dim: "err", label: s.service === "down" ? "Bridge down" : "Loose file modes" };
  if (s.bridges !== undefined && s.bridges !== 1) return { dim: "err", label: `${s.bridges} bridges running` };
  if (s.selfCheck === "failed" || s.selfCheck === "stale") return { dim: "err", label: s.selfCheck === "failed" ? "Self-check failed" : "Self-check stale" };
  if (!s.configOk) return { dim: "warn", label: "Config missing" };
  if (s.unansweredInbound > 0) return { dim: "warn", label: `${s.unansweredInbound} unanswered` };
  return { dim: "ok", label: "Healthy" };
}

export default function RelayStatusCard() {
  const { data, isError } = useApi<RelayStatus>("/api/relay/status", { refetchInterval: 15_000, staleTime: 5_000 });

  if (isError || !data || data.available === false) {
    return (
      <Panel>
        <PanelHeader title="Relay" icon={MessageSquare} />
        <p className="text-[13px] text-ink-3">{isError ? "Relay status unavailable." : data?.reason ?? "Loading Relay status."}</p>
      </Panel>
    );
  }

  const grade = relayGrade(data);
  const unlocked = data.lockState.some((l) => l.startsWith("unlocked"));
  const kinds = Object.entries(data.deniesByKind).map(([k, n]) => `${k} ${n}`).join(", ");

  return (
    <div data-testid="relay-card" className="flex flex-col gap-3">
      <Panel className="p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <MessageSquare className="w-5 h-5 text-ink-3" />
            <span className="text-[15px] text-ink-1">Relay</span>
            <Pill dim={grade.dim}>{grade.label}</Pill>
          </div>
          <div className="text-[12px] text-ink-3">
            {data.service === "up" ? `Bridge up${data.pid ? `, pid ${data.pid}` : ""}, started ${data.startedAgo}` : "Bridge down"}
            {data.checked_at ? ` · checked ${new Date(data.checked_at).toISOString().slice(11, 16)} UTC` : ""}
          </div>
        </div>
      </Panel>
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <StatTile icon={MessageSquare} label="Bridge" value={data.service === "up" ? "Up" : "Down"} dim={data.service === "up" ? "ok" : "err"} sub={`started ${data.startedAgo}${data.bridges !== undefined ? ` · ${data.bridges} bridge${data.bridges === 1 ? "" : "s"}` : ""}${data.selfCheck ? ` · Self-check ${data.selfCheck}${data.selfCheck === "ok" || data.selfCheck === "failed" ? ` ${data.selfCheckAgo}` : ""}` : ""}`} />
        <StatTile icon={Inbox} label="Inbound" value={data.lastInbound} sub={data.unansweredInbound ? `${data.unansweredInbound} unanswered` : "all answered"} dim={data.unansweredInbound ? "warn" : undefined} />
        <StatTile icon={Reply} label="Reply" value={data.lastReply} />
        <StatTile icon={ShieldCheck} label="Denies" value={data.deniesLast24h} sub={`24h: ${kinds || "none"}`} dim={data.deniesLast24h ? "warn" : "ok"} />
        <StatTile
          icon={unlocked ? LockOpen : Lock}
          label="Lock"
          value={data.lockState.length ? data.lockState.join(", ") : "none"}
          sub={`${data.senders} sender${data.senders === 1 ? "" : "s"}${data.tapEnabled ? ", tap on" : ""}`}
          dim={unlocked ? "warn" : "ok"}
        />
      </div>
    </div>
  );
}
