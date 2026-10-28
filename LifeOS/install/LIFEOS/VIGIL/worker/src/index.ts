/** Vigil authenticated D1 event API. Every route but /health needs an emitter bearer. GET /events returns only rows at or below that emitter's privacy ceiling. /stats returns no rows: it gives any registered emitter store-wide counts (total, per-source 24h tallies, oldest and newest timestamps) across every privacy class, and no title, summary or other row content. It reads the trigger-kept tally, never the whole table; a daily cron re-counts it and deletes nothing, because the record is permanent. @version 0.7.0 */
import { invariant } from "../../../TOOLS/Invariant";
import { validateEvent, type VigilEvent } from "../../Schema";
type D1Result<T> = { results: T[]; meta: { changes: number; duration?: number; size_after?: number } };
type D1Statement = { bind(...values: unknown[]): D1Statement; first<T>(): Promise<T | null>; all<T>(): Promise<D1Result<T>>; run(): Promise<D1Result<never>> };
type Env = { VIGIL: { prepare(sql: string): D1Statement } };
const json = (value: unknown, status = 200) => Response.json(value, { status });
const HOUR_MS = 3_600_000;

/** Store stats in bounded reads: total from event_totals, oldest/newest from the ts index, the 24h window from hourly buckets plus the partial first hour (ISC-126, ISC-128). */
async function stats(env: Env, now: number) {
  const hour = new Date(now - HOUR_MS).toISOString(), day = new Date(now - 24 * HOUR_MS).toISOString(), boundary = new Date(Math.floor(Date.parse(day) / HOUR_MS) * HOUR_MS + HOUR_MS).toISOString();
  const totals = await env.VIGIL.prepare("SELECT n AS rows FROM event_totals WHERE id = 1").all<{ rows: number }>();
  const oldest = await env.VIGIL.prepare("SELECT ts FROM events ORDER BY ts ASC LIMIT 1").all<{ ts: string }>();
  const newest = await env.VIGIL.prepare("SELECT ts FROM events ORDER BY ts DESC LIMIT 1").all<{ ts: string }>();
  const oneHour = await env.VIGIL.prepare("SELECT COUNT(*) AS rows_1h FROM events WHERE ts >= ?").bind(hour).all<{ rows_1h: number }>();
  const buckets = await env.VIGIL.prepare("SELECT source, SUM(n) AS count FROM event_counts WHERE hour >= ? GROUP BY source").bind(boundary.slice(0, 13)).all<{ source: string; count: number }>();
  const partial = await env.VIGIL.prepare("SELECT source, COUNT(*) AS count FROM events WHERE ts >= ? AND ts < ? GROUP BY source").bind(day, boundary).all<{ source: string; count: number }>();
  const emitters = await env.VIGIL.prepare("SELECT COUNT(*) AS emitters FROM emitters").all<{ emitters: number }>();
  const by_source_24h: Record<string, number> = {};
  for (const row of [...buckets.results, ...partial.results]) if (Number(row.count) > 0) by_source_24h[row.source] = (by_source_24h[row.source] ?? 0) + Number(row.count);
  const results = [totals, oldest, newest, oneHour, buckets, partial, emitters], durations = results.map((result) => result.meta.duration).filter((value): value is number => typeof value === "number");
  const db_size_bytes = results.map((result) => result.meta.size_after).findLast((value) => typeof value === "number") ?? null;
  return { rows: Number(totals.results[0]?.rows ?? 0), rows_1h: Number(oneHour.results[0]?.rows_1h ?? 0), rows_24h: Object.values(by_source_24h).reduce((sum, count) => sum + count, 0), oldest_ts: oldest.results[0]?.ts ?? null, newest_ts: newest.results[0]?.ts ?? null, emitters: Number(emitters.results[0]?.emitters ?? 0), by_source_24h, db_size_bytes, query_ms: durations.length ? durations.reduce((sum, duration) => sum + duration, 0) : null, served_at: new Date(now).toISOString() };
}

/**
 * Daily recount: drop empty buckets and reset the total to a direct count, so tally drift cannot last. It deletes no event:
 * the record is permanent by design, so no row is ever removed by age (STATVS full migration ISC-47).
 */
