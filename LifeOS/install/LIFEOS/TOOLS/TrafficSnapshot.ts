#!/usr/bin/env bun
/**
 * @version 1.0.1
 * TrafficSnapshot.ts — what a zone and its Worker actually saw, as one JSON.
 *
 * The first stage of Bunker's code sweep (the white-box leg of the security
 * plane) and a general `cloud-management skill` Query tool: top request paths, WAF events,
 * Worker invocation counts, and the zone's active custom firewall rules.
 *
 * Every dataset degrades on its own. Cloudflare gates several analytics
 * datasets by plan (a Free zone gets `authz` on firewallEventsAdaptiveGroups,
 * verified 2026-09-03), so each block is either `{ available: true, rows }` or
 * `{ available: false, reason }` and the tool never throws on a plan gate.
 * Consumers rank on what they have.
 *
 * Usage:
 *   bun TrafficSnapshot.ts --zone example.com [--script my-worker] [--hours 24] [--top 50] [--json]
 *
 * Auth: CLOUDFLARE_API_TOKEN (+ CLOUDFLARE_ACCOUNT_ID for Worker analytics) from
 * the environment, else the LifeOS .env via the normal dotenv path. Never printed.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getClaudeDir } from "./Paths";

const API = "https://api.cloudflare.com/client/v4";

export interface Dataset<T> { available: boolean; reason?: string; rows: T[] }
export interface PathRow { path: string; method: string; count: number }
export interface FirewallRow { path: string; action: string; ruleId: string; source: string; count: number }
export interface WorkerRow { scriptName: string; status: string; requests: number; errors: number }
export interface CustomRule { id: string; description: string; expression: string; action: string; enabled: boolean }

export interface Snapshot {
  zone: string;
  zoneId: string | null;
  script: string | null;
  window_hours: number;
  taken_at: string;
  paths: Dataset<PathRow>;
  firewall: Dataset<FirewallRow>;
  worker: Dataset<WorkerRow>;
  customRules: Dataset<CustomRule>;
}

interface GqlError { message?: string; extensions?: { code?: string } }

/** Classify a GraphQL response body into a Dataset. Pure — tested. */
export function classifyGql<T>(body: unknown, pick: (data: any) => T[] | undefined): Dataset<T> {
  const b = body as { data?: any; errors?: GqlError[] } | null;
  if (!b || typeof b !== "object") return { available: false, reason: "no response body", rows: [] };
  const errs = Array.isArray(b.errors) ? b.errors : [];
  if (errs.length) {
    const code = errs[0]?.extensions?.code ?? "error";
    const msg = errs[0]?.message ?? "unknown";
    const reason = code === "authz" ? `plan-gated (${msg.slice(0, 80)})` : `${code}: ${msg.slice(0, 120)}`;
    return { available: false, reason, rows: [] };
  }
  let rows: T[] | undefined;
  try { rows = pick(b.data); } catch { rows = undefined; }
  if (!rows) return { available: false, reason: "dataset absent from response", rows: [] };
  return { available: true, rows };
}

/** Classify a REST envelope into a Dataset. Pure — tested. */
export function classifyRest<T>(body: unknown, pick: (result: any) => T[] | undefined): Dataset<T> {
  const b = body as { success?: boolean; errors?: { code?: number; message?: string }[]; result?: any } | null;
  if (!b || typeof b !== "object") return { available: false, reason: "no response body", rows: [] };
  if (b.success === false) {
    const e = b.errors?.[0];
    return { available: false, reason: `${e?.code ?? "error"}: ${(e?.message ?? "unknown").slice(0, 120)}`, rows: [] };
  }
  let rows: T[] | undefined;
  try { rows = pick(b.result); } catch { rows = undefined; }
  if (!rows) return { available: false, reason: "result absent", rows: [] };
  return { available: true, rows };
}

