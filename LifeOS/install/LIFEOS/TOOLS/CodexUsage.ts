/**
 * CodexUsage.ts — the OpenAI/Codex plan's usage windows, cached for the statusline.
 *
 * Statusline ISA 20260910-statusline-codex-usage. Two sources, one normalized shape:
 *
 *   1. The ChatGPT backend usage endpoint (`/backend-api/codex/usage`, the same call the
 *      Codex TUI makes for `account/rateLimits/read`), authenticated with the access token and
 *      account id Codex keeps in `$CODEX_HOME/auth.json`. Verified live 2026-09-10: 200, one
 *      weekly window, `secondary_window: null`.
 *   2. The newest `rate_limits` row in any Codex rollout log — `$CODEX_HOME/sessions/**` plus the
 *      isolated agent homes `$XDG_CACHE_HOME/lifeos-codex-homes/<agent>/sessions/**` — when the endpoint is
 *      unreachable or rejects the token (Codex refreshes its own token; this tool never does).
 *
 * The cache (`$XDG_CACHE_HOME/lifeos-statusline/codex-usage.json`, owner-only dir) holds percentages, reset epochs,
 * the plan, the account email and a `fetched_at` stamp. The token is never written or printed.
 *
 *   bun LIFEOS/TOOLS/CodexUsage.ts --refresh [--json]   # fetch → fallback → write cache; exit 1 when neither source has data
 *   bun LIFEOS/TOOLS/CodexUsage.ts --print              # print the cache as JSON
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, renameSync, chmodSync, openSync, readSync, closeSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir, userInfo } from "node:os";
import { codexHomesRoot } from "./lib/CacheDir";
import { invariant } from "./Invariant.ts";

export const USAGE_URL = "https://chatgpt.com/backend-api/codex/usage";
const TAIL_BYTES = 128 * 1024;
const ROLLOUT_CANDIDATES = 6;

export interface UsageWindow {
  /** `5H` for a five-hour window, `WK` for a seven-day window; `<n>H` / `<n>D` for anything else. */
  label: string;
  pct: number;
  /** Epoch seconds when the window resets (0 when unknown). */
  reset_at: number;
  window_seconds: number;
}

export interface CodexUsage {
  source: "api" | "rollout";
  plan: string;
  email: string;
  /** Epoch seconds of the observation: the fetch time for `api`, the row timestamp for `rollout`. */
  fetched_at: number;
  /** Epoch seconds of the last refresh attempt that wrote this file — the statusline throttles on
   *  THIS, never on `fetched_at`, so an outage served from an old rollout still costs one fetch per TTL. */
  attempted_at?: number;
  limit_reached: boolean;
  windows: UsageWindow[];
  /** Limit resets the plan holds (api source only): `available` in total, `applicable` usable on the current cap. */
  reset_credits?: { available: number; applicable: number };
}

export function cachePath(): string {
  if (process.env.LIFEOS_CODEX_USAGE_CACHE) return process.env.LIFEOS_CODEX_USAGE_CACHE;
  // The statusline's owner-only cache dir, never the shared /tmp (round-20 audit).
  const dir = join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "lifeos-statusline");
  try { if (!existsSync(dir)) { require("node:fs").mkdirSync(dir, { recursive: true, mode: 0o700 }); } } catch { /* read-only fs: the reader tolerates a missing cache */ }
  return join(dir, "codex-usage.json");
}

export function codexHome(): string {
  return process.env.CODEX_HOME || join(homedir(), ".codex");
}

/** `sessions/` roots to scan for rollouts: the real home first, then every isolated agent home
 *  under the owner-only cache root (never /tmp, where another account could plant one; round 22). */
export function rolloutRoots(home = codexHome(), homes = codexHomesRoot()): string[] {
  const roots = [join(home, "sessions")];
  try {
    for (const d of readdirSync(homes)) roots.push(join(homes, d, "sessions"));
  } catch { /* no homes dir → the real home only */ }
  return roots.filter((r) => existsSync(r));
}

export function labelFor(windowSeconds: number): string {
  if (windowSeconds <= 0) return "?";
  if (windowSeconds <= 6 * 3600) return windowSeconds === 5 * 3600 ? "5H" : `${Math.round(windowSeconds / 3600)}H`;
  if (windowSeconds >= 6 * 86400 && windowSeconds <= 8 * 86400) return "WK";
  return `${Math.round(windowSeconds / 86400)}D`;
}

