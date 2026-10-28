import { PRIVATE_SKILL_NAMES } from "../../TOOLS/CodeDataBoundary.ts";
import { DIMENSIONS, freshnessTier, readLog, deriveCurrent } from "../../TOOLS/State.ts";
/**
 * Today Pulse module — the daily front door (the `/` and `/today` pages).
 *
 * Composes one payload from sources the system already owns and never invents
 * a number: the calendar tool (agenda), the Work board + Achilles + Vigil
 * (blockers), the Work board (top work), Prioritize (the recommended move),
 * HealthSync's Oura files (body) and the State journal (mood). Every probe is
 * fail-soft: a failing source fills `errors[source]` and its panel renders the
 * error, never a blank page. A source that is absent from this install (a private
 * subsystem a public install does not carry) or not yet set up is not an error:
 * its probe throws `SourceUnavailable` and it lands in `unavailable[source]`,
 * which the panel renders as a designed empty state (or nothing, when the
 * source does not apply to this install).
 *
 * Routes:
 *   GET  /api/today            → composed payload (?fresh=1 bypasses the cache)
 *   POST /api/today/checkin    → { dim, value? } appended through State.ts log
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { getClaudeDir } from "../../TOOLS/Paths.ts";
import { principalTimezone } from "../../TOOLS/lib/Timezone.ts";

const run = promisify(execFile);
const MODULE_NAME = "today";
const REMOTE_TTL_MS = 60_000;
const CALENDAR_TTL_MS = 5 * 60_000;

function claudeDir(): string {
  return getClaudeDir();
}
const lifeosDir = () => join(claudeDir(), "LIFEOS");
const userDir = () => join(lifeosDir(), "USER");
const pulseOrigin = () => `http://127.0.0.1:${process.env.PULSE_PORT || "31337"}`;

// ── Types ──

export type Severity = "critical" | "high" | "medium";

export interface CalendarItem {
  id?: string;
  summary?: string;
  status?: string;
  calendar?: string;
  location?: string;
  htmlLink?: string;
  hangoutLink?: string;
  start?: { date?: string; dateTime?: string };
  end?: { date?: string; dateTime?: string };
  attendees?: Array<{ self?: boolean; responseStatus?: string }>;
}

export interface AgendaEvent {
  id: string;
  title: string;
  calendar: string | null;
  start: string;
  end: string;
  startLabel: string;
  endLabel: string;
  minutes: number;
  location: string | null;
  link: string | null;
  state: "past" | "now" | "next" | "later";
  minutesUntil: number | null;
}

export interface DayFrame { title: string; day: number; of: number; calendar: string | null }

export interface Agenda {
  date: string;
  events: AgendaEvent[];
  allDay: Array<{ title: string; calendar: string | null }>;
  frames: DayFrame[];
  next: AgendaEvent | null;
  current: AgendaEvent | null;
  tomorrow: AgendaEvent[];
  bookedMinutes: number;
  remainingMinutes: number;
}

export interface Blocker {
  id: string;
  source: "work" | "achilles" | "vigil" | "system";
  severity: Severity;
  title: string;
  detail: string | null;
  href: string;
  ts: string | null;
  count: number;
}

export interface WorkIssue {
  number: number;
  title: string;
  url?: string;
  state?: string;
  labels: string[];
  updatedAt?: string;
  column: string;
}

export interface RankedWork {
  number: number;
  title: string;
  url: string | null;
  column: string;
  priority: number | null;
  owner: "you" | "needs-you" | "unassigned" | "agent";
  fire: boolean;
  updatedAt: string | null;
}

export interface Recommendation {
  id: string;
  title: string;
  why: string;
  next_action: string;
  priority: string;
  confidence: number;
  category: string;
  evidence: Array<{ label: string; url?: string; source: string }>;
  context: string[];
  alsoOnDeck: Array<{ id: string; title: string; priority: string }>;
  summary: string | null;
  generated_at: string | null;
}

export interface HealthDay {
  date: string;
  sleep_score: number | null;
  readiness: number | null;
  sleep_h: number | null;
  efficiency: number | null;
  hrv: number | null;
  resting_hr: number | null;
  steps: number | null;
  activity: number | null;
}

export interface MoodDim {
  dim: string;
  name: string;
  label: string;
  kind: "rating" | "freshness";
  value: number | null;
  ts: string | null;
  ageHours: number | null;
  tier: "fresh" | "aging" | "stale" | "never";
  note: string | null;
}

// ── Unavailable sources (absent from this install, or not set up yet) ──

export type UnavailableState = "not-installed" | "not-configured";

export interface Unavailable {
  state: UnavailableState;
  /** Short heading for the empty state, e.g. "No calendar connected". */
  title: string;
  /** One sentence for a stranger: what it is and how to set it up. Null = show nothing. */
  message: string | null;
}

