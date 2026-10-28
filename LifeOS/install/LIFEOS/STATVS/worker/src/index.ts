/**
 * STATVS cloud tier: the authenticated D1 event API, Vigil's former store renamed (STATVS ISC-88). Every route but /health
 * needs an emitter bearer. GET /events answers only emitters listed in the deploy config's readers and returns only rows at
 * or below the reader's privacy ceiling; DELETE /events/:id removes only the caller's own row (STATVS ISC-192). /stats reads
 * the trigger-kept tally, never the whole table; a daily cron re-counts it and deletes nothing, because the record is permanent. Every response carries the six
 * security headers the estate scanner checks, a malformed body (400) and a thrown error (500) included. Same database,
 * tables and wire shape as lifeos-vigil.
 *
 * GET /events cursor: a reader re-reads an overlap, so the `since` it sends sits behind the cursor it holds. It may send that
 * cursor too (`cursor`, canonical ISO); `next` is then never earlier than it, so an empty page, or a page of rows the
 * overlap re-read, never moves the reader back. Without `cursor`, `next` is the last row's ts, or `since` on an empty
 * page, as lifeos-vigil answers. @version 0.10.0
 */
import { invariant } from "../../../TOOLS/Invariant";
import { validateEvent, type VigilEvent } from "../../lib/refuse";
type D1Result<T> = { results: T[]; meta: { changes: number; duration?: number; size_after?: number } };
type D1Statement = { bind(...values: unknown[]): D1Statement; first<T>(): Promise<T | null>; all<T>(): Promise<D1Result<T>>; run(): Promise<D1Result<never>> };
type Env = { STATVS: { prepare(sql: string): D1Statement }; STATVS_READERS?: unknown };
const json = (value: unknown, status = 200) => Response.json(value, { status });
const HOUR_MS = 3_600_000;
/** The only cursor form GET /events accepts: what toISOString() writes, so a string comparison orders it like a time. */
const CANONICAL_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** The six headers the estate scanner checks. The Worker serves only JSON, so the CSP allows nothing. */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "geolocation=(), camera=(), microphone=()",
};

/** The emitter names allowed to GET /events. Anything but a list of strings reads as no readers, so a bad binding fails closed. */
export function readers(env: Env): ReadonlySet<string> {
  const list = env.STATVS_READERS;
  return new Set(Array.isArray(list) ? list.filter((r): r is string => typeof r === "string" && r.length > 0) : []);
}

/** Store stats in bounded reads: total from event_totals, oldest/newest from the ts index, the 24h window from hourly buckets plus the partial first hour (ISC-126, ISC-128). */
async function stats(env: Env, now: number) {
  const hour = new Date(now - HOUR_MS).toISOString(), day = new Date(now - 24 * HOUR_MS).toISOString(), boundary = new Date(Math.floor(Date.parse(day) / HOUR_MS) * HOUR_MS + HOUR_MS).toISOString();
  const totals = await env.STATVS.prepare("SELECT n AS rows FROM event_totals WHERE id = 1").all<{ rows: number }>();
  const oldest = await env.STATVS.prepare("SELECT ts FROM events ORDER BY ts ASC LIMIT 1").all<{ ts: string }>();
  const newest = await env.STATVS.prepare("SELECT ts FROM events ORDER BY ts DESC LIMIT 1").all<{ ts: string }>();
  const oneHour = await env.STATVS.prepare("SELECT COUNT(*) AS rows_1h FROM events WHERE ts >= ?").bind(hour).all<{ rows_1h: number }>();
  const buckets = await env.STATVS.prepare("SELECT source, SUM(n) AS count FROM event_counts WHERE hour >= ? GROUP BY source").bind(boundary.slice(0, 13)).all<{ source: string; count: number }>();
  const partial = await env.STATVS.prepare("SELECT source, COUNT(*) AS count FROM events WHERE ts >= ? AND ts < ? GROUP BY source").bind(day, boundary).all<{ source: string; count: number }>();
  const emitters = await env.STATVS.prepare("SELECT COUNT(*) AS emitters FROM emitters").all<{ emitters: number }>();
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
  await env.STATVS.prepare("DELETE FROM event_counts WHERE n <= 0").run();
  await env.STATVS.prepare("INSERT INTO event_totals (id, n) SELECT 1, COUNT(*) FROM events WHERE 1 ON CONFLICT (id) DO UPDATE SET n = excluded.n").run();
  const total = await env.STATVS.prepare("SELECT n FROM event_totals WHERE id = 1").first<{ n: number }>();
  invariant(Number(total?.n ?? 0) >= 0, "the recounted total is a count");
  return { total: Number(total?.n ?? 0) };
}
async function digest(value: string) { return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))].map((x) => x.toString(16).padStart(2, "0")).join(""); }
/** The emitter a bearer belongs to, or null when the bearer is missing or unknown. */
async function emitterOf(env: Env, token: string | undefined) { return token ? env.STATVS.prepare("SELECT name, privacy_ceiling FROM emitters WHERE token_hash = ?").bind(await digest(token)).first<{ name: string; privacy_ceiling: string }>() : null; }

