#!/usr/bin/env bun
/**
 * StatusLineMoney — the money row on the bash status line: whether this session is costing anything beyond the
 * subscriptions, and every other way money leaves this month.
 *
 * The principal, 2026-10-09: every way of spending beyond the subscriptions (extra credits, API costs and the rest)
 * is shown, on its own line with more detail, and a session that is on subscriptions says so.
 *
 * The row draws only as an alert, when something costs money beyond the subscriptions (2026-10-17): this session
 * paying or locked, extra-usage credits used this month, the emergency API lane spent or armed, or Anthropic API key
 * spend. A plain subscription month draws no row. It opens on the state, on a coloured band:
 *   Extra spend this month  this session is on subscription but the month has credits, lane or API-key spend (orange)
 *   Paying · <source>    an Anthropic API key, extra-usage credits on the account it runs on, or the armed
 *                        emergency API lane (orange band)
 *   Locked · <window>    a window is capped and no credits can absorb it (red band)
 * then "<Mon>:", one entry per source, all on one row (2026-10-11). A source at $0 and
 * switched off is left out:
 *   OpenAI               this month's real OpenAI bill so far, org-wide, from the Costs API reading CostTracker writes
 *                        to openai-cost.json. Left out when there is no reading.
 *   <Mon> invoice        last month's real OpenAI invoice from vendor-costs.jsonl.
 *   API key              month-to-date Anthropic API spend from the admin-key reading in anthropic-cost.jsonl
 *   Credits              Claude extra usage summed over the subscription accounts, and which have it on
 *   API lane             the emergency overage lane's month against its cap, and whether it is armed
 *   Google               this month's floor from Google Cloud budget alerts (the highest threshold crossed) and last
 *                        month's Google Cloud payments, both written by the CFO pull (budget-floors.json, vendor-costs.jsonl)
 *
 *   bun LIFEOS/TOOLS/StatusLineMoney.ts row --cols N [--session ID] [--session-cost USD] [--billing SUB|CREDITS|LOCKED|CAPPED --capped 5H] [--plain]
 *
 * Reads local files only, never the network.
 */
import { closeSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { lifeosPath } from "./Paths.ts";
import { invariant } from "./Invariant.ts";
import { monthKey } from "./Overage.ts";
import { pictographCells as cellWidth } from "../STATUSLINE/Width.ts";
import { privateExtension } from "../STATUSLINE/Private.ts";
import { obfuscation } from "./Obfuscate.ts";

// ── Sources ────────────────────────────────────────────────────────────────

/**
 * OpenAI's own month-to-date bill for the whole organization, every key and project, as the Costs API reports it.
 * CostTracker's hourly `log` writes it to openai-cost.json with OPENAI_ADMIN_API_KEY; `usd` is null when that
 * reading failed, and `reason` says why (2026-10-11: the
 * OpenAI bill and amount owed must always be visible).
 */
/** `estimateUsd` is our own estimate (OpenAiSpendEstimate.ts), present only when the real bill could not be read. */
export interface OpenAiBill { month: string; usd: number | null; reason: string | null; estimateUsd?: number | null }

/** This month's OpenAI bill from openai-cost.json; a reading from another month counts as no reading. */
export function openAiBill(path: string, month: string): OpenAiBill | null {
  let r: { month?: unknown; usd?: unknown; reason?: unknown; estimate_usd?: unknown };
  try { r = JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
  if (r.month !== month) return { month, usd: null, reason: "no reading this month" };
  const usd = typeof r.usd === "number" && Number.isFinite(r.usd) && r.usd >= 0 ? r.usd : null;
  const est = usd === null && typeof r.estimate_usd === "number" && Number.isFinite(r.estimate_usd) && r.estimate_usd >= 0 ? r.estimate_usd : null;
  return { month, usd, reason: usd === null ? (typeof r.reason === "string" ? r.reason : "unreadable") : null, ...(est !== null ? { estimateUsd: est } : {}) };
}

/** The last admin-key reading of Anthropic API spend this month, from the tail of anthropic-cost.jsonl. */
export function anthropicApiMonth(path: string, month: string): number | null {
  try {
    const st = statSync(path);
    const len = Math.min(st.size, 64 * 1024);
    const fd = openSync(path, "r");
    const buf = Buffer.alloc(len);
    try { readSync(fd, buf, 0, len, st.size - len); } finally { closeSync(fd); }
    const lines = buf.toString("utf8").trim().split("\n").reverse();
    for (const l of lines) {
      try {
        const r = JSON.parse(l) as { ts?: string; api_spend?: { month_used_usd?: unknown } };
        if (typeof r.ts !== "string") continue;
        if (!r.ts.startsWith(month)) return 0;
        const v = r.api_spend?.month_used_usd;
        return typeof v === "number" && Number.isFinite(v) ? v : null;
      } catch { /* partial first line of the window */ }
    }
  } catch { /* no ledger */ }
  return null;
}

/** This month's spend floor for `vendor` from budget-floors.json; null when there is none for this month. */
export function budgetFloor(path: string, vendor: string, month: string): number | null {
  try {
    const r = JSON.parse(readFileSync(path, "utf8")) as { floors?: { vendor?: unknown; month?: unknown; floor_usd?: unknown }[] };
    const f = (r.floors ?? []).find((x) => x.vendor === vendor && x.month === month);
    return f && typeof f.floor_usd === "number" && Number.isFinite(f.floor_usd) && f.floor_usd >= 0 ? f.floor_usd : null;
  } catch { return null; }
}

/** Google Cloud as the pool block's AN row reads it: this month's alert floor and the percent of budget it crossed,
 *  the monthly budget (from any month's alert, so it is known before this month crosses one), and the last bill. */
export interface GoogleSpend { month: string; floorUsd: number | null; pct: number | null; budgetUsd: number | null; bill: { month: string; usd: number } | null }

export function googleSpend(budgetFloors: string, vendorCosts: string, month: string): GoogleSpend | null {
  let rows: { vendor?: unknown; month?: unknown; floor_usd?: unknown; pct?: unknown; budget_usd?: unknown }[] = [];
  try { rows = (JSON.parse(readFileSync(budgetFloors, "utf8")) as { floors?: typeof rows }).floors ?? []; } catch { /* no floors */ }
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
  const google = rows.filter((r) => r && r.vendor === "google" && typeof r.month === "string");
  const now = google.find((r) => r.month === month);
  const budgeted = google.filter((r) => num(r.budget_usd) !== null).sort((a, b) => String(b.month).localeCompare(String(a.month)))[0];
  const bill = lastBill(vendorCosts, "google", month);
  const out: GoogleSpend = { month, floorUsd: num(now?.floor_usd), pct: num(now?.pct), budgetUsd: num(budgeted?.budget_usd), bill: bill && bill.usd > 0 ? bill : null };
  return out.floorUsd === null && out.bill === null ? null : out;
}

/** The latest month before `month` with an OpenAI invoice in vendor-costs.jsonl. */
export function lastBill(path: string, vendor: string, month: string): { month: string; usd: number } | null {
  let best: { month: string; usd: number } | null = null;
  try {
    for (const l of readFileSync(path, "utf8").split("\n")) {
      if (!l.trim()) continue;
      try {
        const r = JSON.parse(l) as { vendor?: unknown; month?: unknown; cost_usd?: unknown };
        if (r.vendor !== vendor || typeof r.month !== "string" || r.month >= month || typeof r.cost_usd !== "number") continue;
        if (!best || r.month >= best.month) best = { month: r.month, usd: r.cost_usd };
      } catch { /* skip */ }
    }
  } catch { /* no ledger */ }
  return best;
}

// ── Month-source cache (shared by every session's render) ───────────────────
// The three ledger reads above are the same for every session, so one render's answer serves the rest for up to a
// minute. Only data is cached, never rendered text: the head and the wrap point stay per session. Credits and the
// overage group come from files the head reads anyway, so they are never cached and an arm expiry flips on time.

export interface MonthSources {
  openai: OpenAiBill | null; openaiBill: { month: string; usd: number } | null; anthropicApi: number | null;
  googleFloor: number | null; googleBill: { month: string; usd: number } | null;
}
export interface MonthSourcePaths { openaiCost: string; anthropicCost: string; vendorCosts: string; budgetFloors: string }
interface MonthSourceCache extends MonthSources { v: 4; month: string; key: string; expires: number }

export const MONTH_SOURCE_TTL_MS = 60_000;

/** Path, mtime and size of the four ledgers: an append or rewrite misses the cache. */
export function sourceKey(p: MonthSourcePaths): string {
  return [p.openaiCost, p.anthropicCost, p.vendorCosts, p.budgetFloors].map((f) => {
    try { const s = statSync(f); return `${f}:${s.mtimeMs}:${s.size}`; } catch { return `${f}:-`; }
  }).join("|");
}

/** First millisecond of the calendar month after `now`, in UTC, the clock monthKey uses. */
export function nextMonthStart(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

const isMonthUsd = (v: unknown): boolean =>
  v !== null && typeof v === "object" && typeof (v as { month?: unknown }).month === "string" && Number.isFinite((v as { usd?: unknown }).usd);

/** True when a cached value has the shape computeMonthSources returns; anything else is a miss (Astra review, 2026-10-09). */
function validSources(c: Partial<MonthSourceCache>): boolean {
  const o = c.openai as Partial<OpenAiBill> | null | undefined;
  return (o === null || (o !== undefined && typeof o.month === "string" && (o.usd === null || Number.isFinite(o.usd))
      && (o.reason === null || typeof o.reason === "string") && (o.estimateUsd == null || Number.isFinite(o.estimateUsd))))
    && (c.openaiBill === null || isMonthUsd(c.openaiBill))
    && (c.anthropicApi === null || Number.isFinite(c.anthropicApi))
    && (c.googleFloor === null || Number.isFinite(c.googleFloor))
    && (c.googleBill === null || isMonthUsd(c.googleBill));
}

export function computeMonthSources(p: MonthSourcePaths, month: string): MonthSources {
  return {
    openai: openAiBill(p.openaiCost, month),
    openaiBill: lastBill(p.vendorCosts, "openai", month),
    anthropicApi: anthropicApiMonth(p.anthropicCost, month),
    googleFloor: budgetFloor(p.budgetFloors, "google", month),
    googleBill: lastBill(p.vendorCosts, "google", month),
  };
}

/** The month's sources from `cachePath` when it is this month's, unexpired and keyed to the same ledgers; else computed and stored. */
export function monthSources(p: MonthSourcePaths, cachePath: string, month: string, now: number): MonthSources {
  const key = sourceKey(p);
  const c = (() => { try { return JSON.parse(readFileSync(cachePath, "utf8")) as Partial<MonthSourceCache>; } catch { return null; } })();
  if (c && c.v === 4 && c.month === month && c.key === key && typeof c.expires === "number" && now < c.expires
    && "openai" in c && "openaiBill" in c && "anthropicApi" in c && "googleFloor" in c && "googleBill" in c && validSources(c)) {
    return { openai: c.openai ?? null, openaiBill: c.openaiBill ?? null, anthropicApi: c.anthropicApi ?? null, googleFloor: c.googleFloor ?? null, googleBill: c.googleBill ?? null };
  }
  const fresh = computeMonthSources(p, month);
  writeMonthSourceCache(cachePath, { v: 4, month, key, expires: Math.min(now + MONTH_SOURCE_TTL_MS, nextMonthStart(now)), ...fresh });
  return fresh;
}

function writeMonthSourceCache(cachePath: string, c: MonthSourceCache): void {
  invariant(/^\d{4}-\d{2}$/.test(c.month), `money month cache: bad month key ${c.month}`);
  invariant(Number.isFinite(c.expires) && c.expires > 0, `money month cache: bad expiry ${c.expires}`);
  invariant(c.anthropicApi === null || Number.isFinite(c.anthropicApi), "money month cache: non-finite Anthropic API figure");
  invariant(c.googleFloor === null || Number.isFinite(c.googleFloor), "money month cache: non-finite Google floor");
  try {
    mkdirSync(dirname(cachePath), { recursive: true });
    const tmp = `${cachePath}.tmp.${process.pid}`;
    writeFileSync(tmp, JSON.stringify(c), { mode: 0o600 });
    renameSync(tmp, cachePath);
  } catch { /* a read-only cache only costs a recompute next render */ }
}

export interface OverageSummary { month?: unknown; spentUsd?: unknown; ceilingUsd?: unknown; armed?: { armed?: unknown; sessionId?: unknown; expiresAt?: unknown } | null }

// ── Model ──────────────────────────────────────────────────────────────────

export type SessionState = "subs" | "paying" | "locked";
export interface Seg { text: string; color?: string; bold?: boolean }

/** One subscription account as the money row reads it: who, and its extra-usage credits. */
export interface AccountRow { slug?: unknown; email?: unknown; extra?: unknown }

export interface MoneyInput {
  /** "API", "DIRECT", or the private extension's own label. */
  pay: string;
  /** True while obfuscation is on (Obfuscate.ts): accounts are named by slug, never by any part of an email. */
  obfuscate?: boolean;
  sessionId?: string;
  /** This session's total cost from Claude Code's stdin; real money only when it bills an API key. */
  sessionCostUsd?: number | null;
  /** The bash line's billing state for a direct login: CREDITS or LOCKED when a window is capped. */
  billing?: string | null;
  capped?: string | null;
  /** The accounts the private extension knows; empty without one. */
  accounts: AccountRow[];
  served: unknown;
  login: unknown;
  overage: OverageSummary | null;
  anthropicApi: number | null;
  /** This month's OpenAI bill so far; null before CostTracker has written a reading. */
  openai: OpenAiBill | null;
  /** Last month's OpenAI invoice. */
  openaiBill?: { month: string; usd: number } | null;
  /** This month's floor from Google Cloud budget alerts. */
  googleFloor?: number | null;
  /** Last month's Google Cloud payments. */
  googleBill?: { month: string; usd: number } | null;
  month: string;
  now: number;
}

/** `alert`: the row draws only when something costs money beyond the subscriptions, this session or this month
 *  (principal directive, 2026-10-17: no on-subscription line; draw an alert line only for usage credits or other overage). */
export interface MoneyRow { state: SessionState; head: Seg[]; month: Seg[][]; monthLabel: string; alert: boolean }

const C = {
  green: "158;206;106", orange: "255;158;100", red: "247;118;142", yellow: "224;175;104",
  text: "192;202;245", dim: "130;140;180", faint: "86;95;137", purple: "187;154;247",
} as const;

/** Dollars: "$0" for nothing, "<$0.01" under a cent, cents under $100, whole dollars with commas above. */
export function usd(v: number | null | undefined): string {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return "$0";
  if (v < 0.01) return "<$0.01";
  if (v < 100) return `$${v.toFixed(2)}`;
  return `$${Math.round(v).toLocaleString("en-US")}`;
}

const local = (email: unknown, slug: unknown) => (typeof email === "string" && email ? email.split("@")[0] : String(slug));
/** "2026-09" → "Sep" (short) or "September" (long). */
const monthName = (key: string, style: "short" | "long" = "long") =>
  new Date(`${key}-15T00:00:00Z`).toLocaleString("en-US", { month: style, timeZone: "UTC" });
const hhmm = (ms: number) => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };

export function moneyRow(i: MoneyInput): MoneyRow {
  const name = (email: unknown, slug: unknown) => (i.obfuscate ? String(slug) : local(email, slug));
  const ov = i.overage;
  const ovThisMonth = ov && ov.month === i.month;
  const ovSpent = ovThisMonth && typeof ov!.spentUsd === "number" ? ov!.spentUsd : 0;
  const ovCeiling = typeof ov?.ceilingUsd === "number" ? ov.ceilingUsd : null;
  const arm = ov?.armed;
  const armExp = typeof arm?.expiresAt === "number" ? arm.expiresAt * 1000 : 0;
  const armed = arm?.armed === true && (armExp === 0 || armExp > i.now);
  const armedHere = armed && (typeof arm?.sessionId !== "string" || !i.sessionId || arm.sessionId === i.sessionId);

  // The account this session runs on, and whether it is past a window with credits to spend.
  const ext = privateExtension();
  const activeId = ext ? ext.activeSlug(i.pay, i.accounts, i.served, i.sessionId, i.login, i.now) : null;
  const activeRow = i.accounts.find((r) => String(r.slug) === activeId);
  const chip = activeRow && ext ? ext.chipData(activeRow, i.now) : null;
  const ex = (activeRow?.extra ?? null) as { enabled?: unknown; reached?: unknown; used_cents?: unknown; limit_cents?: unknown } | null;
  const creditsOn = ex?.enabled === true && ex.reached !== true;
  const cappedWin = chip && chip.state !== "stale" && chip.state !== "error"
    ? (chip.left5 === 0 ? "5H" : chip.leftWk === 0 ? "Week" : null) : null;

  let state: SessionState = "subs";
  const head: Seg[] = [];
  const S = (text: string, color?: string, bold = false): Seg => ({ text, color, bold });
  if (i.pay === "API") {
    state = "paying";
    head.push(S("⚡ Paying", C.orange, true), S(" · ", C.faint), S("Anthropic API key", C.text),
      S(` · ${usd(i.sessionCostUsd ?? 0)} this session`, C.orange, true));
  } else if (i.billing === "CREDITS" || (i.pay !== "DIRECT" && cappedWin && creditsOn)) {
    state = "paying";
    const win = i.billing === "CREDITS" ? (i.capped ?? "") : cappedWin;
    head.push(S("⚡ Paying", C.orange, true), S(" · ", C.faint), S(`Extra-usage credits on ${name(activeRow?.email, activeId ?? "this login")}`, C.text));
    if (win) head.push(S(` · ${win} capped`, C.dim));
  } else if (i.billing === "LOCKED") {
    state = "locked";
    head.push(S("⛔ Locked", C.red, true), S(" · ", C.faint), S(`${i.capped ?? "A window"} capped, no credits`, C.text));
  }
  if (armedHere) {
    if (state === "subs") { state = "paying"; head.length = 0; head.push(S("⚡ Paying", C.orange, true)); }
    head.push(S(" · ", C.faint), S("Emergency API lane armed", C.orange, true));
    if (armExp) head.push(S(` until ${hhmm(armExp)}`, C.dim));
  }

  // Month to date, one group per source; a group never splits across rows. Inside a group, status sits in
  // parentheses so " · " only ever separates one source from the next. A source at $0 and switched off says
  // nothing and is left out (2026-10-11: the block is one line).
  const month: Seg[][] = [];
  const amt = (v: number, warnAt = 0.005) => S(usd(v), v > warnAt ? C.yellow : C.faint, v > warnAt);
  // OpenAI shows only when OpenAI reported a bill; an unread one says nothing, with no
  // needs-admin-key note (2026-10-12).
  if (i.openai?.usd != null) month.push([S("OpenAI ", C.dim), amt(i.openai.usd)]);
  // With no readable bill, our own estimate shows muted and marked "est." so it never reads as the bill (2026-10-14).
  else if (i.openai?.estimateUsd != null && i.openai.estimateUsd >= 0.01) month.push([S("OpenAI ", C.dim), S(`~${usd(i.openai.estimateUsd)} est.`, C.faint)]);
  if (i.openaiBill && i.openaiBill.usd > 0) month.push([S(`${monthName(i.openaiBill.month, "short")} invoice `, C.dim), S(usd(i.openaiBill.usd), C.orange, true)]);
  if (i.anthropicApi !== null && i.anthropicApi >= 0.01) month.push([S("API key ", C.dim), amt(i.anthropicApi)]);
  // Google Cloud reports no running total, so this month shows the highest budget threshold crossed, as at least that much.
  const gFloor = i.googleFloor != null && i.googleFloor > 0 ? i.googleFloor : null;
  const gBill = i.googleBill && i.googleBill.usd > 0 ? i.googleBill : null;
  if (gFloor !== null || gBill) {
    const g = [S("Google ", C.dim)];
    if (gFloor !== null) g.push(S(`≥${usd(gFloor)}`, C.yellow, true));
    if (gBill) g.push(S(gFloor !== null ? ` (${monthName(gBill.month, "short")} ${usd(gBill.usd)})` : `${monthName(gBill.month, "short")} ${usd(gBill.usd)}`, C.dim));
    month.push(g);
  }
  const extras = i.accounts.map((r) => ({ r, e: (r.extra ?? null) as { enabled?: unknown; used_cents?: unknown; limit_cents?: unknown } | null }));
  const used = extras.reduce((a, { e }) => a + (typeof e?.used_cents === "number" ? e.used_cents : 0), 0) / 100;
  const on = extras.filter(({ e }) => e?.enabled === true).map(({ r }) => name(r.email, r.slug));
  if (used > 0 || on.length > 0) {
    const g = [S("Credits ", C.dim), amt(used)];
    if (on.length > 0) g.push(S(` (on: ${on.join(", ")})`, C.orange));
    month.push(g);
  }
  if (ov && (ovSpent > 0 || armed)) {
    const g = [S("API lane ", C.dim), amt(ovSpent)];
    if (ovCeiling !== null) g.push(S(`/${usd(ovCeiling)}`, C.faint));
    if (armed) g.push(S(" (armed)", C.orange, true));
    month.push(g);
  }
  const apiKey = i.anthropicApi !== null && i.anthropicApi >= 0.01;
  // Under a cent is rounding noise, never an alert.
  const alert = state !== "subs" || used >= 0.01 || ovSpent >= 0.01 || armed || apiKey;
  // This session is on subscription but the month has extra spend: the head names it in place of a session state.
  if (alert && state === "subs") head.push(S("⚠ Extra spend this month", C.orange, true));
  return { state, head, month, monthLabel: `${monthName(i.month, "short")}: `, alert };
}

// ── Render ─────────────────────────────────────────────────────────────────

/** Row bands, Tokyo Night tinted: orange for extra spend or paying, red locked. A drawn row is always an alert, so
 *  a subscription session with extra spend this month takes the orange band. */
const BAND: Record<SessionState, string> = { subs: "66;40;24", paying: "66;40;24", locked: "70;26;36" };

function paintSegs(segs: Seg[], color: boolean, bg: string): string {
  if (!color) return segs.map((s) => s.text).join("");
  const B = `\x1b[48;2;${bg}m`;
  return B + segs.map((s) => (s.color ? `${s.bold ? "\x1b[1m" : ""}\x1b[38;2;${s.color}m${s.text}\x1b[0m${B}` : s.text)).join("");
}

const width = (segs: Seg[]) => cellWidth(segs.map((s) => s.text).join(""));

/** Cut to `max` cells, ending in "…" when anything was dropped. */
function clipSegs(segs: Seg[], max: number): Seg[] {
  if (width(segs) <= max) return segs;
  const out: Seg[] = [];
  let used = 0;
  for (const s of segs) {
    let t = "";
    for (const ch of s.text) { const w = cellWidth(ch); if (used + w > max - 1) break; t += ch; used += w; }
    if (t) out.push({ ...s, text: t });
    if (t.length < s.text.length) break;
  }
  out.push({ text: "…" });
  return out;
}

/**
 * One row (2026-10-11): the session state, then "Mon:" and
 * each source joined by " · ". When that is too wide the state shortens to its first word ("✓ On Subscription"),
 * then sources that do not fit whole are counted in a closing "+N more" ("+N" when even that is too wide). The row is padded to `cols` so its band
 * runs the full width.
 */
export const MONEY_MAX_ROWS = 1;

export function renderMoney(row: MoneyRow, cols: number, color = true): string[] {
  const tag: Seg = { text: row.monthLabel, color: C.purple, bold: true };
  const dot: Seg = { text: " · ", color: C.faint };
  const bar: Seg = { text: "  │  ", color: C.faint };
  const full: Seg[] = [{ text: "💵 " }, ...row.head];
  const short: Seg[] = [{ text: "💵 " }, ...row.head.slice(0, 1)];
  const monthRun = (n: number): Seg[] => row.month.slice(0, n).flatMap((g, k) => (k === 0 ? [tag, ...g] : [dot, ...g]));
  const more = (n: number, word: string): Seg[] => (n > 0 ? [dot, { text: `+${n}${word}`, color: C.faint }] : []);
  const line = (head: Seg[], n: number, word = " more"): Seg[] =>
    row.month.length === 0 ? head : [...head, bar, ...monthRun(n), ...more(row.month.length - n, word)];
  const total = row.month.length;
  let r = line(full, total);
  if (width(r) > cols) {
    // The most sources that fit whole behind the short state, with room for the "+N more" that counts the rest.
    let n = total;
    while (n > 1 && width(line(short, n)) > cols) n--;
    r = line(short, n);
    if (width(r) > cols) r = line(short, n, "");
  }
  const rows: Seg[][] = [r];
  return rows.slice(0, MONEY_MAX_ROWS).map((r) => {
    const t = [...r];
    while (t.length && t[t.length - 1].text.trimEnd() !== t[t.length - 1].text) {
      const last = t.pop()!;
      if (last.text.trimEnd()) { t.push({ ...last, text: last.text.trimEnd() }); break; }
    }
    const c = clipSegs(t, cols);
    const pad = cols - width(c);
    return paintSegs(pad > 0 ? [...c, { text: " ".repeat(pad) }] : c, color, BAND[row.state]) + (color ? "\x1b[0m" : "");
  });
}

// ── CLI ────────────────────────────────────────────────────────────────────

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function readJson<T>(path: string): T | null {
  try { return JSON.parse(readFileSync(path, "utf8")) as T; } catch { return null; }
}

/** An API key or any base URL bills an API; otherwise the direct login. */
function genericPay(env: Record<string, string | undefined>): string {
  if (env.ANTHROPIC_API_KEY && env.ANTHROPIC_API_KEY.trim() !== "") return "API";
  return env.ANTHROPIC_BASE_URL?.trim() ? "API" : "DIRECT";
}

export interface MoneyRowsArgs { cols: number; sessionId?: string; sessionCostUsd?: number | null; billing?: string | null; capped?: string | null; color?: boolean; nowMs?: number }

/** The money row's rendered lines for this environment; the CLI `row` command prints exactly these. */
export function moneyRows(env: Record<string, string | undefined>, a: MoneyRowsArgs): string[] {
  const home = env.HOME || homedir();
  const obs = (f: string) => lifeosPath("MEMORY", "OBSERVABILITY", f);
  const cache = join(env.XDG_CACHE_HOME || join(home, ".cache"), "lifeos-statusline", "money-month.json");
  const now = a.nowMs ?? Date.now();
  const month = monthKey(new Date(now));
  const ext = privateExtension();
  const who = ext ? ext.moneyAccounts(env, home) : { pay: genericPay(env), accounts: [], served: null, login: null };
  const row = moneyRow({
    pay: who.pay,
    sessionId: a.sessionId || undefined,
    sessionCostUsd: a.sessionCostUsd ?? null,
    billing: a.billing ?? null,
    capped: a.capped || null,
    accounts: who.accounts,
    served: who.served,
    login: who.login,
    overage: readJson<OverageSummary>(env.LIFEOS_OVERAGE_SUMMARY || obs("overage-summary.json")),
    ...monthSources(
      { openaiCost: obs("openai-cost.json"), anthropicCost: obs("anthropic-cost.jsonl"), vendorCosts: obs("vendor-costs.jsonl"), budgetFloors: obs("budget-floors.json") },
      cache, month, now),
    month,
    now,
    obfuscate: obfuscation({ env, now }).on,
  });
  return row.alert ? renderMoney(row, Number.isFinite(a.cols) && a.cols > 0 ? a.cols : 80, a.color ?? true) : [];
}

function main(): number {
  if (process.argv[2] !== "row") {
    console.error("usage: StatusLineMoney.ts row --cols N [--session ID] [--session-cost USD] [--billing STATE --capped WIN] [--plain]");
    return 2;
  }
  const env = process.env as Record<string, string | undefined>;
  const cols = Number(arg("--cols") ?? env.COLUMNS ?? 80);
  const cost = Number(arg("--session-cost"));
  const lines = moneyRows(env, {
    cols, sessionId: arg("--session"), sessionCostUsd: Number.isFinite(cost) ? cost : null,
    billing: arg("--billing") ?? null, capped: arg("--capped") || null, color: !process.argv.includes("--plain"),
  });
  process.stdout.write(lines.join("\n") + "\n");
  return 0;
}

if (import.meta.main) process.exit(main());
