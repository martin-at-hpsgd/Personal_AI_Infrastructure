"use client";

import { useMemo, useState } from "react";
import { ApiError, apiSend, useApi } from "@/lib/api";
import { BookMarked, Search, Activity, ExternalLink } from "lucide-react";
import { PageShell, PageHeader, Panel, PanelHeader, StatTile, Pill, EmptyState, type Dim } from "@/components/ui/chrome";
import EmptyStateGuide from "@/components/EmptyStateGuide";

/**
 * Corpus — the principal's published body of work as the Corpus Worker indexes it. Zero data in this component:
 * it fetches /api/corpus (modules/corpus.ts), whose endpoint and credentials live in
 * the Corpus skill's Config.md and the private .env. Unconfigured installs see the setup guide.
 */

type SourceCount = { source: string; documents: number; undated: number };
type Scan = { source: string; status: string; scope: string; documents: number; updatedAt: string; error: string | null };
type Run = { id?: string; trigger: string; status: string; startedAt: string; finishedAt: string | null; error: string | null };
type Status = { documents: SourceCount[]; projection: { status: string; count: number }[]; source_scans: Scan[]; runs: Run[]; coverageScope: string };
type Overview = { configured: false; configPath: string } | { configured: true; host: string; fetchedAt: string; status?: Status; error?: string };
type Hit = { title: string; url: string; date: string; source?: string; excerpt: string; score: number; attribution: string };
type SearchResult = { results: Hit[]; total_found?: number; retrieval_status?: string; partial?: boolean; error?: string };

const LABELS: Record<string, string> = { blog: "Blog", newsletter: "Newsletter", video: "Video", tweet: "X", linkedin: "LinkedIn", podcast: "Podcast", article: "Article" };
const label = (s: string) => LABELS[s] ?? s;
const fmt = (n: number) => n.toLocaleString("en-US");

function age(iso: string | null | undefined): string {
  if (!iso) return "—";
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return "—";
  const h = ms / 3_600_000;
  if (h < 1) return `${Math.max(1, Math.round(ms / 60_000))} min ago`;
  if (h < 48) return `${Math.round(h)} h ago`;
  return `${Math.round(h / 24)} d ago`;
}
const stamp = (iso: string | null | undefined) => (iso ? iso.slice(0, 16).replace("T", " ") : "—");
const tone = (status: string): Dim => (status === "complete" ? "ok" : status === "running" || status === "verifying" || status === "pending" ? "blue" : status === "partial" || status === "retry" ? "warn" : "err");