/** Thrown by a probe whose source is absent or unconfigured; `settle` files it under `unavailable`, never `errors`. */
export class SourceUnavailable extends Error {
  readonly unavailable: Unavailable;
  constructor(state: UnavailableState, title: string, message: string | null) {
    super(title);
    this.name = "SourceUnavailable";
    this.unavailable = { state, title, message };
  }
}

/**
 * Read a sibling module's own "this subsystem is not here" answer. A module whose
 * implementation is absent answers `{ available: false }`; one that needs setup
 * answers `{ setup_required: true }`. Anything else is not an unavailability.
 */
export function unavailableFrom(body: unknown): { kind: "absent" | "setup"; reason: string | null } | null {
  if (!body || typeof body !== "object") return null;
  const b = body as { available?: unknown; setup_required?: unknown; reason?: unknown };
  const reason = typeof b.reason === "string" && b.reason.trim() ? b.reason.trim() : null;
  if (b.available === false) return { kind: "absent", reason };
  if (b.setup_required === true) return { kind: "setup", reason };
  return null;
}

// ── Time helpers (24-hour, principal-local) ──

export function localDateKey(d: Date, timeZone?: string): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

export function hhmm(d: Date, timeZone?: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
}

function dayDiff(a: string, b: string): number {
  // Whole days from date key a to date key b (both YYYY-MM-DD).
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

// ── Agenda ──

function declined(it: CalendarItem): boolean {
  return Boolean(it.attendees?.some((a) => a.self && a.responseStatus === "declined"));
}

export function dayFrames(items: CalendarItem[], today: string): DayFrame[] {
  const frames: DayFrame[] = [];
  for (const it of items) {
    const s = it.start?.date, e = it.end?.date;
    if (!s || !e || it.status === "cancelled") continue;
    const of = dayDiff(s, e); // end date is exclusive
    if (of < 2 || today < s || today >= e) continue;
    frames.push({ title: it.summary || "(untitled)", day: dayDiff(s, today) + 1, of, calendar: it.calendar ?? null });
  }
  return frames.sort((a, b) => b.of - a.of);
}

export function buildAgenda(items: CalendarItem[], now: Date, timeZone?: string): Agenda {
  const today = localDateKey(now, timeZone);
  const tomorrowKey = localDateKey(new Date(now.getTime() + 86_400_000), timeZone);
  const live = items.filter((it) => it.status !== "cancelled" && !declined(it));
  const timed = (key: string) =>
    live
      .filter((it) => it.start?.dateTime && it.end?.dateTime && localDateKey(new Date(it.start.dateTime), timeZone) === key)
      .map((it) => {
        const s = new Date(it.start!.dateTime!), e = new Date(it.end!.dateTime!);
        return {
          id: it.id || `${s.toISOString()}-${it.summary}`,
          title: it.summary || "(untitled)",
          calendar: it.calendar ?? null,
          start: s.toISOString(),
          end: e.toISOString(),
          startLabel: hhmm(s, timeZone),
          endLabel: hhmm(e, timeZone),
          minutes: Math.max(0, Math.round((e.getTime() - s.getTime()) / 60_000)),
          location: it.location ?? null,
          link: it.hangoutLink ?? it.htmlLink ?? null,
          state: "later" as AgendaEvent["state"],
          minutesUntil: null as number | null,
        };
      })
      .sort((a, b) => a.start.localeCompare(b.start) || a.title.localeCompare(b.title));

  const events = timed(today);
  const t = now.getTime();
  let next: AgendaEvent | null = null, current: AgendaEvent | null = null;
  for (const ev of events) {
    const s = Date.parse(ev.start), e = Date.parse(ev.end);
    if (e <= t) ev.state = "past";
    else if (s <= t) { ev.state = "now"; current ??= ev; }
    else {
      ev.minutesUntil = Math.round((s - t) / 60_000);
      if (!next) { ev.state = "next"; next = ev; }
    }
  }
  const remaining = events.filter((ev) => ev.state !== "past");
  const allDay = live
    .filter((it) => it.start?.date && it.end?.date && it.start.date <= today && today < it.end.date && dayDiff(it.start.date, it.end.date) < 2)
    .map((it) => ({ title: it.summary || "(untitled)", calendar: it.calendar ?? null }));

  return {
    date: today,
    events,
    allDay,
    frames: dayFrames(live, today),
    next,
    current,
    tomorrow: timed(tomorrowKey).slice(0, 4),
    bookedMinutes: events.reduce((n, ev) => n + ev.minutes, 0),
    remainingMinutes: remaining.reduce((n, ev) => n + Math.max(0, Math.round((Date.parse(ev.end) - Math.max(t, Date.parse(ev.start))) / 60_000)), 0),
  };
}

// ── Work ──

export function priorityOf(labels: string[]): number | null {
  for (const l of labels) {
    const m = /^Priority:P(\d)$/i.exec(l);
    if (m) return Number(m[1]);
  }
  return null;
}

/** Read the principal's lane label (e.g. `Agent:<name>`) from the WORK config; empty when unset. */
export function principalLane(configYaml: string): string {
  return /^\s*AGENT_LABEL:\s*"?([^"\n#]+?)"?\s*(?:#.*)?$/m.exec(configYaml)?.[1]?.trim() ?? "";
}

/**
 * Rank the board for a human: fires (P0 before P1) first, then your own lane and
 * needs-human items, then priority, then In-Progress before Queued. Blocked,
 * closed and complete items leave; agent-owned sweeps leave unless they sit in
 * your lane or are a fire.
 */
export function rankWork(items: WorkIssue[], lane: string, limit = 6): RankedWork[] {
  const laneLc = lane.toLowerCase();
  const owner = (i: WorkIssue): RankedWork["owner"] => {
    if (laneLc && i.labels.some((l) => l.toLowerCase() === laneLc)) return "you";
    if (i.labels.some((l) => /^Status:needs-human$/i.test(l))) return "needs-you";
    if (i.labels.some((l) => /^agent:/i.test(l))) return "agent";
    return "unassigned";
  };
  const pr = (i: WorkIssue) => priorityOf(i.labels) ?? 9;
  return items
    .filter((i) => (i.state ?? "OPEN").toUpperCase() === "OPEN")
    .filter((i) => !/^(blocked|complete|done|in-review|content)$/i.test(i.column))
    .filter((i) => !i.labels.some((l) => /^(?:Status:)?(?:blocked|done|complete)$/i.test(l)))
    .map((i) => ({ i, o: owner(i), p: pr(i) }))
    .filter(({ o, p }) => o !== "agent" || p <= 1)
    .sort((a, b) =>
      Number(b.p <= 1) - Number(a.p <= 1) ||
      // Among fires a P0 outranks a P1 whoever owns it; below that, your lane leads.
      (a.p <= 1 && b.p <= 1 ? a.p - b.p : 0) ||
      Number(b.o === "you" || b.o === "needs-you") - Number(a.o === "you" || a.o === "needs-you") ||
      a.p - b.p ||
      Number(b.i.column === "In-Progress") - Number(a.i.column === "In-Progress") ||
      (b.i.updatedAt ?? "").localeCompare(a.i.updatedAt ?? ""))
    .slice(0, limit)
    .map(({ i, o, p }) => ({
      number: i.number,
      title: i.title,
      url: i.url ?? null,
      column: i.column,
      priority: p === 9 ? null : p,
      owner: o,
      fire: p <= 1,
      updatedAt: i.updatedAt ?? null,
    }));
}

// ── Blockers ──

const SEV_RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2 };

