/**
 * Vigil's one door to new state (Vigil ISC-437, ISC-438, migration design §3 Lane D).
 *
 * The tick reads new rows from STATVS through consumer `vigil-tick`: streams `event` and `cloud`
 * only, the classes in `policy.read_classes`, rows that carry a severity. It never reads stream
 * `vigil` or `vigil-log`, so Vigil never answers its own decisions. A missing or corrupt consumer
 * file baselines at the end of the record and writes one `vigil-log` `baseline` row; it never reads
 * the record from the start (S8). Reading never moves the cursor: the caller commits a row's `pos`
 * once its decision row is written (`commitRead`), so a crash between the two re-reads the rows, and
 * the `answered` set (view `vigil-ledger`) stops a second answer.
 *
 * `toEvent` maps a row back to the VigilEvent the routing functions take (§2.1 in reverse).
 *
 * p1: nothing in the live tick calls this; it is exercised by tests and the shadow pass.
 * @version 1.0.0
 */
import { append, commit, readSince, type ConsumerPos, type ConsumerRow, type PrivacyClass, type StatvsRow } from "../STATVS/index";
import { invariant } from "../TOOLS/Invariant";
import { DEFAULT_READ_CLASSES, type VigilPolicy } from "./Policy";
import { KINDS, PRIVACY_CLASSES, SEVERITIES, type VigilEvent } from "./Schema";

export const VIGIL_TICK_CONSUMER = "vigil-tick";
/** The only streams the tick reads. Never `vigil` or `vigil-log` (Vigil ISC-438). */
export const READ_STREAMS: readonly string[] = ["event", "cloud"];
export const LOG_STREAM = "vigil-log";
export const LOG_WRITER = "wf:vigil-tick-log";

export type ReadItem = { row: ConsumerRow; event: VigilEvent };

export interface ReadNewResult {
  items: ReadItem[];
  /** The position after everything read; commit it once every item is answered. */
  next: ConsumerPos;
  /** Rows the answered set already holds: read again after a crash, never answered twice. */
  skipped: string[];
  /** Rows that could not be mapped to an event (no severity, say). Read past, never routed. */
  unreadable: string[];
  /**
   * Rows whose event id an earlier row in this read already carries. Read past, never routed: the first row
   * answers for the event. A writer that retries after a refused legacy append writes the same event id twice,
   * so this is an expected state, not an impossible one.
   */
  duplicates: string[];
  baselined?: true;
  /** The baseline row's id, or why it could not be written. */
  baseline_row?: string;
  baseline_error?: string;
  reset?: true;
  problems?: string[];
}

export interface ReadNewOptions {
  /** Row ids and event ids already answered (view `vigil-ledger`). */
  answered?: { has(id: string): boolean };
  limit?: number;
  now?: number;
  /** The consumer name; tests and the shadow pass use their own. */
  consumer?: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

/** The classes the tick reads: the policy's, keeping only public, system and personal; anything else reads the default. */
export function readClasses(policy: Pick<VigilPolicy, "read_classes">): PrivacyClass[] {
  const allowed: readonly string[] = DEFAULT_READ_CLASSES;
  const want = Array.isArray(policy.read_classes) ? policy.read_classes.filter((c) => allowed.includes(c)) : [];
  return (want.length ? [...new Set(want)] : [...DEFAULT_READ_CLASSES]) as PrivacyClass[];
}

/**
 * A record row as the VigilEvent routing sees: id = data.event_id ?? row.id, source = data.source ?? writer,
 * the cloud class from data.cloud_class (else system and personal → personal, public → public), dedup key
 * from data.dedup_key ?? row.id. A redacted row (data null) keeps its envelope and is still routed. Null
 * for a row with no valid severity, which the tick never routes.
 */
export function toEvent(row: StatvsRow): VigilEvent | null {
  const severity = (SEVERITIES as readonly string[]).includes(row.severity ?? "") ? row.severity as VigilEvent["severity"] : null;
  if (!severity) return null;
  const d = isObj(row.data) ? row.data : {};
  const title = str(row.title) ?? `${row.kind ?? "event"} from ${row.writer}`;
  const cloud = str(d.cloud_class);
  const privacy_class = (cloud && (PRIVACY_CLASSES as readonly string[]).includes(cloud) ? cloud : row.class === "public" ? "public" : row.class === "customer" ? "customer" : "personal") as VigilEvent["privacy_class"];
  const event: VigilEvent = {
    id: str(d.event_id) ?? row.id,
    source: str(d.source) ?? row.writer,
    ts: row.ts,
    kind: ((KINDS as readonly string[]).includes(row.kind ?? "") ? row.kind : "other") as VigilEvent["kind"],
    severity,
    title,
    summary: str(d.summary) ?? title,
    ref: str(row.ref),
    url: str(d.url),
    privacy_class,
    dedup_key: str(d.dedup_key) ?? row.id,
  };
  if (isObj(d.meta)) event.meta = d.meta as VigilEvent["meta"];
  return event;
}

/** Write the consumer's one `baseline` row to vigil-log (no severity, so nothing ever re-reads it). */
function baselineRow(consumer: string, reason: string): { id?: string; error?: string } {
  const r = append({ writer: LOG_WRITER, stream: LOG_STREAM, class: "personal", kind: "baseline", title: "Vigil tick consumer baselined at the end of the record", data: { consumer, reason } });
  if (r.ok) return { id: r.row.id };
  return { error: "refused" in r ? r.refused : r.reason };
}

/** New rows for the tick since its consumer position. Never moves the cursor except to persist a baseline. */
export function readNew(policy: Pick<VigilPolicy, "read_classes">, opts: ReadNewOptions = {}): ReadNewResult {
  const consumer = opts.consumer ?? VIGIL_TICK_CONSUMER;
  invariant(!READ_STREAMS.includes("vigil") && !READ_STREAMS.includes(LOG_STREAM), "the tick never reads its own decision streams");
  const r = readSince(consumer, {
    streams: [...READ_STREAMS],
    classes: readClasses(policy),
    severity: true,
    ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  });
  const items: ReadItem[] = [], skipped: string[] = [], unreadable: string[] = [], duplicates: string[] = [];
  const eventIds = new Set<string>();
  for (const row of r.rows) {
    invariant(READ_STREAMS.includes(row.stream), `the consumer returned a row of stream ${row.stream}`);
    const event = toEvent(row);
    if (!event) { unreadable.push(row.id); continue; }
    if (opts.answered && (opts.answered.has(row.id) || opts.answered.has(event.id))) { skipped.push(row.id); continue; }
    if (eventIds.has(event.id)) { duplicates.push(row.id); continue; }
    eventIds.add(event.id);
    items.push({ row, event });
  }
  const out: ReadNewResult = { items, next: r.next, skipped, unreadable, duplicates };
  if (r.reset) out.reset = true;
  if (r.problems?.length) out.problems = r.problems;
  if (r.baselined) {
    out.baselined = true;
    const b = baselineRow(consumer, "consumer file missing or unreadable");
    if (b.id) out.baseline_row = b.id; else out.baseline_error = b.error;
  }
  return out;
}

/** Commit after the decision row for the last answered item is written: its `pos`, or a read's `next`. */
export function commitRead(pos: ConsumerPos, opts: { consumer?: string; now?: number } = {}): ConsumerPos {
  return commit(opts.consumer ?? VIGIL_TICK_CONSUMER, pos, opts.now !== undefined ? { now: opts.now } : {});
}
