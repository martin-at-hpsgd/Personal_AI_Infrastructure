"use client";

/**
 * Today — Pulse's front door (rendered at `/` and `/today`).
 * One fetch of /api/today; this page holds zero data of its own.
 */

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useQueryClient } from "@tanstack/react-query";
import { ApiError, apiFetch, apiKey, apiSend, useApi } from "@/lib/api";
import { fmtLongDay, zonedDayKey, zonedHour, zonedMidnight } from "@/lib/time";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  CalendarDays,
  CheckCircle2,
  Compass,
  ExternalLink,
  Flame,
  ListOrdered,
  Moon,
  RefreshCw,
  ShieldCheck,
  Smile,
  Sun,
} from "lucide-react";
import { PageShell, PageHeader, Panel, PanelHeader, Pill, type Dim } from "@/components/ui/chrome";

// ── Payload types (mirror modules/today.ts) ──

type EvState = "past" | "now" | "next" | "later";
interface AgendaEvent {
  id: string; title: string; calendar: string | null; start: string; end: string;
  startLabel: string; endLabel: string; minutes: number; location: string | null;
  link: string | null; state: EvState; minutesUntil: number | null;
}
interface Agenda {
  date: string; events: AgendaEvent[]; allDay: Array<{ title: string; calendar: string | null }>;
  frames: Array<{ title: string; day: number; of: number }>; next: AgendaEvent | null;
  current: AgendaEvent | null; tomorrow: AgendaEvent[]; bookedMinutes: number; remainingMinutes: number;
}
interface Blocker {
  id: string; source: "work" | "achilles" | "vigil" | "system"; severity: "critical" | "high" | "medium";
  title: string; detail: string | null; href: string; ts: string | null; count: number;
}
interface RankedWork {
  number: number; title: string; url: string | null; column: string; priority: number | null;
  owner: "you" | "needs-you" | "unassigned" | "agent"; fire: boolean; updatedAt: string | null;
}
interface Recommendation {
  id: string; title: string; why: string; next_action: string; priority: string; confidence: number;
  category: string; evidence: Array<{ label: string; url?: string; source: string }>; context: string[];
  alsoOnDeck: Array<{ id: string; title: string; priority: string }>; summary: string | null; generated_at: string | null;
}
interface HealthDay { date: string; sleep_score: number | null; readiness: number | null; sleep_h: number | null; hrv: number | null; steps: number | null }
interface Health {
  generated_at: string | null;
  last_night: { sleep_h: number | null; efficiency: number | null; sleep_score: number | null; readiness: number | null };
  series: HealthDay[];
  averages: { sleep_h: number | null; sleep_score: number | null; readiness: number | null; hrv: number | null; steps: number | null };
  sources: Array<{ name: string; status: string; lastError: string | null }>;
}
interface MoodDim {
  dim: string; name: string; label: string; kind: "rating" | "freshness"; value: number | null;
  ts: string | null; ageHours: number | null; tier: "fresh" | "aging" | "stale" | "never"; note: string | null;
}
interface TodayPayload {
  generated_at: string; date: string; greeting: string;
  agenda: Agenda | null;
  blockers: { items: Blocker[]; total: number; counts: { board: number; achilles_open: number | null; achilles_high: number; exposure_line?: string | null; last_audit?: string | null } };
  work: { top: RankedWork[]; counts: Record<string, number>; stale: boolean } | null;
  recommendation: Recommendation | null;
  health: Health | null;
  mood: { dims: MoodDim[]; needsCheckin: string[] } | null;
  errors: Record<string, string>;
  /** Sources absent from this install or not set up yet; rendered as designed empty states, never errors. */
  unavailable?: Record<string, Unavailable>;
}
interface Unavailable { state: "not-installed" | "not-configured"; title: string; message: string | null }

// ── Helpers ──

const SEV_DIM: Record<Blocker["severity"], Dim> = { critical: "err", high: "warn", medium: "neutral" };
const PRIO_DIM: Record<string, Dim> = { now: "err", soon: "warn", later: "ok" };

