"use client";

import { useState } from "react";
import { useApi, apiFetch, ApiError } from "@/lib/api";
import { fmtClock, fmtDateParts, fmtDateTime } from "@/lib/time";
import {
  RefreshCw,
  ClipboardCheck,
  Check,
  X,
  Eye,
  AlertTriangle,
  Gauge,
  Clock,
  ScanSearch,
  History,
  Target,
  Inbox,
  ListChecks,
  ScrollText,
  ChevronDown,
  ChevronUp,
  Repeat2,
  XCircle,
} from "lucide-react";
import {
  PageShell,
  PageHeader,
  Panel,
  PanelHeader,
  Pill,
  dimStyle,
  type Dim,
} from "@/components/ui/chrome";

type FixType = "delete" | "tool" | "check" | "prose";
type RecStatus = "open" | "accepted" | "dismissed" | "expired";

interface Prediction {
  metric: string;
  args?: unknown;
  direction: "down" | "up";
  size_pct: number;
  p: number;
  due: string;
  baseline?: unknown;
  mde_pct?: number;
}

interface Rec {
  id: string;
  kind: "change" | "deletion";
  status: RecStatus;
  created: string;
  decided?: string;
  note?: string;
  title: string;
  change: string;
  fix_type: FixType;
  target?: string;
  why_not_check?: string;
  evidence?: string[];
  generators?: string[];
  key?: string;
  prediction?: Prediction;
  upgrade_id?: string;
  score?: unknown;
}

interface Alarm {
  rule: string;
  date: string;
  detail?: string;
  value?: unknown;
  class?: string;
  suspects?: string[];
}

interface Watch {
  id: string;
  label: string;
  cut: string;
  days: number;
  metrics?: unknown;
  result?: unknown;
  /** The watch's state as one plain sentence, built by the Review module (ISC-89). */
  sentence?: string;
  outcome?: OutcomeKind;
}

/** The glance label the Review module gives a watch outcome (modules/review.ts OutcomeKind). */
type OutcomeKind = "too-early" | "overdue" | "unclear" | "helped" | "worse" | "never-measured" | "no-watch-yet";

const OUTCOME: Record<OutcomeKind, { label: string; dim: Dim }> = {
  "too-early": { label: "too early", dim: "neutral" },
  overdue: { label: "overdue", dim: "warn" },
  unclear: { label: "unclear", dim: "blue" },
  helped: { label: "helped", dim: "ok" },
  worse: { label: "worse", dim: "err" },
  "never-measured": { label: "never measured", dim: "neutral" },
  "no-watch-yet": { label: "no watch yet", dim: "neutral" },
};

interface CardRow {
  generator: string;
  recommended: number;
  accepted: number;
  applied: number;
  verified: number;
  scored: number;
  hits: number;
  hit_rate: number | null;
  brier: number | null;
}

interface Scorecard {
  ts: string;
  month: string;
  card: CardRow[];
  agreement?: unknown;
  drill?: unknown;
}

interface LabelItem {
  id: string;
  ts: string;
  detector: "failure" | "pass";
  prompt: string;
  reply: string;
  label: null;
}

// The Upgrades store is Review's queue (/upgrades folded into /review, 2026-10-10).
interface QueueItem {
  id: string;
  source: string;
  claim: string;
  created: string;
  confidence: number;
  status: "recommended" | "accepted";
  target_surface: string;
  expires_in_days: number | null;
  evidence_count: number;
  recommendation: string;
  quote: string;
  category: string;
  has_patch: boolean;
  patch_target: string | null;
  proposed_patch: string;
  recurrence_count: number;
  ledger_id: string | null;
}

// What a queue row's Detail shows; fetched from /api/review/detail/:id when the row opens.
interface QueueDetail {
  id: string;
  current_state: string;
  falsifier: string;
  evidence: string[];
  evidence_more: number;
  notes: string[];
  recommendation: string;
}

interface ClosedItem {
  id: string;
  source: string;
  claim: string;
  created: string;
  status: "rejected" | "expired";
  target_surface: string;
  confidence: number;
  quote: string;
  category: string;
  recurrence_count: number;
  note: string;
  /** Why it closed, one plain line (ISC-96). */
  reason?: string;
  closed_at?: string | null;
}

interface AppliedItem {
  id: string;
  source: string;
  claim: string;
  created: string;
  status: "applied" | "verified";
  ledger_id: string | null;
  watch: { id: string; label: string; verdict: string } | null;
  /** The watch state as one plain sentence with its number (ISC-89); the row shows this, never raw watch data. */
  verdict_sentence?: string;
  verdict_kind?: OutcomeKind;
}

interface ReviewResponse {
  as_of: {
    exchanges: string | null;
    complaints: string | null;
    coverage: string | null;
    turns: string | null;
    review_runs?: { daily?: string; weekly?: string; monthly?: string };
  };
  open: Rec[];
  decided: Rec[];
  health: Record<string, "ok" | "failing" | "stale" | "never"> | null;
  alarms: Alarm[];
  watches: Watch[];
  scorecard: Scorecard | null;
  labels: LabelItem[];
  queue?: QueueItem[];
  applied?: AppliedItem[];
  closed?: ClosedItem[];
  closed_total?: number;
  next_runs?: { daily?: string | null; weekly?: string | null; monthly?: string | null };
}

const PAGE_SIZE = 20;

const SOURCE_LABEL: Record<string, string> = {
  directive: "principal said",
  correction: "correction",
  "upgrade-skill": "upgrade scan",
  "algo-run": "/algo",
  autonomous: "autonomous",
  manual: "manual",
  coach: "coaching",
  errata: "errata",
  "assay-miss": "assay miss",
  hillclimb: "hill climb",
  review: "review",
  evidence: "evidence",
  analysis: "analysis",
};

const fixTypeDim: Record<FixType, Dim> = {
  delete: "err",
  tool: "blue",
  check: "warn",
  prose: "neutral",
};

