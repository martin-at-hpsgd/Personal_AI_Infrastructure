#!/usr/bin/env bun
/**
 * @version 1.3.17
 * CostTracker — Anthropic cost observability for LifeOS
 *
 * Why this exists:
 *   LifeOS-local processes can bill the API instead of the subscription without
 *   anyone noticing (an SDK client in a long-running service, a spawned `--bare`
 *   session, an .env auto-load of ANTHROPIC_API_KEY). Such a leak otherwise shows
 *   up only when the monthly invoice arrives. This tool closes that feedback loop.
 *
 * What it tracks:
 *   1. Subscription usage (5h/7d window %, read from UpdateCounts cache)
 *   2. API spend (from ANTHROPIC_ADMIN_API_KEY cost_report, if available)
 *   3. Call-site inventory (static rg scan for SDK imports + `--bare` + ANTHROPIC_API_KEY refs)
 *      — This is the real leak detector: catches regressions BEFORE they bill
 *
 * Outputs:
 *   MEMORY/OBSERVABILITY/anthropic-cost.jsonl   — append-only ledger
 *   MEMORY/OBSERVABILITY/anthropic-call-sites.json — current call-site snapshot
 *
 * CLI:
 *   bun CostTracker.ts status              — human-readable snapshot
 *   bun CostTracker.ts scan                — static scan, prints call sites
 *   bun CostTracker.ts log                 — append JSONL entry (for cron)
 *   bun CostTracker.ts alert-check         — threshold check, voice-alert if exceeded
 *   bun CostTracker.ts baseline            — snapshot current call sites as "known good"
 *
 * Designed to be called hourly by Pulse cron. Zero AI cost — pure data aggregation.
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, appendFileSync } from "fs";
import { join } from "path";
import { spawnSync } from "child_process";
import { PULSE_BASE } from "../PULSE/endpoint";
import { homedir } from "node:os";
import { getClaudeDir, getLifeosDir, lifeosPath } from "./Paths"; // public issue #1974 @sabo961, PR #1918 @PigLardLord
import { buildOpenAiSpend, estimateOpenAiMonth, loadCloudRuns, loadPricing, loadUsageRows } from "./OpenAiSpendEstimate";
import { invariant } from "./Invariant";

const HOME = process.env.HOME ?? process.env.USERPROFILE ?? homedir();
const LIFEOS_DIR = getLifeosDir();
const OBS_DIR = join(LIFEOS_DIR, "MEMORY", "OBSERVABILITY");
const LEDGER_PATH = join(OBS_DIR, "anthropic-cost.jsonl");
const OPENAI_BILL_PATH = join(OBS_DIR, "openai-cost.json");
const CALL_SITES_PATH = join(OBS_DIR, "anthropic-call-sites.json");
const USAGE_CACHE_PATH = join(LIFEOS_DIR, "MEMORY", "STATE", "usage-cache.json");

// Alert thresholds — tunable
const API_SPEND_MONTHLY_ALERT_USD = 5.0;    // even Workflows should stay under $5/mo
const SUB_USAGE_ALERT_PCT = 95;             // subscription near-capacity warning

interface CostSnapshot {
  ts: string;
  subscription: {
    five_hour_pct: number | null;
    seven_day_pct: number | null;
  };
  api_spend: {
    month_used_usd: number | null;
    source: "admin_key" | "unavailable";
  };
  call_sites: {
    total: number;
    bypass: number;    // should NOT bill API but do
    legit: number;     // CF Workers, opt-in Evals
    new_since_baseline: string[];
  };
  alerts: string[];
}

interface CallSite {
  file: string;
  line: number;
  match: string;
  classification: "bypass" | "legit" | "unknown";
  reason: string;
}

// ──────────────────────────────────────────────────────────────────────────
// Subscription usage (OAuth, cached by UpdateCounts.hook.ts)
// ──────────────────────────────────────────────────────────────────────────

// Exported for LIFEOS/TOOLS/CostTracker.test.ts (the stale-window cases).
export function readSubscriptionUsage(): { five_hour_pct: number | null; seven_day_pct: number | null } {
  try {
    const raw = readFileSync(USAGE_CACHE_PATH, "utf-8");
    const data = JSON.parse(raw);
    // public issue #2132, @MatiasBarboza: check if resets_at has passed.
    // A window whose resets_at is in the past no longer describes current usage.
    const isValidWindow = (window: any) => {
      if (!window || typeof window.resets_at !== "string") return false;
      const resetsAt = new Date(window.resets_at).getTime();
      return !isNaN(resetsAt) && resetsAt > Date.now();
    };
    return {
      five_hour_pct: isValidWindow(data?.five_hour) ? (data.five_hour.utilization ?? null) : null,
      seven_day_pct: isValidWindow(data?.seven_day) ? (data.seven_day.utilization ?? null) : null,
    };
  } catch {
    return { five_hour_pct: null, seven_day_pct: null };
  }
}

// ──────────────────────────────────────────────────────────────────────────
// OpenAI bill (requires OPENAI_ADMIN_API_KEY)
// ──────────────────────────────────────────────────────────────────────────

/**
 * This month's real OpenAI bill so far, every key and project, from the organization Costs API, written to
 * openai-cost.json for the status line's money row. A failed read writes usd null and the reason, so the row can
 * say what is missing instead of showing a stale number. With no readable bill it also writes estimate_usd, our own
 * estimate from logged OpenAI usage and any cloud runs (OpenAiSpendEstimate.ts), which the row draws muted as "est.".
 */
