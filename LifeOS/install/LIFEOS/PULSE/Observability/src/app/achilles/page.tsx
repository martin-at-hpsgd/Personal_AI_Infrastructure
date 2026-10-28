"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ApiError, apiQuery, useApi } from "@/lib/api";
import { ShieldAlert, ShieldCheck, Shield, Info, FileWarning, ScrollText } from "lucide-react";
import { PageShell, PageHeader, Panel, PanelHeader, StatTile, Pill } from "@/components/ui/chrome";
import TelosRiskRegister, { useLifeRisks } from "@/components/TelosRiskRegister";
import Md from "@/components/Md";
import { fmtDateParts, fmtDateTime } from "@/lib/time";
import { achillesLifeRiskIds, findingLifeRisks, riskHref, riskQuery } from "@/lib/telos-risks";

// Achilles — the vulnerability management registry, worn by Pulse.
// Read-only surface: mutations go through `bun LIFEOS/TOOLS/Achilles.ts`
// so every write passes registry invariants. Doctrine: LIFEOS/ACHILLES/ISA.md. (maintainer-side; not in the public release)

interface Entry {
  id: string; title: string; category: string; severity: string; source: string;
  status: string; cves: string[]; affected: string[]; first_seen: string;
  closed_at?: string; work_issue?: number; ul_issue?: number; risk_ref?: string; evidence: string[]; links: string[];
  affected_match?: boolean;
  /** "finder" when the finder named the risk, "map" when the risk map placed it (security-audit ISA ISC-39). */
  risk_basis?: "finder" | "map";
}
interface Data {
  generated_at: string;
  stats: { total: number; open: number; open_critical: number; open_high: number; informational: number; remediated: number; by_category: Record<string, number> };
  open_critical: Entry[];
  entries: Entry[];
  last_audit: string | null; exposure_line: string | null;
  coverage: { pct: number; ran: number; total: number } | null;
  open_by_life_risk: Record<string, number>;
}

const when = (iso: string) => `${fmtDateParts(iso, { weekday: "short" })} ${fmtDateTime(iso)}`;

// The newest security audit on the page face: when it ran, how much of the
// estate its finders reached, and open findings per life risk. The full report
// opens in place (security-audit ISA ISC-64, ISC-105).
function AuditPanel({ data, lifeTitles }: { data: Data; lifeTitles: Record<string, string> }) {
  const [report, setReport] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();
  const show = useCallback(async () => {
    setOpen(true);
    if (report !== null) return;
    try {
      const j = await queryClient.fetchQuery(apiQuery<{ markdown: string }>("/api/achilles/report"));
      setReport(j.markdown.replace(/^---[\s\S]*?---\n/, ""));
    } catch (e) { setReport(e instanceof ApiError ? "No audit report yet." : "Report unavailable."); }
  }, [report, queryClient]);
  useEffect(() => { if (window.location.hash === "#audit-report") { show(); document.getElementById("audit-report")?.scrollIntoView({ block: "start" }); } }, [show]);
  const risks = Object.entries(data.open_by_life_risk).sort((a, b) => b[1] - a[1]);
  const cov = data.coverage;
  return (
    <div id="audit-report" style={{ scrollMarginTop: 120 }}>
    <Panel style={{ marginBottom: 16 }}>
      <PanelHeader icon={ScrollText} title="Last security audit" meta={data.last_audit ? when(data.last_audit) : "never run"} />
      {!data.last_audit ? (
        <div style={{ padding: "12px 16px", fontSize: 13, opacity: 0.6 }}>No audit has run yet: <code>bun LIFEOS/TOOLS/SecurityAudit.ts run</code></div>
      ) : (
        <div style={{ padding: "12px 16px", display: "flex", flexDirection: "column", gap: 10 }}>
          {data.exposure_line && <div data-testid="audit-exposure" style={{ fontSize: 14, fontWeight: 600 }}>{data.exposure_line}</div>}
          <div className="flex flex-wrap items-center gap-3 text-xs text-ink-2">
            <span>Ran {when(data.last_audit)}</span>
            {cov && <Pill dim={cov.pct >= 80 ? "ok" : cov.pct >= 50 ? "warn" : "err"}>coverage {cov.pct}% · {cov.ran} of {cov.total} finders</Pill>}
          </div>
          <div className="flex flex-wrap gap-2 text-xs" data-sensitive>
            {risks.length === 0 ? <span className="text-ink-3">No open technical findings linked to a life risk.</span> : risks.map(([id, n]) => (
              <a key={id} href={riskHref(id) ?? "#"} className="rounded-md border border-[color:var(--line-1)] px-2 py-1 hover:bg-[color:var(--surface-3)]" title={lifeTitles[id] ?? id}>
                <span className="mono">{id}</span> {lifeTitles[id] ? <span className="text-ink-3">{lifeTitles[id]}</span> : null} · <strong>{n}</strong> open
              </a>
            ))}
          </div>
          <div>
            <button className="text-xs underline" onClick={() => (open ? setOpen(false) : show())}>{open ? "Hide report" : "Read the full report"}</button>
          </div>
          {open && <div data-sensitive className="text-sm">{report === null ? <span className="text-ink-3">Loading report…</span> : <Md content={report} />}</div>}
        </div>
      )}
    </Panel>
    </div>
  );
}

