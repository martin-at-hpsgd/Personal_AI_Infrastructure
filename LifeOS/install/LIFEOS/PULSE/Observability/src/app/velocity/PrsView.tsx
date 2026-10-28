"use client";

import { keepPreviousData } from "@tanstack/react-query";
import { useApi } from "@/lib/api";
import { Gauge, GitPullRequest } from "lucide-react";
import { PageShell, PageHeader, Panel, PanelHeader, StatTile, EmptyState } from "@/components/ui/chrome";
import { StackedBars, BarList, n0, type Row } from "./VelocityCharts";
import { fmt, fmtRange, RangeBar, useRange, ViewSwitch } from "./shared";

/**
 * Velocity, PRs view: merged pull requests over the same repos and weeks as Deeds, so the gap
 * between process and progress is plain. Holds ZERO data: GET /api/velocity/prs?range=.
 */

interface Prs {
  available: boolean; generated?: string; range?: { from: string; to: string; days: number };
  total: number; weeks: { week: string; merged: number }[]; repos: { repo: string; merged: number }[];
}

export default function PrsView() {
  const [range, setRange, ready] = useRange();
  const { data, isError: failed } = useApi<Prs>(ready ? `/api/velocity/prs?range=${encodeURIComponent(range)}` : null, { placeholderData: keepPreviousData });

  const header = (
    <PageHeader icon={Gauge} title="Velocity"
      subtitle="Pull requests merged across the same repos and weeks as Deeds. Process on its own, so the gap to progress shows." />
  );
  const shell = (body: React.ReactNode) => (
    <PageShell><div data-view="prs" data-range={range}>{header}<ViewSwitch view="prs" range={range} />{body}</div></PageShell>
  );

  if (failed) return shell(<div className="mt-8"><EmptyState icon={Gauge} title="Pulse unreachable" hint="The pull request numbers could not be loaded." /></div>);
  if (!data) return shell(<div className="mt-8 text-ink-3 text-sm">Loading…</div>);
  if (!data.available) return shell(<div className="mt-8"><EmptyState icon={Gauge} title="No pull request data yet" hint="The nightly collector writes it; nothing has been collected so far." /></div>);

  const rows: Row[] = data.weeks.map((w, i) => ({ key: w.week, label: fmt(w.week), total: w.merged, parts: { Merged: w.merged }, partial: false, tick: i % (data.weeks.length > 40 ? 4 : data.weeks.length > 20 ? 2 : 1) === 0 }));
  const repos = data.repos.filter((r) => r.merged > 0).sort((a, b) => b.merged - a.merged || a.repo.localeCompare(b.repo));
  const max = Math.max(1, ...repos.map((r) => r.merged));
  const label = data.range ? `${fmtRange(data.range.from, data.range.to)} · ${data.range.days} days` : undefined;

  return shell(
    <>
      <RangeBar range={range} onChange={setRange} label={label} />
      <div className="mt-4 grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div data-testid="prs-total" data-total={data.total}>
          <StatTile label="Merged PRs" icon={GitPullRequest} value={n0(data.total)} sub="merged in the selected range" />
        </div>
      </div>
      <Panel className="mt-4 p-4" >
        <PanelHeader title="Merged per week" />
        <div data-testid="prs-weekly-chart">
          <StackedBars rows={rows} categories={["Merged"]} markers={[]} directLabels={rows.length <= 16} height={150} yTicks={4} />
        </div>
      </Panel>
      <Panel className="mt-5 p-5">
        <PanelHeader title="Merged by repo" meta={`${repos.length} repos`} />
        {repos.length === 0 ? <div className="text-ink-3 text-sm mt-2">No pull request merged in this window.</div> : (
          <div className="mt-2 grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-2 text-[13px]" data-testid="prs-repos">
            {repos.map((r) => <div key={r.repo} className="grid grid-cols-[12rem_1fr_3.5rem] items-center gap-3"><span className="text-ink-1 truncate">{r.repo}</span><BarList value={r.merged / max} label="" /><span className="mono text-right text-ink-2">{n0(r.merged)}</span></div>)}
          </div>)}
      </Panel>
    </>
  );
}
