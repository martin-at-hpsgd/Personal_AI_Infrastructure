#!/usr/bin/env bun
// WorkerCrashes — hourly crash counts for every Cloudflare Worker on the account, from Cloudflare's
// invocation analytics (GraphQL `workersInvocationsAdaptive`). One fixed, read-only query; the caller
// picks only how many hours back. Run it through CfEnv, which hands it the token and account id:
//
//   bun ~/.claude/LIFEOS/TOOLS/CfEnv.ts workers-crashes [--hours 6]
//
// Prints one JSON object: { from, to, rows: [{ worker, hour, crashes }] }, one row per Worker per hour
// that had a crash. Exit 0 on a good read, 1 when Cloudflare refuses or answers in an unexpected shape.
// Bunker's monitor reads it once a sweep (Bunker ISA ISC-65 to ISC-70).

/** Invocation statuses that are the Worker's own failure. `clientDisconnected` (the caller hung up),
 *  `responseStreamDisconnected` (the reader went away mid-stream) and `internalError` (Cloudflare's side)
 *  are not crashes. */
export const CRASH_STATUSES = ["scriptThrewException", "exceededCpu", "exceededMemory", "exceededResources"] as const;

export type CrashRow = { worker: string; hour: string; crashes: number };
type Raw = { sum?: { requests?: unknown }; dimensions?: { scriptName?: unknown; status?: unknown; datetimeHour?: unknown } };

const QUERY = `query($a:String!,$f:Time!,$t:Time!,$s:[String!]){viewer{accounts(filter:{accountTag:$a}){workersInvocationsAdaptive(limit:10000,filter:{datetime_geq:$f,datetime_lt:$t,status_in:$s}){sum{requests} dimensions{scriptName status datetimeHour}}}}}`;
const LIMIT = 10_000;

/** Raw analytics groups to one crash row per Worker per hour. Non-crash statuses drop out here too, so a
 *  query that ignored the status filter still could not count them. Throws on any unexpected shape. */
export function crashRows(raw: unknown[]): CrashRow[] {
  const crash = new Set<string>(CRASH_STATUSES);
  const byKey = new Map<string, CrashRow>();
  for (const g of raw as Raw[]) {
    const d = g.dimensions, n = g.sum?.requests;
    if (typeof d?.scriptName !== "string" || typeof d.status !== "string" || typeof d.datetimeHour !== "string" || typeof n !== "number") throw new Error("unexpected analytics row shape");
    if (!crash.has(d.status) || n <= 0) continue;
    const key = `${d.scriptName}\0${d.datetimeHour}`;
    const row = byKey.get(key) ?? { worker: d.scriptName, hour: d.datetimeHour, crashes: 0 };
    row.crashes += n;
    byKey.set(key, row);
  }
  return [...byKey.values()].sort((a, b) => a.worker.localeCompare(b.worker) || a.hour.localeCompare(b.hour));
}

async function main(): Promise<void> {
  const i = process.argv.indexOf("--hours");
  const hours = i === -1 ? 6 : Number(process.argv[i + 1]);
  if (!Number.isInteger(hours) || hours < 1 || hours > 24 * 30) { console.error("WorkerCrashes: --hours takes a whole number from 1 to 720."); process.exit(2); }
  const account = process.env.CLOUDFLARE_ACCOUNT_ID, token = process.env.CLOUDFLARE_API_TOKEN;
  if (!account || !token) { console.error("WorkerCrashes: run me through CfEnv.ts workers-crashes, which supplies the Cloudflare credentials."); process.exit(2); }
  const to = new Date(), from = new Date(to.getTime() - hours * 3_600_000);
  const res = await fetch("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: QUERY, variables: { a: account, f: from.toISOString(), t: to.toISOString(), s: CRASH_STATUSES } }),
    signal: AbortSignal.timeout(45_000),
  });
  const body = (await res.json().catch(() => null)) as { errors?: { message?: string }[]; data?: { viewer?: { accounts?: { workersInvocationsAdaptive?: unknown }[] } } } | null;
  const raw = body?.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive;
  if (!res.ok || body?.errors?.length || !Array.isArray(raw)) {
    console.error(`WorkerCrashes: analytics read failed (HTTP ${res.status}): ${body?.errors?.map((e) => e.message).join("; ").slice(0, 300) ?? "no JSON body"}`);
    process.exit(1);
  }
  if (raw.length >= LIMIT) { console.error(`WorkerCrashes: ${LIMIT} or more groups; the count would be truncated.`); process.exit(1); }
  console.log(JSON.stringify({ from: from.toISOString(), to: to.toISOString(), rows: crashRows(raw) }));
}

if (import.meta.main) await main();
