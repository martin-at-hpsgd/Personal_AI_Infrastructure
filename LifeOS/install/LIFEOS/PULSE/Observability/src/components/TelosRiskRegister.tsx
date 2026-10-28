"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useApi } from "@/lib/api";
import { FileWarning } from "lucide-react";
import { Panel, PanelHeader, Pill } from "@/components/ui/chrome";
import { parseLifeRiskData, riskHref, riskQuery, selectRisks, type LifeRiskData } from "@/lib/telos-risks";

export function useLifeRisks(enabled = true) {
  const query = useApi<unknown>("/api/telos/risks", { enabled, refetchInterval: 60_000 });
  const parsed = useMemo(() => (query.data === undefined ? null : parseLifeRiskData(query.data)), [query.data]);
  // A failed read or a body that does not parse blanks the register, as before.
  const error = query.isError || (query.data !== undefined && !parsed);
  const data: LifeRiskData | null = error ? null : parsed;
  return { data, error };
}

type RegisterProps = { securityOnly?: boolean; includeRiskIds?: string[]; sourceState?: ReturnType<typeof useLifeRisks>; readyToScroll?: boolean };

/** With a shared sourceState the register reads nothing itself; otherwise it reads through the query layer. */
export default function TelosRiskRegister(props: RegisterProps) {
  return props.sourceState ? <RiskRegisterView {...props} state={props.sourceState} /> : <FetchedRiskRegister {...props} />;
}

function FetchedRiskRegister(props: RegisterProps) {
  const fetched = useLifeRisks();
  return <RiskRegisterView {...props} state={fetched} />;
}

