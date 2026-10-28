#!/usr/bin/env bun
/**
 * PulseFreshness — Pulse-wide staleness sweep.
 *
 * Probes every read-only Pulse tab API, extracts each payload's freshness
 * blocks (the {tier, daysOld, label} objects computeFreshness emits), and
 * reports every non-fresh surface. This is the deterministic answer to
 * "every tab must be accurate and current": staleness surfaces itself.
 *
 * Usage:
 *   bun LIFEOS/TOOLS/PulseFreshness.ts            # human table, exit 1 if any stale, exit 2 if any probe failed
 *   bun LIFEOS/TOOLS/PulseFreshness.ts --json     # machine output
 *   bun LIFEOS/TOOLS/PulseFreshness.ts --max-days 45   # override stale threshold report filter
 *
 * A probe that errors, times out, returns non-2xx or returns unparseable JSON is not "fresh": the run
 * reports itself incomplete and exits 2 (stale wins with 1), and never prints the all-fresh line.
 *
 * Wire-ins: /ic (advisory row) and any cadence job. Headless-safe: no voice,
 * no browser — pure HTTP against localhost Pulse.
 */
const BASE = process.env.PULSE_BASE ?? "http://localhost:31337";
const TIMEOUT_MS = 10_000;

// Read-only tab payload endpoints. Mutating/regenerating endpoints excluded.
const ENDPOINTS = [
  "/api/achilles",
  "/api/algorithm-tab",
  "/api/atlas",
  "/api/books",
  "/api/bunker",
  "/api/content",
  "/api/evals",
  "/api/house",
  "/api/ledger",
  "/api/life/air",
  "/api/life/business",
  "/api/life/finances",
  "/api/life/growth",
  "/api/life/health",
  "/api/life/work",
  "/api/memory",
  "/api/projects",
  "/api/synapse",
  "/api/upgrades",
];

export interface FreshHit { endpoint: string; path: string; tier: string; days: number; label?: string }

export function findFreshness(o: unknown, path: string, out: FreshHit[], endpoint: string, depth: number): void {
  if (depth > 6 || !o || typeof o !== "object") return;
  const obj = o as Record<string, unknown>;
  if (typeof obj.tier === "string" && obj.daysOld !== undefined) {
    out.push({ endpoint, path, tier: String(obj.tier), days: Number(obj.daysOld), label: obj.label as string | undefined });
    return;
  }
  for (const [k, v] of Object.entries(obj)) {
    if (v && typeof v === "object") findFreshness(v, path ? `${path}.${k}` : k, out, endpoint, depth + 1);
  }
}

export interface ProbeResult { endpoint: string; status: string; hits: FreshHit[] }

/** Probe every endpoint. Any failure to fetch or parse is recorded as a non-"ok" status, never skipped. */
export async function probeAll(base: string, endpoints: readonly string[], fetchImpl: typeof fetch = fetch, timeoutMs = TIMEOUT_MS): Promise<ProbeResult[]> {
  const results: ProbeResult[] = [];
  for (const ep of endpoints) {
    try {
      const r = await fetchImpl(base + ep, { signal: AbortSignal.timeout(timeoutMs) });
      if (!r.ok) { results.push({ endpoint: ep, status: `HTTP ${r.status}`, hits: [] }); continue; }
      const j = await r.json();
      const hits: FreshHit[] = [];
      findFreshness(j, "", hits, ep, 0);
      results.push({ endpoint: ep, status: "ok", hits });
    } catch (e) {
      results.push({ endpoint: ep, status: `ERR ${String(e).slice(0, 60)}`, hits: [] });
    }
  }
  return results;
}

export interface Verdict { stale: FreshHit[]; errors: ProbeResult[]; exitCode: 0 | 1 | 2 }

/** Stale beats incomplete (1), incomplete beats clean (2): a probe that could not be evaluated is never a pass. */
export function verdict(results: ProbeResult[], maxDays: number | null): Verdict {
  const stale = results.flatMap(r => r.hits.filter(h => h.tier !== "fresh" && (maxDays === null || h.days >= maxDays)));
  const errors = results.filter(r => r.status !== "ok");
  return { stale, errors, exitCode: stale.length > 0 ? 1 : errors.length > 0 ? 2 : 0 };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const asJson = args.includes("--json");
  const maxDaysIdx = args.indexOf("--max-days");
  const maxDays = maxDaysIdx >= 0 ? Number(args[maxDaysIdx + 1]) : null;

  const results = await probeAll(BASE, ENDPOINTS);
  const { stale, errors, exitCode } = verdict(results, maxDays);

  if (asJson) {
    console.log(JSON.stringify({ probed: results.length, complete: errors.length === 0, stale, errors: errors.map(e => ({ endpoint: e.endpoint, status: e.status })) }, null, 1));
  } else {
    console.log(`PulseFreshness — probed ${results.length} endpoints`);
    if (stale.length === 0 && errors.length === 0) console.log("  all freshness blocks report fresh");
    for (const h of stale) console.log(`  STALE  ${h.endpoint}  ${h.path}  ${h.tier} (${h.days}d${h.label ? `, ${h.label}` : ""})`);
    for (const e of errors) console.log(`  ${e.status.startsWith("HTTP 404") ? "no-endpoint" : "ERROR"}  ${e.endpoint}  ${e.status}`);
    if (errors.length > 0) console.log(`  INCOMPLETE: ${errors.length} of ${results.length} probes could not be evaluated; freshness is unknown, not fresh`);
  }

  process.exit(exitCode);
}