export default function CorpusPage() {
  const overview = useApi<Overview>("/api/corpus");
  const data = overview.data ?? null;
  const error = overview.isError && !data ? String(overview.error) : null;
  const [query, setQuery] = useState("");
  const [source, setSource] = useState<string | null>(null);
  const [search, setSearch] = useState<SearchResult | null>(null);
  const [searching, setSearching] = useState(false);

  const status = data?.configured ? data.status : undefined;
  const host = data?.configured ? data.host : "";
  const fetchedAt = data?.configured ? data.fetchedAt : null;
  const total = useMemo(() => (status?.documents ?? []).reduce((n, s) => n + s.documents, 0), [status]);
  const sources = useMemo(() => [...(status?.documents ?? [])].sort((a, b) => b.documents - a.documents), [status]);
  const scans = useMemo(() => new Map((status?.source_scans ?? []).map((s) => [s.source, s])), [status]);
  const projected = status?.projection.find((p) => p.status === "complete")?.count ?? 0;
  const projectionTotal = (status?.projection ?? []).reduce((n, p) => n + p.count, 0);
  const lastRun = status?.runs[0];

  async function runSearch(e?: { preventDefault(): void }) {
    e?.preventDefault();
    const q = query.trim();
    if (!q) return;
    setSearching(true);
    try {
      setSearch(await apiSend<SearchResult>("/api/corpus/search", "POST", { query: q, source: source ?? undefined, limit: 12 }));
    } catch (err) {
      // The endpoint answers 4xx with a JSON body ({ error } or { configured: false, results: [] }); show it as before.
      let body: SearchResult | null = null;
      if (err instanceof ApiError) {
        try { body = JSON.parse(err.body) as SearchResult; } catch { /* not JSON */ }
      }
      // A bare { error } body carries no results array; default it so the result list never reads undefined.
      setSearch(body ? { ...body, results: Array.isArray(body.results) ? body.results : [] } : { results: [], error: String(err) });
    } finally {
      setSearching(false);
    }
  }

  const subtitle = status
    ? `Everything published, indexed and searchable. ${fmt(total)} documents across ${sources.length} sources.`
    : "Everything published, indexed and searchable.";

  return (
    <PageShell className="max-w-[1200px]">
      <PageHeader icon={BookMarked} title="Corpus" subtitle={subtitle} />

      {error && <div className="text-warn text-sm">Couldn&apos;t reach the Corpus API: {error}</div>}
      {!data && !error && <div className="text-ink-3 text-sm">Loading…</div>}

      {data && !data.configured && (
        <EmptyStateGuide
          section="Corpus"
          description="Corpus indexes everything you have published (blog posts, newsletters, videos, social posts) so you and your DA can search it and cite it. It needs the Corpus skill and its Worker, which are not part of the public release; with them installed, the endpoint goes in the skill's Config.md and credentials stay in your private .env."
          hideInterview
          daPromptExample="help me set up Corpus for my published writing"
        />
      )}

      {data?.configured && data.error && (
        <Panel className="p-4"><div className="text-warn text-sm">The Corpus Worker didn&apos;t answer: {data.error}</div></Panel>
      )}

      {status && (
        <>
          <div className="grid gap-3 grid-cols-2 sm:grid-cols-4 lg:grid-cols-8">
            <StatTile label="Total" value={fmt(total)} dim="blue" active={source === null} onClick={() => setSource(null)} />
            {sources.map((s) => (
              <StatTile key={s.source} label={label(s.source)} value={fmt(s.documents)} active={source === s.source} onClick={() => setSource(source === s.source ? null : s.source)} sub={s.undated ? `${fmt(s.undated)} undated` : undefined} />
            ))}
          </div>

          <Panel className="p-4 flex flex-col gap-3">
            <PanelHeader title="Search" icon={Search} meta={source ? <Pill dim="blue">{label(source)} only</Pill> : <Pill dim="neutral">all sources</Pill>} />
            <form onSubmit={runSearch} className="flex gap-2">
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="What have I said about…"
                maxLength={500}
                className="flex-1 min-w-0 rounded-lg bg-surface-2 border border-line-2 px-3 py-2 text-sm text-ink-1 placeholder:text-ink-3 focus:outline-none focus:border-blue-400"
              />
              <button type="submit" disabled={searching || !query.trim()} className="rounded-lg px-4 py-2 text-sm font-medium bg-blue-500/20 text-blue-100 border border-blue-400/40 disabled:opacity-40">
                {searching ? "Searching…" : "Search"}
              </button>
            </form>
            {search?.error && <div className="text-warn text-sm">Search failed: {search.error}</div>}
            {search && !search.error && search.results.length === 0 && <EmptyState icon={Search} title="No matches" hint="A failed or partial retrieval is never evidence of absence; try other words." />}
            {search && search.results.length > 0 && (
              <ul className="flex flex-col gap-2">
                {search.partial && <li className="text-warn text-xs">Partial retrieval ({search.retrieval_status}); more may exist.</li>}
                {search.results.map((h, i) => (
                  <Panel as="li" key={`${h.url}-${i}`} hover className="p-3">
                    <div className="flex items-start justify-between gap-3">
                      <a href={h.url} target="_blank" rel="noreferrer" className="text-ink-1 font-medium hover:text-blue-200 flex items-center gap-1.5 min-w-0">
                        <span className="truncate">{h.title}</span>
                        <ExternalLink className="w-3.5 h-3.5 shrink-0 text-ink-3" />
                      </a>
                      <div className="flex items-center gap-1.5 shrink-0">
                        {h.source && <Pill dim="neutral">{label(h.source)}</Pill>}
                        <span className="text-xs text-ink-3 tabular-nums whitespace-nowrap">{h.date ? h.date.slice(0, 10) : "undated"}</span>
                      </div>
                    </div>
                    <p className="text-sm text-ink-2 mt-1.5 line-clamp-3">{h.excerpt}</p>
                    {h.attribution !== "principal" && <div className="text-xs text-ink-3 mt-1">attribution: {h.attribution}</div>}
                  </Panel>
                ))}
              </ul>
            )}
          </Panel>

          <div className="grid gap-4 lg:grid-cols-3">
            <Panel className="p-4 lg:col-span-2">
              <PanelHeader title="Sources" meta={<span className="text-xs text-ink-3">{host}</span>} />
              <div className="overflow-x-auto mt-2">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-ink-3 text-xs">
                      <th className="py-1.5 pr-3 font-medium">Source</th>
                      <th className="py-1.5 pr-3 font-medium text-right">Documents</th>
                      <th className="py-1.5 pr-3 font-medium">Last scan</th>
                      <th className="py-1.5 pr-3 font-medium">Updated</th>
                      <th className="py-1.5 font-medium">Scope</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sources.map((s) => {
                      const scan = scans.get(s.source);
                      return (
                        <tr key={s.source} className="border-t border-line-1 align-top">
                          <td className="py-2 pr-3 text-ink-1">{label(s.source)}</td>
                          <td className="py-2 pr-3 text-right tabular-nums text-ink-1">{fmt(s.documents)}</td>
                          <td className="py-2 pr-3">{scan ? <Pill dim={tone(scan.status)}>{scan.status}</Pill> : <span className="text-ink-3">—</span>}</td>
                          <td className="py-2 pr-3 text-ink-2 whitespace-nowrap" title={stamp(scan?.updatedAt)}>{age(scan?.updatedAt)}</td>
                          <td className="py-2 text-ink-3 text-xs">{scan?.error ? <span className="text-warn">{scan.error}</span> : scan?.scope ?? ""}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Panel>

            <Panel className="p-4 flex flex-col gap-3">
              <PanelHeader title="Index health" icon={Activity} />
              <div>
                <div className="text-xs text-ink-3">Embedded and verified</div>
                <div className="tabular-nums text-ink-1 text-lg font-semibold">{fmt(projected)} <span className="text-ink-3 text-sm font-normal">of {fmt(projectionTotal)}</span></div>
                <div className="h-1.5 rounded-full bg-surface-3 mt-1.5 overflow-hidden">
                  <div className="h-full rounded-full" style={{ width: `${projectionTotal ? (projected / projectionTotal) * 100 : 0}%`, background: "var(--ok)" }} />
                </div>
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {status.projection.filter((p) => p.status !== "complete").map((p) => (
                    <Pill key={p.status} dim={tone(p.status)}>{p.status} {fmt(p.count)}</Pill>
                  ))}
                </div>
              </div>
              <div className="flex flex-col gap-1.5">
                <div className="text-xs text-ink-3">Recent runs</div>
                {status.runs.slice(0, 6).map((r, i) => (
                  <div key={r.id ?? i} className="flex items-center justify-between gap-2 text-sm">
                    <span className="text-ink-2 truncate" title={r.error ?? r.trigger}>{r.trigger.startsWith("cron:") ? "daily sync" : r.trigger === "authenticated-trigger" ? "manual sync" : r.trigger}</span>
                    <span className="flex items-center gap-2 shrink-0">
                      <Pill dim={tone(r.status)}>{r.status}</Pill>
                      <span className="text-xs text-ink-3 w-16 text-right">{age(r.startedAt)}</span>
                    </span>
                  </div>
                ))}
                {!status.runs.length && <div className="text-ink-3 text-sm">No runs recorded.</div>}
              </div>
              {lastRun && <div className="text-xs text-ink-3">Fetched {age(fetchedAt)} · last run {stamp(lastRun.startedAt)}</div>}
            </Panel>
          </div>
        </>
      )}
    </PageShell>
  );
}