function ago(iso: string | null, now = Date.now()): string {
  if (!iso) return "";
  const m = Math.round((now - Date.parse(iso)) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function ageLabel(hours: number | null): string {
  if (hours === null) return "never";
  if (hours < 1) return "now";
  if (hours < 48) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
}

function inLabel(mins: number): string {
  if (mins < 60) return `in ${mins} min`;
  const h = Math.floor(mins / 60), m = mins % 60;
  return m ? `in ${h}h ${m}m` : `in ${h}h`;
}

const longDate = fmtLongDay;

function ErrorLine({ msg }: { msg?: string }) {
  if (!msg) return null;
  return (
    <div className="flex items-center gap-2 text-[13px]" style={{ color: "var(--warn)" }}>
      <AlertTriangle className="w-4 h-4 shrink-0" /> <span className="truncate" title={msg}>{msg}</span>
    </div>
  );
}

/** A source this install does not have, or has not set up: what it is and how to set it up. Null message renders nothing. */
function NotSetUp({ info }: { info?: Unavailable }) {
  if (!info || !info.message) return null;
  return (
    <div className="flex flex-col gap-1 rounded-md px-3 py-3" style={{ background: "rgba(10,21,40,0.45)", border: "1px dashed var(--line-2)" }} data-testid="not-set-up">
      <div className="text-ink-1 text-[14px]">{info.title}</div>
      <div className="text-ink-3 text-[13px] leading-snug">{info.message}</div>
    </div>
  );
}

// ── Day frame (trip / multi-day context) ──

function DayFrameBar({ frame }: { frame: { title: string; day: number; of: number } }) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Compass className="w-4 h-4" style={{ color: "var(--freedom)" }} />
      <span className="text-ink-1 text-[15px]">{frame.title}</span>
      <span className="mono text-[12px] text-ink-3">day {frame.day} of {frame.of}</span>
      <div className="flex gap-1" aria-label={`day ${frame.day} of ${frame.of}`}>
        {Array.from({ length: frame.of }, (_, i) => (
          <span
            key={i}
            className="h-1.5 w-5 rounded-full"
            style={{ background: i + 1 < frame.day ? "rgba(125,211,252,0.45)" : i + 1 === frame.day ? "var(--freedom)" : "var(--line-2)" }}
          />
        ))}
      </div>
    </div>
  );
}

// ── Agenda strip ──