/**
 * The route's own answer for a row it does not hold for this bearer. lib/cloud.ts reads { deleted: 0 } as "absent" and any
 * other 404 (an unknown route, the old lifeos-vigil host) as a failure, so the two must never share a body.
 */
const notHeld = () => json({ deleted: 0 }, 404);
/** Longer than any id the Mac deletes (lib/cloud.ts sends ids up to 256 characters). */
const MAX_DELETE_ID = 1024;

/** DELETE /events/:id: removes the row only when the caller's emitter wrote it; 404 { deleted: 0 } otherwise. Writes nothing else (the tally triggers keep counts exact). */
async function deleteOwn(env: Env, emitter: string, rawId: string): Promise<Response> {
  let id = "";
  // A malformed id is a bad request, never { deleted: 0 }: POST does not bound ids, so "absent" must come from the lookup.
  try { id = decodeURIComponent(rawId); } catch { return json({ error: "id does not decode" }, 400); }
  if (!id || id.length > MAX_DELETE_ID) return json({ error: "id is empty or too long" }, 400);
  invariant(emitter.length > 0, "a delete is scoped to a known emitter, never to every row");
  // Counted from RETURNING, never meta.changes: the tally trigger makes changes over-count.
  const r = await env.STATVS.prepare("DELETE FROM events WHERE id = ? AND emitter = ? RETURNING id").bind(id, emitter).all<{ id: string }>();
  invariant(r.results.length <= 1, "id is the primary key, so one delete removes at most one row");
  return r.results.length ? json({ deleted: 1 }) : notHeld();
}

