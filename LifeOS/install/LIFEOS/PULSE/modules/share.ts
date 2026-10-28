/**
 * Share Pulse module — the library view over the principal's self-hosted
 * file-sharing system, driven entirely through that project's own CLI.
 *
 * Routes:
 *   GET    /api/share                 → every share (rows + stats), cached ~60s
 *   POST   /api/share/refresh         → drop the cache (202)
 *   POST   /api/share/upload?name=…   → raw body streamed to a scratch file → `share <file>` (201 + link)
 *                                       optional &expire=7d|24h|30d
 *   DELETE /api/share/<slug>          → `share --rm <slug>` (200 | 404)
 *   GET    /api/share/status          → live upload state from the CLI's status file
 *                                       (idle | uploading | failed, filename, link, elapsed_ms)
 *
 * Holds ZERO truth and carries ZERO identity: the CLI is resolved from
 * `SHARE_CLI` env → `~/.bun/bin/share` → `share` on PATH, and every row's
 * link comes back from the CLI's own `--json` output. The public worker is
 * untouched — every mutation here is the same CLI the terminal runs, behind
 * Pulse's loopback Host guard and cross-site write guard. No secrets in this
 * module or its payloads; the CLI reads its own credentials.
 */
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";

const MODULE_NAME = "share";

const CACHE_MS = 60_000;
const LIST_LIMIT = 500;
const READ_TIMEOUT_MS = 90_000;
/** Uploads are multipart to R2 and can be gigabytes — a long leash, not none. */
const UPLOAD_TIMEOUT_MS = 60 * 60_000;
const SLUG_RE = /^[1-9A-HJ-NP-Za-km-z]{6,16}$/;
/** The CLI's upload-state file: it is the one writer, Pulse and the menu-bar app read. Fixed identity-free path, env override. */
const STATUS_FILE = process.env.SHARE_STATUS_FILE ?? join(homedir(), "Library", "Application Support", "Share", "status.json");

export type ShareState = "idle" | "uploading" | "failed";
export interface ShareStatus {
  state: ShareState;
  filename?: string;
  size?: number;
  started_at?: string;
  finished_at?: string;
  link?: string;
  error?: string;
  pid?: number;
  updated_at?: string;
}
const EXPIRE_RE = /^\d+\s*[mhdw]$/i;

export interface ShareRow {
  slug: string;
  filename: string;
  size: number;
  mime: string;
  created_at: string;
  expires_at: string | null;
  views: number;
  og: number;
  url: string;
}

interface Payload {
  available: boolean;
  error?: string;
  shares: ShareRow[];
  stats: { shares: number; bytes: number } | null;
  fetched_at: string | null;
}

const state = {
  running: false,
  cli: null as string | null,
  cached: null as Payload | null,
  cachedAt: 0,
  inflight: null as Promise<Payload> | null,
  uploads: 0,
  /** Last link seen in the status file; a new one means the library changed under us. */
  lastLink: null as string | null,
};

/** Missing, torn or foreign file reads as idle. Exported for tests. */
export function parseStatus(text: string | null): ShareStatus {
  if (text) {
    try {
      const parsed = JSON.parse(text) as Partial<ShareStatus>;
      if (parsed.state === "idle" || parsed.state === "uploading" || parsed.state === "failed") return { ...parsed, state: parsed.state };
    } catch {
      /* torn write or not ours */
    }
  }
  return { state: "idle" };
}

function readStatus(): ShareStatus & { elapsed_ms: number | null; file: string } {
  let text: string | null = null;
  try {
    text = readFileSync(STATUS_FILE, "utf8");
  } catch {
    /* no upload has ever run here */
  }
  const status = parseStatus(text);
  const started = status.started_at ? Date.parse(status.started_at) : NaN;
  const ended = status.finished_at ? Date.parse(status.finished_at) : Date.now();
  const elapsed_ms = Number.isFinite(started) ? Math.max(0, ended - started) : null;
  // A link that was not there last time means a share landed outside Pulse: drop the cache so the next list is fresh.
  if (status.state === "idle" && status.link && status.link !== state.lastLink) {
    state.lastLink = status.link;
    invalidate();
  }
  return { ...status, elapsed_ms, file: basename(STATUS_FILE) };
}

