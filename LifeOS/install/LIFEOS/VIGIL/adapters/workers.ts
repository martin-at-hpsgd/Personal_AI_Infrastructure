/** Cloudflare Workers that start or stop failing, read from Workers Logs . An install with no Cloudflare credentials has no Workers to watch: it reads as not installed. @version 0.3.0 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { VigilEvent } from "../../STATVS/lib/refuse";
import { readJson, statePath } from "../../STATVS/lib/collectState";
import { scan } from "../../STATVS/lib/record";
import { clock, event, need, SourceMissing, withCursor } from "./common";
import { getEnvPath } from "../../TOOLS/Paths";

/** One Worker's invocations over the window. Cancels (the client hung up) and unknown outcomes count as neither. */
type Counts = { ok: number; failed: number };
type Deploy = { ts: string; versionId: string | null; previousVersionId?: string | null };
export type Snapshot = { at: string; workers: Record<string, Counts>; failing: string[]; deploys: Record<string, Deploy> };
type Row = { worker: string; outcome: string; count: number };

const WINDOW_MINUTES = 30, DEPLOY_WINDOW_MS = 2 * 3600e3, ROW_LIMIT = 500;
const NOT_FAILED = new Set(["ok", "canceled", "unknown"]);
const LIFEOS = join(import.meta.dir, "..", "..");
const CFENV = join(LIFEOS, "TOOLS", "CfEnv.ts");

/** Starts failing at 3+ failures and 5+ in 100; stays failing until under 3 or under 1 in 100, so a Worker near the line does not flap. */
export function isFailing(c: Counts, wasFailing: boolean): boolean {
  const rate = c.failed / Math.max(1, c.ok + c.failed);
  return wasFailing ? c.failed >= 3 && rate >= 0.01 : c.failed >= 3 && rate >= 0.05;
}

/** The one Cloudflare call: a read-only Workers Logs count by Worker and outcome. `dry: true` keeps the run from being saved in the account. */
export function queryCloudflare(fromMs: number, toMs: number): Row[] {
  const body = { queryId: "lifeos-vigil-workers", dry: true, timeframe: { from: fromMs, to: toMs }, view: "calculations", parameters: { calculations: [{ operator: "count" }], groupBys: [{ type: "string", value: "$workers.scriptName" }, { type: "string", value: "$workers.outcome" }], limit: ROW_LIMIT } };
  const r = spawnSync(process.execPath, [CFENV, "observability", "telemetry", "query", "--body", JSON.stringify(body), "-q"], { encoding: "utf8", timeout: 60_000 });
  if (r.status !== 0) throw new Error(`telemetry query failed (exit ${r.status ?? r.signal}): ${`${r.stderr ?? ""}`.trim().slice(-200)}`);
  return parseRows(r.stdout ?? "");
}