async function logOpenAiBill(): Promise<{ usd: number | null; reason: string | null }> {
  const now = new Date();
  const spend = await buildOpenAiSpend({ config: { projectId: "", days: now.getUTCDate() } });
  const usd = spend.source === "admin_key" ? spend.total_usd : null;
  const month = now.toISOString().slice(0, 7);
  let estimate: number | null = null;
  if (usd === null) {
    const e = estimateOpenAiMonth(month, loadUsageRows(join(OBS_DIR, "openai-usage.jsonl"), month), await loadCloudRuns(), loadPricing(join(getLifeosDir(), "TOOLS")));
    estimate = Math.round(e.usd * 100) / 100;
  }
  const reading = { ts: now.toISOString(), month, usd, reason: usd === null ? spend.reason ?? "unavailable" : null, ...(estimate !== null ? { estimate_usd: estimate } : {}) };
  invariant(usd === null || (Number.isFinite(usd) && usd >= 0), `openai bill: bad usd ${usd}`);
  invariant(estimate === null || (Number.isFinite(estimate) && estimate >= 0), `openai bill: bad estimate ${estimate}`);
  invariant(/^\d{4}-\d{2}$/.test(reading.month), `openai bill: bad month ${reading.month}`);
  writeFileSync(OPENAI_BILL_PATH, JSON.stringify(reading) + "\n", { mode: 0o600 });
  return reading;
}

// ──────────────────────────────────────────────────────────────────────────
// API spend (requires ANTHROPIC_ADMIN_API_KEY)
// ──────────────────────────────────────────────────────────────────────────