const statusDim: Record<RecStatus, Dim> = {
  open: "blue",
  accepted: "ok",
  dismissed: "neutral",
  expired: "warn",
};

function formatRelativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const future = diffMs < 0;
  const abs = Math.abs(diffMs);
  const mins = Math.floor(abs / 60000);
  const hours = Math.floor(mins / 60);
  const days = Math.floor(hours / 24);
  let s: string;
  if (mins < 1) return "now";
  if (mins < 60) s = `${mins}m`;
  else if (hours < 24) s = `${hours}h`;
  else s = `${days}d`;
  return future ? `in ${s}` : `${s} ago`;
}

function formatAbsoluteTime(iso: string): string {
  if (Number.isNaN(new Date(iso).getTime())) return iso;
  return fmtDateTime(iso);
}

function formatDate(iso: string): string {
  if (Number.isNaN(new Date(iso).getTime())) return iso;
  return fmtDateParts(iso, { year: "numeric", month: "short", day: "numeric" });
}

function fresh(iso: string | null | undefined): string {
  if (!iso) return "never";
  return `${formatRelativeTime(iso)} · ${formatAbsoluteTime(iso)}`;
}

function predictionText(p: Prediction): string {
  const now = typeof p.baseline === "number" ? ` · now ${(p.baseline * 100).toFixed(1)} per 100` : "";
  const mde = p.mde_pct != null ? ` · changes under ${p.mde_pct}% are noise` : "";
  return `Predicts ${p.metric} ${p.direction} ${p.size_pct}% by ${p.due}, p ${p.p}${now}${mde}`;
}

function pct(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "–";
  return `${Math.round((n <= 1 ? n * 100 : n) * 10) / 10}%`;
}

function num(n: number | null | undefined, digits = 2): string {
  if (n == null || Number.isNaN(n)) return "–";
  return n.toFixed(digits);
}

