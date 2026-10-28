/**
 * UsageOverage — estimate how far past the Claude 5-hour limit the account is,
 * from usage-credit dollars burned since the cap.
 *
 * Method: when five_hour.utilization >= 100 and extra usage is enabled, credits burned since the
 * first capped read (B) are real dollars spent beyond the plan. The window's transcript cost (C,
 * priced from models.ts) covers plan + overage, so plan-covered work W = C - B and the estimate
 * is 100 * (W + B) / W.
 *
 * @version 1.0.1
 */
import { chmodSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { invariant } from "./Invariant.ts";
import { pricingFor } from "./models.ts";
import { getClaudeDir } from "./Paths.ts";

export interface Est5h { pct: number | null; label: string | null; burnedUsd: number }

const FIVE_H_MS = 5 * 3600_000;
const COST_TTL_MS = 5 * 60_000;

function cacheDir(): string {
  return join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "lifeos-statusline");
}

/** `5H:<round(epochSec/60)>` so sub-second jitter in resets_at maps to one key. */
export function capKey(window: string, resetsAtIso: string): string {
  const ms = Date.parse(resetsAtIso);
  invariant(Number.isFinite(ms), `capKey: unparsable resets_at ${resetsAtIso}`);
  return `${window}:${Math.round(ms / 1000 / 60)}`;
}

export function overageEstimate(costUsd: number | null, burnedUsd: number): number | null {
  if (costUsd == null || !Number.isFinite(costUsd) || costUsd <= 0) return null;
  if (costUsd <= burnedUsd) return null;
  const w = costUsd - burnedUsd;
  if (w < 5) return null;
  return Math.round((100 * (w + burnedUsd)) / w);
}

function labelFor(pct: number): string {
  return pct > 999 ? ">999%" : `~${pct}%`;
}

function readJson(p: string): any {
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; }
}

function atomicWrite(path: string, data: unknown): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

function walkJsonl(root: string, minMtimeMs: number, out: string[]): void {
  let entries;
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = join(root, e.name);
    if (e.isDirectory()) walkJsonl(p, minMtimeMs, out);
    else if (e.isFile() && e.name.endsWith(".jsonl")) {
      try { if (statSync(p).mtimeMs >= minMtimeMs) out.push(p); } catch { /* skip */ }
    }
  }
}

type Rates = { input: number; output: number; cacheRead: number; cacheWrite5m: number; cacheWrite1h: number };

/** Mirrors UsageAggregator.messageCost, but with the PriceMatch rates and no fallback price. */
function msgCost(p: Rates, u: any): number {
  const inp = u.input_tokens || 0, out = u.output_tokens || 0, cr = u.cache_read_input_tokens || 0, cw = u.cache_creation_input_tokens || 0;
  const cw5 = u.cache_creation?.ephemeral_5m_input_tokens ?? 0;
  const cw1 = u.cache_creation?.ephemeral_1h_input_tokens ?? (cw - cw5);
  return (inp * p.input + out * p.output + cr * p.cacheRead + cw5 * p.cacheWrite5m + cw1 * p.cacheWrite1h) / 1_000_000;
}

