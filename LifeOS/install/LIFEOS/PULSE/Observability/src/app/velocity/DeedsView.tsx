"use client";

import { keepPreviousData } from "@tanstack/react-query";
import { useApi } from "@/lib/api";
import { Gauge, Sprout, Wrench, Hammer } from "lucide-react";
import { PageShell, PageHeader, Panel, PanelHeader, StatTile, EmptyState } from "@/components/ui/chrome";
import { n0 } from "./VelocityCharts";
import { DeedsBars, KINDS, KIND_COLOR } from "./DeedsCharts";
import { fmt, fmtRange, RangeBar, useRange, ViewSwitch } from "./shared";

/**
 * Velocity, Deeds view: what the products gained, measured by what changed in them.
 * Caps, fixes and tends are three separate numbers; nothing here adds them into one score.
 * Holds ZERO data: GET /api/velocity/deeds?range=.
 */

interface Deeds {
  available: boolean; generated?: string; range?: { from: string; to: string; days: number };
  totals: { cap: number; fix: number; tend: number };
  coverage: { repos: number; commits: number; judged: number; notJudged: number; cached: number };
  weeks: { week: string; cap: number; fix: number; tend: number }[];
  repos: { repo: string; cap: number; fix: number; tend: number }[];
  caps: { name: string; change: string; repo: string; date: string; sha: string }[];
  errors: { repo: string; code: string }[];
}

