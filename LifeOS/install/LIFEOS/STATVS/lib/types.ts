/** STATVS row and API types. @version 1.1.0 */

export type PrivacyClass = "public" | "system" | "personal" | "customer";
export const PRIVACY_CLASSES: readonly PrivacyClass[] = ["public", "system", "personal", "customer"] as const;
export type Severity = "info" | "low" | "medium" | "high" | "critical";
/** What a row did to the RES it names (CENSVS ISA F3). The same list as GENERA's OPS; append() checks against that. */
export type RowOp = "create" | "set" | "move" | "link" | "unlink" | "observe" | "retire";

export interface StatvsInput {
  writer: string;
  stream: string;
  class?: PrivacyClass;
  app?: string;
  kind?: string;
  severity?: Severity;
  title?: string;
  session?: string;
  ref?: string;
  /** The RES this row is about, "<kind>:<key>" with kind from GENERA. Optional: any row may name one. */
  subject?: string;
  /** What the row did to `subject`. Requires subject. */
  op?: RowOp;
  data: unknown;
  ts?: string;
}

export interface StatvsRow {
  v: 1;
  id: string;
  seq: number;
  hlc: string;
  ts: string;
  writer: string;
  stream: string;
  class: PrivacyClass;
  app?: string;
  kind?: string;
  severity?: string;
  title?: string;
  session?: string;
  ref?: string;
  subject?: string;
  op?: RowOp;
  data: unknown | null;
  data_hash: string;
  obj?: string;
  flags?: string[];
  prev: string;
  hash: string;
}

export type AppendResult =
  | { ok: true; row: StatvsRow }
  | { ok: false; refused: string }
  | { ok: false; spooled: true; reason: string };

export interface ScanResult {
  rows: StatvsRow[];
  /** segment path (relative to statvsDir) → byte offset read up to (end of the last complete line). */
  offsets: Record<string, number>;
  /** Malformed lines skipped, each naming its segment and line. Other segments are still read. */
  problems?: string[];
}

export interface StreamDef {
  owner: string;
  class: PrivacyClass;
  retention: string;
  /** Severity rows of this stream leave the machine for the cloud tier. Default false (migration design §2.3, ISC-191). */
  forward?: boolean;
  /** false: rows of this stream never leave the machine (the core shipper skips them). Omitted: they may ship. */
  ship?: boolean;
}

export interface Counters {
  refused: number;
  spooled: number;
  quarantined: number;
  drained: number;
}