function AgendaStrip({ agenda, error, unavailable }: { agenda: Agenda | null; error?: string; unavailable?: Unavailable }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000); // not-data: clock tick that re-evaluates the now-line
    return () => clearInterval(t);
  }, []);

  const range = useMemo(() => {
    // Midnight of the agenda day in the principal's zone, so the axis hours match the agenda's HH:mm labels (ISA F7).
    const base = zonedMidnight(agenda?.date ?? zonedDayKey());
    let lo = 7, hi = 22;
    for (const e of agenda?.events ?? []) {
      lo = Math.min(lo, Math.floor((Date.parse(e.start) - base) / 3_600_000));
      hi = Math.max(hi, Math.ceil((Date.parse(e.end) - base) / 3_600_000));
    }
    lo = Math.max(0, lo); hi = Math.min(24, Math.max(hi, lo + 1));
    return { base, lo, hi, span: (hi - lo) * 3_600_000 };
  }, [agenda]);

  const pct = (t: number) => Math.min(100, Math.max(0, ((t - (range.base + range.lo * 3_600_000)) / range.span) * 100));
  const nowPct = pct(now);
  const nowVisible = now >= range.base + range.lo * 3_600_000 && now <= range.base + range.hi * 3_600_000;
  const hours = Array.from({ length: range.hi - range.lo + 1 }, (_, i) => range.lo + i);
  const events = agenda?.events ?? [];

  return (
    <Panel className="p-5 flex flex-col gap-4">
      <PanelHeader
        title="Agenda"
        icon={CalendarDays}
        meta={agenda ? `${events.length} event${events.length === 1 ? "" : "s"} · ${Math.round(agenda.remainingMinutes / 60 * 10) / 10}h booked ahead` : undefined}
        actions={agenda?.allDay.map((a) => <Pill key={a.title} dim="blue">{a.title}</Pill>)}
      />
      <ErrorLine msg={error} />
      <NotSetUp info={unavailable} />

      {/* Timeline */}
      {!unavailable && <div className="relative h-[86px] rounded-md" style={{ background: "rgba(10,21,40,0.55)", border: "1px solid var(--line-1)" }}>
        {hours.map((h) => (
          <div key={h} className="absolute top-0 bottom-0" style={{ left: `${((h - range.lo) / (range.hi - range.lo)) * 100}%` }}>
            <div className="h-full w-px" style={{ background: h % 3 === 0 ? "var(--line-2)" : "var(--line-1)" }} />
            {h % 3 === 0 && h < range.hi && (
              <span className="absolute bottom-1 left-1 mono text-[10px] text-ink-3">{String(h).padStart(2, "0")}:00</span>
            )}
          </div>
        ))}
        {events.map((e) => {
          const left = pct(Date.parse(e.start)), right = pct(Date.parse(e.end));
          const live = e.state === "now", next = e.state === "next", past = e.state === "past";
          return (
            <a
              key={e.id}
              href={e.link ?? undefined}
              target="_blank"
              rel="noreferrer"
              title={`${e.startLabel}–${e.endLabel} · ${e.title}${e.location ? ` · ${e.location}` : ""}`}
              className="absolute top-2 h-[50px] rounded-[4px] px-2 py-1 overflow-hidden text-[12px] leading-tight transition-opacity hover:opacity-100"
              style={{
                left: `${left}%`,
                width: `calc(${Math.max(right - left, 0.6)}% - 2px)`,
                background: live ? "rgba(37,139,255,0.42)" : next ? "rgba(37,139,255,0.24)" : "rgba(128,204,255,0.12)",
                border: `1px solid ${live ? "var(--accent-soft)" : next ? "rgba(128,204,255,0.5)" : "var(--line-2)"}`,
                opacity: past ? 0.45 : 1,
                color: "var(--ink-1)",
              }}
            >
              <div className="mono text-[10px] text-ink-2">{e.startLabel}</div>
              <div className="truncate">{e.title}</div>
            </a>
          );
        })}
        {nowVisible && (
          <div className="absolute top-0 bottom-0 pointer-events-none" style={{ left: `${nowPct}%` }}>
            <div className="h-full w-[2px] -ml-px" style={{ background: "var(--err)" }} />
            <div className="absolute -top-1 -left-[4px] h-2 w-2 rounded-full" style={{ background: "var(--err)" }} />
          </div>
        )}
        {agenda && events.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center text-ink-2 text-[14px]">
            Nothing booked today. The day is yours.
          </div>
        )}
      </div>}

      {/* Now / Next / Tomorrow */}
      {agenda && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-[14px]">
          <div>
            <div className="pulse-stat-label text-[11px] uppercase tracking-[0.12em] text-ink-3 mb-1">Now</div>
            {agenda.current
              ? <div className="text-ink-1">{agenda.current.title} <span className="mono text-ink-3 text-[12px]">until {agenda.current.endLabel}</span></div>
              : <div className="text-ink-2">Free</div>}
          </div>
          <div>
            <div className="pulse-stat-label text-[11px] uppercase tracking-[0.12em] text-ink-3 mb-1">Next</div>
            {agenda.next
              ? <div className="text-ink-1">{agenda.next.title} <span className="mono text-ink-3 text-[12px]">{agenda.next.startLabel} · {inLabel(agenda.next.minutesUntil ?? 0)}</span></div>
              : <div className="text-ink-2">Nothing else today</div>}
          </div>
          <div>
            <div className="pulse-stat-label text-[11px] uppercase tracking-[0.12em] text-ink-3 mb-1">Tomorrow</div>
            {agenda.tomorrow.length
              ? <div className="text-ink-1 truncate">{agenda.tomorrow.map((t) => `${t.startLabel} ${t.title}`).join(" · ")}</div>
              : <div className="text-ink-2">Clear so far</div>}
          </div>
        </div>
      )}
    </Panel>
  );
}

// ── The move ──

