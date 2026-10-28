/**
 * STATVS core — the one erasure route (statvs-full-migration ISA, ISC-65 to ISC-67).
 *
 * The record is permanent; this module is its single exception, for a leaked secret, customer data, or another
 * person's personal data that got in by mistake. The control is the erase credential, separate from every writer
 * and reader and held only by {{PRINCIPAL_NAME}}: the route takes any well-formed request that carries it. Every request also
 * carries his approval in his own words, which the tombstone keeps as the record; the core checks only that it is
 * present, and the client tool's terminal check guards against a scripted call by mistake, not against a caller
 * that holds the credential.
 *
 * An erasure clears whole groups of one v3 or v4 row: "data" (the payload, and its body object when it has one) and
 * "text" (app, kind, severity, title, session, ref, and a v4 row's subject). A v4 row's op is in neither group: it is
 * one word from a closed list and stays covered by the hash. Clearing text alone can leave a subject the index derives
 * from the payload; clearing both groups removes every trace. A v3 or v4 row commits to those groups only through data_hash and
 * content_hash, so the cleared row keeps its hash and its Merkle leaf, and every checkpoint still verifies (ISC-66).
 * A signed tombstone row naming the target, the groups, the reason and the approval is appended before anything is
 * removed, so no erasure happens unlogged.
 *
 * This is the only file that removes or overwrites a stored row or body (ISC-67); a test holds every other file to
 * conditional puts.
 */
import { canonicalJson } from "../../lib/canonical";
import { scan } from "../../lib/mask";
import { leafInput, TEXT_FIELDS, verifyRowHash, type Ingested, type RowFields } from "../../lib/row";
import type { D1Like } from "./index-store";
import type { R2Like } from "./sequencer";

class InvariantViolation extends Error {
  constructor(message: string) { super(`INVARIANT VIOLATION: ${message}`); this.name = "InvariantViolation"; }
}
function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new InvariantViolation(message);
}

export const ERASE_GROUPS = ["data", "text"] as const;
export type EraseGroup = (typeof ERASE_GROUPS)[number];
/** The only reasons the route accepts (ISC-65). */
export const ERASE_REASONS = ["leaked-secret", "customer-data", "personal-data"] as const;
export type EraseReason = (typeof ERASE_REASONS)[number];
/** The reserved writer of tombstone rows; the intake refuses it from any credential. */
export const ERASURE_WRITER = "statvs:erasure";
export const ERASE_SCOPE = "erase";

export interface EraseRequest {
  chain: string;
  seq: number;
  groups: EraseGroup[];
  reason: EraseReason;
  /** Who said yes ({{PRINCIPAL_NAME}}). */
  by: string;
  /** His words, verbatim. */
  approval: string;
}

/** A request checked and put in canonical form (groups sorted, deduplicated), or why it is refused. */
export function parseEraseRequest(raw: unknown): { ok: true; req: EraseRequest } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "body must be an object" };
  const o = raw as Record<string, unknown>;
  if (typeof o.chain !== "string" || o.chain.length === 0) return { ok: false, error: "chain is required" };
  if (!Number.isSafeInteger(o.seq) || (o.seq as number) < 1) return { ok: false, error: "seq must be a positive integer" };
  if (!Array.isArray(o.groups) || o.groups.length === 0 || !o.groups.every((g) => ERASE_GROUPS.includes(g as EraseGroup))) return { ok: false, error: `groups must name some of ${ERASE_GROUPS.join(", ")}` };
  if (!ERASE_REASONS.includes(o.reason as EraseReason)) return { ok: false, error: `reason must be one of ${ERASE_REASONS.join(", ")}` };
  if (typeof o.by !== "string" || o.by.trim().length === 0) return { ok: false, error: "by names who approved" };
  if (typeof o.approval !== "string" || o.approval.trim().length < 2 || o.approval.length > 1000) return { ok: false, error: "approval carries the approver's words (2 to 1000 characters)" };
  // The tombstone keeps the approval forever, so it must not carry what is being erased.
  if (scan({ by: o.by, approval: o.approval }).length > 0) return { ok: false, error: "the approval text holds a secret; say what to erase without quoting it" };
  const groups = [...new Set(o.groups as EraseGroup[])].sort();
  return { ok: true, req: { chain: o.chain, seq: o.seq as number, groups, reason: o.reason as EraseReason, by: o.by.trim(), approval: o.approval.trim() } };
}

