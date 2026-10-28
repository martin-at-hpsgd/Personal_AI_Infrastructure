/**
 * Usage Pulse module — read-only surface over Anthropic subscription + token/cost usage.
 *
 * Routes:
 *   GET /api/usage/summary            → { ts, subscription:{fiveHourPct,sevenDayPct}, monthUsedUsd,
 *                                          today, week, month, hasDaily }
 *   GET /api/usage/trend?range=daily|weekly|monthly → { range, points:[{label,totalTokens,costUsd,messages}] }
 *   GET /api/usage/models?window=30|all             → { window, models:[{model,messages,totalTokens,costUsd,pct}] }
 *   GET /api/usage/accounts           → per-account Claude Code usage rows (empty unless an install adds per-account polling)
 *   GET /api/usage/codex              → { accounts:[{email,plan,source,fetched_at,limit_reached,stale,windows}] }
 *
 * SOURCES (all read-only, produced elsewhere):
 *   - MEMORY/OBSERVABILITY/anthropic-cost.jsonl  — live subscription 5h/7d % + admin cost_report monthly $ (CostTracker cron)
 *   - MEMORY/OBSERVABILITY/usage-daily.jsonl     — DURABLE per-day token/cost/model rollup (UsageAggregator nightly launchd)
 *
 * No secret is read or emitted here — only the already-computed aggregates.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { readJsonlCached, readJsonlTail } from "../lib/jsonl-window.ts";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const MODULE_NAME = "usage";
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
const OBS_DIR = join(CLAUDE_DIR, "LIFEOS", "MEMORY", "OBSERVABILITY");
const ANTHROPIC_COST = join(OBS_DIR, "anthropic-cost.jsonl");
const USAGE_DAILY = join(OBS_DIR, "usage-daily.jsonl");
const OVERAGE_SUMMARY = join(OBS_DIR, "overage-summary.json");
const OVERAGE_LEDGER = join(OBS_DIR, "overage-ledger.jsonl");
const OVERAGE_STATE = join(OBS_DIR, "overage-state.json");
const OVERAGE_CONFIG = join(CLAUDE_DIR, "LIFEOS", "USER", "CONFIG", "overage.json");
const OVERAGE_CEILING_DEFAULT_USD = 1000;

/** The ceiling Overage.ts enforces. Read from the same config file so this surface and the
 *  CLI can never quote different numbers (ISC O1). */
function overageCeiling(): number {
  try {
    const n = Number((JSON.parse(readFileSync(OVERAGE_CONFIG, "utf8")) as { ceilingUsd?: unknown }).ceilingUsd);
    if (Number.isFinite(n) && n > 0) return n;
  } catch { /* no config → the default */ }
  return OVERAGE_CEILING_DEFAULT_USD;
}

/** The live arm state, so a recompute never reports "disarmed" while the lane is on. */
function overageArm(): { armed: boolean; sessionId?: string; reason?: string; expiresAt?: number } {
  try {
    const s = JSON.parse(readFileSync(OVERAGE_STATE, "utf8")) as { armed?: boolean; expiresAt?: number };
    if (!s?.armed) return { armed: false };
    if (typeof s.expiresAt === "number" && s.expiresAt > 0 && s.expiresAt <= Math.floor(Date.now() / 1000)) return { armed: false };
    return s as { armed: boolean };
  } catch { return { armed: false }; }
}
const state = { running: false };

interface ModelAgg { messages: number; totalTokens: number; costUsd: number }
interface DayAgg {
  date: string; messages: number; inputTokens: number; outputTokens: number;
  cacheReadTokens: number; cacheCreationTokens: number; totalTokens: number;
  costUsd: number; models: Record<string, ModelAgg>;
}
interface OverageCall {
  ts: string; vendor: "openai" | "anthropic"; lane: string; model: string;
  inputTokens: number; outputTokens: number; costUsd: number; sessionId?: string; reason?: string;
}
interface OverageSummary {
  month: string; ceilingUsd: number; spentUsd: number; remainingUsd: number;
  byVendor: (Pick<OverageCall, "vendor" | "lane" | "model" | "inputTokens" | "outputTokens" | "costUsd"> & { calls: number })[];
  armed: { armed: boolean; sessionId?: string; reason?: string; expiresAt?: number };
  recent: OverageCall[]; updated: string;
}

// ── Source readers ───────────────────────────────────────────────────────────