export interface BlockerInputs {
  workColumns?: Record<string, WorkIssue[] | Array<Omit<WorkIssue, "column">>> | null;
  achilles?: Array<{ id: string; title: string; severity?: string; status?: string; first_seen?: string; affected?: string[] }> | null;
  vigilEvents?: Array<{ id: string; ts: string; title: string; summary?: string | null; severity: string; source?: string; kind?: string }> | null;
  vigilTick?: { stale?: boolean; age_minutes?: number; reason?: string | null } | null;
}

export function mergeBlockers(input: BlockerInputs, now: Date, limit = 12): { items: Blocker[]; total: number } {
  const out: Blocker[] = [];
  for (const issue of (input.workColumns?.Blocked ?? []) as WorkIssue[]) {
    const p = priorityOf(issue.labels ?? []);
    out.push({
      id: `work-${issue.number}`,
      source: "work",
      severity: p === 0 ? "critical" : p === 1 ? "high" : "medium",
      title: issue.title,
      detail: `#${issue.number} · blocked on the board`,
      href: issue.url ?? "/work",
      ts: issue.updatedAt ?? null,
      count: 1,
    });
  }
  for (const f of input.achilles ?? []) {
    // Achilles counts open and in_progress as outstanding (achilles.ts isOpen): remediation under way is still a blocker.
    if (f.status && f.status !== "open" && f.status !== "in_progress") continue;
    if (f.severity !== "critical" && f.severity !== "high") continue;
    out.push({
      id: `achilles-${f.id}`,
      source: "achilles",
      severity: f.severity,
      title: f.title,
      detail: `${f.id}${f.affected?.length ? ` · ${f.affected.join(", ")}` : ""}`,
      href: "/achilles",
      ts: f.first_seen ?? null,
      count: 1,
    });
  }
  const since = now.getTime() - 86_400_000;
  const vigil = new Map<string, Blocker>();
  for (const ev of input.vigilEvents ?? []) {
    if (ev.severity !== "critical" && ev.severity !== "high") continue;
    const t = Date.parse(ev.ts);
    if (!(t >= since && t <= now.getTime())) continue; // future-dated test rows never count
    const key = `${ev.source ?? ""}|${ev.title}`;
    const prev = vigil.get(key);
    if (prev) {
      prev.count += 1;
      if (ev.ts > (prev.ts ?? "")) prev.ts = ev.ts;
      if (SEV_RANK[ev.severity as Severity] < SEV_RANK[prev.severity]) prev.severity = ev.severity as Severity;
      continue;
    }
    vigil.set(key, {
      id: `vigil-${ev.id}`,
      source: "vigil",
      severity: ev.severity as Severity,
      title: ev.title,
      detail: ev.summary ?? ev.source ?? null,
      href: "/vigil",
      ts: ev.ts,
      count: 1,
    });
  }
  out.push(...vigil.values());
  if (input.vigilTick?.stale) {
    out.push({
      id: "system-vigil-tick",
      source: "system",
      severity: "high",
      title: "Vigil's monitoring tick is stale",
      detail: input.vigilTick.reason ?? `last tick ${input.vigilTick.age_minutes ?? "?"} min ago`,
      href: "/vigil",
      ts: null,
      count: 1,
    });
  }
  out.sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity] || (b.ts ?? "").localeCompare(a.ts ?? ""));
  return { items: out.slice(0, limit), total: out.length };
}