function TheMove({ rec, error }: { rec: Recommendation | null; error?: string }) {
  if (!rec) {
    return (
      <Panel className="p-6">
        <PanelHeader title="The move" icon={ArrowRight} />
        <ErrorLine msg={error} />
        {!error && <div className="text-ink-2">No recommendation yet. Prioritize refreshes every two hours.</div>}
      </Panel>
    );
  }
  return (
    <Panel
      className="p-0 overflow-hidden"
      style={{ borderColor: "rgba(128,204,255,0.35)", boxShadow: "0 0 0 1px rgba(37,139,255,0.12), 0 18px 48px -24px rgba(37,139,255,0.45)" }}
    >
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]">
        <div className="p-6 flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[12px] font-semibold uppercase tracking-[0.16em]" style={{ color: "var(--accent-soft)" }}>The move</span>
            <Pill dim={PRIO_DIM[rec.priority] ?? "blue"}>{rec.priority}</Pill>
            <Pill dim="neutral">{rec.category}</Pill>
            <span className="flex gap-0.5 ml-1" title={`confidence ${rec.confidence}/5`} aria-label={`confidence ${rec.confidence} of 5`}>
              {[1, 2, 3, 4, 5].map((i) => (
                <span key={i} className="h-1.5 w-3 rounded-full" style={{ background: i <= rec.confidence ? "var(--accent-soft)" : "var(--line-2)" }} />
              ))}
            </span>
          </div>
          <h2 className="text-ink-1 text-[26px] leading-snug" style={{ fontFamily: "'valkyrie-text', Georgia, serif" }}>{rec.title}</h2>
          <div className="flex items-start gap-3 rounded-md px-4 py-3" style={{ background: "rgba(37,139,255,0.12)", border: "1px solid rgba(128,204,255,0.28)" }}>
            <ArrowRight className="w-5 h-5 mt-0.5 shrink-0" style={{ color: "var(--accent-soft)" }} />
            <div className="text-ink-1 text-[16px] leading-relaxed">{rec.next_action}</div>
          </div>
          <p className="text-ink-2 text-[14px] leading-relaxed">{rec.why}</p>
          {rec.context.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {rec.context.map((c) => (
                <span key={c} className="text-[12px] px-2.5 py-1 rounded-md text-ink-2" style={{ background: "rgba(168,165,200,0.08)", border: "1px solid var(--line-2)" }}>{c}</span>
              ))}
            </div>
          )}
          {rec.evidence.some((e) => e.label !== rec.title) && (
            <div className="flex flex-wrap gap-3 text-[12px]">
              {rec.evidence.filter((e) => e.label !== rec.title).map((e) => e.url ? (
                <a key={e.label} href={e.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-ink-3 hover:text-ink-1">
                  {e.label} <ExternalLink className="w-3 h-3" />
                </a>
              ) : <span key={e.label} className="text-ink-3">{e.label}</span>)}
            </div>
          )}
        </div>
        <div className="p-6 flex flex-col gap-3 border-t lg:border-t-0 lg:border-l border-line-1" style={{ background: "rgba(10,21,40,0.35)" }}>
          <div className="flex items-center gap-2">
            <ListOrdered className="w-4 h-4 text-ink-3" />
            <span className="text-[12px] font-semibold uppercase tracking-[0.12em] text-ink-3">Also on deck</span>
          </div>
          <ol className="flex flex-col gap-2.5">
            {rec.alsoOnDeck.map((r, i) => (
              <li key={r.id} className="flex items-start gap-3 text-[14px]">
                <span className="mono text-[12px] text-ink-3 mt-0.5 w-4 shrink-0">{i + 2}</span>
                <span className="text-ink-1 leading-snug flex-1">{r.title}</span>
                <span className="h-2 w-2 rounded-full mt-1.5 shrink-0" title={r.priority} style={{ background: `var(--${PRIO_DIM[r.priority] ?? "ok"})` }} />
              </li>
            ))}
          </ol>
          {rec.summary && <p className="text-ink-3 text-[13px] leading-relaxed italic mt-1">{rec.summary}</p>}
          <Link href="/prioritize" className="mt-auto inline-flex items-center gap-1 text-[12px] text-ink-3 hover:text-ink-1">
            Prioritize · {ago(rec.generated_at)} <ArrowRight className="w-3 h-3" />
          </Link>
        </div>
      </div>
    </Panel>
  );
}

// ── Blockers ──

const SOURCE_LABEL: Record<Blocker["source"], string> = { work: "Board", achilles: "Achilles", vigil: "Vigil", system: "System" };

