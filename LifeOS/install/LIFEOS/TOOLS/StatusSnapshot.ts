#!/usr/bin/env bun
/**
 * StatusSnapshot.ts — what the LifeOSHooks status display needs that the mod API does not carry.
 *
 * The plugin draws context and the 5H/WK windows from `session.measure`; everything else comes
 * from here, through the HookBridge `status-snapshot` verb: per-model weekly windows (FB), the
 * Codex week, overage, the session's model mix, the 🧠/🩺 lines, and the Env row. Files only, no
 * network: the caches it reads are the ones the statusline-refresh workflow keeps, so the
 * statusline and the plugin's hint tail show the same figures (mods redesign § 2.5, slice 4; Decision 2026-10-11).
 *
 *   bun StatusSnapshot.ts <session-id> [--full]
 *
 * Without --full: usage, codex, overage, memory, credits, tz (cheap, read every turn by the plugin).
 * With --full: adds models (ModelMix), env (location, weather, tide, a quote), the version and the status panel.
 * The pool and transport fields come from this install's private extension (LIFEOS/STATUSLINE/Private.ts); without
 * one, pool is null and transport is "direct" or "proxy".
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { getLifeosDir } from "./Paths";
import { readSurfaceLines } from "../../hooks/lib/function-hooks";
import { computeMix, RUNG_TIER } from "./ModelMix";
import { summary as overageSummary } from "./Overage";
import { overage5h, type Est5h } from "./UsageOverage";
import { planLabel } from "./CodexUsage";
import { privateExtension } from "../STATUSLINE/Private";
import { principalTimezone } from "./lib/Timezone";

export interface Window { label: string; pct: number; resetsAt: string | null }

export interface StatusSnapshot {
  ok: true;
  usage: Window[];
  /** The private extension's multi-login usage snapshot; null without the extension or its state. */
  pool: object | null;
  /** How this Claude Code process reaches the models: "direct", "proxy" for a non-Anthropic base URL, or the extension's own label. */
  transport: string;
  codex: Window[];
  codexPlan: string | null;
  overage: { spentUsd: number; ceilingUsd: number; armed: boolean } | null;
  /** The month's usage credits, in dollars; null when they are off. Cheap, so the hint line has it every turn. */
  credits: StatusPanel["credits"];
  /** How far past the capped 5H window, estimated from credits burned since the cap (UsageOverage.ts); null below the cap. */
  est5h: Est5h | null;
  memory: string | null;
  health: string | null;
  /** ISC-140: the principal's IANA timezone (follows his location); reset times are drawn in it. Cheap, so every read has it. */
  tz: string | null;
  models?: Array<{ label: string; pct: number }>;
  env?: { place: string | null; weather: string | null; tide: string | null; quote: string | null };
  version?: string | null;
  /** The rest of the bash statusline (--full only; its one drawn reader, /board, is gone). */
  status?: StatusPanel;
}

/** What the statusline shows that the other tabs do not: who, how you are, what to do next, money, accounts. */
export interface StatusPanel {
  session: string | null;
  /** MOOD and ENERGY from the State journal; age is null while the value is fresh. */
  state: Array<{ label: string; value: number | null; age: string | null }>;
  /** The one thing that most needs doing, in the statusline's order. */
  action: { text: string; tone: "bad" | "warn" | "info" } | null;
  alerts: string[];
  credits: { usedUsd: number; limitUsd: number; pct: number } | null;
  /** ccSlug: the private extension's active account, so one email on two orgs names the right one; null without it. */
  accounts: { cc: string | null; ccSlug: string | null; co: string | null };
}

export function cacheDir(): string {
  return join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "lifeos-statusline");
}

