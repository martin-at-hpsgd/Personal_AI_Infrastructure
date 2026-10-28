"use client";
/** Vigil — the monitoring layer's own instrument. @version 0.7.0
 *
 * Reading order IS the design (Direction.md v3, council of four, 2026-09-24):
 *   is it alive and what needs me (one verdict sentence) → what arrived (one stream,
 *   events and routing decisions; the principal asked for it on top, 2026-09-24) → who
 *   fell silent (the roll call of every emitter)
 *   → the breakdowns, one tab each (activity, timeline, routing, ticks, store, raw).
 *
 * The page polls every 2 s; tick age and the countdown move every second.
 *
 * The theme sans for every sentence, name and label; mono only for figures, times
 * and ids. Colour only where it carries state. Sort, not colour, is the primary signal.
 *
 * The page codes against the /api/vigil v2 contract and degrades honestly.
 * A field the API does not serve is named as missing — never faked, never
 * crashed over. Where a band can be rebuilt from data that IS present (the
 * raw event list), the band says so in its own footnote rather than passing
 * a derivation off as the real thing.
 */

import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { PageHeader, PageShell, Pill, type Dim } from "@/components/ui/chrome";
import { useApi } from "@/lib/api";
import { fmtClock, fmtDateTime, zonedHour } from "@/lib/time";

/* ──────────────────────────── contract ──────────────────────────── */

type EmitterState = "never" | "error" | "quiet" | "watching" | "live";

interface VEvent {
  id?: string; ts: string; source: string; kind: string; severity: string;
  title?: string; summary?: string; ref?: string | null; dedup_key?: string;
  meta?: { state_inputs?: StateInputs } | null;
}
interface Store { configured?: boolean; reachable?: boolean; rows?: number | null; checked_at?: string | null; latency_ms?: number | null; query_ms?: number | null; rows_1h?: number | null; rows_24h?: number | null; oldest_ts?: string | null; newest_ts?: string | null; db_size_bytes?: number | null; emitters?: number | null; events_per_minute_1h?: number | null; events_per_minute_24h?: number | null }
interface Database { store?: Store | null; probes?: Array<{ ts: string; ok: boolean; latency_ms: number | null; query_ms: number | null; rows: number | null }> | null; outbox?: { rows?: number | null; rows_1h?: number | null; rows_24h?: number | null; bytes?: number | null; oldest_ts?: string | null; newest_ts?: string | null; pulled_rows?: number | null } | null; api?: { compose_ms?: number | null; cached?: boolean | null } | null }
interface Health {
  tick_age_minutes?: number | null; tick_stale?: boolean; tick_reason?: string | null;
  runs_24h?: number | null; expected_runs_24h?: number | null; store?: Store | null;
  texts_24h?: number | null; text_ceiling?: number | null; digest_pending?: number | null;
  held_24h?: number | null; failed_24h?: number | null;
}
interface ApiEmitter {
  source: string; state?: EmitterState; count_1h?: number | null; count_24h?: number | null;
  per_hour?: number | null; last_age_minutes?: number | null; expected_cadence_minutes?: number | null;
  last_read?: { ok?: boolean; ts?: string | null; error?: string | null } | null;
  tempo_24h?: number[] | null;
}
interface Bucket { hour_start: string; info?: number; low?: number; medium?: number; high?: number; critical?: number }
type StateInputs = Record<string, { read?: boolean; age_minutes?: number | null }>;
interface LedgerRow {
  ts: string; decision?: string; reason?: string | null;
  event?: { id?: string; source?: string; severity?: string; title?: string } | null;
  state_inputs?: StateInputs | null;
}
interface LegacySource {
  source: string; count_1h: number; count_24h: number; per_hour: number;
  last_age_minutes: number; expected_cadence_minutes: number | null; quiet: boolean;
}
/** The strip above the verdict. Every figure is computed by /api/vigil; the page only formats. */
interface Stats {
  window?: { start?: string; end?: string; minutes?: number } | null;
  per_minute_60?: number[] | null; peak_per_minute?: number | null;
  count_1h?: number | null; per_hour?: number | null; events_per_minute?: number | null;
  count_24h?: number | null; events_per_minute_24h?: number | null; events_per_hour_24h?: number | null;
  emitters?: { reading_cleanly?: number | null; registered?: number | null } | null;
  busiest_24h?: { source: string; count: number; share?: number | null } | null;
  last_event?: { ts: string; source: string; age_minutes: number } | null;
}
/** One adapter's read on one tick (ISC-65). */
interface Ping { name: string; ok: boolean; error?: string; events: number; ms: number }
/** A tick row. Ticks recorded before ISC-65 carry only ts, so pings is null. */
interface PingTick {
  ts: string; duration_ms?: number | null; collected?: number | null; routed?: number | null;
  baseline?: boolean; dry_run?: boolean; error?: string | null; pings?: Ping[] | null;
}
interface Pings { interval_seconds?: number | null; registered?: string[] | null; ticks?: PingTick[] | null }
interface KindRow { kind: string; count_1h: number; count_24h: number; by_severity_24h?: Record<string, number> | null; last_ts?: string | null }
type Decision3 = "sent" | "held" | "failed";
interface Kinds {
  rows?: KindRow[] | null; total_1h?: number | null; total_24h?: number | null;
  notifications?: Partial<Record<Decision3, { count_1h: number; count_24h: number }>> | null;
}
interface FeedRow {
  id: string; ts: string; type: "event" | "notification"; source: string; kind: string; severity: string;
  title: string; summary?: string | null; decision?: Decision3 | null; reason?: string | null;
  subject?: { id?: string; source: string; severity: string; kind: string; title: string } | null;
}
interface Clock { last_tick_ts?: string | null; interval_seconds?: number | null; next_at?: string | null; served_at?: string | null }
interface Payload {
  database?: Database | null;
  pings?: Pings | null;
  kinds?: Kinds | null;
  feed?: FeedRow[] | null;
  clock?: Clock | null;
  health?: Health | null;
  stats?: Stats | null;
  emitters?: ApiEmitter[] | null;
  counts?: { by_source?: Record<string, number>; by_severity?: Record<string, number>; by_kind?: Record<string, number> } | null;
  timeline?: Bucket[] | null;
  ledger?: LedgerRow[] | null;
  events?: VEvent[] | null;
  /** Retired by the v2 contract; read only as the emitters fallback. */
  sources?: LegacySource[] | null;
  tick?: { stale?: boolean; age_minutes?: number | null; reason?: string | null } | null;
  digest_pending?: number | null;
  held_24h?: number | null;
}

/* ──────────────────────────── constants ──────────────────────────── */

const HOUR = 3_600_000;
const SELF = "vigil"; // Vigil's own heartbeat: half ink, out of every total.
const SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;
type Severity = (typeof SEVERITIES)[number];

/** Severity ramp, drawn from the status tokens — never a new palette. */
const SEV_COLOR: Record<string, string> = {
  critical: "var(--err)",
  high: "rgba(248,113,113,0.60)",
  medium: "var(--warn)",
  low: "rgba(130,157,187,0.85)",
  info: "rgba(37,139,255,0.70)",
};
const STATE_ORDER: Record<EmitterState, number> = { never: 0, error: 1, quiet: 2, watching: 3, live: 4 };
const STATE_COLOR: Record<EmitterState, string> = {
  never: "var(--err)", error: "var(--err)", quiet: "var(--warn)", watching: "var(--ink-2)", live: "var(--ok)",
};
const DECISION_DIM: Record<string, Dim> = {
  failed: "err", held: "warn", sent: "ok", text: "ok", digest: "blue", dashboard: "neutral",
};
/** State inputs read this long ago are amber; unread is red. */
const STATE_INPUT_AMBER_MINUTES = 240;

/* Type (Direction v3): the theme sans for every sentence, name and label; mono only for
   figures, times and ids. Sizes 24 verdict · 15 body · 13.5 figures · 13 captions.
   Section heads are <h2>, which pulse-typography.css sets in the display face. */