function loadEnv(): { token: string | null; account: string | null } {
  const env = { ...process.env } as Record<string, string | undefined>;
  if (!env.CLOUDFLARE_API_TOKEN) {
    const p = join(getClaudeDir(), ".env");
    if (existsSync(p)) {
      for (const line of readFileSync(p, "utf8").split("\n")) {
        const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
        if (!m) continue;
        const v = m[2].replace(/^["']|["']$/g, "");
        if (env[m[1]] === undefined) env[m[1]] = v;
      }
    }
  }
  return { token: env.CLOUDFLARE_API_TOKEN ?? null, account: env.CLOUDFLARE_ACCOUNT_ID ?? null };
}

async function gql(token: string, query: string): Promise<unknown> {
  const r = await fetch(`${API}/graphql`, {
    signal: AbortSignal.timeout(30_000),
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  try { return await r.json(); } catch { return { errors: [{ message: `http ${r.status}` }] }; }
}

async function rest(token: string, path: string): Promise<unknown> {
  const r = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) });
  try { return await r.json(); } catch { return { success: false, errors: [{ message: `http ${r.status}` }] }; }
}

export async function takeSnapshot(opts: { zone: string; script?: string; hours?: number; top?: number }): Promise<Snapshot> {
  const { token, account } = loadEnv();
  const hours = opts.hours ?? 24;
  const top = opts.top ?? 50;
  const now = new Date();
  const since = new Date(now.getTime() - hours * 3600_000);
  const unavailable = <T,>(reason: string): Dataset<T> => ({ available: false, reason, rows: [] });
  const snap: Snapshot = {
    zone: opts.zone, zoneId: null, script: opts.script ?? null, window_hours: hours, taken_at: now.toISOString(),
    paths: unavailable("not attempted"), firewall: unavailable("not attempted"),
    worker: unavailable("not attempted"), customRules: unavailable("not attempted"),
  };
  if (!token) {
    const r = "CLOUDFLARE_API_TOKEN missing";
    snap.paths = unavailable(r); snap.firewall = unavailable(r); snap.worker = unavailable(r); snap.customRules = unavailable(r);
    return snap;
  }

  const zones = classifyRest<{ id: string }>(await rest(token, `/zones?name=${encodeURIComponent(opts.zone)}`), (res) => res);
  const zoneId = zones.rows[0]?.id ?? null;
  snap.zoneId = zoneId;
  if (!zoneId) {
    const r = zones.available ? `zone ${opts.zone} not found in this account` : `zone lookup failed: ${zones.reason}`;
    snap.paths = unavailable(r); snap.firewall = unavailable(r); snap.customRules = unavailable(r);
  } else {
    const t = { geq: since.toISOString(), leq: now.toISOString() };
    const pathsQ = `{ viewer { zones(filter:{zoneTag:"${zoneId}"}) { g: httpRequestsAdaptiveGroups(limit:${top}, filter:{datetime_geq:"${t.geq}", datetime_leq:"${t.leq}"}, orderBy:[count_DESC]) { count dimensions { clientRequestPath clientRequestHTTPMethodName } } } } }`;
    const fwQ = `{ viewer { zones(filter:{zoneTag:"${zoneId}"}) { g: firewallEventsAdaptiveGroups(limit:${top}, filter:{datetime_geq:"${t.geq}", datetime_leq:"${t.leq}"}, orderBy:[count_DESC]) { count dimensions { clientRequestPath action ruleId source } } } } }`;
    const [pathsBody, fwBody, rulesBody] = await Promise.all([
      gql(token, pathsQ),
      gql(token, fwQ),
      rest(token, `/zones/${zoneId}/rulesets/phases/http_request_firewall_custom/entrypoint`),
    ]);
    snap.paths = classifyGql<PathRow>(pathsBody, (d) => d?.viewer?.zones?.[0]?.g?.map((r: any) => ({
      path: String(r.dimensions?.clientRequestPath ?? ""), method: String(r.dimensions?.clientRequestHTTPMethodName ?? ""), count: Number(r.count ?? 0),
    })));
    snap.firewall = classifyGql<FirewallRow>(fwBody, (d) => d?.viewer?.zones?.[0]?.g?.map((r: any) => ({
      path: String(r.dimensions?.clientRequestPath ?? ""), action: String(r.dimensions?.action ?? ""),
      ruleId: String(r.dimensions?.ruleId ?? ""), source: String(r.dimensions?.source ?? ""), count: Number(r.count ?? 0),
    })));
    snap.customRules = classifyRest<CustomRule>(rulesBody, (res) => {
      // A zone with no custom ruleset yet returns success with no rules; that is an available, empty set.
      const rules = Array.isArray(res?.rules) ? res.rules : [];
      return rules.map((r: any) => ({
        id: String(r.id ?? ""), description: String(r.description ?? ""), expression: String(r.expression ?? ""),
        action: String(r.action ?? ""), enabled: r.enabled !== false,
      }));
    });
    // A 404 on the entrypoint means "no custom rules yet", not a failure to read.
    if (!snap.customRules.available && /^10003:|could not find|not found|404/i.test(snap.customRules.reason ?? "")) snap.customRules = { available: true, rows: [] };
  }

  if (opts.script) {
    if (!account) snap.worker = unavailable("CLOUDFLARE_ACCOUNT_ID missing");
    else {
      const wQ = `{ viewer { accounts(filter:{accountTag:"${account}"}) { g: workersInvocationsAdaptive(limit:20, filter:{datetime_geq:"${since.toISOString()}", datetime_leq:"${now.toISOString()}", scriptName:"${opts.script}"}) { sum { requests errors } dimensions { scriptName status } } } } }`;
      snap.worker = classifyGql<WorkerRow>(await gql(token, wQ), (d) => d?.viewer?.accounts?.[0]?.g?.map((r: any) => ({
        scriptName: String(r.dimensions?.scriptName ?? ""), status: String(r.dimensions?.status ?? ""),
        requests: Number(r.sum?.requests ?? 0), errors: Number(r.sum?.errors ?? 0),
      })));
    }
  }
  return snap;
}

export function summarize(s: Snapshot): string {
  const line = (name: string, d: Dataset<unknown>) => `${d.available ? "✓" : "✗"} ${name}: ${d.available ? `${d.rows.length} rows` : d.reason}`;
  const out = [`Traffic snapshot — ${s.zone} (${s.zoneId ?? "no zone id"}) · last ${s.window_hours}h · ${s.taken_at}`,
    line("paths", s.paths), line("firewall", s.firewall), line("worker", s.worker), line("customRules", s.customRules)];
  if (s.paths.available) for (const r of s.paths.rows.slice(0, 15)) out.push(`  ${String(r.count).padStart(7)}  ${r.method.padEnd(6)} ${r.path}`);
  if (s.firewall.available) for (const r of s.firewall.rows.slice(0, 10)) out.push(`  ⚔ ${String(r.count).padStart(5)}  ${r.action.padEnd(12)} ${r.path}  (${r.source}/${r.ruleId})`);
  return out.join("\n");
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const flag = (n: string) => { const i = argv.indexOf(`--${n}`); return i !== -1 ? argv[i + 1] : undefined; };
  const zone = flag("zone");
  if (!zone) { console.error("usage: TrafficSnapshot.ts --zone <name> [--script <worker>] [--hours 24] [--top 50] [--json]"); process.exit(2); }
  const snap = await takeSnapshot({ zone, script: flag("script"), hours: flag("hours") ? Number(flag("hours")) : undefined, top: flag("top") ? Number(flag("top")) : undefined });
  console.log(argv.includes("--json") ? JSON.stringify(snap, null, 2) : summarize(snap));
}