function readJson(p: string): unknown {
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; }
}
function readText(p: string): string | null {
  try { const t = readFileSync(p, "utf8").trim(); return t || null; } catch { return null; }
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** The Claude usage cache (`usage.json`, written by the statusline's OAuth fetcher) as labelled windows. */
export function usageWindows(raw: unknown): Window[] {
  const u = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const out: Window[] = [];
  const limits = Array.isArray(u.limits) ? (u.limits as Array<Record<string, unknown>>) : [];
  if (limits.length > 0) {
    for (const l of limits) {
      const pct = num(l.percent);
      if (pct === null) continue;
      const resetsAt = typeof l.resets_at === "string" ? l.resets_at : null;
      const scoped = (l.scope as { model?: { display_name?: unknown } } | null)?.model?.display_name;
      let label: string;
      if (l.kind === "session") label = "5H";
      else if (l.kind === "weekly_all") label = "WK";
      else if (typeof scoped === "string" && scoped) label = scoped.toLowerCase() === "fable" ? "FB" : scoped.slice(0, 2).toUpperCase();
      else continue;
      out.push({ label, pct, resetsAt });
    }
    return out;
  }
  // Older cache shape: five_hour / seven_day objects carrying utilization.
  for (const [key, label] of [["five_hour", "5H"], ["seven_day", "WK"], ["seven_day_opus", "OP"], ["seven_day_sonnet", "SO"]] as const) {
    const w = u[key] as Record<string, unknown> | null | undefined;
    const pct = num(w?.utilization);
    if (pct !== null) out.push({ label, pct, resetsAt: typeof w?.resets_at === "string" ? w.resets_at : null });
  }
  return out;
}

/** The Codex usage cache (`codex-usage.json`, CodexUsage.ts) as labelled windows. */
export function codexWindows(raw: unknown): { windows: Window[]; plan: string | null } {
  const c = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const windows: Window[] = [];
  for (const w of Array.isArray(c.windows) ? (c.windows as Array<Record<string, unknown>>) : []) {
    const pct = num(w.pct);
    const at = num(w.reset_at);
    if (pct === null || typeof w.label !== "string") continue;
    windows.push({ label: w.label, pct, resetsAt: at !== null ? new Date(at * 1000).toISOString() : null });
  }
  return { windows, plan: typeof c.plan === "string" ? c.plan : null };
}

/** "proxy" when the process carries a base URL other than the official API host, else "direct". */
export function genericTransport(baseUrl: string | null | undefined): string {
  const u = (baseUrl ?? "").trim();
  if (!u) return "direct";
  try { if (new URL(u).hostname === "api.anthropic.com") return "direct"; } catch { /* an odd value is still a base URL someone set */ }
  return "proxy";
}

function pickQuote(lifeosDir: string, now = Date.now()): string | null {
  const t = readText(join(lifeosDir, "USER", "PRINCIPAL", "Quotes.txt"));
  if (!t) return null;
  const lines = t.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return null;
  // One quote per 10 minutes, the same for every reader in that window.
  const [text, who] = lines[Math.floor(now / 600_000) % lines.length].split("|");
  return who ? `"${text.trim()}" — ${who.trim()}` : `"${text.trim()}"`;
}

const ageLabel = (h: number): string => (h < 48 ? `${Math.round(h)}h` : `${Math.floor(h / 24)}d`);
const hoursSince = (ts: unknown, now: number): number | null => {
  if (typeof ts !== "string") return null;
  const t = Date.parse(ts);
  return Number.isNaN(t) ? null : (now - t) / 3_600_000;
};

/**
 * The statusline's STATE line and its next action, ported from LIFEOS_StatusLine.sh § STATE AREA:
 * MOOD and ENRG with an age once not fresh; the action is the first of memory-health critical,
 * overdue issues, interview due, unlogged or stale state, workout, walk, memory-health warn, BLE.
 */
export function statePanel(lifeosDir: string, now = Date.now()): Pick<StatusPanel, "state" | "action"> {
  type Dim = { value?: number | null; ts?: string } | null;
  const cur = readJson(join(lifeosDir, "USER", "STATE", "current.json")) as { dims?: Record<string, Dim>; windows?: Record<string, { fresh?: number; stale?: number; target?: number }> } | null;
  const state: StatusPanel["state"] = [];
  const toLog: string[] = [];
  let workout = false;
  let walk = false;
  if (cur) {
    for (const [d, label, plain] of [["M", "MOOD", "mood"], ["E", "ENERGY", "energy"]] as const) {
      const e = cur.dims?.[d] ?? null;
      const h = hoursSince(e?.ts, now);
      const w = cur.windows?.[d] ?? {};
      const value = typeof e?.value === "number" ? e.value : null;
      const tier = value === null || h === null ? "unset" : h <= (w.fresh ?? 24) ? "fresh" : h <= (w.stale ?? 72) ? "aging" : "stale";
      if (tier === "unset" || tier === "stale") toLog.push(plain);
      state.push({ label, value, age: tier === "fresh" || h === null ? null : ageLabel(h) });
    }
    for (const d of ["W", "K"] as const) {
      const h = hoursSince(cur.dims?.[d]?.ts, now);
      const target = cur.windows?.[d]?.target ?? (d === "K" ? 1 : 2);
      const due = h === null || Math.floor(h / 24) > target;
      if (d === "W") workout = due; else walk = due;
    }
  }
  let critical: string | null = null;
  let warn: string | null = null;
  try {
    const lines = readFileSync(join(lifeosDir, "MEMORY", "OBSERVABILITY", "memory-health.jsonl"), "utf8").trim().split("\n");
    const acts = (JSON.parse(lines[lines.length - 1] ?? "{}").actions ?? []) as Array<{ text?: string; severity?: string }>;
    for (const a of acts) {
      if (!a.text) continue;
      if (a.severity === "critical") critical ??= a.text; else warn ??= a.text;
    }
  } catch { /* no health log */ }
  const wa = readJson(join(lifeosDir, "MEMORY", "STATE", "work-attention.json")) as { updated?: string; overdue?: unknown[]; ble?: { overdue?: boolean; reason?: string } } | null;
  const waFresh = wa && (hoursSince(wa.updated, now) ?? Infinity) <= 72;
  const overdue = waFresh ? (wa!.overdue ?? []).length : 0;
  const interview = (readJson(join(lifeosDir, "USER", "CACHE", "interview-due.json")) as { due?: boolean } | null)?.due === true;
  const action: StatusPanel["action"] =
    critical ? { text: critical, tone: "bad" }
    : overdue > 0 ? { text: `${overdue} issues overdue`, tone: "warn" }
    : interview ? { text: "Interview due", tone: "warn" }
    : toLog.length > 0 ? { text: `Log ${toLog.join(", ")}`, tone: "info" }
    : workout ? { text: "Workout due", tone: "info" }
    : walk ? { text: "Walk due", tone: "info" }
    : warn ? { text: warn, tone: "warn" }
    : waFresh && wa!.ble?.overdue ? { text: `BLE pass due: ${wa!.ble.reason ?? "due"}`, tone: "warn" }
    : null;
  return { state, action };
}

/** The Anthropic extra-usage credits from the usage cache, in dollars; null when they are off. */
export function creditsOf(raw: unknown): StatusPanel["credits"] {
  const x = ((raw && typeof raw === "object" ? raw : {}) as { extra_usage?: { is_enabled?: boolean; monthly_limit?: unknown; used_credits?: unknown } }).extra_usage;
  if (!x?.is_enabled) return null;
  const limit = num(x.monthly_limit) ?? 0;
  const used = num(x.used_credits) ?? 0;
  return { usedUsd: used / 100, limitUsd: limit / 100, pct: limit > 0 ? (used / limit) * 100 : 0 };
}

function statusPanel(sessionId: string, dir: string, lifeosDir: string): StatusPanel {
  const names = readJson(join(lifeosDir, "MEMORY", "STATE", "session-names.json")) as Record<string, unknown> | null;
  const session = sessionId && typeof names?.[sessionId] === "string" ? (names[sessionId] as string) : null;
  const doctor = readText(join(lifeosDir, "MEMORY", "STATE", "capabilities-statusline.txt"));
  const ext = privateExtension();
  const cc = (readJson(join(homedir(), ".claude.json")) as { oauthAccount?: { emailAddress?: string } } | null)?.oauthAccount?.emailAddress ?? null;
  const co = (readJson(join(dir, "codex-usage.json")) as { email?: string } | null)?.email || null;
  return {
    session,
    ...statePanel(lifeosDir),
    alerts: doctor ? [doctor.replace(/^⚠\s*/, "")] : [],
    credits: creditsOf(readJson(join(dir, "usage.json"))),
    accounts: { cc, ccSlug: ext ? ext.activeAccountSlug(lifeosDir, Date.now()) : null, co },
  };
}

export interface SnapshotOpts {
  /** The Claude Code process's ANTHROPIC_BASE_URL: undefined reads this process's own, null or "" means none. */
  baseUrl?: string | null;
  now?: number;
}

export function snapshot(sessionId: string, full: boolean, dir = cacheDir(), lifeosDir = getLifeosDir(), projectsRoot?: string, opts: SnapshotOpts = {}): StatusSnapshot {
  const now = opts.now ?? Date.now();
  const ext = privateExtension();
  const baseUrl = opts.baseUrl === undefined ? process.env.ANTHROPIC_BASE_URL : opts.baseUrl;
  const transport = ext ? ext.transportOf(baseUrl) : genericTransport(baseUrl);
  let pool: object | null = null;
  // The extension loaded above with no catch; only its reading of state files may fail without stopping the rest.
  if (ext) { try { pool = ext.accountsSnapshot(lifeosDir, dir, now); } catch { /* the rest still draws */ } }
  const codex = codexWindows(readJson(join(dir, "codex-usage.json")));
  const usageRaw = readJson(join(dir, "usage.json"));
  let est5h: Est5h | null = null;
  try { est5h = overage5h(usageRaw, { dir, projectsRoot }); } catch { /* the rest still draws */ }
  let overage: StatusSnapshot["overage"] = null;
  try {
    const o = overageSummary() as unknown as { spentUsd?: number; ceilingUsd?: number; armed?: { armed?: boolean } };
    overage = { spentUsd: o.spentUsd ?? 0, ceilingUsd: o.ceilingUsd ?? 0, armed: o.armed?.armed === true };
  } catch { /* no ledger */ }
  const surf = sessionId ? readSurfaceLines(sessionId) : {};
  let tz: string | null = null;
  try { tz = principalTimezone(); } catch { /* the plugin falls back to the machine's zone */ }
  const snap: StatusSnapshot = {
    ok: true,
    usage: usageWindows(usageRaw),
    pool,
    transport,
    codex: codex.windows,
    codexPlan: planLabel(codex.plan),
    overage,
    credits: creditsOf(usageRaw),
    est5h,
    memory: surf.memory ?? null,
    health: surf.health ?? null,
    tz,
  };
  if (!full) return snap;
  try {
    const mix = computeMix(sessionId);
    const models: Array<{ label: string; pct: number }> = [];
    const byLabel = new Map<string, number>();
    for (const level of ["max", "high", "medium", "low"] as const) {
      const label = String(RUNG_TIER[level]).toUpperCase();
      byLabel.set(label, (byLabel.get(label) ?? 0) + (mix.pct[level] ?? 0));
    }
    for (const [label, pct] of byLabel) models.push({ label, pct });
    for (const lane of ["astra", "sol"] as const) models.push({ label: lane.toUpperCase(), pct: mix.lanePct[lane] ?? 0 });
    snap.models = models;
  } catch { snap.models = []; }
  const loc = readJson(join(dir, "location-cache.json")) as { city?: string; region?: string } | null;
  snap.env = {
    place: loc?.city ? `${loc.city}${loc.region ? `, ${loc.region}` : ""}` : null,
    weather: readText(join(dir, "weather-cache.json")),
    tide: readText(join(dir, "tide-line.txt")),
    quote: pickQuote(lifeosDir),
  };
  snap.version = readText(join(lifeosDir, "VERSION"));
  try { snap.status = statusPanel(sessionId, dir, lifeosDir); } catch { /* the other tabs still draw */ }
  return snap;
}

if (import.meta.main) {
  const sid = (process.argv[2] ?? "").replace(/[^A-Za-z0-9_-]/g, "");
  const baseArg = process.argv.find((a) => a.startsWith("--base-url="));
  console.log(JSON.stringify(snapshot(sid, process.argv.includes("--full"), undefined, undefined, undefined, baseArg === undefined ? {} : { baseUrl: baseArg.slice("--base-url=".length) })));
}

