"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useApi } from "@/lib/api";
import { MessageCircleQuestionMark, ChevronRight, ChevronDown } from "lucide-react";
import { PageShell, PageHeader, Panel, Pill, dimStyle } from "@/components/ui/chrome";
import { useLifeRisks } from "@/components/TelosRiskRegister";
import { riskHref } from "@/lib/telos-risks";
import { fmtClock, fmtDateTime } from "@/lib/time";

// Socrates — the standing-question ledger, worn by Pulse.
// Read-only over the redacted snapshot; mutations via `bun LIFEOS/SOCRATES/Socrates.ts`.
//
// 2026-09-06 redesign (principal directive):
// the question list IS the page. One line says when the last check ran and,
// when it is late, why. Domains are a filter strip, findings ride their own
// question's row as a routed chip, and the thirty unanswerable questions fold
// to one line. Three-valued by doctrine: unknown renders as loudly as fail.

interface Q {
  id: string; domain: string; text: string; ideal: string; status: string; severity: string;
  cadence: string; verifier: string; answerer: string | null; experiential: boolean;
  node_type: string | null; provenance: string; telos_ref: string | null;
  accounted_for: number | null; ruled_out: string[];
}
interface A { question_id: string; instance_key: string; ts: string; verdict: string; value: string | null; evidence: string | null; computed_from: string; closer_version: string }
interface F { question_id: string; instance_key: string; first_seen: string; last_seen: string; seen_count: number; last_verdict: string; last_value: string | null; routed?: { achilles_id: string; work_issue?: number | null; ul_issue?: number | null; routed_at: string } }
interface Data {
  generated_at: string; stale: boolean; age_minutes: number; stale_reason: string | null;
  domains: Array<{ domain: string; pass: number; fail: number; unknown: number; unanswerable: number }>;
  questions: Q[]; answers: A[]; findings: F[];
}

type Dim = "ok" | "warn" | "err" | "blue" | "neutral";
type Verdict = "fail" | "unknown" | "pass";
const VERDICT_DIM: Record<Verdict, Dim> = { fail: "err", unknown: "warn", pass: "ok" };
const VERDICT_ORDER: Record<Verdict, number> = { fail: 0, unknown: 1, pass: 2 };
const SEVERITY_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const CADENCE_MS: Record<string, number> = { hourly: 3600_000, daily: 86400_000, weekly: 7 * 86400_000, monthly: 30 * 86400_000 };