export async function recount(env: Env) {
  await env.VIGIL.prepare("DELETE FROM event_counts WHERE n <= 0").run();
  await env.VIGIL.prepare("INSERT INTO event_totals (id, n) SELECT 1, COUNT(*) FROM events WHERE 1 ON CONFLICT (id) DO UPDATE SET n = excluded.n").run();
  const total = await env.VIGIL.prepare("SELECT n FROM event_totals WHERE id = 1").first<{ n: number }>();
  invariant(Number(total?.n ?? 0) >= 0, "the recounted total is a count");
  return { total: Number(total?.n ?? 0) };
}
async function digest(value: string) { return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))].map((x) => x.toString(16).padStart(2, "0")).join(""); }
export default { async scheduled(_controller: unknown, env: Env, ctx: { waitUntil(promise: Promise<unknown>): void }) { ctx.waitUntil(recount(env)); }, async fetch(req: Request, env: Env): Promise<Response> { const url = new URL(req.url); if (req.method === "GET" && url.pathname === "/health") return json({ ok: true }); const token = req.headers.get("authorization")?.match(/^Bearer (.+)$/)?.[1]; if (req.method === "GET" && url.pathname === "/stats") {
  if (!token || !await env.VIGIL.prepare("SELECT name FROM emitters WHERE token_hash = ?").bind(await digest(token)).first<{ name: string }>()) return json({ error: "unauthorized" }, 401);
  return json(await stats(env, Date.now()));
} if (req.method === "POST" && url.pathname === "/events") { if (!token) return json({ error: "unauthorized" }, 401); const emitter = await env.VIGIL.prepare("SELECT name, privacy_ceiling FROM emitters WHERE token_hash = ?").bind(await digest(token)).first<{ name: string; privacy_ceiling: string }>(); if (!emitter) return json({ error: "unauthorized" }, 401); const body: unknown = await req.json(), events = Array.isArray(body) ? body : [body]; try { events.forEach(validateEvent); } catch (e) { return json({ error: e instanceof Error ? e.message : "invalid event" }, 400); } const RANK: Record<string, number> = { public: 0, personal: 1, customer: 2 }; const ceiling = RANK[emitter.privacy_ceiling] ?? 1; for (const raw of events as VigilEvent[]) if ((RANK[raw.privacy_class] ?? 9) > ceiling) return json({ error: "privacy_class above this emitter's ceiling" }, 403); let inserted = 0; for (const raw of events as VigilEvent[]) { const e = { ...raw, ts: new Date(raw.ts).toISOString(), emitter: emitter.name }; invariant(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(e.ts), "stored ts is canonical ISO, so hourly buckets and range reads agree"); const r = await env.VIGIL.prepare("INSERT OR IGNORE INTO events (id,source,emitter,ts,kind,severity,title,summary,ref,url,privacy_class,dedup_key,meta) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(e.id,e.source,e.emitter,e.ts,e.kind,e.severity,e.title,e.summary,e.ref,e.url,e.privacy_class,e.dedup_key,e.meta ? JSON.stringify(e.meta) : null).run(); inserted += r.meta.changes > 0 ? 1 : 0; } return json({ inserted }, 201); } if (req.method === "GET" && url.pathname === "/events") { if (!token) return json({ error: "unauthorized" }, 401); const reader = await env.VIGIL.prepare("SELECT name, privacy_ceiling FROM emitters WHERE token_hash = ?").bind(await digest(token)).first<{ name: string; privacy_ceiling: string }>(); if (!reader) return json({ error: "unauthorized" }, 401); const LEVELS = ["public", "personal", "customer"], allowed = LEVELS.slice(0, (LEVELS.indexOf(reader.privacy_ceiling) < 0 ? 1 : LEVELS.indexOf(reader.privacy_ceiling)) + 1); const since = url.searchParams.get("since") ?? "", limit = Math.min(1000, Math.max(1, Number(url.searchParams.get("limit") ?? 100))); const result = await env.VIGIL.prepare(`SELECT * FROM events WHERE ts > ? AND id != ? AND privacy_class IN (${allowed.map(() => "?").join(",")}) ORDER BY ts, id LIMIT ?`).bind(since, since, ...allowed, limit).all<VigilEvent>(); const events = result.results; return json({ events, next: events.at(-1)?.ts ?? since }); } return json({ error: "not found" }, 404); } };
