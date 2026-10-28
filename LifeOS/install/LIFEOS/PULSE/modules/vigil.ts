/** Vigil Pulse module — read-only local event surface. @version 0.7.0 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
const policyPath = join(import.meta.dir, "../../VIGIL/Policy.ts");
const adaptersPath = join(import.meta.dir, "../../VIGIL/adapters/index.ts");
const policyModule = existsSync(policyPath) ? await import(policyPath) : undefined;
const adaptersModule = existsSync(adaptersPath) ? await import(adaptersPath) : undefined;
const REGISTERED_ADAPTERS: string[] = adaptersModule?.REGISTERED_ADAPTERS ?? [];
const registryPath = join(import.meta.dir, "../../WATCHES/lib/registry.ts"), heartbeatsPath = join(import.meta.dir, "../../VIGIL/Heartbeats.ts");
const registryModule = existsSync(registryPath) ? await import(registryPath) : undefined;
const heartbeatsModule = existsSync(heartbeatsPath) ? await import(heartbeatsPath) : undefined;
/** The watch registry as source to cadence in minutes, read per compose so a watch added or removed shows at once. An unreadable registry yields no watch rows rather than breaking the page. */
function watchCadences(): Map<string, number | null> { const out = new Map<string, number | null>(); try { const reg = registryModule?.loadRegistry?.() as { watches: Record<string, { cadence_minutes?: number; interval_seconds?: number }> } | undefined; for (const [name, entry] of Object.entries(reg?.watches ?? {})) out.set(`watch-${name}`, typeof entry.cadence_minutes === "number" ? entry.cadence_minutes : typeof entry.interval_seconds === "number" ? entry.interval_seconds / 60 : null); } catch { /* no watch rows */ } return out; }
const emitPath = join(import.meta.dir, "../../VIGIL/Emit.ts");
const emitModule = existsSync(emitPath) ? await import(emitPath) : undefined;
/** While the page is open, Pulse reads the store's /stats itself this often, so the database figures move between five-minute ticks. */
const LIVE_PROBE_MS = 15_000;
type LiveProbe = { checked_at: string; reachable: boolean; rows: number | null; latency_ms: number; stats: Record<string, unknown> | null };
const live: { last: LiveProbe | null; history: Array<{ ts: string; ok: boolean; latency_ms: number; query_ms: number | null; rows: number | null }>; inFlight: boolean; startedAt: number } = { last: null, history: [], inFlight: false, startedAt: 0 };
/** One /stats read, timed end to end. Never throws; a failed read is recorded as unreachable. */
async function probeLive(fetchImpl: typeof fetch = fetch): Promise<void> {
  const credentials = emitModule?.vigilCredentials?.() as { url: string; token: string } | null | undefined;
  if (!credentials) return;
  live.inFlight = true; live.startedAt = Date.now();
  const started = performance.now(); let reachable = false, rows: number | null = null, stats: Record<string, unknown> | null = null;
  try {
    const res = await fetchImpl(`${credentials.url.replace(/\/$/, "")}/stats`, { headers: { Authorization: `Bearer ${credentials.token}` }, signal: AbortSignal.timeout(10_000) });
    if (res.ok) { const body = await res.json() as Record<string, unknown>; if (typeof body.rows === "number" && Number.isFinite(body.rows)) { reachable = true; rows = body.rows; const { rows: _rows, ...extra } = body; stats = Object.keys(extra).length ? extra : null; } }
  } catch { /* recorded below as unreachable */ }
  const latency_ms = Math.round(performance.now() - started), checked_at = new Date().toISOString();
  live.last = { checked_at, reachable, rows, latency_ms, stats };
  live.history = [{ ts: checked_at, ok: reachable, latency_ms, query_ms: typeof stats?.query_ms === "number" ? stats.query_ms : null, rows }, ...live.history].slice(0, 24);
  live.inFlight = false; state.cache = null;
}

