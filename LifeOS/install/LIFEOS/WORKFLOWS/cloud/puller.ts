/**
 * The local half of the outbox-first ledger path (ISC-34).
 *
 * Reads pending records from a runner's GET /outbox, appends each to the local
 * run ledger through the engine's appendRecord (which re-checks the record with
 * assertRecord), then acks. A run id the ledger already holds is skipped and
 * still acked, so a lost ack never duplicates a line. A malformed record is not
 * appended and not acked: it stays in the outbox where it can be seen.
 */
import { existsSync } from "node:fs";
import { appendRecord, assertRecord, readLedger, type LedgerRecord } from "../engine/ledger.ts";
import { definitionsDir, ledgerPath, NAME_RE, pathForName } from "../engine/paths.ts";
import type { FetchLike } from "./preflight.ts";
import type { CloudLedgerRecord } from "./outbox.ts";

export interface PullInput {
  base: string;
  token: string;
  ledger: string;
  fetch?: FetchLike;
}

export interface PullResult {
  appended: number;
  skipped: number;
  acked: number;
  malformed: number;
}

export async function pullOnce(input: PullInput): Promise<PullResult> {
  const fetcher = input.fetch ?? fetch;
  const auth = { authorization: `Bearer ${input.token}` };
  const res = await fetcher(new URL("/outbox", input.base), { method: "GET", headers: auth, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`GET /outbox returned HTTP ${res.status}`);
  const body = await res.json() as { entries?: unknown };
  if (!body || !Array.isArray(body.entries)) throw new Error("GET /outbox returned an unexpected shape");
  const held = new Set(readLedger(input.ledger).records.map(r => r.run_id));
  const ack: string[] = [];
  let appended = 0, skipped = 0, malformed = 0;
  for (const entry of body.entries as Array<{ key?: unknown; record?: CloudLedgerRecord | null }>) {
    if (typeof entry?.key !== "string") { malformed++; continue; }
    const record = entry.record as unknown as LedgerRecord | null;
    try {
      if (record === null) throw new Error("unparseable");
      assertRecord(record);
    } catch {
      malformed++;
      continue;
    }
    if (held.has(record.run_id)) skipped++;
    else {
      appendRecord(input.ledger, record);
      held.add(record.run_id);
      appended++;
    }
    ack.push(entry.key);
  }
  if (ack.length === 0) return { appended, skipped, acked: 0, malformed };
  const acked = await fetcher(new URL("/outbox/ack", input.base), { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ keys: ack }), signal: AbortSignal.timeout(30_000) });
  if (!acked.ok) throw new Error(`POST /outbox/ack returned HTTP ${acked.status}; ${appended} appended, will be skipped on the next pull`);
  return { appended, skipped, acked: ack.length, malformed };
}

/** Pull one runner until its outbox is empty or a pass acks nothing (a listing holds at most 100 records). */
export async function drain(input: PullInput, maxPasses = 20): Promise<PullResult> {
  const total: PullResult = { appended: 0, skipped: 0, acked: 0, malformed: 0 };
  for (let i = 0; i < maxPasses; i++) {
    const r = await pullOnce(input);
    total.appended += r.appended; total.skipped += r.skipped; total.acked += r.acked; total.malformed += r.malformed;
    if (r.acked === 0) break;
  }
  return total;
}

/** The fleet's workers.dev subdomain and shared bearer, from the Workflows CLI config. Never printed. */
export function fleetAuth(yaml: string): { subdomain: string; token: string } | null {
  const key = (k: string) => yaml.match(new RegExp(`^${k}:\\s*"?([^"\\n]+)"?`, "m"))?.[1]?.trim() ?? null;
  const subdomain = key("subdomain"), token = key("auth_token");
  return subdomain && token && /^[a-z0-9-]+$/.test(subdomain) ? { subdomain, token } : null;
}

/** True when `name` is a valid workflow name with a `<name>.workflow.yaml` in the definitions home. */
export function definitionExists(name: string, home: string = definitionsDir()): boolean {
  return NAME_RE.test(name) && existsSync(pathForName(name, home));
}

/**
 * Which runners one pull visits. Names given on the command line pass through as given. With none, every
 * deployed workflow that still has a definition is pulled, sorted; a deployed workflow whose definition was
 * deleted is skipped, because its deploy record outlives it and its runner may be gone (GET /outbox 404).
 */
export function pullTargets(requested: readonly string[], deployed: Iterable<string>, hasDefinition: (name: string) => boolean): { targets: string[]; skipped: string[] } {
  if (requested.length) return { targets: [...requested], skipped: [] };
  const targets: string[] = [], skipped: string[] = [];
  for (const name of [...deployed].sort()) (hasDefinition(name) ? targets : skipped).push(name);
  return { targets, skipped };
}

/** Ledger records whose workflow still has a definition; a deleted workflow's history stays in the ledger but never alerts. */
export function liveRecords<T extends { workflow: string }>(records: readonly T[], hasDefinition: (name: string) => boolean): T[] {
  return records.filter(r => hasDefinition(r.workflow));
}

// M-61: drain every deployed cloud runner's outbox into the local run ledger.
//   bun LIFEOS/WORKFLOWS/cloud/puller.ts [<workflow>...] [--json]
// With no names, every workflow in the deploy log that still has a definition is pulled. Exit 0 when every runner drained, 1 otherwise.
if (import.meta.main) {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { homedir } = await import("node:os");
  const { lastDeploys } = await import("../engine/deploy-record.ts");
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const configPath = join(homedir(), ".config", "workflows", "config.yaml");
  const auth = existsSync(configPath) ? fleetAuth(readFileSync(configPath, "utf8")) : null;
  if (!auth) { console.error(`no subdomain/auth_token in ${configPath}`); process.exit(1); }
  const deploys = lastDeploys();
  const names = args.filter(a => !a.startsWith("--"));
  const { targets, skipped } = pullTargets(names, deploys.keys(), n => definitionExists(n));
  const ledger = ledgerPath();
  const results: Array<{ name: string } & (PullResult | { error: string })> = [];
  for (const name of targets) {
    const runner = deploys.get(name)?.runner ?? `wf-${name}`;
    try {
      results.push({ name, ...(await drain({ base: `https://${runner}.${auth.subdomain}.workers.dev`, token: auth.token, ledger })) });
    } catch (e) {
      results.push({ name, error: e instanceof Error ? e.message : String(e) });
    }
  }
  // With the cloud runs in the ledger, a workflow that keeps failing (cloud or local) becomes one Vigil text per streak.
  // A deleted workflow never alerts: its old failures slide through the ledger's read window, so the streak's first
  // run (the dedup key) keeps changing, and a deleted workflow was once re-texted day after day.
  const { emitFailureStreaks } = await import("../engine/vigil-emit.ts");
  const alerts = emitFailureStreaks(liveRecords(readLedger(ledger).records, n => definitionExists(n))).map(e => e.meta?.workflow as string);
  if (!json) for (const w of alerts) console.log(`alert: ${w} keeps failing (sent to Vigil)`);
  if (json) console.log(JSON.stringify({ runners: results.length, appended: results.reduce((n, r) => n + ("appended" in r ? r.appended : 0), 0), failed: results.filter(r => "error" in r).map(r => r.name), skipped, alerts, results }));
  else {
    for (const name of skipped) console.log(`${name}: skipped, deployed but no definition in the definitions home`);
    for (const r of results) console.log("error" in r ? `${r.name}: FAILED ${r.error}` : `${r.name}: ${r.appended} appended, ${r.skipped} already held, ${r.malformed} malformed`);
  }
  process.exit(results.some(r => "error" in r) ? 1 : 0);
}