function clampPct(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function epoch(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

type ApiWindow = { used_percent?: unknown; limit_window_seconds?: unknown; reset_at?: unknown } | null | undefined;
type RolloutWindow = { used_percent?: unknown; window_minutes?: unknown; resets_at?: unknown } | null | undefined;

/** The endpoint payload → the cache shape. `now` is the fetch time in epoch seconds. */
export function normalizeApi(payload: Record<string, unknown>, now: number): CodexUsage {
  const rl = (payload.rate_limit ?? {}) as { primary_window?: ApiWindow; secondary_window?: ApiWindow; limit_reached?: unknown };
  const windows: UsageWindow[] = [];
  for (const w of [rl.primary_window, rl.secondary_window]) {
    if (!w) continue;
    const secs = epoch(w.limit_window_seconds);
    windows.push({ label: labelFor(secs), pct: clampPct(w.used_percent), reset_at: epoch(w.reset_at), window_seconds: secs });
  }
  windows.sort((a, b) => a.window_seconds - b.window_seconds);
  return {
    source: "api",
    plan: typeof payload.plan_type === "string" ? payload.plan_type : "",
    email: typeof payload.email === "string" ? payload.email : "",
    fetched_at: now,
    limit_reached: rl.limit_reached === true,
    windows,
    reset_credits: resetCredits(payload.rate_limit_reset_credits),
  };
}

/** `rate_limit_reset_credits` — the plan's limit resets: how many the account holds, and how many apply right now. Absent from rollout rows. */
function resetCredits(v: unknown): CodexUsage["reset_credits"] {
  if (!v || typeof v !== "object") return undefined;
  const r = v as { available_count?: unknown; applicable_available_count?: unknown };
  const n = (x: unknown) => (typeof x === "number" && Number.isFinite(x) && x >= 0 ? Math.floor(x) : 0);
  return { available: n(r.available_count), applicable: n(r.applicable_available_count) };
}

/** A rollout `rate_limits` object → the cache shape. `ts` is the row's timestamp in epoch seconds; the email is not in the log. */
export function normalizeRollout(rateLimits: Record<string, unknown>, ts: number, email = ""): CodexUsage {
  const windows: UsageWindow[] = [];
  for (const w of [rateLimits.primary as RolloutWindow, rateLimits.secondary as RolloutWindow]) {
    if (!w) continue;
    const secs = epoch(w.window_minutes) * 60;
    windows.push({ label: labelFor(secs), pct: clampPct(w.used_percent), reset_at: epoch(w.resets_at), window_seconds: secs });
  }
  windows.sort((a, b) => a.window_seconds - b.window_seconds);
  return {
    source: "rollout",
    plan: typeof rateLimits.plan_type === "string" ? rateLimits.plan_type : "",
    email,
    fetched_at: ts,
    limit_reached: rateLimits.rate_limit_reached_type != null && rateLimits.rate_limit_reached_type !== "",
    windows,
  };
}

function readTail(file: string): string {
  const size = statSync(file).size;
  const start = Math.max(0, size - TAIL_BYTES);
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    return buf.toString("utf8");
  } finally { closeSync(fd); }
}

/** The last `rate_limits` row in one rollout, or null. */
export function lastRateLimitsRow(file: string): { rateLimits: Record<string, unknown>; ts: number } | null {
  if (!existsSync(file)) return null;
  const lines = readTail(file).split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.includes('"rate_limits"')) continue;
    try {
      const row = JSON.parse(line) as { timestamp?: unknown; payload?: { rate_limits?: unknown } };
      const rl = row.payload?.rate_limits;
      if (!rl || typeof rl !== "object") continue;
      const ts = typeof row.timestamp === "string" ? Math.round(Date.parse(row.timestamp) / 1000) : 0;
      if (!ts) continue;
      return { rateLimits: rl as Record<string, unknown>, ts };
    } catch { /* a truncated first line of the tail window */ }
  }
  return null;
}

function walkRollouts(dir: string, out: { file: string; mtime: number }[]): void {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return; }
  for (const e of entries) {
    const p = join(dir, e);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walkRollouts(p, out);
    else if (e.startsWith("rollout-") && e.endsWith(".jsonl")) out.push({ file: p, mtime: st.mtimeMs });
  }
}

/** The newest `rate_limits` observation across every rollout root, by row timestamp. */
export function newestRolloutUsage(roots: string[], email = ""): CodexUsage | null {
  const files: { file: string; mtime: number }[] = [];
  for (const r of roots) walkRollouts(r, files);
  files.sort((a, b) => b.mtime - a.mtime);
  let best: CodexUsage | null = null;
  for (const f of files.slice(0, ROLLOUT_CANDIDATES)) {
    const row = lastRateLimitsRow(f.file);
    if (!row) continue;
    const u = normalizeRollout(row.rateLimits, row.ts, email);
    if (u.windows.length === 0) continue;
    if (!best || u.fetched_at > best.fetched_at) best = u;
  }
  return best;
}

interface Auth { token: string; accountId: string }

/** Identity comes from the live login, never from its usage cache. */
export function authEmail(home = codexHome()): string | null {
  try {
    const j = JSON.parse(readFileSync(join(home, "auth.json"), "utf8"));
    const payload = JSON.parse(Buffer.from(j.tokens.id_token.split(".")[1], "base64url").toString("utf8"));
    const email = payload.email ?? payload["https://api.openai.com/profile"]?.email;
    return typeof email === "string" && email.length > 0 ? email : null;
  } catch { return null; }
}

