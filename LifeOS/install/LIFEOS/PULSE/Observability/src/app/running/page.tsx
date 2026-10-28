"use client";

/**
 * /running — everything that has been running on this machine for 30 minutes or more, who owns it, and what
 * looks wrong (running-work watch ISA, M3 ISC-19). Reads /api/vigil/running (LIFEOS/TOOLS/RunningScan.ts,
 * cached 30 s). Findings come first; the rest is the long-running work grouped by owner. Read-only: the page
 * shows how to look at a process, and never stops one.
 */

import { useApi } from "@/lib/api";
import { fmtClock } from "@/lib/time";
import { Activity, AlertTriangle, Cpu, Server, TerminalSquare, Users } from "lucide-react";
import { PageShell, PageHeader, Panel, PanelHeader, StatTile, Pill, type Dim } from "@/components/ui/chrome";

type Owner = { kind: "service"; label: string; intervalS: number | null; main: boolean } | { kind: "session"; session: string | null } | { kind: "dead-session"; session: string } | { kind: "terminal"; tty: string } | { kind: "none" };
interface Tree { pid: number; pids: number[]; command: string; ageS: number; cpuS: number; owner: Owner; idle: boolean }
interface Finding { kind: string; title: string; detail: string; ageS: number | null; pid: number | null; owner: string; look: string }
interface Scan { available: boolean; reason?: string; generated_at: string; procs: number; trees: Tree[]; findings: Finding[]; verdicts_at: string | null; scan_ms: number }

const age = (s: number) => s >= 86400 ? `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h` : s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m` : `${Math.floor(s / 60)}m`;
const hhmm = (iso: string | null) => fmtClock(iso, "never");
const KIND_LABEL: Record<string, string> = { overrun: "Overran", idle: "Idle", unowned: "Unowned", "dead-session": "Dead session", straggler: "Straggler", "blind-reader": "Vigil blind", "workflow-overdue": "Workflow overdue" };
const GROUPS: { key: Owner["kind"]; title: string; icon: typeof Server }[] = [
  { key: "service", title: "Services", icon: Server },
  { key: "session", title: "Live sessions", icon: Users },
  { key: "terminal", title: "Terminals", icon: TerminalSquare },
  { key: "dead-session", title: "Dead sessions", icon: AlertTriangle },
  { key: "none", title: "No owner", icon: AlertTriangle },
];
const ownerName = (o: Owner) => o.kind === "service" ? o.label : o.kind === "session" ? (o.session ? `session ${o.session.slice(0, 8)}` : "session helper") : o.kind === "dead-session" ? `session ${o.session.slice(0, 8)}` : o.kind === "terminal" ? o.tty : "—";

export default function RunningPage() {
  const { data, isError } = useApi<Scan>("/api/vigil/running", { refetchInterval: 30_000, staleTime: 10_000 });

  return (
    <PageShell>
      <PageHeader icon={Activity} title="Running" subtitle="Everything running 30 minutes or more, who owns it, and what looks wrong" />
      {isError || !data || data.available === false ? (
        <Panel><p className="text-[13px] text-ink-3">{isError ? "Running scan unavailable." : data?.reason ?? "Scanning…"}</p></Panel>
      ) : (
        <div data-testid="running-page" className="flex flex-col gap-4">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <StatTile icon={AlertTriangle} label="Findings" value={data.findings.length} dim={data.findings.length ? "warn" : "ok"} sub={data.findings.length ? "need a look" : "nothing found"} />
            <StatTile icon={Activity} label="Long-running" value={data.trees.length} sub="trees 30 min or older" />
            <StatTile icon={Cpu} label="Processes" value={data.procs.toLocaleString("en-US")} sub="on this machine" />
            <StatTile icon={Server} label="Scanned" value={hhmm(data.generated_at)} sub={`Vigil verdicts ${hhmm(data.verdicts_at)}`} />
          </div>

          <Panel className="p-4">
            <PanelHeader title={`Findings (${data.findings.length})`} icon={AlertTriangle} />
            {data.findings.length === 0 ? (
              <p className="text-[13px] text-ink-3">Nothing found: no stuck jobs, idle or unowned work, dead-session leftovers, blind Vigil readers, or overdue workflow runs.</p>
            ) : (
              <ul className="flex flex-col gap-3">
                {data.findings.map((f, i) => (
                  <li key={`${f.kind}-${f.pid ?? f.title}-${i}`} className="flex flex-col gap-1 border-b border-line-2 pb-3 last:border-0 last:pb-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <Pill dim={"warn" as Dim}>{KIND_LABEL[f.kind] ?? f.kind}</Pill>
                      <span className="text-[14px] text-ink-1">{f.title}</span>
                    </div>
                    <p className="text-[13px] text-ink-2">{f.detail}</p>
                    <p className="text-[12px] text-ink-3">Owner: {f.owner}{f.pid ? ` · pid ${f.pid}` : ""} · Look: <code className="text-[12px]">{f.look}</code></p>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          {GROUPS.map((g) => {
            const rows = data.trees.filter((t) => t.owner.kind === g.key);
            if (rows.length === 0) return null;
            return (
              <Panel key={g.key} className="p-4">
                <PanelHeader title={`${g.title} (${rows.length})`} icon={g.icon} />
                <table className="w-full text-[12px]">
                  <thead><tr className="text-left text-ink-3"><th className="py-1 pr-3 font-normal">Command</th><th className="py-1 pr-3 font-normal">Owner</th><th className="py-1 pr-3 font-normal">Age</th><th className="py-1 pr-3 font-normal">CPU</th><th className="py-1 font-normal">Processes</th></tr></thead>
                  <tbody>
                    {rows.map((t) => (
                      <tr key={t.pid} className="border-t border-line-2 text-ink-2">
                        <td className="py-1 pr-3 text-ink-1">{t.command}{t.idle ? <span className="ml-2 text-ink-3">(idle)</span> : null}</td>
                        <td className="py-1 pr-3">{ownerName(t.owner)}</td>
                        <td className="py-1 pr-3">{age(t.ageS)}</td>
                        <td className="py-1 pr-3">{t.cpuS < 60 ? `${t.cpuS}s` : `${Math.round(t.cpuS / 60)}m`}</td>
                        <td className="py-1">{t.pids.length} · pid {t.pid}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Panel>
            );
          })}
        </div>
      )}
    </PageShell>
  );
}