function compact(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function excerpt(s: string, max = 400): string {
  if (!s) return "";
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** A future time in words: "in 2 days", "in 5 hours", "in 20 minutes". */
function untilWords(iso: string): string {
  const mins = Math.max(0, Math.round((new Date(iso).getTime() - Date.now()) / 60000));
  const [n, unit] = mins >= 2880 ? [Math.round(mins / 1440), "day"] : mins >= 120 ? [Math.round(mins / 60), "hour"] : [mins, "minute"];
  return `in ${n} ${unit}${n === 1 ? "" : "s"}`;
}

/** When a scheduled review runs next: "Monday 06:50, in 2 days"; a run a week or more away names its date. */
function nextRunText(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const far = d.getTime() - Date.now() > 6 * 86_400_000;
  const when = `${fmtDateParts(d, { weekday: "long", ...(far ? { day: "numeric", month: "long" } : {}) })} ${fmtClock(d)}`;
  return `${when}, ${untilWords(iso)}`;
}

/**
 * The page's quiet state: one compact line in a panel, so an empty section reads as a fact rather than a blank
 * band (ISC-92). Same register as the Detector check line and Vigil's "All quiet. Nothing needs you."
 */
function QuietLine({ children, sub, icon: Icon = Check }: { children: React.ReactNode; sub?: React.ReactNode; icon?: typeof Check }) {
  return (
    <Panel className="py-3 flex items-start gap-2.5 min-w-0">
      <Icon size={14} className="text-ink-3 shrink-0 mt-[4px]" aria-hidden />
      <p className="text-sm text-ink-2 leading-snug min-w-0 break-words" data-part="quiet">
        {children}
        {sub && <span className="text-ink-3"> {sub}</span>}
      </p>
    </Panel>
  );
}

async function postJson(url: string, body: unknown): Promise<any> {
  let text = "";
  let status = 0;
  try {
    text = await apiFetch<string>(url, { method: "POST", body: JSON.stringify(body), parse: "text" });
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    text = e.body;
    status = e.status;
  }
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON body */
  }
  if (status || (json && json.error)) {
    throw new Error((json && json.error) || `HTTP ${status}`);
  }
  return json;
}

export default function ReviewPage() {
  const { data: reviewData, error: reviewError, refetch: fetchData } = useApi<ReviewResponse>("/api/review");
  const data = reviewData ?? null;
  const error = reviewError ? String(reviewError) : null;
  const [refreshing, setRefreshing] = useState(false);
  // Result of a decision, keyed by rec id, shown on the card after the POST.
  const [decisions, setDecisions] = useState<Record<string, Rec>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [rowError, setRowError] = useState<Record<string, string>>({});
  const [removedLabels, setRemovedLabels] = useState<Record<string, boolean>>({});
  // Queue view state: source filter, how many rows are showing, and rows acted on this visit.
  const [sourceFilter, setSourceFilter] = useState<string>("all");
  const [queueShown, setQueueShown] = useState(PAGE_SIZE);
  const [appliedShown, setAppliedShown] = useState(PAGE_SIZE);
  const [closedShown, setClosedShown] = useState(PAGE_SIZE);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  // Detail per queue row, fetched when Detail opens: the payload for the list stays small.
  const [details, setDetails] = useState<Record<string, QueueDetail | "loading" | "error">>({});
  const openDetail = async (id: string) => {
    if (details[id] && details[id] !== "error") return;
    setDetails((m) => ({ ...m, [id]: "loading" }));
    try {
      const d = await apiFetch<QueueDetail>(`/api/review/detail/${encodeURIComponent(id)}`);
      setDetails((m) => ({ ...m, [id]: d }));
    } catch {
      setDetails((m) => ({ ...m, [id]: "error" }));
    }
  };
  const [queueDone, setQueueDone] = useState<Record<string, "accepted" | "rejected">>({});

  const handleRefresh = async () => {
    setRefreshing(true);
    setDecisions({});
    setRemovedLabels({});
    setQueueDone({});
    await fetchData();
    setRefreshing(false);
  };

  const handleDecide = async (id: string, decision: "y" | "n") => {
    setBusy((b) => ({ ...b, [id]: true }));
    setRowError((r) => {
      const { [id]: _drop, ...rest } = r;
      return rest;
    });
    try {
      const note = (notes[id] || "").trim();
      const res = await postJson("/api/review/decide", {
        id,
        decision,
        ...(note ? { note } : {}),
      });
      if (res?.rec) setDecisions((d) => ({ ...d, [id]: res.rec as Rec }));
    } catch (e) {
      setRowError((r) => ({ ...r, [id]: String((e as Error).message || e) }));
    } finally {
      setBusy((b) => ({ ...b, [id]: false }));
    }
  };

  const handleLabel = async (id: string, right: boolean) => {
    setBusy((b) => ({ ...b, [id]: true }));
    setRowError((r) => {
      const { [id]: _drop, ...rest } = r;
      return rest;
    });
    try {
      await postJson("/api/review/label", { id, right });
      setRemovedLabels((m) => ({ ...m, [id]: true }));
    } catch (e) {
      setRowError((r) => ({ ...r, [id]: String((e as Error).message || e) }));
    } finally {
      setBusy((b) => ({ ...b, [id]: false }));
    }
  };

  const handleQueue = async (item: QueueItem, verb: "accept" | "reject") => {
    let note: string | undefined;
    if (verb === "accept") {
      const ok = window.confirm(
        item.source === "autonomous"
          ? "Graduate this hypothesis to its target frame?"
          : "Accept this upgrade? It moves to accepted and waits for implementation (apply happens via the ledger flow)."
      );
      if (!ok) return;
    } else {
      note = window.prompt("Reject reason (optional):") ?? "";
    }
    setBusy((b) => ({ ...b, [item.id]: true }));
    setRowError((r) => {
      const { [item.id]: _drop, ...rest } = r;
      return rest;
    });
    try {
      await postJson(`/api/upgrades/${encodeURIComponent(item.id)}/${verb}`, { note: note || undefined });
      setQueueDone((m) => ({ ...m, [item.id]: verb === "accept" ? "accepted" : "rejected" }));
    } catch (e) {
      setRowError((r) => ({ ...r, [item.id]: String((e as Error).message || e) }));
    } finally {
      setBusy((b) => ({ ...b, [item.id]: false }));
    }
  };

  if (error) {
    return (
      <PageShell>
        <div className="text-warn text-sm">
          Couldn&apos;t reach Review API: {error}
        </div>
      </PageShell>
    );
  }

  if (!data) {
    return (
      <PageShell>
        <div className="text-ink-3 text-sm">Loading…</div>
      </PageShell>
    );
  }

  const open = data.open ?? [];
  const decided = data.decided ?? [];
  const alarms = data.alarms ?? [];
  const watches = data.watches ?? [];
  const labels = (data.labels ?? []).filter((l) => !removedLabels[l.id]);
  const queue = (data.queue ?? []).filter((q) => queueDone[q.id] !== "rejected");
  const applied = data.applied ?? [];
  const closed = data.closed ?? [];
  const closedTotal = Math.max(data.closed_total ?? 0, closed.length);
  const sourceCounts = queue.reduce<Record<string, number>>((m, q) => ((m[q.source] = (m[q.source] ?? 0) + 1), m), {});
  const sources = Object.entries(sourceCounts).sort((a, b) => b[1] - a[1]);
  const queueShownItems = queue.filter((q) => sourceFilter === "all" || q.source === sourceFilter);
  const asOf = data.as_of ?? {
    exchanges: null,
    complaints: null,
    coverage: null,
    turns: null,
  };
  const runs = asOf.review_runs ?? {};
  const healthKnown = !!data.health && Object.keys(data.health).length > 0;
  const badInstruments = Object.entries(data.health ?? {}).filter(
    ([, state]) => state !== "ok" && state !== "never"
  );

  const asOfRows: Array<[string, string | null | undefined]> = [
    ["Exchanges", asOf.exchanges],
    ["Complaints", asOf.complaints],
    ["Coverage", asOf.coverage],
    ["Turns", asOf.turns],
    ["Daily review", runs.daily],
    ["Weekly review", runs.weekly],
    ["Monthly review", runs.monthly],
  ];

  const subtitle =
    (open.length > 0
      ? `${open.length} open decision${open.length === 1 ? "" : "s"}`
      : "No open decisions") + ` · ${queue.length} queued · ${applied.length} applied`;

  return (
    <PageShell>
      <PageHeader
        icon={ClipboardCheck}
        title="Review"
        subtitle={subtitle}
        actions={
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            className="px-3 py-1.5 text-xs font-medium rounded-md transition-colors flex items-center gap-1.5"
            style={dimStyle("ok", true)}
          >
            <RefreshCw size={12} className={refreshing ? "animate-spin" : ""} />
            {refreshing ? "Refreshing…" : "Refresh"}
          </button>
        }
      />

      {/* Open decisions */}
      <section className="flex flex-col gap-3">
        <PanelHeader
          icon={Target}
          title="Decide this week"
          meta={<Pill dim="blue">{open.length}</Pill>}
        />
        {open.length === 0 && (
          <div data-part="decide-empty">
            <QuietLine
              sub={
                data.next_runs?.weekly
                  ? `The next weekly review runs ${nextRunText(data.next_runs.weekly)}.`
                  : "New decisions appear here after the weekly review."
              }
            >
              Nothing is waiting on you.
            </QuietLine>
          </div>
        )}
        <div className={open.length ? "grid gap-3" : "hidden"}>
          {open.map((rec) => {
            const result = decisions[rec.id];
            const shown = result ?? rec;
            const isDone = !!result && result.status !== "open";
            return (
              <Panel
                key={rec.id}
                className="space-y-3 min-w-0"
                style={{
                  borderLeftWidth: "3px",
                  borderLeftColor:
                    shown.status === "accepted"
                      ? "var(--ok)"
                      : shown.status === "dismissed"
                        ? "var(--ink-3)"
                        : `var(--${fixTypeDim[rec.fix_type] === "neutral" ? "ink-2" : fixTypeDim[rec.fix_type] === "blue" ? "accent-blue" : fixTypeDim[rec.fix_type]})`,
                }}
              >
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div className="font-medium text-sm text-ink-1 min-w-0 break-words flex-1">
                    {rec.title}
                    <div className="text-[11px] text-ink-3 font-normal mt-0.5">proposed {formatRelativeTime(rec.created)} · from {(rec.generators ?? []).join(", ") || "review"}</div>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    {rec.kind === "deletion" ? <Pill dim="err">deletion</Pill> : <Pill dim={fixTypeDim[rec.fix_type]}>{rec.fix_type}</Pill>}
                  </div>
                </div>

                <div className="text-xs text-ink-2 leading-relaxed break-words whitespace-pre-wrap">
                  {rec.change}
                </div>

                {rec.prediction ? (
                  <div className="text-xs text-ink-1 break-words">
                    {predictionText(rec.prediction)}
                  </div>
                ) : rec.kind === "deletion" ? (
                  <div className="text-xs text-ink-3 break-words">
                    No prediction: a deletion is judged by whether anything misses what it removed.
                  </div>
                ) : null}

                {rec.evidence && rec.evidence.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {rec.evidence.map((ev, i) => (
                      <span
                        key={`${ev}-${i}`}
                        className="mono inline-block max-w-[18rem] truncate px-2 py-0.5 text-[11px] rounded-md bg-surface-3 border border-line-1 text-ink-2"
                        title={ev}
                      >
                        {ev}
                      </span>
                    ))}
                  </div>
                )}

                {isDone ? (
                  <div className="flex items-center gap-2 flex-wrap pt-1">
                    <Pill dim={statusDim[shown.status]}>
                      {shown.status === "accepted" ? (
                        <Check size={12} />
                      ) : (
                        <X size={12} />
                      )}
                      {shown.status}
                    </Pill>
                    {shown.upgrade_id && (
                      <span className="text-xs text-ink-2">
                        Upgrade{" "}
                        <span className="mono text-ink-1">{shown.upgrade_id}</span>
                      </span>
                    )}
                    {shown.note && (
                      <span className="text-xs text-ink-3 break-words">
                        {shown.note}
                      </span>
                    )}
                  </div>
                ) : (
                  <div className="flex flex-wrap items-center gap-2 pt-1">
                    <input
                      type="text"
                      value={notes[rec.id] ?? ""}
                      onChange={(e) =>
                        setNotes((n) => ({ ...n, [rec.id]: e.target.value }))
                      }
                      placeholder="Note (optional)"
                      aria-label={`Note for ${rec.title}`}
                      className="flex-1 min-w-[10rem] px-2.5 py-1.5 text-xs rounded-md bg-surface-3 border border-line-1 text-ink-1 placeholder:text-ink-3"
                    />
                    <button
                      onClick={() => handleDecide(rec.id, "y")}
                      disabled={!!busy[rec.id]}
                      className="px-4 py-1.5 text-xs font-medium rounded-md transition-colors flex items-center gap-1.5 min-h-[34px]"
                      style={dimStyle("ok", true)}
                    >
                      <Check size={12} />
                      Yes
                    </button>
                    <button
                      onClick={() => handleDecide(rec.id, "n")}
                      disabled={!!busy[rec.id]}
                      className="px-4 py-1.5 text-xs font-medium rounded-md transition-colors flex items-center gap-1.5 min-h-[34px]"
                      style={dimStyle("warn", true)}
                    >
                      <X size={12} />
                      No
                    </button>
                    <div className="basis-full text-[11px] text-ink-3">Yes files one Upgrades record to act on; nothing in the system changes until that record is applied.</div>
                  </div>
                )}

                {rowError[rec.id] && (
                  <div className="text-warn text-xs break-words">
                    {rowError[rec.id]}
                  </div>
                )}
              </Panel>
            );
          })}
        </div>
      </section>

      {/* Queue: every recommended Upgrades record, filtered by source */}
      <section className="flex flex-col gap-3">
        <PanelHeader
          icon={Inbox}
          title="Queue"
          meta={<Pill dim="blue">{queue.length}</Pill>}
        />
        <p className="text-[13px] text-ink-3 leading-snug -mt-1">
          Every proposal not yet decided. The weekly review picks at most three of these for Decide this week; you can also accept or reject any row here.
        </p>
        {/* On a phone the source filter is one select; the chip row wraps to four lines there. */}
        <label className="sm:hidden flex items-center gap-2 text-xs text-ink-3">
          source
          <select
            value={sourceFilter}
            onChange={(e) => {
              setSourceFilter(e.target.value);
              setQueueShown(PAGE_SIZE);
            }}
            className="flex-1 min-w-0 px-2.5 py-1.5 text-xs rounded-md bg-surface-3 border border-line-1 text-ink-1"
          >
            {[["all", queue.length] as [string, number], ...sources].map(([id, n]) => (
              <option key={id} value={id}>
                {id === "all" ? "All" : SOURCE_LABEL[id] ?? id} ({n})
              </option>
            ))}
          </select>
        </label>
        <div className="hidden sm:flex items-center gap-1.5 flex-wrap">
          <span className="text-xs text-ink-3 mr-1">source</span>
          {[["all", queue.length] as [string, number], ...sources].map(([id, n]) => (
            <button
              key={id}
              onClick={() => {
                setSourceFilter(id);
                setQueueShown(PAGE_SIZE);
              }}
              aria-pressed={sourceFilter === id}
              className={`flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-full transition-colors ${
                sourceFilter === id
                  ? "text-ink-1 bg-surface-3 border border-line-1"
                  : "text-ink-3 hover:text-ink-1 border border-transparent"
              }`}
            >
              {id === "all" ? "All" : SOURCE_LABEL[id] ?? id} <span className="mono">{n}</span>
            </button>
          ))}
        </div>
        {queueShownItems.length === 0 ? (
          <QuietLine icon={Inbox} sub="Directives, corrections, scans and Review's own yes decisions land here.">
            Nothing queued.
          </QuietLine>
        ) : (
          <Panel className="p-0 divide-y divide-line-1">
            {queueShownItems.slice(0, queueShown).map((item) => {
              const done = queueDone[item.id] as "accepted" | "rejected" | undefined;
              const isCoach = item.source === "coach" && !!item.quote;
              const soon = item.expires_in_days !== null && item.expires_in_days < 7;
              const isOpen = !!expanded[item.id];
              const state = done ?? item.status;
              return (
                <div
                  key={item.id}
                  data-row="queue"
                  className="px-4 py-3 space-y-2 min-w-0"
                  style={soon && !done ? { boxShadow: "inset 3px 0 0 var(--warn)" } : undefined}
                >
                  {/* Text above, actions beside it from 640px up; on a phone the actions sit below the meta (ISC-95). */}
                  <div className="flex flex-col sm:flex-row sm:items-start gap-2 sm:gap-4 min-w-0">
                  <div className="min-w-0 flex-1 space-y-1.5">
                  <div className={`text-sm text-ink-1 leading-snug break-words ${isOpen ? "" : "line-clamp-2"}`} title={isOpen ? undefined : isCoach ? item.quote : item.claim}>
                    {isCoach ? `“${item.quote}”` : item.claim || item.id}
                  </div>
                  {isCoach && (
                    <div className="text-xs text-ink-2 leading-snug break-words">{item.claim}</div>
                  )}
                  <div data-part="meta" className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs min-w-0">
                    <Pill dim="blue">{SOURCE_LABEL[item.source] ?? item.source}</Pill>
                    {item.category && <Pill dim="warn">{item.category}</Pill>}
                    <Pill dim="ok" title="How confident the source is that this change is right">{Math.round(item.confidence * 100)}% confident</Pill>
                    {state !== "recommended" && (
                      <Pill dim={state === "accepted" ? "ok" : "neutral"}>{state}</Pill>
                    )}
                    {item.source === "coach" && item.recurrence_count > 1 && (
                      <span
                        className="flex items-center gap-1 text-warn font-semibold"
                        title={`This problem came back ${item.recurrence_count} times`}
                      >
                        <Repeat2 size={11} />×{item.recurrence_count}
                      </span>
                    )}
                    {item.has_patch && <Pill dim="warn" className="max-w-full whitespace-normal [overflow-wrap:anywhere]">PATCH → {item.patch_target ?? item.target_surface}</Pill>}
                    {!item.has_patch && item.target_surface !== "unknown" && (
                      <span className="text-ink-3 min-w-0 [overflow-wrap:anywhere]">
                        → <span className="text-ink-2">{item.target_surface}</span>
                      </span>
                    )}
                    {item.evidence_count > 0 && (
                      <span className="text-ink-3">{item.evidence_count} signal{item.evidence_count === 1 ? "" : "s"}</span>
                    )}
                    {item.ledger_id && (
                      <span className="flex items-center gap-1 text-ink-3" title="Ledger id">
                        <ScrollText size={11} />
                        <span className="mono text-ink-2">{item.ledger_id}</span>
                      </span>
                    )}
                    {item.expires_in_days !== null && !done && (
                      <span className={soon ? "text-warn font-semibold" : "text-ink-3"}>
                        expires in {item.expires_in_days}d
                      </span>
                    )}
                    <span className="text-ink-3">{formatRelativeTime(item.created)}</span>
                  </div>
                  </div>
                  <div data-part="actions" className="flex items-center gap-2 shrink-0">
                    {item.status === "recommended" && !done && (
                      <button
                        onClick={() => handleQueue(item, "accept")}
                        disabled={!!busy[item.id]}
                        className="px-3 py-1.5 text-xs font-medium rounded-md transition-colors flex items-center gap-1.5"
                        style={dimStyle("ok", true)}
                      >
                        <Check size={12} />
                        {item.source === "autonomous" ? "Graduate" : "Accept"}
                      </button>
                    )}
                    {!done && (
                      <button
                        onClick={() => handleQueue(item, "reject")}
                        disabled={!!busy[item.id]}
                        className="px-3 py-1.5 text-xs font-medium rounded-md transition-colors flex items-center gap-1.5"
                        style={dimStyle("err", true)}
                      >
                        <X size={12} />
                        Reject
                      </button>
                    )}
                    <button
                      onClick={() => {
                        setExpanded((m) => ({ ...m, [item.id]: !isOpen }));
                        if (!isOpen) void openDetail(item.id);
                      }}
                      className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md text-ink-2 hover:text-ink-1 hover:bg-surface-3 transition-colors ml-auto sm:ml-0"
                    >
                      {isOpen ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                      {isOpen ? "Hide" : "Detail"}
                    </button>
                  </div>
                  </div>
                  {isOpen && (
                    <div className="pt-2 border-t border-line-1 space-y-3 text-xs">
                      {item.recommendation && (
                        <p className="text-ink-2 whitespace-pre-wrap break-words">{(typeof details[item.id] === "object" && (details[item.id] as QueueDetail).recommendation) || item.recommendation}</p>
                      )}
                      {item.proposed_patch && (
                        <div>
                          <div className="text-ink-3 uppercase tracking-wide text-[11px] mb-1">
                            Proposed patch (accepting applies it)
                          </div>
                          <pre className="text-ink-2 mono text-[11px] leading-snug whitespace-pre-wrap break-words max-h-80 overflow-y-auto p-2 rounded bg-surface-3 border border-line-1">
                            {item.proposed_patch}
                          </pre>
                        </div>
                      )}
                      {details[item.id] === "loading" && <div className="text-ink-3">Loading detail…</div>}
                      {details[item.id] === "error" && <div className="text-warn">Detail could not be loaded.</div>}
                      {typeof details[item.id] === "object" && (() => {
                        const d = details[item.id] as QueueDetail;
                        const label = "text-ink-3 uppercase tracking-wide text-[11px] mb-1";
                        return (
                          <>
                            {d.current_state && (
                              <div>
                                <div className={label}>Current state</div>
                                <p className="text-ink-2 whitespace-pre-wrap break-words">{d.current_state}</p>
                              </div>
                            )}
                            {d.falsifier && (
                              <div>
                                <div className={label}>Falsifier</div>
                                <p className="text-ink-2 break-words">{d.falsifier}</p>
                              </div>
                            )}
                            {d.evidence.length > 0 && (
                              <div>
                                <div className={label}>Evidence</div>
                                <ul className="space-y-0.5 text-ink-2 mono">
                                  {d.evidence.map((e, i) => (
                                    <li key={`${i}-${e}`} className="break-words">{e}</li>
                                  ))}
                                </ul>
                                {d.evidence_more > 0 && <div className="text-ink-3 mt-0.5">and {d.evidence_more} more</div>}
                              </div>
                            )}
                            {d.notes.length > 0 && (
                              <div>
                                <div className={label}>History</div>
                                <ul className="space-y-0.5 text-ink-3 mono text-[11px]">
                                  {d.notes.map((n, i) => (
                                    <li key={`${i}-${n}`} className="break-words">{n}</li>
                                  ))}
                                </ul>
                              </div>
                            )}
                          </>
                        );
                      })()}
                    </div>
                  )}
                  {rowError[item.id] && (
                    <div className="text-warn text-xs break-words">{rowError[item.id]}</div>
                  )}
                </div>
              );
            })}
          </Panel>
        )}
        {queueShownItems.length > queueShown && (
          <button
            onClick={() => setQueueShown((n) => n + PAGE_SIZE)}
            className="self-start px-3 py-1.5 text-xs font-medium rounded-md text-ink-2 hover:text-ink-1 hover:bg-surface-3 border border-line-1 transition-colors"
          >
            Show {Math.min(PAGE_SIZE, queueShownItems.length - queueShown)} more of {queueShownItems.length - queueShown} left
          </button>
        )}
      </section>

      {/* Applied: each applied or verified change with its Ledger id and watch verdict */}
      <section className="flex flex-col gap-3">
        <PanelHeader
          icon={ListChecks}
          title="Applied"
          meta={<Pill dim="ok">{applied.length}</Pill>}
        />
        {applied.length === 0 ? (
          <QuietLine icon={ListChecks}>Nothing applied yet.</QuietLine>
        ) : (
          <Panel className="p-0 divide-y divide-line-1">
            {applied.slice(0, appliedShown).map((a) => {
              const sentence = a.verdict_sentence ?? "No verdict yet.";
              const outcome = OUTCOME[a.verdict_kind ?? "too-early"];
              return (
                <div key={a.id} data-row="applied" className="px-4 py-3 space-y-1.5 min-w-0">
                  <div className="text-sm text-ink-1 leading-snug break-words line-clamp-2" title={a.claim}>{a.claim}</div>
                  {/* The outcome leads the row: a glance label, then the sentence with its number (ISC-89, ISC-90). */}
                  <div className="flex items-start gap-2 text-[13px] leading-snug min-w-0">
                    <Pill dim={outcome.dim} className="shrink-0">{outcome.label}</Pill>
                    <span data-part="verdict" className={`min-w-0 break-words pt-px ${a.verdict_kind === "worse" ? "text-ink-1" : "text-ink-2"}`}>
                      {sentence}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-3 min-w-0">
                    <span>{a.status}</span>
                    <span>{SOURCE_LABEL[a.source] ?? a.source}</span>
                    {a.ledger_id && (
                      <span className="flex items-center gap-1 min-w-0" title="Ledger id">
                        <ScrollText size={11} className="shrink-0" />
                        <span className="mono text-ink-2 [overflow-wrap:anywhere]">{a.ledger_id}</span>
                      </span>
                    )}
                    <span title={formatAbsoluteTime(a.created)}>{formatRelativeTime(a.created)}</span>
                  </div>
                </div>
              );
            })}
          </Panel>
        )}
        {applied.length > appliedShown && (
          <button
            onClick={() => setAppliedShown((n) => n + PAGE_SIZE)}
            className="self-start px-3 py-1.5 text-xs font-medium rounded-md text-ink-2 hover:text-ink-1 hover:bg-surface-3 border border-line-1 transition-colors"
          >
            Show {Math.min(PAGE_SIZE, applied.length - appliedShown)} more of {applied.length - appliedShown} left
          </button>
        )}
      </section>

      {/* Closed: rejected and expired records, collapsed; newest first, paged like the queue */}
      <section className="flex flex-col gap-3">
        <details className="group">
          <summary className="cursor-pointer list-none">
            <PanelHeader
              icon={XCircle}
              title="Closed"
              meta={<Pill dim="neutral">{closedTotal}</Pill>}
              className="mb-0"
            />
          </summary>
          <div className="mt-3 flex flex-col gap-3">
            {closed.length === 0 ? (
              <QuietLine icon={XCircle}>Nothing rejected or expired yet.</QuietLine>
            ) : (
              <Panel className="p-0 divide-y divide-line-1">
                {closed.slice(0, closedShown).map((c) => (
                  <div key={c.id} data-row="closed" className="px-4 py-3 space-y-1.5 min-w-0">
                    <div className="text-sm text-ink-1 leading-snug break-words line-clamp-2" title={c.claim}>
                      {c.source === "coach" && c.quote ? `“${c.quote}”` : c.claim || c.id}
                    </div>
                    {c.source === "coach" && c.quote && (
                      <div className="text-xs text-ink-2 leading-snug break-words">{c.claim}</div>
                    )}
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                      <Pill dim={c.status === "rejected" ? "err" : "warn"}>{c.status}</Pill>
                      <Pill dim="neutral">{SOURCE_LABEL[c.source] ?? c.source}</Pill>
                      {c.category && <Pill dim="warn">{c.category}</Pill>}
                      {c.source === "coach" && c.recurrence_count > 1 && (
                        <span className="flex items-center gap-1 text-warn font-semibold">
                          <Repeat2 size={11} />×{c.recurrence_count}
                        </span>
                      )}
                      {c.target_surface !== "unknown" && (
                        <span className="text-ink-3 min-w-0 [overflow-wrap:anywhere]">
                          → <span className="text-ink-2">{c.target_surface}</span>
                        </span>
                      )}
                      <span className="text-ink-3" title={c.closed_at ? formatAbsoluteTime(c.closed_at) : "No closing note carries a time"}>
                        {c.closed_at ? `closed ${formatRelativeTime(c.closed_at)}` : "closed, date unknown"}
                      </span>
                    </div>
                    <div data-part="reason" className="text-xs text-ink-2 truncate" title={c.reason ?? c.note}>
                      {c.reason ?? c.note}
                    </div>
                  </div>
                ))}
              </Panel>
            )}
            {closed.length > closedShown && (
              <button
                onClick={() => setClosedShown((n) => n + PAGE_SIZE)}
                className="self-start px-3 py-1.5 text-xs font-medium rounded-md text-ink-2 hover:text-ink-1 hover:bg-surface-3 border border-line-1 transition-colors"
              >
                Show {Math.min(PAGE_SIZE, closed.length - closedShown)} more of {closed.length - closedShown} left
              </button>
            )}
            {closedTotal > closed.length && (
              <div className="text-[11px] text-ink-3">
                Showing the newest {closed.length} of {closedTotal} closed records.
              </div>
            )}
          </div>
        </details>
      </section>

      {/* Instruments */}
      <section className="flex flex-col gap-3">
        <PanelHeader
          icon={Gauge}
          title="Instruments"
          meta={
            badInstruments.length > 0 ? (
              <Pill dim="err">{badInstruments.length}</Pill>
            ) : undefined
          }
        />
        <Panel className="space-y-2">
          {!healthKnown ? (
            <div className="text-xs text-ink-2">
              No daily run yet — first run 07:00
            </div>
          ) : badInstruments.length === 0 ? (
            <div className="text-xs text-ink-2 flex items-center gap-2">
              <Check size={14} className="text-ok" />
              all instruments ok
            </div>
          ) : (
            badInstruments.map(([id, state]) => (
              <div
                key={id}
                className="flex items-center justify-between gap-3 text-xs"
              >
                <span className="mono text-ink-1 break-all min-w-0">{id}</span>
                <Pill dim={state === "failing" ? "err" : "warn"}>{state}</Pill>
              </div>
            ))
          )}
        </Panel>
      </section>

      {/* As of */}
      <section className="flex flex-col gap-3">
        <PanelHeader icon={Clock} title="As of" />
        <Panel>
          <div className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
            {asOfRows.map(([label, iso]) => (
              <div
                key={label}
                className="flex items-baseline justify-between gap-3 text-xs min-w-0"
              >
                <span className="text-ink-3 shrink-0">{label}</span>
                <span className="text-ink-1 text-right break-words min-w-0">
                  {fresh(iso)}
                </span>
              </div>
            ))}
          </div>
        </Panel>
      </section>

      {/* Recent alarms */}
      {alarms.length > 0 && (
        <section className="flex flex-col gap-3">
          <PanelHeader
            icon={AlertTriangle}
            title="Recent alarms"
            meta={<Pill dim="warn">{alarms.length}</Pill>}
          />
          <div className="grid gap-3">
            {alarms.map((a, i) => (
              <Panel key={`${a.rule}-${a.date}-${i}`} className="space-y-1.5">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="mono text-sm text-ink-1 break-all">
                    {a.rule}
                  </span>
                  {a.class && <Pill dim="warn">{a.class}</Pill>}
                  <span className="text-xs text-ink-3">{formatDate(a.date)}</span>
                </div>
                {a.detail && (
                  <div className="text-xs text-ink-2 break-words">{a.detail}</div>
                )}
                {a.value != null && (
                  <div className="text-xs text-ink-3 mono break-all">
                    value {compact(a.value)}
                  </div>
                )}
                {a.suspects && a.suspects.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 pt-1">
                    {a.suspects.map((s) => (
                      <span
                        key={s}
                        className="mono px-2 py-0.5 text-[11px] rounded-md bg-surface-3 border border-line-1 text-ink-2 [overflow-wrap:anywhere]"
                      >
                        {s}
                      </span>
                    ))}
                  </div>
                )}
              </Panel>
            ))}
          </div>
        </section>
      )}

      {/* Watches */}
      {watches.length > 0 && (
        <section className="flex flex-col gap-3">
          <PanelHeader
            icon={Eye}
            title="Watches"
            meta={<Pill dim="blue">{watches.length}</Pill>}
          />
          <Panel className="p-0 divide-y divide-line-1">
            {watches.map((w) => (
              <div key={w.id} data-row="watch" className="px-4 py-3 space-y-1.5 min-w-0">
                <div className="flex items-start justify-between gap-3 min-w-0">
                  <div className="text-sm text-ink-1 leading-snug break-words min-w-0 flex-1">
                    {w.label}
                  </div>
                  <Pill dim={OUTCOME[w.outcome ?? "too-early"].dim} className="shrink-0">
                    {OUTCOME[w.outcome ?? "too-early"].label}
                  </Pill>
                </div>
                <div data-part="verdict" className="text-[13px] text-ink-2 leading-snug break-words">
                  {w.sentence ?? (w.result != null ? "Measured." : "Not measured yet.")}
                </div>
                <div className="text-xs text-ink-3" title={formatAbsoluteTime(w.cut)}>
                  Changed {formatRelativeTime(w.cut)} · {w.days}-day window
                </div>
              </div>
            ))}
          </Panel>
        </section>
      )}

      {/* Scorecard */}
      <section className="flex flex-col gap-3">
        <PanelHeader
          icon={Target}
          title="Scorecard"
          meta={data.scorecard ? data.scorecard.month : undefined}
        />
        {data.scorecard && (data.scorecard.card ?? []).length > 0 ? (
          <Panel className="overflow-x-auto p-0">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-ink-3 text-left">
                  {[
                    "Generator",
                    "Recommended",
                    "Accepted",
                    "Applied",
                    "Verified",
                    "Hit rate",
                    "Brier",
                  ].map((h, i) => (
                    <th
                      key={h}
                      className={`px-3 py-2 font-semibold whitespace-nowrap ${i > 0 ? "text-right" : ""}`}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.scorecard.card.map((row) => (
                  <tr key={row.generator} className="border-t border-line-1">
                    <td className="px-3 py-2 mono text-ink-1 whitespace-nowrap">
                      {row.generator}
                    </td>
                    <td className="px-3 py-2 text-right text-ink-2">
                      {row.recommended}
                    </td>
                    <td className="px-3 py-2 text-right text-ink-2">
                      {row.accepted}
                    </td>
                    <td className="px-3 py-2 text-right text-ink-2">
                      {row.applied}
                    </td>
                    <td className="px-3 py-2 text-right text-ink-2">
                      {row.verified}
                    </td>
                    <td className="px-3 py-2 text-right text-ink-1">
                      {pct(row.hit_rate)}
                    </td>
                    <td className="px-3 py-2 text-right text-ink-1">
                      {num(row.brier)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="px-3 py-2 border-t border-line-1 text-[11px] text-ink-3">
              Card cut {fresh(data.scorecard.ts)}
            </div>
          </Panel>
        ) : (
          <QuietLine
            icon={Target}
            sub={
              data.next_runs?.monthly
                ? `The first monthly review runs ${nextRunText(data.next_runs.monthly)}.`
                : "The first monthly scorecard arrives on the 1st."
            }
          >
            No scorecard yet.
          </QuietLine>
        )}
      </section>

      {/* Detector check */}
      <section className="flex flex-col gap-3">
        <PanelHeader
          icon={ScanSearch}
          title="Detector check"
          meta={labels.length > 0 ? <Pill dim="blue">{labels.length}</Pill> : undefined}
        />
        {labels.length === 0 ? (
          <QuietLine icon={ScanSearch}>Nothing to label.</QuietLine>
        ) : (
          <div className="grid gap-3">
            {labels.map((l) => (
              <Panel key={l.id} className="space-y-2 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-xs text-ink-3">Detector says</span>
                  <Pill dim={l.detector === "failure" ? "err" : "ok"}>
                    {l.detector}
                  </Pill>
                  <span className="text-xs text-ink-3">{fresh(l.ts)}</span>
                </div>
                <div className="space-y-1">
                  <div className="text-[11px] uppercase tracking-wide text-ink-3">
                    Prompt
                  </div>
                  <div className="text-xs text-ink-2 break-words whitespace-pre-wrap">
                    {excerpt(l.prompt)}
                  </div>
                </div>
                <div className="space-y-1">
                  <div className="text-[11px] uppercase tracking-wide text-ink-3">
                    Reply
                  </div>
                  <div className="text-xs text-ink-2 break-words whitespace-pre-wrap">
                    {excerpt(l.reply)}
                  </div>
                </div>
                <div className="flex flex-wrap gap-2 pt-1">
                  <button
                    onClick={() => handleLabel(l.id, true)}
                    disabled={!!busy[l.id]}
                    className="px-3 py-1.5 text-xs font-medium rounded-md transition-colors min-h-[34px]"
                    style={dimStyle("ok", true)}
                  >
                    Detector right
                  </button>
                  <button
                    onClick={() => handleLabel(l.id, false)}
                    disabled={!!busy[l.id]}
                    className="px-3 py-1.5 text-xs font-medium rounded-md transition-colors min-h-[34px]"
                    style={dimStyle("warn", true)}
                  >
                    Detector wrong
                  </button>
                </div>
                {rowError[l.id] && (
                  <div className="text-warn text-xs break-words">
                    {rowError[l.id]}
                  </div>
                )}
              </Panel>
            ))}
          </div>
        )}
      </section>

      {/* Recently decided */}
      {decided.length > 0 && (
        <section className="flex flex-col gap-3">
          <details className="group">
            <summary className="cursor-pointer list-none">
              <PanelHeader
                icon={History}
                title="Recently decided"
                meta={<Pill dim="neutral">{decided.length}</Pill>}
                className="mb-0"
              />
            </summary>
            <Panel className="mt-3 space-y-2">
              {decided.map((r) => (
                <div
                  key={r.id}
                  className="flex items-start justify-between gap-3 text-xs"
                >
                  <span className="text-ink-1 break-words min-w-0 flex-1">
                    {r.title}
                  </span>
                  <span className="flex items-center gap-2 shrink-0">
                    <Pill dim={statusDim[r.status]}>{r.status}</Pill>
                    <span className="text-ink-3 whitespace-nowrap">
                      {formatDate(r.decided ?? r.created)}
                    </span>
                  </span>
                </div>
              ))}
            </Panel>
          </details>
        </section>
      )}
    </PageShell>
  );
}