function Blockers({ data, error, unavailable }: { data: TodayPayload["blockers"]; error?: string; unavailable: Record<string, Unavailable> }) {
  return (
    <Panel className="p-5 flex flex-col gap-3">
      <PanelHeader
        title="Blockers"
        icon={AlertTriangle}
        meta={data.total > data.items.length ? `${data.items.length} of ${data.total}` : String(data.total)}
      />
      <ErrorLine msg={error} />
      {data.items.length === 0 ? (
        <div className="flex items-center gap-2 py-6 justify-center text-ink-2">
          <CheckCircle2 className="w-5 h-5" style={{ color: "var(--ok)" }} /> Nothing is stuck.
        </div>
      ) : (
        <ul className="flex flex-col divide-y divide-[color:var(--line-1)]">
          {data.items.map((b) => {
            const external = b.href.startsWith("http");
            const body = (
              <div className="flex items-start gap-3 py-2.5">
                <span className="h-2 w-2 rounded-full mt-2 shrink-0" style={{ background: `var(--${SEV_DIM[b.severity] === "neutral" ? "ink-3" : SEV_DIM[b.severity]})` }} title={b.severity} />
                <div className="min-w-0 flex-1">
                  <div className="text-ink-1 text-[14px] leading-snug">
                    {b.title}
                    {b.count > 1 && <span className="mono text-[11px] text-ink-3 ml-2">×{b.count}</span>}
                  </div>
                  {b.detail && <div className="text-ink-3 text-[12px] truncate" title={b.detail}>{b.detail}</div>}
                </div>
                <div className="flex flex-col items-end gap-1 shrink-0">
                  <Pill dim={SEV_DIM[b.severity]}>{SOURCE_LABEL[b.source]}</Pill>
                  {b.ts && <span className="mono text-[11px] text-ink-3">{ago(b.ts)}</span>}
                </div>
              </div>
            );
            return (
              <li key={b.id}>
                {external
                  ? <a href={b.href} target="_blank" rel="noreferrer" className="block hover:bg-[color:var(--surface-3)] rounded-md -mx-2 px-2">{body}</a>
                  : <Link href={b.href} className="block hover:bg-[color:var(--surface-3)] rounded-md -mx-2 px-2">{body}</Link>}
              </li>
            );
          })}
        </ul>
      )}
      {data.counts.exposure_line && (
        <Link href="/achilles#audit-report" data-testid="exposure-line" className="mt-auto flex items-center gap-2 rounded-md border border-[color:var(--line-1)] px-3 py-2 text-[13px] text-ink-1 hover:bg-[color:var(--surface-3)]">
          <ShieldCheck className="w-4 h-4 shrink-0 text-ink-3" />
          <span className="min-w-0 flex-1 truncate" title={data.counts.exposure_line}>{data.counts.exposure_line}</span>
          {data.counts.last_audit && <span className="mono text-[11px] text-ink-3 shrink-0">{ago(data.counts.last_audit)}</span>}
        </Link>
      )}
      <div className={`${data.counts.exposure_line ? "" : "mt-auto "}flex flex-wrap gap-4 text-[12px] text-ink-3 pt-1`}>
        {!unavailable.work && <Link href="/work" className="hover:text-ink-1">{data.counts.board} blocked on the board</Link>}
        {data.counts.achilles_open !== null && <Link href="/achilles" className="hover:text-ink-1">{data.counts.achilles_open} open findings</Link>}
        {!unavailable.vigil && <Link href="/vigil" className="hover:text-ink-1">Vigil</Link>}
      </div>
    </Panel>
  );
}

// ── Top work ──

const OWNER_LABEL: Record<RankedWork["owner"], { text: string; dim: Dim } | null> = {
  you: { text: "yours", dim: "blue" },
  "needs-you": { text: "needs you", dim: "warn" },
  unassigned: null,
  agent: { text: "agent", dim: "neutral" },
};

function TopWork({ work, error, unavailable }: { work: TodayPayload["work"]; error?: string; unavailable?: Unavailable }) {
  return (
    <Panel className="p-5 flex flex-col gap-3">
      <PanelHeader title="Top work" icon={Flame} meta={work ? `${work.counts["In-Progress"] ?? 0} in progress · ${work.counts["Queued"] ?? 0} queued` : undefined} />
      <ErrorLine msg={error} />
      <NotSetUp info={unavailable} />
      {work && work.top.length === 0 && <div className="text-ink-2 py-6 text-center">No human-owned work is open.</div>}
      {work && work.top.length > 0 && (
        <ul className="flex flex-col divide-y divide-[color:var(--line-1)]">
          {work.top.map((w) => {
            const owner = OWNER_LABEL[w.owner];
            return (
              <li key={w.number}>
                <a href={w.url ?? "/work"} target={w.url ? "_blank" : undefined} rel="noreferrer" className="flex items-start gap-3 py-2.5 hover:bg-[color:var(--surface-3)] rounded-md -mx-2 px-2">
                  <span
                    className="mono text-[11px] px-1.5 py-0.5 rounded shrink-0 mt-0.5"
                    style={{
                      background: w.fire ? "rgba(248,113,113,0.16)" : "rgba(168,165,200,0.10)",
                      color: w.fire ? "var(--err)" : "var(--ink-2)",
                      border: `1px solid ${w.fire ? "rgba(248,113,113,0.35)" : "var(--line-2)"}`,
                    }}
                  >
                    {w.priority !== null ? `P${w.priority}` : "—"}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-ink-1 text-[14px] leading-snug">{w.title}</div>
                    <div className="mono text-[11px] text-ink-3">#{w.number} · {w.column}{w.updatedAt ? ` · ${ago(w.updatedAt)}` : ""}</div>
                  </div>
                  {owner && <Pill dim={owner.dim} className="shrink-0">{owner.text}</Pill>}
                </a>
              </li>
            );
          })}
        </ul>
      )}
      <Link href="/work" className="mt-auto inline-flex items-center gap-1 text-[12px] text-ink-3 hover:text-ink-1 pt-1">
        Full board <ArrowRight className="w-3 h-3" />
      </Link>
    </Panel>
  );
}

