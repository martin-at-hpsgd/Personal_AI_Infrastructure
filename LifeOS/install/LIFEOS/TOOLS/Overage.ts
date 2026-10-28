#!/usr/bin/env bun
/**
 * @version 1.0.5
 * Overage.ts — the emergency API lane's state of record: what it cost, what is left, is it on.
 *
 * WHY: both top lanes ride a subscription — Astra through `codex exec`
 * on the ChatGPT plan, Fable on the Claude plan. The emergency lane (`ApiLane.ts`) makes a
 * capped window a decision, and this file is the money side of
 * that decision: every billed call lands in one ledger, one summary answers "how much this
 * month, how much is left", and one arm state answers "is it on right now".
 *
 * POLICY (OPERATIONAL_PREFERENCES § Model selection, emergency API lane):
 *   - Ask each time. The caller arms only after the principal says yes; this file cannot see
 *     that yes. What it enforces is the channel: an arm is refused unless the environment
 *     looks like an interactive terminal (a declared channel or terminal identity), which
 *     keeps scheduled and headless spawns out but is not proof of approval.
 *   - $1,000 a month across both vendors. At the ceiling the lane refuses even while armed.
 *   - Failover only. This is for a capped window, never a cheaper road for routine work.
 *
 * FILES (all under MEMORY/OBSERVABILITY/):
 *   overage-ledger.jsonl   append-only, one billed call per line — the source of truth
 *   overage-state.json     the arm state (0600): who armed it, why, until when
 *   overage-summary.json   a derived cache the statusline and Pulse read without spawning bun
 *
 *   bun LIFEOS/TOOLS/Overage.ts status [--json]
 *   bun LIFEOS/TOOLS/Overage.ts arm --session <id> --reason "<why>" [--minutes 240]
 *   bun LIFEOS/TOOLS/Overage.ts disarm
 *   bun LIFEOS/TOOLS/Overage.ts check --session <id>          # exit 0 only when a call may bill
 *   bun LIFEOS/TOOLS/Overage.ts record --vendor openai --lane astra --model <id> \
 *        --input N --output N [--cached N] [--session <id>]
 */

import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, chmodSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { lifeosPath } from "./Paths";
import { pricingFor } from "./models";
import { invariant } from "./Invariant.ts";

// lifeosPath, not getClaudeDir()+"LIFEOS": a relocated LIFEOS_DIR is where the statusline reads the summary.
const OBS_DIR = lifeosPath("MEMORY", "OBSERVABILITY");

/** Test seams: every path is overridable so a suite never touches the real ledger. */
export function ledgerPath(): string { return process.env.LIFEOS_OVERAGE_LEDGER || join(OBS_DIR, "overage-ledger.jsonl"); }
export function statePath(): string { return process.env.LIFEOS_OVERAGE_STATE || join(OBS_DIR, "overage-state.json"); }
export function summaryPath(): string { return process.env.LIFEOS_OVERAGE_SUMMARY || join(OBS_DIR, "overage-summary.json"); }
function configPath(): string { return process.env.LIFEOS_OVERAGE_CONFIG || lifeosPath("USER", "CONFIG", "overage.json"); }

/** Fallback monthly ceiling across BOTH vendors, used only when USER/CONFIG/overage.json sets no `ceilingUsd` (principal, 2026-09-20). */
export const DEFAULT_CEILING_USD = 1000;
/** How long one arm lasts with no explicit --minutes. An arm is a session decision, not a setting. */
export const DEFAULT_ARM_MINUTES = 240;

export interface CeilingRead { ceilingUsd: number; error?: string }

/**
 * The monthly ceiling, read so a broken config can never RAISE it (LOSIntegrity S095). Only an absent
 * file, or a file with no `ceilingUsd` key, means the default. A file that exists but cannot be read,
 * parsed or validated returns a zero ceiling with the reason, and billing and arming refuse on it.
 */
