#!/usr/bin/env bun
/**
 * FableBudget.ts — how much Fable the router may spend right now (Router ISA F9, R134).
 *
 * Fable is the top model and its window runs out fast, so the router spends it gently. This reads the usage poll of the
 * user's own subscriptions, to budget the user's own Fable allowance, and returns one status:
 *
 *   out      no polled subscription is under THRESHOLD_PCT on its 5-hour, weekly and Fable windows
 *   low      the best weekly Fable room on any polled subscription is under FLOOR_PCT
 *   ahead    every account with at least FLOOR_PCT room has spent more Fable than an even pace through its window
 *            plus CUSHION_PCT
 *   unknown  no poll, or a poll older than STALE_MS
 *   open     otherwise: the only status at which the router picks Fable by itself
 *
 * It counts only subscriptions the user owns and pays for, used within each provider's terms, and reads their usage only to
 * budget the user's own work; it never shares, lends or resells a seat, and one subscription works the same.
 *
 * Pure apart from the two file reads in `readFableBudget`, so the tests drive `fableBudget` directly. This file keeps the
 * router from picking Fable when no account has room for it, and tells the route line why.
 *
 * Usage: bun LIFEOS/ROUTER/FableBudget.ts [--json]
 */
import { existsSync, readFileSync } from "node:fs";
import { lifeosPath } from "../TOOLS/Paths";

export type FableStatus = "open" | "ahead" | "low" | "out" | "unknown";
export interface FableAccount { slug: string; room: number; fableUsed: number | null; pace: number | null; onPace: boolean; hasRoom: boolean }
export interface FableBudget { status: FableStatus; room: number | null; accounts: FableAccount[]; fetchedAt: string | null }

/** The code-default usage threshold at which an account counts as spent; the live value comes from the install's switch settings (switchThreshold). */
export const THRESHOLD_PCT = 99;
/** Under this much weekly Fable room on the best account, the router stops picking Fable. */
export const FLOOR_PCT = 10;
/** How far ahead of an even pace an account may spend Fable before it counts as ahead. */
export const CUSHION_PCT = 10;
/** A poll older than this says nothing about now; the usage poll runs every few minutes. */
export const STALE_MS = 30 * 60_000;
const WEEK_MS = 7 * 24 * 3_600_000;

type Win = { pct?: number | null; resets_at?: string | null } | null | undefined;
type PollRow = { slug?: string; status?: string; five_hour?: Win; seven_day?: Win; windows?: Array<{ name?: string } & NonNullable<Win>>; extra?: { enabled?: boolean } | null };
export interface Poll { fetched_at?: string; accounts?: PollRow[] }
export interface Registry { accounts?: Array<{ slug?: string; org?: string; pool?: boolean }> }

const pct = (w: Win): number | null => (typeof w?.pct === "number" && Number.isFinite(w.pct) ? w.pct : null);

/** The subscriptions the budget counts: every registry row that is not a team seat and not marked `pool: false`. */
export function pooledSlugs(reg: Registry | null): Set<string> | null {
  if (!reg?.accounts) return null;
  return new Set(reg.accounts.filter((a) => a.slug && a.org !== "team" && a.pool !== false).map((a) => a.slug!));
}

export interface SwitchSettings { rules?: { threshold?: unknown }; temporary?: Array<{ until?: unknown; rules?: { threshold?: unknown } }> }
const validThreshold = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0 && v <= 100;
/** The switch threshold, layered the way the switch settings are: the code default, then `rules`, then each
 *  temporary entry still before its `until`, later over earlier. A bad value keeps the layer below. */
export function switchThreshold(settings: SwitchSettings | null, now: number = Date.now()): number {
  let t = THRESHOLD_PCT;
  if (validThreshold(settings?.rules?.threshold)) t = settings!.rules!.threshold as number;
  for (const e of settings?.temporary ?? []) {
    const until = typeof e?.until === "string" ? Date.parse(e.until) : NaN;
    if (Number.isFinite(until) && until > now && validThreshold(e.rules?.threshold)) t = e.rules!.threshold as number;
  }
  return t;
}

