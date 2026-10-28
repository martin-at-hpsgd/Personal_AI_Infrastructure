"use client";

import { useEffect, useRef, useState } from "react";
import { keepPreviousData, useQueryClient } from "@tanstack/react-query";
import { apiQuery, apiSend, invalidateApi, useApi } from "@/lib/api";
import { Gauge, RefreshCw, Layers, FolderKanban, Cpu, Clock, FileCode2, Scale, Flag } from "lucide-react";
import { PageShell, PageHeader, Panel, PanelHeader, StatTile, TabBar, EmptyState, type TabSpec } from "@/components/ui/chrome";
import { StackedBars, CumulativeLine, Heatmap, BarList, Sparkline, ModelStrip, PALETTE, n0, type Row, type Marker } from "./VelocityCharts";
import { fmt, fmtRange, RANGES, useRange, ViewSwitch } from "./shared";

/**
 * Velocity, Commits view: the activity analytics surface (the pre-deeds page, now one of three views). One filter bar drives every chart on every tab.
 * Holds ZERO data: /api/velocity/meta, /api/velocity/query, /api/velocity/presets.
 */

type Group = "project" | "category" | "model" | "author" | "cls";
type Tab = "overview" | "projects" | "models" | "categories" | "rhythm" | "output" | "compare" | "events";
interface Meta { available: boolean; error?: string | null; refreshing?: boolean; generated?: string; age_ms?: number; timezone: string; authorsLabel: string | null; authors: string[]; models: string[]; categories: string[]; repos: { id: string; name: string; category: string; commits: number; lastDay: string | null }[]; modelTimeline: { at: number; raw: string; label: string }[]; lanes: { lane: string; vendor: string; at: number; raw: string; label: string }[]; rows: number; collect?: Record<string, number> }
interface Agg { commits: number; ins: number; del: number; files: number; code: [number, number]; docs: [number, number]; data: [number, number]; other: [number, number]; activeDays: number }
interface Q {
  today: string; range: { from: string; to: string; days: number }; prev: { from: string; to: string } | null; bucket: "day" | "week" | "month"; group: Group;
  groups: string[]; seriesGroups: string[]; series: { key: string; total: number; ins: number; del: number; parts: Record<string, number>; partial: boolean }[];
  table: (Agg & { group: string; share: number; prevCommits: number | null; delta: number | null; lastDay: string | null })[];
  totals: Agg & { perDay: number; days: number }; prevTotals: (Agg & { perDay: number }) | null;
  rhythm: { matrix: number[][]; hours: number[]; dows: number[] };
  records: { bestDay: { day: string; commits: number }; bestWeek: { week: string; commits: number }; streak: { current: number; longest: number; from: string; to: string } };
  movers: { up: { project: string; now: number; prev: number; delta: number; ratio: number | null }[]; down: { project: string; now: number; prev: number; delta: number; ratio: number | null }[] };
  stalls: { project: string; category: string; lastDay: string | null; daysSince: number | null }[];
  models: { label: string; days: number; commits: number; perDay: number; ins: number; del: number; linesPerDay: number; codeLinesPerDay: number; windows: { from: string; to: string }[] }[];
  lanes: { lane: string; vendor: string; now: string; since: string; windows: { label: string; vendor: string; from: string; to: string; days: number }[] }[];
  vendors: { vendor: string; dispatches: number; share: number; secs: number; lastDay: string | null; agents: { agent: string; model: string; n: number; secs: number; lastDay: string }[] }[];
  dispatchSeries: { key: string; total: number; parts: Record<string, number>; partial: boolean }[]; dispatchSince: string | null;
  attribution: { evidence: number; inferred: number; vendors: { vendor: string; commits: number }[] };
  events: { type: "tag" | "model" | "custom" | "lane"; day: string; label: string; project: string | null; kind: string }[]; releases: number;
}
interface Preset { id: string; label: string; a: { from: string; to: string }; b: { from: string; to: string } }
type Cmp = { a: { from: string; to: string }; b: { from: string; to: string }; label: string };

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const fmtBucket = (key: string, bucket: string) => bucket === "month" ? `${MONTHS[+key.slice(5, 7) - 1]} ${key.slice(0, 4)}` : fmt(key);
const n1 = (n: number) => (Math.round(n * 10) / 10).toLocaleString("en-US", { maximumFractionDigits: 1 });
const pct = (n: number) => `${Math.round(n * 100)}%`;
const sign = (n: number) => (n > 0 ? `+${n0(n)}` : n0(n));
/** Which buckets get an x-axis label: every point up to 20, then thinned; month buckets over 14 label quarters, over 48 label Januaries only. */
function tickAt(q: Q, i: number): boolean {
  const n = q.series.length; const key = q.series[i].key;
  if (q.bucket === "month" && n > 48) return key.endsWith("-01-01");
  if (q.bucket === "month" && n > 14) return /-(01|04|07|10)-01$/.test(key);
  const every = n > 40 ? 4 : n > 20 ? 2 : 1; return i % every === 0;
}
const GROUPS: [Group, string][] = [["category", "Category"], ["project", "Project"], ["model", "Model"], ["author", "Author"], ["cls", "Work type"]];
const groupLabel = (g: Group) => GROUPS.find(([k]) => k === g)?.[1] ?? g;
const CLS_LABEL: Record<string, string> = { feature: "Feature", fix: "Fix", claim: "Criterion closed", release: "Release", docs: "Docs", test: "Test" };
const DOWS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const UP = "text-[color:var(--ok,#199E70)]", DOWN = "text-[color:var(--ember)]";
const qs = (o: Record<string, string | null | undefined>) => Object.entries(o).filter(([, v]) => v).map(([k, v]) => `${k}=${encodeURIComponent(v!)}`).join("&");