export function ceilingChecked(path = configPath()): CeilingRead {
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return { ceilingUsd: DEFAULT_CEILING_USD };
    return { ceilingUsd: 0, error: `overage config unreadable (${(e as NodeJS.ErrnoException)?.code ?? "error"})` };
  }
  let j: unknown;
  try { j = JSON.parse(text); } catch { return { ceilingUsd: 0, error: "overage config is not valid JSON" }; }
  if (j === null || typeof j !== "object" || Array.isArray(j)) return { ceilingUsd: 0, error: "overage config is not a JSON object" };
  const raw = (j as { ceilingUsd?: unknown }).ceilingUsd;
  if (raw === undefined) return { ceilingUsd: DEFAULT_CEILING_USD };
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    return { ceilingUsd: 0, error: `overage config ceilingUsd is not a positive number: ${String(JSON.stringify(raw)).slice(0, 40)}` };
  }
  return { ceilingUsd: raw };
}

/** The ceiling in dollars; zero (nothing bills) when the config exists but is invalid. */
export function ceilingUsd(): number {
  return ceilingChecked().ceilingUsd;
}

export type Vendor = "openai" | "anthropic";

export interface LedgerRow {
  ts: string;
  vendor: Vendor;
  lane: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  costUsd: number;
  sessionId?: string;
  reason?: string;
}

export interface ArmState {
  armed: boolean;
  sessionId?: string;
  reason?: string;
  armedAt?: number;   // epoch seconds
  expiresAt?: number; // epoch seconds
}

export interface VendorRollup {
  vendor: Vendor;
  lane: string;
  model: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface OverageSummary {
  month: string;
  ceilingUsd: number;
  spentUsd: number;
  remainingUsd: number;
  /** Ledger lines that are not valid billed calls. Non-zero means the ceiling cannot be trusted. */
  malformedRows: number;
  /** Set when USER/CONFIG/overage.json exists but cannot be read or validated: the ceiling is then zero and billing refuses. */
  configError?: string;
  byVendor: VendorRollup[];
  armed: ArmState;
  recent: LedgerRow[];
  updated: string;
}

// ── Pricing ────────────────────────────────────────────────────────────────
// Anthropic prices come from model-pricing.json (ModelSync keeps it current).
// Everything else comes from vendor-pricing.json, sourced from the vendor's own
// pricing page. An unpriced model is a loud failure, never a silent $0 — a call
// we cannot price is a call we cannot hold to a ceiling.

export interface TokenPrice { input: number; cachedInput: number; output: number }

let vendorTable: Record<string, { input: number; cachedInput: number; output: number }> | null = null;
function vendorPricing(): Record<string, { input: number; cachedInput: number; output: number }> {
  if (vendorTable) return vendorTable;
  try {
    const p = process.env.LIFEOS_VENDOR_PRICING || join(import.meta.dir, "vendor-pricing.json");
    vendorTable = (JSON.parse(readFileSync(p, "utf8")) as { models: Record<string, any> }).models ?? {};
  } catch { vendorTable = {}; }
  return vendorTable;
}

/** $/MTok for any model on either vendor, or null when the model has no priced row. */
export function priceFor(vendor: Vendor, model: string): TokenPrice | null {
  if (vendor === "anthropic") {
    const m = pricingFor(model);
    if (!m) return null;
    return { input: m.pricing.input, cachedInput: m.pricing.cacheRead, output: m.pricing.output };
  }
  const row = vendorPricing()[model.trim()];
  if (!row) return null;
  return { input: row.input, cachedInput: row.cachedInput, output: row.output };
}

export interface TokenUsage { inputTokens: number; outputTokens: number; cachedInputTokens?: number }

/** Dollars for one call. Cached input is billed at the cached rate and is NOT double-counted. */
export function costOf(vendor: Vendor, model: string, u: TokenUsage): number {
  const p = priceFor(vendor, model);
  if (!p) throw new Error(`[Overage] no price for ${vendor}/${model} — add a row to vendor-pricing.json before billing it`);
  const cached = Math.max(0, u.cachedInputTokens ?? 0);
  const fresh = Math.max(0, u.inputTokens - cached);
  const cost = (fresh * p.input + cached * p.cachedInput + Math.max(0, u.outputTokens) * p.output) / 1_000_000;
  return Math.round(cost * 1e6) / 1e6;
}

// ── Ledger ─────────────────────────────────────────────────────────────────

export function monthKey(d = new Date()): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** A ledger row is billable evidence only when every field the ceiling depends on is well formed. */
export function isValidLedgerRow(r: unknown): r is LedgerRow {
  if (!r || typeof r !== "object" || Array.isArray(r)) return false;
  const o = r as Record<string, unknown>;
  const nonNeg = (v: unknown): boolean => typeof v === "number" && Number.isFinite(v) && v >= 0;
  return typeof o.ts === "string" && /^\d{4}-\d{2}/.test(o.ts)
    && (o.vendor === "openai" || o.vendor === "anthropic")
    && typeof o.model === "string"
    && nonNeg(o.costUsd);
}

export interface LedgerRead { rows: LedgerRow[]; malformed: number }

/**
 * Read the ledger and count every line that is not a valid billed call. The count is what lets
 * the billing gate fail closed: a ledger whose total cannot be established cannot hold a ceiling.
 */
export function readLedgerChecked(path = ledgerPath()): LedgerRead {
  if (!existsSync(path)) return { rows: [], malformed: 0 };
  const rows: LedgerRow[] = [];
  let malformed = 0;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as unknown;
      if (isValidLedgerRow(r)) rows.push(r); else malformed++;
    } catch { malformed++; }
  }
  return { rows, malformed };
}

