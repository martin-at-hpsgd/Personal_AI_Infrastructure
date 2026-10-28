/**
 * Corpus module — feeds the Pulse CORPUS page: the principal's published body of work (blog, newsletter,
 * videos, X, LinkedIn, podcasts, articles) as indexed by the Corpus Worker.
 *
 * Zero data in this file. Endpoint and credentials resolve through the private Corpus skill client, which
 * reads its Config.md and the private .env. On an install without that client or config the module answers
 * `configured: false` and the page renders its setup guide.
 */
// release-allow: private-skill-names (the client loader existsSync-guards the private client and config before any import)
/**
 *
 * Routes (all under /api/corpus):
 *   GET  /api/corpus          → { configured, host, status, fetchedAt } (status cached 60 s)
 *   POST /api/corpus/search   → { query, source?, limit? } → ranked, dated, linked excerpts
 *   GET  /api/corpus/status   → module health
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getClaudeDir } from "../../TOOLS/Paths";

const MODULE = "corpus";
const CACHE_MS = 60_000;
const SOURCES = new Set(["blog", "newsletter", "video", "tweet", "linkedin", "podcast", "article"]);
const root = () => getClaudeDir();
const clientDir = () => join(root(), "skills", "_CORPUS");
const configFile = () => join(root(), "LIFEOS", "USER", "CUSTOMIZATIONS", "SKILLS", "_CORPUS", "Config.md");

type Client = { api: { status(): Promise<any>; findPost(o: { query: string; limit?: number; source?: string }): Promise<any> }; endpoint(): string };
const state: { running: boolean; startedAt: Date | null; cache: { body: unknown; expiresAt: number } | null; client: Client | null | undefined } = { running: false, startedAt: null, cache: null, client: undefined };

/** The private client, or null when this install has none (a public release, or Corpus never set up). */
async function client(): Promise<Client | null> {
  if (state.client !== undefined) return state.client;
  if (!existsSync(join(clientDir(), "index.ts")) || !existsSync(configFile())) return (state.client = null);
  try {
    const [index, config] = await Promise.all([import(join(clientDir(), "index.ts")), import(join(clientDir(), "config.ts"))]);
    config.endpoint(); // throws when Config.md carries no endpoint
    return (state.client = { api: new index.CorpusAPI(), endpoint: config.endpoint });
  } catch {
    return (state.client = null);
  }
}

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function start(): Promise<void> {
  state.running = true;
  state.startedAt = new Date();
  console.log(`[${MODULE}] Starting`);
}
export async function stop(): Promise<void> { state.running = false; }
export function health() {
  return { module: MODULE, running: state.running, startedAt: state.startedAt?.toISOString() ?? null, configured: state.client ? true : state.client === null ? false : null };
}

async function overview() {
  if (state.cache && state.cache.expiresAt > Date.now()) return state.cache.body;
  const c = await client();
  if (!c) return { configured: false, configPath: "LIFEOS/USER/CUSTOMIZATIONS/SKILLS/_CORPUS/Config.md" };
  const status = await c.api.status();
  const body = { configured: true, host: new URL(c.endpoint()).host, fetchedAt: new Date().toISOString(), ...(status.error ? { error: status.error } : { status }) };
  if (!status.error) state.cache = { body, expiresAt: Date.now() + CACHE_MS };
  return body;
}

export async function handleRequest(req: Request, pathname: string): Promise<Response | null> {
  if (pathname === "/api/corpus/status" && req.method === "GET") return json(health());
  if (pathname === "/api/corpus" && req.method === "GET") return json(await overview());
  if (pathname === "/api/corpus/search" && req.method === "POST") {
    const c = await client();
    if (!c) return json({ configured: false, results: [] }, 409);
    let body: any;
    try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
    const query = typeof body?.query === "string" ? body.query.trim() : "";
    if (!query || query.length > 500) return json({ error: "A query of 1 to 500 characters is required" }, 400);
    const source = typeof body?.source === "string" && SOURCES.has(body.source) ? body.source : undefined;
    const limit = Number.isInteger(body?.limit) ? Math.min(Math.max(body.limit, 1), 25) : 10;
    return json(await c.api.findPost({ query, limit, source }));
  }
  return null;
}
