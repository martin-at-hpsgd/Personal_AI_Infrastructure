"use client";

/**
 * Ledger — the change-tracking read surface.
 * What changed, when, at what version, verified how — system edits and estate deploys.
 * Data: GET /api/ledger (modules/ledger.ts). This page holds zero data logic.
 */

import { useState } from "react";
import { useApi } from "@/lib/api";
import {
  GitCommitVertical,
  Package,
  Rocket,
  ScrollText,
  ShieldCheck,
  Workflow,
} from "lucide-react";
import {
  EmptyState,
  PageHeader,
  PageShell,
  Panel,
  PanelHeader,
  Pill,
  StatTile,
  type Dim,
} from "@/components/ui/chrome";

interface LedgerPayload {
  generated_at: string;
  versions: { lifeos: string | null; algorithm: string | null; system_prompt: string | null };
  registry: {
    last_updated: string | null;
    total_updates: number | null;
    recent: {
      timestamp: string;
      title: string;
      significance: string | null;
      change_type: string | null;
      version: string | null;
      files: number;
    }[];
  } | null;
  deploys: {
    ts: string;
    project: string;
    target: string;
    domain: string | null;
    sha: string | null;
    version: string | null;
    ok: boolean;
  }[];
  integrity: {
    last_run: { ts: string; exitCode: number; blocking: number; info?: number } | null;
    clean: boolean | null;
  };
  drift: { ts: string; count: number; tag: string } | null;
  errors: string[];
}

const SIG_DIM: Record<string, Dim> = {
  critical: "err",
  major: "warn",
  moderate: "blue",
  minor: "neutral",
  trivial: "neutral",
};