// ── Recommendation ──

export interface PrioritizeLatest {
  generated_at?: string;
  summary?: string;
  focus?: string[];
  recommendations?: Array<{
    id: string; title: string; why: string; next_action: string; priority: string;
    confidence: number; category: string; evidence?: Array<{ label: string; url?: string; source: string }>;
  }>;
}

export function contextNotes(agenda: Agenda | null, readiness: number | null, now: Date): string[] {
  const notes: string[] = [];
  const frame = agenda?.frames[0];
  if (frame) notes.push(`${frame.title}, day ${frame.day} of ${frame.of}.`);
  if (agenda) {
    if (agenda.current) notes.push(`In ${agenda.current.title} until ${agenda.current.endLabel}.`);
    if (agenda.next && agenda.next.minutesUntil !== null) {
      const m = agenda.next.minutesUntil;
      const until = m < 60 ? `${m} min` : `${Math.floor(m / 60)}h ${m % 60}m`;
      notes.push(`Next: ${agenda.next.title} at ${agenda.next.startLabel} (in ${until}).`);
    } else if (!agenda.current) {
      notes.push(agenda.events.length ? "Nothing else on the calendar today." : "Calendar is clear today.");
    }
  }
  if (readiness !== null) {
    notes.push(readiness >= 85 ? `Readiness ${readiness}: a good day for the hardest thing.`
      : readiness >= 70 ? `Readiness ${readiness}: normal capacity.`
      : `Readiness ${readiness}: low, so favor one contained task.`);
  }
  void now;
  return notes;
}