type Dim = "health" | "money" | "freedom" | "creative" | "relationships" | "rhythms" | "blue" | "ok" | "warn" | "err" | "neutral";
const SEV_DIM: Record<string, Dim> = { critical: "err", high: "warn", medium: "warn", low: "neutral" };
const STATUS_DIM: Record<string, Dim> = {
  open: "err", in_progress: "warn", remediated: "ok",
  accepted: "neutral", false_positive: "neutral", informational: "blue",
};

// ── Risk register (ThreatModel), moved onto Achilles 2026-08-28. Standing risks
// live here beside the concrete instances they link to via risk_ref; /security
// keeps the outsider scanner. Data stays private (ThreatModel skill). ──
interface RiskSummary {
  id: string; title: string; threat: string;
  telos_ref?: string; scope?: string;
  level: "Critical" | "High" | "Medium" | "Low";
  score: number; likelihood: number; impact: number;
  status: string; assets: string[]; data_classes: string[];
  owner: string; response: string; review_by: string; overdue: boolean;
}
interface ThreatModelData {
  available: boolean;
  grade?: "red" | "orange" | "green";
  total?: number; open?: number; overdue_review?: number;
  byLevel?: Record<string, number>;
  byStatus?: Record<string, number>;
  risks?: RiskSummary[];
  updated?: string | null;
}
type PrivateData<T> = T | "unavailable" | null;
const LEVEL_DIM: Record<string, Dim> = { Critical: "err", High: "warn", Medium: "freedom", Low: "rhythms" };
const GRADE_DIM: Record<string, Dim> = { red: "err", orange: "warn", green: "ok" };

