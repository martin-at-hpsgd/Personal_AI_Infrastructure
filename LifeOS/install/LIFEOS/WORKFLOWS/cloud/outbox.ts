/**
 * The cloud half of the run ledger (ISC-34): an outbox in Workers KV.
 *
 * The runner writes each finished run's ledger record here first, under
 * `outbox/<finished_at>/<run_id>`, so keys list oldest first. The local puller
 * reads the outbox, appends each record to the local ledger through the
 * engine's appendRecord, and only then acks, which deletes the key. A crash
 * between append and ack re-delivers the record; the puller skips a run id the
 * ledger already holds, so delivery is at-least-once and the ledger stays
 * exactly-once.
 *
 * Occurrence claims live in D1 (claims.ts), not here: KV is eventually
 * consistent, so a KV claim could not stop a cron minute delivered twice from
 * running twice (ISC-276).
 */
import type { LedgerRecord } from "../engine/ledger.ts";

/** The subset of the Workers KV API the runner uses; tests pass an in-memory double. */
export interface KvLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
  list(options: { prefix: string; limit?: number; cursor?: string }): Promise<{ keys: Array<{ name: string }>; list_complete: boolean; cursor?: string }>;
}

export const OUTBOX_PREFIX = "outbox/";
export const PAUSE_KEY = "workflows:pause";
/** In-flight markers outlive any run; the sweep closes a dead run's marker long before this. */
const INFLIGHT_TTL_SECONDS = 7 * 86_400;
export const MAX_PULL = 100;

/** A record shaped exactly like a local ledger line except for where it ran. */
export type CloudLedgerRecord = Omit<LedgerRecord, "runs_on"> & { runs_on: "cloud" };

const RUN_ID_RE = /^[A-Za-z0-9-]{8,}$/;

export function outboxKey(record: Pick<CloudLedgerRecord, "finished_at" | "run_id">): string {
  if (!RUN_ID_RE.test(record.run_id)) throw new Error(`Outbox record has a malformed run id: ${record.run_id}`);
  if (!Number.isFinite(Date.parse(record.finished_at))) throw new Error("Outbox record has no finish time");
  return `${OUTBOX_PREFIX}${record.finished_at}/${record.run_id}`;
}

export async function writeOutbox(kv: KvLike, record: CloudLedgerRecord): Promise<string> {
  const key = outboxKey(record);
  await kv.put(key, JSON.stringify(record));
  return key;
}

/** Up to `limit` pending records, oldest first. A value that no longer parses is returned as its key alone so it can be acked away. */
export async function readOutbox(kv: KvLike, limit: number = MAX_PULL): Promise<Array<{ key: string; record: CloudLedgerRecord | null }>> {
  const bounded = Math.max(1, Math.min(MAX_PULL, Math.floor(limit)));
  const listed = await kv.list({ prefix: OUTBOX_PREFIX, limit: bounded });
  const out: Array<{ key: string; record: CloudLedgerRecord | null }> = [];
  for (const { name } of listed.keys) {
    const text = await kv.get(name);
    if (text === null) continue;
    try {
      out.push({ key: name, record: JSON.parse(text) as CloudLedgerRecord });
    } catch {
      out.push({ key: name, record: null });
    }
  }
  return out;
}

/** Deletes acked keys. Only keys under the outbox prefix are accepted, so an ack can never delete the pause flag or an in-flight marker. */
export async function ackOutbox(kv: KvLike, keys: unknown): Promise<number> {
  if (!Array.isArray(keys) || keys.length > MAX_PULL || !keys.every(k => typeof k === "string" && k.startsWith(OUTBOX_PREFIX) && !k.includes(".."))) {
    throw new Error(`An ack is a list of at most ${MAX_PULL} outbox keys`);
  }
  for (const key of keys as string[]) await kv.delete(key);
  return keys.length;
}

/**
 * In-flight markers: the cloud runner's abandoned-run record. A run writes
 * `inflight/<run_id>` after its claim and deletes it after its outbox record lands. Cloudflare ends a
 * scheduled invocation at 15 minutes with no chance to write anything, so a marker still present past
 * its deadline means the run died, and the runner's sweep closes it with an `abandoned` record.
 */
export const INFLIGHT_PREFIX = "inflight/";

export interface InflightMarker {
  run_id: string;
  workflow: string;
  occurrence_key: string;
  trigger: LedgerRecord["trigger"];
  definition_hash: string;
  data_class: LedgerRecord["data_class"];
  steps: string[];
  started_at: string;
  deadline_at: string;
}

export async function markInflight(kv: KvLike, marker: InflightMarker): Promise<void> {
  if (!RUN_ID_RE.test(marker.run_id)) throw new Error(`In-flight marker has a malformed run id: ${marker.run_id}`);
  await kv.put(`${INFLIGHT_PREFIX}${marker.run_id}`, JSON.stringify(marker), { expirationTtl: INFLIGHT_TTL_SECONDS });
}

export async function clearInflight(kv: KvLike, runId: string): Promise<void> {
  await kv.delete(`${INFLIGHT_PREFIX}${runId}`);
}

/** Up to `limit` in-flight markers. A value that no longer parses comes back as null so the sweep can drop it. */
export async function readInflight(kv: KvLike, limit: number = MAX_PULL): Promise<Array<{ key: string; marker: InflightMarker | null }>> {
  const listed = await kv.list({ prefix: INFLIGHT_PREFIX, limit: Math.max(1, Math.min(MAX_PULL, Math.floor(limit))) });
  const out: Array<{ key: string; marker: InflightMarker | null }> = [];
  for (const { name } of listed.keys) {
    const text = await kv.get(name);
    if (text === null) continue;
    try {
      out.push({ key: name, marker: JSON.parse(text) as InflightMarker });
    } catch {
      out.push({ key: name, marker: null });
    }
  }
  return out;
}

/** The global pause (ISC-137): any non-empty value engages it. Read fresh before every run. */
export async function pauseEngaged(kv: KvLike): Promise<boolean> {
  const value = await kv.get(PAUSE_KEY);
  return typeof value === "string" && value.trim().length > 0;
}
