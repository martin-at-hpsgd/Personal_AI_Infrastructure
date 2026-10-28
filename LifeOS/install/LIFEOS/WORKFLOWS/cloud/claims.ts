/**
 * Occurrence claims for the cloud runner (ISC-276..279): one row per workflow and occurrence key in
 * the shared `wf-claims` D1 database, taken by a single INSERT that does nothing on conflict. D1
 * writes go through one primary, so two deliveries of the same cron minute cannot both see one
 * changed row; the KV read-then-write this replaced was eventually consistent and only narrowed
 * that window. The table has the same shape as the embedded store's `workflow_claims` table.
 */
import { invariant } from "../../TOOLS/Invariant.ts";

/** The subset of the D1 API the runner uses; tests pass a bun:sqlite double. */
export interface D1Like {
  prepare(sql: string): { bind(...values: unknown[]): { run(): Promise<{ meta?: { changes?: number } }> } };
}

/** The one database every runner binds as CLAIMS. */
export const CLAIMS_DATABASE = "wf-claims";
/** Claims outlive any retry window; a week is far past Cloudflare's duplicate-delivery horizon. */
export const CLAIM_RETENTION_MS = 7 * 86_400_000;

const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS workflow_claims (workflow TEXT NOT NULL, occurrence_key TEXT NOT NULL, run_id TEXT NOT NULL, claimed_at TEXT NOT NULL, PRIMARY KEY (workflow, occurrence_key))",
  "CREATE INDEX IF NOT EXISTS idx_workflow_claims_claimed_at ON workflow_claims(claimed_at)",
];

const missingTable = (error: unknown): boolean => /no such table/i.test(error instanceof Error ? error.message : String(error));

/** Runs one statement, creating the table first when this database has never held a claim. */
async function runWithSchema(db: D1Like, sql: string, values: unknown[]): Promise<{ meta?: { changes?: number } }> {
  try {
    return await db.prepare(sql).bind(...values).run();
  } catch (error) {
    if (!missingTable(error)) throw error;
    for (const statement of SCHEMA) await db.prepare(statement).bind().run();
    return await db.prepare(sql).bind(...values).run();
  }
}

/** Claims one occurrence; false when it was already claimed. Throws when the database does, so a failed claim never starts a run. */
export async function claimOccurrence(db: D1Like, workflow: string, occurrenceKey: string, runId: string, now: Date = new Date()): Promise<boolean> {
  invariant(workflow.length > 0 && occurrenceKey.length > 0 && runId.length > 0, "a claim needs a workflow, key and run id");
  const result = await runWithSchema(db, "INSERT INTO workflow_claims (workflow, occurrence_key, run_id, claimed_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING",
    [workflow, occurrenceKey, runId, now.toISOString()]);
  return (result.meta?.changes ?? 0) === 1;
}

/** Deletes this workflow's claims older than the retention window; returns how many went. */
export async function pruneClaims(db: D1Like, workflow: string, now: Date = new Date()): Promise<number> {
  invariant(workflow.length > 0, "a prune needs a workflow");
  const cutoff = new Date(now.getTime() - CLAIM_RETENTION_MS).toISOString();
  const result = await runWithSchema(db, "DELETE FROM workflow_claims WHERE workflow = ? AND claimed_at < ?", [workflow, cutoff]);
  return result.meta?.changes ?? 0;
}