/** Valid rows only. Anything that gates billing reads `summary().malformedRows` as well. */
export function readLedger(path = ledgerPath()): LedgerRow[] {
  return readLedgerChecked(path).rows;
}

/** Append one billed call and refresh the derived summary cache. Returns the row written. */
export function record(row: Omit<LedgerRow, "ts" | "costUsd" | "cachedInputTokens"> & { ts?: string; cachedInputTokens?: number; costUsd?: number }): LedgerRow {
  invariant(row.vendor === "openai" || row.vendor === "anthropic", "Overage.record: vendor must be openai or anthropic");
  invariant(!!row.model, "Overage.record: model is required");
  invariant(Number.isFinite(row.inputTokens) && row.inputTokens >= 0, "Overage.record: inputTokens must be a non-negative number");
  invariant(Number.isFinite(row.outputTokens) && row.outputTokens >= 0, "Overage.record: outputTokens must be a non-negative number");
  const cachedInputTokens = Math.max(0, row.cachedInputTokens ?? 0);
  const full: LedgerRow = {
    ts: row.ts ?? new Date().toISOString(),
    vendor: row.vendor,
    lane: row.lane,
    model: row.model,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cachedInputTokens,
    costUsd: row.costUsd ?? costOf(row.vendor, row.model, { ...row, cachedInputTokens }),
    ...(row.sessionId ? { sessionId: row.sessionId } : {}),
    ...(row.reason ? { reason: row.reason } : {}),
  };
  invariant(Number.isFinite(full.costUsd) && full.costUsd >= 0, "Overage.record: costUsd must be a non-negative number");
  const path = ledgerPath();
  mkdirSync(join(path, ".."), { recursive: true });
  appendFileSync(path, JSON.stringify(full) + "\n", { mode: 0o600 });
  writeSummaryCache();
  return full;
}

// ── Arm state ──────────────────────────────────────────────────────────────

export function readArm(path = statePath(), now = Math.floor(Date.now() / 1000)): ArmState {
  if (!existsSync(path)) return { armed: false };
  try {
    const s = JSON.parse(readFileSync(path, "utf8")) as ArmState;
    if (!s || s.armed !== true) return { armed: false };
    // Fail closed: an arm is valid only with a bound session and a finite expiry still in the future.
    // A hand-written or torn state (no session, missing/zero/non-numeric expiry) is never armed.
    if (typeof s.sessionId !== "string" || s.sessionId.length === 0) return { armed: false };
    if (typeof s.expiresAt !== "number" || !Number.isFinite(s.expiresAt) || s.expiresAt <= now) return { armed: false };
    return s;
  } catch { return { armed: false }; }
}