/** Last non-empty JSON line of a jsonl file, or null. */
function lastLine<T = any>(path: string): T | null {
  // Byte-bounded tail (2026-09-04): anthropic-cost.jsonl is 21 MB and grows.
  const rows = readJsonlTail(path, 1, 64 * 1024);
  return rows.length ? (rows[rows.length - 1] as T) : null;
}

function readDaily(): DayAgg[] {
  if (!existsSync(USAGE_DAILY)) return [];
  const out = readJsonlCached(USAGE_DAILY) as DayAgg[];
  return [...out].sort((a, b) => a.date.localeCompare(b.date));
}

function monthNow(): string { return new Date().toISOString().slice(0, 7); }
function asNumber(value: unknown): number { return typeof value === "number" && Number.isFinite(value) ? value : 0; }
function roundUsd(value: number): number { return Math.round(value * 100) / 100; }
function emptyOverage(): OverageSummary {
  return {
    month: monthNow(), ceilingUsd: overageCeiling(), spentUsd: 0, remainingUsd: overageCeiling(),
    byVendor: [], armed: overageArm(), recent: [], updated: new Date().toISOString(),
  };
}

function isOverageCall(value: unknown): value is OverageCall {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return typeof row.ts === "string" && (row.vendor === "openai" || row.vendor === "anthropic")
    && typeof row.lane === "string" && typeof row.model === "string";
}

function buildOverage(): OverageSummary {
  const empty = emptyOverage();
  if (!existsSync(OVERAGE_LEDGER)) return empty;
  const rows = (readJsonlCached(OVERAGE_LEDGER) as unknown[])
    .filter(isOverageCall)
    .filter((row) => row.ts.slice(0, 7) === empty.month);
  const vendors = new Map<string, OverageSummary["byVendor"][number]>();
  for (const row of rows) {
    const key = `${row.vendor}\u0000${row.lane}\u0000${row.model}`;
    const current = vendors.get(key) ?? { vendor: row.vendor, lane: row.lane, model: row.model, calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
    current.calls += 1;
    current.inputTokens += asNumber(row.inputTokens);
    current.outputTokens += asNumber(row.outputTokens);
    current.costUsd += asNumber(row.costUsd);
    vendors.set(key, current);
  }
  const spentUsd = roundUsd(rows.reduce((total, row) => total + asNumber(row.costUsd), 0));
  return {
    ...empty,
    spentUsd,
    remainingUsd: Math.max(0, roundUsd(empty.ceilingUsd - spentUsd)),
    byVendor: [...vendors.values()].map((row) => ({ ...row, costUsd: roundUsd(row.costUsd) })).sort((a, b) => b.costUsd - a.costUsd),
    recent: [...rows].sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, 20).map((row) => ({
      ...row, inputTokens: asNumber(row.inputTokens), outputTokens: asNumber(row.outputTokens), costUsd: roundUsd(asNumber(row.costUsd)),
    })),
  };
}

function buildOverageSummary(): OverageSummary {
  if (!existsSync(OVERAGE_SUMMARY)) return buildOverage();
  try {
    const cached = JSON.parse(readFileSync(OVERAGE_SUMMARY, "utf8")) as OverageSummary;
    const cacheIsFresh = !existsSync(OVERAGE_LEDGER) || statSync(OVERAGE_SUMMARY).mtimeMs >= statSync(OVERAGE_LEDGER).mtimeMs;
    // A current cache is authoritative only until the ledger advances; malformed cache data falls back too.
    if (cacheIsFresh && cached?.month === monthNow() && typeof cached.updated === "string" && Array.isArray(cached.byVendor) && Array.isArray(cached.recent) && cached.armed) return cached;
  } catch { /* ledger fallback intentionally handles absent or partial cache writes */ }
  return buildOverage();
}

// ── Aggregation helpers ──────────────────────────────────────────────────────

interface Totals { totalTokens: number; costUsd: number; messages: number }
const ZERO: Totals = { totalTokens: 0, costUsd: 0, messages: 0 };
function sumDays(days: DayAgg[]): Totals {
  return days.reduce<Totals>((s, d) => ({
    totalTokens: s.totalTokens + (d.totalTokens || 0),
    costUsd: s.costUsd + (d.costUsd || 0),
    messages: s.messages + (d.messages || 0),
  }), { ...ZERO });
}
function round2(t: Totals): Totals { return { ...t, costUsd: Math.round(t.costUsd * 100) / 100 }; }