// ── Body ──

function Bars({ series, pick, label, unit }: { series: HealthDay[]; pick: (d: HealthDay) => number | null; label: string; unit?: string }) {
  const vals = series.map(pick);
  const max = Math.max(1, ...vals.filter((v): v is number => v !== null));
  return (
    <div className="flex flex-col gap-1.5 min-w-0">
      <div className="text-[11px] uppercase tracking-[0.12em] text-ink-3">{label}</div>
      <div className="flex items-end gap-[2px] h-16" role="img" aria-label={`${label}, last ${series.length} days`}>
        {series.map((d, i) => {
          const v = vals[i];
          const last = i === series.length - 1;
          return (
            <div key={d.date} className="flex-1 h-full flex items-end group relative" title={`${d.date.slice(5)} · ${v ?? "–"}${unit ?? ""}`}>
              <div
                className="w-full rounded-t-[4px]"
                style={{ height: v === null ? 2 : `${Math.max(4, (v / max) * 100)}%`, background: last ? "var(--health)" : "rgba(52,211,153,0.38)" }}
              />
            </div>
          );
        })}
      </div>
      <div className="flex justify-between mono text-[10px] text-ink-3">
        <span>{series[0]?.date.slice(5)}</span><span>{series.at(-1)?.date.slice(5)}</span>
      </div>
    </div>
  );
}

function Metric({ label, value, unit, sub }: { label: string; value: string; unit?: string; sub?: string }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="text-[11px] uppercase tracking-[0.12em] text-ink-3">{label}</div>
      <div className="flex items-baseline gap-1">
        <span className="pulse-stat-value leading-none text-ink-1">{value}</span>
        {unit && <span className="text-[13px] text-ink-2">{unit}</span>}
      </div>
      {sub && <div className="text-[11px] text-ink-3 mono">{sub}</div>}
    </div>
  );
}

function delta(v: number | null, avg: number | null, digits = 0): string | undefined {
  if (v === null || avg === null) return undefined;
  const d = Math.round((v - avg) * 10 ** digits) / 10 ** digits;
  return `${d >= 0 ? "+" : ""}${d} vs 7d`;
}

function Body({ health, error, unavailable }: { health: Health | null; error?: string; unavailable?: Unavailable }) {
  const ln = health?.last_night;
  return (
    <Panel className="p-5 flex flex-col gap-4">
      <PanelHeader title="Body" icon={Activity} meta={health?.generated_at ? `Oura · ${ago(health.generated_at)}` : undefined} actions={<Link href="/health" className="text-[12px] text-ink-3 hover:text-ink-1">Health →</Link>} />
      <ErrorLine msg={error} />
      <NotSetUp info={unavailable} />
      {health && ln && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <Metric label="Slept" value={ln.sleep_h?.toFixed(1) ?? "–"} unit="h" sub={delta(ln.sleep_h, health.averages.sleep_h, 1)} />
            <Metric label="Sleep score" value={ln.sleep_score?.toString() ?? "–"} sub={delta(ln.sleep_score, health.averages.sleep_score)} />
            <Metric label="Readiness" value={ln.readiness?.toString() ?? "–"} sub={delta(ln.readiness, health.averages.readiness)} />
            <Metric label="Efficiency" value={ln.efficiency?.toString() ?? "–"} unit="%" />
          </div>
          {health.series.length > 1 && (
            <div className="grid grid-cols-3 gap-5">
              <Bars series={health.series} pick={(d) => d.sleep_h} label="Sleep · h" unit="h" />
              <Bars series={health.series} pick={(d) => d.readiness} label="Readiness" />
              <Bars series={health.series} pick={(d) => d.steps} label="Steps" />
            </div>
          )}
          {health.sources.filter((s) => s.status !== "ok").map((s) => (
            <ErrorLine key={s.name} msg={`${s.name}: ${s.status}${s.lastError ? ` · ${s.lastError}` : ""}`} />
          ))}
        </>
      )}
    </Panel>
  );
}