/** SHARE_CLI env → ~/.bun/bin/share (the installed symlink) → bare `share` on PATH. */
export function resolveCli(): string | null {
  const candidates = [process.env.SHARE_CLI, join(homedir(), ".bun", "bin", "share")].filter(
    (c): c is string => !!c,
  );
  for (const c of candidates) {
    if (!existsSync(c)) continue;
    try {
      // The bin entry is a symlink into the project; the CLI locates its own
      // wrangler config from its real directory, so dereference before spawning.
      return realpathSync(c);
    } catch {
      return c;
    }
  }
  const which = Bun.which("share");
  if (which) {
    try {
      return realpathSync(which);
    } catch {
      return which;
    }
  }
  return null;
}

export function start() {
  state.running = true;
  state.cli = resolveCli();
  if (!state.cli) console.log(`[${MODULE_NAME}] share CLI not found (set SHARE_CLI or install the project bin)`);
}

export function stop() {
  state.running = false;
}

export function health() {
  return { module: MODULE_NAME, running: state.running, cli_present: !!state.cli, uploads_in_flight: state.uploads };
}

// ── CLI plumbing ──────────────────────────────────────────────────────

interface Run {
  out: string;
  err: string;
  code: number;
}

/** Spawn the CLI under Pulse's own bun; drain both pipes under a kill timer (the modules/work.ts lesson). */
async function cli(args: string[], timeoutMs: number): Promise<Run> {
  if (!state.cli) state.cli = resolveCli();
  if (!state.cli) return { out: "", err: "share CLI not found", code: 127 };
  const proc = Bun.spawn([process.execPath, state.cli, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, LIFEOS_NOTIFICATION_CHANNEL: "headless" },
  });
  const timer = setTimeout(() => {
    try {
      proc.kill();
    } catch {
      /* already gone */
    }
  }, timeoutMs);
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  return { out, err, code };
}