export default function CommitsView() {
  const queryClient = useQueryClient();
  const metaRes = useApi<Meta>("/api/velocity/meta");
  const meta: Meta | null = metaRes.data ?? (metaRes.isError ? ({ available: false, error: "Pulse unreachable" } as Meta) : null);
  const [tab, setTab] = useState<Tab>("overview");
  const [range, setRange, ready] = useRange();
  const [group, setGroup] = useState<Group>("category");
  const [filters, setFilters] = useState<{ project?: string; category?: string; author?: string; model?: string; cls?: string }>({});
  const [busy, setBusy] = useState(false);
  const { data: presets = [] } = useApi<{ presets?: Preset[] }, Preset[]>("/api/velocity/presets", { select: (j) => j.presets ?? [] });
  const [cmp, setCmp] = useState<Cmp | null>(null);

  const metaOk = !!meta?.available;
  const { data: q = null } = useApi<Q>(ready && metaOk ? `/api/velocity/query?${qs({ range, group, ...filters })}` : null, { placeholderData: keepPreviousData });
  // A new cache build (meta.generated changes) makes every query stale.
  const lastGenerated = useRef(meta?.generated);
  useEffect(() => {
    if (lastGenerated.current !== undefined && meta?.generated !== lastGenerated.current) void invalidateApi(queryClient, "/api/velocity/query");
    lastGenerated.current = meta?.generated;
  }, [meta?.generated, queryClient]);

  const cmpA = useApi<Q>(cmp && metaOk ? `/api/velocity/query?${qs({ range: `${cmp.a.from},${cmp.a.to}`, group, ...filters })}` : null, { placeholderData: keepPreviousData });
  const cmpB = useApi<Q>(cmp && metaOk ? `/api/velocity/query?${qs({ range: `${cmp.b.from},${cmp.b.to}`, group, ...filters })}` : null, { placeholderData: keepPreviousData });
  const cmpQ = cmpA.data && cmpB.data ? { a: cmpA.data, b: cmpB.data } : null;

  const refresh = async () => {
    setBusy(true);
    try {
      const before = meta?.generated;
      await apiSend("/api/velocity/refresh", "POST");
      for (let i = 0; i < 150; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const j = await queryClient.fetchQuery<Meta>({ ...apiQuery<Meta>("/api/velocity/meta"), staleTime: 0 });
        if (j.available && j.generated !== before && !j.refreshing) break;
      }
    } catch {
      // the refresh request failed; the view keeps its current data
    } finally { setBusy(false); }
  };

  const tabs: TabSpec<Tab>[] = [
    { id: "overview", label: "Overview", icon: Gauge }, { id: "projects", label: "Projects", icon: FolderKanban }, { id: "models", label: "Models", icon: Cpu },
    { id: "categories", label: "Categories", icon: Layers }, { id: "rhythm", label: "Rhythm", icon: Clock }, { id: "output", label: "Output", icon: FileCode2 },
    { id: "compare", label: "Compare", icon: Scale }, { id: "events", label: "Events", icon: Flag },
  ];

  const header = (
    <PageHeader icon={Gauge} title="Velocity"
      subtitle={meta?.available ? `Commits to main across ${meta.repos.filter((r) => r.commits > 0).length} repos${meta.authorsLabel ? `, by ${meta.authorsLabel}` : ""}. Sync commits excluded. Local days, ${meta.timezone}.` : "Shipping analytics across every configured repo."}
      actions={<button onClick={refresh} disabled={busy} className="inline-flex items-center gap-2 text-sm px-3 py-1.5 rounded-md border border-line-2 text-ink-2 hover:text-ink-1 hover:border-line-3 disabled:opacity-50"><RefreshCw className={`w-4 h-4 ${busy ? "animate-spin" : ""}`} /> {busy ? "Recounting…" : "Recount now"}</button>} />
  );

  if (!meta) return <PageShell><div data-view="commits" data-range={range}>{header}<ViewSwitch view="commits" range={range} /><div className="mt-8 text-ink-3 text-sm">Loading…</div></div></PageShell>;
  if (!meta.available) return <PageShell><div data-view="commits" data-range={range}>{header}<ViewSwitch view="commits" range={range} /><div className="mt-8"><EmptyState icon={Gauge} title="No velocity data yet" hint={meta.error ?? "Press Recount now."} /></div></div></PageShell>;

  const sel = "bg-surface-1 border border-line-2 rounded-md px-2 py-1 text-[13px] text-ink-1";
  const filterBar = (
    <div className="mt-5 flex flex-wrap items-center gap-2 text-[13px]" data-testid="velocity-filters">
      <div className="inline-flex rounded-md border border-line-2 overflow-hidden">
        {RANGES.map(([id, label]) => <button key={id} onClick={() => setRange(id)} className={`px-2.5 py-1 ${range === id ? "bg-surface-2 text-ink-1" : "text-ink-3 hover:text-ink-1"}`}>{label}</button>)}
      </div>
      <select className={sel} value={group} onChange={(e) => setGroup(e.target.value as Group)}>{GROUPS.map(([g, l]) => <option key={g} value={g}>Group: {l}</option>)}</select>
      <select className={sel} value={filters.project ?? ""} onChange={(e) => setFilters({ ...filters, project: e.target.value || undefined })}><option value="">All projects</option>{meta.repos.filter((r) => r.commits > 0).map((r) => <option key={r.id} value={r.name}>{r.name}</option>)}</select>
      <select className={sel} value={filters.category ?? ""} onChange={(e) => setFilters({ ...filters, category: e.target.value || undefined })}><option value="">All categories</option>{meta.categories.map((c) => <option key={c} value={c}>{c}</option>)}</select>
      <select className={sel} value={filters.model ?? ""} onChange={(e) => setFilters({ ...filters, model: e.target.value || undefined })}><option value="">All models</option>{meta.models.map((m) => <option key={m} value={m}>{m}</option>)}</select>
      <select className={sel} value={filters.author ?? ""} onChange={(e) => setFilters({ ...filters, author: e.target.value || undefined })}><option value="">All authors</option>{meta.authors.map((a) => <option key={a} value={a}>{a}</option>)}</select>
      <select className={sel} value={filters.cls ?? ""} onChange={(e) => setFilters({ ...filters, cls: e.target.value || undefined })}><option value="">All work</option>{Object.entries(CLS_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
      {Object.values(filters).some(Boolean) && <button className="text-ink-3 hover:text-ink-1 underline" onClick={() => setFilters({})}>clear</button>}
      {q && <span className="ml-auto text-ink-3 mono" data-testid="velocity-range">{fmtRange(q.range.from, q.range.to)} · {q.range.days} days</span>}
    </div>
  );

  return (
    <PageShell><div data-view="commits" data-range={range}>
      {header}
      <ViewSwitch view="commits" range={range} />
      {filterBar}
      <TabBar className="mt-4" tabs={tabs} active={tab} onChange={setTab} />
      {!q ? <div className="mt-8 text-ink-3 text-sm">Querying…</div> : (
        <div className="mt-5" data-testid="velocity-tab" data-tab={tab} data-total={q.totals.commits}>
          {tab === "overview" && <Overview q={q} />}
          {tab === "projects" && <Projects q={q} group={group} />}
          {tab === "models" && <Models q={q} meta={meta} />}
          {tab === "categories" && <Categories q={q} />}
          {tab === "rhythm" && <Rhythm q={q} />}
          {tab === "output" && <Output q={q} />}
          {tab === "compare" && <Compare presets={presets} cmp={cmp} setCmp={setCmp} cmpQ={cmpQ} today={q.today} />}
          {tab === "events" && <Events q={q} />}
        </div>
      )}
      <div className="mt-6 flex flex-wrap justify-between gap-4 text-[12px] text-ink-3 mono">
        <span>{n0(meta.rows)} commits in the cache. A commit whose Co-Authored-By trailer names a model is attributed to that model; the rest go to the carrier pinned in this system&apos;s config at commit time, which is inference, not proof. Other vendors also show as agent dispatches from the subagent log and as lane pins from config history.</span>
        <span>Recounted {Math.round((meta.age_ms ?? 0) / 3_600_000) < 1 ? "under an hour" : `${Math.round((meta.age_ms ?? 0) / 3_600_000)} h`} ago, nightly at 03:30.</span>
      </div>
    </div></PageShell>
  );
}

// ---------- shared pieces ----------

function seriesRows(q: Q): Row[] {
  return q.series.map((s, i) => ({ key: s.key, label: fmtBucket(s.key, q.bucket), total: s.total, parts: s.parts, partial: s.partial, tick: tickAt(q, i) }));
}
function bucketIndex(q: Q, day: string) { return q.series.findIndex((s, i) => s.key <= day && (i + 1 >= q.series.length || q.series[i + 1].key > day)); }
function eventMarkers(q: Q): Marker[] {
  return q.events.filter((e) => e.type === "model" || e.type === "custom").map((e) => ({ atIndex: bucketIndex(q, e.day), label: e.label })).filter((m) => m.atIndex >= 0).slice(0, 6);
}
function Legend({ groups, table, group }: { groups: string[]; table: Q["table"]; group: Group }) {
  const map = new Map(table.map((t) => [t.group, t.commits]));
  const other = table.slice(4).reduce((a, t) => a + t.commits, 0);
  return (
    <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5 text-[13px] text-ink-2">
      {groups.map((g, i) => <span key={g} className="whitespace-nowrap"><i className="inline-block w-2.5 h-2.5 rounded-sm mr-1.5 align-[-1px]" style={{ background: PALETTE[Math.min(i, PALETTE.length - 1)] }} />{group === "cls" ? CLS_LABEL[g] ?? g : g} <b className="font-normal text-ink-1 mono ml-0.5">{n0(g === "Other" ? other : map.get(g) ?? 0)}</b></span>)}
    </div>
  );
}
function Delta({ now, prev }: { now: number; prev: number | null | undefined }) {
  if (prev === null || prev === undefined) return null;
  const d = now - prev; const r = prev ? Math.round((d / prev) * 100) : null;
  return <span className={d > 0 ? UP : d < 0 ? DOWN : "text-ink-3"}>{sign(Math.round(d * 10) / 10)}{r !== null ? ` (${r > 0 ? "+" : ""}${r}%)` : ""} vs previous</span>;
}

// ---------- tabs ----------

function Overview({ q }: { q: Q }) {
  const t = q.totals, p = q.prevTotals;
  const codeLines = t.code[0] + t.code[1];
  const cum = (() => { let acc = 0; return q.series.map((s, i) => ({ day: s.key, label: fmtBucket(s.key, q.bucket), tick: tickAt(q, i), total: (acc += s.total) })); })();
  const cf = p ? Math.round(p.perDay * q.range.days) : 0;
  return (
    <>
      <div className="grid grid-cols-2 lg:grid-cols-6 gap-3">
        <StatTile label="Commits" value={n0(t.commits)} sub={<Delta now={t.commits} prev={p?.commits} />} />
        <StatTile label="Per day" value={n1(t.perDay)} sub={p ? <Delta now={t.perDay} prev={p.perDay} /> : `${t.activeDays} active days`} />
        <StatTile label="Code lines" value={n0(codeLines)} sub={p ? <Delta now={codeLines} prev={p.code[0] + p.code[1]} /> : `+${n0(t.code[0])} −${n0(t.code[1])}`} />
        <StatTile label="Files touched" value={n0(t.files)} sub={p ? <Delta now={t.files} prev={p.files} /> : undefined} />
        <StatTile label="Active days" value={`${t.activeDays}/${t.days}`} sub={`streak ${q.records.streak.current}, longest ${q.records.streak.longest}`} />
        <StatTile label="Releases" value={n0(q.releases)} sub="tags in range" />
      </div>
      <Panel className="mt-5 p-5">
        <PanelHeader title={`Commits per ${q.bucket}, by ${groupLabel(q.group).toLowerCase()}`} />
        <StackedBars rows={seriesRows(q)} categories={q.seriesGroups} markers={eventMarkers(q)} directLabels={q.series.length <= 16} height={300} yTicks={5} />
        <Legend groups={q.seriesGroups} table={q.table} group={q.group} />
      </Panel>
      <div className="mt-5 grid grid-cols-1 lg:grid-cols-3 gap-5">
        <Panel className="p-5"><PanelHeader title="Movers" meta={q.prev ? "vs previous window" : "needs a bounded range"} />
          {q.movers.up.length + q.movers.down.length === 0 ? <div className="text-ink-3 text-sm mt-2">Nothing crossed the floor.</div> : (
            <table className="w-full text-[13px] mt-2"><tbody>
              {[...q.movers.up, ...q.movers.down].map((m) => <tr key={m.project} className="border-t border-line-1"><td className="py-1.5 text-ink-1">{m.project}</td><td className="py-1.5 text-right mono text-ink-2">{n0(m.prev)} → {n0(m.now)}</td><td className={`py-1.5 text-right mono ${m.delta > 0 ? UP : DOWN}`}>{sign(m.delta)}</td></tr>)}
            </tbody></table>)}
        </Panel>
        <Panel className="p-5"><PanelHeader title="Stalled" meta="no commits in 14+ days" />
          {q.stalls.length === 0 ? <div className="text-ink-3 text-sm mt-2">Nothing stalled.</div> : (
            <table className="w-full text-[13px] mt-2"><tbody>
              {q.stalls.map((s) => <tr key={s.project} className="border-t border-line-1"><td className="py-1.5 text-ink-1">{s.project}</td><td className="py-1.5 text-ink-3">{s.category}</td><td className="py-1.5 text-right mono text-ink-2">{s.daysSince} d</td></tr>)}
            </tbody></table>)}
        </Panel>
        <Panel className="p-5"><PanelHeader title="Records" meta="in range" />
          <dl className="mt-2 text-[13px] grid grid-cols-[1fr_auto] gap-y-1.5">
            <dt className="text-ink-2">Best day</dt><dd className="mono text-ink-1 text-right">{q.records.bestDay.commits ? `${n0(q.records.bestDay.commits)} on ${fmt(q.records.bestDay.day)}` : "—"}</dd>
            <dt className="text-ink-2">Best week</dt><dd className="mono text-ink-1 text-right">{q.records.bestWeek.commits ? `${n0(q.records.bestWeek.commits)} from ${fmt(q.records.bestWeek.week)}` : "—"}</dd>
            <dt className="text-ink-2">Longest streak</dt><dd className="mono text-ink-1 text-right">{q.records.streak.longest ? `${q.records.streak.longest} days, ${fmt(q.records.streak.from)}–${fmt(q.records.streak.to)}` : "—"}</dd>
            <dt className="text-ink-2">Lines, all classes</dt><dd className="mono text-ink-1 text-right">+{n0(t.ins)} −{n0(t.del)}</dd>
          </dl>
        </Panel>
      </div>
      <Panel className="mt-5 p-5">
        <PanelHeader title="Cumulative commits in range" meta={p ? "dashed: the previous window's pace" : undefined} />
        <CumulativeLine series={cum} events={q.events.filter((e) => e.type !== "tag").map((e) => ({ date: q.series[bucketIndex(q, e.day)]?.key ?? e.day, label: e.label }))} counterfactual={cf} counterfactualLabel={p ? `at the previous window's pace: ${n0(cf)}` : ""} height={240} />
      </Panel>
    </>
  );
}

function Projects({ q, group }: { q: Q; group: Group }) {
  return (
    <Panel className="p-5">
      <PanelHeader title={`${groupLabel(group)}s in range`} meta={`${q.table.length} groups`} />
      <div className="overflow-x-auto mt-2">
        <table className="w-full text-[13px]">
          <thead><tr className="text-ink-3 text-left"><th className="py-1.5 font-normal">Name</th><th className="py-1.5 font-normal text-right">Commits</th><th className="py-1.5 font-normal">Share</th><th className="py-1.5 font-normal text-right">Δ prev</th><th className="py-1.5 font-normal text-right">Code lines</th><th className="py-1.5 font-normal text-right">Files</th><th className="py-1.5 font-normal text-right">Active days</th><th className="py-1.5 font-normal text-right">Last</th></tr></thead>
          <tbody>{q.table.map((r) => (
            <tr key={r.group} className="border-t border-line-1">
              <td className="py-1.5 text-ink-1">{group === "cls" ? CLS_LABEL[r.group] ?? r.group : r.group}</td>
              <td className="py-1.5 text-right mono text-ink-1">{n0(r.commits)}</td>
              <td className="py-1.5 w-40"><BarList value={r.share} label={pct(r.share)} /></td>
              <td className={`py-1.5 text-right mono ${r.delta === null ? "text-ink-3" : r.delta > 0 ? UP : r.delta < 0 ? DOWN : "text-ink-3"}`}>{r.delta === null ? "—" : sign(r.delta)}</td>
              <td className="py-1.5 text-right mono text-ink-2">+{n0(r.code[0])} −{n0(r.code[1])}</td>
              <td className="py-1.5 text-right mono text-ink-2">{n0(r.files)}</td>
              <td className="py-1.5 text-right mono text-ink-2">{r.activeDays}</td>
              <td className="py-1.5 text-right mono text-ink-3">{r.lastDay ? fmt(r.lastDay) : "—"}</td>
            </tr>))}</tbody>
        </table>
      </div>
    </Panel>
  );
}

function Models({ q, meta }: { q: Q; meta: Meta }) {
  const max = Math.max(1, ...q.models.map((m) => m.perDay));
  return (
    <>
      <Panel className="p-5">
        <PanelHeader title="Rate by attributed model, in range" meta={`commits per pinned day · ${n0(q.attribution.evidence)} commits name their model in a trailer${q.attribution.vendors.length ? ` (${q.attribution.vendors.map((v) => `${v.vendor} ${n0(v.commits)}`).join(", ")})` : ""}, ${n0(q.attribution.inferred)} fall back to the carrier pinned that day`} />
        <table className="w-full text-[13px] mt-2">
          <thead><tr className="text-ink-3 text-left"><th className="py-1.5 font-normal">Model</th><th className="py-1.5 font-normal text-right">Pinned days</th><th className="py-1.5 pr-6 font-normal text-right">Commits</th><th className="py-1.5 font-normal">Commits / day</th><th className="py-1.5 font-normal text-right">Code lines / day</th><th className="py-1.5 font-normal text-right">All lines / day</th></tr></thead>
          <tbody>{q.models.map((m, i) => (
            <tr key={m.label} className="border-t border-line-1">
              <td className="py-1.5 text-ink-1"><i className="inline-block w-2.5 h-2.5 rounded-sm mr-2 align-[-1px]" style={{ background: PALETTE[Math.min(i, 4)] }} />{m.label}</td>
              <td className="py-1.5 text-right mono text-ink-2">{m.days ? n1(m.days) : "—"}</td>
              <td className="py-1.5 pr-6 text-right mono text-ink-1">{n0(m.commits)}</td>
              <td className="py-1.5 w-56">{m.days ? <BarList value={m.perDay / max} label={n1(m.perDay)} color={PALETTE[Math.min(i, 4)]} /> : <span className="text-ink-3 text-[12px]">never the carrier · trailer evidence only</span>}</td>
              <td className="py-1.5 text-right mono text-ink-2">{n0(m.codeLinesPerDay)}</td>
              <td className="py-1.5 text-right mono text-ink-2">{n0(m.linesPerDay)}</td>
            </tr>))}</tbody>
        </table>
      </Panel>
      <Panel className="mt-5 p-5">
        <PanelHeader title="Which carrier was pinned when" meta="from this system's config history" />
        <ModelStrip timeline={meta.modelTimeline} from={q.range.from} to={q.range.to} labels={q.models.map((m) => m.label)} />
      </Panel>
      <Vendors q={q} />
      <Lanes q={q} meta={meta} />
      {q.group === "model" && (
        <Panel className="mt-5 p-5">
          <PanelHeader title={`Commits per ${q.bucket}, by model`} />
          <StackedBars rows={seriesRows(q)} categories={q.seriesGroups} markers={eventMarkers(q)} directLabels={false} height={260} yTicks={4} />
          <Legend groups={q.seriesGroups} table={q.table} group={q.group} />
        </Panel>
      )}
      {q.group !== "model" && <div className="mt-3 text-[12px] text-ink-3">Set the filter bar to Group: Model for the per-bucket chart by model.</div>}
    </>
  );
}

function Categories({ q }: { q: Q }) {
  const rows = seriesRows(q).map((r) => { const t = Object.values(r.parts).reduce((a, b) => a + b, 0) || 1; return { ...r, total: 100, parts: Object.fromEntries(Object.entries(r.parts).map(([k, v]) => [k, (v / t) * 100])) }; });
  return (
    <>
      <Panel className="p-5">
        <PanelHeader title={`Share per ${q.bucket}, by ${groupLabel(q.group).toLowerCase()}`} meta="100% stacked" />
        <StackedBars rows={rows} categories={q.seriesGroups} markers={[]} directLabels={false} height={260} yTicks={4} format={(v) => `${Math.round(v)}%`} />
        <Legend groups={q.seriesGroups} table={q.table} group={q.group} />
      </Panel>
      <Panel className="mt-5 p-5">
        <PanelHeader title="Share in range" />
        <div className="mt-2 grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-2 text-[13px]">
          {q.table.map((r, i) => <div key={r.group} className="grid grid-cols-[10rem_1fr_4rem] items-center gap-3"><span className="text-ink-1 truncate">{q.group === "cls" ? CLS_LABEL[r.group] ?? r.group : r.group}</span><BarList value={r.share} label="" color={PALETTE[Math.min(i, 4)]} /><span className="mono text-right text-ink-2">{pct(r.share)}</span></div>)}
        </div>
      </Panel>
    </>
  );
}

function Rhythm({ q }: { q: Q }) {
  const dmax = Math.max(1, ...q.rhythm.dows);
  const peakHour = q.rhythm.hours.indexOf(Math.max(...q.rhythm.hours));
  const peakDow = q.rhythm.dows.indexOf(dmax);
  const total = Math.max(1, q.totals.commits);
  return (
    <>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatTile label="Peak hour" value={`${String(peakHour).padStart(2, "0")}:00`} sub={`${n0(q.rhythm.hours[peakHour])} commits`} />
        <StatTile label="Peak weekday" value={DOWS[peakDow]} sub={`${n0(dmax)} commits`} />
        <StatTile label="Night share" value={pct(q.rhythm.hours.slice(0, 6).concat(q.rhythm.hours.slice(22)).reduce((a, b) => a + b, 0) / total)} sub="22:00–06:00" />
        <StatTile label="Weekend share" value={pct((q.rhythm.dows[5] + q.rhythm.dows[6]) / total)} sub="Sat + Sun" />
      </div>
      <Panel className="mt-5 p-5"><PanelHeader title="Commits by hour and weekday" /><Heatmap matrix={q.rhythm.matrix} rowLabels={DOWS} /></Panel>
      <Panel className="mt-5 p-5"><PanelHeader title="By weekday" />
        <div className="mt-2 grid grid-cols-1 gap-1.5 text-[13px]">{DOWS.map((d, i) => <div key={d} className="grid grid-cols-[3rem_1fr_4rem] items-center gap-3"><span className="text-ink-2">{d}</span><BarList value={q.rhythm.dows[i] / dmax} label="" /><span className="mono text-right text-ink-1">{n0(q.rhythm.dows[i])}</span></div>)}</div>
      </Panel>
    </>
  );
}

function Output({ q }: { q: Q }) {
  const t = q.totals;
  const classes: [string, [number, number]][] = [["Code", t.code], ["Docs", t.docs], ["Data", t.data], ["Other", t.other]];
  const cmax = Math.max(1, ...classes.map(([, v]) => v[0] + v[1]));
  const lineRows: Row[] = q.series.map((s, i) => ({ key: s.key, label: fmtBucket(s.key, q.bucket), total: s.ins + s.del, parts: { Added: s.ins, Removed: s.del }, partial: s.partial, tick: tickAt(q, i) }));
  const byGroup = [...q.table].sort((a, b) => (b.code[0] + b.code[1]) - (a.code[0] + a.code[1])).slice(0, 12);
  const gmax = Math.max(1, ...byGroup.map((r) => r.code[0] + r.code[1]));
  return (
    <>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {classes.map(([k, v]) => <StatTile key={k} label={`${k} lines`} value={n0(v[0] + v[1])} sub={`+${n0(v[0])} −${n0(v[1])}`} />)}
      </div>
      <Panel className="mt-5 p-5"><PanelHeader title={`Lines added and removed per ${q.bucket}`} meta="lockfiles and minified files excluded" />
        <StackedBars rows={lineRows} categories={["Added", "Removed"]} markers={[]} directLabels={false} height={260} yTicks={4} />
        <div className="mt-3 flex gap-5 text-[13px] text-ink-2"><span><i className="inline-block w-2.5 h-2.5 rounded-sm mr-1.5" style={{ background: PALETTE[0] }} />Added</span><span><i className="inline-block w-2.5 h-2.5 rounded-sm mr-1.5" style={{ background: PALETTE[1] }} />Removed</span></div>
      </Panel>
      <div className="mt-5 grid grid-cols-1 lg:grid-cols-2 gap-5">
        <Panel className="p-5"><PanelHeader title="Lines by class" />
          <div className="mt-2 grid gap-1.5 text-[13px]">{classes.map(([k, v], i) => <div key={k} className="grid grid-cols-[4rem_1fr_7rem] items-center gap-3"><span className="text-ink-2">{k}</span><BarList value={(v[0] + v[1]) / cmax} label="" color={PALETTE[i]} /><span className="mono text-right text-ink-1">{n0(v[0] + v[1])}</span></div>)}</div>
        </Panel>
        <Panel className="p-5"><PanelHeader title={`Code lines by ${groupLabel(q.group).toLowerCase()}`} meta="top 12" />
          <div className="mt-2 grid gap-1.5 text-[13px]">{byGroup.map((r) => <div key={r.group} className="grid grid-cols-[9rem_1fr_7rem] items-center gap-3"><span className="text-ink-2 truncate">{q.group === "cls" ? CLS_LABEL[r.group] ?? r.group : r.group}</span><BarList value={(r.code[0] + r.code[1]) / gmax} label="" /><span className="mono text-right text-ink-1">{n0(r.code[0] + r.code[1])}</span></div>)}</div>
        </Panel>
      </div>
    </>
  );
}

function Compare({ presets, cmp, setCmp, cmpQ, today }: { presets: Preset[]; cmp: Cmp | null; setCmp: (c: Cmp | null) => void; cmpQ: { a: Q; b: Q } | null; today: string }) {
  const [a, setA] = useState({ from: "", to: "" }); const [b, setB] = useState({ from: "", to: "" });
  const inp = "bg-surface-1 border border-line-2 rounded-md px-2 py-1 text-[13px] text-ink-1 mono";
  const metric = (label: string, fa: number, fb: number, f: (n: number) => string = n0) => {
    const r = fa ? fb / fa : null;
    return <tr key={label} className="border-t border-line-1"><td className="py-1.5 text-ink-2">{label}</td><td className="py-1.5 text-right mono text-ink-1">{f(fa)}</td><td className="py-1.5 text-right mono text-ink-1">{f(fb)}</td><td className={`py-1.5 text-right mono ${r === null ? "text-ink-3" : r >= 1 ? UP : DOWN}`}>{r === null ? "—" : `${n1(r)}×`}</td></tr>;
  };
  return (
    <>
      <Panel className="p-5">
        <PanelHeader title="Pick two windows" meta="presets: every model switch and feature release in the cache" />
        <div className="mt-3 flex flex-wrap items-center gap-2 text-[13px]">
          <select className={inp} data-testid="velocity-preset" value={cmp?.label ?? ""} onChange={(e) => { const p = presets.find((x) => x.label === e.target.value); if (p) setCmp({ a: p.a, b: p.b, label: p.label }); }}>
            <option value="">Preset…</option>{presets.map((p) => <option key={p.id} value={p.label}>{p.label}</option>)}
          </select>
          <span className="text-ink-3">or</span>
          <input className={inp} type="date" value={a.from} max={today} onChange={(e) => setA({ ...a, from: e.target.value })} /><span className="text-ink-3">–</span><input className={inp} type="date" value={a.to} max={today} onChange={(e) => setA({ ...a, to: e.target.value })} />
          <span className="text-ink-3">vs</span>
          <input className={inp} type="date" value={b.from} max={today} onChange={(e) => setB({ ...b, from: e.target.value })} /><span className="text-ink-3">–</span><input className={inp} type="date" value={b.to} max={today} onChange={(e) => setB({ ...b, to: e.target.value })} />
          <button className="px-2.5 py-1 rounded-md border border-line-2 text-ink-2 hover:text-ink-1 disabled:opacity-50" disabled={!(a.from && a.to && b.from && b.to)} onClick={() => setCmp({ a, b, label: "custom" })}>Compare</button>
        </div>
      </Panel>
      {cmp && cmpQ && (
        <Panel className="mt-5 p-5" data-testid="velocity-compare">
          <PanelHeader title={cmp.label === "custom" ? "Custom windows" : cmp.label} meta={`A ${fmt(cmpQ.a.range.from)}–${fmt(cmpQ.a.range.to)} (${cmpQ.a.range.days} d) · B ${fmt(cmpQ.b.range.from)}–${fmt(cmpQ.b.range.to)} (${cmpQ.b.range.days} d)`} />
          <table className="w-full text-[13px] mt-2">
            <thead><tr className="text-ink-3 text-left"><th className="py-1.5 font-normal">Metric</th><th className="py-1.5 font-normal text-right">A</th><th className="py-1.5 font-normal text-right">B</th><th className="py-1.5 font-normal text-right">B / A</th></tr></thead>
            <tbody>
              {metric("Commits per day", cmpQ.a.totals.perDay, cmpQ.b.totals.perDay, n1)}
              {metric("Commits", cmpQ.a.totals.commits, cmpQ.b.totals.commits)}
              {metric("Code lines per day", (cmpQ.a.totals.code[0] + cmpQ.a.totals.code[1]) / cmpQ.a.range.days, (cmpQ.b.totals.code[0] + cmpQ.b.totals.code[1]) / cmpQ.b.range.days)}
              {metric("Files per day", cmpQ.a.totals.files / cmpQ.a.range.days, cmpQ.b.totals.files / cmpQ.b.range.days, n1)}
              {metric("Active days share", cmpQ.a.totals.activeDays / cmpQ.a.range.days, cmpQ.b.totals.activeDays / cmpQ.b.range.days, pct)}
              {metric("Best day", cmpQ.a.records.bestDay.commits, cmpQ.b.records.bestDay.commits)}
              {metric("Releases", cmpQ.a.releases, cmpQ.b.releases)}
            </tbody>
          </table>
          <div className="mt-4 grid grid-cols-1 lg:grid-cols-2 gap-5">
            {[cmpQ.a, cmpQ.b].map((w, i) => <div key={i}><div className="text-[12px] text-ink-3 mb-1">{i === 0 ? "A" : "B"} · commits per {w.bucket}</div><Sparkline values={w.series.map((s) => s.total)} labels={w.series.map((s) => fmtBucket(s.key, w.bucket))} height={64} color={PALETTE[i]} /></div>)}
          </div>
        </Panel>
      )}
    </>
  );
}

const VENDOR_COLOR: Record<string, string> = { Anthropic: PALETTE[0], OpenAI: PALETTE[1], Google: PALETTE[2], xAI: PALETTE[3], Perplexity: PALETTE[4], "Z.ai": PALETTE[4], Other: PALETTE[4] };
const vcolor = (v: string) => VENDOR_COLOR[v] ?? PALETTE[4];
const hrs = (secs: number) => secs >= 3600 ? `${n1(secs / 3600)} h` : secs >= 60 ? `${n0(secs / 60)} min` : "<1 min";

/** Every vendor that actually ran: agent dispatches with the resolved model, from the subagent event log. */
function Vendors({ q }: { q: Q }) {
  const rows: Row[] = q.dispatchSeries.map((s, i) => ({ key: s.key, label: fmtBucket(s.key, q.bucket), total: s.total, parts: s.parts, partial: s.partial, tick: tickAt(q, i) }));
  const vendors = q.vendors.map((v) => v.vendor);
  return (
    <Panel className="mt-5 p-5">
      <PanelHeader title="Vendors in the loop, in range" meta={q.dispatchSince ? `agent dispatches with the resolved model · log starts ${fmt(q.dispatchSince)}, ${q.dispatchSince.slice(0, 4)}` : "no dispatch log yet"} />
      {q.vendors.length === 0 ? <div className="text-ink-3 text-sm mt-2">No agent dispatches in this window.</div> : (
        <>
          <table className="w-full text-[13px] mt-2">
            <thead><tr className="text-ink-3 text-left"><th className="py-1.5 font-normal">Vendor</th><th className="py-1.5 font-normal text-right">Dispatches</th><th className="py-1.5 font-normal">Share</th><th className="py-1.5 font-normal">Agents · model</th><th className="py-1.5 font-normal text-right whitespace-nowrap pl-4">Run time</th><th className="py-1.5 font-normal text-right whitespace-nowrap pl-4">Last</th></tr></thead>
            <tbody>{q.vendors.map((v) => (
              <tr key={v.vendor} className="border-t border-line-1 align-top">
                <td className="py-1.5 text-ink-1 whitespace-nowrap"><i className="inline-block w-2.5 h-2.5 rounded-sm mr-2 align-[-1px]" style={{ background: vcolor(v.vendor) }} />{v.vendor}</td>
                <td className="py-1.5 text-right mono text-ink-1">{n0(v.dispatches)}</td>
                <td className="py-1.5 w-40"><BarList value={v.share} label={pct(v.share)} color={vcolor(v.vendor)} /></td>
                <td className="py-1.5 text-ink-2">{v.agents.slice(0, 6).map((a) => `${a.agent} · ${a.model} (${n0(a.n)})`).join(", ")}{v.agents.length > 6 && <span className="text-ink-3"> +{v.agents.length - 6} more</span>}</td>
                <td className="py-1.5 text-right mono text-ink-2 whitespace-nowrap pl-4">{v.secs ? hrs(v.secs) : "—"}</td>
                <td className="py-1.5 text-right mono text-ink-2 whitespace-nowrap pl-4">{v.lastDay ? fmt(v.lastDay) : "—"}</td>
              </tr>))}</tbody>
          </table>
          <div className="mt-4"><PanelHeader title={`Dispatches per ${q.bucket}, by vendor`} /></div>
          <StackedBars rows={rows} categories={vendors} palette={vendors.map(vcolor)} markers={[]} directLabels={false} height={220} yTicks={4} />
        </>
      )}
    </Panel>
  );
}

/** Every lane's pinned model over the range: carrier, advisor, and each cross-vendor lane from config history. */
function Lanes({ q, meta }: { q: Q; meta: Meta }) {
  const order = (l: string) => l === "carrier" ? 0 : l === "advisor" ? 1 : 2;
  const lanes = [...q.lanes].sort((a, b) => order(a.lane) - order(b.lane) || a.vendor.localeCompare(b.vendor) || a.lane.localeCompare(b.lane));
  return (
    <Panel className="mt-5 p-5">
      <PanelHeader title="Which model each lane was pinned to, in range" meta="config history · settings.json and the cross-vendor lane table" />
      {lanes.length === 0 ? <div className="text-ink-3 text-sm mt-2">No lane pins in this window.</div> : (
        <div className="mt-2 grid gap-1">
          {lanes.map((l) => (
            <div key={l.lane} className="grid grid-cols-[11rem_6rem_1fr_17rem] gap-3 items-center border-t border-line-1 py-1.5 text-[13px]">
              <span className="text-ink-1 mono truncate">{l.lane}</span>
              <span className="text-ink-2"><i className="inline-block w-2.5 h-2.5 rounded-sm mr-1.5 align-[-1px]" style={{ background: vcolor(l.vendor) }} />{l.vendor}</span>
              <ModelStrip timeline={meta.lanes.filter((p) => p.lane === l.lane)} from={q.range.from} to={q.range.to} labels={[...new Set(l.windows.map((w) => w.label))]} compact />
              <span className="text-ink-2 text-right whitespace-nowrap">{l.now} <span className="text-ink-3 mono">since {fmt(l.since)}</span></span>
            </div>))}
        </div>
      )}
    </Panel>
  );
}

function Events({ q }: { q: Q }) {
  const byDay = new Map<string, Q["events"]>(); for (const e of q.events) { const arr = byDay.get(e.day) ?? []; arr.push(e); byDay.set(e.day, arr); }
  const days = [...byDay.keys()].sort().reverse();
  return (
    <Panel className="p-5">
      <PanelHeader title="Releases, carrier switches, and lane pins in range" meta={`${q.events.length} events shown, ${q.releases} tags including patches`} />
      {days.length === 0 ? <div className="text-ink-3 text-sm mt-2">Nothing in this window.</div> : (
        <div className="mt-2 grid gap-1 text-[13px]">
          {days.map((d) => <div key={d} className="grid grid-cols-[5rem_1fr] gap-3 border-t border-line-1 py-1.5"><span className="mono text-ink-3">{fmt(d)}</span><span className="flex flex-wrap gap-x-4 gap-y-1">{byDay.get(d)!.map((e, i) => <span key={i} className={e.type === "model" ? "text-[color:var(--accent-blue)]" : e.type === "lane" ? "text-ink-2" : "text-ink-1"}>{e.type === "model" ? `→ ${e.label}` : e.type === "lane" ? `${e.label} (${e.kind})` : `${e.project} ${e.label}`}</span>)}</span></div>)}
        </div>)}
    </Panel>
  );
}