/** Is there anything of these groups left on the row? A body row's payload is its body object, so the caller says whether that is still stored. */
export function holds(row: Ingested, groups: readonly EraseGroup[], bodyStored: boolean): boolean {
  const r = row as unknown as Record<string, unknown>;
  return groups.some((g) => (g === "data" ? r.data !== undefined || bodyStored : TEXT_FIELDS.some((k) => r[k] !== undefined)));
}

/** The row with the groups cleared. Its hash and Merkle leaf are those of the row it replaces, or this throws. */
export async function clearRow(row: Ingested, groups: readonly EraseGroup[]): Promise<Ingested> {
  invariant(row.v === 3 || row.v === 4, `${row.chain}#${row.seq} is v${row.v}; only a v3 or v4 row can be cleared and keep its hash`);
  const out = { ...row } as unknown as Record<string, unknown>;
  if (groups.includes("data")) delete out.data;
  if (groups.includes("text")) for (const k of TEXT_FIELDS) delete out[k];
  const cleared = out as unknown as Ingested;
  invariant(await verifyRowHash(cleared), `${row.chain}#${row.seq} cleared of ${groups.join("+")} no longer verifies`);
  invariant(canonicalJson([...leafInput(cleared)]) === canonicalJson([...leafInput(row)]), `${row.chain}#${row.seq} cleared of ${groups.join("+")} would move its Merkle leaf`);
  return cleared;
}

/** The tombstone's fields: what was cleared, why, and who said yes. Never the cleared content. */
export function tombstoneFields(req: EraseRequest, target: Ingested, segment: string, at: string, seq: number): RowFields {
  return {
    chain: `${ERASURE_WRITER.replace(":", "_")}|-|system|${at.slice(0, 10)}`,
    seq,
    ts: at,
    ts_basis: "stated",
    writer: ERASURE_WRITER,
    stream: "erasure",
    kind: "erasure",
    data: {
      target: { chain: target.chain, seq: target.seq, offset: target.offset, segment, hash: target.hash },
      groups: req.groups,
      reason: req.reason,
      by: req.by,
      approval: req.approval,
      removed: {
        ...(req.groups.includes("data") ? { data_hash: target.data_hash, ...(target.body ? { body: target.body } : {}) } : {}),
        ...(req.groups.includes("text") ? { content_hash: target.content_hash } : {}),
      },
    },
  };
}

/** Replace a segment object with its rows after an erasure. Only clearRow's output reaches here. */
export async function overwriteSegment(record: R2Like, key: string, bytes: Uint8Array): Promise<void> {
  invariant(key.startsWith("seg/"), `only a segment is rewritten by an erasure (got ${key})`);
  await record.put(key, bytes, { httpMetadata: { contentType: "application/gzip" } });
}

/** Remove a body object an erasure cleared. Every row that named the same bytes loses them with it. */
export async function deleteBody(record: R2Like, key: string): Promise<void> {
  invariant(key.startsWith("body/"), `only a body is deleted by an erasure (got ${key})`);
  invariant(typeof record.delete === "function", "the record store cannot delete");
  await record.delete(key);
}

/** Clear a row's text fields from every index database (it lives in one; the others match nothing). */
export async function clearIndexText(dbs: Map<string, D1Like>, shard: string, offset: number): Promise<number> {
  let changed = 0;
  for (const db of dbs.values()) {
    const r = await db.prepare("UPDATE rows SET app = NULL, kind = NULL, severity = NULL, title = NULL, session = NULL, ref = NULL WHERE shard = ? AND ingest_offset = ?").bind(shard, offset).run();
    changed += r.meta?.changes ?? 0;
  }
  return changed;
}