async function fetchApiSpend(): Promise<{ month_used_usd: number | null; source: "admin_key" | "unavailable" }> {
  const adminKey = process.env.ANTHROPIC_ADMIN_API_KEY;
  if (!adminKey) return { month_used_usd: null, source: "unavailable" };

  try {
    const now = new Date();
    const startOfMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01T00:00:00Z`;
    const resp = await fetch(
      `https://api.anthropic.com/v1/organizations/cost_report?starting_at=${startOfMonth}`,
      {
        headers: { "x-api-key": adminKey, "anthropic-version": "2023-06-01" },
        signal: AbortSignal.timeout(5000),
      }
    );
    if (!resp.ok) return { month_used_usd: null, source: "unavailable" };
    const data = await resp.json() as any;
    let totalCents = 0;
    if (Array.isArray(data?.data)) {
      for (const day of data.data) {
        if (Array.isArray(day?.results)) {
          for (const entry of day.results) {
            totalCents += parseFloat(entry.amount || "0");
          }
        }
      }
    }
    return { month_used_usd: totalCents / 100, source: "admin_key" };
  } catch {
    return { month_used_usd: null, source: "unavailable" };
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Static call-site scan — the real leak detector
// ──────────────────────────────────────────────────────────────────────────

// Paths we scan (source-of-truth for LifeOS-local billing risk)
// Every root is required unless marked optional: a required root that is missing is a scan failure (S085).
// USER is the principal's data tree, which a fresh install may not have yet.
const SCAN_ROOTS: ScanRoot[] = [
  lifeosPath("PULSE"),
  lifeosPath("TOOLS"),
  { path: lifeosPath("USER"), optional: true },
  join(getClaudeDir(), "skills"),
  join(getClaudeDir(), "hooks"),
];

// Paths to exclude from scan
const SCAN_EXCLUDES = [
  "node_modules",
  ".git",
  "LIFEOS_RELEASES",
  "WORKFLOWS/Workers",   // CF Workers — legit API users
  "WORKFLOWS/Shared",    // CF Workers — legit API users
  "WORKFLOWS/summarize", // CF Workers — legit API users
  "worktrees",
  "WORKFLOWS/.claude",
  "MEMORY/OBSERVABILITY",
  "CostTracker.ts",      // don't flag ourselves
];

// Patterns that indicate API billing risk
const RISK_PATTERNS = [
  { pattern: "@anthropic-ai/claude-agent-sdk", reason: "Claude Agent SDK — bills API unless ANTHROPIC_API_KEY is stripped from env" },
  { pattern: "@anthropic-ai/sdk", reason: "Raw Anthropic SDK — bills API directly" },
  { pattern: "@ai-sdk/anthropic", reason: "Vercel AI SDK Anthropic provider — bills API directly" },
  { pattern: "claude.*--bare", reason: "`claude --bare` flag forces ANTHROPIC_API_KEY auth, skips OAuth/keychain" },
  { pattern: "x-api-key.*(anthropic|sk-ant)", reason: "Raw HTTP to Anthropic API with x-api-key header" },
  { pattern: "api\\.anthropic\\.com/v1/messages", reason: "Direct HTTP POST to Anthropic messages endpoint" },
];

// Known-legit classifications (file path substrings)
const LEGIT_HINTS: Record<string, string> = {
  "CostTracker.ts": "this tool — scans itself for patterns",
  "hooks/handlers/UpdateCounts.ts": "OAuth usage cache (not billing inference)",
  "Tools/SecurityFilter.ts": "content redaction filter — regex only, no API call",
  "skills/Assay/": "opt-in API billing, gated by EVALS_ALLOW_API_BILLING=1",
  "LIFEOS/TOOLS/Inference.ts": "canonical inference tool — deletes ANTHROPIC_API_KEY before spawn",
  "LIFEOS/PULSE/setup.ts": "provisioning script — placeholder comment only",
};

// Cache per-file guard check so repeated classify calls don't re-read
const guardCache: Map<string, boolean> = new Map();
function fileHasGuard(filePath: string): boolean {
  if (guardCache.has(filePath)) return guardCache.get(filePath)!;
  try {
    const abs = filePath.startsWith("~") ? filePath.replace("~", HOME) : filePath;
    const content = readFileSync(abs, "utf-8");
    const guarded = content.includes("delete process.env.ANTHROPIC_API_KEY") ||
                    content.includes("delete env.ANTHROPIC_API_KEY");
    guardCache.set(filePath, guarded);
    return guarded;
  } catch {
    return false;
  }
}

export function classifyCallSite(file: string, reason: string): { classification: "bypass" | "legit" | "unknown"; note: string } {
  // Documentation files (.md) never execute — just mention SDK/API in prose or examples
  if (file.endsWith(".md")) {
    return { classification: "legit", note: "markdown (docs/template) — no runtime billing risk" };
  }
  // JSON manifests (package.json deps, config) declare a package but can't carry the
  // env-scrub guard — matching one is a false BYPASS, not a real call site (#1321).
  if (file.endsWith(".json")) {
    return { classification: "legit", note: "JSON manifest (dependency/config) — not an executable call site" };
  }
  for (const [hint, note] of Object.entries(LEGIT_HINTS)) {
    if (file.includes(hint)) return { classification: "legit", note };
  }
  // File has the ANTHROPIC_API_KEY-delete guard → its SDK/API-risk usage is neutralized
  if (fileHasGuard(file)) {
    return { classification: "legit", note: "file has `delete process.env.ANTHROPIC_API_KEY` guard — SDK/CLI uses OAuth subscription" };
  }
  if (reason.includes("--bare")) {
    return { classification: "bypass", note: "`--bare` flag — remove it, use Inference.ts flag pattern, and strip ANTHROPIC_API_KEY from env" };
  }
  if (reason.includes("SDK")) {
    return { classification: "bypass", note: "SDK call without ANTHROPIC_API_KEY-delete guard — will bill API if key present in env" };
  }
  // Raw HTTP hits (x-api-key header / direct messages-endpoint POST) bill API directly.
  // fileHasGuard() already returned legit above for guarded files (#1320).
  if (reason.includes("Raw HTTP") || reason.includes("messages endpoint")) {
    return { classification: "bypass", note: "raw HTTP call to Anthropic API without ANTHROPIC_API_KEY-delete guard — bills API directly" };
  }
  return { classification: "unknown", note: reason };
}

export interface ScanFailure { root: string; pattern: string; reason: string }
export interface ScanResult { sites: CallSite[]; failures: ScanFailure[] }
/** A root to scan: a bare path is required; `optional: true` lets it be absent without failing the scan. */
export type ScanRoot = string | { path: string; optional?: boolean };

export interface RgMatch { file: string; line: number; text: string }

/** Text from an rg JSON `{text}` or base64 `{bytes}` field, or null when neither is there. */
function rgText(v: unknown): string | null {
  if (!v || typeof v !== "object") return null;
  const o = v as { text?: unknown; bytes?: unknown };
  if (typeof o.text === "string") return o.text;
  if (typeof o.bytes === "string") return Buffer.from(o.bytes, "base64").toString("utf8");
  return null;
}

/**
 * Every match in rg `--json` output (S085). Paths are read from the event, never split out of a text line, so a
 * file name holding a colon is reported like any other. A line that is not a JSON event, or a match event without
 * a path or line number, makes the whole output unreadable: the caller records a failure, never an empty scan.
 */
export function parseRgJson(output: string): { ok: true; matches: RgMatch[] } | { ok: false; reason: string } {
  const matches: RgMatch[] = [];
  for (const raw of output.split("\n")) {
    if (!raw.trim()) continue;
    let ev: { type?: unknown; data?: { path?: unknown; lines?: unknown; line_number?: unknown } };
    try { ev = JSON.parse(raw); } catch { return { ok: false, reason: `unparseable rg output line: ${raw.slice(0, 120)}` }; }
    if (!ev || typeof ev !== "object" || typeof ev.type !== "string") return { ok: false, reason: `malformed rg event: ${raw.slice(0, 120)}` };
    if (ev.type !== "match") continue;
    const file = rgText(ev.data?.path);
    const line = ev.data?.line_number;
    if (file === null || typeof line !== "number" || !Number.isInteger(line)) return { ok: false, reason: `malformed rg match event: ${raw.slice(0, 120)}` };
    matches.push({ file, line, text: rgText(ev.data?.lines) ?? "" });
  }
  return { ok: true, matches };
}

/**
 * One rg run for one root and one pattern, as an argv array (no shell, so a
 * quote or `$(...)` in an env-derived root is just a path character).
 * Exit 1 means "no matches"; any other outcome is a failure, never an empty scan.
 */
export function runRg(root: string, pattern: string, rgBin = "rg"): { ok: true; output: string } | { ok: false; reason: string } {
  const args = ["--json"];
  for (const e of SCAN_EXCLUDES) args.push("-g", `!${e}/**`);
  args.push("-e", pattern, "--", root);
  const r = spawnSync(rgBin, args, { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });
  if (r.error) return { ok: false, reason: `rg did not run: ${(r.error as Error).message}` };
  if (r.status === 1) return { ok: true, output: "" };
  if (r.status !== 0) return { ok: false, reason: `rg exited ${r.status ?? r.signal}: ${(r.stderr ?? "").trim().slice(0, 200)}` };
  return { ok: true, output: (r.stdout ?? "").trim() };
}

/**
 * Scan the given roots. A root that cannot be scanned, a required root that is missing, and rg output that cannot
 * be read are each reported in `failures`; none of them ever reads as an empty scan.
 */
export function scanCallSitesChecked(roots: ScanRoot[], rgBin = "rg"): ScanResult {
  const hits: CallSite[] = [];
  const failures: ScanFailure[] = [];

  for (const entry of roots) {
    const root = typeof entry === "string" ? entry : entry.path;
    const optional = typeof entry !== "string" && entry.optional === true;
    // stat, never existsSync: existsSync is false for a loop or an unreadable ancestor too, and only a root that is
    // genuinely absent (ENOENT) may be skipped, and only when it is optional (S085 review).
    try { statSync(root); } catch (e) {
      const code = (e as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT" && optional) continue;
      const reason = code === "ENOENT" ? "required scan root is missing (does not exist)" : `scan root cannot be reached (${code ?? (e as Error)?.message ?? "error"})`;
      failures.push({ root: root.replace(HOME, "~"), pattern: "*", reason });
      continue;
    }
    for (const { pattern, reason } of RISK_PATTERNS) {
      const res = runRg(root, pattern, rgBin);
      if (!res.ok) {
        failures.push({ root: root.replace(HOME, "~"), pattern, reason: res.reason });
        continue;
      }
      if (!res.output) continue;
      const parsed = parseRgJson(res.output);
      if (!parsed.ok) {
        failures.push({ root: root.replace(HOME, "~"), pattern, reason: parsed.reason });
        continue;
      }
      for (const { file, line: lineNum, text } of parsed.matches) {
        const { classification, note } = classifyCallSite(file, reason);
        hits.push({
          file: file.replace(HOME, "~"),
          line: lineNum,
          match: text.trim().slice(0, 120),
          classification,
          reason: note,
        });
      }
    }
  }

  // Dedup by file+line+pattern
  const seen = new Set<string>();
  const sites = hits.filter((h) => {
    const key = `${h.file}:${h.line}:${h.reason}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { sites, failures };
}

function scanCallSites(): ScanResult {
  return scanCallSitesChecked(SCAN_ROOTS);
}

function describeFailures(failures: ScanFailure[]): string {
  return `billing scan INCOMPLETE (${failures.length} rg run(s) failed; e.g. ${failures[0].root}: ${failures[0].reason}) — a zero bypass count is not trustworthy`;
}

// ──────────────────────────────────────────────────────────────────────────
// Baseline diff — detect new call sites since last scan
// ──────────────────────────────────────────────────────────────────────────

function readBaseline(): Set<string> {
  try {
    const raw = readFileSync(CALL_SITES_PATH, "utf-8");
    const data = JSON.parse(raw) as { sites: CallSite[] };
    return new Set(data.sites.map((s) => `${s.file}:${s.line}:${s.reason}`));
  } catch {
    return new Set();
  }
}

function writeBaseline(sites: CallSite[]): void {
  mkdirSync(OBS_DIR, { recursive: true });
  writeFileSync(CALL_SITES_PATH, JSON.stringify({ updated: new Date().toISOString(), sites }, null, 2));
}

// ──────────────────────────────────────────────────────────────────────────
// Snapshot assembly
// ──────────────────────────────────────────────────────────────────────────

async function takeSnapshot(): Promise<{ snapshot: CostSnapshot; sites: CallSite[] }> {
  const subscription = readSubscriptionUsage();
  const api_spend = await fetchApiSpend();
  const { sites, failures: scanFailures } = scanCallSites();
  const baseline = readBaseline();

  const bypass = sites.filter((s) => s.classification === "bypass").length;
  const legit = sites.filter((s) => s.classification === "legit").length;
  const newSites = sites
    .filter((s) => !baseline.has(`${s.file}:${s.line}:${s.reason}`))
    .map((s) => `${s.file}:${s.line} (${s.classification}) — ${s.reason}`);

  const alerts: string[] = [];
  if (scanFailures.length > 0) alerts.push(describeFailures(scanFailures));
  if (api_spend.month_used_usd !== null && api_spend.month_used_usd > API_SPEND_MONTHLY_ALERT_USD) {
    alerts.push(`API spend this month: $${api_spend.month_used_usd.toFixed(2)} (threshold $${API_SPEND_MONTHLY_ALERT_USD})`);
  }
  if (newSites.length > 0) {
    alerts.push(`${newSites.length} NEW API-risk call site(s) since baseline`);
  }
  if (bypass > 0) {
    alerts.push(`${bypass} call site(s) classified as BYPASS — review and patch`);
  }
  if (subscription.five_hour_pct !== null && subscription.five_hour_pct > SUB_USAGE_ALERT_PCT) {
    alerts.push(`Subscription 5h window at ${subscription.five_hour_pct}% (threshold ${SUB_USAGE_ALERT_PCT}%)`);
  }

  return {
    snapshot: {
      ts: new Date().toISOString(),
      subscription,
      api_spend,
      call_sites: { total: sites.length, bypass, legit, new_since_baseline: newSites },
      alerts,
    },
    sites,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Voice alert via Pulse
// ──────────────────────────────────────────────────────────────────────────

async function voiceAlert(message: string): Promise<void> {
  try {
    await fetch(`${PULSE_BASE}/notify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Cadence job: silent banner only — scheduled tasks never voice (2026-08-14)
      body: JSON.stringify({ message, voice_enabled: false }),
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    // Pulse may be down — log to stderr instead
    console.error(`[CostTracker] alert (voice unavailable): ${message}`);
  }
}

// ──────────────────────────────────────────────────────────────────────────
// CLI
// ──────────────────────────────────────────────────────────────────────────

function formatStatus(snap: CostSnapshot): string {
  const lines: string[] = [];
  lines.push(`═══ LifeOS Anthropic Cost — ${snap.ts} ═══`);
  lines.push(``);
  lines.push(`Subscription (OAuth):`);
  lines.push(`  5h window:   ${snap.subscription.five_hour_pct ?? "unknown"}%`);
  lines.push(`  7d window:   ${snap.subscription.seven_day_pct ?? "unknown"}%`);
  lines.push(``);
  lines.push(`API Spend (month to date):`);
  if (snap.api_spend.month_used_usd !== null) {
    lines.push(`  $${snap.api_spend.month_used_usd.toFixed(2)}  (from ${snap.api_spend.source})`);
  } else {
    lines.push(`  unknown  (ANTHROPIC_ADMIN_API_KEY not set)`);
  }
  lines.push(``);
  lines.push(`Call Sites (LifeOS-local risk surface):`);
  lines.push(`  total:   ${snap.call_sites.total}`);
  lines.push(`  bypass:  ${snap.call_sites.bypass}   ← should NOT bill API`);
  lines.push(`  legit:   ${snap.call_sites.legit}   ← CF Workers / opt-in`);
  if (snap.call_sites.new_since_baseline.length > 0) {
    lines.push(``);
    lines.push(`NEW since baseline:`);
    for (const s of snap.call_sites.new_since_baseline) lines.push(`  + ${s}`);
  }
  lines.push(``);
  if (snap.alerts.length === 0) {
    lines.push(`✅ No alerts`);
  } else {
    lines.push(`🚨 Alerts:`);
    for (const a of snap.alerts) lines.push(`  ! ${a}`);
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? "status";
  mkdirSync(OBS_DIR, { recursive: true });

  switch (cmd) {
    case "status": {
      const { snapshot } = await takeSnapshot();
      console.log(formatStatus(snapshot));
      break;
    }
    case "scan": {
      const { sites, failures } = scanCallSites();
      if (failures.length > 0) {
        console.error(describeFailures(failures));
        for (const f of failures) console.error(`  ${f.root} [${f.pattern}]: ${f.reason}`);
        process.exitCode = 2;
      }
      console.log(`Found ${sites.length} potential API-billing call site(s):`);
      console.log(``);
      for (const s of sites) {
        const icon = s.classification === "bypass" ? "🔴" : s.classification === "legit" ? "✅" : "❓";
        console.log(`${icon} ${s.file}:${s.line}`);
        console.log(`   ${s.reason}`);
      }
      break;
    }
    case "log": {
      const { snapshot } = await takeSnapshot();
      appendFileSync(LEDGER_PATH, JSON.stringify(snapshot) + "\n");
      console.log(`Logged snapshot to ${LEDGER_PATH.replace(HOME, "~")}`);
      const bill = await logOpenAiBill();
      console.log(bill.usd === null ? `OpenAI bill unread: ${bill.reason}` : `OpenAI bill this month: $${bill.usd.toFixed(2)}`);
      if (snapshot.alerts.length > 0) {
        for (const a of snapshot.alerts) console.log(`  🚨 ${a}`);
      }
      break;
    }
    case "alert-check": {
      const { snapshot } = await takeSnapshot();
      if (snapshot.alerts.length === 0) {
        console.log("No alerts.");
        return;
      }
      const message = `LifeOS cost alert: ${snapshot.alerts.join("; ")}`;
      await voiceAlert(message);
      console.log(message);
      break;
    }
    case "baseline": {
      const { sites, failures } = scanCallSites();
      // A baseline written from a partial scan would bless a hole as "no call sites".
      invariant(failures.length === 0, `refusing to write baseline from an incomplete scan: ${failures[0]?.root} ${failures[0]?.reason}`);
      writeBaseline(sites);
      console.log(`Baseline written: ${sites.length} call site(s) at ${CALL_SITES_PATH.replace(HOME, "~")}`);
      console.log(`  bypass: ${sites.filter((s) => s.classification === "bypass").length}`);
      console.log(`  legit:  ${sites.filter((s) => s.classification === "legit").length}`);
      console.log(`  unknown:${sites.filter((s) => s.classification === "unknown").length}`);
      break;
    }
    default:
      console.error(`Usage: bun CostTracker.ts <status|scan|log|alert-check|baseline>`);
      process.exit(1);
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`[CostTracker] fatal: ${(err as Error).message}`);
    process.exit(1);
  });
}