const MODULE_NAME = "vigil", STALE_MS = 10 * 60_000, DAY_MS = 86_400_000, CACHE_TTL_MS = 1_500, PING_TICKS = 12, FEED_ROWS = 100, HOUR_MS = 3_600_000;
const SEVERITIES = ["info", "low", "medium", "high", "critical"] as const;
const state: { running: boolean; cache: { payload: Payload; expiresAt: number } | null } = { running: false, cache: null };
type Event = { id?: string; ts: string; source: string; severity: string; kind: string; title?: string; ref?: string | null; summary?: string; meta?: Record<string, unknown>; [key: string]: unknown };
type ReadOutcome = { ok: boolean; ts: string | null; error: string | null };
type Emitter = { source: string; state: "live" | "quiet" | "watching" | "never" | "error"; count_1h: number; count_24h: number; per_hour: number; tempo_24h: number[]; last_age_minutes: number | null; expected_cadence_minutes: number | null; last_read: ReadOutcome };
type Source = { source: string; count_1h: number; count_24h: number; per_hour: number; last_age_minutes: number; expected_cadence_minutes: number | null; quiet: boolean };
type StoreHealth = { configured: boolean; reachable: boolean | null; rows: number | null; checked_at: string | null; latency_ms: number | null; query_ms: number | null; rows_1h: number | null; rows_24h: number | null; oldest_ts: string | null; newest_ts: string | null; db_size_bytes: number | null; emitters: number | null; events_per_minute_1h: number | null; events_per_minute_24h: number | null };
type Health = { tick_age_minutes: number | null; tick_stale: boolean; tick_reason: string | null; runs_24h: number; store: StoreHealth; texts_24h: number; text_ceiling: number; digest_pending: number; held_24h: number; failed_24h: number };
type StoreProbe = { ts: string; ok: boolean; latency_ms: number; query_ms: number | null; rows: number | null };
type Database = { store: StoreHealth; probes: StoreProbe[]; outbox: { rows: number; rows_1h: number; rows_24h: number; bytes: number; oldest_ts: string | null; newest_ts: string | null; pulled_rows: number }; api: { compose_ms: number | null; cached: boolean } };
/** The strip above the verdict line (ISC-61..63). Rates are served raw: the page may truncate for display, never round up. */
type Stats = {
  window: { start: string; end: string; minutes: 60 };
  per_minute_60: number[];
  /** The busiest single minute in the window. */
  peak_per_minute: number;
  count_1h: number;
  per_hour: number;
  events_per_minute: number;
  count_24h: number;
  events_per_minute_24h: number;
  events_per_hour_24h: number;
  emitters: { reading_cleanly: number; registered: number };
  /** share is count / count_24h, served raw. */
  busiest_24h: { source: string; count: number; share: number } | null;
  last_event: { ts: string; source: string; age_minutes: number } | null;
};
/** One adapter's read on one tick, as Tick.ts records it (ISC-65). */
type Ping = { name: string; ok: boolean; error?: string; events: number; ms: number };
/** A tick row for the recent-pings panel (ISC-67). Lines written before ISC-65 carry only ts, so every other field may be null. */
type PingTick = { ts: string; duration_ms: number | null; collected: number | null; routed: number | null; baseline: boolean; dry_run: boolean; error: string | null; pings: Ping[] | null };
type Pings = { interval_seconds: number; registered: string[]; ticks: PingTick[] };
type KindRow = { kind: string; count_1h: number; count_24h: number; by_severity_24h: Record<string, number>; last_ts: string | null };
type Decision3 = "sent" | "held" | "failed";
/** Activity by type (ISC-68). Vigil's own rows are out of the kind counts: heartbeats entirely, notifications in their own block. */
type Kinds = { window: { hour_start: string; day_start: string }; rows: KindRow[]; total_1h: number; total_24h: number; notifications: Record<Decision3, { count_1h: number; count_24h: number }> };
/** The newest events and notifications, heartbeat excluded (ISC-68). A notification names the event it was about. */
type FeedRow = { id: string; ts: string; type: "event" | "notification"; source: string; kind: string; severity: string; title: string; summary: string | null; decision: Decision3 | null; reason: string | null; subject: { id: string; source: string; severity: string; kind: string; title: string } | null };
type Payload = { database: Database; pings: Pings; kinds: Kinds; feed: FeedRow[]; health: Health; stats: Stats; emitters: Emitter[]; counts: { by_source: Record<string, number>; by_severity: Record<string, number>; by_kind: Record<string, number> }; timeline: Array<{ hour_start: string; info: number; low: number; medium: number; high: number; critical: number }>; matrix: { kinds: string[]; severities: string[]; cells: number[][] }; ledger: Array<{ ts: string; decision: "sent" | "failed" | "held"; reason: string; event: { id: string; source: string; severity: string; title: string }; state_inputs: unknown }>; events: Event[]; sources: Source[]; tick: { stale: boolean; age_minutes: number | null; reason: string | null };
  /** What the page needs to count seconds between polls (ISC-66): the last tick to the second and when the next one is due. */
  clock: { last_tick_ts: string | null; interval_seconds: number; next_at: string | null; served_at: string }; digest_pending: number; held_24h: number };