// ── Mind ──

const TIER_COLOR: Record<MoodDim["tier"], string> = { fresh: "var(--ok)", aging: "var(--warn)", stale: "var(--err)", never: "var(--ink-3)" };

function Mind({ mood, error, onCheckin, busy }: {
  mood: TodayPayload["mood"]; error?: string; onCheckin: (dim: string, value?: number) => void; busy: string | null;
}) {
  const ratings = mood?.dims.filter((d) => d.kind === "rating") ?? [];
  const habits = mood?.dims.filter((d) => d.kind === "freshness") ?? [];
  const asks = ["M", "E"];
  return (
    <Panel className="p-5 flex flex-col gap-4">
      <PanelHeader title="Mind" icon={Smile} meta={mood?.needsCheckin.length ? "check-in due" : "up to date"} />
      <ErrorLine msg={error} />
      {mood && (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {asks.map((dim) => {
              const d = mood.dims.find((x) => x.dim === dim);
              if (!d) return null;
              return (
                <div key={dim} className="rounded-md px-3 py-2.5" style={{ background: "rgba(10,21,40,0.45)", border: `1px solid ${d.tier === "fresh" ? "var(--line-2)" : "rgba(251,191,36,0.35)"}` }}>
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-[13px] text-ink-1">{d.name[0].toUpperCase() + d.name.slice(1)} right now?</span>
                    <span className="mono text-[11px]" style={{ color: TIER_COLOR[d.tier] }}>
                      {d.value !== null ? `${d.value}/5 · ` : ""}{ageLabel(d.ageHours)}
                    </span>
                  </div>
                  <div className="flex gap-1.5">
                    {[1, 2, 3, 4, 5].map((v) => {
                      const current = d.tier === "fresh" && d.value === v;
                      return (
                        <button
                          key={v}
                          type="button"
                          disabled={busy !== null}
                          onClick={() => onCheckin(dim, v)}
                          className="flex-1 py-1.5 rounded-md mono text-[13px] cursor-pointer transition-colors disabled:opacity-50"
                          style={{
                            background: current ? "rgba(37,139,255,0.35)" : "rgba(168,165,200,0.08)",
                            border: `1px solid ${current ? "var(--accent-soft)" : "var(--line-2)"}`,
                            color: "var(--ink-1)",
                          }}
                          aria-label={`log ${d.name} ${v} of 5`}
                        >
                          {busy === `${dim}${v}` ? "…" : v}
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
          <div className="flex flex-wrap gap-x-5 gap-y-2">
            {ratings.filter((d) => !asks.includes(d.dim)).map((d) => (
              <div key={d.dim} className="flex items-baseline gap-1.5" title={d.note ?? undefined}>
                <span className="text-[11px] uppercase tracking-[0.1em] text-ink-3">{d.label}</span>
                <span className="mono text-[14px] text-ink-1">{d.value ?? "–"}</span>
                <span className="mono text-[10px]" style={{ color: TIER_COLOR[d.tier] }}>{ageLabel(d.ageHours)}</span>
              </div>
            ))}
          </div>
          <div className="flex flex-wrap gap-2">
            {habits.map((d) => (
              <button
                key={d.dim}
                type="button"
                disabled={busy !== null}
                onClick={() => onCheckin(d.dim)}
                className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-[12px] cursor-pointer disabled:opacity-50"
                style={{ background: "rgba(168,165,200,0.08)", border: "1px solid var(--line-2)", color: "var(--ink-2)" }}
                title={`Log ${d.name} done now`}
              >
                <span className="h-1.5 w-1.5 rounded-full" style={{ background: TIER_COLOR[d.tier] }} />
                {d.name} · {d.ageHours === null ? "never" : `${ageLabel(d.ageHours)} ago`}
                <span className="text-ink-3">{busy === d.dim ? "…" : "+ done"}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </Panel>
  );
}

// ── Page ──

export default function TodayPage() {
  const queryClient = useQueryClient();
  const today = useApi<TodayPayload>("/api/today", { refetchInterval: 120_000 });
  const data = today.data ?? null;
  // Errors from the refresh and check-in actions; a good poll or refresh clears them, as before.
  const [actionError, setActionError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => { if (today.dataUpdatedAt) setActionError(null); }, [today.dataUpdatedAt]);
  const readError = today.error instanceof ApiError ? String(new Error(`HTTP ${today.error.status}`)) : today.error ? String(today.error) : null;
  const error = readError ?? actionError;

  const refresh = async () => {
    setRefreshing(true);
    try {
      const fresh = await apiFetch<TodayPayload>("/api/today?fresh=1");
      queryClient.setQueryData(apiKey("/api/today"), fresh);
      setActionError(null);
    } catch (e) {
      setActionError(e instanceof ApiError ? String(new Error(`HTTP ${e.status}`)) : String(e));
    }
    setRefreshing(false);
  };

  const checkin = async (dim: string, value?: number) => {
    setBusy(`${dim}${value ?? ""}`);
    try {
      const json = await apiSend<{ mood: TodayPayload["mood"] }>("/api/today/checkin", "POST", value === undefined ? { dim } : { dim, value });
      queryClient.setQueryData<TodayPayload>(apiKey("/api/today"), (d) => (d ? { ...d, mood: json.mood } : d));
    } catch (e) {
      if (e instanceof ApiError) {
        let msg = `HTTP ${e.status}`;
        try { const parsed = JSON.parse(e.body) as { error?: string }; msg = parsed.error ?? msg; } catch { /* keep HTTP status */ }
        setActionError(String(new Error(msg)));
      } else {
        setActionError(String(e));
      }
    } finally {
      setBusy(null);
    }
  };

  const hour = zonedHour();
  const errs = data?.errors ?? {};
  const gone = data?.unavailable ?? {};
  const frame = data?.agenda?.frames[0];
  const ln = data?.health?.last_night;
  const moodDim = data?.mood?.dims.find((d) => d.dim === "M");

  return (
    <PageShell>
      <PageHeader
        title="Today"
        icon={hour >= 6 && hour < 19 ? Sun : Moon}
        subtitle={data ? `${data.greeting}. ${longDate(data.date)}.` : "Loading the day…"}
        actions={
          <div className="flex items-center gap-4">
            {ln && (
              <div className="hidden md:flex items-center gap-4 mono text-[12px] text-ink-2">
                <span title="Last night's sleep"><Moon className="inline w-3.5 h-3.5 mr-1 text-ink-3" />{ln.sleep_h?.toFixed(1) ?? "–"}h</span>
                <span title="Readiness">RDY {ln.readiness ?? "–"}</span>
                {moodDim && <span title="Mood" style={{ color: moodDim.tier === "fresh" ? undefined : "var(--warn)" }}>MOOD {moodDim.value ?? "–"}{moodDim.tier !== "fresh" ? ` · ${ageLabel(moodDim.ageHours)}` : ""}</span>}
              </div>
            )}
            <button
              type="button"
              onClick={refresh}
              disabled={refreshing}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[12px] text-ink-2 hover:text-ink-1 cursor-pointer disabled:opacity-50"
              style={{ background: "rgba(168,165,200,0.08)", border: "1px solid var(--line-2)" }}
              title={data ? `Updated ${ago(data.generated_at)}` : undefined}
            >
              <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? "animate-spin" : ""}`} /> Refresh
            </button>
          </div>
        }
      />

      {error && <ErrorLine msg={error} />}
      {frame && <DayFrameBar frame={frame} />}

      {data && (
        <>
          <AgendaStrip agenda={data.agenda} error={errs.calendar} unavailable={gone.calendar} />
          <TheMove rec={data.recommendation} error={errs.prioritize} />
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
            <Blockers data={data.blockers} error={[errs.work, errs.achilles, errs.vigil].filter(Boolean).join(" · ") || undefined} unavailable={gone} />
            <TopWork work={data.work} error={errs.work} unavailable={gone.work} />
          </div>
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
            <Body health={data.health} error={errs.health} unavailable={gone.health} />
            <Mind mood={data.mood} error={errs.mood} onCheckin={checkin} busy={busy} />
          </div>
        </>
      )}
    </PageShell>
  );
}