const SANS = "var(--sans)";
const MONO = "var(--mono)";
const VERDICT: CSSProperties = { fontFamily: SANS, fontSize: 26, fontWeight: 700, lineHeight: 1.25, letterSpacing: "0.005em" };
/** Column heads and small labels: sentence case, faint, no letterspacing. */
const LABEL: CSSProperties = { fontFamily: SANS, fontSize: 13, fontWeight: 600, color: "var(--ink-3)", whiteSpace: "nowrap", flex: "none" };
/** A readout figure in the Activity tab. */
const STAT: CSSProperties = { fontFamily: MONO, fontSize: 21, fontVariantNumeric: "tabular-nums", lineHeight: 1.3 };
const BODY: CSSProperties = { fontFamily: SANS, fontSize: 15, fontWeight: 600, lineHeight: 1.45 };
/** Figures: counts, ages, clocks. Tabular so columns of them align. */
const FIG: CSSProperties = { fontFamily: MONO, fontSize: 13, fontWeight: 400, fontVariantNumeric: "tabular-nums" };
const CELL: CSSProperties = { ...BODY, padding: "8px 12px 8px 0", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", verticalAlign: "middle" };
const NUM: CSSProperties = { ...CELL, ...FIG, textAlign: "right", paddingRight: 16 };
const NOWRAP: CSSProperties = { whiteSpace: "nowrap" };
/** A narrative cell: wraps to two lines at its column width, then clips.
    The clamp lives on an inner box — `display: -webkit-box` on a <td> takes the cell
    out of the table formatting context and the columns collapse. */
const WRAP2: CSSProperties = { ...BODY, padding: "7px 10px 7px 0", verticalAlign: "top", whiteSpace: "normal" };
const CLAMP2: CSSProperties = {
  display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden",
} as CSSProperties;
/** State inputs carry four readings in a narrow column, so they get a third line. */
const CLAMP3: CSSProperties = { ...CLAMP2, WebkitLineClamp: 3 } as CSSProperties;
/** Rows carry their own hairline, so a run of like rows can read as one block. */
const HAIRLINE = "1px solid var(--line-1)";
/** The left rule and wash that lift a critical row out of a run of similar ones. */
const CRIT_RULE = "inset 3px 0 0 var(--err)";
const CRIT_WASH = "rgba(248,113,113,0.10)";
/** Room for that left rule, matched on the header so the column stays aligned. */
const FIRST: CSSProperties = { paddingLeft: 10 };

/* ──────────────────────────── formatting ──────────────────────────── */

function ageText(minutes: number | null | undefined): string {
  if (minutes == null || !Number.isFinite(minutes)) return "—";
  if (minutes < 1) return "<1m";
  if (minutes < 90) return `${Math.round(minutes)}m`;
  const hours = minutes / 60;
  if (hours < 48) return `${hours < 10 ? hours.toFixed(1).replace(/\.0$/, "") : Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
}
/** 24-hour clock everywhere in LifeOS. */
function clock(iso: string | null | undefined): string {
  return fmtClock(iso);
}
/** Two-digit hour ("07") of an instant in the principal's zone. */
function hourLabel(w: string | number): string {
  return String(zonedHour(w)).padStart(2, "0");
}
function count(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value) ? "—" : value.toLocaleString("en-US");
}

/** A served rate, cut (never rounded) to three decimals. A quiet hour must read as quiet:
    0.2 stays 0.2, 7/60 shows as 0.116 rather than 0.12, and anything under a thousandth says so. */
function rate(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value) || value < 0) return "—";
  if (value === 0) return "0";
  // The 1e-9 only absorbs binary float error (0.57 * 1000 is 569.999…); it cannot lift a real value a step.
  const cut = Math.floor(value * 1000 + 1e-9) / 1000;
  return cut === 0 ? "<0.001" : String(cut);
}

/** A number and its unit, welded into one nowrap run so they never break apart. */
function Num({ value, unit, tone }: { value: ReactNode; unit?: string; tone?: string }) {
  return (
    <span style={{ whiteSpace: "nowrap", fontFamily: MONO, fontVariantNumeric: "tabular-nums", fontSize: "0.9em", fontWeight: 400, color: tone }}>
      {value}
      {unit && <span style={{ opacity: 0.6 }}>{unit}</span>}
    </span>
  );
}

/* ──────────────────────────── normalisation ──────────────────────────── */

interface Row {
  source: string; state: EmitterState;
  count1h: number | null; count24h: number | null; perHour: number | null;
  lastAgeMinutes: number | null; cadenceMinutes: number | null;
  lastReadError: string | null; lastReadAt: string | null;
  /** 24 hourly counts, oldest first; null means that hour is outside what we can see. */
  tempo: Array<number | null>;
  tempoIsDerived: boolean;
  isSelf: boolean;
}

/** Hourly buckets for one source, from the raw event list. Hours we cannot see stay null. */
function deriveTempo(events: VEvent[], source: string, now: number, coveredFrom: number): Array<number | null> {
  const nowHour = Math.floor(now / HOUR);
  const tempo: Array<number | null> = Array.from({ length: 24 }, (_, i) => (i < coveredFrom ? null : 0));
  for (const event of events) {
    if (event.source !== source) continue;
    const ms = Date.parse(event.ts);
    if (!Number.isFinite(ms)) continue;
    const index = 23 + (Math.floor(ms / HOUR) - nowHour);
    if (index >= coveredFrom && index <= 23) tempo[index] = (tempo[index] ?? 0) + 1;
  }
  return tempo;
}

/** The oldest hour the loaded event list actually reaches. Everything before it is unknown, not zero. */
function coverageFrom(events: VEvent[], now: number): number {
  const stamps = events.map((event) => Date.parse(event.ts)).filter((ms) => Number.isFinite(ms));
  if (stamps.length === 0) return 24;
  const oldestHour = Math.floor(Math.min(...stamps) / HOUR);
  return Math.min(24, Math.max(0, 23 + (oldestHour - Math.floor(now / HOUR))));
}

function buildRows(data: Payload, events: VEvent[], now: number): { rows: Row[]; fromRegistry: boolean } {
  const coveredFrom = coverageFrom(events, now);
  const fromRegistry = Array.isArray(data.emitters);
  const source: ApiEmitter[] = fromRegistry
    ? (data.emitters as ApiEmitter[])
    : (data.sources ?? []).map((legacy) => ({
        source: legacy.source,
        state: (legacy.quiet ? "quiet" : "live") as EmitterState,
        count_1h: legacy.count_1h, count_24h: legacy.count_24h, per_hour: legacy.per_hour,
        last_age_minutes: legacy.last_age_minutes, expected_cadence_minutes: legacy.expected_cadence_minutes,
      }));

  const rows = source.map<Row>((emitter) => {
    const served = Array.isArray(emitter.tempo_24h) && emitter.tempo_24h.length === 24;
    const state: EmitterState = emitter.state
      ?? (emitter.last_age_minutes == null ? "never"
        : emitter.expected_cadence_minutes != null && emitter.last_age_minutes > 2 * emitter.expected_cadence_minutes ? "quiet"
        : "live");
    return {
      source: emitter.source,
      state,
      count1h: emitter.count_1h ?? null,
      count24h: emitter.count_24h ?? null,
      perHour: emitter.per_hour ?? null,
      lastAgeMinutes: state === "never" ? null : emitter.last_age_minutes ?? null,
      cadenceMinutes: emitter.expected_cadence_minutes ?? null,
      lastReadError: emitter.last_read && emitter.last_read.ok === false ? (emitter.last_read.error ?? "read failed") : null,
      lastReadAt: emitter.last_read?.ts ?? null,
      tempo: served ? (emitter.tempo_24h as number[]).slice(0, 24) : deriveTempo(events, emitter.source, now, coveredFrom),
      tempoIsDerived: !served,
      isSelf: emitter.source === SELF,
    };
  });

  rows.sort((a, b) =>
    STATE_ORDER[a.state] - STATE_ORDER[b.state]
    || (b.count24h ?? -1) - (a.count24h ?? -1)
    || a.source.localeCompare(b.source));
  return { rows, fromRegistry };
}

/** The ledger, from the notification records in the event list, when the API serves no ledger. */
function deriveLedger(events: VEvent[]): LedgerRow[] {
  return events
    .filter((event) => event.kind === "notification")
    .slice(0, 20)
    .map((event) => {
      const tail = (event.dedup_key ?? "").split(":").pop() ?? "";
      const title = (event.title ?? "").toLowerCase();
      const decision = ["failed", "held", "sent"].includes(tail) ? tail
        : title.includes("failed") ? "failed"
        : title.includes("held") ? "held"
        : "sent";
      return {
        ts: event.ts,
        decision,
        reason: event.summary ?? null,
        event: { id: event.ref ?? undefined, source: event.source, severity: event.severity, title: event.title },
        state_inputs: event.meta?.state_inputs ?? null,
      };
    });
}

/** 24 hourly severity buckets from the raw event list, when the API serves no timeline. */
function deriveTimeline(events: VEvent[], now: number): Bucket[] {
  const nowHour = Math.floor(now / HOUR);
  const buckets: Bucket[] = Array.from({ length: 24 }, (_, i) => ({
    hour_start: new Date((nowHour - 23 + i) * HOUR).toISOString(),
    critical: 0, high: 0, medium: 0, low: 0, info: 0,
  }));
  for (const event of events) {
    const ms = Date.parse(event.ts);
    if (!Number.isFinite(ms)) continue;
    const index = 23 + (Math.floor(ms / HOUR) - nowHour);
    if (index < 0 || index > 23) continue;
    const key = (SEVERITIES as readonly string[]).includes(event.severity) ? (event.severity as Severity) : "info";
    buckets[index][key] = (buckets[index][key] ?? 0) + 1;
  }
  return buckets;
}

/** Vigil's own liveness row. Its notifications are not heartbeats: they are what the tick decided. */
function isHeartbeat(event: VEvent): boolean {
  return event.source === SELF && (event.kind === "heartbeat" || event.title === "Vigil heartbeat" || (event.dedup_key ?? "").startsWith("vigil:heartbeat:"));
}

/** The activity feed, from the raw event list, when the API serves no feed. */
function deriveFeed(events: VEvent[]): FeedRow[] {
  const byId = new Map(events.map((event) => [event.id, event]));
  return events.filter((event) => !isHeartbeat(event)).slice(0, 100).map<FeedRow>((event) => {
    const match = event.source === SELF && event.kind === "notification" ? (event.title ?? "").match(/(sent|held|failed)$/) : null;
    const decision = (match?.[1] ?? null) as Decision3 | null;
    const subject = decision && event.ref ? byId.get(event.ref) : undefined;
    return {
      id: event.id ?? `${event.ts}:${event.source}`, ts: event.ts, type: decision ? "notification" : "event",
      source: event.source, kind: event.kind, severity: event.severity, title: event.title ?? event.summary ?? "Event",
      summary: event.summary ?? null, decision, reason: decision ? event.summary ?? null : null,
      subject: decision ? { source: subject?.source ?? "unknown", severity: subject?.severity ?? "info", kind: subject?.kind ?? "unknown", title: subject?.title ?? "event no longer in the list" } : null,
    };
  });
}

/** What a feed row is ABOUT: a notification files under the event it decided on. */
function about(row: FeedRow): { source: string; kind: string; severity: string } {
  return row.subject ? { source: row.subject.source, kind: row.subject.kind, severity: row.subject.severity } : row;
}

/** A read's duration, in the unit that keeps it short. */
function msText(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "—";
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
}

/** m:ss for a countdown, h:mm:ss past an hour. */
function mss(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

/** "2m 14s", "48s", "1h 3m": an age that visibly moves every second. */
function secondsAge(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

/** A wall clock that re-renders only the component that asks for it, once a second. */
function useSecond(): number {
  const [t, setT] = useState(() => Date.now());
  useEffect(() => { const id = setInterval(() => setT(Date.now()), 1000); return () => clearInterval(id); }, []); // not-data: the age readout ticks each second
  return t;
}

/** How long a new tick or event keeps its "new" marker. The flash is motion; the marker is not. */
const FRESH_MS = 90_000;
/** How often the page asks /api/vigil while it is visible. The API caches for 1.5 s, so this is at most one compose per read. */
const POLL_MS = 2_000;
/** Consecutive failed reads before the verdict turns red; until then the last good data stays up. */
const MISSES_BEFORE_ERROR = 3;
/** Stream rows shown before "show more": enough to read, few enough that the emitters stay in reach below. */
const FEED_FOLD = 12;

/** Raw events in the Raw tab, heartbeat included, so their shape is visible. */
const LATEST_COUNT = 16;
/** The breakdowns below the stream, one tab each. Every figure the API serves stays reachable here. */
const TABS = [
  { id: "activity", label: "Activity" },
  { id: "timeline", label: "Timeline" },
  { id: "ledger", label: "Routing" },
  { id: "pings", label: "Ticks" },
  { id: "database", label: "Store" },
  { id: "latest", label: "Raw events" },
] as const;
type TabId = (typeof TABS)[number]["id"];
const TAB_KEY = "vigil.tab.v3";

/* ──────────────────────────── pieces ──────────────────────────── */

/** HH:mm:ss, 24-hour, so events a few seconds apart stay distinguishable. */
function clockSeconds(iso: string | null | undefined): string {
  return fmtClock(iso);
}

/** JSON syntax colours: keys, strings, numbers, true/false/null, punctuation. */
const JSON_COLOR = {
  key: "rgba(128,204,255,0.95)",
  string: "rgba(134,239,172,0.9)",
  number: "rgba(251,191,36,0.9)",
  literal: "rgba(196,160,255,0.95)",
  punct: "var(--ink-3)",
} as const;
const JSON_TOKEN = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|([{}[\],])/g;

/** Pretty-printed, syntax-highlighted JSON. Plain text between tokens (whitespace) passes through untouched. */
function JsonCode({ value }: { value: unknown }) {
  const text = JSON.stringify(value, null, 2) ?? "undefined";
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(JSON_TOKEN)) {
    const at = match.index ?? 0;
    if (at > last) parts.push(text.slice(last, at));
    const [whole, str, colon, literal, number, punct] = match;
    if (str !== undefined) {
      parts.push(<span key={at} style={{ color: colon ? JSON_COLOR.key : JSON_COLOR.string }}>{str}</span>);
      if (colon) parts.push(<span key={`${at}:`} style={{ color: JSON_COLOR.punct }}>{colon}</span>);
    } else if (literal !== undefined) parts.push(<span key={at} style={{ color: JSON_COLOR.literal }}>{literal}</span>);
    else if (number !== undefined) parts.push(<span key={at} style={{ color: JSON_COLOR.number }}>{number}</span>);
    else parts.push(<span key={at} style={{ color: JSON_COLOR.punct }}>{punct ?? whole}</span>);
    last = at + whole.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <code data-json style={{ fontFamily: "inherit" }}>{parts}</code>;
}

/** The newest events exactly as the API serves them. Click a row for its raw JSON. */
function LatestEvents({ events, fresh }: { events: VEvent[]; fresh: Map<string, number> }) {
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [allRaw, setAllRaw] = useState(false);
  const latest = useMemo(
    () => [...events].sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts)).slice(0, LATEST_COUNT),
    [events]);
  const toggle = (key: string) => setOpen((old) => {
    const next = new Set(old);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
  if (latest.length === 0) return <Missing>No events served yet.</Missing>;
  return (
    <>
      <table>
        <colgroup>
          <col style={{ width: 96 }} /><col style={{ width: 150 }} /><col style={{ width: 90 }} /><col style={{ width: 84 }} />
          <col /><col style={{ width: "22%" }} />
        </colgroup>
        <thead>
          <tr>
            <th style={{ ...LABEL, ...FIRST }}>time</th>
            <th style={LABEL}>source</th>
            <th style={LABEL}>kind</th>
            <th style={LABEL}>severity</th>
            <th style={LABEL}>title · summary</th>
            <th style={LABEL}>ref · dedup key</th>
          </tr>
        </thead>
        <tbody>
          {latest.map((event, index) => {
            const key = event.id ?? `${event.ts}-${index}`;
            const expanded = allRaw || open.has(key);
            const self = event.source === SELF;
            return (
              <Fragment key={key}>
                <tr data-latest-event={event.id ?? ""} onClick={() => toggle(key)}
                  className={event.id && fresh.has(event.id) ? "vigil-arrived" : undefined}
                  style={{ borderTop: HAIRLINE, cursor: "pointer", opacity: self ? 0.55 : 1 }}>
                  <td style={{ ...CELL, ...FIRST, color: "var(--ink-3)" }}>{clockSeconds(event.ts)}</td>
                  <td style={{ ...CELL, color: "var(--ink-1)" }}>{event.source}</td>
                  <td style={{ ...CELL, color: "var(--ink-2)" }}>{event.kind}</td>
                  <td style={{ ...CELL, color: SEV_COLOR[event.severity] ?? "var(--ink-2)" }}>{event.severity}</td>
                  <td style={WRAP2} title={event.summary ?? event.title}>
                    <span style={CLAMP2}>
                      <span style={{ color: "var(--ink-1)" }}>{event.title ?? "—"}</span>
                      {event.summary && <span style={{ color: "var(--ink-2)" }}> · {event.summary}</span>}
                    </span>
                  </td>
                  <td style={{ ...WRAP2, color: "var(--ink-3)" }} title={`${event.ref ?? ""}\n${event.dedup_key ?? ""}`}>
                    <span style={CLAMP2}>{event.ref ?? "—"}{event.dedup_key ? ` · ${event.dedup_key}` : ""}</span>
                  </td>
                </tr>
                {expanded && (
                  <tr>
                    <td colSpan={6} style={{ padding: "0 0 10px 10px" }}>
                      <pre style={{ ...BODY, margin: 0, padding: "8px 12px", background: "rgba(176,196,221,0.05)", border: HAIRLINE, color: "var(--ink-2)", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                        <JsonCode value={event} />
                      </pre>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
      <button type="button" onClick={() => { setAllRaw((value) => !value); setOpen(new Set()); }}
        style={{ ...BODY, background: "transparent", border: 0, padding: "8px 0 0", cursor: "pointer", color: "var(--ink-2)", textDecoration: "underline" }}>
        {allRaw ? "hide raw JSON" : `show raw JSON for all ${latest.length}`}
      </button>
    </>
  );
}

function Tabs({ active, onPick }: { active: TabId; onPick: (id: TabId) => void }) {
  return (
    <div role="tablist" aria-label="Vigil breakdowns" style={{ display: "flex", flexWrap: "wrap", gap: "0 28px", borderBottom: "1px solid var(--line-1)" }}>
      {TABS.map((tab) => {
        const on = tab.id === active;
        return (
          <button key={tab.id} type="button" role="tab" aria-selected={on} data-tab={tab.id} onClick={() => onPick(tab.id)}
            style={{ ...BODY, fontSize: 16, fontWeight: 700, background: "transparent", border: 0, cursor: "pointer", padding: "10px 0 9px", whiteSpace: "nowrap", flex: "none",
              color: on ? "var(--ink-1)" : "var(--ink-3)", boxShadow: on ? "inset 0 -2px 0 var(--accent-soft)" : undefined }}>
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

/** A section: a display-face heading, one faint line of meta beside it, then the content. */
function Band({ id, label, meta, children }: { id: string; label: string; meta?: ReactNode; children: ReactNode }) {
  return (
    <section data-band={id}>
      <div style={{ display: "flex", alignItems: "baseline", flexWrap: "wrap", gap: "2px 14px", marginBottom: 12 }}>
        <h2 style={{ fontSize: 17, margin: 0, color: "var(--ink-1)", letterSpacing: "0.02em" }}>{label}</h2>
        {meta != null && <span style={{ ...BODY, fontSize: 14, color: "var(--ink-3)", minWidth: 0 }}>{meta}</span>}
      </div>
      {children}
    </section>
  );
}

/** Said out loud when the API does not serve a field. Never dressed up as data. */
function Missing({ children }: { children: ReactNode }) {
  return <p role="status" style={{ ...BODY, color: "var(--warn)", padding: "8px 0" }}>{children}</p>;
}
function bytes(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  if (value < 1024) return `${count(value)} B`;
  return value < 1024 * 1024 ? `${(value / 1024).toFixed(1)} KB` : `${(value / (1024 * 1024)).toFixed(1)} MB`;
}
function eventTime(ts: string | null | undefined, now: number): string {
  if (!ts || !Number.isFinite(Date.parse(ts))) return "—";
  const ms = Date.parse(ts);
  // A row stamped ahead of the clock is a bad timestamp, not a fresh event; say so with its full date.
  if (ms > now + 60_000) return `${ts.slice(0, 10)} ${clock(ts)} · future-dated`;
  const day = now - ms >= 86_400_000 ? `${ts.slice(0, 10)} ` : "";
  return `${day}${clock(ts)} · ${ageText((now - ms) / 60_000)} ago`;
}
function DatabasePanel({ database, fallbackStore, now }: { database: Database | null | undefined; fallbackStore: Store | null | undefined; now: number }) {
  const store = database?.store ?? fallbackStore, probes = database?.probes ?? [], outbox = database?.outbox, api = database?.api;
  const healthy = probes.filter((probe) => probe.ok && probe.latency_ms != null && Number.isFinite(probe.latency_ms)).map((probe) => probe.latency_ms!).sort((a, b) => a - b);
  const percentile = (fraction: number) => healthy.length ? healthy[Math.ceil(fraction * healthy.length) - 1] : null;
  const extendedMissing = store?.rows != null && [store.rows_1h, store.rows_24h, store.oldest_ts, store.newest_ts, store.db_size_bytes, store.emitters, store.query_ms].every((value) => value == null);
  const max = Math.max(1, ...probes.map((probe) => probe.latency_ms ?? 0));
  const ms = (value: number | null | undefined) => value == null ? "—" : `${count(value)} ms`;
  const perMin = (rows: number | null | undefined, minutes: number) => rows == null ? null : rows / minutes;
  const head = (label: string, right = true) => <th style={{ ...LABEL, textAlign: right ? "right" : "left", paddingRight: 14 }}>{label}</th>;
  const futureNewest = store?.newest_ts != null && Date.parse(store.newest_ts) > now + 60_000;
  return (
    <>
      <table data-database-table>
        <colgroup>
          <col style={{ width: 130 }} /><col style={{ width: 84 }} /><col style={{ width: 64 }} /><col style={{ width: 74 }} />
          <col style={{ width: 150 }} /><col style={{ width: 90 }} /><col /><col /><col style={{ width: 170 }} />
        </colgroup>
        <thead>
          <tr>
            {head("", false)}{head("rows")}{head("1h")}{head("24h")}{head("per min 1h / 24h")}{head("size")}
            {head("oldest", false)}{head("newest", false)}{head("query · round-trip")}
          </tr>
        </thead>
        <tbody>
          <tr data-db-row="store" style={{ borderTop: HAIRLINE }}>
            <td style={{ ...CELL, color: "var(--ink-1)" }}>D1 store{store?.reachable === false && <span style={{ color: "var(--err)" }}> ✗</span>}</td>
            <td style={{ ...NUM, color: "var(--ink-1)" }}><Num value={count(store?.rows)} /></td>
            <td style={NUM}><Num value={count(store?.rows_1h)} /></td>
            <td style={NUM}><Num value={count(store?.rows_24h)} /></td>
            <td style={NUM}><Num value={`${rate(store?.events_per_minute_1h)} / ${rate(store?.events_per_minute_24h)}`} /></td>
            <td style={NUM}><Num value={bytes(store?.db_size_bytes)} /></td>
            <td style={{ ...WRAP2, verticalAlign: "middle", color: "var(--ink-2)" }}>{eventTime(store?.oldest_ts, now)}</td>
            <td style={{ ...WRAP2, verticalAlign: "middle", color: futureNewest ? "var(--warn)" : "var(--ink-2)" }} title={store?.newest_ts ?? undefined}>{eventTime(store?.newest_ts, now)}</td>
            <td style={NUM}><Num value={`${ms(store?.query_ms)} · ${ms(store?.latency_ms)}`} /></td>
          </tr>
          <tr data-db-row="outbox" style={{ borderTop: HAIRLINE }}>
            <td style={{ ...CELL, color: "var(--ink-1)" }}>Local outbox</td>
            <td style={{ ...NUM, color: "var(--ink-1)" }}><Num value={count(outbox?.rows)} /></td>
            <td style={NUM}><Num value={count(outbox?.rows_1h)} /></td>
            <td style={NUM}><Num value={count(outbox?.rows_24h)} /></td>
            <td style={NUM}><Num value={`${rate(perMin(outbox?.rows_1h, 60))} / ${rate(perMin(outbox?.rows_24h, 1440))}`} /></td>
            <td style={NUM}><Num value={bytes(outbox?.bytes)} /></td>
            <td style={{ ...WRAP2, verticalAlign: "middle", color: "var(--ink-2)" }}>{eventTime(outbox?.oldest_ts, now)}</td>
            <td style={{ ...WRAP2, verticalAlign: "middle", color: "var(--ink-2)" }}>{eventTime(outbox?.newest_ts, now)}</td>
            <td style={NUM}><Num value={`compose ${ms(api?.compose_ms)}`} /></td>
          </tr>
        </tbody>
      </table>
      <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap", paddingTop: 8 }}>
        <span style={{ ...BODY, color: "var(--ink-2)" }}>
          store round-trip median {ms(percentile(0.5))} · p95 {ms(percentile(0.95))} · max {ms(healthy.at(-1))} over {probes.length} checks
          {" · "}{count(store?.emitters)} emitters · {count(outbox?.pulled_rows)} pulled from the store · API {api?.cached ? "cached" : "fresh"}
        </span>
        <span aria-label="Recent store round-trips" style={{ display: "flex", alignItems: "end", gap: 2, height: 16, marginLeft: "auto" }}>
          {[...probes].reverse().map((probe, index) => <span key={`${probe.ts}-${index}`} title={`${clock(probe.ts)} · ${probe.ok ? ms(probe.latency_ms) : "failed"}`} style={{ width: 5, height: Math.max(2, Math.round(16 * (probe.latency_ms ?? 0) / max)), background: probe.ok ? "var(--ink-2)" : "var(--err)" }} />)}
        </span>
      </div>
      {extendedMissing && <Missing>The Vigil worker hasn&apos;t been redeployed with the extended /stats yet — only the row count is served.</Missing>}
    </>
  );
}
function Footnote({ children }: { children: ReactNode }) {
  return <p style={{ ...BODY, color: "var(--ink-2)", paddingTop: 6 }}>{children}</p>;
}

/** 24 hours of ink. One cell per hour, one scale across every row, no axis to misread. */
function Tempo({ tempo, scale, dim }: { tempo: Array<number | null>; scale: number; dim: boolean }) {
  const nowHour = Math.floor(Date.now() / HOUR);
  return (
    <div style={{ display: "flex", gap: 2, alignItems: "stretch", height: 16, opacity: dim ? 0.5 : 1 }}>
      {tempo.map((value, index) => {
        const hour = hourLabel((nowHour - 23 + index) * HOUR);
        if (value == null) {
          return (
            <span key={index} title={`${hour}:00 — outside the loaded window`}
              style={{ flex: 1, minWidth: 3, alignSelf: "end", height: 1, background: "var(--line-2)" }} />
          );
        }
        const weight = scale > 0 ? Math.sqrt(Math.min(value, scale) / scale) : 0;
        return (
          <span key={index} title={`${hour}:00 — ${value} event${value === 1 ? "" : "s"}`}
            style={{
              flex: 1, minWidth: 3, borderRadius: 1,
              // A single event has to read at a glance, so the ramp starts well clear
              // of the empty fill. One scale across every row is preserved.
              background: value === 0 ? "rgba(176,196,221,0.13)" : `rgba(176,196,221,${(0.34 + 0.60 * weight).toFixed(3)})`,
            }} />
        );
      })}
    </div>
  );
}

/** A minute strip’s y-scale never drops below this, so one event in a quiet hour draws a short
    bar instead of a full-height one. The scale is printed on the strip’s own axis, never implied. */
const MINUTE_SCALE_FLOOR = 4;

/** Sixty minutes as sixty columns. Counts here are 0 to a few, so a column (not a line) is the
    honest mark: a line through mostly-zero integers draws spikes that look like noise. */
function MinuteStrip({ buckets, windowStart, windowEnd, top }: {
  buckets: number[]; windowStart: number | null; windowEnd: string | null; top: number;
}) {
  const tick: CSSProperties = { ...BODY, lineHeight: 1, color: "var(--ink-3)" };
  return (
    <div style={{ display: "grid", gridTemplateColumns: "auto minmax(0, 1fr)", columnGap: 6 }}>
      {/* A two-tick y-axis beside the bars: 0 at the baseline, the scale top at the dashed rule. */}
      <div aria-hidden style={{ ...tick, display: "flex", flexDirection: "column", justifyContent: "space-between", alignItems: "flex-end" }}>
        <span>{top}</span><span>0</span>
      </div>
      <div role="img" aria-label={`Events per minute over the last 60 minutes, bar top = ${top} events`}
        style={{ display: "flex", gap: 1, alignItems: "flex-end", height: 36, borderBottom: "1px solid var(--ink-3)", borderTop: "1px dashed var(--line-2)" }}>
        {buckets.map((value, index) => {
          const at = windowStart == null ? null : clock(new Date(windowStart + index * 60_000).toISOString());
          return (
            // The hit target is the full column height; the ink inside it is the count.
            <span key={index} title={`${at ?? `minute ${index + 1}`} — ${value} event${value === 1 ? "" : "s"}`}
              style={{ flex: 1, minWidth: 2, height: "100%", display: "flex", alignItems: "flex-end" }}>
              <span style={{
                width: "100%", borderRadius: "1px 1px 0 0",
                height: value === 0 ? 0 : `${(value / top) * 100}%`,
                background: "rgba(176,196,221,0.82)",
              }} />
            </span>
          );
        })}
      </div>
      <span />
      <div style={{ ...BODY, display: "flex", justifyContent: "space-between", color: "var(--ink-3)", whiteSpace: "nowrap", gap: 8, paddingTop: 2, overflow: "hidden" }}>
        <span>{windowStart == null ? "—" : clock(new Date(windowStart).toISOString())}</span>
        <span>{clock(windowEnd)}</span>
      </div>
    </div>
  );
}

/** One readout: small-caps label, the figure at verdict size, one line of context under it. */
function Readout({ id, label, value, context, tone, title }: {
  id: string; label: string; value: ReactNode; context: ReactNode; tone?: string; title?: string;
}) {
  return (
    <div data-stat={id} className="vigil-readout" title={title}>
      <div style={{ ...LABEL, width: "auto", overflow: "hidden", textOverflow: "ellipsis" }}>{label}</div>
      <div style={{ ...STAT, color: tone ?? "var(--ink-1)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", marginTop: 4 }}>{value}</div>
      <div style={{ ...BODY, color: "var(--ink-2)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{context}</div>
    </div>
  );
}

/** Rate, shape of the hour, the day's volume, who is reading, who is loudest, how long since.
    None of these figures appears in the verdict or Needs-you lines below it. */
function StatsStrip({ stats }: { stats: Stats }) {
  const buckets = Array.isArray(stats.per_minute_60) && stats.per_minute_60.length === 60 ? stats.per_minute_60 : null;
  const windowStart = stats.window?.start ? Date.parse(stats.window.start) : null;
  const windowEnd = stats.window?.end ?? null;
  const peak = stats.peak_per_minute ?? null;
  const top = Math.max(MINUTE_SCALE_FLOOR, peak ?? 0);
  const reading = stats.emitters?.reading_cleanly ?? null;
  const registered = stats.emitters?.registered ?? null;
  const busiest = stats.busiest_24h ?? null;
  const last = stats.last_event ?? null;
  return (
    <div data-band="stats" className="vigil-stats">
      <div data-stat="rate" className="vigil-readout vigil-rate"
        title={`${count(stats.count_1h)} events in the 60 full minutes ${clock(stats.window?.start)}–${clock(windowEnd)} ÷ 60 = ${stats.events_per_minute ?? "—"} per minute`}>
        <div style={LABEL}>Events per minute · last hour</div>
        <div style={{ display: "flex", alignItems: "flex-end", gap: 16, marginTop: 4 }}>
          <div style={{ flex: "none" }}>
            <div style={{ ...STAT, color: "var(--ink-1)", whiteSpace: "nowrap" }}>
              {rate(stats.events_per_minute)}<span style={{ ...BODY, color: "var(--ink-2)" }}>/min</span>
            </div>
            <div style={{ ...BODY, color: "var(--ink-2)", whiteSpace: "nowrap" }}>
              <span style={{ color: "var(--ink-1)" }}>{count(stats.per_hour ?? stats.count_1h)}</span>/h
              <span style={{ color: "var(--ink-3)" }}> · </span>peak <span style={{ color: "var(--ink-1)" }}>{peak ?? "—"}</span>/min
            </div>
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            {buckets
              ? <MinuteStrip buckets={buckets} windowStart={windowStart} windowEnd={windowEnd} top={top} />
              : <span style={{ ...BODY, color: "var(--warn)" }}>per-minute buckets not served</span>}
          </div>
        </div>
      </div>

      <Readout id="day" label="Last 24h"
        value={count(stats.count_24h)}
        context={<>avg {rate(stats.events_per_minute_24h)}/min</>}
        title={`${count(stats.count_24h)} events in 24h ÷ 1,440 minutes = ${stats.events_per_minute_24h ?? "—"}/min, ${rate(stats.events_per_hour_24h)}/h`} />

      <Readout id="reading" label="Adapters reading"
        tone={reading != null && registered != null && reading < registered ? "var(--warn)" : undefined}
        value={<>{count(reading)}<span style={{ ...BODY, color: "var(--ink-2)" }}> of {count(registered)}</span></>}
        context="Vigil not counted"
        title="Registered adapters whose last read succeeded: live, watching, or past cadence but still reading. Never-read and failed-read adapters are left out, and so is Vigil itself, which the emitters table lists as its own heartbeat row." />

      <Readout id="busiest" label="Busiest · 24h"
        value={busiest?.source ?? "—"}
        context={busiest
          ? <>{count(busiest.count)} events{busiest.share != null && Number.isFinite(busiest.share) ? ` · ${Math.floor(busiest.share * 100)}%` : ""}</>
          : "nothing posted"}
        title={busiest ? `${busiest.source} posted ${busiest.count} of the ${count(stats.count_24h)} events in the last 24h` : undefined} />

      <Readout id="last" label="Last event"
        value={last ? <>{ageText(last.age_minutes)}<span style={{ ...BODY, color: "var(--ink-2)" }}> ago</span></> : "—"}
        context={last ? <>{last.source} · {clock(last.ts)}</> : "none in the store"}
        title={last ? `${last.source} at ${last.ts}` : undefined} />
    </div>
  );
}

function StateInputsCell({ inputs }: { inputs: StateInputs | null | undefined }) {
  if (!inputs || Object.keys(inputs).length === 0) return <span style={{ color: "var(--ink-3)" }}>not recorded</span>;
  return (
    <>
      {Object.entries(inputs).map(([name, value], index) => {
        const unread = value?.read === false || value?.age_minutes == null;
        const stale = !unread && (value.age_minutes as number) > STATE_INPUT_AMBER_MINUTES;
        return (
          // The separator sits OUTSIDE the nowrap span so the list has somewhere to
          // break. Inside it, the cell had no break opportunity and clipped instead.
          <Fragment key={name}>
            {index > 0 && <span style={{ color: "var(--ink-3)" }}> · </span>}
            <span style={{ whiteSpace: "nowrap", color: unread ? "var(--err)" : stale ? "var(--warn)" : undefined }}>
              {name} {unread ? "unread" : ageText(value.age_minutes)}
            </span>
          </Fragment>
        );
      })}
    </>
  );
}

/** The still marker for something that arrived while the page was open. A flash rides on
    top of it through CSS, and reduced motion keeps the marker and drops the flash. */
function NewTag() {
  return <span data-new style={{ ...BODY, color: "var(--accent-soft)", whiteSpace: "nowrap" }}>new</span>;
}

/** Top-right of the head: whether the page itself is live, and how old its read is, to the second. */
function LiveRead({ fetchedAt, error, pollMs }: { fetchedAt: number | null; error: boolean; pollMs: number }) {
  const t = useSecond();
  if (fetchedAt == null) return <span style={{ ...BODY, color: "var(--ink-2)", whiteSpace: "nowrap" }}>reading…</span>;
  const age = (t - fetchedAt) / 1000;
  const late = error || age > (pollMs / 1000) * 3;
  return (
    <span data-live={late ? "late" : "live"} style={{ ...BODY, color: "var(--ink-2)", whiteSpace: "nowrap" }}
      title={`The page asks /api/vigil every ${pollMs / 1000}s. Last answer ${fmtClock(fetchedAt)}.`}>
      <span style={{ color: late ? "var(--warn)" : "var(--ok)", marginRight: 6 }}>●</span>
      {late ? "not updating" : "live"}<span style={{ color: "var(--ink-3)" }}> · </span>read <Num value={secondsAge(age)} /> ago
    </span>
  );
}

interface TickClockProps { clock: Clock | null; staleFromServer: boolean; fallbackMinutes: number | null; cadence: number | null }

/** Where the tick stands this second. Recomputed per render from the served clock, so it moves between polls. */
function tickNow(t: number, { clock, staleFromServer, cadence }: TickClockProps) {
  const last = clock?.last_tick_ts ? Date.parse(clock.last_tick_ts) : NaN;
  const interval = clock?.interval_seconds ?? (cadence != null ? cadence * 60 : null);
  const next = clock?.next_at ? Date.parse(clock.next_at) : NaN;
  const ageSeconds = Number.isFinite(last) ? (t - last) / 1000 : null;
  // Ten minutes is the server's stale line; the page crosses it on its own between polls.
  const stale = staleFromServer || (ageSeconds != null && ageSeconds > 600);
  const untilNext = Number.isFinite(next) ? (next - t) / 1000 : null;
  const fraction = untilNext != null && interval ? Math.min(1, Math.max(0, 1 - untilNext / interval)) : null;
  // A tick takes up to ~30 s after launchd fires it, so the first 90 s past due are "ticking", not late.
  const phase = untilNext == null ? null : untilNext > 0 ? "waiting" : untilNext > -90 ? "ticking" : "late";
  return { interval, ageSeconds, stale, untilNext, fraction, phase } as const;
}

/** The verdict's first figure: tick age to the second, beside the cadence it should keep. */
function TickAge(props: TickClockProps) {
  const { interval, ageSeconds, stale } = tickNow(useSecond(), props);
  return (
    <span style={NOWRAP} data-tick-age={ageSeconds == null ? "unknown" : Math.floor(ageSeconds)}
      title={props.clock?.last_tick_ts ? `last tick ${fmtDateTime(props.clock.last_tick_ts)}` : undefined}>
      <span style={{ color: stale ? "var(--err)" : "var(--ok)" }}>●</span>{" "}
      Tick <Num value={ageSeconds != null ? secondsAge(ageSeconds) : ageText(props.fallbackMinutes)} />
      {interval != null && <span style={{ opacity: 0.55 }}>/{Math.round(interval / 60)}m</span>}
    </span>
  );
}

/** A countdown to the next tick with the interval drawn as a filling bar. It sits on the
    Needs-you row so the verdict stays one line. */
function TickCountdown(props: TickClockProps) {
  const { stale, untilNext, fraction, phase } = tickNow(useSecond(), props);
  if (!phase) return null;
  return (
    <span data-countdown={phase} style={{ ...BODY, whiteSpace: "nowrap", color: "var(--ink-2)", display: "inline-flex", alignItems: "center", gap: 10 }}>
      {phase === "waiting" && <span>next tick in <Num value={mss(untilNext as number)} tone="var(--ink-1)" /></span>}
      {phase === "ticking" && <span className="vigil-pulse">tick running now</span>}
      {phase === "late" && <span style={{ color: stale ? "var(--err)" : "var(--warn)" }}>next tick <Num value={mss(-(untilNext as number))} /> late</span>}
      {fraction != null && (
        <span aria-hidden style={{ display: "inline-block", width: 72, height: 4, background: "var(--line-2)", borderRadius: 2, overflow: "hidden" }}>
          <span style={{ display: "block", height: "100%", width: `${(fraction * 100).toFixed(1)}%`, background: phase === "late" ? "var(--warn)" : "rgba(176,196,221,0.85)" }} />
        </span>
      )}
    </span>
  );
}

const MARK: CSSProperties = {
  ...BODY, lineHeight: "20px", height: 20, textAlign: "center", borderRadius: 2, overflow: "hidden",
};

/** One adapter's outcome on one tick: an empty cell is a clean read with nothing new, a number
    is what it emitted, ✕ is a failed read. Glyph and text carry the state; colour only repeats it. */
function PingMark({ ping, tickTs, scale }: { ping: Ping | undefined; tickTs: string; scale: number }) {
  if (!ping) {
    return <span role="cell" title="no read recorded for this adapter on this tick" style={{ ...MARK, color: "var(--ink-3)" }}>–</span>;
  }
  const at = clock(tickTs);
  if (!ping.ok) {
    return (
      <span role="cell" data-ping="error" title={`${ping.name} · ${at} · read failed after ${msText(ping.ms)}: ${ping.error ?? "no reason recorded"}`}
        style={{ ...MARK, color: "var(--err)", background: "rgba(248,113,113,0.16)", boxShadow: "inset 0 0 0 1px rgba(248,113,113,0.55)" }}>✕</span>
    );
  }
  if (ping.events > 0) {
    const weight = Math.sqrt(Math.min(ping.events, scale) / scale);
    return (
      <span role="cell" data-ping="emitted" title={`${ping.name} · ${at} · emitted ${ping.events} event${ping.events === 1 ? "" : "s"} in ${msText(ping.ms)}`}
        style={{ ...MARK, color: "var(--ink-1)", background: `rgba(176,196,221,${(0.28 + 0.5 * weight).toFixed(3)})` }}>{ping.events}</span>
    );
  }
  return (
    <span role="cell" data-ping="clean" title={`${ping.name} · ${at} · clean read, nothing new, ${msText(ping.ms)}`}
      style={{ ...MARK, background: "rgba(176,196,221,0.09)" }} />
  );
}

/** Median of a list, or null. */
function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b), mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** ISC-67. The last twelve ticks, newest first, one row each, one column per adapter (A–Z). */
function PingsPanel({ pings, freshTick }: { pings: Pings; freshTick: string | null }) {
  const ticks = pings.ticks ?? [];
  const adapters = useMemo(() => {
    const names = new Set<string>(pings.registered ?? []);
    for (const row of ticks) for (const ping of row.pings ?? []) names.add(ping.name);
    return [...names].sort();
  }, [pings.registered, ticks]);
  const scale = Math.max(1, ...ticks.flatMap((row) => (row.pings ?? []).map((ping) => ping.events)));
  const recorded = ticks.filter((row) => Array.isArray(row.pings));
  /** Consecutive ticks from before ISC-65 fold into one line: they say the same thing. A failed tick never folds. */
  const segments = useMemo(() => {
    const out: Array<{ kind: "tick"; row: PingTick } | { kind: "unrecorded"; rows: PingTick[] }> = [];
    for (const row of ticks) {
      const last = out[out.length - 1];
      if (row.pings == null && !row.error) {
        if (last?.kind === "unrecorded") last.rows.push(row); else out.push({ kind: "unrecorded", rows: [row] });
      } else out.push({ kind: "tick", row });
    }
    return out;
  }, [ticks]);

  // The window's reading, so no one has to hover to find the adapter that keeps failing.
  const summary = useMemo(() => {
    const errors = new Map<string, number>(), events = new Map<string, number>(), times = new Map<string, number[]>();
    for (const row of recorded) for (const ping of row.pings ?? []) {
      if (!ping.ok) errors.set(ping.name, (errors.get(ping.name) ?? 0) + 1);
      if (ping.events > 0) events.set(ping.name, (events.get(ping.name) ?? 0) + ping.events);
      times.set(ping.name, [...(times.get(ping.name) ?? []), ping.ms]);
    }
    const rank = (m: Map<string, number>) => [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const slowest = [...times].map(([name, list]) => [name, median(list) ?? 0] as const).sort((a, b) => b[1] - a[1])[0] ?? null;
    return { errors: rank(errors), events: rank(events), slowest };
  }, [recorded]);

  const grid: CSSProperties = { display: "grid", gridTemplateColumns: `58px 44px repeat(${adapters.length}, minmax(18px, 1fr)) 72px 84px minmax(110px, 160px)`, columnGap: 3, alignItems: "center" };
  const head: CSSProperties = { ...BODY, color: "var(--ink-3)", writingMode: "vertical-rl", transform: "rotate(180deg)", whiteSpace: "nowrap", lineHeight: 1, justifySelf: "center", alignSelf: "end", paddingTop: 4 };
  const right: CSSProperties = { ...BODY, textAlign: "right", whiteSpace: "nowrap" };

  return (
    <div role="table" aria-label="Recent ticks, one row per tick, one column per adapter" style={{ minWidth: 0, overflowX: "auto" }}>
      <div role="row" style={{ ...grid, paddingBottom: 6, borderBottom: HAIRLINE }}>
        <span role="columnheader" style={{ ...LABEL, alignSelf: "end" }}>tick</span>
        <span role="columnheader" aria-label="arrival" />
        {adapters.map((name) => <span key={name} role="columnheader" title={name} style={head}>{name}</span>)}
        <span role="columnheader" style={{ ...LABEL, alignSelf: "end", textAlign: "right" }}>took</span>
        <span role="columnheader" style={{ ...LABEL, alignSelf: "end", textAlign: "right" }}>events</span>
        <span role="columnheader" style={{ ...LABEL, alignSelf: "end", paddingLeft: 12 }}>failed reads</span>
      </div>
      {segments.map((segment, index) => {
        if (segment.kind === "unrecorded") {
          const newest = segment.rows[0]!, oldest = segment.rows[segment.rows.length - 1]!;
          return (
            <div role="row" key={`unrecorded-${newest.ts}`} data-unrecorded={segment.rows.length}
              style={{ ...grid, padding: "3px 0", borderTop: index === 0 ? undefined : HAIRLINE }}>
              <span role="cell" style={{ ...BODY, color: "var(--ink-3)", whiteSpace: "nowrap" }} title={`${fmtDateTime(oldest.ts)} – ${fmtDateTime(newest.ts)}`}>{clock(newest.ts)}</span>
              <span role="cell" />
              <span role="cell" style={{ ...BODY, gridColumn: `span ${adapters.length + 3}`, color: "var(--ink-3)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {segment.rows.length === 1
                  ? "this tick ran before per-adapter pings were logged"
                  : `these ${segment.rows.length} ticks, ${clock(oldest.ts)}–${clock(newest.ts)}, ran before per-adapter pings were logged`}
              </span>
            </div>
          );
        }
        const row = segment.row;
        const byName = new Map((row.pings ?? []).map((ping) => [ping.name, ping]));
        const failed = (row.pings ?? []).filter((ping) => !ping.ok).map((ping) => ping.name).sort();
        const fresh = freshTick != null && row.ts === freshTick;
        return (
          <div role="row" key={row.ts} data-tick={row.ts} className={fresh ? "vigil-arrived" : undefined}
            style={{ ...grid, padding: "3px 0", borderTop: index === 0 ? undefined : HAIRLINE, boxShadow: fresh ? "inset 2px 0 0 var(--accent-soft)" : undefined }}>
            <span role="cell" style={{ ...BODY, color: index === 0 ? "var(--ink-1)" : "var(--ink-2)", paddingLeft: fresh ? 6 : 0 }} title={fmtDateTime(row.ts)}>{clock(row.ts)}</span>
            <span role="cell">{fresh ? <NewTag /> : row.dry_run ? <span style={{ ...BODY, color: "var(--ink-3)" }}>dry</span> : null}</span>
            {row.pings == null
              ? <span role="cell" style={{ ...BODY, gridColumn: `span ${adapters.length}`, color: "var(--ink-3)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  not recorded — this tick ran before per-adapter pings were logged
                </span>
              : adapters.map((name) => <PingMark key={name} ping={byName.get(name)} tickTs={row.ts} scale={scale} />)}
            <span role="cell" style={{ ...right, color: "var(--ink-2)" }}>{msText(row.duration_ms)}</span>
            <span role="cell" style={right}>{row.collected == null ? "—" : count(row.collected)}</span>
            <span role="cell" title={row.error ?? (failed.length ? failed.join(", ") : undefined)}
              style={{ ...BODY, paddingLeft: 12, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", color: row.error || failed.length ? "var(--err)" : "var(--ink-3)" }}>
              {row.error ? `tick failed: ${row.error}` : row.pings == null ? "" : failed.length ? failed.join(", ") : "none"}
            </span>
          </div>
        );
      })}
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "4px 16px", paddingTop: 10 }}>
        <span style={{ ...BODY, color: "var(--ink-2)", whiteSpace: "nowrap", display: "inline-flex", alignItems: "center", gap: 6 }}>
          <span style={{ ...MARK, width: 18, background: "rgba(176,196,221,0.09)" }} /> clean read, nothing new
        </span>
        <span style={{ ...BODY, color: "var(--ink-2)", whiteSpace: "nowrap", display: "inline-flex", alignItems: "center", gap: 6 }}>
          <span style={{ ...MARK, width: 18, color: "var(--ink-1)", background: "rgba(176,196,221,0.5)" }}>2</span> emitted that many events
        </span>
        <span style={{ ...BODY, color: "var(--ink-2)", whiteSpace: "nowrap", display: "inline-flex", alignItems: "center", gap: 6 }}>
          <span style={{ ...MARK, width: 18, color: "var(--err)", background: "rgba(248,113,113,0.16)", boxShadow: "inset 0 0 0 1px rgba(248,113,113,0.55)" }}>✕</span> read failed
        </span>
        <span style={{ ...BODY, color: "var(--ink-2)", whiteSpace: "nowrap" }}>– no read recorded</span>
        <span style={{ ...BODY, color: "var(--ink-3)", marginLeft: "auto", whiteSpace: "nowrap" }}>columns A–Z · hover a mark for adapter, time and read ms</span>
      </div>
      {recorded.length > 0 && (
        <Footnote>
          Across these {recorded.length} tick{recorded.length === 1 ? "" : "s"}:{" "}
          {summary.errors.length
            ? <span style={{ color: "var(--err)" }}>failed reads {summary.errors.map(([name, n]) => `${name} ×${n}`).join(", ")}</span>
            : <span style={{ color: "var(--ok)" }}>no failed reads</span>}
          <span style={{ color: "var(--ink-3)" }}> · </span>
          {summary.events.length ? <>emitted {summary.events.map(([name, n]) => `${name} ${n}`).join(", ")}</> : "nothing emitted"}
          {summary.slowest && <><span style={{ color: "var(--ink-3)" }}> · </span>slowest read {summary.slowest[0]}, median {msText(summary.slowest[1])}</>}
        </Footnote>
      )}
    </div>
  );
}

/* ──────────────────────────── roll call and stream (v3) ──────────────────────────── */

/** Cadence in the unit that keeps it short: 15m, 2h, 1d. */
function cadenceText(minutes: number | null): string {
  if (minutes == null) return "no cadence";
  if (minutes < 90) return `≤${minutes}m`;
  if (minutes < 2880) return `≤${Math.round(minutes / 60)}h`;
  return `≤${Math.round(minutes / 1440)}d`;
}

const ROLL_STATE_WORD: Record<EmitterState, string> = {
  never: "never posted", error: "read failed", quiet: "past cadence", watching: "watching", live: "live",
};

/** Why a late emitter is late, in words. */
function lateReason(row: Row): ReactNode {
  if (row.state === "never") return "has never posted";
  if (row.state === "error") return `last read failed${row.lastReadError ? `: ${row.lastReadError}` : ""}`;
  return <>silent <b style={{ fontFamily: MONO, fontWeight: 700, fontSize: "1.1em" }}>{ageText(row.lastAgeMinutes)}</b>, expects an event every {cadenceText(row.cadenceMinutes).replace("≤", "")}</>;
}
/** How far past its cadence a late emitter is. Never-posted and failed reads outrank any lateness. */
function overdue(row: Row): number {
  if (row.state === "never" || row.state === "error") return Infinity;
  return row.lastAgeMinutes != null && row.cadenceMinutes ? row.lastAgeMinutes / row.cadenceMinutes : 0;
}
/** A small group heading inside a section. */
function GroupLabel({ children }: { children: ReactNode }) {
  return <div style={{ ...BODY, fontSize: 14, color: "var(--ink-3)", margin: "0 0 8px" }}>{children}</div>;
}

/** Every registered emitter. The ones that need a look come first, each on its own line with the
    reason in words; the healthy rest follow as a compact roll, read down two columns. */
function RollCall({ rows: served, scale, active, onPick }: {
  rows: Row[]; scale: number; active: string | null; onPick: (source: string | null) => void;
}) {
  const isLate = (row: Row) => row.state === "never" || row.state === "error" || row.state === "quiet";
  const late = served.filter((row) => !row.isSelf && isLate(row)).sort((a, b) => overdue(b) - overdue(a));
  // Vigil's own heartbeat reads last: it is the instrument, not one of the voices.
  const rest = [...served.filter((row) => !row.isSelf && !isLate(row)), ...served.filter((row) => row.isSelf)];
  const half = Math.ceil(rest.length / 2);
  const pick = (row: Row) => onPick(active === row.source ? null : row.source);
  const hint = (row: Row) => `${row.source} · ${ROLL_STATE_WORD[row.state]}${row.lastReadError ? ` · ${row.lastReadError}` : ""}${row.isSelf ? " · Vigil's own heartbeat, out of every total" : ""} — click to ${active === row.source ? "show every source" : "filter the stream"}`;
  return (
    <div data-rollcall>
      {late.length > 0 && <GroupLabel>Need a look · {late.length}, most overdue first</GroupLabel>}
      {late.length > 0 && (
        <div data-roll-late className="vigil-late">
          {late.map((row) => {
            const on = active === row.source;
            return (
              <button key={row.source} type="button" data-emitter={row.source} data-emitter-state={row.state}
                aria-pressed={on} onClick={() => pick(row)} title={hint(row)} className="vigil-late-row"
                style={{ boxShadow: `inset 3px 0 0 ${STATE_COLOR[row.state]}`, background: on ? "rgba(128,204,255,0.10)" : "rgba(251,191,36,0.05)" }}>
                <span style={{ minWidth: 0 }}>
                  <span style={{ ...BODY, fontSize: 18, fontWeight: 700, display: "block", color: "var(--ink-1)" }}>{row.source}</span>
                  <span className="vigil-late-why-inline" style={{ ...BODY, fontSize: 14, display: "none", color: STATE_COLOR[row.state] }}>{lateReason(row)}</span>
                </span>
                <span style={{ ...BODY, fontSize: 16, color: STATE_COLOR[row.state], minWidth: 0 }}>{lateReason(row)}</span>
                <Tempo tempo={row.tempo} scale={scale} dim={false} />
                <span style={{ ...FIG, textAlign: "right", color: "var(--ink-2)", whiteSpace: "nowrap" }}>
                  {row.count24h == null || row.state === "never" ? "—" : count(row.count24h)}<span style={{ color: "var(--ink-3)" }}> /24h</span>
                </span>
              </button>
            );
          })}
        </div>
      )}
      <GroupLabel>{late.length > 0 ? "Healthy" : "All reporting"} · {rest.filter((row) => !row.isSelf).length}{rest.some((row) => row.state === "watching") ? `, ${rest.filter((row) => row.state === "watching").length} watching with nothing to report yet` : ""}</GroupLabel>
      <div className="vigil-roll" style={{ gridTemplateRows: `repeat(${half}, auto)` }}>
        {rest.map((row) => {
          const on = active === row.source;
          const age = row.state === "never" ? "never" : row.state === "watching" ? "watching" : ageText(row.lastAgeMinutes);
          return (
            <button key={row.source} type="button" data-emitter={row.source} data-emitter-state={row.state}
              aria-pressed={on} onClick={() => pick(row)} title={hint(row)} className="vigil-roll-row"
              style={{
                opacity: row.isSelf ? 0.5 : 1,
                boxShadow: on ? "inset 2px 0 0 var(--accent-soft)" : undefined,
                background: on ? "rgba(128,204,255,0.08)" : undefined,
              }}>
              <span aria-hidden style={{ color: STATE_COLOR[row.state], fontSize: 10 }}>●</span>
              <span style={{ ...BODY, color: on ? "var(--ink-1)" : "var(--ink-2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textAlign: "left" }}>
                {row.source}{row.isSelf && <span style={{ color: "var(--ink-3)" }}> · self</span>}
              </span>
              <span style={{ ...FIG, textAlign: "right", whiteSpace: "nowrap", color: "var(--ink-3)" }}>
                {age}
                {row.cadenceMinutes != null && <span> / {cadenceText(row.cadenceMinutes)}</span>}
              </span>
              <Tempo tempo={row.tempo} scale={scale} dim={true} />
              <span style={{ ...FIG, textAlign: "right", color: "var(--ink-3)" }}>
                {row.state === "never" || row.state === "watching" || row.count24h == null ? "—" : count(row.count24h)}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Consecutive rows that say the same thing (same source, kind, title) fold into one line with a count. */
function foldRuns(rows: FeedRow[]): FeedRow[][] {
  const groups: FeedRow[][] = [];
  const same = (a: FeedRow, b: FeedRow) => a.type === b.type && a.decision === b.decision
    && about(a).source === about(b).source && about(a).kind === about(b).kind && about(a).severity === about(b).severity
    && (a.type === "notification" ? a.subject?.title === b.subject?.title : a.title === b.title);
  for (const row of rows) {
    const last = groups[groups.length - 1];
    if (last && same(last[0], row)) last.push(row); else groups.push([row]);
  }
  return groups;
}

/** One list for everything that arrived: events, and the tick's decisions about them.
    Routine rows (info, low) read quieter than the ones that matter; repeats fold. Click a row for its JSON. */
function Stream({ rows, events, fresh, now }: { rows: FeedRow[]; events: VEvent[]; fresh: Map<string, number>; now: number }) {
  const [open, setOpen] = useState<string | null>(null);
  const [unfolded, setUnfolded] = useState<Set<string>>(() => new Set());
  const byId = useMemo(() => new Map(events.filter((event) => event.id).map((event) => [event.id as string, event])), [events]);
  const groups = useMemo(() => foldRuns(rows), [rows]);
  const line = (row: FeedRow, repeat: number, key: string, onClick: () => void) => {
    const subject = about(row);
    const arrived = fresh.get(row.id), isFresh = arrived != null && now - arrived < FRESH_MS;
    const routine = row.type === "event" && (subject.severity === "info" || subject.severity === "low");
    const critical = subject.severity === "critical";
    const decisionTone = row.decision === "failed" ? "var(--err)" : row.decision === "held" ? "var(--warn)" : "var(--ok)";
    const title = row.type === "notification" ? row.subject?.title ?? "event no longer in the list" : row.title;
    const summary = row.type === "notification" ? row.reason : row.summary;
    return (
      <div key={key} role="listitem" data-stream-row={row.type} data-severity={subject.severity} data-repeat={repeat > 1 ? repeat : undefined}
        className={`vigil-stream-row${isFresh ? " vigil-arrived" : ""}`} onClick={onClick}
        style={{
          boxShadow: `inset 3px 0 0 ${routine ? "var(--line-1)" : SEV_COLOR[subject.severity] ?? "var(--line-2)"}`,
          background: critical ? CRIT_WASH : open === row.id ? "rgba(176,196,221,0.05)" : undefined,
        }}>
        <span style={{ ...FIG, color: "var(--ink-3)", paddingTop: 3 }} title={fmtDateTime(row.ts)}>{clock(row.ts)}</span>
        <span style={{ minWidth: 0 }}>
          <span style={{ ...BODY, fontSize: 16, display: "block", color: routine ? "var(--ink-2)" : "var(--ink-1)", fontWeight: routine ? 600 : 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {row.type === "notification" && (
              <span style={{ color: decisionTone }}>{row.decision === "held" ? "Text held" : row.decision === "failed" ? "Text failed" : "Text sent"} → </span>
            )}
            {isFresh && <span style={{ color: "var(--accent-soft)" }}>new · </span>}
            {title}
            {repeat > 1 && <span style={{ ...FIG, marginLeft: 8, padding: "0 6px", borderRadius: 4, background: "rgba(176,196,221,0.12)", color: "var(--ink-2)" }}>×{repeat}</span>}
          </span>
          {summary && (
            <span style={{ ...BODY, ...CLAMP2, fontSize: 15, lineHeight: 1.4, marginTop: 2, color: routine ? "var(--ink-3)" : "var(--ink-2)" }}>
              {repeat > 1 ? `newest: ${summary}` : summary}
            </span>
          )}
        </span>
        <span className="vigil-stream-source" style={{ minWidth: 0, paddingTop: 2 }}>
          <span style={{ ...BODY, display: "block", color: "var(--ink-2)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{subject.source}</span>
          <span style={{ ...FIG, display: "block", color: "var(--ink-3)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {subject.kind} · <span style={{ color: SEV_COLOR[subject.severity] ?? "var(--ink-3)" }}>{subject.severity}</span>
          </span>
        </span>
        <span style={{ ...FIG, color: "var(--ink-3)", textAlign: "right", paddingTop: 3 }}>{ageText((now - Date.parse(row.ts)) / 60_000)}</span>
      </div>
    );
  };
  const json = (row: FeedRow) => (
    <pre key={`${row.id}:json`} style={{ ...FIG, margin: "0 0 8px 3px", padding: "10px 14px", background: "rgba(176,196,221,0.05)", borderLeft: "1px solid var(--line-2)", color: "var(--ink-2)", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
      <JsonCode value={byId.get(row.id) ?? row} />
    </pre>
  );
  return (
    <div data-stream role="list">
      {groups.map((group) => {
        const head = group[0];
        const expandedRun = group.length > 1 && unfolded.has(head.id);
        if (group.length > 1 && !expandedRun) {
          return line(head, group.length, head.id, () => setUnfolded((old) => new Set(old).add(head.id)));
        }
        return group.map((row) => (
          <Fragment key={row.id}>
            {line(row, 1, row.id, () => setOpen(open === row.id ? null : row.id))}
            {open === row.id && json(row)}
          </Fragment>
        ));
      })}
    </div>
  );
}

/** A segmented filter: one button per value, the active one lit. */
function Segment({ options, value, onPick }: {
  options: Array<{ id: string | null; label: string; n?: number; tone?: string }>; value: string | null; onPick: (id: string | null) => void;
}) {
  return (
    <div role="group" style={{ display: "inline-flex", border: "1px solid var(--line-2)", borderRadius: 8, overflowX: "auto", maxWidth: "100%", flex: "none" }}>
      {options.map((option, index) => {
        const on = option.id === value;
        return (
          <button key={option.label} type="button" aria-pressed={on} data-filter={option.id ?? "all"} onClick={() => onPick(on && option.id != null ? null : option.id)}
            style={{
              ...BODY, fontSize: 14, padding: "4px 12px", border: 0, cursor: "pointer", whiteSpace: "nowrap",
              borderLeft: index === 0 ? 0 : "1px solid var(--line-2)",
              background: on ? "rgba(128,204,255,0.14)" : "transparent",
              color: on ? "var(--ink-1)" : option.n === 0 ? "var(--ink-3)" : "var(--ink-2)",
            }}>
            {option.tone && <span aria-hidden style={{ color: option.tone, marginRight: 6, fontSize: 9, verticalAlign: "middle" }}>●</span>}
            {option.label}
            {option.n != null && <span style={{ ...FIG, fontSize: 12, marginLeft: 6, color: "var(--ink-3)" }}>{count(option.n)}</span>}
          </button>
        );
      })}
    </div>
  );
}


/* ──────────────────────────── page ──────────────────────────── */

export default function VigilPage() {
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [severityFilter, setSeverityFilter] = useState<string | null>(null);
  const [sourceFilter, setSourceFilter] = useState<string | null>(null);
  const [kindFilter, setKindFilter] = useState<string | null>(null);
  const [notificationsOnly, setNotificationsOnly] = useState(false);
  const [feedOpen, setFeedOpen] = useState(false);
  const [tab, setTab] = useState<TabId>("activity");
  useEffect(() => {
    try {
      const saved = localStorage.getItem(TAB_KEY);
      if (saved && TABS.some((entry) => entry.id === saved)) setTab(saved as TabId);
    } catch { /* storage blocked: the default tab is fine */ }
  }, []);
  const pickTab = useCallback((id: TabId) => {
    setTab(id);
    try { localStorage.setItem(TAB_KEY, id); } catch { /* per-viewer convenience only */ }
  }, []);
  /** What arrived while the page was open (ISC-66). The first load marks nothing: everything is old news then. */
  const [freshTick, setFreshTick] = useState<{ ts: string; at: number } | null>(null);
  const [freshIds, setFreshIds] = useState<Map<string, number>>(() => new Map());
  const seen = useRef<{ tick: string | null; ids: Set<string> } | null>(null);

  // Polls every POLL_MS; the query pauses while the browser tab is hidden and catches up when it comes back.
  const vigil = useApi<Payload>("/api/vigil", { refetchInterval: POLL_MS, retry: false });
  const data = vigil.data ?? null;
  const fetchedAt = vigil.dataUpdatedAt || null;

  /** A single missed read never repaints the page as broken. */
  const misses = useRef(0);
  useEffect(() => {
    if (!vigil.errorUpdatedAt) return;
    misses.current += 1;
    if (misses.current >= MISSES_BEFORE_ERROR) setFetchError(`/api/vigil is unreachable — ${vigil.error?.message ?? "no answer"}`);
  }, [vigil.errorUpdatedAt, vigil.error]);

  useEffect(() => {
    const payload = vigil.data;
    const at = vigil.dataUpdatedAt;
    if (!payload || !at) return;
    misses.current = 0;
    const newestTick = payload.pings?.ticks?.[0]?.ts ?? payload.clock?.last_tick_ts ?? null;
    const feed = Array.isArray(payload.feed) ? payload.feed : deriveFeed(payload.events ?? []);
    const ids = new Set(feed.map((row) => row.id));
    if (seen.current) {
      const previous = seen.current;
      if (newestTick && newestTick !== previous.tick) setFreshTick({ ts: newestTick, at });
      const arrived = feed.filter((row) => !previous.ids.has(row.id)).map((row) => row.id);
      setFreshIds((old) => {
        const next = new Map([...old].filter(([, when]) => at - when < FRESH_MS));
        for (const id of arrived) next.set(id, at);
        return next;
      });
    }
    seen.current = { tick: newestTick, ids };
    setFetchError(null);
    setNow(at);
  }, [vigil.data, vigil.dataUpdatedAt]);

  const allEvents = useMemo(() => data?.events ?? [], [data]);
  const realEvents = useMemo(() => allEvents.filter((event) => event.source !== SELF), [allEvents]);
  const hiddenSelf = allEvents.length - realEvents.length;

  const { rows, fromRegistry } = useMemo(() => buildRows(data ?? {}, allEvents, now), [data, allEvents, now]);
  const feeders = rows.filter((row) => !row.isSelf);
  const tempoScale = useMemo(
    () => Math.max(1, ...feeders.flatMap((row) => row.tempo.map((value) => value ?? 0))),
    [feeders]);
  const tempoDerived = rows.some((row) => row.tempoIsDerived);
  const tempoCovered = useMemo(() => 24 - coverageFrom(allEvents, now), [allEvents, now]);

  const health = data?.health ?? null;
  const tickAge = health?.tick_age_minutes ?? data?.tick?.age_minutes ?? null;
  const tickStale = health?.tick_stale ?? data?.tick?.stale ?? false;
  const tickReason = health?.tick_reason ?? data?.tick?.reason ?? null;
  const store = health?.store ?? null;
  const storeBad = store != null && store.configured !== false && store.reachable === false;
  const selfCadence = rows.find((row) => row.isSelf)?.cadenceMinutes ?? null;
  const expectedRuns = health?.expected_runs_24h ?? (selfCadence ? Math.round(1440 / selfCadence) : null);
  const digestPending = health?.digest_pending ?? data?.digest_pending ?? null;
  const held = health?.held_24h ?? data?.held_24h ?? null;

  const timeline = useMemo(
    () => (Array.isArray(data?.timeline) ? data!.timeline! : realEvents.length ? deriveTimeline(realEvents, now) : []),
    [data, realEvents, now]);
  const timelineDerived = !Array.isArray(data?.timeline);
  const [hoverHour, setHoverHour] = useState<number | null>(null);
  /** Who posted in each hour, from the loaded events, for the timeline rollover. Keyed by hour start (ms). */
  const hourSources = useMemo(() => {
    const byHour = new Map<number, Map<string, number>>();
    for (const event of realEvents) {
      const ms = Date.parse(event.ts);
      if (!Number.isFinite(ms)) continue;
      const start = Math.floor(ms / HOUR) * HOUR;
      const counts = byHour.get(start) ?? new Map<string, number>();
      counts.set(event.source, (counts.get(event.source) ?? 0) + 1);
      byHour.set(start, counts);
    }
    return new Map([...byHour].map(([start, counts]) => [start, [...counts].sort((a, b) => b[1] - a[1])] as const));
  }, [realEvents]);
  const coverageStart = useMemo(() => {
    const stamps = allEvents.map((event) => Date.parse(event.ts)).filter((ms) => Number.isFinite(ms));
    return stamps.length ? Math.floor(Math.min(...stamps) / HOUR) * HOUR + HOUR : Infinity;
  }, [allEvents]);
  const timelineMax = Math.max(1, ...timeline.map((bucket) => SEVERITIES.reduce((sum, key) => sum + (bucket[key] ?? 0), 0)));
  /** The busiest hour, named, so the tall bar is not a mystery. */
  const peak = useMemo(() => {
    if (timeline.length === 0) return null;
    const totals = timeline.map((bucket) => SEVERITIES.reduce((sum, key) => sum + (bucket[key] ?? 0), 0));
    const index = totals.indexOf(Math.max(...totals));
    if (totals[index] === 0) return null;
    const top = feeders.reduce<Row | null>((best, row) =>
      (row.tempo[index] ?? 0) > (best?.tempo[index] ?? 0) ? row : best, null);
    return {
      index,
      total: totals[index],
      hour: hourLabel(timeline[index].hour_start),
      source: (top?.tempo[index] ?? 0) > 0 ? top?.source : undefined,
    };
  }, [timeline, feeders]);

  // Activity by type (ISC-68): served by the API, or counted from the loaded events and said so.
  const kinds = useMemo<Kinds>(() => {
    if (data?.kinds && Array.isArray(data.kinds.rows)) return data.kinds;
    const rowsByKind = new Map<string, KindRow>();
    for (const event of realEvents) {
      const ms = Date.parse(event.ts);
      if (!Number.isFinite(ms) || ms < now - 86_400_000 || ms > now) continue;
      const row = rowsByKind.get(event.kind) ?? { kind: event.kind, count_1h: 0, count_24h: 0, by_severity_24h: {}, last_ts: null };
      row.count_24h++; if (ms >= now - HOUR) row.count_1h++;
      row.by_severity_24h![event.severity] = (row.by_severity_24h![event.severity] ?? 0) + 1;
      if (!row.last_ts || event.ts > row.last_ts) row.last_ts = event.ts;
      rowsByKind.set(event.kind, row);
    }
    const list = [...rowsByKind.values()].sort((a, b) => b.count_1h - a.count_1h || b.count_24h - a.count_24h || a.kind.localeCompare(b.kind));
    return { rows: list, total_1h: list.reduce((n, r) => n + r.count_1h, 0), total_24h: list.reduce((n, r) => n + r.count_24h, 0), notifications: null };
  }, [data, realEvents, now]);
  const kindsDerived = !(data?.kinds && Array.isArray(data.kinds.rows));
  const kindMax = Math.max(1, ...(kinds.rows ?? []).flatMap((row) => SEVERITIES.map((severity) => row.by_severity_24h?.[severity] ?? 0)));

  const ledger = useMemo(
    () => (Array.isArray(data?.ledger) ? data!.ledger!.slice(0, 20) : deriveLedger(allEvents)),
    [data, allEvents]);
  const ledgerDerived = !Array.isArray(data?.ledger);

  // The feed: newest events and notifications, heartbeat excluded. A notification files under the event it decided on.
  const feed = useMemo(() => (Array.isArray(data?.feed) ? data!.feed! : deriveFeed(allEvents)), [data, allEvents]);
  const feedDerived = !Array.isArray(data?.feed);
  // Chips in a FIXED order: the five severities, then every registered emitter.
  const severityCounts = SEVERITIES.map((severity) => ({ severity, n: feed.filter((row) => about(row).severity === severity).length }));
  const sourceChips = (rows.length ? rows.map((row) => row.source) : [...new Set(feed.map((row) => about(row).source))].sort())
    .filter((source) => source !== SELF);
  const shown = feed.filter((row) => {
    const subject = about(row);
    return (!severityFilter || subject.severity === severityFilter) && (!sourceFilter || subject.source === sourceFilter)
      && (!kindFilter || subject.kind === kindFilter) && (!notificationsOnly || row.type === "notification");
  });
  const filtering = severityFilter != null || sourceFilter != null || kindFilter != null || notificationsOnly;
  const visible = feedOpen || filtering ? shown : shown.slice(0, FEED_FOLD);
  const notes = kinds.notifications ?? null;
  const tickClock = data?.clock ?? null;

  // Totals over the timeline's own window, so the caption figure is the ink on the bars.
  const sum24 = (key: Severity) => timeline.reduce((total, bucket) => total + (bucket[key] ?? 0), 0);
  const critical24 = sum24("critical");
  const high24 = sum24("high");
  const total24 = SEVERITIES.reduce((total, key) => total + sum24(key), 0);
  // The Activity band reads the same rolling 24 h as its kinds table, so its summary and the table agree.
  const kindSeverity = (severity: Severity) => (kinds.rows ?? []).reduce((n, row) => n + (row.by_severity_24h?.[severity] ?? 0), 0);
  const kindCritical24 = kindSeverity("critical");
  const kindHigh24 = kindSeverity("high");

  // What is actually waiting on him, as prose. Each clause appears only when non-zero,
  // so an empty line is the real answer and not a formatting accident.
  const needs = useMemo(() => {
    const clauses: Array<{ key: string; text: string; tone?: string }> = [];
    const names = (rows_: Row[]) => rows_.map((row) => row.source).join(", ");

    const failed = health?.failed_24h ?? 0;
    if (failed > 0) {
      const recent = ledger.filter((entry) => entry.decision === "failed" && now - Date.parse(entry.ts) <= 86_400_000);
      const bySeverity = SEVERITIES
        .map((severity) => ({ severity, n: recent.filter((entry) => entry.event?.severity === severity).length }))
        .filter((pair) => pair.n > 0);
      const sources = [...new Set(recent.map((entry) => entry.event?.source).filter(Boolean))];
      const detail = bySeverity.length
        ? ` (${bySeverity.map((pair) => `${pair.n} ${pair.severity}`).join(", ")}${sources.length ? ` — ${sources.join(", ")}` : ""})`
        : "";
      clauses.push({ key: "failed", text: `${failed} text${failed === 1 ? "" : "s"} failed to send in the last 24h${detail}`, tone: "var(--err)" });
    }

    if (storeBad) clauses.push({ key: "store", text: "the event store is unreachable", tone: "var(--err)" });

    const never = feeders.filter((row) => row.state === "never");
    if (never.length) clauses.push({ key: "never", text: `${never.length} emitter${never.length === 1 ? " has" : "s have"} never posted (${names(never)})`, tone: "var(--err)" });

    const errored = feeders.filter((row) => row.state === "error");
    if (errored.length) clauses.push({ key: "error", text: `${errored.length} emitter${errored.length === 1 ? "" : "s"} failed the last read (${names(errored)})`, tone: "var(--err)" });

    const quiet = feeders.filter((row) => row.state === "quiet");
    if (quiet.length) clauses.push({ key: "quiet", text: `${quiet.length} emitter${quiet.length === 1 ? " is" : "s are"} past cadence (${names(quiet)})`, tone: "var(--warn)" });

    if ((held ?? 0) > 0) clauses.push({ key: "held", text: `${held} event${held === 1 ? "" : "s"} held back from texting`, tone: "var(--warn)" });

    // A row stamped ahead of the clock is a bad timestamp somewhere upstream; the Store tab names it.
    const newest = (data?.database?.store ?? store)?.newest_ts;
    if (newest && Date.parse(newest) > now + 60_000) {
      clauses.push({ key: "future", text: `the store holds a row dated ${newest.slice(0, 10)}, in the future (Store tab)`, tone: "var(--warn)" });
    }

    return clauses;
  }, [health, ledger, storeBad, feeders, held, now, data, store]);

  const alarm = tickStale || storeBad || fetchError != null;
  const late = feeders.filter((row) => row.state === "never" || row.state === "error" || row.state === "quiet");
  const live = feeders.filter((row) => row.state === "live" || row.state === "watching");
  const sep = <span style={{ color: "var(--ink-3)" }}> · </span>;
  // The headline: what needs him, short. The full clauses sit in its title and in the roll call below.
  const headline = needs.map((clause) => ({
    key: clause.key, tone: clause.tone,
    text: clause.key === "quiet" ? `${feeders.filter((row) => row.state === "quiet").length} emitter${feeders.filter((row) => row.state === "quiet").length === 1 ? "" : "s"} past cadence`
      : clause.key === "never" ? `${feeders.filter((row) => row.state === "never").length} never posted`
      : clause.key === "error" ? `${feeders.filter((row) => row.state === "error").length} failed their read`
      : clause.key === "failed" ? `${health?.failed_24h ?? 0} text${(health?.failed_24h ?? 0) === 1 ? "" : "s"} failed`
      : clause.key === "held" ? `${held} event${held === 1 ? "" : "s"} held back`
      : clause.key === "future" ? "the store holds a future-dated row"
      : clause.text,
  }));

  return (
    <PageShell className="vigil-instrument">
      <style>{`
        .vigil-instrument table { width: 100%; table-layout: fixed; border-collapse: collapse; }
        .vigil-instrument tbody tr:hover { background: rgba(176,196,221,0.045); }
        .vigil-instrument th { text-align: left; padding: 0 12px 8px 0; }
        /* Roll call: two columns read top to bottom, one on narrow screens. */
        .vigil-roll { display: grid; grid-auto-flow: column; grid-template-columns: repeat(2, minmax(0, 1fr)); column-gap: 40px; }
        .vigil-roll-row { display: grid; grid-template-columns: 12px minmax(90px, 1fr) 136px minmax(96px, 200px) 44px; align-items: center; column-gap: 14px;
          width: 100%; padding: 7px 10px 7px 12px; border: 0; border-bottom: 1px solid var(--line-1); background: transparent; cursor: pointer; text-align: left; color: inherit; }
        .vigil-roll-row:hover { background: rgba(176,196,221,0.05) !important; }
        /* Emitters that need a look: their own lines, reason in words, two across on a wide screen. */
        .vigil-late { display: grid; grid-template-columns: minmax(0, 1fr); gap: 8px; margin-bottom: 20px; }
        .vigil-late-row { display: grid; grid-template-columns: minmax(160px, 260px) minmax(0, 1fr) minmax(160px, 420px) 84px; align-items: center; column-gap: 18px;
          width: 100%; padding: 12px 14px 12px 18px; border: 0; border-radius: 0 6px 6px 0; cursor: pointer; text-align: left; color: inherit; }
        .vigil-late-row:hover { filter: brightness(1.15); }
        @media (max-width: 900px) { .vigil-late-row { grid-template-columns: minmax(0, 1fr) 72px; } .vigil-late-row > :nth-child(2), .vigil-late-row > :nth-child(3) { display: none; } }
        @media (max-width: 900px) { .vigil-late-row .vigil-late-why-inline { display: block !important; } }
        @media (max-width: 1100px) { .vigil-roll { grid-auto-flow: row; grid-template-columns: minmax(0, 1fr); grid-template-rows: none !important; } }
        @media (max-width: 560px) { .vigil-roll-row { grid-template-columns: 12px minmax(0, 1fr) auto; } .vigil-roll-row > :nth-child(4), .vigil-roll-row > :nth-child(5) { display: none; } }
        /* Stream rows: time · what · source · age. The source column folds away on a phone. */
        .vigil-stream-row { display: grid; grid-template-columns: 60px minmax(0, 1fr) minmax(150px, 220px) 48px; column-gap: 20px; align-items: start;
          padding: 12px 6px 12px 18px; border-bottom: 1px solid var(--line-1); cursor: pointer; }
        .vigil-stream-row:hover { background: rgba(176,196,221,0.05); }
        @media (max-width: 760px) { .vigil-stream-row { grid-template-columns: 48px minmax(0, 1fr) 40px; } .vigil-stream-source { display: none; } }
        .vigil-select { font-family: var(--sans); font-weight: 600; font-size: 14px; color: var(--ink-1); background: var(--surface-1); border: 1px solid var(--line-2); border-radius: 8px; padding: 4px 10px; }
        /* The stats readouts, now inside the Activity tab. */
        .vigil-stats { display: grid; grid-template-columns: minmax(360px, 2.1fr) repeat(4, minmax(150px, 1fr)); border-top: 1px solid var(--line-1); margin-top: 18px; }
        .vigil-readout { min-width: 0; padding: 12px 16px; border-left: 1px solid var(--line-1); }
        .vigil-readout:first-child { padding-left: 0; border-left: 0; }
        .vigil-rate { padding-right: 28px; }
        @media (max-width: 1100px) {
          .vigil-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
          .vigil-rate { grid-column: 1 / -1; padding-left: 0; border-left: 0; }
          .vigil-readout:nth-child(2), .vigil-readout:nth-child(4) { padding-left: 0; border-left: 0; }
          .vigil-readout { border-top: 1px solid var(--line-1); }
          .vigil-rate { border-top: 0; }
        }
        /* A row that arrived while the page was open flashes once; its "new" marker stays. */
        @keyframes vigil-arrive { from { background-color: rgba(128,204,255,0.20); } to { background-color: transparent; } }
        .vigil-arrived { animation: vigil-arrive 2.4s ease-out 1; }
        @keyframes vigil-breathe { 0%, 100% { opacity: 1; } 50% { opacity: 0.45; } }
        .vigil-pulse { animation: vigil-breathe 2s ease-in-out infinite; }
        @media (prefers-reduced-motion: reduce) { .vigil-instrument * { transition: none !important; animation: none !important; } }
      `}</style>

      <PageHeader title="Vigil" subtitle="Every subsystem logs here. The five-minute tick decides what reaches you."
        actions={<span style={{ ...BODY, color: "var(--ink-2)" }}><LiveRead fetchedAt={fetchedAt} error={fetchError != null} pollMs={POLL_MS} /></span>} />

      {/* ── The verdict: what needs him, in one sentence, then every figure beside what it should be. ── */}
      <section data-band="verdict" data-tick-health={tickStale ? "stale" : "fresh"}
        style={{ paddingBottom: 20, borderBottom: `1px solid ${alarm ? "var(--err)" : "var(--line-1)"}` }}>
        <p data-verdict style={{ ...VERDICT, margin: 0, color: alarm ? "var(--err)" : "var(--ink-1)" }}
          title={needs.map((clause) => clause.text).join("\n") || undefined}>
          {!data && !fetchError && <span style={{ color: "var(--ink-3)" }}>Reading /api/vigil…</span>}
          {fetchError && <>The page can&apos;t reach Vigil: {fetchError}</>}
          {data && !fetchError && tickStale && <>Vigil has stopped ticking{tickReason ? `: ${tickReason}` : ""}</>}
          {data && !fetchError && !tickStale && storeBad && <>The event store is unreachable</>}
          {data && !fetchError && !alarm && (headline.length === 0
            ? <span>All quiet. <span style={{ color: "var(--ink-2)" }}>Nothing needs you.</span></span>
            : headline.map((clause, index) => (
                <Fragment key={clause.key}>
                  {index > 0 && <span style={{ color: "var(--ink-3)" }}> · </span>}
                  <span style={{ color: clause.tone ?? "var(--ink-1)" }}>{clause.text}</span>
                </Fragment>
              )))}
        </p>
        {data && !fetchError && (
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "8px 24px", marginTop: 10 }}>
            <p data-needs-you style={{ ...BODY, margin: 0, color: "var(--ink-2)", minWidth: 0 }}>
              <TickAge clock={tickClock} staleFromServer={tickStale} fallbackMinutes={tickAge} cadence={selfCadence} />
              {sep}<span style={NOWRAP}><Num value={count(health?.runs_24h)} tone="var(--ink-1)" /> of <Num value={expectedRuns == null ? "—" : count(expectedRuns)} /> runs in 24h</span>
              {sep}<span style={NOWRAP}>texts <Num value={count(health?.texts_24h)} tone="var(--ink-1)" /> of <Num value={count(health?.text_ceiling)} /> today</span>
              {sep}<span style={NOWRAP}>digest <Num value={count(digestPending)} tone="var(--ink-1)" /></span>
              {sep}<span style={NOWRAP}>held <Num value={count(held)} tone={(held ?? 0) > 0 ? "var(--warn)" : "var(--ink-1)"} /></span>
              {sep}<span style={NOWRAP}>failed <Num value={count(health?.failed_24h)} tone={(health?.failed_24h ?? 0) > 0 ? "var(--err)" : "var(--ink-1)"} /></span>
              {sep}{store == null ? <span style={NOWRAP}>store —</span>
                : store.configured === false ? <span style={NOWRAP}>store not configured</span>
                : store.reachable === false ? <span style={{ ...NOWRAP, color: "var(--err)" }}>store unreachable</span>
                : store.reachable == null ? <span style={{ ...NOWRAP, color: "var(--warn)" }}>store not checked</span>
                : <span style={NOWRAP}>store <Num value={count(store.rows)} tone="var(--ink-1)" /> rows</span>}
            </p>
            <span style={{ marginLeft: "auto", flex: "none" }}>
              <TickCountdown clock={tickClock} staleFromServer={tickStale} fallbackMinutes={tickAge} cadence={selfCadence} />
            </span>
          </div>
        )}
        {data && !health && !fetchError && (
          <p role="status" style={{ ...BODY, color: "var(--warn)", margin: "8px 0 0" }}>
            /api/vigil serves no health object yet, so runs, store, texts and failures read “—”: unreported, not zero.
          </p>
        )}
      </section>

      {/* ── The stream: one list, newest first, heartbeat left out. ── */}
      <Band id="stream" label="Events"
        meta={data ? <>newest first · {count(kinds.total_1h)} in the last hour, {count(kinds.total_24h)} in 24h · heartbeat hidden · click a row for its JSON</> : "…"}>
        <div data-filters style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10, paddingBottom: 12 }}>
          <Segment value={severityFilter} onPick={setSeverityFilter}
            options={[{ id: null, label: "All", n: feed.length }, ...severityCounts.map(({ severity, n }) => ({ id: severity, label: severity, n, tone: SEV_COLOR[severity] }))]} />
          <select className="vigil-select" aria-label="Filter by source" value={sourceFilter ?? ""}
            onChange={(event) => setSourceFilter(event.target.value || null)}>
            <option value="">every source</option>
            {sourceChips.map((source) => {
              const n = feed.filter((row) => about(row).source === source).length;
              return <option key={source} value={source}>{source} ({n})</option>;
            })}
          </select>
          <Segment value={notificationsOnly ? "texts" : null} onPick={(id) => setNotificationsOnly(id === "texts")}
            options={[{ id: "texts", label: "texts only", n: feed.filter((row) => row.type === "notification").length }]} />
          {filtering && (
            <button type="button" data-clear-filters
              onClick={() => { setSeverityFilter(null); setSourceFilter(null); setKindFilter(null); setNotificationsOnly(false); }}
              style={{ ...BODY, fontSize: 14, marginLeft: "auto", background: "transparent", border: 0, padding: "2px 0", cursor: "pointer", color: "var(--accent-soft)", whiteSpace: "nowrap" }}>
              clear filters{kindFilter ? ` (kind: ${kindFilter})` : ""}
            </button>
          )}
        </div>
        {shown.length === 0
          ? <Missing>{data ? (feed.length === 0 ? "Nothing in the feed yet." : "Nothing in the feed matches that filter.") : "…"}</Missing>
          : <Stream rows={visible} events={allEvents} fresh={freshIds} now={now} />}
        {data && shown.length > visible.length && (
          <button type="button" data-feed-more onClick={() => setFeedOpen(true)}
            style={{ ...BODY, fontSize: 14, background: "transparent", border: 0, padding: "10px 0 0", cursor: "pointer", color: "var(--accent-soft)" }}>
            Show all {shown.length}
          </button>
        )}
        {data && feedOpen && !filtering && shown.length > FEED_FOLD && (
          <button type="button" onClick={() => setFeedOpen(false)}
            style={{ ...BODY, fontSize: 14, background: "transparent", border: 0, padding: "10px 0 0", cursor: "pointer", color: "var(--accent-soft)" }}>
            Show the newest {FEED_FOLD}
          </button>
        )}
        {data && feedDerived && <Footnote>/api/vigil serves no feed yet; these rows are read from the loaded event list.</Footnote>}
      </Band>

      {/* ── Roll call: who feeds me, and who fell silent. ── */}
      <Band id="emitters" label="Emitters"
        meta={data
          ? <>{feeders.length} registered{late.length ? <> · <span style={{ color: "var(--warn)" }}>{late.length} need a look</span></> : ""} · {live.length} live · bars are events per hour, last {!tempoDerived || tempoCovered >= 24 ? "24h" : `${tempoCovered}h`} · click one to filter</>
          : "…"}>
        {rows.length === 0
          ? <Missing>{data ? "No emitters served and no sources have posted." : "…"}</Missing>
          : <RollCall rows={rows} scale={tempoScale} active={sourceFilter} onPick={setSourceFilter} />}
        {data && !fromRegistry && (
          <Missing>/api/vigil serves no emitters array yet, so this lists only the sources that have posted. An emitter that never posted is missing.</Missing>
        )}
      </Band>

      {/* ── The breakdowns. Every figure the API serves stays one click away. ── */}
      <div>
        <Tabs active={tab} onPick={pickTab} />
        <div style={{ paddingTop: 20 }}>

      {tab === "activity" && <Band id="activity" label="Activity by kind"
        meta={data
          ? <>last 24h · heartbeat excluded · <span style={{ color: kindCritical24 > 0 ? "var(--err)" : undefined }}>{count(kindCritical24)} critical</span>, {count(kindHigh24)} high{kindsDerived ? " · counted from the loaded event list" : ""} · click a kind to filter the stream</>
          : "…"}>
        {(kinds.rows ?? []).length === 0
          ? <Missing>{data ? "No events in the last 24 hours once the heartbeat is excluded." : "…"}</Missing>
          : (
            <table data-kinds>
              <colgroup>
                <col style={{ width: 190 }} /><col style={{ width: 72 }} /><col style={{ width: 72 }} />
                {SEVERITIES.map((severity) => <col key={severity} />)}
                <col style={{ width: 96 }} />
              </colgroup>
              <thead>
                <tr>
                  <th style={{ ...LABEL, ...FIRST }}>kind</th>
                  <th style={{ ...LABEL, textAlign: "right", paddingRight: 14 }}>1h</th>
                  <th style={{ ...LABEL, textAlign: "right", paddingRight: 14 }}>24h</th>
                  {SEVERITIES.map((severity) => (
                    <th key={severity} style={{ ...LABEL, textAlign: "right", paddingRight: 14 }}>
                      <span style={{ display: "inline-block", width: 7, height: 7, background: SEV_COLOR[severity], marginRight: 6, verticalAlign: "middle" }} />{severity}
                    </th>
                  ))}
                  <th style={{ ...LABEL, textAlign: "right", paddingRight: 0 }}>newest</th>
                </tr>
              </thead>
              <tbody>
                {(kinds.rows ?? []).map((row) => {
                  const active = kindFilter === row.kind;
                  return (
                    <tr key={row.kind} data-kind={row.kind} style={{ borderTop: HAIRLINE, background: active ? "rgba(128,204,255,0.07)" : undefined }}>
                      <td style={{ ...CELL, ...FIRST, boxShadow: active ? "inset 2px 0 0 var(--accent-soft)" : undefined }}>
                        <button type="button" aria-pressed={active} onClick={() => setKindFilter(active ? null : row.kind)}
                          title={active ? "Show every kind in the feed" : `Show only ${row.kind} in the feed below`}
                          style={{ ...BODY, background: "transparent", border: 0, padding: 0, cursor: "pointer", color: "var(--ink-1)", textDecoration: active ? "none" : "underline", textDecorationColor: "var(--line-2)", textUnderlineOffset: 3 }}>
                          {row.kind}
                        </button>
                      </td>
                      <td style={{ ...NUM, color: row.count_1h === 0 ? "var(--ink-3)" : "var(--ink-1)" }}>{row.count_1h === 0 ? "·" : <Num value={count(row.count_1h)} />}</td>
                      <td style={NUM}><Num value={count(row.count_24h)} /></td>
                      {SEVERITIES.map((severity) => {
                        const value = row.by_severity_24h?.[severity] ?? 0;
                        return (
                          <td key={severity} style={{ ...NUM, color: value === 0 ? "var(--ink-3)" : severity === "critical" ? "var(--err)" : undefined, background: value === 0 ? undefined : `rgba(176,196,221,${(0.04 + 0.18 * Math.sqrt(value / kindMax)).toFixed(3)})` }}>
                            {value === 0 ? "·" : <Num value={count(value)} />}
                          </td>
                        );
                      })}
                      <td style={{ ...NUM, paddingRight: 0, color: "var(--ink-2)" }}>{row.last_ts ? <Num value={ageText((now - Date.parse(row.last_ts)) / 60_000)} unit=" ago" /> : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}

        {/* What the tick did about them: texts sent, held, failed. */}
        <div data-notifications style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: "4px 14px", padding: "10px 0 4px", borderTop: HAIRLINE }}>
          <span style={{ ...BODY, color: "var(--ink-2)" }}>Texts, last hour / 24h</span>
          {notes
            ? (["sent", "held", "failed"] as const).map((decision) => {
                const value = notes[decision] ?? { count_1h: 0, count_24h: 0 };
                const tone = value.count_24h === 0 ? "var(--ink-3)" : decision === "failed" ? "var(--err)" : decision === "held" ? "var(--warn)" : "var(--ink-1)";
                return (
                  <span key={decision} data-notification={decision} style={{ ...BODY, whiteSpace: "nowrap" }}>
                    <span style={{ color: "var(--ink-2)" }}>{decision} </span>
                    <span style={{ color: tone }}><Num value={count(value.count_1h)} /> / <Num value={count(value.count_24h)} /></span>
                  </span>
                );
              })
            : <span style={{ ...BODY, color: "var(--warn)" }}>not served — the notification counts are unreported, not zero</span>}
        </div>

        {data && !fetchError && (data.stats
          ? <StatsStrip stats={data.stats} />
          : <Missing>/api/vigil serves no stats object yet: the rate, the minute strip and the day&apos;s totals are unreported, not zero.</Missing>)}
      </Band>}

      {/* ── Recent pings: every adapter's read on each of the last twelve ticks (ISC-67). ── */}
      {tab === "pings" && <Band id="pings" label="Recent pings"
        meta={data?.pings
          ? `last ${data.pings.ticks?.length ?? 0} ticks, newest first · one mark per adapter per tick · a tick every ${Math.round((data.pings.interval_seconds ?? 300) / 60)}m`
          : data ? undefined : "…"}>
        {!data
          ? <Missing>…</Missing>
          : !data.pings
            ? <Missing>/api/vigil serves no pings yet — per-adapter reads are unreported, not clean.</Missing>
            : (data.pings.ticks ?? []).length === 0
              ? <Missing>No ticks recorded in ticks.jsonl yet.</Missing>
              : <PingsPanel pings={data.pings} freshTick={freshTick && now - freshTick.at < FRESH_MS ? freshTick.ts : null} />}
      </Band>}

      {/* ── What I decided to tell him. A decision outranks an event, so it sits above the stream. ── */}
      {tab === "ledger" && <Band id="ledger" label="Routing ledger" meta={ledger.length ? `last ${ledger.length} decisions, newest first` : undefined}>
        {ledger.length === 0
          ? <Missing>{data ? "No routing decisions recorded in this window." : "…"}</Missing>
          : (
            <table>
              {/* The event is the row's subject, so it takes the widest column; source
                  rides in front of the title and the two narrative cells wrap instead. */}
              {/* Event takes half the row and reason 22%; severity rides in the event
                  prefix beside its source so both stay legible at this width. */}
              <colgroup>
                <col style={{ width: 70 }} /><col style={{ width: 96 }} />
                <col style={{ width: "50%" }} /><col style={{ width: "20%" }} /><col />
              </colgroup>
              <thead>
                <tr>
                  <th style={{ ...LABEL, ...FIRST }}>time</th>
                  <th style={LABEL}>decision</th>
                  <th style={LABEL}>event</th>
                  <th style={LABEL}>reason</th>
                  <th style={LABEL}>state inputs</th>
                </tr>
              </thead>
              <tbody>
                {ledger.map((entry, index) => {
                  const previous = ledger[index - 1];
                  const opensGroup = !previous
                    || previous.event?.source !== entry.event?.source
                    || previous.event?.severity !== entry.event?.severity;
                  const critical = entry.event?.severity === "critical";
                  return (
                    <tr key={`${entry.ts}-${index}`} data-decision={entry.decision ?? "unknown"}
                      style={{ borderTop: opensGroup ? HAIRLINE : "none", background: critical ? CRIT_WASH : undefined }}>
                      <td style={{ ...CELL, ...FIRST, color: "var(--ink-3)", boxShadow: critical ? CRIT_RULE : undefined }}>{clock(entry.ts)}</td>
                      <td style={CELL}><Pill dim={DECISION_DIM[entry.decision ?? ""] ?? "neutral"}>{entry.decision ?? "unknown"}</Pill></td>
                      <td style={CELL} title={entry.event?.title ?? undefined}>
                        <span style={{ color: "var(--ink-3)" }}>{entry.event?.source ?? "—"}{" · "}</span>
                        <span style={{ color: SEV_COLOR[entry.event?.severity ?? ""] ?? "var(--ink-3)" }}>{entry.event?.severity ?? "—"}{" · "}</span>
                        <span style={{ color: "var(--ink-1)", fontWeight: critical ? 700 : undefined }}>{entry.event?.title ?? "—"}</span>
                      </td>
                      <td style={{ ...WRAP2, color: "var(--ink-2)" }} title={entry.reason ?? undefined}>
                        <span style={CLAMP2}>{entry.reason ?? "no reason recorded"}</span>
                      </td>
                      <td style={{ ...WRAP2, color: "var(--ink-2)" }}>
                        <span style={CLAMP3}><StateInputsCell inputs={entry.state_inputs} /></span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        {data && ledgerDerived && (
          <Missing>
            /api/vigil serves no ledger array yet — these rows are read straight from the notification records in the event list, so a decision that wrote no record is not here.
          </Missing>
        )}
      </Band>}

      {/* ── The shape of the day. The kind-by-severity breakdown lives in the Activity band now. ── */}
      {tab === "timeline" && <Band id="timeline" label="Timeline">
        {timeline.length === 0
          ? <Missing>{data ? "No events in the last 24 hours once the heartbeat is excluded." : "…"}</Missing>
          : (
            <>
              {/* The spike explains itself: which hour, how many, and who sent them. */}
              <div style={{ position: "relative", height: 18 }}>
                {peak && (
                  <span style={{
                    ...BODY, position: "absolute", bottom: 0, whiteSpace: "nowrap", color: "var(--ink-2)",
                    ...(peak.index > 14
                      ? { right: `${((24 - peak.index - 1) / 24) * 100}%` }
                      : { left: `${(peak.index / 24) * 100}%` }),
                  }}>
                    {peak.hour}:00 <span style={{ color: "var(--ink-3)" }}>·</span> {peak.total} events
                    {peak.source && <> <span style={{ color: "var(--ink-3)" }}>·</span> {peak.source}</>}
                  </span>
                )}
              </div>
              {/* Gridline every six hours, the current hour washed, and a solid baseline
                  so an empty hour still reads as an hour rather than as missing data. */}
              <div style={{ position: "relative" }} onMouseLeave={() => setHoverHour(null)}>
              {hoverHour != null && timeline[hoverHour] && (() => {
                const bucket = timeline[hoverHour];
                const start = Date.parse(bucket.hour_start);
                const total = SEVERITIES.reduce((sum, key) => sum + (bucket[key] ?? 0), 0);
                const sources = hourSources.get(start) ?? [];
                const hour = fmtClock(start);
                const end = fmtClock(start + HOUR);
                const covered = start >= coverageStart;
                return (
                  <div data-timeline-tip role="tooltip" style={{
                    ...BODY, position: "absolute", bottom: "calc(100% + 8px)", zIndex: 5, minWidth: 220, maxWidth: 320,
                    padding: "8px 12px", background: "var(--surface-2, var(--surface-1))", border: "1px solid var(--line-2)",
                    boxShadow: "0 6px 18px rgba(0,0,0,0.35)", pointerEvents: "none",
                    ...(hoverHour > 14 ? { right: `${((timeline.length - hoverHour - 1) / timeline.length) * 100}%` } : { left: `${(hoverHour / timeline.length) * 100}%` }),
                  }}>
                    <div style={{ color: "var(--ink-1)" }}>{hour}–{end}{hoverHour === timeline.length - 1 ? " (current hour)" : ""} · {total} event{total === 1 ? "" : "s"}</div>
                    {SEVERITIES.filter((severity) => (bucket[severity] ?? 0) > 0).map((severity) => (
                      <div key={severity} style={{ display: "flex", alignItems: "center", color: "var(--ink-2)" }}>
                        <span style={{ display: "inline-block", width: 8, height: 8, background: SEV_COLOR[severity], marginRight: 6 }} />
                        {severity}<span style={{ marginLeft: "auto", paddingLeft: 12 }}>{bucket[severity]}</span>
                      </div>
                    ))}
                    {sources.length > 0 && (
                      <div style={{ borderTop: HAIRLINE, marginTop: 6, paddingTop: 6 }}>
                        {sources.slice(0, 6).map(([source, n]) => (
                          <div key={source} style={{ display: "flex", color: "var(--ink-2)" }}>
                            {source}<span style={{ marginLeft: "auto", paddingLeft: 12 }}>{n}</span>
                          </div>
                        ))}
                        {sources.length > 6 && <div style={{ color: "var(--ink-3)" }}>+{sources.length - 6} more sources</div>}
                      </div>
                    )}
                    {!covered && total > 0 && <div style={{ color: "var(--ink-3)", marginTop: 4 }}>sources: older than the loaded event list</div>}
                  </div>
                );
              })()}
              <div style={{ display: "flex", gap: 3, alignItems: "flex-end", height: 72, borderBottom: "1px solid var(--ink-3)" }}>
                {timeline.map((bucket, index) => {
                  const isNow = index === timeline.length - 1;
                  return (
                    <div key={bucket.hour_start ?? index} data-hour={bucket.hour_start} onMouseEnter={() => setHoverHour(index)}
                      style={{
                        flex: 1, height: "100%", display: "flex", flexDirection: "column", justifyContent: "flex-end", cursor: "default",
                        borderLeft: index % 6 === 0 ? "1px solid var(--line-2)" : undefined,
                        background: hoverHour === index ? "rgba(176,196,221,0.12)" : isNow ? "rgba(128,204,255,0.07)" : undefined,
                      }}>
                      {[...SEVERITIES].reverse().map((severity) => {
                        const value = bucket[severity] ?? 0;
                        if (value === 0) return null;
                        return <span key={severity} style={{ height: `${(value / timelineMax) * 100}%`, minHeight: 2, background: SEV_COLOR[severity] }} />;
                      })}
                    </div>
                  );
                })}
              </div>
              </div>
              <div style={{ display: "flex", gap: 3, marginTop: 4 }}>
                {timeline.map((bucket, index) => {
                  const isNow = index === timeline.length - 1;
                  const label = isNow ? "now" : index % 6 === 0 ? `${hourLabel(bucket.hour_start)}:00` : "";
                  return (
                    <span key={index} style={{ ...BODY, flex: 1, color: isNow ? "var(--accent-soft)" : "var(--ink-3)", textAlign: isNow ? "right" : "left", overflow: "visible", whiteSpace: "nowrap" }}>
                      {label}
                    </span>
                  );
                })}
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "4px 14px", paddingTop: 8 }}>
                <span style={{ ...BODY, color: "var(--ink-2)" }}>
                  events per hour, last 24h · bar = one hour · colour = severity · tallest bar {timelineMax}/h · heartbeat excluded ({hiddenSelf} hidden)
                  {timelineDerived && " · counted from the loaded event list, not a served timeline"}
                </span>
                <span style={{ ...BODY, marginLeft: "auto", whiteSpace: "nowrap" }}>
                  <span style={{ color: "var(--ink-2)" }}>24h total </span>
                  <Num value={count(total24)} />
                  <span style={{ color: "var(--ink-2)" }}> · </span>
                  <Num value={count(critical24)} tone={critical24 > 0 ? "var(--err)" : undefined} />
                  <span style={{ color: "var(--ink-2)" }}> critical · </span>
                  <Num value={count(high24)} />
                  <span style={{ color: "var(--ink-2)" }}> high</span>
                </span>
                <span style={{ display: "flex", gap: 12 }}>
                  {SEVERITIES.map((severity) => (
                    <span key={severity} style={{ ...BODY, color: "var(--ink-2)", whiteSpace: "nowrap" }}>
                      <span style={{ display: "inline-block", width: 8, height: 8, background: SEV_COLOR[severity], marginRight: 5 }} />
                      {severity}
                    </span>
                  ))}
                </span>
              </div>
            </>
          )}

      </Band>}
      {tab === "database" && <Band id="database" label="Event store" meta={data ? "the D1 store and the local outbox · re-read every 15 s while this page is open" : "…"}>
        {!data ? <Missing>…</Missing> : <DatabasePanel database={data.database} fallbackStore={data.health?.store} now={now} />}
      </Band>}

      {tab === "latest" && <Band id="latest" label="Raw events"
        meta={data ? `newest ${Math.min(LATEST_COUNT, allEvents.length)} of ${allEvents.length} loaded · every field as served, heartbeat included · click a row for its JSON` : "…"}>
        {!data ? <Missing>…</Missing> : <LatestEvents events={allEvents} fresh={freshIds} />}
      </Band>}

        </div>
      </div>

      <p style={{ ...BODY, fontSize: 13, color: "var(--ink-3)", margin: 0 }}>
        Vigil implementation: LIFEOS/VIGIL
      </p>
    </PageShell>
  );
}