export function pickRecommendation(latest: PrioritizeLatest | null, context: string[]): Recommendation | null {
  const recs = latest?.recommendations ?? [];
  if (!recs.length) return null;
  const byId = new Map(recs.map((r) => [r.id, r]));
  const top = (latest?.focus ?? []).map((id) => byId.get(id)).find(Boolean)
    ?? recs.find((r) => r.priority === "now")
    ?? recs[0]!;
  const ordered = [
    ...(latest?.focus ?? []).map((id) => byId.get(id)).filter((r): r is NonNullable<typeof r> => Boolean(r)),
    ...recs,
  ];
  const seen = new Set([top.id]);
  const alsoOnDeck: Recommendation["alsoOnDeck"] = [];
  for (const r of ordered) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    alsoOnDeck.push({ id: r.id, title: r.title, priority: r.priority });
    if (alsoOnDeck.length >= 4) break;
  }
  return {
    id: top.id,
    title: top.title,
    why: top.why,
    next_action: top.next_action,
    priority: top.priority,
    confidence: top.confidence,
    category: top.category,
    evidence: (top.evidence ?? []).slice(0, 4).map((e) => ({ label: e.label, url: e.url, source: e.source })),
    context,
    alsoOnDeck,
    summary: latest?.summary ?? null,
    generated_at: latest?.generated_at ?? null,
  };
}

// ── Health ──

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function healthDayFrom(date: string, metrics: Record<string, unknown>): HealthDay {
  return {
    date,
    sleep_score: num(metrics.oura_sleep_score),
    readiness: num(metrics.oura_readiness_score),
    sleep_h: num(metrics.sleep_duration_h),
    efficiency: num(metrics.sleep_efficiency),
    hrv: num(metrics.avg_sleep_hrv),
    resting_hr: num(metrics.avg_sleep_hr),
    steps: num(metrics.steps),
    activity: num(metrics.oura_activity_score),
  };
}

function avg(xs: Array<number | null>): number | null {
  const v = xs.filter((x): x is number => x !== null);
  return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10 : null;
}

function readHealth(days = 8) {
  const healthDir = join(userDir(), "HEALTH");
  const currentPath = join(healthDir, "current.json");
  if (!existsSync(currentPath)) {
    throw new SourceUnavailable("not-configured", "No health data yet",
      "Sleep and readiness appear here once a health source is connected. Set one up with LIFEOS/TOOLS/InstallHealthSync.ts.");
  }
  const current = JSON.parse(readFileSync(currentPath, "utf8")) as {
    generated_at?: string; day?: string;
    last_night?: Record<string, number | null>;
    sources?: Record<string, { status?: string; lastSuccess?: string | null; lastError?: string | null }>;
  };
  const ouraDir = join(healthDir, "DATA", "oura");
  const series: HealthDay[] = [];
  if (existsSync(ouraDir)) {
    const files = readdirSync(ouraDir).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().slice(-days);
    for (const f of files) {
      try {
        const d = JSON.parse(readFileSync(join(ouraDir, f), "utf8")) as { metrics?: Record<string, unknown> };
        const day = healthDayFrom(f.slice(0, 10), d.metrics ?? {});
        if (day.sleep_score !== null || day.readiness !== null || day.sleep_h !== null) series.push(day);
      } catch { /* one unreadable day never hides the rest */ }
    }
  }
  const last7 = series.slice(-7);
  const sources = Object.entries(current.sources ?? {})
    .filter(([, s]) => s.status && s.status !== "unconfigured" && s.status !== "awaiting-first-export")
    .map(([name, s]) => ({ name, status: s.status!, lastSuccess: s.lastSuccess ?? null, lastError: s.lastError ?? null }));
  return {
    generated_at: current.generated_at ?? null,
    last_night: {
      sleep_h: num(current.last_night?.sleep_duration_h),
      efficiency: num(current.last_night?.sleep_efficiency),
      sleep_score: num(current.last_night?.oura_sleep_score),
      readiness: num(current.last_night?.oura_readiness_score),
    },
    series: last7,
    averages: {
      sleep_h: avg(last7.map((d) => d.sleep_h)),
      sleep_score: avg(last7.map((d) => d.sleep_score)),
      readiness: avg(last7.map((d) => d.readiness)),
      hrv: avg(last7.map((d) => d.hrv)),
      steps: avg(last7.map((d) => d.steps)),
    },
    sources,
  };
}