const MINUTE_MS = 60_000;
/**
 * The window is the last 60 COMPLETED wall-clock minutes, so every bucket is a whole minute,
 * the rate divides by exactly 60, and the per-minute buckets sum to count_1h by construction.
 * The in-progress minute is left out rather than counted as a partial minute.
 */
export function computeStats(allEvents: Event[], emitters: Emitter[], nowMs: number): Stats {
  const real = allEvents.flatMap((event) => { const ms = Date.parse(event.ts); return event.source !== "vigil" && Number.isFinite(ms) && ms <= nowMs ? [{ event, ms }] : []; });
  const windowEnd = Math.floor(nowMs / MINUTE_MS) * MINUTE_MS, windowStart = windowEnd - 60 * MINUTE_MS;
  const per_minute_60 = Array.from({ length: 60 }, () => 0);
  for (const { ms } of real) if (ms >= windowStart && ms < windowEnd) per_minute_60[Math.floor((ms - windowStart) / MINUTE_MS)]!++;
  const count_1h = per_minute_60.reduce((sum, n) => sum + n, 0);
  const day = real.filter(({ ms }) => ms >= nowMs - DAY_MS), count_24h = day.length;
  const bySource = new Map<string, number>();
  for (const { event } of day) bySource.set(event.source, (bySource.get(event.source) ?? 0) + 1);
  // Ties break alphabetically so the busiest source does not flicker between refreshes.
  const busiest = [...bySource].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  const newest = real.reduce<{ event: Event; ms: number } | null>((best, row) => (best === null || row.ms > best.ms ? row : best), null);
  const registered = new Set<string>(REGISTERED_ADAPTERS);
  const registeredRows = emitters.filter((row) => registered.has(row.source));
  return {
    window: { start: new Date(windowStart).toISOString(), end: new Date(windowEnd).toISOString(), minutes: 60 },
    per_minute_60,
    peak_per_minute: Math.max(...per_minute_60),
    count_1h,
    per_hour: count_1h,
    events_per_minute: count_1h / 60,
    count_24h,
    events_per_minute_24h: count_24h / 1440,
    events_per_hour_24h: count_24h / 24,
    emitters: { reading_cleanly: registeredRows.filter((row) => row.state !== "never" && row.state !== "error" && row.last_read.ok).length, registered: registered.size },
    busiest_24h: busiest ? { source: busiest[0], count: busiest[1], share: busiest[1] / count_24h } : null,
    last_event: newest ? { ts: newest.event.ts, source: newest.event.source, age_minutes: Math.floor((nowMs - newest.ms) / MINUTE_MS) } : null,
  };
}
const dir = () => process.env.VIGIL_STATE_DIR || join(homedir(), ".local/state/lifeos/vigil");
function lines<T>(name: string): T[] { const path = join(dir(), name); if (!existsSync(path)) return []; return readFileSync(path, "utf8").split("\n").filter(Boolean).flatMap((line) => { try { return [JSON.parse(line) as T]; } catch { return []; } }); }
function lineCount(name: string): number { const path = join(dir(), name); return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).length : 0; }
function json<T>(name: string, fallback: T): T { try { return JSON.parse(readFileSync(join(dir(), name), "utf8")) as T; } catch { return fallback; } }
function counters(rows: Event[]) { const by_source: Record<string, number> = {}, by_severity: Record<string, number> = {}, by_kind: Record<string, number> = {}; for (const event of rows) { by_source[event.source] = (by_source[event.source] ?? 0) + 1; by_severity[event.severity] = (by_severity[event.severity] ?? 0) + 1; by_kind[event.kind] = (by_kind[event.kind] ?? 0) + 1; } return { by_source, by_severity, by_kind }; }
/** Vigil's own liveness row. Its notifications are not heartbeats: they are what the tick decided. */
export function isHeartbeat(event: Event): boolean { return event.source === "vigil" && (event.kind === "heartbeat" || event.title === "Vigil heartbeat" || String(event.dedup_key ?? "").startsWith("vigil:heartbeat:")); }
const DECISIONS: readonly Decision3[] = ["sent", "held", "failed"];
function decisionOf(event: Event): Decision3 | null { const found = event.title?.match(/Vigil notification (sent|failed|held)$/)?.[1] ?? (typeof event.meta?.decision === "string" ? event.meta.decision : null); return DECISIONS.includes(found as Decision3) ? found as Decision3 : null; }
const num = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;
/** The last PING_TICKS runs, newest first. A malformed ping is dropped rather than drawn as a guess. */
export function composePings(rows: Array<Record<string, unknown>>, intervalSeconds: number): Pings {
  const ticks = rows.filter((row) => typeof row.ts === "string" && Number.isFinite(Date.parse(row.ts))).sort((a, b) => String(b.ts).localeCompare(String(a.ts))).slice(0, PING_TICKS).map<PingTick>((row) => ({
    ts: String(row.ts), duration_ms: num(row.duration_ms), collected: num(row.collected), routed: num(row.routed), baseline: row.baseline === true, dry_run: row.dry_run === true, error: typeof row.error === "string" ? row.error : null,
    pings: Array.isArray(row.pings) ? (row.pings as Array<Record<string, unknown>>).flatMap((ping) => typeof ping?.name === "string" && typeof ping.ok === "boolean" && num(ping.events) !== null && num(ping.ms) !== null ? [{ name: ping.name, ok: ping.ok, ...(ping.ok ? {} : { error: typeof ping.error === "string" ? ping.error : "read failed" }), events: ping.events as number, ms: ping.ms as number }] : []) : null,
  }));
  return { interval_seconds: intervalSeconds, registered: [...REGISTERED_ADAPTERS], ticks };
}
/** Counts by kind over the last 60 minutes and 24 hours, same windows as the stats strip's hour and day. */
export function composeKinds(allEvents: Event[], nowMs: number): Kinds {
  const hourStart = nowMs - HOUR_MS, dayStart = nowMs - DAY_MS, rows = new Map<string, KindRow>(), notifications = Object.fromEntries(DECISIONS.map((d) => [d, { count_1h: 0, count_24h: 0 }])) as Kinds["notifications"];
  let total_1h = 0, total_24h = 0;
  for (const event of allEvents) {
    const ms = Date.parse(event.ts); if (!Number.isFinite(ms) || ms < dayStart || ms > nowMs || isHeartbeat(event)) continue;
    const inHour = ms >= hourStart;
    if (event.source === "vigil") { const decision = event.kind === "notification" ? decisionOf(event) : null; if (decision) { notifications[decision].count_24h++; if (inHour) notifications[decision].count_1h++; } continue; }
    const row = rows.get(event.kind) ?? { kind: event.kind, count_1h: 0, count_24h: 0, by_severity_24h: Object.fromEntries(SEVERITIES.map((s) => [s, 0])), last_ts: null };
    row.count_24h++; total_24h++; if (inHour) { row.count_1h++; total_1h++; }
    row.by_severity_24h[event.severity] = (row.by_severity_24h[event.severity] ?? 0) + 1;
    if (row.last_ts === null || event.ts > row.last_ts) row.last_ts = event.ts;
    rows.set(event.kind, row);
  }
  return { window: { hour_start: new Date(hourStart).toISOString(), day_start: new Date(dayStart).toISOString() }, rows: [...rows.values()].sort((a, b) => b.count_1h - a.count_1h || b.count_24h - a.count_24h || a.kind.localeCompare(b.kind)), total_1h, total_24h, notifications };
}
/** allEvents arrives newest first. */
export function composeFeed(allEvents: Event[], nowMs: number): FeedRow[] {
  const byId = new Map(allEvents.map((event) => [event.id, event]));
  return allEvents.filter((event) => !isHeartbeat(event) && Date.parse(event.ts) <= nowMs).slice(0, FEED_ROWS).map<FeedRow>((event) => {
    const decision = event.source === "vigil" && event.kind === "notification" ? decisionOf(event) : null, subject = decision && event.ref ? byId.get(event.ref) : undefined;
    return { id: String(event.id ?? `${event.ts}:${event.source}`), ts: event.ts, type: decision ? "notification" : "event", source: event.source, kind: event.kind, severity: event.severity, title: String(event.title ?? event.summary ?? "Event"), summary: typeof event.summary === "string" ? event.summary : null, decision, reason: decision ? String(event.meta?.reason ?? event.summary ?? "") : null,
      subject: decision ? { id: String(subject?.id ?? event.ref ?? ""), source: String(subject?.source ?? "unknown"), severity: String(subject?.severity ?? "info"), kind: String(subject?.kind ?? "unknown"), title: String(subject?.title ?? "event no longer in the outbox") } : null };
  });
}
export function compose(now = new Date()): Payload {
  const nowMs = now.getTime(), cutoff = nowMs - DAY_MS, allEvents = lines<Event>("outbox.jsonl").sort((a, b) => b.ts.localeCompare(a.ts)), events = allEvents.slice(0, 200), real24h = allEvents.filter((event) => event.source !== "vigil" && Date.parse(event.ts) >= cutoff && Date.parse(event.ts) <= nowMs), policy = policyModule?.loadPolicy() ?? { text_ceiling_per_24h: 0, source_cadence_minutes: {} as Record<string, number> };
  const sourceEvents = Object.groupBy(allEvents, (event) => event.source), watches = watchCadences(), beats = new Map((heartbeatsModule?.heartbeatReport?.(now, dir()) as Array<{ source: string; stale: boolean }> | undefined ?? []).map((entry) => [entry.source, entry.stale] as const)), names = [...new Set<string>([...REGISTERED_ADAPTERS, ...watches.keys(), ...Object.keys(sourceEvents)])];
  const hour = 3_600_000, currentHour = Math.floor(nowMs / hour) * hour, firstHour = currentHour - 23 * hour;
  const emitters: Emitter[] = names.map((source) => { const rows = sourceEvents[source] ?? [], ages = rows.map((event) => nowMs - Date.parse(event.ts)).filter(Number.isFinite), lastAge = ages.length ? Math.max(0, Math.round(Math.min(...ages) / 60_000)) : null, count_1h = ages.filter((age) => age >= 0 && age <= 3_600_000).length, count_24h = ages.filter((age) => age >= 0 && age <= DAY_MS).length, tempo_24h = Array.from({ length: 24 }, () => 0), isWatch = watches.has(source), cadence = isWatch ? watches.get(source) ?? null : policy.source_cadence_minutes[source] ?? null, read = json<{ ok?: boolean; ts?: string; error?: string }>(join("cursors", `${source}.read.json`), {}), beat = isWatch ? json<{ ts?: string; ok?: boolean }>(join("heartbeats", `${source}.json`), {}) : {}, last_read: ReadOutcome = { ok: read.ok !== false, ts: read.ts ?? null, error: read.error ?? null }; for (const event of rows) { const index = Math.floor((Math.floor(Date.parse(event.ts) / hour) * hour - firstHour) / hour); if (index >= 0 && index < 24) tempo_24h[index]++; } const watchState: Emitter["state"] = beat.ok === false ? "error" : typeof beat.ts !== "string" ? lastAge === null ? "never" : "live" : beats.get(source) === false ? count_24h > 0 ? "live" : "watching" : "quiet"; const emitterState: Emitter["state"] = isWatch ? watchState : read.ok === false ? "error" : lastAge === null ? read.ok === true && typeof read.ts === "string" ? "watching" : "never" : cadence !== null && lastAge > 2 * cadence ? "quiet" : "live"; return { source, state: emitterState, count_1h, count_24h, per_hour: Number((count_24h / 24).toFixed(1)), tempo_24h, last_age_minutes: lastAge, expected_cadence_minutes: cadence, last_read }; });
  const sources: Source[] = Object.entries(sourceEvents).flatMap(([source, rows]) => { if (!rows?.length) return []; const ages = rows.map((event) => nowMs - Date.parse(event.ts)), lastAge = Math.max(0, Math.round(Math.min(...ages) / 60_000)), count_1h = ages.filter((age) => age >= 0 && age <= 3_600_000).length, count_24h = ages.filter((age) => age >= 0 && age <= DAY_MS).length, cadence = policy.source_cadence_minutes[source] ?? null; return [{ source, count_1h, count_24h, per_hour: Number((count_24h / 24).toFixed(1)), last_age_minutes: lastAge, expected_cadence_minutes: cadence, quiet: cadence !== null && lastAge > 2 * cadence }]; }).sort((a, b) => b.count_24h - a.count_24h);
  const intervalSeconds = (policy.source_cadence_minutes.vigil ?? 5) * 60, tickTs = json<{ ts?: string }>("last-tick.json", {}).ts ?? null, tickAgeMs = tickTs ? nowMs - Date.parse(tickTs) : Number.POSITIVE_INFINITY, tickStale = !Number.isFinite(tickAgeMs) || tickAgeMs > STALE_MS, tick = { stale: tickStale, age_minutes: Number.isFinite(tickAgeMs) ? Math.max(0, Math.round(tickAgeMs / 60_000)) : null, reason: tickStale ? tickTs ? "last tick is older than 10 minutes" : "last-tick.json is missing" : null };
  const clock = { last_tick_ts: Number.isFinite(tickAgeMs) ? tickTs : null, interval_seconds: intervalSeconds, next_at: Number.isFinite(tickAgeMs) && tickTs ? new Date(Date.parse(tickTs) + intervalSeconds * 1000).toISOString() : null, served_at: now.toISOString() };
  const timeline = Array.from({ length: 24 }, (_, index) => ({ hour_start: new Date(currentHour - (23 - index) * hour).toISOString(), info: 0, low: 0, medium: 0, high: 0, critical: 0 })); for (const event of real24h) { const index = Math.floor((Math.floor(Date.parse(event.ts) / hour) * hour - firstHour) / hour); if (index >= 0 && index < 24 && SEVERITIES.includes(event.severity as typeof SEVERITIES[number])) timeline[index]![event.severity as typeof SEVERITIES[number]]++; }
  const kinds = [...new Set(real24h.map((event) => event.kind))].sort(), cells = kinds.map((kind) => SEVERITIES.map((severity) => real24h.filter((event) => event.kind === kind && event.severity === severity).length));
  const byId = new Map(allEvents.map((event) => [event.id, event])), notices = allEvents.filter((event) => event.source === "vigil" && event.kind === "notification"), ledger = notices.slice(0, 50).flatMap((notice) => { const decision = notice.title?.match(/Vigil notification (sent|failed|held)$/)?.[1] as "sent" | "failed" | "held" | undefined; if (!decision) return []; const subject = notice.ref ? byId.get(notice.ref) : undefined; return [{ ts: notice.ts, decision, reason: String(notice.meta?.reason ?? notice.summary ?? ""), event: { id: String(subject?.id ?? notice.ref ?? notice.id ?? ""), source: String(subject?.source ?? "unknown"), severity: String(subject?.severity ?? "info"), title: String(subject?.title ?? "Unknown event") }, state_inputs: notice.meta?.state_inputs ?? {} }]; });
  const tickStore = json<{ checked_at?: string; reachable?: boolean; rows?: number | null; latency_ms?: number | null; stats?: Record<string, unknown> | null }>(join("cursors", "store.json"), {}), store = live.last && live.last.checked_at > (tickStore.checked_at ?? "") ? live.last : tickStore, recentNotices = notices.filter((event) => Date.parse(event.ts) >= cutoff && Date.parse(event.ts) <= nowMs), digest_pending = lines("digest.jsonl").length, held_24h = recentNotices.filter((event) => event.title === "Vigil notification held").length;
  const tickRows = lines<Record<string, unknown> & { ts: string }>("ticks.jsonl");
  const extra = store.stats ?? {}, rows_1h = num(extra.rows_1h), rows_24h = num(extra.rows_24h);
  const storeHealth: StoreHealth = { configured: Boolean(process.env.VIGIL_URL), reachable: typeof store.reachable === "boolean" ? store.reachable : null, rows: num(store.rows), checked_at: store.checked_at ?? null, latency_ms: num(store.latency_ms), query_ms: num(extra.query_ms), rows_1h, rows_24h, oldest_ts: typeof extra.oldest_ts === "string" ? extra.oldest_ts : null, newest_ts: typeof extra.newest_ts === "string" ? extra.newest_ts : null, db_size_bytes: num(extra.db_size_bytes), emitters: num(extra.emitters), events_per_minute_1h: rows_1h === null ? null : rows_1h / 60, events_per_minute_24h: rows_24h === null ? null : rows_24h / 1440 };
  const health: Health = { tick_age_minutes: tick.age_minutes, tick_stale: tick.stale, tick_reason: tick.reason, runs_24h: tickRows.filter((row) => Date.parse(row.ts) >= cutoff && Date.parse(row.ts) <= nowMs).length, store: storeHealth, texts_24h: recentNotices.filter((event) => event.title === "Vigil notification sent").length, text_ceiling: policy.text_ceiling_per_24h, digest_pending, held_24h, failed_24h: recentNotices.filter((event) => event.title === "Vigil notification failed").length };
  const outboxPath = join(dir(), "outbox.jsonl"), outboxBytes = existsSync(outboxPath) ? statSync(outboxPath).size : 0;
  const probeRows = [...live.history, ...lines<Record<string, unknown>>("store-probes.jsonl")].filter((row) => typeof row.ts === "string" && typeof row.ok === "boolean" && num(row.latency_ms) !== null).sort((a, b) => String(b.ts).localeCompare(String(a.ts))).slice(0, 24).map<StoreProbe>((row) => ({ ts: String(row.ts), ok: row.ok as boolean, latency_ms: row.latency_ms as number, query_ms: num(row.query_ms), rows: num(row.rows) }));
  const database: Database = { store: storeHealth, probes: probeRows, outbox: { rows: allEvents.length, rows_1h: allEvents.filter((event) => { const ms = Date.parse(event.ts); return ms >= nowMs - HOUR_MS && ms <= nowMs; }).length, rows_24h: allEvents.filter((event) => { const ms = Date.parse(event.ts); return ms >= cutoff && ms <= nowMs; }).length, bytes: outboxBytes, oldest_ts: allEvents.at(-1)?.ts ?? null, newest_ts: allEvents[0]?.ts ?? null, pulled_rows: lineCount("pulled.jsonl") }, api: { compose_ms: null, cached: false } };
  return { database, pings: composePings(tickRows, intervalSeconds), kinds: composeKinds(allEvents, nowMs), feed: composeFeed(allEvents, nowMs), health, stats: computeStats(allEvents, emitters, nowMs), emitters, counts: counters(real24h), timeline, matrix: { kinds, severities: [...SEVERITIES], cells }, ledger, events, sources, tick, clock, digest_pending, held_24h };
}
/** One scan of everything long-running (LIFEOS/TOOLS/RunningScan.ts, running-work watch ISC-18), cached 30 s: a live scan asks launchd for schedules and is too slow to run on every request. Read-only. */
const RUNNING_TTL_MS = 30_000;
let runningCache: { at: number; value: unknown } | null = null;
async function runningScan(): Promise<unknown> {
  if (runningCache && Date.now() - runningCache.at < RUNNING_TTL_MS) return runningCache.value;
  try { const { liveScan } = await import("../../TOOLS/RunningScan"); runningCache = { at: Date.now(), value: { available: true, ...(await liveScan()) } }; }
  catch (error) { return { available: false, reason: `running scan failed: ${error instanceof Error ? error.message : String(error)}` }; }
  return runningCache.value;
}
export function start(): void { state.running = true; console.log(`[${MODULE_NAME}] Started — serving /api/vigil`); }
export async function handleRequest(req: Request, pathname: string): Promise<Response | null> { if (!pathname.startsWith("/api/vigil")) return null; if (!policyModule || !adaptersModule) return Response.json({ available: false, reason: "Vigil private implementation is not installed" }, { status: 503 }); if (req.method !== "GET") return new Response("method not allowed", { status: 405 }); if (pathname === "/api/vigil/running") return Response.json(await runningScan()); const now = Date.now(); if (pathname !== "/api/vigil/banner" && !live.inFlight && now - live.startedAt >= LIVE_PROBE_MS) void probeLive(); const cached = Boolean(state.cache && state.cache.expiresAt > now); if (!cached) { const started = performance.now(), payload = compose(new Date(now)); payload.database.api.compose_ms = Math.round(performance.now() - started); state.cache = { payload, expiresAt: now + CACHE_TTL_MS }; } const p = state.cache!.payload; if (pathname === "/api/vigil/banner") return Response.json({ alert: p.tick.stale || (p.counts.by_severity.critical ?? 0) > 0, critical_24h: p.events.filter((event) => event.severity === "critical" && Date.parse(event.ts) >= now - DAY_MS).length, stale: p.tick.stale }); return Response.json({ ...p, database: { ...p.database, api: { ...p.database.api, cached } } }); }
export function health(): { running: boolean } { return { running: state.running }; }