function RiskRegisterSection({ tm, selected }: { tm: PrivateData<ThreatModelData>; selected: string | null }) {
  const [rf, setRf] = useState<string | null>(null);
  if (tm === "unavailable" || (tm && !tm.available)) return <Panel><p className="p-4 text-xs">Standing risk register unavailable.</p></Panel>;
  if (!tm) {
    return (
      <Panel style={{ marginBottom: 16 }}>
        <PanelHeader icon={FileWarning} title="Risk register" />
        <div style={{ padding: "12px 16px", fontSize: 13, opacity: 0.6 }}>Loading risk register…</div>
      </Panel>
    );
  }
  const bl = tm.byLevel ?? {};
  const gradeDim = GRADE_DIM[tm.grade ?? "green"] ?? "neutral";
  const gradeLabel = ({ red: "Red", orange: "Orange", green: "Green" } as Record<string, string>)[tm.grade ?? "green"];
  const openRisks = (tm.risks ?? []).filter((r) => r.status !== "closed");
  const risks = selected?.startsWith("R-") ? (tm.risks ?? []).filter(r => r.id === selected) : rf === "overdue" ? openRisks.filter((r) => r.overdue) : rf ? openRisks.filter((r) => r.level === rf) : openRisks;
  const TILES: { key: string | null; label: string; value: string | number; dim: Dim; fixed?: boolean }[] = [
    { key: null, label: "Grade", value: gradeLabel ?? "—", dim: gradeDim, fixed: true },
    { key: "Critical", label: "Critical", value: bl.Critical ?? 0, dim: bl.Critical ? "err" : "ok" },
    { key: "High", label: "High", value: bl.High ?? 0, dim: bl.High ? "warn" : "ok" },
    { key: "Medium", label: "Medium", value: bl.Medium ?? 0, dim: "freedom" },
    { key: "Low", label: "Low", value: bl.Low ?? 0, dim: "rhythms" },
    { key: "overdue", label: "Overdue", value: tm.overdue_review ?? 0, dim: tm.overdue_review ? "warn" : "ok" },
  ];
  return (
    <div id="standing-risks" data-sensitive style={{ scrollMarginTop: 120 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 12, marginBottom: 12 }}>
        {TILES.map((t) => (
          <StatTile
            key={t.label}
            label={t.label}
            value={String(t.value)}
            dim={t.dim}
            active={t.fixed ? undefined : rf === t.key}
            onClick={t.fixed ? undefined : () => setRf(rf === t.key ? null : t.key)}
          />
        ))}
      </div>
      <Panel style={{ marginBottom: 16 }}>
        <PanelHeader icon={FileWarning} title={`Risk register — standing risks (${tm.open ?? 0})`} />
        {risks.length === 0 ? (
          <div style={{ padding: "12px 16px", fontSize: 13, opacity: 0.6 }}>{selected?.startsWith("R-") ? `Standing risk ${selected} is not in the current register.` : "No open risks in this view."}</div>
        ) : (
          risks.map((r) => (
            <div key={r.id} style={{ borderTop: "1px solid rgba(255,255,255,0.06)", padding: "10px 16px" }}>
              <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10, fontSize: 13 }}>
                <Pill dim={LEVEL_DIM[r.level] ?? "neutral"}>{r.level} · {r.score}</Pill>
                <span style={{ fontFamily: "monospace", fontSize: 11, opacity: 0.6, flex: "none" }}>{r.id}</span>
                <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.title}</span>
                {r.overdue && <Pill dim="warn">overdue</Pill>}
                <span style={{ fontSize: 11, opacity: 0.5, flex: "none" }}>{r.owner || "—"}</span>
              </div>
              <div style={{ fontSize: 12, opacity: 0.65, marginTop: 4 }}>{r.threat}</div>
              <div className="flex flex-wrap gap-3 mt-2 text-xs text-ink-2">
                <span>Scope: {r.scope ?? "personal"}</span><span>Review: {r.review_by || "unknown"}</span>
                {r.telos_ref && riskHref(r.telos_ref) ? <a className="underline" href={riskHref(r.telos_ref)!}>Life risk {r.telos_ref}</a> : <span>No life risk linked</span>}
              </div>
            </div>
          ))
        )}
      </Panel>
    </div>
  );
}

