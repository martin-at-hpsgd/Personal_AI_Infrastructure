#!/usr/bin/env bun
// Observability — the account-wide Workers observability default: Workers Logs on for every
// invocation, traces on at a 10% sample. Applied through the script-settings endpoint, which
// changes settings without uploading code or creating a version.
//
// Run it through CfEnv so the master token reaches this process and nothing else:
//   bun ~/.claude/LIFEOS/TOOLS/CfEnv.ts observability-default audit [--json]
//   bun ~/.claude/LIFEOS/TOOLS/CfEnv.ts observability-default apply [--dry-run] [--worker <name>]
//
// `audit` is read-only: it lists every Worker whose live observability differs from the default
// and exits 1 when any does. `apply` patches only the observability object; other settings
// (logpush, tags, tail consumers, log destinations, persistence) are carried over untouched.
// CfEnv also imports this module after every real deploy, because cf deploy uploads whatever
// cloudflare.config.ts says, and a config without traces would otherwise switch them off.

import { InvariantViolation, invariant } from "./Invariant";

/** The default, in the API's snake_case shape. */
export const DEFAULT_OBSERVABILITY = {
  enabled: true,
  head_sampling_rate: 1,
  logs: { enabled: true, head_sampling_rate: 1, invocation_logs: true },
  traces: { enabled: true, head_sampling_rate: 0.1 },
} as const;

type Json = Record<string, unknown>;
export type LiveObservability = Json & { logs?: Json; traces?: Json };

const API = "https://api.cloudflare.com/client/v4";
const TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 5;