function writeArm(s: ArmState): void {
  const path = statePath();
  mkdirSync(join(path, ".."), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(s, null, 2) + "\n", { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

/**
 * The session's channel. Anything but an interactive terminal is refused an arm. This is
 * environment evidence only (a caller-declared channel, or TERM/SSH identity), so an agent
 * running inside an interactive session passes it; the principal's yes is the caller's duty.
 */
export function channel(): string {
  const raw = process.env.LIFEOS_NOTIFICATION_CHANNEL;
  if (raw && raw.length > 0) return raw;
  // Fail closed: with no declared channel, only real terminal identity counts as interactive
  // (same evidence as hooks/lib/notification-channel.ts). launchd/cron spawns carry none.
  const env = process.env;
  if (env.TERM || env.TERM_PROGRAM || env.KITTY_WINDOW_ID || env.SSH_TTY) return "desktop";
  if (env.CLAUDE_CODE_ENTRYPOINT === "claude-desktop") return "desktop";
  return "headless";
}

export interface ArmResult { ok: boolean; state: ArmState; error?: string }

/**
 * Arm the lane for one session; the caller runs this only after the principal says yes, which
 * this function cannot verify. Refused with no session id, from a
 * headless/scheduled channel, or once the month's ceiling is spent — an ask that cannot be
 * answered by a human is not an ask (ISC O12).
 */
export function arm(opts: { sessionId?: string; reason?: string; minutes?: number; now?: number }): ArmResult {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const ch = channel();
  if (ch !== "desktop") return { ok: false, state: { armed: false }, error: `the emergency API lane cannot be armed from channel '${ch}' — arming needs an interactive terminal channel, and the principal's yes before it` };
  if (!opts.sessionId) return { ok: false, state: { armed: false }, error: "--session <id> is required: an arm belongs to one session" };
  if (!opts.reason) return { ok: false, state: { armed: false }, error: "--reason \"<why>\" is required: the ledger records why the lane was on" };
  const s = summary(now);
  if (s.configError) return { ok: false, state: { armed: false }, error: `${s.configError} — the monthly ceiling cannot be established, so the lane stays off until USER/CONFIG/overage.json is repaired` };
  if (s.malformedRows > 0) return { ok: false, state: { armed: false }, error: `the overage ledger has ${s.malformedRows} malformed row(s) — month-to-date spend cannot be established, so the lane stays off until the ledger is repaired` };
  if (s.remainingUsd <= 0) return { ok: false, state: { armed: false }, error: `month-to-date overage is $${s.spentUsd.toFixed(2)} against a $${s.ceilingUsd} ceiling — raise the ceiling in USER/CONFIG/overage.json or wait for the month to roll` };
  const minutes = Number.isFinite(opts.minutes) && (opts.minutes as number) > 0 ? (opts.minutes as number) : DEFAULT_ARM_MINUTES;
  const state: ArmState = { armed: true, sessionId: opts.sessionId, reason: opts.reason, armedAt: now, expiresAt: now + Math.round(minutes * 60) };
  invariant(typeof state.sessionId === "string" && state.sessionId.length > 0, "Overage.arm: an arm must carry a session id");
  invariant(Number.isFinite(state.expiresAt) && (state.expiresAt as number) > now, "Overage.arm: expiresAt must be a finite future time");
  writeArm(state);
  writeSummaryCache(now);
  return { ok: true, state };
}

/**
 * Revoke the arm. Only an absent state file is "nothing to clear"; any other unlink failure
 * throws, and the revocation is re-read from disk before success is reported, so a failed
 * disarm can never print "disarmed" while the arm survives.
 */
export function disarm(): ArmState {
  const off: ArmState = { armed: false };
  const path = statePath();
  try { unlinkSync(path); } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") {
      throw new Error(`[Overage] disarm failed: could not remove ${path} (${(e as Error).message}) — the lane may still be armed`);
    }
  }
  if (existsSync(path)) {
    throw new Error(`[Overage] disarm failed: ${path} still exists after removal — the lane may still be armed`);
  }
  writeSummaryCache();
  return off;
}

export interface CheckResult { ok: boolean; reason: string; spentUsd: number; remainingUsd: number; armed: ArmState }

/**
 * May a call bill right now? Armed for THIS session, not expired, and under the ceiling.
 * Every gate is re-read from disk, so a disarm in another window stops the next call.
 */
export function check(sessionId?: string, now = Math.floor(Date.now() / 1000)): CheckResult {
  const armed = readArm(statePath(), now);
  const s = summary(now);
  if (!armed.armed) return { ok: false, reason: "the emergency API lane is not armed — nothing bills the API without the principal's word", spentUsd: s.spentUsd, remainingUsd: s.remainingUsd, armed };
  if (!sessionId) {
    return { ok: false, reason: "a requesting session id is required — an arm belongs to the session that asked for it", spentUsd: s.spentUsd, remainingUsd: s.remainingUsd, armed };
  }
  if (armed.sessionId !== sessionId) {
    return { ok: false, reason: `armed for session ${armed.sessionId}, not this one — an arm belongs to the session that asked for it`, spentUsd: s.spentUsd, remainingUsd: s.remainingUsd, armed };
  }
  if (s.configError) return { ok: false, reason: `${s.configError} — the monthly ceiling cannot be established, so nothing bills until it is repaired`, spentUsd: s.spentUsd, remainingUsd: s.remainingUsd, armed };
  if (s.malformedRows > 0) return { ok: false, reason: `the overage ledger has ${s.malformedRows} malformed row(s) — spend cannot be established, so nothing bills until it is repaired`, spentUsd: s.spentUsd, remainingUsd: s.remainingUsd, armed };
  if (s.remainingUsd <= 0) return { ok: false, reason: `the $${s.ceilingUsd} monthly ceiling is spent ($${s.spentUsd.toFixed(2)})`, spentUsd: s.spentUsd, remainingUsd: s.remainingUsd, armed };
  return { ok: true, reason: `armed${armed.reason ? `: ${armed.reason}` : ""}`, spentUsd: s.spentUsd, remainingUsd: s.remainingUsd, armed };
}

// ── Summary ────────────────────────────────────────────────────────────────

const RECENT_LIMIT = 20;

/** Month-to-date rollup over the ledger, plus the live arm state. Pure read. */
export function summary(now = Math.floor(Date.now() / 1000)): OverageSummary {
  const month = monthKey(new Date(now * 1000));
  const ledger = readLedgerChecked();
  const rows = ledger.rows.filter((r) => r.ts.slice(0, 7) === month);
  const ceilingRead = ceilingChecked();
  const ceiling = ceilingRead.ceilingUsd;
  const byKey = new Map<string, VendorRollup>();
  let spent = 0;
  for (const r of rows) {
    spent += r.costUsd;
    const key = `${r.vendor}|${r.lane}|${r.model}`;
    const agg = byKey.get(key) ?? { vendor: r.vendor, lane: r.lane, model: r.model, calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
    agg.calls++;
    agg.inputTokens += r.inputTokens || 0;
    agg.outputTokens += r.outputTokens || 0;
    agg.costUsd = Math.round((agg.costUsd + r.costUsd) * 1e6) / 1e6;
    byKey.set(key, agg);
  }
  spent = Math.round(spent * 1e6) / 1e6;
  return {
    month,
    ceilingUsd: ceiling,
    spentUsd: spent,
    remainingUsd: Math.max(0, Math.round((ceiling - spent) * 1e6) / 1e6),
    malformedRows: ledger.malformed,
    ...(ceilingRead.error ? { configError: ceilingRead.error } : {}),
    byVendor: [...byKey.values()].sort((a, b) => b.costUsd - a.costUsd),
    armed: readArm(statePath(), now),
    recent: rows.slice(-RECENT_LIMIT).reverse(),
    updated: new Date(now * 1000).toISOString(),
  };
}

/** Write the derived cache the statusline and Pulse read without spawning bun. */
export function writeSummaryCache(now = Math.floor(Date.now() / 1000)): OverageSummary {
  const s = summary(now);
  const path = summaryPath();
  mkdirSync(join(path, ".."), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(s, null, 2) + "\n", { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  return s;
}

// ── CLI ────────────────────────────────────────────────────────────────────

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

/**
 * Dollars for a human. A sub-cent amount keeps four decimals: a real billed call must never
 * read as "$0.00", which is indistinguishable from nothing having billed at all (2026-09-20,
 * the first live Astra probe cost $0.00037 and the first draft printed it as $0.00).
 */
export function money(n: number): string {
  if (n >= 100) return `$${Math.round(n).toLocaleString("en-US")}`;
  if (n > 0 && n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

function printStatus(s: OverageSummary): void {
  const state = s.armed.armed ? `ARMED (session ${s.armed.sessionId ?? "?"}${s.armed.reason ? `, ${s.armed.reason}` : ""})` : "disarmed";
  console.log(`emergency API lane: ${state}`);
  console.log(`${s.month}: ${money(s.spentUsd)} of ${money(s.ceilingUsd)} · ${money(s.remainingUsd)} left`);
  if (s.configError) console.log(`WARNING: ${s.configError} — billing is refused until it is repaired`);
  if (s.malformedRows > 0) console.log(`WARNING: ${s.malformedRows} malformed ledger row(s) — billing is refused until the ledger is repaired`);
  if (s.byVendor.length === 0) { console.log("no billed calls this month"); return; }
  for (const v of s.byVendor) {
    console.log(`  ${v.vendor.padEnd(9)} ${v.lane.padEnd(6)} ${v.model.padEnd(16)} ${String(v.calls).padStart(4)} calls  ${money(v.costUsd)}`);
  }
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const cmd = argv[0] ?? "status";
  const json = argv.includes("--json");
  switch (cmd) {
    case "status":
    case "summary": {
      const s = summary();
      if (json) console.log(JSON.stringify(s, null, 2));
      else printStatus(s);
      break;
    }
    case "arm": {
      const r = arm({ sessionId: flag(argv, "session"), reason: flag(argv, "reason"), minutes: Number(flag(argv, "minutes")) });
      if (!r.ok) { console.error(`[Overage] refused: ${r.error}`); process.exit(1); }
      console.log(json ? JSON.stringify(r.state, null, 2) : `emergency API lane ARMED until ${new Date((r.state.expiresAt ?? 0) * 1000).toISOString()} — ${r.state.reason}`);
      break;
    }
    case "disarm": {
      try { disarm(); } catch (e) { console.error((e as Error).message); process.exit(1); }
      console.log("emergency API lane disarmed");
      break;
    }
    case "check": {
      const c = check(flag(argv, "session"));
      if (json) console.log(JSON.stringify(c, null, 2));
      else console.log(`${c.ok ? "OK" : "REFUSED"}: ${c.reason} (${money(c.spentUsd)} spent, ${money(c.remainingUsd)} left)`);
      process.exit(c.ok ? 0 : 1);
    }
    case "record": {
      const row = record({
        vendor: (flag(argv, "vendor") ?? "") as Vendor,
        lane: flag(argv, "lane") ?? "",
        model: flag(argv, "model") ?? "",
        inputTokens: Number(flag(argv, "input") ?? 0),
        outputTokens: Number(flag(argv, "output") ?? 0),
        cachedInputTokens: Number(flag(argv, "cached") ?? 0),
        sessionId: flag(argv, "session"),
        reason: flag(argv, "reason"),
      });
      console.log(json ? JSON.stringify(row, null, 2) : `recorded ${row.vendor}/${row.model} ${money(row.costUsd)}`);
      break;
    }
    default:
      console.error(`[Overage] unknown command '${cmd}' — status | arm | disarm | check | record`);
      process.exit(2);
  }
}