/** ISO date string N days before today (UTC). */
function daysAgo(n: number): string {
  const ms = Date.now() - n * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}
function isoWeek(date: string): string {
  const d = new Date(date + "T00:00:00Z");
  const day = (d.getUTCDay() + 6) % 7; // Mon=0
  d.setUTCDate(d.getUTCDate() - day + 3);
  const firstThu = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((d.getTime() - firstThu.getTime()) / 86_400_000 - 3 + ((firstThu.getUTCDay() + 6) % 7)) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

// ── Per-account usage (an optional, install-local extension) ─────────────────
//
// An install can add per-account polling by placing an extension module beside this one
// (usage-accounts.ts; LIFEOS_USAGE_ACCOUNTS_EXT points elsewhere for tests). The extension writes
// the per-account state file this module reads (accounts-usage.json). Without it nothing polls,
// nothing logs, and /accounts reads whatever state file exists: none on a fresh install, so the
// list is empty. Pulse owns the cadence: one poll at start, then every 15 min — the same TTL the
// status line uses for the usage endpoint.

/** LIFEOS_ACCOUNTS_FILE points the module at a fixture state file (tests, fixture renders); read per request. */
function accountsStatePath(): string { return process.env.LIFEOS_ACCOUNTS_FILE || join(OBS_DIR, "accounts-usage.json"); }
const ACCOUNTS_POLL_MS = 15 * 60_000;
let accountsTimer: ReturnType<typeof setInterval> | null = null;

/** What a per-account extension module exports. */
export interface AccountsExtension {
  /** False when the extension is present but no accounts are configured: polling stays silent. */
  configured(): boolean | Promise<boolean>;
  /** Refresh the per-account state file. */
  poll(): Promise<void>;
  /** The one command that logs this account in, or null for an unknown slug. */
  loginCommand(slug: string): string | null;
  /** Runs after each timed poll, when present. */
  afterPoll?(): Promise<void>;
  /** True only when this install has the private skill that owns account recommendations. Absent or
   *  false, /accounts carries no recommendation, so the page never prompts a move to another account. */
  showsRecommendation?(): boolean;
}

/** Read per call so tests can point it at a fixture or at nothing. */
export function accountsExtensionPath(): string {
  return process.env.LIFEOS_USAGE_ACCOUNTS_EXT || join(import.meta.dir, "usage-accounts.ts");
}

/** The extension, or null when the file is absent (the normal public install). A file that exists
 *  but does not export the contract throws, so a broken extension is loud, never silently skipped. */
export async function loadAccountsExtension(path: string = accountsExtensionPath()): Promise<AccountsExtension | null> {
  if (!existsSync(path)) return null;
  const mod = (await import(path)) as Partial<AccountsExtension>;
  if (typeof mod.configured !== "function" || typeof mod.poll !== "function" || typeof mod.loginCommand !== "function") {
    throw new Error(`${path} must export configured(), poll() and loginCommand()`);
  }
  if (mod.afterPoll !== undefined && typeof mod.afterPoll !== "function") throw new Error(`${path}: afterPoll must be a function`);
  if (mod.showsRecommendation !== undefined && typeof mod.showsRecommendation !== "function") throw new Error(`${path}: showsRecommendation must be a function`);
  return mod as AccountsExtension;
}

/** One poll. `ext` undefined loads the installed extension; null (or an absent file) is a quiet no-op. */
export async function pollAccounts(ext?: AccountsExtension | null): Promise<void> {
  try {
    const e = ext === undefined ? await loadAccountsExtension() : ext;
    if (!e || !(await e.configured())) return;
    await e.poll();
  } catch (err) {
    console.error(`[${MODULE_NAME}] account poll failed: ${String(err)}`);
  }
}

/** The extension's post-poll step; a failure is logged and never escapes the usage timer. */
async function afterAccountsPoll(): Promise<void> {
  try {
    const e = await loadAccountsExtension();
    if (e?.afterPoll) await e.afterPoll();
  } catch (err) {
    console.error(`[${MODULE_NAME}] post-poll step failed: ${String(err)}`);
  }
}

/** One entry per state-file row, each with `active` (slug === active_slug, so at most one card) and an
 *  `org_label`: "Personal" for a personal org, else the org name. */
export function accountsView(s: any, now = Date.now()) {
  const age = now - Date.parse(s?.fetched_at ?? 0);
  const activeSlug: string | null = typeof s?.active_slug === "string" ? s.active_slug : null;
  const rows: any[] = Array.isArray(s?.accounts) ? s.accounts : [];
  return {
    ...s, active_slug: activeSlug, stale: !(age < 2 * ACCOUNTS_POLL_MS),
    accounts: rows.map((a) => ({ ...a, active: activeSlug !== null && a.slug === activeSlug, org_label: a.kind === "team" ? a.org ?? "Team" : a.kind === "personal" ? "Personal" : a.org ?? null })),
  };
}

/** The active account's row, by active_slug only; null when the state cannot say which row is live. */
export function activeRow(state: any): any | null {
  if (typeof state?.active_slug !== "string" || !Array.isArray(state?.accounts)) return null;
  return state.accounts.find((a: any) => a.slug === state.active_slug && a.status === "ok") ?? null;
}

function buildAccounts() {
  const path = accountsStatePath();
  if (!existsSync(path)) return { fetched_at: null, active_email: null, active_slug: null, accounts: [], recommendation: null, stale: true };
  return accountsView(JSON.parse(readFileSync(path, "utf8")));
}

/** A needs-login card carries the one command that logs that account in (the extension's
 *  loginCommand); without it the card sat blank. */
export function withLoginHints<T extends { accounts: { slug: string; status: string }[] }>(
  state: T, login: (slug: string) => string | null,
): T {
  return {
    ...state,
    accounts: state.accounts.map((a) => {
      const cmd = a.status === "needs-login" ? login(a.slug) : null;
      return cmd ? { ...a, login: cmd } : a;
    }),
  };
}

/** The /accounts body: the state file's rows, with login hints when an extension is installed. The
 *  state file's recommendation passes through only when the extension says this install shows one
 *  (showsRecommendation); a public install has no extension, so its body always carries null. */
export async function buildAccountsWithLogin(ext?: AccountsExtension | null) {
  const e = ext === undefined ? await loadAccountsExtension() : ext;
  const raw = buildAccounts();
  const state = e?.showsRecommendation?.() === true ? raw : { ...raw, recommendation: null };
  return e ? withLoginHints(state, (slug) => e.loginCommand(slug)) : state;
}

// ── Codex accounts (the ChatGPT plan the codex workers ride) ─────────────────
//
// LIFEOS/TOOLS/CodexUsage.ts is the statusline's fetcher: endpoint first, newest
// rollout row as fallback, one owner-only cache carrying percentages, plan and
// email, never a token. Pulse reads the same cache so the two cannot disagree,
// and refreshes it on the accounts timer. One login today; the array shape is
// for the day there is a second.

// Registry (USER data): LIFEOS/USER/CONFIG/openai-accounts.json. The `default` row is the
// login in ~/.codex, which the codex workers ride; every other row has its own CODEX_HOME at
// <configDirRoot>/<slug>, logged in once by hand, and its own cache beside the default one.
const CODEX_REGISTRY = join(CLAUDE_DIR, "LIFEOS", "USER", "CONFIG", "openai-accounts.json");
interface CodexRow { slug: string; email: string; default?: boolean }
interface CodexRegistry { configDirRoot: string; accounts: CodexRow[] }

function codexRegistry(): CodexRegistry | null {
  try {
    const r = JSON.parse(readFileSync(CODEX_REGISTRY, "utf8")) as CodexRegistry;
    return Array.isArray(r?.accounts) && typeof r.configDirRoot === "string" ? r : null;
  } catch { return null; }
}
export function codexHomeFor(reg: Pick<CodexRegistry, "configDirRoot">, slug: string): string {
  return join(reg.configDirRoot.replace(/^~(?=\/|$)/, homedir()), slug);
}
export function codexCacheFor(defaultCache: string, row: Pick<CodexRow, "slug" | "default">): string {
  return row.default ? defaultCache : join(dirname(defaultCache), `codex-usage-${row.slug}.json`);
}

async function pollCodex(): Promise<void> {
  try {
    const { refresh, readAuth, cachePath } = await import("../../TOOLS/CodexUsage.ts");
    await refresh();
    const reg = codexRegistry();
    for (const row of reg?.accounts ?? []) {
      if (row.default) continue;
      const home = codexHomeFor(reg!, row.slug);
      if (!existsSync(join(home, "auth.json"))) continue; // not logged in yet: the card says so
      await refresh({ auth: readAuth(home), roots: [join(home, "sessions")], path: codexCacheFor(cachePath(), row) });
    }
  } catch (err) {
    console.error(`[${MODULE_NAME}] codex poll failed: ${String(err)}`);
  }
}

interface CodexCache {
  source: string; plan: string; email: string; fetched_at: number; limit_reached: boolean;
  windows: { label: string; pct: number; reset_at: number }[];
  reset_credits?: { available: number; applicable: number };
}

/** Every registry account: its usage row when a cache exists, else a needs-login row carrying the
 *  one command that logs it in. No registry → the single default login, as before. */
export function buildCodexAll(defaultCache: string, reg: CodexRegistry | null, now = Date.now()) {
  if (!reg) return buildCodex(defaultCache, now);
  const accounts = reg.accounts.map((row) => {
    let got = buildCodex(codexCacheFor(defaultCache, row), now).accounts[0];
    // A cache signed in as some other address is that account's usage, not this row's: the
    // default home held one account's login while the registry named it as another, and Pulse
    // drew one plan under two names (2026-09-22). Only a matching (or unknown) email counts.
    let same = !got?.email || got.email.toLowerCase() === row.email.toLowerCase();
    // The default row whose ~/.codex is someone else's may still have its own cache, written from another machine.
    if (row.default && got && !same) {
      const own = buildCodex(codexCacheFor(defaultCache, { slug: row.slug }), now).accounts[0];
      if (own && (!own.email || own.email.toLowerCase() === row.email.toLowerCase())) { got = own; same = true; }
    }
    if (got && same) return { slug: row.slug, status: "ok" as const, ...got, email: got.email || row.email };
    // Always the account's own store, never ~/.codex: a login started there and abandoned
    // deletes the workers' live auth.json (2026-09-22). A later switch moves it in.
    const home = `${reg.configDirRoot}/${row.slug}`;
    return {
      slug: row.slug, status: "needs-login" as const, email: row.email, plan: "", source: "", limit_reached: false,
      // codex refuses a CODEX_HOME that does not exist yet, so the hint creates it first.
      fetched_at: null, stale: true, windows: [], login: `mkdir -p ${home} && CODEX_HOME=${home} codex login --device-auth`,
    };
  });
  return { accounts };
}

export function buildCodex(cachePath: string, now = Date.now()) {
  if (!existsSync(cachePath)) return { accounts: [] };
  let c: CodexCache;
  try { c = JSON.parse(readFileSync(cachePath, "utf8")) as CodexCache; } catch { return { accounts: [] }; }
  if (!c || !Array.isArray(c.windows)) return { accounts: [] };
  const nowSec = Math.floor(now / 1000);
  const iso = (sec: number) => (sec > 0 ? new Date(sec * 1000).toISOString() : null);
  return {
    accounts: [{
      email: c.email || "", plan: c.plan || "", source: c.source, limit_reached: c.limit_reached === true,
      fetched_at: iso(c.fetched_at),
      resets: c.reset_credits && typeof c.reset_credits.available === "number"
        ? { available: c.reset_credits.available, applicable: asNumber(c.reset_credits.applicable) } : null,
      stale: !(now - c.fetched_at * 1000 < 2 * ACCOUNTS_POLL_MS),
      // Same clamp as the statusline: a window whose reset has passed reads 0, never its old value.
      windows: c.windows.map((w) => ({
        label: w.label, pct: w.reset_at > 0 && w.reset_at <= nowSec ? 0 : asNumber(w.pct), resets_at: iso(w.reset_at),
      })),
    }],
  };
}

async function codexCachePath(): Promise<string> {
  return (await import("../../TOOLS/CodexUsage.ts")).cachePath();
}

export function buildSummary(accounts: any = buildAccounts()) {
  const cost = lastLine<any>(ANTHROPIC_COST);
  const days = readDaily();
  const today = daysAgo(0);
  const weekCut = daysAgo(7);
  const monthCut = daysAgo(30);
  // The gauges follow the ACTIVE account's live row when the per-account state has one;
  // the CostTracker ledger is the fallback (it lags a /login by up to a poll cycle).
  const active = activeRow(accounts);
  return {
    ts: active?.fetched_at ?? cost?.ts ?? null,
    subscription: {
      fiveHourPct: active?.five_hour?.pct ?? cost?.subscription?.five_hour_pct ?? null,
      sevenDayPct: active?.seven_day?.pct ?? cost?.subscription?.seven_day_pct ?? null,
    },
    monthUsedUsd: cost?.api_spend?.month_used_usd ?? null,
    monthUsedSource: cost?.api_spend?.source ?? null,
    today: round2(sumDays(days.filter((d) => d.date === today))),
    week: round2(sumDays(days.filter((d) => d.date >= weekCut))),
    month: round2(sumDays(days.filter((d) => d.date >= monthCut))),
    hasDaily: days.length > 0,
    daysTracked: days.length,
  };
}

function buildTrend(range: string) {
  const days = readDaily();
  if (range === "monthly") {
    const buckets = new Map<string, Totals>();
    for (const d of days) {
      const k = d.date.slice(0, 7); // YYYY-MM
      const b = buckets.get(k) ?? { ...ZERO };
      b.totalTokens += d.totalTokens || 0; b.costUsd += d.costUsd || 0; b.messages += d.messages || 0;
      buckets.set(k, b);
    }
    const points = [...buckets.entries()].sort().slice(-12).map(([label, t]) => ({ label, ...round2(t) }));
    return { range, points };
  }
  if (range === "weekly") {
    const buckets = new Map<string, Totals>();
    for (const d of days) {
      const k = isoWeek(d.date);
      const b = buckets.get(k) ?? { ...ZERO };
      b.totalTokens += d.totalTokens || 0; b.costUsd += d.costUsd || 0; b.messages += d.messages || 0;
      buckets.set(k, b);
    }
    const points = [...buckets.entries()].sort().slice(-12).map(([label, t]) => ({ label, ...round2(t) }));
    return { range, points };
  }
  // daily — last 30 days present in the store
  const points = days.slice(-30).map((d) => ({
    label: d.date,
    totalTokens: d.totalTokens || 0,
    costUsd: Math.round((d.costUsd || 0) * 100) / 100,
    messages: d.messages || 0,
  }));
  return { range: "daily", points };
}

function buildModels(windowArg: string) {
  const days = readDaily();
  const scoped = windowArg === "all" ? days : days.filter((d) => d.date >= daysAgo(30));
  const agg = new Map<string, ModelAgg>();
  for (const d of scoped) {
    for (const [model, m] of Object.entries(d.models || {})) {
      const cur = agg.get(model) ?? { messages: 0, totalTokens: 0, costUsd: 0 };
      cur.messages += m.messages || 0;
      cur.totalTokens += m.totalTokens || 0;
      cur.costUsd += m.costUsd || 0;
      agg.set(model, cur);
    }
  }
  const totalMsgs = [...agg.values()].reduce((s, m) => s + m.messages, 0) || 1;
  const models = [...agg.entries()]
    .map(([model, m]) => ({
      model,
      messages: m.messages,
      totalTokens: m.totalTokens,
      costUsd: Math.round(m.costUsd * 100) / 100,
      pct: Math.round((m.messages / totalMsgs) * 1000) / 10,
    }))
    .sort((a, b) => b.messages - a.messages);
  return { window: windowArg === "all" ? "all" : "30d", models };
}

// ── Module contract ──────────────────────────────────────────────────────────

export async function start(): Promise<void> {
  state.running = true;
  void pollAccounts();
  void pollCodex();
  accountsTimer = setInterval(async () => {
    await pollAccounts();
    await pollCodex();
    await afterAccountsPoll();
  }, ACCOUNTS_POLL_MS);
  console.log(`[${MODULE_NAME}] started`);
}
export async function stop(): Promise<void> {
  state.running = false;
  if (accountsTimer) { clearInterval(accountsTimer); accountsTimer = null; }
}
export function health(): { status: string; details?: Record<string, unknown> } {
  return { status: state.running ? "healthy" : "stopped", details: { hasDaily: existsSync(USAGE_DAILY) } };
}
export async function handleRequest(req: Request, pathname: string): Promise<Response | null> {
  const url = new URL(req.url);
  const sub = pathname.replace(/^\/api\/usage/, "") || "/";
  try {
    if (sub === "/" || sub === "/summary") return Response.json(buildSummary());
    if (sub === "/trend") return Response.json(buildTrend(url.searchParams.get("range") || "daily"));
    if (sub === "/models") return Response.json(buildModels(url.searchParams.get("window") || "30"));
    if (sub === "/overage") return Response.json(buildOverageSummary());
    if (sub === "/accounts") return Response.json(await buildAccountsWithLogin());
    if (sub === "/codex") return Response.json(buildCodexAll(await codexCachePath(), codexRegistry()));
    if (sub === "/status" || sub === "/health") return Response.json(health());
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 });
  }
  return null;
}