function RiskRegisterView({ securityOnly = false, includeRiskIds, state, readyToScroll = true }: RegisterProps & { state: ReturnType<typeof useLifeRisks> }) {
  const { data, error } = state;
  const [domain, setDomain] = useState("all");
  const [selected, setSelected] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const scrolledTo = useRef<string | null>(null);
  useEffect(() => {
    if (!securityOnly) setSelected(riskQuery(window.location.search));
  }, [securityOnly]);
  useEffect(() => {
    const target = selected || (new URLSearchParams(window.location.search).get("section") === "risks" ? "all" : null);
    if (data && readyToScroll && target && scrolledTo.current !== target) {
      document.getElementById("sec-risks")?.scrollIntoView({ block: "start" });
      scrolledTo.current = target;
    }
  }, [selected, data, securityOnly, readyToScroll]);
  const source = data?.risks ?? [];
  const risks = selectRisks(includeRiskIds ? source.filter(r => includeRiskIds.includes(r.id)) : source, includeRiskIds ? "all" : securityOnly ? "security" : domain, selected);
  return (
    <section id="sec-risks" data-sensitive style={{ scrollMarginTop: 120, marginTop: 24, marginBottom: 24 }}>
      <Panel>
        <PanelHeader icon={FileWarning} title={includeRiskIds ? "Life risks · security & linked estate" : securityOnly ? "Life risks · security" : "Life risk register"}
          meta={<a href="/telos?section=risks" className="text-xs underline inline-flex items-center min-h-11">TELOS</a>} />
        <div style={{ padding: "12px 16px" }}>
          <p className="text-xs text-ink-2 mb-3">What could knock your life off course, and the current state of prevention, detection, and response.</p>
          {!securityOnly && <div className="flex flex-wrap items-center gap-3 mb-4">
            <label className="text-xs">Domain <select aria-label="Risk domain" value={domain} onChange={e => { setDomain(e.target.value); setSelected(null); }} className="ml-2 bg-surface-1 border border-line-1 rounded p-2">
              <option value="all">All domains</option>
              {[...new Set(source.map(r => r.domain))].sort().map(d => <option key={d} value={d}>{d}</option>)}
            </select></label>
            {selected && <button className="text-xs underline min-h-11" onClick={() => { setSelected(null); window.history.replaceState(null, "", "/telos?section=risks"); }}>Show all risks</button>}
            <span className="text-xs text-ink-3">Highest score first · {risks.length} {risks.length === 1 ? "risk" : "risks"}</span>
          </div>}
          {error ? <p role="alert">Life risk register unavailable. Try reloading the page.</p> : !data ? <p role="status">Loading life risks…</p> : <>
            {data.errors.length > 0 && <div role="alert" className="text-xs text-warn mb-3">Register needs attention: {data.errors.join("; ")}</div>}
            {risks.length === 0 && <p className="text-xs text-ink-2">{selected ? `Risk ${selected} is not in this register.` : "No risks recorded in this view."}</p>}
            {risks.length > 0 && <>
            <p className="text-xs text-ink-3 mb-2 lg:hidden">Scroll horizontally to compare all columns.</p>
            <div className="overflow-x-auto rounded-lg border border-line-1" role="region" aria-label="Life risk table" tabIndex={0}>
            <table className="w-full text-xs text-left" style={{ minWidth: 960, borderCollapse: "collapse" }}>
              <thead className="bg-surface-1 text-ink-3"><tr>
                {["Risk", "Domain", "Score", "Open findings", "Prevent", "Detect", "Respond", "Owner", "Review"].map(label => <th key={label} scope="col" className="px-3 py-3 font-semibold whitespace-nowrap">{label}</th>)}
              </tr></thead>
              {risks.map(r => {
                const open = expanded[r.id] ?? selected === r.id;
                return <tbody key={r.id} data-risk-id={r.id} className="border-t border-line-1">
                <tr className="hover:bg-surface-1">
                  <th scope="row" className="px-3 py-3 align-top font-normal" style={{ minWidth: 280, width: "34%" }}>
                    <a href={riskHref(r.id) ?? "/telos"} className="mono text-ink-3 underline">{r.id}</a>
                    <button type="button" aria-expanded={open} aria-controls={`risk-details-${r.id}`} onClick={() => setExpanded(previous => ({ ...previous, [r.id]: !open }))} className="flex items-start gap-2 w-full text-left text-sm font-semibold min-h-11 py-2">
                      <span aria-hidden="true" className="text-ink-3">{open ? "▾" : "▸"}</span><span>{r.title}</span>
                    </button>
                  </th>
                  <td className="px-3 py-4 align-top text-ink-2">{r.domain}</td>
                  <td className="px-3 py-4 align-top whitespace-nowrap"><Pill dim={r.score >= 15 ? "err" : r.score >= 10 ? "warn" : "neutral"}>{r.level} · {r.score}/25</Pill><div className="mt-2 text-ink-3">L {r.likelihood}/5 × I {r.impact}/5</div></td>
                  <td className="px-3 py-4 align-top whitespace-nowrap" data-testid="open-findings">{r.open_findings === null ? <span className="text-ink-3">—</span> : r.open_findings > 0 ? <a href="/achilles#audit-report" className="underline"><Pill dim="warn">{r.open_findings} open</Pill></a> : <Pill dim="ok">0 open</Pill>}</td>
                  {(["prevent", "detect", "respond"] as const).map(key => {
                    const state = r[key]?.state ?? "unknown";
                    return <td key={key} className="px-3 py-4 align-top"><Pill dim={state === "have" ? "ok" : state === "none" ? "err" : state === "partial" ? "warn" : "neutral"}>{state}</Pill></td>;
                  })}
                  <td className="px-3 py-4 align-top text-ink-2">{r.owner || "unknown"}</td>
                  <td className="px-3 py-4 align-top text-ink-2 whitespace-nowrap">{r.review_by || "unknown"}</td>
                </tr>
                <tr id={`risk-details-${r.id}`} hidden={!open} className="bg-surface-1"><td colSpan={9} className="px-5 py-4">
                <p className="text-sm text-ink-2 mb-4" style={{ maxWidth: "90ch" }}>{r.scenario || "Scenario unknown"}</p>
                <dl className="grid grid-cols-3 gap-6">{(["prevent", "detect", "respond"] as const).map(key => {
                  const coverage = r[key]; const state = coverage?.state ?? "unknown";
                  return <div key={key}><dt className="text-xs flex items-center gap-2 capitalize">{key}<Pill dim={state === "have" ? "ok" : state === "none" ? "err" : state === "partial" ? "warn" : "neutral"}>{state}</Pill></dt>
                    <dd className="text-xs text-ink-2 mt-1">{coverage?.text || "No current description recorded."}</dd></div>;
                })}</dl>
                {r.links.length > 0 && <div className="flex flex-wrap gap-2 mt-4 text-xs">{r.links.map((l, i) => {
                  const href = riskHref(l.ref);
                  return href ? <a key={i} className="underline text-dim-freedom" href={href}>{l.raw}</a> : <span key={i} className="text-ink-3">{l.raw}</span>;
                })}</div>}
                </td></tr>
              </tbody>; })}
            </table>
            </div>
            </>}
          </>}
        </div>
      </Panel>
    </section>
  );
}