function isObject(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Live observability with the default laid over it; every field the default does not name is kept. */
export function mergeObservability(current: unknown): LiveObservability {
  const cur = isObject(current) ? current : {};
  const logs = isObject(cur.logs) ? cur.logs : {};
  const traces = isObject(cur.traces) ? cur.traces : {};
  return {
    ...cur,
    enabled: DEFAULT_OBSERVABILITY.enabled,
    head_sampling_rate: DEFAULT_OBSERVABILITY.head_sampling_rate,
    logs: { ...logs, ...DEFAULT_OBSERVABILITY.logs },
    traces: { ...traces, ...DEFAULT_OBSERVABILITY.traces },
  };
}

/**
 * Fields where live observability differs from the default, as `path: live -> default`.
 * An absent top-level head_sampling_rate means 1 to the API, so absence there is no difference;
 * every other default field must be present with the exact value.
 */
export function diffObservability(current: unknown): string[] {
  const cur = isObject(current) ? current : {};
  const out: string[] = [];
  const check = (path: string, live: unknown, want: unknown, absentOk = false) => {
    if (live === undefined && absentOk) return;
    if (live !== want) out.push(`${path}: ${JSON.stringify(live ?? null)} -> ${JSON.stringify(want)}`);
  };
  check("enabled", cur.enabled, DEFAULT_OBSERVABILITY.enabled);
  check("head_sampling_rate", cur.head_sampling_rate, DEFAULT_OBSERVABILITY.head_sampling_rate, true);
  const logs = isObject(cur.logs) ? cur.logs : {};
  for (const [k, v] of Object.entries(DEFAULT_OBSERVABILITY.logs)) check(`logs.${k}`, logs[k], v);
  const traces = isObject(cur.traces) ? cur.traces : {};
  for (const [k, v] of Object.entries(DEFAULT_OBSERVABILITY.traces)) check(`traces.${k}`, traces[k], v);
  return out;
}

/**
 * What a cloudflare.config.ts says about observability, read from its text (cf configs are
 * TypeScript, so this is a pattern read, never an evaluation). `optOuts` names each block the
 * config switches off on purpose; those are the ones CfEnv warns about before overriding them.
 */
export function readConfigObservability(configText: string): { declared: boolean; optOuts: string[] } {
  const start = configText.search(/\bobservability\s*:\s*\{/);
  if (start === -1) return { declared: false, optOuts: [] };
  const block = balancedBlock(configText, configText.indexOf("{", start));
  const optOuts: string[] = [];
  const nested = (key: string) => {
    const at = block.search(new RegExp(`\\b${key}\\s*:\\s*\\{`));
    return at === -1 ? "" : balancedBlock(block, block.indexOf("{", at));
  };
  const logs = nested("logs");
  const traces = nested("traces");
  const top = block.replace(logs, "").replace(traces, "");
  if (/\benabled\s*:\s*false\b/.test(top)) optOuts.push("observability");
  if (/\benabled\s*:\s*false\b/.test(logs)) optOuts.push("logs");
  if (/\binvocationLogs\s*:\s*false\b/.test(logs)) optOuts.push("logs.invocationLogs");
  if (/\benabled\s*:\s*false\b/.test(traces)) optOuts.push("traces");
  return { declared: true, optOuts };
}

function balancedBlock(text: string, open: number): string {
  invariant(text[open] === "{", "balancedBlock must start on an opening brace");
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return text.slice(open, i + 1);
  }
  return text.slice(open);
}

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;
export type Api = { token: string; account: string; fetcher?: Fetcher; sleep?: (ms: number) => Promise<void> };

type Envelope = { success?: boolean; errors?: { code?: number; message?: string }[]; result?: unknown; result_info?: { total_pages?: number; total_count?: number } };

async function call(api: Api, method: "GET" | "PATCH", path: string, body?: unknown): Promise<Envelope> {
  const fetcher = api.fetcher ?? ((url, init) => fetch(url, init));
  const sleep = api.sleep ?? ((ms) => Bun.sleep(ms));
  for (let attempt = 1; ; attempt++) {
    const res = await fetcher(`${API}/accounts/${api.account}${path}`, {
      method,
      headers: { Authorization: `Bearer ${api.token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if ((res.status === 429 || res.status >= 500) && attempt < MAX_ATTEMPTS) {
      const after = Number(res.headers.get("retry-after"));
      await sleep((Number.isFinite(after) && after > 0 ? Math.min(after, 120) : 5 * attempt) * 1000);
      continue;
    }
    const text = await res.text();
    let env: Envelope;
    try {
      env = JSON.parse(text) as Envelope;
    } catch {
      throw new Error(`${method} ${path}: HTTP ${res.status}, non-JSON body: ${text.slice(0, 200)}`);
    }
    if (!res.ok || env.success !== true) {
      const errs = (env.errors ?? []).map((e) => `${e.code ?? "?"} ${e.message ?? ""}`.trim()).join("; ");
      throw new Error(`${method} ${path}: HTTP ${res.status}${errs ? ` (${errs})` : ""}`);
    }
    return env;
  }
}

/**
 * Every Worker on the account. Two lists are read and unioned: the scripts list (every uploaded
 * script) and the Workers list, which also holds Workers created but never deployed.
 */
export async function listWorkers(api: Api): Promise<string[]> {
  const names: string[] = [];
  const sources = [
    { path: "/workers/scripts", key: "id" },
    { path: "/workers/workers", key: "name" },
  ] as const;
  for (const { path, key } of sources) {
    for (let page = 1; ; page++) {
      const env = await call(api, "GET", `${path}?page=${page}&per_page=100`);
      if (!Array.isArray(env.result)) throw new Error(`${path} returned no result array`);
      for (const s of env.result as Json[]) {
        const name = s[key];
        if (typeof name !== "string" || !name) throw new Error(`${path} returned an entry with no ${key}`);
        names.push(name);
      }
      // The scripts list reports total_pages; the Workers list reports only total_count.
      const info = env.result_info ?? {};
      const pages = info.total_pages ?? (info.total_count === undefined ? undefined : Math.ceil(info.total_count / 100));
      if (!pages || page >= pages || env.result.length === 0) break;
    }
  }
  return [...new Set(names)];
}

export async function getObservability(api: Api, worker: string): Promise<LiveObservability | undefined> {
  const env = await call(api, "GET", `/workers/scripts/${encodeURIComponent(worker)}/script-settings`);
  if (!isObject(env.result)) throw new Error(`script-settings for ${worker} returned no result object`);
  const obs = env.result.observability;
  return isObject(obs) ? (obs as LiveObservability) : undefined;
}

export type EnsureResult = { worker: string; changed: boolean; before: string[]; after: string[] };

/**
 * Bring one Worker to the default. Reads live settings, patches only when they differ, and reads
 * back so the result reports what Cloudflare now holds, not what was sent.
 */
export async function ensureObservability(api: Api, worker: string, dryRun = false): Promise<EnsureResult> {
  invariant(worker.length > 0, "ensureObservability needs a worker name");
  const live = await getObservability(api, worker);
  const before = diffObservability(live);
  if (!before.length || dryRun) return { worker, changed: false, before, after: before };
  const next = mergeObservability(live);
  invariant(diffObservability(next).length === 0, "merged observability must equal the default on every default field");
  await call(api, "PATCH", `/workers/scripts/${encodeURIComponent(worker)}/script-settings`, { observability: next });
  const after = diffObservability(await getObservability(api, worker));
  return { worker, changed: true, before, after };
}

/**
 * The post-deploy step CfEnv runs on the Worker it just deployed. It never throws: the deploy has
 * already gone live, so a settings failure is reported as a `failed: …` status for CfEnv to warn
 * about and write to the deploy ledger, never turned into a failed deploy.
 */
export async function observabilityAfterDeploy(api: Api, worker: string): Promise<string> {
  if (!api.account) return "failed: no CLOUDFLARE_ACCOUNT_ID, so the default could not be applied";
  if (!worker) return "failed: no worker name, so the default could not be applied";
  try {
    const r = await ensureObservability(api, worker);
    if (r.after.length) return `failed: still differs after apply (${r.after.join(", ")})`;
    return r.changed ? `restored (${r.before.join(", ")})` : "default";
  } catch (e) {
    if (e instanceof InvariantViolation) throw e;
    return `failed: ${(e as Error).message}`;
  }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }));
  return out;
}

export type AccountRow = { worker: string; logs: boolean; traces: boolean; diff: string[]; error?: string };

/** Read-only sweep of every Worker's live observability. */
export async function auditAccount(api: Api, concurrency = 4): Promise<AccountRow[]> {
  const workers = await listWorkers(api);
  return mapLimit(workers, concurrency, async (worker) => {
    try {
      const live = await getObservability(api, worker);
      return { worker, logs: live?.enabled === true && live.logs?.enabled === true, traces: live?.enabled === true && live.traces?.enabled === true, diff: diffObservability(live) };
    } catch (e) {
      if (e instanceof InvariantViolation) throw e;
      return { worker, logs: false, traces: false, diff: [], error: (e as Error).message };
    }
  });
}

export type ApplyRow = EnsureResult & { error?: string };

export async function applyAccount(api: Api, opts: { dryRun?: boolean; only?: string } = {}, concurrency = 4): Promise<ApplyRow[]> {
  const workers = opts.only ? [opts.only] : await listWorkers(api);
  return mapLimit(workers, concurrency, async (worker) => {
    try {
      return await ensureObservability(api, worker, opts.dryRun);
    } catch (e) {
      if (e instanceof InvariantViolation) throw e;
      return { worker, changed: false, before: [], after: [], error: (e as Error).message };
    }
  });
}

function apiFromEnv(): Api {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!token || !account) {
    console.error("Observability: CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are missing. Run it as `CfEnv.ts observability-default <audit|apply>`.");
    process.exit(2);
  }
  return { token, account };
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  const json = rest.includes("--json");
  if (cmd === "audit") {
    const rows = await auditAccount(apiFromEnv());
    const off = rows.filter((r) => r.diff.length || r.error);
    const summary = { workers: rows.length, logsOn: rows.filter((r) => r.logs).length, tracesOn: rows.filter((r) => r.traces).length, differing: off.length, errors: rows.filter((r) => r.error).length };
    if (json) console.log(JSON.stringify({ default: DEFAULT_OBSERVABILITY, summary, differing: off }, null, 2));
    else {
      for (const r of off) console.log(r.error ? `${r.worker}  ERROR ${r.error}` : `${r.worker}  ${r.diff.join(", ")}`);
      console.log(`${summary.workers} workers · logs on ${summary.logsOn} · traces on ${summary.tracesOn} · differ from default ${summary.differing} · read errors ${summary.errors}`);
    }
    return off.length ? 1 : 0;
  }
  if (cmd === "apply") {
    const wi = rest.indexOf("--worker");
    const only = wi === -1 ? undefined : rest[wi + 1];
    if (wi !== -1 && (!only || only.startsWith("-"))) { console.error("Observability: --worker needs a name."); return 2; }
    const dryRun = rest.includes("--dry-run");
    const rows = await applyAccount(apiFromEnv(), { dryRun, only });
    const failed = rows.filter((r) => r.error || (r.changed && r.after.length));
    if (json) console.log(JSON.stringify({ dryRun, rows }, null, 2));
    else {
      for (const r of rows) {
        if (r.error) console.log(`${r.worker}  FAILED ${r.error}`);
        else if (r.changed) console.log(`${r.worker}  ${r.after.length ? `STILL DIFFERS ${r.after.join(", ")}` : "applied"}`);
        else if (r.before.length) console.log(`${r.worker}  would change ${r.before.join(", ")}`);
      }
      console.log(`${rows.length} workers · changed ${rows.filter((r) => r.changed).length} · already default ${rows.filter((r) => !r.error && !r.before.length).length} · failed ${failed.length}${dryRun ? " · dry run, nothing written" : ""}`);
    }
    return failed.length ? 1 : 0;
  }
  console.error("usage: Observability.ts audit [--json] | apply [--dry-run] [--worker <name>] [--json]  (run through CfEnv.ts observability-default)");
  return 2;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