export function readAuth(home = codexHome()): Auth | null {
  const p = join(home, "auth.json");
  if (!existsSync(p)) return null;
  try {
    const j = JSON.parse(readFileSync(p, "utf8")) as { tokens?: { access_token?: unknown; account_id?: unknown } };
    const token = j.tokens?.access_token;
    const accountId = j.tokens?.account_id;
    if (typeof token !== "string" || !token) return null;
    return { token, accountId: typeof accountId === "string" ? accountId : "" };
  } catch { return null; }
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** One GET against the usage endpoint; null on any non-200, non-JSON, or missing `rate_limit`. */
export async function fetchUsage(auth: Auth, fetchImpl: FetchLike = fetch, now = Math.floor(Date.now() / 1000)): Promise<CodexUsage | null> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${auth.token}`,
    Accept: "application/json",
    "User-Agent": "lifeos-codex-usage",
  };
  if (auth.accountId) headers["ChatGPT-Account-Id"] = auth.accountId;
  let res: Response;
  try {
    res = await fetchImpl(USAGE_URL, { headers, signal: AbortSignal.timeout(4000) });
  } catch { return null; }
  if (res.status !== 200) return null;
  let payload: Record<string, unknown>;
  try { payload = (await res.json()) as Record<string, unknown>; } catch { return null; }
  if (!payload || typeof payload !== "object" || !payload.rate_limit) return null;
  const u = normalizeApi(payload, now);
  return u.windows.length > 0 ? u : null;
}

export function readCache(path = cachePath()): CodexUsage | null {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, "utf8")) as CodexUsage; } catch { return null; }
}

/** Atomic 0600 write. Invariants: at least one window, every pct in 0..100, a positive stamp, and no token material in the body. */
export function writeCache(u: CodexUsage, path = cachePath(), tokenHint?: string): void {
  invariant(u.windows.length > 0, "CodexUsage cache needs at least one window");
  invariant(u.windows.every((w) => w.pct >= 0 && w.pct <= 100), "CodexUsage pct out of 0..100");
  invariant(u.fetched_at > 0, "CodexUsage fetched_at must be positive");
  const body = JSON.stringify(u, null, 2) + "\n";
  invariant(!/eyJ[A-Za-z0-9_-]{20,}/.test(body), "CodexUsage cache must not carry a JWT");
  // Real tokens run to ~1.8 KB; a hint shorter than 16 chars would false-positive on ordinary text.
  if (tokenHint && tokenHint.length >= 16) invariant(!body.includes(tokenHint), "CodexUsage cache must not carry the access token");
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, body, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

export interface RefreshOptions {
  fetchImpl?: FetchLike;
  auth?: Auth | null;
  roots?: string[];
  path?: string;
  now?: number;
}

/** `<cache>.failed` — touched when a refresh found no data, cleared on success. The statusline
 *  skips re-spawning the fetch while the stamp is younger than its TTL, so a dead endpoint
 *  with no rollouts costs one bun start per TTL, never one per 5 s render tick. */
export function failureStampPath(path: string): string { return `${path}.failed`; }

/** Endpoint first, rollout fallback. Returns what was written, or null when neither source had data (cache untouched, failure stamp written). */
export async function refresh(opts: RefreshOptions = {}): Promise<CodexUsage | null> {
  const path = opts.path ?? cachePath();
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const auth = opts.auth === undefined ? readAuth() : opts.auth;
  const prev = readCache(path);
  let u: CodexUsage | null = null;
  if (auth) u = await fetchUsage(auth, opts.fetchImpl ?? fetch, now);
  if (!u) u = newestRolloutUsage(opts.roots ?? rolloutRoots(), prev?.email ?? "");
  if (!u) {
    writeFileSync(failureStampPath(path), `${now}\n`, { mode: 0o600 });
    return null;
  }
  try { unlinkSync(failureStampPath(path)); } catch { /* no stamp to clear */ }
  // A rollout snapshot older than the cached observation is no improvement; keep the newer stamp.
  if (u.source === "rollout" && prev && prev.fetched_at >= u.fetched_at) u = prev;
  u = { ...u, attempted_at: now };
  writeCache(u, path, auth?.token.slice(0, 24));
  return u;
}

/** Display label for an OpenAI plan_type: "prolite" is the $200 Pro plan. The cache keeps the raw value. */
export function planLabel(plan: string | null | undefined): string | null {
  if (!plan) return null;
  const known: Record<string, string> = { prolite: "Pro", pro: "Pro", plus: "Plus" };
  return known[plan.toLowerCase()] ?? plan;
}

export function printLine(u: CodexUsage): string {
  return `codex usage ${u.source}: ${u.windows.map((w) => `${w.label} ${w.pct}%`).join(" · ")} · ${planLabel(u.plan) ?? "?"} · ${cachePath()}`;
}

// The CLI is a function, not top-level await: a module with top-level await cannot be require()d by in-process callers.
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  if (args.includes("--print")) {
    const c = readCache();
    if (!c) { console.error(`no cache at ${cachePath()}`); process.exit(1); }
    console.log(JSON.stringify(c, null, 2));
    process.exit(0);
  }
  const u = await refresh();
  if (!u) { console.error("CodexUsage: no usage data from the endpoint or any rollout log"); process.exit(1); }
  if (json) console.log(JSON.stringify(u, null, 2));
  else console.log(printLine(u));
}

if (import.meta.main) void main();
