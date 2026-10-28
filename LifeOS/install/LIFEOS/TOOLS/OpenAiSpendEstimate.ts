/**
 * OpenAiSpendEstimate.ts — this month's OpenAI spend: the real bill from OpenAI's organization Costs API, and our own
 * estimate for when that bill cannot be read (no working OPENAI_ADMIN_API_KEY, which not every account can create).
 *
 * The bill (buildOpenAiSpend), grounded on openai/openai-openapi (GET /v1/organization/costs, AdminApiKeyAuth):
 *   page -> data[] buckets -> results[] { amount:{value,currency}, line_item, project_id }
 *   params: start_time (unix, required), bucket_width=1d, project_ids[], group_by=line_item, limit 1..180
 * It degrades to {source:"unavailable"} whenever the admin key is absent or the call fails and never throws, so a cost
 * outage cannot take down a caller. The admin key is read from env, sent only as a Bearer header, never placed in a
 * URL, argument, or log.
 *
 * The estimate (estimateOpenAiMonth), priced from vendor-pricing.json ($/MTok), has two sources:
 *   - MEMORY/OBSERVABILITY/openai-usage.jsonl: every API-billed OpenAI call LifeOS makes locally
 *   - cloud runs this install's private extension reports (loadCloudRuns): a run's own cost_usd when present, else
 *     its token usage priced at its executed model's input/output rate; an install without the extension has none
 * Anything OpenAI bills that neither source sees (another key's cloud worker) is outside the estimate, so it is a
 * floor, never the bill. Read-only: no invariants.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// ── The bill: OpenAI organization Costs API ──

export interface OpenAiSpendLineItem { line_item: string; usd: number }
export interface OpenAiSpendDay { date: string; usd: number }
export interface OpenAiSpend {
  source: "admin_key" | "unavailable";
  reason?: string;
  currency: "usd";
  project_id: string | null;
  window: { start: string; end: string; days: number };
  total_usd: number;
  by_day: OpenAiSpendDay[];
  by_line_item: OpenAiSpendLineItem[];
  fetched_at: string;
}
/** `projectId` narrows the bill to one OpenAI project; absent or empty reads every project in the organization. */
export interface OpenAiSpendConfig { adminKey?: string; projectId?: string; days?: number }
export interface OpenAiSpendDeps { config?: OpenAiSpendConfig; fetch?: typeof fetch; now?: () => number }

export const ADMIN_KEY_ENV = "OPENAI_ADMIN_API_KEY";
const COSTS_URL = "https://api.openai.com/v1/organization/costs";
const MAX_DAYS = 180; // API caps buckets at 180
const DAY_MS = 86_400_000;

function round(n: number): number { return Math.round(n * 1e6) / 1e6; }

function unavailable(now: number, projectId: string | null, days: number, reason: string): OpenAiSpend {
  return {
    source: "unavailable", reason, currency: "usd", project_id: projectId,
    window: { start: new Date(now - days * DAY_MS).toISOString(), end: new Date(now).toISOString(), days },
    total_usd: 0, by_day: [], by_line_item: [], fetched_at: new Date(now).toISOString(),
  };
}

export async function buildOpenAiSpend(deps: OpenAiSpendDeps = {}): Promise<OpenAiSpend> {
  const now = (deps.now ?? Date.now)();
  const adminKey = deps.config?.adminKey ?? process.env[ADMIN_KEY_ENV];
  const projectId = deps.config?.projectId ?? null;
  let days = deps.config?.days ?? 30;
  if (!Number.isSafeInteger(days) || days < 1) days = 30;
  if (days > MAX_DAYS) days = MAX_DAYS;
  if (!adminKey || /[\r\n]/.test(adminKey)) return unavailable(now, projectId, days, `no ${ADMIN_KEY_ENV}`);

  const doFetch = deps.fetch ?? fetch;
  const headers = { Authorization: `Bearer ${adminKey}`, "Content-Type": "application/json" };
  try {
    // 1d buckets align to UTC midnight; ask for `days` buckets ending today.
    const startDay = new Date(now - (days - 1) * DAY_MS);
    startDay.setUTCHours(0, 0, 0, 0);
    const startSec = Math.floor(startDay.getTime() / 1000);
    const base = new URL(COSTS_URL);
    base.searchParams.set("start_time", String(startSec));
    base.searchParams.set("bucket_width", "1d");
    base.searchParams.set("limit", String(days));
    base.searchParams.set("group_by", "line_item");
    if (projectId) base.searchParams.append("project_ids", projectId);

    const buckets: any[] = [];
    let url = base.toString();
    for (let guard = 0; guard < 12; guard++) {
      const resp = await doFetch(url, { headers, redirect: "error", signal: AbortSignal.timeout(10_000), cache: "no-store" });
      if (!resp.ok) { await resp.body?.cancel?.(); return unavailable(now, projectId, days, `HTTP ${resp.status}`); }
      const page: any = await resp.json();
      if (!page || !Array.isArray(page.data)) break;
      buckets.push(...page.data);
      if (buckets.length > 400 || !page.has_more || typeof page.next_page !== "string" || !page.next_page) break;
      const next = new URL(base.toString());
      next.searchParams.set("page", page.next_page);
      url = next.toString();
    }

    const by_day: OpenAiSpendDay[] = [];
    const lineMap = new Map<string, number>();
    let total = 0;
    for (const b of buckets) {
      if (!b || !Array.isArray(b.results)) continue;
      const startTime = Number(b.start_time);
      const date = Number.isFinite(startTime) ? new Date(startTime * 1000).toISOString().slice(0, 10) : "unknown";
      let dayUsd = 0;
      for (const res of b.results) {
        if (res?.amount?.currency && res.amount.currency !== "usd") continue;
        const v = Number(res?.amount?.value);
        if (!Number.isFinite(v) || v < 0) continue;
        dayUsd += v; total += v;
        const li = typeof res?.line_item === "string" && res.line_item ? res.line_item : "unlabeled";
        lineMap.set(li, (lineMap.get(li) ?? 0) + v);
      }
      by_day.push({ date, usd: round(dayUsd) });
    }
    const by_line_item = [...lineMap.entries()]
      .map(([line_item, usd]) => ({ line_item, usd: round(usd) }))
      .sort((a, b) => b.usd - a.usd);

    return {
      source: "admin_key", currency: "usd", project_id: projectId,
      window: { start: new Date(startSec * 1000).toISOString(), end: new Date(now).toISOString(), days },
      total_usd: round(total), by_day, by_line_item, fetched_at: new Date(now).toISOString(),
    };
  } catch {
    return unavailable(now, projectId, days, "fetch failed");
  }
}