const TILES = [
  { kind: "cap", label: "Caps", icon: Sprout, sub: "capabilities gained or deepened" },
  { kind: "fix", label: "Fixes", icon: Wrench, sub: "broken things made sound" },
  { kind: "tend", label: "Tends", icon: Hammer, sub: "upkeep nobody sees" },
] as const;
const CHANGE_STYLE: Record<string, string> = {
  new: "text-[color:var(--ok,#199E70)]", deepened: "text-[color:var(--accent-blue)]",
  regressed: "text-[color:var(--ember)]", removed: "text-[color:var(--ember)]",
};
/** 24-hour local stamp, never AM/PM. */
function stamp(iso?: string): string {
  if (!iso) return "never";
  const d = new Date(iso); if (isNaN(d.getTime())) return "unknown";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export default function DeedsView() {
  const [range, setRange, ready] = useRange();
  const { data, isError: failed } = useApi<Deeds>(ready ? `/api/velocity/deeds?range=${encodeURIComponent(range)}` : null, { placeholderData: keepPreviousData });

  const header = (
    <PageHeader icon={Gauge} title="Velocity"
      subtitle={data?.available ? `What the products gained across ${n0(data.coverage.repos)} repos: capabilities shipped, things fixed, upkeep done. Each kind is counted on its own.` : "What the products gained, measured by what changed in them."} />
  );
  const shell = (body: React.ReactNode) => (
    <PageShell><div data-view="deeds" data-range={range}>{header}<ViewSwitch view="deeds" range={range} />{body}</div></PageShell>
  );

  if (failed) return shell(<div className="mt-8"><EmptyState icon={Gauge} title="Pulse unreachable" hint="The deeds numbers could not be loaded." /></div>);
  if (!data) return shell(<div className="mt-8 text-ink-3 text-sm">Loading…</div>);
  if (!data.available) return shell(<div className="mt-8"><EmptyState icon={Gauge} title="No deeds data yet" hint="The nightly deeds collector writes it; nothing has been collected so far." /></div>);

  const repos = data.repos.filter((r) => r.cap || r.fix || r.tend).sort((a, b) => b.cap - a.cap || b.fix - a.fix || b.tend - a.tend || a.repo.localeCompare(b.repo));
  const caps = [...data.caps].sort((a, b) => b.date.localeCompare(a.date));
  const label = data.range ? `${fmtRange(data.range.from, data.range.to)} · ${data.range.days} days` : undefined;

  return shell(
    <>
      <RangeBar range={range} onChange={setRange} label={label} />
      <div className="mt-4 grid grid-cols-1 sm:grid-cols-3 gap-3" data-testid="deeds-tiles">
        {TILES.map((t) => (
          <div key={t.kind} data-testid="deeds-tile" data-kind={t.kind} data-value={data.totals[t.kind]}>
            <StatTile label={t.label} icon={t.icon} value={n0(data.totals[t.kind])} sub={t.sub} />
          </div>
        ))}
      </div>
      <div className="mt-2 text-[12px] text-ink-3" data-testid="deeds-coverage">
        {n0(data.coverage.commits)} commits read, {n0(data.coverage.judged)} judged, <span className="mono text-ink-2" data-testid="deeds-not-judged" data-value={data.coverage.notJudged}>{n0(data.coverage.notJudged)}</span> not judged.
        {data.errors.length > 0 && <> {n0(data.errors.length)} {data.errors.length === 1 ? "repo" : "repos"} could not be read: {data.errors.map((e) => `${e.repo} (${e.code})`).join(", ")}.</>}
      </div>
      <Panel className="mt-4 p-4">
        <PanelHeader title="Per week" meta={<span className="inline-flex gap-4">{KINDS.map(([k, l]) => <span key={k} className="whitespace-nowrap"><i className="inline-block w-2.5 h-2.5 rounded-sm mr-1.5 align-[-1px]" style={{ background: KIND_COLOR[k] }} />{l}</span>)}</span>} />
        <DeedsBars weeks={data.weeks} height={150} />
      </Panel>
      <div className="mt-5 grid grid-cols-1 lg:grid-cols-5 gap-5">
        <Panel className="p-5 lg:col-span-2" >
          <PanelHeader title="What each repo gained" meta={`${repos.length} repos`} />
          {repos.length === 0 ? <div className="text-ink-3 text-sm mt-2">No repo had a deed in this window.</div> : (
            <div className="overflow-x-auto mt-2">
              <table className="w-full text-[13px]" data-testid="deeds-repos">
                <thead><tr className="text-ink-3 text-left"><th className="py-1.5 font-normal">Repo</th><th className="py-1.5 font-normal text-right">Caps</th><th className="py-1.5 font-normal text-right">Fixes</th><th className="py-1.5 font-normal text-right">Tends</th></tr></thead>
                <tbody>{repos.map((r) => (
                  <tr key={r.repo} className="border-t border-line-1" data-testid="deeds-repo-row">
                    <td className="py-1.5 text-ink-1">{r.repo}</td>
                    <td className="py-1.5 text-right mono text-ink-1">{n0(r.cap)}</td>
                    <td className="py-1.5 text-right mono text-ink-1">{n0(r.fix)}</td>
                    <td className="py-1.5 text-right mono text-ink-1">{n0(r.tend)}</td>
                  </tr>))}</tbody>
              </table>
            </div>)}
        </Panel>
        <Panel className="p-5 lg:col-span-3">
          <PanelHeader title="Caps by name" meta={`${n0(caps.length)} in range`} />
          {caps.length === 0 ? <div className="text-ink-3 text-sm mt-2">No cap shipped in this window.</div> : (
            <div className="overflow-y-auto mt-2 max-h-[560px]">
              <table className="w-full text-[13px]" data-testid="deeds-caps">
                <thead><tr className="text-ink-3 text-left"><th className="py-1.5 font-normal">Cap</th><th className="py-1.5 font-normal">Repo</th><th className="py-1.5 font-normal">Change</th><th className="py-1.5 font-normal text-right">Date</th></tr></thead>
                <tbody>{caps.map((c) => (
                  <tr key={`${c.repo}-${c.sha}-${c.name}`} className="border-t border-line-1 align-top" data-testid="deeds-cap-row">
                    <td className="py-1.5 pr-3 text-ink-1">{c.name}</td>
                    <td className="py-1.5 pr-3 text-ink-2 whitespace-nowrap" data-field="repo">{c.repo}</td>
                    <td className={`py-1.5 pr-3 whitespace-nowrap ${CHANGE_STYLE[c.change] ?? "text-ink-2"}`} data-field="change">{c.change}</td>
                    <td className="py-1.5 text-right mono text-ink-3 whitespace-nowrap">{fmt(c.date)}</td>
                  </tr>))}</tbody>
              </table>
            </div>)}
        </Panel>
      </div>
      <div className="mt-6 text-[12px] text-ink-3 mono">
        A cap is a capability gained or deepened, a fix moves something from broken to sound, a tend is upkeep. A cap that regressed or was removed counts -1. Judged from each commit&apos;s diff by the deeds CLI, never from its message. Collected {stamp(data.generated)}, nightly.
      </div>
    </>
  );
}