/** Every route; fetch() adds the security headers to whatever this returns. */
async function route(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  if (req.method === "GET" && url.pathname === "/health") return json({ ok: true });
  const token = req.headers.get("authorization")?.match(/^Bearer (.+)$/)?.[1];
  if (req.method === "GET" && url.pathname === "/stats") {
    if (!token || !await env.STATVS.prepare("SELECT name FROM emitters WHERE token_hash = ?").bind(await digest(token)).first<{ name: string }>()) return json({ error: "unauthorized" }, 401);
    return json(await stats(env, Date.now()));
  }
  if (req.method === "POST" && url.pathname === "/events") {
    if (!token) return json({ error: "unauthorized" }, 401);
    const emitter = await emitterOf(env, token); if (!emitter) return json({ error: "unauthorized" }, 401);
    let body: unknown;
    try { body = await req.json(); } catch { return json({ error: "body is not JSON" }, 400); }
    const events = Array.isArray(body) ? body : [body];
    try { events.forEach(validateEvent); } catch (e) { return json({ error: e instanceof Error ? e.message : "invalid event" }, 400); }
    const RANK: Record<string, number> = { public: 0, personal: 1, customer: 2 }; const ceiling = RANK[emitter.privacy_ceiling] ?? 1;
    for (const raw of events as VigilEvent[]) if ((RANK[raw.privacy_class] ?? 9) > ceiling) return json({ error: "privacy_class above this emitter's ceiling" }, 403);
    let inserted = 0;
    for (const raw of events as VigilEvent[]) { const e = { ...raw, ts: new Date(raw.ts).toISOString(), emitter: emitter.name }; invariant(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(e.ts), "stored ts is canonical ISO, so hourly buckets and range reads agree"); const r = await env.STATVS.prepare("INSERT OR IGNORE INTO events (id,source,emitter,ts,kind,severity,title,summary,ref,url,privacy_class,dedup_key,meta) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(e.id,e.source,e.emitter,e.ts,e.kind,e.severity,e.title,e.summary,e.ref,e.url,e.privacy_class,e.dedup_key,e.meta ? JSON.stringify(e.meta) : null).run(); inserted += r.meta.changes > 0 ? 1 : 0; }
    return json({ inserted }, 201);
  }
  if (req.method === "GET" && url.pathname === "/events") {
    if (!token) return json({ error: "unauthorized" }, 401);
    const reader = await emitterOf(env, token); if (!reader) return json({ error: "unauthorized" }, 401);
    // Readers-only (STATVS ISC-192): a known bearer that is not a listed reader may post but never read.
    if (!readers(env).has(reader.name)) return json({ error: "this emitter may not read events" }, 403);
    const LEVELS = ["public", "personal", "customer"], allowed = LEVELS.slice(0, (LEVELS.indexOf(reader.privacy_ceiling) < 0 ? 1 : LEVELS.indexOf(reader.privacy_ceiling)) + 1);
    const since = url.searchParams.get("since") ?? "", limit = Math.min(1000, Math.max(1, Number(url.searchParams.get("limit") ?? 100)));
    const cursor = url.searchParams.get("cursor");
    if (cursor !== null && !(CANONICAL_TS.test(cursor) && Number.isFinite(Date.parse(cursor)))) return json({ error: "cursor is not a canonical ISO timestamp" }, 400);
    // `after` continues a full page from its last row by (ts, id), so rows that share one timestamp are never cut off at a page edge.
    const after = url.searchParams.get("after");
    if (after !== null && !(after.length > 0 && after.length <= 256 && CANONICAL_TS.test(since))) return json({ error: "after needs a non-empty event id and a canonical ISO since" }, 400);
    const where = after === null ? "ts > ? AND id != ?" : "(ts > ? OR (ts = ? AND id > ?))";
    const keys = after === null ? [since, since] : [since, since, after];
    const result = await env.STATVS.prepare(`SELECT * FROM events WHERE ${where} AND privacy_class IN (${allowed.map(() => "?").join(",")}) ORDER BY ts, id LIMIT ?`).bind(...keys, ...allowed, limit).all<VigilEvent>();
    const events = result.results, last = events.at(-1)?.ts ?? since;
    // The reader's own cursor bounds next from below: re-reading the overlap never hands it an earlier position.
    const next = cursor !== null && cursor > last ? cursor : last;
    return json({ events, next, ...(events.length ? { last_id: events.at(-1)!.id } : {}) });
  }
  const one = url.pathname.match(/^\/events\/([^/]+)$/);
  if (req.method === "DELETE" && one) {
    if (!token) return json({ error: "unauthorized" }, 401);
    const emitter = await emitterOf(env, token); if (!emitter) return json({ error: "unauthorized" }, 401);
    return deleteOwn(env, emitter.name, one[1]!);
  }
  return json({ error: "not found" }, 404);
}

export default {
  async scheduled(_controller: unknown, env: Env, ctx: { waitUntil(promise: Promise<unknown>): void }) { ctx.waitUntil(recount(env)); },
  async fetch(req: Request, env: Env): Promise<Response> {
    let res: Response;
    // A thrown error (D1 down, an invariant) still answers with the six headers; its text never reaches the caller.
    try { res = await route(req, env); } catch (e) {
      console.error("statvs route failed:", e instanceof Error ? e.name : typeof e);
      res = json({ error: "internal error" }, 500);
    }
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.headers.set(name, value);
    return res;
  },
};