function parseJson<T>(text: string): T | null {
  const start = text.search(/[[{]/);
  if (start === -1) return null;
  try {
    return JSON.parse(text.slice(start)) as T;
  } catch {
    return null;
  }
}

function invalidate() {
  state.cached = null;
  state.cachedAt = 0;
}

async function load(): Promise<Payload> {
  const [list, stats] = await Promise.all([
    cli(["--list", "--json", "--limit", String(LIST_LIMIT)], READ_TIMEOUT_MS),
    cli(["--stats", "--json"], READ_TIMEOUT_MS),
  ]);
  if (list.code !== 0) {
    const error = (list.err.trim() || list.out.trim() || `exit ${list.code}`).slice(0, 300);
    console.log(`[${MODULE_NAME}] list failed: ${error}`);
    return { available: false, error, shares: [], stats: null, fetched_at: null };
  }
  const rows = parseJson<ShareRow[]>(list.out) ?? [];
  const totals = stats.code === 0 ? parseJson<{ shares: number; bytes: number }>(stats.out) : null;
  return {
    available: true,
    shares: rows,
    stats: totals ?? { shares: rows.length, bytes: rows.reduce((s, r) => s + (r.size || 0), 0) },
    fetched_at: new Date().toISOString(),
  };
}

async function snapshot(): Promise<Payload> {
  const now = Date.now();
  if (state.cached && now - state.cachedAt < CACHE_MS) return state.cached;
  if (state.inflight) return state.inflight;
  state.inflight = load()
    .then((p) => {
      if (p.available) {
        state.cached = p;
        state.cachedAt = Date.now();
      }
      return p;
    })
    .finally(() => {
      state.inflight = null;
    });
  return state.inflight;
}

// ── Mutations ─────────────────────────────────────────────────────────

/** A display name the CLI will store verbatim: no path separators, no control chars, bounded. */
export function safeName(raw: string | null): string | null {
  if (!raw) return null;
  const name = basename(raw.replace(/[\\/]/g, "_"))
    .replace(/[\x00-\x1f\x7f]/g, "")
    .trim()
    .slice(0, 200);
  if (!name || name === "." || name === "..") return null;
  return name;
}

async function upload(req: Request, url: URL): Promise<Response> {
  const name = safeName(url.searchParams.get("name"));
  if (!name) return Response.json({ error: "name query parameter required" }, { status: 400 });
  const expire = url.searchParams.get("expire")?.trim() || null;
  if (expire && !EXPIRE_RE.test(expire)) return Response.json({ error: "bad expire (use 24h, 7d, 30d, 2w)" }, { status: 400 });
  if (!req.body) return Response.json({ error: "empty body" }, { status: 400 });

  const dir = mkdtempSync(join(tmpdir(), "lifeos-share-"));
  const path = join(dir, name);
  state.uploads++;
  try {
    // Stream the body to disk chunk by chunk (a FileSink), never buffering the
    // whole file: recordings run to gigabytes. `Bun.write(path, new Response(req.body))`
    // took the process down with no stack on Bun 1.3.6 — reproduced in isolation.
    const sink = Bun.file(path).writer();
    let written = 0;
    for await (const chunk of req.body) {
      written += chunk.byteLength;
      sink.write(chunk);
    }
    await sink.end();
    if (written === 0) return Response.json({ error: "empty body" }, { status: 400 });

    const args = [path, "--name", name];
    if (expire) args.push("--expire", expire);
    const run = await cli(args, UPLOAD_TIMEOUT_MS);
    if (run.code !== 0) {
      const error = (run.err.trim() || run.out.trim() || `exit ${run.code}`).slice(0, 300);
      console.log(`[${MODULE_NAME}] upload failed: ${error}`);
      return Response.json({ error }, { status: 502 });
    }
    const link = run.out.split("\n").map((l) => l.trim()).find((l) => /^https?:\/\//.test(l));
    if (!link) return Response.json({ error: "CLI returned no link" }, { status: 502 });
    invalidate();
    return Response.json({ url: link, slug: link.slice(link.lastIndexOf("/") + 1), filename: name, size: written }, { status: 201 });
  } finally {
    state.uploads--;
    rmSync(dir, { recursive: true, force: true });
  }
}

async function remove(slug: string): Promise<Response> {
  if (!SLUG_RE.test(slug)) return Response.json({ error: "bad slug" }, { status: 400 });
  const run = await cli(["--rm", slug, "--json"], READ_TIMEOUT_MS);
  if (run.code !== 0) {
    const error = (run.err.trim() || run.out.trim() || `exit ${run.code}`).slice(0, 300);
    if (/no share with slug/i.test(error)) return Response.json({ error: "no such share" }, { status: 404 });
    console.log(`[${MODULE_NAME}] remove failed: ${error}`);
    return Response.json({ error }, { status: 502 });
  }
  invalidate();
  return Response.json(parseJson<Record<string, unknown>>(run.out) ?? { removed: slug });
}

// ── Request handling ──────────────────────────────────────────────────

export async function handleRequest(req: Request, pathname: string): Promise<Response | null> {
  if (!pathname.startsWith("/api/share")) return null;
  const method = req.method.toUpperCase();
  const rest = pathname.slice("/api/share".length);

  if (rest === "" || rest === "/") {
    if (method !== "GET") return Response.json({ error: "method not allowed" }, { status: 405 });
    const p = await snapshot();
    return Response.json({ ...p, cache_age_ms: state.cachedAt ? Date.now() - state.cachedAt : null });
  }
  if (rest === "/status") {
    if (method !== "GET") return Response.json({ error: "method not allowed" }, { status: 405 });
    return Response.json(readStatus(), { headers: { "Cache-Control": "no-store" } });
  }
  if (rest === "/refresh" && method === "POST") {
    invalidate();
    return Response.json({ refreshing: true }, { status: 202 });
  }
  if (rest === "/upload" && method === "POST") return upload(req, new URL(req.url));

  const m = /^\/([^/]+)$/.exec(rest);
  if (m && method === "DELETE") return remove(decodeURIComponent(m[1]!));

  return Response.json({ error: "not found" }, { status: 404 });
}