function ago(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const m = Math.round(ms / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = ms / 3600_000;
  if (h < 48) return `${h < 10 ? h.toFixed(1).replace(/\.0$/, "") : Math.round(h)}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
function clock(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : fmtClock(d);
}

interface Row { q: Q; verdict: Verdict; instances: number; unknowns: number; lastTs: string | null; late: boolean; findings: F[] }

function buildRows(data: Data, now: number): Row[] {
  const byQ = new Map<string, A[]>();
  for (const a of data.answers) byQ.set(a.question_id, [...(byQ.get(a.question_id) ?? []), a]);
  const byF = new Map<string, F[]>();
  for (const f of data.findings) byF.set(f.question_id, [...(byF.get(f.question_id) ?? []), f]);
  return data.questions
    .filter((q) => q.status === "active")
    .map((q) => {
      const rows = byQ.get(q.id) ?? [];
      const unknowns = rows.filter((r) => r.verdict === "unknown").length;
      const verdict: Verdict = rows.length === 0 ? "unknown" : rows.some((r) => r.verdict === "fail") ? "fail" : unknowns > 0 ? "unknown" : "pass";
      const lastTs = rows.reduce<string | null>((m, r) => (m === null || r.ts > m ? r.ts : m), null);
      const cadenceMs = CADENCE_MS[q.cadence] ?? 86400_000;
      const late = lastTs === null || now - Date.parse(lastTs) > 2 * cadenceMs;
      return { q, verdict, instances: rows.length, unknowns, lastTs, late, findings: byF.get(q.id) ?? [] };
    })
    .sort((a, b) =>
      VERDICT_ORDER[a.verdict] - VERDICT_ORDER[b.verdict]
      || (SEVERITY_ORDER[a.q.severity] ?? 9) - (SEVERITY_ORDER[b.q.severity] ?? 9)
      || a.q.id.localeCompare(b.q.id));
}

const rowStyle = { borderTop: "1px solid rgba(255,255,255,0.06)", padding: "10px 16px" } as const;
const mono = { fontFamily: "monospace", fontSize: 12, opacity: 0.65, flex: "none" } as const;
const muted = { fontSize: 11, opacity: 0.55, flex: "none", whiteSpace: "nowrap" } as const;

function FilterChip({ label, count, dim, active, onClick }: { label: string; count: number; dim: Dim; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      data-filter={label}
      onClick={onClick}
      className="flex items-center gap-1.5 px-3 py-1 rounded-full text-[12px] font-medium cursor-pointer transition-all duration-150 whitespace-nowrap"
      style={{ ...dimStyle(dim, active), ...(active ? { color: "var(--ink-1)", boxShadow: "inset 0 1px 0 var(--glass-edge)" } : { opacity: 0.85 }) }}
    >
      {label}
      <span className="mono" style={{ fontSize: 11, opacity: 0.75 }}>{count}</span>
    </button>
  );
}

export default function SocratesPage() {
  const { data: lifeRisks, error: riskError } = useLifeRisks();
  const [selectedQuestion, setSelectedQuestion] = useState<string | null>(null);
  const scrolledTo = useRef<string | null>(null);
  const socrates = useApi<Data>("/api/socrates", { refetchInterval: 60_000 });
  const data = socrates.data ?? null;
  const [expanded, setExpanded] = useState<string | null>(null);
  const [verdictFilter, setVerdictFilter] = useState<Verdict | null>(null);
  const [domainFilter, setDomainFilter] = useState<string | null>(null);
  const [showUnanswerable, setShowUnanswerable] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  // The age clock restarts on every successful read.
  useEffect(() => { if (socrates.dataUpdatedAt) setNow(Date.now()); }, [socrates.dataUpdatedAt]);
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("question");
    if (id && /^SOC-\d{4}$/.test(id)) { setSelectedQuestion(id); setExpanded(id); setShowUnanswerable(true); }
  }, []);
  useEffect(() => {
    if (data && selectedQuestion && scrolledTo.current !== selectedQuestion) {
      document.querySelector(`[data-row="${selectedQuestion}"]`)?.scrollIntoView({ block: "center" });
      scrolledTo.current = selectedQuestion;
    }
  }, [data, selectedQuestion]);

  const rows = useMemo(() => (data ? buildRows(data, now) : []), [data, now]);
  const unanswerable = useMemo(() => (data?.questions ?? []).filter((q) => q.status === "unanswerable"), [data]);
  const counts = useMemo(() => ({
    fail: rows.filter((r) => r.verdict === "fail").length,
    unknown: rows.filter((r) => r.verdict === "unknown").length,
    pass: rows.filter((r) => r.verdict === "pass").length,
    routed: rows.reduce((n, r) => n + r.findings.filter((f) => f.routed).length, 0),
  }), [rows]);
  const domainCounts = useMemo(() => {
    const m = new Map<string, { total: number; fail: number }>();
    for (const r of rows) {
      const d = m.get(r.q.domain) ?? { total: 0, fail: 0 };
      d.total++; if (r.verdict === "fail") d.fail++;
      m.set(r.q.domain, d);
    }
    return [...m.entries()].sort((a, b) => b[1].fail - a[1].fail || a[0].localeCompare(b[0]));
  }, [rows]);
  const shown = rows.filter((r) => selectedQuestion ? r.q.id === selectedQuestion : (!verdictFilter || r.verdict === verdictFilter) && (!domainFilter || r.q.domain === domainFilter));
  const selectedRecord = data?.questions.find(q => q.id === selectedQuestion);
  const riskLinks = (question: Q) => (lifeRisks?.risks ?? []).filter(r => r.id === question.telos_ref || r.links.some(l => l.kind === "socrates" && l.ref === question.id));
  const riskBacklinks = (question: Q) => <div data-sensitive className="flex flex-wrap gap-2 text-xs mt-2">{riskLinks(question).map(r => <a key={r.id} href={riskHref(r.id) ?? "/telos"} onClick={e => e.stopPropagation()} className="underline" style={{ color: "#9acbff", padding: "6px 0" }}>{r.id}: {r.title}</a>)}</div>;

  const stale = !!data?.stale;
  const lastCheck = data?.generated_at ? clock(data.generated_at) : "—";
  const ageText = data && data.age_minutes >= 0 ? ago(data.age_minutes * 60_000) : "never";

  return (
    <PageShell>
      <PageHeader
        icon={MessageCircleQuestionMark}
        title="Socrates"
        subtitle="Standing questions about my life and estate, asked on a schedule and answered pass / fail / unknown."
      />

      {/* One line of tick health. Red and explained when late; never softened. */}
      <div
        data-tick-health={stale ? "stale" : "fresh"}
        style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "6px 14px", fontSize: 13, marginBottom: 14, padding: "8px 12px", borderRadius: 10,
          border: stale ? "1px solid rgba(255,120,80,0.55)" : "1px solid rgba(255,255,255,0.06)", background: stale ? "rgba(255,120,80,0.08)" : "transparent" }}
      >
        <span style={{ width: 8, height: 8, borderRadius: 999, background: stale ? "#ff7850" : "#4ade80", flex: "none" }} />
        <span>
          Last check <strong>{lastCheck}</strong> · {ageText} · expected hourly
        </span>
        {stale && (
          <span style={{ opacity: 0.85 }}>
            — {data?.stale_reason ?? "the hourly check has not written since then; everything below is last-known, not current."}
          </span>
        )}
        <span style={{ marginLeft: "auto", opacity: 0.7, fontSize: 12 }}>
          {counts.fail} failing · {counts.unknown} unknown · {counts.pass} passing · {unanswerable.length} unanswerable · {counts.routed} routed
        </span>
      </div>

      {/* Filters: verdict first (the thing you act on), then domain. */}
      <div data-filters style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, marginBottom: 12 }}>
        {(["fail", "unknown", "pass"] as Verdict[]).map((v) => (
          <FilterChip key={v} label={v} count={counts[v]} dim={VERDICT_DIM[v]} active={verdictFilter === v} onClick={() => setVerdictFilter(verdictFilter === v ? null : v)} />
        ))}
        <span style={{ width: 1, height: 18, background: "rgba(255,255,255,0.12)", margin: "0 4px" }} />
        {domainCounts.map(([d, c]) => (
          <FilterChip key={d} label={d} count={c.fail > 0 ? c.fail : c.total} dim={c.fail > 0 ? "err" : "neutral"} active={domainFilter === d} onClick={() => setDomainFilter(domainFilter === d ? null : d)} />
        ))}
      </div>

      {/* The questions. Fail → unknown → pass, critical first inside each. */}
      {selectedQuestion && <div style={{ marginBottom: 12 }}><button type="button" className="underline" onClick={() => { setSelectedQuestion(null); window.history.replaceState(null, "", "/socrates"); }}>Show all questions</button>{data && !data.questions.some(q => q.id === selectedQuestion) && <p role="status">Question {selectedQuestion} is not in the current ledger.</p>}</div>}
      {riskError && <p role="status" className="text-xs mb-3">Life-risk connections are unavailable.</p>}
      {selectedRecord && selectedRecord.status !== "active" && selectedRecord.status !== "unanswerable" && <Panel style={{ marginBottom: 14 }}><div data-sensitive data-row={selectedRecord.id} style={rowStyle}><p>{selectedRecord.id}: {selectedRecord.text}</p><p role="status">This question is {selectedRecord.status} and is not actively checked.</p>{riskBacklinks(selectedRecord)}</div></Panel>}
      <Panel className="sq-questions" style={{ marginBottom: 14 }}>
        {shown.length === 0 && <div style={{ padding: "12px 16px", fontSize: 13, opacity: 0.6 }}>{data ? "No questions match that filter." : "Loading…"}</div>}
        {shown.map((r) => {
          const q = r.q;
          const open = expanded === q.id;
          const latest = (data?.answers ?? []).filter((a) => a.question_id === q.id);
          return (
            <div key={q.id} data-row={q.id} data-verdict={r.verdict} style={{ ...rowStyle, cursor: "pointer" }} onClick={() => setExpanded(open ? null : q.id)}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13 }}>
                <Pill dim={VERDICT_DIM[r.verdict]}>{r.verdict}{r.unknowns > 0 && r.verdict !== "unknown" ? ` +${r.unknowns}?` : ""}</Pill>
                <span style={mono}>{q.id}</span>
                <span style={{ flex: 1, minWidth: 0 }}>{q.text}</span>
                {r.findings.map((f, i) => f.routed
                  ? <Pill key={i} dim="blue" title={`open since ${f.first_seen.slice(0, 10)} · ${f.seen_count} ticks`}>→ {f.routed.achilles_id}{(f.routed.work_issue ?? f.routed.ul_issue) ? ` · #${f.routed.work_issue ?? f.routed.ul_issue}` : ""}</Pill>
                  : <Pill key={i} dim="neutral" title={`open since ${f.first_seen.slice(0, 10)} · ${f.seen_count} ticks`}>unrouted</Pill>)}
                {r.instances > 1 && <span style={muted}>{r.instances} instances</span>}
                <span style={{ ...muted, color: r.late ? "#fbbf24" : undefined, opacity: r.late ? 0.95 : 0.55 }} title={r.lastTs ? fmtDateTime(r.lastTs) : "never answered"}>
                  {r.lastTs ? `answered ${ago(now - Date.parse(r.lastTs))}` : "never answered"} · {q.cadence}{r.late ? " · late" : ""}
                </span>
              </div>
              {riskBacklinks(q)}
              {open && (
                <div style={{ marginTop: 8, fontSize: 12, opacity: 0.85, display: "flex", flexDirection: "column", gap: 4 }}>
                  <div style={{ opacity: 0.7 }}>ideal: {q.ideal}</div>
                  <div style={{ opacity: 0.7 }}>{q.domain} · severity {q.severity} · via {q.answerer} · {q.verifier}{q.telos_ref ? ` · ${q.telos_ref}` : ""}</div>
                  {latest.slice(0, 12).map((a, i) => (
                    <div key={i} style={{ display: "flex", gap: 8 }}>
                      <Pill dim={VERDICT_DIM[(a.verdict as Verdict)] ?? "neutral"}>{a.verdict}</Pill>
                      <span style={{ fontFamily: "monospace", fontSize: 11, opacity: 0.7 }}>{a.instance_key || "—"}</span>
                      <span style={{ flex: 1 }}>{a.value != null ? `${a.value} · ` : ""}{a.evidence}</span>
                      <span style={{ fontSize: 11, opacity: 0.5, whiteSpace: "nowrap" }}>{ago(now - Date.parse(a.ts))}</span>
                    </div>
                  ))}
                  {latest.length > 12 && <div style={{ opacity: 0.6 }}>… {latest.length - 12} more instances</div>}
                  {latest[0] && (() => { try { const cf = JSON.parse(latest[0].computed_from); return (
                    <div style={{ opacity: 0.6 }}>computed from: {cf.touched.join(", ") || "nothing"}{cf.untouched?.length ? ` · NOT consulted: ${cf.untouched.join(", ")}` : ""}</div>
                  ); } catch { return null; } })()}
                </div>
              )}
            </div>
          );
        })}
      </Panel>

      {/* Named blind spots, folded. One line says how many; the rows are one click away. */}
      <Panel className="sq-unanswerable" style={{ marginBottom: 16 }}>
        <button
          type="button"
          data-unanswerable-toggle
          onClick={() => setShowUnanswerable(!showUnanswerable)}
          style={{ width: "100%", textAlign: "left", background: "transparent", border: 0, color: "inherit", cursor: "pointer", padding: "10px 16px", fontSize: 13, display: "flex", alignItems: "center", gap: 8 }}
        >
          {showUnanswerable ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <span><strong>{unanswerable.length}</strong> questions have no answerer yet — named blind spots, never closed by agents</span>
        </button>
        {showUnanswerable && unanswerable.filter(q => !selectedQuestion || q.id === selectedQuestion).map((q) => (
          <div key={q.id} data-row={q.id} data-verdict="unanswerable" style={rowStyle}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13 }}>
              <Pill dim="blue">unanswerable</Pill>
              <span style={mono}>{q.id}</span>
              <span style={{ flex: 1 }}>{q.text}</span>
              <Pill dim="neutral">{q.domain}</Pill>
              {q.experiential && <Pill dim="neutral">experiential</Pill>}
            </div>
            {riskBacklinks(q)}
            {q.ruled_out.length > 0 && <div style={{ marginTop: 6, fontSize: 12, opacity: 0.65 }}>ruled out: {q.ruled_out.join(" · ")}</div>}
          </div>
        ))}
      </Panel>

      <div style={{ fontSize: 11, opacity: 0.5 }}>
        Questions: LIFEOS/USER/SOCRATES/questions/ · answers: ~/.local/state/lifeos/socrates · mutations via <code>bun LIFEOS/SOCRATES/Socrates.ts</code> · design: LIFEOS/DOCUMENTATION/Socrates/SocratesSystem.md
      </div>
    </PageShell>
  );
}