/** CfEnv reads its two keys from the install's env file only, so that file (never the shell) decides whether there is an account to watch. Names only; no value is read out. */
function cloudflareConfigured(): boolean {
  try { const text = readFileSync(getEnvPath(), "utf8"); return ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"].every((k) => new RegExp(`^\\s*(?:export\\s+)?${k}\\s*=\\s*\\S`, "m").test(text)); } catch { return false; }
}

/** cf's stdout to rows; anything but the expected shape throws, so the read shows red. */
export function parseRows(stdout: string): Row[] {
  const start = stdout.search(/^[[{]/m);
  need(start !== -1, "telemetry query returned JSON");
  const found = (JSON.parse(stdout.slice(start)) as { calculations?: { aggregates?: unknown[] }[] }).calculations?.[0]?.aggregates;
  need(Array.isArray(found), "calculations[0].aggregates");
  const aggregates = found as unknown[];
  need(aggregates.length < ROW_LIMIT, `fewer than ${ROW_LIMIT} worker/outcome rows`);
  return aggregates.map((a) => {
    const { groups, count } = a as { groups?: { value?: unknown }[]; count?: unknown };
    need(groups?.length === 2 && typeof groups[0]?.value === "string" && typeof groups[1]?.value === "string" && typeof count === "number", "aggregate groups and count");
    return { worker: groups[0]!.value as string, outcome: groups[1]!.value as string, count };
  });
}

/** Latest successful deploy per Worker, from the record's `deploy` stream, which CfEnv writes on every real deploy
 *  (STATVS ISC-110). Only the last two days are opened: a deploy older than the window never names a failure. */
export function lastDeploys(now = new Date()): Record<string, Deploy> {
  const fromDate = new Date(now.getTime() - DEPLOY_WINDOW_MS - 86_400_000).toISOString().slice(0, 10);
  const out: Record<string, Deploy> = {};
  for (const r of scan({ streams: ["deploy"], classes: ["system"], fromDate }).rows) {
    const d = r.data as { cfExit?: unknown; versionId?: unknown; previousVersionId?: unknown } | null;
    if (r.stream !== "deploy" || !r.app || d?.cfExit !== 0) continue;
    if (!out[r.app] || out[r.app]!.ts < r.ts) out[r.app] = { ts: r.ts, versionId: typeof d.versionId === "string" ? d.versionId : null, previousVersionId: typeof d.previousVersionId === "string" ? d.previousVersionId : null };
  }
  return out;
}

export async function live(wasFailing: string[] = [], query = queryCloudflare, deploysOf: (now: Date) => Record<string, Deploy> = lastDeploys, now = new Date()): Promise<Snapshot> {
  if (query === queryCloudflare && !cloudflareConfigured()) throw new SourceMissing(`Cloudflare credentials (CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID) not in ${getEnvPath()}`);
  const workers: Record<string, Counts> = {};
  for (const r of query(now.getTime() - WINDOW_MINUTES * 60e3, now.getTime())) {
    const c = (workers[r.worker] ??= { ok: 0, failed: 0 });
    if (r.outcome === "ok") c.ok += r.count; else if (!NOT_FAILED.has(r.outcome)) c.failed += r.count;
  }
  const prior = new Set(wasFailing);
  const failing = Object.keys(workers).filter((w) => isFailing(workers[w]!, prior.has(w))).sort();
  const all = deploysOf(now), deploys: Record<string, Deploy> = {};
  for (const w of failing) if (all[w]) deploys[w] = all[w]!;
  return { at: now.toISOString(), workers, failing, deploys };
}

export function diff(prev: Snapshot | undefined, next: Snapshot): VigilEvent[] {
  if (!prev) return [];
  const was = new Set(prev.failing), is = new Set(next.failing), out: VigilEvent[] = [];
  for (const w of next.failing.filter((x) => !was.has(x))) {
    const c = next.workers[w]!, d = next.deploys[w], age = d ? Date.parse(next.at) - Date.parse(d.ts) : Infinity;
    const afterDeploy = d && age >= 0 && age <= DEPLOY_WINDOW_MS;
    const counts = `${c.failed} of ${c.ok + c.failed} invocations failed in the last ${WINDOW_MINUTES} minutes`;
    out.push(afterDeploy
      ? event("workers", w, "failing", "high", `${w} started failing after its deploy at ${clock(d.ts)}`, `${counts}. It was deployed at ${clock(d.ts)}, version ${d.versionId ?? "not recorded"}. Roll back with CfEnv.ts workers deployments create --worker ${w} and ${d.previousVersionId ? `version ${d.previousVersionId}` : "the previous version (CfEnv.ts workers deployments list)"}.`, "infra", null, next.at)
      : event("workers", w, "failing", "medium", `${w} is failing on Cloudflare`, `${counts}. Read the errors with CfEnv.ts observability telemetry query filtered to this Worker.`, "infra", null, next.at));
  }
  for (const w of prev.failing.filter((x) => !is.has(x))) {
    const c = next.workers[w];
    out.push(event("workers", w, "recovered", "info", `${w} stopped failing`, c ? `${c.failed} of ${c.ok + c.failed} invocations failed in the last ${WINDOW_MINUTES} minutes, below the line.` : `No invocations in the last ${WINDOW_MINUTES} minutes.`, "infra", null, next.at));
  }
  return out;
}

const priorFailing = (): string[] => readJson<Snapshot | undefined>(statePath("cursors", "workers.json"), undefined)?.failing ?? [];
export const read = () => withCursor("workers", () => live(priorFailing()), diff);