export function fableBudget(poll: Poll | null, reg: Registry | null, now: number = Date.now(), threshold: number = THRESHOLD_PCT): FableBudget {
  const fetchedAt = poll?.fetched_at ?? null;
  const at = fetchedAt ? Date.parse(fetchedAt) : NaN;
  if (!poll?.accounts || !Number.isFinite(at) || now - at > STALE_MS) return { status: "unknown", room: null, accounts: [], fetchedAt };
  const pooled = pooledSlugs(reg);
  const accounts: FableAccount[] = [];
  const seen = new Set<string>();
  for (const r of poll.accounts) {
    if (!r.slug || r.status !== "ok" || (pooled && !pooled.has(r.slug)) || seen.has(r.slug)) continue;
    seen.add(r.slug);
    const fw = r.windows?.find((w) => /fable/i.test(w.name ?? ""));
    const five = pct(r.five_hour), week = pct(r.seven_day), fable = pct(fw);
    // An unread window counts as empty only on an account known not to bill extra usage, the way the switcher reads it.
    const safe = !!r.extra && !r.extra.enabled; // overage reads as Boolean(extra.enabled)
    const known = [five, week, fable].every((p) => p !== null) || safe;
    const hasRoom = known && [five, week, fable].every((p) => (p ?? 0) < threshold);
    const room = Math.max(0, 100 - Math.max(week ?? 0, fable ?? 0));
    const reset = fw?.resets_at ? Date.parse(fw.resets_at) : NaN;
    const pace = Number.isFinite(reset) ? Math.round(Math.min(1, Math.max(0, 1 - (reset - now) / WEEK_MS)) * 100) : null;
    const onPace = fable === null || pace === null ? hasRoom : fable <= pace + CUSHION_PCT;
    accounts.push({ slug: r.slug, room, fableUsed: fable, pace, onPace, hasRoom });
  }
  const open = accounts.filter((a) => a.hasRoom);
  if (open.length === 0) return { status: "out", room: 0, accounts, fetchedAt };
  const room = Math.max(...open.map((a) => a.room));
  if (room < FLOOR_PCT) return { status: "low", room, accounts, fetchedAt };
  if (!open.some((a) => a.room >= FLOOR_PCT && a.onPace)) return { status: "ahead", room, accounts, fetchedAt };
  return { status: "open", room, accounts, fetchedAt };
}

function readJson<T>(path: string): T | null {
  try { return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : null; } catch { return null; }
}

/** The live budget, from the usage poll and the account registry. Never throws: an unreadable poll is `unknown`. */
export function readFableBudget(env: NodeJS.ProcessEnv = process.env, now: number = Date.now()): FableBudget {
  const poll = readJson<Poll>(env.LIFEOS_ACCOUNTS_FILE || lifeosPath("MEMORY", "OBSERVABILITY", "accounts-usage.json"));
  const reg = readJson<Registry>(env.LIFEOS_ACCOUNT_REGISTRY || lifeosPath("USER", "CONFIG", "anthropic-accounts.json"));
  const settings = readJson<SwitchSettings>(env.LIFEOS_SWITCH_SETTINGS_FILE || lifeosPath("USER", "CONFIG", "switch-settings.json"));
  return fableBudget(poll, reg, now, switchThreshold(settings, now));
}

export function formatFableBudget(b: FableBudget): string {
  const head = `Fable budget: ${b.status}${b.room !== null ? ` · best weekly room ${b.room}%` : ""}${b.fetchedAt ? ` · poll ${b.fetchedAt}` : ""}`;
  const rows = b.accounts.map((a) => `  ${a.slug.padEnd(8)} room ${String(a.room).padStart(3)}%  fable used ${a.fableUsed ?? "--"}%  pace ${a.pace ?? "--"}%  ${a.hasRoom ? (a.onPace ? "on pace" : "ahead of pace") : "no room"}`);
  return [head, ...rows].join("\n");
}

if (import.meta.main) {
  const b = readFableBudget();
  console.log(process.argv.includes("--json") ? JSON.stringify(b, null, 2) : formatFableBudget(b));
}