// ── Mood ──

const MOOD_ORDER = ["M", "E", "H", "S", "C", "CF", "R", "F", "W", "K", "A"];

export function buildMood(dims: Record<string, { value: number | null; ts: string; note?: string }>, now: Date): MoodDim[] {
  return MOOD_ORDER.filter((d) => DIMENSIONS[d]).map((d) => {
    const spec = DIMENSIONS[d];
    const cur = dims[d];
    const ageHours = cur ? Math.max(0, Math.round(((now.getTime() - Date.parse(cur.ts)) / 3_600_000) * 10) / 10) : null;
    return {
      dim: d,
      name: spec.name,
      label: spec.label,
      kind: spec.kind,
      value: cur?.value ?? null,
      ts: cur?.ts ?? null,
      ageHours,
      tier: cur ? freshnessTier(d, cur.ts, now) : "never",
      note: cur?.note ?? null,
    };
  });
}

function readMood(now: Date) {
  const current = deriveCurrent(readLog());
  const dims = buildMood(current.dims, now);
  const needsCheckin = dims.filter((d) => (d.dim === "M" || d.dim === "E") && d.tier !== "fresh").map((d) => d.dim);
  return { dims, needsCheckin };
}

// ── Remote probes (sibling modules over loopback; one cache per source) ──

const cache = new Map<string, { at: number; data: unknown }>();

async function cached<T>(key: string, ttl: number, fresh: boolean, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (!fresh && hit && Date.now() - hit.at < ttl) return hit.data as T;
  const data = await load();
  cache.set(key, { at: Date.now(), data });
  return data;
}