// ── The estimate: our own records ──

export type Price = { input: number; cachedInput?: number; output: number };
export type Pricing = Record<string, Price>;
export type UsageRow = { ts?: string; model?: string; input?: number; output?: number; cached?: number };
/** One cloud run that billed OpenAI outside the local usage log. */
export type CloudRun = {
  updated_at?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
  models?: { executed_model?: string; requested_model?: string; configured_model?: string }[];
  cost_usd?: number | null;
};
export interface SpendEstimate { usd: number; localUsd: number; cloudUsd: number; unpricedCalls: number; unpricedModels: string[] }

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

/** Cost of one logged call: uncached input, cached input, then output (reasoning is inside output). */
export function rowCost(r: UsageRow, p: Price): number {
  const cached = Math.min(num(r.cached), num(r.input));
  return ((num(r.input) - cached) * p.input + cached * (p.cachedInput ?? p.input) + num(r.output) * p.output) / 1e6;
}

export function estimateOpenAiMonth(month: string, rows: UsageRow[], runs: CloudRun[], pricing: Pricing): SpendEstimate {
  let localUsd = 0, cloudUsd = 0, unpricedCalls = 0;
  const unpriced = new Set<string>();
  for (const r of rows) {
    if (!String(r.ts ?? "").startsWith(month)) continue;
    const p = r.model ? pricing[r.model] : undefined;
    if (!p) { unpricedCalls++; unpriced.add(r.model ?? "unknown"); continue; }
    localUsd += rowCost(r, p);
  }
  for (const run of runs) {
    if (!String(run.updated_at ?? "").startsWith(month)) continue;
    if (typeof run.cost_usd === "number" && Number.isFinite(run.cost_usd) && run.cost_usd >= 0) { cloudUsd += run.cost_usd; continue; }
    const tokens = num(run.usage?.input_tokens) + num(run.usage?.output_tokens);
    if (!tokens) continue;
    const m = run.models?.[0];
    const model = m?.executed_model ?? m?.requested_model ?? m?.configured_model;
    const p = model ? pricing[model] : undefined;
    if (!p) { unpricedCalls++; unpriced.add(model ?? "unknown"); continue; }
    cloudUsd += rowCost({ input: run.usage?.input_tokens, output: run.usage?.output_tokens }, p);
  }
  return { usd: localUsd + cloudUsd, localUsd, cloudUsd, unpricedCalls, unpricedModels: [...unpriced].sort() };
}

export function loadPricing(toolsDir: string): Pricing {
  return (JSON.parse(readFileSync(join(toolsDir, "vendor-pricing.json"), "utf8")) as { models: Pricing }).models;
}

export function loadUsageRows(path: string, month: string): UsageRow[] {
  let text = "";
  try { text = readFileSync(path, "utf8"); } catch { return []; }
  const out: UsageRow[] = [];
  for (const line of text.split("\n")) {
    if (!line.includes(`"ts":"${month}`)) continue;
    try { out.push(JSON.parse(line)); } catch { /* a torn line is skipped */ }
  }
  return out;
}

/** The private extension's file name; the release never ships it. */
export const SPEND_PRIVATE_FILE = "OpenAiSpendPrivate.ts";

/**
 * Cloud runs from this install's private extension (OpenAiSpendPrivate.ts beside this file, or in
 * LIFEOS_PRIVATE_EXTENSION_DIR), or none when the install has no extension. The extension owns its own
 * unreachable-source handling; a broken extension fails loudly instead of quietly dropping its runs.
 */
export async function loadCloudRuns(dir: string = process.env.LIFEOS_PRIVATE_EXTENSION_DIR || import.meta.dir): Promise<CloudRun[]> {
  const file = join(dir, SPEND_PRIVATE_FILE);
  if (!existsSync(file)) return [];
  const ext = (await import(file)) as { loadRuns?: () => Promise<CloudRun[]> };
  if (typeof ext.loadRuns !== "function") throw new Error(`${file} does not export loadRuns()`);
  const runs = await ext.loadRuns();
  return Array.isArray(runs) ? runs : [];
}