export default function AchillesPage() {
  const lifeRisks = useLifeRisks();
  const [selectedRisk, setSelectedRisk] = useState<string | null>(null);
  const scrolledTo = useRef<string | null>(null);
  const { data: dataQ } = useApi<Data>("/api/achilles", { refetchInterval: 60_000 });
  const data = dataQ ?? null; // a failed refetch keeps the last good data
  const [expanded, setExpanded] = useState<string | null>(null);
  const [filter, setFilter] = useState<string | null>(null);
  const tmQ = useApi<ThreatModelData>("/api/threatmodel", { refetchInterval: 60_000 });
  const threatModel: PrivateData<ThreatModelData> = tmQ.data ?? (tmQ.isError ? "unavailable" : null);
  useEffect(() => {
    const selected = riskQuery(window.location.search);
    setSelectedRisk(selected);
    if (selected?.startsWith("ACH-")) setExpanded(selected);
  }, []);
  useEffect(() => {
    if (!selectedRisk || scrolledTo.current === selectedRisk) return;
    if (selectedRisk?.startsWith("R-") && threatModel && threatModel !== "unavailable") document.getElementById("standing-risks")?.scrollIntoView({ block: "start" });
    if (selectedRisk?.startsWith("ACH-") && data) document.getElementById("achilles-findings")?.scrollIntoView({ block: "start" });
    if ((selectedRisk.startsWith("R-") && threatModel && threatModel !== "unavailable") || (selectedRisk.startsWith("ACH-") && data)) scrolledTo.current = selectedRisk;
  }, [selectedRisk, threatModel, data]);

  const s = data?.stats;
  const isOpen = (e: Entry) => e.status === "open" || e.status === "in_progress";
  const FILTERS: Record<string, (e: Entry) => boolean> = {
    open_critical: (e) => isOpen(e) && e.severity === "critical",
    open_high: (e) => isOpen(e) && e.severity === "high",
    open: isOpen,
    remediated: (e) => e.status === "remediated",
    informational: (e) => e.status === "informational",
    total: () => true,
  };
  const TILES = [
    { key: "open_critical", label: "Open critical", value: s?.open_critical },
    { key: "open_high", label: "Open high", value: s?.open_high },
    { key: "open", label: "Open total", value: s?.open },
    { key: "remediated", label: "Remediated", value: s?.remediated },
    { key: "informational", label: "Informational", value: s?.informational },
    { key: "total", label: "All entries", value: s?.total },
  ];
  const allEntries = data?.entries ?? [];
  const entries = selectedRisk ? allEntries.filter(e => e.id === selectedRisk || e.risk_ref === selectedRisk) : allEntries;
  const openEntries = entries.filter(isOpen);
  const restEntries = entries.filter((e) => !isOpen(e));
  const sections = filter
    ? [{ title: `${TILES.find((t) => t.key === filter)?.label ?? "Filtered"} (${entries.filter(FILTERS[filter]).length})`, icon: Shield, list: entries.filter(FILTERS[filter]), empty: "No entries in this view." }]
    : [{ title: "Open", icon: ShieldAlert, list: openEntries, empty: "Nothing open — no known unaddressed weaknesses." },
       { title: "History & intel", icon: Shield, list: restEntries, empty: "No closed or informational entries yet." }];

  return (
    <PageShell>
      <PageHeader
        icon={s && s.open_critical + s.open_high > 0 ? ShieldAlert : ShieldCheck}
        title="Achilles"
        subtitle="Vulnerability management — every known weakness, every finder, one lifecycle"
      />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 12, marginBottom: 16 }}>
        {TILES.map((t) => (
          <StatTile
            key={t.key}
            label={t.label}
            value={String(t.value ?? "—")}
            active={filter === t.key}
            onClick={() => setFilter(filter === t.key ? null : t.key)}
          />
        ))}
      </div>

      {data && <AuditPanel data={data} lifeTitles={Object.fromEntries((lifeRisks.data?.risks ?? []).map((r: { id: string; title: string }) => [r.id, r.title]))} />}
      {selectedRisk && <div className="flex flex-wrap gap-3 text-xs mb-4" data-sensitive><span>Linked view: {selectedRisk}</span><button className="underline" onClick={() => { setSelectedRisk(null); setFilter(null); window.history.replaceState(null, "", "/achilles"); }}>Show all findings and standing risks</button></div>}
      <div id="achilles-findings" data-sensitive style={{ scrollMarginTop: 120 }}>
      {sections.map((sec) => (
        <Panel key={sec.title} style={{ marginBottom: 16 }}>
          <PanelHeader icon={sec.icon} title={sec.title} />
          {sec.list.length === 0 && <div style={{ padding: "12px 16px", fontSize: 13, opacity: 0.6 }}>{selectedRisk ? "No findings explicitly linked in this view." : sec.empty}</div>}
          {sec.list.map((e) => (
            <div key={e.id} style={{ borderTop: "1px solid rgba(255,255,255,0.06)", padding: "10px 16px", cursor: "pointer" }} onClick={() => setExpanded(expanded === e.id ? null : e.id)}>
              <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10, fontSize: 13 }}>
                <span style={{ fontFamily: "monospace", opacity: 0.7, flex: "none" }}>{e.id}</span>
                <Pill dim={SEV_DIM[e.severity] ?? "neutral"}>{e.severity}</Pill>
                <Pill dim={STATUS_DIM[e.status] ?? "neutral"}>{e.status.replace("_", " ")}</Pill>
                <Pill dim="neutral">{e.category}</Pill>
                <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.title}</span>
                {(e.work_issue ?? e.ul_issue) ? <span style={{ fontFamily: "monospace", fontSize: 11, opacity: 0.7, flex: "none" }}>#{e.work_issue ?? e.ul_issue}</span> : null}
                <span style={{ fontSize: 11, opacity: 0.5, flex: "none" }}>{(e.closed_at ?? e.first_seen)?.slice(0, 10)}</span>
              </div>
              <div className="flex flex-wrap gap-2 mt-2 text-xs" onClick={event => event.stopPropagation()}>
                {e.risk_ref && riskHref(e.risk_ref) && <a href={riskHref(e.risk_ref)!} className="underline">{e.risk_ref}</a>}
                {e.risk_ref && e.risk_basis === "map" && <span data-testid="risk-mapped" className="rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wider" style={{ border: "1px dashed var(--line-2)", opacity: 0.8 }} title="The risk map placed this finding; the finder did not name the risk">mapped</span>}
                {findingLifeRisks(e, lifeRisks.data?.risks ?? [], threatModel && threatModel !== "unavailable" ? threatModel.risks ?? [] : []).map(r => <a key={r.id} href={riskHref(r.id)!} className="underline">→ {r.id} · {r.title}</a>)}
                {lifeRisks.error && <span>Life risk links unavailable</span>}
              </div>
              {expanded === e.id && (
                <div style={{ marginTop: 8, fontSize: 12, opacity: 0.85, display: "flex", flexDirection: "column", gap: 4 }}>
                  <div>source: {e.source}{e.affected_match === false ? " (no stack match — informational)" : ""}{e.risk_ref ? ` · risk: ${e.risk_ref}${e.risk_basis === "map" ? " (placed by the risk map)" : e.risk_basis === "finder" ? " (named by the finder)" : ""}` : ""}</div>
                  {e.cves.length > 0 && <div>CVEs: {e.cves.join(", ")}</div>}
                  {e.affected.length > 0 && <div>affected: {e.affected.join("; ")}</div>}
                  {e.evidence.length > 0 && (
                    <div style={{ display: "flex", gap: 6, alignItems: "flex-start" }}>
                      <Info size={12} style={{ marginTop: 2, flex: "none" }} />
                      <div>{e.evidence.map((ev, i) => <div key={i}>{ev}</div>)}</div>
                    </div>
                  )}
                  {e.links.map((l, i) => (
                    <a key={i} href={l} target="_blank" rel="noreferrer" style={{ color: "#7dd3fc", textDecoration: "underline" }}>{l}</a>
                  ))}
                </div>
              )}
            </div>
          ))}
        </Panel>
      ))}
      </div>
      <RiskRegisterSection tm={threatModel} selected={selectedRisk} />
      <TelosRiskRegister securityOnly sourceState={lifeRisks} readyToScroll={!!data && threatModel !== null} includeRiskIds={achillesLifeRiskIds(lifeRisks.data?.risks ?? [], threatModel && threatModel !== "unavailable" ? threatModel.risks ?? [] : [])} />

      <div style={{ fontSize: 11, opacity: 0.5 }}>
        Registry: LIFEOS/USER/SECURITY/ACHILLES/registry.json · mutations via <code>bun LIFEOS/TOOLS/Achilles.ts</code> · concrete instances above, standing risks (ThreatModel) linked by risk_ref
      </div>
    </PageShell>
  );
}