/** What each sibling source means to a stranger when it reports itself absent or unconfigured. */
const SOURCE_COPY: Record<string, { absent: Omit<Unavailable, "state">; setup: Omit<Unavailable, "state"> }> = {
  "/api/vigil": {
    // Vigil is an optional monitoring layer; when it is not installed the Blockers card simply leaves it out.
    absent: { title: "Monitoring not installed", message: null },
    setup: { title: "Monitoring not set up", message: null },
  },
  "/api/work": {
    absent: { title: "No work board", message: null },
    setup: { title: "No work board connected", message: "Top work lists your open issues once a private GitHub repo is bound as the work board (LIFEOS/USER/WORK/work_repo.json)." },
  },
  "/api/achilles": {
    absent: { title: "Security findings not installed", message: null },
    setup: { title: "Security findings not set up", message: null },
  },
  "/api/prioritize": {
    absent: { title: "Recommendations not installed", message: null },
    setup: { title: "Recommendations not set up", message: null },
  },
};

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${pulseOrigin()}${path}`, { signal: AbortSignal.timeout(15_000), redirect: "error" });
  let body: unknown = null;
  try { body = await res.json(); } catch { body = null; }
  const gone = unavailableFrom(body);
  if (gone) {
    const copy = SOURCE_COPY[path]?.[gone.kind];
    throw new SourceUnavailable(
      gone.kind === "absent" ? "not-installed" : "not-configured",
      copy?.title ?? (gone.kind === "absent" ? `${path} is not installed` : `${path} is not set up`),
      copy ? copy.message : gone.reason,
    );
  }
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
  if (body === null) throw new Error(`${path} → HTTP ${res.status}, body is not JSON`);
  return body as T;
}

function calendarTool(): string | null {
  const p = join(claudeDir(), "skills", PRIVATE_SKILL_NAMES.calendar, "Tools", "gcal.ts");
  return existsSync(p) ? p : null;
}

async function loadCalendar(now: Date): Promise<CalendarItem[]> {
  const tool = calendarTool();
  if (!tool) {
    throw new SourceUnavailable("not-installed", "No calendar connected",
      "Today's meetings appear on this timeline once a calendar skill with a gcal tool is installed.");
  }
  // From local midnight today through the end of tomorrow.
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start.getTime() + 2 * 86_400_000);
  let stdout: string;
  try {
    ({ stdout } = await run(process.execPath, [tool, "list", "--from", start.toISOString(), "--to", end.toISOString(), "--max", "100"], {
      timeout: 30_000,
      maxBuffer: 8_000_000,
    }));
  } catch (err) {
    throw calendarRunFailure(err);
  }
  const parsed = JSON.parse(stdout) as { items?: CalendarItem[] };
  return parsed.items ?? [];
}

/** gcal.ts exits 3 when no Google account is connected yet: that is a setup state, not an error. Any other failure stays an error. */
export function calendarRunFailure(err: unknown): Error {
  if ((err as { code?: unknown } | null)?.code === 3) {
    return new SourceUnavailable("not-configured", "No calendar connected",
      "Today's meetings appear on this timeline once a Google account is connected; the Calendar skill's Setup.md walks through it.");
  }
  return err instanceof Error ? err : new Error(String(err));
}

function readWorkLane(): string {
  const p = join(userDir(), "WORK", "config.yaml");
  return existsSync(p) ? principalLane(readFileSync(p, "utf8")) : "";
}

// ── Compose ──

export interface Probes {
  calendar: () => Promise<CalendarItem[]>;
  work: () => Promise<{ columns: Record<string, Array<Omit<WorkIssue, "column">>>; lastFetch?: string; stale?: boolean }>;
  achilles: () => Promise<{ open_critical?: BlockerInputs["achilles"]; stats?: { open?: number; open_high?: number; open_critical?: number }; exposure_line?: string | null; last_audit?: string | null }>;
  vigil: () => Promise<{ events?: BlockerInputs["vigilEvents"]; tick?: BlockerInputs["vigilTick"] }>;
  prioritize: () => Promise<{ latest: PrioritizeLatest | null }>;
  health: () => ReturnType<typeof readHealth>;
  mood: (now: Date) => ReturnType<typeof readMood>;
  lane: () => string;
}

async function settle<T>(
  name: string,
  errors: Record<string, string>,
  unavailable: Record<string, Unavailable>,
  fn: () => Promise<T> | T,
): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof SourceUnavailable) unavailable[name] = err.unavailable;
    else errors[name] = err instanceof Error ? err.message : String(err);
    return null;
  }
}

export async function compose(probes: Probes, now = new Date(), timeZone?: string) {
  const errors: Record<string, string> = {};
  const unavailable: Record<string, Unavailable> = {};
  const [cal, work, achilles, vigil, prio, health, mood] = await Promise.all([
    settle("calendar", errors, unavailable, probes.calendar),
    settle("work", errors, unavailable, probes.work),
    settle("achilles", errors, unavailable, probes.achilles),
    settle("vigil", errors, unavailable, probes.vigil),
    settle("prioritize", errors, unavailable, probes.prioritize),
    settle("health", errors, unavailable, probes.health),
    settle("mood", errors, unavailable, () => probes.mood(now)),
  ]);

  const agenda = cal ? buildAgenda(cal, now, timeZone) : null;
  const columns = work?.columns ?? null;
  const flat: WorkIssue[] = columns
    ? Object.entries(columns).flatMap(([column, list]) => list.map((i) => ({ ...i, labels: i.labels ?? [], column })))
    : [];
  const blockers = mergeBlockers(
    { workColumns: columns, achilles: achilles?.open_critical ?? null, vigilEvents: vigil?.events ?? null, vigilTick: vigil?.tick ?? null },
    now,
  );
  const readiness = health?.last_night.readiness ?? null;
  const recommendation = pickRecommendation(prio?.latest ?? null, contextNotes(agenda, readiness, now));
  const hour = Number(hhmm(now, timeZone).slice(0, 2));

  return {
    generated_at: now.toISOString(),
    date: localDateKey(now, timeZone),
    greeting: hour < 5 ? "Late night" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening",
    agenda,
    blockers: {
      ...blockers,
      counts: {
        board: (columns?.Blocked ?? []).length,
        achilles_open: achilles?.stats?.open ?? null,
        achilles_high: (achilles?.stats?.open_high ?? 0) + (achilles?.stats?.open_critical ?? 0),
        // The security audit report's opening line, verbatim (security-audit ISA ISC-105).
        exposure_line: achilles?.exposure_line ?? null,
        last_audit: achilles?.last_audit ?? null,
      },
    },
    work: columns
      ? {
          top: rankWork(flat, probes.lane()),
          counts: Object.fromEntries(Object.entries(columns).map(([c, l]) => [c, l.length])),
          stale: Boolean(work?.stale),
        }
      : null,
    recommendation,
    health,
    mood,
    errors,
    unavailable,
  };
}

const liveProbes = (fresh: boolean): Probes => ({
  calendar: () => cached("calendar", CALENDAR_TTL_MS, fresh, () => loadCalendar(new Date())),
  work: () => cached("work", REMOTE_TTL_MS, fresh, () => getJson("/api/work")),
  achilles: () => cached("achilles", REMOTE_TTL_MS, fresh, () => getJson("/api/achilles")),
  vigil: () => cached("vigil", REMOTE_TTL_MS, fresh, () => getJson("/api/vigil")),
  prioritize: () => cached("prioritize", REMOTE_TTL_MS, fresh, () => getJson("/api/prioritize")),
  health: () => readHealth(),
  mood: (now) => readMood(now),
  lane: readWorkLane,
});

// ── Check-in (the one write: the principal's own rating via the State journal) ──

export function checkinEntry(body: unknown): { entry: string } | { error: string } {
  const b = (body ?? {}) as { dim?: unknown; value?: unknown; note?: unknown };
  const dim = typeof b.dim === "string" ? b.dim.toUpperCase() : "";
  const spec = DIMENSIONS[dim];
  if (!spec) return { error: `unknown dimension: ${String(b.dim)}` };
  if (spec.kind === "freshness") {
    if (b.value !== undefined && b.value !== null) return { error: `${dim} is a freshness reset and takes no value` };
    return { entry: dim };
  }
  if (typeof b.value !== "number" || !Number.isInteger(b.value) || b.value < 1 || b.value > 5) {
    return { error: `${dim} needs an integer value 1-5` };
  }
  const note = typeof b.note === "string" ? b.note.replace(/[\r\n]+/g, " ").trim().slice(0, 200) : "";
  return { entry: note ? `${dim}${b.value} ${note}` : `${dim}${b.value}` };
}

async function handleCheckin(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "body must be JSON" }, { status: 400 });
  }
  const parsed = checkinEntry(body);
  if ("error" in parsed) return Response.json(parsed, { status: 400 });
  const tool = join(lifeosDir(), "TOOLS", "State.ts");
  try {
    const { stdout } = await run(process.execPath, [tool, "log", parsed.entry, "--source", "manual"], { timeout: 15_000 });
    return Response.json({ ok: true, entry: parsed.entry, out: stdout.trim(), mood: readMood(new Date()) });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

// ── Module contract ──

let lastCompose: { at: string; errors: number; unavailable: string[] } | null = null;

export async function start(): Promise<void> {}
export async function stop(): Promise<void> {}

export function health(): { status: string; details?: Record<string, unknown> } {
  return { status: "ok", details: { module: MODULE_NAME, lastCompose } };
}

export async function handleRequest(req: Request, pathname: string): Promise<Response | null> {
  if (!pathname.startsWith("/api/today")) return null;
  if (pathname === "/api/today/checkin") {
    if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
    return handleCheckin(req);
  }
  if (pathname !== "/api/today") return null;
  if (req.method !== "GET") return new Response("method not allowed", { status: 405 });
  const fresh = new URL(req.url).searchParams.get("fresh") === "1";
  // The day, greeting and agenda clock follow the principal's current zone, not the zone the daemon started in (Pulse ISA ISC-35).
  const payload = await compose(liveProbes(fresh), new Date(), principalTimezone());
  lastCompose = { at: payload.generated_at, errors: Object.keys(payload.errors).length, unavailable: Object.keys(payload.unavailable) };
  return Response.json(payload, { headers: { "Cache-Control": "no-store" } });
}