export function windowCost(
  resetsAtIso: string,
  opts: { projectsRoot?: string; nowMs?: number; cacheDir?: string } = {},
): { usd: number; unknownModel: boolean } {
  const dir = opts.cacheDir ?? cacheDir();
  const now = opts.nowMs ?? Date.now();
  const key = capKey("5H", resetsAtIso);
  const cachePath = join(dir, "overage-cost.json");
  const hit = readJson(cachePath);
  if (hit && hit.key === key && typeof hit.usd === "number" && typeof hit.atMs === "number" && now - hit.atMs >= 0 && now - hit.atMs < COST_TTL_MS) {
    return { usd: hit.usd, unknownModel: hit.unknownModel === true };
  }

  const resetMs = Date.parse(resetsAtIso);
  const startMs = resetMs - FIVE_H_MS;
  const root = opts.projectsRoot ?? join(getClaudeDir(), "projects");
  const files: string[] = [];
  walkJsonl(root, startMs, files);

  const byReq = new Map<string, number>();
  let anon = 0;
  let unknownModel = false;
  for (const f of files) {
    let text: string;
    try { text = readFileSync(f, "utf8"); } catch { continue; }
    for (const line of text.split("\n")) {
      if (!line.includes('"usage"')) continue;
      let r: any;
      try { r = JSON.parse(line); } catch { continue; }
      if (r?.type !== "assistant" && r?.message?.role !== "assistant") continue;
      const m = r.message;
      const u = m?.usage;
      if (!u) continue;
      const t = Date.parse(r.timestamp);
      if (!Number.isFinite(t) || t < startMs || t > now) continue;
      const model: string = m.model ?? "";
      if (!model || model === "<synthetic>") continue;
      const price = pricingFor(model);
      if (!price) { unknownModel = true; continue; }
      const cost = msgCost(price.pricing, u);
      const id: string | undefined = r.requestId ?? m.id;
      const k = id ?? `anon:${anon++}`;
      byReq.set(k, Math.max(byReq.get(k) ?? 0, cost)); // streamed duplicates: keep the final (largest) line
    }
  }
  let usd = 0;
  for (const c of byReq.values()) usd += c;
  usd = Math.round(usd * 1e6) / 1e6;

  invariant(Number.isFinite(usd) && usd >= 0, `windowCost: bad total ${usd}`);
  try {
    mkdirSync(dir, { recursive: true });
    atomicWrite(cachePath, { key, atMs: now, usd, unknownModel });
  } catch { /* cache is best-effort */ }
  return { usd, unknownModel };
}

export function overage5h(
  usage: unknown,
  opts: { dir?: string; projectsRoot?: string; nowMs?: number } = {},
): Est5h | null {
  const u = usage as any;
  const five = u?.five_hour;
  const extra = u?.extra_usage;
  if (!five || typeof five.utilization !== "number" || five.utilization < 100) return null;
  if (extra?.is_enabled !== true) return null;
  if (typeof five.resets_at !== "string" || !Number.isFinite(Date.parse(five.resets_at))) return null;

  const dir = opts.dir ?? cacheDir();
  const used = extra.used_credits;
  if (typeof used !== "number" || !Number.isFinite(used)) return { pct: null, label: null, burnedUsd: 0 };

  const key = capKey("5H", five.resets_at);
  const basePath = join(dir, "usage-cap-v2.json");
  const base = readJson(basePath);
  let baseline: number;
  if (base && base.key === key && typeof base.usedCents === "number" && Number.isFinite(base.usedCents)) {
    baseline = base.usedCents;
  } else {
    baseline = used;
    invariant(typeof key === "string" && key.length > 0 && Number.isFinite(baseline), "overage5h: bad baseline");
    mkdirSync(dir, { recursive: true });
    atomicWrite(basePath, { key, usedCents: baseline });
  }
  const burnedUsd = Math.round(Math.max(0, used - baseline)) / 100;

  const wc = windowCost(five.resets_at, { projectsRoot: opts.projectsRoot, nowMs: opts.nowMs, cacheDir: dir });
  if (wc.unknownModel) return { pct: null, label: null, burnedUsd };
  const pct = overageEstimate(wc.usd, burnedUsd);
  return { pct, label: pct == null ? null : labelFor(pct), burnedUsd };
}

/** The bash statusline's read, `<label>|<burned dollars>`, empty below the cap. */
export function overageLine(usage: unknown, opts: { dir?: string; projectsRoot?: string; nowMs?: number } = {}): string {
  const e = overage5h(usage, opts);
  return e ? `${e.label ?? ""}|${Math.round(e.burnedUsd)}` : "";
}

/** `bun UsageOverage.ts --line`: prints overageLine for the cached usage payload. */
if (import.meta.main && process.argv.includes("--line")) {
  console.log(overageLine(readJson(join(cacheDir(), "usage.json"))));
}