function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 48) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export default function LedgerPage() {
  const { data: ledgerData, error: ledgerError } = useApi<LedgerPayload>("/api/ledger", { refetchInterval: 60_000 });
  const data = ledgerData ?? null;
  const error = ledgerError ? String(ledgerError) : null;
  const [sigFilter, setSigFilter] = useState<string | null>(null);      // System updates by significance
  const [deployFilter, setDeployFilter] = useState<"ok" | "fail" | null>(null); // Estate deploys by outcome

  if (error) {
    return (
      <PageShell>
        <PageHeader title="Ledger" icon={ScrollText} subtitle="Change tracking" />
        <EmptyState icon={ScrollText} title="Ledger API unreachable" hint={error} />
      </PageShell>
    );
  }

  const integrityClean = data?.integrity?.clean;
  // public issue #1843, @jacobo-ortiz — absent drift data must read "—", not a green zero
  const driftCount = data?.drift?.count ?? null;

  return (
    <PageShell>
      <PageHeader
        title="Ledger"
        icon={ScrollText}
        subtitle="What changed, when, at what version — system edits and estate deploys"
      />

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
        <StatTile label="LifeOS" value={data?.versions?.lifeos ?? "—"} icon={Package} />
        <StatTile label="Algorithm" value={data?.versions?.algorithm ?? "—"} icon={Workflow} />
        <StatTile label="Prompt" value={data?.versions?.system_prompt ?? "—"} icon={ScrollText} />
        <StatTile
          label="Updates"
          value={data?.registry?.total_updates ?? "—"}
          icon={GitCommitVertical}
          sub={data?.registry?.last_updated ? `last ${timeAgo(data.registry.last_updated)}` : undefined}
        />
        <StatTile
          label="Integrity"
          value={integrityClean == null ? "—" : integrityClean ? "clean" : "blocked"}
          dim={integrityClean == null ? "neutral" : integrityClean ? "ok" : "err"}
          icon={ShieldCheck}
          sub={data?.integrity?.last_run ? timeAgo(data.integrity.last_run.ts) : "no run recorded"}
        />
        <StatTile
          label="Drift"
          value={driftCount == null ? "—" : driftCount}
          unit={driftCount == null ? undefined : "files"}
          dim={driftCount == null ? "neutral" : driftCount >= 10 ? "warn" : "ok"}
          icon={Rocket}
          sub={data?.drift?.tag ? `since ${data.drift.tag}` : undefined}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Panel>
          <PanelHeader
            title="System updates"
            icon={GitCommitVertical}
            meta={data?.registry ? `latest ${data.registry.recent.length}` : undefined}
          />
          {data?.registry?.recent?.length ? (() => {
            const recent = data.registry.recent;
            const counts: Record<string, number> = {};
            for (const u of recent) counts[u.significance ?? "?"] = (counts[u.significance ?? "?"] ?? 0) + 1;
            const order = ["critical", "major", "moderate", "minor", "trivial"];
            const sigs = Object.keys(counts).sort((a, b) => order.indexOf(a) - order.indexOf(b));
            const shown = sigFilter ? recent.filter((u) => (u.significance ?? "?") === sigFilter) : recent;
            return (
            <>
            {sigs.length > 1 && (
              <div className="grid grid-cols-3 sm:grid-cols-5 gap-2 mb-3">
                {sigs.map((s) => (
                  <StatTile key={s} label={s} value={counts[s]} dim={SIG_DIM[s] ?? "neutral"}
                    active={sigFilter === s}
                    onClick={() => setSigFilter(sigFilter === s ? null : s)} />
                ))}
              </div>
            )}
            <ul className="flex flex-col divide-y divide-line-2">
              {shown.map((u, i) => (
                <li key={i} className="py-2.5 flex items-center gap-3">
                  <Pill dim={SIG_DIM[u.significance ?? ""] ?? "neutral"}>{u.significance ?? "?"}</Pill>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm text-ink-1 truncate">{u.title}</div>
                    <div className="text-[12px] text-ink-3 mono">
                      {timeAgo(u.timestamp)}
                      {u.version ? ` · v${u.version}` : ""}
                      {u.change_type ? ` · ${u.change_type}` : ""}
                      {u.files ? ` · ${u.files} files` : ""}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
            </>
            );
          })() : (
            <EmptyState icon={GitCommitVertical} title="No registry entries readable" />
          )}
        </Panel>

        <Panel>
          <PanelHeader
            title="Estate deploys"
            icon={Rocket}
            meta={data ? `latest ${data.deploys.length}` : undefined}
          />
          {data?.deploys?.length ? (() => {
            const okN = data.deploys.filter((d) => d.ok).length;
            const failN = data.deploys.length - okN;
            const shown = deployFilter ? data.deploys.filter((d) => (deployFilter === "ok" ? d.ok : !d.ok)) : data.deploys;
            return (
            <>
            <div className="grid grid-cols-2 gap-2 mb-3">
              <StatTile label="ok" value={okN} dim="ok" active={deployFilter === "ok"} onClick={() => setDeployFilter(deployFilter === "ok" ? null : "ok")} />
              <StatTile label="fail" value={failN} dim={failN ? "err" : "neutral"} active={deployFilter === "fail"} onClick={() => setDeployFilter(deployFilter === "fail" ? null : "fail")} />
            </div>
            <ul className="flex flex-col divide-y divide-line-2">
              {shown.map((d, i) => (
                <li key={i} className="py-2.5 flex items-center gap-3">
                  <Pill dim={d.ok ? "ok" : "err"}>{d.ok ? "ok" : "fail"}</Pill>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm text-ink-1 truncate">
                      {d.project}
                      {d.domain ? <span className="text-ink-3"> · {d.domain}</span> : null}
                    </div>
                    <div className="text-[12px] text-ink-3 mono">
                      {timeAgo(d.ts)} · {d.target}
                      {d.version ? ` · v${d.version}` : d.sha ? ` · ${d.sha}` : ""}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
            </>
            );
          })() : (
            <EmptyState
              icon={Rocket}
              title="No deploy events yet"
              hint="Every gated deploy records here via LedgerDeployEvent — events accumulate as projects ship."
            />
          )}
        </Panel>
      </div>
    </PageShell>
  );
}
